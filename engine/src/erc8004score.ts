// The Factor Score on ERC-8004: Factor writes an agent's score to the standard's reputation registry on Robinhood Chain,
// so any marketplace that reads ERC-8004 sees it without asking Factor.
//
// What the registry is (read from the deployed ReputationRegistryUpgradeable 2.0.0 behind 0x8004BAa1...9b63, source on
// Sourcify for chain 4663): anyone may give an identity an entry, a value of up to 18 decimals with two tags, a link and a
// hash, except the identity's owner and those it approved ("Self-feedback not allowed"); an entry's writer may revoke it;
// getSummary(agentId, [writers], tag1, tag2) averages the entries that are not revoked, read with their decimals.
//
// So each entry Factor writes here is:
//
//   giveFeedback(agentId, score, 1, "factorScore", "", "", <site>/api/v1/erc8004/score/<n>, keccak256(<the file>))
//
// The value is the desk's own score of the agent, 0 to 1000, with one decimal: 0.0 to 100.0, the scale most readers of
// ERC-8004 expect. Its own first tag keeps it apart from the job entries (tag "factor", ./erc8004.ts), whose values are
// 100 and 50: an app that averages Factor's job entries is not handed scores, and the other way round. Once a new score
// entry is mined, the one before it is revoked, so exactly one score entry from Factor stands for each agent and
//
//   getSummary(agentId, [Factor's writer], "factorScore", "")  ->  (1, 425, 1)   = a Factor Score of 425
//
// is the score as Factor last wrote it, and readAllFeedback(..., includeRevoked = true) its history. The file says which
// agent, the score, the score before, the block it was read at, the desk, and where anyone checks it on the chain
// (FactorDesk.score(agent)); it is fixed once written, kept here word for word and served at that address.
//
// When: only for an agent linked to an ERC-8004 identity (./erc8004.ts finds it, or the agent signs it; Factor never
// registers or holds an identity for anybody), only once it has a settled job, and only when the score has moved
// meaningfully: by EVERYWHERE_SCORES_STEP points (25) or more since the last entry and no sooner than
// EVERYWHERE_SCORES_EVERY_H hours (24) after it; at once when it moves by four steps or falls to 0 (a job not delivered
// after drawing, or an early half kept). The gas wallet writes it, as it writes the job entries, and the day's entries
// and revokes never cost more than EVERYWHERE_SCORES_GAS_DAY_WEI. EVERYWHERE_SCORES=on (and ERC8004=on, which finds the
// identities) does it; the owner's "scores" switch stops it at once. What was written stays on the chain.

import { decodeEventLog, getAddress, keccak256, toHex, type Abi, type Hex } from "viem";
import { erc8004ReputationAbi } from "./abi/index.js";
import type { Outcome } from "./chain/act.js";
import type { CallSpec, Fees, Head, Receipt } from "./chain/chain.js";
import type { Ctx } from "./chain/context.js";
import type { EngineDb } from "./chain/db.js";
import { DeskStore } from "./desk.js";
import { registryOf, type Erc8004 } from "./erc8004.js";
import { scoreOf } from "./score.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export const SCORE_TAG1 = "factorScore";
export const SCORE_TAG2 = "";
/** The value has one decimal: the score 0 to 1000 reads as 0.0 to 100.0. */
export const SCORE_DECIMALS = 1;
const BPS = 10_000n;

export interface ScoresConfig {
  /** EVERYWHERE_SCORES=on: off unless it is said. Needs ERC8004=on, which finds the agents' identities */
  enabled: boolean;
  /** EVERYWHERE_SCORES_GAS_DAY_WEI: the most the entries and revokes may cost the gas wallet in 24 hours (0.0005 ETH) */
  gasDayWei: bigint;
  /** EVERYWHERE_SCORES_STEP: how far a score moves before it is written again (25 points) */
  step: number;
  /** EVERYWHERE_SCORES_EVERY_H: the fewest hours between two entries for one agent (24), unless it moves four steps or to 0 */
  everyH: number;
  /** EVERYWHERE_SCORES_PER_PASS: sent in one pass at most (3) */
  perPass: number;
  site: string;
}

export function readScores(env: Env, problems: string[] = []): ScoresConfig {
  const raw = (env.EVERYWHERE_SCORES ?? "").trim().toLowerCase();
  if (raw && raw !== "on" && raw !== "off") problems.push(`EVERYWHERE_SCORES must be on or off: it is "${env.EVERYWHERE_SCORES}"`);
  let gasDayWei = 500_000_000_000_000n; // 0.0005 ETH: some hundreds of entries at today's price of gas
  const rawGas = env.EVERYWHERE_SCORES_GAS_DAY_WEI?.trim();
  if (rawGas) {
    if (/^\d{1,30}$/.test(rawGas)) gasDayWei = BigInt(rawGas);
    else problems.push(`EVERYWHERE_SCORES_GAS_DAY_WEI must be whole wei, as digits: it is "${rawGas}"`);
  }
  const whole = (name: string, def: number, min: number, max: number): number => {
    const v = env[name]?.trim();
    if (!v) return def;
    if (/^\d{1,6}$/.test(v) && Number(v) >= min && Number(v) <= max) return Number(v);
    problems.push(`${name} must be a whole number from ${min} to ${max}: it is "${v}"`);
    return def;
  };
  return {
    enabled: raw === "on", gasDayWei, step: whole("EVERYWHERE_SCORES_STEP", 25, 1, 1000), everyH: whole("EVERYWHERE_SCORES_EVERY_H", 24, 0, 24 * 90), perPass: whole("EVERYWHERE_SCORES_PER_PASS", 3, 1, 50),
    site: (env.FACTOR_SITE_URL?.trim() || "https://factoragents.fun").replace(/\/+$/, ""),
  };
}

export interface ScoreFile {
  agentRegistry: string;
  agentId: number | string;
  clientAddress: string;
  createdAt: string;
  value: number;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  factor: { agent: string; score: number; of: 1000; reads: string; before: number | null; block: number; desk: string; check: string; page: string };
}

/** The file a score entry points at: the standard's fields, Factor's beside them. Compact JSON; its keccak256 is the hash on the chain. */
export function scoreFile(o: { chainId: number; identity: string; agentId: string; writer: string; desk: string; site: string; agent: string; name: string | null; score: number; before: number | null; block: number; atS: number }): { file: ScoreFile; body: string; hash: Hex } {
  const id = BigInt(o.agentId);
  const file: ScoreFile = {
    agentRegistry: registryOf(o.chainId, o.identity),
    agentId: id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : id.toString(),
    clientAddress: `eip155:${o.chainId}:${getAddress(o.writer)}`,
    createdAt: new Date(o.atS * 1000).toISOString(),
    value: o.score,
    valueDecimals: SCORE_DECIMALS,
    tag1: SCORE_TAG1,
    tag2: SCORE_TAG2,
    factor: {
      agent: getAddress(o.agent), score: o.score, of: 1000, reads: `${(o.score / 10).toFixed(1)} of 100`, before: o.before, block: o.block, desk: getAddress(o.desk),
      check: `score(${getAddress(o.agent)}) on the desk ${getAddress(o.desk)}`, page: `${o.site}/agents/${o.name ?? o.agent}`,
    },
  };
  const body = JSON.stringify(file);
  return { file, body, hash: keccak256(toHex(body)) };
}

export type ScoreStatus = "queued" | "sent" | "done" | "failed" | "refused";
export interface ScoreRow {
  n: number; agent: string; agent_id: string; writer: string; score: number; block: number; uri: string; hash: string; body: string;
  status: ScoreStatus; tx_hash: string | null; feedback_index: number | null; mined_block: number | null; error: string | null;
  revoke_status: "sent" | "done" | null; revoke_tx: string | null; created_at: number; updated_at: number;
}

const SCHEMA = `
-- The Factor Score written to ERC-8004 (./erc8004score.ts): each entry, its file word for word, and its transaction.
-- Never taken back by a reindex: what is on the chain is there.
CREATE TABLE IF NOT EXISTS erc8004_scores (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  writer TEXT NOT NULL,
  score INTEGER NOT NULL,
  block INTEGER NOT NULL,
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
CREATE INDEX IF NOT EXISTS erc8004_scores_agent ON erc8004_scores (agent_id, writer, n);
`;

const REFUSED_FOR_GOOD = /Self-feedback not allowed|ERC721NonexistentToken/;

export interface ScoreJson {
  /** the score as Factor last wrote it to ERC-8004, its value there (one decimal) and where */
  score: number; value: string; tag1: string; agentId: string; reviewer: string; tx: string; index: number | null; at: string;
  /** entries written for it in all; each newer one revokes the one before */
  written: number;
}

export interface ScoresDeps {
  db: EngineDb;
  erc8004: () => Erc8004 | null;
  chainId: number;
  desk: string;
  now: () => number;
  /** the chain's time, seconds */
  nowS: () => number;
  /** an agent's name on Factor, for the page in the file */
  nameOf: (agent: string) => string | null;
  log: (line: string) => void;
}

type Attempt = (kind: "erc8004_score", ref: string, call: CallSpec, detail: Record<string, unknown>, feeCap: bigint, pre?: { gas: bigint; fees: Fees }) => Promise<Outcome>;

export class Erc8004Scores {
  constructor(readonly cfg: ScoresConfig, private d: ScoresDeps) {
    d.db.db.exec(SCHEMA);
  }

  on(): boolean {
    const e = this.d.erc8004();
    return this.cfg.enabled && !!e?.cfg.enabled && !stopped(this.d.db, "scores");
  }

  row(n: number): ScoreRow | null {
    return (this.d.db.q("SELECT * FROM erc8004_scores WHERE n = ?").get(n) as ScoreRow | undefined) ?? null;
  }

  /** The newest entry for an identity from a writer that is on the chain or on its way. */
  last(agentId: string, writer: string): ScoreRow | null {
    return (this.d.db.q("SELECT * FROM erc8004_scores WHERE agent_id = ? AND writer = ? AND status IN ('sent', 'done') ORDER BY n DESC LIMIT 1").get(agentId, writer) as ScoreRow | undefined) ?? null;
  }

  /**
   * The agents whose score is due to be written: linked, with a settled job, and moved meaningfully since the last entry
   * (see the top of the file). The ones that moved most first.
   */
  due(writer: string, nowS = this.d.nowS()): { agent: string; agentId: string; score: number; before: number | null }[] {
    const e = this.d.erc8004();
    if (!e) return [];
    const desk = new DeskStore(this.d.db);
    const now = this.d.now();
    const out: { agent: string; agentId: string; score: number; before: number | null; moved: number }[] = [];
    for (const l of e.store.links()) {
      if (l.lost || !l.agent_id) continue;
      const row = desk.agent(l.agent);
      if (!row || row.record.settled + row.record.settledAtHalf === 0) continue;
      // one written down and not yet sent: it is on its way, unless it is old (the process stopped in between)
      // one that failed is tried again ten minutes later; one the registry refuses for good, never for that identity
      const queued = this.d.db.q("SELECT n FROM erc8004_scores WHERE agent_id = ? AND writer = ? AND ((status IN ('queued', 'failed') AND updated_at > ?) OR status = 'refused')").get(l.agent_id, writer, now - 600_000);
      if (queued) continue;
      const score = scoreOf(row.record, nowS);
      const last = this.last(l.agent_id, writer);
      if (!last) { out.push({ agent: l.agent, agentId: l.agent_id, score, before: null, moved: 1001 }); continue; }
      if (last.status === "sent") continue;
      const moved = Math.abs(score - last.score);
      const soon = now - last.created_at < this.cfg.everyH * 3_600_000;
      if (moved === 0) continue;
      if ((score === 0 && last.score > 0) || moved >= 4 * this.cfg.step || (moved >= this.cfg.step && !soon)) out.push({ agent: l.agent, agentId: l.agent_id, score, before: last.score, moved });
    }
    return out.sort((a, b) => b.moved - a.moved).map(({ moved: _m, ...x }) => x);
  }

  /** Entries that a newer one from the same writer has replaced, mined and not yet revoked. */
  replaced(writer: string): ScoreRow[] {
    return this.d.db.q(`SELECT s.* FROM erc8004_scores s WHERE s.writer = ? AND s.status = 'done' AND s.revoke_status IS NULL AND s.feedback_index IS NOT NULL
      AND EXISTS (SELECT 1 FROM erc8004_scores t WHERE t.agent_id = s.agent_id AND t.writer = s.writer AND t.status = 'done' AND t.n > s.n) ORDER BY s.n LIMIT 20`).all(writer) as ScoreRow[];
  }

  /** What the entries and revokes cost the gas wallet in the last 24 hours, at the most it could have paid a gas. */
  spentToday(): bigint {
    const rows = this.d.db.q("SELECT status, gas_used, gas_limit, max_fee_wei FROM engine_actions WHERE kind = 'erc8004_score' AND mode = 'live' AND tx_hash IS NOT NULL AND created_at >= ?").all(this.d.now() - 86_400_000) as { status: string; gas_used: string | null; gas_limit: string | null; max_fee_wei: string | null }[];
    let sum = 0n;
    for (const r of rows) sum += BigInt(r.gas_used ?? (r.status === "signed" || r.status === "sent" ? (r.gas_limit ?? "0") : "0")) * BigInt(r.max_fee_wei ?? "0");
    return sum;
  }

  /** The call and the file of one entry. `n` is the entry's number, in its address; 0 for one only shown (dry). */
  entry(o: { agent: string; agentId: string; writer: string; score: number; before: number | null; block: number; n: number }): { call: CallSpec; body: string; hash: Hex; uri: string } {
    const e = this.d.erc8004()!;
    const made = scoreFile({ chainId: this.d.chainId, identity: e.cfg.identity, agentId: o.agentId, writer: o.writer, desk: this.d.desk, site: this.cfg.site, agent: o.agent, name: this.d.nameOf(o.agent), score: o.score, before: o.before, block: o.block, atS: this.d.nowS() });
    const uri = `${this.cfg.site}/api/v1/erc8004/score/${o.n}`;
    const call: CallSpec = { to: e.cfg.reputation, abi: erc8004ReputationAbi as Abi, functionName: "giveFeedback", args: [BigInt(o.agentId), BigInt(o.score), SCORE_DECIMALS, SCORE_TAG1, SCORE_TAG2, "", uri, made.hash] };
    return { call, body: made.body, hash: made.hash, uri };
  }

  /** The entry's number in the registry, from the transaction's logs. */
  indexOf(r: Receipt): number | null {
    const rep = this.d.erc8004()?.cfg.reputation;
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

  private mark(n: number, f: Partial<Pick<ScoreRow, "status" | "tx_hash" | "feedback_index" | "mined_block" | "error" | "revoke_status" | "revoke_tx">>): void {
    const sets = Object.keys(f).map((k) => `${k} = @${k}`).join(", ");
    this.d.db.q(`UPDATE erc8004_scores SET ${sets}, updated_at = @now WHERE n = @n`).run({ ...f, now: this.d.now(), n });
  }

  /** A transaction of an entry's (ref w:<n>) or a revoke's (r:<n>), mined, or found never to have been. */
  landed(ref: string, hash: string, r: Receipt): void {
    const m = /^([wr]):(\d+)$/.exec(ref);
    if (!m) return;
    const n = Number(m[2]);
    if (m[1] === "w") {
      if (r.ok) {
        this.mark(n, { status: "done", tx_hash: hash, feedback_index: this.indexOf(r), mined_block: Number(r.blockNumber), error: null });
        this.d.log(`[scores] entry ${n} is on ERC-8004: ${hash}`);
      } else this.mark(n, { status: "failed", tx_hash: hash, error: `the transaction reverted (${hash})` });
    } else this.mark(n, r.ok ? { revoke_status: "done", revoke_tx: hash } : { revoke_status: null, revoke_tx: null });
  }

  unsent(ref: string, why: string): void {
    const m = /^([wr]):(\d+)$/.exec(ref);
    if (!m) return;
    if (m[1] === "w") this.mark(Number(m[2]), { status: "failed", tx_hash: null, error: why });
    else this.mark(Number(m[2]), { revoke_status: null, revoke_tx: null });
  }

  /** One pass of the keeper: replaced entries revoked first, then the scores that are due written. */
  async step(ctx: Ctx, head: Head, attempt: Attempt): Promise<string> {
    if (!this.cfg.enabled) return "EVERYWHERE_SCORES is off: no score is written to ERC-8004";
    const e = this.d.erc8004();
    if (!e || !e.cfg.enabled) return "ERC8004 is off: no identity is known, so no score is written";
    const off = stopped(this.d.db, "scores");
    if (off) return `stopped by the owner${off.note ? `: ${off.note}` : ""}`;
    const writer = ctx.facts.bot;
    if (!writer) return "the engine holds no gas wallet key: nothing can be written";
    const db = this.d.db;
    const live = ctx.mode === "live" && !!ctx.signer;
    const said: string[] = [];
    let sent = 0;
    const ready = (ref: string): boolean => {
      const prev = db.lastAction("erc8004_score", ref);
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
    for (const old of this.replaced(writer)) {
      if (sent >= this.cfg.perPass || ctx.stopping()) break;
      const ref = `r:${old.n}`;
      if (!ready(ref)) continue;
      const call: CallSpec = { to: e.cfg.reputation, abi: erc8004ReputationAbi as Abi, functionName: "revokeFeedback", args: [BigInt(old.agent_id), BigInt(old.feedback_index!)] };
      const pre = await fits(call);
      if (pre === "over") { said.push("the day's gas for scores is spent (EVERYWHERE_SCORES_GAS_DAY_WEI): the rest wait"); return said.join("; "); }
      const out = await attempt("erc8004_score", ref, call, { revoke: old.n, agentId: old.agent_id, index: old.feedback_index }, ctx.params.maxGasWei, pre);
      sent++;
      if (out.status === "done" && out.hash && out.receipt) this.landed(ref, out.hash, out.receipt);
      else if (out.status === "sent" && out.hash) this.mark(old.n, { revoke_status: "sent", revoke_tx: out.hash });
      said.push(`${out.status === "dry" ? "would revoke" : "revoked"} score entry ${old.n} (#${old.agent_id}, index ${old.feedback_index})${out.status === "failed" || out.status === "skipped" ? `: ${out.status}, ${out.why}` : ""}`);
      if (db.openActions().length > 0) return said.join("; ");
    }
    const block = Number(head.number);
    for (const x of this.due(writer, head.timestamp)) {
      if (sent >= this.cfg.perPass || ctx.stopping()) break;
      const holds = await e.holds(x.agent, x.agentId);
      if (!holds.ok) {
        e.store.lose(x.agent, holds.why, this.d.now());
        said.push(`${x.agent}: ${holds.why}`);
        continue;
      }
      if (holds.owner === writer) { said.push(`#${x.agentId} is owned by the gas wallet itself: the registry does not let an owner write to its own identity`); continue; }
      // the entry is written down before anything is sent, so the file its address names is there whatever happens next
      let n = 0;
      if (live) n = Number(db.q("INSERT INTO erc8004_scores (agent, agent_id, writer, score, block, uri, hash, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', '', '', 'queued', ?, ?)").run(x.agent, x.agentId, writer, x.score, block, this.d.now(), this.d.now()).lastInsertRowid);
      const made = this.entry({ ...x, writer, block, n });
      if (live) db.q("UPDATE erc8004_scores SET uri = ?, hash = ?, body = ? WHERE n = ?").run(made.uri, made.hash, made.body, n);
      const ref = `w:${n}`;
      if (!live && !ready(`show:${x.agentId}`)) continue;
      const pre = await fits(made.call);
      if (pre === "over") {
        if (live) db.q("DELETE FROM erc8004_scores WHERE n = ?").run(n);
        said.push("the day's gas for scores is spent (EVERYWHERE_SCORES_GAS_DAY_WEI): the rest wait");
        break;
      }
      const out = await attempt("erc8004_score", live ? ref : `show:${x.agentId}`, made.call, { agent: x.agent, agentId: x.agentId, score: x.score, before: x.before, uri: made.uri, hash: made.hash }, ctx.params.maxGasWei, pre);
      sent++;
      if (out.status === "done" && out.hash && out.receipt) this.landed(ref, out.hash, out.receipt);
      else if (out.status === "sent" && out.hash) this.mark(n, { status: "sent", tx_hash: out.hash });
      else if (live) {
        if (out.hash && out.receipt) this.landed(ref, out.hash, out.receipt);
        else this.mark(n, { status: REFUSED_FOR_GOOD.test(out.why) ? "refused" : "failed", error: out.why });
      }
      said.push(`${out.status === "dry" ? "would write" : out.status === "done" ? "wrote" : out.status} the score of #${x.agentId} (${x.score}${x.before === null ? "" : `, was ${x.before}`})${out.status === "failed" || out.status === "skipped" ? `: ${out.why}` : ""}`);
      if (db.openActions().length > 0) break;
    }
    return said.length ? said.join("; ") : "no score has moved enough to be written";
  }

  // ---------- what the site and apps read ----------

  /** An agent's score as Factor last wrote it to ERC-8004, or null. */
  json(agent: string): ScoreJson | null {
    const r = this.d.db.q("SELECT * FROM erc8004_scores WHERE agent = ? AND status = 'done' ORDER BY n DESC LIMIT 1").get(agent) as ScoreRow | undefined;
    if (!r) return null;
    const written = (this.d.db.q("SELECT COUNT(*) AS n FROM erc8004_scores WHERE agent = ? AND status = 'done'").get(agent) as { n: number }).n;
    return { score: r.score, value: (r.score / 10).toFixed(1), tag1: SCORE_TAG1, agentId: r.agent_id, reviewer: getAddress(r.writer), tx: r.tx_hash!, index: r.feedback_index, at: new Date(r.updated_at).toISOString(), written };
  }

  /** The file an entry points at, word for word, once its entry is on its way or written. */
  file(n: number): string | null {
    const r = this.row(n);
    return r && (r.status === "sent" || r.status === "done") ? r.body : null;
  }

  about(writer: string | null): Record<string, unknown> {
    const c = (this.d.db.q("SELECT COUNT(*) AS n FROM erc8004_scores WHERE status = 'done'").get() as { n: number }).n;
    const agents = (this.d.db.q("SELECT COUNT(DISTINCT agent) AS n FROM erc8004_scores WHERE status = 'done'").get() as { n: number }).n;
    return {
      enabled: this.on(), tag1: SCORE_TAG1, tag2: SCORE_TAG2, valueDecimals: SCORE_DECIMALS, reviewer: writer ? getAddress(writer) : null, step: this.cfg.step, everyH: this.cfg.everyH,
      entries: c, agents, read: `getSummary(agentId, [reviewer], "${SCORE_TAG1}", "") on ${getAddress(this.d.erc8004()?.cfg.reputation ?? "0x8004baa17c55a88189ae136b182e5fda19de9b63")}`,
    };
  }
}
