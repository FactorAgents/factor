// Milestones (docs/MILESTONES.md; contracts/src/FactorMilestones.sol): a customer splits a bigger job into 2 to 6
// stages and locks the whole budget up front; each stage is locked on the desk as a job for the agent the moment the
// stage before it is paid, and is paid through the desk like any job.
//
// What the engine does with them:
//
//   reads     the milestone contract's Posted, Opened, StagePaid, Ended, Owed and Collected, each into chain_events and
//             the tables here, and the contract's totals at the head. Each stage is a desk job, read by the desk's own
//             watcher like any other: its advances, delivery and pay are on the desk's pages as they always are
//   keeps     the words of each plan (its title, and each stage's title and brief), off the chain. They are stored only
//             when they hash to what the plan holds, so nothing has to be signed. Each stage's title and brief become
//             its desk job's the moment the stage is on the desk: what the agent works from, Factor's own agents too
//   keeper    every timed step: step(id) once the stage on the desk was settled or came back, once the customer's 24
//             hours after a delivery are over, or once a stage is past its due time and the desk's grace. Anyone may
//             send it
//
//   GET  /v1/milestones                       the rules, the totals, the plans (show=open|all, customer=, agent=)
//   GET  /v1/milestones/about                 whether milestones are on, the contract, the rules and the totals
//   GET  /v1/milestones/<n>                   one plan, with every stage and where it stands
//   GET  /v1/milestones/job/<n>               the plan a desk job is a stage of
//   GET  /v1/milestones/agent/<id>            an agent's plans and stages paid (address or name)
//   GET  /v1/milestones/customer/<address>    a customer's plans
//   POST /v1/milestones/terms  { id, terms }  a plan's words; must hash to what the plan holds
//
// Switches: MILESTONES=on (off unless it is said), with FACTOR_MILESTONES and FACTOR_MILESTONES_BLOCK; and the owner's
// "milestones" switch (./switches.ts), which hides plans and stops the keeper at once. Nothing anybody does on the chain
// depends on either: every call of the contract is open to everybody.

import { formatEther, keccak256, toHex, type Abi, type Hex } from "viem";
import { factorMilestonesAbi } from "./abi/index.js";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import { readLogs, type CallSpec, type Chain, type ChainLog, type Head } from "./chain/chain.js";
import type { Ctx } from "./chain/context.js";
import type { EngineDb, EventRow } from "./chain/db.js";
import { decode } from "./chain/watch.js";
import { STATE } from "./desk.js";
import { BRIEF_MOST, EARLIER_STAGES, briefText, oneLine } from "./profiles.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export interface MilestonesConfig {
  /** MILESTONES=on: off unless it is said */
  enabled: boolean;
  /** FACTOR_MILESTONES: the milestone contract, once deployed (contracts/deploy-milestones.sh writes it) */
  milestones: string | null;
  /** FACTOR_MILESTONES_BLOCK: the block to read plans from */
  fromBlock: bigint | null;
  /** MILESTONES_PER_PASS: how many plans the keeper moves on in one pass */
  perPass: number;
  /** why it is on and cannot run, when it cannot */
  note: string | null;
}

export function readMilestones(env: Env, problems: string[] = []): MilestonesConfig {
  const on = (env.MILESTONES ?? "").trim().toLowerCase() === "on";
  const raw = env.FACTOR_MILESTONES?.trim();
  const milestones = raw ? normalizeAddress(raw) : null;
  if (raw && !milestones) problems.push(`FACTOR_MILESTONES is not an address: "${raw}"`);
  const rawBlock = env.FACTOR_MILESTONES_BLOCK?.trim();
  let fromBlock: bigint | null = null;
  if (rawBlock) {
    if (/^\d+$/.test(rawBlock)) fromBlock = BigInt(rawBlock);
    else problems.push(`FACTOR_MILESTONES_BLOCK must be a block number: it is "${rawBlock}"`);
  }
  const rawPer = env.MILESTONES_PER_PASS?.trim();
  let perPass = 5;
  if (rawPer) {
    if (/^\d+$/.test(rawPer) && Number(rawPer) >= 1 && Number(rawPer) <= 100) perPass = Number(rawPer);
    else problems.push(`MILESTONES_PER_PASS must be a whole number from 1 to 100: it is "${rawPer}"`);
  }
  let note: string | null = null;
  if (on && !milestones) note = "MILESTONES is on and FACTOR_MILESTONES is not set: there is no milestone contract to read yet";
  else if (on && fromBlock === null) note = "MILESTONES is on and FACTOR_MILESTONES_BLOCK is not set: the block to read plans from";
  return { enabled: on, milestones, fromBlock, perPass, note };
}

/** The rules, as the contract and the desk have them (FactorMilestones' and FactorDesk's constants): what the site says. */
export const MILESTONE_RULES = {
  minStages: 2, maxStages: 6, minStageEth: 0.001, minTimeH: 1, maxTimeD: 30, jobFeePct: 2, advanceFeePct: 1, graceH: 12, reviewH: 24,
  minStageWei: 1_000_000_000_000_000n, minTimeS: 3600, maxTimeS: 30 * 86_400, graceS: 12 * 3600, reviewS: 24 * 3600,
  titleChars: 80, briefChars: 12_000, termsBytes: 40_000,
} as const;

/** A plan's words: its title, and each stage's title and brief. */
export interface Terms { title: string; stages: { title: string; brief: string }[] }

/** The words as they are hashed: compact JSON, keys in this order. The kit (packages/kit/src/milestones.ts) and the site (web/src/lib/milestones.ts) write the same, to the letter. */
export const termsText = (t: Terms): string => JSON.stringify({ title: t.title, stages: t.stages.map((s) => ({ title: s.title, brief: s.brief })) });
export const termsHash = (text: string): Hex => keccak256(toHex(text));

/** The words, read back from their text, or why they are not a plan's words. Every title one plain line, every brief a brief. */
export function parseTerms(text: string, count: number): Terms | string {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return "the words are not JSON"; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return "the words are a JSON object with a title and its stages";
  const o = v as Record<string, unknown>;
  const title = oneLine(o.title, 3, MILESTONE_RULES.titleChars);
  if (!title || title !== o.title) return `the plan's title is one plain line of 3 to ${MILESTONE_RULES.titleChars} characters, without links`;
  if (!Array.isArray(o.stages) || o.stages.length !== count) return `the words have ${Array.isArray(o.stages) ? o.stages.length : 0} stages and the plan ${count}`;
  const stages: Terms["stages"] = [];
  for (const [i, s] of (o.stages as unknown[]).entries()) {
    const x = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    const t = oneLine(x.title, 3, MILESTONE_RULES.titleChars);
    if (!t || t !== x.title) return `stage ${i + 1}'s title is one plain line of 3 to ${MILESTONE_RULES.titleChars} characters, without links`;
    const b = briefText(x.brief);
    if (!b || b !== x.brief || b.length > MILESTONE_RULES.briefChars) return `stage ${i + 1}'s brief is plain text of up to ${MILESTONE_RULES.briefChars} characters`;
    stages.push({ title: t, brief: b });
  }
  return { title, stages };
}

const MT = factorMilestonesAbi as Abi;
const STATES = ["none", "running", "done", "missed", "declined", "rejected"] as const;
export type PlanState = Exclude<(typeof STATES)[number], "none">;
/** Where one stage stands: not on the desk yet, on it, delivered, paid, or how it ended the plan; `returned` never started and went back. */
export type StageStatus = "waiting" | "open" | "delivered" | "paid" | "missed" | "declined" | "rejected" | "returned";

export interface PlanRow {
  id: number; block: number; at: number; tx_hash: string; customer: string; agent: string; total: string; count: number; allow_early: number; terms_hash: string;
  state: PlanState; current: number; ended_at: number | null; ended_tx: string | null; from_desk: string; unstarted: string;
}
export interface StageRow { plan: number; n: number; block: number; price: string; time: number; job: number | null; opened_at: number | null; due_at: number | null; opened_tx: string | null; paid_at: number | null; paid_tx: string | null }
interface TermsRow { plan: number; body: string; at: number; hidden: number }

const SCHEMA = `
-- Milestones (./milestones.ts). A plan's words: never on the chain, and kept by a reindex.
CREATE TABLE IF NOT EXISTS milestone_terms (
  plan INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  at INTEGER NOT NULL,               -- ms
  hidden INTEGER NOT NULL DEFAULT 0
);
`;

export interface MilestonesDeps {
  cfg: MilestonesConfig;
  db: EngineDb;
  chain: Chain;
  chainId: number;
  /** the chain's clock, seconds */
  nowS: () => number;
  /** the wall clock, ms */
  now: () => number;
  log: (line: string) => void;
  /** agents' names */
  names: () => Map<string, { name: string; hidden?: number }>;
  /** an agent's score on the desk, as the engine last read it */
  scoreOf: (address: string) => number;
  /** whether the desk bars an agent from pool advances */
  barred: (address: string) => boolean;
  /** gives a stage's desk job its title and brief, as its customer's own: the words were checked against the chain */
  brief: (job: number, by: string, title: string, brief: string) => void;
}

/** The totals, read from the contract. */
export interface MilestoneTotals { held: string; atDesk: string; owed: string; budgets: string; paid: string; returned: string; count: number; at: number }

interface DeskJob { state: number; due_at: number; delivered_at: number; locked_at: number }

export class Milestones {
  private totalsReadAt = 0;

  constructor(readonly d: MilestonesDeps) {
    d.db.db.exec(SCHEMA);
  }

  /** Reading the chain: switched on and a contract to read. */
  reading(): boolean {
    return this.d.cfg.enabled && !!this.d.cfg.milestones && this.d.cfg.fromBlock !== null;
  }

  /** Shown and kept: reading, and the owner has not stopped it. */
  on(): boolean {
    return this.reading() && !stopped(this.d.db, "milestones");
  }

  // ---------- the books ----------

  row(id: number): PlanRow | null {
    return (this.d.db.q("SELECT * FROM milestone_plans WHERE id = ?").get(id) as PlanRow | undefined) ?? null;
  }

  stages(id: number): StageRow[] {
    return this.d.db.q("SELECT * FROM milestone_stages WHERE plan = ? ORDER BY n").all(id) as StageRow[];
  }

  /** The plan and stage a desk job is, or null. */
  ofJob(job: number): { plan: PlanRow; stage: StageRow } | null {
    const s = (this.d.db.q("SELECT * FROM milestone_stages WHERE job = ?").get(job) as StageRow | undefined) ?? null;
    const p = s ? this.row(s.plan) : null;
    return s && p ? { plan: p, stage: s } : null;
  }

  private terms(id: number): Terms | null {
    const r = (this.d.db.q("SELECT * FROM milestone_terms WHERE plan = ?").get(id) as TermsRow | undefined) ?? null;
    const p = this.row(id);
    if (!r || r.hidden || !p) return null;
    const t = parseTerms(r.body, p.count);
    return typeof t === "string" ? null : t;
  }

  private hiddenTerms(id: number): boolean {
    return !!(this.d.db.q("SELECT hidden FROM milestone_terms WHERE plan = ?").get(id) as { hidden: number } | undefined)?.hidden;
  }

  totals(): MilestoneTotals | null {
    return this.d.db.getJson<MilestoneTotals>("milestones:totals");
  }

  /** The owner hides a plan's words, and the briefs its stages carry. The plan stays on the chain and on the site, as a number. */
  hide(key: string, hidden: boolean): boolean {
    const id = Number(key);
    const n = this.d.db.q("UPDATE milestone_terms SET hidden = ? WHERE plan = ?").run(hidden ? 1 : 0, id).changes;
    for (const s of this.stages(id)) {
      if (s.job === null) continue;
      this.d.db.q("UPDATE job_titles SET hidden = ? WHERE job_id = ?").run(hidden ? 1 : 0, s.job);
      this.d.db.q("UPDATE job_briefs SET hidden = ? WHERE job_id = ?").run(hidden ? 1 : 0, s.job);
    }
    return n > 0;
  }

  // ---------- reading the chain ----------

  /** One log of the milestone contract's, written down. Returns a line for the engine's log, when it is worth one. Exported for the tests. */
  apply(log: ChainLog, at: number): string | null {
    const e = decode({ name: "milestones" as never, abi: MT }, log, at);
    if (!e) return null;
    e.contract = "milestones";
    if (!this.d.db.addEvent(e)) return null;
    return this.effect(e);
  }

  private name(address: string): string {
    const p = this.d.names().get(address);
    return p && !p.hidden ? p.name : shortAddress(address);
  }

  private effect(e: EventRow): string | null {
    const db = this.d.db;
    const a = e.args;
    const id = a.id !== undefined ? Number(a.id) : 0;
    if (e.event === "Posted") {
      // arrays come through the decoder as JSON text (./chain/watch.ts)
      const list = (x: unknown): unknown[] => (typeof x === "string" ? (JSON.parse(x) as unknown[]) : Array.isArray(x) ? x : []);
      const prices = list(a.prices).map(String);
      const times = list(a.times).map(Number);
      db.q("INSERT OR IGNORE INTO milestone_plans (id, block, at, tx_hash, customer, agent, total, count, allow_early, terms_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id, e.block, e.at, e.tx_hash, normalizeAddress(a.customer), normalizeAddress(a.agent), String(a.total), prices.length, a.allowEarly ? 1 : 0, String(a.terms).toLowerCase(),
      );
      prices.forEach((price, n) => db.q("INSERT OR IGNORE INTO milestone_stages (plan, n, block, price, time) VALUES (?, ?, ?, ?, ?)").run(id, n, e.block, price, times[n] ?? 0));
      return `plan ${id}: ${prices.length} stages, ${ethText(String(a.total))} ETH locked for ${this.name(normalizeAddress(a.agent)!)}`;
    }
    if (e.event === "Opened") {
      const n = Number(a.stage), job = Number(a.job);
      db.q("UPDATE milestone_stages SET job = ?, opened_at = ?, due_at = ?, opened_tx = ? WHERE plan = ? AND n = ?").run(job, e.at, Number(a.dueAt), e.tx_hash, id, n);
      db.q("UPDATE milestone_plans SET current = ? WHERE id = ? AND current <= ?").run(n, id, n);
      this.briefStage(id, n, job);
      return `plan ${id}: stage ${n + 1} is on the desk as job ${job}`;
    }
    if (e.event === "StagePaid") {
      db.q("UPDATE milestone_stages SET paid_at = ?, paid_tx = ? WHERE plan = ? AND n = ?").run(e.at, e.tx_hash, id, Number(a.stage));
      return `plan ${id}: stage ${Number(a.stage) + 1} paid through the desk`;
    }
    if (e.event === "Ended") {
      const how = STATES[Number(a.how)] ?? "done";
      db.q("UPDATE milestone_plans SET state = ?, current = ?, ended_at = ?, ended_tx = ?, from_desk = ?, unstarted = ? WHERE id = ?").run(how, Number(a.stage), e.at, e.tx_hash, String(a.fromDesk), String(a.unstarted), id);
      if (how === "done") return `plan ${id}: every stage paid`;
      return `plan ${id}: ${how} at stage ${Number(a.stage) + 1}, ${ethText((BigInt(String(a.fromDesk)) + BigInt(String(a.unstarted))).toString())} ETH back to the customer`;
    }
    if (e.event === "Owed") return `${ethText(String(a.amount))} ETH waits in the milestone contract for ${shortAddress(normalizeAddress(a.who) ?? "")}, who refused it`;
    return null;
  }

  /** A stage on the desk gets its title and brief from the plan's words, once both are here. */
  private briefStage(id: number, n: number, job: number): void {
    const p = this.row(id);
    const t = this.terms(id);
    const s = t?.stages[n];
    if (!p || !t || !s) return;
    const own = `${s.brief}\n\n(Stage ${n + 1} of ${p.count} of "${t.title}", a job in stages: the stages after it start once this one is accepted.)`;
    // a later stage often says "the same as before": it gets the stages before it as context, within the brief's limit
    let room = BRIEF_MOST - own.length - EARLIER_STAGES.length - 4;
    const earlier: string[] = [];
    for (const [i, e] of t.stages.slice(0, n).entries()) {
      const line = `Stage ${i + 1}, ${e.title}: ${e.brief}`;
      if (room < 80) break;
      earlier.push(line.length <= room ? line : `${line.slice(0, room - 1)}…`);
      room -= Math.min(line.length, room) + 2;
    }
    this.d.brief(job, p.customer, s.title, earlier.length ? `${own}\n\n${EARLIER_STAGES}\n${earlier.join("\n\n")}` : own);
  }

  /** One pass of the milestone contract's logs, from where the last stopped to the safe head. Returns the lines worth logging. */
  async watch(ctx: Ctx, head: Head): Promise<string[]> {
    if (!this.reading()) return [];
    const { db, chain } = this.d;
    const safe = head.number - BigInt(ctx.params.confirmations);
    const start = (db.cursor("milestones") ?? this.d.cfg.fromBlock! - 1n) + 1n;
    if (start > safe) return [];
    const lines: string[] = [];
    const span = BigInt(ctx.params.logSpan);
    let from = start;
    for (let n = 0; n < ctx.params.spansPerPass && from <= safe; n++) {
      const to = from + span - 1n > safe ? safe : from + span - 1n;
      let logs: ChainLog[] = [];
      await readLogs(chain, from, to, { address: [this.d.cfg.milestones!] }, to - from + 1n, (got) => { logs = got; }, 1);
      logs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
      const missing = [...new Set(logs.filter((l) => l.timestamp === undefined && !ctx.blockTimes.has(l.blockNumber)).map((l) => l.blockNumber))];
      for (let i = 0; i < missing.length; i += 10) {
        const blocks = await Promise.all(missing.slice(i, i + 10).map((b) => chain.block(b)));
        blocks.forEach((b, k) => ctx.blockTimes.set(missing[i + k]!, b?.timestamp ?? 0));
      }
      db.tx(() => {
        for (const l of logs) {
          const line = this.apply(l, l.timestamp ?? ctx.blockTimes.get(l.blockNumber) ?? 0);
          if (line) lines.push(line);
        }
        db.setCursor("milestones", to);
      });
      from = to + 1n;
    }
    for (const l of lines) this.d.log(`[milestones] ${l}`);
    if (lines.length) this.totalsReadAt = 0;
    return lines;
  }

  /** The totals, once every half minute. */
  async refresh(): Promise<void> {
    if (!this.reading() || this.d.now() - this.totalsReadAt <= 30_000) return;
    this.totalsReadAt = this.d.now();
    const M = <T>(fn: string) => this.d.chain.read<T>({ to: this.d.cfg.milestones!, abi: MT, functionName: fn });
    const [held, atDesk, owed, budgets, paid, returned, count] = await Promise.all([
      M<bigint>("held"), M<bigint>("atDesk"), M<bigint>("owedTotal"), M<bigint>("totalBudgets"), M<bigint>("totalPaid"), M<bigint>("totalReturned"), M<bigint>("planCount"),
    ]);
    this.d.db.setJson("milestones:totals", { held: held.toString(), atDesk: atDesk.toString(), owed: owed.toString(), budgets: budgets.toString(), paid: paid.toString(), returned: returned.toString(), count: Number(count), at: this.d.now() } satisfies MilestoneTotals);
  }

  // ---------- the keeper ----------

  private deskJob(job: number | null): DeskJob | null {
    if (job === null) return null;
    return (this.d.db.q("SELECT state, due_at, delivered_at, locked_at FROM desk_jobs WHERE id = ?").get(job) as DeskJob | undefined) ?? null;
  }

  /** Whether anyone can step a plan now, on the chain's clock, and what the step does. Exported for the tests. */
  due(p: PlanRow, job: DeskJob | null, t: number): "opens" | "returns" | "settles" | "refunds" | null {
    if (p.state !== "running" || !job) return null;
    if (job.state === STATE.settled) return "opens";
    if (job.state === STATE.refunded || job.state === STATE.declined) return "returns";
    if (job.state === STATE.delivered && job.delivered_at > 0 && t >= job.delivered_at + MILESTONE_RULES.reviewS) return "settles";
    if ((job.state === STATE.locked || job.state === STATE.advanced) && t > job.due_at + MILESTONE_RULES.graceS) return "refunds";
    return null;
  }

  /**
   * The keeper's turn (./chain/act.ts calls it as the step "milestone", before the desk's own settling and refunding):
   * every plan whose stage on the desk has come to its time is stepped. A few a pass, the oldest first.
   */
  async step(ctx: Ctx, head: Head, attempt: (kind: "milestone", ref: string, call: CallSpec, detail: Record<string, unknown>, feeCap: bigint) => Promise<{ status: string; why: string; hash?: string }>): Promise<string> {
    if (!this.reading()) return "milestones are not switched on";
    if (stopped(this.d.db, "milestones")) return "milestones are stopped by the owner";
    const db = this.d.db;
    const t = head.timestamp;
    const said: string[] = [];
    let n = 0;
    // one try at a time per plan and stage: one on its way waits; one that failed waits ten minutes; one shown in dry mode, half an hour
    const ready = (ref: string): boolean => {
      const prev = db.lastAction("milestone", ref);
      if (!prev) return true;
      if (prev.status === "signed" || prev.status === "sent") return false;
      if (prev.status === "done") return this.d.now() - prev.updated_at > 120_000;
      if (prev.status === "failed") return this.d.now() - prev.updated_at > 600_000;
      if (prev.status === "dry") return this.d.now() - prev.created_at > 1_800_000;
      return true;
    };
    const live = db.q("SELECT * FROM milestone_plans WHERE state = 'running' ORDER BY id").all() as PlanRow[];
    for (const p of live) {
      if (n >= this.d.cfg.perPass || ctx.stopping()) break;
      const s = this.stages(p.id)[p.current];
      const what = this.due(p, this.deskJob(s?.job ?? null), t);
      if (!what) continue;
      const ref = `step:${p.id}:${p.current}`;
      if (!ready(ref)) continue;
      n++;
      const words = `step plan ${p.id} (stage ${p.current + 1}: ${what === "opens" ? "paid, the next opens" : what === "settles" ? "the customer's day is over" : what === "refunds" ? "past its due time" : "it came back"})`;
      const out = await attempt("milestone", ref, { to: this.d.cfg.milestones!, abi: MT, functionName: "step", args: [BigInt(p.id)] }, { plan: p.id, stage: p.current + 1, customer: p.customer, agent: p.agent, what }, ctx.params.maxGasWei);
      said.push(`${out.status === "dry" ? `would ${words}` : out.status === "done" ? words : `${words}: ${out.status}`}${out.status === "failed" || out.status === "skipped" ? ` (${out.why})` : ""}`);
      if (db.openActions().length > 0) break;
    }
    return said.length ? said.join("; ") : "no plan needs a step";
  }

  // ---------- what is sent in, hashed against the chain ----------

  /** A plan's words. They must hash to what the plan holds, with one stage for each on the chain; nothing else is taken, so nothing has to be signed. */
  async putTerms(body: Record<string, unknown>): Promise<Answer> {
    if (!this.on()) return no(503, "milestones are switched off for now");
    const id = idOf(body.id);
    if (id === null) return no(400, "id is a plan's number");
    const text = typeof body.terms === "string" ? body.terms : "";
    if (!text || Buffer.byteLength(text, "utf8") > MILESTONE_RULES.termsBytes) return no(400, `the words are JSON text of at most ${MILESTONE_RULES.termsBytes} bytes`);
    const known = this.row(id) ?? (await this.chainPlan(id));
    if (!known) return no(404, "there is no such plan on the chain yet: try again in a moment");
    if (known.terms_hash.toLowerCase() !== termsHash(text)) return no(409, "these words do not hash to what the plan holds");
    const t = parseTerms(text, known.count);
    if (typeof t === "string") return no(400, t);
    this.d.db.q("INSERT INTO milestone_terms (plan, body, at) VALUES (?, ?, ?) ON CONFLICT(plan) DO NOTHING").run(id, text, this.d.now());
    // stages already on the desk get their words now
    for (const s of this.stages(id)) if (s.job !== null) this.briefStage(id, s.n, s.job);
    return { status: 200, body: { ok: true, id } };
  }

  private async chainPlan(id: number): Promise<{ terms_hash: string; count: number } | null> {
    const x = await this.d.chain.read<{ state: number | bigint; terms: string; count: number | bigint }>({ to: this.d.cfg.milestones!, abi: MT, functionName: "plan", args: [BigInt(id)] });
    return Number(x.state) === 0 ? null : { terms_hash: x.terms, count: Number(x.count) };
  }

  // ---------- what the site reads ----------

  /** Where one stage stands, read from its desk job. */
  private stageStatus(p: PlanRow, s: StageRow, job: DeskJob | null): StageStatus {
    if (s.n < p.current) return "paid";
    if (s.n > p.current) return p.state === "running" ? "waiting" : "returned";
    if (s.job === null || !job) return p.state === "running" ? "open" : p.state === "done" ? "paid" : (p.state as StageStatus);
    if (job.state === STATE.settled) return "paid";
    if (job.state === STATE.delivered) return "delivered";
    if (job.state === STATE.refunded) return "missed";
    if (job.state === STATE.declined) return "declined";
    if (job.state === STATE.half) return "rejected";
    return "open";
  }

  about(): MilestonesAbout {
    const on = this.on();
    const t = this.totals();
    const R = MILESTONE_RULES;
    const count = (sql: string) => (this.d.db.q(sql).get() as { n: number }).n;
    return {
      enabled: on, contract: this.d.cfg.milestones, chainId: this.d.chainId,
      rules: { minStages: R.minStages, maxStages: R.maxStages, minStageEth: R.minStageEth, minTimeH: R.minTimeH, maxTimeD: R.maxTimeD, jobFeePct: R.jobFeePct, advanceFeePct: R.advanceFeePct, graceH: R.graceH, reviewH: R.reviewH, titleChars: R.titleChars, briefChars: R.briefChars, termsBytes: R.termsBytes },
      totals: on && t ? { plans: t.count, budgetsEth: ethNum(t.budgets), paidEth: ethNum(t.paid), returnedEth: ethNum(t.returned), heldEth: ethNum(t.held), running: count("SELECT COUNT(*) AS n FROM milestone_plans WHERE state = 'running'"), done: count("SELECT COUNT(*) AS n FROM milestone_plans WHERE state = 'done'"), stagesPaid: count("SELECT COUNT(*) AS n FROM milestone_stages WHERE paid_at IS NOT NULL") } : null,
    };
  }

  /** One plan whole: its facts and every stage, with its desk job and where it stands. */
  planJson(p: PlanRow): MilestonePlanJson {
    const t = this.d.nowS();
    const words = this.terms(p.id);
    const named = (a: string) => ({ address: a, name: this.name(a), named: this.d.names().has(a) });
    const rows = this.stages(p.id);
    let expected = 0;
    let paid = 0n;
    const stages: MilestoneStageJson[] = rows.map((s) => {
      const job = this.deskJob(s.job);
      const status = this.stageStatus(p, s, job);
      if (status === "paid") paid += BigInt(s.price);
      // a stage not on the desk yet: the date it would have if every stage before it were accepted on its due date
      const due = s.due_at ?? (status === "waiting" ? (expected || t) + s.time : null);
      if (due) expected = due;
      const w = words?.stages[s.n];
      return {
        n: s.n + 1, priceEth: ethNum(s.price), priceWei: s.price, timeS: s.time, status,
        title: w?.title ?? null,
        ...(s.job !== null ? { job: { n: s.job, id: String(s.job).padStart(4, "0") } } : {}),
        ...(s.due_at ? { dueAt: iso(s.due_at) } : due && status === "waiting" ? { expectedDueAt: iso(due) } : {}),
        ...(s.opened_at ? { openedAt: iso(s.opened_at) } : {}),
        ...(job?.delivered_at ? { deliveredAt: iso(job.delivered_at) } : {}),
        ...(s.paid_at ? { paidAt: iso(s.paid_at), paidTx: s.paid_tx } : {}),
      };
    });
    const cur = rows[p.current];
    const next = this.due(p, this.deskJob(cur?.job ?? null), t);
    return {
      id: p.id, customer: p.customer, agent: { ...named(p.agent), score: this.d.scoreOf(p.agent), barred: this.d.barred(p.agent) },
      totalEth: ethNum(p.total), totalWei: p.total, count: p.count, allowEarly: !!p.allow_early, termsHash: p.terms_hash,
      title: words?.title ?? null, hidden: this.hiddenTerms(p.id), state: p.state, current: p.current + 1, postedAt: iso(p.at), tx: p.tx_hash,
      paidEth: ethNum(paid.toString()), stages,
      ...(p.ended_tx ? { endedAt: iso(p.ended_at ?? 0), endedTx: p.ended_tx, returnedEth: ethNum((BigInt(p.from_desk) + BigInt(p.unstarted)).toString()) } : {}),
      ...(next ? { next } : {}),
    };
  }

  json(id: number): MilestonePlanJson | null {
    const p = this.row(id);
    return p ? this.planJson(p) : null;
  }

  /** How a desk job names the plan it is a stage of. */
  jobLink(job: number): MilestoneJobLink | null {
    const x = this.ofJob(job);
    if (!x) return null;
    const words = this.terms(x.plan.id);
    return { id: x.plan.id, stage: x.stage.n + 1, count: x.plan.count, title: words?.title ?? null, stageTitle: words?.stages[x.stage.n]?.title ?? null, customer: x.plan.customer, state: x.plan.state };
  }

  list(o: { show?: string; customer?: string; agent?: string; limit?: number }): MilestonePlanJson[] {
    const limit = o.limit ?? 50;
    const db = this.d.db;
    let rows: PlanRow[];
    if (o.customer) rows = db.q("SELECT * FROM milestone_plans WHERE customer = ? ORDER BY id DESC LIMIT ?").all(o.customer, limit) as PlanRow[];
    else if (o.agent) rows = db.q("SELECT * FROM milestone_plans WHERE agent = ? ORDER BY id DESC LIMIT ?").all(o.agent, limit) as PlanRow[];
    else if (o.show === "open") rows = db.q("SELECT * FROM milestone_plans WHERE state = 'running' ORDER BY id DESC LIMIT ?").all(limit) as PlanRow[];
    else rows = db.q("SELECT * FROM milestone_plans ORDER BY id DESC LIMIT ?").all(limit) as PlanRow[];
    return rows.map((p) => this.planJson(p));
  }

  /** An agent's plans and the stages it was paid for, or null when it has none. */
  agentJson(address: string): AgentMilestonesJson | null {
    if (!this.on()) return null;
    const db = this.d.db;
    const count = (state: string) => (db.q("SELECT COUNT(*) AS n FROM milestone_plans WHERE agent = ? AND state = ?").get(address, state) as { n: number }).n;
    const plans = (db.q("SELECT COUNT(*) AS n FROM milestone_plans WHERE agent = ?").get(address) as { n: number }).n;
    if (!plans) return null;
    const paid = db.q("SELECT s.price FROM milestone_stages s JOIN milestone_plans p ON p.id = s.plan WHERE p.agent = ? AND s.paid_at IS NOT NULL").all(address) as { price: string }[];
    return { plans, running: count("running"), done: count("done"), missed: count("missed"), declined: count("declined"), rejected: count("rejected"), stagesPaid: paid.length, paidEth: ethNum(paid.reduce((n, r) => n + BigInt(r.price), 0n).toString()), items: this.list({ agent: address, limit: 10 }) };
  }

  customerJson(customer: string): { customer: string; plans: number; items: MilestonePlanJson[] } {
    return { customer, plans: (this.d.db.q("SELECT COUNT(*) AS n FROM milestone_plans WHERE customer = ?").get(customer) as { n: number }).n, items: this.list({ customer, limit: 20 }) };
  }

  /** For the owner's health answer. */
  health(): Record<string, unknown> {
    const count = (state: string) => (this.d.db.q("SELECT COUNT(*) AS n FROM milestone_plans WHERE state = ?").get(state) as { n: number }).n;
    return { reading: this.reading(), on: this.on(), milestones: this.d.cfg.milestones, running: count("running"), done: count("done"), missed: count("missed"), totals: this.totals(), note: this.d.cfg.note };
  }
}

type Answer = { status: number; body: Record<string, unknown> };
const no = (status: number, error: string): Answer => ({ status, body: { error } });
const idOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null);

/** What milestones are, as the site reads it: web/src/lib/types.ts keeps the same shape by hand. */
export interface MilestonesAbout {
  enabled: boolean; contract: string | null; chainId: number;
  rules: { minStages: number; maxStages: number; minStageEth: number; minTimeH: number; maxTimeD: number; jobFeePct: number; advanceFeePct: number; graceH: number; reviewH: number; titleChars: number; briefChars: number; termsBytes: number };
  totals: { plans: number; budgetsEth: number; paidEth: number; returnedEth: number; heldEth: number; running: number; done: number; stagesPaid: number } | null;
}

export interface MilestoneStageJson {
  /** 1 to 6 */
  n: number; priceEth: number; priceWei: string; timeS: number; status: StageStatus;
  /** its title from the plan's words; null until they have arrived, or while the owner hides them */
  title: string | null;
  job?: { n: number; id: string };
  dueAt?: string;
  /** not on the desk yet: the due date it would have if every stage before it were accepted on its due date */
  expectedDueAt?: string;
  openedAt?: string; deliveredAt?: string; paidAt?: string; paidTx?: string | null;
}

export interface MilestonePlanJson {
  id: number; customer: string; agent: { address: string; name: string; named: boolean; score: number; barred: boolean };
  totalEth: number; totalWei: string; count: number; allowEarly: boolean; termsHash: string;
  title: string | null; hidden: boolean; state: PlanState;
  /** the stage on the desk now, from 1; the last one once the plan ended */
  current: number; postedAt: string; tx: string; paidEth: number; stages: MilestoneStageJson[];
  endedAt?: string; endedTx?: string; returnedEth?: number;
  /** its time has come: what anyone's step does */
  next?: "opens" | "returns" | "settles" | "refunds";
}

export interface MilestoneJobLink { id: number; stage: number; count: number; title: string | null; stageTitle: string | null; customer: string; state: PlanState }

export interface AgentMilestonesJson { plans: number; running: number; done: number; missed: number; declined: number; rejected: number; stagesPaid: number; paidEth: number; items: MilestonePlanJson[] }

const iso = (s: number): string => new Date(s * 1000).toISOString();
const ethNum = (wei: string): number => Number(formatEther(BigInt(wei)));
const ethText = (wei: string): string => {
  const n = ethNum(wei);
  return n >= 0.01 ? n.toFixed(4) : n.toFixed(6);
};
