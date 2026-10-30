// A credit line's calls, as a visitor's wallet sends them (contracts/src/FactorLine.sol): open the line, draw on it as
// cash or as compute, repay it, add a bond at the line account, take out what is free, and sweep the account's income
// into the line. Amounts are wei, always.
//
// Every call is tried first without being sent: a call the contract would refuse never reaches the wallet, and the
// visitor is told why in plain words.
import { decodeErrorResult, encodeFunctionData, formatEther, type Abi, type Hex } from "viem";
import { factorDeskAbi } from "./abi/FactorDesk";
import { factorLineAbi } from "./abi/FactorLine";
import { factorLineAccountAbi } from "./abi/FactorLineAccount";
import { explain as deskExplain, Refusal, wordsFor, type Sent } from "./desk";
import { declined, ensureChain, ethCall, sendTx, waitFor, type Provider } from "./wallet";

export const LINE_ABI = factorLineAbi as Abi;
export const LINE_ACCOUNT_ABI = factorLineAccountAbi as Abi;
const ALL = [...LINE_ABI, ...LINE_ACCOUNT_ABI, ...(factorDeskAbi as Abi)].filter((x) => x.type === "error") as Abi;

const eth = (wei: unknown): string => {
  const s = formatEther(BigInt(String(wei)));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};
const when = (s: unknown): string => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

// The line's own refusals, in plain words. The desk's are said by lib/desk.ts.
const WORDS: Record<string, (a: readonly unknown[]) => string> = {
  NotRegistered: () => "Register this wallet as an agent first: a line is opened by an agent with a record on the desk.",
  Barred: () => "This agent is barred on the desk, so it cannot open a line.",
  HasLine: () => "This wallet has its line already. One line per agent.",
  IsLineAccount: () => "A line account cannot open a line of its own.",
  NoLine: () => "This wallet has no credit line yet. Open one first.",
  TooSmall: (a) => `The smallest draw is ${eth(a[0])} ETH.`,
  IsDefaulted: () => "This line was never repaid and is barred for good.",
  IsLate: (a) => `The line was due ${when(a[0])}. Repay it before drawing again.`,
  OverLimit: (a) => (BigInt(String(a[0])) === 0n ? "Nothing is left of the line's limit right now. It grows with the bond and the job fees at the line account." : `The line allows ${eth(a[0])} ETH more right now.`),
  PoolShort: (a) => (BigInt(String(a[0])) === 0n ? "The line pool has nothing to lend right now." : `The line pool can lend ${eth(a[0])} ETH more right now.`),
  OverDebt: (a) => `The line owes ${eth(a[0])} ETH. Repay that much at most.`,
  NothingOwed: () => "Nothing is owed or waiting.",
  TooSoon: (a) => `Not before ${when(a[0])}.`,
  NotKey: () => "Only the agent's own wallet runs its line account. Connect that wallet.",
  Owes: (a) => `The line is owed ${eth(a[0])} ETH. Nothing leaves the account until it is repaid.`,
  NotFree: (a) => `The account holds ${eth(a[0])} ETH beyond what the line is owed.`,
  OverLineRoom: (a) => `With the line, the pool can advance ${eth(a[0])} ETH more on this job.`,
  ZeroAmount: () => "Enter an amount.",
  GasShort: () => "The wallet sent it with too little gas. Try again.",
};

/** What a failed line call was, in words. */
export function explainLine(e: unknown): string {
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

/** One call to the line contract or a line account: tried without sending, sent, followed until it is mined. */
export async function sendLine(p: Provider, o: { to: string; abi: Abi; from: string; fn: string; args?: readonly unknown[]; value?: bigint; on?: (step: "checking" | "wallet" | "mining") => void }): Promise<Sent> {
  o.on?.("checking");
  await ensureChain(p);
  // the contract must be there on the chain the wallet is really on: ETH sent to an empty address is simply gone
  const code = await p.request({ method: "eth_getCode", params: [o.to, "latest"] }).catch(() => null);
  if (typeof code !== "string" || code.length <= 2) throw new Refusal("Your wallet does not see the credit line contract on the chain it is on. Nothing was sent. Check that the wallet is on Robinhood Chain.");
  const data = encodeFunctionData({ abi: o.abi, functionName: o.fn, args: o.args ?? [] });
  try {
    await ethCall(p, o.to, data, o.from, o.value);
  } catch (e) {
    throw new Refusal(explainLine(e));
  }
  o.on?.("wallet");
  let hash: string;
  try {
    hash = await sendTx(p, { from: o.from, to: o.to, data, value: o.value });
  } catch (e) {
    throw new Refusal(explainLine(e));
  }
  o.on?.("mining");
  const receipt = await waitFor(p, hash);
  if (receipt.status !== "0x1") throw new Refusal(receipt.reason ?? "The transaction was mined and refused. Nothing changed. Reload the page and look again.");
  return { hash: receipt.transactionHash || hash, receipt };
}

/** The fee on a draw, as the contract takes it: 2% of it, half burned and half to the pool; the rest reaches the agent. */
export function drawParts(wei: bigint): { fee: bigint; burned: bigint; toPool: bigint; net: bigint } {
  const fee = (wei * 200n) / 10_000n, burned = (wei * 100n) / 10_000n;
  return { fee, burned, toPool: fee - burned, net: wei - fee };
}
