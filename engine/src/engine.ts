// The engine: Factor's hands on the chain and the feed the site reads. One process, one SQLite file. What it does
// on the chain is behind ENGINE_MODE:
//
//   off    (the default) nothing runs. No node is ever asked anything; the feed answers "not launched".
//   watch  reads the chain into the database. Sends nothing, simulates nothing.
//   dry    as watch, and for every action it would send: builds it, runs it against the chain without sending,
//          and writes down what it would have done.
//   live   as dry, and sends. Needs BOT_PRIVATE_KEY, the key of the wallet that pays the gas.
//
// At boot the configuration is checked, then the addresses against the node: a wrong address (no code there, or
// contracts not wired to each other, or a token that is not the burn pot's) stops the engine with one plain line.
// A node that does not answer is not a wrong address: the check is tried again.

import type Database from "better-sqlite3";
import type { Abi } from "viem";
import { factorAccountsAbi, factorBurnPotAbi, factorDeskAbi, factorSplitterAbi } from "./abi/index.js";
import { actPass, type ActResult } from "./chain/act.js";
import { normalizeAddress } from "./chain/address.js";
import { addressOfKey, hostsOnly, nodeBusy, reason, revertOf, viemChain, viemSigner, type Chain, type Signer } from "./chain/chain.js";
import { Accounts } from "./accounts.js";
import { ComputeStore, Gateway } from "./compute.js";
import { Demo } from "./house/demo.js";
import { House, houseSigner, takeHouseSeed, type HouseSigner } from "./house/house.js";
import { allStopped, stopFromEnv, stopped } from "./switches.js";
import { Profiles } from "./profiles.js";
import { configured, readConfig, takeBotKey, takeModelKey, takeRouterKey, type EngineConfig, type Env } from "./chain/config.js";
import type { Ctx } from "./chain/context.js";
import { EngineDb } from "./chain/db.js";
import { watchPass, type WatchResult } from "./chain/watch.js";
import { EngineApi, link, type Answer, type EngineView } from "./api.js";
import { Pulse, pulseOn } from "./pulse.js";
import { Live, livePushOn } from "./live.js";
import { DeskMind, anthropicWriter, deskOn } from "./deskmind.js";
import { LaunchList } from "./launchlist.js";
import { HouseActivity, activityOn, anthropicAsk } from "./activity.js";
import { Matcher, matchOn } from "./match.js";
import { DEFAULT_MODELS } from "./compute.js";
import { Pay } from "./pay.js";
import { Subjobs } from "./subjobs.js";
import { Firms, HOUSE_FIRM } from "./firms.js";
import { Plans } from "./plans.js";
import { OpenJobs } from "./openjobs.js";
import { recordSigner, type RecordSigner } from "./record.js";
import { Erc8004 } from "./erc8004.js";
import { sourceOf } from "./api.js";
import { snapshotOf } from "./chain/context.js";

export interface EngineOptions {
  env?: Env; // instead of process.env (tests)
  chain?: Chain; // instead of the node (tests)
  signer?: Signer | null; // instead of the key's wallet (tests)
  log?: (line: string) => void;
  now?: () => number; // the wall clock
  pollMs?: number; // how often a sent transaction's receipt is asked for
  manual?: boolean; // no loops: the caller runs each pass itself (tests)
  houseSigners?: (name: string) => HouseSigner; // instead of the keys made from the seed (tests)
}

const ZERO = "0x0000000000000000000000000000000000000000";
const BACKOFF_MAX_MS = 5 * 60_000;

// A wrong address: said once, and the engine stops. Anything else thrown while checking is the node not
// answering, and the check is tried again.
class Wrong extends Error {}

interface Loop {
  lastRunAt: number | null;
  lastOkAt: number | null;
  runs: number;
  failures: number;
  waitMs: number;
  backingOff: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  again: boolean; // a run was asked for while one was under way
  tick: () => void;
}

export class Engine {
  readonly config: EngineConfig;
  state: "off" | "stopped" | "starting" | "running" = "off";
  problems: string[] = [];
  warnings: string[] = [];
  lastError: { at: number; where: string; message: string } | null = null;
  ctx: Ctx | null = null;
  profiles: Profiles | null = null;
  gateway: Gateway | null = null;
  accounts: Accounts | null = null;
  house: House | null = null;
  demo: Demo | null = null;
  /** the newest blocks of the chain as the engine reads them, for the site's receipt (./pulse.ts) */
  pulse: Pulse | null = null;
  /** tells the site the moment what it shows has changed (./live.ts); null with LIVE_PUSH=off */
  live: Live | null = null;
  /** the Desk, Factor's own mind (./deskmind.ts) */
  deskMind: DeskMind | null = null;
  /** agents signed up before the launch (./launchlist.ts) */
  launchList: LaunchList;
  /** Factor's own agents at work before the launch (./activity.ts) */
  activity: HouseActivity | null = null;
  /** "just say what you need" (./match.ts): on whenever there is a model key, off with MATCH=off */
  matcher: Matcher | null = null;
  /** Pay with Factor (./pay.ts): payment links, deals and x402 */
  pay: Pay | null = null;
  /** agents that hire agents (./subjobs.ts): the link between a job and the jobs its agent locked for parts of it */
  subjobs: Subjobs | null = null;
  /** agent firms (./firms.ts): agents under one name with one shared record, hired through their lead */
  firms: Firms | null = null;
  /** monthly clients (./plans.ts): plans whose every month is an ordinary job on the desk */
  plans: Plans | null = null;
  /** ERC-8004 (./erc8004.ts): settled jobs written to the agents' reputation in the standard's registry */
  erc8004: Erc8004 | null = null;
  /** open jobs (./openjobs.ts): a customer posts a job, agents apply, and the price is locked for the one picked */
  openjobs: OpenJobs | null = null;
  /** the key that signs agents' records for other apps (./record.ts), or null */
  readonly recordSigner: RecordSigner | null;
  private carryTimer: ReturnType<typeof setInterval> | null = null;
  private deskTimer: ReturnType<typeof setInterval> | null = null;
  private deskBusy = false;
  private chain: (Chain & { stop?: () => void }) | null = null;
  private loops = new Map<string, Loop>();
  private stopped = false;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private booting: Promise<void> | null = null;
  private clockOffset = 0;
  private readonly api: EngineApi;
  private readonly env: Env;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(
    private sqlite: Database.Database,
    private opts: EngineOptions = {},
  ) {
    this.env = opts.env ?? process.env;
    this.config = readConfig(this.env);
    // on a rehearsal the engine's clock is the local fork's (see config.rehearsalClock); everywhere else the wall clock
    this.now = opts.now ?? (this.config.rehearsalClock ? () => Date.now() + this.clockOffset : Date.now);
    const print = opts.log ?? ((line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`));
    this.log = (line) => print(hostsOnly(line));
    this.api = new EngineApi(() => this.view());
    // the sign-ups are kept in the same file whatever the mode, so they are there at the launch
    this.recordSigner = recordSigner(this.env);
    this.launchList = new LaunchList(sqlite, { perOwner: this.config.house.hosted.perOwner, most: this.config.house.hosted.most, floorWei: this.config.house.hosted.floorWei, now: this.now });
  }

  /**
   * At the launch, the sign-ups are carried onto the desk: an agent made before it is made now, run by Factor like any
   * other (when making agents is on), and an agent with a wallet of its own gets the name its wallet signed.
   */
  carrySignups(): number {
    if (this.state !== "running" || !this.ctx || !this.house) return 0;
    let n = 0;
    for (const r of this.launchList.waiting()) {
      if (r.kind === "made") {
        if (!this.house.canMake()) continue;
        const made = this.house.make({ owner: r.owner, name: r.name, does: r.does, instructions: r.instructions ?? "", priceWei: BigInt(r.price_wei ?? "0"), payout: r.payout ?? r.owner });
        if (!made.ok && made.status !== 409) continue;
        if (made.ok && r.paused) this.house.pause(r.owner, r.name, true);
      } else {
        this.ctx.db.q("INSERT INTO agent_profiles (address, name, name_key, does, signed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(address) DO NOTHING").run(r.owner, r.name, r.name.toLowerCase(), r.does, r.signed_at);
      }
      this.launchList.carried(r.id);
      n++;
    }
    if (n) this.log(`[launch list] carried ${n} sign-up${n === 1 ? "" : "s"} onto the desk`);
    return n;
  }

  private view(): EngineView {
    const loops: EngineView["loops"] = {};
    for (const [name, l] of this.loops) loops[name] = { lastRunAt: l.lastRunAt, lastOkAt: l.lastOkAt, runs: l.runs, failures: l.failures, waitMs: l.waitMs, backingOff: l.backingOff };
    return {
      config: this.config, state: this.state, problems: this.problems, warnings: this.warnings, lastError: this.lastError, loops, ctx: this.ctx, rpc: this.chain?.health() ?? null, now: this.now,
      links: { pons: link(this.env.FACTOR_PONS_URL), github: link(this.env.FACTOR_GITHUB_URL), x: link(this.env.FACTOR_X_URL) }, dataDirSet: !!this.env.FACTOR_DATA_DIR?.trim(), profiles: this.profiles, gateway: this.gateway, accounts: this.accounts, house: this.house, demo: this.demo, pulse: this.pulse, deskMind: this.deskMind, launchList: this.launchList, activity: this.activity, matcher: this.matcher, pay: this.pay, subjobs: this.subjobs, recordSigner: this.recordSigner, firms: this.firms, plans: this.plans, erc8004: this.erc8004, openjobs: this.openjobs,
    };
  }

  // The answer to one of the engine's API routes, or null when the path is not one of them.
  handle(path: string, query?: URLSearchParams, from?: string): Promise<Answer | null> {
    return this.api.handle(path, query, from);
  }

  // Everything under /v1/compute/: the gateway answers the request itself (a model's answer may be a stream).
  // False when there is no gateway to answer, which is when the engine is not reading the chain.
  compute(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, path: string): boolean {
    if (!this.gateway || this.state !== "running") return false;
    void this.gateway.http(req, res, path);
    return true;
  }

  // A Pay with Factor link asked for over x402 (./pay.ts): the 402 that says how to pay, or, with the X-PAYMENT
  // header, the job the payment locked. `resource` is the address the caller asked, as the answer names it.
  async x402(path: string, payment: string | undefined, resource: string): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> }> {
    if (!this.pay || this.state !== "running") return { status: 503, headers: {}, body: { x402Version: 1, error: "the engine is not reading the chain yet" } };
    const m = /^\/v1\/x402\/([A-Za-z0-9_.-]{100,9000})$/.exec(path);
    if (!m) return { status: 404, headers: {}, body: { x402Version: 1, error: "not found" } };
    return this.pay.x402(m[1]!, payment, resource);
  }

  // The answer to a signed write (an agent's name, a job's title), or null when the path is not one.
  // A write that was taken is a change the site should show at once (./live.ts): asking a model to match a job, or
  // checking an order before it is sent, changes nothing.
  post(path: string, body: unknown, from: string, adminKey?: string): Promise<Answer | null> {
    return this.api.post(path, body, from, adminKey).then((a) => {
      if (a && a.status >= 200 && a.status < 300 && path !== "/v1/match" && path !== "/v1/accounts/check") this.live?.poke();
      return a;
    });
  }

  /** How many rows the database has had written since it opened: the live stream's cheap test for "maybe changed". */
  private writes(): number {
    this.writesQ ??= this.sqlite.prepare("SELECT total_changes() AS n");
    return (this.writesQ.get() as { n: number }).n;
  }
  private writesQ: Database.Statement | null = null;

  /** Counts of what a page shows beside the state (a job's brief, title and work; links; sub-jobs; months of plans; ERC-8004 links and entries). */
  private extraCounts(): string {
    const out: string[] = [];
    for (const t of ["job_titles", "job_briefs", "job_deliveries", "pay_links", "subjobs", "plan_months", "firm_members", "hosted_agents", "erc8004_links", "erc8004_entries", "open_jobs", "open_job_applications"]) {
      try {
        const r = this.sqlite.prepare(`SELECT COUNT(*) AS n, IFNULL(MAX(rowid), 0) AS m FROM ${t}`).get() as { n: number; m: number };
        out.push(`${r.n}:${r.m}`);
      } catch {
        out.push("-"); // not made yet: that part is not on
      }
    }
    return out.join(",");
  }

  // Start whatever the mode asks for. Never throws: the check against the node runs on its own.
  start(): void {
    const c = this.config;
    // the live stream: on unless LIVE_PUSH=off. Never in a test that runs the engine by hand (it builds its own).
    if (!this.live && livePushOn(this.env) && !this.opts.manual) {
      this.live = new Live({ state: () => this.api.state(this.view()), writes: () => this.writes(), extra: () => this.extraCounts(), changed: () => this.api.forget(), now: this.now });
      this.live.start();
    }
    // the pulse reads the chain whatever the mode is, and before the launch above all: a read and nothing else.
    // Never in tests, which hand the engine a chain of their own, run it by hand, or run under vitest.
    if (!this.pulse && pulseOn(this.env) && !this.opts.chain && !this.opts.manual && !process.env.VITEST && c.rpcUrls.length) {
      this.pulse = new Pulse(c.rpcUrls, { everyMs: Number(this.env.ENGINE_PULSE_MS) || undefined, now: this.now });
      this.pulse.onBeat = (b) => this.live?.beat(b);
      this.pulse.start();
    }
    // Before the launch Factor's own agents do small real jobs every few minutes, for the home page's receipt.
    if (!this.matcher && matchOn(this.env) && this.env.ANTHROPIC_API_KEY?.trim()) {
      const model = this.env.MATCH_MODEL?.trim() || "claude-haiku-4-5-20251001";
      const p = DEFAULT_MODELS[model] ?? DEFAULT_MODELS["claude-haiku-4-5-20251001"]!;
      const daily = Number(this.env.MATCH_DAILY_USD);
      this.matcher = new Matcher({ ask: anthropicAsk(this.env.ANTHROPIC_API_KEY.trim(), model, this.env.HOUSE_UPSTREAM_URL?.trim() || undefined), price: { in: p.in, out: p.out }, dailyUsd: Number.isFinite(daily) && daily > 0 ? daily : 1 });
    }
    if (!this.activity && activityOn(this.env) && !this.opts.chain && !this.opts.manual && !process.env.VITEST && c.rpcUrls.length) {
      const key = this.env.ANTHROPIC_API_KEY?.trim();
      const model = this.env.HOUSE_MODEL?.trim() || "claude-sonnet-5-5";
      const p = DEFAULT_MODELS[model] ?? DEFAULT_MODELS["claude-sonnet-5-5"]!;
      this.activity = new HouseActivity(this.sqlite, {
        urls: c.rpcUrls, ask: key ? anthropicAsk(key, model, this.env.HOUSE_UPSTREAM_URL?.trim() || undefined) : null, price: { in: p.in, out: p.out },
        everyMin: Number(this.env.ACTIVITY_EVERY_MIN) || undefined, practiceEvery: Number(this.env.ACTIVITY_PRACTICE_EVERY) || undefined,
        launched: () => this.state === "running", now: this.now,
      });
      this.activity.start();
    }
    if (!this.carryTimer && !this.opts.manual) {
      this.carryTimer = setInterval(() => { try { this.carrySignups(); } catch (e) { this.log(`[launch list] carrying failed: ${e instanceof Error ? e.message : String(e)}`); } }, 60_000);
      this.carryTimer.unref?.();
    }
    // the Desk writes whatever the mode is too: its opening files before the launch, then the rest as the desk works.
    // Its notes are worded by the model when there is a key, and written plainly from the facts when there is not.
    if (!this.deskMind && deskOn(this.env) && !this.opts.chain && !this.opts.manual && !process.env.VITEST) {
      const key = this.env.ANTHROPIC_API_KEY?.trim();
      const model = this.env.DESK_MODEL?.trim() || "claude-haiku-4-5-20251001";
      const daily = Number(this.env.DESK_DAILY_USD);
      this.deskMind = new DeskMind(this.sqlite, { writer: key ? anthropicWriter(key, model, this.env.HOUSE_UPSTREAM_URL?.trim() || undefined) : null, model, dailyUsd: Number.isFinite(daily) && daily >= 0 ? daily : undefined, now: this.now });
      const pass = () => {
        if (this.deskBusy) return;
        this.deskBusy = true;
        this.api.deskPass(this.view()).catch((e: unknown) => this.log(`[desk] a pass failed: ${e instanceof Error ? e.message : String(e)}`)).finally(() => { this.deskBusy = false; });
      };
      setTimeout(pass, 5_000).unref?.();
      this.deskTimer = setInterval(pass, 60_000);
      this.deskTimer.unref?.();
    }
    if (c.problems.length) {
      this.problems = [...c.problems];
      this.state = "stopped";
      for (const p of c.problems) this.log(`[engine] NOT STARTED: ${p}`);
      this.log("[engine] the feed answers \"not launched\" until that is put right");
      return;
    }
    if (c.mode === "off") return; // nothing is made: no client, no timer, no request
    if (!configured(c)) return;
    this.state = "starting";
    this.chain = this.opts.chain ?? viemChain(c.rpcUrls, c.chainId, this.now);
    // The key signs in live mode only. In dry mode it is used for one thing: its address, so that what would be
    // sent is tried as the very wallet that will send it, and a wrong key is found before the day it matters.
    let signer: Signer | null = null;
    let bot: string | null = null;
    if (this.opts.signer !== undefined) {
      signer = c.mode === "live" ? this.opts.signer : null;
      bot = this.opts.signer?.address ?? null;
    } else {
      const key = c.mode === "watch" ? null : takeBotKey(this.env);
      if (key && c.mode === "live") signer = viemSigner(key, c.rpcUrls, c.chainId);
      if (key) bot = addressOfKey(key);
    }
    this.ctx = {
      mode: c.mode,
      params: c.params,
      chainId: c.chainId,
      explorer: c.explorer,
      addr: { splitter: c.splitter, burnPot: c.burnPot, desk: c.desk, accounts: c.accounts.factory, skimTo: c.skimTo },
      accounts: c.accounts,
      deployBlock: c.deployBlock,
      chain: this.chain,
      signer,
      db: new EngineDb(this.sqlite, this.now),
      facts: { token: null, factory: null, escrow: null, gateway: null, bot, from: bot },
      log: this.log,
      now: this.now,
      pollMs: this.opts.pollMs ?? 1000,
      blockTimes: new Map(),
      stopping: () => this.stopped,
    };
    this.log(`[engine] mode ${c.mode}: ${c.mode === "watch" ? "reading the chain, sending nothing" : c.mode === "dry" ? "reading the chain and showing what it would send, sending nothing" : `reading the chain and sending from the gas wallet ${signer?.address}`}`);
    // what the owner asked to be stopped from the start (ENGINE_STOP): kept until it is turned back on
    const unknown: string[] = [];
    stopFromEnv(this.ctx.db, this.env.ENGINE_STOP, unknown);
    for (const u of unknown) this.log(`[engine] WARNING: ${u}`);
    const off = Object.keys(allStopped(this.ctx.db));
    if (off.length) this.log(`[engine] STOPPED by the owner: ${off.join(", ")}. Turn one back with POST /v1/admin/switch.`);
    // accounts for people without a wallet: orders are taken only while there is a gas wallet to send them from
    this.accounts = new Accounts(c.accounts, this.ctx.db, this.chain, c.desk, () => this.ctx?.mode === "live" && !!this.ctx.signer && this.state === "running", () => this.kick("act"), this.log);
    const accountSigned = (address: string, message: string, signature: unknown) => this.accounts!.signed(address, message, signature);
    this.profiles = new Profiles(this.ctx.db, this.now, accountSigned);
    const db = this.ctx.db;
    // the chain's time now: the last block read, and the seconds since
    const nowS = () => { const snap = snapshotOf(db); const t = this.now(); return snap ? snap.blockTime + Math.max(0, Math.floor((t - snap.at) / 1000)) : Math.floor(t / 1000); };
    this.pay = new Pay({
      cfg: c.pay, db, chain: this.chain, desk: c.desk, burnPot: c.burnPot, accountsFactory: c.accounts.factory,
      signed: async (address, message, signature) => this.profiles!.signed(address, message, signature), nowS,
      paused: () => { const h = stopped(db, "hiring"); return h ? h.note || "New jobs are paused for now." : null; },
      subjobs: () => (c.subjobs.enabled ? this.subjobs : null),
      firms: () => (c.firms.enabled ? this.firms : null),
    });
    // the links are read whether or not hiring is on, so a job's chain still shows after it is switched off
    this.subjobs = new Subjobs({
      cfg: c.subjobs, db, chain: this.chain, desk: c.desk, nowS,
      signed: async (address, message, signature) => this.profiles!.signed(address, message, signature),
      paused: () => { const h = stopped(db, "hiring"); return h ? h.note || "New jobs are paused for now." : null; },
      burnFor: (price) => this.pay!.burnFor(price),
      burnIn: (customer, hash) => this.pay!.burnIn(customer, hash),
      dealBurnUsed: (hash) => !!this.pay!.store.byBurnTx(hash) || !!this.openjobs?.store.byBurnTx(hash),
      house: () => new Set([...c.houseAgents, ...(this.house?.addresses() ?? [])]),
      hosted: () => this.house?.hostedAddresses() ?? new Map(),
      teamAllows: (parent, hirer, agent) => c.firms.enabled && !!this.firms?.teamAllows(parent, hirer, agent),
    });
    // firms are read whether or not they are on, so a firm's page and its record still show after it is switched off
    const houseSet = () => new Set([...c.houseAgents, ...(this.house?.addresses() ?? [])]);
    this.firms = new Firms({
      cfg: c.firms, db, nowS,
      signed: async (address, message, signature) => this.profiles!.signed(address, message, signature),
      sameHand: (a, b) => this.subjobs!.sameHand(a, b),
      factorOwn: (a) => houseSet().has(a) || a === this.house?.demoCustomer || this.subjobs!.controllers(a).has("factor:house"),
      rootOf: (job) => this.subjobs!.rootOf(job),
      family: (root) => this.subjobs!.store.family(root),
      names: () => this.profiles!.all(),
      isMonth: (job) => !!this.plans?.store.byJob(job),
    });
    // plans are read whether or not they are on, so a plan's page still shows after it is switched off
    this.plans = new Plans({
      cfg: c.plans, db, chain: this.chain, desk: c.desk, nowS,
      signed: async (address, message, signature) => this.profiles!.signed(address, message, signature),
      paused: () => { const h = stopped(db, "hiring"); return h ? h.note || "New jobs are paused for now." : null; },
      burnFor: (price) => this.pay!.burnFor(price),
      burnIn: (customer, hash) => this.pay!.burnIn(customer, hash),
      burnUsed: (hash) => !!this.pay!.store.byBurnTx(hash) || !!this.subjobs!.store.byBurnTx(hash) || !!this.openjobs?.store.byBurnTx(hash),
      checkLink: (token, at) => this.pay!.check(token, at),
      firms: () => (c.firms.enabled ? this.firms : null),
      sameHand: (a, b) => this.subjobs!.sameHand(a, b),
      names: () => this.profiles!.all(),
      pool: () => { const snap = snapshotOf(db); return snap ? { pool: BigInt(snap.desk.pool), out: BigInt(snap.desk.out) } : null; },
    });
    const factorOwn = (a: string) => houseSet().has(a) || a === this.house?.demoCustomer || this.subjobs!.controllers(a).has("factor:house");
    // open jobs are read whether or not they are on, so a listing's page still shows after it is switched off
    this.openjobs = new OpenJobs({
      cfg: c.openJobs, db, chain: this.chain, desk: c.desk, nowS,
      signed: async (address, message, signature) => this.profiles!.signed(address, message, signature),
      paused: () => { const h = stopped(db, "hiring"); return h ? h.note || "New jobs are paused for now." : null; },
      // the same hand as far as Factor can see it, and Factor itself on both sides (its own agents and its own customer)
      sameHand: (a, b) => this.subjobs!.sameHand(a, b) || (factorOwn(a) && factorOwn(b)),
      names: () => this.profiles!.all(),
      house: () => houseSet(),
      hosted: () => this.house?.hostedAddresses() ?? new Map(),
      burnFor: (price) => this.pay!.burnFor(price),
      burnIn: (customer, hash) => this.pay!.burnIn(customer, hash),
      burnUsed: (hash) => !!this.pay!.store.byBurnTx(hash) || !!this.subjobs!.store.byBurnTx(hash) || !!this.plans!.store.byBurnTx(hash),
      linkedElsewhere: (job) => (this.subjobs!.store.link(job) ? "a sub-job of another job" : this.plans!.store.byJob(job) ? "a month of a monthly plan" : null),
    });
    if (c.openJobs.enabled) this.log(`[openjobs] on: customers can post open jobs, up to ${c.openJobs.maxApplicants} agents apply to each, ranked by Factor Score`);
    // ERC-8004: made whether or not it is on, so an agent's page still shows what was written after it is switched off
    this.erc8004 = new Erc8004(c.erc8004, {
      db, chain: this.chain, chainId: c.chainId, desk: c.desk, explorer: c.explorer, now: this.now, nowS,
      writer: () => this.ctx?.facts.bot ?? null,
      signed: async (address, message, signature) => this.profiles!.signed(address, message, signature),
      sourceOf: (agent, id) => sourceOf(this.view(), agent, id),
      sameHand: (a, b) => this.subjobs!.sameHand(a, b),
      log: this.log,
    });
    this.ctx.erc8004 = this.erc8004;
    if (c.erc8004.enabled) this.log(`[erc8004] on: every settled job of an agent linked to an ERC-8004 identity is written to its reputation (${c.erc8004.reputation})${c.erc8004.backfill ? ", and the jobs from before its link once" : ""}`);
    if (c.plans.enabled) this.log(`[plans] on: customers can put an agent or a firm on a monthly plan of up to ${c.plans.mostMonths} months`);
    if (c.firms.enabled) this.log(`[firms] on: agents can form firms of up to ${c.firms.mostMembers + 1}, and customers hire them through their lead`);
    if (c.subjobs.enabled) this.log(`[subjobs] on: an agent can hire other agents for parts of its job, ${c.subjobs.maxDepth} levels deep, ${c.subjobs.perParent} under one job`);
    if (c.pay.enabled) this.log(`[pay] Pay with Factor on: every deal adds ${c.pay.burnBps / 100}% of its price to the burn, paid by the buyer`);
    this.gateway = new Gateway(c.compute, new ComputeStore(this.ctx.db), this.ctx.db, c.compute.enabled ? { anthropic: c.compute.direct ? takeModelKey(this.env) : null, router: takeRouterKey(this.env) } : { anthropic: null, router: null }, this.log, accountSigned);
    // Factor's own agents: put up only while there is a gas wallet to send what they sign
    this.house = new House(c.house, {
      db: this.ctx.db, chain: this.chain, desk: c.desk, accounts: this.accounts, profiles: this.profiles,
      modelKey: c.house.enabled ? takeModelKey(this.env) : null, seed: c.house.enabled ? takeHouseSeed(this.env) : null,
      live: () => this.ctx?.mode === "live" && !!this.ctx.signer && this.state === "running", now: this.now, log: this.log,
      costTo: () => this.ctx?.facts.from ?? null,
      firms: () => (c.firms.enabled ? this.firms : null), subjobs: () => (c.subjobs.enabled ? this.subjobs : null), burnFor: (wei) => this.pay!.burnFor(wei), burnPot: c.burnPot, nowS,
      planStopped: (job) => this.plans?.stoppedMonth(job) ?? null,
      ...(this.opts.houseSigners ? { signers: this.opts.houseSigners, paceMs: 0 } : {}),
    });
    // the demonstration customer (./house/demo.ts): an account of Factor's own that hires Factor's own agents
    const demoSeed = c.house.demo.enabled ? takeHouseSeed(this.env) : null;
    this.demo = new Demo(c.house.demo, {
      db: this.ctx.db, chain: this.chain, desk: c.desk, accounts: this.accounts, profiles: this.profiles, house: this.house,
      signer: this.opts.houseSigners ? this.opts.houseSigners("demonstration customer") : demoSeed ? houseSigner(demoSeed, "demonstration customer") : null,
      token: () => this.ctx?.facts.token ?? null,
      live: () => this.ctx?.mode === "live" && !!this.ctx.signer && this.state === "running", now: this.now, log: this.log,
    });
    if (c.house.demo.enabled) this.log(`[demo] on: a demonstration job every ${c.house.demo.everyS / 60} minutes, each marked as Factor's own`);
    if (c.house.hosted.enabled) this.log(`[house] people can make agents here: ${c.house.hosted.perOwner} for one address, ${c.house.hosted.most} in all`);
    if (c.house.enabled) this.log(`[house] on: ${this.house.agents.map((a) => a.service.name).join(", ") || "no agent (no key for the model, and none that works without)"}; model ${c.house.model}, up to $${c.house.dailyMicro / 1e6} a day`);
    else if (c.house.note) this.log(`[house] NOT ON: ${c.house.note}`);
    if (c.accounts.enabled) this.log(`[accounts] on: made by ${c.accounts.factory}; the gas wallet pays up to ${Number(c.accounts.gasDayWei / 10n ** 12n) / 1e6} ETH a day for them`);
    else if (c.accounts.note) this.log(`[accounts] NOT ON: ${c.accounts.note}`);
    if (c.compute.enabled) this.log(`[compute] on: ${[c.compute.direct ? Object.keys(c.compute.models).join(", ") : "", c.compute.router.enabled ? "OpenRouter's models" : ""].filter(Boolean).join(" and ")}, at the price plus ${c.compute.markupBps / 100}%`);
    else if (c.compute.note) this.log(`[compute] NOT ON: ${c.compute.note}`);
    this.log(`[engine] desk ${c.desk}, splitter ${c.splitter}, burn pot ${c.burnPot}, from block ${c.deployBlock}; ${c.rpcUrls.length} node(s): ${c.rpcUrls.map((u) => hostsOnly(u)).join(", ")}`);
    this.booting = this.boot();
  }

  // Check the addresses against the node, then start the loops. A node that does not answer: again in 30 s.
  private async boot(): Promise<void> {
    if (this.stopped || !this.ctx) return;
    try {
      await this.check();
    } catch (e) {
      if (e instanceof Wrong) {
        this.state = "stopped";
        this.problems = [e.message];
        this.log(`[engine] STOPPED: ${e.message}`);
        this.log("[engine] nothing is read or sent until that is put right and the server is restarted.");
        return;
      }
      this.fail("boot", e);
      this.log(`[engine] the node did not answer the boot check (${reason(e)}): trying again in 30 s`);
      if (!this.stopped) this.bootTimer = setTimeout(() => (this.booting = this.boot()), 30_000);
      return;
    }
    if (this.stopped) return;
    this.reindexIfAsked();
    this.state = "running";
    this.log("[engine] the addresses hold the contracts they should: running");
    if (this.opts.manual) return;
    const p = this.ctx.params;
    this.every("watch", p.watchEveryMs, () => this.watchOnce().then(() => undefined));
    if (this.ctx.mode === "dry" || this.ctx.mode === "live") this.every("act", p.actEveryMs, () => this.actOnce().then(() => undefined), false);
    if (this.ctx.mode === "live" && this.config.house.enabled) this.every("house", 5000, () => this.houseOnce(), false);
  }

  // Everything about the deployment that can be read back. Throws Wrong with the first thing that is not so.
  async check(): Promise<void> {
    const ctx = this.ctx!;
    const { chain, addr } = ctx;
    const c = this.config;
    const id = await chain.chainId();
    if (id !== c.chainId) throw new Wrong(`the node is on chain ${id}, not ${c.chainId} (Robinhood Chain): FACTOR_RPC_URLS points somewhere else`);
    const names: [string, string][] = [["FACTOR_SPLITTER", addr.splitter], ["FACTOR_BURN_POT", addr.burnPot], ["FACTOR_DESK", addr.desk]];
    const codes = await Promise.all(names.map(([, a]) => chain.code(a)));
    names.forEach(([name, a], i) => {
      if (!codes[i] || codes[i] === "0x") throw new Wrong(`${name} is ${a}, and there is no contract at that address on chain ${id}`);
    });
    // each contract is asked a question only it can answer the right way: who it is wired to
    const ask = async (name: string, to: string, abi: Abi, functionName: string): Promise<string> => {
      try {
        return normalizeAddress(await chain.read<string>({ to, abi, functionName })) ?? ZERO;
      } catch (e) {
        if (revertOf(e) || /returned no data|not a contract|decode|ZeroData/i.test((e as Error).message ?? "")) throw new Wrong(`${name} is ${to}, and the contract there does not answer ${functionName}(): it is not the ${name === "FACTOR_SPLITTER" ? "splitter" : name === "FACTOR_DESK" ? "desk" : "burn pot"}`);
        throw e;
      }
    };
    const [sBurn, sAdmin, bSplitter, token, sDesk, dBurn, gateway] = await Promise.all([
      ask("FACTOR_SPLITTER", addr.splitter, factorSplitterAbi as Abi, "burnPot"),
      ask("FACTOR_SPLITTER", addr.splitter, factorSplitterAbi as Abi, "admin"),
      ask("FACTOR_BURN_POT", addr.burnPot, factorBurnPotAbi as Abi, "splitter"),
      ask("FACTOR_BURN_POT", addr.burnPot, factorBurnPotAbi as Abi, "token"),
      ask("FACTOR_SPLITTER", addr.splitter, factorSplitterAbi as Abi, "desk"),
      ask("FACTOR_DESK", addr.desk, factorDeskAbi as Abi, "burnPot"),
      ask("FACTOR_DESK", addr.desk, factorDeskAbi as Abi, "gateway"),
    ]);
    if (sBurn !== addr.burnPot) throw new Wrong(`the splitter sends its burn share to ${sBurn}, not to FACTOR_BURN_POT ${addr.burnPot}`);
    if (bSplitter !== addr.splitter) throw new Wrong(`the burn pot's splitter() is ${bSplitter}, not FACTOR_SPLITTER ${addr.splitter}`);
    if (sDesk !== addr.desk) throw new Wrong(`the splitter sends the pool's share to ${sDesk}, not to FACTOR_DESK ${addr.desk}`);
    if (dBurn !== addr.burnPot) throw new Wrong(`the desk sends its advance fees to ${dBurn}, not to FACTOR_BURN_POT ${addr.burnPot}`);
    ctx.facts.gateway = gateway;
    // the maker of accounts, when one is named: it must be one, or orders would be sent into nothing
    if (addr.accounts) {
      if ((await chain.code(addr.accounts)) === "0x") throw new Wrong(`FACTOR_ACCOUNTS is ${addr.accounts}, and there is no contract at that address on chain ${id}`);
      const original = await ask("FACTOR_ACCOUNTS", addr.accounts, factorAccountsAbi as Abi, "implementation");
      if (original === ZERO || (await chain.code(original)) === "0x") throw new Wrong(`FACTOR_ACCOUNTS is ${addr.accounts}, and it has nothing to make accounts from`);
    }
    if (c.token && token !== c.token) throw new Wrong(`the burn pot's token() is ${token === ZERO ? "not set (nothing is launched from it)" : token}, not FACTOR_TOKEN ${c.token}`);
    if (c.admin && sAdmin !== c.admin) throw new Wrong(`the splitter's admin is ${sAdmin}, not FACTOR_ADMIN ${c.admin}`);
    const head = await chain.head();
    if (ctx.deployBlock > head.number) throw new Wrong(`FACTOR_DEPLOY_BLOCK is ${ctx.deployBlock}, past the chain's head ${head.number}`);
    if (token !== ZERO) ctx.facts.token = token;

    this.warnings = [];
    const mine = ctx.facts.bot;
    if (mine && sAdmin === mine) this.warn("BOT_PRIVATE_KEY is the admin wallet's key: the gas wallet must be a wallet of its own, holding only a little ETH");
    // without a key, calls are tried as the admin: every call the engine makes is open to anyone, so the answer is the same
    if (!ctx.facts.from) ctx.facts.from = sAdmin;
  }

  private warn(line: string): void {
    this.warnings.push(line);
    this.log(`[engine] WARNING: ${line}`);
  }

  // ENGINE_REINDEX holding a value it has not held before: everything the chain can give back is read again from
  // the deploy block, once. The record of what the engine did, and the names and titles people signed, are kept.
  private reindexIfAsked(): void {
    const ctx = this.ctx!;
    const token = this.config.reindex;
    if (!token || ctx.db.get("reindex") === token) return;
    ctx.db.forgetChain();
    ctx.db.set("reindex", token);
    this.log(`[engine] ENGINE_REINDEX=${token}: the chain is read again from block ${ctx.deployBlock}`);
  }

  private fail(where: string, e: unknown): void {
    this.lastError = { at: this.now(), where, message: reason(e) };
  }

  // Run a job again and again: once at a time, never overlapping itself. The node turning it away (403, 429)
  // doubles its wait, up to five minutes, said once when it starts and once when it clears; anything else it
  // throws is an error, kept for the health answer.
  private every(name: string, ms: number, fn: () => Promise<void>, runNow = true): void {
    const l: Loop = { lastRunAt: null, lastOkAt: null, runs: 0, failures: 0, waitMs: ms, backingOff: false, timer: null, running: null, again: false, tick: () => undefined };
    this.loops.set(name, l);
    const next = () => {
      if (this.stopped) return;
      // somebody asked for a run while this one was under way (kick): the next comes at once, never while the
      // node is turning requests away
      l.timer = setTimeout(tick, l.again && !l.backingOff ? 0 : l.waitMs);
      l.again = false;
    };
    const tick = () => {
      if (l.timer) clearTimeout(l.timer);
      l.timer = null;
      l.lastRunAt = this.now();
      l.runs++;
      l.running = fn()
        .then(() => {
          if (l.backingOff) this.log(`[${name}] the node answers again: back to every ${ms / 1000} s`);
          l.backingOff = false;
          l.waitMs = ms;
          l.lastOkAt = this.now();
        })
        .catch((e) => {
          if (nodeBusy(e)) {
            if (!l.backingOff) this.log(`[${name}] the node is turning requests away (403 or 429): waiting longer between runs until it answers again`);
            l.backingOff = true;
            l.waitMs = Math.min(Math.max(l.waitMs * 2, ms), Math.max(ms, BACKOFF_MAX_MS));
          } else {
            l.failures++;
            const before = this.lastError?.message;
            this.fail(name, e);
            if (before !== this.lastError?.message) this.log(`[${name}] failed: ${reason(e)}`);
          }
        })
        .finally(() => {
          l.running = null;
          next();
        });
    };
    l.tick = tick;
    if (runNow) tick();
    else next();
  }

  // Do not wait for a loop's next turn: somebody is waiting for what it does (an order of an account).
  private kick(name: string): void {
    const l = this.loops.get(name);
    if (!l || this.stopped || l.backingOff) return;
    if (l.running) l.again = true;
    else l.tick();
  }

  // One pass of the watchers (the loop calls this; so do the tests).
  async watchOnce(): Promise<WatchResult> {
    if (!this.ctx) throw new Error("the engine is not running");
    const pass = await watchPass(this.ctx);
    // an open job whose rule is the best Factor Score is picked as soon as its moment has come (./openjobs.ts)
    try { this.openjobs?.pickDue(); } catch (e) { this.log(`[openjobs] picking failed: ${e instanceof Error ? e.message : String(e)}`); }
    if (this.config.rehearsalClock) {
      const offset = pass.head.timestamp * 1000 - Date.now();
      if (Math.abs(offset - this.clockOffset) > 2000) this.clockOffset = offset;
    }
    return pass;
  }

  // One pass of the actions.
  async actOnce(): Promise<ActResult> {
    if (!this.ctx) throw new Error("the engine is not running");
    return actPass(this.ctx);
  }

  // One pass of Factor's own agents: whatever each has to do for the jobs locked for it.
  async houseOnce(): Promise<void> {
    await this.house?.pass();
    await this.demo?.pass();
    this.houseFirm();
  }

  /** Factor's own firm, put together once its lead and members are on the desk (./firms.ts). */
  houseFirm(): boolean {
    if (!this.firms || !this.house || !this.config.firms.enabled) return false;
    const lead = this.house.addressOf(HOUSE_FIRM.lead);
    const members = HOUSE_FIRM.members.map((m) => this.house!.addressOf(m));
    if (!lead || members.some((m) => !m)) return false;
    const made = this.firms.ensureHouse(lead, members as string[]);
    if (made) this.log(`[firms] ${HOUSE_FIRM.name} stands: ${HOUSE_FIRM.lead} leads ${HOUSE_FIRM.members.join(", ")}`);
    return made;
  }

  // The boot check, when a test wants to wait for it.
  async ready(): Promise<void> {
    await this.booting;
  }

  // Stop the loops and wait for whatever pass is under way: a transaction being followed to its receipt is
  // followed to the end, so nothing is left half written.
  async stop(): Promise<void> {
    this.live?.stop();
    this.pulse?.stop();
    this.activity?.stop();
    if (this.carryTimer) clearInterval(this.carryTimer);
    if (this.deskTimer) clearInterval(this.deskTimer);
    this.stopped = true;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    for (const l of this.loops.values()) if (l.timer) clearTimeout(l.timer);
    await Promise.allSettled([this.booting, ...[...this.loops.values()].map((l) => l.running)]);
    this.chain?.stop?.();
    if (this.state === "running" || this.state === "starting") this.state = "stopped";
  }
}

export type { EngineConfig } from "./chain/config.js";
export type { Answer } from "./api.js";
