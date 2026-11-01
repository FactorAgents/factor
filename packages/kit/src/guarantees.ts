// Guarantees (contracts/src/FactorGuarantee.sol, docs/GUARANTEES.md): the guarantee contract's refusals in plain words,
// and the fee on a cover as the contract takes it.
import { BaseError, ContractFunctionRevertedError, formatEther } from "viem";
import { explain, Refusal } from "./words.js";

const eth = (wei: unknown): string => formatEther(BigInt(String(wei)));
const when = (s: unknown): string => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const STATE_WORD = ["no cover", "reserved", "tied to its job", "released", "paid", "declined", "lapsed"];

/** The guarantee contract's own refusals. A few share a name with the desk's, and mean something else here. */
export const GUARANTEE_WORDS: Record<string, (a: readonly unknown[]) => string> = {
  NotRegistered: () => "That agent has not registered on the desk.",
  NotAgent: () => "Only the agent's own wallet (or the key of its line account) runs its guarantee.",
  SelfCover: () => "An agent cannot buy cover on its own job.",
  TooSmall: (a) => `The smallest cover is ${eth(a[0])} ETH.`,
  JobTooSmall: (a) => `The smallest job is ${eth(a[0])} ETH.`,
  BadDueTime: () => "The due time must be between 1 hour and 30 days from now.",
  OverLimit: (a) => (BigInt(String(a[0])) === 0n ? "This agent sells no cover on this job right now: its score, its offer or its free bond allows none." : `This agent can cover up to ${eth(a[0])} ETH of this job right now.`),
  WrongFee: (a) => `The fee for this cover is ${eth(a[0])} ETH.`,
  OverFree: (a) => (BigInt(String(a[0])) === 0n ? "Nothing in the bond is free: all of it backs covers that have not ended." : `${eth(a[0])} ETH of the bond is free. The rest backs covers that have not ended.`),
  WrongState: (a) => `This cover is ${STATE_WORD[Number(a[0])] ?? "not open"}.`,
  Expired: (a) => `The hour to tie this cover ended ${when(a[0])}. It lapses back to the agent's bond.`,
  TooSoon: (a) => `Not before ${when(a[0])}.`,
  NotTheJob: () => "That job is not the one this cover was reserved for: same customer, agent, price, due time and early switch, locked after the reservation.",
  JobCovered: () => "That job has its cover already.",
  NoCover: () => "That job has no cover.",
  NotFinished: () => "The job is not finished on the desk yet. The cover ends when it is.",
  NothingOwed: () => "Nothing is waiting to be collected.",
  ZeroAmount: () => "The amount is zero.",
  GasShort: () => "It was sent with too little gas. Try again.",
};

/** What a failed guarantee call was, in words. */
export function guaranteeWordsOf(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (e instanceof BaseError) {
    const hit = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (hit instanceof ContractFunctionRevertedError && hit.data?.errorName && GUARANTEE_WORDS[hit.data.errorName]) return GUARANTEE_WORDS[hit.data.errorName]!((hit.data.args ?? []) as readonly unknown[]);
  }
  return explain(e);
}

/** The fee on a cover, as the contract takes it: 1% of it. When the cover ends, half (rounded down) buys back and burns $FACTOR and the rest goes to the agent; all of it goes back to the customer if the agent declines. */
export function coverFee(cover: bigint): { fee: bigint; burned: bigint; toAgent: bigint } {
  const fee = (cover * 100n) / 10_000n, burned = fee / 2n;
  return { fee, burned, toAgent: fee - burned };
}
