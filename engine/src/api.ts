// What the engine tells the outside.
//
//   GET  /v1/state             everything the site's first page draws, in the shape of web/src/lib/types.ts
//   GET  /v1/agents            every agent, by score
//   GET  /v1/agents/<id>       one agent (its address or its name), its jobs and its lines of the ledger
//   GET  /v1/jobs              jobs, newest first: ?limit=50&before=<number>&agent=<address>&customer=<address>
//   GET  /v1/jobs/<number>     one job, its advances and its lines of the ledger
//   GET  /v1/ledger            the ledger, newest first: ?limit=50&before=<n>&show=locked|advanced|settled|refunded|burned
//   GET  /v1/burns             every buy back and burn: ?limit=50&before=<burn number>
//   GET  /v1/health            for the owner: cursors, actions, the gas wallet, the nodes, the last error
//   POST /v1/agents/profile    an agent's name and what it does, signed by its wallet (profiles.ts)
//   POST /v1/jobs/title        what a job is about, signed by the customer who locked it
//
// Every GET is answered from the database (the last reading of the chain, the ledger, the engine's copy of each
// job and agent), so a burst of visitors costs the node nothing. Before the contracts are given, and whenever the
// engine is off or stopped, /v1/state answers the same shape with launched: false and no figure invented.

import { getAddress } from "viem";
import { actState, KINDS } from "./chain/act.js";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import { hostsOnly, type RpcHealth } from "./chain/chain.js";
import type { EngineConfig } from "./chain/config.js";
import { snapshotOf, type Ctx, type Snapshot } from "./chain/context.js";
import { DeskStore, KIND_NAME, RULES, STATE, STATE_NAME, type AdvanceRow, type AgentRow, type JobRow, type LedgerRow } from "./desk.js";
import { Profiles, type Profile, type Written } from "./profiles.js";
import { canDrawOf, limitOf, scoreOf, scoreParts } from "./score.js";

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

// What the engine is, for the answers: built by engine.ts.
export interface EngineView {
  config: EngineConfig;
  state: "off" | "stopped" | "starting" | "running";
  problems: string[];
  warnings: string[];
  lastError: { at: number; where: string; message: string } | null;
  loops: Record<string, { lastRunAt: number | null; lastOkAt: number | null; runs: number; failures: number; waitMs: number; backingOff: boolean }>;
  ctx: Ctx | null;
  rpc: RpcHealth | null;
  now: () => number;
  // the three addresses the site links to, and whether the database is on a path the owner chose: all that is
  // handed on of the environment, so that no answer can ever carry a secret out of it
  links: { pons: string | null; github: string | null; x: string | null };
  dataDirSet: boolean;
  profiles: Profiles | null;
}

// ---- the site's shape: web/src/lib/types.ts. Keep the two in step by hand. ----

export interface AdvanceJson { kind: "customer" | "pool" | "compute"; eth: number; feeEth: number; at: string }
export interface JobJson {
  id: string; // "0412"
  n: number;
  title: string;
  agentId: string;
  customer: string;
  priceEth: number;
  state: "locked" | "advanced" | "delivered" | "settled" | "half" | "declined" | "refunded";
  lockedAt: string;
  dueAt: string;
  allowEarly: boolean;
  late: boolean;
  deliveredAt?: string;
  settledAt?: string;
  /** every draw added together, under the kind most of it came by: what the site's bill shows on one line */
  advance?: AdvanceJson;
  advances: AdvanceJson[];
  paidEth?: number;
  backEth?: number;
  feeEth?: number;
  notRepaidEth?: number;
  tx: string;
}
export interface AgentJson {
  id: string; // its address: what the site's links carry
  name: string;
  named: boolean; // false: the name is only its address, shortened
  address: string;
  house: boolean;
  does: string;
  since: string;
  settled: number;
  settledAtHalf: number;
  notDelivered: number;
  unanswered: number;
  customers: number;
  onTimePct: number;
  volumeEth: number;
  feesPaidEth: number;
  bondEth: number;
  drawnEth: number;
  limitEth: number;
  canDrawEth: number;
  advancesRepaid: number;
  advancesMissed: number;
  barred: boolean;
  score: number;
  scoreParts: { name: string; value: string; points: number; max: number }[];
}
export interface EventJson { n: number; at: string; kind: string; jobId?: string; agentId?: string; text: string; amount: string; tx: string }
export interface BurnJson { n: number; at: string; eth: number; tokens: number; tx: string }
export interface FactorState {
  source: "engine";
  asOf: string;
  launched: boolean;
  links: { pons: string | null; github: string | null; x: string | null };
  stats: { advancedEth: number; settledJobs: number; jobs: number; poolEth: number; reserveEth: number; outEth: number; heldEth: number; burnedTokens: number; supplyLeft: number; agents: number; lostEth: number };
  params: { advanceMaxPct: number; advanceFeePct: number; jobFeePct: number; graceHours: number; reviewHours: number; rejectedPct: number; reserveMinPct: number; minJobEth: number };
  agents: AgentJson[];
  jobs: JobJson[];
  events: EventJson[];
  burns: BurnJson[];
  contracts: { desk: string | null; splitter: string | null; burnPot: string | null; token: string | null; explorer: string };
}

const ok = (body: Record<string, unknown>): Answer => ({ status: 200, body });
const notFound = (what: string): Answer => ({ status: 404, body: { error: what } });
const SUPPLY = 1_000_000_000;
const PARAMS: FactorState["params"] = {
  advanceMaxPct: RULES.advanceMaxPct, advanceFeePct: RULES.advanceFeePct, jobFeePct: RULES.jobFeePct, graceHours: RULES.graceHours,
  reviewHours: RULES.reviewHours, rejectedPct: RULES.rejectedPct, reserveMinPct: RULES.reserveMinPct, minJobEth: RULES.minJobEth,
};
// what the first page gets of each list
const STATE_AGENTS = 200, STATE_JOBS = 60, STATE_EVENTS = 60, STATE_BURNS = 20;
// a page of a list, when the caller does not say, and the most one request may ask for
const PAGE = 50, PAGE_MOST = 200;
// the ledger's filters, as the site names them, and the kinds of line each one shows
const SHOW: Record<string, string[]> = {
  locked: ["locked"], advanced: ["advanced"], delivered: ["delivered"], settled: ["settled", "half"], refunded: ["refunded", "not_repaid", "declined"], burned: ["burned"], pool: ["pool_in"], bond: ["bond"],
};

/** ETH as a number to six places: fine for showing, never used for arithmetic. */
const eth = (wei: string | bigint): number => Number(BigInt(wei) / 10n ** 12n) / 1e6;
/** Whole tokens (18 decimals) as a number, to six places. */
const tokens = (wei: bigint): number => Number(wei / 10n ** 12n) / 1e6;
const iso = (s: number): string => new Date(s * 1000).toISOString();
const pad = (id: number): string => String(id).padStart(4, "0");
/** 0.0200 ETH, the way the ledger writes an amount. */
const ethText = (wei: string, sign = ""): string => `${sign}${(Number(BigInt(wei) / 10n ** 12n) / 1e6).toFixed(4)} ETH`;
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
/** An address the site may link to: https and nothing else. */
export const link = (raw: string | undefined): string | null => (raw && /^https:\/\/[^\s]+$/.test(raw.trim()) ? raw.trim() : null);

interface Names {
  profiles: Map<string, Profile>;
  house: Set<string>;
}
const nameOf = (names: Names, address: string | null): string => (address ? (names.profiles.get(address)?.name ?? shortAddress(address)) : "an agent");

export function agentJson(row: AgentRow, names: Names, nowS: number): AgentJson {
  const r = row.record;
  const p = names.profiles.get(row.address);
  return {
    id: row.address, name: p?.name ?? shortAddress(row.address), named: !!p, address: row.address, house: names.house.has(row.address), does: p?.does ?? "", since: iso(row.registered_at),
    settled: r.settled, settledAtHalf: r.settledAtHalf, notDelivered: r.notDelivered, unanswered: r.unanswered, customers: r.customers,
    onTimePct: r.settled ? Math.round((r.onTime * 100) / r.settled) : 0,
    volumeEth: eth(r.volume), feesPaidEth: eth(r.feesPaid), bondEth: eth(r.bond), drawnEth: eth(r.advancedNow), limitEth: eth(limitOf(r)), canDrawEth: eth(canDrawOf(r)),
    advancesRepaid: r.advancesRepaid, advancesMissed: r.advancesNotRepaid + r.earlyKept, barred: r.barred, score: scoreOf(r, nowS),
    scoreParts: scoreParts(r, nowS).map((s) => (s.name.startsWith("Fees") ? { ...s, value: ethText(s.value) } : s)),
  };
}

const advanceJson = (a: AdvanceRow): AdvanceJson => ({ kind: KIND_NAME[a.kind] ?? "pool", eth: eth(a.amount), feeEth: eth(a.fee), at: iso(a.at) });

export function jobJson(j: JobRow, advances: AdvanceRow[], title: string | undefined): JobJson {
  const state = (STATE_NAME[j.state] ?? "locked") as JobJson["state"];
  const closed = j.state >= STATE.settled;
  // one line for the bill: everything drawn, under the kind most of it came by
  let advance: AdvanceJson | undefined;
  if (advances.length) {
    const byKind = [0n, 0n, 0n];
    let total = 0n, fee = 0n;
    for (const a of advances) {
      byKind[a.kind] = (byKind[a.kind] ?? 0n) + BigInt(a.amount);
      total += BigInt(a.amount);
      fee += BigInt(a.fee);
    }
    const most = byKind.indexOf(byKind.reduce((m, v) => (v > m ? v : m), 0n));
    advance = { kind: KIND_NAME[most] ?? "pool", eth: eth(total), feeEth: eth(fee), at: iso(advances[0].at) };
  }
  return {
    id: pad(j.id), n: j.id, title: title ?? "", agentId: j.agent, customer: j.customer, priceEth: eth(j.price), state, lockedAt: iso(j.locked_at), dueAt: iso(j.due_at),
    allowEarly: !!j.allow_early, late: !!j.late,
    ...(j.delivered_at ? { deliveredAt: iso(j.delivered_at) } : {}),
    ...(closed && j.closed_at ? { settledAt: iso(j.closed_at) } : {}),
    ...(advance ? { advance } : {}),
    advances: advances.map(advanceJson),
    ...(j.state === STATE.settled || j.state === STATE.half ? { paidEth: eth(j.paid), feeEth: eth(j.fee) } : {}),
    ...(j.state === STATE.half || j.state === STATE.declined || j.state === STATE.refunded ? { backEth: eth(j.back) } : {}),
    ...(j.state === STATE.refunded && j.not_repaid !== "0" ? { notRepaidEth: eth(j.not_repaid) } : {}),
    tx: j.locked_tx,
  };
}

/** A line of the ledger in words. The wording is the site's (web/src/lib/sample.ts wrote the first ones). */
export function eventJson(l: LedgerRow, names: Names): EventJson {
  const who = nameOf(names, l.agent);
  let text = "";
  let amount = ethText(l.amount);
  switch (l.kind) {
    case "locked": text = "a customer locked the payment"; break;
    case "advanced": text = l.note === "customer" ? `${who} drew an advance its customer allowed` : l.note === "compute" ? `${who} had its compute paid from the pool` : `${who} drew an advance from the pool`; break;
    case "delivered": text = `${who} delivered${l.note === "late" ? " late" : ""}, waiting for the customer`; break;
    case "settled":
      if (l.note === "repaid") (text = `${who} delivered, the pool was repaid`), (amount = ethText(l.amount, "+"));
      else text = `${who} delivered and was paid`;
      break;
    case "half": text = "the customer rejected the delivery, the job settled at half"; break;
    case "declined": text = `${who} declined the job, the customer has it all back`; break;
    case "refunded": text = l.note === "drew" ? `${who} did not deliver in time, the customer was refunded` : "the job was not taken up, the customer has it all back"; break;
    case "not_repaid": {
      let parts = { fromBond: "0", lost: "0" };
      try { parts = { ...parts, ...JSON.parse(l.note) }; } catch { /* an old row */ }
      text = parts.lost === "0" ? `${who} did not deliver: its bond repaid the pool` : parts.fromBond === "0" ? `${who} did not deliver: the pool carried the advance` : `${who} did not deliver: its bond paid first, the pool the rest`;
      break;
    }
    case "burned": (text = "bought back and burned"), (amount = `${whole.format(Math.floor(tokens(BigInt(l.amount))))} $FACTOR`); break;
    case "bond": text = l.note === "taken" ? `${who} took bond out` : `${who} added to its bond`; break;
    case "pool_in": (text = l.note === "fees" ? "trading fees arrived in the pool" : "ETH was added to the pool"), (amount = ethText(l.amount, "+")); break;
    default: text = l.kind;
  }
  return { n: l.n, at: iso(l.at), kind: l.kind, ...(l.job_id !== null ? { jobId: pad(l.job_id) } : {}), ...(l.agent ? { agentId: l.agent } : {}), text, amount, tx: l.tx_hash };
}

export class EngineApi {
  private cache = new Map<string, { at: number; answer: Answer }>();
  // POSTs from one address, for the little a wallet's owner ever needs to send
  private posts = new Map<string, { n: number; from: number }>();

  constructor(private view: () => EngineView) {}

  // The answer for a path, or null when the path is not one of the engine's. `query` is what followed the ? in the
  // address; a value in it that makes no sense is ignored, never an error.
  async handle(path: string, query: URLSearchParams = new URLSearchParams()): Promise<Answer | null> {
    const route = this.route(path, query);
    if (!route) return null;
    const v = this.view();
    const ttl = v.config.params.apiCacheMs;
    const key = `${path}?${[...query.entries()].filter(([k]) => ["limit", "before", "show", "agent", "customer"].includes(k)).map(([k, x]) => `${k}=${x.slice(0, 64)}`).sort().join("&")}`;
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit && ttl > 0 && now - hit.at < ttl) return hit.answer;
    const answer = route(v);
    if (ttl > 0) {
      if (this.cache.size > 2000) this.cache.clear();
      this.cache.set(key, { at: now, answer });
    }
    return answer;
  }

  private route(path: string, query: URLSearchParams): ((v: EngineView) => Answer) | null {
    const whole_ = (name: string, most: number): number | undefined => { const raw = query.get(name); return raw && /^\d{1,9}$/.test(raw) ? Math.min(Number(raw), most) : undefined; };
    const limit = Math.max(1, whole_("limit", PAGE_MOST) ?? PAGE), before = whole_("before", 1e9);
    if (path === "/v1/state") return (v) => ok(this.state(v) as unknown as Record<string, unknown>);
    if (path === "/v1/health") return (v) => this.health(v);
    if (path === "/v1/burns") return (v) => ok(this.burns(v, limit, before));
    if (path === "/v1/agents") return (v) => ok({ items: this.agents(v) });
    if (path === "/v1/jobs") return (v) => ok(this.jobs(v, limit, before, normalizeAddress(query.get("agent")) ?? undefined, normalizeAddress(query.get("customer")) ?? undefined));
    if (path === "/v1/ledger") return (v) => ok(this.ledger(v, limit, before, SHOW[query.get("show") ?? ""]));
    let m = /^\/v1\/agents\/([0-9a-zA-Z-]{3,42})$/.exec(path);
    if (m) return (v) => this.agent(v, m![1]);
    m = /^\/v1\/jobs\/(\d{1,9})$/.exec(path);
    if (m) return (v) => this.job(v, Number(m![1]));
    return null;
  }

  // A signed write. `from` is the caller's address on the network, for the limit on how many one may send.
  async post(path: string, body: unknown, from: string, adminKey?: string): Promise<Answer | null> {
    if (path !== "/v1/agents/profile" && path !== "/v1/jobs/title" && path !== "/v1/admin/hide") return null;
    const v = this.view();
    if (!v.profiles || v.state !== "running") return { status: 503, body: { error: "the engine is not reading the chain yet" } };
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "the body is not a JSON object" } };
    const b = body as Record<string, unknown>;
    if (path === "/v1/admin/hide") {
      const want = v.config.adminKey;
      if (!want || !adminKey || adminKey.length !== want.length || adminKey !== want) return { status: 401, body: { error: "not the owner" } };
      const done = (b.what === "agent" || b.what === "job") && (typeof b.key === "string" || typeof b.key === "number") ? v.profiles.hide(b.what, String(b.key), b.hidden !== false) : false;
      this.cache.clear();
      return done ? ok({ ok: true }) : notFound("nothing by that key");
    }
    const now = Date.now();
    const seen = this.posts.get(from);
    if (!seen || now - seen.from > 60_000) this.posts.set(from, { n: 1, from: now });
    else if (++seen.n > 10) return { status: 429, body: { error: "too many requests: try again in a minute" } };
    if (this.posts.size > 5000) this.posts.clear();
    const r: Written = path === "/v1/agents/profile" ? await v.profiles.setProfile(b) : await v.profiles.setTitle(b);
    if (!r.ok) return { status: r.status, body: { error: r.error } };
    this.cache.clear();
    return ok({ ok: true });
  }

  // ---- what the answers are made of ----

  private names(v: EngineView): Names {
    return { profiles: v.profiles?.all() ?? new Map(), house: new Set(v.config.houseAgents) };
  }

  /** The chain's time now: the last block read, and the seconds since. */
  private chainNow(v: EngineView, snap: Snapshot | null): number {
    const now = v.now();
    return snap ? snap.blockTime + Math.max(0, Math.floor((now - snap.at) / 1000)) : Math.floor(now / 1000);
  }

  private running(v: EngineView): { ctx: Ctx; snap: Snapshot; store: DeskStore } | null {
    if (v.state !== "running" || !v.ctx) return null;
    const snap = snapshotOf(v.ctx.db);
    return snap ? { ctx: v.ctx, snap, store: new DeskStore(v.ctx.db) } : null;
  }

  private agents(v: EngineView): AgentJson[] {
    const r = this.running(v);
    if (!r) return [];
    const names = this.names(v);
    const t = this.chainNow(v, r.snap);
    return r.store.agents().map((a) => agentJson(a, names, t)).sort((a, b) => b.score - a.score || b.settled - a.settled || (a.since < b.since ? -1 : 1));
  }

  private jobsJson(v: EngineView, store: DeskStore, rows: JobRow[]): JobJson[] {
    const ids = rows.map((j) => j.id);
    const advances = store.advancesOf(ids);
    const titles = v.profiles?.titles(ids) ?? new Map<number, string>();
    return rows.map((j) => jobJson(j, advances.get(j.id) ?? [], titles.get(j.id)));
  }

  private jobs(v: EngineView, limit: number, before?: number, agent?: string, customer?: string): Record<string, unknown> {
    const r = this.running(v);
    if (!r) return { total: 0, more: false, items: [] };
    const rows = r.store.jobs(limit + 1, before, agent, customer);
    return { total: r.store.jobCount(), more: rows.length > limit, items: this.jobsJson(v, r.store, rows.slice(0, limit)) };
  }

  private ledger(v: EngineView, limit: number, before?: number, kinds?: string[]): Record<string, unknown> {
    const r = this.running(v);
    if (!r) return { total: 0, more: false, items: [] };
    const names = this.names(v);
    const rows = r.store.ledger(limit + 1, { before, kinds });
    return { total: r.store.ledgerCount(kinds), more: rows.length > limit, items: rows.slice(0, limit).map((l) => eventJson(l, names)) };
  }

  private agent(v: EngineView, idOrName: string): Answer {
    const r = this.running(v);
    if (!r) return notFound("no such agent");
    const address = normalizeAddress(idOrName) ?? v.profiles?.byName(idOrName) ?? null;
    const row = address ? r.store.agent(address) : null;
    if (!row) return notFound("no such agent");
    const names = this.names(v);
    return ok({
      agent: agentJson(row, names, this.chainNow(v, r.snap)),
      jobs: this.jobsJson(v, r.store, r.store.jobs(PAGE, undefined, row.address)),
      events: r.store.ledger(30, { agent: row.address }).map((l) => eventJson(l, names)),
    });
  }

  private job(v: EngineView, id: number): Answer {
    const r = this.running(v);
    const row = r?.store.job(id);
    if (!r || !row) return notFound("no such job");
    const names = this.names(v);
    const agent = r.store.agent(row.agent);
    return ok({
      job: this.jobsJson(v, r.store, [row])[0],
      agent: agent ? agentJson(agent, names, this.chainNow(v, r.snap)) : null,
      events: r.store.ledger(50, { jobId: id }).map((l) => eventJson(l, names)),
    });
  }

  /** One page of the burns, newest first, each with the burn pot's own number for it. */
  private burns(v: EngineView, limit: number, before?: number): Record<string, unknown> {
    const r = this.running(v);
    if (!r?.snap.token) return { total: 0, more: false, items: [] };
    const rows = r.ctx.db.burns(limit + 1, before);
    return { total: r.snap.burnPot.burnCount, more: rows.length > limit, items: rows.slice(0, limit).map((b): BurnJson => ({ n: b.n, at: iso(b.at), eth: eth(b.eth_in), tokens: tokens(BigInt(b.tokens_burned)), tx: b.tx_hash })) };
  }

  state(v: EngineView): FactorState {
    const c = v.config;
    const r = this.running(v);
    const contracts = { desk: v.ctx?.addr.desk ?? c.desk, splitter: v.ctx?.addr.splitter ?? c.splitter, burnPot: v.ctx?.addr.burnPot ?? c.burnPot, token: r?.snap.token?.address ?? null, explorer: c.explorer };
    // Where the token is bought: the address the owner set, or, once there is a token and nothing was set, the
    // token's own page on Pons. So the site's buy button works from the launch on whether or not anybody remembered.
    const links = { ...v.links, pons: v.links.pons ?? (contracts.token ? `https://ponsfamily.com/launchpad/${getAddress(contracts.token)}` : null) };
    const base = { source: "engine" as const, asOf: new Date(v.now()).toISOString(), links, params: PARAMS, contracts };
    if (!r) {
      return { ...base, launched: false, stats: { advancedEth: 0, settledJobs: 0, jobs: 0, poolEth: 0, reserveEth: 0, outEth: 0, heldEth: 0, burnedTokens: 0, supplyLeft: SUPPLY, agents: 0, lostEth: 0 }, agents: [], jobs: [], events: [], burns: [] };
    }
    const { ctx, snap, store } = r;
    const names = this.names(v);
    // What was minted is read from the token's own mint; what is burned is that less the supply the token reports
    // now, so it counts every burn there has been. Nothing here adds burns up.
    let burned = 0n, supply = BigInt(SUPPLY) * 10n ** 18n;
    if (snap.token) {
      const mints = ctx.db.events("token", "Transfer");
      const minted = mints.length ? mints.reduce((s, e) => s + BigInt(String(e.args.value)), 0n) : supply;
      supply = BigInt(snap.token.totalSupply);
      burned = minted > supply ? minted - supply : 0n;
    }
    const d = snap.desk;
    const poolAll = BigInt(d.pool) + BigInt(d.out);
    return {
      ...base,
      launched: !!snap.token,
      stats: {
        advancedEth: eth(d.totalAdvanced), settledJobs: store.countByState(STATE.settled), jobs: d.jobCount, poolEth: eth(poolAll), reserveEth: eth((poolAll * BigInt(RULES.reserveMinPct)) / 100n),
        outEth: eth(d.out), heldEth: eth(d.held), burnedTokens: tokens(burned), supplyLeft: tokens(supply), agents: store.agentCount(), lostEth: eth(d.totalLost),
      },
      agents: this.agents(v).slice(0, STATE_AGENTS),
      jobs: this.jobsJson(v, store, store.jobs(STATE_JOBS)),
      events: store.ledger(STATE_EVENTS).map((l) => eventJson(l, names)),
      burns: ctx.db.burns(STATE_BURNS).map((b): BurnJson => ({ n: b.n, at: iso(b.at), eth: eth(b.eth_in), tokens: tokens(BigInt(b.tokens_burned)), tx: b.tx_hash })),
    };
  }

  private health(v: EngineView): Answer {
    const c = v.config;
    const now = v.now();
    const base = { mode: c.mode, state: v.state, launched: false, problems: v.problems, warnings: v.warnings, lastError: v.lastError };
    if (!v.ctx) return ok(base);
    const { ctx } = v;
    const snap: Snapshot | null = snapshotOf(ctx.db);
    const store = new DeskStore(ctx.db);
    const warnings = [...v.warnings];
    const watchers = ctx.db.cursors().map((w) => ({ watcher: w.watcher, cursor: w.block, behindBlocks: snap ? Math.max(0, snap.block - w.block) : null, updatedAt: w.updated_at }));
    const actions: Record<string, unknown> = {};
    for (const kind of KINDS) {
      const st = actState(ctx, kind);
      const last = ctx.db.lastAction(kind);
      actions[kind] = {
        result: st.result,
        resultAt: st.resultAt || null,
        failuresInARow: st.fails,
        retryAt: st.nextAt || null,
        lastSentAt: st.lastAt || null, // the chain's time
        last: last ? { id: last.id, ref: last.ref, status: last.status, mode: last.mode, tx: last.tx_hash, error: last.error, at: last.updated_at } : null,
        done: ctx.db.countActions(kind, "done"),
        failed: ctx.db.countActions(kind, "failed"),
      };
    }
    const gas = snap?.bot ? BigInt(snap.bot.balance) : null;
    if (gas !== null && gas < ctx.params.botGasWarnWei) warnings.push(`the gas wallet is low: ${snap!.bot!.balance} wei`);
    if (snap && (snap.splitter.adminPending !== "0" || snap.splitter.burnPending !== "0" || snap.splitter.poolPending !== "0")) warnings.push("the splitter holds a share a destination refused: splitter.retry() delivers it (anyone can call it)");
    // the desk's four parts against what it really holds: less than their sum would be a fault in the desk itself
    if (snap) {
      const books = BigInt(snap.desk.pool) + BigInt(snap.desk.held) + BigInt(snap.desk.bonds) + BigInt(snap.desk.owedTotal);
      if (BigInt(snap.desk.balance) < books) warnings.push(`THE DESK HOLDS LESS THAN ITS BOOKS SAY: ${snap.desk.balance} wei against ${books} wei`);
    }
    // the names and titles people signed live only in the database: on a host, a path that is not a volume is wiped by a redeploy
    if (c.mode === "live" && !v.dataDirSet && !c.rehearsalClock) warnings.push("FACTOR_DATA_DIR is not set: the database is in the working folder. On a host, attach a volume and point FACTOR_DATA_DIR at it BEFORE the launch, or a redeploy loses the names agents signed.");
    const open = ctx.db.openActions();
    const t = snap ? snap.blockTime + Math.max(0, Math.floor((now - snap.at) / 1000)) : Math.floor(now / 1000);
    return ok({
      ...base,
      launched: !!snap?.token,
      warnings,
      chain: snap ? { block: snap.block, blockTime: snap.blockTime, readAt: snap.at, secondsSinceRead: Math.max(0, Math.round((now - snap.at) / 1000)) } : null,
      token: snap?.token?.address ?? null,
      phase: snap?.phase ?? null,
      contracts: ctx.addr,
      gateway: ctx.facts.gateway,
      deployBlock: Number(ctx.deployBlock),
      watchers,
      loops: v.loops,
      actions,
      onTheirWay: open.map((a) => ({ id: a.id, kind: a.kind, ref: a.ref, status: a.status, tx: a.tx_hash, nonce: a.nonce, since: a.updated_at })),
      locks: ctx.db.locks().map((k) => ({ name: k.name, takenAt: k.taken_at, expiresAt: k.expires_at })),
      // the address only: the key is never in any answer
      gasWallet: snap?.bot ? { address: snap.bot.address, wei: snap.bot.balance, low: gas !== null && gas < ctx.params.botGasWarnWei } : null,
      splitter: snap?.splitter ?? null,
      burnPot: snap?.burnPot ?? null,
      desk: snap ? { ...snap.desk, agents: store.agentCount(), jobsKnown: store.jobCount(), waitingToBeRead: ctx.db.count("desk_jobs") ? (ctx.db.q("SELECT (SELECT COUNT(*) FROM desk_jobs WHERE dirty = 1) + (SELECT COUNT(*) FROM desk_agents WHERE dirty = 1) AS n").get() as { n: number }).n : 0, dueToSettle: store.dueToSettle(t, 500).length, dueToRefund: store.dueToRefund(t, 500).length } : null,
      ethUsd8: snap?.ethUsd8 ?? null,
      rpc: v.rpc ? { ...v.rpc, lastError: v.rpc.lastError ? hostsOnly(v.rpc.lastError) : null } : null,
      events: ctx.db.count("chain_events"),
      ledger: ctx.db.count("ledger"),
    });
  }
}
