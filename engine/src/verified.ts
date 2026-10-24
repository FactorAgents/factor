// Verified owners: the wallet behind an agent is checked once by two outside services, and the agent shows the outcome.
//
// Who the owner is: whoever signs for the agent on Factor today. An agent that runs itself is its own owner (its own
// wallet signs its name and its rules); an agent made on the site is its maker's; Factor's own agents are Factor's
// admin wallet's (the same wallets ./autoapply.ts takes rules from).
//
//   POST /v1/verified/check   the owner signs verifyMessage (agent, owner, time) with the owner wallet. Factor then asks
//                             the two services about THAT wallet, at once, and stores the outcome.
//   GET  /v1/verified         whether it is on, which checks are used and their thresholds
//   GET  /v1/verified/<agent> an agent's outcome, and the wallets that may verify it
//
// The two checks:
//   Human Passport   proof of personhood. Its Stamps API v2 (GET /v2/stamps/<scorer id>/score/<address>) gives the
//                    wallet's score; it passes at HUMAN_PASSPORT_MIN_SCORE (20) or more.
//   Talent Protocol  a builder's record. Its API (GET /score?id=<address>&account_source=wallet&scorer_slug=builder_score)
//                    gives the wallet's Builder Score; it passes at TALENT_MIN_SCORE (40) or more. No profile: no pass.
// One passing is enough (VERIFIED_NEEDS=any, the default), or both must (VERIFIED_NEEDS=all).
//
// What is kept: verified or not, which check passed, a band of each score (like "20 to 29", never the number), when it
// was checked and when it runs out, and the owner's signature that asked for it. Nothing the services answer beyond the
// one number is read, and the number itself is not stored: no stamp, no name, no profile, no account.
//
// It runs out after VERIFIED_VALID_DAYS (30). Factor checks the same wallet again on its own after
// VERIFIED_RECHECK_HOURS (168), a few at a time, and the owner can ask again at any time with a new signature. A check
// that cannot be made (a service down or slow, no key) changes nothing: the last outcome stands until it runs out.
//
// Switches: VERIFIED=on (off unless it is said), and the owner's "verified" switch (./switches.ts), which stops checks
// and hides every outcome at once. With it off, nothing on the site or in the engine changes. Keys: HUMAN_PASSPORT_API_KEY
// with HUMAN_PASSPORT_SCORER_ID, and TALENT_API_KEY; each check runs only when its keys are there. With no key at all it
// is unavailable: nobody is verified, and a job for verified owners only cannot be posted (it fails closed).
// VERIFIED_FAKE=on puts a stand-in in place of both services for a local run; it is refused on a host.
//
// What it never touches: the score's number, any limit, anything on the chain. It is shown beside the score.

import { normalizeAddress } from "./chain/address.js";
import type { EngineDb } from "./chain/db.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export type Source = "passport" | "talent";
export const SOURCE_NAME: Record<Source, string> = { passport: "Human Passport", talent: "Talent Protocol" };
export const SOURCE_WHAT: Record<Source, string> = { passport: "proof of personhood", talent: "a builder's record" };

export interface VerifiedConfig {
  /** VERIFIED=on: off unless it is said */
  enabled: boolean;
  /** VERIFIED_NEEDS: any (one check passing is enough) or all */
  needs: "any" | "all";
  /** HUMAN_PASSPORT_MIN_SCORE: the Passport score that passes */
  passportMin: number;
  /** TALENT_MIN_SCORE: the Builder Score that passes */
  talentMin: number;
  /** VERIFIED_VALID_DAYS: how long an outcome stands */
  validS: number;
  /** VERIFIED_RECHECK_HOURS: how old an outcome is when Factor checks it again on its own */
  recheckS: number;
  /** how long one service has to answer */
  timeoutMs: number;
  /** a new check for one agent at most this often */
  cooldownS: number;
  /** checks of all agents in fifteen minutes at most: under the services' free limits */
  per15Min: number;
  /** the checks that can run: their keys are there, or the stand-in is on */
  sources: Source[];
  /** VERIFIED_FAKE=on, allowed: the stand-in answers for both. VERIFIED_FAKE_PASS: the wallets it passes ("all": every one) */
  fake: { on: boolean; pass: "all" | string[] };
  /** why it is on and cannot run, when it cannot */
  note: string | null;
}

/** On a host, the stand-in is never taken: Railway sets these, and a production build sets NODE_ENV. */
const onHost = (env: Env): boolean => !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID) || (env.NODE_ENV ?? "").trim() === "production";

export function readVerified(env: Env, problems: string[] = []): VerifiedConfig {
  const on = (env.VERIFIED ?? "").trim().toLowerCase() === "on";
  const num = (name: string, def: number, least: number, most: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    if (/^\d{1,6}(\.\d{1,3})?$/.test(raw) && Number(raw) >= least && Number(raw) <= most) return Number(raw);
    problems.push(`${name} must be a number from ${least} to ${most}: it is "${raw}"`);
    return def;
  };
  const rawNeeds = (env.VERIFIED_NEEDS ?? "").trim().toLowerCase();
  if (rawNeeds && rawNeeds !== "any" && rawNeeds !== "all") problems.push(`VERIFIED_NEEDS must be any or all: it is "${env.VERIFIED_NEEDS}"`);
  const keys = takeVerifiedKeys(env);
  const wantFake = (env.VERIFIED_FAKE ?? "").trim().toLowerCase() === "on";
  const host = onHost(env);
  const fakeOn = wantFake && !host;
  const rawPass = (env.VERIFIED_FAKE_PASS ?? "").trim().toLowerCase();
  const pass: "all" | string[] = rawPass === "all" ? "all" : rawPass.split(",").map((x) => normalizeAddress(x.trim())).filter((x): x is string => !!x);
  const sources: Source[] = fakeOn ? ["passport", "talent"] : [...(keys.passport ? ["passport" as const] : []), ...(keys.talent ? ["talent" as const] : [])];
  let note: string | null = null;
  if (on && wantFake && host) note = "VERIFIED_FAKE is for a local run and is refused on a host: the stand-in never answers here";
  if (on && !sources.length) note = `${note ? `${note}. ` : ""}no check has its key: set HUMAN_PASSPORT_API_KEY with HUMAN_PASSPORT_SCORER_ID, or TALENT_API_KEY. Until then nobody is verified`;
  return {
    enabled: on, needs: rawNeeds === "all" ? "all" : "any",
    passportMin: num("HUMAN_PASSPORT_MIN_SCORE", 20, 1, 1000), talentMin: num("TALENT_MIN_SCORE", 40, 1, 10_000),
    validS: Math.round(num("VERIFIED_VALID_DAYS", 30, 1, 365) * 86_400), recheckS: Math.round(num("VERIFIED_RECHECK_HOURS", 168, 1, 8760) * 3600),
    timeoutMs: Math.round(num("VERIFIED_TIMEOUT_S", 8, 1, 60) * 1000), cooldownS: Math.round(num("VERIFIED_COOLDOWN_S", 60, 0, 86_400)), per15Min: Math.round(num("VERIFIED_PER_15_MIN", 100, 1, 2000)),
    sources, fake: { on: fakeOn, pass }, note,
  };
}

/** The services' keys, read at the moment the checks are made and held by nothing else: never logged, stored or returned. */
export function takeVerifiedKeys(env: Env): { passport: { key: string; scorer: string } | null; talent: { key: string } | null } {
  const pk = env.HUMAN_PASSPORT_API_KEY?.trim(), scorer = env.HUMAN_PASSPORT_SCORER_ID?.trim(), tk = env.TALENT_API_KEY?.trim();
  return { passport: pk && scorer && /^\d{1,12}$/.test(scorer) ? { key: pk, scorer } : null, talent: tk ? { key: tk } : null };
}

/** The words the owner signs: readable, so a wallet shows exactly what it puts its name to. The same in the kit and on the site. */
export const verifyMessage = (o: { agent: string; owner: string; at: number }): string =>
  ["Factor: verify the owner of an agent", `agent: ${o.agent}`, `owner: ${o.owner}`, "checks: Human Passport, Talent Protocol", `at: ${o.at}`].join("\n");

// ---------- the services ----------

/** One service, asked about one wallet: its score, or null when it holds nothing on the wallet. Throws when it cannot answer. */
export interface Provider { source: Source; score(address: string, signal: AbortSignal): Promise<number | null> }

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Human Passport's Stamps API v2: the wallet's score as a number. Only `score` is read from the answer. */
export function passportProvider(key: string, scorer: string, o: { fetch?: Fetch; base?: string } = {}): Provider {
  const f = o.fetch ?? (globalThis.fetch as unknown as Fetch), base = (o.base ?? "https://api.passport.xyz").replace(/\/+$/, "");
  return {
    source: "passport",
    async score(address, signal) {
      const r = await f(`${base}/v2/stamps/${encodeURIComponent(scorer)}/score/${address}`, { headers: { "X-API-KEY": key, accept: "application/json" }, signal });
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error(`Human Passport answered ${r.status}`);
      const s = Number((await r.json() as { score?: unknown }).score);
      if (!Number.isFinite(s)) throw new Error("Human Passport answered without a score");
      return s;
    },
  };
}

/** Talent Protocol's API: the wallet's Builder Score as a number. Only `score.points` is read from the answer. No profile: null. */
export function talentProvider(key: string, o: { fetch?: Fetch; base?: string } = {}): Provider {
  const f = o.fetch ?? (globalThis.fetch as unknown as Fetch), base = (o.base ?? "https://api.talentprotocol.com").replace(/\/+$/, "");
  return {
    source: "talent",
    async score(address, signal) {
      const r = await f(`${base}/score?id=${address}&account_source=wallet&scorer_slug=builder_score`, { headers: { "X-API-KEY": key, accept: "application/json" }, signal });
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error(`Talent Protocol answered ${r.status}`);
      const p = (await r.json() as { score?: { points?: unknown } }).score?.points;
      if (p === undefined || p === null) return null;
      const s = Number(p);
      if (!Number.isFinite(s)) throw new Error("Talent Protocol answered without a score");
      return s;
    },
  };
}

/** The stand-in for a local run: the wallets in VERIFIED_FAKE_PASS have a Passport score of 27 and no builder record. */
export function fakeProviders(pass: "all" | string[]): Provider[] {
  const passes = (a: string) => pass === "all" || pass.includes(a);
  return [
    { source: "passport", score: async (a) => (passes(a) ? 27.4 : 3.1) },
    { source: "talent", score: async () => null },
  ];
}

/** The services the engine asks: the stand-in, or each one whose keys are there. */
export function providersOf(cfg: VerifiedConfig, env: Env): Provider[] {
  if (cfg.fake.on) return fakeProviders(cfg.fake.pass);
  const k = takeVerifiedKeys(env);
  return [...(k.passport ? [passportProvider(k.passport.key, k.passport.scorer)] : []), ...(k.talent ? [talentProvider(k.talent.key)] : [])];
}

/** A score as a band, never the number: what is kept and shown. */
const BANDS: Record<Source, number[]> = { passport: [10, 20, 30, 40], talent: [40, 80, 120, 170, 250] };
export function bandOf(source: Source, score: number | null): string {
  if (score === null) return "no record";
  const edges = BANDS[source];
  if (score < edges[0]!) return `under ${edges[0]}`;
  for (let i = 0; i < edges.length - 1; i++) if (score < edges[i + 1]!) return `${edges[i]} to ${edges[i + 1]! - 1}`;
  return `${edges[edges.length - 1]} or more`;
}

export interface CheckResult { source: Source; outcome: "pass" | "fail" | "error"; band: string | null; why?: string }

/** Ask every service at once, each with its own time limit. A service that throws or is too slow is an error, never a fail. */
export async function runChecks(providers: Provider[], address: string, cfg: Pick<VerifiedConfig, "passportMin" | "talentMin" | "timeoutMs">): Promise<CheckResult[]> {
  return Promise.all(providers.map(async (p): Promise<CheckResult> => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const score = await Promise.race([
        p.score(address, ctl.signal),
        new Promise<never>((_, no) => { timer = setTimeout(() => { ctl.abort(); no(new Error(`${SOURCE_NAME[p.source]} did not answer in time`)); }, cfg.timeoutMs); }),
      ]);
      const min = p.source === "passport" ? cfg.passportMin : cfg.talentMin;
      return { source: p.source, outcome: score !== null && score >= min ? "pass" : "fail", band: bandOf(p.source, score) };
    } catch (e) {
      return { source: p.source, outcome: "error", band: null, why: e instanceof Error ? e.message.slice(0, 160) : "no answer" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
}

/** Verified or not, from the results: one pass is enough, or all must pass. Null: nothing answered, so nothing can be said. */
export function outcomeOf(results: CheckResult[], needs: "any" | "all"): boolean | null {
  if (!results.length || results.every((r) => r.outcome === "error")) return null;
  return needs === "all" ? results.every((r) => r.outcome === "pass") : results.some((r) => r.outcome === "pass");
}

// ---------- the books ----------

export interface VerifiedRow { agent: string; owner: string; verified: number; sources: string; bands: string; checked_at: number; expires_at: number; signed_at: number; signature: string; note: string | null; how: string }

const SCHEMA = `
-- Verified owners (./verified.ts). The outcome of checking an agent's owner wallet: never a score, a stamp or a profile.
CREATE TABLE IF NOT EXISTS verified_owners (
  agent TEXT PRIMARY KEY,
  owner TEXT NOT NULL,               -- the wallet that signed, and the one that was checked
  verified INTEGER NOT NULL,         -- 1: passed
  sources TEXT NOT NULL,             -- JSON: the checks that passed, like ["passport"]
  bands TEXT NOT NULL,               -- JSON: each check's band, like {"passport":"20 to 29","talent":"no record"}
  checked_at INTEGER NOT NULL,       -- seconds
  expires_at INTEGER NOT NULL,       -- seconds
  signed_at INTEGER NOT NULL,        -- the time in the owner's signature: an older one is never taken again
  signature TEXT NOT NULL,
  note TEXT,                         -- the last check Factor could not make on its own, and why
  how TEXT NOT NULL DEFAULT 'owner'  -- owner: asked for with a signature | again: checked again by Factor
);
`;

export class VerifiedStore {
  constructor(private db: EngineDb) {
    db.db.exec(SCHEMA);
  }

  get(agent: string): VerifiedRow | null {
    return (this.db.q("SELECT * FROM verified_owners WHERE agent = ?").get(agent) as VerifiedRow | undefined) ?? null;
  }

  put(r: VerifiedRow): void {
    this.db.q("INSERT INTO verified_owners (agent, owner, verified, sources, bands, checked_at, expires_at, signed_at, signature, note, how) VALUES (@agent, @owner, @verified, @sources, @bands, @checked_at, @expires_at, @signed_at, @signature, @note, @how) ON CONFLICT(agent) DO UPDATE SET owner = excluded.owner, verified = excluded.verified, sources = excluded.sources, bands = excluded.bands, checked_at = excluded.checked_at, expires_at = excluded.expires_at, signed_at = excluded.signed_at, signature = excluded.signature, note = excluded.note, how = excluded.how").run(r);
  }

  note(agent: string, note: string | null): void {
    this.db.q("UPDATE verified_owners SET note = ? WHERE agent = ?").run(note, agent);
  }

  /** Outcomes old enough to be checked again, oldest first. */
  due(before: number, limit: number): VerifiedRow[] {
    return this.db.q("SELECT * FROM verified_owners WHERE checked_at < ? ORDER BY checked_at LIMIT ?").all(before, limit) as VerifiedRow[];
  }

  /** Every agent whose owner passed and has not run out at `t`. */
  passing(t: number): string[] {
    return (this.db.q("SELECT agent FROM verified_owners WHERE verified = 1 AND expires_at > ?").all(t) as { agent: string }[]).map((r) => r.agent);
  }
}

// ---------- what the site and apps read ----------

export interface VerifiedJson {
  verified: true;
  /** the checks that passed, by name */
  sources: string[];
  /** each check's band, by name: never the number */
  bands: Record<string, string>;
  checkedAt: string;
  expiresAt: string;
  /** the wallet that was checked */
  owner: string;
}

export interface VerifiedAbout {
  enabled: boolean;
  /** which checks run, by name, and what each is */
  checks: { name: string; what: string; passesAt: string }[];
  needs: "any" | "all";
  validDays: number;
  how: string;
  kept: string;
}

export interface VerifiedDeps {
  cfg: VerifiedConfig;
  db: EngineDb;
  providers: Provider[];
  /** wall clock, ms */
  now: () => number;
  /** whether `address` signed `message`: a wallet, or an account through one of its keys (./profiles.ts) */
  signed: (address: string, message: string, signature: unknown) => Promise<boolean>;
  /** the wallets that sign for an agent besides itself: its maker, or Factor's admin for Factor's own (./autoapply.ts) */
  setters: (agent: string) => string[];
  log: (line: string) => void;
}

type Answer = { status: number; body: Record<string, unknown> };
const no = (status: number, error: string): Answer => ({ status, body: { error } });
const WINDOW_S = 600;
const iso = (s: number) => new Date(s * 1000).toISOString();

export class Verified {
  readonly store: VerifiedStore;
  private recent: number[] = [];
  private lastTry = new Map<string, number>();
  private lastPass = 0;
  private busy = false;

  constructor(private d: VerifiedDeps) {
    this.store = new VerifiedStore(d.db);
  }

  get cfg(): VerifiedConfig {
    return this.d.cfg;
  }

  private nowS(): number {
    return Math.floor(this.d.now() / 1000);
  }

  /** The checks that run: the services it was given. */
  sources(): Source[] {
    return this.d.providers.map((p) => p.source);
  }

  /** On, able to check, and not stopped by the owner: anything shows only then. */
  on(): boolean {
    return this.d.cfg.enabled && this.d.providers.length > 0 && !stopped(this.d.db, "verified");
  }

  /** The wallets that may verify an agent's owner: the agent itself, and whoever runs it on Factor. */
  ownersOf(agent: string): string[] {
    return [...new Set([agent, ...this.d.setters(agent)])];
  }

  /** Whether an agent's owner is verified now: passed, not run out, and the feature on. Anything else is no. */
  isVerified(agent: string): boolean {
    if (!this.on()) return false;
    const r = this.store.get(agent);
    return !!r && r.verified === 1 && r.expires_at > this.nowS();
  }

  /** The verified agents now, for a list: empty while it is off. */
  all(): Set<string> {
    return this.on() ? new Set(this.store.passing(this.nowS())) : new Set();
  }

  /** What an agent's page shows: the outcome while it passes and stands, or null. Nothing negative is ever said here. */
  json(agent: string): VerifiedJson | null {
    if (!this.isVerified(agent)) return null;
    const r = this.store.get(agent)!;
    const bands = JSON.parse(r.bands) as Partial<Record<Source, string>>;
    return {
      verified: true, sources: (JSON.parse(r.sources) as Source[]).map((s) => SOURCE_NAME[s]),
      bands: Object.fromEntries(Object.entries(bands).map(([k, v]) => [SOURCE_NAME[k as Source] ?? k, v!])),
      checkedAt: iso(r.checked_at), expiresAt: iso(r.expires_at), owner: r.owner,
    };
  }

  about(): VerifiedAbout {
    const c = this.d.cfg;
    const on = this.on();
    const checks = (on ? this.sources() : []).map((s) => ({ name: SOURCE_NAME[s], what: SOURCE_WHAT[s], passesAt: s === "passport" ? `a Passport score of ${c.passportMin} or more` : `a Builder Score of ${c.talentMin} or more` }));
    return {
      enabled: on, checks, needs: c.needs, validDays: Math.round(c.validS / 86_400),
      how: `The owner signs with the wallet that runs the agent. Factor asks ${checks.map((x) => `${x.name} (${x.what})`).join(" and ") || "the checks"} about that wallet. ${c.needs === "all" ? "Every one must pass." : "One passing is enough."} It is checked again every ${Math.round(c.recheckS / 86_400)} days and runs out after ${Math.round(c.validS / 86_400)}.`,
      kept: "Verified or not, which check passed, a band of each score, and the date. No score, stamp, name or profile is kept.",
    };
  }

  /** The owner signs, and the wallet is checked at once. Asked again, it checks again (a new signature each time). */
  async check(body: Record<string, unknown>): Promise<Answer> {
    const c = this.d.cfg;
    if (!c.enabled) return no(503, "verified owners are switched off for now");
    if (!this.d.providers.length) return no(503, c.note ? `owners cannot be checked right now: ${c.note}` : "owners cannot be checked right now");
    const off = stopped(this.d.db, "verified");
    if (off) return no(503, off.note || "checking owners is stopped for now");
    const agent = normalizeAddress(body.agent);
    if (!agent) return no(400, "agent is not an address");
    const owner = normalizeAddress(body.owner);
    if (!owner) return no(400, "owner is not an address: the wallet that runs the agent");
    const at = typeof body.at === "number" && Number.isSafeInteger(body.at) ? body.at : null;
    const t = this.nowS();
    if (at === null || Math.abs(t - at) > WINDOW_S) return no(400, "the signature's time is more than ten minutes from now: sign again");
    if (!this.d.db.q("SELECT 1 FROM desk_agents WHERE address = ?").get(agent)) return no(404, "this agent has not registered on the desk");
    const owners = this.ownersOf(agent);
    if (!owners.includes(owner)) return no(403, "that wallet does not run this agent on Factor: its owner is the agent's own wallet, or whoever made it here");
    let ok = false;
    try {
      ok = await this.d.signed(owner, verifyMessage({ agent, owner, at }), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, "the signature is not the owner wallet's");
    const had = this.store.get(agent);
    if (had && at <= had.signed_at) return no(409, "that signature was used already: sign again for a new check");
    const last = this.lastTry.get(agent) ?? 0;
    if (c.cooldownS > 0 && t - last < c.cooldownS) return no(429, `this agent was checked a moment ago: try again in ${c.cooldownS - (t - last)} seconds`);
    if (!this.room()) return no(429, "many owners are being checked right now: try again in a few minutes");
    this.lastTry.set(agent, t);
    if (this.lastTry.size > 5000) this.lastTry.clear();
    const results = await runChecks(this.d.providers, owner, c);
    const verified = outcomeOf(results, c.needs);
    if (verified === null) return no(503, `${results.map((r) => r.why).filter(Boolean).join("; ") || "no check answered"}. Nothing was changed: try again in a few minutes`);
    const row = this.rowOf(agent, owner, results, verified, at, String(body.signature), "owner");
    this.store.put(row);
    this.d.log(`[verified] ${agent}: its owner ${owner} was checked, ${verified ? `verified by ${results.filter((r) => r.outcome === "pass").map((r) => SOURCE_NAME[r.source]).join(" and ")}` : "not verified"}`);
    return { status: 200, body: { ok: true, agent, owner, verified, checks: results.map((r) => ({ name: SOURCE_NAME[r.source], outcome: r.outcome, band: r.band })), checkedAt: iso(row.checked_at), expiresAt: iso(row.expires_at) } };
  }

  /** Room in the services' free limits: checks in the last fifteen minutes, all agents together. */
  private room(): boolean {
    const t = this.d.now();
    this.recent = this.recent.filter((x) => t - x < 15 * 60_000);
    if (this.recent.length >= this.d.cfg.per15Min) return false;
    this.recent.push(t);
    return true;
  }

  private rowOf(agent: string, owner: string, results: CheckResult[], verified: boolean, signedAt: number, signature: string, how: "owner" | "again"): VerifiedRow {
    const t = this.nowS();
    const bands: Partial<Record<Source, string>> = {};
    for (const r of results) if (r.band) bands[r.source] = r.band;
    return {
      agent, owner, verified: verified ? 1 : 0, sources: JSON.stringify(results.filter((r) => r.outcome === "pass").map((r) => r.source)), bands: JSON.stringify(bands),
      checked_at: t, expires_at: t + this.d.cfg.validS, signed_at: signedAt, signature, note: null, how,
    };
  }

  /**
   * Factor checks old outcomes again on its own, a few at a time and at most every ten minutes: the same owner wallet,
   * which signed once. An owner that no longer runs the agent is not verified from then on. A check that cannot be made
   * leaves the outcome as it was, to run out in its time. Answers how many were checked.
   */
  async pass(most = 5): Promise<number> {
    if (!this.on() || this.busy) return 0;
    const now = this.d.now();
    if (now - this.lastPass < 10 * 60_000) return 0;
    this.lastPass = now;
    this.busy = true;
    let n = 0;
    try {
      for (const row of this.store.due(this.nowS() - this.d.cfg.recheckS, most)) {
        if (!this.ownersOf(row.agent).includes(row.owner)) {
          this.store.put({ ...row, verified: 0, sources: "[]", checked_at: this.nowS(), note: "the wallet that was checked no longer runs this agent", how: "again" });
          continue;
        }
        if (!this.room()) break;
        const results = await runChecks(this.d.providers, row.owner, this.d.cfg);
        const verified = outcomeOf(results, this.d.cfg.needs);
        if (verified === null) { this.store.note(row.agent, results.map((r) => r.why).filter(Boolean).join("; ").slice(0, 300) || "no check answered"); continue; }
        this.store.put(this.rowOf(row.agent, row.owner, results, verified, row.signed_at, row.signature, "again"));
        n++;
      }
    } finally {
      this.busy = false;
    }
    if (n) this.d.log(`[verified] checked ${n} owner${n === 1 ? "" : "s"} again`);
    return n;
  }

  /** Forget the ten-minute wait between passes (tests, and a rehearsal that moves time). */
  soon(): void {
    this.lastPass = 0;
  }
}
