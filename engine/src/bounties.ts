// Bounties (docs/BOUNTIES.md; contracts/src/FactorBounty.sol): a customer locks a prize for a task, agents enter with
// their finished work until the deadline, and the customer picks a winner, who is paid through the desk.
//
// What the engine does with them:
//
//   reads     the bounty contract's Posted, Entered, Picked, Closed, Paid, Owed and Collected, each into chain_events and
//             the tables here (not the desk's ledger: switched off, bounties leave no trace on the desk's pages), and the
//             contract's totals at the head
//   keeps     the words of each task and the work of each entry, off the chain. Each is stored only when it hashes to
//             what is on the chain, so nothing has to be signed and nobody can store work under another agent's name
//   hides     every work from everybody until a winner is picked or the bounty ends. From the deadline its poster can
//             read them with a wallet signature, which is never kept
//   keeper    every timed step: close(id) with no entries, with no pick in time, with a winner who delivered or did not,
//             and returnBonds(id) after a pick. Anyone may send them
//   house     Factor's own agents enter on their own, with real work from the services they sell, up to a daily cap on
//             models of its own. See housePass; nothing but a bounty seen on the chain starts it
//
//   GET  /v1/bounties                       the rules, the totals, the board (show=open|all, poster=, agent=)
//   GET  /v1/bounties/about                 whether bounties are on, the contract, the rules and the totals
//   GET  /v1/bounties/<n>                   one bounty, with its entries once they are public; the count until then
//   GET  /v1/bounties/<n>/entries/<agent>   one entry whole, once it is public
//   GET  /v1/bounties/<n>/mine/<agent>      whether an agent's entry and its work have arrived. Nothing hidden
//   GET  /v1/bounties/agent/<id>            an agent's wins and entries (address or name)
//   GET  /v1/bounties/poster/<address>      a poster's history: what it posted and whom it picked
//   POST /v1/bounties/task    { id, task }              the words of a task; must hash to what the bounty holds
//   POST /v1/bounties/entry   { id, agent, work }       the work of an entry; must hash to what the agent committed
//   POST /v1/bounties/read    { id, poster, at, signature }   the poster reads the entries, from the deadline
//
// Switches: BOUNTIES=on (off unless it is said), with FACTOR_BOUNTY and FACTOR_BOUNTY_BLOCK; BOUNTIES_HOUSE=on for the
// house agents; and the owner's "bounties" switch (./switches.ts), which hides bounties and stops the keeper and the house
// agents at once. Nothing anybody does on the chain depends on either: every call of the contract is open to everybody.

import { encodeAbiParameters, encodeFunctionData, formatEther, keccak256, toHex, type Abi, type Hex } from "viem";
import { factorBountyAbi } from "./abi/index.js";
import { takesWork } from "./autoapply.js";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import { readLogs, reason, revertOf, type CallSpec, type Chain, type ChainLog, type Head } from "./chain/chain.js";
import type { Ctx } from "./chain/context.js";
import type { EngineDb, EventRow } from "./chain/db.js";
import { decode } from "./chain/watch.js";
import { STATE } from "./desk.js";
import type { Asked, Done, Service } from "./house/shared.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export interface BountiesConfig {
  /** BOUNTIES=on: off unless it is said */
  enabled: boolean;
  /** FACTOR_BOUNTY: the bounty contract, once deployed (contracts/deploy-bounties.sh writes it) */
  bounty: string | null;
  /** FACTOR_BOUNTY_BLOCK: the block to read bounties from */
  fromBlock: bigint | null;
  /** BOUNTIES_PER_PASS: how many bounties the keeper moves on in one pass */
  perPass: number;
  /** BOUNTIES_HOUSE=on: Factor's own agents enter on their own */
  house: boolean;
  /** BOUNTIES_HOUSE_DAILY_USD: what they spend on models for entries in a day (UTC), at most, in millionths of a dollar. Apart from what they spend on jobs */
  houseDailyMicro: number;
  /** why it is on and cannot run, when it cannot */
  note: string | null;
}

export function readBounties(env: Env, problems: string[] = []): BountiesConfig {
  const on = (env.BOUNTIES ?? "").trim().toLowerCase() === "on";
  const raw = env.FACTOR_BOUNTY?.trim();
  const bounty = raw ? normalizeAddress(raw) : null;
  if (raw && !bounty) problems.push(`FACTOR_BOUNTY is not an address: "${raw}"`);
  const rawBlock = env.FACTOR_BOUNTY_BLOCK?.trim();
  let fromBlock: bigint | null = null;
  if (rawBlock) {
    if (/^\d+$/.test(rawBlock)) fromBlock = BigInt(rawBlock);
    else problems.push(`FACTOR_BOUNTY_BLOCK must be a block number: it is "${rawBlock}"`);
  }
  const rawPer = env.BOUNTIES_PER_PASS?.trim();
  let perPass = 5;
  if (rawPer) {
    if (/^\d+$/.test(rawPer) && Number(rawPer) >= 1 && Number(rawPer) <= 100) perPass = Number(rawPer);
    else problems.push(`BOUNTIES_PER_PASS must be a whole number from 1 to 100: it is "${rawPer}"`);
  }
  const rawUsd = env.BOUNTIES_HOUSE_DAILY_USD?.trim();
  let usd = 2;
  if (rawUsd) {
    if (/^\d+(\.\d{1,2})?$/.test(rawUsd) && Number(rawUsd) <= 1000) usd = Number(rawUsd);
    else problems.push(`BOUNTIES_HOUSE_DAILY_USD must be dollars, at most 1000: it is "${rawUsd}"`);
  }
  let note: string | null = null;
  if (on && !bounty) note = "BOUNTIES is on and FACTOR_BOUNTY is not set: there is no bounty contract to read yet";
  else if (on && fromBlock === null) note = "BOUNTIES is on and FACTOR_BOUNTY_BLOCK is not set: the block to read bounties from";
  return { enabled: on, bounty, fromBlock, perPass, house: (env.BOUNTIES_HOUSE ?? "").trim().toLowerCase() === "on", houseDailyMicro: Math.round(usd * 1_000_000), note };
}

/** The rules, as the contract has them (FactorBounty's constants): what the site says. */
export const BOUNTY_RULES = {
  burnPct: 1, bondPct: 1, jobFeePct: 2, minPrizeEth: 0.005, maxEntries: 25, minOpenH: 1, maxOpenD: 30, pickD: 3, deliverD: 3, graceH: 12, reviewH: 24,
  minPrizeWei: 5_000_000_000_000_000n, pickS: 3 * 86_400, deliverS: 3 * 86_400, graceS: 12 * 3600, reviewS: 24 * 3600, taskBytes: 8000, workBytes: 200_000,
} as const;

/** How long a house agent's work may take, at most, before the deadline leaves it no room. */
const HOUSE_MARGIN_S = 300;
/** At most this many of Factor's own agents on one bounty, and never when it would use the last slots. */
const HOUSE_PER_BOUNTY = 2;
const HOUSE_LEAVES_SLOTS = 5;
const HOUSE_MOST_TRIES = 3;
/** A signature of a poster's read holds this long. */
const READ_WINDOW_S = 600;

/** The words that find the work each of Factor's own services does, in a task's title and words. A service with no word in a task does not enter it. */
export const SERVICE_WORDS: Record<string, string[]> = {
  "page-smith": ["landing page", "one-page site", "one page site", "web page", "webpage", "website", "homepage", "home page"],
  "plain-reader": ["summar", "sum up", "plain words", "key points", "what it says", "read this", "read through"],
  "price-desk": ["price sheet", "prices of", "price of", "prices for", "price for"],
  "red-pen": ["proofread", "proof-read", "typo", "grammar", "spelling", "copy edit", "copyedit"],
  "second-tongue": ["translat"],
  "code-reader": ["explain this code", "explain the code", "what this code", "what the code", "code review", "read this code", "read the code"],
  "sol-reader": ["solidity", "smart contract"],
  "query-smith": ["sql", "database query"],
  "data-shaper": ["csv", "clean table", "messy data", "spreadsheet"],
  "note-smith": ["release notes", "changelog", "commits"],
  "faq-smith": ["faq", "questions and answers"],
  "mark-smith": ["logo", "a mark for", "symbol for"],
  "gas-desk": ["gas cost", "what gas", "gas price"],
  "token-desk": ["fact sheet", "about this token", "about the token"],
  "wallet-desk": ["this wallet", "this address", "what an address holds"],
};

/** What the desk gets as a proof, and what an entrant commits to: FactorBounty.entryHash, to the letter. */
export function entryHashOf(contract: string, id: number, agent: string, workHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }], [contract as Hex, BigInt(id), agent as Hex, workHash]));
}
export const textHash = (text: string): Hex => keccak256(toHex(text));

/** The words a poster signs to read its entries: readable, so a wallet shows exactly what it puts its name to. The same on the site (web/src/lib/bounties.ts). */
export const readMessage = (o: { id: number; poster: string; at: number }): string => ["Factor: read the entries of a bounty", `bounty: ${o.id}`, `poster: ${o.poster}`, `at: ${o.at}`].join("\n");

const BT = factorBountyAbi as Abi;
const STATES = ["none", "open", "picked", "won", "unpicked", "undelivered", "empty"] as const;
export type BountyState = Exclude<(typeof STATES)[number], "none">;
/** What a bounty is doing now: `open` taking entries, `choosing` waiting for the poster's pick, then the contract's own states. `ending`: its time is up and anyone can close it. */
export type BountyStatus = "open" | "choosing" | "ending" | "picked" | "won" | "unpicked" | "undelivered" | "empty";

export interface BountyRow {
  id: number; block: number; at: number; tx_hash: string; poster: string; prize: string; fee: string; bond: string; deadline: number; min_score: number; task_hash: string;
  state: BountyState; entries: number; winner: string | null; job: number | null; due_at: number | null; picked_at: number | null; picked_tx: string | null; bonds_back: number;
  closed_at: number | null; closed_tx: string | null; share: string; paid_to: number; burned: string; to_poster: string;
}
export interface EntryRow { bounty: number; agent: string; block: number; at: number; tx_hash: string; from_addr: string; hash: string; n: number; got_share: string; got_bond: string }
interface WorkRow { bounty: number; agent: string; kind: "text" | "html"; body: string; at: number }
interface TaskRow { bounty: number; body: string; at: number; hidden: number }

type HouseState = "worked" | "entering" | "entered" | "skipped";
interface HouseRow { bounty: number; agent: string; service: string; state: HouseState; work: string; note: string; relay: string | null; tries: number; next_at: number; cost_micro: number; created_at: number; updated_at: number }

const SCHEMA = `
-- Bounties (./bounties.ts). The words of a task and the work of an entry: never on the chain, and kept by a reindex.
CREATE TABLE IF NOT EXISTS bounty_tasks (
  bounty INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  at INTEGER NOT NULL,               -- ms
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bounty_works (
  bounty INTEGER NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,                -- text, or html
  body TEXT NOT NULL,
  at INTEGER NOT NULL,               -- ms
  PRIMARY KEY (bounty, agent)
);
-- What Factor's own agents did on a bounty. The work is kept before anything is sent, so a restart asks no model twice.
CREATE TABLE IF NOT EXISTS bounty_house (
  bounty INTEGER NOT NULL,
  agent TEXT NOT NULL,
  service TEXT NOT NULL,
  state TEXT NOT NULL,               -- worked, entering, entered, skipped
  work TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  relay TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,       -- ms
  updated_at INTEGER NOT NULL,       -- ms
  PRIMARY KEY (bounty, agent)
);
CREATE INDEX IF NOT EXISTS bounty_house_day ON bounty_house (created_at);
`;

export interface HouseHand {
  name: string;
  address: string;
  service: Service;
}

/** What Factor's own agents lend to bounties (./house/house.ts). */
export interface HouseHands {
  /** the agents on the desk and ready, in the order they are listed; none while the agents are stopped */
  ready(): HouseHand[];
  /** what its account holds */
  balance(address: string): Promise<bigint>;
  /** does a service's work with nobody asked */
  work(service: Service, title: string, brief: string): Promise<Done>;
  /** asks the model, and says what it cost */
  ask(a: Asked): Promise<{ text: string; costMicro: number }>;
  /** the most a question could cost, in millionths of a dollar */
  worstCost(a: Asked): number;
  /** an order of one call from the agent's account. null: not now */
  order(agent: string, call: { to: string; value: bigint; data: Hex }): Promise<string | null>;
  /** how an order went */
  relay(id: string): "waiting" | "done" | "failed";
}

export interface BountiesDeps {
  cfg: BountiesConfig;
  db: EngineDb;
  chain: Chain;
  chainId: number;
  /** the chain's clock, seconds */
  nowS: () => number;
  /** the wall clock, ms */
  now: () => number;
  log: (line: string) => void;
  /** agents' names */
  names: () => Map<string, { name: string; hidden?: number }>;
  /** whether `address` signed `message`: a wallet, or an account through one of its keys */
  signed: (address: string, message: string, signature: unknown) => Promise<boolean>;
  /** the same hand as far as Factor can see it */
  sameHand: (a: string, b: string) => boolean;
  /** an agent's score on the desk, as the engine last read it */
  scoreOf: (address: string) => number;
  /** keeps a work on a desk job's page */
  keep: (job: number, work: string) => void;
  /** whether a wallet is a line account's key, and the account */
  house?: () => HouseHands | null;
}

/** The totals, read from the contract. */
export interface BountyTotals { held: string; bonds: string; owed: string; atDesk: string; prizes: string; burned: string; won: string; split: string; returned: string; count: number; at: number }

export class Bounties {
  private totalsReadAt = 0;
  private lastHouseSay = "";

  constructor(readonly d: BountiesDeps) {
    d.db.db.exec(SCHEMA);
  }

  /** Reading the chain: switched on and a contract to read. */
  reading(): boolean {
    return this.d.cfg.enabled && !!this.d.cfg.bounty && this.d.cfg.fromBlock !== null;
  }

  /** Shown and kept: reading, and the owner has not stopped it. */
  on(): boolean {
    return this.reading() && !stopped(this.d.db, "bounties");
  }

  // ---------- the books ----------

  row(id: number): BountyRow | null {
    return (this.d.db.q("SELECT * FROM bounties WHERE id = ?").get(id) as BountyRow | undefined) ?? null;
  }

  /** The bounty a desk job came from. */
  ofJob(job: number): BountyRow | null {
    return (this.d.db.q("SELECT * FROM bounties WHERE job = ?").get(job) as BountyRow | undefined) ?? null;
  }

  entries(id: number): EntryRow[] {
    return this.d.db.q("SELECT * FROM bounty_entries WHERE bounty = ? ORDER BY n").all(id) as EntryRow[];
  }

  private entry(id: number, agent: string): EntryRow | null {
    return (this.d.db.q("SELECT * FROM bounty_entries WHERE bounty = ? AND agent = ?").get(id, agent) as EntryRow | undefined) ?? null;
  }

  private work(id: number, agent: string): WorkRow | null {
    return (this.d.db.q("SELECT * FROM bounty_works WHERE bounty = ? AND agent = ?").get(id, agent) as WorkRow | undefined) ?? null;
  }

  private task(id: number): TaskRow | null {
    return (this.d.db.q("SELECT * FROM bounty_tasks WHERE bounty = ?").get(id) as TaskRow | undefined) ?? null;
  }

  totals(): BountyTotals | null {
    return this.d.db.getJson<BountyTotals>("bounties:totals");
  }

  /** The owner hides what a task says. The bounty stays on the chain and on the board, as a number. */
  hide(key: string, hidden: boolean): boolean {
    return this.d.db.q("UPDATE bounty_tasks SET hidden = ? WHERE bounty = ?").run(hidden ? 1 : 0, Number(key)).changes > 0;
  }

  // ---------- reading the chain ----------

  /** One log of the bounty contract's, written down. Returns a line for the engine's log, when it is worth one. Exported for the tests. */
  apply(log: ChainLog, at: number): string | null {
    const e = decode({ name: "bounty" as never, abi: BT }, log, at);
    if (!e) return null;
    e.contract = "bounty";
    if (!this.d.db.addEvent(e)) return null;
    return this.effect(e);
  }

  private name(address: string): string {
    const p = this.d.names().get(address);
    return p && !p.hidden ? p.name : shortAddress(address);
  }

  private effect(e: EventRow): string | null {
    const db = this.d.db;
    const a = e.args;
    const id = a.id !== undefined ? Number(a.id) : 0;
    if (e.event === "Posted") {
      db.q("INSERT OR IGNORE INTO bounties (id, block, at, tx_hash, poster, prize, fee, bond, deadline, min_score, task_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id, e.block, e.at, e.tx_hash, normalizeAddress(a.poster), String(a.prize), String(a.fee), String(a.bond), Number(a.deadline), Number(a.minScore), String(a.task).toLowerCase(),
      );
      return `bounty ${id}: ${ethText(String(a.prize))} ETH posted by ${shortAddress(normalizeAddress(a.poster) ?? "")}`;
    }
    if (e.event === "Entered") {
      const agent = normalizeAddress(a.agent)!;
      db.q("INSERT OR IGNORE INTO bounty_entries (bounty, agent, block, at, tx_hash, from_addr, hash, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, agent, e.block, e.at, e.tx_hash, normalizeAddress(a.from), String(a.hash).toLowerCase(), Number(a.count));
      db.q("UPDATE bounties SET entries = (SELECT COUNT(*) FROM bounty_entries WHERE bounty = ?) WHERE id = ?").run(id, id);
      return `bounty ${id}: entry ${Number(a.count)} is in`;
    }
    if (e.event === "Picked") {
      const winner = normalizeAddress(a.winner)!;
      const job = Number(a.job);
      db.q("UPDATE bounties SET state = 'picked', winner = ?, job = ?, due_at = ?, picked_at = ?, picked_tx = ? WHERE id = ? AND state = 'open'").run(winner, job, Number(a.dueAt), e.at, e.tx_hash, id);
      // from here every entry is public, and the winner's work is the job's own
      const work = this.work(id, winner);
      if (work) this.d.keep(job, work.body);
      return `bounty ${id}: ${this.name(winner)} was picked, job ${job}`;
    }
    if (e.event === "Closed") {
      const how = STATES[Number(a.how)] ?? "won";
      db.q("UPDATE bounties SET state = ?, closed_at = ?, closed_tx = ?, share = ?, paid_to = ?, burned = ?, to_poster = ? WHERE id = ?").run(how, e.at, e.tx_hash, String(a.share), Number(a.paidTo), String(a.burned), String(a.toPoster), id);
      if (how === "won") return `bounty ${id}: won by ${this.name(normalizeAddress(a.winner)!)}, paid through the desk`;
      if (how === "unpicked") return `bounty ${id}: no pick in time, split between ${Number(a.paidTo)} entrants`;
      if (how === "empty") return `bounty ${id}: no entries, everything went back to the poster`;
      return `bounty ${id}: the winner did not deliver, ${Number(a.paidTo) ? `split between the ${Number(a.paidTo)} others` : "the prize went back to the poster"}`;
    }
    if (e.event === "Paid") {
      const who = normalizeAddress(a.who)!;
      db.q("UPDATE bounty_entries SET got_share = ?, got_bond = ? WHERE bounty = ? AND agent = ?").run(String(a.share), String(a.bond), id, who);
      if (BigInt(String(a.bond)) > 0n && this.row(id)?.winner !== who) db.q("UPDATE bounties SET bonds_back = 1 WHERE id = ?").run(id);
      return null;
    }
    if (e.event === "Owed") return `${ethText(String(a.amount))} ETH waits in the bounty contract for ${shortAddress(normalizeAddress(a.who) ?? "")}, who refused it`;
    return null;
  }

  /** One pass of the bounty contract's logs, from where the last stopped to the safe head. Returns the lines worth logging. */
  async watch(ctx: Ctx, head: Head): Promise<string[]> {
    if (!this.reading()) return [];
    const { db, chain } = this.d;
    const safe = head.number - BigInt(ctx.params.confirmations);
    const start = (db.cursor("bounties") ?? this.d.cfg.fromBlock! - 1n) + 1n;
    if (start > safe) return [];
    const lines: string[] = [];
    const span = BigInt(ctx.params.logSpan);
    let from = start;
    for (let n = 0; n < ctx.params.spansPerPass && from <= safe; n++) {
      const to = from + span - 1n > safe ? safe : from + span - 1n;
      let logs: ChainLog[] = [];
      await readLogs(chain, from, to, { address: [this.d.cfg.bounty!] }, to - from + 1n, (got) => { logs = got; }, 1);
      logs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
      const missing = [...new Set(logs.filter((l) => l.timestamp === undefined && !ctx.blockTimes.has(l.blockNumber)).map((l) => l.blockNumber))];
      for (let i = 0; i < missing.length; i += 10) {
        const blocks = await Promise.all(missing.slice(i, i + 10).map((b) => chain.block(b)));
        blocks.forEach((b, k) => ctx.blockTimes.set(missing[i + k]!, b?.timestamp ?? 0));
      }
      db.tx(() => {
        for (const l of logs) {
          const line = this.apply(l, l.timestamp ?? ctx.blockTimes.get(l.blockNumber) ?? 0);
          if (line) lines.push(line);
        }
        db.setCursor("bounties", to);
      });
      from = to + 1n;
    }
    for (const l of lines) this.d.log(`[bounties] ${l}`);
    if (lines.length) this.totalsReadAt = 0;
    return lines;
  }

  /** The totals, once every half minute. */
  async refresh(): Promise<void> {
    if (!this.reading() || this.d.now() - this.totalsReadAt <= 30_000) return;
    this.totalsReadAt = this.d.now();
    const B = <T>(fn: string) => this.d.chain.read<T>({ to: this.d.cfg.bounty!, abi: BT, functionName: fn });
    const [held, bonds, owed, atDesk, prizes, burned, won, split, returned, count] = await Promise.all([
      B<bigint>("held"), B<bigint>("bonds"), B<bigint>("owedTotal"), B<bigint>("atDesk"), B<bigint>("totalPrizes"), B<bigint>("totalBurned"), B<bigint>("totalWon"), B<bigint>("totalSplit"), B<bigint>("totalReturned"), B<bigint>("bountyCount"),
    ]);
    this.d.db.setJson("bounties:totals", { held: held.toString(), bonds: bonds.toString(), owed: owed.toString(), atDesk: atDesk.toString(), prizes: prizes.toString(), burned: burned.toString(), won: won.toString(), split: split.toString(), returned: returned.toString(), count: Number(count), at: this.d.now() } satisfies BountyTotals);
  }

  // ---------- the keeper ----------

  /** What is next for a bounty on the chain's clock: "close" or "bonds" when anyone can send it now, or null. Exported for the tests. */
  due(b: BountyRow, job: { state: number; due_at: number; delivered_at: number; proof: string } | null, t: number): "close" | "bonds" | null {
    if (b.state === "open") {
      if (t < b.deadline) return null;
      if (b.entries === 0) return "close";
      return t >= b.deadline + BOUNTY_RULES.pickS ? "close" : null;
    }
    if (b.state !== "picked" || !job) return null;
    const finished = job.state === STATE.settled || job.state === STATE.declined || job.state === STATE.refunded;
    if (finished) return "close";
    if ((job.state === STATE.locked || job.state === STATE.advanced) && t > job.due_at + BOUNTY_RULES.graceS) return "close";
    if (job.state === STATE.delivered && job.delivered_at > 0) {
      const mine = this.entry(b.id, b.winner!);
      if (mine && job.proof.toLowerCase() === mine.hash.toLowerCase()) return "close";
      if (t >= job.delivered_at + BOUNTY_RULES.reviewS) return "close";
    }
    return !b.bonds_back && b.entries > 1 ? "bonds" : null;
  }

  /**
   * The keeper's turn (./chain/act.ts calls it as the step "bounty", before the desk's own settling and refunding): every
   * bounty whose time has come is closed or its bonds sent back. A few a pass, the oldest first.
   */
  async step(ctx: Ctx, head: Head, attempt: (kind: "bounty", ref: string, call: CallSpec, detail: Record<string, unknown>, feeCap: bigint) => Promise<{ status: string; why: string; hash?: string }>): Promise<string> {
    if (!this.reading()) return "bounties are not switched on";
    if (stopped(this.d.db, "bounties")) return "bounties are stopped by the owner";
    const db = this.d.db;
    const t = head.timestamp;
    const said: string[] = [];
    let n = 0;
    // one try at a time per bounty: one on its way waits; one that failed waits ten minutes; one shown in dry mode, half an hour
    const ready = (ref: string): boolean => {
      const prev = db.lastAction("bounty", ref);
      if (!prev) return true;
      if (prev.status === "signed" || prev.status === "sent") return false;
      if (prev.status === "done") return this.d.now() - prev.updated_at > 120_000;
      if (prev.status === "failed") return this.d.now() - prev.updated_at > 600_000;
      if (prev.status === "dry") return this.d.now() - prev.created_at > 1_800_000;
      return true;
    };
    const live = db.q("SELECT * FROM bounties WHERE state IN ('open', 'picked') ORDER BY id").all() as BountyRow[];
    for (const b of live) {
      if (n >= this.d.cfg.perPass || ctx.stopping()) break;
      const job = b.job !== null ? (db.q("SELECT state, due_at, delivered_at, proof FROM desk_jobs WHERE id = ?").get(b.job) as { state: number; due_at: number; delivered_at: number; proof: string } | undefined) ?? null : null;
      const what = this.due(b, job, t);
      if (!what) continue;
      const ref = `${what}:${b.id}`;
      if (!ready(ref)) continue;
      n++;
      const fn = what === "close" ? "close" : "returnBonds";
      const words = what === "bonds" ? `send the bonds of bounty ${b.id} back` : `close bounty ${b.id}`;
      const out = await attempt("bounty", ref, { to: this.d.cfg.bounty!, abi: BT, functionName: fn, args: [BigInt(b.id)] }, { bounty: b.id, poster: b.poster, prize: b.prize, entries: b.entries }, ctx.params.maxGasWei);
      said.push(`${out.status === "dry" ? `would ${words}` : out.status === "done" ? words : `${words}: ${out.status}`}${out.status === "failed" || out.status === "skipped" ? ` (${out.why})` : ""}`);
      if (db.openActions().length > 0) break;
    }
    return said.length ? said.join("; ") : "no bounty needs closing";
  }

  // ---------- what is sent in, hashed against the chain ----------

  /** The words of a task. They must hash to what the bounty holds; nothing else is taken, so nothing has to be signed. */
  async putTask(body: Record<string, unknown>): Promise<Answer> {
    if (!this.on()) return no(503, "bounties are switched off for now");
    const id = idOf(body.id);
    if (id === null) return no(400, "id is a bounty's number");
    const task = typeof body.task === "string" ? body.task : "";
    if (!task.trim() || byteLength(task) > BOUNTY_RULES.taskBytes) return no(400, `a task is plain words, at most ${BOUNTY_RULES.taskBytes} bytes`);
    const hash = textHash(task);
    const known = this.row(id)?.task_hash ?? (await this.chainBounty(id))?.task ?? null;
    if (!known) return no(404, "there is no such bounty on the chain");
    if (known.toLowerCase() !== hash) return no(409, "these words do not hash to what the bounty holds");
    this.d.db.q("INSERT INTO bounty_tasks (bounty, body, at) VALUES (?, ?, ?) ON CONFLICT(bounty) DO NOTHING").run(id, task, this.d.now());
    return { status: 200, body: { ok: true, id } };
  }

  /** The work of an entry. It must hash to what the agent committed on the chain, under its own address and this bounty. */
  async putEntry(body: Record<string, unknown>): Promise<Answer> {
    if (!this.on()) return no(503, "bounties are switched off for now");
    const id = idOf(body.id);
    const agent = normalizeAddress(body.agent);
    if (id === null) return no(400, "id is a bounty's number");
    if (!agent) return no(400, "agent is not an address");
    const work = typeof body.work === "string" ? body.work : "";
    if (!work.trim() || byteLength(work) > BOUNTY_RULES.workBytes) return no(400, `a work is at most ${BOUNTY_RULES.workBytes} bytes`);
    const hash = entryHashOf(this.d.cfg.bounty!, id, agent, textHash(work));
    const known = this.entry(id, agent)?.hash ?? (await this.chainEntry(id, agent));
    if (!known) return no(404, "this agent has not entered that bounty on the chain yet: try again in a moment");
    if (known.toLowerCase() !== hash) return no(409, "this work does not hash to what the agent committed on the chain");
    this.d.db.q("INSERT INTO bounty_works (bounty, agent, kind, body, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(bounty, agent) DO NOTHING").run(id, agent, kindOf(work), work, this.d.now());
    return { status: 200, body: { ok: true, id, agent } };
  }

  /** The poster reads the entries, from the deadline. Its signature proves it, and is never kept. */
  async read(body: Record<string, unknown>): Promise<Answer> {
    if (!this.on()) return no(503, "bounties are switched off for now");
    const id = idOf(body.id);
    const poster = normalizeAddress(body.poster);
    if (id === null || !poster) return no(400, "id is a bounty's number and poster an address");
    const b = this.row(id);
    if (!b) return no(404, "no such bounty");
    if (b.poster !== poster) return no(403, "only the bounty's poster reads its entries before they are public");
    const at = typeof body.at === "number" && Number.isSafeInteger(body.at) && Math.abs(this.d.nowS() - body.at) <= READ_WINDOW_S ? body.at : null;
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    if (this.d.nowS() < b.deadline) return no(409, "the entries open to the poster at the deadline, once nobody can enter any more");
    let ok = false;
    try {
      ok = await this.d.signed(poster, readMessage({ id, poster, at }), body.signature);
    } catch {
      return no(503, "the chain could not be asked about the signature: try again in a moment");
    }
    if (!ok) return no(401, "the signature is not the poster's");
    return { status: 200, body: { id, items: this.entries(id).map((e) => this.entryJson(b, e, true)) } };
  }

  private async chainBounty(id: number): Promise<{ task: string } | null> {
    const x = await this.d.chain.read<{ state: number | bigint; task: string }>({ to: this.d.cfg.bounty!, abi: BT, functionName: "bounty", args: [BigInt(id)] });
    return Number(x.state) === 0 ? null : { task: x.task };
  }

  private async chainEntry(id: number, agent: string): Promise<string | null> {
    const x = await this.d.chain.read<{ hash: string; at: number | bigint }>({ to: this.d.cfg.bounty!, abi: BT, functionName: "entryOf", args: [BigInt(id), agent] });
    return Number(x.at) === 0 ? null : x.hash;
  }

  // ---------- Factor's own agents ----------

  /** Spent on models for entries today (UTC), in millionths of a dollar. */
  spentToday(): number {
    const now = this.d.now(), from = now - (now % 86_400_000);
    return (this.d.db.q("SELECT COALESCE(SUM(cost_micro), 0) AS n FROM bounty_house WHERE created_at >= ?").get(from) as { n: number }).n;
  }

  private houseRow(id: number, agent: string): HouseRow | null {
    return (this.d.db.q("SELECT * FROM bounty_house WHERE bounty = ? AND agent = ?").get(id, agent) as HouseRow | undefined) ?? null;
  }

  private saveHouse(id: number, agent: string, service: string, patch: Partial<Omit<HouseRow, "bounty" | "agent" | "service">>): void {
    const now = this.d.now();
    this.d.db.q("INSERT OR IGNORE INTO bounty_house (bounty, agent, service, state, created_at, updated_at) VALUES (?, ?, ?, 'skipped', ?, ?)").run(id, agent, service, now, now);
    const keys = Object.keys(patch);
    if (keys.length) this.d.db.q(`UPDATE bounty_house SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE bounty = ? AND agent = ?`).run(...Object.values(patch), now, id, agent);
  }

  /** The services a task is work for: their words are in it, and the service can work from it. In the order they are listed. */
  fitting(hands: HouseHand[], title: string, words: string): HouseHand[] {
    return hands.filter((h) => {
      const own = SERVICE_WORDS[h.service.name];
      return !!own && takesWork({ takes: [], words: own }, title, words) && !h.service.refuses(words);
    });
  }

  /**
   * One pass of Factor's own agents. They look only at bounties seen on the chain, whose words have arrived; no page view
   * and no call of the API starts this. Each work is kept before anything is sent. One new work a pass, so a run of
   * bounties cannot spend the day's cap in one go, and the cap is checked against the most a question could cost.
   */
  async housePass(): Promise<void> {
    const cfg = this.d.cfg;
    if (!cfg.house || !this.on()) return;
    const hands = this.d.house?.();
    if (!hands) return;
    const db = this.d.db;
    const ready = hands.ready();
    if (!ready.length) return;
    // first what is under way
    for (const r of db.q("SELECT * FROM bounty_house WHERE state IN ('worked', 'entering')").all() as HouseRow[]) {
      if (r.next_at > this.d.now()) continue;
      try { await this.houseOn(hands, r); } catch (e) {
        if (!revertOf(e)) this.d.log(`[bounties] ${r.service}, bounty ${r.bounty}: ${reason(e)}`);
        this.saveHouse(r.bounty, r.agent, r.service, { next_at: this.d.now() + 30_000 });
      }
    }
    const t = this.d.nowS();
    const open = db.q("SELECT * FROM bounties WHERE state = 'open' AND deadline > ? AND entries <= ? ORDER BY id").all(t + HOUSE_MARGIN_S, BOUNTY_RULES.maxEntries - HOUSE_LEAVES_SLOTS) as BountyRow[];
    for (const b of open) {
      const task = this.task(b.id);
      if (!task || task.hidden) continue;
      const { title, words } = splitTask(task.body);
      const already = (db.q("SELECT COUNT(*) AS n FROM bounty_house WHERE bounty = ? AND state != 'skipped'").get(b.id) as { n: number }).n;
      if (already >= HOUSE_PER_BOUNTY) continue;
      for (const h of this.fitting(ready, title, words)) {
        if (this.houseRow(b.id, h.address)) continue;
        // never its own: a bounty posted by Factor's own hand, or by the agent itself
        if (b.poster === h.address || this.d.sameHand(b.poster, h.address)) { this.saveHouse(b.id, h.address, h.service.name, { state: "skipped", note: "posted by the same hand" }); continue; }
        if (this.entry(b.id, h.address)) continue;
        if (this.d.scoreOf(h.address) < b.min_score) { this.saveHouse(b.id, h.address, h.service.name, { state: "skipped", note: "under the poster's minimum score" }); continue; }
        if ((await hands.balance(h.address)) < BigInt(b.bond)) { this.say(`${h.service.name} holds less than the bond of bounty ${b.id}, and passes`); continue; }
        let done: Done;
        let cost = 0;
        if (h.service.work) done = await hands.work(h.service, title, words);
        else {
          const asked = h.service.ask!(title, words);
          if (this.spentToday() + hands.worstCost(asked) > cfg.houseDailyMicro) { this.say(`the day's cap for models on bounties ($${cfg.houseDailyMicro / 1e6}) is reached: nothing more is asked today`); return; }
          try {
            const answer = await hands.ask(asked);
            cost = answer.costMicro;
            done = h.service.finish!(answer.text);
          } catch (e) {
            this.d.log(`[bounties] ${h.service.name}, bounty ${b.id}: the model did not answer (${reason(e)})`);
            return;
          }
        }
        if ("decline" in done) {
          this.saveHouse(b.id, h.address, h.service.name, { state: "skipped", note: done.decline, cost_micro: cost });
          this.d.log(`[bounties] ${h.service.name} passes on bounty ${b.id}: ${done.decline}`);
          if (cost > 0) return;
          continue;
        }
        if (byteLength(done.work) > BOUNTY_RULES.workBytes) { this.saveHouse(b.id, h.address, h.service.name, { state: "skipped", note: "the work came out too large", cost_micro: cost }); return; }
        this.saveHouse(b.id, h.address, h.service.name, { state: "worked", work: done.work, cost_micro: cost });
        this.d.log(`[bounties] ${h.service.name} did the work for bounty ${b.id}${cost ? `: $${(cost / 1e6).toFixed(4)} for the model, $${(this.spentToday() / 1e6).toFixed(4)} of $${cfg.houseDailyMicro / 1e6} today` : ", asking no model"}`);
        await this.houseOn(hands, this.houseRow(b.id, h.address)!).catch((e: unknown) => { this.d.log(`[bounties] ${h.service.name}, bounty ${b.id}: ${reason(e)}`); });
        return;
      }
    }
  }

  private say(line: string): void {
    if (line === this.lastHouseSay) return;
    this.lastHouseSay = line;
    this.d.log(`[bounties] ${line}`);
  }

  /** A work that is done goes on the chain as an entry; once it has, the work is stored. */
  private async houseOn(hands: HouseHands, r: HouseRow): Promise<void> {
    const b = this.row(r.bounty);
    if (!b) return;
    if (r.state === "entering" && r.relay) {
      const how = hands.relay(r.relay);
      if (how === "waiting") return;
      if (how === "done") {
        this.saveHouse(r.bounty, r.agent, r.service, { state: "entered", relay: null });
        this.d.db.q("INSERT INTO bounty_works (bounty, agent, kind, body, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(bounty, agent) DO NOTHING").run(r.bounty, r.agent, kindOf(r.work), r.work, this.d.now());
        this.d.log(`[bounties] ${r.service} entered bounty ${r.bounty}`);
        return;
      }
      if (r.tries + 1 >= HOUSE_MOST_TRIES) return this.saveHouse(r.bounty, r.agent, r.service, { state: "skipped", note: "its entry did not go through", relay: null, tries: r.tries + 1 });
      return this.saveHouse(r.bounty, r.agent, r.service, { state: "worked", relay: null, tries: r.tries + 1, next_at: this.d.now() + 20_000 * 2 ** r.tries });
    }
    if (r.state !== "worked") return;
    // its time ran out or the slots filled while it worked: what it cost is spent, and nothing more is
    if (b.state !== "open" || this.d.nowS() >= b.deadline || b.entries >= BOUNTY_RULES.maxEntries) return this.saveHouse(r.bounty, r.agent, r.service, { state: "skipped", note: "the bounty took no more entries by the time the work was done" });
    const hash = entryHashOf(this.d.cfg.bounty!, r.bounty, r.agent, textHash(r.work));
    const data = encodeFunctionData({ abi: factorBountyAbi as Abi, functionName: "enter", args: [BigInt(r.bounty), r.agent, hash] });
    let relay: string | null;
    try {
      relay = await hands.order(r.agent, { to: this.d.cfg.bounty!, value: BigInt(b.bond), data });
    } catch (e) {
      const why = revertOf(e);
      if (!why) throw e;
      return this.saveHouse(r.bounty, r.agent, r.service, { state: "skipped", note: `the contract refuses it (${why.name})` });
    }
    if (relay) this.saveHouse(r.bounty, r.agent, r.service, { state: "entering", relay });
  }

  /** A house agent that won: the work it entered and its hash, which it delivers with no second call to a model. */
  winOf(job: number, agent: string): { work: string; proof: Hex } | null {
    const b = this.ofJob(job);
    if (!b || b.winner !== agent) return null;
    const e = this.entry(b.id, agent);
    const work = this.work(b.id, agent);
    if (!e || !work) return null;
    return { work: work.body, proof: e.hash as Hex };
  }

  // ---------- what the site reads ----------

  /** Whether a bounty's entries are public now: a winner picked, or the bounty over. */
  revealed(b: BountyRow): boolean {
    return b.state !== "open";
  }

  status(b: BountyRow, t = this.d.nowS()): BountyStatus {
    if (b.state !== "open") return b.state;
    if (t < b.deadline) return "open";
    if (b.entries === 0) return "ending";
    return t < b.deadline + BOUNTY_RULES.pickS ? "choosing" : "ending";
  }

  about(): BountiesAbout {
    const on = this.on();
    const t = this.totals();
    return {
      enabled: on, contract: this.d.cfg.bounty, chainId: this.d.chainId,
      rules: { burnPct: BOUNTY_RULES.burnPct, bondPct: BOUNTY_RULES.bondPct, jobFeePct: BOUNTY_RULES.jobFeePct, minPrizeEth: BOUNTY_RULES.minPrizeEth, maxEntries: BOUNTY_RULES.maxEntries, minOpenH: BOUNTY_RULES.minOpenH, maxOpenD: BOUNTY_RULES.maxOpenD, pickD: BOUNTY_RULES.pickD, deliverD: BOUNTY_RULES.deliverD, graceH: BOUNTY_RULES.graceH, taskBytes: BOUNTY_RULES.taskBytes, workBytes: BOUNTY_RULES.workBytes },
      totals: on && t ? { bounties: t.count, prizesEth: ethNum(t.prizes), openEth: ethNum(t.held), wonEth: ethNum(t.won), splitEth: ethNum(t.split), burnedEth: ethNum(t.burned), open: (this.d.db.q("SELECT COUNT(*) AS n FROM bounties WHERE state = 'open'").get() as { n: number }).n, entries: (this.d.db.q("SELECT COUNT(*) AS n FROM bounty_entries").get() as { n: number }).n } : null,
    };
  }

  /** One bounty as the board shows it. Never any work. */
  bountyJson(b: BountyRow): BountyJson {
    const t = this.d.nowS();
    const task = this.task(b.id);
    const shown = task && !task.hidden ? splitTask(task.body) : null;
    const job = b.job !== null ? (this.d.db.q("SELECT state, due_at, delivered_at FROM desk_jobs WHERE id = ?").get(b.job) as { state: number; due_at: number; delivered_at: number } | undefined) : undefined;
    const status = this.status(b, t);
    const named = (a: string) => ({ address: a, name: this.name(a), named: this.d.names().has(a) });
    return {
      id: b.id, poster: b.poster, prizeEth: ethNum(b.prize), prizeWei: b.prize, feeEth: ethNum(b.fee), feeWei: b.fee, bondEth: ethNum(b.bond), bondWei: b.bond,
      deadline: iso(b.deadline), pickUntil: iso(b.deadline + BOUNTY_RULES.pickS), minScore: b.min_score, taskHash: b.task_hash, title: shown?.title ?? null, task: shown ? task!.body : null, hidden: !!task?.hidden,
      state: b.state, status, entries: b.entries, slots: BOUNTY_RULES.maxEntries, revealed: this.revealed(b), postedAt: iso(b.at), tx: b.tx_hash,
      ...(b.winner ? { winner: named(b.winner) } : {}),
      ...(b.job !== null ? { job: { n: b.job, id: String(b.job).padStart(4, "0"), ...(job ? { state: job.state, dueAt: iso(job.due_at), ...(job.delivered_at ? { deliveredAt: iso(job.delivered_at) } : {}) } : {}) } } : {}),
      ...(b.picked_tx ? { pickedTx: b.picked_tx, pickedAt: iso(b.picked_at ?? 0) } : {}),
      ...(b.closed_tx ? { closedTx: b.closed_tx, closedAt: iso(b.closed_at ?? 0), shareEth: ethNum(b.share), paidTo: b.paid_to, burnedEth: ethNum(b.burned), toPosterEth: ethNum(b.to_poster) } : {}),
      ...(status === "ending" ? { next: b.entries === 0 ? "returns" as const : "splits" as const } : {}),
    };
  }

  /** How a desk job names the bounty it is the prize of, and the hash its winner delivers as its proof. */
  jobLink(b: BountyRow): { id: number; title: string | null; poster: string; proof: string | null } {
    const task = this.task(b.id);
    return { id: b.id, title: task && !task.hidden ? splitTask(task.body).title : null, poster: b.poster, proof: b.winner ? this.entry(b.id, b.winner)?.hash ?? null : null };
  }

  /** One entry. `full`: with all of its work; otherwise the start of it. The caller has decided that it may be seen. */
  entryJson(b: BountyRow, e: EntryRow, full: boolean): BountyEntryJson {
    const w = this.work(b.id, e.agent);
    const house = !!this.d.db.q("SELECT 1 FROM bounty_house WHERE bounty = ? AND agent = ? AND state = 'entered'").get(b.id, e.agent);
    return {
      agent: e.agent, name: this.name(e.agent), named: this.d.names().has(e.agent), n: e.n, enteredAt: iso(e.at), hash: e.hash, tx: e.tx_hash, score: this.d.scoreOf(e.agent), won: b.winner === e.agent, house,
      shown: !!w, shareEth: ethNum(e.got_share), bondBackEth: ethNum(e.got_bond),
      ...(w ? { kind: w.kind, work: full ? w.body : w.body.slice(0, 4000), whole: full || w.body.length <= 4000 } : {}),
    };
  }

  /** One bounty's page: its facts, and its entries once they are public. */
  json(id: number): (BountyJson & { items?: BountyEntryJson[] }) | null {
    const b = this.row(id);
    if (!b) return null;
    return { ...this.bountyJson(b), ...(this.revealed(b) ? { items: this.entries(id).map((e) => this.entryJson(b, e, false)) } : {}) };
  }

  entryWhole(id: number, agent: string): BountyEntryJson | null {
    const b = this.row(id);
    const e = b && this.revealed(b) ? this.entry(id, agent) : null;
    return b && e ? this.entryJson(b, e, true) : null;
  }

  /** Whether an agent's entry and its work have arrived. Nothing hidden: its address and hash are on the chain. */
  mine(id: number, agent: string): { entered: boolean; workShown: boolean; hash?: string } {
    const e = this.entry(id, agent);
    return { entered: !!e, workShown: !!this.work(id, agent), ...(e ? { hash: e.hash } : {}) };
  }

  list(o: { show?: string; poster?: string; agent?: string; limit?: number }): BountyJson[] {
    const limit = o.limit ?? 50;
    const db = this.d.db;
    let rows: BountyRow[];
    if (o.poster) rows = db.q("SELECT * FROM bounties WHERE poster = ? ORDER BY id DESC LIMIT ?").all(o.poster, limit) as BountyRow[];
    else if (o.agent) rows = db.q("SELECT b.* FROM bounties b JOIN bounty_entries e ON e.bounty = b.id WHERE e.agent = ? ORDER BY b.id DESC LIMIT ?").all(o.agent, limit) as BountyRow[];
    else if (o.show === "open") rows = db.q("SELECT * FROM bounties WHERE state IN ('open', 'picked') ORDER BY deadline, id LIMIT ?").all(limit) as BountyRow[];
    else rows = db.q("SELECT * FROM bounties ORDER BY id DESC LIMIT ?").all(limit) as BountyRow[];
    return rows.map((b) => this.bountyJson(b));
  }

  /** A poster's history, in the open: what it posted, what became of each, and whom it picked. The answer to the free-work attack is that this is public. */
  posterJson(poster: string): { poster: string; posted: number; won: number; unpicked: number; undelivered: number; empty: number; open: number; items: BountyJson[]; picks: { bounty: number; winner: string; name: string; score: number; jobsSettled: number }[] } {
    const count = (state: string) => (this.d.db.q("SELECT COUNT(*) AS n FROM bounties WHERE poster = ? AND state = ?").get(poster, state) as { n: number }).n;
    const picks = (this.d.db.q("SELECT id, winner FROM bounties WHERE poster = ? AND winner IS NOT NULL ORDER BY id DESC LIMIT 20").all(poster) as { id: number; winner: string }[]).map((r) => ({
      bounty: r.id, winner: r.winner, name: this.name(r.winner), score: this.d.scoreOf(r.winner),
      jobsSettled: (this.d.db.q("SELECT COUNT(*) AS n FROM desk_jobs WHERE agent = ? AND state = 4").get(r.winner) as { n: number }).n,
    }));
    return { poster, posted: (this.d.db.q("SELECT COUNT(*) AS n FROM bounties WHERE poster = ?").get(poster) as { n: number }).n, won: count("won"), unpicked: count("unpicked"), undelivered: count("undelivered"), empty: count("empty"), open: count("open") + count("picked"), items: this.list({ poster, limit: 20 }), picks };
  }

  /** An agent's wins and entries, or null when it has none. */
  agentJson(address: string): AgentBountiesJson | null {
    if (!this.on()) return null;
    const db = this.d.db;
    const entered = (db.q("SELECT COUNT(*) AS n FROM bounty_entries WHERE agent = ?").get(address) as { n: number }).n;
    if (!entered) return null;
    const wins = db.q("SELECT prize FROM bounties WHERE winner = ? AND state = 'won'").all(address) as { prize: string }[];
    const split = (db.q("SELECT got_share FROM bounty_entries WHERE agent = ?").all(address) as { got_share: string }[]).reduce((n, r) => n + BigInt(r.got_share), 0n);
    return { entered, won: wins.length, wonEth: ethNum(wins.reduce((n, r) => n + BigInt(r.prize), 0n).toString()), splitEth: ethNum(split.toString()), items: this.list({ agent: address, limit: 10 }) };
  }

  /** For the owner's health answer. */
  health(): Record<string, unknown> {
    const count = (state: string) => (this.d.db.q("SELECT COUNT(*) AS n FROM bounties WHERE state = ?").get(state) as { n: number }).n;
    return { reading: this.reading(), on: this.on(), bounty: this.d.cfg.bounty, open: count("open"), picked: count("picked"), won: count("won"), house: this.d.cfg.house, houseSpentTodayMicro: this.spentToday(), houseDailyMicro: this.d.cfg.houseDailyMicro, totals: this.totals(), note: this.d.cfg.note };
  }
}

/** The first line of a task is its title, the whole of it is what agents work from. */
export function splitTask(body: string): { title: string; words: string } {
  const title = (body.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 140);
  return { title, words: body };
}

export const kindOf = (work: string): "text" | "html" => (/^\s*<!doctype html/i.test(work) ? "html" : "text");

type Answer = { status: number; body: Record<string, unknown> };
const no = (status: number, error: string): Answer => ({ status, body: { error } });
const idOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null);
const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

/** What bounties are, as the site reads it: web/src/lib/types.ts keeps the same shape by hand. */
export interface BountiesAbout {
  enabled: boolean; contract: string | null; chainId: number;
  rules: { burnPct: number; bondPct: number; jobFeePct: number; minPrizeEth: number; maxEntries: number; minOpenH: number; maxOpenD: number; pickD: number; deliverD: number; graceH: number; taskBytes: number; workBytes: number };
  totals: { bounties: number; prizesEth: number; openEth: number; wonEth: number; splitEth: number; burnedEth: number; open: number; entries: number } | null;
}

export interface BountyJson {
  id: number; poster: string; prizeEth: number; prizeWei: string; feeEth: number; feeWei: string; bondEth: number; bondWei: string;
  deadline: string; pickUntil: string; minScore: number; taskHash: string;
  /** the task's first line and the whole of it; null until its words have arrived, or while the owner hides them */
  title: string | null; task: string | null; hidden: boolean;
  state: BountyState; status: BountyStatus; entries: number; slots: number; revealed: boolean; postedAt: string; tx: string;
  winner?: { address: string; name: string; named: boolean };
  job?: { n: number; id: string; state?: number; dueAt?: string; deliveredAt?: string };
  pickedTx?: string; pickedAt?: string; closedTx?: string; closedAt?: string; shareEth?: number; paidTo?: number; burnedEth?: number; toPosterEth?: number;
  /** its time is up: what anyone's close does */
  next?: "returns" | "splits";
}

export interface BountyEntryJson {
  agent: string; name: string; named: boolean; n: number; enteredAt: string; hash: string; tx: string; score: number; won: boolean;
  /** one of Factor's own agents entered on its own */
  house: boolean;
  /** its work reached the engine */
  shown: boolean;
  kind?: "text" | "html"; work?: string; whole?: boolean;
  shareEth: number; bondBackEth: number;
}

export interface AgentBountiesJson { entered: number; won: number; wonEth: number; splitEth: number; items: BountyJson[] }

const iso = (s: number): string => new Date(s * 1000).toISOString();
// every digit kept: a share and a bond are often under a millionth of an ETH
const ethNum = (wei: string): number => Number(formatEther(BigInt(wei)));
const ethText = (wei: string): string => {
  const n = ethNum(wei);
  return n >= 0.01 ? n.toFixed(4) : n.toFixed(6);
};
