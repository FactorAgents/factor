// Factor's own agents: three that take jobs on the desk like anybody's, do the work, and deliver it. They are there
// so that the desk has somebody to hire from its first hour, and they are said to be Factor's wherever they show.
//
// Each is an account without a wallet of its own ETH (../accounts.ts): a key only this process holds signs what it
// does, and the gas wallet sends it. To the desk they are agents like any other: registered, hired by a customer
// who locks the price, paid when the customer accepts or the review time runs out, and marked on their record if
// they ever failed to deliver. Nothing about them is special-cased in a contract.
//
// What one does with a job locked for it:
//   - the price is under what the service takes, the customer gave no brief in time, or the brief is nothing it can
//     work from: it declines, and the customer has everything back at once, with the reason on the job's page;
//   - otherwise it does the work (most ask a model, four read the chain and ask nobody), puts the work's fingerprint
//     on the chain as the delivery, and shows the work itself on the job's page.
// It never draws an advance: it has no costs worth one.
//
// The work is kept the moment it is done, before anything is sent, so a restart in the middle never asks a model
// for the same job twice and never delivers twice.

import { concat, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Accounts, Call, Key } from "../accounts.js";
import { deskCall, KIND, orderTypedData } from "../accounts.js";
import { normalizeAddress } from "../chain/address.js";
import { nodeBusy, reason, revertOf, type Chain } from "../chain/chain.js";
import type { EngineDb } from "../chain/db.js";
import { costMicro, DEFAULT_MODELS, type Price } from "../compute.js";
import { stopped } from "../switches.js";
import { proofOf, type Profiles } from "../profiles.js";
import { FEED_ABI, FEEDS } from "./feeds.js";
import { hostedService, type HostedRow } from "./hosted.js";
import { FirmRunner, type JobFacts } from "./firm.js";
import { HOUSE_FIRM, type Firms } from "../firms.js";
import type { Subjobs } from "../subjobs.js";
import { SERVICES, type Asked, type Done, type Service } from "./services.js";

type Env = Record<string, string | undefined>;

export interface HouseConfig {
  /** HOUSE_MODE=on, a key to derive the agents' keys from, and a maker of accounts. They work only while the engine is live. */
  enabled: boolean;
  model: string; // HOUSE_MODEL
  upstream: string; // HOUSE_UPSTREAM_URL
  dailyMicro: number; // HOUSE_DAILY_USD: what the agents spend on models in a day (UTC), at most
  payout: string | null; // HOUSE_PAYOUT: where what they earn is sent on to; not set, it stays in their accounts
  payoutMinWei: bigint;
  briefWaitS: number; // HOUSE_BRIEF_WAIT_S: how long a job may wait for its brief before it is declined
  note: string | null;
  /** agents somebody made on the site and Factor runs for them (./hosted.ts): HOSTED_MODE=on */
  hosted: { enabled: boolean; perOwner: number; most: number; floorWei: bigint; dailyMicroEach: number; payoutMinWei: bigint };
  /** demonstration jobs, with a customer of Factor's own (./demo.ts): DEMO_MODE=on */
  demo: { enabled: boolean; everyS: number; acceptAfterS: number };
}

export function readHouse(env: Env, problems: string[] = []): HouseConfig {
  const on = (env.HOUSE_MODE ?? "").trim().toLowerCase() === "on";
  const hasSeed = !!(env.HOUSE_AGENTS_KEY?.trim() || env.BOT_PRIVATE_KEY?.trim());
  const hasMaker = !!env.FACTOR_ACCOUNTS?.trim();
  if (env.HOUSE_AGENTS_KEY?.trim() && !/^(0x)?[0-9a-fA-F]{64}$/.test(env.HOUSE_AGENTS_KEY.trim())) problems.push("HOUSE_AGENTS_KEY must be 32 bytes of hex, with or without the 0x in front");
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const v = env[name]?.trim();
    if (!v) return fallback;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}: it is "${v}"`);
      return fallback;
    }
    return Number(v);
  };
  const rawPayout = env.HOUSE_PAYOUT?.trim() ?? "";
  const payout = rawPayout ? normalizeAddress(rawPayout) : null;
  if (rawPayout && !payout) problems.push(`HOUSE_PAYOUT is not an address: "${rawPayout}"`);
  const upstream = (env.HOUSE_UPSTREAM_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(upstream)) problems.push("HOUSE_UPSTREAM_URL is not an http(s) address");
  const model = env.HOUSE_MODEL?.trim() || "claude-sonnet-5-5";
  return {
    enabled: on && hasSeed && hasMaker,
    model, upstream,
    dailyMicro: int("HOUSE_DAILY_USD", 10, 1, 100_000) * 1_000_000,
    payout,
    payoutMinWei: 5n * 10n ** 15n,
    briefWaitS: int("HOUSE_BRIEF_WAIT_S", 900, 30, 86_400),
    hosted: {
      enabled: on && hasSeed && hasMaker && (env.HOSTED_MODE ?? "").trim().toLowerCase() === "on",
      perOwner: int("HOSTED_PER_OWNER", 3, 1, 50),
      most: int("HOSTED_MOST", 200, 1, 10_000),
      floorWei: 10n ** 15n, // 0.001 ETH: the least a job of one of these costs
      dailyMicroEach: int("HOSTED_DAILY_USD_EACH", 1, 1, 1000) * 1_000_000,
      payoutMinWei: 2n * 10n ** 15n,
    },
    demo: {
      enabled: on && hasSeed && hasMaker && (env.DEMO_MODE ?? "").trim().toLowerCase() === "on",
      everyS: int("DEMO_EVERY_MIN", 60, 1, 1440) * 60,
      acceptAfterS: int("DEMO_ACCEPT_AFTER_MIN", 3, 0, 1440) * 60,
    },
    note: !on ? null : !hasMaker ? "HOUSE_MODE is on and FACTOR_ACCOUNTS is not set: the house agents act through accounts, and there is nothing to make them with." : !hasSeed ? "HOUSE_MODE is on and there is no key to make the house agents' keys from (BOT_PRIVATE_KEY, or HOUSE_AGENTS_KEY)." : null,
  };
}

/**
 * What the house agents' keys are made from: HOUSE_AGENTS_KEY when the owner set one, and otherwise the gas wallet's
 * key, through a hash that cannot be run backwards. Read when the agents are made and kept nowhere else.
 */
export function takeHouseSeed(env: Env = process.env): Hex | null {
  const own = env.HOUSE_AGENTS_KEY?.trim();
  if (own && /^(0x)?[0-9a-fA-F]{64}$/.test(own)) return (own.startsWith("0x") ? own : `0x${own}`) as Hex;
  const bot = env.BOT_PRIVATE_KEY?.trim();
  if (!bot || !/^(0x)?[0-9a-fA-F]{64}$/.test(bot)) return null;
  return keccak256(concat([(bot.startsWith("0x") ? bot : `0x${bot}`) as Hex, toHex("factor house agents")]));
}

export interface HouseSigner {
  address: string; // the key's own address: what its account obeys
  signTypedData(typed: ReturnType<typeof orderTypedData>): Promise<Hex>;
  /** plain words, signed: what a hire by Factor's own firm carries (./firm.ts) */
  signMessage?(message: string): Promise<Hex>;
}
export function houseSigner(seed: Hex, name: string): HouseSigner {
  const account = privateKeyToAccount(keccak256(concat([seed, toHex(`factor house agent ${name}`)])));
  return { address: account.address.toLowerCase(), signTypedData: (typed) => account.signTypedData(typed), signMessage: (message) => account.signMessage({ message }) };
}

type State = "waiting" | "worked" | "delivering" | "delivered" | "to_decline" | "declining" | "declined" | "gave_up";
interface Row { job_id: number; agent: string; state: State; kind: string; work: string; note: string; relay: string | null; tries: number; next_at: number; cost_micro: number }
interface JobRow { id: number; customer: string; agent: string; price: string; due_at: number; locked_at: number; state: number; allow_early: number }
interface Agent { service: Service; signer: HouseSigner; key: Key; address: string | null; setUp: boolean; payoutAt: number; hosted?: { id: number; owner: string; payout: string } }
const JOB = "id, customer, agent, price, due_at, locked_at, state, allow_early";
type Made = { ok: true; id: number; name: string } | { ok: false; status: number; error: string };

const GRACE_S = 12 * 3600;
const MOST_TRIES = 3;

export interface HouseDeps {
  db: EngineDb;
  chain: Chain;
  desk: string;
  accounts: Accounts;
  profiles: Profiles;
  /** the owner's key with the model maker: sent to the model maker, never anywhere else */
  modelKey: string | null;
  seed: Hex | null;
  live: () => boolean;
  now: () => number; // ms, the engine's clock
  log: (line: string) => void;
  /** where the ETH that pays for a hosted agent's models goes when the owner named no payout address: the gas wallet */
  costTo?: () => string | null;
  /** for the tests: other signers than the ones made from the seed, and no waiting between reads */
  signers?: (name: string) => HouseSigner;
  paceMs?: number;
  /** agent firms and agents that hire agents, for Factor's own firm (./firm.ts); without them it does not work as one */
  firms?: () => Firms | null;
  subjobs?: () => Subjobs | null;
  burnFor?: (priceWei: bigint) => bigint;
  burnPot?: string;
  /** the chain's clock, seconds */
  nowS?: () => number;
}

export class House {
  readonly agents: Agent[] = [];
  private busy = false;
  /** the account of the demonstration customer (./demo.ts), once it is known: its jobs are marked wherever they show */
  demoCustomer: string | null = null;

  /** Factor's own firm at work (./firm.ts) */
  readonly firm: FirmRunner | null = null;

  constructor(readonly cfg: HouseConfig, private d: HouseDeps) {
    if (!cfg.enabled) return;
    if (d.firms && d.subjobs && d.burnPot) {
      const lead = () => this.agents.find((x) => !x.hosted && x.service.name === HOUSE_FIRM.lead) ?? null;
      this.firm = new FirmRunner({
        db: d.db, chain: d.chain, desk: d.desk, burnPot: d.burnPot, accounts: d.accounts, profiles: d.profiles, firms: d.firms, subjobs: d.subjobs, burnFor: d.burnFor ?? (() => 0n),
        members: () => HOUSE_FIRM.members.map((name) => { const a = this.agents.find((x) => !x.hosted && x.service.name === name); return a ? { name, address: a.address, ready: a.setUp, service: a.service } : null; }).filter((m): m is NonNullable<typeof m> => !!m),
        order: (calls) => { const a = lead(); return a ? this.order(a, calls) : Promise.resolve(null); },
        ask: (q) => this.ask(q),
        canSpend: () => this.spentToday() < this.cfg.dailyMicro,
        decline: async (job, note) => { const a = lead(); if (a) await this.decline(a, job as JobRow, note); },
        worked: (job, work, cost) => { const a = lead(); if (a) this.save(job.id, a, { state: "worked", work, kind: /^\s*<!doctype html/i.test(work) ? "html" : "text", cost_micro: cost.micro, input: cost.input, output: cost.output, tries: 0, next_at: 0 }); },
        now: d.now, nowS: d.nowS ?? (() => Math.floor(d.now() / 1000)), log: d.log,
      });
    }
    for (const service of SERVICES) {
      const signer = d.signers?.(service.name) ?? (d.seed ? houseSigner(d.seed, service.name) : null);
      if (!signer) continue;
      // an agent that asks a model is not put up without a key for the model: it would only decline everything
      if (service.ask && !d.modelKey) continue;
      this.agents.push({ service, signer, key: { kind: KIND.wallet, a: `0x${"0".repeat(24)}${signer.address.slice(2)}` as Hex, b: `0x${"0".repeat(64)}` as Hex }, address: null, setUp: false, payoutAt: 0 });
    }
    // the agents people made on the site: they ask a model, so there are none without a key for one
    if (cfg.hosted.enabled && d.modelKey) for (const row of d.db.q("SELECT * FROM hosted_agents ORDER BY id").all() as HostedRow[]) this.put(row);
  }

  // ---------- agents made on the site ----------

  private put(row: HostedRow): Agent | null {
    const signer = this.d.signers?.(`hosted ${row.id}`) ?? (this.d.seed ? houseSigner(this.d.seed, `hosted ${row.id}`) : null);
    if (!signer) return null;
    const a: Agent = { service: hostedService(row), signer, key: { kind: KIND.wallet, a: `0x${"0".repeat(24)}${signer.address.slice(2)}` as Hex, b: `0x${"0".repeat(64)}` as Hex }, address: null, setUp: false, payoutAt: 0, hosted: { id: row.id, owner: row.owner, payout: row.payout } };
    this.agents.push(a);
    return a;
  }

  /**
   * Somebody makes an agent: a name, what it does, how to do it and its price. Factor runs it from here on. Whoever
   * calls this has already seen that `owner` signed for it (../api.ts).
   */
  make(o: { owner: string; name: string; does: string; instructions: string; priceWei: bigint; payout: string }): Made {
    const h = this.cfg.hosted;
    if (!h.enabled || !this.d.modelKey) return { ok: false, status: 503, error: "making an agent here is not switched on yet" };
    if (stopped(this.d.db, "house") || stopped(this.d.db, "keeper")) return { ok: false, status: 503, error: "making an agent is paused for now" };
    if (o.priceWei < h.floorWei) return { ok: false, status: 400, error: `the price is under the least one of these takes a job for (${Number(h.floorWei / 10n ** 12n) / 1e6} ETH)` };
    if (o.priceWei > 10n ** 18n) return { ok: false, status: 400, error: "the price is over 1 ETH a job: set it lower" };
    const db = this.d.db;
    if ((db.q("SELECT COUNT(*) AS n FROM hosted_agents WHERE owner = ?").get(o.owner) as { n: number }).n >= h.perOwner) return { ok: false, status: 429, error: `one address can have ${h.perOwner} agents made here` };
    if ((db.q("SELECT COUNT(*) AS n FROM hosted_agents").get() as { n: number }).n >= h.most) return { ok: false, status: 429, error: "no more agents can be made here for now" };
    if (db.q("SELECT 1 FROM hosted_agents WHERE name = ?").get(o.name)) return { ok: false, status: 409, error: "another agent has that name" };
    const id = Number(db.q("INSERT INTO hosted_agents (owner, name, does, instructions, price_wei, payout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(o.owner, o.name, o.does, o.instructions, o.priceWei.toString(), o.payout, this.d.now()).lastInsertRowid);
    this.put(db.q("SELECT * FROM hosted_agents WHERE id = ?").get(id) as HostedRow);
    this.d.log(`[house] a new agent was made on the site: ${o.name}, for ${o.owner}`);
    return { ok: true, id, name: o.name };
  }

  /** Whether an agent can be made here right now: switched on, a key for the model, and nothing stopped. */
  canMake(): boolean {
    return this.cfg.hosted.enabled && !!this.d.modelKey && this.d.live() && !stopped(this.d.db, "house") && !stopped(this.d.db, "keeper");
  }

  /** The agents an address made here, for their owner's own page. */
  madeBy(owner: string): { name: string; does: string; priceEth: number; payout: string; paused: boolean; address: string | null; ready: boolean }[] {
    return (this.d.db.q("SELECT * FROM hosted_agents WHERE owner = ? ORDER BY id").all(owner) as HostedRow[]).map((r) => {
      const a = this.agents.find((x) => x.hosted?.id === r.id);
      return { name: r.name, does: r.does, priceEth: Number(BigInt(r.price_wei) / 10n ** 12n) / 1e6, payout: r.payout, paused: !!r.paused, address: a?.address ?? null, ready: !!a?.setUp };
    });
  }

  /** Its owner pauses one (it declines every job from then on) or lets it work again. */
  pause(owner: string, name: string, paused: boolean): boolean {
    return this.d.db.q("UPDATE hosted_agents SET paused = ? WHERE owner = ? AND name = ?").run(paused ? 1 : 0, owner, name).changes > 0;
  }

  /** Who made the agent at an address, when it is one made on the site. */
  ownerOf(address: string): string | null {
    return this.agents.find((x) => x.address === address)?.hosted?.owner ?? null;
  }

  /** The house agents' addresses on the desk, as far as they are known yet. */
  addresses(): string[] {
    return this.agents.filter((a) => !a.hosted).map((a) => a.address).filter((a): a is string => !!a);
  }

  /** The agents made on the site, by address: who made each. */
  hostedAddresses(): Map<string, string> {
    return new Map(this.agents.filter((a) => a.hosted && a.address).map((a) => [a.address!, a.hosted!.owner]));
  }

  /** What a house agent takes a job for, for the page that offers it. */
  serviceOf(address: string): { needs: string; delivers: string; fromEth: number } | null {
    const a = this.agents.find((x) => x.address === address);
    return a ? { needs: a.service.needs, delivers: a.service.delivers, fromEth: Number(a.service.floorWei / 10n ** 12n) / 1e6 } : null;
  }

  /** Why a house agent declined a job, for the job's page. */
  note(jobId: number): string | null {
    const r = this.d.db.q("SELECT state, note FROM house_jobs WHERE job_id = ?").get(jobId) as { state: State; note: string } | undefined;
    return r && r.note && ["to_decline", "declining", "declined", "gave_up"].includes(r.state) ? r.note : null;
  }

  /** How Factor's own firm went about a job hired through it, for the job's page. */
  firmNote(jobId: number): string | null {
    return this.firm?.note(jobId) ?? null;
  }

  /** The address of one of Factor's own agents on the desk, once it is set up. */
  addressOf(name: string): string | null {
    const a = this.agents.find((x) => !x.hosted && x.service.name === name);
    return a?.setUp ? a.address : null;
  }

  /** What was spent on models today (UTC), by all of them or by one. */
  spentToday(agent?: string): number {
    const now = this.d.now(), from = now - (now % 86_400_000);
    const row = agent ? this.d.db.q("SELECT COALESCE(SUM(cost_micro), 0) AS n FROM house_jobs WHERE created_at >= ? AND agent = ?").get(from, agent) : this.d.db.q("SELECT COALESCE(SUM(cost_micro), 0) AS n FROM house_jobs WHERE created_at >= ?").get(from);
    return (row as { n: number }).n;
  }

  totals(): Record<string, unknown> {
    const by = this.d.db.q("SELECT state, COUNT(*) AS n FROM house_jobs GROUP BY state").all() as { state: string; n: number }[];
    const n = (s: string) => by.find((r) => r.state === s)?.n ?? 0;
    return {
      enabled: this.cfg.enabled, note: this.cfg.note, model: this.cfg.model, payout: this.cfg.payout,
      agents: this.agents.filter((a) => !a.hosted).map((a) => ({ name: a.service.name, address: a.address, ready: a.setUp, asksAModel: !!a.service.ask })),
      hosted: { enabled: this.cfg.hosted.enabled, agents: this.agents.filter((a) => a.hosted).length, ready: this.agents.filter((a) => a.hosted && a.setUp).length },
      delivered: n("delivered"), declined: n("declined"), gaveUp: n("gave_up"), underWay: n("waiting") + n("worked") + n("delivering") + n("to_decline") + n("declining"),
      spentTodayMicro: this.spentToday(), dailyMicro: this.cfg.dailyMicro,
    };
  }

  // ---------- one pass ----------

  /** Everything the house agents have to do right now, one thing at a time. Never throws for one job's sake. */
  async pass(): Promise<void> {
    // the owner's switches (../switches.ts): while the agents, or everything the gas wallet sends, are stopped, they
    // take nothing up. A job locked for them meanwhile is refunded by the desk's own clock like any unanswered one.
    if (!this.cfg.enabled || !this.d.live() || this.busy || stopped(this.d.db, "house") || stopped(this.d.db, "keeper")) return;
    this.busy = true;
    try {
      for (const a of this.agents) {
        if (!(await this.ready(a))) continue;
        const open = this.d.db.q(`SELECT ${JOB} FROM desk_jobs WHERE agent = ? AND state IN (1, 2) ORDER BY id LIMIT 6`).all(a.address) as JobRow[];
        const mine = this.d.db.q("SELECT job_id FROM house_jobs WHERE agent = ? AND state IN ('worked', 'delivering', 'to_decline', 'declining')").all(a.address) as { job_id: number }[];
        const ids = [...new Set([...mine.map((m) => m.job_id), ...open.map((j) => j.id)])].sort((x, y) => x - y);
        for (const id of ids) {
          const job = open.find((j) => j.id === id) ?? (this.d.db.q(`SELECT ${JOB} FROM desk_jobs WHERE id = ?`).get(id) as JobRow | undefined);
          if (!job) continue;
          try {
            // a job hired through Factor's own firm: its lead runs the team until the work is ready to deliver
            if (this.firm && !a.hosted && a.service.name === HOUSE_FIRM.lead && this.firm.isFirmJob(job) && (await this.firm.step({ name: a.service.name, address: a.address!, service: a.service, signMessage: a.signer.signMessage ? (m) => a.signer.signMessage!(m) : undefined }, job as JobFacts))) continue;
            await this.step(a, job);
          } catch (e) {
            if (nodeBusy(e)) throw e;
            this.d.log(`[house] ${a.service.name}, job ${id}: ${reason(e)}`);
            this.save(id, a, { next_at: this.d.now() + 30_000 });
          }
        }
        await this.payOut(a);
      }
    } finally {
      this.busy = false;
    }
  }

  /** The agent exists on the chain, is registered on the desk and goes by its name. Each of the three steps happens once. */
  private async ready(a: Agent): Promise<boolean> {
    if (a.setUp) return true;
    const { accounts, db, profiles } = this.d;
    if (!a.address) a.address = await accounts.addressOfKey(a.key);
    const row = accounts.store.get(a.address);
    if (!row) {
      accounts.makeOwn(a.address, a.key);
      this.d.log(`[house] ${a.service.name}: its account ${a.address} is being made`);
      return false;
    }
    if (!row.deployed) return false;
    if (!db.q("SELECT 1 FROM desk_agents WHERE address = ?").get(a.address)) {
      // the desk's own word on it, in case the engine has not read the log yet: registering twice is refused
      await this.order(a, [deskCall(this.d.desk, "register")]).catch((e) => { if (!revertOf(e)) throw e; });
      return false;
    }
    profiles.house(a.address, a.service.name, a.service.does);
    a.setUp = true;
    this.d.log(`[house] ${a.service.name} is on the desk as ${a.address}`);
    return true;
  }

  private row(jobId: number): Row | null {
    return (this.d.db.q("SELECT * FROM house_jobs WHERE job_id = ?").get(jobId) as Row | undefined) ?? null;
  }

  private save(jobId: number, a: Agent, patch: Partial<Omit<Row, "job_id" | "agent">> & { input?: number; output?: number }): void {
    const now = this.d.now();
    this.d.db.q("INSERT OR IGNORE INTO house_jobs (job_id, agent, state, created_at, updated_at) VALUES (?, ?, 'waiting', ?, ?)").run(jobId, a.address, now, now);
    const keys = Object.keys(patch);
    if (keys.length) this.d.db.q(`UPDATE house_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE job_id = ?`).run(...Object.values(patch), now, jobId);
  }

  /** One job, one step further: decide, work, deliver, or see how what was sent went. */
  private async step(a: Agent, job: JobRow): Promise<void> {
    const { db, profiles } = this.d;
    const now = this.d.now();
    const nowS = Math.floor(now / 1000);
    let row = this.row(job.id);
    if (row && (row.next_at > now || ["delivered", "declined", "gave_up"].includes(row.state))) return;

    // something of ours is on its way for this job: how did it go?
    if (row && (row.state === "delivering" || row.state === "declining") && row.relay) {
      const sent = this.d.accounts.store.relay(row.relay);
      if (sent && (sent.status === "queued" || sent.status === "sent")) return;
      if (sent?.status === "done") {
        if (row.state === "delivering") {
          profiles.keep(job.id, row.work);
          this.d.log(`[house] ${a.service.name} delivered job ${job.id}`);
        } else this.d.log(`[house] ${a.service.name} declined job ${job.id}: ${row.note}`);
        return this.save(job.id, a, { state: row.state === "delivering" ? "delivered" : "declined", relay: null });
      }
      // it was not carried out: tried again a few times, each a little later, then left to the desk's own clock
      if (row.tries + 1 >= MOST_TRIES) return this.save(job.id, a, { state: "gave_up", relay: null, tries: row.tries + 1 });
      this.save(job.id, a, { state: row.state === "delivering" ? "worked" : "to_decline", relay: null, tries: row.tries + 1, next_at: now + 20_000 * 2 ** row.tries });
      return;
    }

    if (!row || row.state === "waiting") {
      if (job.state !== 1) return; // not ours to decide any more
      if (nowS > job.due_at + GRACE_S) return this.save(job.id, a, { state: "gave_up", note: "its time had run out before it could be done" });
      const floor = a.service.floorWei;
      if (BigInt(job.price) < floor) return this.decline(a, job, `the price is under what ${a.service.name} takes a job for (${Number(floor / 10n ** 12n) / 1e6} ETH)`);
      if (a.hosted) {
        const own = db.q("SELECT paused FROM hosted_agents WHERE id = ?").get(a.hosted.id) as { paused: number } | undefined;
        if (!own || own.paused) return this.decline(a, job, `${a.service.name} is not taking jobs for now`);
      }
      const brief = profiles.brief(job.id);
      if (!brief) {
        if (nowS - job.locked_at > this.cfg.briefWaitS) return this.decline(a, job, `no brief came with the job, and ${a.service.name} cannot work without one`);
        return; // the customer signs the brief a moment after locking: looked at again on the next pass
      }
      const refused = a.service.refuses(brief);
      if (refused) return this.decline(a, job, refused);
      const title = profiles.titles([job.id]).get(job.id) ?? "";
      let done: Done;
      let cost = { micro: 0, input: 0, output: 0 };
      if (a.service.work) done = await a.service.work(title, brief, { chain: this.d.chain, now: nowS, desk: this.d.desk, pace: () => new Promise((r) => setTimeout(r, this.d.paceMs ?? 300)) });
      else {
        if (this.spentToday() >= this.cfg.dailyMicro || (a.hosted && this.spentToday(a.address!) >= this.cfg.hosted.dailyMicroEach)) return this.decline(a, job, `${a.service.name} has taken all the jobs it takes in a day: hire it again tomorrow`);
        try {
          const answer = await this.ask(a.service.ask!(title, brief));
          cost = { micro: answer.costMicro, input: answer.input, output: answer.output };
          done = a.service.finish!(answer.text);
        } catch (e) {
          const tries = (row?.tries ?? 0) + 1;
          this.d.log(`[house] ${a.service.name}, job ${job.id}: the model did not answer (${reason(e)}), try ${tries} of ${MOST_TRIES}`);
          if (tries >= MOST_TRIES) return this.decline(a, job, `${a.service.name} could not do the work this time`);
          return this.save(job.id, a, { tries, next_at: now + 20_000 * 2 ** tries });
        }
      }
      if ("decline" in done) {
        this.save(job.id, a, { cost_micro: cost.micro, input: cost.input, output: cost.output });
        return this.decline(a, job, done.decline);
      }
      // kept before anything is sent: from here on a restart delivers this very work, and asks nobody again
      this.save(job.id, a, { state: "worked", work: done.work, kind: /^\s*<!doctype html/i.test(done.work) ? "html" : "text", cost_micro: cost.micro, input: cost.input, output: cost.output, tries: 0, next_at: 0 });
      row = this.row(job.id)!;
    }

    if (row.state === "worked") {
      if (job.state >= 3) return this.save(job.id, a, { state: job.state === 3 || job.state === 4 || job.state === 5 ? "delivered" : "gave_up" });
      // A demonstration job whose customer allowed an early advance: the agent draws half of it and delivers in one
      // order, so the advance is never out on a job that is not delivered (an advance kept that way bars an agent).
      const early = this.demoCustomer !== null && job.customer === this.demoCustomer && !!job.allow_early && job.state === 1;
      const calls = [...(early ? [deskCall(this.d.desk, "draw", [BigInt(job.id), BigInt(job.price) / 2n, 0])] : []), deskCall(this.d.desk, "deliver", [BigInt(job.id), proofOf(row.work)])];
      const relay = await this.orderFor(a, job, calls);
      if (relay) this.save(job.id, a, { state: "delivering", relay });
      return;
    }
    if (row.state === "to_decline") {
      if (job.state !== 1) return this.save(job.id, a, { state: "gave_up" });
      const relay = await this.orderFor(a, job, [deskCall(this.d.desk, "decline", [BigInt(job.id)])]);
      if (relay) this.save(job.id, a, { state: "declining", relay });
    }
    void db;
  }

  private async decline(a: Agent, job: JobRow, note: string): Promise<void> {
    this.save(job.id, a, { state: "to_decline", note, tries: 0, next_at: 0 });
    const relay = await this.orderFor(a, job, [deskCall(this.d.desk, "decline", [BigInt(job.id)])]);
    if (relay) this.save(job.id, a, { state: "declining", relay });
  }

  /** An order for a job. A desk that refuses it (the job moved on) ends the matter; a busy account waits a pass. */
  private async orderFor(a: Agent, job: JobRow, calls: Call[]): Promise<string | null> {
    try {
      return await this.order(a, calls);
    } catch (e) {
      const r = revertOf(e);
      if (!r) throw e;
      this.d.log(`[house] ${a.service.name}, job ${job.id}: the desk refuses it (${r.name})`);
      this.save(job.id, a, { state: "gave_up" });
      return null;
    }
  }

  private order(a: Agent, calls: Call[]): Promise<string | null> {
    return this.d.accounts.orderAs(a.address!, calls, (typed) => a.signer.signTypedData(typed));
  }

  /**
   * What an agent has earned goes on, now and then, when there is enough to be worth it. One of Factor's own: to
   * where the owner said. One somebody made here: to its maker, less what its jobs cost in models, which goes
   * where Factor's own earnings go.
   */
  private async payOut(a: Agent): Promise<void> {
    const now = this.d.now();
    const to = a.hosted ? a.hosted.payout : this.cfg.payout;
    if (!to || now < a.payoutAt) return;
    a.payoutAt = now + 600_000;
    if (this.d.db.q("SELECT 1 FROM house_jobs WHERE agent = ? AND state IN ('worked', 'delivering', 'to_decline', 'declining') LIMIT 1").get(a.address)) return;
    // the lead of Factor's own firm keeps what it drew early while its team is at work: that is what pays them
    if (this.firm && a.service.name === HOUSE_FIRM.lead && this.d.db.q("SELECT 1 FROM house_firm_jobs f JOIN desk_jobs j ON j.id = f.job_id WHERE j.agent = ? AND f.state NOT IN ('done', 'alone') LIMIT 1").get(a.address)) return;
    const balance = await this.d.chain.balance(a.address!);
    if (balance < (a.hosted ? this.cfg.hosted.payoutMinWei : this.cfg.payoutMinWei)) return;
    const calls: Call[] = [];
    let covered = 0;
    if (a.hosted) {
      const costTo = this.cfg.payout ?? this.d.costTo?.() ?? null;
      const spent = (this.d.db.q("SELECT COALESCE(SUM(cost_micro), 0) AS n FROM house_jobs WHERE agent = ?").get(a.address) as { n: number }).n;
      const paid = (this.d.db.q("SELECT cost_paid_micro FROM hosted_agents WHERE id = ?").get(a.hosted.id) as { cost_paid_micro: number } | undefined)?.cost_paid_micro ?? 0;
      const owed = Math.max(0, spent - paid);
      if (owed > 0 && costTo) {
        const price8 = await this.ethUsd8();
        if (price8 === null) return; // no price for ETH just now: looked at again later, nothing is sent on a guess
        // millionths of a dollar into wei: micro x 1e20 / (dollars x 1e8)
        const wei = (BigInt(owed) * 10n ** 20n) / price8;
        const take = wei > balance ? balance : wei;
        covered = wei > balance ? Number((BigInt(owed) * balance) / wei) : owed;
        if (take > 0n) calls.push({ to: costTo, value: take, data: "0x" });
        if (balance - take > 0n) calls.push({ to, value: balance - take, data: "0x" });
      } else calls.push({ to, value: balance, data: "0x" });
    } else calls.push({ to, value: balance, data: "0x" });
    const relay = await this.order(a, calls).catch((e) => { if (!revertOf(e)) throw e; return null; });
    if (!relay) return;
    if (a.hosted && covered > 0) this.d.db.q("UPDATE hosted_agents SET cost_paid_micro = cost_paid_micro + ? WHERE id = ?").run(covered, a.hosted.id);
    this.d.log(`[house] ${a.service.name}: ${Number(balance / 10n ** 12n) / 1e6} ETH it earned is on its way${a.hosted ? ` to its maker ${to}${covered ? `, less what its models cost` : ""}` : ` to ${to}`}`);
  }

  private async ethUsd8(): Promise<bigint | null> {
    const feed = FEEDS.find((f) => f.symbol === "ETH");
    if (!feed) return null;
    try {
      const [, answer] = await this.d.chain.read<readonly [bigint, bigint, bigint, bigint, bigint]>({ to: feed.address, abi: FEED_ABI as never, functionName: "latestRoundData" });
      return answer > 0n ? answer : null;
    } catch { return null; }
  }

  // ---------- the model ----------

  private async ask(a: Asked): Promise<{ text: string; input: number; output: number; costMicro: number }> {
    const key = this.d.modelKey;
    if (!key) throw new Error("no key for the model");
    const res = await fetch(`${this.cfg.upstream}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: this.cfg.model, max_tokens: a.maxTokens, system: a.system, messages: [{ role: "user", content: a.user }] }),
      signal: AbortSignal.timeout(240_000),
    });
    if (!res.ok) throw new Error(`the model maker answered ${res.status}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    const input = Number(body.usage?.input_tokens ?? 0), output = Number(body.usage?.output_tokens ?? 0);
    // what it cost at the model maker's list price: counted against the day's ceiling
    const price: Price = DEFAULT_MODELS[this.cfg.model] ?? DEFAULT_MODELS["claude-sonnet-5-5"]!;
    return { text, input, output, costMicro: costMicro({ input, output, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, price, 0) };
  }
}
