// The desk, as the engine keeps it.
//
// Two kinds of thing are written down, and they come from two places:
//
//   what HAPPENED   the ledger's lines, each advance, what a job paid when it closed. These come from the desk's
//                   logs, each written once, keyed by its transaction and its place in it.
//   what IS         a job's state and what is drawn on it, an agent's record. These are not worked out from logs:
//                   a log only marks the row as changed (dirty), and the row is then read from the desk itself,
//                   job(id) and agent(address), at the head. So the engine's copy can never drift from the desk's.
//
// After a reorg every row is marked and read again.

import type { Abi } from "viem";
import { factorDeskAbi } from "./abi/index.js";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import type { Ctx } from "./chain/context.js";
import type { EngineDb, EventRow } from "./chain/db.js";

const DESK = factorDeskAbi as Abi;

/** The desk's own numbers for a job's state. */
export const STATE = { none: 0, locked: 1, advanced: 2, delivered: 3, settled: 4, half: 5, declined: 6, refunded: 7 } as const;
export const STATE_NAME = ["none", "locked", "advanced", "delivered", "settled", "half", "declined", "refunded"] as const;
export type StateName = (typeof STATE_NAME)[number];
export const KIND_NAME = ["customer", "pool", "compute"] as const;

/** The rulebook's numbers, as the desk holds them (docs/RULEBOOK.md, section 9). They are constants in the contract. */
export const RULES = {
  advanceMaxPct: 50,
  advanceFeePct: 1,
  jobFeePct: 2,
  graceHours: 12,
  reviewHours: 24,
  rejectedPct: 50,
  reserveMinPct: 20,
  minJobEth: 0.001,
  graceS: 12 * 3600,
  reviewS: 24 * 3600,
  customerFeesMinWei: 10n ** 15n,
} as const;

export interface JobRow {
  id: number;
  dirty: number;
  locked_block: number;
  locked_at: number;
  locked_tx: string;
  customer: string;
  agent: string;
  price: string;
  due_at: number;
  allow_early: number;
  state: number;
  early: string;
  from_pool: string;
  delivered_at: number;
  late: number;
  proof: string;
  closed_at: number;
  paid: string;
  back: string;
  fee: string;
  not_repaid: string;
}

/** An agent's record as the desk holds it: counts as numbers, amounts as wei in text. */
export interface AgentRecord {
  registered: boolean;
  barred: boolean;
  firstSettledAt: number;
  settled: number;
  settledAtHalf: number;
  notDelivered: number;
  unanswered: number;
  customers: number;
  onTime: number;
  late: number;
  advancesRepaid: number;
  advancesNotRepaid: number;
  earlyKept: number;
  bond: string;
  feesPaid: string;
  advancedNow: string;
  volume: string;
}

export interface AgentRow {
  address: string;
  dirty: number;
  registered_block: number;
  registered_at: number;
  record: AgentRecord;
}

export interface LedgerRow {
  n: number;
  tx_hash: string;
  log_index: number;
  kind: string;
  block: number;
  at: number;
  job_id: number | null;
  agent: string | null;
  amount: string;
  note: string;
}

export interface AdvanceRow {
  tx_hash: string;
  log_index: number;
  block: number;
  at: number;
  job_id: number;
  agent: string;
  kind: number;
  amount: string;
  fee: string;
}

const EMPTY: AgentRecord = {
  registered: true, barred: false, firstSettledAt: 0, settled: 0, settledAtHalf: 0, notDelivered: 0, unanswered: 0, customers: 0, onTime: 0, late: 0,
  advancesRepaid: 0, advancesNotRepaid: 0, earlyKept: 0, bond: "0", feesPaid: "0", advancedNow: "0", volume: "0",
};

const eth = (wei: unknown): string => {
  const w = BigInt(String(wei));
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

// ---------- writing down what happened ----------

function line(db: EngineDb, e: EventRow, kind: string, amount: unknown, jobId: number | null, agent: string | null, note = ""): void {
  db.q("INSERT OR IGNORE INTO ledger (tx_hash, log_index, kind, block, at, job_id, agent, amount, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(e.tx_hash, e.log_index, kind, e.block, e.at, jobId, agent, String(amount), note);
}

function touchAgent(db: EngineDb, e: EventRow, address: unknown): string | null {
  const a = normalizeAddress(address);
  if (!a) return null;
  db.q("INSERT INTO desk_agents (address, dirty, registered_block, registered_at) VALUES (?, 1, ?, ?) ON CONFLICT(address) DO UPDATE SET dirty = 1").run(a, e.block, e.at);
  return a;
}

function touchJob(db: EngineDb, id: number): void {
  db.q("UPDATE desk_jobs SET dirty = 1 WHERE id = ?").run(id);
}

/** One of the desk's logs, written down. Returns a line for the engine's own log when it is worth one. */
export function applyDesk(db: EngineDb, e: EventRow, addr: { splitter: string }): string | null {
  const a = e.args;
  const id = a.id === undefined ? null : Number(a.id);
  switch (e.event) {
    case "Registered": {
      const agent = touchAgent(db, e, a.agent);
      return `a new agent registered: ${shortAddress(agent)}`;
    }
    case "Locked": {
      const agent = touchAgent(db, e, a.agent);
      const customer = normalizeAddress(a.customer) ?? "";
      db.q(
        "INSERT INTO desk_jobs (id, dirty, locked_block, locked_at, locked_tx, customer, agent, price, due_at, allow_early) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET dirty = 1, locked_block = excluded.locked_block, locked_at = excluded.locked_at, locked_tx = excluded.locked_tx, customer = excluded.customer, agent = excluded.agent, price = excluded.price, due_at = excluded.due_at, allow_early = excluded.allow_early",
      ).run(id, e.block, e.at, e.tx_hash, customer, agent, String(a.price), Number(a.dueAt), a.allowEarly ? 1 : 0);
      line(db, e, "locked", a.price, id, agent);
      return `job ${id}: ${eth(a.price)} ETH locked for ${shortAddress(agent)}`;
    }
    case "Advanced": {
      const agent = touchAgent(db, e, a.agent);
      const kind = Number(a.kind);
      db.q("INSERT OR IGNORE INTO desk_advances (tx_hash, log_index, block, at, job_id, agent, kind, amount, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(e.tx_hash, e.log_index, e.block, e.at, id, agent, kind, String(a.amount), String(a.fee));
      touchJob(db, id!);
      line(db, e, "advanced", a.amount, id, agent, KIND_NAME[kind] ?? "pool");
      return `job ${id}: ${shortAddress(agent)} drew ${eth(a.amount)} ETH (${KIND_NAME[kind] ?? kind})`;
    }
    case "Delivered": {
      const agent = touchAgent(db, e, a.agent);
      touchJob(db, id!);
      const price = (db.q("SELECT price FROM desk_jobs WHERE id = ?").get(id) as { price: string } | undefined)?.price ?? "0";
      line(db, e, "delivered", price, id, agent, a.late ? "late" : "");
      return `job ${id}: delivered${a.late ? ", late" : ""}`;
    }
    case "Settled": {
      const agent = touchAgent(db, e, a.agent);
      db.q("UPDATE desk_jobs SET dirty = 1, closed_at = ?, paid = ?, fee = ?, back = '0' WHERE id = ?").run(e.at, String(a.toAgent), String(a.jobFee), id);
      const repaid = BigInt(String(a.poolRepaid)) > 0n;
      line(db, e, "settled", repaid ? a.poolRepaid : a.toAgent, id, agent, repaid ? "repaid" : "paid");
      return `job ${id}: settled, ${eth(a.toAgent)} ETH to the agent${repaid ? `, ${eth(a.poolRepaid)} ETH back to the pool` : ""}`;
    }
    case "SettledAtHalf": {
      const agent = touchAgent(db, e, a.agent);
      db.q("UPDATE desk_jobs SET dirty = 1, closed_at = ?, paid = ?, back = ?, fee = ? WHERE id = ?").run(e.at, String(a.toAgent), String(a.toCustomer), String(a.jobFee), id);
      line(db, e, "half", a.toCustomer, id, agent);
      return `job ${id}: rejected, settled at half`;
    }
    case "Declined": {
      const agent = touchAgent(db, e, a.agent);
      db.q("UPDATE desk_jobs SET dirty = 1, closed_at = ?, back = ?, paid = '0', fee = '0' WHERE id = ?").run(e.at, String(a.toCustomer), id);
      line(db, e, "declined", a.toCustomer, id, agent);
      return `job ${id}: declined`;
    }
    case "Refunded": {
      const agent = touchAgent(db, e, a.agent);
      db.q("UPDATE desk_jobs SET dirty = 1, closed_at = ?, back = ?, not_repaid = ?, paid = '0', fee = '0' WHERE id = ?").run(e.at, String(a.toCustomer), String(a.notRepaid), id);
      // a job the agent drew on and did not deliver, or one it never took up: the ledger words them differently
      line(db, e, "refunded", a.toCustomer, id, agent, db.q("SELECT 1 FROM desk_advances WHERE job_id = ? LIMIT 1").get(id) ? "drew" : "");
      if (BigInt(String(a.notRepaid)) > 0n) line(db, e, "not_repaid", a.notRepaid, id, agent, JSON.stringify({ fromBond: String(a.fromBond), lost: String(a.lost) }));
      return `job ${id}: refunded${BigInt(String(a.notRepaid)) > 0n ? `, ${eth(a.notRepaid)} ETH of pool advance not repaid (${eth(a.lost)} lost)` : ""}`;
    }
    case "BondAdded":
    case "BondTaken": {
      const agent = touchAgent(db, e, a.agent);
      line(db, e, "bond", a.amount, null, agent, e.event === "BondAdded" ? "added" : "taken");
      return null;
    }
    case "PoolIn": {
      const fees = normalizeAddress(a.from) === addr.splitter;
      line(db, e, "pool_in", a.amount, null, null, fees ? "fees" : "gift");
      return `${eth(a.amount)} ETH into the pool${fees ? " from trading fees" : ""}`;
    }
    default:
      return null; // Owed and Collected are kept with every other log and make no line
  }
}

/** A burn, as a line of the ledger. The amount is the tokens burned. */
export function applyBurn(db: EngineDb, e: EventRow): void {
  line(db, e, "burned", e.args.tokensBurned, null, null, String(e.args.ethIn));
}

// ---------- reading back what is ----------

const num = (v: unknown): number => Number(v ?? 0);
const wei = (v: unknown): string => BigInt(String(v ?? 0)).toString();

/** The rows marked as changed, read from the desk at the head. Returns how many are still waiting. */
export async function refreshDesk(ctx: Ctx): Promise<number> {
  const { db, chain } = ctx;
  const most = ctx.params.deskReadsPerPass;
  const jobs = db.q("SELECT id FROM desk_jobs WHERE dirty = 1 ORDER BY id LIMIT ?").all(most) as { id: number }[];
  const agents = db.q("SELECT address FROM desk_agents WHERE dirty = 1 ORDER BY address LIMIT ?").all(most) as { address: string }[];
  if (jobs.length === 0 && agents.length === 0) return 0;
  // asked in one go: on the real chain the reads fold into a few multicalls
  const [gotJobs, gotAgents] = await Promise.all([
    Promise.all(jobs.map((j) => chain.read<Record<string, unknown>>({ to: ctx.addr.desk, abi: DESK, functionName: "job", args: [BigInt(j.id)] }))),
    Promise.all(agents.map((a) => chain.read<Record<string, unknown>>({ to: ctx.addr.desk, abi: DESK, functionName: "agent", args: [a.address] }))),
  ]);
  db.tx(() => {
    jobs.forEach(({ id }, i) => {
      const j = gotJobs[i];
      // the desk has no such job: the lock was on a branch of the chain that is gone
      if (num(j.state) === STATE.none) return void db.q("DELETE FROM desk_jobs WHERE id = ?").run(id);
      db.q("UPDATE desk_jobs SET dirty = 0, state = ?, early = ?, from_pool = ?, delivered_at = ?, late = ?, proof = ?, customer = ?, agent = ?, price = ?, due_at = ?, allow_early = ? WHERE id = ?").run(
        num(j.state), wei(j.early), wei(j.fromPool), num(j.deliveredAt), j.late ? 1 : 0, String(j.proof ?? ""), normalizeAddress(j.customer) ?? "", normalizeAddress(j.agent) ?? "", wei(j.price), num(j.dueAt), j.allowEarly ? 1 : 0, id,
      );
    });
    agents.forEach(({ address }, i) => {
      const a = gotAgents[i];
      if (!a.registered) return void db.q("DELETE FROM desk_agents WHERE address = ?").run(address);
      const record: AgentRecord = {
        registered: true, barred: !!a.barred, firstSettledAt: num(a.firstSettledAt), settled: num(a.settled), settledAtHalf: num(a.settledAtHalf), notDelivered: num(a.notDelivered),
        unanswered: num(a.unanswered), customers: num(a.customers), onTime: num(a.onTime), late: num(a.late), advancesRepaid: num(a.advancesRepaid), advancesNotRepaid: num(a.advancesNotRepaid),
        earlyKept: num(a.earlyKept), bond: wei(a.bond), feesPaid: wei(a.feesPaid), advancedNow: wei(a.advancedNow), volume: wei(a.volume),
      };
      db.q("UPDATE desk_agents SET dirty = 0, record = ? WHERE address = ?").run(JSON.stringify(record), address);
    });
  });
  const left = (db.q("SELECT (SELECT COUNT(*) FROM desk_jobs WHERE dirty = 1) + (SELECT COUNT(*) FROM desk_agents WHERE dirty = 1) AS n").get() as { n: number }).n;
  return left;
}

/** One job read from the desk right now (after the engine itself closed it). */
export async function rereadJob(ctx: Ctx, id: number): Promise<void> {
  ctx.db.q("UPDATE desk_jobs SET dirty = 1 WHERE id = ?").run(id);
  const row = ctx.db.q("SELECT agent FROM desk_jobs WHERE id = ?").get(id) as { agent: string } | undefined;
  if (row) ctx.db.q("UPDATE desk_agents SET dirty = 1 WHERE address = ?").run(row.agent);
  await refreshDesk(ctx);
}

// ---------- reading the engine's copy ----------

const agentOf = (r: { address: string; dirty: number; registered_block: number; registered_at: number; record: string }): AgentRow => {
  let record = EMPTY;
  try {
    record = { ...EMPTY, ...(JSON.parse(r.record) as AgentRecord) };
  } catch {
    // a row not read from the desk yet
  }
  return { ...r, record };
};

export class DeskStore {
  constructor(private db: EngineDb) {}

  job(id: number): JobRow | null {
    return (this.db.q("SELECT * FROM desk_jobs WHERE id = ?").get(id) as JobRow | undefined) ?? null;
  }

  /** Jobs, newest first: the newest `limit`, or those with a number under `before`. */
  jobs(limit: number, before?: number, agent?: string): JobRow[] {
    const where = [before !== undefined ? "id < @before" : "", agent ? "agent = @agent" : ""].filter(Boolean).join(" AND ");
    return this.db.q(`SELECT * FROM desk_jobs ${where ? `WHERE ${where}` : ""} ORDER BY id DESC LIMIT @limit`).all({ limit, before: before ?? 0, agent: agent ?? "" }) as JobRow[];
  }

  jobCount(): number {
    return (this.db.q("SELECT COUNT(*) AS n FROM desk_jobs").get() as { n: number }).n;
  }

  countByState(state: number): number {
    return (this.db.q("SELECT COUNT(*) AS n FROM desk_jobs WHERE state = ?").get(state) as { n: number }).n;
  }

  /** Delivered, and the customer's day is over: anyone may settle it. Oldest first. */
  dueToSettle(t: number, limit: number): JobRow[] {
    return this.db.q("SELECT * FROM desk_jobs WHERE state = ? AND delivered_at > 0 AND delivered_at + ? <= ? ORDER BY delivered_at LIMIT ?").all(STATE.delivered, RULES.reviewS, t, limit) as JobRow[];
  }

  /** Not delivered, and the due time and the grace are past: anyone may refund it. Oldest first. */
  dueToRefund(t: number, limit: number): JobRow[] {
    return this.db.q("SELECT * FROM desk_jobs WHERE state IN (?, ?) AND due_at + ? < ? ORDER BY due_at LIMIT ?").all(STATE.locked, STATE.advanced, RULES.graceS, t, limit) as JobRow[];
  }

  agent(address: string): AgentRow | null {
    const r = this.db.q("SELECT * FROM desk_agents WHERE address = ?").get(address) as Parameters<typeof agentOf>[0] | undefined;
    return r ? agentOf(r) : null;
  }

  agents(): AgentRow[] {
    return (this.db.q("SELECT * FROM desk_agents ORDER BY registered_block, address").all() as Parameters<typeof agentOf>[0][]).map(agentOf);
  }

  agentCount(): number {
    return (this.db.q("SELECT COUNT(*) AS n FROM desk_agents").get() as { n: number }).n;
  }

  advances(jobId: number): AdvanceRow[] {
    return this.db.q("SELECT * FROM desk_advances WHERE job_id = ? ORDER BY block, log_index").all(jobId) as AdvanceRow[];
  }

  advancesOf(jobIds: number[]): Map<number, AdvanceRow[]> {
    const out = new Map<number, AdvanceRow[]>();
    if (jobIds.length === 0) return out;
    const rows = this.db.db.prepare(`SELECT * FROM desk_advances WHERE job_id IN (${jobIds.map(() => "?").join(",")}) ORDER BY block, log_index`).all(...jobIds) as AdvanceRow[];
    for (const r of rows) out.set(r.job_id, [...(out.get(r.job_id) ?? []), r]);
    return out;
  }

  /** The ledger, newest first. `kinds` narrows it; `jobId` and `agent` too. */
  ledger(limit: number, o: { before?: number; kinds?: string[]; jobId?: number; agent?: string } = {}): LedgerRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (o.before !== undefined) (where.push("n < ?"), args.push(o.before));
    if (o.kinds?.length) (where.push(`kind IN (${o.kinds.map(() => "?").join(",")})`), args.push(...o.kinds));
    if (o.jobId !== undefined) (where.push("job_id = ?"), args.push(o.jobId));
    if (o.agent) (where.push("agent = ?"), args.push(o.agent));
    return this.db.db.prepare(`SELECT * FROM ledger ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY n DESC LIMIT ?`).all(...args, limit) as LedgerRow[];
  }

  ledgerCount(kinds?: string[]): number {
    if (!kinds?.length) return (this.db.q("SELECT COUNT(*) AS n FROM ledger").get() as { n: number }).n;
    return (this.db.db.prepare(`SELECT COUNT(*) AS n FROM ledger WHERE kind IN (${kinds.map(() => "?").join(",")})`).get(...kinds) as { n: number }).n;
  }
}
