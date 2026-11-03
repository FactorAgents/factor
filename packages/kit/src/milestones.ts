// Milestones (contracts/src/FactorMilestones.sol, docs/MILESTONES.md): the milestone contract's refusals in plain words, and
// the words of a job in stages and their hash. The words and the hash are the same, to the letter, as the engine checks
// (engine/src/milestones.ts) and the site builds (web/src/lib/milestones.ts).
import { BaseError, ContractFunctionRevertedError, formatEther, keccak256, toHex, type Hex } from "viem";
import { explain, Refusal } from "./words.js";

const eth = (wei: unknown): string => formatEther(BigInt(String(wei)));
/** The contract's states, in the order it numbers them. */
export const MILESTONE_STATES = ["none", "running", "done", "missed", "declined", "rejected"] as const;
const STATE_WORD = ["not on the chain", "running", "done: every stage was paid", "over: a stage was missed", "over: a stage was declined", "over: a stage was rejected"];

export const MIN_STAGES = 2;
export const MAX_STAGES = 6;
/** The smallest stage (the desk's smallest job), a stage's shortest and longest time, and the most the words may be. */
export const MIN_STAGE_WEI = 1_000_000_000_000_000n;
export const MIN_STAGE_S = 3600;
export const MAX_STAGE_S = 30 * 86_400;
export const TITLE_MOST = 80;
export const BRIEF_MOST = 12_000;
export const TERMS_BYTES = 40_000;

/** A job in stages, in words: its title, and each stage's title and brief. */
export interface Terms { title: string; stages: { title: string; brief: string }[] }
/** The words as they are hashed: compact JSON, keys in this order. */
export const termsText = (t: Terms): string => JSON.stringify({ title: t.title, stages: t.stages.map((s) => ({ title: s.title, brief: s.brief })) });
export const termsHash = (text: string): Hex => keccak256(toHex(text));

/** The milestone contract's own refusals. A few share a name with the desk's, and mean something else here. */
export const MILESTONE_WORDS: Record<string, (a: readonly unknown[]) => string> = {
  ZeroAddress: () => "An address is missing.",
  DeskRules: () => "The desk's rules do not fit a job in stages.",
  BadStages: () => `A job in stages has ${MIN_STAGES} to ${MAX_STAGES} stages, each with a price and a time.`,
  TooSmall: (a) => `The smallest stage is ${eth(a[0])} ETH, the desk's smallest job.`,
  BadTime: () => "Each stage's time is between 1 hour and 30 days.",
  NoTerms: () => "Say what each stage is.",
  WrongValue: (a) => `It takes exactly ${eth(a[0])} ETH: every stage's price together.`,
  NotCustomer: () => "Only the wallet or account that hired in stages can accept or reject a stage.",
  WrongState: (a) => `This job in stages is ${STATE_WORD[Number(a[0])] ?? "not running"}.`,
  NothingOwed: () => "Nothing is waiting to be collected.",
  PushFailed: () => "The wallet the payout was for refused it. It is still waiting in the milestone contract.",
  GasShort: () => "It was sent with too little gas. Try again.",
  OnlyDesk: () => "The milestone contract takes ETH from the desk and from nobody else.",
  ReentrancyGuardReentrantCall: () => "The milestone contract does not take a call in the middle of another one.",
};

/** What a failed call to the milestone contract was, in words. The desk's own refusals (a stage not delivered yet, the customer's day not over) are said by the desk's words. */
export function milestoneWordsOf(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (e instanceof BaseError) {
    const hit = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (hit instanceof ContractFunctionRevertedError && hit.data?.errorName && MILESTONE_WORDS[hit.data.errorName]) return MILESTONE_WORDS[hit.data.errorName]!((hit.data.args ?? []) as readonly unknown[]);
  }
  return explain(e);
}

/** The words of a job in stages, held to what the engine takes: refused here, before anything is sent. */
export function checkTerms(t: Terms): string {
  const line = (x: unknown, what: string): string => {
    const s = typeof x === "string" ? x.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
    if (s.length < 3 || s.length > TITLE_MOST || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff<>]/.test(s) || /https?:|www\.|:\/\/|\.(com|io|xyz|fun|net|org|gg|me|app)\b/i.test(s)) throw new Refusal(`${what} is one plain line of 3 to ${TITLE_MOST} characters, without links.`, "bad_title");
    return s;
  };
  if (!Array.isArray(t.stages) || t.stages.length < MIN_STAGES || t.stages.length > MAX_STAGES) throw new Refusal(`A job in stages has ${MIN_STAGES} to ${MAX_STAGES} stages.`, "bad_stages");
  const out: Terms = {
    title: line(t.title, "The job's title"),
    stages: t.stages.map((s, i) => {
      const brief = typeof s.brief === "string" ? s.brief.replace(/\r\n?/g, "\n").trim() : "";
      if (!brief || brief.length > BRIEF_MOST || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/.test(brief)) throw new Refusal(`Stage ${i + 1}'s brief is plain text of up to ${BRIEF_MOST} characters: what the agent works from.`, "bad_brief");
      return { title: line(s.title, `Stage ${i + 1}'s title`), brief };
    }),
  };
  const text = termsText(out);
  if (new TextEncoder().encode(text).length > TERMS_BYTES) throw new Refusal(`The words of all the stages together are at most ${TERMS_BYTES} bytes.`, "too_long");
  return text;
}
