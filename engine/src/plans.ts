// Monthly clients: a customer puts an agent, or a whole firm, on a monthly plan. Every month is an ordinary job on the
// desk, locked by the customer, which the agent can start with up to half of up front, delivers, and is paid for when
// the customer accepts it. Recurring income, on the agent's public record.
//
// There is no new contract. The desk holds a job for 30 days at most (MAX_DUE) and has no cancel for the customer,
// so the months cannot all be locked on the first day: a month locked for the third month would be due inside the
// first, and a month nobody has started could not be given back when the customer stops. So a plan is locked MONTH BY
// MONTH: the customer signs the plan once, locks the first month at once, and locks each next month when it comes
// (or as soon as the month before it is delivered). Every month's payment is on the chain before its work starts; a
// month that was never locked never left the customer's wallet.
//
//   POST /v1/plans/create   the customer signs the plan (planMessage): the agent (or the firm, through its lead), the
//                           price a month, how many months, whether each month may be started with half, a title and a
//                           brief. Nothing is locked yet; the first month is locked within a day or the plan lapses.
//   POST /v1/plans/month    { plan, month, job, lockTx, burnTx? }: a month locked on the chain, read from the desk's own
//                           Locked log, must be exactly the plan's: from its customer, for its agent, at its price, with
//                           its early switch, due when that month is due. Then the job is that month of the plan.
//   POST /v1/plans/stop     the customer signs to stop (stopMessage). No month is locked after it. A month locked
//                           ahead that the agent has not started can be declined by the agent (Factor's own agents
//                           decline it by themselves), and a month nobody answers comes back by the desk's own clock.
//   GET  /v1/plans/<id>     one plan: its months, each one's job, what can be drawn, and what comes next
//   GET  /v1/plans?agent=<address>|customer=<address>|firm=<slug>   plans, newest first
//
// The schedule: a plan's month is 30 days. Month 1 is due 30 days after its lock; month k is due (k - 1) months after
// month 1, or 30 days after its own lock when it is locked before its month begins (the desk's longest), whichever is
// sooner. Month k can be locked once month k - 1 is delivered, or once its own month has begun. A plan whose next
// month is not locked before that month runs out has lapsed.
//
// Next month early: a month locked ahead, before its month begins, is next month's income already locked. With a
// good record (below) the agent can draw on it from the pool, during this month. It is the desk's own pool advance:
// the same limit (the agent's bond and the fees it has paid in), the same 80% the pool may have out, the same
// repayment from the job's own payment before the agent is paid. Nothing here gives the pool more risk than any
// pool advance today. The rule for a good record is the engine's (the site and the kit offer the draw by it):
//   - the agent is not barred, has settled PLANS_NEXT_MIN_SETTLED jobs (3), and at most one in ten settled at half
//   - every month of this plan before it was delivered on time, and none was rejected or not delivered
//
// Every month adds its share to the burn like a Pay with Factor deal: the customer sends it to the burn pot beside the
// lock, and the engine checks the transfer on the chain before it counts it.

import { formatEther, keccak256, toHex, type Hex } from "viem";
import { normalizeAddress } from "./chain/address.js";
import type { EngineDb } from "./chain/db.js";
import { RULES, STATE, type AgentRecord } from "./desk.js";
import type { Firms } from "./firms.js";
import { MIN_JOB_WEI, readLock, type LockFacts, type PayLink } from "./pay.js";
import { briefText, oneLine } from "./profiles.js";
import { canDrawOf } from "./score.js";

type Env = Record<string, string | undefined>;

export interface PlansConfig {
  /** PLANS=on: off unless it is said */
  enabled: boolean;
  /** PLANS_MAX_MONTHS: the longest plan */
  mostMonths: number;
  /** PLANS_NEXT_MIN_SETTLED: jobs an agent has settled before it can draw next month early from the pool */
  nextMinSettled: number;
  /** how long a signed plan waits for its first month, seconds */
  startS: number;
  /** plans one customer may have running at once */
  perCustomer: number;
}

export function readPlans(env: Env, problems: string[] = []): PlansConfig {
  const on = (env.PLANS ?? "").trim().toLowerCase() === "on";
  const whole = (name: string, def: number, least: number, most: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    if (/^\d{1,3}$/.test(raw) && Number(raw) >= least && Number(raw) <= most) return Number(raw);
    problems.push(`${name} must be a whole number from ${least} to ${most}: it is "${raw}"`);
    return def;
  };
  return { enabled: on, mostMonths: whole("PLANS_MAX_MONTHS", 12, 2, 24), nextMinSettled: whole("PLANS_NEXT_MIN_SETTLED", 3, 0, 100), startS: 86_400, perCustomer: 20 };
}

/** A plan's month, and the desk's own limits on a job's due time. */
export const MONTH_S = 30 * 86_400;
const MAX_DUE_S = 30 * 86_400;
const MIN_DUE_S = 3600;
/** How far a lock's due time may be from the one the plan asks for: the customer's clock and the chain's differ, and a wallet can wait a while for its owner to confirm. */
export const DUE_SLACK_S = 3600;
/** A plan's title: shorter than a job's, since each month's job is called "Month 2 of 6: <title>". */
export const TITLE_MOST = 60;

/** What the customer signs. `price` is wei as text, per month. `firm`: the firm's short name, hired through its lead (`agent`). */
export interface PlanText { customer: string; agent: string; firm?: string; price: string; months: number; early: boolean; title: string; brief: string; at: number }

/**
 * The words the customer signs: readable, so a wallet shows exactly what it puts its name to. The same to the letter
 * in the kit (packages/kit/src/plans.ts) and on the site (web/src/lib/plans.ts).
 */
export function planMessage(p: PlanText): string {
  return [
    "Factor: a monthly plan",
    `customer: ${p.customer}`,
    `agent: ${p.agent}`,
    ...(p.firm ? [`firm: ${p.firm}`] : []),
    `price: ${formatEther(BigInt(p.price))} ETH a month`,
    `months: ${p.months}`,
    `early: ${p.early ? "up to half of each month may be drawn before delivery" : "nothing before delivery"}`,
    `title: ${p.title}`,
    `brief: ${p.brief ? keccak256(toHex(p.brief)) : "none"}`,
    `at: ${p.at}`,
  ].join("\n");
}

/** A plan's own number: the fingerprint of what was signed. */
export const planIdOf = (p: PlanText): Hex => keccak256(toHex(planMessage(p)));

/** What the customer signs to stop a plan. */
export const stopMessage = (s: { plan: string; customer: string; at: number }): string => ["Factor: stop a monthly plan", `plan: ${s.plan}`, `customer: ${s.customer}`, `at: ${s.at}`].join("\n");

/** The title each month's job carries. */
export const monthTitle = (month: number, months: number, title: string): string => `Month ${month} of ${months}: ${title}`;

// ---------- the books ----------

export interface PlanRow {
  id: string; customer: string; agent: string; firm: string | null; price: string; months: number; early: number; title: string; brief: string;
  signed_at: number; signature: string; via: string; link_id: string | null; created_at: number; start_at: number | null;
  stopped_at: number | null; stop_signature: string | null; hidden: number;
}
export interface MonthRow { plan_id: string; month: number; job_id: number; lock_tx: string; burn_wei: string; burn_tx: string | null; linked_at: number }

const SCHEMA = `
-- Monthly clients (./plans.ts). A plan: what its customer signed. start_at is month 1's due time less a month, set when
-- month 1 is linked: every later month's due time is reckoned from it.
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,               -- the fingerprint of the signed words
  customer TEXT NOT NULL,
  agent TEXT NOT NULL,               -- the agent, or the firm's lead
  firm TEXT,                         -- the firm's short name, when the plan is with a firm
  price TEXT NOT NULL,               -- wei, each month
  months INTEGER NOT NULL,
  early INTEGER NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  via TEXT NOT NULL,                 -- hire | kit | link
  link_id TEXT,                      -- the subscribe link it was bought through
  created_at INTEGER NOT NULL,       -- ms
  start_at INTEGER,                  -- chain seconds
  stopped_at INTEGER,                -- chain seconds
  stop_signature TEXT,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS plans_agent ON plans (agent);
CREATE INDEX IF NOT EXISTS plans_customer ON plans (customer);
CREATE INDEX IF NOT EXISTS plans_firm ON plans (firm);
-- A month of a plan: a job on the desk. Never taken back by a reindex: job numbers are the desk's own.
CREATE TABLE IF NOT EXISTS plan_months (
  plan_id TEXT NOT NULL,
  month INTEGER NOT NULL,
  job_id INTEGER NOT NULL UNIQUE,
  lock_tx TEXT NOT NULL,
  burn_wei TEXT NOT NULL DEFAULT '0',
  burn_tx TEXT UNIQUE,
  linked_at INTEGER NOT NULL,        -- ms
  PRIMARY KEY (plan_id, month)
);
`;

export class PlanStore {
  constructor(private db: EngineDb) {
    db.db.exec(SCHEMA);
  }

  plan(id: string): PlanRow | null {
    return (this.db.q("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined) ?? null;
  }

  months(plan: string): MonthRow[] {
    return this.db.q("SELECT * FROM plan_months WHERE plan_id = ? ORDER BY month").all(plan) as MonthRow[];
  }

  byJob(job: number): MonthRow | null {
    return (this.db.q("SELECT * FROM plan_months WHERE job_id = ?").get(job) as MonthRow | undefined) ?? null;
  }

  byBurnTx(tx: string): MonthRow | null {
    return (this.db.q("SELECT * FROM plan_months WHERE burn_tx = ?").get(tx) as MonthRow | undefined) ?? null;
  }

  list(o: { agent?: string; customer?: string; firm?: string; limit?: number } = {}): PlanRow[] {
    const where = ["hidden = 0", "start_at IS NOT NULL"], args: unknown[] = [];
    if (o.agent) { where.push("agent = ?"); args.push(o.agent); }
    if (o.customer) { where.push("customer = ?"); args.push(o.customer); }
    if (o.firm) { where.push("firm = ?"); args.push(o.firm); }
    return this.db.q(`SELECT * FROM plans WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...args, o.limit ?? 200) as PlanRow[];
  }

  hide(id: string, hidden: boolean): boolean {
    return this.db.q("UPDATE plans SET hidden = ? WHERE id = ?").run(hidden ? 1 : 0, id).changes === 1;
  }
}

// ---------- what a page and an app read ----------

export type PlanStatus = "waiting" | "active" | "stopped" | "ended" | "lapsed" | "done";
export interface PlanMonthJson {
  month: number;
  job: number;
  id: string;
  state: string;
  dueAt: string;
  /** when this month begins: before it, a locked month is next month's income, drawn early */
  beginsAt: string;
  late: boolean;
  /** drawn on it so far: up front out of its own payment, and from the pool */
  upFrontEth: number;
  fromPoolEth: number;
  /** of that, what was drawn from the pool before the month began: next month's income, early */
  nextEarlyEth: number;
  /** what the agent was paid when it settled */
  paidEth?: number;
  burnEth: number;
  lockTx: string;
}
export interface PlanNextJson {
  /** the month that would be locked next */
  month: number;
  /** whether the customer can lock it now, or why not */
  open: boolean;
  why?: string;
  /** from when it can be locked, if not yet */
  from?: string;
  /** the due time it gets when locked now */
  dueAt?: string;
  /** its month runs out at: unlocked by then, the plan lapses */
  lapsesAt: string;
}
export interface PlanEarlyJson {
  month: number;
  job: number;
  /** true: its month has not begun, so a draw on it is next month's income early */
  ahead: boolean;
  open: boolean;
  why?: string;
  /** what the pool would advance on it right now (the desk's own limits), and up front out of its own payment */
  fromPoolEth: number;
  fromPoolWei: string;
  upFrontEth: number;
}
export interface PlanJson {
  id: string;
  status: PlanStatus;
  /** why it ended or lapsed, in a line */
  note?: string;
  customer: string;
  agent: { address: string; name: string; named: boolean };
  firm?: { slug: string; name: string; house: boolean };
  title: string;
  brief: string;
  priceEth: number;
  priceWei: string;
  months: number;
  early: boolean;
  via: string;
  signedAt: string;
  startAt: string | null;
  stoppedAt: string | null;
  /** months locked, delivered (or settled), and settled */
  locked: number;
  delivered: number;
  settled: number;
  /** what the settled months paid the agent, and what was locked in all */
  paidEth: number;
  lockedEth: number;
  items: PlanMonthJson[];
  next: PlanNextJson | null;
  drawEarly: PlanEarlyJson | null;
  /** the words the customer signed, and the signature, for anyone to check again */
  signed: { message: string; signature: string; by: string };
}
/** An agent's (or a firm's) monthly clients, for its page and its record. */
export interface PlansSummaryJson {
  active: number;
  clients: number;
  /** the price a month of every active plan, added up */
  monthlyEth: number;
  monthlyWei: string;
  monthsDelivered: number;
  monthsSettled: number;
  plans: number;
  items: { id: string; status: PlanStatus; customer: string; title: string; priceEth: number; months: number; locked: number; delivered: number; firm?: string }[];
}

// ---------- the rules ----------

type Answer = { status: number; body: Record<string, unknown> };
const no = (status: number, error: string): Answer => ({ status, body: { error } });
const WINDOW_S = 600;
const ethNum = (wei: bigint | string): number => Number(BigInt(wei) / 10n ** 12n) / 1e6;
const iso = (s: number): string => new Date(s * 1000).toISOString();
const pad = (id: number): string => String(id).padStart(4, "0");
const STATE_WORD = ["none", "locked", "advanced", "delivered", "settled", "half", "declined", "refunded"] as const;

interface DeskJob { id: number; customer: string; agent: string; price: string; due_at: number; state: number; locked_at: number; allow_early: number; early: string; from_pool: string; late: number; paid: string; locked_tx: string }
const JOB_COLS = "id, customer, agent, price, due_at, state, locked_at, allow_early, early, from_pool, late, paid, locked_tx";

export interface PlanDeps {
  cfg: PlansConfig;
  db: EngineDb;
  chain: Parameters<typeof readLock>[0];
  desk: string;
  /** whether `address` signed `message`: a wallet, or an account through one of its keys (../profiles.ts) */
  signed: (address: string, message: string, signature: unknown) => Promise<boolean>;
  /** the chain's time now, in seconds */
  nowS: () => number;
  /** new jobs are paused by the owner: the note to say, or null */
  paused: () => string | null;
  /** what a month adds to the burn, wei, for its price (../pay.ts); 0n when Pay with Factor adds nothing */
  burnFor: (priceWei: bigint) => bigint;
  /** what a transaction sent to the burn pot from a customer (../pay.ts burnIn) */
  burnIn: (customer: string, hash: string) => Promise<bigint | string>;
  /** whether a transfer to the burn pot was already counted for a deal or a sub-job */
  burnUsed: (hash: string) => boolean;
  /** a subscribe link, read and checked (../pay.ts) */
  checkLink: (token: unknown, at?: number) => Promise<{ ok: true; link: PayLink; id: string } | { ok: false; status: number; error: string }>;
  /** agent firms (./firms.ts): a plan with a firm files each month under it. null while firms are off */
  firms: () => Firms | null;
  /** whether two addresses are run by the same hand, as far as Factor can see (./subjobs.ts) */
  sameHand: (a: string, b: string) => boolean;
  /** names agents signed, by address */
  names: () => Map<string, { name: string }>;
  /** the pool, as the last reading of the chain has it: what is in it, and what is out with agents */
  pool: () => { pool: bigint; out: bigint } | null;
}

export class Plans {
  readonly store: PlanStore;

  constructor(private d: PlanDeps) {
    this.store = new PlanStore(d.db);
  }

  get cfg(): PlansConfig {
    return this.d.cfg;
  }

  private job(id: number): DeskJob | null {
    return (this.d.db.q(`SELECT ${JOB_COLS} FROM desk_jobs WHERE id = ?`).get(id) as DeskJob | undefined) ?? null;
  }

  private record(address: string): AgentRecord | null {
    const r = this.d.db.q("SELECT record FROM desk_agents WHERE address = ?").get(address) as { record: string } | undefined;
    return r ? (JSON.parse(r.record) as AgentRecord) : null;
  }

  private fresh(at: unknown): number | null {
    if (typeof at !== "number" || !Number.isSafeInteger(at)) return null;
    return Math.abs(this.d.nowS() - at) <= WINDOW_S ? at : null;
  }

  /** The customer signs a plan with an agent, or with a firm through its lead. Nothing is locked here. */
  async create(body: Record<string, unknown>, via: "hire" | "kit" | "link" = "hire"): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "monthly plans are switched off for now");
    const paused = this.d.paused();
    if (paused) return no(409, paused);
    const customer = normalizeAddress(body.customer);
    if (!customer) return no(400, "customer is not an address");
    const price = typeof body.price === "string" && /^\d{1,30}$/.test(body.price) ? body.price : null;
    if (price === null) return no(400, "price is the price of one month, in wei, as text");
    if (BigInt(price) < MIN_JOB_WEI) return no(400, "a month is 0.001 ETH at least, the desk's smallest job");
    const months = typeof body.months === "number" && Number.isSafeInteger(body.months) ? body.months : null;
    if (months === null || months < 2 || months > this.d.cfg.mostMonths) return no(400, `a plan is 2 to ${this.d.cfg.mostMonths} months`);
    if (typeof body.early !== "boolean") return no(400, "early is true or false: whether the agent may start each month with up to half of it");
    const title = oneLine(body.title, 3, TITLE_MOST);
    if (!title || title !== body.title) return no(400, `a plan's title is one plain line of 3 to ${TITLE_MOST} characters, without links, line breaks or double spaces`);
    const brief = body.brief === "" || body.brief === undefined ? "" : briefText(body.brief);
    if (brief === null || (brief !== "" && brief !== body.brief)) return no(400, "a brief is plain text of up to 12,000 characters");
    const at = this.fresh(body.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    // with an agent, or with a firm: a firm is hired through its lead
    let agent = normalizeAddress(body.agent);
    let firm: string | undefined;
    if (body.firm !== undefined && body.firm !== null && body.firm !== "") {
      const f = this.d.firms();
      if (!f) return no(503, "firms are switched off for now: put the agent itself on the plan");
      const row = typeof body.firm === "string" ? f.store.bySlug(body.firm) : null;
      if (!row || row.hidden) return no(404, "no such firm");
      if (agent && agent !== row.lead) return no(400, "a firm is hired through its lead: agent must be the firm's lead");
      agent = row.lead;
      firm = row.slug;
      const why = f.customerProblem(row, customer);
      if (why) return no(409, why);
    }
    if (!agent) return no(400, "agent is not an address");
    if (agent === customer) return no(400, "an agent cannot be its own monthly client");
    if (this.d.sameHand(agent, customer)) return no(409, "the customer is run by the same hand as the agent, so the plan would only make records");
    if (!this.d.db.q("SELECT 1 FROM desk_agents WHERE address = ?").get(agent)) return no(404, "that agent has not registered on the desk");
    const p: PlanText = { customer, agent, ...(firm ? { firm } : {}), price, months, early: body.early, title, brief, at };
    // bought through a subscribe link: the plan must be the link's own terms, which its agent signed
    let linkId: string | null = null;
    if (body.link !== undefined && body.link !== null && body.link !== "") {
      const c = await this.d.checkLink(body.link);
      if (!c.ok) return no(c.status, c.error);
      const l = c.link;
      if (!l.months) return no(400, "that link sells one job, not a monthly plan");
      if (l.agent !== agent || l.price !== price || l.months !== months || l.early !== p.early || l.title !== title || l.brief !== brief || (l.firm ?? undefined) !== firm) return no(400, "the plan is not the link's terms: sign the plan the link describes");
      linkId = c.id;
      via = "link";
    }
    let ok = false;
    try {
      ok = await this.d.signed(customer, planMessage(p), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, "the signature is not the customer's");
    const id = planIdOf(p);
    const db = this.d.db;
    return db.tx((): Answer => {
      const had = this.store.plan(id);
      if (had) return { status: 200, body: { ok: true, plan: id, created: false } };
      const running = this.store.list({ customer }).filter((x) => this.status(x).status === "active").length;
      if (running >= this.d.cfg.perCustomer) return no(429, `a customer has ${this.d.cfg.perCustomer} plans running at most`);
      db.q("INSERT INTO plans (id, customer, agent, firm, price, months, early, title, brief, signed_at, signature, via, link_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, customer, agent, firm ?? null, price, months, p.early ? 1 : 0, title, brief, at, String(body.signature), via, linkId, db.now());
      return { status: 200, body: { ok: true, plan: id, created: true, burnWei: this.d.burnFor(BigInt(price)).toString(), dueAt: this.d.nowS() + MONTH_S - 300 } };
    });
  }

  /** A month locked on the chain, linked to its plan. Asked again for the same job, it answers the same. */
  async month(body: Record<string, unknown>): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "monthly plans are switched off for now");
    const planId = typeof body.plan === "string" && /^0x[0-9a-f]{64}$/.test(body.plan) ? body.plan : null;
    const job = typeof body.job === "number" && Number.isSafeInteger(body.job) && body.job > 0 ? body.job : null;
    const lockTx = typeof body.lockTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.lockTx) ? body.lockTx.toLowerCase() : null;
    const burnTx = body.burnTx === undefined || body.burnTx === null || body.burnTx === "" ? null : typeof body.burnTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.burnTx) ? body.burnTx.toLowerCase() : "bad";
    if (!planId || job === null || !lockTx) return no(400, "send { plan, job, lockTx }: the plan's number, the job's number and the transaction that locked it");
    if (burnTx === "bad") return no(400, "burnTx is a transaction's hash");
    const locked = await readLock(this.d.chain, this.d.desk, job, lockTx);
    if (typeof locked === "string") return no(locked.startsWith("not yet") ? 404 : 400, locked);
    const r = this.attach(planId, job, locked, lockTx);
    if (r.status !== 200 || !burnTx) return r;
    const burn = await this.addBurn(job, locked.customer, burnTx);
    return { status: 200, body: { ...r.body, ...burn } };
  }

  /** The link itself, once the lock was read from the chain. */
  attach(planId: string, job: number, locked: LockFacts, lockTx: string): Answer {
    const db = this.d.db;
    const r = db.tx((): Answer => {
      const had = this.store.byJob(job);
      if (had) return had.plan_id === planId ? { status: 200, body: this.linked(had) } : no(409, "that job is already a month of another plan");
      const plan = this.store.plan(planId);
      if (!plan) return no(404, "no such plan: sign the plan first (POST /v1/plans/create)");
      const done = this.store.months(planId);
      const month = done.length + 1;
      const why = this.monthProblem(plan, done, month, locked);
      if (why) return no(409, `${why}. The job stands on the desk as an ordinary job of yours`);
      if (month === 1) db.q("UPDATE plans SET start_at = ? WHERE id = ?").run(locked.dueAt - MONTH_S, planId);
      db.q("INSERT INTO plan_months (plan_id, month, job_id, lock_tx, linked_at) VALUES (?, ?, ?, ?, ?)").run(planId, month, job, lockTx, db.now());
      // what the month is about, as the customer signed it with the plan
      db.q("INSERT INTO job_titles (job_id, title, by, signed_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING").run(job, monthTitle(month, plan.months, plan.title), plan.customer, plan.signed_at);
      if (plan.brief) db.q("INSERT INTO job_briefs (job_id, brief, by, signed_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING").run(job, plan.brief, plan.customer, plan.signed_at);
      return { status: 200, body: this.linked(this.store.byJob(job)!) };
    });
    if (r.status !== 200) return r;
    // a plan with a firm: each month is the firm's job, with the sub-jobs its lead hires under it
    const plan = this.store.plan(planId)!;
    if (plan.firm) {
      const f = this.d.firms();
      const filed = f ? f.attachDeal(job, plan.firm, locked, planId, "plan") : { firmNote: "firms are switched off for now: the month stands as the lead's own job" };
      return { status: 200, body: { ...r.body, ...filed } };
    }
    return r;
  }

  private linked(m: MonthRow): Record<string, unknown> {
    const plan = this.store.plan(m.plan_id)!;
    return { ok: true, plan: m.plan_id, month: m.month, months: plan.months, job: m.job_id, jobId: pad(m.job_id), burnWei: m.burn_wei };
  }

  /** Why a lock cannot be month `month` of a plan, or null. */
  monthProblem(plan: PlanRow, done: MonthRow[], month: number, locked: LockFacts): string | null {
    if (plan.hidden) return "that plan was taken off Factor";
    if (plan.stopped_at !== null) return "the customer stopped this plan: no month is locked after that";
    if (month > plan.months) return `the plan's ${plan.months} months are all locked already`;
    if (locked.customer !== plan.customer) return "that job was not locked by the plan's customer";
    if (locked.agent !== plan.agent) return "that job was locked for another agent than the plan's";
    if (locked.price !== BigInt(plan.price)) return "that job's price is not the plan's price a month";
    if (locked.allowEarly !== !!plan.early) return "that job does not allow an early start the way the plan says";
    if (month === 1) {
      if (locked.at > plan.signed_at + this.d.cfg.startS) return "the plan lapsed: its first month was not locked within a day of signing it";
      if (Math.abs(locked.dueAt - (locked.at + MONTH_S)) > DUE_SLACK_S) return "month 1 is due 30 days after it is locked";
      return null;
    }
    const start = plan.start_at!;
    const prev = this.job(done[month - 2]!.job_id);
    if (!prev) return "the month before it has not been read from the desk yet: try again in a few seconds";
    if (prev.state === STATE.declined || prev.state === STATE.refunded) return `month ${month - 1} was not delivered, so the plan ended there`;
    const begins = start + (month - 1) * MONTH_S;
    const ends = start + month * MONTH_S;
    if (locked.at > ends - MIN_DUE_S) return `month ${month} ran out before it was locked: the plan lapsed`;
    const delivered = prev.state === STATE.delivered || prev.state === STATE.settled || prev.state === STATE.half;
    if (!delivered && locked.at < begins) return `month ${month} can be locked once month ${month - 1} is delivered, or from ${iso(begins).slice(0, 16).replace("T", " ")} UTC`;
    const want = Math.min(ends, locked.at + MAX_DUE_S);
    if (Math.abs(locked.dueAt - want) > DUE_SLACK_S) return `month ${month} is due ${iso(want).slice(0, 16).replace("T", " ")} UTC: the end of its month, or 30 days after its lock when that is sooner`;
    return null;
  }

  /** What the customer added to the burn beside a month. */
  private async addBurn(job: number, customer: string, burnTx: string): Promise<Record<string, unknown>> {
    const m = this.store.byJob(job);
    if (!m) return {};
    const plan = this.store.plan(m.plan_id)!;
    const need = this.d.burnFor(BigInt(plan.price));
    if (BigInt(m.burn_wei) > 0n) return { burned: BigInt(m.burn_wei) >= need, burnWei: m.burn_wei, burnNeededWei: need.toString() };
    const used = this.store.byBurnTx(burnTx);
    if ((used && used.job_id !== job) || this.d.burnUsed(burnTx)) return { burned: false, burnNote: "that transfer to the burn pot was already counted for another deal", burnNeededWei: need.toString() };
    const sent = await this.d.burnIn(customer, burnTx);
    if (typeof sent === "string") return { burned: false, burnNote: sent, burnNeededWei: need.toString() };
    if (sent < need) return { burned: false, burnNote: `the transfer to the burn pot was ${formatEther(sent)} ETH, under the month's ${formatEther(need)} ETH`, burnNeededWei: need.toString() };
    this.d.db.q("UPDATE plan_months SET burn_wei = ?, burn_tx = ? WHERE job_id = ?").run(sent.toString(), burnTx, job);
    return { burned: true, burnWei: sent.toString(), burnNeededWei: need.toString() };
  }

  /** The customer signs to stop the plan. No month is locked after it; the months already locked run as any job. */
  async stop(body: Record<string, unknown>): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "monthly plans are switched off for now");
    const planId = typeof body.plan === "string" && /^0x[0-9a-f]{64}$/.test(body.plan) ? body.plan : null;
    if (!planId) return no(400, "plan is the plan's number");
    const plan = this.store.plan(planId);
    if (!plan || plan.hidden) return no(404, "no such plan");
    const at = this.fresh(body.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    if (plan.stopped_at !== null) return { status: 200, body: { ok: true, plan: planId, stopped: true } };
    let ok = false;
    try {
      ok = await this.d.signed(plan.customer, stopMessage({ plan: planId, customer: plan.customer, at }), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, "only the plan's customer can stop it");
    this.d.db.q("UPDATE plans SET stopped_at = ?, stop_signature = ? WHERE id = ? AND stopped_at IS NULL").run(this.d.nowS(), String(body.signature), planId);
    return { status: 200, body: { ok: true, plan: planId, stopped: true, notStarted: this.notStarted(planId) } };
  }

  /** The months of a stopped plan that are locked and that nobody has started: the agent can decline each, which gives it all back. */
  notStarted(planId: string): number[] {
    // a month linked a moment ago may not be read from the desk yet: it was locked, and nobody can have started it
    return this.store.months(planId).filter((m) => { const j = this.job(m.job_id); return !j || j.state === STATE.locked; }).map((m) => m.job_id);
  }

  /**
   * Why an agent should decline a job, when it is a month of a stopped plan that it has not started: the customer
   * stopped the plan, and declining gives the customer the whole month back. null for any other job.
   */
  stoppedMonth(job: number): string | null {
    const m = this.store.byJob(job);
    if (!m) return null;
    const plan = this.store.plan(m.plan_id);
    if (!plan || plan.stopped_at === null) return null;
    const j = this.job(job);
    if (!j || j.state !== STATE.locked) return null;
    return `the customer stopped the monthly plan before month ${m.month} was started, so it goes back to them`;
  }

  /** Where a plan stands, and why when it ended or lapsed. */
  status(plan: PlanRow, t = this.d.nowS()): { status: PlanStatus; note?: string; rows: { m: MonthRow; job: DeskJob | null }[] } {
    const rows = this.store.months(plan.id).map((m) => ({ m, job: this.job(m.job_id) }));
    const closed = (s: number | undefined) => s === STATE.settled || s === STATE.half || s === STATE.declined || s === STATE.refunded;
    if (!rows.length) return t > plan.signed_at + this.d.cfg.startS ? { status: "lapsed", note: "its first month was not locked within a day", rows } : { status: "waiting", rows };
    const failed = rows.find((r) => r.job?.state === STATE.declined || r.job?.state === STATE.refunded);
    if (plan.stopped_at !== null) return { status: "stopped", note: `stopped by the customer after ${rows.length} of ${plan.months} months`, rows };
    if (failed) return { status: "ended", note: `month ${failed.m.month} was ${failed.job!.state === STATE.declined ? "declined" : "not delivered"}, so the plan ended there`, rows };
    if (rows.length === plan.months) return rows.every((r) => closed(r.job?.state)) ? { status: "done", rows } : { status: "active", rows };
    const next = rows.length + 1;
    if (plan.start_at !== null && t > plan.start_at + next * MONTH_S - MIN_DUE_S) return { status: "lapsed", note: `month ${next} was not locked in its month`, rows };
    return { status: "active", rows };
  }

  /** What was drawn on a job from the pool (to the agent or as compute) before a moment: read from the desk's own logs. */
  private poolBefore(job: number, before: number): bigint {
    const rows = this.d.db.q("SELECT amount FROM desk_advances WHERE job_id = ? AND kind != 0 AND at < ?").all(job, before) as { amount: string }[];
    return rows.reduce((n, r) => n + BigInt(r.amount), 0n);
  }

  /** The pool's own figures, as the desk works them out: what it can still send out (it never has more than 80% out). */
  private poolRoom(): bigint {
    const p = this.d.pool();
    if (!p) return 0n;
    const cap = ((p.pool + p.out) * 8000n) / 10_000n;
    return cap > p.out ? cap - p.out : 0n;
  }

  /** Whether the agent can draw on a month from the pool by the plan's rule of a good record, and how much the desk allows. */
  private earlyOf(plan: PlanRow, rows: { m: MonthRow; job: DeskJob | null }[], t: number): PlanEarlyJson | null {
    // the newest locked month after the first that is still open: next month's, when its month has not begun
    const open = [...rows].reverse().find((r) => r.m.month >= 2 && r.job && (r.job.state === STATE.locked || r.job.state === STATE.advanced));
    if (!open || !open.job || plan.start_at === null) return null;
    const j = open.job;
    const begins = plan.start_at + (open.m.month - 1) * MONTH_S;
    const half = (BigInt(j.price) * 5000n) / 10_000n;
    const drawn = BigInt(j.early || "0") + BigInt(j.from_pool || "0");
    const room = half > drawn ? half - drawn : 0n;
    const rec = this.record(plan.agent);
    let why: string | null = null;
    if (!this.d.cfg.enabled) why = "monthly plans are switched off for now";
    else if (t > j.due_at + RULES.graceS) why = "the month's time is up";
    else if (!rec || rec.barred) why = "the pool does not advance this agent";
    else if (rec.settled < this.d.cfg.nextMinSettled) why = `the agent has settled ${rec.settled} job${rec.settled === 1 ? "" : "s"}: next month early takes ${this.d.cfg.nextMinSettled}`;
    else if (rec.settledAtHalf * 10 > rec.settled) why = "more than one in ten of the agent's jobs settled at half";
    else {
      const before = rows.filter((r) => r.m.month < open.m.month);
      const bad = before.find((r) => !r.job || r.job.state === STATE.half || r.job.state === STATE.declined || r.job.state === STATE.refunded || !!r.job.late || (r.job.state !== STATE.delivered && r.job.state !== STATE.settled));
      if (bad) why = `month ${bad.m.month} of this plan ${!bad.job ? "is not read yet" : bad.job.state === STATE.half ? "was rejected" : bad.job.late ? "was delivered late" : bad.job.state === STATE.locked || bad.job.state === STATE.advanced ? "is not delivered yet" : "was not delivered"}`;
    }
    let fromPool = room;
    const can = rec ? canDrawOf(rec) : 0n;
    if (can < fromPool) fromPool = can;
    const pr = this.poolRoom();
    if (pr < fromPool) fromPool = pr;
    if (!why && room === 0n) why = "half of the month is drawn already";
    else if (!why && fromPool === 0n) why = can === 0n ? "the agent's limit with the pool is used up: it grows with its bond and the fees its jobs pay in" : "the pool has nothing to advance right now";
    return {
      month: open.m.month, job: j.id, ahead: t < begins, open: !why, ...(why ? { why } : {}),
      fromPoolEth: why ? 0 : ethNum(fromPool), fromPoolWei: why ? "0" : fromPool.toString(), upFrontEth: j.allow_early ? ethNum(room) : 0,
    };
  }

  /** What the customer can lock next, and when. */
  private nextOf(plan: PlanRow, rows: { m: MonthRow; job: DeskJob | null }[], status: PlanStatus, t: number): PlanNextJson | null {
    if (status !== "active" || rows.length >= plan.months || plan.start_at === null) return null;
    const month = rows.length + 1;
    const begins = plan.start_at + (month - 1) * MONTH_S, ends = plan.start_at + month * MONTH_S;
    const prev = rows[rows.length - 1]!.job;
    const delivered = !!prev && (prev.state === STATE.delivered || prev.state === STATE.settled || prev.state === STATE.half);
    const lapsesAt = iso(ends - MIN_DUE_S);
    if (!delivered && t < begins) return { month, open: false, why: `month ${month - 1} is not delivered yet`, from: iso(begins), lapsesAt };
    return { month, open: true, dueAt: iso(Math.min(ends, t + MAX_DUE_S - 300)), lapsesAt };
  }

  private named(address: string): { address: string; name: string; named: boolean } {
    const p = this.d.names().get(address);
    return { address, name: p?.name ?? `${address.slice(0, 6)}…${address.slice(-4)}`, named: !!p };
  }

  json(plan: PlanRow, t = this.d.nowS()): PlanJson {
    const st = this.status(plan, t);
    const rows = st.rows;
    const firmRow = plan.firm ? this.d.firms()?.store.bySlug(plan.firm) ?? null : null;
    const items: PlanMonthJson[] = rows.map(({ m, job }) => ({
      month: m.month, job: m.job_id, id: pad(m.job_id), state: job ? STATE_WORD[job.state] ?? "locked" : "locked",
      dueAt: job ? iso(job.due_at) : "", beginsAt: plan.start_at !== null ? iso(plan.start_at + (m.month - 1) * MONTH_S) : "",
      late: !!job?.late, upFrontEth: ethNum(job?.early || "0"), fromPoolEth: ethNum(job?.from_pool || "0"),
      nextEarlyEth: plan.start_at !== null ? ethNum(this.poolBefore(m.job_id, plan.start_at + (m.month - 1) * MONTH_S)) : 0,
      ...(job && (job.state === STATE.settled || job.state === STATE.half) ? { paidEth: ethNum(job.paid || "0") } : {}),
      burnEth: ethNum(m.burn_wei), lockTx: m.lock_tx,
    }));
    const settledRows = rows.filter((r) => r.job?.state === STATE.settled || r.job?.state === STATE.half);
    const p: PlanText = { customer: plan.customer, agent: plan.agent, ...(plan.firm ? { firm: plan.firm } : {}), price: plan.price, months: plan.months, early: !!plan.early, title: plan.title, brief: plan.brief, at: plan.signed_at };
    return {
      id: plan.id, status: st.status, ...(st.note ? { note: st.note } : {}), customer: plan.customer, agent: this.named(plan.agent),
      ...(firmRow ? { firm: { slug: firmRow.slug, name: firmRow.name, house: !!firmRow.house } } : {}),
      title: plan.title, brief: plan.brief, priceEth: ethNum(plan.price), priceWei: plan.price, months: plan.months, early: !!plan.early, via: plan.via,
      signedAt: iso(plan.signed_at), startAt: plan.start_at !== null ? iso(plan.start_at) : null, stoppedAt: plan.stopped_at !== null ? iso(plan.stopped_at) : null,
      locked: rows.length, delivered: rows.filter((r) => r.job && r.job.state >= STATE.delivered && r.job.state <= STATE.half).length, settled: rows.filter((r) => r.job?.state === STATE.settled).length,
      paidEth: ethNum(settledRows.reduce((n, r) => n + BigInt(r.job!.paid || "0"), 0n)), lockedEth: ethNum(BigInt(plan.price) * BigInt(rows.length)),
      items, next: this.nextOf(plan, rows, st.status, t), drawEarly: this.earlyOf(plan, rows, t),
      signed: { message: planMessage(p), signature: plan.signature, by: plan.customer },
    };
  }

  /** The monthly clients of an agent (as the agent of the plans) or of a firm. */
  summary(o: { agent?: string; firm?: string }): PlansSummaryJson {
    const t = this.d.nowS();
    const plans = this.store.list(o);
    let monthly = 0n, delivered = 0, settled = 0;
    const clients = new Set<string>();
    const items: PlansSummaryJson["items"] = [];
    for (const plan of plans) {
      const st = this.status(plan, t);
      if (st.status === "active") { monthly += BigInt(plan.price); clients.add(plan.customer); }
      const d = st.rows.filter((r) => r.job && r.job.state >= STATE.delivered && r.job.state <= STATE.half).length;
      delivered += d;
      settled += st.rows.filter((r) => r.job?.state === STATE.settled).length;
      items.push({ id: plan.id, status: st.status, customer: plan.customer, title: plan.title, priceEth: ethNum(plan.price), months: plan.months, locked: st.rows.length, delivered: d, ...(plan.firm ? { firm: plan.firm } : {}) });
    }
    return { active: items.filter((i) => i.status === "active").length, clients: clients.size, monthlyEth: ethNum(monthly), monthlyWei: monthly.toString(), monthsDelivered: delivered, monthsSettled: settled, plans: plans.length, items: items.slice(0, 50) };
  }

  /** Every active plan together: for the first page's figures. */
  totals(): { active: number; clients: number; monthlyEth: number } {
    const t = this.d.nowS();
    let active = 0, monthly = 0n;
    const clients = new Set<string>();
    for (const plan of this.store.list({ limit: 5000 })) {
      if (this.status(plan, t).status !== "active") continue;
      active++;
      monthly += BigInt(plan.price);
      clients.add(plan.customer);
    }
    return { active, clients: clients.size, monthlyEth: ethNum(monthly) };
  }

  /** The month a job is, for the job's page. */
  monthOf(job: number): { plan: string; month: number; months: number; title: string } | null {
    const m = this.store.byJob(job);
    if (!m) return null;
    const plan = this.store.plan(m.plan_id);
    return plan && !plan.hidden ? { plan: plan.id, month: m.month, months: plan.months, title: plan.title } : null;
  }
}
