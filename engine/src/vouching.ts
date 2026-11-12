// Vouching (docs/VOUCHING.md; contracts/src/FactorVouch.sol): an agent with a strong score co-signs a newer agent's credit
// line, or a cover it sold on a job, up to a share of its own vouching bond. Kept (the line repaid, the job delivered),
// the voucher earns part of the fee the newer agent paid; failed (the line defaulted, the job never delivered), the
// voucher's bond pays whoever bore the loss: the line pool, or the job's customer.
//
// What the engine does with them:
//
//   reads     the vouching contract's BondAdded, BondTaken, Offered, Accepted, Withdrawn, Settled, Owed and Collected
//             into chain_events and the tables here. What a voucher's bond IS (all of it, what is held back, its record,
//             its score) and where each open vouch's line or cover stands (the line's debt, due time and default; the
//             cover's state and its desk job's) are read from the contracts at the head, the stalest first
//   settles   a standing vouch once its outcome is on the chain: settle(id), which recovers a line due to be recovered,
//             or closes a cover whose job is finished, first. Anyone may; the keeper does it on time
//   withdraws an offer nobody accepted within its seven days, so the voucher's bond is free again
//   shows     beside every vouch the ties Factor's records find between the voucher and the agent (the checks reviews
//             and verifiers use), and whether the voucher is one of Factor's own: a tied vouch, or one of Factor's own,
//             is shown and marked, and never counted toward an agent's standing
//
//   GET  /v1/vouches                  the rules, the totals, the vouchers (Factor's own apart) and the latest vouches
//   GET  /v1/vouches/about            whether vouching is on, the contract, the rules and the totals
//   GET  /v1/vouches/<n>              one vouch
//   GET  /v1/vouches/agent/<id>       an agent's vouches: received and given, and its record as a voucher
//   GET  /v1/vouches/voucher/<id>     one voucher, with its vouches
//   GET  /v1/vouches/line/<account>   the vouches on one credit line
//   GET  /v1/vouches/cover/<n>        the vouches on one cover
//
// Switches: VOUCHING=on (off unless it is said), with FACTOR_VOUCH and FACTOR_VOUCH_BLOCK; and the owner's "vouching"
// switch (./switches.ts), which hides vouches and stops the keeper's settles and withdrawals at once. Nothing a voucher or
// an agent does on the chain depends on either: every call of the contract is open to everybody.

import { formatEther, type Abi } from "viem";
import { factorDeskAbi, factorGuaranteeAbi, factorLineAbi, factorVouchAbi } from "./abi/index.js";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import { readLogs, type CallSpec, type Chain, type ChainLog, type Head } from "./chain/chain.js";
import type { Ctx } from "./chain/context.js";
import type { EngineDb, EventRow } from "./chain/db.js";
import { decode } from "./chain/watch.js";
import { STATE } from "./desk.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export interface VouchingConfig {
  /** VOUCHING=on: off unless it is said */
  enabled: boolean;
  /** FACTOR_VOUCH: the vouching contract, once deployed (contracts/deploy-vouch.sh writes it) */
  contract: string | null;
  /** FACTOR_VOUCH_BLOCK: the block to read vouches from */
  fromBlock: bigint | null;
  /** VOUCHING_PER_PASS: how many vouches the keeper settles or withdraws in one pass */
  perPass: number;
  /** why it is on and cannot run, when it cannot */
  note: string | null;
}

export function readVouching(env: Env, problems: string[] = []): VouchingConfig {
  const on = (env.VOUCHING ?? "").trim().toLowerCase() === "on";
  const raw = env.FACTOR_VOUCH?.trim();
  const contract = raw ? normalizeAddress(raw) : null;
  if (raw && !contract) problems.push(`FACTOR_VOUCH is not an address: "${raw}"`);
  const rawBlock = env.FACTOR_VOUCH_BLOCK?.trim();
  let fromBlock: bigint | null = null;
  if (rawBlock) {
    if (/^\d+$/.test(rawBlock)) fromBlock = BigInt(rawBlock);
    else problems.push(`FACTOR_VOUCH_BLOCK must be a block number: it is "${rawBlock}"`);
  }
  const rawPer = env.VOUCHING_PER_PASS?.trim();
  let perPass = 5;
  if (rawPer) {
    if (/^\d+$/.test(rawPer) && Number(rawPer) >= 1 && Number(rawPer) <= 100) perPass = Number(rawPer);
    else problems.push(`VOUCHING_PER_PASS must be a whole number from 1 to 100: it is "${rawPer}"`);
  }
  let note: string | null = null;
  if (on && !contract) note = "VOUCHING is on and FACTOR_VOUCH is not set: there is no vouching contract to read yet";
  else if (on && fromBlock === null) note = "VOUCHING is on and FACTOR_VOUCH_BLOCK is not set: the block to read vouches from";
  return { enabled: on, contract, fromBlock, perPass, note };
}

const DAY = 86_400;
/** The rules, as the contract has them (FactorVouch's constants): what the site and the kit say. */
export const VOUCH_RULES = {
  minScore: 300, maxSharePct: 25, feePct: 2, voucherPctOfFee: 50, minVouchEth: 0.0001, lineTermDays: 30, offerDays: 7,
  minVouchWei: 100_000_000_000_000n, lineTermS: 30 * DAY, offerS: 7 * DAY,
  // the line contract's and the desk's own clocks, which the vouching contract reads
  lineDueS: 30 * DAY, lineDefaultAfterS: 30 * DAY, graceS: 12 * 3600, reviewS: 24 * 3600,
} as const;

const VT = factorVouchAbi as Abi;
const KINDS = ["line", "cover"] as const;
export type VouchKind = (typeof KINDS)[number];
const STATES = ["none", "offered", "active", "kept", "failed", "returned", "withdrawn"] as const;
export type VouchState = Exclude<(typeof STATES)[number], "none">;
const COVER_STATES = ["none", "reserved", "bound", "released", "paid", "declined", "lapsed"] as const;
const ZERO = "0x0000000000000000000000000000000000000000";

export interface VouchRow {
  id: number; block: number; at: number; tx_hash: string; voucher: string; agent: string; kind: VouchKind; subject: string;
  amount: string; fee: string; expires_at: number; state: VouchState; started_at: number | null; ends_at: number | null; payer: string | null; accepted_tx: string | null;
  ended_tx: string | null; ended_at: number | null; to_voucher: string; burned: string; paid: string; paid_to: string | null; fee_back: string;
  debt_at_offer: string; subject_state: string; read_at: number; ties: string | null; ties_at: number;
}

interface VoucherRow { voucher: string; block: number; state: string; state_at: number }

/** What a voucher's bond is, read at the head. Amounts in wei, as text. */
export interface VoucherState {
  bond: string; held: string; vouches: number; kept: number; failed: number; returned: number; vouchedTotal: string; lostTotal: string; earned: string; score: number;
}

/** Where a line vouch's line stands, read at the head. */
interface LineSubject { kind: "line"; key: string | null; debt: string; dueAt: number; defaulted: boolean }
/** Where a cover vouch's cover and its desk job stand, read at the head. */
interface CoverSubject { kind: "cover"; state: (typeof COVER_STATES)[number]; job: number; customer: string; price: string; amount: string; jobState: number; dueAt: number; deliveredAt: number }
type Subject = LineSubject | CoverSubject;

export interface VouchingDeps {
  cfg: VouchingConfig;
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
  /** a tie Factor's records show between an agent and another wallet, in words, or null (the checks reviews use) */
  ties: (agent: string, other: string) => Promise<string | null>;
  /** one of Factor's own wallets: its house agents, its test agents and demo wallets */
  factorOwn: (address: string) => boolean;
}

/** The totals, read from the contract. */
export interface VouchTotals { bonds: string; held: string; feesHeld: string; owed: string; vouched: string; paid: string; earned: string; burned: string; vouches: number; at: number }

/** The addresses the vouching contract reads, read from it once. */
interface Wiring { line: string; guarantee: string; desk: string }

export class Vouching {
  private totalsReadAt = 0;

  constructor(readonly d: VouchingDeps) {}

  /** Reading the chain: switched on and a contract to read. */
  reading(): boolean {
    return this.d.cfg.enabled && !!this.d.cfg.contract && this.d.cfg.fromBlock !== null;
  }

  /** Shown and kept: reading, and the owner has not stopped it. */
  on(): boolean {
    return this.reading() && !stopped(this.d.db, "vouching");
  }

  // ---------- the books ----------

  vouch(id: number): VouchRow | null {
    return (this.d.db.q("SELECT * FROM vouch_vouches WHERE id = ?").get(id) as VouchRow | undefined) ?? null;
  }

  vouches(o: { agent?: string; voucher?: string; kind?: VouchKind; subject?: string; state?: VouchState; limit?: number }): VouchRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (o.agent) { where.push("agent = ?"); args.push(o.agent); }
    if (o.voucher) { where.push("voucher = ?"); args.push(o.voucher); }
    if (o.kind) { where.push("kind = ?"); args.push(o.kind); }
    if (o.subject) { where.push("subject = ?"); args.push(o.subject); }
    if (o.state) { where.push("state = ?"); args.push(o.state); }
    return this.d.db.q(`SELECT * FROM vouch_vouches ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, o.limit ?? 30) as VouchRow[];
  }

  private voucherRow(voucher: string): VoucherRow | null {
    return (this.d.db.q("SELECT * FROM vouch_vouchers WHERE voucher = ?").get(voucher) as VoucherRow | undefined) ?? null;
  }

  voucherState(voucher: string): VoucherState | null {
    const r = this.voucherRow(voucher);
    if (!r) return null;
    const s = JSON.parse(r.state) as Partial<VoucherState>;
    return {
      bond: s.bond ?? "0", held: s.held ?? "0", vouches: s.vouches ?? 0, kept: s.kept ?? 0, failed: s.failed ?? 0, returned: s.returned ?? 0,
      vouchedTotal: s.vouchedTotal ?? "0", lostTotal: s.lostTotal ?? "0", earned: s.earned ?? "0", score: s.score ?? 0,
    };
  }

  totals(): VouchTotals | null {
    return this.d.db.getJson<VouchTotals>("vouching:totals");
  }

  private wiring(): Wiring | null {
    return this.d.db.getJson<Wiring>("vouching:wiring");
  }

  /** The desk address an agent works from, as the contract counts it: a line account when the wallet has one. */
  agentOf(address: string): string {
    const row = this.d.db.q("SELECT account FROM lines WHERE key = ?").get(address) as { account: string } | undefined;
    if (row) return row.account;
    // credit lines not read: the key as the line contract named it when a vouch's line was read
    const seen = this.d.db.q("SELECT subject FROM vouch_vouches WHERE kind = 'line' AND json_extract(subject_state, '$.key') = ? LIMIT 1").get(address) as { subject: string } | undefined;
    return seen?.subject ?? address;
  }

  // ---------- reading the chain ----------

  /** One log of the vouching contract's, written down. Returns a line for the engine's log, when it is worth one. Exported for the tests. */
  apply(log: ChainLog, at: number): string | null {
    const e = decode({ name: "vouch" as never, abi: VT }, log, at);
    if (!e) return null;
    e.contract = "vouch";
    if (!this.d.db.addEvent(e)) return null;
    return this.effect(e);
  }

  /** A voucher seen: read again at once. */
  private dirty(voucher: string, block: number): void {
    this.d.db.q("INSERT INTO vouch_vouchers (voucher, block) VALUES (?, ?) ON CONFLICT(voucher) DO UPDATE SET state_at = 0").run(voucher, block);
  }

  private name(address: string): string {
    const p = this.d.names().get(address);
    return p && !p.hidden ? p.name : shortAddress(address);
  }

  private effect(e: EventRow): string | null {
    const db = this.d.db;
    const a = e.args;
    const voucher = normalizeAddress(a.voucher) ?? null;
    if (e.event === "BondAdded" && voucher) {
      this.dirty(voucher, e.block);
      return `${ethText(String(a.amount))} ETH into ${this.name(voucher)}'s vouching bond`;
    }
    if (e.event === "BondTaken" && voucher) {
      this.dirty(voucher, e.block);
      return `${this.name(voucher)} took ${ethText(String(a.amount))} ETH out of its vouching bond`;
    }
    if (e.event === "Offered" && voucher) {
      const id = Number(a.id);
      const agent = normalizeAddress(a.agent)!;
      const kind = KINDS[Number(a.kind)] ?? "line";
      const subject = kind === "line" ? normalizeAddress(`0x${BigInt(String(a.subject)).toString(16).padStart(40, "0")}`)! : String(a.subject);
      db.q("INSERT OR IGNORE INTO vouch_vouches (id, block, at, tx_hash, voucher, agent, kind, subject, amount, fee, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id, e.block, e.at, e.tx_hash, voucher, agent, kind, subject, String(a.amount), String(a.fee), Number(a.expiresAt),
      );
      this.dirty(voucher, e.block);
      return `vouch ${id}: ${this.name(voucher)} offers to co-sign ${this.name(agent)}'s ${kind === "line" ? "credit line" : `cover ${subject}`} for ${ethText(String(a.amount))} ETH`;
    }
    if (e.event === "Accepted") {
      const id = Number(a.id);
      db.q("UPDATE vouch_vouches SET state = 'active', started_at = ?, ends_at = ?, payer = ?, accepted_tx = ?, read_at = 0 WHERE id = ? AND state = 'offered'").run(e.at, Number(a.endsAt) || null, normalizeAddress(a.payer), e.tx_hash, id);
      const v = this.vouch(id);
      if (v) this.dirty(v.voucher, e.block);
      return v ? `vouch ${id}: ${this.name(v.agent)} accepted ${this.name(v.voucher)}'s vouch and paid its fee` : null;
    }
    if (e.event === "Withdrawn" && voucher) {
      const id = Number(a.id);
      db.q("UPDATE vouch_vouches SET state = 'withdrawn', ended_tx = ?, ended_at = ? WHERE id = ?").run(e.tx_hash, e.at, id);
      this.dirty(voucher, e.block);
      return `vouch ${id}: the offer was withdrawn`;
    }
    if (e.event === "Settled" && voucher) {
      const id = Number(a.id);
      const how = STATES[Number(a.how)] ?? "kept";
      const paidTo = normalizeAddress(a.paidTo);
      db.q("UPDATE vouch_vouches SET state = ?, ended_tx = ?, ended_at = ?, to_voucher = ?, burned = ?, paid = ?, paid_to = ?, fee_back = ? WHERE id = ?").run(
        how, e.tx_hash, e.at, String(a.toVoucher), String(a.burned), String(a.paid), paidTo && paidTo !== ZERO ? paidTo : null, String(a.feeBack), id,
      );
      this.dirty(voucher, e.block);
      const agent = normalizeAddress(a.agent) ?? "";
      if (how === "failed") return `vouch ${id}: ${this.name(agent)} did not repay or deliver; ${ethText(String(a.paid))} ETH paid from the fee and ${this.name(voucher)}'s vouching bond`;
      if (how === "returned") return `vouch ${id}: the covered job was declined, the fee went back`;
      return `vouch ${id}: kept; ${this.name(voucher)} earned ${ethText(String(a.toVoucher))} ETH`;
    }
    if (e.event === "Owed") return `${ethText(String(a.amount))} ETH waits in the vouching contract for ${shortAddress(normalizeAddress(a.who) ?? "")}, who refused it`;
    return null;
  }

  /** One pass of the vouching contract's logs, from where the last stopped to the safe head. Returns the lines worth logging. */
  async watch(ctx: Ctx, head: Head): Promise<string[]> {
    if (!this.reading()) return [];
    const { db, chain } = this.d;
    const safe = head.number - BigInt(ctx.params.confirmations);
    const start = (db.cursor("vouching") ?? this.d.cfg.fromBlock! - 1n) + 1n;
    if (start > safe) return [];
    const lines: string[] = [];
    const span = BigInt(ctx.params.logSpan);
    let from = start;
    for (let n = 0; n < ctx.params.spansPerPass && from <= safe; n++) {
      const to = from + span - 1n > safe ? safe : from + span - 1n;
      let logs: ChainLog[] = [];
      await readLogs(chain, from, to, { address: [this.d.cfg.contract!] }, to - from + 1n, (got) => { logs = got; }, 1);
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
        db.setCursor("vouching", to);
      });
      from = to + 1n;
    }
    for (const l of lines) this.d.log(`[vouching] ${l}`);
    if (lines.length) this.totalsReadAt = 0;
    return lines;
  }

  /**
   * What is read rather than logged: the contract's wiring once; each voucher's bond, record and score, the stalest first,
   * every two minutes at most; each open vouch's line or cover and its desk job, every minute; the ties of each vouch
   * once an hour; and the totals every half minute.
   */
  async refresh(): Promise<void> {
    if (!this.reading()) return;
    const { db, chain } = this.d;
    const vc = this.d.cfg.contract!;
    const V = <T>(fn: string, args: unknown[] = []) => chain.read<T>({ to: vc, abi: VT, functionName: fn, args });
    let w = this.wiring();
    if (!w) {
      const [line, guarantee, desk] = await Promise.all([V<string>("line"), V<string>("guarantee"), V<string>("desk")]);
      w = { line: normalizeAddress(line)!, guarantee: normalizeAddress(guarantee)!, desk: normalizeAddress(desk)! };
      db.setJson("vouching:wiring", w);
    }
    const stale = db.q("SELECT * FROM vouch_vouchers ORDER BY state_at LIMIT 25").all() as VoucherRow[];
    await Promise.all(stale.filter((r) => r.state_at === 0 || this.d.now() - r.state_at > 120_000).map(async (r) => {
      const [b, score] = await Promise.all([
        V<{ bond: bigint; held: bigint; vouches: number | bigint; kept: number | bigint; failed: number | bigint; returned: number | bigint; vouchedTotal: bigint; lostTotal: bigint; earned: bigint }>("voucherOf", [r.voucher]),
        V<bigint>("scoreOf", [r.voucher]),
      ]);
      const s: VoucherState = {
        bond: b.bond.toString(), held: b.held.toString(), vouches: Number(b.vouches), kept: Number(b.kept), failed: Number(b.failed), returned: Number(b.returned),
        vouchedTotal: b.vouchedTotal.toString(), lostTotal: b.lostTotal.toString(), earned: b.earned.toString(), score: Number(score),
      };
      db.q("UPDATE vouch_vouchers SET state = ?, state_at = ? WHERE voucher = ?").run(JSON.stringify(s), this.d.now(), r.voucher);
    }));
    // each open vouch's line or cover, as the line contract, the guarantee contract and the desk have it
    const open = db.q("SELECT * FROM vouch_vouches WHERE state IN ('offered', 'active') AND ? - read_at > 60000 ORDER BY read_at LIMIT 25").all(this.d.now()) as VouchRow[];
    const wired = w;
    await Promise.all(open.map(async (v) => {
      const subject = await this.readSubject(v, wired);
      const debtAtOffer = v.state === "offered" || v.debt_at_offer === "0" ? (await V<{ debtAtOffer: bigint }>("vouch", [BigInt(v.id)])).debtAtOffer.toString() : v.debt_at_offer;
      db.q("UPDATE vouch_vouches SET subject_state = ?, debt_at_offer = ?, read_at = ? WHERE id = ?").run(JSON.stringify(subject), debtAtOffer, this.d.now(), v.id);
    }));
    // the ties Factor's records show between the voucher and the agent, once an hour
    const untied = db.q("SELECT * FROM vouch_vouches WHERE ? - ties_at > 3600000 ORDER BY ties_at LIMIT 25").all(this.d.now()) as VouchRow[];
    for (const v of untied) {
      const found = await this.findTies(v);
      db.q("UPDATE vouch_vouches SET ties = ?, ties_at = ? WHERE id = ?").run(JSON.stringify(found), this.d.now(), v.id);
    }
    if (this.d.now() - this.totalsReadAt > 30_000) {
      this.totalsReadAt = this.d.now();
      const [bonds, held, feesHeld, owed, vouched, paid, earned, burned, count] = await Promise.all([
        V<bigint>("bonds"), V<bigint>("held"), V<bigint>("feesHeld"), V<bigint>("owedTotal"), V<bigint>("totalVouched"), V<bigint>("totalPaid"), V<bigint>("totalEarned"), V<bigint>("totalBurned"), V<bigint>("vouchCount"),
      ]);
      db.setJson("vouching:totals", { bonds: bonds.toString(), held: held.toString(), feesHeld: feesHeld.toString(), owed: owed.toString(), vouched: vouched.toString(), paid: paid.toString(), earned: earned.toString(), burned: burned.toString(), vouches: Number(count), at: this.d.now() } satisfies VouchTotals);
    }
  }

  private async readSubject(v: VouchRow, w: Wiring): Promise<Subject> {
    const { chain } = this.d;
    if (v.kind === "line") {
      const l = await chain.read<{ key: string; dueAt: number | bigint; defaulted: boolean; debt: bigint }>({ to: w.line, abi: factorLineAbi as Abi, functionName: "line", args: [v.subject] });
      const key = normalizeAddress(l.key);
      return { kind: "line", key: key && key !== ZERO ? key : null, debt: l.debt.toString(), dueAt: Number(l.dueAt), defaulted: !!l.defaulted };
    }
    const c = await chain.read<{ state: number | bigint; job: bigint; customer: string; price: bigint; amount: bigint }>({ to: w.guarantee, abi: factorGuaranteeAbi as Abi, functionName: "cover", args: [BigInt(v.subject)] });
    const job = Number(c.job);
    const j = job > 0 ? await chain.read<{ state: number | bigint; dueAt: number | bigint; deliveredAt: number | bigint }>({ to: w.desk, abi: factorDeskAbi as Abi, functionName: "job", args: [BigInt(job)] }) : null;
    return {
      kind: "cover", state: COVER_STATES[Number(c.state)] ?? "none", job, customer: normalizeAddress(c.customer) ?? ZERO, price: c.price.toString(), amount: c.amount.toString(),
      jobState: j ? Number(j.state) : 0, dueAt: j ? Number(j.dueAt) : 0, deliveredAt: j ? Number(j.deliveredAt) : 0,
    };
  }

  private subjectOf(v: VouchRow): Subject | null {
    const s = JSON.parse(v.subject_state || "{}") as Partial<Subject>;
    return s.kind ? (s as Subject) : null;
  }

  /** The ties Factor's records show between a vouch's voucher and its agent, both ways round, in words. */
  async findTies(v: VouchRow): Promise<string[]> {
    const out = new Set<string>();
    for (const [a, b] of [[v.agent, v.voucher], [v.voucher, v.agent]] as const) {
      const why = await this.d.ties(a, b).catch(() => null);
      if (why) out.add(why);
    }
    // a line account's key is the same agent: a tie of the key counts too
    const key = this.keyOf(v.agent);
    if (key && key !== v.agent) {
      const why = await this.d.ties(key, v.voucher).catch(() => null);
      if (why) out.add(why);
    }
    return [...out];
  }

  private keyOf(account: string): string | null {
    const row = this.d.db.q("SELECT key FROM lines WHERE account = ?").get(account) as { key: string } | undefined;
    if (row) return row.key;
    const seen = this.d.db.q("SELECT json_extract(subject_state, '$.key') AS key FROM vouch_vouches WHERE kind = 'line' AND subject = ? AND json_extract(subject_state, '$.key') IS NOT NULL LIMIT 1").get(account) as { key: string } | undefined;
    return seen?.key ?? null;
  }

  /** One of Factor's own: the wallet, or the key of its line account. */
  own(address: string): boolean {
    const key = this.keyOf(address);
    return this.d.factorOwn(address) || (!!key && this.d.factorOwn(key));
  }

  // ---------- the keeper ----------

  /** What settle(id) would do now, by the contract's own rule, from what was last read: null while nothing would. */
  settleable(v: VouchRow, t: number): "kept" | "failed" | "returned" | "recover" | "close" | null {
    if (v.state !== "active") return null;
    const s = this.subjectOf(v);
    if (!s) return null;
    if (s.kind === "line") {
      const debt = BigInt(s.debt);
      if (!s.defaulted && debt > 0n && t > s.dueAt + VOUCH_RULES.lineDefaultAfterS) return "recover";
      const backed = debt > 0n && s.dueAt - VOUCH_RULES.lineDueS <= (v.ends_at ?? 0);
      if (s.defaulted && backed) return "failed";
      if (t > (v.ends_at ?? 0) && !backed) return "kept";
      return null;
    }
    if (s.state === "released") return "kept";
    if (s.state === "paid") return "failed";
    if (s.state === "declined") return "returned";
    if (s.state !== "bound") return null;
    if (s.jobState === STATE.settled || s.jobState === STATE.half || s.jobState === STATE.declined || s.jobState === STATE.refunded) return "close";
    if ((s.jobState === STATE.locked || s.jobState === STATE.advanced) && t > s.dueAt + VOUCH_RULES.graceS) return "close";
    if (s.jobState === STATE.delivered && s.deliveredAt > 0 && t >= s.deliveredAt + VOUCH_RULES.reviewS) return "close";
    return null;
  }

  /**
   * The keeper's turn (./chain/act.ts calls it as the step "vouch", after the line's own sweeps and recoveries): a standing
   * vouch whose outcome is on the chain is settled, the ones that pay a loss first; an offer past its seven days is
   * withdrawn. A few a pass.
   */
  async step(ctx: Ctx, head: Head, attempt: (kind: "vouch", ref: string, call: CallSpec, detail: Record<string, unknown>, feeCap: bigint) => Promise<{ status: string; why: string; hash?: string }>): Promise<string> {
    if (!this.reading()) return "vouching is not switched on";
    if (stopped(this.d.db, "vouching")) return "vouching is stopped by the owner";
    const db = this.d.db;
    const t = head.timestamp;
    const vc = this.d.cfg.contract!;
    const said: string[] = [];
    let n = 0;
    const ready = (ref: string): boolean => {
      const prev = db.lastAction("vouch", ref);
      if (!prev) return true;
      if (prev.status === "signed" || prev.status === "sent") return false;
      if (prev.status === "done") return this.d.now() - prev.updated_at > 120_000;
      if (prev.status === "failed") return this.d.now() - prev.updated_at > 600_000;
      if (prev.status === "dry") return this.d.now() - prev.created_at > 1_800_000;
      return true;
    };
    const go = async (ref: string, fn: string, id: number, detail: Record<string, unknown>, words: string): Promise<boolean> => {
      if (!ready(ref)) return false;
      n++;
      const out = await attempt("vouch", ref, { to: vc, abi: VT, functionName: fn, args: [BigInt(id)] }, detail, ctx.params.maxGasWei);
      said.push(`${out.status === "dry" ? `would ${words}` : out.status === "done" ? words : `${words}: ${out.status}`}${out.status === "failed" || out.status === "skipped" ? ` (${out.why})` : ""}`);
      if (out.status === "done") db.q("UPDATE vouch_vouches SET read_at = 0 WHERE id = ?").run(id);
      return db.openActions().length > 0;
    };
    const active = (db.q("SELECT * FROM vouch_vouches WHERE state = 'active' ORDER BY id").all() as VouchRow[])
      .map((v) => ({ v, how: this.settleable(v, t) }))
      .filter((x) => x.how !== null)
      .sort((a, b) => Number(b.how === "failed" || b.how === "recover" || b.how === "close") - Number(a.how === "failed" || a.how === "recover" || a.how === "close"));
    for (const { v, how } of active) {
      if (n >= this.d.cfg.perPass || ctx.stopping()) break;
      const words = how === "kept" ? `settle vouch ${v.id}: kept` : how === "returned" ? `settle vouch ${v.id}: returned` : how === "failed" ? `settle vouch ${v.id}: the loss paid from its bond` : how === "recover" ? `settle vouch ${v.id}, recovering its line first` : `settle vouch ${v.id}, closing its cover first`;
      if (await go(`settle:${v.id}`, "settle", v.id, { vouch: v.id, kind: v.kind, voucher: v.voucher, agent: v.agent, amount: v.amount, how }, words)) break;
    }
    const offered = db.q("SELECT * FROM vouch_vouches WHERE state = 'offered' AND expires_at < ? ORDER BY id").all(t - 60) as VouchRow[];
    for (const v of offered) {
      if (n >= this.d.cfg.perPass || ctx.stopping()) break;
      if (await go(`withdraw:${v.id}`, "withdraw", v.id, { vouch: v.id, voucher: v.voucher }, `withdraw vouch ${v.id}'s offer, never accepted`)) break;
    }
    return said.length ? said.join("; ") : "no vouch needs settling or withdrawing";
  }

  // ---------- what the site and the kit read ----------

  about(): VouchingAbout {
    const on = this.on();
    const t = this.totals();
    const standing = on ? (this.d.db.q("SELECT COUNT(*) AS n FROM vouch_vouches WHERE state = 'active'").get() as { n: number }).n : 0;
    return {
      enabled: on, contract: this.d.cfg.contract, chainId: this.d.chainId,
      rules: { minScore: VOUCH_RULES.minScore, maxSharePct: VOUCH_RULES.maxSharePct, feePct: VOUCH_RULES.feePct, voucherPctOfFee: VOUCH_RULES.voucherPctOfFee, minVouchEth: VOUCH_RULES.minVouchEth, lineTermDays: VOUCH_RULES.lineTermDays, offerDays: VOUCH_RULES.offerDays },
      totals: on && t ? { bondsEth: ethNum(t.bonds), heldEth: ethNum(t.held), vouchedEth: ethNum(t.vouched), paidEth: ethNum(t.paid), earnedEth: ethNum(t.earned), burnedEth: ethNum(t.burned), vouches: t.vouches, standing } : null,
    };
  }

  /** One vouch as the site shows it. */
  json(v: VouchRow): VouchJson {
    const nowS = this.d.nowS();
    const s = this.subjectOf(v);
    const ties = v.ties ? (JSON.parse(v.ties) as string[]) : [];
    const factorOwn = this.own(v.voucher);
    let next: VouchJson["next"] | undefined;
    if (v.state === "offered") next = { what: nowS <= v.expires_at ? "accept" : "lapsed", at: iso(v.expires_at) };
    else if (v.state === "active") {
      const how = this.settleable(v, nowS);
      if (how) next = { what: "settle", at: iso(nowS) };
      else if (v.kind === "line") {
        const owes = s?.kind === "line" && BigInt(s.debt) > 0n && s.dueAt - VOUCH_RULES.lineDueS <= (v.ends_at ?? 0);
        next = owes && nowS > (v.ends_at ?? 0) ? { what: "waits-for-repayment", at: iso((s as LineSubject).dueAt + VOUCH_RULES.lineDefaultAfterS) } : { what: "ends", at: iso(v.ends_at ?? 0) };
      } else if (s?.kind === "cover") {
        if (s.jobState === STATE.delivered) next = { what: "kept-when-settled", at: iso(s.deliveredAt + VOUCH_RULES.reviewS) };
        else next = { what: "pays-if-not-delivered", at: iso(s.dueAt + VOUCH_RULES.graceS) };
      }
    }
    return {
      id: v.id, kind: v.kind, state: v.state,
      voucher: v.voucher, voucherName: this.name(v.voucher), voucherNamed: this.d.names().has(v.voucher),
      agent: v.agent, agentName: this.name(v.agent), agentNamed: this.d.names().has(v.agent), agentKey: this.keyOf(v.agent),
      amountEth: ethNum(v.amount), amountWei: v.amount, feeEth: ethNum(v.fee), feeWei: v.fee,
      offeredAt: iso(v.at), expiresAt: iso(v.expires_at), tx: v.tx_hash,
      ...(v.started_at ? { startedAt: iso(v.started_at), acceptedTx: v.accepted_tx ?? "" } : {}),
      ...(v.kind === "line" && v.ends_at ? { endsAt: iso(v.ends_at) } : {}),
      ...(v.kind === "line" ? { line: { account: v.subject, ...(s?.kind === "line" ? { owesEth: ethNum(s.debt), dueAt: s.dueAt ? iso(s.dueAt) : null, late: BigInt(s.debt) > 0n && nowS > s.dueAt, defaulted: s.defaulted } : {}), owedAtOfferEth: ethNum(v.debt_at_offer) } } : {}),
      ...(v.kind === "cover" ? { cover: { id: Number(v.subject), ...(s?.kind === "cover" ? { job: s.job ? String(s.job).padStart(4, "0") : null, customer: s.customer, priceEth: ethNum(s.price), coverEth: ethNum(s.amount), state: s.state } : {}) } } : {}),
      ...(v.ended_tx ? { endedTx: v.ended_tx, endedAt: iso(v.ended_at ?? 0), toVoucherEth: ethNum(v.to_voucher), burnedEth: ethNum(v.burned), paidEth: ethNum(v.paid), paidTo: v.paid_to, feeBackEth: ethNum(v.fee_back) } : {}),
      ...(next ? { next } : {}),
      ties, factorOwn, counts: !factorOwn && ties.length === 0,
    };
  }

  /** A voucher as the site shows it, or null when it never bonded. */
  voucherJson(address: string, full = false): VoucherJson | null {
    if (!this.on()) return null;
    const s = this.voucherState(address);
    if (!s) return null;
    const bond = BigInt(s.bond), held = BigInt(s.held);
    const out: VoucherJson = {
      voucher: address, name: this.name(address), named: this.d.names().has(address), factorOwn: this.own(address),
      bondEth: ethNum(s.bond), heldEth: ethNum(s.held), freeEth: ethNum((bond - held).toString()), freeWei: (bond - held).toString(),
      perAgentEth: ethNum(((bond * BigInt(VOUCH_RULES.maxSharePct)) / 100n).toString()),
      score: s.score, strong: s.score >= VOUCH_RULES.minScore,
      vouches: s.vouches, kept: s.kept, failed: s.failed, returned: s.returned,
      standing: (this.d.db.q("SELECT COUNT(*) AS n FROM vouch_vouches WHERE voucher = ? AND state = 'active'").get(address) as { n: number }).n,
      vouchedEth: ethNum(s.vouchedTotal), lostEth: ethNum(s.lostTotal), earnedEth: ethNum(s.earned),
    };
    if (full) out.items = this.vouches({ voucher: address, limit: 30 }).map((v) => this.json(v));
    return out;
  }

  /** An agent's vouches, received and given, as its page shows them; null while vouching is off or it has none. */
  agentJson(address: string): AgentVouchingJson | null {
    if (!this.on()) return null;
    const agent = this.agentOf(address);
    const received = this.vouches({ agent, limit: 30 }).filter((v) => v.state !== "withdrawn").map((v) => this.json(v));
    const asVoucher = this.voucherJson(agent, true);
    if (!received.length && !asVoucher) return null;
    const counted = received.filter((v) => v.counts);
    return {
      agent, received,
      standing: counted.filter((v) => v.state === "active").length,
      backedEth: counted.filter((v) => v.state === "active").reduce((n, v) => n + v.amountEth, 0),
      kept: counted.filter((v) => v.state === "kept").length,
      failed: counted.filter((v) => v.state === "failed").length,
      notCounted: received.length - counted.length,
      voucher: asVoucher,
    };
  }

  /** What an agent's record carries: the vouches that count, standing and how they ended. */
  recordOf(address: string): { standing: number; backedEth: number; kept: number; failed: number } | null {
    const j = this.agentJson(address);
    return j && (j.standing || j.kept || j.failed) ? { standing: j.standing, backedEth: j.backedEth, kept: j.kept, failed: j.failed } : null;
  }

  /** The vouches on one credit line or one cover. */
  onSubject(kind: VouchKind, subject: string): VouchJson[] {
    if (!this.on()) return [];
    return this.vouches({ kind, subject, limit: 30 }).filter((v) => v.state !== "withdrawn").map((v) => this.json(v));
  }

  list(o: { state?: VouchState; agent?: string; voucher?: string } = {}): { vouchers: VoucherJson[]; factorOwn: VoucherJson[]; items: VouchJson[] } {
    if (!this.on()) return { vouchers: [], factorOwn: [], items: [] };
    const all = (this.d.db.q("SELECT voucher FROM vouch_vouchers").all() as { voucher: string }[]).map((r) => this.voucherJson(r.voucher)!).filter((x) => x && (x.bondEth > 0 || x.vouches > 0));
    // ranked by vouches kept, then standing, then the bond; Factor's own apart
    const rank = (a: VoucherJson, b: VoucherJson) => b.kept - a.kept || b.standing - a.standing || b.bondEth - a.bondEth;
    const items = this.vouches({ ...(o.state ? { state: o.state } : {}), ...(o.agent ? { agent: this.agentOf(o.agent) } : {}), ...(o.voucher ? { voucher: this.agentOf(o.voucher) } : {}), limit: 30 }).map((v) => this.json(v));
    return { vouchers: all.filter((x) => !x.factorOwn).sort(rank), factorOwn: all.filter((x) => x.factorOwn).sort(rank), items };
  }

  /** For the owner's health answer. */
  health(): Record<string, unknown> {
    const count = (state: string) => (this.d.db.q("SELECT COUNT(*) AS n FROM vouch_vouches WHERE state = ?").get(state) as { n: number }).n;
    return { reading: this.reading(), on: this.on(), contract: this.d.cfg.contract, offered: count("offered"), active: count("active"), failed: count("failed"), totals: this.totals(), note: this.d.cfg.note };
  }
}

/** What vouching is, as the site and the kit read it: web/src/lib/types.ts keeps the same shape by hand. */
export interface VouchingAbout {
  enabled: boolean; contract: string | null; chainId: number;
  rules: { minScore: number; maxSharePct: number; feePct: number; voucherPctOfFee: number; minVouchEth: number; lineTermDays: number; offerDays: number };
  totals: { bondsEth: number; heldEth: number; vouchedEth: number; paidEth: number; earnedEth: number; burnedEth: number; vouches: number; standing: number } | null;
}

export interface VouchJson {
  id: number;
  /** line: a credit line, by its line account. cover: a cover on one desk job, by its number in the guarantee contract */
  kind: VouchKind;
  /** offered: waiting for the agent. active: standing. kept: repaid or delivered. failed: the loss paid. returned: the job was declined. withdrawn: never accepted */
  state: VouchState;
  voucher: string; voucherName: string; voucherNamed: boolean;
  agent: string; agentName: string; agentNamed: boolean; agentKey: string | null;
  amountEth: number; amountWei: string; feeEth: number; feeWei: string;
  offeredAt: string; expiresAt: string; tx: string;
  startedAt?: string; acceptedTx?: string; endsAt?: string;
  line?: { account: string; owesEth?: number; dueAt?: string | null; late?: boolean; defaulted?: boolean; owedAtOfferEth: number };
  cover?: { id: number; job?: string | null; customer?: string; priceEth?: number; coverEth?: number; state?: string };
  endedTx?: string; endedAt?: string; toVoucherEth?: number; burnedEth?: number; paidEth?: number; paidTo?: string | null; feeBackEth?: number;
  /** what happens next, and from when */
  next?: { what: "accept" | "lapsed" | "settle" | "ends" | "waits-for-repayment" | "kept-when-settled" | "pays-if-not-delivered"; at: string };
  /** ties Factor's records show between the voucher and the agent, in words */
  ties: string[];
  /** the voucher is one of Factor's own */
  factorOwn: boolean;
  /** counted toward the agent's standing: not Factor's own and no tie */
  counts: boolean;
}

export interface VoucherJson {
  voucher: string; name: string; named: boolean; factorOwn: boolean;
  bondEth: number; heldEth: number; freeEth: number; freeWei: string;
  /** the most it can hold back for one agent: a quarter of its bond */
  perAgentEth: number;
  /** the score the contract counts, and whether it is strong enough to offer */
  score: number; strong: boolean;
  vouches: number; kept: number; failed: number; returned: number; standing: number;
  vouchedEth: number; lostEth: number; earnedEth: number;
  items?: VouchJson[];
}

export interface AgentVouchingJson {
  agent: string;
  received: VouchJson[];
  /** the vouches that count: standing now, the ETH behind them, and how the ended ones went */
  standing: number; backedEth: number; kept: number; failed: number;
  /** shown and not counted: a voucher of Factor's own, or one Factor's records tie to the agent */
  notCounted: number;
  /** its own record as a voucher, when it has bonded */
  voucher: VoucherJson | null;
}

const iso = (s: number): string => new Date(s * 1000).toISOString();
// every digit kept: a vouch's fee and its halves are often under a millionth of an ETH
const ethNum = (wei: string): number => Number(formatEther(BigInt(wei)));
const ethText = (wei: string): string => {
  const n = ethNum(wei);
  return n >= 0.01 ? n.toFixed(4) : n.toFixed(6);
};
