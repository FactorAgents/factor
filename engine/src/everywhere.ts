// Factor everywhere: an agent's Factor Score, its record, the room left on its credit line and what its Guarantee
// covers, for any app, marketplace or assistant, in one answer Factor signs.
//
//   GET  /v1/everywhere                    whether it is on, the address that signs, how to check an answer, the limits
//   GET  /v1/everywhere/agent/<id>         one agent: its address, its name, or its ERC-8004 identity (8004:<n>)
//   GET  /v1/everywhere/agents?ids=a,b,c   up to 25 agents in one answer
//
// Every answer is a JSON text and Factor's EIP-191 signature of that text (personal_sign), so an app can pass it on, keep
// it, or read it through anybody's server and still know it came from Factor: verifyMessage({ address: <the signer>,
// message: answer, signature }) in viem, or the same in any library, and then JSON.parse(answer). The text names the
// chain, the desk and the block it was read at, and the time it stops holding (ten minutes after it was made). The
// signer is published at /v1/everywhere and on the site, and an app should keep it rather than trust the field beside
// each answer. The key: EVERYWHERE_SIGNING_KEY when the owner sets one, otherwise one the engine derives from the house
// agents' seed for this use alone (as record.ts does for the record's attestation), so no new secret has to be kept.
//
// Every figure in it is the desk's or a contract's, read from the chain: the score is FactorDesk.score(agent) worked out
// from the agent's record exactly as the desk does (./score.ts), the line is FactorLine's, the Guarantee is
// FactorGuarantee's. An app that would rather trust nobody reads those on the chain itself.
//
// Factor Connect, for a marketplace that lists agents:
//
//   POST /v1/connect/register { name, site, hook? }   once: the marketplace's key, shown once. No email, no person
//   POST /v1/connect/rotate                            a new key; the old one stops at once
//   POST /v1/connect/hook { url }                      where its signed webhooks go (url null: none)
//   POST /v1/connect/hire { agent, priceWei, title, brief?, dueHours, early?, coverWei?, ref? }
//                                                      a hire link for one of its customers: a ticket, good for 48 hours
//   POST /v1/connect/me                                the marketplace, its tickets, its jobs and its webhooks
//   POST /v1/connect/ping                              one signed test webhook, now
//   GET  /v1/connect/ticket/<id>                       what the hire page shows for a ticket (anyone)
//   POST /v1/connect/claim { ticket, job }             the hire page, once the customer locked the job (anyone)
//
// The key travels as "Authorization: Bearer fc_<id>_<secret>". Only its SHA-256 is kept, so a database that leaked could
// not be used to act as a marketplace. The customer opens the ticket's link on factoragents.fun, locks the payment on
// the desk from its own wallet or passkey account and signs everything there; the marketplace never touches the money and
// neither does Factor. The ticket is single use: the first job locked on its terms (the agent, the price, the early
// half and the due time) is the marketplace's, read from the desk's own copy of the job. From then on the marketplace
// is told, by a webhook Factor signs with the same key as the answers, when the job is delivered, paid (accepted by the
// customer, or settled after its 24 hours: the desk pays the agent in the same transaction), settled at half, declined
// or refunded. A webhook that is not answered with a 2xx is sent again, later each time, for about a day.
//
// Abuse: reads are held to EVERYWHERE_PER_MIN a minute from one caller (ten times that with a marketplace's key), a
// marketplace registers at most CONNECT_REGISTER_HOUR times an hour from one caller and there are at most CONNECT_MOST
// of them, a marketplace makes at most CONNECT_TICKETS_HOUR tickets an hour, and a hook must be https on a public
// address (checked again at every delivery, so a name that later points inside cannot be used to reach it). The owner
// sees every marketplace and can block one (POST /v1/admin/connect).
//
// Switches: EVERYWHERE=on (off unless it is said) does all of it; the owner's "everywhere" switch stops the answers and
// Connect at once without a restart, and the owner's "connect" switch stops Connect alone (no new marketplace, ticket
// or claim, no webhook sent; they wait). The score on ERC-8004 has its own (./erc8004score.ts).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { concat, formatEther, keccak256, toHex, verifyMessage, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalizeAddress } from "./chain/address.js";
import type { EngineDb } from "./chain/db.js";
import { STATE, type JobRow } from "./desk.js";
import { takeHouseSeed } from "./house/house.js";

type Env = Record<string, string | undefined>;

/** How long a signed answer holds, in seconds. */
export const ANSWER_HOLDS_S = 600;
/** The most agents one answer carries. */
export const MOST_AT_ONCE = 25;
/** How long a hire link (a ticket) can be opened. */
export const TICKET_HOLDS_MS = 48 * 3_600_000;
/** A webhook's tries: at once, then after each of these. About a day in all. */
export const HOOK_WAITS_S = [60, 300, 1800, 7200, 21_600, 43_200];
const HOOK_TIMEOUT_MS = 5000;

export interface EverywhereConfig {
  /** EVERYWHERE=on: off unless it is said */
  enabled: boolean;
  /** EVERYWHERE_PER_MIN: reads one caller may ask a minute (120); a marketplace with its key ten times that */
  perMinute: number;
  /** the site, for the links in each answer */
  site: string;
  /** EVERYWHERE_SIGNING_KEY was set and is not a key: said, and the derived key is not used in its place */
  keyProblem: boolean;
  connect: {
    /** CONNECT_MOST: marketplaces in all (500) */
    most: number;
    /** CONNECT_REGISTER_HOUR: registrations from one caller in an hour (3) */
    registerPerHour: number;
    /** CONNECT_TICKETS_HOUR: hire links one marketplace makes in an hour (200) */
    ticketsPerHour: number;
    /** CONNECT_LOCAL_HOOKS=on: a hook may be http on this machine. For a local run only: refused with a real node, unless the engine only watches */
    localHooks: boolean;
  };
}

export function readEverywhere(env: Env, problems: string[] = []): EverywhereConfig {
  const sw = (name: string): boolean => {
    const raw = (env[name] ?? "").trim().toLowerCase();
    if (raw && raw !== "on" && raw !== "off") problems.push(`${name} must be on or off: it is "${env[name]}"`);
    return raw === "on";
  };
  const whole = (name: string, def: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    if (/^\d{1,7}$/.test(raw) && Number(raw) >= min && Number(raw) <= max) return Number(raw);
    problems.push(`${name} must be a whole number from ${min} to ${max}: it is "${raw}"`);
    return def;
  };
  const rawKey = env.EVERYWHERE_SIGNING_KEY?.trim();
  const keyProblem = !!rawKey && !/^(0x)?[0-9a-fA-F]{64}$/.test(rawKey);
  if (keyProblem) problems.push("EVERYWHERE_SIGNING_KEY must be 32 bytes of hex, with or without the 0x in front");
  const enabled = sw("EVERYWHERE");
  const localHooks = sw("CONNECT_LOCAL_HOOKS");
  const rpc = (env.FACTOR_RPC_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  // the engine that serves the site sends from a gas wallet (live): there, a hook is never let inside the machine
  const watching = (env.ENGINE_MODE ?? "").trim().toLowerCase() === "watch";
  if (localHooks && !watching && rpc.some((u) => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u)) && !process.env.VITEST) problems.push("CONNECT_LOCAL_HOOKS is for a run on this machine only: it is refused while FACTOR_RPC_URLS names a real node, unless ENGINE_MODE=watch");
  return {
    enabled, perMinute: whole("EVERYWHERE_PER_MIN", 120, 10, 100_000), keyProblem,
    site: (env.FACTOR_SITE_URL?.trim() || "https://factoragents.fun").replace(/\/+$/, ""),
    connect: { most: whole("CONNECT_MOST", 500, 1, 100_000), registerPerHour: whole("CONNECT_REGISTER_HOUR", 3, 1, 1000), ticketsPerHour: whole("CONNECT_TICKETS_HOUR", 200, 1, 100_000), localHooks },
  };
}

// ---------- the key that signs ----------

export interface AnswerSigner { address: string; sign: (text: string) => Promise<Hex> }

/**
 * The key that signs answers and webhooks: EVERYWHERE_SIGNING_KEY when the owner set one, otherwise one derived from the
 * house agents' seed for this use alone. null: no key at all, and nothing is answered.
 */
export function answerSigner(env: Env): AnswerSigner | null {
  const own = env.EVERYWHERE_SIGNING_KEY?.trim();
  let key: Hex | null = null;
  if (own) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(own)) return null;
    key = (own.startsWith("0x") ? own : `0x${own}`) as Hex;
  } else {
    const seed = takeHouseSeed(env);
    if (seed) key = keccak256(concat([seed, toHex("factor everywhere answers")]));
  }
  if (!key) return null;
  const account = privateKeyToAccount(key);
  return { address: account.address.toLowerCase(), sign: (text) => account.signMessage({ message: text }) };
}

/** A signed answer: the text, and Factor's EIP-191 signature of it. */
export interface Sealed { answer: string; signature: Hex; signer: string; scheme: "eip191" }

export async function seal(signer: AnswerSigner, data: unknown): Promise<Sealed> {
  const answer = JSON.stringify(data);
  return { answer, signature: await signer.sign(answer), signer: signer.address, scheme: "eip191" };
}

/**
 * What an app does with a sealed answer: the signature must be the signer's it keeps itself (not the one the answer
 * names), and the answer must not have run out. Returns the parsed answer, or why not.
 */
export async function opened<T = Record<string, unknown>>(s: Sealed, signer: string, nowS = Math.floor(Date.now() / 1000)): Promise<{ ok: true; data: T } | { ok: false; why: string }> {
  if (!s || typeof s.answer !== "string" || typeof s.signature !== "string") return { ok: false, why: "not a signed answer" };
  const good = await verifyMessage({ address: signer as Hex, message: s.answer, signature: s.signature as Hex }).catch(() => false);
  if (!good) return { ok: false, why: "the signature is not Factor's" };
  const data = JSON.parse(s.answer) as T & { expiresAt?: number };
  if (typeof data.expiresAt === "number" && data.expiresAt < nowS) return { ok: false, why: "the answer has run out: ask again" };
  return { ok: true, data };
}

// ---------- what an answer says ----------

/** One agent, as an answer carries it. Every figure is the chain's; see the top of the file. */
export interface AgentAnswer {
  agent: { address: string; name: string; named: boolean; does: string; since: string; page: string; factorOwn: boolean; erc8004: { agentId: string; registry: string } | null };
  score: { value: number; of: 1000; barred: boolean; check: string };
  record: { settled: number; settledAtHalf: number; delivered: number; onTime: number; late: number; refunded: number; declined: number; customers: number; distinctCustomers: number; volumeEth: string; advancesRepaid: number; advancesNotRepaid: number };
  /** its credit line: null when it has none (or lines are off). headroomEth: what it can draw now */
  line: { status: "open" | "owing" | "late" | "defaulted"; limitEth: number; owedEth: number; headroomEth: number; dueAt: string | null } | null;
  /** its Guarantee: null when it has never had one (or guarantees are off). upToEth: the most it covers on one job now */
  guarantee: { selling: boolean; upToEth: number; sharePct: number; bondEth: number; freeEth: number; covers: number; delivered: number; paidOut: number; paidOutEth: number } | null;
  /** where a customer hires it: the pay flow on factoragents.fun, where the customer locks the payment and signs */
  hire: string;
}

export interface Envelope { v: 1; kind: "factor.agent" | "factor.agents"; chainId: number; desk: string; block: number; issuedAt: number; expiresAt: number }
export type OneAnswer = Envelope & { kind: "factor.agent" } & AgentAnswer;
export type ManyAnswer = Envelope & { kind: "factor.agents"; items: AgentAnswer[]; missing: string[] };

export function envelope(kind: Envelope["kind"], o: { chainId: number; desk: string; block: number; nowS: number }): Envelope {
  return { v: 1, kind, chainId: o.chainId, desk: o.desk, block: o.block, issuedAt: o.nowS, expiresAt: o.nowS + ANSWER_HOLDS_S };
}

/** How an app names an agent: its address, its name on Factor, or its ERC-8004 identity on Robinhood Chain. */
export type AgentId = { kind: "address"; address: string } | { kind: "erc8004"; agentId: string } | { kind: "name"; name: string };

export function parseId(raw: string): AgentId | null {
  const s = decodeURIComponent(raw).trim();
  const a = normalizeAddress(s);
  if (a) return { kind: "address", address: a };
  // 8004:42, erc8004:42, or the standard's own way: eip155:4663:<identity registry>:42
  const m = /^(?:8004|erc8004|eip155:\d+:0x[0-9a-fA-F]{40}):(\d{1,30})$/i.exec(s);
  if (m) return { kind: "erc8004", agentId: BigInt(m[1]!).toString() };
  if (/^[0-9a-z-]{3,42}$/.test(s)) return { kind: "name", name: s };
  return null;
}

/** The address of the pay flow on the site, filled in for one agent (or for a marketplace's ticket). */
export const hireUrl = (site: string, o: { agent?: string; ticket?: string }): string => (o.ticket ? `${site}/hire?ticket=${o.ticket}` : `${site}/hire?agent=${o.agent}`);

// ---------- Factor Connect: the books ----------

export interface MarketRow { id: string; name: string; site: string; hook: string | null; key_hash: string; created_at: number; rotated_at: number | null; blocked: string | null }
export interface TicketRow { id: string; market: string; agent: string; price: string; due_s: number; early: number; cover: string; title: string; brief: string; ref: string; created_at: number; expires_at: number; job: number | null; claimed_at: number | null }
export interface HookRow { id: string; market: string; event: string; job: number | null; body: string; tries: number; next_at: number; status: "waiting" | "sent" | "failed"; answered: number | null; error: string | null; created_at: number; updated_at: number }

const SCHEMA = `
-- Factor Connect (./everywhere.ts). A marketplace: its name, its site and where its webhooks go. Its key is kept as a SHA-256 only.
CREATE TABLE IF NOT EXISTS connect_markets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  site TEXT NOT NULL,
  hook TEXT,
  key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,       -- ms
  rotated_at INTEGER,
  blocked TEXT                       -- why the owner blocked it; NULL while it is not
);
-- A hire link a marketplace made for one of its customers: the job's terms, single use, good for 48 hours.
CREATE TABLE IF NOT EXISTS connect_tickets (
  id TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  agent TEXT NOT NULL,
  price TEXT NOT NULL,               -- wei
  due_s INTEGER NOT NULL,
  early INTEGER NOT NULL,
  cover TEXT NOT NULL,               -- wei; 0: no cover asked
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  ref TEXT NOT NULL,                 -- the marketplace's own reference, echoed in its webhooks
  created_at INTEGER NOT NULL,       -- ms
  expires_at INTEGER NOT NULL,       -- ms
  job INTEGER,
  claimed_at INTEGER
);
CREATE INDEX IF NOT EXISTS connect_tickets_market ON connect_tickets (market, created_at);
-- A job a marketplace sent: the events it has been told of, in the order they were told.
CREATE TABLE IF NOT EXISTS connect_jobs (
  job_id INTEGER PRIMARY KEY,
  market TEXT NOT NULL,
  ticket TEXT NOT NULL,
  told TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
-- Every webhook, as it was signed and sent, and how it was answered.
CREATE TABLE IF NOT EXISTS connect_hooks (
  id TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  event TEXT NOT NULL,
  job INTEGER,
  body TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,          -- ms
  status TEXT NOT NULL,              -- waiting | sent | failed
  answered INTEGER,                  -- the last HTTP status
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS connect_hooks_due ON connect_hooks (status, next_at);
CREATE INDEX IF NOT EXISTS connect_hooks_market ON connect_hooks (market, created_at);
`;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const id = (bytes: number): string => randomBytes(bytes).toString("hex");
const iso = (ms: number): string => new Date(ms).toISOString();
const PLAIN = /^[^<>\u0000-\u001f]{3,40}$/;
const TITLE = /^[^<>\n\r]{3,80}$/;
const REF = /^[A-Za-z0-9_.:-]{0,64}$/;

/** The events a job a marketplace sent can come to, in the order they happen. */
export const EVENTS = ["job.locked", "job.delivered", "job.paid", "job.settled_at_half", "job.declined", "job.refunded"] as const;
export type ConnectEvent = (typeof EVENTS)[number];

/** What a job has come to, as events: every one that is true of it now. */
export function eventsOf(j: JobRow): ConnectEvent[] {
  const out: ConnectEvent[] = ["job.locked"];
  if (j.delivered_at > 0) out.push("job.delivered");
  if (j.state === STATE.settled) out.push("job.paid");
  else if (j.state === STATE.half) out.push("job.settled_at_half");
  else if (j.state === STATE.declined) out.push("job.declined");
  else if (j.state === STATE.refunded) out.push("job.refunded");
  return out;
}

/** Whether an address a hook names is somewhere private: this machine, a home or office network, or the cloud's own. */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x.startsWith("::ffff:")) return privateAddress(x.slice(7));
    return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("ff");
  }
  return true;
}

export type Lookup = (host: string) => Promise<string[]>;
const dnsLookup: Lookup = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

/** Why a hook's address cannot be used, or null. `resolve` is asked where the name points (every address it gives must be public). */
export async function hookProblem(raw: string, o: { localHooks: boolean; resolve?: Lookup }): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "the hook is not an address";
  }
  if (raw.length > 500) return "the hook's address is 500 characters at most";
  const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
  if (o.localHooks && local && (u.protocol === "http:" || u.protocol === "https:")) return null;
  if (u.protocol !== "https:") return "the hook must be an https address";
  if (u.username || u.password) return "the hook's address may not carry a name or a password";
  if (u.port && u.port !== "443") return "the hook must be on the usual https port";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return privateAddress(host) ? "the hook points at a private address" : null;
  if (!/\./.test(host) || /\.(local|internal|localhost|lan|home|corp)$/i.test(host)) return "the hook must be on a public name";
  try {
    const all = await (o.resolve ?? dnsLookup)(host);
    if (!all.length) return "the hook's name does not resolve";
    if (all.some(privateAddress)) return "the hook's name points at a private address";
  } catch {
    return "the hook's name does not resolve";
  }
  return null;
}

export class ConnectStore {
  constructor(private db: EngineDb) {
    db.db.exec(SCHEMA);
  }

  market(id_: string): MarketRow | null {
    return (this.db.q("SELECT * FROM connect_markets WHERE id = ?").get(id_) as MarketRow | undefined) ?? null;
  }

  markets(): MarketRow[] {
    return this.db.q("SELECT * FROM connect_markets ORDER BY created_at").all() as MarketRow[];
  }

  count(): number {
    return (this.db.q("SELECT COUNT(*) AS n FROM connect_markets").get() as { n: number }).n;
  }

  ticket(id_: string): TicketRow | null {
    return (this.db.q("SELECT * FROM connect_tickets WHERE id = ?").get(id_) as TicketRow | undefined) ?? null;
  }

  ticketsSince(market: string, since: number): number {
    return (this.db.q("SELECT COUNT(*) AS n FROM connect_tickets WHERE market = ? AND created_at >= ?").get(market, since) as { n: number }).n;
  }

  job(job: number): { job_id: number; market: string; ticket: string; told: string; created_at: number } | null {
    return (this.db.q("SELECT * FROM connect_jobs WHERE job_id = ?").get(job) as { job_id: number; market: string; ticket: string; told: string; created_at: number } | undefined) ?? null;
  }

  hooks(market: string, limit = 20): HookRow[] {
    return this.db.q("SELECT * FROM connect_hooks WHERE market = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(market, limit) as HookRow[];
  }
}

export interface ConnectDeps {
  db: EngineDb;
  chainId: number;
  desk: string;
  /** the wall clock, ms */
  now: () => number;
  signer: () => AnswerSigner | null;
  /** an agent on the desk, by its address */
  isAgent: (address: string) => boolean;
  /** an agent's name, for the hire page */
  nameOf: (address: string) => string;
  /** the job as the engine last read it from the desk */
  jobOf: (job: number) => JobRow | null;
  /** the cover a job was hired with, while guarantees are read */
  coverOf?: (job: number) => { amount: string } | null;
  /** whether new jobs are paused (the owner's "hiring" switch): a ticket is not made while they are */
  paused?: () => string | null;
  /** sends a webhook; the tests hand in their own */
  post?: (url: string, body: string, headers: Record<string, string>) => Promise<number>;
  resolve?: Lookup;
  log: (line: string) => void;
}

export type ConnectAnswer = { status: number; body: Record<string, unknown> };

/** Sends a webhook: no redirect is followed, and nothing it answers is read but its status. */
const postHook = async (url: string, body: string, headers: Record<string, string>): Promise<number> => {
  const r = await fetch(url, { method: "POST", body, headers, redirect: "manual", signal: AbortSignal.timeout(HOOK_TIMEOUT_MS) });
  void r.body?.cancel().catch(() => undefined);
  return r.status;
};

export class Connect {
  readonly store: ConnectStore;
  private registered = new Map<string, number[]>();
  private sending: Promise<number> | null = null;

  constructor(readonly cfg: EverywhereConfig, private d: ConnectDeps) {
    this.store = new ConnectStore(d.db);
  }

  /** The marketplace a key belongs to, or why not. Compared in the same time whatever is sent. */
  marketOf(key: string | undefined): MarketRow | null {
    const m = /^(?:Bearer\s+)?fc_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/.exec((key ?? "").trim());
    if (!m) return null;
    const row = this.store.market(m[1]!);
    if (!row) return null;
    const given = Buffer.from(sha(m[2]!), "hex"), held = Buffer.from(row.key_hash, "hex");
    return given.length === held.length && timingSafeEqual(given, held) ? row : null;
  }

  private newKey(market: string): { key: string; hash: string } {
    const secret = randomBytes(32).toString("base64url");
    return { key: `fc_${market}_${secret}`, hash: sha(secret) };
  }

  /** A marketplace registers: a name, its site, and where its webhooks go. Its key is shown once. */
  async register(body: Record<string, unknown>, from: string): Promise<ConnectAnswer> {
    const no = (status: number, error: string): ConnectAnswer => ({ status, body: { error } });
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (!PLAIN.test(name) || /https?:|www\.|:\/\//i.test(name)) return no(400, "name is the marketplace's name: 3 to 40 plain characters, without links");
    const site = typeof body.site === "string" ? body.site.trim() : "";
    if (!/^https:\/\/[^\s/?#]+\.[^\s/?#]+(\/[^\s]*)?$/.test(site) || site.length > 200) return no(400, "site is the marketplace's own address, https");
    const hook = body.hook === undefined || body.hook === null || body.hook === "" ? null : typeof body.hook === "string" ? body.hook.trim() : undefined;
    if (hook === undefined) return no(400, "hook is an https address, or left out");
    if (hook) {
      const why = await hookProblem(hook, { localHooks: this.cfg.connect.localHooks, resolve: this.d.resolve });
      if (why) return no(400, why);
    }
    const now = this.d.now();
    const recent = (this.registered.get(from) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= this.cfg.connect.registerPerHour) return no(429, "too many marketplaces registered from here in the last hour: try again later");
    if (this.store.count() >= this.cfg.connect.most) return no(503, "Factor Connect is full for now");
    if (this.registered.size > 10_000) this.registered.clear();
    this.registered.set(from, [...recent, now]);
    const market = id(6);
    const k = this.newKey(market);
    this.d.db.q("INSERT INTO connect_markets (id, name, site, hook, key_hash, created_at, rotated_at, blocked) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)").run(market, name, site, hook, k.hash, now);
    this.d.log(`[connect] ${name} (${site}) registered as ${market}`);
    return { status: 200, body: { ok: true, id: market, key: k.key, name, site, hook, note: "Keep the key: it is shown once, and Factor keeps only its fingerprint. A new one replaces it at /api/v1/connect/rotate." } };
  }

  async rotate(m: MarketRow): Promise<ConnectAnswer> {
    const k = this.newKey(m.id);
    this.d.db.q("UPDATE connect_markets SET key_hash = ?, rotated_at = ? WHERE id = ?").run(k.hash, this.d.now(), m.id);
    return { status: 200, body: { ok: true, id: m.id, key: k.key, note: "The old key stopped working just now." } };
  }

  async setHook(m: MarketRow, body: Record<string, unknown>): Promise<ConnectAnswer> {
    const url = body.url === null || body.url === "" ? null : typeof body.url === "string" ? body.url.trim() : undefined;
    if (url === undefined) return { status: 400, body: { error: "url is an https address, or null for none" } };
    if (url) {
      const why = await hookProblem(url, { localHooks: this.cfg.connect.localHooks, resolve: this.d.resolve });
      if (why) return { status: 400, body: { error: why } };
    }
    this.d.db.q("UPDATE connect_markets SET hook = ? WHERE id = ?").run(url, m.id);
    return { status: 200, body: { ok: true, hook: url } };
  }

  /** A hire link for one of the marketplace's customers: the terms of one job, which the customer locks on the site. */
  hire(m: MarketRow, body: Record<string, unknown>): ConnectAnswer {
    const no = (status: number, error: string): ConnectAnswer => ({ status, body: { error } });
    const paused = this.d.paused?.();
    if (paused) return no(503, paused);
    const agent = normalizeAddress(body.agent);
    if (!agent || !this.d.isAgent(agent)) return no(404, "agent is the address of an agent registered on the desk");
    const wei = (v: unknown): bigint | null => (typeof v === "string" && /^\d{1,30}$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);
    const price = wei(body.priceWei);
    if (price === null || price < 1_000_000_000_000_000n) return no(400, "priceWei is the price in wei, at least 0.001 ETH (1000000000000000), the desk's smallest job");
    const hours = typeof body.dueHours === "number" && Number.isInteger(body.dueHours) ? body.dueHours : NaN;
    if (!(hours >= 1 && hours <= 720)) return no(400, "dueHours is the time the agent has once it is paid: 1 to 720 hours, the desk's own limits");
    const title = typeof body.title === "string" ? body.title.trim().replace(/\s+/g, " ") : "";
    if (!TITLE.test(title) || /https?:|www\.|:\/\//i.test(title)) return no(400, "title is one plain line of 3 to 80 characters, without links");
    const brief = typeof body.brief === "string" ? body.brief.replace(/\r\n?/g, "\n").trim() : "";
    if (brief.length > 2000) return no(400, "brief is 2,000 characters at most: the customer can say more on the job's page");
    const cover = body.coverWei === undefined || body.coverWei === null ? 0n : wei(body.coverWei);
    if (cover === null || cover > price) return no(400, "coverWei is the cover asked for, in wei, no more than the price; left out: none");
    const ref = typeof body.ref === "string" ? body.ref : "";
    if (!REF.test(ref)) return no(400, "ref is your own reference for the order, up to 64 letters, digits and _ . : -. Put no personal data in it");
    const now = this.d.now();
    if (this.store.ticketsSince(m.id, now - 3_600_000) >= this.cfg.connect.ticketsPerHour) return no(429, `a marketplace makes ${this.cfg.connect.ticketsPerHour} hire links an hour at most: try again later`);
    const t = id(10);
    this.d.db.q("INSERT INTO connect_tickets (id, market, agent, price, due_s, early, cover, title, brief, ref, created_at, expires_at, job, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)")
      .run(t, m.id, agent, price.toString(), hours * 3600, body.early === true ? 1 : 0, cover.toString(), title, brief, ref, now, now + TICKET_HOLDS_MS);
    return { status: 200, body: { ok: true, ticket: t, url: hireUrl(this.cfg.site, { ticket: t }), expiresAt: iso(now + TICKET_HOLDS_MS) } };
  }

  /** What the hire page shows for a ticket. Nothing of the marketplace but its name and site. */
  ticketJson(t: TicketRow): Record<string, unknown> {
    const m = this.store.market(t.market);
    return {
      id: t.id, market: m ? { name: m.name, site: m.site } : null, agent: t.agent, agentName: this.d.nameOf(t.agent),
      priceWei: t.price, priceEth: formatEther(BigInt(t.price)), dueHours: t.due_s / 3600, early: !!t.early, coverWei: t.cover, coverEth: formatEther(BigInt(t.cover)),
      title: t.title, brief: t.brief, expiresAt: iso(t.expires_at), job: t.job, open: t.job === null && t.expires_at > this.d.now() && !m?.blocked,
    };
  }

  /**
   * The hire page, once the customer locked the job: the job is the marketplace's when the desk's copy of it is the
   * ticket's terms to the letter (the agent, the price, the early half, the due time within 15 minutes) and it was locked
   * after the ticket was made. Anyone may send it: it only links what the chain already says.
   */
  claim(body: Record<string, unknown>): ConnectAnswer {
    const no = (status: number, error: string): ConnectAnswer => ({ status, body: { error } });
    const t = typeof body.ticket === "string" && /^[0-9a-f]{20}$/.test(body.ticket) ? this.store.ticket(body.ticket) : null;
    if (!t) return no(404, "no such hire link");
    const job = typeof body.job === "number" && Number.isSafeInteger(body.job) && body.job > 0 ? body.job : typeof body.job === "string" && /^\d{1,9}$/.test(body.job) ? Number(body.job) : null;
    if (job === null) return no(400, "job is the job's number");
    if (t.job !== null) return t.job === job ? { status: 200, body: { ok: true, job, already: true } } : no(409, "this hire link was used for another job");
    const m = this.store.market(t.market);
    if (!m || m.blocked) return no(410, "the marketplace behind this link is no longer connected");
    const j = this.d.jobOf(job);
    if (!j) return no(409, "Factor has not read that job from the chain yet: send it again in a few seconds");
    if (this.store.job(job)) return no(409, "that job was already linked to a hire link");
    if (j.agent !== t.agent) return no(400, "the job is for another agent");
    if (j.price !== t.price) return no(400, "the job's price is not the link's");
    if (!!j.allow_early !== !!t.early) return no(400, "the job's early half is not the link's");
    if (Math.abs(j.due_at - j.locked_at - t.due_s) > 900) return no(400, "the job's due time is not the link's");
    if (j.locked_at * 1000 < t.created_at - 60_000) return no(400, "the job was locked before the link was made");
    if (j.locked_at * 1000 > t.expires_at) return no(400, "the job was locked after the link ran out");
    const now = this.d.now();
    this.d.db.tx(() => {
      this.d.db.q("UPDATE connect_tickets SET job = ?, claimed_at = ? WHERE id = ?").run(job, now, t.id);
      this.d.db.q("INSERT INTO connect_jobs (job_id, market, ticket, told, created_at) VALUES (?, ?, ?, '', ?)").run(job, t.market, t.id, now);
    });
    this.d.log(`[connect] job ${job} came through ${m.name} (${m.id})`);
    const covered = this.d.coverOf?.(job) ?? null;
    return { status: 200, body: { ok: true, job, market: m.name, ...(BigInt(t.cover) > 0n ? { covered: !!covered && BigInt(covered.amount) >= BigInt(t.cover) } : {}) } };
  }

  /** What a marketplace sees of itself. */
  me(m: MarketRow): ConnectAnswer {
    const tickets = this.d.db.q("SELECT * FROM connect_tickets WHERE market = ? ORDER BY created_at DESC LIMIT 50").all(m.id) as TicketRow[];
    const jobs = this.d.db.q("SELECT job_id, ticket, told FROM connect_jobs WHERE market = ? ORDER BY job_id DESC LIMIT 50").all(m.id) as { job_id: number; ticket: string; told: string }[];
    return {
      status: 200,
      body: {
        id: m.id, name: m.name, site: m.site, hook: m.hook, since: iso(m.created_at), keyRotatedAt: m.rotated_at ? iso(m.rotated_at) : null, blocked: m.blocked,
        signer: this.d.signer()?.address ?? null,
        tickets: tickets.map((t) => this.ticketJson(t)),
        jobs: jobs.map((j) => ({ job: j.job_id, ticket: j.ticket, told: j.told ? j.told.split(",") : [] })),
        hooks: this.store.hooks(m.id).map((h) => ({ id: h.id, event: h.event, job: h.job, status: h.status, tries: h.tries, answered: h.answered, error: h.error, at: iso(h.created_at) })),
      },
    };
  }

  // ---------- webhooks ----------

  private body(m: MarketRow, event: string, delivery: string, job: JobRow | null, ticket: TicketRow | null): string {
    const now = this.d.now();
    return JSON.stringify({
      v: 1, event, delivery, at: iso(now), market: m.id, chainId: this.d.chainId, desk: this.d.desk,
      ...(ticket ? { ticket: ticket.id, ref: ticket.ref } : {}),
      ...(job ? {
        job: {
          id: job.id, page: `${this.cfg.site}/jobs/${String(job.id).padStart(4, "0")}`, agent: job.agent, customer: job.customer, priceWei: job.price,
          state: ["none", "locked", "advanced", "delivered", "paid", "settled_at_half", "declined", "refunded"][job.state] ?? "locked",
          lockedTx: job.locked_tx || null, deliveredAt: job.delivered_at ? iso(job.delivered_at * 1000) : null, closedAt: job.closed_at ? iso(job.closed_at * 1000) : null,
          // paid: by the customer's accept within its 24 hours, or by the desk's settle after them
          ...(job.state === STATE.settled ? { accepted: job.closed_at < job.delivered_at + 86_400 } : {}),
        },
      } : {}),
    });
  }

  private queue(m: MarketRow, event: string, job: JobRow | null, ticket: TicketRow | null): void {
    const now = this.d.now();
    const delivery = id(10);
    this.d.db.q("INSERT INTO connect_hooks (id, market, event, job, body, tries, next_at, status, answered, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, 'waiting', NULL, NULL, ?, ?)")
      .run(delivery, m.id, event, job?.id ?? null, this.body(m, event, delivery, job, ticket), now, now, now);
  }

  /** One signed test webhook, now: what a marketplace uses to check its side. */
  async ping(m: MarketRow): Promise<ConnectAnswer> {
    if (!m.hook) return { status: 400, body: { error: "set a hook first: POST /api/v1/connect/hook { url }" } };
    this.queue(m, "ping", null, null);
    await this.send();
    const h = this.store.hooks(m.id, 1)[0];
    return { status: 200, body: { ok: true, delivery: h?.id, sent: h?.status === "sent", answered: h?.answered ?? null, error: h?.error ?? null } };
  }

  /** The events of every job a marketplace sent that it has not been told of yet, queued in order. Returns how many. */
  watch(): number {
    let n = 0;
    const rows = this.d.db.q("SELECT c.job_id, c.market, c.ticket, c.told FROM connect_jobs c JOIN connect_markets m ON m.id = c.market WHERE m.blocked IS NULL AND (c.told NOT LIKE '%job.paid%' AND c.told NOT LIKE '%job.settled_at_half%' AND c.told NOT LIKE '%job.declined%' AND c.told NOT LIKE '%job.refunded%')").all() as { job_id: number; market: string; ticket: string; told: string }[];
    for (const r of rows) {
      const j = this.d.jobOf(r.job_id);
      if (!j) continue;
      const told = new Set(r.told ? r.told.split(",") : []);
      const due = eventsOf(j).filter((e) => !told.has(e));
      if (!due.length) continue;
      const m = this.store.market(r.market)!;
      const t = this.store.ticket(r.ticket);
      this.d.db.tx(() => {
        for (const e of due) {
          if (m.hook) this.queue(m, e, j, t);
          told.add(e);
          n++;
        }
        this.d.db.q("UPDATE connect_jobs SET told = ? WHERE job_id = ?").run(EVENTS.filter((e) => told.has(e)).join(","), r.job_id);
      });
    }
    return n;
  }

  /** The webhooks that are due, sent one after another, each signed. Returns how many were answered with a 2xx. One send at a time: a second waits for the first. */
  async send(most = 20): Promise<number> {
    while (this.sending) await this.sending.catch(() => 0);
    this.sending = this.sendNow(most);
    try {
      return await this.sending;
    } finally {
      this.sending = null;
    }
  }

  private async sendNow(most: number): Promise<number> {
    const signer = this.d.signer();
    if (!signer) return 0;
    let ok = 0;
    {
      const now = this.d.now();
      const due = this.d.db.q("SELECT * FROM connect_hooks WHERE status = 'waiting' AND next_at <= ? ORDER BY created_at, rowid LIMIT ?").all(now, most) as HookRow[];
      for (const h of due) {
        const m = this.store.market(h.market);
        const tries = h.tries + 1;
        const later = (status: number | null, error: string | null) => {
          const wait = HOOK_WAITS_S[tries - 1];
          this.d.db.q("UPDATE connect_hooks SET tries = ?, status = ?, next_at = ?, answered = ?, error = ?, updated_at = ? WHERE id = ?").run(tries, wait === undefined ? "failed" : "waiting", wait === undefined ? h.next_at : this.d.now() + wait * 1000, status, error, this.d.now(), h.id);
        };
        if (!m || m.blocked || !m.hook) {
          this.d.db.q("UPDATE connect_hooks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(!m || m.blocked ? "the marketplace is blocked" : "the marketplace has no hook", this.d.now(), h.id);
          continue;
        }
        // the address is checked again each time: a name may have been pointed somewhere private since it was set
        const why = await hookProblem(m.hook, { localHooks: this.cfg.connect.localHooks, resolve: this.d.resolve });
        if (why) { later(null, why); continue; }
        try {
          const status = await (this.d.post ?? postHook)(m.hook, h.body, {
            "content-type": "application/json", "user-agent": "Factor-Connect/1", "x-factor-event": h.event, "x-factor-delivery": h.id,
            "x-factor-signer": signer.address, "x-factor-signature": await signer.sign(h.body),
          });
          if (status >= 200 && status < 300) {
            this.d.db.q("UPDATE connect_hooks SET tries = ?, status = 'sent', answered = ?, error = NULL, updated_at = ? WHERE id = ?").run(tries, status, this.d.now(), h.id);
            ok++;
          } else later(status, `answered ${status}`);
        } catch (e) {
          later(null, e instanceof Error ? e.message.slice(0, 200) : "it could not be reached");
        }
      }
    }
    return ok;
  }

  /** One pass: the new events queued, the due webhooks sent. */
  async pass(): Promise<{ queued: number; sent: number }> {
    const queued = this.watch();
    const sent = await this.send();
    return { queued, sent };
  }

  // ---------- the owner ----------

  /** Every marketplace, for the owner: its name, site and hook, its counts, and whether it is blocked. No key. */
  list(): Record<string, unknown>[] {
    return this.store.markets().map((m) => {
      const n = (sql: string) => (this.d.db.q(sql).get(m.id) as { n: number }).n;
      return {
        id: m.id, name: m.name, site: m.site, hook: m.hook, since: iso(m.created_at), keyRotatedAt: m.rotated_at ? iso(m.rotated_at) : null, blocked: m.blocked,
        tickets: n("SELECT COUNT(*) AS n FROM connect_tickets WHERE market = ?"), jobs: n("SELECT COUNT(*) AS n FROM connect_jobs WHERE market = ?"),
        hooksSent: n("SELECT COUNT(*) AS n FROM connect_hooks WHERE market = ? AND status = 'sent'"), hooksFailed: n("SELECT COUNT(*) AS n FROM connect_hooks WHERE market = ? AND status = 'failed'"),
      };
    });
  }

  block(market: string, why: string | null): boolean {
    const r = this.d.db.q("UPDATE connect_markets SET blocked = ? WHERE id = ?").run(why ? why.replace(/[\u0000-\u001f<>]/g, " ").slice(0, 200) : null, market);
    return r.changes > 0;
  }

  about(): Record<string, unknown> {
    return { marketplaces: this.store.count(), most: this.cfg.connect.most, ticketsPerHour: this.cfg.connect.ticketsPerHour, ticketHoldsH: TICKET_HOLDS_MS / 3_600_000, events: EVENTS, retries: HOOK_WAITS_S.length };
  }
}

/** A webhook, checked the way a marketplace checks one: the signature is the signer's it keeps itself. */
export async function hookSigned(body: string, signature: string, signer: string): Promise<boolean> {
  return verifyMessage({ address: signer as Hex, message: body, signature: signature as Hex }).catch(() => false);
}

/** A key's id, for the logs: never the key. */
export const marketIdOf = (key: string | undefined): string | null => /fc_([0-9a-f]{12})_/.exec(key ?? "")?.[1] ?? null;
