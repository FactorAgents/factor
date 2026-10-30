// Credit lines (docs/CREDIT-LINES.md; contracts/src/FactorLine.sol): credit with no job behind it, paid back from
// the agent's next income.
//
// What the engine does with them:
//
//   reads     the line contract's Opened, Drawn, Repaid, Defaulted and PoolIn, each into chain_events and the line's
//             own list of moves (not the desk's ledger: switched off, lines leave no trace on the desk's pages). What a
//             line IS (its debt, due time, record, limit and room, what its account holds) is read from the contracts
//             themselves at the head, as the desk's rows are
//   credits   a draw as compute: the ETH reached the gateway, and it becomes a lot of compute credit for the agent's
//             key (./compute.ts), priced at the ETH price of the moment. When the line is repaid in full what is left
//             of the lot is the agent's to keep; when it defaults the line pool takes back what was not spent, and the
//             keeper sends that ETH to the line contract (return_compute, ./chain/act.ts)
//   sweeps    income waiting in a line account that owes: the keeper calls the account's sweep() once what waits is
//             worth the gas, or whatever it is when the line is due within a day, so money that is there is never
//             counted late
//   recovers  a line still owed 30 days past its due time: recover() takes the account's bond and its ETH, and what is
//             left defaults. After a default, again whenever the account has ETH or a free bond
//   scores    an agent's record carries over: its key's and its line account's desk records count as one, a line
//             repaid on time counts as an advance repaid, a late repayment takes 50 points off as a job settled at half
//             does, and a default sets the score to 0
//   signs     a line account answers ERC-1271 for its key, so whatever Factor asks an agent to sign works for its
//             line account too (signed(), below)
//
//   GET  /v1/lines               the pool, the rules and every line
//   GET  /v1/lines/about         whether lines are on, the contract and the pool
//   GET  /v1/lines/<id>          one line, by its key or its account (address or the agent's name)
//
// Switches: LINES=on (off unless it is said), with FACTOR_LINE and FACTOR_LINE_BLOCK; and the owner's "lines" switch
// (./switches.ts), which hides lines and stops the keeper's sweeps and recoveries at once. Nothing an agent does on the
// chain depends on either: open, draw, repay, sweep and recover are open to everybody.

import { hashMessage, type Abi } from "viem";
import { factorDeskAbi, factorLineAbi, factorLineAccountAbi } from "./abi/index.js";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import { readLogs, revertOf, reason, nodeBusy, type CallSpec, type Chain, type ChainLog, type Head } from "./chain/chain.js";
import { snapshotOf, type Ctx } from "./chain/context.js";
import type { EngineDb, EventRow } from "./chain/db.js";
import { decode } from "./chain/watch.js";
import { ComputeStore } from "./compute.js";
import type { AgentRecord } from "./desk.js";
import { scoreOf } from "./score.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export interface LinesConfig {
  /** LINES=on: off unless it is said */
  enabled: boolean;
  /** FACTOR_LINE: the line contract, once deployed (contracts/deploy-lines.sh writes it) */
  line: string | null;
  /** FACTOR_LINE_BLOCK: the block to read lines from */
  fromBlock: bigint | null;
  /** LINES_SWEEP_MIN_WEI: the least the keeper sweeps from an account, unless its line is due within a day */
  sweepMinWei: bigint;
  /** LINES_PER_PASS: how many lines the keeper looks at in one pass */
  perPass: number;
  /** why it is on and cannot run, when it cannot */
  note: string | null;
}

export function readLines(env: Env, problems: string[] = []): LinesConfig {
  const on = (env.LINES ?? "").trim().toLowerCase() === "on";
  const raw = env.FACTOR_LINE?.trim();
  const line = raw ? normalizeAddress(raw) : null;
  if (raw && !line) problems.push(`FACTOR_LINE is not an address: "${raw}"`);
  const rawBlock = env.FACTOR_LINE_BLOCK?.trim();
  let fromBlock: bigint | null = null;
  if (rawBlock) {
    if (/^\d+$/.test(rawBlock)) fromBlock = BigInt(rawBlock);
    else problems.push(`FACTOR_LINE_BLOCK must be a block number: it is "${rawBlock}"`);
  }
  const rawMin = env.LINES_SWEEP_MIN_WEI?.trim();
  let sweepMinWei = 20_000_000_000_000n; // 0.00002 ETH, about ten times what a sweep costs in gas
  if (rawMin) {
    if (/^\d+$/.test(rawMin)) sweepMinWei = BigInt(rawMin);
    else problems.push(`LINES_SWEEP_MIN_WEI must be whole wei, as digits: it is "${rawMin}"`);
  }
  const rawPer = env.LINES_PER_PASS?.trim();
  let perPass = 5;
  if (rawPer) {
    if (/^\d+$/.test(rawPer) && Number(rawPer) >= 1 && Number(rawPer) <= 100) perPass = Number(rawPer);
    else problems.push(`LINES_PER_PASS must be a whole number from 1 to 100: it is "${rawPer}"`);
  }
  let note: string | null = null;
  if (on && !line) note = "LINES is on and FACTOR_LINE is not set: there is no line contract to read yet";
  else if (on && fromBlock === null) note = "LINES is on and FACTOR_LINE_BLOCK is not set: the block to read lines from";
  return { enabled: on, line, fromBlock, sweepMinWei, perPass, note };
}

/** The rules, as the contract has them (FactorLine's constants): what the site and the kit say. */
export const LINE_RULES = {
  feePct: 2, burnPct: 1, poolPct: 1, dueDays: 30, defaultDays: 30, minDrawEth: 0.0001, poolOutMaxPct: 80,
  dueS: 30 * 86_400, defaultS: 30 * 86_400, minDrawWei: 100_000_000_000_000n,
} as const;

const LINE = factorLineAbi as Abi;
const ACCT = factorLineAccountAbi as Abi;
const DESK = factorDeskAbi as Abi;
const ERC1271_VALID = "0x1626ba7e";

export interface LineRow {
  account: string; key: string; block: number; at: number; tx_hash: string; state: string; state_at: number; swept_at: number; recovered_at: number;
}

/** What a line is, read at the head. Amounts in wei, as text; times in the chain's seconds. */
export interface LineState {
  debt: string; dueAt: number; defaulted: boolean; draws: number; onTime: number; late: number; drawn: string; repaid: string;
  limit: string; room: string; canDraw: string; balance: string; bond: string; feesPaid: string; deskOut: string; deskBarred: boolean; keyBarred: boolean;
}

export interface LinesDeps {
  cfg: LinesConfig;
  db: EngineDb;
  chain: Chain;
  chainId: number;
  desk: string;
  /** the chain's clock, seconds */
  nowS: () => number;
  /** the wall clock, ms */
  now: () => number;
  log: (line: string) => void;
  /** agents' names */
  names: () => Map<string, { name: string; hidden?: number }>;
  /** an agent's record as the desk keeps it, or null */
  record: (address: string) => AgentRecord | null;
}

/** The pool's figures, read from the line contract. */
export interface LinePoolState { pool: string; out: string; lost: string; room: string; owed: string; seeded: string; drawn: string; burned: string; feesToPool: string; repaid: string; recovered: string; lines: number; at: number }

export class Lines {
  private poolReadAt = 0;

  constructor(readonly d: LinesDeps) {}

  /** Reading the chain: switched on and a line contract to read. */
  reading(): boolean {
    return this.d.cfg.enabled && !!this.d.cfg.line && this.d.cfg.fromBlock !== null;
  }

  /** Shown and kept: reading, and the owner has not stopped it. */
  on(): boolean {
    return this.reading() && !stopped(this.d.db, "lines");
  }

  // ---------- the books ----------

  all(): LineRow[] {
    return this.d.db.q("SELECT * FROM lines ORDER BY block, rowid").all() as LineRow[];
  }

  byAccount(account: string): LineRow | null {
    return (this.d.db.q("SELECT * FROM lines WHERE account = ?").get(account) as LineRow | undefined) ?? null;
  }

  byKey(key: string): LineRow | null {
    return (this.d.db.q("SELECT * FROM lines WHERE key = ?").get(key) as LineRow | undefined) ?? null;
  }

  /** The line an address is part of, as its key or as its account. */
  of(address: string): LineRow | null {
    return this.byKey(address) ?? this.byAccount(address);
  }

  private byAny(id: string): LineRow | null {
    const a = normalizeAddress(id);
    if (a) return this.of(a);
    for (const [address, p] of this.d.names()) if (p.name === id && !p.hidden) return this.of(address);
    return null;
  }

  /** Whether an address is a line account Factor has seen. */
  isAccount(address: string): boolean {
    return !!this.byAccount(address);
  }

  private stateOf(r: LineRow): LineState {
    const s = JSON.parse(r.state) as Partial<LineState>;
    return {
      debt: s.debt ?? "0", dueAt: s.dueAt ?? 0, defaulted: !!s.defaulted, draws: s.draws ?? 0, onTime: s.onTime ?? 0, late: s.late ?? 0, drawn: s.drawn ?? "0", repaid: s.repaid ?? "0",
      limit: s.limit ?? "0", room: s.room ?? "0", canDraw: s.canDraw ?? "0", balance: s.balance ?? "0", bond: s.bond ?? "0", feesPaid: s.feesPaid ?? "0", deskOut: s.deskOut ?? "0",
      deskBarred: !!s.deskBarred, keyBarred: !!s.keyBarred,
    };
  }

  pool(): LinePoolState | null {
    return this.d.db.getJson<LinePoolState>("lines:pool");
  }

  // ---------- reading the chain ----------

  /** One log of the line contract's, written down. Returns a line for the engine's log, when it is worth one. Exported for the tests. */
  apply(log: ChainLog, at: number, ethUsd8: string | null): string | null {
    const e = decode({ name: "line" as never, abi: LINE }, log, at);
    if (!e) return null;
    e.contract = "line";
    if (!this.d.db.addEvent(e)) return null;
    return this.effect(e, ethUsd8);
  }

  private move(e: EventRow, account: string | null, kind: string, amount: string, extra: Record<string, unknown>): void {
    this.d.db.q("INSERT OR IGNORE INTO line_moves (tx_hash, log_index, block, at, account, kind, amount, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(e.tx_hash, e.log_index, e.block, e.at, account, kind, amount, JSON.stringify(extra));
  }

  private dirty(account: string): void {
    this.d.db.q("UPDATE lines SET state_at = 0 WHERE account = ?").run(account);
  }

  private effect(e: EventRow, ethUsd8: string | null): string | null {
    const db = this.d.db;
    const a = e.args;
    const account = normalizeAddress(a.account) ?? null;
    if (e.event === "Opened") {
      const key = normalizeAddress(a.key)!;
      db.q("INSERT OR IGNORE INTO lines (account, key, block, at, tx_hash) VALUES (?, ?, ?, ?, ?)").run(account, key, e.block, e.at, e.tx_hash);
      this.move(e, account, "open", "0", { key });
      return `${shortAddress(key)} opened its credit line: its line account is ${account}`;
    }
    if (!account && e.event !== "PoolIn") return null;
    if (e.event === "Drawn") {
      const key = normalizeAddress(a.key)!;
      const compute = a.asCompute === true || a.asCompute === "true";
      this.move(e, account, "draw", String(a.amount), { key, compute, burned: String(a.burned), toPool: String(a.toPool), dueAt: Number(a.dueAt) });
      if (compute) new ComputeStore(db).addLineLot(e, key, account!, BigInt(String(a.amount)) - BigInt(String(a.burned)) - BigInt(String(a.toPool)), ethUsd8);
      this.dirty(account!);
      return `${shortAddress(key)} drew ${ethText(String(a.amount))} ETH on its line${compute ? " as compute" : ""}`;
    }
    if (e.event === "Repaid") {
      const debt = BigInt(String(a.debt));
      const late = a.late === true || a.late === "true";
      const key = this.byAccount(account!)?.key ?? null;
      this.move(e, account, "repay", String(a.amount), { from: normalizeAddress(a.from), debt: debt.toString(), late });
      // repaid in full: what is left of its compute credit is the agent's to keep
      if (debt === 0n) new ComputeStore(db).keepLine(account!);
      this.dirty(account!);
      return `${ethText(String(a.amount))} ETH repaid on ${shortAddress(key ?? account!)}'s line${debt === 0n ? (late ? ": repaid in full, late" : ": repaid in full") : ""}`;
    }
    if (e.event === "Defaulted") {
      const key = normalizeAddress(a.key);
      this.move(e, account, "default", String(a.debt), { key });
      // the pool takes back what it lost from the compute credit not spent
      new ComputeStore(db).closeLine(account!, BigInt(String(a.debt)));
      this.dirty(account!);
      return `${shortAddress(key ?? account!)}'s line defaulted with ${ethText(String(a.debt))} ETH unpaid: barred from lines for good`;
    }
    if (e.event === "PoolIn") {
      const from = normalizeAddress(a.from);
      this.move(e, null, "seed", String(a.amount), { from });
      return `${ethText(String(a.amount))} ETH went into the line pool, from ${shortAddress(from ?? "")}`;
    }
    return null;
  }

  /** One pass of the line contract's logs, from where the last stopped to the safe head. Returns the lines worth logging. */
  async watch(ctx: Ctx, head: Head): Promise<string[]> {
    if (!this.reading()) return [];
    const { db, chain } = this.d;
    const safe = head.number - BigInt(ctx.params.confirmations);
    const start = (db.cursor("lines") ?? this.d.cfg.fromBlock! - 1n) + 1n;
    if (start > safe) return [];
    const lines: string[] = [];
    const span = BigInt(ctx.params.logSpan);
    let from = start;
    for (let n = 0; n < ctx.params.spansPerPass && from <= safe; n++) {
      const to = from + span - 1n > safe ? safe : from + span - 1n;
      let logs: ChainLog[] = [];
      await readLogs(chain, from, to, { address: [this.d.cfg.line!] }, to - from + 1n, (got) => { logs = got; }, 1);
      logs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
      const missing = [...new Set(logs.filter((l) => l.timestamp === undefined && !ctx.blockTimes.has(l.blockNumber)).map((l) => l.blockNumber))];
      for (let i = 0; i < missing.length; i += 10) {
        const blocks = await Promise.all(missing.slice(i, i + 10).map((b) => chain.block(b)));
        blocks.forEach((b, k) => ctx.blockTimes.set(missing[i + k]!, b?.timestamp ?? 0));
      }
      const ethUsd8 = snapshotOf(db)?.ethUsd8 ?? null;
      db.tx(() => {
        for (const l of logs) {
          const line = this.apply(l, l.timestamp ?? ctx.blockTimes.get(l.blockNumber) ?? 0, ethUsd8);
          if (line) lines.push(line);
        }
        db.setCursor("lines", to);
      });
      from = to + 1n;
    }
    for (const l of lines) this.d.log(`[lines] ${l}`);
    // something happened on a line: the pool's figures are read again at once
    if (lines.length) this.poolReadAt = 0;
    return lines;
  }

  /**
   * What is read rather than logged: each line as the contract has it, its limit and room, what its account holds and
   * what the desk keeps for it, the stalest first; and the pool's figures once a minute.
   */
  async refresh(): Promise<void> {
    if (!this.reading()) return;
    const { db, chain } = this.d;
    const line = this.d.cfg.line!;
    const stale = db.q("SELECT * FROM lines ORDER BY state_at LIMIT 25").all() as LineRow[];
    await Promise.all(stale.filter((r) => this.d.now() - r.state_at > 15_000).map(async (r) => {
      const L = (fn: string, args: unknown[]) => chain.read<unknown>({ to: line, abi: LINE, functionName: fn, args });
      const [l, limit, room, canDraw, balance, acct, key] = await Promise.all([
        L("line", [r.account]) as Promise<{ debt: bigint; dueAt: number | bigint; defaulted: boolean; draws: number | bigint; onTime: number | bigint; late: number | bigint; drawn: bigint; repaid: bigint }>,
        L("limit", [r.account]) as Promise<bigint>, L("room", [r.account]) as Promise<bigint>, L("canDraw", [r.key]) as Promise<bigint>,
        chain.balance(r.account),
        chain.read<{ bond: bigint; feesPaid: bigint; advancedNow: bigint; barred: boolean }>({ to: this.d.desk, abi: DESK, functionName: "agent", args: [r.account] }),
        chain.read<{ barred: boolean }>({ to: this.d.desk, abi: DESK, functionName: "agent", args: [r.key] }),
      ]);
      const state: LineState = {
        debt: l.debt.toString(), dueAt: Number(l.dueAt), defaulted: l.defaulted, draws: Number(l.draws), onTime: Number(l.onTime), late: Number(l.late), drawn: l.drawn.toString(), repaid: l.repaid.toString(),
        limit: limit.toString(), room: room.toString(), canDraw: canDraw.toString(), balance: balance.toString(), bond: acct.bond.toString(), feesPaid: acct.feesPaid.toString(), deskOut: acct.advancedNow.toString(),
        deskBarred: acct.barred, keyBarred: key.barred,
      };
      db.q("UPDATE lines SET state = ?, state_at = ? WHERE account = ?").run(JSON.stringify(state), this.d.now(), r.account);
    }));
    if (this.d.now() - this.poolReadAt > 30_000) {
      this.poolReadAt = this.d.now();
      const r = <T>(fn: string) => chain.read<T>({ to: line, abi: LINE, functionName: fn });
      const [pool, out, lost, room, owed, seeded, drawn, burned, feesToPool, repaid, recovered, count] = await Promise.all([
        r<bigint>("pool"), r<bigint>("out"), r<bigint>("lost"), r<bigint>("poolRoom"), r<bigint>("owedTotal"), r<bigint>("totalPoolIn"), r<bigint>("totalDrawn"), r<bigint>("totalBurned"),
        r<bigint>("totalFeesToPool"), r<bigint>("totalRepaid"), r<bigint>("totalRecovered"), r<bigint>("lineCount"),
      ]);
      const s: LinePoolState = { pool: pool.toString(), out: out.toString(), lost: lost.toString(), room: room.toString(), owed: owed.toString(), seeded: seeded.toString(), drawn: drawn.toString(), burned: burned.toString(), feesToPool: feesToPool.toString(), repaid: repaid.toString(), recovered: recovered.toString(), lines: Number(count), at: this.d.now() };
      db.setJson("lines:pool", s);
    }
  }

  // ---------- the keeper ----------

  /**
   * The keeper's turn (./chain/act.ts calls it as the step "line"): income waiting in an account whose line owes is
   * swept into the line, and a line still owed 30 days past its due time is recovered. A few lines a pass, the ones
   * that need it most first.
   */
  async step(ctx: Ctx, head: Head, attempt: (kind: "line", ref: string, call: CallSpec, detail: Record<string, unknown>, feeCap: bigint) => Promise<{ status: string; why: string; hash?: string }>): Promise<string> {
    if (!this.reading()) return "credit lines are not switched on";
    if (stopped(this.d.db, "lines")) return "credit lines are stopped by the owner";
    const t = head.timestamp;
    const said: string[] = [];
    let n = 0;
    for (const r of this.all()) {
      if (n >= this.d.cfg.perPass || ctx.stopping()) break;
      const s = this.stateOf(r);
      const debt = BigInt(s.debt), balance = BigInt(s.balance);
      if (debt === 0n) continue;
      const who = shortAddress(r.key);
      // recover: 30 days past due, or after a default whenever there is ETH or a free bond to take, once a day at most
      const recoverable = !s.defaulted ? t > s.dueAt + LINE_RULES.defaultS : (balance > 0n || (BigInt(s.bond) > 0n && BigInt(s.deskOut) === 0n)) && t >= r.recovered_at + 86_400;
      if (recoverable && s.dueAt > 0) {
        n++;
        const call: CallSpec = { to: this.d.cfg.line!, abi: LINE, functionName: "recover", args: [r.account] };
        const out = await attempt("line", `recover:${r.account}`, call, { account: r.account, key: r.key, debt: s.debt }, ctx.params.maxGasWei);
        if (out.status === "done" || out.status === "dry" || out.status === "sent") this.d.db.q("UPDATE lines SET recovered_at = ?, state_at = 0 WHERE account = ?").run(t, r.account);
        said.push(`${who}: ${out.status === "dry" ? "would recover" : out.status === "done" ? "recovered" : out.status} its line${out.status === "failed" || out.status === "skipped" ? ` (${out.why})` : ""}`);
        if (ctx.db.openActions().length) break;
        continue;
      }
      // sweep: income in the account while the line owes
      if (balance === 0n) continue;
      const dueSoon = s.dueAt > 0 && s.dueAt - t < 86_400;
      if (balance < this.d.cfg.sweepMinWei && !dueSoon) { said.push(`${who}: ${ethText(balance.toString())} ETH waits in its account, under ${ethText(this.d.cfg.sweepMinWei.toString())}`); continue; }
      if (t < r.swept_at + 300) continue;
      n++;
      const call: CallSpec = { to: r.account, abi: ACCT, functionName: "sweep" };
      const out = await attempt("line", `sweep:${r.account}`, call, { account: r.account, key: r.key, waiting: s.balance, debt: s.debt }, ctx.params.maxGasWei);
      if (out.status === "done" || out.status === "dry" || out.status === "sent") this.d.db.q("UPDATE lines SET swept_at = ?, state_at = 0 WHERE account = ?").run(t, r.account);
      said.push(`${who}: ${out.status === "dry" ? "would sweep" : out.status === "done" ? "swept" : out.status} ${ethText((balance < debt ? balance : debt).toString())} ETH into its line${out.status === "failed" || out.status === "skipped" ? ` (${out.why})` : ""}`);
      if (ctx.db.openActions().length) break;
    }
    return said.length ? said.join("; ") : "no line needs a sweep or a recovery";
  }

  // ---------- signatures ----------

  /** Whether a line account's key signed `message`: the account answers ERC-1271 for its key. */
  async signed(address: string, message: string, signature: unknown): Promise<boolean> {
    if (!this.reading() || typeof signature !== "string" || !/^0x([0-9a-fA-F]{2}){65,2048}$/.test(signature)) return false;
    if (!this.isAccount(address)) return false;
    try {
      const answer = await this.d.chain.read<string>({ to: address, abi: ACCT, functionName: "isValidSignature", args: [hashMessage(message), signature] });
      return answer === ERC1271_VALID;
    } catch (e) {
      if (nodeBusy(e)) throw e;
      if (revertOf(e)) return false;
      return false;
    }
  }

  // ---------- the record, carried over ----------

  /**
   * One agent's record across its key and its line account, as one: counts added, the earliest first job, barred if
   * either is. Null when the address has no line.
   */
  mergedRecord(address: string): { key: string; account: string; record: AgentRecord } | null {
    const r = this.of(address);
    if (!r) return null;
    const a = this.d.record(r.key), b = this.d.record(r.account);
    if (!a && !b) return null;
    const zero: AgentRecord = { registered: true, barred: false, firstSettledAt: 0, settled: 0, settledAtHalf: 0, notDelivered: 0, unanswered: 0, customers: 0, onTime: 0, late: 0, advancesRepaid: 0, advancesNotRepaid: 0, earlyKept: 0, bond: "0", feesPaid: "0", advancedNow: "0", volume: "0" };
    const x = a ?? zero, y = b ?? zero;
    const first = [x.firstSettledAt, y.firstSettledAt].filter((t) => t > 0);
    const add = (p: string, q: string) => (BigInt(p) + BigInt(q)).toString();
    return {
      key: r.key, account: r.account,
      record: {
        registered: true, barred: x.barred || y.barred, firstSettledAt: first.length ? Math.min(...first) : 0,
        settled: x.settled + y.settled, settledAtHalf: x.settledAtHalf + y.settledAtHalf, notDelivered: x.notDelivered + y.notDelivered, unanswered: x.unanswered + y.unanswered,
        // a customer of both counts twice here: the same floor of fees was paid on each side, so neither is a dust customer
        customers: x.customers + y.customers, onTime: x.onTime + y.onTime, late: x.late + y.late,
        advancesRepaid: x.advancesRepaid + y.advancesRepaid, advancesNotRepaid: x.advancesNotRepaid + y.advancesNotRepaid, earlyKept: x.earlyKept + y.earlyKept,
        bond: add(x.bond, y.bond), feesPaid: add(x.feesPaid, y.feesPaid), advancedNow: add(x.advancedNow, y.advancedNow), volume: add(x.volume, y.volume),
      },
    };
  }

  /** What the line adds to the score: repaid on time counts as an advance repaid, late takes 50 off, a default sets it to 0. */
  lineMarks(address: string): { onTime: number; late: number; defaulted: boolean } | null {
    const r = this.of(address);
    if (!r) return null;
    const s = this.stateOf(r);
    return { onTime: s.onTime, late: s.late, defaulted: s.defaulted };
  }

  /** The agent's score with its line: the desk's formula over both records, with the line's marks. */
  scoreWithLine(address: string, nowS: number): number | null {
    const m = this.mergedRecord(address);
    const marks = this.lineMarks(address);
    if (!m || !marks) return null;
    if (marks.defaulted) return 0;
    const base = scoreOf({ ...m.record, advancesRepaid: m.record.advancesRepaid + marks.onTime }, nowS);
    return Math.max(0, base - marks.late * 50);
  }

  // ---------- what the site and the kit read ----------

  about(): LinesAbout {
    const p = this.pool();
    const on = this.on();
    return {
      enabled: on, contract: this.d.cfg.line, chainId: this.d.chainId,
      rules: { feePct: LINE_RULES.feePct, burnPct: LINE_RULES.burnPct, poolPct: LINE_RULES.poolPct, dueDays: LINE_RULES.dueDays, defaultDays: LINE_RULES.defaultDays, minDrawEth: LINE_RULES.minDrawEth, poolOutMaxPct: LINE_RULES.poolOutMaxPct },
      pool: on && p ? {
        poolEth: ethNum(p.pool), outEth: ethNum(p.out), lostEth: ethNum(p.lost), roomEth: ethNum(p.room), seededEth: ethNum(p.seeded), drawnEth: ethNum(p.drawn), burnedEth: ethNum(p.burned),
        feesToPoolEth: ethNum(p.feesToPool), repaidEth: ethNum(p.repaid), recoveredEth: ethNum(p.recovered), roomWei: p.room,
      } : null,
      lines: on ? this.all().length : 0,
      owing: on ? this.all().filter((r) => BigInt(this.stateOf(r).debt) > 0n).length : 0,
    };
  }

  /** One line as the site shows it. */
  json(r: LineRow, full = false): LineJson {
    const s = this.stateOf(r);
    const names = this.d.names();
    const p = names.get(r.key);
    const nowS = this.d.nowS();
    const debt = BigInt(s.debt);
    const status: LineJson["status"] = s.defaulted ? "defaulted" : debt === 0n ? "open" : nowS > s.dueAt ? "late" : "owing";
    const balance = BigInt(s.balance);
    const out: LineJson = {
      key: r.key, account: r.account, name: p && !p.hidden ? p.name : shortAddress(r.key), named: !!p && !p.hidden,
      openedAt: new Date(r.at * 1000).toISOString(), tx: r.tx_hash, status,
      debtEth: ethNum(s.debt), debtWei: s.debt,
      dueAt: s.dueAt > 0 ? new Date(s.dueAt * 1000).toISOString() : null,
      defaultsAt: s.dueAt > 0 && !s.defaulted ? new Date((s.dueAt + LINE_RULES.defaultS) * 1000).toISOString() : null,
      limitEth: ethNum(s.limit), roomEth: ethNum(s.room), canDrawEth: ethNum(s.canDraw), canDrawWei: s.canDraw,
      bondEth: ethNum(s.bond), feesPaidEth: ethNum(s.feesPaid), deskOutEth: ethNum(s.deskOut),
      balanceEth: ethNum(s.balance), freeEth: ethNum((balance > debt ? balance - debt : 0n).toString()),
      draws: s.draws, drawnEth: ethNum(s.drawn), repaidEth: ethNum(s.repaid), onTime: s.onTime, late: s.late, defaulted: s.defaulted,
      barred: s.deskBarred || s.keyBarred,
      computeUsd: new ComputeStore(this.d.db).lineCredit(r.account),
    };
    if (full) {
      out.moves = (this.d.db.q("SELECT tx_hash, at, kind, amount, extra FROM line_moves WHERE account = ? ORDER BY block DESC, log_index DESC LIMIT 20").all(r.account) as { tx_hash: string; at: number; kind: string; amount: string; extra: string }[])
        .map((m) => { const x = JSON.parse(m.extra) as { compute?: boolean; late?: boolean; debt?: string }; return { kind: m.kind as LineMove["kind"], at: new Date(m.at * 1000).toISOString(), eth: ethNum(m.amount), tx: m.tx_hash, ...(x.compute ? { compute: true } : {}), ...(x.late ? { late: true } : {}), ...(x.debt !== undefined ? { debtEth: ethNum(x.debt) } : {}) }; });
    }
    return out;
  }

  list(): LineJson[] {
    if (!this.on()) return [];
    return this.all().map((r) => this.json(r)).sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
  }

  /** One line, by its key or its account (address or the agent's name). */
  one(id: string): LineJson | null {
    if (!this.on()) return null;
    const r = this.byAny(id);
    return r ? this.json(r, true) : null;
  }

  /** The small mark beside an agent wherever it shows: which side of a line it is, and how the line stands. */
  badge(address: string): LineBadge | null {
    if (!this.on()) return null;
    const r = this.of(address);
    if (!r) return null;
    const j = this.json(r);
    return { role: r.key === address ? "key" : "account", key: r.key, account: r.account, status: j.status, score: this.scoreWithLine(address, this.d.nowS()) };
  }

  /** For the owner's health answer. */
  health(): Record<string, unknown> {
    const rows = this.all();
    return { reading: this.reading(), on: this.on(), line: this.d.cfg.line, lines: rows.length, owing: rows.filter((r) => BigInt(this.stateOf(r).debt) > 0n).length, pool: this.pool(), note: this.d.cfg.note };
  }
}

/** What lines are, as the site and the kit read it: web/src/lib/types.ts keeps the same shape by hand. */
export interface LinesAbout {
  enabled: boolean; contract: string | null; chainId: number;
  rules: { feePct: number; burnPct: number; poolPct: number; dueDays: number; defaultDays: number; minDrawEth: number; poolOutMaxPct: number };
  pool: { poolEth: number; outEth: number; lostEth: number; roomEth: number; roomWei: string; seededEth: number; drawnEth: number; burnedEth: number; feesToPoolEth: number; repaidEth: number; recoveredEth: number } | null;
  lines: number;
  owing: number;
}

export interface LineMove { kind: "open" | "draw" | "repay" | "default" | "seed"; at: string; eth: number; tx: string; compute?: boolean; late?: boolean; debtEth?: number }

export interface LineJson {
  key: string; account: string; name: string; named: boolean; openedAt: string; tx: string;
  /** open: nothing owed. owing: owed, before its due time. late: owed past it. defaulted: barred for good */
  status: "open" | "owing" | "late" | "defaulted";
  debtEth: number; debtWei: string; dueAt: string | null; defaultsAt: string | null;
  limitEth: number; roomEth: number; canDrawEth: number; canDrawWei: string;
  bondEth: number; feesPaidEth: number; deskOutEth: number;
  /** what its account holds, and what of that is the agent's (beyond what the line is owed) */
  balanceEth: number; freeEth: number;
  draws: number; drawnEth: number; repaidEth: number; onTime: number; late: number; defaulted: boolean;
  /** the key or the account is barred on the desk: the limit is 0 */
  barred: boolean;
  /** compute credit its draws as compute became, in dollars, and what its calls spent of it */
  computeUsd: { grantedUsd: number; spentUsd: number };
  moves?: LineMove[];
}

export interface LineBadge { role: "key" | "account"; key: string; account: string; status: LineJson["status"]; score: number | null }

const ethNum = (wei: string): number => Number(BigInt(wei) / 10n ** 12n) / 1e6;
const ethText = (wei: string): string => {
  const n = ethNum(wei);
  return n >= 0.01 ? n.toFixed(4) : n.toFixed(6);
};
// used by the tests to read the keeper's choice
export { reason as _reason };
