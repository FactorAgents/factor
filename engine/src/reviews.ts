// Paid reviews: a review that only the wallet that paid for a job can write (docs/REVIEWS.md).
//
//   GET  /v1/reviews                      whether reviews are on, and the rules in figures
//   GET  /v1/reviews/agent/<id>           an agent's average, count, the ones not counted, and its reviews
//   GET  /v1/reviews/job/<n>              a job's review with its history and reply, and who may review it until when
//   GET  /v1/reviews/file/<n>/<version>   the file an ERC-8004 entry of the review points at, word for word
//   GET  /v1/reviews/job/<n>/erc8004      the unsigned giveFeedback call for the customer's own wallet, or why not
//   POST /v1/reviews                      { job, stars, text, at, reviewer, signature }  (EIP-712, reviewTyped)
//   POST /v1/reviews/reply                { job, text, at, by, review, signature }        (EIP-712, replyTyped)
//   POST /v1/reviews/erc8004              { job, tx }: the customer's ERC-8004 entry, read back from the chain
//
// Who reviews a job is read from the desk, never from the caller: its customer, or for a bounty's prize its poster and
// for a stage of a job in stages the plan's customer (the engine passes that in, reviewerOf). Only once the job is paid
// (settled, or settled at half), within REVIEWS_WINDOW_DAYS of it; one review per job, changed for REVIEWS_EDIT_DAYS
// after the first version and at most MOST_VERSIONS times, every version kept. The agent answers once, signed by its own
// wallet or by the wallet that runs it on Factor. A review the engine can tie to the agent's own hand is kept, marked
// self-dealing and left out of the average (selfDealing). The average is weighted by what each job paid, each weight
// capped at WEIGHT_CAP_WEI, over jobs of REVIEWS_FLOOR_ETH or more.
//
// No gas is paid by Factor and nothing is sent: a review is a signature the engine checks and keeps, and the ERC-8004
// entry is the customer's own transaction, prepared here unsigned and read back once it is mined. Reviews never change
// the Factor Score. REVIEWS=on (off unless it is said); the owner's "reviews" switch stops it at once.

import { decodeEventLog, encodeFunctionData, getAddress, hashTypedData, keccak256, parseAbi, recoverTypedDataAddress, toHex, type Abi, type Hex } from "viem";
import { erc8004ReputationAbi } from "./abi/index.js";
import { normalizeAddress } from "./chain/address.js";
import { nodeBusy, type Chain } from "./chain/chain.js";
import type { EngineDb } from "./chain/db.js";
import { DeskStore, STATE, type JobRow } from "./desk.js";
import { registryOf, type Erc8004 } from "./erc8004.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export const REVIEW_TAG1 = "factorReview";
/** The longest a review's words or a reply may be, in characters. */
export const REVIEW_MOST_CHARS = 500;
/** A review and its changes: at most this many versions. */
export const REVIEW_MOST_VERSIONS = 5;
/** Days after the review's latest version for the agent's one reply. */
export const REPLY_DAYS = 30;
/** How far a signature's time may be from the engine's clock, in seconds. */
export const SIGN_WINDOW_S = 600;
/** The most one job weighs in the average: 0.05 ETH. */
export const WEIGHT_CAP_WEI = 5n * 10n ** 16n;
/** Writes (versions and replies) from one wallet in 24 hours. */
export const PER_WALLET_DAY = 20;

export interface ReviewsConfig {
  /** REVIEWS=on: off unless it is said */
  enabled: boolean;
  /** REVIEWS_WINDOW_DAYS: days after the payment to leave the first review (30) */
  windowDays: number;
  /** REVIEWS_EDIT_DAYS: days after the first version to change it (7) */
  editDays: number;
  /** REVIEWS_FLOOR_ETH: the smallest job that counts toward the average (0.001 ETH, the desk's smallest job) */
  floorWei: bigint;
  /** the site, for the address of an ERC-8004 entry's file */
  site: string;
}

export function readReviews(env: Env, problems: string[] = []): ReviewsConfig {
  const raw = (env.REVIEWS ?? "").trim().toLowerCase();
  if (raw && raw !== "on" && raw !== "off") problems.push(`REVIEWS must be on or off: it is "${env.REVIEWS}"`);
  const whole = (name: string, def: number, min: number, max: number): number => {
    const v = env[name]?.trim();
    if (!v) return def;
    if (/^\d{1,4}$/.test(v) && Number(v) >= min && Number(v) <= max) return Number(v);
    problems.push(`${name} must be a whole number from ${min} to ${max}: it is "${v}"`);
    return def;
  };
  let floorWei = 10n ** 15n;
  const f = env.REVIEWS_FLOOR_ETH?.trim();
  if (f) {
    if (/^\d{1,3}(\.\d{1,6})?$/.test(f) && Number(f) >= 0.001 && Number(f) <= 100) floorWei = BigInt(Math.round(Number(f) * 1e6)) * 10n ** 12n;
    else problems.push(`REVIEWS_FLOOR_ETH must be a number of ETH from 0.001 to 100: it is "${f}"`);
  }
  return {
    enabled: raw === "on", windowDays: whole("REVIEWS_WINDOW_DAYS", 30, 1, 365), editDays: whole("REVIEWS_EDIT_DAYS", 7, 0, 90), floorWei,
    site: (env.FACTOR_SITE_URL?.trim() || "https://factoragents.fun").replace(/\/+$/, ""),
  };
}

// ---------- the words ----------

/**
 * A review's or a reply's words in their plain form, or null when there are more than `most` characters of them. The
 * same on the site (web/src/lib/reviews.ts) and in the kit (packages/kit/src/reviews.ts): what is signed must already be
 * in this form, so what is kept is what the person saw and signed. Composed Unicode; control characters but the line
 * break, zero-width and direction-changing characters and pictographs taken out; spaces and tabs one space; at most two
 * line breaks in a row; trimmed.
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

// ---------- what is signed ----------

export const REVIEW_TYPES = {
  Review: [{ name: "job", type: "uint256" }, { name: "agent", type: "address" }, { name: "reviewer", type: "address" }, { name: "stars", type: "uint8" }, { name: "text", type: "string" }, { name: "at", type: "uint64" }],
  Reply: [{ name: "job", type: "uint256" }, { name: "agent", type: "address" }, { name: "by", type: "address" }, { name: "review", type: "bytes32" }, { name: "text", type: "string" }, { name: "at", type: "uint64" }],
} as const;

export const reviewDomain = (chainId: number, desk: string) => ({ name: "Factor Reviews", version: "1", chainId, verifyingContract: getAddress(desk) as Hex });

/** A review as EIP-712 typed data: the same on the site and in the kit. */
export function reviewTyped(o: { chainId: number; desk: string; job: number; agent: string; reviewer: string; stars: number; text: string; at: number }) {
  return { domain: reviewDomain(o.chainId, o.desk), types: { Review: REVIEW_TYPES.Review }, primaryType: "Review" as const, message: { job: BigInt(o.job), agent: getAddress(o.agent) as Hex, reviewer: getAddress(o.reviewer) as Hex, stars: o.stars, text: o.text, at: BigInt(o.at) } };
}

/** An agent's reply as EIP-712 typed data; `review` is the digest of the version it answers. */
export function replyTyped(o: { chainId: number; desk: string; job: number; agent: string; by: string; review: Hex; text: string; at: number }) {
  return { domain: reviewDomain(o.chainId, o.desk), types: { Reply: REVIEW_TYPES.Reply }, primaryType: "Reply" as const, message: { job: BigInt(o.job), agent: getAddress(o.agent) as Hex, by: getAddress(o.by) as Hex, review: o.review, text: o.text, at: BigInt(o.at) } };
}

/** Typed data as a wallet takes it over JSON (eth_signTypedData_v4): numbers as strings, the domain's type named. */
export function typedJson(t: ReturnType<typeof reviewTyped> | ReturnType<typeof replyTyped>): Record<string, unknown> {
  return {
    domain: t.domain,
    types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...t.types },
    primaryType: t.primaryType,
    message: Object.fromEntries(Object.entries(t.message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
  };
}

const ERC1271 = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);

/**
 * Whether `address` signed the typed data: a wallet by recovering its address, an account by asking the account itself
 * (ERC-1271) whether one of its keys signed the same digest. A node that does not answer is not a no: it throws.
 */
export async function signedTyped(chain: Chain, address: string, typed: Parameters<typeof hashTypedData>[0], signature: unknown): Promise<boolean> {
  if (typeof signature !== "string" || !/^0x([0-9a-fA-F]{2}){65,2048}$/.test(signature)) return false;
  if (signature.length === 132) {
    try {
      const who = await recoverTypedDataAddress({ ...(typed as Parameters<typeof recoverTypedDataAddress>[0]), signature: signature as Hex });
      if (who.toLowerCase() === address) return true;
    } catch {
      // not a wallet's signature: perhaps an account's
    }
  }
  try {
    if ((await chain.code(address)) === "0x") return false;
    const answer = await chain.read<string>({ to: address, abi: ERC1271 as Abi, functionName: "isValidSignature", args: [hashTypedData(typed), signature] });
    return String(answer).toLowerCase() === "0x1626ba7e";
  } catch (e) {
    if (nodeBusy(e)) throw e;
    return false;
  }
}

// ---------- the books ----------

const SCHEMA = `
-- Paid reviews (./reviews.ts): one row per job, its latest version. Never taken back by a reindex.
CREATE TABLE IF NOT EXISTS reviews (
  job_id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  kind TEXT NOT NULL,                -- how the job came: job | bounty | milestone | subjob | firm | monthly
  price TEXT NOT NULL,               -- wei: what the job was locked for
  outcome TEXT NOT NULL,             -- settled | half
  closed_at INTEGER NOT NULL,        -- chain seconds: when it was paid
  stars INTEGER NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,               -- seconds: when the latest version was signed
  first_at INTEGER NOT NULL,         -- seconds: when the first was
  version INTEGER NOT NULL,
  self TEXT,                         -- why it is self-dealing, or NULL
  hidden INTEGER NOT NULL DEFAULT 0, -- its words hidden by the owner; its stars still count
  reply_hidden INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL        -- ms
);
CREATE INDEX IF NOT EXISTS reviews_agent ON reviews (agent, at);
CREATE INDEX IF NOT EXISTS reviews_reviewer ON reviews (reviewer);
-- Every version as it was signed, and the file an ERC-8004 entry of it points at, once one was prepared.
CREATE TABLE IF NOT EXISTS review_versions (
  job_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  stars INTEGER NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  digest TEXT NOT NULL,
  signature TEXT NOT NULL UNIQUE,
  file TEXT,
  file_hash TEXT,
  created_at INTEGER NOT NULL,       -- ms
  PRIMARY KEY (job_id, version)
);
CREATE INDEX IF NOT EXISTS review_versions_by ON review_versions (reviewer, created_at);
-- The agent's one reply to a review.
CREATE TABLE IF NOT EXISTS review_replies (
  job_id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  by TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  version INTEGER NOT NULL,          -- the version it answers
  digest TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at INTEGER NOT NULL        -- ms
);
CREATE INDEX IF NOT EXISTS review_replies_by ON review_replies (by, created_at);
-- A review the customer also wrote to ERC-8004 from their own wallet, as read back from the chain.
CREATE TABLE IF NOT EXISTS review_erc8004 (
  job_id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  client TEXT NOT NULL,
  tx TEXT NOT NULL,
  idx INTEGER,
  block INTEGER NOT NULL,
  at INTEGER NOT NULL                -- ms
);
`;

interface ReviewRow { job_id: number; agent: string; reviewer: string; kind: string; price: string; outcome: "settled" | "half"; closed_at: number; stars: number; text: string; at: number; first_at: number; version: number; self: string | null; hidden: number; reply_hidden: number; updated_at: number }
interface VersionRow { job_id: number; version: number; reviewer: string; stars: number; text: string; at: number; digest: string; signature: string; file: string | null; file_hash: string | null; created_at: number }
interface ReplyRow { job_id: number; agent: string; by: string; text: string; at: number; version: number; digest: string; signature: string; created_at: number }
interface OnChainRow { job_id: number; version: number; agent_id: string; client: string; tx: string; idx: number | null; block: number; at: number }

// ---------- what the site and apps read ----------

/** An agent's reviews in two figures, and how many were left out. Only while reviews are on and it has any. */
export interface ReviewSummary { average: number | null; count: number; notCounted: number }

export interface ReviewJson {
  job: number;
  jobId: string;
  agent: string;
  reviewer: string;
  stars: number;
  /** null while the owner has hidden the words */
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
  /** null when it counts; otherwise why it is left out of the average */
  notCounted: "self-dealing" | "under the floor" | null;
  /** why it is self-dealing, as Factor saw it */
  self: string | null;
  /** the earlier versions, newest first */
  history: { version: number; stars: number; text: string | null; at: string }[];
  reply: { by: string; text: string | null; hidden: boolean; at: string; version: number; toEarlier: boolean } | null;
  /** the customer also wrote it to ERC-8004 from their own wallet: which version, the entry and its transaction */
  erc8004: { agentId: string; version: number; latest: boolean; index: number | null; tx: string } | null;
  /** what was signed, for anyone to check: the digest (hashTypedData) and the signature of the latest version */
  digest: string;
  signature: string;
}

/** Who may review a job, until when, and whether it is open now. */
export interface ReviewStanding {
  reviewer: string | null;
  kind: string | null;
  /** a first review, or a change, can be signed now */
  open: boolean;
  why: string | null;
  /** the last moment to leave the first review */
  until: string | null;
  /** the last moment to change it, once there is one */
  editUntil: string | null;
  versionsLeft: number;
  /** the agent's one reply, while it can still be given */
  replyUntil: string | null;
  /** the wallets that may sign the agent's reply */
  repliers: string[];
}

export interface ReviewsDeps {
  db: EngineDb;
  chain: Chain;
  chainId: number;
  desk: string;
  now: () => number;
  /** the chain's time, seconds */
  nowS: () => number;
  /** who reviews a job and how it came, or why nobody does */
  reviewerOf: (job: JobRow) => { reviewer: string; kind: string } | { none: string };
  /** why a reviewer is the agent's own hand, as far as Factor can see it, or null */
  selfDealing: (agent: string, reviewer: string) => Promise<string | null>;
  /** who signs for an agent besides itself: its maker, or Factor's admin wallet for Factor's own */
  setters: (agent: string) => string[];
  erc8004: () => Erc8004 | null;
  log: (line: string) => void;
}

export type ReviewAnswer = { status: number; body: Record<string, unknown> };
const no = (status: number, error: string): ReviewAnswer => ({ status, body: { error } });
const iso = (s: number): string => new Date(s * 1000).toISOString();
const pad = (n: number): string => String(n).padStart(4, "0");
const ethNum = (wei: string): number => Number(BigInt(wei) / 10n ** 12n) / 1e6;
const short = (a: string): string => `${a.slice(0, 6)}...${a.slice(-4)}`;
const DAY = 86_400;
const intOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : null);

/** The weighted average of reviews that count, to one decimal, or null when none does. */
export function averageOf(rows: { stars: number; price: string; counted: boolean }[]): number | null {
  let sw = 0n, w = 0n;
  for (const r of rows) {
    if (!r.counted) continue;
    const p = BigInt(r.price);
    const weight = p < WEIGHT_CAP_WEI ? p : WEIGHT_CAP_WEI;
    sw += BigInt(r.stars) * weight;
    w += weight;
  }
  if (w === 0n) return null;
  return Math.round(Number((sw * 1000n) / w) / 100) / 10;
}

export class Reviews {
  constructor(readonly cfg: ReviewsConfig, private d: ReviewsDeps) {
    d.db.db.exec(SCHEMA);
  }

  on(): boolean {
    return this.cfg.enabled && !stopped(this.d.db, "reviews");
  }

  about(): Record<string, unknown> {
    return {
      enabled: this.on(), windowDays: this.cfg.windowDays, editDays: this.cfg.editDays, mostVersions: REVIEW_MOST_VERSIONS, mostChars: REVIEW_MOST_CHARS, replyDays: REPLY_DAYS,
      floorEth: ethNum(this.cfg.floorWei.toString()), weightCapEth: ethNum(WEIGHT_CAP_WEI.toString()), tag1: REVIEW_TAG1, signWindowS: SIGN_WINDOW_S,
      domain: reviewDomain(this.d.chainId, this.d.desk), types: REVIEW_TYPES,
    };
  }

  health(): Record<string, unknown> {
    const n = (sql: string) => (this.d.db.q(sql).get() as { n: number }).n;
    return { enabled: this.cfg.enabled, on: this.on(), reviews: n("SELECT COUNT(*) AS n FROM reviews"), self: n("SELECT COUNT(*) AS n FROM reviews WHERE self IS NOT NULL"), replies: n("SELECT COUNT(*) AS n FROM review_replies"), onErc8004: n("SELECT COUNT(*) AS n FROM review_erc8004") };
  }

  private row(job: number): ReviewRow | null {
    return (this.d.db.q("SELECT * FROM reviews WHERE job_id = ?").get(job) as ReviewRow | undefined) ?? null;
  }
  private versions(job: number): VersionRow[] {
    return this.d.db.q("SELECT * FROM review_versions WHERE job_id = ? ORDER BY version").all(job) as VersionRow[];
  }
  private replyOf(job: number): ReplyRow | null {
    return (this.d.db.q("SELECT * FROM review_replies WHERE job_id = ?").get(job) as ReplyRow | undefined) ?? null;
  }
  private onChain(job: number): OnChainRow | null {
    return (this.d.db.q("SELECT * FROM review_erc8004 WHERE job_id = ?").get(job) as OnChainRow | undefined) ?? null;
  }
  private writesToday(wallet: string): number {
    const since = this.d.now() - DAY * 1000;
    const a = (this.d.db.q("SELECT COUNT(*) AS n FROM review_versions WHERE reviewer = ? AND created_at >= ?").get(wallet, since) as { n: number }).n;
    const b = (this.d.db.q("SELECT COUNT(*) AS n FROM review_replies WHERE by = ? AND created_at >= ?").get(wallet, since) as { n: number }).n;
    return a + b;
  }

  private counted(r: Pick<ReviewRow, "self" | "price">): ReviewJson["notCounted"] {
    if (r.self) return "self-dealing";
    if (BigInt(r.price) < this.cfg.floorWei) return "under the floor";
    return null;
  }

  /** Who may review a job, until when, and whether a review (or a change of it) can be signed now. */
  standing(job: JobRow): ReviewStanding {
    const who = this.d.reviewerOf(job);
    const repliers = [job.agent, ...this.d.setters(job.agent)].filter((x, i, a) => a.indexOf(x) === i);
    const base: ReviewStanding = { reviewer: null, kind: null, open: false, why: null, until: null, editUntil: null, versionsLeft: 0, replyUntil: null, repliers };
    if ("none" in who) return { ...base, why: who.none };
    const out: ReviewStanding = { ...base, reviewer: who.reviewer, kind: who.kind };
    if (!this.on()) return { ...out, why: "paid reviews are switched off for now" };
    if (job.state !== STATE.settled && job.state !== STATE.half) {
      return { ...out, why: job.state === STATE.declined || job.state === STATE.refunded ? "nothing was paid for work on this job, so it has no review" : "a review is for a job that is paid: accepted, settled by itself, or settled at half" };
    }
    const now = this.d.nowS();
    const had = this.row(job.id);
    const until = job.closed_at + this.cfg.windowDays * DAY;
    if (!had) return { ...out, until: iso(until), open: now <= until, why: now <= until ? null : `the ${this.cfg.windowDays} days to review this job are over`, versionsLeft: REVIEW_MOST_VERSIONS };
    const editUntil = had.first_at + this.cfg.editDays * DAY;
    const left = REVIEW_MOST_VERSIONS - had.version;
    const replyUntil = this.replyOf(job.id) ? null : iso(had.at + REPLY_DAYS * DAY);
    const why = left <= 0 ? `a review is changed ${REVIEW_MOST_VERSIONS - 1} times at most` : now > editUntil ? `the ${this.cfg.editDays} days to change this review are over` : null;
    return { ...out, until: iso(until), editUntil: iso(editUntil), versionsLeft: Math.max(0, left), open: !why, why, replyUntil };
  }

  /** A customer's review, or a change of it, signed (POST /v1/reviews). */
  async write(b: Record<string, unknown>): Promise<ReviewAnswer> {
    if (!this.on()) return no(503, "paid reviews are switched off for now");
    const id = intOf(b.job);
    if (id === null || id < 1) return no(400, "job is a job's number");
    const job = new DeskStore(this.d.db).job(id);
    if (!job || job.dirty) return no(404, "the desk has no such job yet (a new job shows up a few seconds after it is locked)");
    const st = this.standing(job);
    if (!st.reviewer) return no(403, st.why ?? "nobody reviews this job");
    const reviewer = normalizeAddress(b.reviewer);
    if (!reviewer) return no(400, "reviewer is the address of the wallet that signs");
    if (reviewer !== st.reviewer) return no(403, `only the customer who paid for job ${pad(id)}, ${short(st.reviewer)}, can review it`);
    if (!st.open) return no(409, st.why ?? "this job cannot be reviewed now");
    const stars = intOf(b.stars);
    if (stars === null || stars < 1 || stars > 5) return no(400, "stars is a whole number from 1 to 5");
    const text = reviewText(b.text ?? "");
    if (text === null) return no(400, `the words are plain text of up to ${REVIEW_MOST_CHARS} characters`);
    if (text !== (b.text ?? "")) return no(400, "the words are not in their plain form: send them as reviewText makes them, and sign that");
    const at = intOf(b.at);
    const now = this.d.nowS();
    if (at === null || Math.abs(now - at) > SIGN_WINDOW_S) return no(400, "the signature's time is more than ten minutes from now: sign again");
    const had = this.row(id);
    if (had && at <= had.at) return no(409, "that is not newer than the review already stored: sign it again");
    if (this.writesToday(reviewer) >= PER_WALLET_DAY) return no(429, `that is ${PER_WALLET_DAY} reviews and replies from one wallet in a day: try again tomorrow`);
    const typed = reviewTyped({ chainId: this.d.chainId, desk: this.d.desk, job: id, agent: job.agent, reviewer, stars, text, at });
    if (!(await signedTyped(this.d.chain, reviewer, typed, b.signature))) return no(401, "the signature is not the reviewer's, or it was made for other words");
    const signature = String(b.signature).toLowerCase();
    if (this.d.db.q("SELECT 1 FROM review_versions WHERE signature = ?").get(signature)) return no(409, "that signature is already stored");
    const self = await this.d.selfDealing(job.agent, reviewer);
    const digest = hashTypedData(typed);
    const version = (had?.version ?? 0) + 1;
    const nowMs = this.d.now();
    this.d.db.tx(() => {
      this.d.db.q("INSERT INTO review_versions (job_id, version, reviewer, stars, text, at, digest, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, version, reviewer, stars, text, at, digest, signature, nowMs);
      this.d.db.q(`INSERT INTO reviews (job_id, agent, reviewer, kind, price, outcome, closed_at, stars, text, at, first_at, version, self, updated_at) VALUES (@job_id, @agent, @reviewer, @kind, @price, @outcome, @closed_at, @stars, @text, @at, @at, @version, @self, @now)
        ON CONFLICT(job_id) DO UPDATE SET stars = excluded.stars, text = excluded.text, at = excluded.at, version = excluded.version, self = excluded.self, updated_at = excluded.updated_at`).run({
        job_id: id, agent: job.agent, reviewer, kind: st.kind!, price: job.price, outcome: job.state === STATE.half ? "half" : "settled", closed_at: job.closed_at, stars, text, at, version, self, now: nowMs,
      });
    });
    this.d.log(`[reviews] job ${id}: ${stars} star${stars === 1 ? "" : "s"} from its customer${version > 1 ? ` (version ${version})` : ""}${self ? `, self-dealing: ${self}` : ""}`);
    return { status: 200, body: { ok: true, review: this.json(this.row(id)!) } };
  }

  /** The agent's one reply to a review, signed by its wallet or the wallet that runs it on Factor (POST /v1/reviews/reply). */
  async reply(b: Record<string, unknown>): Promise<ReviewAnswer> {
    if (!this.on()) return no(503, "paid reviews are switched off for now");
    const id = intOf(b.job);
    if (id === null || id < 1) return no(400, "job is a job's number");
    const r = this.row(id);
    if (!r) return no(404, "this job has no review to answer");
    const by = normalizeAddress(b.by);
    if (!by) return no(400, "by is the address of the wallet that signs");
    const allowed = [r.agent, ...this.d.setters(r.agent)];
    if (!allowed.includes(by)) return no(403, "only the agent's own wallet, or the wallet that runs it on Factor, can answer its reviews");
    if (this.replyOf(id)) return no(409, "the agent has answered this review already: a reply is never changed");
    const text = reviewText(b.text);
    if (!text) return no(400, `a reply is plain text of 1 to ${REVIEW_MOST_CHARS} characters`);
    if (text !== b.text) return no(400, "the words are not in their plain form: send them as reviewText makes them, and sign that");
    const digest = typeof b.review === "string" ? b.review.toLowerCase() : "";
    const v = this.versions(id).find((x) => x.digest.toLowerCase() === digest);
    if (!v) return no(409, "review is not the digest of one of this review's versions: read the review again");
    const now = this.d.nowS();
    if (now > r.at + REPLY_DAYS * DAY) return no(409, `the ${REPLY_DAYS} days to answer this review are over`);
    const at = intOf(b.at);
    if (at === null || Math.abs(now - at) > SIGN_WINDOW_S) return no(400, "the signature's time is more than ten minutes from now: sign again");
    if (this.writesToday(by) >= PER_WALLET_DAY) return no(429, `that is ${PER_WALLET_DAY} reviews and replies from one wallet in a day: try again tomorrow`);
    const typed = replyTyped({ chainId: this.d.chainId, desk: this.d.desk, job: id, agent: r.agent, by, review: v.digest as Hex, text, at });
    if (!(await signedTyped(this.d.chain, by, typed, b.signature))) return no(401, "the signature is not that wallet's, or it was made for other words");
    this.d.db.q("INSERT INTO review_replies (job_id, agent, by, text, at, version, digest, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING").run(id, r.agent, by, text, at, v.version, hashTypedData(typed), String(b.signature).toLowerCase(), this.d.now());
    this.d.log(`[reviews] job ${id}: the agent answered its review`);
    return { status: 200, body: { ok: true, review: this.json(this.row(id)!) } };
  }

  // ---------- reading ----------

  private json(r: ReviewRow): ReviewJson {
    const vs = this.versions(r.job_id);
    const latest = vs[vs.length - 1]!;
    const rep = this.replyOf(r.job_id);
    const oc = this.onChain(r.job_id);
    return {
      job: r.job_id, jobId: pad(r.job_id), agent: r.agent, reviewer: r.reviewer, stars: r.stars, text: r.hidden ? null : r.text, hidden: !!r.hidden,
      priceEth: ethNum(r.price), priceWei: r.price, outcome: r.outcome === "half" ? "settled at half" : "paid in full", kind: r.kind, paidAt: iso(r.closed_at),
      at: iso(r.at), firstAt: iso(r.first_at), version: r.version, notCounted: this.counted(r), self: r.self,
      history: vs.slice(0, -1).reverse().map((v) => ({ version: v.version, stars: v.stars, text: r.hidden ? null : v.text, at: iso(v.at) })),
      reply: rep ? { by: rep.by, text: r.reply_hidden ? null : rep.text, hidden: !!r.reply_hidden, at: iso(rep.at), version: rep.version, toEarlier: rep.version < r.version } : null,
      erc8004: oc ? { agentId: oc.agent_id, version: oc.version, latest: oc.version === r.version, index: oc.idx, tx: oc.tx } : null,
      digest: latest.digest, signature: latest.signature,
    };
  }

  /** A job's review, or null. */
  ofJob(job: number): ReviewJson | null {
    const r = this.row(job);
    return r ? this.json(r) : null;
  }

  /** Every agent's average and count, for the lists: one reading of the table. */
  summaries(): Map<string, ReviewSummary> {
    const rows = this.d.db.q("SELECT agent, stars, price, self FROM reviews").all() as { agent: string; stars: number; price: string; self: string | null }[];
    const by = new Map<string, { stars: number; price: string; counted: boolean }[]>();
    for (const r of rows) {
      const list = by.get(r.agent) ?? [];
      list.push({ stars: r.stars, price: r.price, counted: this.counted(r) === null });
      by.set(r.agent, list);
    }
    const out = new Map<string, ReviewSummary>();
    for (const [agent, list] of by) {
      const count = list.filter((x) => x.counted).length;
      out.set(agent, { average: averageOf(list), count, notCounted: list.length - count });
    }
    return out;
  }

  summary(agent: string): ReviewSummary | null {
    return this.summaries().get(agent) ?? null;
  }

  /** An agent's reviews, newest first, with its summary. */
  ofAgent(agent: string, limit = 50): { summary: ReviewSummary; items: ReviewJson[] } {
    const rows = this.d.db.q("SELECT * FROM reviews WHERE agent = ? ORDER BY at DESC, job_id DESC LIMIT ?").all(agent, Math.max(1, Math.min(limit, 200))) as ReviewRow[];
    return { summary: this.summary(agent) ?? { average: null, count: 0, notCounted: 0 }, items: rows.map((r) => this.json(r)) };
  }

  /** The newest few, for a signed answer and Copilot: stars, words, amount and date only. */
  recent(agent: string, n = 3): { job: number; stars: number; text: string | null; priceEth: number; at: string; counted: boolean }[] {
    return (this.d.db.q("SELECT * FROM reviews WHERE agent = ? ORDER BY at DESC, job_id DESC LIMIT ?").all(agent, n) as ReviewRow[]).map((r) => ({ job: r.job_id, stars: r.stars, text: r.hidden ? null : r.text, priceEth: ethNum(r.price), at: iso(r.at), counted: this.counted(r) === null }));
  }

  /** The owner hides a review's words, or its reply's: the stars still count. */
  hide(job: number, what: "review" | "review-reply", hidden: boolean): boolean {
    const col = what === "review" ? "hidden" : "reply_hidden";
    return this.d.db.q(`UPDATE reviews SET ${col} = ?, updated_at = ? WHERE job_id = ?`).run(hidden ? 1 : 0, this.d.now(), job).changes > 0;
  }

  // ---------- ERC-8004, from the customer's own wallet ----------

  /** The file an ERC-8004 entry of a version points at: the standard's fields, Factor's beside them. Compact JSON. */
  private fileOf(r: ReviewRow, v: VersionRow, agentId: string, job: JobRow): { body: string; hash: Hex } {
    const e = this.d.erc8004()!;
    const id = BigInt(agentId);
    const typed = reviewTyped({ chainId: this.d.chainId, desk: this.d.desk, job: r.job_id, agent: r.agent, reviewer: r.reviewer, stars: v.stars, text: v.text, at: v.at });
    const file = {
      agentRegistry: registryOf(this.d.chainId, e.cfg.identity),
      agentId: id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : id.toString(),
      clientAddress: `eip155:${this.d.chainId}:${getAddress(r.reviewer)}`,
      createdAt: iso(v.at),
      value: v.stars,
      valueDecimals: 0,
      tag1: REVIEW_TAG1,
      tag2: r.kind,
      ...(job.locked_tx ? { proofOfPayment: { fromAddress: getAddress(job.customer), toAddress: getAddress(this.d.desk), chainId: String(this.d.chainId), txHash: job.locked_tx } } : {}),
      factor: {
        job: r.job_id, page: `${this.cfg.site}/jobs/${pad(r.job_id)}`, agent: getAddress(r.agent), reviewer: getAddress(r.reviewer), priceWei: r.price,
        outcome: r.outcome === "half" ? "settled at half" : "paid in full", paidAt: iso(r.closed_at), stars: v.stars, of: 5, text: v.text, version: v.version, desk: getAddress(this.d.desk),
        signed: typedJson(typed), signature: v.signature, digest: v.digest,
      },
    };
    const body = JSON.stringify(file);
    return { body, hash: keccak256(toHex(body)) };
  }

  /**
   * The unsigned giveFeedback call that writes a review's latest version to the agent's ERC-8004 reputation, for the
   * customer's own wallet to send; or why it cannot be. The file is made once for the version and kept word for word.
   */
  erc8004Call(id: number): ReviewAnswer {
    if (!this.on()) return no(503, "paid reviews are switched off for now");
    const r = this.row(id);
    if (!r) return no(404, "this job has no review yet");
    const e = this.d.erc8004();
    const link = e?.store.link(r.agent);
    if (!e || !link?.agent_id || link.lost) return { status: 200, body: { ok: false, why: "this agent has no ERC-8004 identity linked on Factor, so there is no reputation to write the review to" } };
    const job = new DeskStore(this.d.db).job(id)!;
    const vs = this.versions(id);
    const v = vs[vs.length - 1]!;
    // a file made before is kept word for word, as long as it is for the same identity
    const madeFor = (body: string): string | null => { try { return String((JSON.parse(body) as { agentId: unknown }).agentId); } catch { return null; } };
    let made = v.file && v.file_hash && madeFor(v.file) === link.agent_id ? { body: v.file, hash: v.file_hash as Hex } : null;
    if (!made) {
      made = this.fileOf(r, v, link.agent_id, job);
      this.d.db.q("UPDATE review_versions SET file = ?, file_hash = ? WHERE job_id = ? AND version = ?").run(made.body, made.hash, id, v.version);
    }
    const uri = `${this.cfg.site}/api/v1/reviews/file/${id}/${v.version}`;
    const args = [BigInt(link.agent_id), BigInt(v.stars), 0, REVIEW_TAG1, r.kind, "", uri, made.hash] as const;
    const data = encodeFunctionData({ abi: erc8004ReputationAbi, functionName: "giveFeedback", args });
    const oc = this.onChain(id);
    return {
      status: 200,
      body: {
        ok: true, to: getAddress(e.cfg.reputation), data, value: "0", chainId: this.d.chainId, from: getAddress(r.reviewer), fn: "giveFeedback",
        agentId: link.agent_id, stars: v.stars, valueDecimals: 0, tag1: REVIEW_TAG1, tag2: r.kind, endpoint: "", uri, hash: made.hash, version: v.version,
        already: oc && oc.version === v.version ? { tx: oc.tx, index: oc.idx } : null,
        does: `Writes ${v.stars} star${v.stars === 1 ? "" : "s"} for job ${pad(id)} to the ERC-8004 reputation of identity #${link.agent_id}, from your own wallet. You pay its gas; Factor sends nothing.`,
      },
    };
  }

  /** The file an ERC-8004 entry points at, word for word, once one was prepared for that version. */
  file(id: number, version: number): string | null {
    const v = this.d.db.q("SELECT file FROM review_versions WHERE job_id = ? AND version = ?").get(id, version) as { file: string | null } | undefined;
    return v?.file ?? null;
  }

  /**
   * The customer's ERC-8004 entry, read back from its transaction's receipt: a NewFeedback log from the reputation
   * registry for the agent's identity, from the reviewer, with the tag factorReview and the hash of one of the review's
   * files. Nothing is taken on the caller's word.
   */
  async readBack(b: Record<string, unknown>): Promise<ReviewAnswer> {
    if (!this.on()) return no(503, "paid reviews are switched off for now");
    const id = intOf(b.job);
    if (id === null || id < 1) return no(400, "job is a job's number");
    const tx = typeof b.tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(b.tx) ? b.tx.toLowerCase() : null;
    if (!tx) return no(400, "tx is the transaction's hash");
    const r = this.row(id);
    if (!r) return no(404, "this job has no review");
    const e = this.d.erc8004();
    const link = e?.store.link(r.agent);
    if (!e || !link?.agent_id) return no(409, "this agent has no ERC-8004 identity linked on Factor");
    const receipt = await this.d.chain.receipt(tx);
    if (!receipt) return no(404, "the transaction is not mined yet: try again in a few seconds");
    if (!receipt.ok) return no(409, "the transaction reverted: nothing was written");
    const hashes = new Map(this.versions(id).filter((v) => v.file_hash).map((v) => [v.file_hash!.toLowerCase(), v.version]));
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== e.cfg.reputation) continue;
      try {
        const x = decodeEventLog({ abi: erc8004ReputationAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
        if (x.eventName !== "NewFeedback") continue;
        const a = x.args as { agentId: bigint; clientAddress: string; feedbackIndex: bigint; tag1: string; feedbackHash: Hex };
        const version = hashes.get(a.feedbackHash.toLowerCase());
        if (a.agentId.toString() !== link.agent_id || a.clientAddress.toLowerCase() !== r.reviewer || a.tag1 !== REVIEW_TAG1 || version === undefined) continue;
        this.d.db.q("INSERT INTO review_erc8004 (job_id, version, agent_id, client, tx, idx, block, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET version = excluded.version, agent_id = excluded.agent_id, client = excluded.client, tx = excluded.tx, idx = excluded.idx, block = excluded.block, at = excluded.at")
          .run(id, version, link.agent_id, r.reviewer, tx, Number(a.feedbackIndex), Number(receipt.blockNumber), this.d.now());
        this.d.log(`[reviews] job ${id}: its review is also on ERC-8004, identity #${link.agent_id}, entry ${a.feedbackIndex}: ${tx}`);
        return { status: 200, body: { ok: true, review: this.json(this.row(id)!) } };
      } catch {
        // another event
      }
    }
    return no(409, "that transaction holds no factorReview entry from the reviewer for this review");
  }
}
