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
import type { Accounts } from "./accounts.js";
import type { Gateway } from "./compute.js";
import { keccak256, toHex } from "viem";
import type { Demo } from "./house/demo.js";
import { hostedMessage, INSTRUCTIONS_LEAST, INSTRUCTIONS_MOST } from "./house/hosted.js";
import type { House } from "./house/house.js";
import { SERVICES } from "./house/services.js";
import { timingSafeEqual } from "node:crypto";
import { allStopped, isSwitch, SWITCHES, stopped, turn } from "./switches.js";
import { DeskStore, KIND_NAME, RULES, STATE, STATE_NAME, type AdvanceRow, type AgentRecord, type AgentRow, type JobRow, type LedgerRow } from "./desk.js";
import { briefText, oneLine, Profiles, type Profile, type Written } from "./profiles.js";
import { canDrawOf, limitOf, scoreOf, scoreParts } from "./score.js";
import type { Pulse } from "./pulse.js";
import { ethOf, type DeskMind, type Facts, type Note } from "./deskmind.js";
import type { LaunchList } from "./launchlist.js";
import type { HouseActivity } from "./activity.js";
import type { Matcher } from "./match.js";
import { signerOf } from "./profiles.js";
import type { Pay } from "./pay.js";
import { recordOf, type RecordSigner } from "./record.js";

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
  gateway: Gateway | null;
  accounts: Accounts | null;
  house: House | null;
  demo: Demo | null;
  pulse?: Pulse | null;
  deskMind?: DeskMind | null;
  launchList?: LaunchList | null;
  activity?: HouseActivity | null;
  /** "just say what you need" (./match.ts) */
  matcher?: Matcher | null;
  /** Pay with Factor (./pay.ts) */
  pay?: Pay | null;
  /** the key that signs agents' records (./record.ts) */
  recordSigner?: RecordSigner | null;
}

// ---- the site's shape: web/src/lib/types.ts. Keep the two in step by hand. ----

/** A note of the Desk's (./deskmind.ts), as the site shows it. `worded`: written by the model, checked against its facts. */
export interface NoteJson { kind: string; subject: string; text: string; at: string; worded: boolean }
export interface DeskJson { on: boolean; writing: boolean; letter: NoteJson | null; latest: NoteJson[] }
export const noteJson = (n: Note): NoteJson => ({ kind: n.kind, subject: n.subject, text: n.text, at: new Date(n.at).toISOString(), worded: !!n.model });

const lowerFirst = (s: string) => (/^[A-Z][a-z ]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/** An agent's credit file in figures: its record, its bond and fees, and so its limit, what is free and its score. */
export function fileFacts(name: string, rec: AgentRecord, nowS: number): Facts {
  return {
    agent: name, barred: rec.barred, jobsSettled: rec.settled, differentCustomers: rec.customers, deliveredOnTime: rec.onTime, deliveredLate: rec.late,
    settledAtHalf: rec.settledAtHalf, notDelivered: rec.notDelivered, advancesRepaid: rec.advancesRepaid, advancesNotRepaid: rec.advancesNotRepaid,
    bondEth: ethOf(rec.bond), feesPaidInEth: ethOf(rec.feesPaid), limitWithPoolEth: ethOf(limitOf(rec)), freeToDrawNowEth: ethOf(canDrawOf(rec)), scoreOutOf1000: scoreOf(rec, nowS),
  };
}

/** One reading of the chain: the newest block when it was read, and the gas price then (./pulse.ts). */
export interface PulseJson { block: number; gwei: number | null; at: string }

/** The newest readings, newest first. Empty when the engine reads no chain. */
export const pulseJson = (v: EngineView, limit: number): PulseJson[] => (v.pulse?.latest(limit) ?? []).map((b) => ({ block: b.block, gwei: b.gwei, at: new Date(b.at).toISOString() }));

export interface AdvanceJson { kind: "customer" | "pool" | "compute"; eth: number; feeEth: number; at: string }
export interface JobJson {
  /** a demonstration: the customer is Factor's own. Said on the ledger's line and on the job's page */
  demo?: boolean;
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
  /** locked through a Pay with Factor link: how it was paid, and what the buyer added to the burn beside it */
  deal?: { via: string; burnEth: number };
}
export interface AgentJson {
  /** the Desk's credit file on it, newest */
  file?: { text: string; at: string };
  id: string; // its address: what the site's links carry
  name: string;
  named: boolean; // false: the name is only its address, shortened
  /** made on the site and run by Factor for whoever made it: said wherever it shows */
  hosted?: boolean;
  owner?: string;
  address: string;
  house: boolean;
  /** for one of Factor's own agents: what to put in the brief, what comes back, and the least it takes a job for */
  service?: { needs: string; delivers: string; fromEth: number };
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
export interface EventJson { n: number; at: string; kind: string; jobId?: string; agentId?: string; text: string; amount: string; tx: string; demo?: boolean; /** the Desk's reason for an advance */ why?: string }
export interface BurnJson { n: number; at: string; eth: number; tokens: number; tx: string }
export interface BurnPotJson {
  potEth: number;          // what the pot holds now
  nextEth: number;         // what the next burn would spend
  nextAt: string | null;   // the earliest it may go; null while the pot is empty
  ready: boolean;          // a burn would go through right now
  open: boolean;           // the market takes a buy right now
  count: number;
  ethSpent: number;        // all the ETH burns have spent
  lastAt: string | null;
  everyMin: number;        // the least time between two burns
  smallestEth: number;     // a smaller burn waits, at most a day
  /** whether $FACTOR has left Pons' curve for its pool: from then on Pons releases the fees in batches */
  bonded: boolean;
  /** when trading fees last arrived and were split, so a quiet pot reads as waiting and not as stopped */
  lastFeesAt: string | null;
}
export interface FactorState {
  source: "engine";
  asOf: string;
  launched: boolean;
  links: { pons: string | null; github: string | null; x: string | null };
  stats: { advancedEth: number; settledJobs: number; jobs: number; poolEth: number; reserveEth: number; outEth: number; heldEth: number; burnedTokens: number; supplyLeft: number; agents: number; demoJobs: number; lostEth: number; poolFromTradingEth: number };
  /** the burn pot as the chain has it: what it holds, when the next burn may go, what it would spend. Null before the launch. */
  burn: BurnPotJson | null;
  params: { advanceMaxPct: number; advanceFeePct: number; jobFeePct: number; graceHours: number; reviewHours: number; rejectedPct: number; reserveMinPct: number; minJobEth: number };
  agents: AgentJson[];
  jobs: JobJson[];
  events: EventJson[];
  burns: BurnJson[];
  contracts: { desk: string | null; splitter: string | null; burnPot: string | null; token: string | null; explorer: string };
  /** compute credit: whether an advance drawn "as compute" can be spent on models yet, and what they cost here */
  compute: { enabled: boolean; markupPct: number; maxTokens: number; models: { id: string; inUsd: number; outUsd: number }[]; router: { enabled: boolean; models: number }; limits: { callUsd: number; agentDayUsd: number } };
  /** accounts for people without a wallet: whether one can be made and used right now, and what makes them */
  accounts: { enabled: boolean; factory: string | null; ordersPerDay: number };
  /** set while the owner has paused new jobs: why, in a line. The site and the kit then lock nothing. */
  paused: string | null;
  /** Factor's own agents, whether or not they are on the desk yet: what each does and takes a job for */
  roster: RosterJson[];
  /** whether somebody can make an agent on the site right now, how many one address may have, and the least a job of one costs */
  hosted: { enabled: boolean; perOwner: number; fromEth: number; beforeLaunch?: boolean };
  /** agents signed up for the launch, before it (./launchlist.ts) */
  signups: { total: number; latest: { kind: string; name: string; does: string; at: string; priceEth?: number; address?: string }[] };
  /** Factor's own agents at work before the launch (./activity.ts) */
  activity: { n: number; at: string; agent: string; kind: string; text: string }[];
  /** the newest blocks the engine read, newest first: what the receipt prints between the ledger's lines */
  pulse: PulseJson[];
  /** the Desk: its last letter and newest notes */
  desk: DeskJson;
  /** Pay with Factor: whether links are taken, what a deal adds to the burn (hundredths of a percent of its price), and the deals so far */
  pay: { enabled: boolean; burnBps: number; deals: number; burnedEth: number };
}
export interface RosterJson { name: string; does: string; needs: string; delivers: string; fromEth: number; asksAModel: boolean; /** the Desk's opening file on it */ file?: { text: string; at: string } }
// what Factor's own agents are, said the same before the launch and after it
const ROSTER: RosterJson[] = SERVICES.map((s) => ({ name: s.name, does: s.does, needs: s.needs, delivers: s.delivers, fromEth: Number(s.floorWei / 10n ** 12n) / 1e6, asksAModel: !!s.ask }));

// The burn pot's own figures, read from the chain (FactorBurnPot's preview, market and totals); nothing worked out here.
function burnPotJson(b: Snapshot["burnPot"], lastFeesAt: number | null): BurnPotJson {
  return {
    bonded: b.open && !b.viaCurve, lastFeesAt: lastFeesAt ? new Date(lastFeesAt * 1000).toISOString() : null,
    potEth: eth(b.balance), nextEth: eth(b.nextAmount), nextAt: b.nextAt ? new Date(b.nextAt * 1000).toISOString() : null, ready: b.ready, open: b.open,
    count: b.burnCount, ethSpent: eth(b.totalEthBurned), lastAt: b.lastBurnAt ? new Date(b.lastBurnAt * 1000).toISOString() : null, everyMin: 30, smallestEth: 0.001,
  };
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
  /** the Desk's newest note of a kind about a subject, when there is a Desk (./deskmind.ts) */
  desk?: (kind: "file" | "reason", subject: string) => { text: string; at: string } | null;
  profiles: Map<string, Profile>;
  house: Set<string>;
  /** agents made on the site, by address: who made each */
  hosted?: Map<string, string>;
  /** the jobs that are demonstrations */
  demoJobs?: Set<number>;
  service?: (address: string) => AgentJson["service"] | null;
}
const nameOf = (names: Names, address: string | null): string => (address ? (names.profiles.get(address)?.name ?? shortAddress(address)) : "an agent");

export function agentJson(row: AgentRow, names: Names, nowS: number): AgentJson {
  const r = row.record;
  const p = names.profiles.get(row.address);
  return {
    id: row.address, name: p?.name ?? shortAddress(row.address), named: !!p, address: row.address, house: names.house.has(row.address), does: p?.does ?? "", since: iso(row.registered_at),
    ...(names.hosted?.has(row.address) ? { hosted: true, owner: names.hosted.get(row.address)! } : {}),
    ...(names.service?.(row.address) ? { service: names.service(row.address)! } : {}),
    settled: r.settled, settledAtHalf: r.settledAtHalf, notDelivered: r.notDelivered, unanswered: r.unanswered, customers: r.customers,
    onTimePct: r.settled ? Math.round((r.onTime * 100) / r.settled) : 0,
    volumeEth: eth(r.volume), feesPaidEth: eth(r.feesPaid), bondEth: eth(r.bond), drawnEth: eth(r.advancedNow), limitEth: eth(limitOf(r)), canDrawEth: eth(canDrawOf(r)),
    advancesRepaid: r.advancesRepaid, advancesMissed: r.advancesNotRepaid + r.earlyKept, barred: r.barred, score: scoreOf(r, nowS),
    scoreParts: scoreParts(r, nowS).map((s) => (s.name.startsWith("Fees") ? { ...s, value: ethText(s.value) } : s)),
    ...(names.desk?.("file", row.address) ? { file: names.desk("file", row.address)! } : {}),
  };
}

const advanceJson = (a: AdvanceRow): AdvanceJson => ({ kind: KIND_NAME[a.kind] ?? "pool", eth: eth(a.amount), feeEth: eth(a.fee), at: iso(a.at) });

export function jobJson(j: JobRow, advances: AdvanceRow[], title: string | undefined, demo = false, deal?: { via: string; burn_wei: string }): JobJson {
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
    ...(demo ? { demo: true } : {}),
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
    ...(deal ? { deal: { via: deal.via, burnEth: eth(deal.burn_wei) } } : {}),
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
    case "pool_in": (text = l.note === "fees" ? "trading fees arrived in the pool" : l.note === "compute" ? "compute credit nobody spent went back to the pool" : "ETH was added to the pool"), (amount = ethText(l.amount, "+")); break;
    default: text = l.kind;
  }
  const why = l.kind === "advanced" ? names.desk?.("reason", `${l.tx_hash}:${l.log_index}`)?.text : undefined;
  return { n: l.n, at: iso(l.at), kind: l.kind, ...(l.job_id !== null ? { jobId: pad(l.job_id) } : {}), ...(l.agent ? { agentId: l.agent } : {}), text, amount, tx: l.tx_hash, ...(l.job_id !== null && names.demoJobs?.has(l.job_id) ? { demo: true } : {}), ...(why ? { why } : {}) };
}

export class EngineApi {
  private cache = new Map<string, { at: number; answer: Answer }>();
  // POSTs from one address, for the little a wallet's owner ever needs to send
  private posts = new Map<string, { n: number; from: number }>();

  constructor(private view: () => EngineView) {}

  // The answer for a path, or null when the path is not one of the engine's. `query` is what followed the ? in the
  // address; a value in it that makes no sense is ignored, never an error.
  async handle(path: string, query: URLSearchParams = new URLSearchParams(), from = ""): Promise<Answer | null> {
    // accounts are asked about as they change (an order on its way): never answered from the cache
    if (path.startsWith("/v1/accounts/")) {
      // what an account holds is asked of the chain: one caller gets a few a second, not as many as it likes
      if (from && this.tooMany(from, "get", 300)) return { status: 429, body: { error: "too many requests: try again in a minute" } };
      return this.accountsGet(path);
    }
    // Pay with Factor's links and an agent's record: read, and checked against the chain when a link is signed by an
    // account, so they are kept for a few seconds like the rest and a caller gets a few hundred a minute
    if (path.startsWith("/v1/pay/") || path.startsWith("/v1/record/")) {
      if (from && this.tooMany(from, "pay-get", 600)) return { status: 429, body: { error: "too many requests: try again in a minute" } };
      const v = this.view();
      const ttl = v.config.params.apiCacheMs;
      const hit = this.cache.get(path);
      if (hit && ttl > 0 && Date.now() - hit.at < ttl) return hit.answer;
      const answer = await this.payGet(v, path);
      if (answer && ttl > 0) {
        if (this.cache.size > 2000) this.cache.clear();
        this.cache.set(path, { at: Date.now(), answer });
      }
      return answer;
    }
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
    if (path === "/v1/pulse") return (v) => ok({ items: pulseJson(v, 12) });
    if (path === "/v1/desk") return (v) => ok({ ...this.deskJson(v), items: v.deskMind?.recent(Math.min(limit, 100)).map(noteJson) ?? [] });
    if (path === "/v1/health") return (v) => this.health(v);
    if (path === "/v1/burns") return (v) => ok(this.burns(v, limit, before));
    if (path === "/v1/agents") return (v) => ok({ items: this.agents(v) });
    if (path === "/v1/jobs") return (v) => ok(this.jobs(v, limit, before, normalizeAddress(query.get("agent")) ?? undefined, normalizeAddress(query.get("customer")) ?? undefined));
    if (path === "/v1/ledger") return (v) => ok(this.ledger(v, limit, before, SHOW[query.get("show") ?? ""]));
    let m = /^\/v1\/agents\/made\/(0x[0-9a-fA-F]{40})$/.exec(path);
    if (m) return (v) => (v.house && v.state === "running" ? ok({ enabled: !!v.house.cfg.hosted.enabled, items: v.house.madeBy(m![1]!.toLowerCase()) }) : ok({ enabled: !!v.launchList, beforeLaunch: true, items: v.launchList?.madeBy(m![1]!.toLowerCase()) ?? [] }));
    m = /^\/v1\/agents\/([0-9a-zA-Z-]{3,42})$/.exec(path);
    if (m) return (v) => this.agent(v, m![1]);
    m = /^\/v1\/jobs\/(\d{1,9})$/.exec(path);
    if (m) return (v) => this.job(v, Number(m![1]));
    return null;
  }

  // What an account holds, the account of a passkey, how an order went.
  private async accountsGet(path: string): Promise<Answer | null> {
    const v = this.view();
    const a = v.accounts;
    if (!a || v.state !== "running") return { status: 503, body: { error: "the engine is not reading the chain yet" } };
    let m = /^\/v1\/accounts\/relay\/(0x[0-9a-f]{64})$/.exec(path);
    if (m) { const r = a.status(m[1]!); return r ? ok(r) : notFound("no such order"); }
    m = /^\/v1\/accounts\/by-credential\/(0x[0-9a-f]{2,2046})$/.exec(path);
    if (m) { const r = a.byCredential(m[1]!); return r ? ok(r) : notFound("no account is known for that passkey"); }
    m = /^\/v1\/accounts\/(0x[0-9a-fA-F]{40})$/.exec(path);
    if (m) { const r = await a.account(m[1]!.toLowerCase()); return r ? ok(r) : notFound("that is not an account made here"); }
    return null;
  }

  // A link, the links an agent shows, an agent's record, and the key that signs records.
  private async payGet(v: EngineView, path: string): Promise<Answer | null> {
    if (path === "/v1/record/signer") {
      return ok({ signer: v.recordSigner?.address ?? null, domain: { name: "Factor Record", version: "1", chainId: v.config.chainId, verifyingContract: v.ctx?.addr.desk ?? v.config.desk } });
    }
    const r = this.running(v);
    if (!r || !v.pay) return { status: 503, body: { error: "the engine is not reading the chain yet" } };
    let m = /^\/v1\/pay\/link\/([A-Za-z0-9_.-]{100,9000})$/.exec(path);
    if (m) { const a = await v.pay.info(m[1]!); return { status: a.status, body: a.body }; }
    m = /^\/v1\/pay\/links\/(0x[0-9a-fA-F]{40})$/.exec(path);
    if (m) return ok({ items: v.pay.linksOf(m[1]!.toLowerCase()) });
    m = /^\/v1\/record\/([0-9a-zA-Z-]{3,42})$/.exec(path);
    if (m) {
      const address = normalizeAddress(m[1]) ?? v.profiles?.byName(m[1]!) ?? null;
      const row = address ? r.store.agent(address) : null;
      if (!row) return notFound("no such agent: it has not registered on the desk");
      const p = v.profiles?.all().get(row.address);
      return ok(await recordOf({
        db: r.ctx.db, row, name: p?.name ?? shortAddress(row.address), named: !!p, does: p?.does ?? "", chainId: v.config.chainId, desk: r.ctx.addr.desk, block: r.snap.block,
        nowS: this.chainNow(v, r.snap), site: v.config.pay.site, pay: v.pay.store.totals(row.address), signer: v.recordSigner ?? null,
      }) as unknown as Record<string, unknown>);
    }
    return null;
  }

  // A job locked through a link, and a link an agent shows on its page.
  private async payPost(path: string, body: unknown, from: string): Promise<Answer> {
    const v = this.view();
    if (!v.pay || v.state !== "running") return { status: 503, body: { error: "the engine is not reading the chain yet" } };
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "the body is not a JSON object" } };
    if (this.tooMany(from, "pay", 60)) return { status: 429, body: { error: "too many requests: try again in a minute" } };
    const b = body as Record<string, unknown>;
    const a = path === "/v1/pay/deal" ? await v.pay.claim(b, b.via === "kit" ? "kit" : "checkout") : await v.pay.publish(b);
    if (a.status === 200) this.cache.clear();
    return a;
  }

  // One caller's requests of one kind in a minute: true when it is one too many.
  private tooMany(from: string, kind: string, most: number): boolean {
    const now = Date.now();
    const key = `${kind}:${from}`;
    const seen = this.posts.get(key);
    if (this.posts.size > 20_000) this.posts.clear();
    if (!seen || now - seen.from > 60_000) { this.posts.set(key, { n: 1, from: now }); return false; }
    return ++seen.n > most;
  }

  // "Just say what you need": the job in the customer's words, matched to an agent on the desk with a brief written
  // for it (./match.ts). Nothing is hired here: the customer locks the job themselves.
  private async matchPost(body: unknown, from: string): Promise<Answer> {
    const v = this.view();
    if (!v.matcher) return { status: 503, body: { error: "matching is not switched on" } };
    if (this.tooMany(from, "match", 8)) return { status: 429, body: { error: "too many requests: try again in a minute" } };
    const text = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).text : undefined;
    if (typeof text !== "string") return { status: 400, body: { error: "send { \"text\": \"what you need\" }" } };
    const candidates = this.agents(v).filter((a) => a.named && a.does.trim()).map((a) => ({ name: a.name, does: a.does, needs: a.service?.needs, fromEth: a.service?.fromEth ?? null }));
    const r = await v.matcher.match(text, candidates);
    return r.ok ? ok({ ...r.match, cached: r.cached }) : { status: r.status, body: { error: r.error } };
  }

  private async accountsPost(path: string, body: unknown, from: string): Promise<Answer | null> {
    const what = path.slice("/v1/accounts".length);
    if (what !== "" && what !== "/check" && what !== "/call" && what !== "/relay") return null;
    const v = this.view();
    const a = v.accounts;
    if (!a || v.state !== "running") return { status: 503, body: { error: "the engine is not reading the chain yet" } };
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "the body is not a JSON object" } };
    if (this.tooMany(from, what, what === "/call" || what === "/check" ? 240 : 30)) return { status: 429, body: { error: "too many requests: try again in a minute" } };
    const b = body as Record<string, unknown>;
    const r = what === "" ? await a.create(b, from) : what === "/check" ? await a.check(b) : what === "/call" ? await a.call(b) : await a.relay(b, from);
    if ("status" in r && "error" in r) return { status: r.status, body: { error: r.error, ...(r.refused ? { refused: r.refused } : {}) } };
    return ok(r as Record<string, unknown>);
  }

  // Somebody makes an agent on the site, or pauses one they made. Signed by the address it is made for: a wallet, or
  // an account without a wallet through one of its keys.
  private async hostedPost(path: string, body: unknown, from: string): Promise<Answer> {
    const v = this.view();
    const no = (status: number, error: string): Answer => ({ status, body: { error } });
    const before = !v.profiles || !v.house || v.state !== "running";
    if (before && !v.launchList) return no(503, "the engine is not reading the chain yet");
    if (!body || typeof body !== "object" || Array.isArray(body)) return no(400, "the body is not a JSON object");
    if (this.tooMany(from, "make", 6)) return no(429, "too many requests: try again in a minute");
    const b = body as Record<string, unknown>;
    // Before the launch an agent made here signs up for it (./launchlist.ts): signed the same way, on the desk at the launch.
    if (before) {
      const list = v.launchList!;
      if (path === "/v1/agents/make") { const r = await list.make(b); if (r.status === 200) this.cache.clear(); return r; }
      const owner = normalizeAddress(b.owner), name = typeof b.name === "string" ? b.name.trim() : "", at = Number(b.at);
      if (!owner || typeof b.paused !== "boolean" || !Number.isSafeInteger(at) || Math.abs(at - Math.floor(v.now() / 1000)) > 600) return no(400, "owner, name, paused and a fresh at are needed");
      if ((await signerOf(`Factor: ${b.paused ? "pause" : "resume"} my agent\nowner: ${owner}\nname: ${name}\nat: ${at}`, b.signature)) !== owner) return no(401, "the signature is not the owner's");
      this.cache.clear();
      return list.pause(owner, name, b.paused) ? ok({ ok: true }) : notFound("no agent of yours by that name");
    }
    const vp = v.profiles!, vh = v.house!;
    const owner = normalizeAddress(b.owner);
    if (!owner) return no(400, "owner is not an address");
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const at = vp.freshAt(b.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    if (path === "/v1/agents/pause") {
      if (typeof b.paused !== "boolean") return no(400, "paused is true or false");
      if (!(await vp.signed(owner, `Factor: ${b.paused ? "pause" : "resume"} my agent\nowner: ${owner}\nname: ${name}\nat: ${at}`, b.signature))) return no(401, "the signature is not the owner's");
      this.cache.clear();
      return vh.pause(owner, name, b.paused) ? ok({ ok: true }) : notFound("no agent of yours by that name");
    }
    const problem = vp.nameProblem(name);
    if (problem) return no(problem.startsWith("another") ? 409 : 400, problem);
    const does = oneLine(b.does, 12, 80);
    if (!does || does !== b.does) return no(400, "what it does is one plain line of 12 to 80 characters, without links, line breaks or double spaces");
    const instructions = briefText(b.instructions);
    if (!instructions || instructions !== b.instructions || instructions.length < INSTRUCTIONS_LEAST || instructions.length > INSTRUCTIONS_MOST) return no(400, `the instructions are plain text of ${INSTRUCTIONS_LEAST} to ${INSTRUCTIONS_MOST} characters`);
    if (typeof b.priceEth !== "string" || !/^\d{1,3}(\.\d{1,6})?$/.test(b.priceEth)) return no(400, "the price is ETH as a plain decimal, like 0.002");
    const [whole, frac = ""] = b.priceEth.split(".");
    const priceWei = BigInt(whole!) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
    const payout = b.payout === undefined || b.payout === "" ? owner : normalizeAddress(b.payout);
    if (!payout) return no(400, "payout is not an address");
    if (!(await vp.signed(owner, hostedMessage(owner, name, does, b.priceEth, payout, keccak256(toHex(instructions)), at), b.signature))) return no(401, "the signature is not the owner's");
    const made = vh.make({ owner, name, does, instructions, priceWei, payout });
    if (!made.ok) return no(made.status, made.error);
    this.cache.clear();
    return ok({ ok: true, name: made.name });
  }

  // A signed write. `from` is the caller's address on the network, for the limit on how many one may send.
  async post(path: string, body: unknown, from: string, adminKey?: string): Promise<Answer | null> {
    if (path === "/v1/match") return this.matchPost(body, from);
    if (path === "/v1/pay/deal" || path === "/v1/pay/links") return this.payPost(path, body, from);
    if (path === "/v1/accounts" || path.startsWith("/v1/accounts/")) return this.accountsPost(path, body, from);
    if (path === "/v1/agents/make" || path === "/v1/agents/pause") return this.hostedPost(path, body, from);
    if (path !== "/v1/agents/profile" && path !== "/v1/jobs/title" && path !== "/v1/jobs/brief" && path !== "/v1/jobs/delivery" && path !== "/v1/admin/hide" && path !== "/v1/admin/switch") return null;
    const v = this.view();
    if ((!v.profiles || v.state !== "running") && path === "/v1/agents/profile" && v.launchList && body && typeof body === "object" && !Array.isArray(body)) {
      if (this.tooMany(from, "make", 6)) return { status: 429, body: { error: "too many requests: try again in a minute" } };
      const r = await v.launchList.own(body as Record<string, unknown>);
      if (r.status === 200) this.cache.clear();
      return r;
    }
    if (!v.profiles || v.state !== "running") return { status: 503, body: { error: "the engine is not reading the chain yet" } };
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "the body is not a JSON object" } };
    const b = body as Record<string, unknown>;
    if (path === "/v1/admin/hide" || path === "/v1/admin/switch") {
      const want = v.config.adminKey;
      // compared in the same time whatever is sent, and tried a few times a minute at most from one place
      if (this.tooMany(from, "admin", 10)) return { status: 429, body: { error: "too many requests: try again in a minute" } };
      const given = Buffer.from(adminKey ?? ""), held = Buffer.from(want ?? "");
      if (!want || given.length !== held.length || !timingSafeEqual(given, held)) return { status: 401, body: { error: "not the owner" } };
    }
    if (path === "/v1/admin/switch") {
      // one of the owner's switches (./switches.ts): { "what": "accounts", "on": false, "note": "why" }
      if (!v.ctx) return { status: 503, body: { error: "the engine is not reading the chain yet" } };
      if (!isSwitch(b.what) || typeof b.on !== "boolean") return { status: 400, body: { error: `what is one of ${SWITCHES.join(", ")}, and on is true or false` } };
      turn(v.ctx.db, b.what, b.on, typeof b.note === "string" ? b.note : "");
      this.cache.clear();
      return ok({ ok: true, stopped: allStopped(v.ctx.db) });
    }
    if (path === "/v1/admin/hide") {
      const done = (b.what === "agent" || b.what === "job") && (typeof b.key === "string" || typeof b.key === "number") ? v.profiles.hide(b.what, String(b.key), b.hidden !== false) : false;
      this.cache.clear();
      return done ? ok({ ok: true }) : notFound("nothing by that key");
    }
    const now = Date.now();
    const seen = this.posts.get(from);
    if (!seen || now - seen.from > 60_000) this.posts.set(from, { n: 1, from: now });
    else if (++seen.n > 10) return { status: 429, body: { error: "too many requests: try again in a minute" } };
    if (this.posts.size > 5000) this.posts.clear();
    const r: Written = path === "/v1/agents/profile" ? await v.profiles.setProfile(b) : path === "/v1/jobs/brief" ? await v.profiles.setBrief(b) : path === "/v1/jobs/delivery" ? v.profiles.publish(b) : await v.profiles.setTitle(b);
    if (!r.ok) return { status: r.status, body: { error: r.error } };
    this.cache.clear();
    return ok({ ok: true });
  }

  // ---- what the answers are made of ----

  private names(v: EngineView): Names {
    const d = v.deskMind;
    return { desk: d ? (kind, subject) => { const n = d.latest(kind, subject); return n ? { text: n.text, at: new Date(n.at).toISOString() } : null; } : undefined, profiles: v.profiles?.all() ?? new Map(), house: new Set([...v.config.houseAgents, ...(v.house?.addresses() ?? [])]), hosted: v.house?.hostedAddresses() ?? new Map(), demoJobs: this.demoJobs(v), service: (a) => v.house?.serviceOf(a) ?? null };
  }

  /** The jobs whose customer is Factor's own demonstration customer (./house/demo.ts). */
  private demoJobs(v: EngineView): Set<number> {
    if (!v.ctx) return new Set();
    return new Set((v.ctx.db.q("SELECT job_id FROM demo_jobs WHERE job_id IS NOT NULL").all() as { job_id: number }[]).map((r) => r.job_id));
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
    const demo = this.demoJobs(v);
    const deals = v.pay?.store.deals(ids) ?? new Map();
    return rows.map((j) => jobJson(j, advances.get(j.id) ?? [], titles.get(j.id), demo.has(j.id), deals.get(j.id)));
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
    const work = v.profiles?.work(id) ?? null;
    const note = v.house?.note(id) ?? null;
    return ok({
      job: this.jobsJson(v, r.store, [row])[0],
      agent: agent ? agentJson(agent, names, this.chainNow(v, r.snap)) : null,
      events: r.store.ledger(50, { jobId: id }).map((l) => eventJson(l, names)),
      // what the customer asked for at length, the work when its agent showed it, and a house agent's reason for declining
      brief: v.profiles?.brief(id) ?? null,
      work: work ? { kind: work.kind, text: work.body, at: new Date(work.at).toISOString() } : null,
      ...(note ? { note } : {}),
    });
  }

  /** One page of the burns, newest first, each with the burn pot's own number for it. */
  private burns(v: EngineView, limit: number, before?: number): Record<string, unknown> {
    const r = this.running(v);
    if (!r?.snap.token) return { total: 0, more: false, items: [] };
    const rows = r.ctx.db.burns(limit + 1, before);
    return { total: r.snap.burnPot.burnCount, more: rows.length > limit, items: rows.slice(0, limit).map((b): BurnJson => ({ n: b.n, at: iso(b.at), eth: eth(b.eth_in), tokens: tokens(BigInt(b.tokens_burned)), tx: b.tx_hash })) };
  }

  /**
   * One pass of the Desk (./deskmind.ts): the notes that are due, a few at a time. Opening files for Factor's own
   * agents that have none; once the desk runs, a new credit file for an agent whose record changed (at most hourly),
   * a reason for every advance without one; and soon after midnight UTC, the letter on the day before.
   */
  async deskPass(v: EngineView, most = { openings: 3, files: 5, reasons: 10 }): Promise<number> {
    const d = v.deskMind;
    if (!d) return 0;
    let written = 0;
    // an opening file the model could not word (or written before there was a key) gets a new try once an hour
    // An opening file carries no figure at all (an agent with no record has none worth saying), so no number can get in.
    // It is written again when its facts change, and a plain one gets a new try once an hour while it can be worded.
    const openingFacts = (x: RosterJson): Facts => ({ agent: x.name, does: lowerFirst(x.does) });
    const due = (x: RosterJson) => {
      const n = d.latest("opening", x.name);
      if (!n || JSON.stringify(n.facts) !== JSON.stringify(openingFacts(x))) return true;
      return n.model === null && d.canWord() && v.now() - n.at > 3_600_000;
    };
    for (const a of ROSTER.filter(due).slice(0, most.openings)) {
      await d.write("opening", a.name, openingFacts(a));
      written++;
    }
    const r = this.running(v);
    if (r) {
      const names = this.names(v);
      const t = this.chainNow(v, r.snap);
      let files = 0;
      for (const row of r.store.agents()) {
        if (files >= most.files) break;
        const facts = fileFacts(nameOf(names, row.address), row.record, t);
        const last = d.latest("file", row.address);
        if (last && (JSON.stringify(last.facts) === JSON.stringify(facts) || v.now() - last.at < 3_600_000)) continue;
        await d.write("file", row.address, facts);
        files++; written++;
      }
      const advances = r.ctx.db.q("SELECT * FROM desk_advances ORDER BY block DESC, log_index DESC LIMIT 50").all() as AdvanceRow[];
      let reasons = 0;
      for (const a of advances) {
        if (reasons >= most.reasons) break;
        const subject = `${a.tx_hash}:${a.log_index}`;
        if (d.latest("reason", subject)) continue;
        const job = r.store.job(a.job_id), rec = r.store.agent(a.agent)?.record;
        await d.write("reason", subject, { agent: nameOf(names, a.agent), job: a.job_id, advanceFrom: KIND_NAME[a.kind] === "customer" ? "the customer's own locked payment, which the customer allowed" : KIND_NAME[a.kind] === "compute" ? "the pool, paid straight to compute" : "the pool", drawnEth: ethOf(a.amount), lockedByTheCustomerEth: job ? ethOf(job.price) : "0", agentLimitWithPoolEth: rec ? ethOf(limitOf(rec)) : "0" });
        reasons++; written++;
      }
    }
    const today = Math.floor(v.now() / 86_400_000) * 86_400_000;
    const yesterday = new Date(today - 86_400_000).toISOString().slice(0, 10);
    if (v.now() - today >= 5 * 60_000 && !d.latest("letter", yesterday)) {
      const facts = r ? this.dayFacts(r, yesterday, today) : this.chainDayFacts(v, yesterday);
      if (facts) { await d.write("letter", yesterday, facts); written++; }
    }
    return written;
  }

  /** Yesterday on the desk, from the ledger: what a letter after the launch may say. */
  private dayFacts(r: { ctx: Ctx; snap: Snapshot; store: DeskStore }, day: string, todayMs: number): Facts {
    const from = Math.floor((todayMs - 86_400_000) / 1000), to = Math.floor(todayMs / 1000);
    const rows = r.ctx.db.q("SELECT kind, amount FROM ledger WHERE at >= ? AND at < ?").all(from, to) as { kind: string; amount: string }[];
    const count = (k: string) => rows.filter((x) => x.kind === k).length;
    const advanced = rows.filter((x) => x.kind === "advanced").reduce((s, x) => s + BigInt(x.amount || "0"), 0n);
    const d = r.snap.desk;
    return { launched: true, day, locked: count("locked"), settled: count("settled") + count("half"), advances: count("advanced"), advancedEth: ethOf(advanced), burns: count("burned"), poolEth: ethOf(BigInt(d.pool) + BigInt(d.out)), outEth: ethOf(d.out) };
  }

  /** Yesterday on the chain, from the pulse: what a letter before the launch may say. Null until a whole day was read. */
  private chainDayFacts(v: EngineView, day: string): Facts | null {
    const y = v.pulse?.yesterday();
    if (!y || y.day !== day) return null;
    return { launched: false, day, firstBlock: y.firstBlock.toLocaleString("en-US"), lastBlock: y.lastBlock.toLocaleString("en-US"), gwei: y.gwei ?? 0 };
  }

  /** Factor's own agents, each with the Desk's opening file when it has written one. */
  private rosterJson(v: EngineView): RosterJson[] {
    const d = v.deskMind;
    return ROSTER.map((a) => { const n = d?.latest("opening", a.name); return n ? { ...a, file: { text: n.text, at: new Date(n.at).toISOString() } } : a; });
  }

  /** What the Desk says, for the site: its last letter, its newest notes, and whether it is writing right now. */
  deskJson(v: EngineView): DeskJson {
    const d = v.deskMind;
    if (!d) return { on: false, writing: false, letter: null, latest: [] };
    const letter = d.recent(1, ["letter"])[0] ?? null;
    return { on: true, writing: d.writing, letter: letter ? noteJson(letter) : null, latest: d.recent(8).map(noteJson) };
  }

  state(v: EngineView): FactorState {
    const c = v.config;
    const r = this.running(v);
    const contracts = { desk: v.ctx?.addr.desk ?? c.desk, splitter: v.ctx?.addr.splitter ?? c.splitter, burnPot: v.ctx?.addr.burnPot ?? c.burnPot, token: r?.snap.token?.address ?? null, explorer: c.explorer };
    // Where the token is bought: the address the owner set, or, once there is a token and nothing was set, the
    // token's own page on Pons. So the site's buy button works from the launch on whether or not anybody remembered.
    const links = { ...v.links, pons: v.links.pons ?? (contracts.token ? `https://ponsfamily.com/launchpad/${getAddress(contracts.token)}` : null) };
    const compute = v.gateway?.about() ?? { enabled: false, markupPct: 0, maxTokens: 0, models: [], router: { enabled: false, models: 0 }, limits: { callUsd: 0, agentDayUsd: 0 } };
    const accounts = v.accounts?.about() ?? { enabled: false, factory: null, ordersPerDay: 0 };
    const hiring = v.ctx ? stopped(v.ctx.db, "hiring") : null;
    const paused = hiring ? hiring.note || "New jobs are paused for now. Jobs already locked run as they were: the contract settles or refunds each one by itself." : null;
    const h = v.house?.cfg.hosted;
    const running = v.state === "running" && !!v.house;
    const hosted = running
      ? { enabled: !!h?.enabled && v.house!.canMake(), perOwner: h?.perOwner ?? 0, fromEth: h ? Number(h.floorWei / 10n ** 12n) / 1e6 : 0 }
      : { enabled: !!v.launchList, perOwner: v.launchList?.perOwner ?? 0, fromEth: v.launchList ? Number(v.launchList.floorWei / 10n ** 12n) / 1e6 : 0, beforeLaunch: true };
    const signups = v.launchList ? { total: v.launchList.total(), latest: v.launchList.list(8) } : { total: 0, latest: [] };
    const activity = (v.activity?.latest(8) ?? []).map((x) => ({ n: x.n, at: new Date(x.at).toISOString(), agent: x.agent, kind: x.kind, text: x.text }));
    const deals = v.pay?.store.all() ?? { deals: 0, burnedWei: 0n };
    const pay = { enabled: !!v.pay && c.pay.enabled && v.state === "running", burnBps: c.pay.burnBps, deals: deals.deals, burnedEth: eth(deals.burnedWei) };
    const base = { source: "engine" as const, asOf: new Date(v.now()).toISOString(), links, params: PARAMS, contracts, compute, accounts, paused, roster: this.rosterJson(v), hosted, pulse: pulseJson(v, 8), desk: this.deskJson(v), signups, activity, pay };
    if (!r) {
      return { ...base, launched: false, stats: { advancedEth: 0, settledJobs: 0, jobs: 0, poolEth: 0, reserveEth: 0, outEth: 0, heldEth: 0, burnedTokens: 0, supplyLeft: SUPPLY, agents: 0, demoJobs: 0, lostEth: 0, poolFromTradingEth: 0 }, burn: null, agents: [], jobs: [], events: [], burns: [] };
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
        outEth: eth(d.out), heldEth: eth(d.held), burnedTokens: tokens(burned), supplyLeft: tokens(supply), agents: store.agentCount(), demoJobs: this.demoJobs(v).size, lostEth: eth(d.totalLost),
        poolFromTradingEth: eth(snap.splitter.totalToPool),
      },
      burn: snap.token ? burnPotJson(snap.burnPot, ctx.db.splits(1)[0]?.at ?? null) : null,
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
      stopped: allStopped(ctx.db),
      house: v.house ? v.house.totals() : null,
      demo: v.demo ? v.demo.totals() : null,
      accounts: v.accounts ? { ...v.accounts.about(), note: c.accounts.note, ...v.accounts.store.totals(), gasDayWei: c.accounts.gasDayWei.toString() } : null,
      compute: v.gateway ? { ...v.gateway.about(), note: c.compute.note, ...v.gateway.store.totals(), todayMicro: v.gateway.store.spentToday(), dailyMicro: c.compute.dailyMicro, routerFloatUsd: v.gateway.float?.usd() ?? null } : null,
      rpc: v.rpc ? { ...v.rpc, lastError: v.rpc.lastError ? hostsOnly(v.rpc.lastError) : null } : null,
      events: ctx.db.count("chain_events"),
      ledger: ctx.db.count("ledger"),
    });
  }
}
