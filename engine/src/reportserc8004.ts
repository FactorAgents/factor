// Credit scores on ERC-8004: Factor writes every ranked agent's credit report score (./reports.ts) to the standard's
// reputation registry on Robinhood Chain, so any app that reads ERC-8004 sees it straight from the registry, without
// asking Factor (docs/REPORTS.md, section 9; docs/RELEASE-reports-erc8004.md).
//
// Each entry is the one ./reports.ts has prepared since the reports went live, now sent:
//
//   giveFeedback(agentId, score, 0, "factorReport", "1.1.0", "", <site>/api/v1/erc8004/report/<n>, keccak256(<the file>))
//
// The value is the report's score, 0 to 1000, with no decimals; the first tag keeps it apart from Factor's job entries
// ("factor") and Factor Scores ("factorScore"), the second is the formula's version. The file says which identity, the
// score and its five parts, the score before, the block the chain was read to and the report's page; it is fixed once
// written, kept here word for word and served at its own address, so its keccak256 is the hash on the chain. So
//
//   getSummary(agentId, [Factor's writer], "factorReport", "")  ->  (1, 223, 0)   = a credit score of 223
//
// is the score as Factor last wrote it, and readAllFeedback(..., includeRevoked = true) its history.
//
// Who: every RANKED agent with an ERC-8004 identity: a score above 0, not Factor's own (ranked apart, never written).
// Once written, an agent is followed: when its score changes, the new entry is written and, once it is mined, the one
// before it is revoked, so exactly one report entry from Factor stands for each agent. No sooner than
// REPORTS_ERC8004_EVERY_H hours (168, a week) after its last entry, except a fall to 0, written at once. A new formula
// version counts as a change. The first run writes the best scores first.
//
// How: the gas wallet writes, as it writes the job entries and the Factor Scores (./chain/act.ts, the same attempt: the
// lock, a simulation of exactly the call, the gas against its cap, then the transaction followed to its receipt). The
// entries and revokes of 24 hours never cost more than REPORTS_ERC8004_GAS_DAY_WEI, counted at the most each could have
// cost. Each entry is written down here before it is sent, so a restart finds it and the transaction it went out in; and
// before every entry the registry's own count of the gas wallet's entries for that identity is read against Factor's
// notes: more on the chain than in the notes and nothing more is written to it, so an entry is never written twice.
//
// Switches: REPORTS_ERC8004=on (off unless it is said) writes, and needs REPORTS=on; the owner's "reports8004" switch
// (./switches.ts) stops it at once, and the "reports" switch stops it with the reports. What was written stays on the chain.

import { decodeEventLog, getAddress, keccak256, toHex, type Abi, type Hex } from "viem";
import { erc8004ReputationAbi } from "./abi/index.js";
import type { Outcome } from "./chain/act.js";
import type { CallSpec, Chain, Fees, Head, Receipt } from "./chain/chain.js";
import type { Ctx } from "./chain/context.js";
import type { EngineDb } from "./chain/db.js";
import { entriesKnown } from "./erc8004.js";
import type { Reports } from "./reports.js";
import { REPORT_VERSION } from "./reportscore.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

/** The first tag of a report entry: apart from Factor's job entries ("factor") and Factor Scores ("factorScore"). */
export const REPORT_TAG1 = "factorReport";
/** The second tag: the formula's version. */
export const REPORT_TAG2 = REPORT_VERSION.split("/")[1]!;
/** The value has no decimals: the score 0 to 1000 as it is. */
export const REPORT_DECIMALS = 0;
const BPS = 10_000n;
/**
 * The day's gas by default: 0.004 ETH. A giveFeedback of a report costs about 200,000 gas on Robinhood Chain (the node's own
 * estimate, 198,246 on 11 Nov 2026), and gas was 0.0202 gwei; counted at the most each could cost (the fee cap, about 1.2
 * times the base fee), 405 entries come to about 0.002 ETH. Twice that leaves room for gas to double and the first full
 * run still to finish in one day.
 */
export const REPORTS_ERC8004_GAS_DAY_DEFAULT = 4_000_000_000_000_000n;

export interface ReportsErc8004Config {
  /** REPORTS_ERC8004=on: off unless it is said. Needs REPORTS=on */
  enabled: boolean;
  /** REPORTS_ERC8004_EVERY_H: the fewest hours between two entries for one agent (168, a week), unless it falls to 0 */
  everyH: number;
  /** REPORTS_ERC8004_GAS_DAY_WEI: the most the entries and revokes may cost the gas wallet in 24 hours (0.004 ETH) */
  gasDayWei: bigint;
  /** REPORTS_ERC8004_PER_PASS: sent in one pass of the keeper at most (10) */
  perPass: number;
  site: string;
}

export function readReportsErc8004(env: Env, problems: string[] = []): ReportsErc8004Config {
  const raw = (env.REPORTS_ERC8004 ?? "").trim().toLowerCase();
  if (raw && raw !== "on" && raw !== "off") problems.push(`REPORTS_ERC8004 must be on or off: it is "${env.REPORTS_ERC8004}"`);
  let gasDayWei = REPORTS_ERC8004_GAS_DAY_DEFAULT;
  const rawGas = env.REPORTS_ERC8004_GAS_DAY_WEI?.trim();
  if (rawGas) {
    if (/^\d{1,30}$/.test(rawGas)) gasDayWei = BigInt(rawGas);
    else problems.push(`REPORTS_ERC8004_GAS_DAY_WEI must be whole wei, as digits: it is "${rawGas}"`);
  }
  const whole = (name: string, def: number, min: number, max: number): number => {
    const v = env[name]?.trim();
    if (!v) return def;
    if (/^\d{1,6}$/.test(v) && Number(v) >= min && Number(v) <= max) return Number(v);
    problems.push(`${name} must be a whole number from ${min} to ${max}: it is "${v}"`);
    return def;
  };
  return {
    enabled: raw === "on", gasDayWei, everyH: whole("REPORTS_ERC8004_EVERY_H", 168, 0, 24 * 90), perPass: whole("REPORTS_ERC8004_PER_PASS", 10, 1, 50),
    site: (env.FACTOR_SITE_URL?.trim() || "https://factoragents.fun").replace(/\/+$/, ""),
  };
}

export interface ReportFile {
  agentRegistry: string;
  agentId: number | string;
  clientAddress: string | null;
  createdAt: string;
  value: number;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  factor: { report: string; version: string; score: number; of: 1000; parts: Record<string, number>; before?: number | null; block: number | null };
}

/** The file a report entry points at: the standard's fields, Factor's beside them. Compact JSON; its keccak256 is the hash on the chain. */
export function reportFile(o: { chainId: number; identity: string; agentId: string; writer: string | null; site: string; score: number; parts: Record<string, number>; block: number | null; atS: number; before?: number | null }): { file: ReportFile; body: string; hash: Hex } {
  const id = BigInt(o.agentId);
  const file: ReportFile = {
    agentRegistry: `eip155:${o.chainId}:${getAddress(o.identity)}`,
    agentId: id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : id.toString(),
    clientAddress: o.writer ? `eip155:${o.chainId}:${getAddress(o.writer)}` : null,
    createdAt: new Date(o.atS * 1000).toISOString(),
    value: o.score,
    valueDecimals: REPORT_DECIMALS,
    tag1: REPORT_TAG1,
    tag2: REPORT_TAG2,
    factor: { report: `${o.site}/reports/${o.agentId}`, version: REPORT_VERSION, score: o.score, of: 1000, parts: o.parts, ...(o.before !== undefined ? { before: o.before } : {}), block: o.block },
  };
  const body = JSON.stringify(file);
  return { file, body, hash: keccak256(toHex(body)) };
}

export type EntryStatus = "queued" | "sent" | "done" | "failed" | "refused";
export interface EntryRow {
  n: number; agent_id: string; writer: string; score: number; version: string; block: number | null; uri: string; hash: string; body: string;
  status: EntryStatus; tx_hash: string | null; feedback_index: number | null; mined_block: number | null; error: string | null;
  revoke_status: "sent" | "done" | null; revoke_tx: string | null; created_at: number; updated_at: number;
}

export const REPORT_ERC8004_SCHEMA = `
-- Credit report scores written to ERC-8004 (./reportserc8004.ts): each entry, its file word for word, and its transaction.
-- Never taken back by a reindex: what is on the chain is there.
CREATE TABLE IF NOT EXISTS report_erc8004 (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  writer TEXT NOT NULL,
  score INTEGER NOT NULL,
  version TEXT NOT NULL,
  block INTEGER,
  uri TEXT NOT NULL,
  hash TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,              -- queued | sent | done | failed | refused
  tx_hash TEXT,
  feedback_index INTEGER,
  mined_block INTEGER,
  error TEXT,
  revoke_status TEXT,                -- NULL | sent | done: the entry was revoked once a newer one stood
  revoke_tx TEXT,
  created_at INTEGER NOT NULL,       -- ms
  updated_at INTEGER NOT NULL        -- ms
);
CREATE INDEX IF NOT EXISTS report_erc8004_agent ON report_erc8004 (agent_id, writer, n);
`;

const REFUSED_FOR_GOOD = /Self-feedback not allowed|ERC721NonexistentToken/;

/** A report's place on ERC-8004, as the report page, its API, the signed answer and the kit show it. */
export interface ReportOnChain {
  /** whether a report entry from Factor is on the registry for it */
  written: boolean;
  /** when its first entry was mined */
  since: string | null;
  /** the standing entry: its score, the formula's version, the transaction, its number in the registry, when */
  score: number | null; version: string | null; tx: string | null; txUrl: string | null; index: number | null; at: string | null;
  /** its file, word for word, at this address; its keccak256 is the entry's hash */
  uri: string | null;
  /** entries written for it in all; each newer one revokes the one before */
  entries: number;
  reviewer: string | null;
  registry: string;
  tag1: string;
  /** how anyone reads it from the registry itself */
  read: string;
  /** not written yet: the entry Factor would write, prepared */
  prepared: string | null;
}

export interface ReportsErc8004Deps {
  db: EngineDb;
  reports: () => Reports | null;
  chain: Pick<Chain, "read">;
  chainId: number;
  explorer: string;
  now: () => number;
  /** the chain's time, seconds */
  nowS: () => number;
  /** the gas wallet's address, the writer */
  writer: () => string | null;
  log: (line: string) => void;
}

type Attempt = (kind: "erc8004_report", ref: string, call: CallSpec, detail: Record<string, unknown>, feeCap: bigint, pre?: { gas: bigint; fees: Fees }) => Promise<Outcome>;

export class ReportsErc8004 {
  constructor(readonly cfg: ReportsErc8004Config, private d: ReportsErc8004Deps) {
    d.db.db.exec(REPORT_ERC8004_SCHEMA);
  }

  /** Writing now: switched on, the reports on, and the owner has not stopped it. */
  on(): boolean {
    return this.cfg.enabled && !!this.d.reports()?.on() && !stopped(this.d.db, "reports8004");
  }

  row(n: number): EntryRow | null {
    return (this.d.db.q("SELECT * FROM report_erc8004 WHERE n = ?").get(n) as EntryRow | undefined) ?? null;
  }

  /** The newest entry for an identity from a writer that is on the chain or on its way. */
  last(agentId: string, writer: string): EntryRow | null {
    return (this.d.db.q("SELECT * FROM report_erc8004 WHERE agent_id = ? AND writer = ? AND status IN ('sent', 'done') ORDER BY n DESC LIMIT 1").get(agentId, writer) as EntryRow | undefined) ?? null;
  }

  /**
   * The agents whose report is due to be written: every ranked agent with an identity not yet written, best first; then
   * every one written before whose score or formula changed, once its week is over (at once for a fall to 0), the ones
   * that moved most first.
   */
  due(writer: string): { agentId: string; score: number; before: number | null; parts: Record<string, number> }[] {
    const reports = this.d.reports();
    if (!reports) return [];
    const now = this.d.now();
    const firsts: { agentId: string; score: number; before: null; parts: Record<string, number> }[] = [];
    const changes: { agentId: string; score: number; before: number; parts: Record<string, number>; moved: number }[] = [];
    for (const a of reports.writable()) {
      if (a.owner === writer || a.wallet === writer) continue; // the registry refuses an owner's entry for its own identity
      // one written down and not yet sent: it is on its way, unless it is old (the process stopped in between)
      // one that failed is tried again ten minutes later; one the registry refuses for good, never for that identity
      const held = this.d.db.q("SELECT n FROM report_erc8004 WHERE agent_id = ? AND writer = ? AND ((status IN ('queued', 'failed') AND updated_at > ?) OR status = 'refused')").get(a.agentId, writer, now - 600_000);
      if (held) continue;
      const last = this.last(a.agentId, writer);
      if (!last) {
        if (a.score > 0 && !a.factorOwn) firsts.push({ agentId: a.agentId, score: a.score, before: null, parts: a.parts });
        continue;
      }
      if (last.status === "sent" || a.factorOwn) continue;
      if (a.score === last.score && last.version === REPORT_VERSION) continue;
      const soon = now - last.created_at < this.cfg.everyH * 3_600_000;
      if (soon && !(a.score === 0 && last.score > 0)) continue;
      changes.push({ agentId: a.agentId, score: a.score, before: last.score, parts: a.parts, moved: Math.abs(a.score - last.score) });
    }
    firsts.sort((x, y) => y.score - x.score || Number(x.agentId) - Number(y.agentId));
    changes.sort((x, y) => y.moved - x.moved);
    return [...firsts, ...changes.map(({ moved: _m, ...x }) => x)];
  }

  /** Entries that a newer one from the same writer has replaced, mined and not yet revoked. */
  replaced(writer: string): EntryRow[] {
    return this.d.db.q(`SELECT s.* FROM report_erc8004 s WHERE s.writer = ? AND s.status = 'done' AND s.revoke_status IS NULL AND s.feedback_index IS NOT NULL
      AND EXISTS (SELECT 1 FROM report_erc8004 t WHERE t.agent_id = s.agent_id AND t.writer = s.writer AND t.status = 'done' AND t.n > s.n) ORDER BY s.n LIMIT 20`).all(writer) as EntryRow[];
  }

  /** What the entries and revokes cost the gas wallet in the last 24 hours, at the most it could have paid a gas. */
  spentToday(): bigint {
    const rows = this.d.db.q("SELECT status, gas_used, gas_limit, max_fee_wei FROM engine_actions WHERE kind = 'erc8004_report' AND mode = 'live' AND tx_hash IS NOT NULL AND created_at >= ?").all(this.d.now() - 86_400_000) as { status: string; gas_used: string | null; gas_limit: string | null; max_fee_wei: string | null }[];
    let sum = 0n;
    for (const r of rows) sum += BigInt(r.gas_used ?? (r.status === "signed" || r.status === "sent" ? (r.gas_limit ?? "0") : "0")) * BigInt(r.max_fee_wei ?? "0");
    return sum;
  }

  /** The call and the file of one entry. `n` is the entry's number, in its address; 0 for one only shown (dry). */
  entry(o: { agentId: string; writer: string; score: number; before: number | null; parts: Record<string, number>; block: number | null; n: number }): { call: CallSpec; body: string; hash: Hex; uri: string } {
    const r = this.d.reports()!;
    const made = reportFile({ chainId: this.d.chainId, identity: r.cfg.identity, agentId: o.agentId, writer: o.writer, site: this.cfg.site, score: o.score, parts: o.parts, block: o.block, atS: this.d.nowS(), before: o.before });
    const uri = `${this.cfg.site}/api/v1/erc8004/report/${o.n}`;
    const call: CallSpec = { to: r.cfg.reputation, abi: erc8004ReputationAbi as Abi, functionName: "giveFeedback", args: [BigInt(o.agentId), BigInt(o.score), REPORT_DECIMALS, REPORT_TAG1, REPORT_TAG2, "", uri, made.hash] };
    return { call, body: made.body, hash: made.hash, uri };
  }

  /** The entry's number in the registry, from the transaction's logs. */
  indexOf(r: Receipt): number | null {
    const rep = this.d.reports()?.cfg.reputation.toLowerCase();
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== rep) continue;
      try {
        const x = decodeEventLog({ abi: erc8004ReputationAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
        if (x.eventName === "NewFeedback") return Number((x.args as { feedbackIndex: bigint }).feedbackIndex);
      } catch {
        // another event
      }
    }
    return null;
  }

  private mark(n: number, f: Partial<Pick<EntryRow, "status" | "tx_hash" | "feedback_index" | "mined_block" | "error" | "revoke_status" | "revoke_tx">>): void {
    const sets = Object.keys(f).map((k) => `${k} = @${k}`).join(", ");
    this.d.db.q(`UPDATE report_erc8004 SET ${sets}, updated_at = @now WHERE n = @n`).run({ ...f, now: this.d.now(), n });
  }

  /** A transaction of an entry's (ref w:<n>) or a revoke's (r:<n>), mined, or found never to have been. */
  landed(ref: string, hash: string, r: Receipt): void {
    const m = /^([wr]):(\d+)$/.exec(ref);
    if (!m) return;
    const n = Number(m[2]);
    if (m[1] === "w") {
      if (r.ok) {
        this.mark(n, { status: "done", tx_hash: hash, feedback_index: this.indexOf(r), mined_block: Number(r.blockNumber), error: null });
        this.d.log(`[reports8004] entry ${n} is on ERC-8004: ${hash}`);
      } else this.mark(n, { status: "failed", tx_hash: hash, error: `the transaction reverted (${hash})` });
    } else this.mark(n, r.ok ? { revoke_status: "done", revoke_tx: hash } : { revoke_status: null, revoke_tx: null });
  }

  unsent(ref: string, why: string): void {
    const m = /^([wr]):(\d+)$/.exec(ref);
    if (!m) return;
    if (m[1] === "w") this.mark(Number(m[2]), { status: "failed", tx_hash: null, error: why });
    else this.mark(Number(m[2]), { revoke_status: null, revoke_tx: null });
  }

  /** One pass of the keeper: replaced entries revoked first, then the reports that are due written. */
  async step(ctx: Ctx, head: Head, attempt: Attempt): Promise<string> {
    if (!this.cfg.enabled) return "REPORTS_ERC8004 is off: no credit report is written to ERC-8004";
    const reports = this.d.reports();
    if (!reports || !reports.cfg.enabled) return "REPORTS is off: there is no report to write";
    const off = stopped(this.d.db, "reports8004") ?? stopped(this.d.db, "reports");
    if (off) return `stopped by the owner${off.note ? `: ${off.note}` : ""}`;
    if (!reports.caughtUp()) return "the reports are still reading the chain: nothing is written before every agent is scored";
    const writer = ctx.facts.bot;
    if (!writer) return "the engine holds no gas wallet key: nothing can be written";
    const db = this.d.db;
    const live = ctx.mode === "live" && !!ctx.signer;
    const said: string[] = [];
    let sent = 0;
    // written down and never sent (the process stopped in between): set aside, so it is not taken for one on its way
    db.q("UPDATE report_erc8004 SET status = 'failed', error = 'never sent: the process stopped in between', updated_at = ? WHERE status = 'queued' AND updated_at < ?").run(this.d.now(), this.d.now() - 600_000);
    const ready = (ref: string): boolean => {
      const prev = db.lastAction("erc8004_report", ref);
      if (!prev) return true;
      if (prev.status === "signed" || prev.status === "sent") return false;
      if (prev.status === "failed") return this.d.now() - prev.updated_at > 600_000;
      if (prev.status === "dry") return this.d.now() - prev.created_at > 1_800_000;
      return true;
    };
    // what one more could cost, against what the day allows
    const fits = async (call: CallSpec): Promise<{ gas: bigint; fees: Fees } | "over" | undefined> => {
      try {
        const [gas, fees] = await Promise.all([ctx.chain.estimateGas(call, writer), ctx.chain.fees()]);
        if (live && this.spentToday() + ((gas * (BPS + BigInt(ctx.params.gasHeadroomBps))) / BPS) * fees.maxFeePerGas > this.cfg.gasDayWei) return "over";
        return { gas, fees };
      } catch {
        return undefined; // a refusal: the attempt tries it and says why
      }
    };
    const SPENT = "the day's gas for credit reports is spent (REPORTS_ERC8004_GAS_DAY_WEI): the rest wait";
    for (const old of this.replaced(writer)) {
      if (sent >= this.cfg.perPass || ctx.stopping()) break;
      const ref = `r:${old.n}`;
      if (!ready(ref)) continue;
      const call: CallSpec = { to: reports.cfg.reputation, abi: erc8004ReputationAbi as Abi, functionName: "revokeFeedback", args: [BigInt(old.agent_id), BigInt(old.feedback_index!)] };
      const pre = await fits(call);
      if (pre === "over") { said.push(SPENT); return said.join("; "); }
      const out = await attempt("erc8004_report", ref, call, { revoke: old.n, agentId: old.agent_id, index: old.feedback_index }, ctx.params.maxGasWei, pre);
      sent++;
      if (out.status === "done" && out.hash && out.receipt) this.landed(ref, out.hash, out.receipt);
      else if (out.status === "sent" && out.hash) this.mark(old.n, { revoke_status: "sent", revoke_tx: out.hash });
      else if (out.status === "failed" && /Already revoked/.test(out.why)) this.mark(old.n, { revoke_status: "done" });
      said.push(`${out.status === "dry" ? "would revoke" : out.status === "done" ? "revoked" : out.status} report entry ${old.n} (#${old.agent_id}, index ${old.feedback_index})${out.status === "failed" || out.status === "skipped" ? `: ${out.why}` : ""}`);
      if (db.openActions().length > 0) return said.join("; ");
    }
    const block = reports.readTo();
    let wrote = 0;
    const due = this.due(writer);
    for (const x of due) {
      if (sent >= this.cfg.perPass || ctx.stopping()) break;
      if (!live && !ready(`show:${x.agentId}`)) continue;
      // the registry's own count of the gas wallet's entries for this identity against Factor's notes: never twice
      let onChain: bigint;
      try {
        onChain = await this.d.chain.read<bigint>({ to: reports.cfg.reputation, abi: erc8004ReputationAbi as Abi, functionName: "getLastIndex", args: [BigInt(x.agentId), writer] });
      } catch (e) {
        said.push(`#${x.agentId}: the registry could not be read (${(e as Error).message?.slice(0, 120)}): tried again next pass`);
        break;
      }
      const ours = entriesKnown(db, x.agentId, writer);
      if (onChain > BigInt(ours)) {
        const why = `the registry holds ${onChain} entries from ${writer} for identity #${x.agentId}, and Factor's notes ${ours}: nothing more is written to it until that is looked at`;
        if (live) db.q("INSERT INTO report_erc8004 (agent_id, writer, score, version, block, uri, hash, body, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', '', '', 'refused', ?, ?, ?)").run(x.agentId, writer, x.score, REPORT_VERSION, block, why, this.d.now(), this.d.now());
        this.d.log(`[reports8004] ${why}`);
        said.push(why);
        continue;
      }
      // the entry is written down before anything is sent, so the file its address names is there whatever happens next
      let n = 0;
      if (live) n = Number(db.q("INSERT INTO report_erc8004 (agent_id, writer, score, version, block, uri, hash, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', '', '', 'queued', ?, ?)").run(x.agentId, writer, x.score, REPORT_VERSION, block, this.d.now(), this.d.now()).lastInsertRowid);
      const made = this.entry({ ...x, writer, block, n });
      if (live) db.q("UPDATE report_erc8004 SET uri = ?, hash = ?, body = ? WHERE n = ?").run(made.uri, made.hash, made.body, n);
      const ref = `w:${n}`;
      const pre = await fits(made.call);
      if (pre === "over") {
        if (live) db.q("DELETE FROM report_erc8004 WHERE n = ?").run(n);
        said.push(SPENT);
        break;
      }
      const out = await attempt("erc8004_report", live ? ref : `show:${x.agentId}`, made.call, { agentId: x.agentId, score: x.score, before: x.before, uri: made.uri, hash: made.hash }, ctx.params.maxGasWei, pre);
      sent++;
      if (out.status === "done" && out.hash && out.receipt) { this.landed(ref, out.hash, out.receipt); wrote++; }
      else if (out.status === "sent" && out.hash) this.mark(n, { status: "sent", tx_hash: out.hash });
      else if (live) {
        if (out.hash && out.receipt) this.landed(ref, out.hash, out.receipt);
        else this.mark(n, { status: REFUSED_FOR_GOOD.test(out.why) ? "refused" : "failed", error: out.why });
      }
      if (out.status === "failed" || out.status === "skipped") said.push(`#${x.agentId} (${x.score}): ${out.status}, ${out.why}`);
      else if (out.status === "dry") said.push(`would write the report of #${x.agentId} (${x.score}${x.before === null ? "" : `, was ${x.before}`})`);
      if (out.status === "skipped" || db.openActions().length > 0) break;
    }
    if (wrote) said.unshift(`wrote ${wrote} report${wrote === 1 ? "" : "s"} (${due.length - wrote} more due)`);
    return said.length ? said.join("; ") : "every ranked report is on ERC-8004 as it stands";
  }

  // ---------- what the site and apps read ----------

  private reviewer(): string | null {
    const w = this.d.writer();
    return w ? getAddress(w) : null;
  }

  private readHow(): string {
    const rep = this.d.reports()?.cfg.reputation ?? "0x8004baa17c55a88189ae136b182e5fda19de9b63";
    return `getSummary(agentId, [${this.reviewer() ?? "Factor's gas wallet"}], "${REPORT_TAG1}", "") on ${getAddress(rep)}`;
  }

  /** A report's place on ERC-8004: written (since when, its transaction), or prepared and not yet written. */
  ofAgent(agentId: string): ReportOnChain {
    const db = this.d.db;
    const r = db.q("SELECT * FROM report_erc8004 WHERE agent_id = ? AND status = 'done' ORDER BY n DESC LIMIT 1").get(agentId) as EntryRow | undefined;
    const first = db.q("SELECT updated_at FROM report_erc8004 WHERE agent_id = ? AND status = 'done' ORDER BY n LIMIT 1").get(agentId) as { updated_at: number } | undefined;
    const entries = (db.q("SELECT COUNT(*) AS n FROM report_erc8004 WHERE agent_id = ? AND status = 'done'").get(agentId) as { n: number }).n;
    const rep = this.d.reports()?.cfg.reputation ?? "0x8004baa17c55a88189ae136b182e5fda19de9b63";
    const base = { registry: getAddress(rep), tag1: REPORT_TAG1, read: this.readHow().replace("agentId", agentId), entries };
    if (!r) return { written: false, since: null, score: null, version: null, tx: null, txUrl: null, index: null, at: null, uri: null, reviewer: this.reviewer(), prepared: `${this.cfg.site}/api/v1/reports/erc8004/${agentId}`, ...base };
    return {
      written: true, since: new Date(first!.updated_at).toISOString(), score: r.score, version: r.version, tx: r.tx_hash, txUrl: r.tx_hash ? `${this.d.explorer}/tx/${r.tx_hash}` : null, index: r.feedback_index,
      at: new Date(r.updated_at).toISOString(), uri: r.uri, reviewer: getAddress(r.writer), prepared: null, ...base,
    };
  }

  /** The file an entry points at, word for word, once its entry is on its way or written. */
  file(n: number): string | null {
    const r = this.row(n);
    return r && (r.status === "sent" || r.status === "done") ? r.body : null;
  }

  /** What /v1/reports says of it: how many reports are on ERC-8004, and how to read them. */
  about(): Record<string, unknown> {
    const db = this.d.db;
    const c = (sql: string) => (db.q(sql).get() as { n: number }).n;
    const first = db.q("SELECT tx_hash, updated_at FROM report_erc8004 WHERE status = 'done' ORDER BY n LIMIT 1").get() as { tx_hash: string; updated_at: number } | undefined;
    const last = db.q("SELECT tx_hash, updated_at FROM report_erc8004 WHERE status = 'done' ORDER BY n DESC LIMIT 1").get() as { tx_hash: string; updated_at: number } | undefined;
    return {
      enabled: this.on(), reports: c("SELECT COUNT(DISTINCT agent_id) AS n FROM report_erc8004 WHERE status = 'done'"), entries: c("SELECT COUNT(*) AS n FROM report_erc8004 WHERE status = 'done'"),
      tag1: REPORT_TAG1, tag2: REPORT_TAG2, valueDecimals: REPORT_DECIMALS, reviewer: this.reviewer(), everyH: this.cfg.everyH,
      since: first ? new Date(first.updated_at).toISOString() : null, firstTx: first?.tx_hash ?? null, lastTx: last?.tx_hash ?? null, lastTxUrl: last?.tx_hash ? `${this.d.explorer}/tx/${last.tx_hash}` : null, lastAt: last ? new Date(last.updated_at).toISOString() : null,
      read: this.readHow(),
    };
  }

  /** For the owner's health answer: the counts by state, the day's gas against its cap, and the first and last transactions. */
  health(): Record<string, unknown> {
    const db = this.d.db;
    const by = Object.fromEntries((db.q("SELECT status, COUNT(*) AS n FROM report_erc8004 GROUP BY status").all() as { status: string; n: number }[]).map((r) => [r.status, r.n]));
    const revoked = (db.q("SELECT COUNT(*) AS n FROM report_erc8004 WHERE revoke_status = 'done'").get() as { n: number }).n;
    const paid = db.q("SELECT COUNT(*) AS n, COALESCE(SUM(CAST(gas_used AS INTEGER)), 0) AS gas FROM engine_actions WHERE kind = 'erc8004_report' AND mode = 'live' AND status = 'done'").get() as { n: number; gas: number };
    const a = this.about();
    return { on: this.on(), byStatus: by, revoked, transactions: paid.n, gasUsed: paid.gas, spentTodayWei: this.spentToday().toString(), gasDayWei: this.cfg.gasDayWei.toString(), perPass: this.cfg.perPass, everyH: this.cfg.everyH, reports: a.reports, firstTx: a.firstTx, lastTx: a.lastTx };
  }
}
