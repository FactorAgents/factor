// Milestones, as a visitor's wallet or account sends them (contracts/src/FactorMilestones.sol): a customer locks the
// whole budget of a job in 2 to 6 stages, each stage is locked on the desk as a job for the agent the moment the stage
// before it is paid, and the customer accepts or rejects each stage through the milestone contract. Anyone can take the
// steps that are timed. Amounts are wei, always. The words of a plan and their hash are the same, to the letter, as the
// engine checks (engine/src/milestones.ts).
//
// Every call is tried first without being sent: a call the contract would refuse never reaches the wallet, and the
// visitor is told why in plain words.
import { decodeErrorResult, decodeEventLog, encodeFunctionData, formatEther, keccak256, toHex, type Abi, type Hex } from "viem";
import { factorMilestonesAbi } from "./abi/FactorMilestones";
import { factorDeskAbi } from "./abi/FactorDesk";
import { explain as deskExplain, Refusal, wordsFor } from "./desk";
import { declined, ensureChain, ethCall, sendTx, waitFor, type Provider, type Receipt } from "./wallet";
import type { StageStatus } from "./types";

export const MILESTONES_ABI = factorMilestonesAbi as Abi;
const ALL = [...MILESTONES_ABI, ...(factorDeskAbi as Abi)].filter((x) => x.type === "error") as Abi;

export const MIN_STAGES = 2;
export const MAX_STAGES = 6;
export const MIN_STAGE_WEI = 1_000_000_000_000_000n;
export const TITLE_MOST = 80;
export const BRIEF_MOST = 12_000;
export const TERMS_BYTES = 40_000;
/** The times a stage can have, from the moment it is locked on the desk: inside the desk's 1 hour to 30 days. */
export const STAGE_TIMES: [string, number][] = [["2 hours", 2 * 3600], ["24 hours", 86_400], ["3 days", 3 * 86_400], ["7 days", 7 * 86_400], ["14 days", 14 * 86_400], ["30 days", 30 * 86_400]];

export interface Terms { title: string; stages: { title: string; brief: string }[] }
/** The words as they are hashed: compact JSON, keys in this order. The engine and the kit write the same. */
export const termsText = (t: Terms): string => JSON.stringify({ title: t.title, stages: t.stages.map((s) => ({ title: s.title, brief: s.brief })) });
export const termsHash = (text: string): Hex => keccak256(toHex(text));
export const bytesOf = (text: string): number => new TextEncoder().encode(text).length;
/** A title as the engine takes it (engine/src/profiles.ts, oneLine): one plain line of 3 to 80 characters, no markup, no links. null: it is not one. */
export function titleOf(raw: string): string | null {
  const t = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (t.length < 3 || t.length > TITLE_MOST) return null;
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff<>]/.test(t)) return null;
  if (/https?:|www\.|:\/\/|\.(com|io|xyz|fun|net|org|gg|me|app)\b/i.test(t)) return null;
  return t;
}
/** A stage's brief as the engine takes it (engine/src/profiles.ts, briefText). null: it is not one. */
export function briefOf(raw: string): string | null {
  const t = raw.replace(/\r\n?/g, "\n").trim();
  if (t.length < 1 || t.length > BRIEF_MOST) return null;
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/.test(t)) return null;
  return t;
}

const eth = (wei: unknown): string => {
  const s = formatEther(BigInt(String(wei)));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};
const STATE_WORD = ["not on the chain", "running", "done: every stage was paid", "over: a stage was missed", "over: a stage was declined", "over: a stage was rejected"];

/** The contract's refusals, in plain words. The desk's are said by lib/desk.ts. */
const WORDS: Record<string, (a: readonly unknown[]) => string> = {
  BadStages: () => `A job in stages has ${MIN_STAGES} to ${MAX_STAGES} stages, each with a price and a time.`,
  TooSmall: (a) => `The smallest stage is ${eth(a[0])} ETH, the desk's smallest job.`,
  BadTime: () => "Each stage's time is between 1 hour and 30 days.",
  NoTerms: () => "Say what each stage is.",
  WrongValue: (a) => `It takes exactly ${eth(a[0])} ETH: every stage's price together.`,
  NotRegistered: () => "That address has not registered as an agent on the desk.",
  NotCustomer: () => "Only the wallet or account that hired in stages can accept or reject a stage.",
  WrongState: (a) => `This plan is ${STATE_WORD[Number(a[0])] ?? "not running"}.`,
  NothingOwed: () => "Nothing is waiting to be collected.",
  GasShort: () => "The wallet sent it with too little gas. Try again.",
};

/** What a failed call was, in words. */
export function explainMilestones(e: unknown): string {
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

/** One call to the milestone contract: tried without sending, sent, followed until it is mined. */
export async function sendMilestones(p: Provider, o: { contract: string; from: string; fn: string; args?: readonly unknown[]; value?: bigint; on?: (step: "checking" | "wallet" | "mining") => void }): Promise<{ hash: string; receipt: Receipt }> {
  o.on?.("checking");
  await ensureChain(p);
  const code = await p.request({ method: "eth_getCode", params: [o.contract, "latest"] }).catch(() => null);
  if (typeof code !== "string" || code.length <= 2) throw new Refusal("Your wallet does not see the milestone contract on the chain it is on. Nothing was sent. Check that the wallet is on Robinhood Chain.");
  const data = encodeFunctionData({ abi: MILESTONES_ABI, functionName: o.fn, args: o.args ?? [] });
  try {
    await ethCall(p, o.contract, data, o.from, o.value);
  } catch (e) {
    throw new Refusal(explainMilestones(e));
  }
  o.on?.("wallet");
  let hash: string;
  try {
    hash = await sendTx(p, { from: o.from, to: o.contract, data, value: o.value });
  } catch (e) {
    throw new Refusal(explainMilestones(e));
  }
  o.on?.("mining");
  const receipt = await waitFor(p, hash);
  if (receipt.status !== "0x1") throw new Refusal(receipt.reason ?? "The transaction was mined and refused. Nothing changed. Reload the page and look again.");
  return { hash: receipt.transactionHash || hash, receipt };
}

/** The plan's number and its first stage's desk job, read from the transaction that hired in stages. */
export function postedPlan(receipt: Receipt, contract: string): { id: number; job: number | null } | null {
  let id: number | null = null, job: number | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: MILESTONES_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      if (d.eventName === "Posted") id = Number((d.args as unknown as { id: bigint }).id);
      if (d.eventName === "Opened") job = Number((d.args as unknown as { job: bigint }).job);
    } catch {
      // another event
    }
  }
  return id === null ? null : { id, job };
}

/** The words of a plan go to the engine, which takes them because they hash to what the plan holds. */
export async function sendTerms(id: number, terms: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    const r = await fetch("/api/v1/milestones/terms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, terms }) });
    if (r.ok) return;
    const said = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "It could not be saved.";
    // what was just sent shows up on the chain's side a moment later: asked again
    if (!(r.status === 404 && tries < 15)) throw new Refusal(said.charAt(0).toUpperCase() + said.slice(1) + (said.endsWith(".") ? "" : "."));
    await new Promise((res) => setTimeout(res, 2000));
  }
}

export const STAGE_WORD: Record<StageStatus, string> = {
  waiting: "Not started", open: "On the desk", delivered: "Delivered", paid: "Paid", missed: "Missed", declined: "Declined", rejected: "Rejected", returned: "Back to the customer",
};
export const STAGE_TONE: Partial<Record<StageStatus, string>> = { paid: "go", open: "warn", delivered: "warn", missed: "bad", declined: "bad", rejected: "bad" };
export const PLAN_WORD = { running: "Running", done: "Every stage paid", missed: "A stage was missed", declined: "A stage was declined", rejected: "A stage was rejected" } as const;

/** A stage's time, in words. */
export const timeWord = (s: number): string => (s % 86_400 === 0 ? `${s / 86_400} day${s === 86_400 ? "" : "s"}` : s % 3600 === 0 ? `${s / 3600} hour${s === 3600 ? "" : "s"}` : `${Math.round(s / 60)} minutes`);
