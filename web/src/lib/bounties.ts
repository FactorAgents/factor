// Bounties, as a visitor's wallet or account sends them (contracts/src/FactorBounty.sol): a poster locks a prize for a
// task, an agent enters with a hash of its finished work and a bond, the poster reads the entries from the deadline with
// one signature and picks a winner, and the winner delivers on the desk. Anyone can take the steps that are timed.
// Amounts are wei, always. The words a poster signs are the same, to the letter, as the engine checks
// (engine/src/bounties.ts), and so is the hash.
//
// Every call is tried first without being sent: a call the contract would refuse never reaches the wallet, and the
// visitor is told why in plain words.
import { decodeErrorResult, decodeEventLog, encodeAbiParameters, encodeFunctionData, formatEther, keccak256, toHex, type Abi, type Hex } from "viem";
import { factorBountyAbi } from "./abi/FactorBounty";
import { factorDeskAbi } from "./abi/FactorDesk";
import { explain as deskExplain, Refusal, wordsFor } from "./desk";
import { declined, ensureChain, ethCall, sendTx, signText, waitFor, type Provider, type Receipt } from "./wallet";
import type { BountyEntry, BountyStatus } from "./types";

export const BOUNTY_ABI = factorBountyAbi as Abi;
const ALL = [...BOUNTY_ABI, ...(factorDeskAbi as Abi)].filter((x) => x.type === "error") as Abi;

export const MIN_PRIZE_WEI = 5_000_000_000_000_000n;
export const TASK_BYTES = 8000;
export const WORK_BYTES = 200_000;
export const feeFor = (prize: bigint): bigint => (prize * 100n) / 10_000n;
export const bondFor = (prize: bigint): bigint => (prize * 100n) / 10_000n;
export const textHash = (text: string): Hex => keccak256(toHex(text));
/** What an entrant commits to: FactorBounty.entryHash, to the letter. Its proof on the desk if it wins. */
export const entryHashOf = (contract: string, id: number, agent: string, workHash: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }], [contract as Hex, BigInt(id), agent as Hex, workHash]));
export const readMessage = (o: { id: number; poster: string; at: number }): string => ["Factor: read the entries of a bounty", `bounty: ${o.id}`, `poster: ${o.poster}`, `at: ${o.at}`].join("\n");
export const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

const eth = (wei: unknown): string => {
  const s = formatEther(BigInt(String(wei)));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};
const when = (s: unknown): string => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const STATE_WORD = ["not on the chain", "open", "picked already", "won", "split", "ended", "over: nobody entered"];

/** The contract's refusals, in plain words. The desk's are said by lib/desk.ts. */
const WORDS: Record<string, (a: readonly unknown[]) => string> = {
  TooSmall: (a) => `The smallest prize is ${eth(a[0])} ETH.`,
  BadDeadline: () => "The deadline must be between 1 hour and 30 days from now.",
  BadScore: () => "A minimum score is at most 1000, the top of the desk's score.",
  NoTask: () => "Say what the task is.",
  WrongValue: (a) => `It takes exactly ${eth(a[0])} ETH.`,
  WrongState: (a) => `This bounty is ${STATE_WORD[Number(a[0])] ?? "not open"}.`,
  TooSoon: (a) => `Not before ${when(a[0])}.`,
  TooLate: (a) => `That ended ${when(a[0])}.`,
  NotAgent: () => "Only the agent's own wallet or account (or the key of its line account) can enter for it. Connect that one.",
  NotPoster: () => "Only the wallet or account that posted this bounty can pick its winner.",
  NoHash: () => "There is no work to enter.",
  NotRegistered: () => "That address has not registered as an agent on the desk. Register on the Take a job page first.",
  Barred: () => "An agent barred on the desk cannot enter.",
  OwnBounty: () => "The poster of a bounty cannot enter it.",
  AlreadyIn: () => "This agent has entered this bounty already. One entry for one agent, and a line account and its key count as one.",
  Full: () => "This bounty has all the entries it takes.",
  ScoreTooLow: (a) => `The poster asks for a Factor Score of ${String(a[1])}. This agent has ${String(a[0])}.`,
  NotAnEntrant: () => "Only an agent that entered can be picked.",
  BondsAlreadyBack: () => "The bonds have gone back already.",
  NothingOwed: () => "Nothing is waiting to be collected.",
  GasShort: () => "The wallet sent it with too little gas. Try again.",
};

/** What a failed call was, in words. */
export function explainBounty(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (declined(e)) return "You declined it in your wallet. Nothing was sent.";
  const err = e as { data?: unknown; error?: { data?: unknown }; cause?: { data?: unknown } };
  for (const d of [err.data, err.error?.data, err.cause?.data, (err.data as { data?: unknown } | undefined)?.data, (err.data as { originalError?: { data?: unknown } } | undefined)?.originalError?.data]) {
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
      try {
        const r = decodeErrorResult({ abi: ALL, data: d as Hex });
        const args = (r.args ?? []) as readonly unknown[];
        return WORDS[r.errorName]?.(args) ?? wordsFor(r.errorName, args) ?? `The contract refuses it: ${r.errorName}.`;
      } catch {
        // not one of these
      }
    }
  }
  return deskExplain(e);
}

/** One call to the bounty contract: tried without sending, sent, followed until it is mined. */
export async function sendBounty(p: Provider, o: { bounty: string; from: string; fn: string; args?: readonly unknown[]; value?: bigint; on?: (step: "checking" | "wallet" | "mining") => void }): Promise<{ hash: string; receipt: Receipt }> {
  o.on?.("checking");
  await ensureChain(p);
  const code = await p.request({ method: "eth_getCode", params: [o.bounty, "latest"] }).catch(() => null);
  if (typeof code !== "string" || code.length <= 2) throw new Refusal("Your wallet does not see the bounty contract on the chain it is on. Nothing was sent. Check that the wallet is on Robinhood Chain.");
  const data = encodeFunctionData({ abi: BOUNTY_ABI, functionName: o.fn, args: o.args ?? [] });
  try {
    await ethCall(p, o.bounty, data, o.from, o.value);
  } catch (e) {
    throw new Refusal(explainBounty(e));
  }
  o.on?.("wallet");
  let hash: string;
  try {
    hash = await sendTx(p, { from: o.from, to: o.bounty, data, value: o.value });
  } catch (e) {
    throw new Refusal(explainBounty(e));
  }
  o.on?.("mining");
  const receipt = await waitFor(p, hash);
  if (receipt.status !== "0x1") throw new Refusal(receipt.reason ?? "The transaction was mined and refused. Nothing changed. Reload the page and look again.");
  return { hash: receipt.transactionHash || hash, receipt };
}

/** The number the contract gave a bounty, read from the transaction that posted it. */
export function postedBounty(receipt: Receipt, bounty: string): number | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== bounty.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: BOUNTY_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      if (d.eventName === "Posted") return Number((d.args as unknown as { id: bigint }).id);
    } catch {
      // another event
    }
  }
  return null;
}

async function ask<T>(path: "bounties/task" | "bounties/entry" | "bounties/read", body: Record<string, unknown>, patient = false): Promise<T> {
  for (let tries = 0; ; tries++) {
    const r = await fetch(`/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return (await r.json()) as T;
    const said = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "It could not be saved.";
    // what was just sent shows up on the chain's side a moment later: asked again
    if (!(patient && r.status === 404 && tries < 15)) throw new Refusal(said.charAt(0).toUpperCase() + said.slice(1) + (said.endsWith(".") ? "" : "."));
    await new Promise((res) => setTimeout(res, 2000));
  }
}

/** The words of a task go to the engine, which takes them because they hash to what the bounty holds. */
export const sendTask = (id: number, task: string): Promise<unknown> => ask("bounties/task", { id, task }, true);
/** The work of an entry goes to the engine, which takes it because it hashes to what the agent committed. */
export const sendWork = (id: number, agent: string, work: string): Promise<unknown> => ask("bounties/entry", { id, agent, work }, true);

/** The poster reads its bounty's entries, from the deadline, with one signature. */
export async function readEntries(p: Provider, o: { id: number; poster: string; at: number }): Promise<BountyEntry[]> {
  const signature = await signText(p, readMessage(o), o.poster);
  const a = await ask<{ items: BountyEntry[] }>("bounties/read", { ...o, signature });
  return a.items;
}

export const STATUS_WORD: Record<BountyStatus, string> = {
  open: "Taking entries", choosing: "The poster is choosing", ending: "Time is up", picked: "Winner picked", won: "Won", unpicked: "Split: no winner picked", undelivered: "Winner did not deliver", empty: "Nobody entered",
};
