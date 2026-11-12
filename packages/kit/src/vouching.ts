// Vouching (contracts/src/FactorVouch.sol, docs/VOUCHING.md): the vouching contract's refusals in plain words, and the
// fee on a vouch as the contract takes it.
import { BaseError, ContractFunctionRevertedError, formatEther } from "viem";
import { explain, Refusal } from "./words.js";

const eth = (wei: unknown): string => formatEther(BigInt(String(wei)));
const when = (s: unknown): string => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const STATE_WORD = ["no vouch", "offered, waiting for the agent", "standing", "kept", "failed", "returned", "withdrawn"];

/** The vouching contract's own refusals. A few share a name with the desk's or the guarantee contract's, and mean something else here. */
export const VOUCH_WORDS: Record<string, (a: readonly unknown[]) => string> = {
  NotRegistered: () => "That agent has not registered on the desk.",
  NotVoucher: () => "Only the voucher's own wallet (or the key of its line account) runs its vouching bond and offers.",
  NotAgent: () => "Only the vouched agent's own wallet (or the key of its line account) accepts or releases its vouch.",
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
  ZeroAmount: () => "The amount is zero.",
  GasShort: () => "It was sent with too little gas. Try again.",
};

/** What a failed vouching call was, in words. */
export function vouchWordsOf(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (e instanceof BaseError) {
    const hit = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (hit instanceof ContractFunctionRevertedError && hit.data?.errorName && VOUCH_WORDS[hit.data.errorName]) return VOUCH_WORDS[hit.data.errorName]!((hit.data.args ?? []) as readonly unknown[]);
  }
  return explain(e);
}

/** The fee on a vouch, as the contract takes it: 2% of the amount, paid by the vouched agent. Kept, half (rounded down) goes to the voucher's bond and the rest buys back and burns $FACTOR; failed, it pays the loss first; returned, it goes back. */
export function vouchFee(amount: bigint): { fee: bigint; toVoucher: bigint; burned: bigint } {
  const fee = (amount * 200n) / 10_000n, toVoucher = fee / 2n;
  return { fee, toVoucher, burned: fee - toVoucher };
}
