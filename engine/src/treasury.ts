// Agent treasury (docs/TREASURY.md; contracts/src/FactorTreasury.sol): an agent's idle earnings work on their own, inside
// rules the agent sets once. ETH put into an agent's treasury can be taken out only by that agent, at any time. The agent
// sets a floor a run never spends below and, for each of five uses, whether it is on and how far it goes. Then anyone may
// run the treasury, and it does, in this fixed order: repay the agent's own credit line, prepay compute at the gateway, buy
// locked pay inside the agent's rules, top up its guarantee bond, top up its vouching bond.
//
// What the engine does with it:
//
//   reads     the treasury contract's Deposited, Withdrawn, RulesSet, LineRepaid, ComputePrepaid, ClaimBought,
//             GuaranteeBacked, VouchBacked, Skipped and Ran into chain_events and the tables here. What a treasury IS (what
//             it holds, its rules, its totals) is read from balanceOf, rulesOf and totalsOf, the stalest first, with the
//             contract's own preview of the next run for the claims on sale now
//   credits   ComputePrepaid: the ETH reached the gateway. It becomes a lot of compute credit that is the agent's own at
//             once (./compute.ts), read even while the owner's switch is off, so no prepayment is ever missed
//   runs      a treasury whose preview says a run would do something: run(agent, claims), at most once every
//             TREASURY_EVERY_MIN for one treasury. Anyone may; the keeper does it on time
//   shows     each treasury on its agent's page and each step of each run as a receipt, on the agent's page and on its
//             credit report. It changes no score
//
//   GET  /v1/treasury/about             whether the treasury is on, the contract, the order of a run and the totals
//   GET  /v1/treasury                   the treasuries, the latest run first
//   GET  /v1/treasury/<agent>           one agent's treasury: what it holds, its rules, its totals, its runs, the next run
//   GET  /v1/treasury/<agent>/preview   only the next run: what a run would do now, step by step
//
// Switches: TREASURY=on (off unless it is said), with FACTOR_TREASURY and FACTOR_TREASURY_BLOCK; and the owner's "treasury"
// switch (./switches.ts), which hides every treasury and stops the keeper's runs at once. Nothing an agent does on the chain
// depends on either: every call of the contract is open, and a withdrawal needs nobody but the agent.

import { formatEther, type Abi } from "viem";
import { factorTreasuryAbi } from "./abi/index.js";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import { readLogs, type CallSpec, type Chain, type ChainLog, type Head } from "./chain/chain.js";
import { snapshotOf, type Ctx } from "./chain/context.js";
import type { EngineDb, EventRow } from "./chain/db.js";
import { decode } from "./chain/watch.js";
import { ComputeStore } from "./compute.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export interface TreasuryConfig {
  /** TREASURY=on: off unless it is said */
  enabled: boolean;
  /** FACTOR_TREASURY: the treasury contract, once deployed (contracts/deploy-treasury.sh writes it) */
  contract: string | null;
  /** FACTOR_TREASURY_BLOCK: the block to read treasuries from */
  fromBlock: bigint | null;
  /** TREASURY_PER_PASS: how many treasuries the keeper runs in one pass */
  perPass: number;
  /** TREASURY_EVERY_MIN: the keeper runs one treasury at most this often */
  everyMin: number;
  /** why it is on and cannot run, when it cannot */
  note: string | null;
}

export function readTreasury(env: Env, problems: string[] = []): TreasuryConfig {
  const on = (env.TREASURY ?? "").trim().toLowerCase() === "on";
  const raw = env.FACTOR_TREASURY?.trim();
  const contract = raw ? normalizeAddress(raw) : null;
  if (raw && !contract) problems.push(`FACTOR_TREASURY is not an address: "${raw}"`);
  const rawBlock = env.FACTOR_TREASURY_BLOCK?.trim();
  let fromBlock: bigint | null = null;
  if (rawBlock) {
    if (/^\d+$/.test(rawBlock)) fromBlock = BigInt(rawBlock);
    else problems.push(`FACTOR_TREASURY_BLOCK must be a block number: it is "${rawBlock}"`);
  }
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const v = env[name]?.trim();
    if (!v) return fallback;
    if (/^\d+$/.test(v) && Number(v) >= min && Number(v) <= max) return Number(v);
    problems.push(`${name} must be a whole number from ${min} to ${max}: it is "${v}"`);
    return fallback;
  };
  let note: string | null = null;
  if (on && !contract) note = "TREASURY is on and FACTOR_TREASURY is not set: there is no treasury contract to read yet";
  else if (on && fromBlock === null) note = "TREASURY is on and FACTOR_TREASURY_BLOCK is not set: the block to read treasuries from";
  return { enabled: on, contract, fromBlock, perPass: int("TREASURY_PER_PASS", 5, 1, 100), everyMin: int("TREASURY_EVERY_MIN", 30, 1, 1440), note };
}

/** The numbers and the order, as the contract has them (FactorTreasury's constants): what the site says. */
export const TREASURY_RULES = {
  minStep: "100000000000000", maxClaims: 10, day: 86_400,
  order: ["repay", "compute", "claims", "guarantee", "vouch"],
} as const;

const TT = factorTreasuryAbi as Abi;
const STEPS = ["repay", "compute", "claims", "guarantee", "vouch"] as const;
export type TreasuryStep = (typeof STEPS)[number];
/** What a line of treasury_moves is. The five in the middle are the steps of a run: its receipts. */
export type MoveKind = "deposit" | "withdraw" | "rules" | "repay" | "compute" | "claim" | "guarantee" | "vouch" | "skipped" | "run";
const RECEIPTS: MoveKind[] = ["repay", "compute", "claim", "guarantee", "vouch"];

/** An agent's rules as the site shows them: wei in text. */
export interface TreasuryRulesJson {
  floor: string;
  repay: { on: boolean; daily: string };
  compute: { on: boolean; daily: string };
  claims: { on: boolean; daily: string; maxPrice: string; minDiscountBps: number; minScore: number; deliveredOnly: boolean };
  guarantee: { on: boolean; upTo: string };
  vouch: { on: boolean; upTo: string };
}

export interface TreasuryTotalsJson { deposited: string; withdrawn: string; repaid: string; compute: string; claims: string; guarantee: string; vouch: string; runs: number; claimsBought: number }

/** What a run would do now, as the contract's own preview says it. */
export interface TreasuryNextJson {
  /** the claims on sale the preview was asked about, and what each would be bought for ("0": not inside the rules) */
  claims: { id: number; price: string }[];
  repay: string; compute: string; buy: string; guarantee: string; vouch: string;
  total: string;
  /** the line would still owe after the repayment, so nothing after it would be done */
  lineFirst: boolean;
  readAt: string;
}

interface AgentRow { agent: string; block: number; at: number; tx_hash: string; balance: string; rules: string | null; totals: string | null; next: string | null; state_at: number; ran_at: number }
interface MoveRow { tx_hash: string; log_index: number; block: number; at: number; agent: string; kind: MoveKind; amount: string; ref: number; other: string | null; rest: string | null }

export interface TreasuryDeps {
  cfg: TreasuryConfig;
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
  /** one of Factor's own wallets: its house agents, its test agents and demo wallets */
  factorOwn: (address: string) => boolean;
  /** the claims on sale now, the biggest discount first (./claims.ts); none while selling locked pay is off */
  listedClaims: () => number[];
}

/** One step of a run, as a receipt. */
export interface ReceiptView { kind: "repay" | "compute" | "claim" | "guarantee" | "vouch"; text: string; amount: string; amountEth: number; at: string; tx: string; claim?: number }
/** One run: every step it took. */
export interface RunView { tx: string; at: string; by: string | null; spent: string; spentEth: number; steps: ReceiptView[]; skipped: number }

export interface TreasuryView {
  agent: string; name: string; named: boolean;
  balance: string; balanceEth: number;
  /** what a run may spend now: what it holds above its floor */
  spendable: string;
  rules: TreasuryRulesJson | null;
  totals: TreasuryTotalsJson | null;
  runs: RunView[];
  next: TreasuryNextJson | null;
  openedAt: string;
  factorOwn: boolean;
}

export interface TreasuryAbout {
  enabled: boolean; contract: string | null; fromBlock: string | null; chainId: number;
  rules: { minStep: string; maxClaims: number; day: number; order: readonly string[] };
  totals: { treasuries: number; held: string; runs: number; repaid: string; compute: string; claims: string; guarantee: string; vouch: string; factorOwn: number } | null;
}

/** The receipts of an agent's treasury on its credit report. It changes no point of the score. */
export interface ReportTreasuryJson { agent: string; balance: string; runs: number; receipts: ReceiptView[] }

export class Treasury {
  constructor(readonly d: TreasuryDeps) {}

  /** Reading the chain: switched on and a contract to read. */
  reading(): boolean {
    return this.d.cfg.enabled && !!this.d.cfg.contract && this.d.cfg.fromBlock !== null;
  }

  /** Shown and run: reading, and the owner has not stopped it. */
  on(): boolean {
    return this.reading() && !stopped(this.d.db, "treasury");
  }

  // ---------- the books ----------

  row(agent: string): AgentRow | null {
    return (this.d.db.q("SELECT * FROM treasury_agents WHERE agent = ?").get(agent) as AgentRow | undefined) ?? null;
  }

  private moves(agent: string, limit = 200): MoveRow[] {
    return this.d.db.q("SELECT * FROM treasury_moves WHERE agent = ? ORDER BY block DESC, log_index DESC LIMIT ?").all(agent, limit) as MoveRow[];
  }

  private name(address: string): string {
    const p = this.d.names().get(address);
    return p && !p.hidden ? p.name : shortAddress(address);
  }

  // ---------- reading the chain ----------

  /** One log of the treasury contract's, written down. Returns a line for the engine's log, when it is worth one. Exported for the tests. */
  apply(log: ChainLog, at: number, ethUsd8: string | null): string | null {
    const e = decode({ name: "treasury" as never, abi: TT }, log, at);
    if (!e) return null;
    e.contract = "treasury";
    if (!this.d.db.addEvent(e)) return null;
    return this.effect(e, ethUsd8);
  }

  private effect(e: EventRow, ethUsd8: string | null): string | null {
    const db = this.d.db;
    const a = e.args;
    const agent = normalizeAddress(a.agent);
    if (!agent) return null;
    db.q("INSERT OR IGNORE INTO treasury_agents (agent, block, at, tx_hash) VALUES (?, ?, ?, ?)").run(agent, e.block, e.at, e.tx_hash);
    db.q("UPDATE treasury_agents SET state_at = 0 WHERE agent = ?").run(agent);
    const move = (kind: MoveKind, amount: string, o: { ref?: number; other?: string | null; left?: string } = {}) =>
      db.q("INSERT OR IGNORE INTO treasury_moves (tx_hash, log_index, block, at, agent, kind, amount, ref, other, rest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(e.tx_hash, e.log_index, e.block, e.at, agent, kind, amount, o.ref ?? 0, o.other ?? null, o.left ?? null);
    const who = this.name(agent);
    const amount = a.amount !== undefined ? String(a.amount) : "0";
    if (e.event === "Deposited") {
      move("deposit", amount, { other: normalizeAddress(a.from), left: String(a.balance) });
      db.q("UPDATE treasury_agents SET balance = ? WHERE agent = ?").run(String(a.balance), agent);
      return `${who}'s treasury: ${ethText(amount)} ETH put in`;
    }
    if (e.event === "Withdrawn") {
      move("withdraw", amount, { other: normalizeAddress(a.to), left: String(a.balance) });
      db.q("UPDATE treasury_agents SET balance = ? WHERE agent = ?").run(String(a.balance), agent);
      return `${who}'s treasury: ${ethText(amount)} ETH taken out by the agent`;
    }
    if (e.event === "RulesSet") {
      move("rules", "0");
      const r = rulesJson(parse<Record<string, unknown>>(String(a.rules)));
      if (r) db.q("UPDATE treasury_agents SET rules = ? WHERE agent = ?").run(JSON.stringify(r), agent);
      return `${who} set its treasury's rules`;
    }
    if (e.event === "LineRepaid") {
      move("repay", amount, { other: normalizeAddress(a.account), left: String(a.debt) });
      return `${who}'s treasury repaid ${ethText(amount)} ETH of its credit line`;
    }
    if (e.event === "ComputePrepaid") {
      move("compute", amount, { other: normalizeAddress(a.gateway) });
      // the agent's own credit, from the moment the ETH reached the gateway
      const fresh = new ComputeStore(db).addTreasuryLot(e, agent, BigInt(amount), ethUsd8);
      return fresh ? `${who}'s treasury prepaid ${ethText(amount)} ETH of compute` : null;
    }
    if (e.event === "ClaimBought") {
      move("claim", String(a.price), { ref: Number(a.id), left: String(a.face), other: String(Number(a.job)) });
      return `${who}'s treasury bought claim ${Number(a.id)}, the locked pay of job ${Number(a.job)}, for ${ethText(String(a.price))} ETH`;
    }
    if (e.event === "GuaranteeBacked") {
      move("guarantee", amount, { other: normalizeAddress(a.deskAddress), left: String(a.bond) });
      return `${who}'s treasury added ${ethText(amount)} ETH to its guarantee bond`;
    }
    if (e.event === "VouchBacked") {
      move("vouch", amount, { other: normalizeAddress(a.deskAddress), left: String(a.bond) });
      return `${who}'s treasury added ${ethText(amount)} ETH to its vouching bond`;
    }
    if (e.event === "Skipped") {
      move("skipped", "0", { ref: Number(a.ref), other: STEPS[Number(a.step)] ?? null });
      return `${who}'s treasury: the ${STEPS[Number(a.step)] ?? "next"} step was refused at its door and skipped`;
    }
    if (e.event === "Ran") {
      move("run", String(a.spent), { other: normalizeAddress(a.by), left: String(a.balance) });
      db.q("UPDATE treasury_agents SET balance = ?, ran_at = ? WHERE agent = ?").run(String(a.balance), e.at, agent);
      return null;
    }
    return null;
  }

  /** One pass of the treasury contract's logs, from where the last stopped to the safe head. Returns the lines worth logging. */
  async watch(ctx: Ctx, head: Head): Promise<string[]> {
    if (!this.reading()) return [];
    const { db, chain } = this.d;
    const safe = head.number - BigInt(ctx.params.confirmations);
    const start = (db.cursor("treasury") ?? this.d.cfg.fromBlock! - 1n) + 1n;
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
      const ethUsd8 = snapshotOf(db)?.ethUsd8 ?? null;
      db.tx(() => {
        for (const l of logs) {
          const line = this.apply(l, l.timestamp ?? ctx.blockTimes.get(l.blockNumber) ?? 0, ethUsd8);
          if (line) lines.push(line);
        }
        db.setCursor("treasury", to);
      });
      from = to + 1n;
    }
    for (const l of lines) this.d.log(`[treasury] ${l}`);
    return lines;
  }

  /**
   * What is read rather than logged: each treasury that holds something or has rules, every minute at most, the stalest
   * first: what it holds, its rules, its totals, and the contract's own preview of a run for the claims on sale now.
   */
  async refresh(): Promise<void> {
    if (!this.reading()) return;
    const { db, chain } = this.d;
    const tc = this.d.cfg.contract!;
    const now = this.d.now();
    const rows = db.q("SELECT * FROM treasury_agents WHERE state_at = 0 OR (? - state_at > 60000 AND (balance != '0' OR rules IS NOT NULL)) ORDER BY state_at LIMIT 25").all(now) as AgentRow[];
    if (!rows.length) return;
    const ids = this.d.listedClaims().slice(0, TREASURY_RULES.maxClaims);
    await Promise.all(rows.map(async (t) => {
      const [balance, rules, totals, pv] = await Promise.all([
        chain.read<bigint>({ to: tc, abi: TT, functionName: "balanceOf", args: [t.agent] }),
        chain.read<Record<string, unknown>>({ to: tc, abi: TT, functionName: "rulesOf", args: [t.agent] }),
        chain.read<Record<string, unknown>>({ to: tc, abi: TT, functionName: "totalsOf", args: [t.agent] }),
        chain.read<readonly [bigint, bigint, readonly bigint[], bigint, bigint, boolean]>({ to: tc, abi: TT, functionName: "preview", args: [t.agent, ids.map((i) => BigInt(i))] }).catch(() => null),
      ]);
      const r = rulesJson(rules);
      const tj = totalsJson(totals);
      let next: TreasuryNextJson | null = null;
      if (pv) {
        const prices = pv[2].map((p) => BigInt(p));
        const buy = prices.reduce((n, p) => n + p, 0n);
        next = {
          claims: ids.map((id, i) => ({ id, price: (prices[i] ?? 0n).toString() })),
          repay: pv[0].toString(), compute: pv[1].toString(), buy: buy.toString(), guarantee: pv[3].toString(), vouch: pv[4].toString(),
          total: (BigInt(pv[0]) + BigInt(pv[1]) + buy + BigInt(pv[3]) + BigInt(pv[4])).toString(),
          lineFirst: !!pv[5], readAt: new Date(now).toISOString(),
        };
      }
      db.q("UPDATE treasury_agents SET balance = ?, rules = ?, totals = ?, next = ?, state_at = ? WHERE agent = ?").run(
        BigInt(balance).toString(), r && anyRule(r) ? JSON.stringify(r) : t.rules && r ? JSON.stringify(r) : t.rules, tj ? JSON.stringify(tj) : t.totals, next ? JSON.stringify(next) : null, now, t.agent,
      );
    }));
  }

  // ---------- the keeper ----------

  /** The treasuries a run would do something for now, by the contract's own preview as last read, the biggest first. */
  runnable(): { agent: string; next: TreasuryNextJson }[] {
    const out: { agent: string; next: TreasuryNextJson }[] = [];
    for (const t of this.d.db.q("SELECT * FROM treasury_agents WHERE next IS NOT NULL AND balance != '0'").all() as AgentRow[]) {
      const next = parse<TreasuryNextJson>(t.next);
      if (next && BigInt(next.total) > 0n) out.push({ agent: t.agent, next });
    }
    return out.sort((a, b) => (BigInt(b.next.total) > BigInt(a.next.total) ? 1 : -1));
  }

  /**
   * The keeper's turn (./chain/act.ts calls it as the step "treasury"): a treasury whose preview says a run would do
   * something is run, with the claims the preview would buy. One treasury at most once every TREASURY_EVERY_MIN; a few a pass.
   */
  async step(ctx: Ctx, _head: Head, attempt: (kind: "treasury", ref: string, call: CallSpec, detail: Record<string, unknown>, feeCap: bigint) => Promise<{ status: string; why: string; hash?: string }>): Promise<string> {
    if (!this.reading()) return "the agent treasury is not switched on";
    if (stopped(this.d.db, "treasury")) return "the agent treasury is stopped by the owner";
    const db = this.d.db;
    const said: string[] = [];
    const every = this.d.cfg.everyMin * 60_000;
    let n = 0;
    for (const t of this.runnable()) {
      if (n >= this.d.cfg.perPass || ctx.stopping()) break;
      const ref = `run:${t.agent}`;
      const prev = db.lastAction("treasury", ref);
      if (prev) {
        if (prev.status === "signed" || prev.status === "sent") continue;
        if (prev.status === "done" && this.d.now() - prev.updated_at <= every) continue;
        if (prev.status === "failed" && this.d.now() - prev.updated_at <= 600_000) continue;
        if (prev.status === "dry" && this.d.now() - prev.created_at <= 1_800_000) continue;
      }
      n++;
      const ids = t.next.claims.filter((c) => BigInt(c.price) > 0n).map((c) => BigInt(c.id));
      const words = `run ${this.name(t.agent)}'s treasury (${ethText(t.next.total)} ETH to do)`;
      const out = await attempt("treasury", ref, { to: this.d.cfg.contract!, abi: TT, functionName: "run", args: [t.agent, ids] }, { agent: t.agent, next: t.next }, ctx.params.maxGasWei);
      said.push(`${out.status === "dry" ? `would ${words}` : out.status === "done" ? words : `${words}: ${out.status}`}${out.status === "failed" || out.status === "skipped" ? ` (${out.why})` : ""}`);
      if (out.status === "done" || out.status === "failed") db.q("UPDATE treasury_agents SET state_at = 0 WHERE agent = ?").run(t.agent);
      if (db.openActions().length > 0) break;
    }
    return said.length ? said.join("; ") : "no treasury has anything to do";
  }

  // ---------- what the site reads ----------

  about(): TreasuryAbout {
    const on = this.on();
    const c = this.d.cfg;
    let totals: TreasuryAbout["totals"] = null;
    if (on) {
      const rows = this.d.db.q("SELECT * FROM treasury_agents").all() as AgentRow[];
      const counted = rows.filter((r) => !this.d.factorOwn(r.agent));
      const tt = counted.map((r) => parse<TreasuryTotalsJson>(r.totals));
      const sum = (f: (t: TreasuryTotalsJson) => string) => tt.reduce((n, t) => n + (t ? BigInt(f(t)) : 0n), 0n).toString();
      totals = {
        treasuries: counted.length,
        held: counted.reduce((n, r) => n + BigInt(r.balance), 0n).toString(),
        runs: tt.reduce((n, t) => n + (t?.runs ?? 0), 0),
        repaid: sum((t) => t.repaid), compute: sum((t) => t.compute), claims: sum((t) => t.claims), guarantee: sum((t) => t.guarantee), vouch: sum((t) => t.vouch),
        factorOwn: rows.length - counted.length,
      };
    }
    return {
      enabled: on, contract: c.contract, fromBlock: c.fromBlock === null ? null : c.fromBlock.toString(), chainId: this.d.chainId,
      rules: { minStep: TREASURY_RULES.minStep, maxClaims: TREASURY_RULES.maxClaims, day: TREASURY_RULES.day, order: TREASURY_RULES.order },
      totals,
    };
  }

  private receipt(m: MoveRow): ReceiptView {
    const eth = ethText(m.amount);
    const text = m.kind === "repay" ? `Repaid ${eth} ETH of its credit line${m.rest === "0" ? ": the line owes nothing" : ""}`
      : m.kind === "compute" ? `Prepaid ${eth} ETH of compute at the gateway`
      : m.kind === "claim" ? `Bought the locked pay of job ${m.other ?? "?"} (claim ${m.ref}) for ${eth} ETH`
      : m.kind === "guarantee" ? `Added ${eth} ETH to its guarantee bond`
      : `Added ${eth} ETH to its vouching bond`;
    return { kind: m.kind as ReceiptView["kind"], text, amount: m.amount, amountEth: ethNum(m.amount), at: iso(m.at), tx: m.tx_hash, ...(m.kind === "claim" ? { claim: m.ref } : {}) };
  }

  /** An agent's runs, newest first, each with its steps in the order they were taken. */
  runs(agent: string, limit = 10): RunView[] {
    const moves = this.moves(agent);
    const byTx = new Map<string, MoveRow[]>();
    for (const m of moves) byTx.set(m.tx_hash, [...(byTx.get(m.tx_hash) ?? []), m]);
    const out: RunView[] = [];
    for (const m of moves) {
      if (m.kind !== "run") continue;
      const all = (byTx.get(m.tx_hash) ?? []).sort((x, y) => x.log_index - y.log_index);
      out.push({ tx: m.tx_hash, at: iso(m.at), by: m.other, spent: m.amount, spentEth: ethNum(m.amount), steps: all.filter((x) => RECEIPTS.includes(x.kind)).map((x) => this.receipt(x)), skipped: all.filter((x) => x.kind === "skipped").length });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** One treasury as the site shows it; null while off or it was never used. */
  json(agent: string): TreasuryView | null {
    if (!this.on()) return null;
    const t = this.row(agent);
    if (!t) return null;
    const rules = parse<TreasuryRulesJson>(t.rules);
    const balance = BigInt(t.balance);
    const floor = rules ? BigInt(rules.floor) : 0n;
    return {
      agent, name: this.name(agent), named: this.d.names().has(agent),
      balance: t.balance, balanceEth: ethNum(t.balance), spendable: (balance > floor ? balance - floor : 0n).toString(),
      rules, totals: parse<TreasuryTotalsJson>(t.totals), runs: this.runs(agent), next: parse<TreasuryNextJson>(t.next),
      openedAt: iso(t.at), factorOwn: this.d.factorOwn(agent),
    };
  }

  /** The treasuries, the latest run first. */
  list(limit = 30): TreasuryView[] {
    if (!this.on()) return [];
    const rows = this.d.db.q("SELECT agent FROM treasury_agents ORDER BY ran_at DESC, at DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 100)) as { agent: string }[];
    return rows.map((r) => this.json(r.agent)).filter((x): x is TreasuryView => !!x);
  }

  /**
   * The receipts of a treasury on its agent's credit report: by any of the agent's wallets (its own, its owner's, its desk
   * addresses, and the key of a line account among them). null while off or none of them has a treasury that ran.
   */
  forReport(addresses: (string | null)[]): ReportTreasuryJson | null {
    if (!this.on()) return null;
    const mine = new Set(addresses.filter((a): a is string => !!a).map((a) => a.toLowerCase()));
    for (const a of [...mine]) {
      const key = (this.d.db.q("SELECT key FROM lines WHERE account = ?").get(a) as { key: string } | undefined)?.key;
      if (key) mine.add(key);
    }
    for (const a of mine) {
      const t = this.row(a);
      if (!t) continue;
      const receipts = this.moves(a, 100).filter((m) => RECEIPTS.includes(m.kind)).slice(0, 20).map((m) => this.receipt(m));
      if (!receipts.length) continue;
      return { agent: a, balance: t.balance, runs: parse<TreasuryTotalsJson>(t.totals)?.runs ?? this.runs(a, 100).length, receipts };
    }
    return null;
  }

  /** For the owner's health answer. */
  health(): Record<string, unknown> {
    const n = (sql: string) => (this.d.db.q(sql).get() as { n: number }).n;
    return {
      reading: this.reading(), on: this.on(), contract: this.d.cfg.contract,
      treasuries: n("SELECT COUNT(*) AS n FROM treasury_agents"), holding: n("SELECT COUNT(*) AS n FROM treasury_agents WHERE balance != '0'"),
      runs: n("SELECT COUNT(*) AS n FROM treasury_moves WHERE kind = 'run'"), runnable: this.runnable().length, everyMin: this.d.cfg.everyMin, note: this.d.cfg.note,
    };
  }
}

const iso = (s: number): string => new Date(s * 1000).toISOString();
const ethNum = (wei: string): number => Number(formatEther(BigInt(wei)));
const ethText = (wei: string): string => {
  const n = ethNum(wei);
  return n >= 0.01 ? n.toFixed(4) : n.toFixed(6);
};
const parse = <T>(s: string | null): T | null => {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
};
const anyRule = (r: TreasuryRulesJson): boolean => r.floor !== "0" || r.repay.on || r.compute.on || r.claims.on || r.guarantee.on || r.vouch.on;

/** The contract's Rules struct, as read from rulesOf() or a RulesSet log, in the site's shape. */
export function rulesJson(r: Record<string, unknown> | null | undefined): TreasuryRulesJson | null {
  if (!r || r.floor === undefined) return null;
  const s = (v: unknown) => BigInt(String(v ?? "0")).toString();
  return {
    floor: s(r.floor),
    repay: { on: !!r.repay, daily: s(r.repayDaily) },
    compute: { on: !!r.compute, daily: s(r.computeDaily) },
    claims: { on: !!r.claims, daily: s(r.claimsDaily), maxPrice: s(r.claimMaxPrice), minDiscountBps: Number(r.claimMinDiscountBps ?? 0), minScore: Number(r.claimMinScore ?? 0), deliveredOnly: !!r.claimDeliveredOnly },
    guarantee: { on: !!r.guarantee, upTo: s(r.guaranteeUpTo) },
    vouch: { on: !!r.vouch, upTo: s(r.vouchUpTo) },
  };
}

function totalsJson(t: Record<string, unknown> | null | undefined): TreasuryTotalsJson | null {
  if (!t || t.deposited === undefined) return null;
  const s = (v: unknown) => BigInt(String(v ?? "0")).toString();
  return { deposited: s(t.deposited), withdrawn: s(t.withdrawn), repaid: s(t.repaid), compute: s(t.compute), claims: s(t.claims), guarantee: s(t.guarantee), vouch: s(t.vouch), runs: Number(t.runs ?? 0), claimsBought: Number(t.claimsBought ?? 0) };
}
