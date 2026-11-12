// Vouching, as a visitor's wallet sends it (contracts/src/FactorVouch.sol): a strong agent adds to its vouching bond,
// takes out what is free, and offers to co-sign another agent's credit line or a cover on one of its jobs; the vouched
// agent accepts an offer by paying its fee, and releases a vouch on its line while the line owes nothing; the voucher
// withdraws an offer not accepted yet; anyone settles a vouch whose line or cover has ended. Amounts are wei, always.
//
// Every call is tried first without being sent: a call the contract would refuse never reaches the wallet, and the
// visitor is told why in plain words.
import { decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeFunctionData, formatEther, type Abi, type Hex } from "viem";
import { factorVouchAbi } from "./abi/FactorVouch";
import { explain as deskExplain, Refusal, wordsFor, type Sent } from "./desk";
import { declined, ensureChain, ethCall, sendTx, waitFor, type Provider, type Receipt } from "./wallet";

export const VOUCH_ABI = factorVouchAbi as Abi;
const ERRORS = VOUCH_ABI.filter((x) => x.type === "error") as Abi;

const eth = (wei: unknown): string => {
  const s = formatEther(BigInt(String(wei)));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};
const when = (s: unknown): string => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const STATE_WORD = ["no vouch", "offered, waiting for the agent", "standing", "kept", "failed", "returned", "withdrawn"];

// The vouching contract's own refusals, in plain words. The desk's are said by lib/desk.ts.
const WORDS: Record<string, (a: readonly unknown[]) => string> = {
  NotRegistered: () => "That agent has not registered on the desk.",
  NotVoucher: () => "Only the voucher's own wallet (or the key of its line account) runs its vouching bond and offers. Connect that wallet.",
  NotAgent: () => "Only the vouched agent's own wallet (or the key of its line account) accepts or releases its vouch. Connect that wallet.",
  ScoreTooLow: (a) => `A voucher needs a score of ${String(a[1])} or more; this one has ${String(a[0])}.`,
  TooSmall: (a) => `The smallest vouch is ${eth(a[0])} ETH.`,
  Related: () => "An agent cannot vouch for itself, its own line account or key, or a cover its own customer wallet bought.",
  OverShare: (a) => (BigInt(String(a[0])) === 0n ? "This voucher already holds a quarter of its bond for that agent: the most for one agent." : `This voucher can hold back ${eth(a[0])} ETH more for that agent: a quarter of its bond at most.`),
  OverFree: (a) => (BigInt(String(a[0])) === 0n ? "Nothing in the vouching bond is free: all of it backs vouches that have not ended." : `${eth(a[0])} ETH of the vouching bond is free. The rest backs vouches that have not ended.`),
  AlreadyVouched: (a) => `This voucher has vouch ${String(a[0])} open on that already. One at a time.`,
  NoLine: () => "That address is not a credit line's account.",
  LineDefaulted: () => "That credit line has defaulted.",
  LineLate: (a) => `That credit line is late: it was due ${when(a[0])}.`,
  DebtGrew: (a) => `The line owes ${eth(a[0])} ETH now, more than when the vouch was offered. Repay down to that first, or ask for a new offer.`,
  NotCovered: () => "That cover is not tied to a desk job.",
  JobNotOpen: () => "The covered job is not open for a vouch: it was drawn on, delivered, declined, or is past its due time.",
  WrongState: (a) => `This vouch is ${STATE_WORD[Number(a[0])] ?? "not open"}.`,
  WrongKind: () => "Only a vouch on a credit line can be released early.",
  WrongFee: (a) => `The fee for this vouch is ${eth(a[0])} ETH.`,
  Expired: (a) => `The offer's seven days ended ${when(a[0])}.`,
  TooSoon: (a) => `Not before ${when(a[0])}.`,
  NotYet: () => "Its outcome is not on the chain yet: the line's 30 days are not over or its debt is still open, or the covered job is not finished.",
  StillOwes: (a) => `The line owes ${eth(a[0])} ETH. A vouch is released only while the line owes nothing.`,
  NothingOwed: () => "Nothing is waiting to be collected.",
  ZeroAmount: () => "Enter an amount.",
  GasShort: () => "The wallet sent it with too little gas. Try again.",
};

/** What a failed vouching call was, in words. */
export function explainVouch(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (declined(e)) return "You declined it in your wallet. Nothing was sent.";
  const err = e as { data?: unknown; error?: { data?: unknown }; cause?: { data?: unknown } };
  for (const d of [err.data, err.error?.data, err.cause?.data, (err.data as { data?: unknown } | undefined)?.data, (err.data as { originalError?: { data?: unknown } } | undefined)?.originalError?.data]) {
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
      try {
        const r = decodeErrorResult({ abi: ERRORS, data: d as Hex });
        const args = (r.args ?? []) as readonly unknown[];
        return WORDS[r.errorName]?.(args) ?? wordsFor(r.errorName, args) ?? `The contract refuses it: ${r.errorName}.`;
      } catch {
        // not one of these
      }
    }
  }
  return deskExplain(e);
}

/** The fee on a vouch, as the contract takes it: 2% of the amount, paid by the vouched agent. */
export const feeFor = (amount: bigint): bigint => (amount * 200n) / 10_000n;

async function haveCode(p: Provider, to: string): Promise<void> {
  const code = await p.request({ method: "eth_getCode", params: [to, "latest"] }).catch(() => null);
  if (typeof code !== "string" || code.length <= 2) throw new Refusal("Your wallet does not see the vouching contract on the chain it is on. Nothing was sent. Check that the wallet is on Robinhood Chain.");
}

/** One call to the vouching contract: tried without sending, sent, followed until it is mined. */
export async function sendVouch(p: Provider, o: { contract: string; from: string; fn: string; args?: readonly unknown[]; value?: bigint; on?: (step: "checking" | "wallet" | "mining") => void }): Promise<Sent> {
  o.on?.("checking");
  await ensureChain(p);
  await haveCode(p, o.contract);
  const data = encodeFunctionData({ abi: VOUCH_ABI, functionName: o.fn, args: o.args ?? [] });
  try {
    await ethCall(p, o.contract, data, o.from, o.value);
  } catch (e) {
    throw new Refusal(explainVouch(e));
  }
  o.on?.("wallet");
  let hash: string;
  try {
    hash = await sendTx(p, { from: o.from, to: o.contract, data, value: o.value });
  } catch (e) {
    throw new Refusal(explainVouch(e));
  }
  o.on?.("mining");
  const receipt = await waitFor(p, hash);
  if (receipt.status !== "0x1") throw new Refusal(receipt.reason ?? "The transaction was mined and refused. Nothing changed. Reload the page and look again.");
  return { hash: receipt.transactionHash || hash, receipt };
}

async function read<T>(p: Provider, contract: string, fn: string, args: readonly unknown[]): Promise<T> {
  const data = await ethCall(p, contract, encodeFunctionData({ abi: VOUCH_ABI, functionName: fn, args }));
  return decodeFunctionResult({ abi: VOUCH_ABI, functionName: fn, data: data as Hex }) as T;
}

/** The most `voucher` can vouch for `agent` right now, read from the contract: 0 under the least score, or for itself. */
export const canVouch = (p: Provider, contract: string, voucher: string, agent: string): Promise<bigint> => read<bigint>(p, contract, "canVouch", [voucher, agent]);
/** What of a voucher's bond no vouch holds back. */
export const freeOf = (p: Provider, contract: string, voucher: string): Promise<bigint> => read<bigint>(p, contract, "freeOf", [voucher]);
/** The score the contract counts for a voucher. */
export const scoreOf = (p: Provider, contract: string, voucher: string): Promise<bigint> => read<bigint>(p, contract, "scoreOf", [voucher]);

/** The number the contract gave an offer, read from the transaction that made it. */
export function offeredId(receipt: Receipt, contract: string): number | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: VOUCH_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      if (d.eventName === "Offered") return Number((d.args as unknown as { id: bigint }).id);
    } catch {
      // another event
    }
  }
  return null;
}

/** What happens next to a vouch, in words. */
export function nextWords(v: { kind: "line" | "cover"; state: string; agentName: string; amountEth: number; next?: { what: string; at: string } }, dayTime: (iso: string) => string): string | null {
  const n = v.next;
  if (!n) return null;
  if (n.what === "accept") return `Waiting for ${v.agentName} to accept it, until ${dayTime(n.at)}.`;
  if (n.what === "lapsed") return "Never accepted: anyone can withdraw it, and its amount is free in the bond again.";
  if (n.what === "settle") return "Its outcome is on the chain: Factor settles it by itself, and anyone may now.";
  if (n.what === "ends") return `Stands until ${dayTime(n.at)}. Kept then if the line owes nothing.`;
  if (n.what === "waits-for-repayment") return `Its 30 days are over and the line still owes: kept once that debt is repaid, or the line pool is paid if it defaults, from ${dayTime(n.at)}.`;
  if (n.what === "kept-when-settled") return `Delivered: kept once the job settles, ${dayTime(n.at)} at the latest.`;
  if (n.what === "pays-if-not-delivered") return `If the job is not delivered by ${dayTime(n.at)}, its customer is paid the vouched amount.`;
  return null;
}
