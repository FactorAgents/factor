// HEY builder records (docs/HEY.md): what HEY Research Lab (heyresearch.xyz), the public record of building on Robinhood
// Chain, has recorded of a project's builders, read from HEY's public API and shown as HEY's, with a link to the source.
//
//   GET  /v1/hey                 whether it is on, what is read and where, and the words that go with it
//   GET  /v1/hey/record?q=       a project's builder record on HEY, by its name, $TICKER, HEY slug or a 0x contract
//   GET  /v1/hey/agent/<id>      the HEY project an agent's owner linked it to, with that project's builder record
//   POST /v1/hey/link            an agent's owner links it to its maker's project on HEY (or unlinks it), signed
//
// What HEY agreed, and what this file holds to:
//   - every request to HEY carries "x-hey-integration: factor/<version>", the engine's own version (HEY_INTEGRATION)
//   - HEY's facts are passed on as HEY gives them, under HEY's own names, with the address they were read from and the
//     page on HEY to link to. Nothing here turns them into a score, a rank or a grade, and they never touch the Factor
//     Score, a limit or anything on the chain. Market figures and HEY's own computed figures (its Build Momentum, its
//     Discovery Gap, a valuation) are not read into a record at all: a builder record is what the team shipped.
//   - the Verified Builder mark is HEY's, worded "this team ships", never as HEY rating an agent
//
// Being a good guest of a free API (no key needed, 120 requests a minute, answers cached 60 s on HEY's side): every
// answer is kept HEY_CACHE_S (600 s) here; requests for the same thing at the same time share one call; the engine makes
// HEY_PER_MIN (60) calls a minute at most, half of HEY's limit; a 429 is waited out for as long as its retry-after says;
// a call that takes HEY_TIMEOUT_S (8 s) is dropped. When HEY is down, slow or busy, the last answer kept (up to a day
// old) is given, marked stale with its time; with none, the answer says HEY could not be reached, and nothing else on
// Factor waits for it. HEY_API_KEY, when set, is sent as HEY's free key ("a free key names you"); it is optional, read
// when a call is made, and never logged, stored or returned.
//
// The link of an agent to a HEY project is the agent owner's word, signed like the other owner actions (the agent's own
// wallet, its maker for an agent made on the site, Factor's admin for Factor's own agents; an account through one of its
// keys). The project is named by its HEY slug or by a contract address HEY ties to it, and it must be one HEY has
// published when it is linked. The link says "its maker's project on HEY", which is the owner's own claim: the page
// says who linked it and when.
//
// Switches: HEY=on (off unless it is said), and the owner's "hey" switch (./switches.ts), which hides it all at once and
// stops every call to HEY. With it off, nothing about HEY shows anywhere and HEY is never asked anything.

import { createRequire } from "node:module";
import { normalizeAddress } from "./chain/address.js";
import type { EngineDb } from "./chain/db.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

/** The engine's own version, as its package says it: what HEY is told in every request (factor/<version>). */
export const ENGINE_VERSION: string = (() => {
  try {
    const v = (createRequire(import.meta.url)("../package.json") as { version?: unknown }).version;
    return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
export const HEY_INTEGRATION = `factor/${ENGINE_VERSION}`;
export const HEY_SITE = "https://heyresearch.xyz";
export const HEY_CHAIN = 4663;
/** The words that go with a builder record wherever it shows: HEY's, and what it is not. */
export const HEY_WORDS = {
  what: "HEY Research Lab is the public record of building on Robinhood Chain: what each team shipped, with its source.",
  mark: "Verified Builder on HEY: this team ships.",
  not: "HEY's builder record says what a team shipped and how HEY knows it. It is not a rating of an agent, and it never changes the Factor Score.",
};

export interface HeyConfig {
  /** HEY=on: off unless it is said */
  enabled: boolean;
  /** HEY_API_URL: HEY's API (https://heyresearch.xyz/api) */
  base: string;
  /** HEY_TIMEOUT_S: how long one call may take */
  timeoutMs: number;
  /** HEY_CACHE_S: how long an answer is kept before HEY is asked again */
  freshMs: number;
  /** how long an answer may still be given, marked stale, while HEY cannot be reached */
  staleMs: number;
  /** HEY_PER_MIN: the most calls the engine makes to HEY in a minute */
  perMinute: number;
  /** the header every call carries */
  integration: string;
}

export function readHey(env: Env, problems: string[] = []): HeyConfig {
  const raw = (env.HEY ?? "").trim().toLowerCase();
  if (raw && raw !== "on" && raw !== "off") problems.push(`HEY must be on or off: it is "${env.HEY}"`);
  const whole = (name: string, def: number, min: number, max: number): number => {
    const v = env[name]?.trim();
    if (!v) return def;
    if (/^\d{1,6}$/.test(v) && Number(v) >= min && Number(v) <= max) return Number(v);
    problems.push(`${name} must be a whole number from ${min} to ${max}: it is "${v}"`);
    return def;
  };
  let base = `${HEY_SITE}/api`;
  const given = env.HEY_API_URL?.trim().replace(/\/+$/, "");
  if (given) {
    // HEY itself, over https; or a stand-in on this machine, for a test
    if (/^https:\/\/[a-z0-9.-]+(?::\d+)?(\/[\w./-]*)?$/i.test(given) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[\w./-]*)?$/i.test(given)) base = given;
    else problems.push(`HEY_API_URL must be an https address: it is "${given}"`);
  }
  return {
    enabled: raw === "on", base,
    timeoutMs: whole("HEY_TIMEOUT_S", 8, 1, 60) * 1000,
    freshMs: whole("HEY_CACHE_S", 600, 60, 86_400) * 1000,
    staleMs: 86_400_000,
    perMinute: whole("HEY_PER_MIN", 60, 1, 120),
    integration: HEY_INTEGRATION,
  };
}

// ---------- the client ----------

export interface HeyResponse { status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }
export type HeyFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<HeyResponse>;

/** One answer of HEY's: its status and body, when it was read, and whether it is an old one given while HEY is away. */
export interface HeyGot { status: number; body: unknown; url: string; at: number; stale: boolean }

/** HEY could not be asked, or did not answer, and nothing was kept to give instead. */
export class HeyAway extends Error {
  constructor(message: string, readonly retryAfterS: number | null = null) {
    super(message);
  }
}

export interface HeyClientOptions {
  fetch?: HeyFetch;
  now?: () => number;
  /** HEY's free key, read at the moment of a call. Not set: no key is sent */
  key?: () => string | undefined;
  /** whether calls may be made at all: the switch */
  allowed?: () => boolean;
}

/** HEY's public API, asked politely: one header on every call, answers kept, a limit on calls, a time limit on each. */
export class HeyClient {
  private kept = new Map<string, { at: number; status: number; body: unknown }>();
  private flying = new Map<string, Promise<HeyGot>>();
  private calls: number[] = [];
  private waitUntil = 0;
  readonly counts = { calls: 0, kept: 0, stale: 0, failed: 0, limited: 0 };
  lastError: { at: number; message: string } | null = null;
  lastOkAt: number | null = null;
  private readonly f: HeyFetch;
  private readonly now: () => number;

  constructor(readonly cfg: HeyConfig, private o: HeyClientOptions = {}) {
    this.f = o.fetch ?? (globalThis.fetch as unknown as HeyFetch);
    this.now = o.now ?? Date.now;
  }

  /** The headers of every call: what Factor is, always; HEY's free key when one is set. */
  headers(): Record<string, string> {
    const key = this.o.key?.()?.trim();
    return { accept: "application/json", "x-hey-integration": this.cfg.integration, ...(key && /^[\w.-]{8,200}$/.test(key) ? { authorization: `Bearer ${key}` } : {}) };
  }

  /** An answer of HEY's for a path under its API (like "/projects/factor/snapshot"): kept, shared, limited and timed. */
  async get(path: string): Promise<HeyGot> {
    const url = `${this.cfg.base}${path}`;
    const t = this.now();
    const k = this.kept.get(path);
    // a not-found is kept for less time than a found: a project HEY publishes later shows up within minutes
    const life = k && k.status === 200 ? this.cfg.freshMs : Math.min(this.cfg.freshMs, 120_000);
    if (k && t - k.at < life) { this.counts.kept++; return { status: k.status, body: k.body, url, at: k.at, stale: false }; }
    const flying = this.flying.get(path);
    if (flying) return flying;
    const p = this.call(path, url).finally(() => this.flying.delete(path));
    this.flying.set(path, p);
    return p;
  }

  private staleOr(path: string, url: string, why: HeyAway): HeyGot {
    const k = this.kept.get(path);
    if (k && k.status === 200 && this.now() - k.at < this.cfg.staleMs) { this.counts.stale++; return { status: k.status, body: k.body, url, at: k.at, stale: true }; }
    throw why;
  }

  private async call(path: string, url: string): Promise<HeyGot> {
    if (this.o.allowed && !this.o.allowed()) throw new HeyAway("HEY builder records are switched off on Factor");
    const t = this.now();
    if (t < this.waitUntil) { this.counts.limited++; return this.staleOr(path, url, new HeyAway("HEY asked Factor to wait a moment", Math.ceil((this.waitUntil - t) / 1000))); }
    this.calls = this.calls.filter((x) => t - x < 60_000);
    if (this.calls.length >= this.cfg.perMinute) { this.counts.limited++; return this.staleOr(path, url, new HeyAway("Factor has asked HEY enough for this minute", 60)); }
    this.calls.push(t);
    this.counts.calls++;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const r = await Promise.race([
        this.f(url, { headers: this.headers(), signal: ctl.signal }),
        new Promise<never>((_, no) => { timer = setTimeout(() => { ctl.abort(); no(new HeyAway("HEY did not answer in time")); }, this.cfg.timeoutMs); }),
      ]);
      if (r.status === 429) {
        const after = Number(r.headers.get("retry-after"));
        this.waitUntil = this.now() + Math.min(300, Number.isFinite(after) && after > 0 ? after : 30) * 1000;
        throw new HeyAway("HEY asked Factor to wait a moment", Math.ceil((this.waitUntil - this.now()) / 1000));
      }
      if (r.status >= 500) throw new HeyAway(`HEY answered ${r.status}`);
      const body = await r.json().catch(() => null);
      if (r.status === 200 && (body === null || typeof body !== "object")) throw new HeyAway("HEY's answer was not JSON");
      // a found, a not-found and a refusal are all answers: kept, so the same question is not asked again at once
      if (r.status === 200 || r.status === 404 || r.status === 400) {
        if (this.kept.size > 2000) this.kept.clear();
        this.kept.set(path, { at: this.now(), status: r.status, body });
        this.lastOkAt = this.now();
        return { status: r.status, body, url, at: this.now(), stale: false };
      }
      throw new HeyAway(`HEY answered ${r.status}`);
    } catch (e) {
      const away = e instanceof HeyAway ? e : new HeyAway(ctl.signal.aborted ? "HEY did not answer in time" : "HEY could not be reached");
      this.counts.failed++;
      this.lastError = { at: this.now(), message: away.message };
      return this.staleOr(path, url, away);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Forget every answer kept (a test, or the owner turning it back on). */
  forget(): void {
    this.kept.clear();
    this.waitUntil = 0;
  }
}

// ---------- a builder record ----------

/** The facts a builder record carries, under HEY's own names and as HEY gives them. */
export interface HeyFacts {
  verified_builder: boolean | null;
  research_level: string | null;
  hey_status: string | null;
  hey_status_label: string | null;
  hey_status_help: string | null;
  last_activity_at: string | null;
  meaningful_ships_30d: number | null;
  latest_meaningful_ship: { title: string | null; url: string | null; timestamp: string | null; kind: string | null; evidence_id: string | null; evidence_link: string | null } | null;
  latest_change: { summary: string | null; occurred_at: string | null; precision: string | null; evidence_id: string | null; url: string | null } | null;
  latest_release: unknown;
  latest_deployment: unknown;
  repo_url: string | null;
  token_verification: string | null;
  as_of: string | null;
}

export interface BuilderRecord {
  found: true;
  /** who says it: always HEY */
  source: "HEY Research Lab";
  /** the project's page on HEY: where every record links */
  sourceUrl: string;
  /** HEY's badge for the project, as HEY serves it */
  badgeUrl: string;
  project: { slug: string; name: string; symbol: string | null; contract: string | null };
  facts: HeyFacts;
  /** HEY's own words on what its record is and is not */
  disclaimer: string | null;
  /** where HEY's answers were read, and when */
  read: string[];
  readAt: string;
  /** an answer kept from before, given because HEY could not be reached just now */
  stale: boolean;
  /** which of HEY's answers the facts are from: its builder card (a project with a token on the chain) or its snapshot */
  from: "builder card" | "snapshot";
  integration: string;
  words: typeof HEY_WORDS;
}

export interface NotOnHey {
  found: false;
  /** why: HEY does not have it, HEY has several, or HEY could not be reached */
  why: string;
  away?: boolean;
  /** projects HEY suggested for the words, to pick from: each with its page on HEY */
  candidates?: { slug: string; name: string; symbol: string | null; contract: string | null; status: string | null; sourceUrl: string }[];
  source: "HEY Research Lab";
  sourceUrl: string;
}

export type HeyLookup = BuilderRecord | NotOnHey;

const str = (x: unknown): string | null => (typeof x === "string" && x.length <= 2000 ? x : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
const https = (x: unknown): string | null => { const s = str(x); return s && /^https:\/\/[^\s"<>]{3,1500}$/.test(s) ? s : null; };
const SLUG = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/;
const pageOf = (slug: string) => `${HEY_SITE}/project/${slug}`;

/** What a person may type to name a project: words, a $TICKER, a HEY slug, a HEY project link or a 0x contract. */
export function queryOf(raw: unknown): { kind: "contract"; address: string } | { kind: "slug"; slug: string } | { kind: "words"; text: string } | null {
  if (typeof raw !== "string") return null;
  const q = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!q || q.length > 120) return null;
  const a = normalizeAddress(q);
  if (a) return { kind: "contract", address: a };
  const link = /^(?:https?:\/\/)?(?:www\.)?heyresearch\.xyz\/project\/([a-z0-9-]{1,100})\/?(?:[?#].*)?$/i.exec(q);
  if (link && SLUG.test(link[1]!.toLowerCase())) return { kind: "slug", slug: link[1]!.toLowerCase() };
  const text = q.replace(/\s+/g, " ");
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  return { kind: "words", text };
}

/** HEY's builder card (GET /api/v1/builder), its builder facts as they are. */
function factsOfCard(c: Record<string, unknown>): HeyFacts {
  const ship = obj(c.latest_meaningful_ship), change = obj(c.latest_change);
  return {
    verified_builder: typeof c.verified_builder === "boolean" ? c.verified_builder : null,
    research_level: str(c.research_level), hey_status: str(c.hey_status), hey_status_label: str(c.hey_status_label), hey_status_help: str(c.hey_status_help),
    last_activity_at: str(c.last_activity_at), meaningful_ships_30d: num(c.meaningful_ships_30d),
    latest_meaningful_ship: ship ? { title: str(ship.title), url: https(ship.url), timestamp: str(ship.timestamp), kind: str(ship.kind), evidence_id: str(ship.evidence_id), evidence_link: https(ship.evidence_link) } : null,
    latest_change: change ? { summary: str(change.summary), occurred_at: str(change.occurred_at), precision: str(change.precision), evidence_id: str(change.evidence_id), url: https(change.url) } : null,
    latest_release: c.latest_release ?? null, latest_deployment: c.latest_deployment ?? null,
    repo_url: https(c.repo_url), token_verification: str(c.token_verification), as_of: str(c.as_of),
  };
}

/** HEY's snapshot of a project (GET /api/projects/<slug>/snapshot), for a project HEY has no token for: the same facts, from its own fields. */
function factsOfSnapshot(s: Record<string, unknown>): HeyFacts {
  const id = obj(s.identity) ?? {}, build = obj(s.build) ?? {}, ev = obj(s.evidenceSummary) ?? {}, ver = obj(obj(s.verification)?.token) ?? {};
  const items = (obj(s.latestChanges)?.items as unknown[] | undefined) ?? [];
  const first = obj(items[0]);
  const shipped = items.map(obj).find((x) => x && x.countsAsBuilding === true) ?? null;
  const evOf = (x: Record<string, unknown> | null) => obj(((x?.evidence as unknown[] | undefined) ?? [])[0]);
  return {
    verified_builder: str(id.researchLevel) ? id.researchLevel === "VERIFIED_BUILDER" : null,
    research_level: str(id.researchLevel), hey_status: str(build.activityStatus), hey_status_label: null, hey_status_help: null,
    last_activity_at: str(build.lastShippedAt), meaningful_ships_30d: num(ev.meaningfulEvents30d),
    latest_meaningful_ship: shipped ? { title: str(shipped.summaryCurrent) ?? str(shipped.summary), url: https(evOf(shipped)?.url), timestamp: str(shipped.occurredAt), kind: str(shipped.type), evidence_id: str(shipped.id), evidence_link: str(shipped.id) ? `${HEY_SITE}/evidence/${encodeURIComponent(String(shipped.id))}` : null } : null,
    latest_change: first ? { summary: str(first.summaryCurrent) ?? str(first.summary), occurred_at: str(first.occurredAt), precision: str(first.precision), evidence_id: str(first.id), url: str(first.id) ? `${HEY_SITE}/api/evidence/${encodeURIComponent(String(first.id))}` : null } : null,
    latest_release: null, latest_deployment: null, repo_url: null, token_verification: str(ver.status), as_of: str(s.asOf),
  };
}

/** HEY's status, as HEY's own pages say it, for a record read from a snapshot (which carries the code alone). */
export const STATUS_LABEL: Record<string, string> = { SHIPPING: "Shipping", ACTIVE: "Active", RESUMED: "Resumed", QUIET: "Quiet", DORMANT: "Dormant", UNKNOWN: "Unknown" };

/** Builder records: HEY's answers, put together for one project. */
export class HeyRecords {
  constructor(readonly client: HeyClient) {}

  /** A project's builder record, by what a person typed, or why there is none. */
  async lookup(raw: unknown): Promise<HeyLookup> {
    const q = queryOf(raw);
    const none = (why: string, more: Partial<NotOnHey> = {}): NotOnHey => ({ found: false, why, source: "HEY Research Lab", sourceUrl: HEY_SITE, ...more });
    if (!q) return none("name a project by its name, its $TICKER, its HEY page or a 0x contract on Robinhood Chain");
    try {
      if (q.kind === "slug") return await this.record(q.slug);
      if (q.kind === "contract") {
        const c = await this.client.get(`/contracts/${HEY_CHAIN}/${q.address}`);
        const project = obj(obj(c.body)?.associatedProject);
        const slug = str(project?.slug)?.toLowerCase();
        if (c.status !== 200) return none(`HEY holds no record of ${q.address} on Robinhood Chain`, { sourceUrl: `${HEY_SITE}/search?q=${q.address}` });
        if (!slug || !SLUG.test(slug)) return none(`HEY knows the contract ${q.address} but ties it to no project it has published`, { sourceUrl: `${HEY_SITE}/search?q=${q.address}` });
        return await this.record(slug, q.address);
      }
      const words = q.text.replace(/^\$/, "");
      const s = await this.client.get(`/search/suggest?q=${encodeURIComponent(q.text)}`);
      const list = ((obj(s.body)?.suggestions as unknown[] | undefined) ?? []).map(obj).filter((x): x is Record<string, unknown> => !!x && x.type === "project" && !!str(x.slug) && SLUG.test(String(x.slug)));
      const cands = list.slice(0, 5).map((x) => ({ slug: String(x.slug), name: str(x.name) ?? String(x.slug), symbol: str(x.symbol), contract: normalizeAddress(x.contract) ?? null, status: str(x.status), sourceUrl: pageOf(String(x.slug)) }));
      const low = words.toLowerCase();
      const exact = list.filter((x) => String(x.slug) === low || (str(x.name) ?? "").toLowerCase() === low || (str(x.symbol) ?? "").toLowerCase() === low);
      if (exact.length === 1) return await this.record(String(exact[0]!.slug));
      if (exact.length > 1) return none(`HEY has ${exact.length} projects called ${words}: say which, by its HEY page or its contract`, { candidates: cands.filter((c) => exact.some((x) => x.slug === c.slug)) });
      return none(cands.length ? `HEY has no project called ${words}; it suggests these` : `HEY has no project called ${words}`, { ...(cands.length ? { candidates: cands } : {}), sourceUrl: `${HEY_SITE}/search?q=${encodeURIComponent(words)}` });
    } catch (e) {
      return none(e instanceof HeyAway ? `${e.message}: try again in a minute` : "HEY could not be reached: try again in a minute", { away: true });
    }
  }

  /** A published project's builder record by its slug: the snapshot, and HEY's builder card when it has a token on the chain. */
  async record(slug: string, contract?: string): Promise<HeyLookup> {
    const snap = await this.client.get(`/projects/${slug}/snapshot`);
    const s = obj(snap.body);
    if (snap.status !== 200 || !s) return { found: false, why: `HEY has published no project ${slug}`, source: "HEY Research Lab", sourceUrl: HEY_SITE };
    const id = obj(s.identity) ?? {};
    const token = normalizeAddress(obj(id.token)?.contractAddress) ?? null;
    const read = [snap.url];
    // the snapshot's own disclaimer is about figures a builder record does not carry (Still Building, Under the Radar):
    // a record read from the snapshot alone carries HEY_WORDS.not instead
    let facts = factsOfSnapshot(s), from: BuilderRecord["from"] = "snapshot", disclaimer: string | null = null, at = snap.at, stale = snap.stale;
    if (token) {
      try {
        const card = await this.client.get(`/v1/builder?chain=${HEY_CHAIN}&token=${token}`);
        const c = obj(card.body);
        if (card.status === 200 && c) {
          facts = factsOfCard(c);
          from = "builder card";
          disclaimer = str(c.disclaimer);
          read.push(card.url);
          at = Math.min(at, card.at);
          stale = stale || card.stale;
        }
      } catch {
        // the snapshot's own facts stand: the card is a second reading of the same record
      }
    }
    if (from === "snapshot" && facts.hey_status) facts.hey_status_label = STATUS_LABEL[facts.hey_status] ?? null;
    return {
      found: true, source: "HEY Research Lab", sourceUrl: pageOf(slug), badgeUrl: `${HEY_SITE}/api/badge/${slug}`,
      project: { slug, name: str(id.name) ?? slug, symbol: str(id.symbol), contract: token ?? (contract ? normalizeAddress(contract) : null) },
      facts, disclaimer, read, readAt: new Date(at).toISOString(), stale, from, integration: this.client.cfg.integration, words: HEY_WORDS,
    };
  }
}

/** A builder record in words, for a person or an assistant: HEY's facts as HEY's, with the link to the source. */
export function recordText(r: HeyLookup): string {
  if (!r.found) {
    const lines = [`Not on HEY: ${r.why}.`];
    for (const c of r.candidates ?? []) lines.push(`- ${c.name}${c.symbol ? ` ($${c.symbol})` : ""}${c.status ? `: ${c.status}` : ""}. ${c.sourceUrl}`);
    if (!r.away) lines.push(`HEY's search: ${r.sourceUrl}`);
    return lines.join("\n");
  }
  const f = r.facts;
  const lines = [`${r.project.name}${r.project.symbol ? ` ($${r.project.symbol})` : ""}: its builder record on HEY Research Lab, the public record of building on Robinhood Chain.`];
  if (f.verified_builder) lines.push("HEY marks it a Verified Builder: this team ships.");
  if (f.hey_status_label || f.hey_status) lines.push(`HEY's status: ${f.hey_status_label ?? f.hey_status}${f.hey_status_help ? ` (${f.hey_status_help.replace(/\.$/, "")})` : ""}.`);
  if (f.meaningful_ships_30d !== null) lines.push(`Meaningful ships HEY counted in 30 days: ${f.meaningful_ships_30d}.`);
  if (f.latest_meaningful_ship?.title) lines.push(`Latest ship HEY recorded: ${f.latest_meaningful_ship.title}${f.latest_meaningful_ship.timestamp ? `, ${f.latest_meaningful_ship.timestamp.slice(0, 10)}` : ""}${f.latest_meaningful_ship.evidence_link ? ` (evidence: ${f.latest_meaningful_ship.evidence_link})` : ""}.`);
  if (f.repo_url) lines.push(`Its code, as HEY has it: ${f.repo_url}`);
  lines.push(`Source: ${r.sourceUrl} (read ${r.readAt.slice(0, 16).replace("T", " ")} UTC${r.stale ? ", an earlier reading: HEY could not be reached just now" : ""}).`);
  if (r.disclaimer) lines.push(`HEY: "${r.disclaimer}"`);
  lines.push("This is HEY's record of what the team shipped, not a rating, and it never changes the Factor Score.");
  return lines.join("\n");
}

// ---------- an agent's link to its maker's project ----------

/** The words an agent's owner signs to link it to a project on HEY, or to unlink it ("none"). The same in the kit and on the site. */
export const heyLinkMessage = (o: { agent: string; project: string; at: number }): string =>
  ["Factor: link an agent to its maker's project on HEY", `agent: ${o.agent}`, `project: ${o.project}`, `at: ${o.at}`].join("\n");

export interface HeyLinkRow { agent: string; slug: string | null; name: string | null; contract: string | null; given: string; by: string; signed_at: number; signature: string; at: number }

const SCHEMA = `
-- HEY builder records (./hey.ts): the HEY project an agent's owner linked it to. slug NULL: the owner unlinked it.
CREATE TABLE IF NOT EXISTS hey_links (
  agent TEXT PRIMARY KEY,
  slug TEXT,                 -- the project on HEY, as HEY names it
  name TEXT,                 -- its name on HEY when it was linked
  contract TEXT,             -- the contract it was named by, when it was named by one
  given TEXT NOT NULL,       -- what the owner signed: the slug, the contract, or none
  by TEXT NOT NULL,          -- the wallet that signed
  signed_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  at INTEGER NOT NULL        -- when Factor took it, seconds
);
`;

type Answer = { status: number; body: Record<string, unknown> };
const no = (status: number, error: string): Answer => ({ status, body: { error } });
const WINDOW_S = 600;

export interface HeyDeps {
  cfg: HeyConfig;
  db: EngineDb;
  /** wall clock, ms */
  now: () => number;
  /** whether `address` signed `message`: a wallet, or an account through one of its keys (./profiles.ts) */
  signed: (address: string, message: string, signature: unknown) => Promise<boolean>;
  /** the wallets that sign for an agent besides itself: its maker, or Factor's admin for Factor's own */
  setters: (agent: string) => string[];
  /** HEY's free key, read when a call is made */
  key?: () => string | undefined;
  fetch?: HeyFetch;
  log: (line: string) => void;
}

export class Hey {
  readonly client: HeyClient;
  readonly records: HeyRecords;

  constructor(private d: HeyDeps) {
    d.db.db.exec(SCHEMA);
    this.client = new HeyClient(d.cfg, { fetch: d.fetch, now: d.now, key: d.key, allowed: () => this.on() });
    this.records = new HeyRecords(this.client);
  }

  get cfg(): HeyConfig {
    return this.d.cfg;
  }

  /** On and not stopped by the owner: anything shows, and HEY is asked anything, only then. */
  on(): boolean {
    return this.d.cfg.enabled && !stopped(this.d.db, "hey");
  }

  about(): Record<string, unknown> {
    return {
      enabled: this.on(), source: "HEY Research Lab", site: HEY_SITE, project: `${HEY_SITE}/project/factor`, badge: `${HEY_SITE}/api/badge/factor`,
      integration: this.d.cfg.integration, keptS: Math.round(this.d.cfg.freshMs / 1000), words: HEY_WORDS,
    };
  }

  /** A project's builder record, by what a person typed. */
  lookup(q: unknown): Promise<HeyLookup> {
    if (!this.on()) return Promise.resolve({ found: false, why: "HEY builder records are switched off on Factor", source: "HEY Research Lab", sourceUrl: HEY_SITE });
    return this.records.lookup(q);
  }

  /** The wallets that may link an agent: the agent itself, and whoever runs it on Factor. */
  ownersOf(agent: string): string[] {
    return [...new Set([agent, ...this.d.setters(agent)])];
  }

  link(agent: string): HeyLinkRow | null {
    return (this.d.db.q("SELECT * FROM hey_links WHERE agent = ?").get(agent) as HeyLinkRow | undefined) ?? null;
  }

  /** An agent's link, its builder record, and who may change it: for its page. The record is read from HEY (kept a while). */
  async agentJson(agent: string): Promise<Record<string, unknown>> {
    const row = this.link(agent);
    const linked = row?.slug ? { slug: row.slug, name: row.name, contract: row.contract, sourceUrl: pageOf(row.slug), by: row.by, at: new Date(row.at * 1000).toISOString() } : null;
    const record = linked ? await this.records.record(linked.slug).catch((e: unknown) => ({ found: false as const, why: e instanceof HeyAway ? e.message : "HEY could not be reached", away: true, source: "HEY Research Lab" as const, sourceUrl: linked.sourceUrl })) : null;
    return { enabled: true, agent, link: linked, record, owners: this.ownersOf(agent) };
  }

  /** The owner signs which project on HEY is its maker's (by slug or contract), or "none"; Factor checks HEY has it. */
  async setLink(body: Record<string, unknown>): Promise<Answer> {
    if (!this.on()) return no(503, "HEY builder records are switched off on Factor for now");
    const agent = normalizeAddress(body.agent);
    if (!agent) return no(400, "agent is not an address");
    const by = normalizeAddress(body.by);
    if (!by) return no(400, "by is not an address: the wallet that runs the agent");
    const given = typeof body.project === "string" ? body.project.trim() : "";
    const contract = normalizeAddress(given);
    const slug = !contract && given !== "none" && SLUG.test(given) ? given : null;
    if (given !== "none" && !contract && !slug) return no(400, 'project is the project\'s slug on HEY (like "factor"), a 0x contract on Robinhood Chain, or "none"');
    const at = typeof body.at === "number" && Number.isSafeInteger(body.at) ? body.at : null;
    const t = Math.floor(this.d.now() / 1000);
    if (at === null || Math.abs(t - at) > WINDOW_S) return no(400, "the signature's time is more than ten minutes from now: sign again");
    if (!this.d.db.q("SELECT 1 FROM desk_agents WHERE address = ?").get(agent)) return no(404, "this agent has not registered on the desk");
    if (!this.ownersOf(agent).includes(by)) return no(403, "that wallet does not run this agent on Factor: its owner is the agent's own wallet, or whoever made it here");
    let ok = false;
    try {
      ok = await this.d.signed(by, heyLinkMessage({ agent, project: contract ?? slug ?? "none", at }), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, "the signature is not that wallet's");
    const had = this.link(agent);
    if (had && at <= had.signed_at) return no(409, "that signature was used already: sign again");
    let row: HeyLinkRow;
    if (given === "none") row = { agent, slug: null, name: null, contract: null, given: "none", by, signed_at: at, signature: String(body.signature), at: t };
    else {
      const r = await this.records.lookup(contract ?? `${HEY_SITE}/project/${slug}`);
      if (!r.found) return no(r.away ? 503 : 404, r.away ? `${r.why}. Nothing was changed` : `${r.why}: only a project HEY has published can be linked`);
      row = { agent, slug: r.project.slug, name: r.project.name, contract: contract ?? null, given: contract ?? slug!, by, signed_at: at, signature: String(body.signature), at: t };
    }
    this.d.db.q("INSERT INTO hey_links (agent, slug, name, contract, given, by, signed_at, signature, at) VALUES (@agent, @slug, @name, @contract, @given, @by, @signed_at, @signature, @at) ON CONFLICT(agent) DO UPDATE SET slug = excluded.slug, name = excluded.name, contract = excluded.contract, given = excluded.given, by = excluded.by, signed_at = excluded.signed_at, signature = excluded.signature, at = excluded.at").run(row);
    this.d.log(`[hey] ${agent}: ${row.slug ? `linked to ${row.slug} on HEY` : "unlinked from HEY"} by ${by}`);
    return { status: 200, body: { ok: true, agent, link: row.slug ? { slug: row.slug, name: row.name, contract: row.contract, sourceUrl: pageOf(row.slug), by, at: new Date(t * 1000).toISOString() } : null } };
  }

  /** The agents linked to a project, for a count on the owner's health answer. */
  linked(): number {
    return (this.d.db.q("SELECT COUNT(*) AS n FROM hey_links WHERE slug IS NOT NULL").get() as { n: number }).n;
  }

  health(): Record<string, unknown> {
    const c = this.client;
    return { on: this.on(), integration: this.d.cfg.integration, base: this.d.cfg.base, keyed: !!this.d.key?.()?.trim(), ...c.counts, lastOkAt: c.lastOkAt ? new Date(c.lastOkAt).toISOString() : null, lastError: c.lastError ? { at: new Date(c.lastError.at).toISOString(), message: c.lastError.message } : null, linked: this.linked() };
  }
}
