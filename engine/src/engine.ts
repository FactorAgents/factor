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
import { Profiles } from "./profiles.js";
import { configured, readConfig, takeBotKey, takeModelKey, type EngineConfig, type Env } from "./chain/config.js";
import type { Ctx } from "./chain/context.js";
import { EngineDb } from "./chain/db.js";
import { watchPass, type WatchResult } from "./chain/watch.js";
import { EngineApi, link, type Answer, type EngineView } from "./api.js";

export interface EngineOptions {
  env?: Env; // instead of process.env (tests)
  chain?: Chain; // instead of the node (tests)
  signer?: Signer | null; // instead of the key's wallet (tests)
  log?: (line: string) => void;
  now?: () => number; // the wall clock
  pollMs?: number; // how often a sent transaction's receipt is asked for
  manual?: boolean; // no loops: the caller runs each pass itself (tests)
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
  }

  private view(): EngineView {
    const loops: EngineView["loops"] = {};
    for (const [name, l] of this.loops) loops[name] = { lastRunAt: l.lastRunAt, lastOkAt: l.lastOkAt, runs: l.runs, failures: l.failures, waitMs: l.waitMs, backingOff: l.backingOff };
    return {
      config: this.config, state: this.state, problems: this.problems, warnings: this.warnings, lastError: this.lastError, loops, ctx: this.ctx, rpc: this.chain?.health() ?? null, now: this.now,
      links: { pons: link(this.env.FACTOR_PONS_URL), github: link(this.env.FACTOR_GITHUB_URL), x: link(this.env.FACTOR_X_URL) }, dataDirSet: !!this.env.FACTOR_DATA_DIR?.trim(), profiles: this.profiles, gateway: this.gateway, accounts: this.accounts,
    };
  }

  // The answer to one of the engine's API routes, or null when the path is not one of them.
  handle(path: string, query?: URLSearchParams): Promise<Answer | null> {
    return this.api.handle(path, query);
  }

  // Everything under /v1/compute/: the gateway answers the request itself (a model's answer may be a stream).
  // False when there is no gateway to answer, which is when the engine is not reading the chain.
  compute(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, path: string): boolean {
    if (!this.gateway || this.state !== "running") return false;
    void this.gateway.http(req, res, path);
    return true;
  }

  // The answer to a signed write (an agent's name, a job's title), or null when the path is not one.
  post(path: string, body: unknown, from: string, adminKey?: string): Promise<Answer | null> {
    return this.api.post(path, body, from, adminKey);
  }

  // Start whatever the mode asks for. Never throws: the check against the node runs on its own.
  start(): void {
    const c = this.config;
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
      addr: { splitter: c.splitter, burnPot: c.burnPot, desk: c.desk, accounts: c.accounts.factory },
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
    // accounts for people without a wallet: orders are taken only while there is a gas wallet to send them from
    this.accounts = new Accounts(c.accounts, this.ctx.db, this.chain, c.desk, () => this.ctx?.mode === "live" && !!this.ctx.signer && this.state === "running", () => this.kick("act"), this.log);
    const accountSigned = (address: string, message: string, signature: unknown) => this.accounts!.signed(address, message, signature);
    this.profiles = new Profiles(this.ctx.db, this.now, accountSigned);
    this.gateway = new Gateway(c.compute, new ComputeStore(this.ctx.db), this.ctx.db, c.compute.enabled ? takeModelKey(this.env) : null, this.log, accountSigned);
    if (c.accounts.enabled) this.log(`[accounts] on: made by ${c.accounts.factory}; the gas wallet pays up to ${Number(c.accounts.gasDayWei / 10n ** 12n) / 1e6} ETH a day for them`);
    else if (c.accounts.note) this.log(`[accounts] NOT ON: ${c.accounts.note}`);
    if (c.compute.enabled) this.log(`[compute] on: ${Object.keys(c.compute.models).join(", ")}, at the list price plus ${c.compute.markupBps / 100}%`);
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

  // The boot check, when a test wants to wait for it.
  async ready(): Promise<void> {
    await this.booting;
  }

  // Stop the loops and wait for whatever pass is under way: a transaction being followed to its receipt is
  // followed to the end, so nothing is left half written.
  async stop(): Promise<void> {
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
