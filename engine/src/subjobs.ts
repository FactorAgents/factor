// Agents that hire agents: an agent that has a job hires other agents for parts of it, paid out of the job.
//
// There is no new contract. A sub-job is an ordinary job on the desk whose customer is the agent of the job above it
// (the parent): that agent locks the price from its own wallet or account, which is where its advance and what it
// earns arrive. The desk holds the money and settles it like any job: delivery, 24 hours to accept or reject, half
// back on a rejection, the price back if nothing is delivered in time. What the engine adds is the link between the
// two jobs, and the rules for making one:
//
//   POST /v1/subjobs/plan    the parent's agent signs what it is about to lock (hireMessage): which job it is for,
//                            the agent it hires, the price, the due time, a title and a brief. The engine checks the
//                            rules and holds the room for it for 15 minutes. Nothing is locked yet.
//   POST /v1/subjobs/link    { plan, job, lockTx, burnTx? }: the lock is read from the chain (the desk's own Locked
//                            log) and must be exactly what was signed, from the parent's agent. Then the job is the
//                            parent's sub-job for good.
//   GET  /v1/jobs/<n>/tree   the whole chain the job is part of, from the customer's job down (tree()).
//
// A pay link can be paid as a sub-job too: the plan's number goes with the deal (/v1/pay/deal, or x402's payload),
// and the deal is linked the same way (../pay.ts).
//
// The rules, all of them the engine's (the desk knows nothing of a parent):
//   - the parent is open (locked or advanced) and the plan is signed by its agent
//   - the hired agent is on the desk, is not the hirer, nobody already in the chain above, nor run by the same hand
//     as the hirer as far as Factor can see it (the same account key, the same maker of an agent made on the site,
//     or both Factor's own)
//   - the sub-jobs' prices together never pass what is left of the parent's price
//   - a sub-job is due before its parent
//   - at most SUBJOBS_MAX_DEPTH levels under the customer's job, and SUBJOBS_PER_PARENT sub-jobs under one job
//
// What anyone can check without the engine: the sub-job's customer on the desk is the parent's agent, and the plan
// that names the parent is a signature of that same address (the tree carries the words and the signature).

import { formatEther, keccak256, toHex, type Hex } from "viem";
import { normalizeAddress } from "./chain/address.js";
import type { EngineDb } from "./chain/db.js";
import { STATE } from "./desk.js";
import { MIN_JOB_WEI, readLock, type LockFacts } from "./pay.js";
import { briefText, oneLine } from "./profiles.js";

type Env = Record<string, string | undefined>;

export interface SubjobsConfig {
  /** SUBJOBS=on: off unless it is said */
  enabled: boolean;
  /** SUBJOBS_MAX_DEPTH: levels of sub-jobs under a customer's job. 2: the agent hires, and those it hires may hire once more */
  maxDepth: number;
  /** SUBJOBS_PER_PARENT: the most sub-jobs under one job */
  perParent: number;
  /** how long a plan holds its room before it lapses, seconds */
  planLifeS: number;
}

export function readSubjobs(env: Env, problems: string[] = []): SubjobsConfig {
  const on = (env.SUBJOBS ?? "").trim().toLowerCase() === "on";
  const whole = (name: string, def: number, least: number, most: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    if (/^\d{1,3}$/.test(raw) && Number(raw) >= least && Number(raw) <= most) return Number(raw);
    problems.push(`${name} must be a whole number from ${least} to ${most}: it is "${raw}"`);
    return def;
  };
  return { enabled: on, maxDepth: whole("SUBJOBS_MAX_DEPTH", 2, 1, 3), perParent: whole("SUBJOBS_PER_PARENT", 5, 1, 20), planLifeS: 900 };
}

/** What the parent's agent signs before it locks a sub-job. `price` is wei as text; `dueAt` unix seconds. */
export interface HirePlan {
  parent: number;
  agent: string;
  price: string;
  dueAt: number;
  early: boolean;
  title: string;
  brief: string;
  at: number;
}

/**
 * The words the parent's agent signs: readable, so a wallet shows exactly what it is putting its name to. The same to
 * the letter in the kit (packages/kit/src/subjobs.ts) and on the site (web/src/lib/subjobs.ts).
 */
export function hireMessage(p: HirePlan): string {
  return [
    "Factor: hire an agent for part of a job",
    `parent job: ${p.parent}`,
    `agent: ${p.agent}`,
    `price: ${formatEther(BigInt(p.price))} ETH`,
    `due: ${p.dueAt}`,
    `early: ${p.early ? "up to half may be drawn before delivery" : "nothing before delivery"}`,
    `title: ${p.title}`,
    `brief: ${p.brief ? keccak256(toHex(p.brief)) : "none"}`,
    `at: ${p.at}`,
  ].join("\n");
}

/** A plan's own number: the fingerprint of what was signed. */
export const planIdOf = (p: HirePlan): Hex => keccak256(toHex(hireMessage(p)));

// ---------- the books ----------

export interface PlanRow { id: string; parent_id: number; hirer: string; agent: string; price: string; due_at: number; allow_early: number; title: string; brief: string; signed_at: number; signature: string; expires_at: number; job_id: number | null }
export interface LinkRow { job_id: number; parent_id: number; root_id: number; depth: number; hirer: string; agent: string; price: string; plan_id: string; via: string; burn_wei: string; burn_tx: string | null; lock_tx: string; linked_at: number }

const SCHEMA = `
-- Agents that hire agents (./subjobs.ts). A plan: what a job's agent signed before locking a sub-job. It holds its
-- room under the parent until it lapses (expires_at) or a lock on the chain is linked to it (job_id).
CREATE TABLE IF NOT EXISTS subjob_plans (
  id TEXT PRIMARY KEY,               -- the fingerprint of the signed words
  parent_id INTEGER NOT NULL,
  hirer TEXT NOT NULL,               -- the parent's agent: the sub-job's customer
  agent TEXT NOT NULL,
  price TEXT NOT NULL,               -- wei
  due_at INTEGER NOT NULL,
  allow_early INTEGER NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  expires_at INTEGER NOT NULL,       -- chain seconds
  job_id INTEGER UNIQUE
);
CREATE INDEX IF NOT EXISTS subjob_plans_parent ON subjob_plans (parent_id, expires_at);
-- A sub-job: a job on the desk, linked to the job it is part of. Never taken back by a reindex: job numbers are the
-- desk's own and do not change.
CREATE TABLE IF NOT EXISTS subjobs (
  job_id INTEGER PRIMARY KEY,
  parent_id INTEGER NOT NULL,
  root_id INTEGER NOT NULL,          -- the customer's job at the top
  depth INTEGER NOT NULL,            -- 1 under the customer's job, 2 under that
  hirer TEXT NOT NULL,
  agent TEXT NOT NULL,
  price TEXT NOT NULL,
  plan_id TEXT NOT NULL UNIQUE,
  via TEXT NOT NULL,                 -- kit | checkout | x402
  burn_wei TEXT NOT NULL DEFAULT '0',-- what the hirer added to the burn beside it (a deal's own burn is in pay_deals)
  burn_tx TEXT UNIQUE,
  lock_tx TEXT NOT NULL,
  linked_at INTEGER NOT NULL         -- ms
);
CREATE INDEX IF NOT EXISTS subjobs_parent ON subjobs (parent_id);
CREATE INDEX IF NOT EXISTS subjobs_root ON subjobs (root_id);
CREATE INDEX IF NOT EXISTS subjobs_hirer ON subjobs (hirer);
CREATE INDEX IF NOT EXISTS subjobs_agent ON subjobs (agent);
`;

export class SubjobStore {
  constructor(private db: EngineDb) {
    db.db.exec(SCHEMA);
  }

  plan(id: string): PlanRow | null {
    return (this.db.q("SELECT * FROM subjob_plans WHERE id = ?").get(id) as PlanRow | undefined) ?? null;
  }

  /** Plans under a job that still hold room at `t`: not lapsed and not linked yet. One plan can be left out. */
  livePlans(parent: number, t: number, except = ""): PlanRow[] {
    return this.db.q("SELECT * FROM subjob_plans WHERE parent_id = ? AND job_id IS NULL AND expires_at > ? AND id != ?").all(parent, t, except) as PlanRow[];
  }

  link(job: number): LinkRow | null {
    return (this.db.q("SELECT * FROM subjobs WHERE job_id = ?").get(job) as LinkRow | undefined) ?? null;
  }

  children(parent: number): LinkRow[] {
    return this.db.q("SELECT * FROM subjobs WHERE parent_id = ? ORDER BY job_id").all(parent) as LinkRow[];
  }

  family(root: number): LinkRow[] {
    return this.db.q("SELECT * FROM subjobs WHERE root_id = ? ORDER BY depth, job_id").all(root) as LinkRow[];
  }

  byBurnTx(tx: string): LinkRow | null {
    return (this.db.q("SELECT * FROM subjobs WHERE burn_tx = ?").get(tx) as LinkRow | undefined) ?? null;
  }

  /** Whom an agent hired and who hired it: one line per other agent, with how many jobs. */
  relations(agent: string): { hiredBy: { address: string; jobs: number }[]; hires: { address: string; jobs: number }[] } {
    const hiredBy = this.db.q("SELECT hirer AS address, COUNT(*) AS jobs FROM subjobs WHERE agent = ? GROUP BY hirer ORDER BY jobs DESC, MIN(job_id)").all(agent) as { address: string; jobs: number }[];
    const hires = this.db.q("SELECT agent AS address, COUNT(*) AS jobs FROM subjobs WHERE hirer = ? GROUP BY agent ORDER BY jobs DESC, MIN(job_id)").all(agent) as { address: string; jobs: number }[];
    return { hiredBy, hires };
  }

  count(): number {
    return (this.db.q("SELECT COUNT(*) AS n FROM subjobs").get() as { n: number }).n;
  }
}

// ---------- the rules ----------

export interface SubjobDeps {
  cfg: SubjobsConfig;
  db: EngineDb;
  chain: Parameters<typeof readLock>[0];
  desk: string;
  /** whether `address` signed `message`: a wallet, or an account through one of its keys (../profiles.ts) */
  signed: (address: string, message: string, signature: unknown) => Promise<boolean>;
  /** the chain's time now, in seconds */
  nowS: () => number;
  /** new jobs are paused by the owner: the note to say, or null */
  paused: () => string | null;
  /** what a deal adds to the burn, wei, for a price (../pay.ts); 0n when Pay with Factor adds nothing */
  burnFor: (priceWei: bigint) => bigint;
  /** what a transaction sent to the burn pot from a customer (../pay.ts burnIn) */
  burnIn: (customer: string, hash: string) => Promise<bigint | string>;
  /** whether a transfer to the burn pot was already counted for a deal */
  dealBurnUsed: (hash: string) => boolean;
  /** Factor's own agents, by address: one hand runs them all */
  house: () => Set<string>;
  /** agents made on the site, by address: who made each */
  hosted: () => Map<string, string>;
  /** Factor's own firm lets its agents hire each other for a job a customer from outside hired it for (./firms.ts) */
  teamAllows?: (parent: number, hirer: string, agent: string) => boolean;
}

type Answer = { status: number; body: Record<string, unknown> };
const no = (status: number, error: string): Answer => ({ status, body: { error } });

interface JobFacts { id: number; customer: string; agent: string; price: string; due_at: number; state: number; back: string; locked_tx: string }

const HOUR = 3600;
const MAX_DUE_S = 30 * 86_400;

export class Subjobs {
  readonly store: SubjobStore;

  constructor(private d: SubjobDeps) {
    this.store = new SubjobStore(d.db);
  }

  get cfg(): SubjobsConfig {
    return this.d.cfg;
  }

  private job(id: number): JobFacts | null {
    return (this.d.db.q("SELECT id, customer, agent, price, due_at, state, back, locked_tx FROM desk_jobs WHERE id = ?").get(id) as JobFacts | undefined) ?? null;
  }

  /** How deep a job sits: 0 for a customer's job, 1 for a sub-job of it, and so on. */
  depthOf(id: number): number {
    return this.store.link(id)?.depth ?? 0;
  }

  /** The job at the top of the chain a job is part of. */
  rootOf(id: number): number {
    return this.store.link(id)?.root_id ?? id;
  }

  /**
   * What a sub-job holds of its parent's price: the whole price while it is open or once it settled in full, what
   * the hirer did not get back once it settled at half or was refunded, and nothing once it was declined.
   */
  private held(l: LinkRow): bigint {
    const j = this.job(l.job_id);
    const price = BigInt(l.price);
    if (!j) return price;
    if (j.state === STATE.declined) return 0n;
    if (j.state === STATE.half || j.state === STATE.refunded) {
      const back = BigInt(j.back || "0");
      return back >= price ? 0n : price - back;
    }
    return price;
  }

  /** What is still free under a job: its price, less every sub-job and every plan that holds room. */
  room(parent: number, t = this.d.nowS(), except = ""): { priceWei: bigint; committedWei: bigint; reservedWei: bigint; freeWei: bigint; used: number } {
    const p = this.job(parent);
    const price = p ? BigInt(p.price) : 0n;
    const children = this.store.children(parent);
    const plans = this.store.livePlans(parent, t, except);
    const committed = children.reduce((n, l) => n + this.held(l), 0n);
    const reserved = plans.reduce((n, r) => n + BigInt(r.price), 0n);
    const taken = committed + reserved;
    return { priceWei: price, committedWei: committed, reservedWei: reserved, freeWei: price > taken ? price - taken : 0n, used: children.length + plans.length };
  }

  /** Everybody already in the chain above a job: the customer at the top and every agent and customer on the way. */
  private chainAbove(parent: number): Set<string> {
    const out = new Set<string>();
    let id: number | null = parent;
    for (let i = 0; id !== null && i < 8; i++) {
      const j = this.job(id);
      if (j) { out.add(j.customer); out.add(j.agent); }
      id = this.store.link(id)?.parent_id ?? null;
    }
    return out;
  }

  /**
   * Who stands behind an address, as far as Factor can see it: the address itself, every wallet key of it when it
   * is a Factor account (and the passkeys, by their public key), whoever made it and is paid by it when it is an
   * agent made on the site, and Factor itself for Factor's own agents.
   */
  controllers(address: string): Set<string> {
    const out = new Set<string>([address]);
    const keys = this.d.db.q("SELECT kind, a, b FROM account_keys WHERE account = ?").all(address) as { kind: number; a: string; b: string }[];
    for (const k of keys) {
      if (k.kind === 1) {
        const w = normalizeAddress(`0x${k.a.slice(-40)}`);
        if (w) out.add(w);
      } else out.add(`passkey:${k.a.toLowerCase()}:${k.b.toLowerCase()}`);
    }
    // an account whose key is this address: the same hand, seen from the wallet's side
    for (const r of this.d.db.q("SELECT account FROM account_keys WHERE kind = 1 AND lower(a) = ?").all(`0x${"0".repeat(24)}${address.slice(2)}`) as { account: string }[]) out.add(r.account);
    const owner = this.d.hosted().get(address);
    if (owner) out.add(owner);
    const made = this.d.db.q("SELECT owner, payout FROM hosted_agents WHERE owner = ? OR payout = ?").all(address, address) as { owner: string; payout: string }[];
    for (const m of made) { out.add(m.owner); out.add(m.payout); }
    if (this.d.house().has(address)) out.add("factor:house");
    return out;
  }

  sameHand(a: string, b: string): boolean {
    const x = this.controllers(a), y = this.controllers(b);
    for (const v of x) if (y.has(v)) return true;
    return false;
  }

  /**
   * Why a plan breaks a rule, or null. `except`: the plan itself, when it is being linked, so that its own room is
   * not counted twice. `linking`: the lock is already on the chain, so the parent may have moved on since the plan
   * was signed; what is checked then is what the plan promised (the room, the count, who is hired), not the clock.
   */
  problem(p: { parent: number; hirer: string; agent: string; price: bigint; dueAt: number }, o: { except?: string; linking?: boolean; t?: number } = {}): string | null {
    const c = this.d.cfg;
    const t = o.t ?? this.d.nowS();
    const parent = this.job(p.parent);
    if (!parent) return "the desk has no such job yet (a new job shows up a few seconds after it is locked)";
    if (parent.agent !== p.hirer) return "only the agent of a job can hire for it";
    if (!o.linking && parent.state !== STATE.locked && parent.state !== STATE.advanced) return "that job is no longer open: an agent hires only while it is still working on the job";
    const depth = this.depthOf(p.parent) + 1;
    if (depth > c.maxDepth) return `a job ${c.maxDepth} levels under a customer's job cannot hire again`;
    const agent = this.d.db.q("SELECT record FROM desk_agents WHERE address = ?").get(p.agent) as { record: string } | undefined;
    if (!agent) return "that agent has not registered on the desk";
    if (p.agent === p.hirer) return "an agent cannot hire itself";
    if (this.chainAbove(p.parent).has(p.agent)) return "that agent is already in this chain of work, above this job";
    if (this.sameHand(p.hirer, p.agent) && !this.d.teamAllows?.(p.parent, p.hirer, p.agent)) return "that agent is run by the same hand as the one hiring it, so the job would only make records";
    if (p.price < MIN_JOB_WEI) return "the smallest job is 0.001 ETH";
    const room = this.room(p.parent, t, o.except ?? "");
    if (room.used >= c.perParent) return `a job has ${c.perParent} sub-jobs at most`;
    if (p.price > room.freeWei) return room.freeWei === 0n ? "nothing is left of this job's price to hire with" : `only ${formatEther(room.freeWei)} ETH is left of this job's price to hire with`;
    if (p.dueAt >= parent.due_at) return "a sub-job must be due before the job it is part of";
    if (!o.linking) {
      if (p.dueAt < t + HOUR + 60) return "a sub-job is due at least an hour from now (the desk's own rule)";
      if (p.dueAt > t + MAX_DUE_S - 60) return "a sub-job is due within 30 days (the desk's own rule)";
    }
    return null;
  }

  /** The parent's agent signs what it is about to lock; the engine checks the rules and holds the room. */
  async plan(body: Record<string, unknown>): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "agents hiring agents is switched off for now");
    const paused = this.d.paused();
    if (paused) return no(409, paused);
    const parent = typeof body.parent === "number" && Number.isSafeInteger(body.parent) && body.parent > 0 ? body.parent : null;
    const agent = normalizeAddress(body.agent);
    const price = typeof body.price === "string" && /^\d{1,30}$/.test(body.price) ? body.price : null;
    const dueAt = typeof body.dueAt === "number" && Number.isSafeInteger(body.dueAt) ? body.dueAt : null;
    if (parent === null || !agent || price === null || dueAt === null || typeof body.early !== "boolean") return no(400, "send { parent, agent, price (wei), dueAt, early, title, brief, at, signature }");
    const title = oneLine(body.title, 3, 80);
    if (!title || title !== body.title) return no(400, "a title is one plain line of 3 to 80 characters, without links, line breaks or double spaces");
    const brief = body.brief === "" || body.brief === undefined ? "" : briefText(body.brief);
    if (brief === null || (brief !== "" && brief !== body.brief)) return no(400, "a brief is plain text of up to 12,000 characters");
    const at = typeof body.at === "number" && Number.isSafeInteger(body.at) ? body.at : null;
    const t = this.d.nowS();
    if (at === null || Math.abs(at - t) > 600) return no(400, "the signature's time is more than ten minutes from now: sign again");
    const job = this.job(parent);
    if (!job) return no(404, "the desk has no such job yet (a new job shows up a few seconds after it is locked)");
    const p: HirePlan = { parent, agent, price, dueAt, early: body.early, title, brief, at };
    let ok = false;
    try {
      ok = await this.d.signed(job.agent, hireMessage(p), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, "the signature is not the agent's of that job: only the agent of a job can hire for it");
    const id = planIdOf(p);
    // checked and written in one step: two plans signed at the same moment cannot both take the last of the room
    const r = this.d.db.tx((): Answer => {
      const had = this.store.plan(id);
      if (had) return { status: 200, body: { ok: true, plan: id, expiresAt: had.expires_at, linked: had.job_id } };
      const why = this.problem({ parent, hirer: job.agent, agent, price: BigInt(price), dueAt }, { t });
      if (why) return no(409, why);
      this.d.db.q("INSERT INTO subjob_plans (id, parent_id, hirer, agent, price, due_at, allow_early, title, brief, signed_at, signature, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, parent, job.agent, agent, price, dueAt, p.early ? 1 : 0, title, brief, at, String(body.signature), t + this.d.cfg.planLifeS);
      return { status: 200, body: { ok: true, plan: id, expiresAt: t + this.d.cfg.planLifeS } };
    });
    if (r.status !== 200) return r;
    const burn = this.d.burnFor(BigInt(price));
    return { status: 200, body: { ...r.body, parent, agent, priceWei: price, burnWei: burn.toString(), depth: this.depthOf(parent) + 1 } };
  }

  /**
   * A lock on the chain, linked to the plan it carries out. The lock must be the plan to the letter: from the
   * parent's agent, for the agent, at the price, the due time and the early switch it signed, made before the plan
   * lapsed. Asked again for the same job, it answers the same.
   */
  async link(body: Record<string, unknown>, via: "kit" | "checkout" | "x402" = "kit"): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "agents hiring agents is switched off for now");
    const planId = typeof body.plan === "string" && /^0x[0-9a-f]{64}$/.test(body.plan) ? body.plan : null;
    const job = typeof body.job === "number" && Number.isSafeInteger(body.job) && body.job > 0 ? body.job : null;
    const lockTx = typeof body.lockTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.lockTx) ? body.lockTx.toLowerCase() : null;
    const burnTx = body.burnTx === undefined || body.burnTx === null || body.burnTx === "" ? null : typeof body.burnTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.burnTx) ? body.burnTx.toLowerCase() : "bad";
    if (!planId || job === null || !lockTx) return no(400, "send { plan, job, lockTx }: the plan's number, the job's number and the transaction that locked it");
    if (burnTx === "bad") return no(400, "burnTx is a transaction's hash");
    const locked = await readLock(this.d.chain, this.d.desk, job, lockTx);
    if (typeof locked === "string") return no(locked.startsWith("not yet") ? 404 : 400, locked);
    const r = this.attach(planId, job, locked, lockTx, via);
    if (r.status !== 200 || !burnTx) return r;
    const burn = await this.addBurn(job, locked.customer, burnTx);
    return { status: 200, body: { ...r.body, ...burn } };
  }

  /**
   * A hire by one of Factor's own agents, made by the engine itself (./house/firm.ts): the same rules as a signed one,
   * and the words its key signed kept beside it. Nothing is locked here.
   */
  ownPlan(p: HirePlan, hirer: string, signature: string): Answer {
    if (!this.d.cfg.enabled) return no(503, "agents hiring agents is switched off for now");
    const paused = this.d.paused();
    if (paused) return no(409, paused);
    const t = this.d.nowS();
    const id = planIdOf(p);
    return this.d.db.tx((): Answer => {
      if (this.store.plan(id)) return { status: 200, body: { ok: true, plan: id } };
      const why = this.problem({ parent: p.parent, hirer, agent: p.agent, price: BigInt(p.price), dueAt: p.dueAt }, { t });
      if (why) return no(409, why);
      this.d.db.q("INSERT INTO subjob_plans (id, parent_id, hirer, agent, price, due_at, allow_early, title, brief, signed_at, signature, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, p.parent, hirer, p.agent, p.price, p.dueAt, p.early ? 1 : 0, p.title, p.brief, p.at, signature, t + this.d.cfg.planLifeS);
      return { status: 200, body: { ok: true, plan: id } };
    });
  }

  /** What one of Factor's own agents sent to the burn beside a sub-job, in the very order that locked it. */
  ownBurn(job: number, wei: bigint, tx: string): void {
    this.d.db.q("UPDATE subjobs SET burn_wei = ?, burn_tx = ? WHERE job_id = ? AND burn_wei = '0'").run(wei.toString(), tx, job);
  }

  /** The link itself, once the lock was read from the chain. Pay with Factor calls this for a deal that carries a plan. */
  attach(planId: string, job: number, locked: LockFacts, lockTx: string, via: string): Answer {
    if (!this.d.cfg.enabled) return no(503, "agents hiring agents is switched off for now");
    return this.d.db.tx((): Answer => {
      const had = this.store.link(job);
      if (had) return had.plan_id === planId ? { status: 200, body: this.linked(had) } : no(409, "that job is already linked to another plan");
      const plan = this.store.plan(planId);
      if (!plan) return no(404, "no such plan: sign the hire first (POST /v1/subjobs/plan)");
      if (plan.job_id !== null) return no(409, "that plan was carried out by another job already");
      if (locked.customer !== plan.hirer) return no(400, "that job was not locked by the agent who signed the plan");
      if (locked.agent !== plan.agent) return no(400, "that job was locked for another agent than the plan's");
      if (locked.price !== BigInt(plan.price)) return no(400, "that job's price is not the plan's");
      if (locked.dueAt !== plan.due_at) return no(400, "that job is due at another time than the plan's");
      if (locked.allowEarly !== !!plan.allow_early) return no(400, "that job does not allow an early advance the way the plan says");
      if (locked.at > plan.expires_at) return no(410, "the plan had lapsed when the job was locked. The job stands on the desk as an ordinary job of yours");
      // what the plan promised still holds (its own room is not counted twice); the clock rules were checked at signing
      const why = this.problem({ parent: plan.parent_id, hirer: plan.hirer, agent: plan.agent, price: BigInt(plan.price), dueAt: plan.due_at }, { except: planId, linking: true, t: locked.at });
      if (why) return no(409, `${why}. The job stands on the desk as an ordinary job of yours`);
      const depth = this.depthOf(plan.parent_id) + 1;
      this.d.db.q("INSERT INTO subjobs (job_id, parent_id, root_id, depth, hirer, agent, price, plan_id, via, lock_tx, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(job, plan.parent_id, this.rootOf(plan.parent_id), depth, plan.hirer, plan.agent, plan.price, planId, via, lockTx, this.d.db.now());
      this.d.db.q("UPDATE subjob_plans SET job_id = ? WHERE id = ?").run(job, planId);
      // what the sub-job is about, as its customer (the hirer) signed it in the plan; a pay link's own words stay first
      this.d.db.q("INSERT INTO job_titles (job_id, title, by, signed_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING").run(job, plan.title, plan.hirer, plan.signed_at);
      if (plan.brief) this.d.db.q("INSERT INTO job_briefs (job_id, brief, by, signed_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING").run(job, plan.brief, plan.hirer, plan.signed_at);
      return { status: 200, body: this.linked(this.store.link(job)!) };
    });
  }

  private linked(l: LinkRow): Record<string, unknown> {
    return { ok: true, job: l.job_id, parent: l.parent_id, root: l.root_id, depth: l.depth, hirer: l.hirer, agent: l.agent, priceWei: l.price, via: l.via, burnWei: l.burn_wei };
  }

  /** What the hirer added to the burn beside a sub-job it locked directly (a deal's burn is counted by Pay with Factor). */
  private async addBurn(job: number, customer: string, burnTx: string): Promise<Record<string, unknown>> {
    const l = this.store.link(job);
    if (!l) return {};
    const need = this.d.burnFor(BigInt(l.price));
    if (BigInt(l.burn_wei) > 0n) return { burned: BigInt(l.burn_wei) >= need, burnWei: l.burn_wei, burnNeededWei: need.toString() };
    const used = this.store.byBurnTx(burnTx);
    if ((used && used.job_id !== job) || this.d.dealBurnUsed(burnTx)) return { burned: false, burnNote: "that transfer to the burn pot was already counted for another deal", burnNeededWei: need.toString() };
    const sent = await this.d.burnIn(customer, burnTx);
    if (typeof sent === "string") return { burned: false, burnNote: sent, burnNeededWei: need.toString() };
    if (sent < need) return { burned: false, burnNote: `the transfer to the burn pot was ${formatEther(sent)} ETH, under the deal's ${formatEther(need)} ETH`, burnNeededWei: need.toString() };
    this.d.db.q("UPDATE subjobs SET burn_wei = ?, burn_tx = ? WHERE job_id = ?").run(sent.toString(), burnTx, job);
    return { burned: true, burnWei: sent.toString(), burnNeededWei: need.toString() };
  }

  /** The words and the signature that put a sub-job under its parent, for anyone to check again. */
  proof(planId: string): { message: string; signature: string; by: string } | null {
    const r = this.store.plan(planId);
    if (!r) return null;
    const p: HirePlan = { parent: r.parent_id, agent: r.agent, price: r.price, dueAt: r.due_at, early: !!r.allow_early, title: r.title, brief: r.brief, at: r.signed_at };
    return { message: hireMessage(p), signature: r.signature, by: r.hirer };
  }

  /**
   * Whether a link stands on the chain as the engine reads it: the sub-job's customer on the desk is its parent's
   * agent. null while either job has not been read from the desk yet.
   */
  verified(l: LinkRow): boolean | null {
    const child = this.job(l.job_id), parent = this.job(l.parent_id);
    if (!child || !parent) return null;
    return child.customer === parent.agent && child.customer === l.hirer && child.agent === l.agent && child.price === l.price;
  }
}

// ---------- the chain of work, for the page ----------

export interface TreeNodeJson {
  job: number;
  id: string;
  parent: number | null;
  depth: number;
  customer: string;
  agent: string;
  state: string;
  priceEth: number;
  title: string;
  lockTx: string;
  /** what the buyer added to the burn beside this job, ETH */
  burnEth: number;
  via: string | null;
  /** the customer's side of a sub-job may still reject its delivery: the hirer's choice when its own job was rejected */
  canReject?: boolean;
  /** true: the desk says the sub-job's customer is its parent's agent. null: not read from the desk yet */
  verified: boolean | null;
  hire?: { message: string; signature: string; by: string };
  /** in a chain hired through a firm: whether this job's agent is the firm's lead or one of its members */
  inFirm?: boolean;
}
export interface TreeJson {
  root: number;
  nodes: TreeNodeJson[];
  /** the firm the customer's job at the top was hired through */
  firm?: { slug: string; name: string; house: boolean };
  /** every deal in the chain together: how many added to the burn, and how much */
  burn: { deals: number; eth: number };
}

const pad = (id: number): string => String(id).padStart(4, "0");
const ethNum = (wei: string | bigint): number => Number(BigInt(wei) / 10n ** 12n) / 1e6;
const STATE_WORD = ["none", "locked", "advanced", "delivered", "settled", "half", "declined", "refunded"] as const;

/**
 * The whole chain a job is part of, from the customer's job down, or null when the job hired nobody and nobody
 * hired for it. Every figure comes from the desk (the engine's copy of each job); the links are the engine's.
 */
export function treeOf(s: Subjobs, db: EngineDb, jobId: number, o: { nowS: number; reviewS: number; titles: Map<number, string>; deals: Map<number, { burn_wei: string; via: string }> }): TreeJson | null {
  const root = s.rootOf(jobId);
  const family = s.store.family(root);
  if (!family.length) return null;
  const ids = [root, ...family.map((l) => l.job_id)];
  const rows = new Map((db.db.prepare(`SELECT id, customer, agent, price, state, locked_tx, delivered_at FROM desk_jobs WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { id: number; customer: string; agent: string; price: string; state: number; locked_tx: string; delivered_at: number }[]).map((r) => [r.id, r]));
  const links = new Map(family.map((l) => [l.job_id, l]));
  let deals = 0, burned = 0n;
  const nodes: TreeNodeJson[] = ids.map((id) => {
    const r = rows.get(id);
    const l = links.get(id);
    const deal = o.deals.get(id);
    const burnWei = BigInt(deal?.burn_wei ?? "0") + BigInt(l?.burn_wei ?? "0");
    if (burnWei > 0n) { deals++; burned += burnWei; }
    const parentState = l ? rows.get(l.parent_id)?.state : undefined;
    const canReject = !!l && parentState === STATE.half && r?.state === STATE.delivered && !!r.delivered_at && o.nowS < r.delivered_at + o.reviewS;
    const proof = l ? s.proof(l.plan_id) : null;
    return {
      job: id, id: pad(id), parent: l?.parent_id ?? null, depth: l?.depth ?? 0,
      customer: r?.customer ?? l?.hirer ?? "", agent: r?.agent ?? l?.agent ?? "", state: r ? STATE_WORD[r.state] ?? "locked" : "locked",
      priceEth: ethNum(r?.price ?? l?.price ?? "0"), title: o.titles.get(id) ?? "", lockTx: r?.locked_tx || l?.lock_tx || "",
      burnEth: ethNum(burnWei), via: l?.via ?? deal?.via ?? null,
      ...(canReject ? { canReject: true } : {}),
      verified: l ? s.verified(l) : r ? true : null,
      ...(proof ? { hire: proof } : {}),
    };
  });
  return { root, nodes, burn: { deals, eth: ethNum(burned) } };
}
