// Demonstration jobs: a customer of Factor's own that hires Factor's own agents, so that a visitor sees the desk
// work before anybody else has used it.
//
// Everything in one is real. The customer is an account with ETH in it. It locks a real price, the agent does the
// work and puts its fingerprint on the chain, an advance that is drawn is drawn from that payment and its fee is
// burned, and the job settles and pays its job fee into the pool. What is NOT real is the demand: nobody outside
// Factor asked for the work. So every one of these is said to be a demonstration wherever it shows: on the ledger's
// line, on the job's page, and in the count beside the home page's figures (../api.ts marks them by the customer's
// address, which is this account's and nobody else's).
//
// One at a time, every so often (DEMO_EVERY_MIN), going round the agents in turn. The customer's ETH comes back to
// it only as far as the owner sends the agents' earnings there: each job leaves its job fee in the pool and its
// advance fee in the burn, and what a model costs is paid by the owner like any house job's.

import type { Hex } from "viem";
import type { Accounts, Call, Key } from "../accounts.js";
import { deskCall, KIND } from "../accounts.js";
import { reason, revertOf, type Chain } from "../chain/chain.js";
import type { EngineDb } from "../chain/db.js";
import type { Profiles } from "../profiles.js";
import { stopped } from "../switches.js";
import type { House, HouseConfig, HouseSigner } from "./house.js";

type State = "locking" | "locked" | "briefed" | "accepting" | "done";
interface Row { n: number; job_id: number | null; agent: string; title: string; brief: string; state: State; relay: string | null; note: string; created_at: number }

export interface DemoDeps {
  db: EngineDb;
  chain: Chain;
  desk: string;
  accounts: Accounts;
  profiles: Profiles;
  house: House;
  signer: HouseSigner | null;
  /** $FACTOR's address once there is one, and the burn pot's: what the chain-reading agents are asked about */
  token: () => string | null;
  live: () => boolean;
  now: () => number; // ms, the engine's clock
  log: (line: string) => void;
}

const CONTRACT = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract TipJar {
    address public owner;
    uint256 public total;

    constructor() { owner = msg.sender; }

    function tip() external payable { total += msg.value; }

    function withdraw(address payable to) external {
        require(msg.sender == owner, "not the owner");
        to.transfer(address(this).balance);
    }

    function setOwner(address next) external {
        require(msg.sender == owner, "not the owner");
        owner = next;
    }
}`;

/** What the demonstration customer asks each agent for: real briefs each can work from. Several each, used in turn. */
export const BRIEFS: Record<string, { title: string; brief: string | ((o: { token: string | null; desk: string }) => string) }[]> = {
  "page-smith": [
    { title: "A page for a bike repair shop", brief: "A page for Spoke and Wrench, a bike repair shop in Leeds. For people who ride to work and need the bike back the same day. It should say: drop it off before 9, ride it home by 6; punctures, brakes, gears and wheels; no booking needed. Honest and plain, no hype." },
    { title: "A page for a reading group", brief: "A page for The Slow Readers, a reading group that meets in a library on the first Thursday of each month and reads one short book. For people who like to read and never finish long books. It should say that it is free, that anybody can come, and that the book is always under 200 pages." },
  ],
  "plain-reader": [
    { title: "A gym's membership terms", brief: `These terms are between the gym and the member. ${"The member pays the monthly fee on the first day of each month by direct debit. ".repeat(2)}The membership runs for twelve months from the day it starts and then renews for a month at a time. To end it the member gives one full calendar month of notice in writing. If a payment fails the gym may charge a late fee of ten pounds and may suspend the membership until it is paid. The gym may change the monthly fee once a year with thirty days of notice, and the member may end the membership without a fee within those thirty days. The gym is not liable for belongings left in the lockers. A member who is ill or injured may freeze the membership for up to three months with a doctor's note.` },
  ],
  "price-desk": [
    { title: "Prices", brief: "NVDA, TSLA and ETH please" },
    { title: "Prices", brief: "AAPL, MSFT, AMZN and BTC" },
  ],
  "red-pen": [
    { title: "A notice for the door", brief: "Were closed on monday becuase of the holiday, and we will be open agian on tuesday at nine. If your order was due for collection on monday, it will be kept for you untill friday, their is no need to call us." },
  ],
  "second-tongue": [
    { title: "A notice, in Spanish", brief: "Into Spanish: The shop is closed on Monday because of the holiday. We open again on Tuesday at nine. Orders due for collection on Monday are kept until Friday." },
  ],
  "code-reader": [
    { title: "A small function", brief: "function total(items) {\n  let sum = 0;\n  for (let i = 0; i <= items.length; i++) {\n    sum += items[i].price * items[i].qty;\n  }\n  return sum.toFixed(2);\n}" },
  ],
  "sol-reader": [{ title: "A tip jar contract", brief: CONTRACT }],
  "query-smith": [
    { title: "Orders by customer", brief: "Tables: customers(id, name, country, created_at) and orders(id, customer_id, total, placed_at). I want the ten customers who spent the most in 2025, with how many orders each placed. Postgres." },
  ],
  "data-shaper": [
    { title: "A list of sign-ups", brief: "Columns: name, city, date.\n\nAnna Berg - Oslo, 3 March 2026\nben ortiz, madrid (04/03/2026)\nCarla   Hahn / Berlin / 2026-03-05\nD. Okafor; Lagos; March 6th 2026\nEmil Stone, , 7 Mar 2026" },
  ],
  "note-smith": [
    { title: "Release notes for 2.4", brief: "fix: crash when the list is empty\nfeat: export a report as PDF\nchore: bump dependencies\nfeat: dark mode\nfix: wrong total when a row is deleted\nrefactor: split the settings module\nfix: the search box lost focus after each key" },
  ],
  "faq-smith": [
    { title: "A gym's membership terms", brief: `Membership terms. ${"The member pays the monthly fee on the first day of each month by direct debit. ".repeat(2)}The membership runs for twelve months and then renews a month at a time. To end it the member gives one full calendar month of notice in writing. A failed payment may be charged a late fee of ten pounds. The gym may change the fee once a year with thirty days of notice. A member who is ill or injured may freeze the membership for up to three months with a doctor's note. Guests may come twice a month and pay five pounds a visit. The gym is open from six in the morning to ten at night, and from eight to eight at weekends.` },
  ],
  "mark-smith": [
    { title: "A mark for a bakery", brief: "A mark for a small bakery called Early Loaf. Warm and simple, something that reads at the size of a coin. A rising sun or a loaf, one colour." },
  ],
  "gas-desk": [{ title: "What gas costs", brief: "What does a transaction cost right now?" }],
  "token-desk": [{ title: "$FACTOR", brief: ({ token }) => (token ? `The token at ${token}` : "") }],
  "wallet-desk": [{ title: "The desk", brief: ({ desk }) => `What does ${desk} hold?` }],
};

export class Demo {
  private key: Key | null = null;
  private nextAt = 0;
  address: string | null = null;
  note: string | null = null;

  constructor(private cfg: HouseConfig["demo"], private d: DemoDeps) {
    if (cfg.enabled && d.signer) this.key = { kind: KIND.wallet, a: `0x${"0".repeat(24)}${d.signer.address.slice(2)}` as Hex, b: `0x${"0".repeat(64)}` as Hex };
  }

  totals(): Record<string, unknown> {
    const n = (where: string) => (this.d.db.q(`SELECT COUNT(*) AS n FROM demo_jobs WHERE ${where}`).get() as { n: number }).n;
    return { enabled: this.cfg.enabled && !!this.key, customer: this.address, everyMinutes: this.cfg.everyS / 60, jobs: n("job_id IS NOT NULL"), underWay: n("state != 'done'"), note: this.note };
  }

  /** One step: see the open job through, or start the next one when its time has come. Never throws for a job's sake. */
  async pass(): Promise<void> {
    const { db, accounts } = this.d;
    if (!this.cfg.enabled || !this.key || !this.d.live() || stopped(db, "house") || stopped(db, "keeper")) return;
    if (!this.address) {
      this.address = await accounts.addressOfKey(this.key);
      this.d.house.demoCustomer = this.address;
    }
    const account = accounts.store.get(this.address);
    if (!account) { accounts.makeOwn(this.address, this.key); this.d.log(`[demo] the demonstration customer's account ${this.address} is being made`); return; }
    if (!account.deployed) return;
    try {
      const open = db.q("SELECT * FROM demo_jobs WHERE state != 'done' ORDER BY n LIMIT 1").get() as Row | undefined;
      if (open) return await this.step(open);
      await this.start();
    } catch (e) {
      this.d.log(`[demo] ${reason(e)}`);
    }
  }

  private set(n: number, patch: Partial<Pick<Row, "job_id" | "state" | "relay" | "note">>): void {
    const keys = Object.keys(patch);
    this.d.db.q(`UPDATE demo_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE n = ?`).run(...Object.values(patch), this.d.now(), n);
  }

  private order(calls: Call[]): Promise<string | null> {
    return this.d.accounts.orderAs(this.address!, calls, (typed) => this.d.signer!.signTypedData(typed));
  }

  /** How an order of ours went: still on its way, done, or not carried out. */
  private went(relay: string | null): "waiting" | "done" | "failed" {
    const r = relay ? this.d.accounts.store.relay(relay) : null;
    return !r || r.status === "failed" ? "failed" : r.status === "done" ? "done" : "waiting";
  }

  private async step(row: Row): Promise<void> {
    const { db, profiles } = this.d;
    const nowS = Math.floor(this.d.now() / 1000);
    if (row.state === "locking") {
      const how = this.went(row.relay);
      if (how === "waiting") return;
      if (how === "failed") return this.set(row.n, { state: "done", note: "the lock was not carried out" });
      // the job it made: the newest one this customer locked for that agent that no demonstration has yet
      const job = db.q("SELECT id FROM desk_jobs WHERE customer = ? AND agent = ? AND id NOT IN (SELECT job_id FROM demo_jobs WHERE job_id IS NOT NULL) ORDER BY id DESC LIMIT 1").get(this.address, row.agent) as { id: number } | undefined;
      if (!job) return; // on the chain and not read yet: looked at again on the next pass
      return this.set(row.n, { job_id: job.id, state: "locked" });
    }
    if (row.state === "locked") {
      if (!profiles.ownBrief(row.job_id!, this.address!, row.title, row.brief)) return;
      return this.set(row.n, { state: "briefed" });
    }
    const job = db.q("SELECT state, delivered_at FROM desk_jobs WHERE id = ?").get(row.job_id) as { state: number; delivered_at: number } | undefined;
    if (!job) return;
    if (row.state === "briefed") {
      // declined, refunded, or settled by somebody else: nothing more to do
      if (job.state >= 4) return this.set(row.n, { state: "done", note: job.state === 6 ? "the agent declined it" : job.state === 7 ? "it was refunded" : "" });
      if (job.state !== 3 || nowS < job.delivered_at + this.cfg.acceptAfterS) return;
      const relay = await this.order([deskCall(this.d.desk, "accept", [BigInt(row.job_id!)])]).catch((e) => { if (!revertOf(e)) throw e; return null; });
      if (relay) this.set(row.n, { state: "accepting", relay });
      return;
    }
    if (row.state === "accepting") {
      const how = this.went(row.relay);
      if (how === "waiting") return;
      // not carried out: back to waiting for it, and after 24 hours the engine settles a delivered job anyway
      return this.set(row.n, how === "done" ? { state: "done", relay: null } : { state: "briefed", relay: null });
    }
  }

  private async start(): Promise<void> {
    const { db, house } = this.d;
    const now = this.d.now();
    if (stopped(db, "hiring")) return; // the owner paused new jobs: that holds for these too
    if (this.nextAt === 0) {
      // after a restart: not sooner than its pace after the last one
      const last = (db.q("SELECT MAX(created_at) AS at FROM demo_jobs").get() as { at: number | null }).at;
      this.nextAt = last ? last + this.cfg.everyS * 1000 : now;
    }
    if (now < this.nextAt) return;
    const ready = house.agents.filter((a) => !a.hosted && a.setUp && a.address && BRIEFS[a.service.name]?.length);
    if (!ready.length) return;
    const done = (db.q("SELECT COUNT(*) AS n FROM demo_jobs").get() as { n: number }).n;
    // round the agents in turn, and for each its briefs in turn
    for (let i = 0; i < ready.length; i++) {
      const a = ready[(done + i) % ready.length]!;
      const set = BRIEFS[a.service.name]!;
      const pick = set[Math.floor(done / ready.length) % set.length]!;
      const brief = typeof pick.brief === "function" ? pick.brief({ token: this.d.token(), desk: this.d.desk }) : pick.brief;
      if (!brief || a.service.refuses(brief)) continue; // nothing to ask this one for yet (the token is not launched)
      const price = a.service.floorWei;
      if ((await this.d.chain.balance(this.address!)) < price) {
        this.note = `the demonstration customer has too little ETH for the next job (${Number(price / 10n ** 12n) / 1e6} ETH): send some to ${this.address}`;
        this.nextAt = now + 600_000;
        return;
      }
      this.note = null;
      // every other one allows an early advance, which the agent draws as it delivers
      const early = done % 2 === 0;
      const relay = await this.order([deskCall(this.d.desk, "lock", [a.address!, BigInt(Math.floor(now / 1000) + 6 * 3600), early], price)]).catch((e) => { if (!revertOf(e)) throw e; return null; });
      if (!relay) return;
      db.q("INSERT INTO demo_jobs (agent, title, brief, state, relay, created_at, updated_at) VALUES (?, ?, ?, 'locking', ?, ?, ?)").run(a.address, pick.title, brief, relay, now, now);
      this.nextAt = now + this.cfg.everyS * 1000;
      this.d.log(`[demo] a demonstration job for ${a.service.name}: ${pick.title}`);
      return;
    }
  }
}
