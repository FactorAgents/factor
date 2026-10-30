// Credit lines (contracts/src/FactorLine.sol, docs/CREDIT-LINES.md): the line contract's and the line account's
// refusals in plain words, and the fee on a draw as the contract takes it.
import { BaseError, ContractFunctionRevertedError, formatEther } from "viem";
import { explain, Refusal } from "./words.js";

const eth = (wei: unknown): string => formatEther(BigInt(String(wei)));
const when = (s: unknown): string => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** The line's own refusals. A few share a name with the desk's, and mean something else here. */
export const LINE_WORDS: Record<string, (a: readonly unknown[]) => string> = {
  NotRegistered: () => "Register this wallet as an agent first: a line is opened by an agent with a record on the desk.",
  Barred: () => "This agent is barred on the desk, so it cannot open a line.",
  HasLine: () => "This wallet has its line already. One line per agent.",
  IsLineAccount: () => "A line account cannot open a line of its own.",
  NoLine: () => "This wallet has no credit line yet. Open one first (openLine).",
  TooSmall: (a) => `The smallest draw is ${eth(a[0])} ETH.`,
  IsDefaulted: () => "This line was never repaid and is barred for good.",
  IsLate: (a) => `The line was due ${when(a[0])}. Repay it before drawing again.`,
  OverLimit: (a) => (BigInt(String(a[0])) === 0n ? "Nothing is left of the line's limit right now. It grows with the bond and the job fees at the line account." : `The line allows ${eth(a[0])} ETH more right now.`),
  PoolShort: (a) => (BigInt(String(a[0])) === 0n ? "The line pool has nothing to lend right now." : `The line pool can lend ${eth(a[0])} ETH more right now.`),
  OverDebt: (a) => `The line owes ${eth(a[0])} ETH. Repay that much at most.`,
  NothingOwed: () => "Nothing is owed or waiting.",
  TooSoon: (a) => `Not before ${when(a[0])}.`,
  NotKey: () => "Only the agent's own wallet runs its line account.",
  Owes: (a) => `The line is owed ${eth(a[0])} ETH. Nothing leaves the line account until it is repaid.`,
  NotFree: (a) => `The line account holds ${eth(a[0])} ETH beyond what the line is owed.`,
  OverLineRoom: (a) => `With the line, the pool can advance ${eth(a[0])} ETH more on this job.`,
  ZeroAmount: () => "The amount is zero.",
  GasShort: () => "It was sent with too little gas. Try again.",
};

/** What a failed line call was, in words. */
export function lineWordsOf(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (e instanceof BaseError) {
    const hit = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (hit instanceof ContractFunctionRevertedError && hit.data?.errorName && LINE_WORDS[hit.data.errorName]) return LINE_WORDS[hit.data.errorName]!((hit.data.args ?? []) as readonly unknown[]);
  }
  return explain(e);
}

/** The fee on a draw, as the contract takes it: 2% of it, half burned and half to the line pool. The rest reaches the agent (or its compute credit). */
export function drawParts(wei: bigint): { fee: bigint; burned: bigint; toPool: bigint; net: bigint } {
  const fee = (wei * 200n) / 10_000n, burned = (wei * 100n) / 10_000n;
  return { fee, burned, toPool: fee - burned, net: wei - fee };
}
