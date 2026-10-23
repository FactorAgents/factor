// Auto-apply: agents that find their own work. Its owner sets an agent's rules once, with a signature, and the agent
// watches the open jobs (./openjobs.ts), applies to the ones that fit, does the work and delivers on its own.
//
// There is no new contract and no new kind of application. An application made this way is the same signed words as
// one made by hand, under every rule of open jobs; the engine only finds the jobs and, for an agent it runs, signs.
//
//   POST /v1/autoapply/rules   the rules, signed (rulesMessage) by the agent itself or by whoever runs it here: the
//                              maker of an agent made on the site, Factor's admin for Factor's own agents
//   GET  /v1/autoapply/<agent> its rules, the words signed, its log (found, applied, picked, delivering, delivered),
//                              and the open jobs it may apply to right now (what an agent's own program asks)
//
// What the rules say: the work it takes (a few kinds, and words of its own, matched against a listing's title and
// brief), the lowest price, the most jobs at once, its hours (always, or a window in UTC), whether it draws the half a
// customer allows up front, a line to apply with, and on or off. With offers on (BIDS=on), its pricing too: what it
// offers on a job open to offers normally, the lower price it offers with nothing on its hands, and its time from the
// lock (`bid`). An offer it makes on its own is that price, never over the customer's budget and never under its
// lowest price; without `bid` it passes over jobs open to offers.
//
// Who applies:
//   - an agent Factor runs (one of Factor's own, or one made on the site): the engine signs its application with the
//     agent's own key, the one its account obeys, and does the job once it is picked, through the job flow every
//     agent of Factor's goes through (./house/house.ts). It never applies for what it would decline: under its price,
//     no brief it can work from, or while its maker has paused it.
//   - an agent that runs itself: the engine finds the jobs, its program applies with its own key (the kit's
//     watchOpenJobs, or an assistant's tools), saying the application is automatic; it is held to the same rules.
//
// What holds whatever the rules say: every rule of open jobs (registered agents only, never its own customer or the
// same hand, one application per job, the most applicants); never a job its owner posted; never more jobs at once
// than the rules allow (jobs locked for it and applications still standing, together); AUTOAPPLY_PER_AGENT_HOUR
// applications an hour for one agent, AUTOAPPLY_PER_HOUR for all of them; and the owner's switch, which stops it at
// once (POST /v1/admin/switch, "autoapply"). Off unless AUTOAPPLY=on.

import { formatEther } from "viem";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import type { EngineDb } from "./chain/db.js";
import { MAX_LINK_WEI, MIN_JOB_WEI } from "./pay.js";
import { oneLine } from "./profiles.js";
import { applyMessage, PITCH_MOST, type Offer, type OpenJobRow, type OpenJobs } from "./openjobs.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export interface AutoApplyConfig {
  /** AUTOAPPLY=on: off unless it is said */
  enabled: boolean;
  /** AUTOAPPLY_PER_AGENT_HOUR: applications one agent makes on its own in an hour, at most */
  perAgentHour: number;
  /** AUTOAPPLY_PER_HOUR: applications all agents make on their own in an hour, at most */
  perHour: number;
  /** applications the engine signs in one pass, at most */
  perPass: number;
}

export function readAutoApply(env: Env, problems: string[] = []): AutoApplyConfig {
  const on = (env.AUTOAPPLY ?? "").trim().toLowerCase() === "on";
  const whole = (name: string, def: number, least: number, most: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    if (/^\d{1,5}$/.test(raw) && Number(raw) >= least && Number(raw) <= most) return Number(raw);
    problems.push(`${name} must be a whole number from ${least} to ${most}: it is "${raw}"`);
    return def;
  };
  return { enabled: on, perAgentHour: whole("AUTOAPPLY_PER_AGENT_HOUR", 6, 1, 60), perHour: whole("AUTOAPPLY_PER_HOUR", 60, 1, 10_000), perPass: 5 };
}

/** The kinds of work an agent can say it takes, each with the words that find it in a listing. */
export const KINDS: { name: string; words: string[] }[] = [
  { name: "Landing pages", words: ["landing page", "one-page site", "one page site", "web page", "webpage", "website", "homepage", "home page", "a page for"] },
  { name: "Writing", words: ["write", "rewrite", "copy for", "blog", "article", "newsletter", "announcement", "product description"] },
  { name: "Summaries", words: ["summar", "sum up", "key points", "what it says", "read through"] },
  { name: "Proofreading", words: ["proofread", "proof-read", "typo", "grammar", "spelling", "copy edit", "copyedit"] },
  { name: "Figures and tables", words: ["figure", "spreadsheet", "csv", "table", "chart", "numbers"] },
  { name: "Research", words: ["research", "compare", "find out", "look into", "sources"] },
  { name: "Code", words: ["code", "script", "function", "bug", "typescript", "python", "solidity", "smart contract", "sql"] },
  { name: "Translation", words: ["translat"] },
];
const KIND_NAMES = new Set(KINDS.map((k) => k.name));

/**
 * How an agent prices an offer on a job open to offers: its normal price, the lower one with nothing on its hands
 * (wei as text, both its lowest price or more), and its time, in hours from the lock.
 */
export interface BidRule { normalWei: string; freeWei: string; hours: number }

/** An agent's rules. `floorWei` is wei as text; `hours` a window in whole UTC hours, or null for always; `bid` its pricing for offers, when it has one. */
export interface Rules { on: boolean; takes: string[]; words: string[]; floorWei: string; atOnce: number; hours: { from: number; to: number } | null; early: boolean; pitch: string; bid?: BidRule }

/** The pricing line the owner signs with the rules. */
export const bidWords = (b: BidRule): string => `${formatEther(BigInt(b.normalWei))} ETH a job, ${formatEther(BigInt(b.freeWei))} ETH with nothing on its hands, due ${b.hours} hours after the lock`;

export const AT_ONCE_MOST = 10;
export const WORDS_MOST = 12;
const two = (n: number) => String(n).padStart(2, "0");
export const hoursWords = (h: Rules["hours"]): string => (h ? `${two(h.from)}:00 to ${two(h.to)}:00 UTC` : "always");

/**
 * The words the agent's owner signs: readable, so a wallet shows exactly what it puts its name to. The same to the
 * letter in the kit (packages/kit/src/autoapply.ts) and on the site (web/src/lib/autoapply.ts).
 */
export function rulesMessage(r: Rules & { agent: string; by: string; at: number }): string {
  return [
    "Factor: auto-apply rules for an agent",
    `agent: ${r.agent}`,
    `set by: ${r.by}`,
    `on: ${r.on ? "yes" : "no"}`,
    `takes: ${r.takes.length ? r.takes.join(", ") : "none"}`,
    `words: ${r.words.length ? r.words.join(", ") : "none"}`,
    `from: ${formatEther(BigInt(r.floorWei))} ETH a job`,
    `at a time: up to ${r.atOnce} job${r.atOnce === 1 ? "" : "s"}`,
    `hours: ${hoursWords(r.hours)}`,
    `early half: ${r.early ? "drawn up front when the customer allows it" : "never"}`,
    `pitch: ${r.pitch || "none"}`,
    ...(r.bid ? [`offers: ${bidWords(r.bid)}`] : []),
    `at: ${r.at}`,
  ].join("\n");
}

/** Whether a listing is the work the rules take: a kind's words or the agent's own, in its title or brief. */
export function takesWork(r: Pick<Rules, "takes" | "words">, title: string, brief: string): boolean {
  const text = ` ${`${title}\n${brief}`.toLowerCase().replace(/\s+/g, " ")}`;
  const words = [...KINDS.filter((k) => r.takes.includes(k.name)).flatMap((k) => k.words), ...r.words.map((w) => w.toLowerCase())];
  // a word counts where a word starts: "page" finds "pages", never "homepage"'s middle
  return words.some((w) => { const at = text.indexOf(w); for (let i = at; i >= 0; i = text.indexOf(w, i + 1)) if (!/[a-z0-9]/.test(text[i - 1] ?? " ")) return true; return false; });
}

/** Whether the hour of `t` (unix seconds) is inside the window. */
export function inHours(h: Rules["hours"], t: number): boolean {
  if (!h) return true;
  const hour = new Date(t * 1000).getUTCHours();
  return h.from < h.to ? hour >= h.from && hour < h.to : hour >= h.from || hour < h.to;
}

// ---------- the books ----------

export type LogKind = "found" | "applied" | "picked" | "delivering" | "delivered" | "declined";
export interface LogRow { id: number; agent: string; kind: LogKind; open_id: string; job_id: number | null; note: string; at: number }
interface RulesRow { agent: string; rules: string; by: string; signed_at: number; signature: string; updated_at: number }

const SCHEMA = `
-- Auto-apply (./autoapply.ts). An agent's rules: what its owner signed. Never taken back by a reindex.
CREATE TABLE IF NOT EXISTS autoapply_rules (
  agent TEXT PRIMARY KEY,
  rules TEXT NOT NULL,               -- JSON: Rules
  by TEXT NOT NULL,                  -- who signed: the agent, or whoever runs it here
  signed_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  updated_at INTEGER NOT NULL        -- ms
);
-- What an agent did on its own, once each per open job: found, applied, picked, delivering, delivered, declined.
CREATE TABLE IF NOT EXISTS autoapply_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  open_id TEXT NOT NULL,
  job_id INTEGER,
  note TEXT NOT NULL,
  at INTEGER NOT NULL,               -- ms
  UNIQUE (agent, kind, open_id)
);
CREATE INDEX IF NOT EXISTS autoapply_log_agent ON autoapply_log (agent, id);
CREATE INDEX IF NOT EXISTS autoapply_log_open ON autoapply_log (open_id, kind);
`;

export class AutoApplyStore {
  constructor(private db: EngineDb) {
    db.db.exec(SCHEMA);
  }

  get(agent: string): (RulesRow & { r: Rules }) | null {
    const row = this.db.q("SELECT * FROM autoapply_rules WHERE agent = ?").get(agent) as RulesRow | undefined;
    return row ? { ...row, r: JSON.parse(row.rules) as Rules } : null;
  }

  on(): { agent: string; r: Rules; updated_at: number }[] {
    return (this.db.q("SELECT agent, rules, updated_at FROM autoapply_rules").all() as RulesRow[]).map((x) => ({ agent: x.agent, r: JSON.parse(x.rules) as Rules, updated_at: x.updated_at })).filter((x) => x.r.on);
  }

  log(agent: string, limit = 30): LogRow[] {
    return this.db.q("SELECT * FROM autoapply_log WHERE agent = ? ORDER BY id DESC LIMIT ?").all(agent, limit) as LogRow[];
  }

  /** Writes a line once: the same kind for the same open job is never written twice. Answers whether it was new. */
  write(agent: string, kind: LogKind, open: string, note: string, at: number, job: number | null = null): boolean {
    return this.db.q("INSERT OR IGNORE INTO autoapply_log (agent, kind, open_id, job_id, note, at) VALUES (?, ?, ?, ?, ?, ?)").run(agent, kind, open, job, note, at).changes === 1;
  }

  has(agent: string, kind: LogKind, open: string): boolean {
    return !!this.db.q("SELECT 1 FROM autoapply_log WHERE agent = ? AND kind = ? AND open_id = ?").get(agent, kind, open);
  }

  /** The agents that applied on their own to an open job. */
  appliedTo(open: string): Set<string> {
    return new Set((this.db.q("SELECT agent FROM autoapply_log WHERE open_id = ? AND kind = 'applied'").all(open) as { agent: string }[]).map((r) => r.agent));
  }

  appliedSince(at: number, agent?: string): number {
    const r = agent ? this.db.q("SELECT COUNT(*) AS n FROM autoapply_log WHERE kind = 'applied' AND at >= ? AND agent = ?").get(at, agent) : this.db.q("SELECT COUNT(*) AS n FROM autoapply_log WHERE kind = 'applied' AND at >= ?").get(at);
    return (r as { n: number }).n;
  }

  /** Applications made on their own whose story is not over yet: not delivered, not declined. */
  following(): { agent: string; open_id: string }[] {
    return this.db.q("SELECT a.agent, a.open_id FROM autoapply_log a WHERE a.kind = 'applied' AND NOT EXISTS (SELECT 1 FROM autoapply_log b WHERE b.agent = a.agent AND b.open_id = a.open_id AND b.kind IN ('delivered', 'declined')) ORDER BY a.id DESC LIMIT 500").all() as { agent: string; open_id: string }[];
  }
}

// ---------- the rules at work ----------

/** An agent Factor runs, as auto-apply needs it: what it takes a job for, and its own key to sign with. */
export interface Runner {
  address: string;
  name: string;
  /** the least a job of its pays, wei */
  floorWei: bigint;
  /** why it would decline a job with this brief, or null */
  refuses: (brief: string) => string | null;
  /** its maker paused it */
  paused: boolean;
  /** signs plain words with the key its account obeys */
  sign: (message: string) => Promise<string>;
}

type Answer = { status: number; body: Record<string, unknown> };
const no = (status: number, error: string): Answer => ({ status, body: { error } });
const WINDOW_S = 600;
const ethText = (wei: bigint | string): string => formatEther(BigInt(wei));
const pad = (id: number): string => String(id).padStart(4, "0");
const iso = (ms: number): string => new Date(ms).toISOString();

export interface AutoApplyDeps {
  cfg: AutoApplyConfig;
  db: EngineDb;
  openjobs: () => OpenJobs | null;
  /** whether `address` signed `message`: a wallet, or an account through one of its keys (../profiles.ts) */
  signed: (address: string, message: string, signature: unknown) => Promise<boolean>;
  /** the chain's time now, in seconds; and the engine's clock, ms */
  nowS: () => number;
  now: () => number;
  /** the agents Factor runs and can sign for, by address */
  runners: () => Map<string, Runner>;
  /** who besides the agent itself may set its rules: the maker of an agent made on the site, Factor's admin for Factor's own */
  setters: (agent: string) => string[];
  /** whether the engine can send anything now (live, a gas wallet, running) */
  live: () => boolean;
  /** whether offers on open jobs are on (BIDS=on, not stopped) */
  offersOn?: () => boolean;
  names: () => Map<string, { name: string }>;
  log: (line: string) => void;
}

export interface AutoApplyJson {
  enabled: boolean;
  agent: string;
  name: string;
  /** "factor": Factor applies and works for it; "self": its own program applies, with the jobs Factor finds */
  runBy: "factor" | "self";
  /** who can set its rules besides the agent itself */
  setters: string[];
  kinds: string[];
  rules: Rules | null;
  /** the words signed, by whom, and the signature */
  signed?: { message: string; signature: string; by: string; at: string };
  log: { kind: LogKind; open: string; title: string; job?: { n: number; id: string }; note: string; at: string }[];
  /** open jobs it may apply to right now, under its rules and every limit: what an agent's own program applies to */
  fits: string[];
  /** for each of those open to offers, the offer its rules make now: what an agent's own program offers, unless it prices its own */
  quotes: Record<string, { priceWei: string; dueHours: number }>;
  limits: { perAgentHour: number; perHour: number; atOnceMost: number };
}

export class AutoApply {
  readonly store: AutoApplyStore;

  constructor(private d: AutoApplyDeps) {
    this.store = new AutoApplyStore(d.db);
  }

  get cfg(): AutoApplyConfig {
    return this.d.cfg;
  }

  /** Whether it is at work: switched on, and not stopped by the owner. */
  working(): boolean {
    return this.d.cfg.enabled && !stopped(this.d.db, "autoapply");
  }

  private nameOf(address: string): string {
    return this.d.names().get(address)?.name ?? shortAddress(address);
  }

  /** The agent itself, and whoever runs it here. */
  settersOf(agent: string): string[] {
    return [...new Set([agent, ...this.d.setters(agent)])];
  }

  /** The owner signs an agent's rules. Asked again with the same signature, it answers the same. */
  async setRules(body: Record<string, unknown>): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "auto-apply is switched off for now");
    const agent = normalizeAddress(body.agent);
    if (!agent) return no(400, "agent is not an address");
    const by = normalizeAddress(body.by) ?? agent;
    if (!this.d.db.q("SELECT 1 FROM desk_agents WHERE address = ?").get(agent)) return no(409, "that agent has not registered on the desk");
    if (!this.settersOf(agent).includes(by)) return no(403, "only the agent itself, or whoever runs it on Factor, sets its rules");
    if (typeof body.on !== "boolean") return no(400, "on is true or false");
    const takes = Array.isArray(body.takes) ? body.takes : [];
    if (takes.length > KINDS.length || takes.some((k) => typeof k !== "string" || !KIND_NAMES.has(k))) return no(400, `takes is a list of the kinds of work: ${KINDS.map((k) => k.name).join(", ")}`);
    const rawWords = Array.isArray(body.words) ? body.words : [];
    const words = rawWords.map((w) => oneLine(w, 2, 40));
    if (rawWords.length > WORDS_MOST || words.some((w, i) => w === null || w !== rawWords[i] || w.includes(","))) return no(400, `words are up to ${WORDS_MOST} plain words or phrases of 2 to 40 characters, without commas or links`);
    if (body.on && takes.length === 0 && words.length === 0) return no(400, "say what work it takes: a kind of work or a word of its own");
    const floorWei = typeof body.floorWei === "string" && /^\d{1,30}$/.test(body.floorWei) ? body.floorWei : null;
    if (floorWei === null || BigInt(floorWei) < MIN_JOB_WEI || BigInt(floorWei) > MAX_LINK_WEI) return no(400, "floorWei is the lowest price it takes, in wei, as text: 0.001 ETH or more");
    const atOnce = typeof body.atOnce === "number" && Number.isSafeInteger(body.atOnce) ? body.atOnce : null;
    if (atOnce === null || atOnce < 1 || atOnce > AT_ONCE_MOST) return no(400, `atOnce is 1 to ${AT_ONCE_MOST}: the most jobs it has at once`);
    let hours: Rules["hours"] = null;
    if (body.hours !== null && body.hours !== undefined && body.hours !== "always") {
      const h = body.hours as { from?: unknown; to?: unknown };
      const ok = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 23;
      if (typeof h !== "object" || !ok(h.from) || !ok(h.to) || h.from === h.to) return no(400, "hours is \"always\", or { from, to }: whole hours of the day in UTC, 0 to 23, not the same");
      hours = { from: h.from, to: h.to };
    }
    if (typeof body.early !== "boolean") return no(400, "early is true or false: whether it draws the half a customer allows up front");
    const pitch = body.pitch === "" || body.pitch === undefined || body.pitch === null ? "" : oneLine(body.pitch, 3, PITCH_MOST);
    if (pitch === null || (pitch !== "" && pitch !== body.pitch)) return no(400, `a pitch is one plain line of 3 to ${PITCH_MOST} characters, without links`);
    const at = typeof body.at === "number" && Number.isSafeInteger(body.at) && Math.abs(this.d.nowS() - body.at) <= WINDOW_S ? body.at : null;
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    let bid: BidRule | null = null;
    if (body.bid !== undefined && body.bid !== null) {
      if (!this.d.offersOn?.()) return no(503, "offers are switched off for now: set the rules without a price for offers");
      const b = body.bid as { normalWei?: unknown; freeWei?: unknown; hours?: unknown };
      const wei = (v: unknown) => (typeof v === "string" && /^\d{1,30}$/.test(v) ? v : null);
      const normalWei = typeof b === "object" ? wei(b.normalWei) : null, freeWei = typeof b === "object" ? wei(b.freeWei) : null;
      const h = typeof b === "object" && typeof b.hours === "number" && Number.isSafeInteger(b.hours) ? b.hours : null;
      if (normalWei === null || freeWei === null || h === null) return no(400, "bid is { normalWei, freeWei, hours }: its normal price and the price with nothing on its hands, in wei as text, and its time in hours after the lock");
      if (BigInt(normalWei) < BigInt(floorWei) || BigInt(normalWei) > MAX_LINK_WEI) return no(400, "the normal price of its offers is its lowest price or more");
      if (BigInt(freeWei) < BigInt(floorWei) || BigInt(freeWei) > BigInt(normalWei)) return no(400, "the price with nothing on its hands is from its lowest price up to its normal price");
      if (h < 1 || h > 720) return no(400, "the time of its offers is 1 to 720 hours after the lock");
      bid = { normalWei, freeWei, hours: h };
    }
    const r: Rules = { on: body.on, takes: KINDS.map((k) => k.name).filter((n) => takes.includes(n)), words: words as string[], floorWei, atOnce, hours, early: body.early, pitch, ...(bid ? { bid } : {}) };
    const had = this.store.get(agent);
    if (had && had.signature === String(body.signature)) return { status: 200, body: { ok: true, agent, rules: had.r } };
    if (had && at <= had.signed_at) return no(409, "newer rules are already stored: sign again");
    let ok = false;
    try {
      ok = await this.d.signed(by, rulesMessage({ ...r, agent, by, at }), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, `the signature is not ${by === agent ? "the agent's" : "its owner's"}`);
    this.d.db.q("INSERT INTO autoapply_rules (agent, rules, by, signed_at, signature, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(agent) DO UPDATE SET rules = excluded.rules, by = excluded.by, signed_at = excluded.signed_at, signature = excluded.signature, updated_at = excluded.updated_at")
      .run(agent, JSON.stringify(r), by, at, String(body.signature), this.d.now());
    this.d.log(`[autoapply] ${this.nameOf(agent)}: auto-apply ${r.on ? "on" : "off"}, set by ${by === agent ? "the agent" : by}`);
    return { status: 200, body: { ok: true, agent, rules: r } };
  }

  /** Why the rules do not take a listing, or null when they do. Its price, its words, its owner. */
  misfit(agent: string, r: Rules, row: OpenJobRow, runner?: Runner): string | null {
    if (row.offers) {
      // a job open to offers: priced by its rules, within the customer's budget and time
      if (!r.bid) return "open to offers, and its rules name no price for offers";
      if (BigInt(row.price) > 0n && BigInt(row.price) < this.floorWei(r, runner)) return "the budget is under its lowest price";
      if (r.bid.hours > row.due_hours) return "it needs more time than the job gives";
    } else {
      if (BigInt(row.price) < BigInt(r.floorWei)) return "under its lowest price";
      if (runner && BigInt(row.price) < runner.floorWei) return "under what it takes a job for";
    }
    if (!takesWork(r, row.title, row.brief)) return "not work it takes";
    if (this.settersOf(agent).includes(row.customer)) return "posted by its own owner";
    if (runner?.refuses(row.brief)) return "a brief it could not work from";
    return null;
  }

  /** The least it takes a job for: its rules' lowest price, or what Factor takes a job of it for when that is more. */
  private floorWei(r: Rules, runner?: Runner): bigint {
    const f = BigInt(r.floorWei);
    return runner && runner.floorWei > f ? runner.floorWei : f;
  }

  /**
   * The least an agent takes a job for, as open jobs hold every offer to: the lowest price its owner signed in its
   * rules, or what Factor takes a job of one of its own agents for when that is more. null: nothing is said.
   */
  floorOf(agent: string): { wei: bigint; why: string } | null {
    const r = this.store.get(agent)?.r;
    const runner = this.d.runners().get(agent);
    const rules = r ? BigInt(r.floorWei) : null;
    if (runner && (rules === null || runner.floorWei > rules)) return { wei: runner.floorWei, why: "what this agent takes a job for" };
    return rules !== null ? { wei: rules, why: "the agent's own lowest price, in its auto-apply rules" } : null;
  }

  /**
   * The offer its rules make on a job open to offers now: the price with nothing on its hands when it has none, its
   * normal price otherwise, never over the budget and never under its lowest price, at its own time. null: none fits.
   */
  quote(agent: string, r: Rules, row: OpenJobRow, runner?: Runner, t = this.d.nowS()): Offer | null {
    if (!row.offers || !r.bid || r.bid.hours > row.due_hours) return null;
    const base = this.busy(agent, t) === 0 ? BigInt(r.bid.freeWei) : BigInt(r.bid.normalWei);
    const budget = BigInt(row.price);
    const price = budget > 0n && base > budget ? budget : base;
    if (price < this.floorWei(r, runner)) return null;
    return { priceWei: price.toString(), dueHours: r.bid.hours, until: null };
  }

  /** How many jobs an agent has on its hands: jobs locked for it and not delivered, and applications still standing. `except`: an open job not counted. */
  busy(agent: string, t = this.d.nowS(), except?: string): number {
    const jobs = (this.d.db.q("SELECT COUNT(*) AS n FROM desk_jobs WHERE agent = ? AND state IN (1, 2)").get(agent) as { n: number }).n;
    const o = this.d.openjobs();
    let standing = 0;
    if (o) for (const row of o.store.waiting()) {
      if (row.id === except) continue;
      const app = o.store.application(row.id, agent);
      // an offer that has ended no longer stands
      if (!app || o.ended(o.offerOf(app), t)) continue;
      const st = o.status(row, t);
      if (st === "open" || st === "choosing" || (st === "picked" && row.picked_agent === agent)) standing++;
    }
    return jobs + standing;
  }

  /** Why the agent may not apply on its own right now, or null: on, its hours, its jobs at once, the hourly limits. `except`: an open job whose offer it is changing. */
  limitProblem(agent: string, r: Rules | null, t = this.d.nowS(), except?: string): string | null {
    if (!this.working()) return "auto-apply is switched off for now";
    if (!r || !r.on) return "auto-apply is off for this agent";
    if (!inHours(r.hours, t)) return `outside its hours (${hoursWords(r.hours)})`;
    if (this.busy(agent, t, except) >= r.atOnce) return `it has ${r.atOnce} job${r.atOnce === 1 ? "" : "s"} on its hands, the most its rules allow`;
    const hourAgo = this.d.now() - 3_600_000;
    if (this.store.appliedSince(hourAgo, agent) >= this.d.cfg.perAgentHour) return `it applied ${this.d.cfg.perAgentHour} times in the last hour, the most one agent does`;
    if (this.store.appliedSince(hourAgo) >= this.d.cfg.perHour) return "agents applied on their own as often as Factor lets them in an hour: try again later";
    return null;
  }

  /**
   * Asked by open jobs before it takes an application said to be automatic: the agent's rules must be on and take the
   * listing, and every limit must hold. Null when it may.
   */
  allow(agent: string, row: OpenJobRow, o: { replacing?: boolean } = {}): string | null {
    const had = this.store.get(agent);
    const limit = this.limitProblem(agent, had?.r ?? null, this.d.nowS(), o.replacing ? row.id : undefined);
    if (limit) return limit;
    const misfit = this.misfit(agent, had!.r, row, this.d.runners().get(agent));
    return misfit ? `its rules do not take this job: ${misfit}` : null;
  }

  /** Told by open jobs once an application said to be automatic is stored. */
  applied(open: string, agent: string, rank: number, of: number, offer?: Offer): void {
    this.store.write(agent, "found", open, "Found an open job that fits its rules", this.d.now());
    this.store.write(agent, "applied", open, offer ? `Offered ${ethText(offer.priceWei)} ETH, due ${offer.dueHours} hours after the lock, ranked ${rank} of ${of} by Factor Score` : `Applied with one signature, ranked ${rank} of ${of} by Factor Score`, this.d.now());
  }

  /** The open jobs that fit an agent's rules now, oldest first, that it has not applied to. */
  private fitting(agent: string, r: Rules, t: number, runner?: Runner): OpenJobRow[] {
    const o = this.d.openjobs();
    if (!o) return [];
    return o.store.waiting()
      // never twice: a job it applied to on its own once, and then withdrew from, is not found again
      .filter((row) => o.status(row, t) === "open" && !o.store.application(row.id, agent) && !this.store.has(agent, "applied", row.id) && (!row.offers || o.offersOn()) && o.store.count(row.id) < o.cfg.maxApplicants && !o.applyProblem(row, agent, t) && !this.misfit(agent, r, row, runner))
      .sort((a, b) => a.created_at - b.created_at);
  }

  /** The open jobs an agent may apply to on its own right now, under its rules and every limit, with the offer its rules make on those open to offers. */
  fits(agent: string, t = this.d.nowS()): { ids: string[]; quotes: Record<string, { priceWei: string; dueHours: number }> } {
    const had = this.store.get(agent);
    if (!had || this.limitProblem(agent, had.r, t)) return { ids: [], quotes: {} };
    const room = Math.max(0, had.r.atOnce - this.busy(agent, t));
    const runner = this.d.runners().get(agent);
    const rows = this.fitting(agent, had.r, t, runner).slice(0, room);
    const quotes: Record<string, { priceWei: string; dueHours: number }> = {};
    for (const row of rows) { const q = this.quote(agent, had.r, row, runner, t); if (q) quotes[row.id] = { priceWei: q.priceWei, dueHours: q.dueHours }; }
    return { ids: rows.filter((row) => !row.offers || quotes[row.id]).map((row) => row.id), quotes };
  }

  /**
   * One pass: every open job is looked at for every agent with auto-apply on. A job that fits is written to the
   * agent's log as found; an agent Factor runs then applies, with its own key, as far as its limits allow. Then the
   * story of each application made on its own is followed: picked, delivering, delivered. Never throws for one
   * agent's sake. Answers how many applications it made.
   */
  async pass(): Promise<number> {
    if (!this.working()) return 0;
    const o = this.d.openjobs();
    if (!o || !o.cfg.enabled) return 0;
    const t = this.d.nowS();
    const runners = this.d.runners();
    let made = 0;
    for (const { agent, r } of this.store.on()) {
      const runner = runners.get(agent);
      for (const row of this.fitting(agent, r, t, runner)) {
        this.store.write(agent, "found", row.id, "Found an open job that fits its rules", this.d.now());
        // an agent that runs itself applies from its own program; one Factor runs applies here, while it may
        if (!runner || runner.paused || !this.d.live() || made >= this.d.cfg.perPass) continue;
        if (this.limitProblem(agent, r, t)) break;
        try {
          const at = this.d.nowS();
          // a job open to offers: the offer its rules make now, or none
          const offer = row.offers ? this.quote(agent, r, row, runner, at) : null;
          if (row.offers && !offer) continue;
          const signature = await runner.sign(applyMessage({ open: row.id, agent, pitch: r.pitch, at, ...(offer ? { offer } : {}) }));
          const a = await o.apply({ open: row.id, agent, pitch: r.pitch, at, signature, auto: true, ...(offer ? { priceWei: offer.priceWei, dueHours: offer.dueHours } : {}) });
          if (a.status === 200) { made++; this.d.log(`[autoapply] ${runner.name} ${offer ? `offered ${ethText(offer.priceWei)} ETH on` : "applied for"} "${row.title}" on its own`); }
          else this.d.log(`[autoapply] ${runner.name} could not apply for "${row.title}": ${String(a.body.error)}`);
        } catch (e) {
          this.d.log(`[autoapply] ${runner.name}, "${row.title}": ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    this.follow();
    return made;
  }

  /** What became of each application made on its own: picked as the price was locked, drawn on, delivered, declined. */
  follow(): void {
    const o = this.d.openjobs();
    if (!o) return;
    for (const { agent, open_id } of this.store.following()) {
      const row = o.store.get(open_id);
      if (!row || row.job_id === null || row.picked_agent !== agent) continue;
      const job = this.d.db.q("SELECT price, allow_early, state, early, locked_at, delivered_at FROM desk_jobs WHERE id = ?").get(row.job_id) as { price: string; allow_early: number; state: number; early: string; locked_at: number; delivered_at: number } | undefined;
      if (!job) continue;
      this.picked(agent, row.id, row.job_id, job);
      // drawn on: at work. Its own program may draw and deliver between two passes, so it is said even when delivered
      if (job.state >= 2 && job.state <= 5 && BigInt(job.early) > 0n) this.store.write(agent, "delivering", open_id, `Drew ${ethText(job.early)} ETH up front, at work`, this.d.now(), row.job_id);
      if (job.state >= 3 && job.state <= 5) this.store.write(agent, "delivered", open_id, `Delivered job ${pad(row.job_id)}`, (job.delivered_at || Math.floor(this.d.now() / 1000)) * 1000, row.job_id);
      if (job.state === 6) this.store.write(agent, "declined", open_id, `Declined job ${pad(row.job_id)}: the customer has everything back`, this.d.now(), row.job_id);
    }
  }

  /** The line that it was picked, once the price is locked for it. */
  private picked(agent: string, open: string, jobId: number, job: { price: string; allow_early: number; locked_at: number }): void {
    const half = job.allow_early ? (this.store.get(agent)?.r.early ? ", half drawn up front" : ", up to half may be drawn up front") : "";
    this.store.write(agent, "picked", open, `Picked: ${ethText(job.price)} ETH locked as job ${pad(jobId)}${half}`, job.locked_at * 1000, jobId);
  }

  /** Told by Factor's own job flow as an agent it runs sends its delivery (and, if it took it, the half up front). */
  delivering(job: number, agent: string, drew: bigint, title: string): void {
    const o = this.d.openjobs();
    const row = o?.store.byJob(job);
    if (!row || row.picked_agent !== agent || !this.store.has(agent, "applied", row.id)) return;
    const locked = this.d.db.q("SELECT price, allow_early, locked_at FROM desk_jobs WHERE id = ?").get(job) as { price: string; allow_early: number; locked_at: number } | undefined;
    if (locked) this.picked(agent, row.id, job, locked);
    this.store.write(agent, "delivering", row.id, drew > 0n ? `Drew ${ethText(drew)} ETH up front and is delivering ${title ? `"${title}"` : "the work"}` : `Delivering ${title ? `"${title}"` : "the work"}`, this.d.now(), job);
  }

  /** Whether an agent Factor runs draws the half up front on this job: one it applied to on its own, under rules that say so. */
  earlyHalf(job: number, agent: string): boolean {
    const row = this.d.openjobs()?.store.byJob(job);
    if (!row || row.picked_agent !== agent || !row.early || !this.store.has(agent, "applied", row.id)) return false;
    return !!this.store.get(agent)?.r.early;
  }

  json(agent: string, o: { runBy: "factor" | "self" }): AutoApplyJson {
    const had = this.store.get(agent);
    const oj = this.d.openjobs();
    const titles = new Map<string, string>();
    const fits = this.fits(agent);
    const log = this.store.log(agent).map((l) => {
      if (!titles.has(l.open_id)) titles.set(l.open_id, oj?.store.get(l.open_id)?.title ?? "An open job");
      return { kind: l.kind, open: l.open_id, title: titles.get(l.open_id)!, ...(l.job_id !== null ? { job: { n: l.job_id, id: pad(l.job_id) } } : {}), note: l.note, at: iso(l.at) };
    });
    return {
      enabled: this.working(), agent, name: this.nameOf(agent), runBy: o.runBy, setters: this.d.setters(agent), kinds: KINDS.map((k) => k.name),
      rules: had?.r ?? null,
      ...(had ? { signed: { message: rulesMessage({ ...had.r, agent, by: had.by, at: had.signed_at }), signature: had.signature, by: had.by, at: new Date(had.signed_at * 1000).toISOString() } } : {}),
      log, fits: fits.ids, quotes: fits.quotes,
      limits: { perAgentHour: this.d.cfg.perAgentHour, perHour: this.d.cfg.perHour, atOnceMost: AT_ONCE_MOST },
    };
  }

  /** Counts for the first page: agents with auto-apply on, and applications made on their own. */
  totals(): { agents: number; applied: number } {
    return { agents: this.store.on().length, applied: (this.d.db.q("SELECT COUNT(*) AS n FROM autoapply_log WHERE kind = 'applied'").get() as { n: number }).n };
  }
}
