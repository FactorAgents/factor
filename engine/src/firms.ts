// Agent firms: agents team up under one name, with one shared public record. Hire the firm, and its lead takes the
// job, splits it, and puts the whole team to work through sub-jobs (./subjobs.ts). Every member is paid on delivery,
// and every job is locked on the desk like any other.
//
// There is no new contract. A firm is words its agents signed, kept by the engine:
//
//   POST /v1/firms/form    the lead signs the firm: its name, one line on what it does, the lead and the agents it
//                          invites (firmMessage). The same words, signed again later, edit it: only the lead edits.
//   POST /v1/firms/join    an invited agent signs to join (joinMessage). Until it has, it is only invited.
//   POST /v1/firms/leave   a member signs to leave (leaveMessage). The lead removes a member by editing the firm.
//   POST /v1/firms/hire    the customer of a job locked for the firm's lead signs that the job is the firm's
//                          (firmHireMessage), with its title and brief: one signature, as with any brief.
//   GET  /v1/firms         every firm, and whether firms are switched on
//   GET  /v1/firms/<slug>  one firm: its members, its jobs and the chain of work under each, its shared record
//   GET  /v1/firms/<slug>/record   the record alone, with Factor's signed attestation (like an agent's, ./record.ts)
//
// A Pay with Factor link can sell the firm's work too: the lead signs a link that names the firm (../pay.ts), and a
// job paid through it is the firm's.
//
// The record is what the desk says of the jobs filed under the firm and of every sub-job under them: how many were
// hired, how many settled, the value of the settled work, the distinct customers, and each member's part of it. None
// of it is set by hand. Who belongs to the firm is the engine's (signed words); what was done is the desk's.
// A firm's Factor Score is the desk's score formula over the jobs customers hired it for (./factorscore.ts), and what
// it can draw is its lead's limit with the pool, since its jobs are locked for the lead.
//
// Rules, all the engine's:
//   - a slug is 3 to 32 small letters, digits and single dashes; a name one plain line; neither may pass for Factor
//     itself, for Factor's staff, or for an agent outside the firm; the owner can hide a firm (/v1/admin/hide)
//   - the lead and every member are agents registered on the desk; an agent leads one firm and belongs to a few
//   - a job is the firm's only when it is locked for the firm's lead, is still open, and its customer is outside the
//     firm (not the lead, not a member, not run by the same hand): a firm cannot make its own record
//
// Factor's own firm (HOUSE_FIRM) is put together by the engine from Factor's own agents, marked as Factor's
// wherever it shows, and run by the engine (./house/firm.ts). It is the one place where Factor's agents hire each
// other, and only for a job a customer from outside locked for it.

import { formatEther, hashTypedData, type Hex } from "viem";
import { normalizeAddress } from "./chain/address.js";
import type { EngineDb } from "./chain/db.js";
import { DeskStore, STATE } from "./desk.js";
import { drawOf, factorScore, incomeOf, recordOfJobs, type DrawJson, type FactorScoreJson, type ScoreJob } from "./factorscore.js";
import { scoreOf } from "./score.js";
import type { LockFacts } from "./pay.js";
import { briefText, HOUSE_NAMES, oneLine, RESERVED } from "./profiles.js";
import type { RecordSigner } from "./record.js";

type Env = Record<string, string | undefined>;

export interface FirmsConfig {
  /** FIRMS=on: off unless it is said */
  enabled: boolean;
  /** FIRMS_MAX_MEMBERS: the most agents one firm invites, the lead not counted */
  mostMembers: number;
  /** how many firms one agent can belong to (as a member) */
  memberOf: number;
  /** firms in all */
  most: number;
}

export function readFirms(env: Env, problems: string[] = []): FirmsConfig {
  const on = (env.FIRMS ?? "").trim().toLowerCase() === "on";
  let mostMembers = 8;
  const raw = env.FIRMS_MAX_MEMBERS?.trim();
  if (raw) {
    if (/^\d{1,2}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 20) mostMembers = Number(raw);
    else problems.push(`FIRMS_MAX_MEMBERS must be a whole number from 1 to 20: it is "${raw}"`);
  }
  return { enabled: on, mostMembers, memberOf: 5, most: 1000 };
}

// ---------- the words that are signed ----------

export interface FirmText { slug: string; name: string; does: string; lead: string; members: string[]; at: number }

/** What the lead signs to form a firm, or to edit it: readable, so a wallet shows exactly what it puts its name to. */
export const firmMessage = (f: FirmText): string =>
  ["Factor firm", `firm: ${f.slug}`, `name: ${f.name}`, `does: ${f.does}`, `lead: ${f.lead}`, `members: ${f.members.length ? f.members.join(", ") : "none"}`, `at: ${f.at}`].join("\n");
/** What an invited agent signs to join. */
export const joinMessage = (j: { slug: string; lead: string; member: string; at: number }): string =>
  ["Factor: join a firm", `firm: ${j.slug}`, `lead: ${j.lead}`, `member: ${j.member}`, `at: ${j.at}`].join("\n");
/** What a member signs to leave. */
export const leaveMessage = (l: { slug: string; member: string; at: number }): string =>
  ["Factor: leave a firm", `firm: ${l.slug}`, `member: ${l.member}`, `at: ${l.at}`].join("\n");
/** What a customer signs to hire a firm with a job it locked for the firm's lead: the job's title and brief with it. */
export const firmHireMessage = (h: { slug: string; lead: string; job: number; title: string; brief: string; at: number }): string =>
  `${["Factor: hire a firm", `firm: ${h.slug}`, `lead: ${h.lead}`, `job: ${h.job}`, `title: ${h.title}`, `at: ${h.at}`].join("\n")}${h.brief ? `\n\n${h.brief}` : ""}`;

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;
/** The slug a name gives: small letters and digits, dashes between words. */
export const slugOf = (name: string): string => name.normalize("NFKD").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 32).replace(/-+$/, "");

/** Factor's own firm: Factor's agents, put together by the engine and run by it (./house/firm.ts). */
export const HOUSE_FIRM = {
  slug: "the-research-desk",
  name: "The Research Desk",
  does: "Reads what you send, tables its figures, answers its questions, proofreads it",
  lead: "plain-reader",
  members: ["data-shaper", "faq-smith", "red-pen"],
  /** the least a job for the whole team takes: the team is paid out of half of it, drawn early */
  fromWei: 8n * 10n ** 15n,
} as const;

// Names nobody can take for a firm: Factor's own words, staff-sounding words, the docs' examples, and every name
// Factor's own agents and firm go by.
const RESERVED_SLUGS = new Set([...RESERVED, ...HOUSE_NAMES, HOUSE_FIRM.slug, "firm", "firms", "the-firm", "your-firm", "the-firms-name", "firm-name", "my-firm", "an-firm", "a-firm", "team", "staff", "moderator", "moderators", "mods", "help", "news", "announcements", "security"]);
const STAFF = /\b(official|verified|admin|administrator|moderator|staff|support team|helpdesk|security team)\b/i;
const CRUDE = /(fuck|shit|cunt|nigg|fagg|retard|rape|porn|nazi|hitler|kys)/i;
const NAME_CHARS = /^[A-Za-z0-9][A-Za-z0-9 &'.,-]*[A-Za-z0-9.]$/;

// ---------- the books ----------

export interface FirmRow { id: number; slug: string; name: string; name_key: string; does: string; lead: string; house: number; signed_at: number; signature: string; created_at: number; hidden: number }
export interface MemberRow { firm_id: number; address: string; invited_at: number; joined_at: number | null; join_signature: string | null; left_at: number | null }
export interface FirmJobRow { job_id: number; firm_id: number; customer: string; lead: string; via: string; title: string; signed_at: number; signature: string; at: number }

const SCHEMA = `
-- Agent firms (./firms.ts). A firm: what its lead signed. Its slug never changes; its name, line and members do, each
-- time the lead signs them again.
CREATE TABLE IF NOT EXISTS firms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,     -- the name in small letters, one space between words: two firms never share one
  does TEXT NOT NULL,
  lead TEXT NOT NULL,
  house INTEGER NOT NULL DEFAULT 0,  -- Factor's own, put together by the engine
  signed_at INTEGER NOT NULL,        -- the time in what the lead signed, seconds
  signature TEXT NOT NULL,
  created_at INTEGER NOT NULL,       -- ms
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS firms_lead ON firms (lead);
-- Who the lead invited, and who signed to join. A member that left keeps its row, with the time it left.
CREATE TABLE IF NOT EXISTS firm_members (
  firm_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  invited_at INTEGER NOT NULL,
  joined_at INTEGER,
  join_signature TEXT,
  left_at INTEGER,
  PRIMARY KEY (firm_id, address)
);
CREATE INDEX IF NOT EXISTS firm_members_address ON firm_members (address);
-- A job hired through a firm: locked for its lead, filed under the firm by its customer's signature or a link the
-- lead signed for the firm. The sub-jobs under it are the firm's work too (subjobs.root_id).
CREATE TABLE IF NOT EXISTS firm_jobs (
  job_id INTEGER PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  customer TEXT NOT NULL,
  lead TEXT NOT NULL,
  via TEXT NOT NULL,                 -- hire | link | x402 | kit | plan
  title TEXT NOT NULL DEFAULT '',
  signed_at INTEGER NOT NULL,
  signature TEXT NOT NULL,           -- the customer's, or the link's own number
  at INTEGER NOT NULL                -- ms
);
CREATE INDEX IF NOT EXISTS firm_jobs_firm ON firm_jobs (firm_id, job_id);
`;

export class FirmStore {
  constructor(private db: EngineDb) {
    db.db.exec(SCHEMA);
  }

  bySlug(slug: string): FirmRow | null {
    return (this.db.q("SELECT * FROM firms WHERE slug = ?").get(slug) as FirmRow | undefined) ?? null;
  }

  byId(id: number): FirmRow | null {
    return (this.db.q("SELECT * FROM firms WHERE id = ?").get(id) as FirmRow | undefined) ?? null;
  }

  all(): FirmRow[] {
    return this.db.q("SELECT * FROM firms WHERE hidden = 0 ORDER BY house DESC, id").all() as FirmRow[];
  }

  count(): number {
    return (this.db.q("SELECT COUNT(*) AS n FROM firms WHERE hidden = 0").get() as { n: number }).n;
  }

  members(firm: number): MemberRow[] {
    return this.db.q("SELECT * FROM firm_members WHERE firm_id = ? ORDER BY invited_at, rowid").all(firm) as MemberRow[];
  }

  member(firm: number, address: string): MemberRow | null {
    return (this.db.q("SELECT * FROM firm_members WHERE firm_id = ? AND address = ?").get(firm, address) as MemberRow | undefined) ?? null;
  }

  /** The firms an agent leads, belongs to or is invited to, that are shown. */
  of(address: string): { firm: FirmRow; role: "lead" | "member" | "invited" }[] {
    const led = (this.db.q("SELECT * FROM firms WHERE lead = ? AND hidden = 0").all(address) as FirmRow[]).map((firm) => ({ firm, role: "lead" as const }));
    const rows = this.db.q("SELECT f.*, m.joined_at AS m_joined FROM firm_members m JOIN firms f ON f.id = m.firm_id WHERE m.address = ? AND m.left_at IS NULL AND f.hidden = 0 ORDER BY f.id").all(address) as (FirmRow & { m_joined: number | null })[];
    return [...led, ...rows.map(({ m_joined, ...firm }) => ({ firm, role: m_joined ? ("member" as const) : ("invited" as const) }))];
  }

  job(jobId: number): FirmJobRow | null {
    return (this.db.q("SELECT * FROM firm_jobs WHERE job_id = ?").get(jobId) as FirmJobRow | undefined) ?? null;
  }

  jobs(firm: number, limit = 1000): FirmJobRow[] {
    return this.db.q("SELECT * FROM firm_jobs WHERE firm_id = ? ORDER BY job_id DESC LIMIT ?").all(firm, limit) as FirmJobRow[];
  }

  hide(slug: string, hidden: boolean): boolean {
    return this.db.q("UPDATE firms SET hidden = ? WHERE slug = ? AND house = 0").run(hidden ? 1 : 0, slug).changes === 1;
  }
}

// ---------- what a page and an app read ----------

export interface Named { address: string; name: string; named: boolean }
export interface FirmMemberJson extends Named {
  role: "lead" | "member" | "invited";
  since: string | null;
  /** its part of the firm's work: jobs it took in the firm (the lead: the firm's jobs; a member: sub-jobs under them) */
  part: { jobs: number; settled: number; settledEth: number; settledWei: string };
}
export interface FirmJson {
  slug: string;
  name: string;
  does: string;
  /** Factor's own firm, run by Factor */
  house: boolean;
  lead: Named;
  members: FirmMemberJson[];
  since: string;
  hired: number;
  settled: number;
  settledEth: number;
  /** its Factor Score: the desk's score formula over the jobs customers hired it for */
  score: number;
  /** a house firm takes a job for the whole team from this price */
  fromEth?: number;
}
export interface FirmRecordJson {
  version: 1;
  firm: string;
  name: string;
  does: string;
  house: boolean;
  lead: string;
  chainId: number;
  desk: string;
  block: number;
  asOf: string;
  since: string;
  members: { address: string; name: string; role: "lead" | "member"; jobs: number; settled: number; settledWei: string }[];
  /** jobs customers hired the firm for */
  jobs: { hired: number; open: number; delivered: number; settled: number; settledAtHalf: number; declined: number; refunded: number };
  /** the sub-jobs under them: the work the lead split out, to members and to agents outside the firm */
  subJobs: { count: number; settled: number; toMembers: number; toOthers: number };
  /** the value of the firm's settled jobs, as their customers locked them */
  settledWei: string;
  settledEth: string;
  customers: number;
  /** the firm's Factor Score, outside the attestation: worked out from the jobs above by the desk's formula */
  score: number;
  factorScore: FactorScoreJson;
  page: string;
  badge: string;
  attestation: { signer: string; signature: Hex; digest: Hex; message: FirmRecordMessage; issuedAt: string; expiresAt: string } | null;
}

export const FIRM_RECORD_TYPES = {
  FirmRecord: [
    { name: "firm", type: "string" },
    { name: "lead", type: "address" },
    { name: "members", type: "uint32" },
    { name: "block", type: "uint64" },
    { name: "hired", type: "uint32" },
    { name: "settled", type: "uint32" },
    { name: "settledAtHalf", type: "uint32" },
    { name: "refunded", type: "uint32" },
    { name: "subJobs", type: "uint32" },
    { name: "settledValue", type: "uint256" },
    { name: "customers", type: "uint32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;
export interface FirmRecordMessage { firm: string; lead: string; members: number; block: number; hired: number; settled: number; settledAtHalf: number; refunded: number; subJobs: number; settledValue: string; customers: number; issuedAt: number; expiresAt: number }

/** What is signed of a firm's record: bound to Robinhood Chain and the desk, as an agent's record is. */
export function firmRecordTypedData(chainId: number, desk: string, m: FirmRecordMessage) {
  return {
    domain: { name: "Factor Record", version: "1", chainId, verifyingContract: desk as Hex },
    types: FIRM_RECORD_TYPES,
    primaryType: "FirmRecord" as const,
    message: { ...m, lead: m.lead as Hex, block: BigInt(m.block), settledValue: BigInt(m.settledValue), issuedAt: BigInt(m.issuedAt), expiresAt: BigInt(m.expiresAt) },
  };
}

// ---------- the rules ----------

type Answer = { status: number; body: Record<string, unknown> };
const no = (status: number, error: string): Answer => ({ status, body: { error } });
const WINDOW_S = 600;
const ethNum = (wei: bigint | string): number => Number(BigInt(wei) / 10n ** 12n) / 1e6;
const iso = (s: number): string => new Date(s * 1000).toISOString();

export interface FirmDeps {
  cfg: FirmsConfig;
  db: EngineDb;
  /** whether `address` signed `message`: a wallet, or an account through one of its keys (../profiles.ts) */
  signed: (address: string, message: string, signature: unknown) => Promise<boolean>;
  /** the engine's clock, seconds */
  nowS: () => number;
  /** whether two addresses are run by the same hand, as far as Factor can see (./subjobs.ts) */
  sameHand: (a: string, b: string) => boolean;
  /** whether an address is Factor's own: one of its agents, or its demonstration customer */
  factorOwn: (address: string) => boolean;
  /** the job at the top of the chain a job is part of (./subjobs.ts) */
  rootOf: (job: number) => number;
  /** every sub-job under a customer's job (./subjobs.ts) */
  family: (root: number) => { job_id: number; parent_id: number; depth: number; hirer: string; agent: string }[];
  /** names agents signed, by address */
  names: () => Map<string, { name: string }>;
  /** whether a job is a month of a monthly plan (./plans.ts) */
  isMonth?: (job: number) => boolean;
}

export class Firms {
  readonly store: FirmStore;

  constructor(private d: FirmDeps) {
    this.store = new FirmStore(d.db);
  }

  get cfg(): FirmsConfig {
    return this.d.cfg;
  }

  private registered(address: string): boolean {
    return !!this.d.db.q("SELECT 1 FROM desk_agents WHERE address = ?").get(address);
  }

  private fresh(at: unknown): number | null {
    if (typeof at !== "number" || !Number.isSafeInteger(at)) return null;
    return Math.abs(this.d.nowS() - at) <= WINDOW_S ? at : null;
  }

  /** Why a name and a slug cannot be a firm's, or null. `team`: the lead and the members, whose own names the firm may use. */
  nameProblem(slug: string, name: string, does: string, team: string[], house = false): string | null {
    if (!SLUG.test(slug) || slug.includes("--") || slug.startsWith("0x")) return "a firm's short name is 3 to 32 small letters, digits and single dashes";
    if (!NAME_CHARS.test(name)) return "a firm's name is letters, digits, spaces and & ' . , - only";
    if (!house) {
      if (RESERVED_SLUGS.has(slug)) return "that name is not available";
      if (/factor/i.test(slug) || /factor/i.test(name)) return "a firm's name cannot use the word Factor: it would pass for Factor's own";
      if (STAFF.test(name) || STAFF.test(slug.replace(/-/g, " ")) || STAFF.test(does)) return "a firm's name and line cannot pass for Factor's staff";
      if (CRUDE.test(slug) || CRUDE.test(name) || CRUDE.test(does)) return "that name is not available";
      // an agent's name belongs to that agent: a firm may go by it only when that agent is in it
      const holder = this.d.db.q("SELECT address FROM agent_profiles WHERE name_key = ?").get(slug) as { address: string } | undefined;
      if (holder && !team.includes(holder.address)) return "that is the name of an agent outside the firm";
    }
    return null;
  }

  /** The lead signs a firm: forms it, or edits the one it leads (the same slug, a newer time). */
  async form(body: Record<string, unknown>): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "firms are switched off for now");
    const lead = normalizeAddress(body.lead);
    if (!lead) return no(400, "lead is not an address");
    const name = oneLine(body.name, 3, 40);
    if (!name || name !== body.name) return no(400, "a firm's name is one plain line of 3 to 40 characters, without links or double spaces");
    const does = oneLine(body.does, 3, 80);
    if (!does || does !== body.does) return no(400, "what the firm does is one plain line of 3 to 80 characters, without links, line breaks or double spaces");
    const slug = typeof body.slug === "string" && body.slug ? body.slug : slugOf(name);
    if (!Array.isArray(body.members)) return no(400, "members is a list of the agents' addresses");
    const members = body.members.map((m) => normalizeAddress(m));
    if (members.some((m) => !m)) return no(400, "every member is an agent's address");
    const list = members as string[];
    if (new Set(list).size !== list.length) return no(400, "an agent is in the list twice");
    if (list.includes(lead)) return no(400, "the lead is in the firm already: list only the agents it invites");
    if (list.length < 1) return no(400, "a firm is a lead and at least one other agent");
    if (list.length > this.d.cfg.mostMembers) return no(400, `a firm invites ${this.d.cfg.mostMembers} agents at most`);
    const at = this.fresh(body.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    const had = this.store.bySlug(slug);
    if (had?.house) return no(409, "that firm is Factor's own");
    const why = this.nameProblem(slug, name, does, [lead, ...list]);
    if (why) return no(400, why);
    let ok = false;
    try {
      ok = await this.d.signed(lead, firmMessage({ slug, name, does, lead, members: list, at }), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, "the signature is not the lead's");
    if (!this.registered(lead)) return no(404, "the lead has not registered on the desk (a new agent shows up a few seconds after it registers)");
    const missing = list.find((m) => !this.registered(m));
    if (missing) return no(404, `${missing} has not registered on the desk: only agents can be in a firm`);
    const db = this.d.db;
    return db.tx((): Answer => {
      if (had) {
        if (had.lead !== lead) return no(403, "only the firm's lead edits it");
        if (at <= had.signed_at) return no(409, "a newer version of the firm is already stored");
      } else {
        if (this.store.count() >= this.d.cfg.most) return no(429, "no more firms can be formed for now");
        if (db.q("SELECT 1 FROM firms WHERE lead = ?").get(lead)) return no(409, "an agent leads one firm: edit the one it leads");
      }
      const taken = db.q("SELECT id FROM firms WHERE name_key = ?").get(nameKey(name)) as { id: number } | undefined;
      if (taken && taken.id !== had?.id) return no(409, "another firm has that name");
      let id: number;
      if (had) {
        db.q("UPDATE firms SET name = ?, name_key = ?, does = ?, signed_at = ?, signature = ? WHERE id = ?").run(name, nameKey(name), does, at, String(body.signature), had.id);
        id = had.id;
      } else id = Number(db.q("INSERT INTO firms (slug, name, name_key, does, lead, signed_at, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(slug, name, nameKey(name), does, lead, at, String(body.signature), db.now()).lastInsertRowid);
      // who is in the list is invited (again, when it had left); who is no longer in it has left
      for (const m of list) {
        const row = this.store.member(id, m);
        if (!row) db.q("INSERT INTO firm_members (firm_id, address, invited_at) VALUES (?, ?, ?)").run(id, m, at);
        else if (row.left_at !== null) db.q("UPDATE firm_members SET invited_at = ?, joined_at = NULL, join_signature = NULL, left_at = NULL WHERE firm_id = ? AND address = ?").run(at, id, m);
      }
      for (const row of this.store.members(id)) if (!list.includes(row.address) && row.left_at === null) db.q("UPDATE firm_members SET left_at = ? WHERE firm_id = ? AND address = ?").run(at, id, row.address);
      return { status: 200, body: { ok: true, firm: slug, edited: !!had, invited: list.filter((m) => !this.store.member(id, m)?.joined_at) } };
    });
  }

  /** An invited agent signs to join. */
  async join(body: Record<string, unknown>): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "firms are switched off for now");
    const firm = typeof body.firm === "string" ? this.store.bySlug(body.firm) : null;
    if (!firm || firm.hidden) return no(404, "no such firm");
    const member = normalizeAddress(body.member);
    if (!member) return no(400, "member is not an address");
    const at = this.fresh(body.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    const row = this.store.member(firm.id, member);
    if (!row || row.left_at !== null) return no(403, "only an agent the lead invited can join: ask the lead to add it");
    if (row.joined_at) return { status: 200, body: { ok: true, firm: firm.slug, joined: true } };
    let ok = false;
    try {
      ok = await this.d.signed(member, joinMessage({ slug: firm.slug, lead: firm.lead, member, at }), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, "the signature is not this agent's");
    if (!this.registered(member)) return no(404, "this agent has not registered on the desk");
    const n = (this.d.db.q("SELECT COUNT(*) AS n FROM firm_members WHERE address = ? AND joined_at IS NOT NULL AND left_at IS NULL").get(member) as { n: number }).n;
    if (n >= this.d.cfg.memberOf) return no(409, `an agent belongs to ${this.d.cfg.memberOf} firms at most: leave one first`);
    this.d.db.q("UPDATE firm_members SET joined_at = ?, join_signature = ? WHERE firm_id = ? AND address = ?").run(at, String(body.signature), firm.id, member);
    return { status: 200, body: { ok: true, firm: firm.slug, joined: true } };
  }

  /** A member, or an invited agent, signs to leave. The lead edits the firm instead. */
  async leave(body: Record<string, unknown>): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "firms are switched off for now");
    const firm = typeof body.firm === "string" ? this.store.bySlug(body.firm) : null;
    if (!firm || firm.hidden) return no(404, "no such firm");
    if (firm.house) return no(409, "that firm is Factor's own");
    const member = normalizeAddress(body.member);
    if (!member) return no(400, "member is not an address");
    if (member === firm.lead) return no(409, "the lead does not leave its firm: it edits who is in it");
    const at = this.fresh(body.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    const row = this.store.member(firm.id, member);
    if (!row || row.left_at !== null) return no(404, "this agent is not in the firm");
    let ok = false;
    try {
      ok = await this.d.signed(member, leaveMessage({ slug: firm.slug, member, at }), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, "the signature is not this agent's");
    this.d.db.q("UPDATE firm_members SET left_at = ? WHERE firm_id = ? AND address = ?").run(at, firm.id, member);
    return { status: 200, body: { ok: true, firm: firm.slug, left: true } };
  }

  /** The lead, and every member that signed to join and has not left. */
  team(firm: FirmRow): string[] {
    return [firm.lead, ...this.store.members(firm.id).filter((m) => m.joined_at && m.left_at === null).map((m) => m.address)];
  }

  /** Why a customer cannot hire a firm (it is in it, or run by the same hand as one of its agents), or null. */
  customerProblem(firm: FirmRow, customer: string): string | null {
    const inFirm = [firm.lead, ...this.store.members(firm.id).filter((m) => m.left_at === null).map((m) => m.address)];
    if (inFirm.includes(customer)) return "a firm cannot hire itself: its customer is in it";
    if (inFirm.some((a) => this.d.sameHand(a, customer))) return "the customer is run by the same hand as an agent of the firm, so the job would only make records";
    return null;
  }

  /** Why a job locked for a firm's lead cannot be filed under the firm, or null. */
  private jobProblem(firm: FirmRow, job: { customer: string; agent: string; state: number } | null, open = true): string | null {
    if (!job) return "the desk has no such job yet (a new job shows up a few seconds after it is locked)";
    if (job.agent !== firm.lead) return "that job is not locked for the firm's lead: a firm is hired through its lead";
    if (open && job.state !== STATE.locked && job.state !== STATE.advanced) return "that job is no longer open";
    return this.customerProblem(firm, job.customer);
  }

  /** A customer files a job it locked for the lead under the firm, signing the job's title and brief with it. */
  async hire(body: Record<string, unknown>): Promise<Answer> {
    if (!this.d.cfg.enabled) return no(503, "firms are switched off for now");
    const firm = typeof body.firm === "string" ? this.store.bySlug(body.firm) : null;
    if (!firm || firm.hidden) return no(404, "no such firm");
    const jobId = typeof body.job === "number" && Number.isSafeInteger(body.job) && body.job > 0 ? body.job : null;
    if (jobId === null) return no(400, "job is not a job's number");
    const title = oneLine(body.title, 3, 80);
    if (!title || title !== body.title) return no(400, "a title is one plain line of 3 to 80 characters, without links, line breaks or double spaces");
    const brief = body.brief === "" || body.brief === undefined ? "" : briefText(body.brief);
    if (brief === null || (brief !== "" && brief !== body.brief)) return no(400, "a brief is plain text of up to 12,000 characters");
    const at = this.fresh(body.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    const job = this.d.db.q("SELECT customer, agent, state FROM desk_jobs WHERE id = ?").get(jobId) as { customer: string; agent: string; state: number } | undefined;
    if (!job) return no(404, "the desk has no such job yet (a new job shows up a few seconds after it is locked)");
    const had = this.store.job(jobId);
    if (had && had.firm_id !== firm.id) return no(409, "that job was hired through another firm");
    const why = had ? null : this.jobProblem(firm, job);
    if (why) return no(409, why);
    let ok = false;
    try {
      ok = await this.d.signed(job.customer, firmHireMessage({ slug: firm.slug, lead: firm.lead, job: jobId, title, brief, at }), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, "the signature is not the wallet that locked this job");
    const db = this.d.db;
    db.tx(() => {
      if (!had) db.q("INSERT INTO firm_jobs (job_id, firm_id, customer, lead, via, title, signed_at, signature, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(jobId, firm.id, job.customer, firm.lead, typeof body.via === "string" && body.via === "kit" ? "kit" : "hire", title, at, String(body.signature), db.now());
      // the title and the brief, as the customer signed them: like a brief signed on the job's own page
      const t = db.q("SELECT signed_at FROM job_titles WHERE job_id = ?").get(jobId) as { signed_at: number } | undefined;
      if (!t || at > t.signed_at) db.q("INSERT INTO job_titles (job_id, title, by, signed_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET title = excluded.title, by = excluded.by, signed_at = excluded.signed_at").run(jobId, title, job.customer, at);
      const b = db.q("SELECT signed_at FROM job_briefs WHERE job_id = ?").get(jobId) as { signed_at: number } | undefined;
      if (brief && (!b || at > b.signed_at)) db.q("INSERT INTO job_briefs (job_id, brief, by, signed_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET brief = excluded.brief, by = excluded.by, signed_at = excluded.signed_at").run(jobId, brief, job.customer, at);
    });
    return { status: 200, body: { ok: true, firm: firm.slug, job: jobId, lead: firm.lead } };
  }

  /**
   * A job paid through a link the lead signed for the firm (../pay.ts), or a month of a plan with the firm (../plans.ts):
   * the link is the lead's word that it sells the firm's work, a plan the customer's word that it hires the firm, and
   * the lock read from the chain is the customer's. Filed when the rules allow it, or why not.
   */
  attachDeal(jobId: number, slug: string, locked: LockFacts, linkId: string, via: string): { firm: string } | { firmNote: string } {
    if (!this.d.cfg.enabled) return { firmNote: "firms are switched off for now: the deal stands as an ordinary one" };
    const firm = this.store.bySlug(slug);
    if (!firm || firm.hidden) return { firmNote: "the link names a firm Factor does not know: the deal stands as an ordinary one" };
    const had = this.store.job(jobId);
    if (had) return had.firm_id === firm.id ? { firm: firm.slug } : { firmNote: "that job was hired through another firm" };
    const why = this.jobProblem(firm, { customer: locked.customer, agent: locked.agent, state: STATE.locked }, false);
    if (why) return { firmNote: `${why}: the deal stands as an ordinary one` };
    this.d.db.q("INSERT INTO firm_jobs (job_id, firm_id, customer, lead, via, title, signed_at, signature, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING").run(jobId, firm.id, locked.customer, firm.lead, via === "x402" ? "x402" : via === "plan" ? "plan" : "link", "", locked.at, linkId, this.d.db.now());
    return { firm: firm.slug };
  }

  /** The firm a job is part of: the job hired through it, or a sub-job under such a job. */
  firmOfJob(jobId: number): { firm: FirmRow; root: number; part: boolean } | null {
    const root = this.d.rootOf(jobId);
    const fj = this.store.job(root);
    if (!fj) return null;
    const firm = this.store.byId(fj.firm_id);
    return firm && !firm.hidden ? { firm, root, part: root !== jobId } : null;
  }

  /**
   * Factor's own firm is the one place where Factor's agents hire each other: only for a job filed under it whose
   * customer is from outside Factor, and only between agents of the firm. Asked by the rules of a hire (./subjobs.ts).
   */
  teamAllows(parent: number, hirer: string, agent: string): boolean {
    const f = this.firmOfJob(parent);
    if (!f || !f.firm.house) return false;
    const team = this.team(f.firm);
    if (!team.includes(hirer) || !team.includes(agent)) return false;
    const root = this.d.db.q("SELECT customer FROM desk_jobs WHERE id = ?").get(f.root) as { customer: string } | undefined;
    return !!root && !this.d.factorOwn(root.customer);
  }

  /** Factor's own firm, put together from its agents once they are on the desk. Kept as it is when it stands already. */
  ensureHouse(lead: string, members: string[]): boolean {
    const db = this.d.db;
    const had = this.store.bySlug(HOUSE_FIRM.slug);
    if (had && had.lead === lead && members.every((m) => this.store.member(had.id, m)?.joined_at)) return false;
    const at = this.d.nowS();
    db.tx(() => {
      // a firm somebody else gave the name to before Factor's existed (it never could: the name is reserved) is not overwritten
      if (had && !had.house) return;
      let id: number;
      if (had) {
        db.q("UPDATE firms SET lead = ?, name = ?, name_key = ?, does = ?, signed_at = ? WHERE id = ?").run(lead, HOUSE_FIRM.name, nameKey(HOUSE_FIRM.name), HOUSE_FIRM.does, at, had.id);
        id = had.id;
      } else id = Number(db.q("INSERT INTO firms (slug, name, name_key, does, lead, house, signed_at, signature, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, 'factor', ?)").run(HOUSE_FIRM.slug, HOUSE_FIRM.name, nameKey(HOUSE_FIRM.name), HOUSE_FIRM.does, lead, at, db.now()).lastInsertRowid);
      for (const m of members) db.q("INSERT INTO firm_members (firm_id, address, invited_at, joined_at, join_signature) VALUES (?, ?, ?, ?, 'factor') ON CONFLICT(firm_id, address) DO UPDATE SET joined_at = excluded.joined_at, left_at = NULL").run(id, m, at, at);
      for (const row of this.store.members(id)) if (!members.includes(row.address) && row.left_at === null) db.q("UPDATE firm_members SET left_at = ? WHERE firm_id = ? AND address = ?").run(at, id, row.address);
    });
    return true;
  }

  // ---------- the record ----------

  /** Every job of a firm's: the jobs hired through it and every sub-job under them, as the desk has them. */
  private work(firm: FirmRow): { roots: { job: FirmJobRow; row: DeskJob | null }[]; subs: { link: { job_id: number; parent_id: number; depth: number; hirer: string; agent: string }; row: DeskJob | null }[] } {
    const roots = this.store.jobs(firm.id).map((job) => ({ job, row: this.deskJob(job.job_id) }));
    const subs = roots.flatMap((r) => this.d.family(r.job.job_id)).map((link) => ({ link, row: this.deskJob(link.job_id) }));
    return { roots, subs };
  }

  private deskJob(id: number): DeskJob | null {
    return (this.d.db.q("SELECT id, customer, agent, price, state FROM desk_jobs WHERE id = ?").get(id) as DeskJob | undefined) ?? null;
  }

  private named(address: string): Named {
    const p = this.d.names().get(address);
    return { address, name: p?.name ?? `${address.slice(0, 6)}…${address.slice(-4)}`, named: !!p };
  }

  /** A firm as a list shows it, and the figures its page and record are made of. */
  json(firm: FirmRow): FirmJson {
    const { roots, subs } = this.work(firm);
    const done = (s: number | undefined) => s === STATE.settled || s === STATE.half;
    const part = (address: string, lead: boolean) => {
      const mine = lead ? roots.map((r) => r.row).filter((r): r is DeskJob => !!r && r.agent === address) : subs.map((s) => s.row).filter((r): r is DeskJob => !!r && r.agent === address);
      const settled = mine.filter((r) => done(r.state));
      const wei = settled.reduce((n, r) => n + BigInt(r.price), 0n);
      return { jobs: mine.length, settled: settled.length, settledEth: ethNum(wei), settledWei: wei.toString() };
    };
    const members: FirmMemberJson[] = [
      { ...this.named(firm.lead), role: "lead", since: iso(Math.floor(firm.created_at / 1000)), part: part(firm.lead, true) },
      ...this.store.members(firm.id).filter((m) => m.left_at === null).map((m) => ({ ...this.named(m.address), role: (m.joined_at ? "member" : "invited") as "member" | "invited", since: m.joined_at ? iso(m.joined_at) : null, part: part(m.address, false) })),
    ];
    const settled = roots.filter((r) => done(r.row?.state));
    return {
      slug: firm.slug, name: firm.name, does: firm.does, house: !!firm.house, lead: this.named(firm.lead), members, since: iso(Math.floor(firm.created_at / 1000)),
      hired: roots.length, settled: settled.length, settledEth: ethNum(settled.reduce((n, r) => n + BigInt(r.row!.price), 0n)),
      score: scoreOf(recordOfJobs(this.scoreJobs(firm)), this.d.nowS()),
      ...(firm.house ? { fromEth: ethNum(HOUSE_FIRM.fromWei) } : {}),
    };
  }

  list(): FirmJson[] {
    return this.store.all().map((f) => this.json(f)).sort((a, b) => Number(b.house) - Number(a.house) || b.settled - a.settled || b.hired - a.hired || (a.since < b.since ? -1 : 1));
  }

  /** The jobs customers hired the firm for, as the score reads them from the desk's copy. */
  scoreJobs(firm: FirmRow): ScoreJob[] {
    return this.d.db.q("SELECT d.id, d.state, d.customer, d.price, d.fee, d.closed_at, d.early, d.from_pool FROM firm_jobs f JOIN desk_jobs d ON d.id = f.job_id WHERE f.firm_id = ?").all(firm.id) as ScoreJob[];
  }

  /**
   * A firm's Factor Score (./factorscore.ts): the desk's formula over the jobs customers hired it for, their income by
   * the way they came (jobs, months of plans), the parts split out of them, and what can be drawn: its lead's limit.
   */
  factorScore(firm: FirmRow, o: { desk: string }): FactorScoreJson {
    const jobs = this.scoreJobs(firm);
    const record = recordOfJobs(jobs);
    const income = incomeOf(jobs, (id) => (this.d.isMonth?.(id) ? "monthly" : "jobs"), ["jobs", "monthly"]);
    const { subs } = this.work(firm);
    const team = this.team(firm);
    const done = (s: number | undefined) => s === STATE.settled || s === STATE.half;
    const value = subs.reduce((n, s) => n + BigInt(s.row?.price ?? "0"), 0n);
    // what can be drawn on the firm's jobs is the lead's own limit; each member draws on its own parts
    const desk = new DeskStore(this.d.db);
    const lead = desk.agent(firm.lead)?.record;
    const members: NonNullable<DrawJson["members"]> = team.map((address) => {
      const r = desk.agent(address)?.record;
      const draw = r ? drawOf(r, []) : null;
      return { address, name: this.named(address).name, role: address === firm.lead ? ("lead" as const) : ("member" as const), limitEth: draw?.limitEth ?? 0, canDrawEth: draw?.canDrawEth ?? 0, barred: !!r?.barred };
    });
    const leadRecord = lead ?? recordOfJobs([]);
    const draw = drawOf(leadRecord, [], { firm: { lead: { address: firm.lead, name: this.named(firm.lead).name }, members } });
    return factorScore({
      kind: "firm", record, nowS: this.d.nowS(), distinctCustomers: new Set(jobs.filter((x) => done(x.state)).map((x) => x.customer)).size, income,
      hired: { parts: subs.length, settled: subs.filter((s) => done(s.row?.state)).length, valueWei: value.toString(), valueEth: ethNum(value), toMembers: subs.filter((s) => team.includes(s.link.agent)).length, toOthers: subs.filter((s) => !team.includes(s.link.agent)).length },
      draw, check: `worked out by Factor from the jobs hired through the firm, each on the desk ${o.desk}`,
    });
  }

  /** The record of a firm, for any app: worked out from the desk, with Factor's attestation when there is a key. */
  async record(firm: FirmRow, o: { chainId: number; desk: string; block: number; site: string; signer: RecordSigner | null }): Promise<FirmRecordJson> {
    const { roots, subs } = this.work(firm);
    const by = (s: number) => roots.filter((r) => r.row?.state === s).length;
    const team = this.team(firm);
    const done = (s: number | undefined) => s === STATE.settled || s === STATE.half;
    const settledRoots = roots.filter((r) => done(r.row?.state));
    const settledWei = settledRoots.reduce((n, r) => n + BigInt(r.row!.price), 0n);
    const customers = new Set(roots.filter((r) => done(r.row?.state)).map((r) => r.row!.customer)).size;
    const j = this.json(firm);
    const nowS = this.d.nowS();
    const message: FirmRecordMessage = {
      firm: firm.slug, lead: firm.lead, members: team.length - 1, block: o.block, hired: roots.length, settled: by(STATE.settled), settledAtHalf: by(STATE.half), refunded: by(STATE.refunded),
      subJobs: subs.length, settledValue: settledWei.toString(), customers, issuedAt: nowS, expiresAt: nowS + 3600,
    };
    let attestation: FirmRecordJson["attestation"] = null;
    if (o.signer) {
      const typed = firmRecordTypedData(o.chainId, o.desk, message);
      attestation = { signer: o.signer.address, signature: await o.signer.signTypedData(typed as never), digest: hashTypedData(typed as never), message, issuedAt: iso(nowS), expiresAt: iso(nowS + 3600) };
    }
    return {
      version: 1, firm: firm.slug, name: firm.name, does: firm.does, house: !!firm.house, lead: firm.lead, chainId: o.chainId, desk: o.desk, block: o.block, asOf: iso(nowS), since: j.since,
      members: j.members.filter((m) => m.role !== "invited").map((m) => ({ address: m.address, name: m.name, role: m.role as "lead" | "member", jobs: m.part.jobs, settled: m.part.settled, settledWei: m.part.settledWei })),
      jobs: { hired: roots.length, open: by(STATE.locked) + by(STATE.advanced), delivered: by(STATE.delivered), settled: by(STATE.settled), settledAtHalf: by(STATE.half), declined: by(STATE.declined), refunded: by(STATE.refunded) },
      subJobs: { count: subs.length, settled: subs.filter((s) => done(s.row?.state)).length, toMembers: subs.filter((s) => team.includes(s.link.agent)).length, toOthers: subs.filter((s) => !team.includes(s.link.agent)).length },
      settledWei: settledWei.toString(), settledEth: formatEther(settledWei), customers,
      score: j.score, factorScore: this.factorScore(firm, { desk: o.desk }),
      page: `${o.site}/firms/${firm.slug}`, badge: `${o.site}/api/v1/firms/${firm.slug}/badge`,
      attestation,
    };
  }
}

interface DeskJob { id: number; customer: string; agent: string; price: string; state: number }

const nameKey = (name: string): string => name.toLowerCase().replace(/\s+/g, " ").trim();
