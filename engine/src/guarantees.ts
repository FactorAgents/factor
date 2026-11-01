// Guarantees (docs/GUARANTEES.md; contracts/src/FactorGuarantee.sol): an agent backs its jobs with a guarantee bond and
// sells cover; a customer whose covered job is refunded is paid the cover out of the agent's bond.
//
// What the engine does with them:
//
//   reads     the guarantee contract's BondAdded, BondTaken, OfferSet, Reserved, Bound, Closed, Owed and Collected, each
//             into chain_events and the contract's own tables here (not the desk's ledger: switched off, guarantees
//             leave no trace on the desk's pages). What an agent's bond IS (all of it, what is held back, its offer, the
//             score the contract counts and the share of a price it allows) and what each open cover is are read from
//             the contract itself at the head, the stalest first
//   ties      a reservation to the desk job its customer locked on the terms reserved, within the hour: bind(cover, job)
//   closes    a covered job once it is finished on the desk, or due to be refunded or settled: close(job), which refunds
//             or settles it on the desk first. Refunded, the customer is paid the cover; otherwise it goes back to the
//             bond. This is the "automatic" payout: the keeper sends it, and anyone may
//   lapses    a reservation that was not tied within the hour: lapse(cover), so the agent's bond is free again
//
//   GET  /v1/guarantees              the rules, the totals, every agent selling cover and the latest covers
//   GET  /v1/guarantees/about        whether guarantees are on, the contract and the totals
//   GET  /v1/guarantees/agent/<id>   one agent's guarantee: bond, offer, share, record and covers (address or name)
//   GET  /v1/guarantees/job/<n>      the cover of a desk job
//   GET  /v1/guarantees/cover/<id>   one cover, by its number
//   GET  /v1/guarantees/customer/<address>   a customer's covers
//
// Switches: GUARANTEES=on (off unless it is said), with FACTOR_GUARANTEE and FACTOR_GUARANTEE_BLOCK; and the owner's
// "guarantees" switch (./switches.ts), which hides guarantees and stops the keeper's ties, closes and lapses at once.
// Nothing a customer or an agent does on the chain depends on either: every call of the contract is open to everybody.

import type { Abi } from "viem";
import { factorGuaranteeAbi } from "./abi/index.js";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import { readLogs, type CallSpec, type Chain, type ChainLog, type Head } from "./chain/chain.js";
import type { Ctx } from "./chain/context.js";
import type { EngineDb, EventRow } from "./chain/db.js";
import { decode } from "./chain/watch.js";
import { STATE } from "./desk.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export interface GuaranteesConfig {
  /** GUARANTEES=on: off unless it is said */
  enabled: boolean;
  /** FACTOR_GUARANTEE: the guarantee contract, once deployed (contracts/deploy-guarantees.sh writes it) */
  guarantee: string | null;
  /** FACTOR_GUARANTEE_BLOCK: the block to read guarantees from */
  fromBlock: bigint | null;
  /** GUARANTEES_PER_PASS: how many covers the keeper ties, closes or lets lapse in one pass */
  perPass: number;
  /** why it is on and cannot run, when it cannot */
  note: string | null;
}

export function readGuarantees(env: Env, problems: string[] = []): GuaranteesConfig {
  const on = (env.GUARANTEES ?? "").trim().toLowerCase() === "on";
  const raw = env.FACTOR_GUARANTEE?.trim();
  const guarantee = raw ? normalizeAddress(raw) : null;
  if (raw && !guarantee) problems.push(`FACTOR_GUARANTEE is not an address: "${raw}"`);
  const rawBlock = env.FACTOR_GUARANTEE_BLOCK?.trim();
  let fromBlock: bigint | null = null;
  if (rawBlock) {
    if (/^\d+$/.test(rawBlock)) fromBlock = BigInt(rawBlock);
    else problems.push(`FACTOR_GUARANTEE_BLOCK must be a block number: it is "${rawBlock}"`);
  }
  const rawPer = env.GUARANTEES_PER_PASS?.trim();
  let perPass = 5;
  if (rawPer) {
    if (/^\d+$/.test(rawPer) && Number(rawPer) >= 1 && Number(rawPer) <= 100) perPass = Number(rawPer);
    else problems.push(`GUARANTEES_PER_PASS must be a whole number from 1 to 100: it is "${rawPer}"`);
  }
  let note: string | null = null;
  if (on && !guarantee) note = "GUARANTEES is on and FACTOR_GUARANTEE is not set: there is no guarantee contract to read yet";
  else if (on && fromBlock === null) note = "GUARANTEES is on and FACTOR_GUARANTEE_BLOCK is not set: the block to read guarantees from";
  return { enabled: on, guarantee, fromBlock, perPass, note };
}

/** The rules, as the contract has them (FactorGuarantee's constants): what the site and the kit say. */
export const GUARANTEE_RULES = {
  feePct: 1, burnPctOfFee: 50, minCoverEth: 0.0001, windowMin: 60, graceH: 12, reviewH: 24,
  shares: [{ score: 200, pct: 25 }, { score: 400, pct: 50 }, { score: 600, pct: 75 }, { score: 800, pct: 100 }],
  minCoverWei: 100_000_000_000_000n, windowS: 3600, graceS: 12 * 3600, reviewS: 24 * 3600,
} as const;

/** The share of a price a score allows as cover, in percent: the contract's shareOf, to the letter. */
export const sharePct = (score: number): number => (score >= 800 ? 100 : score >= 600 ? 75 : score >= 400 ? 50 : score >= 200 ? 25 : 0);

const GT = factorGuaranteeAbi as Abi;
const COVER_STATES = ["none", "reserved", "bound", "released", "paid", "declined", "lapsed"] as const;
export type CoverState = Exclude<(typeof COVER_STATES)[number], "none">;

export interface CoverRow {
  id: number; block: number; at: number; tx_hash: string; customer: string; agent: string; price: string; due_at: number; allow_early: number;
  amount: string; fee: string; expires_at: number; after_job: number | null; state: CoverState; job: number | null; bound_tx: string | null; bound_at: number | null;
  closed_tx: string | null; closed_at: number | null; paid: string; to_agent: string; burned: string; fee_back: string; read_at: number;
}

interface BondRow { agent: string; block: number; state: string; state_at: number }

/** What an agent's guarantee is, read at the head. Amounts in wei, as text. */
export interface BondState {
  bond: string; reserved: string; offer: string; covers: number; released: number; paid: number; declined: number; lapsed: number;
  coveredTotal: string; paidTotal: string; feesEarned: string; score: number; share: number; key: string | null;
}

export interface GuaranteesDeps {
  cfg: GuaranteesConfig;
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
}

/** The totals, read from the contract. */
export interface GuaranteeTotals { bonds: string; reserved: string; feesHeld: string; owed: string; covered: string; paid: string; fees: string; burned: string; covers: number; at: number }

export class Guarantees {
  private totalsReadAt = 0;

  constructor(readonly d: GuaranteesDeps) {}

  /** Reading the chain: switched on and a contract to read. */
  reading(): boolean {
    return this.d.cfg.enabled && !!this.d.cfg.guarantee && this.d.cfg.fromBlock !== null;
  }

  /** Shown and kept: reading, and the owner has not stopped it. */
  on(): boolean {
    return this.reading() && !stopped(this.d.db, "guarantees");
  }

  // ---------- the books ----------

  cover(id: number): CoverRow | null {
    return (this.d.db.q("SELECT * FROM guarantee_covers WHERE id = ?").get(id) as CoverRow | undefined) ?? null;
  }

  coverOfJob(job: number): CoverRow | null {
    return (this.d.db.q("SELECT * FROM guarantee_covers WHERE job = ?").get(job) as CoverRow | undefined) ?? null;
  }

  coversOf(o: { agent?: string; customer?: string; limit?: number }): CoverRow[] {
    const limit = o.limit ?? 20;
    if (o.agent) return this.d.db.q("SELECT * FROM guarantee_covers WHERE agent = ? ORDER BY id DESC LIMIT ?").all(o.agent, limit) as CoverRow[];
    if (o.customer) return this.d.db.q("SELECT * FROM guarantee_covers WHERE customer = ? ORDER BY id DESC LIMIT ?").all(o.customer, limit) as CoverRow[];
    return this.d.db.q("SELECT * FROM guarantee_covers ORDER BY id DESC LIMIT ?").all(limit) as CoverRow[];
  }

  /** The covers of a set of jobs, for a list of jobs. */
  coversOfJobs(ids: number[]): Map<number, CoverRow> {
    if (!ids.length || !this.on()) return new Map();
    const rows = this.d.db.q(`SELECT * FROM guarantee_covers WHERE job IN (${ids.map(() => "?").join(", ")})`).all(...ids) as CoverRow[];
    return new Map(rows.map((r) => [r.job!, r]));
  }

  private bondRow(agent: string): BondRow | null {
    return (this.d.db.q("SELECT * FROM guarantee_bonds WHERE agent = ?").get(agent) as BondRow | undefined) ?? null;
  }

  bondOf(agent: string): BondState | null {
    const r = this.bondRow(agent);
    if (!r) return null;
    const s = JSON.parse(r.state) as Partial<BondState>;
    return {
      bond: s.bond ?? "0", reserved: s.reserved ?? "0", offer: s.offer ?? "0", covers: s.covers ?? 0, released: s.released ?? 0, paid: s.paid ?? 0, declined: s.declined ?? 0, lapsed: s.lapsed ?? 0,
      coveredTotal: s.coveredTotal ?? "0", paidTotal: s.paidTotal ?? "0", feesEarned: s.feesEarned ?? "0", score: s.score ?? 0, share: s.share ?? 0, key: s.key ?? null,
    };
  }

  totals(): GuaranteeTotals | null {
    return this.d.db.getJson<GuaranteeTotals>("guarantees:totals");
  }

  // ---------- reading the chain ----------

  /** One log of the guarantee contract's, written down. Returns a line for the engine's log, when it is worth one. Exported for the tests. */
  apply(log: ChainLog, at: number): string | null {
    const e = decode({ name: "guarantee" as never, abi: GT }, log, at);
    if (!e) return null;
    e.contract = "guarantee";
    if (!this.d.db.addEvent(e)) return null;
    return this.effect(e);
  }

  private move(e: EventRow, agent: string | null, kind: string, amount: string, extra: Record<string, unknown>): void {
    this.d.db.q("INSERT OR IGNORE INTO guarantee_moves (tx_hash, log_index, block, at, agent, kind, amount, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(e.tx_hash, e.log_index, e.block, e.at, agent, kind, amount, JSON.stringify(extra));
  }

  /** An agent seen: read again at once. */
  private dirty(agent: string, block: number): void {
    this.d.db.q("INSERT INTO guarantee_bonds (agent, block) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET state_at = 0").run(agent, block);
  }

  private name(address: string): string {
    const p = this.d.names().get(address);
    return p && !p.hidden ? p.name : shortAddress(address);
  }

  private effect(e: EventRow): string | null {
    const db = this.d.db;
    const a = e.args;
    const agent = normalizeAddress(a.agent) ?? null;
    if (e.event === "BondAdded" && agent) {
      this.move(e, agent, "bond", String(a.amount), { from: normalizeAddress(a.from), bond: String(a.bond) });
      this.dirty(agent, e.block);
      return `${ethText(String(a.amount))} ETH into ${this.name(agent)}'s guarantee bond`;
    }
    if (e.event === "BondTaken" && agent) {
      this.move(e, agent, "unbond", String(a.amount), { bond: String(a.bond) });
      this.dirty(agent, e.block);
      return `${this.name(agent)} took ${ethText(String(a.amount))} ETH out of its guarantee bond`;
    }
    if (e.event === "OfferSet" && agent) {
      this.move(e, agent, "offer", String(a.offer), {});
      this.dirty(agent, e.block);
      return BigInt(String(a.offer)) === 0n ? `${this.name(agent)} sells no cover now` : `${this.name(agent)} offers cover up to ${ethText(String(a.offer))} ETH a job`;
    }
    if (e.event === "Reserved" && agent) {
      const id = Number(a.id);
      db.q("INSERT OR IGNORE INTO guarantee_covers (id, block, at, tx_hash, customer, agent, price, due_at, allow_early, amount, fee, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id, e.block, e.at, e.tx_hash, normalizeAddress(a.customer), agent, String(a.price), Number(a.dueAt), a.allowEarly === true || a.allowEarly === "true" ? 1 : 0, String(a.amount), String(a.fee), Number(a.expiresAt),
      );
      this.dirty(agent, e.block);
      return `cover ${id}: ${ethText(String(a.amount))} ETH from ${this.name(agent)}'s bond reserved by ${shortAddress(normalizeAddress(a.customer) ?? "")}`;
    }
    if (e.event === "Bound" && agent) {
      const id = Number(a.id), job = Number(a.job);
      db.q("UPDATE guarantee_covers SET state = 'bound', job = ?, bound_tx = ?, bound_at = ? WHERE id = ? AND state = 'reserved'").run(job, e.tx_hash, e.at, id);
      this.dirty(agent, e.block);
      return `cover ${id} is tied to job ${job}`;
    }
    if (e.event === "Closed" && agent) {
      const id = Number(a.id);
      const how = COVER_STATES[Number(a.how)] ?? "released";
      db.q("UPDATE guarantee_covers SET state = ?, closed_tx = ?, closed_at = ?, paid = ?, to_agent = ?, burned = ?, fee_back = ? WHERE id = ?").run(how, e.tx_hash, e.at, String(a.paid), String(a.toAgent), String(a.burned), String(a.feeBack), id);
      this.move(e, agent, how, how === "paid" ? String(a.paid) : "0", { cover: id, job: Number(a.job), toAgent: String(a.toAgent), burned: String(a.burned), feeBack: String(a.feeBack) });
      this.dirty(agent, e.block);
      if (how === "paid") return `cover ${id}: job ${Number(a.job)} was not delivered, ${ethText(String(a.paid))} ETH paid to its customer from ${this.name(agent)}'s bond`;
      if (how === "declined") return `cover ${id}: ${this.name(agent)} declined job ${Number(a.job)}, the fee went back to the customer`;
      if (how === "lapsed") return `cover ${id} lapsed: no job was tied to it within the hour`;
      return `cover ${id}: job ${Number(a.job)} was delivered, the cover went back to ${this.name(agent)}'s bond`;
    }
    if (e.event === "Owed") {
      this.move(e, normalizeAddress(a.who), "owed", String(a.amount), {});
      return `${ethText(String(a.amount))} ETH waits in the guarantee contract for ${shortAddress(normalizeAddress(a.who) ?? "")}, who refused it`;
    }
    return null;
  }

  /** One pass of the guarantee contract's logs, from where the last stopped to the safe head. Returns the lines worth logging. */
  async watch(ctx: Ctx, head: Head): Promise<string[]> {
    if (!this.reading()) return [];
    const { db, chain } = this.d;
    const safe = head.number - BigInt(ctx.params.confirmations);
    const start = (db.cursor("guarantees") ?? this.d.cfg.fromBlock! - 1n) + 1n;
    if (start > safe) return [];
    const lines: string[] = [];
    const span = BigInt(ctx.params.logSpan);
    let from = start;
    for (let n = 0; n < ctx.params.spansPerPass && from <= safe; n++) {
      const to = from + span - 1n > safe ? safe : from + span - 1n;
      let logs: ChainLog[] = [];
      await readLogs(chain, from, to, { address: [this.d.cfg.guarantee!] }, to - from + 1n, (got) => { logs = got; }, 1);
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
        db.setCursor("guarantees", to);
      });
      from = to + 1n;
    }
    for (const l of lines) this.d.log(`[guarantees] ${l}`);
    if (lines.length) this.totalsReadAt = 0;
    return lines;
  }

  /**
   * What is read rather than logged: each agent's bond, its offer, its record and the share its score allows, the
   * stalest first, every few minutes at most (a score moves with the desk); each open cover as the contract has it;
   * and the totals once a minute.
   */
  async refresh(): Promise<void> {
    if (!this.reading()) return;
    const { db, chain } = this.d;
    const g = this.d.cfg.guarantee!;
    const G = <T>(fn: string, args: unknown[] = []) => chain.read<T>({ to: g, abi: GT, functionName: fn, args });
    const stale = db.q("SELECT * FROM guarantee_bonds ORDER BY state_at LIMIT 25").all() as BondRow[];
    await Promise.all(stale.filter((r) => r.state_at === 0 || this.d.now() - r.state_at > 120_000).map(async (r) => {
      const [b, score, key] = await Promise.all([
        G<{ bond: bigint; reserved: bigint; offer: bigint; covers: number | bigint; released: number | bigint; paid: number | bigint; declined: number | bigint; lapsed: number | bigint; coveredTotal: bigint; paidTotal: bigint; feesEarned: bigint }>("bondOf", [r.agent]),
        G<bigint>("scoreOf", [r.agent]), G<string>("keyOf", [r.agent]),
      ]);
      const s: BondState = {
        bond: b.bond.toString(), reserved: b.reserved.toString(), offer: b.offer.toString(), covers: Number(b.covers), released: Number(b.released), paid: Number(b.paid), declined: Number(b.declined), lapsed: Number(b.lapsed),
        coveredTotal: b.coveredTotal.toString(), paidTotal: b.paidTotal.toString(), feesEarned: b.feesEarned.toString(), score: Number(score), share: sharePct(Number(score)),
        key: normalizeAddress(key) && normalizeAddress(key) !== "0x0000000000000000000000000000000000000000" ? normalizeAddress(key) : null,
      };
      db.q("UPDATE guarantee_bonds SET state = ?, state_at = ? WHERE agent = ?").run(JSON.stringify(s), this.d.now(), r.agent);
    }));
    // open covers, as the contract has them: what a reservation's job must come after, and any state a log has not said
    const open = db.q("SELECT * FROM guarantee_covers WHERE state IN ('reserved', 'bound') AND (after_job IS NULL OR ? - read_at > 60000) ORDER BY read_at LIMIT 25").all(this.d.now()) as CoverRow[];
    await Promise.all(open.map(async (c) => {
      const x = await G<{ state: number | bigint; afterJob: bigint; job: bigint }>("cover", [BigInt(c.id)]);
      const st = COVER_STATES[Number(x.state)];
      db.q("UPDATE guarantee_covers SET after_job = ?, read_at = ? WHERE id = ?").run(Number(x.afterJob), this.d.now(), c.id);
      // a cover tied or ended on the chain whose log has not arrived yet stays as the logs say until it does
      if (st === "bound" && c.state === "reserved") db.q("UPDATE guarantee_covers SET state = 'bound', job = ? WHERE id = ?").run(Number(x.job), c.id);
    }));
    if (this.d.now() - this.totalsReadAt > 30_000) {
      this.totalsReadAt = this.d.now();
      const [bonds, reserved, feesHeld, owed, covered, paid, fees, burned, count] = await Promise.all([
        G<bigint>("bonds"), G<bigint>("reserved"), G<bigint>("feesHeld"), G<bigint>("owedTotal"), G<bigint>("totalCovered"), G<bigint>("totalPaid"), G<bigint>("totalFees"), G<bigint>("totalBurned"), G<bigint>("coverCount"),
      ]);
      db.setJson("guarantees:totals", { bonds: bonds.toString(), reserved: reserved.toString(), feesHeld: feesHeld.toString(), owed: owed.toString(), covered: covered.toString(), paid: paid.toString(), fees: fees.toString(), burned: burned.toString(), covers: Number(count), at: this.d.now() } satisfies GuaranteeTotals);
    }
  }

  // ---------- the keeper ----------

  /** The desk job a reservation was for: locked after it by its customer on exactly its terms, and not covered yet. */
  matchOf(c: CoverRow): number | null {
    if (c.after_job === null) return null;
    const row = this.d.db.q(
      "SELECT id FROM desk_jobs WHERE customer = ? AND agent = ? AND price = ? AND due_at = ? AND allow_early = ? AND id > ? AND id NOT IN (SELECT job FROM guarantee_covers WHERE job IS NOT NULL) ORDER BY id LIMIT 1",
    ).get(c.customer, c.agent, c.price, c.due_at, c.allow_early, c.after_job) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /** Whether a covered job can be closed now: finished on the desk, or due to be refunded or settled. */
  closable(job: { state: number; due_at: number; delivered_at: number }, t: number): boolean {
    if (job.state === STATE.settled || job.state === STATE.half || job.state === STATE.declined || job.state === STATE.refunded) return true;
    if ((job.state === STATE.locked || job.state === STATE.advanced) && t > job.due_at + GUARANTEE_RULES.graceS) return true;
    return job.state === STATE.delivered && job.delivered_at > 0 && t >= job.delivered_at + GUARANTEE_RULES.reviewS;
  }

  /**
   * The keeper's turn (./chain/act.ts calls it as the step "guarantee", before the desk's own settling and refunding):
   * a reservation whose job is locked is tied, a covered job that is finished (or due) is closed, which pays or releases
   * its cover, and a reservation past its hour lapses. A few a pass, the ones that pay a customer first.
   */
  async step(ctx: Ctx, head: Head, attempt: (kind: "guarantee", ref: string, call: CallSpec, detail: Record<string, unknown>, feeCap: bigint) => Promise<{ status: string; why: string; hash?: string }>): Promise<string> {
    if (!this.reading()) return "guarantees are not switched on";
    if (stopped(this.d.db, "guarantees")) return "guarantees are stopped by the owner";
    const db = this.d.db;
    const t = head.timestamp;
    const g = this.d.cfg.guarantee!;
    const said: string[] = [];
    let n = 0;
    // one try at a time per cover: one on its way waits; one that failed waits ten minutes; one shown in dry mode, half an hour
    const ready = (ref: string): boolean => {
      const prev = db.lastAction("guarantee", ref);
      if (!prev) return true;
      if (prev.status === "signed" || prev.status === "sent") return false;
      if (prev.status === "done") return this.d.now() - prev.updated_at > 120_000;
      if (prev.status === "failed") return this.d.now() - prev.updated_at > 600_000;
      if (prev.status === "dry") return this.d.now() - prev.created_at > 1_800_000;
      return true;
    };
    const go = async (ref: string, fn: string, args: unknown[], detail: Record<string, unknown>, words: string): Promise<boolean> => {
      if (!ready(ref)) return false;
      n++;
      const out = await attempt("guarantee", ref, { to: g, abi: GT, functionName: fn, args }, detail, ctx.params.maxGasWei);
      said.push(`${out.status === "dry" ? `would ${words}` : out.status === "done" ? words : `${words}: ${out.status}`}${out.status === "failed" || out.status === "skipped" ? ` (${out.why})` : ""}`);
      if (out.status === "done") db.q("UPDATE guarantee_covers SET read_at = 0 WHERE id = ?").run(Number(detail.cover));
      return db.openActions().length > 0;
    };
    // closes first: they are what pays a customer
    const bound = db.q("SELECT c.*, d.state AS job_state, d.due_at AS job_due, d.delivered_at AS job_delivered FROM guarantee_covers c JOIN desk_jobs d ON d.id = c.job WHERE c.state = 'bound' ORDER BY c.id").all() as (CoverRow & { job_state: number; job_due: number; job_delivered: number })[];
    for (const c of bound) {
      if (n >= this.d.cfg.perPass || ctx.stopping()) break;
      if (!this.closable({ state: c.job_state, due_at: c.job_due, delivered_at: c.job_delivered }, t)) continue;
      const pays = c.job_state === STATE.refunded || c.job_state === STATE.locked || c.job_state === STATE.advanced;
      if (await go(`close:${c.job}`, "close", [BigInt(c.job!)], { cover: c.id, job: c.job, agent: c.agent, customer: c.customer, amount: c.amount }, pays ? `pay cover ${c.id} on job ${c.job} to its customer` : `close cover ${c.id} on job ${c.job}`)) break;
    }
    const reserved = db.q("SELECT * FROM guarantee_covers WHERE state = 'reserved' ORDER BY id").all() as CoverRow[];
    for (const c of reserved) {
      if (n >= this.d.cfg.perPass || ctx.stopping()) break;
      if (t <= c.expires_at) {
        const job = this.matchOf(c);
        if (job !== null && (await go(`bind:${c.id}`, "bind", [BigInt(c.id), BigInt(job)], { cover: c.id, job, agent: c.agent, customer: c.customer }, `tie cover ${c.id} to job ${job}`))) break;
      } else if (t > c.expires_at + 60) {
        if (await go(`lapse:${c.id}`, "lapse", [BigInt(c.id)], { cover: c.id, agent: c.agent }, `let cover ${c.id} lapse`)) break;
      }
    }
    return said.length ? said.join("; ") : "no cover needs tying, closing or lapsing";
  }

  // ---------- what the site and the kit read ----------

  about(): GuaranteesAbout {
    const on = this.on();
    const t = this.totals();
    const sellers = on ? (this.d.db.q("SELECT agent, state FROM guarantee_bonds").all() as { agent: string; state: string }[]).filter((r) => { const s = JSON.parse(r.state) as Partial<BondState>; return BigInt(s.offer ?? "0") > 0n && BigInt(s.bond ?? "0") > BigInt(s.reserved ?? "0"); }).length : 0;
    return {
      enabled: on, contract: this.d.cfg.guarantee, chainId: this.d.chainId,
      rules: { feePct: GUARANTEE_RULES.feePct, burnPctOfFee: GUARANTEE_RULES.burnPctOfFee, minCoverEth: GUARANTEE_RULES.minCoverEth, windowMin: GUARANTEE_RULES.windowMin, graceH: GUARANTEE_RULES.graceH, shares: GUARANTEE_RULES.shares.map((s) => ({ score: s.score, pct: s.pct })) },
      totals: on && t ? { bondsEth: ethNum(t.bonds), heldEth: ethNum(t.reserved), coveredEth: ethNum(t.covered), paidEth: ethNum(t.paid), feesEth: ethNum(t.fees), burnedEth: ethNum(t.burned), covers: t.covers, agents: sellers } : null,
    };
  }

  /** One cover as the site shows it. */
  coverJson(c: CoverRow): CoverJson {
    const nowS = this.d.nowS();
    const job = c.job !== null ? (this.d.db.q("SELECT state, due_at, delivered_at FROM desk_jobs WHERE id = ?").get(c.job) as { state: number; due_at: number; delivered_at: number } | undefined) : undefined;
    let next: CoverJson["next"] | undefined;
    if (c.state === "reserved") next = { what: nowS <= c.expires_at ? "tie" : "lapse", at: iso(c.expires_at) };
    else if (c.state === "bound" && job) {
      if (job.state === STATE.locked || job.state === STATE.advanced) next = { what: "pays-if-not-delivered", at: iso(job.due_at + GUARANTEE_RULES.graceS) };
      else if (job.state === STATE.delivered) next = { what: "releases", at: iso(job.delivered_at + GUARANTEE_RULES.reviewS) };
      else next = { what: job.state === STATE.refunded ? "pays" : "releases", at: iso(nowS) };
    }
    return {
      id: c.id, customer: c.customer, agent: c.agent, agentName: this.name(c.agent), named: this.d.names().has(c.agent),
      priceEth: ethNum(c.price), coverEth: ethNum(c.amount), coverWei: c.amount, feeEth: ethNum(c.fee), dueAt: iso(c.due_at), allowEarly: !!c.allow_early,
      state: c.state, job: c.job !== null ? String(c.job).padStart(4, "0") : null, reservedAt: iso(c.at), expiresAt: iso(c.expires_at), tx: c.tx_hash,
      ...(c.bound_tx ? { boundTx: c.bound_tx, boundAt: iso(c.bound_at ?? 0) } : {}),
      ...(c.closed_tx ? { closedTx: c.closed_tx, closedAt: iso(c.closed_at ?? 0), paidEth: ethNum(c.paid), toAgentEth: ethNum(c.to_agent), burnedEth: ethNum(c.burned), feeBackEth: ethNum(c.fee_back) } : {}),
      ...(next ? { next } : {}),
    };
  }

  /** An agent's guarantee as the site shows it, or null when it has never had one. */
  agentJson(address: string, full = false): AgentGuaranteeJson | null {
    if (!this.on()) return null;
    const s = this.bondOf(address);
    if (!s) return null;
    const bond = BigInt(s.bond), held = BigInt(s.reserved), offer = BigInt(s.offer);
    const free = bond - held;
    const upTo = offer < free ? offer : free;
    const out: AgentGuaranteeJson = {
      agent: address, name: this.name(address), named: this.d.names().has(address), key: s.key,
      bondEth: ethNum(s.bond), heldEth: ethNum(s.reserved), freeEth: ethNum(free.toString()), offerEth: ethNum(s.offer), offerWei: s.offer, upToEth: ethNum((s.share > 0 ? upTo : 0n).toString()), upToWei: (s.share > 0 ? upTo : 0n).toString(),
      score: s.score, sharePct: s.share, selling: s.share > 0 && upTo >= GUARANTEE_RULES.minCoverWei,
      covers: s.covers, released: s.released, paid: s.paid, declined: s.declined, lapsed: s.lapsed, coveredEth: ethNum(s.coveredTotal), paidOutEth: ethNum(s.paidTotal), feesEarnedEth: ethNum(s.feesEarned),
    };
    if (full) out.items = this.coversOf({ agent: address, limit: 20 }).map((c) => this.coverJson(c));
    return out;
  }

  /** The small mark beside an agent wherever it shows, while it sells cover. */
  badge(address: string): { upToEth: number; sharePct: number } | null {
    const j = this.agentJson(address);
    return j && j.selling ? { upToEth: j.upToEth, sharePct: j.sharePct } : null;
  }

  list(): { agents: AgentGuaranteeJson[]; covers: CoverJson[] } {
    if (!this.on()) return { agents: [], covers: [] };
    const agents = (this.d.db.q("SELECT agent FROM guarantee_bonds").all() as { agent: string }[]).map((r) => this.agentJson(r.agent)!).filter((x) => x && (x.selling || x.covers > 0)).sort((a, b) => b.upToEth - a.upToEth);
    return { agents, covers: this.coversOf({ limit: 20 }).map((c) => this.coverJson(c)) };
  }

  /** For the owner's health answer. */
  health(): Record<string, unknown> {
    const count = (state: string) => (this.d.db.q("SELECT COUNT(*) AS n FROM guarantee_covers WHERE state = ?").get(state) as { n: number }).n;
    return { reading: this.reading(), on: this.on(), guarantee: this.d.cfg.guarantee, reserved: count("reserved"), bound: count("bound"), paid: count("paid"), totals: this.totals(), note: this.d.cfg.note };
  }
}

/** What guarantees are, as the site and the kit read it: web/src/lib/types.ts keeps the same shape by hand. */
export interface GuaranteesAbout {
  enabled: boolean; contract: string | null; chainId: number;
  rules: { feePct: number; burnPctOfFee: number; minCoverEth: number; windowMin: number; graceH: number; shares: { score: number; pct: number }[] };
  totals: { bondsEth: number; heldEth: number; coveredEth: number; paidEth: number; feesEth: number; burnedEth: number; covers: number; agents: number } | null;
}

export interface CoverJson {
  id: number; customer: string; agent: string; agentName: string; named: boolean;
  priceEth: number; coverEth: number; coverWei: string; feeEth: number; dueAt: string; allowEarly: boolean;
  /** reserved: not tied to a job yet. bound: tied. released: delivered, back to the bond. paid: not delivered, paid to the customer. declined: the agent declined, the fee went back. lapsed: never tied */
  state: CoverState;
  job: string | null; reservedAt: string; expiresAt: string; tx: string;
  boundTx?: string; boundAt?: string; closedTx?: string; closedAt?: string; paidEth?: number; toAgentEth?: number; burnedEth?: number; feeBackEth?: number;
  /** what happens next, and from when */
  next?: { what: "tie" | "lapse" | "pays-if-not-delivered" | "releases" | "pays"; at: string };
}

export interface AgentGuaranteeJson {
  agent: string; name: string; named: boolean; key: string | null;
  bondEth: number; heldEth: number; freeEth: number; offerEth: number; offerWei: string;
  /** "Guaranteed up to": the offer or the free bond, whichever is less; 0 while the score allows no share */
  upToEth: number; upToWei: string;
  /** the score the contract counts and the share of a price it allows, in percent */
  score: number; sharePct: number; selling: boolean;
  covers: number; released: number; paid: number; declined: number; lapsed: number; coveredEth: number; paidOutEth: number; feesEarnedEth: number;
  items?: CoverJson[];
}

const iso = (s: number): string => new Date(s * 1000).toISOString();
const ethNum = (wei: string): number => Number(BigInt(wei) / 10n ** 12n) / 1e6;
const ethText = (wei: string): string => {
  const n = ethNum(wei);
  return n >= 0.01 ? n.toFixed(4) : n.toFixed(6);
};
