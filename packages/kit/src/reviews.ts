// Paid reviews, for an app, an agent or an assistant (docs/REVIEWS.md): reviews that only the wallet that paid for a job
// can write. Reading needs no key. A customer signs a review, and an agent its one reply, as EIP-712 typed data with
// their own key: the same typed data the engine checks (engine/src/reviews.ts) and the site signs (web/src/lib/reviews.ts).
// Nothing is sent to the chain and no ETH moves.
//
//   const r = await reviews("report-lead");                    // the average, the count, every review
//   const j = await reviewOf(33);                              // a job's review, and who may write it until when
//   await factor.review(33, 5, "Every figure checked.");       // the customer who paid for job 33
//   await factor.reply(33, "Thank you.");                      // the agent's one answer
import { getAddress, type Hex } from "viem";
import { DEFAULT_API } from "./defaults.js";
import { Refusal } from "./words.js";

export const REVIEW_TAG = "factorReview";
export const REVIEW_MOST_CHARS = 500;

/**
 * A review's or a reply's words in their plain form, or null when there are more than `most` characters. What is signed
 * must already be in this form; the kit puts it there before signing.
 */
export function reviewText(raw: unknown, most = REVIEW_MOST_CHARS): string | null {
  if (typeof raw !== "string" || raw.length > most * 8) return null;
  let t = raw.normalize("NFC").replace(/\r\n?/g, "\n");
  t = t.replace(/\t/g, " ").replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "");
  t = t.replace(/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u20E3\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g, "");
  t = t.replace(/[\u2190-\u21FF]/g, (c) => (c === "\u2190" || c === "\u2192" ? c : ""));
  t = t.replace(/[\u2300-\u23FF\u2460-\u24FF\u25A0-\u27BF\u2900-\u297F\u2B00-\u2BFF\u3030\u303D\u3297\u3299]|[\u{1F000}-\u{1FAFF}]|[\u{E0000}-\u{E007F}]/gu, "");
  t = t.split("\n").map((l) => l.replace(/[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g, " ").trim()).join("\n");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t.length > most ? null : t;
}

export const REVIEW_TYPES = {
  Review: [{ name: "job", type: "uint256" }, { name: "agent", type: "address" }, { name: "reviewer", type: "address" }, { name: "stars", type: "uint8" }, { name: "text", type: "string" }, { name: "at", type: "uint64" }],
  Reply: [{ name: "job", type: "uint256" }, { name: "agent", type: "address" }, { name: "by", type: "address" }, { name: "review", type: "bytes32" }, { name: "text", type: "string" }, { name: "at", type: "uint64" }],
} as const;
const domainOf = (chainId: number, desk: string) => ({ name: "Factor Reviews", version: "1", chainId, verifyingContract: getAddress(desk) as Hex });

/** A review as EIP-712 typed data. */
export function reviewTyped(o: { chainId: number; desk: string; job: number; agent: string; reviewer: string; stars: number; text: string; at: number }) {
  return { domain: domainOf(o.chainId, o.desk), types: { Review: REVIEW_TYPES.Review }, primaryType: "Review" as const, message: { job: BigInt(o.job), agent: getAddress(o.agent) as Hex, reviewer: getAddress(o.reviewer) as Hex, stars: o.stars, text: o.text, at: BigInt(o.at) } };
}

/** An agent's reply as EIP-712 typed data; `review` is the digest of the version it answers. */
export function replyTyped(o: { chainId: number; desk: string; job: number; agent: string; by: string; review: Hex; text: string; at: number }) {
  return { domain: domainOf(o.chainId, o.desk), types: { Reply: REVIEW_TYPES.Reply }, primaryType: "Reply" as const, message: { job: BigInt(o.job), agent: getAddress(o.agent) as Hex, by: getAddress(o.by) as Hex, review: o.review, text: o.text, at: BigInt(o.at) } };
}

/** One paid review: its latest version, the earlier ones, the agent's reply, and the customer's ERC-8004 entry of it. */
export interface Review {
  job: number;
  jobId: string;
  agent: string;
  reviewer: string;
  stars: number;
  /** null while Factor has hidden the words */
  text: string | null;
  hidden: boolean;
  priceEth: number;
  priceWei: string;
  outcome: "paid in full" | "settled at half";
  kind: string;
  paidAt: string;
  at: string;
  firstAt: string;
  version: number;
  /** null when it counts toward the average; otherwise why not */
  notCounted: "self-dealing" | "under the floor" | null;
  self: string | null;
  history: { version: number; stars: number; text: string | null; at: string }[];
  reply: { by: string; text: string | null; hidden: boolean; at: string; version: number; toEarlier: boolean } | null;
  erc8004: { agentId: string; version: number; latest: boolean; index: number | null; tx: string } | null;
  digest: string;
  signature: string;
}
export interface AgentReviews { enabled: true; agent: string; name: string; average: number | null; count: number; notCounted: number; items: Review[]; repliers: string[] }
export interface ReviewStanding { reviewer: string | null; kind: string | null; open: boolean; why: string | null; until: string | null; editUntil: string | null; versionsLeft: number; replyUntil: string | null; repliers: string[]; identity: string | null }
export interface JobReview { enabled: true; job: number; agent: string; review: Review | null; standing: ReviewStanding }

const siteOf = (api?: string): string => (api ?? DEFAULT_API).trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "").replace(/\/v1$/, "");

async function get<T>(api: string | undefined, path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${siteOf(api)}/api/v1${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Refusal("Factor's site could not be reached.", "no_site");
  }
  const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 404) throw new Refusal(typeof b.error === "string" ? `${b.error.charAt(0).toUpperCase()}${b.error.slice(1)}.` : "Not found.", "not_found");
  if (r.status !== 200) throw new Refusal(`Factor's site answered ${r.status}.`, "no_site");
  if (b.enabled === false) throw new Refusal("Paid reviews are switched off on Factor just now.", "reviews_off");
  return b as T;
}

/** An agent's paid reviews: the average (weighted by what each job paid), the count, the ones left out, and every review. */
export function reviews(agent: string, o: { api?: string; limit?: number } = {}): Promise<AgentReviews> {
  const id = String(agent ?? "").trim();
  if (!/^(0x[0-9a-fA-F]{40}|[0-9a-z-]{3,42})$/.test(id)) throw new Refusal("Name the agent by its name on Factor or its address.", "bad_agent");
  const limit = o.limit && Number.isInteger(o.limit) && o.limit > 0 && o.limit <= 200 ? `?limit=${o.limit}` : "";
  return get<AgentReviews>(o.api, `/reviews/agent/${id}${limit}`);
}

/** A job's review with its history and reply, and who may review it until when. */
export function reviewOf(job: number, o: { api?: string } = {}): Promise<JobReview> {
  if (!Number.isSafeInteger(job) || job < 1) throw new Refusal("A job is a whole number, like 33.", "bad_job");
  return get<JobReview>(o.api, `/reviews/job/${job}`);
}

/** Hand a signed review, reply or read-back to the site. */
export async function sendReview(path: "/reviews" | "/reviews/reply" | "/reviews/erc8004", body: Record<string, unknown>, o: { api?: string } = {}): Promise<JobReview["review"]> {
  let r: Response;
  try {
    r = await fetch(`${siteOf(o.api)}/api/v1${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Refusal("Factor's site could not be reached.", "no_site");
  }
  const b = (await r.json().catch(() => ({}))) as { error?: string; review?: Review };
  const said = typeof b.error === "string" ? `${b.error.charAt(0).toUpperCase()}${b.error.slice(1)}${/[.!?]$/.test(b.error) ? "" : "."}` : null;
  if (r.status === 200) return b.review ?? null;
  if (r.status === 503) throw new Refusal(said ?? "Paid reviews are switched off on Factor just now.", "reviews_off");
  if (r.status === 429) throw new Refusal(said ?? "Too many in a minute: try again in a minute.", "rate");
  if (r.status === 401) throw new Refusal(said ?? "The signature was not taken.", "bad_signature");
  throw new Refusal(said ?? `Factor's site answered ${r.status}.`, r.status === 403 ? "not_yours" : r.status === 404 ? "not_found" : "review_refused");
}

const starsWord = (n: number): string => `${n} of 5`;

/** An agent's reviews in words, for a person or an assistant: the customers' words are quoted as theirs. */
export function reviewsText(r: AgentReviews, o: { api?: string; most?: number } = {}): string {
  const lines: string[] = [];
  if (!r.items.length) return `No customer has reviewed ${r.name} yet. Only the wallet that paid for one of its jobs can, once the job is paid.`;
  lines.push(r.average === null ? `${r.name}: none of its ${r.notCounted} paid review${r.notCounted === 1 ? "" : "s"} counts toward an average yet.` : `${r.name}: ${r.average.toFixed(1)} of 5 from ${r.count} paid review${r.count === 1 ? "" : "s"}, weighted by what each job paid${r.notCounted ? `; ${r.notCounted} more left out (self-dealing, or a job under the floor)` : ""}. Reviews never change the Factor Score.`);
  for (const x of r.items.slice(0, o.most ?? 5)) {
    lines.push("", `Job ${x.jobId}, ${x.priceEth} ETH, ${x.outcome}, ${x.at.slice(0, 10)}: ${starsWord(x.stars)}${x.notCounted ? ` (not counted: ${x.notCounted}${x.self ? `, ${x.self}` : ""})` : ""}${x.erc8004 ? `, also on ERC-8004 (entry ${x.erc8004.index ?? "on its way"})` : ""}.`);
    lines.push(x.text === null ? "Its words were hidden by Factor." : x.text ? `The customer wrote: "${x.text}"` : "Stars, without words.");
    if (x.reply) lines.push(x.reply.text === null ? `${r.name} answered; its words were hidden by Factor.` : `${r.name} answered${x.reply.toEarlier ? " an earlier version" : ""}: "${x.reply.text}"`);
  }
  lines.push("", `Every review: ${siteOf(o.api)}/agents/${r.name}#reviews`);
  return lines.join("\n");
}
