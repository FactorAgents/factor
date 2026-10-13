// The desk's calls, as a visitor's wallet sends them. Amounts are wei here, always: a decimal is for reading, and
// what is typed into a field is turned into wei on its digits (parseEther), never through a float.
//
// Every call is tried first without being sent. A call the desk would refuse never reaches the wallet: the visitor
// is told why in plain words instead of paying gas for a revert.
import { decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeFunctionData, formatEther, keccak256, parseEther, toHex, type Abi, type Hex } from "viem";
import { factorDeskAbi } from "./abi/FactorDesk";
import { declined, ensureChain, ethCall, sendTx, waitFor, type Provider, type Receipt } from "./wallet";

const ABI = factorDeskAbi as Abi;
/** The desk's own numbers for the kind of an advance. */
export const KIND = { customer: 0, pool: 1, compute: 2 } as const;

/** Said to the visitor as it is: what went wrong, in their words. */
export class Refusal extends Error {}

const eth = (wei: unknown): string => {
  const s = formatEther(BigInt(String(wei)));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};
const when = (s: unknown): string => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

// Each of the desk's own refusals, in plain words.
const WORDS: Record<string, (a: readonly unknown[]) => string> = {
  NotRegistered: () => "That wallet has not registered as an agent.",
  AlreadyRegistered: () => "This wallet is already registered as an agent.",
  TooSmall: (a) => `The smallest job is ${eth(a[0])} ETH.`,
  BadDueTime: () => "The due time must be between 1 hour and 30 days from now.",
  NotAgent: () => "Only the job's agent can do this. Connect the agent's wallet.",
  NotCustomer: () => "Only the customer who locked this job can do this. Connect that wallet.",
  WrongState: () => "The job has moved on since this page was loaded. Reload the page.",
  TooLate: () => "It is too late for that on this job.",
  TooSoon: (a) => `Not before ${when(a[0])}.`,
  OverHalf: (a) => (BigInt(String(a[0])) === 0n ? "Half of this job is already advanced. Nothing more can be drawn on it." : `At most ${eth(a[0])} ETH more can be drawn on this job: advances stop at half of it.`),
  EarlyNotAllowed: () => "The customer did not allow an early advance on this job.",
  Barred: () => "The pool does not advance this agent any more.",
  OverLimit: (a) => (BigInt(String(a[0])) === 0n ? "Your limit with the pool is used up. It grows with your bond and with the fees your jobs pay in." : `Your limit with the pool allows ${eth(a[0])} ETH more right now.`),
  PoolShort: (a) => (BigInt(String(a[0])) === 0n ? "The pool has nothing to advance right now." : `The pool can advance ${eth(a[0])} ETH more right now.`),
  OwesThePool: (a) => `A bond can leave only while nothing is owed to the pool. ${eth(a[0])} ETH is out right now.`,
  OverBond: (a) => `Your bond is ${eth(a[0])} ETH.`,
  ZeroAmount: () => "Enter an amount.",
  NothingOwed: () => "Nothing is waiting to be collected.",
  GasShort: () => "The wallet sent it with too little gas. Try again.",
};

/** What a failed call or send was, in words. */
export function explain(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (declined(e)) return "You declined it in your wallet. Nothing was sent.";
  const err = e as { data?: unknown; message?: string; error?: { data?: unknown; message?: string }; cause?: { data?: unknown } };
  // the contract's own answer travels in `data`, wherever this wallet puts it
  for (const d of [err.data, err.error?.data, err.cause?.data, (err.data as { data?: unknown } | undefined)?.data, (err.data as { originalError?: { data?: unknown } } | undefined)?.originalError?.data]) {
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
      try {
        const r = decodeErrorResult({ abi: ABI, data: d as Hex });
        return WORDS[r.errorName]?.((r.args ?? []) as readonly unknown[]) ?? `The desk refuses it: ${r.errorName}.`;
      } catch {
        // not one of the desk's
      }
    }
  }
  const text = `${err.message ?? ""} ${err.error?.message ?? ""}`;
  if (/insufficient funds|exceeds balance/i.test(text)) return "This wallet does not hold enough ETH for that and the gas.";
  if (/revert/i.test(text)) return "The desk refuses it. Reload the page and look at the job again.";
  return (err.message ?? "It did not go through.").split("\n")[0].slice(0, 200);
}

/** ETH as typed ("0.04") in wei, or null when it is not an amount. */
export function toWei(text: string): bigint | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d{0,9}(\.\d{1,18})?$/.test(t) || t === "" || t === ".") return null;
  try {
    return parseEther(t);
  } catch {
    return null;
  }
}
export const fromWei = eth;
/** The proof of a delivery: a hash of what was handed over. The work itself is never sent anywhere by this. */
export const proofOf = (text: string): Hex => keccak256(toHex(text));

async function read<T>(p: Provider, desk: string, functionName: string, args: readonly unknown[]): Promise<T> {
  const data = await ethCall(p, desk, encodeFunctionData({ abi: ABI, functionName, args }));
  return decodeFunctionResult({ abi: ABI, functionName, data: data as Hex }) as T;
}

/** What can be drawn on a job right now, early and from the pool (they share the job's half). */
export async function canDrawOn(p: Provider, desk: string, id: number): Promise<{ early: bigint; fromPool: bigint }> {
  const [early, fromPool] = await read<readonly [bigint, bigint]>(p, desk, "canDrawOn", [BigInt(id)]);
  return { early, fromPool };
}

export const isRegistered = async (p: Provider, desk: string, who: string): Promise<boolean> => (await read<{ registered: boolean }>(p, desk, "agent", [who])).registered;

export interface Sent { hash: string; receipt: Receipt }

/**
 * One call to the desk: tried without sending, sent from the visitor's wallet, followed until it is mined.
 * `on` is told where it stands, so the page can say it.
 */
export async function send(p: Provider, desk: string, from: string, functionName: string, args: readonly unknown[], o: { value?: bigint; on?: (step: "checking" | "wallet" | "mining") => void } = {}): Promise<Sent> {
  o.on?.("checking");
  await ensureChain(p);
  // The desk must be a contract on the chain the wallet is really on. ETH sent to an address with nothing at it is
  // not refused by anything: it is simply gone. So this is asked before every send, of the wallet's own node.
  const code = await p.request({ method: "eth_getCode", params: [desk, "latest"] }).catch(() => null);
  if (typeof code !== "string" || code.length <= 2) throw new Refusal("Your wallet does not see the desk on the chain it is on. Nothing was sent. Check that the wallet is on Robinhood Chain.");
  const data = encodeFunctionData({ abi: ABI, functionName, args });
  try {
    await ethCall(p, desk, data, from, o.value);
  } catch (e) {
    throw new Refusal(explain(e));
  }
  o.on?.("wallet");
  const hash = await sendTx(p, { from, to: desk, data, value: o.value });
  o.on?.("mining");
  const receipt = await waitFor(p, hash);
  if (receipt.status !== "0x1") throw new Refusal("The transaction was mined and the desk refused it. Nothing changed. Reload the page and look again.");
  return { hash, receipt };
}

/** The number the desk gave a job, read from the transaction that locked it. */
export function lockedJob(receipt: Receipt, desk: string): number | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== desk.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      if (d.eventName === "Locked") return Number((d.args as unknown as { id: bigint }).id);
    } catch {
      // another event
    }
  }
  return null;
}

// What a wallet signs to name an agent or a job. The same words, to the letter, as engine/src/profiles.ts.
export const profileMessage = (address: string, name: string, does: string, at: number): string => `Factor agent profile\naddress: ${address}\nname: ${name}\ndoes: ${does}\nat: ${at}`;
export const titleMessage = (jobId: number, title: string, at: number): string => `Factor job\njob: ${jobId}\ntitle: ${title}\nat: ${at}`;
// What an agent's wallet signs for a key to its compute credit: the words of engine/src/compute.ts.
export const computeKeyMessage = (address: string, at: number): string => `Factor compute key\naddress: ${address}\nat: ${at}`;
