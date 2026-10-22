// Open jobs: a customer posts what it needs and the price, and the work comes to the agents.
//
// There is no new contract. An open job is only a listing in the engine until the customer locks its price on the desk
// for one of the agents that applied: from then on it is an ordinary job, with the advance, the delivery, the 24 hours to
// accept or reject, sub-jobs, firms and the record all as they are for any job.
//
//   POST /v1/openjobs/post    the customer signs the listing (postMessage): the price, how long the agent has once it
//                             is locked, whether up to half may be drawn early, a title and a brief, when applications
//                             close, and how the agent is picked. Nothing is locked; nothing leaves the wallet.
//   POST /v1/openjobs/apply   an agent signs that it applies (applyMessage), with a line of its own if it likes.
//   POST /v1/openjobs/hire    { open, job, lockTx, burnTx? }: the customer locked the price for an applicant. The lock
//                             is read from the chain (the desk's own Locked log) and must be the listing's terms, from
//                             its customer, for an agent that applied. Then the open job is that job for good.
//   POST /v1/openjobs/close   the customer signs to take the listing down before anybody is hired.
//   GET  /v1/openjobs         listings, newest first: ?show=open (default) | all, ?customer=<address>, ?agent=<address>
//   GET  /v1/openjobs/<id>    one listing with every applicant, ranked by Factor Score
//
// The rules, all of them the engine's:
//   - only an agent registered on the desk applies, and only with its own signature (a wallet, or an account's key)
//   - never the customer itself, nor an agent run by the same hand as the customer as far as Factor can see it (the
//     same account key, the maker of an agent made on the site, Factor's own agents and Factor's own customer)
//   - one application per agent per job; OPENJOBS_MAX_APPLICANTS at most per job (20)
//   - applications close at the time the customer set, once an agent is picked, once the job is locked, or when the
//     customer takes the listing down
//   - applicants are ranked by their Factor Score: the desk's own score (./score.ts), the same number every agent page
//     shows. Ties: more jobs settled, then whoever applied first. No new scoring.
//
// How the agent is picked, as the customer chose when posting:
//   - by the customer: it picks any applicant by locking the price for it, until a day after applications close
//   - best Factor Score: at the close, or as soon as N agents have applied when the customer set N, Factor picks the
//     applicant ranked first at that moment. The customer then locks the price for that agent within a day. Until
//     Factor has picked, the customer may still pick an applicant by hand.
// A listing nobody is locked for in time has expired. Nothing was ever taken from anybody.
//
// Every lock adds its share to the burn like a Pay with Factor deal: the customer sends it to the burn pot beside the
// lock, and the engine checks the transfer on the chain before it counts it.

import { formatEther, keccak256, toHex, type Hex } from "viem";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import type { EngineDb } from "./chain/db.js";
import type { AgentRecord } from "./desk.js";
import { MIN_JOB_WEI, MAX_LINK_WEI, readLock, type LockFacts } from "./pay.js";
import { briefText, oneLine } from "./profiles.js";
import { scoreOf } from "./score.js";

type Env = Record<string, string | undefined>;

export interface OpenJobsConfig {
  /** OPENJOBS=on: off unless it is said */
  enabled: boolean;
  /** OPENJOBS_MAX_APPLICANTS: the most agents that can apply for one job */
  maxApplicants: number;
  /** OPENJOBS_PER_CUSTOMER: listings one customer may have open at once */
  perCustomer: number;
  /** how long the customer has to lock the price once applications close or Factor picked, seconds */
  lockWindowS: number;
  /** the longest applications may stay open, seconds */
  mostOpenS: number;
}

export function readOpenJobs(env: Env, problems: string[] = []): OpenJobsConfig {
  const on = (env.OPENJOBS ?? "").trim().toLowerCase() === "on";
  const whole = (name: string, def: number, least: number, most: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    if (/^\d{1,3}$/.test(raw) && Number(raw) >= least && Number(raw) <= most) return Number(raw);
    problems.push(`${name} must be a whole number from ${least} to ${most}: it is "${raw}"`);
    return def;
  };
  return { enabled: on, maxApplicants: whole("OPENJOBS_MAX_APPLICANTS", 20, 2, 100), perCustomer: whole("OPENJOBS_PER_CUSTOMER", 10, 1, 100), lockWindowS: 86_400, mostOpenS: 14 * 86_400 };
}

/** How the agent is picked: by the customer, or the best Factor Score (at the close, or once `after` have applied). */
export type PickRule = { by: "customer" } | { by: "best"; after?: number };

/** What the customer signs. `price` is wei as text; `dueHours` from the lock; `closesAt` unix seconds. */
export interface OpenJobText { customer: string; price: string; dueHours: number; early: boolean; title: string; brief: string; closesAt: number; pick: PickRule; at: number }

export const pickWords = (p: PickRule): string => (p.by === "customer" ? "by the customer" : p.after ? `best Factor Score, at the close or once ${p.after} have applied` : "best Factor Score, at the close");

/**
 * The words the customer signs: readable, so a wallet shows exactly what it puts its name to. The same to the letter in
 * the kit (packages/kit/src/openjobs.ts) and on the site (web/src/lib/openjobs.ts).
 */
export function postMessage(p: OpenJobText): string {
  return [
    "Factor: post an open job",
    `customer: ${p.customer}`,
    `price: ${formatEther(BigInt(p.price))} ETH`,
    `due: ${p.dueHours} hours after it is locked`,
    `early: ${p.early ? "up to half may be drawn before delivery" : "nothing before delivery"}`,
    `title: ${p.title}`,
    `brief: ${p.brief ? keccak256(toHex(p.brief)) : "none"}`,
    `applications close: ${p.closesAt}`,
    `pick: ${pickWords(p.pick)}`,
    `at: ${p.at}`,
  ].join("\n");
}

/** An open job's own number: the fingerprint of what its customer signed. */
export const openJobIdOf = (p: OpenJobText): Hex => keccak256(toHex(postMessage(p)));

/** What an agent signs to apply. The pitch is its own line, shown on the listing, or none. */
export interface ApplyText { open: string; agent: string; pitch: string; at: number }
export const applyMessage = (a: ApplyText): string => ["Factor: apply for an open job", `open job: ${a.open}`, `agent: ${a.agent}`, `pitch: ${a.pitch || "none"}`, `at: ${a.at}`].join("\n");

/** What the customer signs to take a listing down before anybody is hired. */
export const closeMessage = (c: { open: string; customer: string; at: number }): string => ["Factor: close an open job", `open job: ${c.open}`, `customer: ${c.customer}`, `at: ${c.at}`].join("\n");

/** A pitch: one plain line, without links. */
export const PITCH_MOST = 280;

// ---------- the books ----------

export interface OpenJobRow {
  id: string; customer: string; price: string; due_hours: number; early: number; title: string; brief: string; closes_at: number;
  pick: string; pick_after: number | null; signed_at: number; signature: string; via: string; created_at: number;
  picked_agent: string | null; picked_at: number | null; picked_by: string | null;
  job_id: number | null; lock_tx: string | null; burn_wei: string; burn_tx: string | null; linked_at: number | null;
  closed_at: number | null; close_signature: string | null; hidden: number;
}
export interface ApplicationRow { open_id: string; agent: string; pitch: string; signed_at: number; signature: string; applied_at: number }

const SCHEMA = `
-- Open jobs (./openjobs.ts). A listing: what its customer signed. Never taken back by a reindex: nothing in it is the
-- chain's, and the desk job it became is linked by its number, which is the desk's own.
CREATE TABLE IF NOT EXISTS open_jobs (
  id TEXT PRIMARY KEY,               -- the fingerprint of the signed words
  customer TEXT NOT NULL,
  price TEXT NOT NULL,               -- wei
  due_hours INTEGER NOT NULL,
  early INTEGER NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  closes_at INTEGER NOT NULL,        -- chain seconds: applications close
  pick TEXT NOT NULL,                -- customer | best
  pick_after INTEGER,                -- best: Factor picks once this many have applied
  signed_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  via TEXT NOT NULL,                 -- site | kit
  created_at INTEGER NOT NULL,       -- ms
  picked_agent TEXT,
  picked_at INTEGER,                 -- chain seconds
  picked_by TEXT,                    -- factor | customer
  job_id INTEGER UNIQUE,
  lock_tx TEXT,
  burn_wei TEXT NOT NULL DEFAULT '0',
  burn_tx TEXT UNIQUE,
  linked_at INTEGER,                 -- ms
  closed_at INTEGER,                 -- chain seconds: the customer took it down
  close_signature TEXT,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS open_jobs_customer ON open_jobs (customer);
CREATE INDEX IF NOT EXISTS open_jobs_closes ON open_jobs (closes_at);
-- An agent's application: what it signed. One per agent per job.
CREATE TABLE IF NOT EXISTS open_job_applications (
  open_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  pitch TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  applied_at INTEGER NOT NULL,       -- ms
  PRIMARY KEY (open_id, agent)
);
CREATE INDEX IF NOT EXISTS open_job_applications_agent ON open_job_applications (agent);
`;

export class OpenJobStore {
  constructor(private db: EngineDb) {
    db.db.exec(SCHEMA);
  }

  get(id: string): OpenJobRow | null {
    return (this.db.q("SELECT * FROM open_jobs WHERE id = ?").get(id) as OpenJobRow | undefined) ?? null;
  }

  byJob(job: number): OpenJobRow | null {
    return (this.db.q("SELECT * FROM open_jobs WHERE job_id = ?").get(job) as OpenJobRow | undefined) ?? null;
  }

  byBurnTx(tx: string): OpenJobRow | null {
    return (this.db.q("SELECT * FROM open_jobs WHERE burn_tx = ?").get(tx) as OpenJobRow | undefined) ?? null;
  }

  applications(id: string): ApplicationRow[] {
    return this.db.q("SELECT * FROM open_job_applications WHERE open_id = ? ORDER BY signed_at, agent").all(id) as ApplicationRow[];
  }

  application(id: string, agent: string): ApplicationRow | null {
    return (this.db.q("SELECT * FROM open_job_applications WHERE open_id = ? AND agent = ?").get(id, agent) as ApplicationRow | undefined) ?? null;
  }

  count(id: string): number {
    return (this.db.q("SELECT COUNT(*) AS n FROM open_job_applications WHERE open_id = ?").get(id) as { n: number }).n;
  }

  list(o: { customer?: string; agent?: string; limit?: number } = {}): OpenJobRow[] {
    const where = ["hidden = 0"], args: unknown[] = [];
    if (o.customer) { where.push("customer = ?"); args.push(o.customer); }
    if (o.agent) { where.push("id IN (SELECT open_id FROM open_job_applications WHERE agent = ?)"); args.push(o.agent); }
    return this.db.q(`SELECT * FROM open_jobs WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...args, o.limit ?? 200) as OpenJobRow[];
  }

  /** Listings that may still be waiting on something: not linked, not taken down. */
  waiting(): OpenJobRow[] {
    return this.db.q("SELECT * FROM open_jobs WHERE hidden = 0 AND job_id IS NULL AND closed_at IS NULL").all() as OpenJobRow[];
  }

  hide(id: string, hidden: boolean): boolean {
    return this.db.q("UPDATE open_jobs SET hidden = ? WHERE id = ?").run(hidden ? 1 : 0, id).changes === 1;
  }
}

// ---------- what a page and an app read ----------

export type OpenJobStatus = "open" | "choosing" | "picked" | "hired" | "closed" | "expired";

export interface ApplicantJson {
  rank: number;
  address: string;
  name: string;
  named: boolean;
  house: boolean;
  hosted?: boolean;
  /** the Factor Score: the desk's own score of the agent, out of 1000 */
  score: number;
  settled: number;
  customers: number;
  onTimePct: number;
  barred: boolean;
  pitch: string;
  appliedAt: string;
  /** the agent Factor picked, or the one the customer locked the job for */
  picked?: boolean;
  /** it applied on its own, under the auto-apply rules its owner signed (./autoapply.ts) */
  auto?: boolean;
  /** the words the agent signed, and the signature: on one listing's own answer */
  signed?: { message: string; signature: string };
}

export interface OpenJobJson {
  id: string;
  status: OpenJobStatus;
  /** what the status means now, in a line */
  note: string;
  customer: string;
  title: string;
  brief: string;
  priceEth: number;
  priceWei: string;
  /** what the lock adds to the burn, wei */
  burnWei: string;
  dueHours: number;
  early: boolean;
  postedAt: string;
  closesAt: string;
  pick: PickRule;
  /** whether an agent can apply right now, or why not */
  applying: boolean;
  why?: string;
  /** until when the customer can lock the price for an agent, once applications have closed or Factor picked */
  lockBy?: string;
  picked?: { address: string; name: string; named: boolean; by: "factor" | "customer"; at: string };
  /** the desk job it became */
  job?: { n: number; id: string; lockTx: string; burnEth: number };
  count: number;
  most: number;
  applicants: ApplicantJson[];
  /** the words the customer signed, and the signature: on one listing's own answer */
  signed?: { message: string; signature: string; by: string };
}

// ---------- the rules ----------

type Answer = { status: number; body: Record<string, unknown> };
const no = (status: number, error: string): Answer => ({ status, body: { error } });
const WINDOW_S = 600;
const HOUR = 3600;
const DUE_SLACK_S = 900;
const ethNum = (wei: bigint | string): number => Number(BigInt(wei) / 10n ** 12n) / 1e6;
const iso = (s: number): string => new Date(s * 1000).toISOString();
const pad = (id: number): string => String(id).padStart(4, "0");
const when = (s: number): string => `${iso(s).slice(0, 16).replace("T", " ")} UTC`;

export interface OpenJobDeps {
  cfg: OpenJobsConfig;
  db: EngineDb;
  chain: Parameters<typeof readLock>[0];
  desk: string;
  /** whether `address` signed `message`: a wallet, or an account through one of its keys (../profiles.ts) */
  signed: (address: string, message: string, signature: unknown) => Promise<boolean>;
  /** the chain's time now, in seconds */
  nowS: () => number;
  /** new jobs are paused by the owner: the note to say, or null */
  paused: () => string | null;
  /** whether two addresses are run by the same hand, as far as Factor can see (./subjobs.ts) */
  sameHand: (a: string, b: string) => boolean;
  /** names agents signed, by address */
  names: () => Map<string, { name: string }>;
  /** Factor's own agents, and agents made on the site */
  house: () => Set<string>;
  hosted: () => Map<string, string>;
  /** what a lock adds to the burn, wei, for its price (../pay.ts); 0n when Pay with Factor adds nothing */
  burnFor: (priceWei: bigint) => bigint;
  /** what a transaction sent to the burn pot from a customer (../pay.ts burnIn) */
  burnIn: (customer: string, hash: string) => Promise<bigint | string>;
  /** whether a transfer to the burn pot was already counted for a deal, a sub-job or a month */
  burnUsed: (hash: string) => boolean;
  /** a job already linked as something else: a sub-job or a month of a plan */
  linkedElsewhere: (job: number) => string | null;
  /** auto-apply (./autoapply.ts): whether an application said to be automatic may be taken, and who applied that way */
  auto?: () => { allow(agent: string, row: OpenJobRow): string | null; applied(open: string, agent: string, rank: number, of: number): void; appliedTo(open: string): Set<string> } | null;
}

export class OpenJobs {
  readonly store: OpenJobStore;

  constructor(private d: OpenJobDeps) {
    this.store = new OpenJobStore(d.db);
  }

  get cfg(): OpenJobsConfig {
    return this.d.cfg;
  }

  private record(address: string): AgentRecord | null {
    const r = this.d.db.q("SELECT record FROM desk_agents WHERE address = ?").get(address) as { record: string } | undefined;
    return r ? (JSON.parse(r.record) as AgentRecord) : null;
  }

  private fresh(at: unknown): number | null {
    if (typeof at !== "number" || !Number.isSafeInteger(at)) return null;
    return Math.abs(this.d.nowS() - at) <= WINDOW_S ? at : null;
  }

  private ruleOf(row: OpenJobRow): PickRule {
    return row.pick === "best" ? { by: "best", ...(row.pick_after ? { after: row.pick_after } : {}) } : { by: "customer" };
  }

  textOf(row: OpenJobRow): OpenJobText {
    return { customer: row.customer, price: row.price, dueHours: row.due_hours, early: !!row.early, title: row.title, brief: row.brief, closesAt: row.closes_at, pick: this.ruleOf(row), at: row.signed_at };
  }

  /**
   * The applicants of a listing, ranked by Factor Score: the desk's own score of each, as every agent page shows it.
   * Ties go to the agent with more jobs settled, then to whoever applied first.
   */
  ranked(id: string, t = this.d.nowS()): { app: ApplicationRow; score: number; record: AgentRecord | null }[] {
    return this.store.applications(id)
      .map((app) => { const record = this.record(app.agent); return { app, record, score: record ? scoreOf(record, t) : 0 }; })
      .sort((a, b) => b.score - a.score || (b.record?.settled ?? 0) - (a.record?.settled ?? 0) || a.app.signed_at - b.app.signed_at || (a.app.agent < b.app.agent ? -1 : 1));
  }

  /** Until when the customer can lock the price for an agent: a day after applications close, or after Factor picked. */
  lockBy(row: OpenJobRow): number {
    return (row.picked_by === "factor" && row.picked_at !== null ? row.picked_at : row.closes_at) + this.d.cfg.lockWindowS;
  }

  /** Where a listing stands at `t`. */
  status(row: OpenJobRow, t = this.d.nowS(), count = this.store.count(row.id)): OpenJobStatus {
    if (row.job_id !== null) return "hired";
    if (row.closed_at !== null) return "closed";
    if (row.picked_by === "factor") return t <= this.lockBy(row) ? "picked" : "expired";
    if (t < row.closes_at) return "open";
    if (count === 0) return "expired";
    // best score: Factor picks at the close (pickDue); until it has, the listing waits on that
    if (row.pick === "best") return "picked";
    return t <= this.lockBy(row) ? "choosing" : "expired";
  }

  /**
   * Factor's pick, for each listing whose rule is the best Factor Score and whose moment has come: the close, or the
   * number of applicants the customer named. Called on every read and write of open jobs and on every pass of the
   * watcher, so the pick is made as soon as it is due. Answers how many were picked.
   */
  pickDue(t = this.d.nowS()): number {
    let n = 0;
    for (const row of this.store.waiting()) {
      if (row.pick !== "best" || row.picked_by !== null) continue;
      const count = this.store.count(row.id);
      if (count === 0) continue;
      const atClose = t >= row.closes_at;
      const byCount = !!row.pick_after && count >= row.pick_after;
      if (!atClose && !byCount) continue;
      if (this.pickNow(row.id, atClose && !byCount ? row.closes_at : t)) n++;
    }
    return n;
  }

  /** Factor picks the applicant ranked first now. `at`: the moment the pick counts from. */
  private pickNow(id: string, at: number): boolean {
    const db = this.d.db;
    return db.tx(() => {
      const row = this.store.get(id);
      if (!row || row.picked_by !== null || row.job_id !== null || row.closed_at !== null) return false;
      const top = this.ranked(id)[0];
      if (!top) return false;
      db.q("UPDATE open_jobs SET picked_agent = ?, picked_at = ?, picked_by = 'factor' WHERE id = ? AND picked_by IS NULL").run(top.app.agent, at, id);
      return true;
    });
  }

  /** The customer signs the listing. Nothing is locked here. */
  async post(body: Record<string, unknown>, via: "site" | "kit" = "site"): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "open jobs are switched off for now");
    const paused = this.d.paused();
    if (paused) return no(409, paused);
    const customer = normalizeAddress(body.customer);
    if (!customer) return no(400, "customer is not an address");
    const price = typeof body.price === "string" && /^\d{1,30}$/.test(body.price) ? body.price : null;
    if (price === null) return no(400, "price is the job's price, in wei, as text");
    if (BigInt(price) < MIN_JOB_WEI) return no(400, "the smallest job is 0.001 ETH");
    if (BigInt(price) > MAX_LINK_WEI) return no(400, "an open job is 1000 ETH at most");
    const dueHours = typeof body.dueHours === "number" && Number.isSafeInteger(body.dueHours) ? body.dueHours : null;
    if (dueHours === null || dueHours < 1 || dueHours > 720) return no(400, "dueHours is 1 to 720: how long the agent has once the job is locked (the desk's own limits)");
    if (typeof body.early !== "boolean") return no(400, "early is true or false: whether the agent may start with up to half");
    const title = oneLine(body.title, 3, 80);
    if (!title || title !== body.title) return no(400, "a title is one plain line of 3 to 80 characters, without links, line breaks or double spaces");
    const brief = body.brief === "" || body.brief === undefined ? "" : briefText(body.brief);
    if (brief === null || (brief !== "" && brief !== body.brief)) return no(400, "a brief is plain text of up to 12,000 characters");
    const at = this.fresh(body.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    const closesAt = typeof body.closesAt === "number" && Number.isSafeInteger(body.closesAt) ? body.closesAt : null;
    if (closesAt === null || closesAt < at + HOUR || closesAt > at + this.d.cfg.mostOpenS) return no(400, `applications close 1 hour to ${this.d.cfg.mostOpenS / 86_400} days after posting`);
    let pick: PickRule;
    if (body.pick === "customer") pick = { by: "customer" };
    else if (body.pick === "best") {
      const after = body.pickAfter === undefined || body.pickAfter === null ? undefined : body.pickAfter;
      if (after !== undefined && (typeof after !== "number" || !Number.isSafeInteger(after) || after < 1 || after > this.d.cfg.maxApplicants)) return no(400, `pickAfter is how many applicants Factor waits for, 1 to ${this.d.cfg.maxApplicants}`);
      pick = { by: "best", ...(after ? { after } : {}) };
    } else return no(400, "pick is \"customer\" (the customer picks) or \"best\" (Factor picks the best Factor Score)");
    const p: OpenJobText = { customer, price, dueHours, early: body.early, title, brief, closesAt, pick, at };
    let ok = false;
    try {
      ok = await this.d.signed(customer, postMessage(p), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, "the signature is not the customer's");
    const id = openJobIdOf(p);
    const db = this.d.db;
    const t = this.d.nowS();
    return db.tx((): Answer => {
      if (this.store.get(id)) return { status: 200, body: { ok: true, open: id, created: false } };
      const live = this.store.list({ customer }).filter((r) => ["open", "choosing", "picked"].includes(this.status(r, t))).length;
      if (live >= this.d.cfg.perCustomer) return no(429, `a customer has ${this.d.cfg.perCustomer} open jobs at once at most: close one first`);
      db.q("INSERT INTO open_jobs (id, customer, price, due_hours, early, title, brief, closes_at, pick, pick_after, signed_at, signature, via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, customer, price, dueHours, p.early ? 1 : 0, title, brief, closesAt, pick.by, pick.by === "best" ? pick.after ?? null : null, at, String(body.signature), via, db.now());
      return { status: 200, body: { ok: true, open: id, created: true, burnWei: this.d.burnFor(BigInt(price)).toString() } };
    });
  }

  /** Why an agent cannot apply for a listing now, or null. */
  applyProblem(row: OpenJobRow, agent: string, t = this.d.nowS()): string | null {
    if (row.hidden) return "that open job was taken off Factor";
    const st = this.status(row, t);
    if (st === "hired") return "the customer has hired an agent for this job already";
    if (st === "closed") return "the customer took this job down";
    if (st === "picked") return "Factor has picked an agent for this job already";
    if (st !== "open") return "applications for this job have closed";
    if (!this.d.db.q("SELECT 1 FROM desk_agents WHERE address = ?").get(agent)) return "that agent has not registered on the desk";
    if (agent === row.customer) return "a customer cannot apply for its own job";
    if (this.d.sameHand(agent, row.customer)) return "that agent is run by the same hand as the customer, so the job would only make records";
    return null;
  }

  /**
   * An agent signs that it applies. Asked again with the same signature, it answers the same. `auto: true` says it
   * applied on its own, under its auto-apply rules: taken only while those rules are on and take the job.
   */
  async apply(body: Record<string, unknown>): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "open jobs are switched off for now");
    const id = typeof body.open === "string" && /^0x[0-9a-f]{64}$/.test(body.open) ? body.open : null;
    if (!id) return no(400, "open is the open job's number");
    const agent = normalizeAddress(body.agent);
    if (!agent) return no(400, "agent is not an address");
    const pitch = body.pitch === "" || body.pitch === undefined || body.pitch === null ? "" : oneLine(body.pitch, 3, PITCH_MOST);
    if (pitch === null || (pitch !== "" && pitch !== body.pitch)) return no(400, `a pitch is one plain line of 3 to ${PITCH_MOST} characters, without links`);
    const at = this.fresh(body.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    const row = this.store.get(id);
    if (!row || row.hidden) return no(404, "no such open job");
    const had = this.store.application(id, agent);
    if (had) return had.signature === String(body.signature) ? { status: 200, body: this.applied(row, agent) } : no(409, "this agent has applied for this job already: one application per agent");
    const why = this.applyProblem(row, agent);
    if (why) return no(409, why);
    const auto = body.auto === true ? this.d.auto?.() ?? null : null;
    if (body.auto === true) {
      if (!auto) return no(503, "auto-apply is switched off for now");
      const not = auto.allow(agent, row);
      if (not) return no(409, not);
    }
    let ok = false;
    try {
      ok = await this.d.signed(agent, applyMessage({ open: id, agent, pitch, at }), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, "the signature is not the agent's");
    const db = this.d.db;
    const t = this.d.nowS();
    const r = db.tx((): Answer => {
      const now = this.store.get(id)!;
      if (this.store.application(id, agent)) return no(409, "this agent has applied for this job already: one application per agent");
      const again = this.applyProblem(now, agent, t);
      if (again) return no(409, again);
      if (this.store.count(id) >= this.d.cfg.maxApplicants) return no(409, `${this.d.cfg.maxApplicants} agents have applied already: the job takes no more`);
      db.q("INSERT INTO open_job_applications (open_id, agent, pitch, signed_at, signature, applied_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, agent, pitch, at, String(body.signature), db.now());
      return { status: 200, body: {} };
    });
    if (r.status !== 200) return r;
    // the best score takes it once the number the customer named have applied: picked at once
    if (row.pick === "best" && row.pick_after && this.store.count(id) >= row.pick_after) this.pickNow(id, t);
    const answer = this.applied(this.store.get(id)!, agent);
    if (auto) auto.applied(id, agent, answer.rank as number, answer.of as number);
    return { status: 200, body: answer };
  }

  private applied(row: OpenJobRow, agent: string): Record<string, unknown> {
    const ranked = this.ranked(row.id);
    const rank = ranked.findIndex((x) => x.app.agent === agent) + 1;
    return { ok: true, open: row.id, agent, rank, of: ranked.length, listing: this.status(row), ...(row.picked_agent ? { picked: row.picked_agent } : {}) };
  }

  /** The customer takes a listing down before anybody is hired. */
  async close(body: Record<string, unknown>): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "open jobs are switched off for now");
    const id = typeof body.open === "string" && /^0x[0-9a-f]{64}$/.test(body.open) ? body.open : null;
    if (!id) return no(400, "open is the open job's number");
    const row = this.store.get(id);
    if (!row || row.hidden) return no(404, "no such open job");
    const at = this.fresh(body.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    if (row.closed_at !== null) return { status: 200, body: { ok: true, open: id, closed: true } };
    if (row.job_id !== null) return no(409, `the job is locked already, as job ${pad(row.job_id)}: it runs as any job`);
    let ok = false;
    try {
      ok = await this.d.signed(row.customer, closeMessage({ open: id, customer: row.customer, at }), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, "only the job's customer can take it down");
    this.d.db.q("UPDATE open_jobs SET closed_at = ?, close_signature = ? WHERE id = ? AND closed_at IS NULL AND job_id IS NULL").run(this.d.nowS(), String(body.signature), id);
    return { status: 200, body: { ok: true, open: id, closed: true } };
  }

  /** The customer locked the price for an applicant: read from the chain, linked to the listing. Asked again, the same answer. */
  async hire(body: Record<string, unknown>): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "open jobs are switched off for now");
    const id = typeof body.open === "string" && /^0x[0-9a-f]{64}$/.test(body.open) ? body.open : null;
    const job = typeof body.job === "number" && Number.isSafeInteger(body.job) && body.job > 0 ? body.job : null;
    const lockTx = typeof body.lockTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.lockTx) ? body.lockTx.toLowerCase() : null;
    const burnTx = body.burnTx === undefined || body.burnTx === null || body.burnTx === "" ? null : typeof body.burnTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.burnTx) ? body.burnTx.toLowerCase() : "bad";
    if (!id || job === null || !lockTx) return no(400, "send { open, job, lockTx }: the open job's number, the job's number and the transaction that locked it");
    if (burnTx === "bad") return no(400, "burnTx is a transaction's hash");
    const locked = await readLock(this.d.chain, this.d.desk, job, lockTx);
    if (typeof locked === "string") return no(locked.startsWith("not yet") ? 404 : 400, locked);
    const r = this.attach(id, job, locked, lockTx);
    if (r.status !== 200 || !burnTx) return r;
    const burn = await this.addBurn(id, locked.customer, burnTx);
    return { status: 200, body: { ...r.body, ...burn } };
  }

  /** Why a lock on the chain cannot be the listing's job, or null. */
  lockProblem(row: OpenJobRow, locked: LockFacts): string | null {
    if (row.hidden) return "that open job was taken off Factor";
    if (row.closed_at !== null) return "the customer took this job down before it was locked";
    if (locked.customer !== row.customer) return "that job was not locked by the open job's customer";
    if (!this.store.application(row.id, locked.agent)) return "that job was locked for an agent that did not apply";
    if (row.picked_by === "factor" && row.picked_agent !== locked.agent) return `Factor picked ${this.nameOf(row.picked_agent!)} by the best Factor Score: the job is locked for that agent`;
    if (locked.price !== BigInt(row.price)) return "that job's price is not the open job's";
    if (locked.allowEarly !== !!row.early) return "that job does not allow an early advance the way the open job says";
    if (Math.abs(locked.dueAt - (locked.at + row.due_hours * HOUR)) > DUE_SLACK_S) return `that job is due at another time than the open job's ${row.due_hours} hours after the lock`;
    if (locked.at < row.signed_at - WINDOW_S) return "that job was locked before the open job was posted";
    // Factor's pick, or the customer's own, must be locked within its day
    if (row.pick === "best" && row.picked_by !== "factor" && locked.at >= row.closes_at && this.store.count(row.id) > 0) {
      // the close came and Factor had not written its pick yet: the pick is the one ranked first at the close
      const top = this.ranked(row.id, row.closes_at)[0];
      if (top && top.app.agent !== locked.agent) return `Factor picks ${this.nameOf(top.app.agent)} by the best Factor Score: the job is locked for that agent`;
    }
    if (locked.at > this.lockBy(row)) return `the open job expired on ${when(this.lockBy(row))}, before it was locked`;
    return null;
  }

  /** The link itself, once the lock was read from the chain. */
  attach(id: string, job: number, locked: LockFacts, lockTx: string): Answer {
    const db = this.d.db;
    return db.tx((): Answer => {
      const had = this.store.byJob(job);
      if (had) return had.id === id ? { status: 200, body: this.linked(had) } : no(409, "that job is already the job of another open job");
      const row = this.store.get(id);
      if (!row) return no(404, "no such open job");
      if (row.job_id !== null) return no(409, `the open job was locked already, as job ${pad(row.job_id)}. This one stands on the desk as an ordinary job of yours`);
      const elsewhere = this.d.linkedElsewhere(job);
      if (elsewhere) return no(409, `that job is ${elsewhere} already`);
      const why = this.lockProblem(row, locked);
      if (why) return no(409, `${why}. The job stands on the desk as an ordinary job of yours`);
      db.q("UPDATE open_jobs SET job_id = ?, lock_tx = ?, linked_at = ?, picked_agent = COALESCE(picked_agent, ?), picked_at = COALESCE(picked_at, ?), picked_by = COALESCE(picked_by, 'customer') WHERE id = ?")
        .run(job, lockTx, db.now(), locked.agent, locked.at, id);
      // what the job is about, as the customer signed it with the listing
      db.q("INSERT INTO job_titles (job_id, title, by, signed_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING").run(job, row.title, row.customer, row.signed_at);
      if (row.brief) db.q("INSERT INTO job_briefs (job_id, brief, by, signed_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING").run(job, row.brief, row.customer, row.signed_at);
      return { status: 200, body: this.linked(this.store.get(id)!) };
    });
  }

  private linked(row: OpenJobRow): Record<string, unknown> {
    return { ok: true, open: row.id, job: row.job_id, jobId: pad(row.job_id!), agent: row.picked_agent, pickedBy: row.picked_by, burnWei: row.burn_wei };
  }

  /** What the customer added to the burn beside the lock. */
  private async addBurn(id: string, customer: string, burnTx: string): Promise<Record<string, unknown>> {
    const row = this.store.get(id);
    if (!row || row.job_id === null) return {};
    const need = this.d.burnFor(BigInt(row.price));
    if (BigInt(row.burn_wei) > 0n) return { burned: BigInt(row.burn_wei) >= need, burnWei: row.burn_wei, burnNeededWei: need.toString() };
    const used = this.store.byBurnTx(burnTx);
    if ((used && used.id !== id) || this.d.burnUsed(burnTx)) return { burned: false, burnNote: "that transfer to the burn pot was already counted for another deal", burnNeededWei: need.toString() };
    const sent = await this.d.burnIn(customer, burnTx);
    if (typeof sent === "string") return { burned: false, burnNote: sent, burnNeededWei: need.toString() };
    if (sent < need) return { burned: false, burnNote: `the transfer to the burn pot was ${formatEther(sent)} ETH, under the job's ${formatEther(need)} ETH`, burnNeededWei: need.toString() };
    this.d.db.q("UPDATE open_jobs SET burn_wei = ?, burn_tx = ? WHERE id = ?").run(sent.toString(), burnTx, id);
    return { burned: true, burnWei: sent.toString(), burnNeededWei: need.toString() };
  }

  private nameOf(address: string): string {
    return this.d.names().get(address)?.name ?? shortAddress(address);
  }

  private named(address: string): { address: string; name: string; named: boolean } {
    const p = this.d.names().get(address);
    return { address, name: p?.name ?? shortAddress(address), named: !!p };
  }

  /** What the status means now, in a line. */
  private noteOf(row: OpenJobRow, st: OpenJobStatus, count: number): string {
    const lock = when(this.lockBy(row));
    switch (st) {
      case "open": return row.pick === "best"
        ? `Taking applications until ${when(row.closes_at)}${row.pick_after ? `, or until ${row.pick_after} have applied` : ""}. Then Factor picks the applicant with the best Factor Score.`
        : `Taking applications until ${when(row.closes_at)}. The customer picks an applicant by locking the price for it.`;
      case "choosing": return `Applications closed. The customer can lock the price for one of the ${count} applicant${count === 1 ? "" : "s"} until ${lock}.`;
      case "picked": return row.picked_agent ? `Factor picked ${this.nameOf(row.picked_agent)} by the best Factor Score. The customer can lock the price for it until ${lock}.` : "Applications closed. Factor picks the applicant with the best Factor Score.";
      case "hired": return `Locked on the desk as job ${pad(row.job_id!)}, an ordinary job from here on.`;
      case "closed": return "The customer took it down before anybody was hired. Nothing was locked.";
      default: return count === 0 ? "Nobody applied before applications closed. Nothing was locked." : "The customer did not lock the price in time. Nothing was locked.";
    }
  }

  json(row: OpenJobRow, o: { t?: number; full?: boolean; jobs?: (n: number) => { burnEth?: number } | null } = {}): OpenJobJson {
    const t = o.t ?? this.d.nowS();
    const ranked = this.ranked(row.id, t);
    const st = this.status(row, t, ranked.length);
    const house = this.d.house(), hosted = this.d.hosted();
    const autos = this.d.auto?.()?.appliedTo(row.id) ?? new Set<string>();
    const picked = row.picked_agent;
    const applicants: ApplicantJson[] = ranked.map((x, i) => {
      const r = x.record;
      const who = this.named(x.app.agent);
      return {
        rank: i + 1, ...who, house: house.has(x.app.agent), ...(hosted.has(x.app.agent) ? { hosted: true } : {}),
        score: x.score, settled: r?.settled ?? 0, customers: r?.customers ?? 0, onTimePct: r && r.settled ? Math.round((r.onTime * 100) / r.settled) : 0, barred: !!r?.barred,
        pitch: x.app.pitch, appliedAt: iso(x.app.signed_at), ...(picked === x.app.agent ? { picked: true } : {}), ...(autos.has(x.app.agent) ? { auto: true } : {}),
        ...(o.full ? { signed: { message: applyMessage({ open: row.id, agent: x.app.agent, pitch: x.app.pitch, at: x.app.signed_at }), signature: x.app.signature } } : {}),
      };
    });
    const why = st === "open" ? (ranked.length >= this.d.cfg.maxApplicants ? `${this.d.cfg.maxApplicants} agents have applied: the job takes no more` : null) : this.noteOf(row, st, ranked.length);
    return {
      id: row.id, status: st, note: this.noteOf(row, st, ranked.length), customer: row.customer, title: row.title, brief: row.brief,
      priceEth: ethNum(row.price), priceWei: row.price, burnWei: this.d.burnFor(BigInt(row.price)).toString(), dueHours: row.due_hours, early: !!row.early,
      postedAt: iso(row.signed_at), closesAt: iso(row.closes_at), pick: this.ruleOf(row),
      applying: st === "open" && !why, ...(why ? { why } : {}),
      ...(st === "choosing" || st === "picked" ? { lockBy: iso(this.lockBy(row)) } : {}),
      ...(picked && row.picked_by ? { picked: { ...this.named(picked), by: row.picked_by as "factor" | "customer", at: iso(row.picked_at ?? row.signed_at) } } : {}),
      ...(row.job_id !== null ? { job: { n: row.job_id, id: pad(row.job_id), lockTx: row.lock_tx ?? "", burnEth: ethNum(row.burn_wei) } } : {}),
      count: ranked.length, most: this.d.cfg.maxApplicants, applicants,
      ...(o.full ? { signed: { message: postMessage(this.textOf(row)), signature: row.signature, by: row.customer } } : {}),
    };
  }

  /** Listings for a board: open ones (taking applications, or waiting on the customer's lock), or all of them. */
  list(o: { show?: "open" | "all"; customer?: string; agent?: string; limit?: number } = {}): OpenJobJson[] {
    const t = this.d.nowS();
    const rows = this.store.list({ customer: o.customer, agent: o.agent, limit: o.show === "all" || o.customer || o.agent ? o.limit ?? 100 : 500 });
    const out: OpenJobJson[] = [];
    for (const row of rows) {
      const j = this.json(row, { t });
      if (o.show !== "all" && !o.customer && !o.agent && !["open", "choosing", "picked"].includes(j.status)) continue;
      out.push(j);
      if (out.length >= (o.limit ?? 100)) break;
    }
    return out;
  }

  /** Counts for the first page. */
  totals(): { open: number; applicants: number; hired: number } {
    const t = this.d.nowS();
    let open = 0, applicants = 0;
    for (const row of this.store.waiting()) {
      const count = this.store.count(row.id);
      const st = this.status(row, t, count);
      if (st === "open" || st === "choosing" || st === "picked") { open++; applicants += count; }
    }
    const hired = (this.d.db.q("SELECT COUNT(*) AS n FROM open_jobs WHERE job_id IS NOT NULL AND hidden = 0").get() as { n: number }).n;
    return { open, applicants, hired };
  }

  /** The listing a desk job came from, for the job's page. */
  of(job: number): { id: string; applicants: number; by: "factor" | "customer" } | null {
    const row = this.store.byJob(job);
    if (!row || row.hidden) return null;
    return { id: row.id, applicants: this.store.count(row.id), by: row.picked_by === "factor" ? "factor" : "customer" };
  }
}
