// ERC-8004: every job settled on Factor written to its agent's reputation on Robinhood Chain, so any app that reads
// the standard sees the agent's real work.
//
// ERC-8004 is a standard pair of registries. The identity registry gives an agent a number (its agentId, an NFT) with
// an owner and an "agentWallet"; the reputation registry holds what others say about an agentId, each entry a value
// with two tags, a link to a file and that file's hash. Both are deployed on Robinhood Chain at the standard addresses
// (version 2.0.0). Nothing here is a contract of Factor's.
//
// Three parts:
//
//   LINK    Factor learns which of its agents have an ERC-8004 identity. It reads the identity registry from time to
//           time (every identity's owner and agentWallet, a few hundred in one request) and links an agent on the
//           desk to the identity whose agentWallet is the agent's own wallet, or failing that, the one it owns. When
//           there is more than one, or to choose another, the agent signs which one (linkMessage, POST
//           /v1/erc8004/link); the identity must be its own on the chain either way. An agent can sign "none" too.
//   WRITE   For every job of a linked agent that settles from then on, the gas wallet writes ONE entry to the agent's
//           reputation: giveFeedback(agentId, value, 0, "factor", <how the job came>, "", <the file's address>, <its
//           hash>). The value: 100 for a job delivered and paid in full, 50 for one the customer rejected and that
//           settled at half. The file (feedbackFile) says which job, its price, how it was paid and settled, with the
//           transactions; it is kept here word for word and served at <site>/api/v1/erc8004/feedback/<job>, and its
//           keccak256 is the hash on the chain. Each job once: the entry is written down before it is sent and the
//           job is never sent again once it is on its way or mined (./chain/act.ts follows it like any other).
//   PAST    ERC8004_BACKFILL=on writes the settled jobs from before an agent was linked, once, oldest first.
//
// What the registry itself holds to: the writer may not be the identity's owner or one it approved (it says
// "Self-feedback not allowed"). So the gas wallet must never own an identity Factor writes to; a job the registry
// refuses for that is set aside and said so. Demonstration jobs (Factor's own customer hiring Factor's own agents) and
// jobs an agent locked for itself are not written: an entry says a customer paid for the work.
//
// Switches: ERC8004=on (off unless it is said) does all of it; the owner's "erc8004" switch (./switches.ts) stops the
// writing at once without a restart; ERC8004_GAS_DAY_WEI is the most the entries may cost in a day.

import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, keccak256, toHex, type Abi, type Hex } from "viem";
import { erc8004IdentityAbi, erc8004ReputationAbi, multicall3Abi } from "./abi/index.js";
import { normalizeAddress } from "./chain/address.js";
import type { CallSpec, Chain, Receipt } from "./chain/chain.js";
import type { EngineDb } from "./chain/db.js";
import { STATE, type JobRow } from "./desk.js";
import type { IncomeSource } from "./factorscore.js";

type Env = Record<string, string | undefined>;

export const IDENTITY_REGISTRY = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
export const REPUTATION_REGISTRY = "0x8004baa17c55a88189ae136b182e5fda19de9b63";
export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

/** What an entry says: 100 for a job delivered and paid in full, 50 for one settled at half. Whole numbers. */
export const VALUE = { settled: 100, half: 50 } as const;
export const VALUE_DECIMALS = 0;
/** The first tag of every entry Factor writes: what an app filters on to read Factor's entries alone. */
export const TAG1 = "factor";
/** The second tag: how the job came to the agent. */
export const TAG2: Record<IncomeSource, string> = { jobs: "job", monthly: "monthly", subjobs: "subjob", firm: "firm" };

export interface Erc8004Config {
  /** ERC8004=on: off unless it is said */
  enabled: boolean;
  /** ERC8004_BACKFILL=on: the settled jobs from before an agent was linked are written too, once */
  backfill: boolean;
  identity: string;
  reputation: string;
  /** ERC8004_GAS_DAY_WEI: the most the entries may cost the gas wallet in 24 hours, at the most it could pay a gas */
  gasDayWei: bigint;
  /** ERC8004_PER_PASS: entries written in one pass at most */
  perPass: number;
  /** the site, for the address of each entry's file */
  site: string;
  /** ERC8004_SCAN_FROM: the first identity the registry is read from (0). For a copy of the chain, where each identity read costs a request to the real node */
  scanFrom: number;
  /** ERC8004_SCAN_EVERY_S: how often the identities made since the last reading are read (300) */
  scanEveryS: number;
  /** ERC8004_SCAN_BATCH: identities in one request (400). A copy of the chain wants a few: each one read there is a request to the real node */
  scanBatch: number;
}

export function readErc8004(env: Env, problems: string[] = []): Erc8004Config {
  const sw = (name: string): boolean => {
    const raw = (env[name] ?? "").trim().toLowerCase();
    if (raw && raw !== "on" && raw !== "off") problems.push(`${name} must be on or off: it is "${env[name]}"`);
    return raw === "on";
  };
  const address = (name: string, def: string): string => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    const a = normalizeAddress(raw);
    if (!a) problems.push(`${name} is not an address: "${raw}"`);
    return a ?? def;
  };
  let gasDayWei = 2_000_000_000_000_000n; // 0.002 ETH: some hundreds of entries at today's price of gas
  const rawGas = env.ERC8004_GAS_DAY_WEI?.trim();
  if (rawGas) {
    if (/^\d{1,30}$/.test(rawGas)) gasDayWei = BigInt(rawGas);
    else problems.push(`ERC8004_GAS_DAY_WEI must be whole wei, as digits: it is "${rawGas}"`);
  }
  let perPass = 5;
  const rawPer = env.ERC8004_PER_PASS?.trim();
  if (rawPer) {
    if (/^\d{1,3}$/.test(rawPer) && Number(rawPer) >= 1 && Number(rawPer) <= 50) perPass = Number(rawPer);
    else problems.push(`ERC8004_PER_PASS must be a whole number from 1 to 50: it is "${rawPer}"`);
  }
  let scanFrom = 0;
  const rawFrom = env.ERC8004_SCAN_FROM?.trim();
  if (rawFrom) {
    if (/^\d{1,12}$/.test(rawFrom)) scanFrom = Number(rawFrom);
    else problems.push(`ERC8004_SCAN_FROM must be an identity's number: it is "${rawFrom}"`);
  }
  let scanEveryS = 300;
  const rawEvery = env.ERC8004_SCAN_EVERY_S?.trim();
  if (rawEvery) {
    if (/^\d{1,6}$/.test(rawEvery) && Number(rawEvery) >= 1) scanEveryS = Number(rawEvery);
    else problems.push(`ERC8004_SCAN_EVERY_S must be a whole number of seconds: it is "${rawEvery}"`);
  }
  let scanBatch = 400;
  const rawBatch = env.ERC8004_SCAN_BATCH?.trim();
  if (rawBatch) {
    if (/^\d{1,4}$/.test(rawBatch) && Number(rawBatch) >= 1 && Number(rawBatch) <= 1000) scanBatch = Number(rawBatch);
    else problems.push(`ERC8004_SCAN_BATCH must be a whole number from 1 to 1000: it is "${rawBatch}"`);
  }
  const site = (env.FACTOR_SITE_URL?.trim() || "https://factoragents.fun").replace(/\/+$/, "");
  return { enabled: sw("ERC8004"), backfill: sw("ERC8004_BACKFILL"), identity: address("ERC8004_IDENTITY", IDENTITY_REGISTRY), reputation: address("ERC8004_REPUTATION", REPUTATION_REGISTRY), gasDayWei, perPass, site, scanFrom, scanEveryS, scanBatch };
}

/** The identity registry the way ERC-8004 names it: eip155:<chain>:<address>. */
export const registryOf = (chainId: number, identity: string): string => `eip155:${chainId}:${getAddress(identity)}`;

/**
 * The words an agent signs to link its ERC-8004 identity (agentId "none": it has none, or wants none linked). The same
 * to the letter in the kit (packages/kit/src/erc8004.ts) and on the site (web/src/lib/erc8004.ts).
 */
export const linkMessage = (o: { agent: string; agentId: string | null; registry: string; at: number }): string =>
  ["Factor: link an ERC-8004 identity", `agent: ${o.agent}`, `agentId: ${o.agentId ?? "none"}`, `registry: ${o.registry}`, `at: ${o.at}`].join("\n");

// ---------- the books ----------

export interface LinkRow {
  agent: string;
  agent_id: string | null; // decimal; null: the agent signed that it wants none linked
  how: "found" | "signed";
  via: "wallet" | "owner" | "none";
  linked_at: number; // chain seconds: jobs settled from then on are written
  signed_at: number | null;
  signature: string | null;
  lost: string | null; // why the identity is no longer the agent's on the chain; null while it is
  checked_at: number; // ms
}

export type EntryStatus = "queued" | "sent" | "done" | "refused" | "skipped";
export interface EntryRow {
  job_id: number;
  agent: string;
  agent_id: string;
  writer: string;
  value: number;
  tag2: string;
  uri: string;
  hash: string;
  body: string;
  past: number;
  status: EntryStatus;
  tx_hash: string | null;
  feedback_index: number | null;
  block: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
-- ERC-8004 (./erc8004.ts). Which identity each agent on the desk is linked to. Never taken back by a reindex.
CREATE TABLE IF NOT EXISTS erc8004_links (
  agent TEXT PRIMARY KEY,
  agent_id TEXT,                     -- decimal; NULL: the agent signed that it wants none
  how TEXT NOT NULL,                 -- found | signed
  via TEXT NOT NULL,                 -- wallet | owner | none: what makes the identity the agent's on the chain
  linked_at INTEGER NOT NULL,        -- chain seconds
  signed_at INTEGER,
  signature TEXT,
  lost TEXT,
  checked_at INTEGER NOT NULL        -- ms
);
-- The identities whose agentWallet or owner is an agent on the desk, as the last reading of the registry found them.
CREATE TABLE IF NOT EXISTS erc8004_found (
  agent TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  via TEXT NOT NULL,                 -- wallet | owner
  sweep INTEGER NOT NULL,
  PRIMARY KEY (agent, agent_id)
);
-- One entry for each settled job of a linked agent: the file as it was written, and the transaction. Never taken back
-- by a reindex: what is on the chain is there.
CREATE TABLE IF NOT EXISTS erc8004_entries (
  job_id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  writer TEXT NOT NULL,
  value INTEGER NOT NULL,
  tag2 TEXT NOT NULL,
  uri TEXT NOT NULL,
  hash TEXT NOT NULL,
  body TEXT NOT NULL,
  past INTEGER NOT NULL DEFAULT 0,   -- written by the backfill
  status TEXT NOT NULL,              -- queued | sent | done | refused | skipped
  tx_hash TEXT,
  feedback_index INTEGER,
  block INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,       -- ms
  updated_at INTEGER NOT NULL        -- ms
);
CREATE INDEX IF NOT EXISTS erc8004_entries_agent ON erc8004_entries (agent, job_id);
CREATE INDEX IF NOT EXISTS erc8004_entries_status ON erc8004_entries (status);
`;

export class Erc8004Store {
  constructor(private db: EngineDb) {
    db.db.exec(SCHEMA);
  }

  link(agent: string): LinkRow | null {
    return (this.db.q("SELECT * FROM erc8004_links WHERE agent = ?").get(agent) as LinkRow | undefined) ?? null;
  }

  links(): LinkRow[] {
    return this.db.q("SELECT * FROM erc8004_links WHERE agent_id IS NOT NULL ORDER BY linked_at").all() as LinkRow[];
  }

  setLink(l: LinkRow): void {
    this.db.q(
      "INSERT INTO erc8004_links (agent, agent_id, how, via, linked_at, signed_at, signature, lost, checked_at) VALUES (@agent, @agent_id, @how, @via, @linked_at, @signed_at, @signature, @lost, @checked_at) ON CONFLICT(agent) DO UPDATE SET agent_id = excluded.agent_id, how = excluded.how, via = excluded.via, linked_at = excluded.linked_at, signed_at = excluded.signed_at, signature = excluded.signature, lost = excluded.lost, checked_at = excluded.checked_at",
    ).run(l);
  }

  lose(agent: string, why: string | null, at: number): void {
    this.db.q("UPDATE erc8004_links SET lost = ?, checked_at = ? WHERE agent = ?").run(why, at, agent);
  }

  found(agent: string): { agent_id: string; via: "wallet" | "owner" }[] {
    return this.db.q("SELECT agent_id, via FROM erc8004_found WHERE agent = ? ORDER BY CAST(agent_id AS INTEGER)").all(agent) as { agent_id: string; via: "wallet" | "owner" }[];
  }

  entry(job: number): EntryRow | null {
    return (this.db.q("SELECT * FROM erc8004_entries WHERE job_id = ?").get(job) as EntryRow | undefined) ?? null;
  }

  /** An agent's entries that are written, or on their way: newest first. */
  entries(agent: string, limit = 20): EntryRow[] {
    return this.db.q("SELECT * FROM erc8004_entries WHERE agent = ? AND status IN ('sent', 'done') ORDER BY job_id DESC LIMIT ?").all(agent, limit) as EntryRow[];
  }

  counts(agent?: string): { done: number; sent: number; queued: number; refused: number; skipped: number; sum: number } {
    const rows = (agent
      ? this.db.q("SELECT status, COUNT(*) AS n, SUM(value) AS s FROM erc8004_entries WHERE agent = ? GROUP BY status").all(agent)
      : this.db.q("SELECT status, COUNT(*) AS n, SUM(value) AS s FROM erc8004_entries GROUP BY status").all()) as { status: EntryStatus; n: number; s: number | null }[];
    const out = { done: 0, sent: 0, queued: 0, refused: 0, skipped: 0, sum: 0 };
    for (const r of rows) {
      out[r.status] = r.n;
      if (r.status === "done") out.sum = r.s ?? 0;
    }
    return out;
  }

  put(e: Omit<EntryRow, "created_at" | "updated_at">, now: number): void {
    this.db.q(
      "INSERT INTO erc8004_entries (job_id, agent, agent_id, writer, value, tag2, uri, hash, body, past, status, tx_hash, feedback_index, block, error, created_at, updated_at) VALUES (@job_id, @agent, @agent_id, @writer, @value, @tag2, @uri, @hash, @body, @past, @status, @tx_hash, @feedback_index, @block, @error, @now, @now) ON CONFLICT(job_id) DO UPDATE SET agent = excluded.agent, agent_id = excluded.agent_id, writer = excluded.writer, value = excluded.value, tag2 = excluded.tag2, uri = excluded.uri, hash = excluded.hash, body = excluded.body, past = excluded.past, status = excluded.status, tx_hash = excluded.tx_hash, feedback_index = excluded.feedback_index, block = excluded.block, error = excluded.error, updated_at = excluded.updated_at",
    ).run({ ...e, now });
  }

  mark(job: number, f: Partial<Pick<EntryRow, "status" | "tx_hash" | "feedback_index" | "block" | "error">>, now: number): void {
    const e = this.entry(job);
    if (!e) return;
    this.db.q("UPDATE erc8004_entries SET status = ?, tx_hash = ?, feedback_index = ?, block = ?, error = ?, updated_at = ? WHERE job_id = ?").run(
      f.status ?? e.status, f.tx_hash === undefined ? e.tx_hash : f.tx_hash, f.feedback_index === undefined ? e.feedback_index : f.feedback_index,
      f.block === undefined ? e.block : f.block, f.error === undefined ? e.error : f.error, now, job,
    );
  }

  /** Entries this writer has on the chain for an identity, or on their way, as Factor's notes have them. */
  written(agentId: string, writer: string): number {
    return (this.db.q("SELECT COUNT(*) AS n FROM erc8004_entries WHERE agent_id = ? AND writer = ? AND status IN ('sent', 'done')").get(agentId, writer) as { n: number }).n;
  }
}

// ---------- the file each entry points at ----------

export interface FeedbackFile {
  agentRegistry: string;
  agentId: number | string;
  clientAddress: string;
  createdAt: string;
  value: number;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  proofOfPayment?: { fromAddress: string; toAddress: string; chainId: string; txHash: string };
  factor: {
    job: number;
    page: string;
    outcome: "paid in full" | "settled at half";
    agent: string;
    customer: string;
    priceWei: string;
    deliveredAt: string | null;
    onTime: boolean;
    income: string;
    desk: string;
    lockedTx: string | null;
    settledTx: string | null;
  };
}

/**
 * The file an entry points at, as ERC-8004 lays one out (agentRegistry, agentId, clientAddress, createdAt, value,
 * valueDecimals, tags, proofOfPayment) with Factor's own part beside it. Everything in it is fixed once the job has
 * settled, so it never changes; it is written as compact JSON, and its keccak256 is the hash on the chain.
 */
export function feedbackFile(o: { chainId: number; identity: string; agentId: string; writer: string; desk: string; site: string; job: JobRow; settledTx: string | null; tag2: string }): { file: FeedbackFile; body: string; hash: Hex; value: number } {
  const j = o.job;
  const full = j.state === STATE.settled;
  const value = full ? VALUE.settled : VALUE.half;
  const id = BigInt(o.agentId);
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const file: FeedbackFile = {
    agentRegistry: registryOf(o.chainId, o.identity),
    agentId: id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : id.toString(),
    clientAddress: `eip155:${o.chainId}:${getAddress(o.writer)}`,
    createdAt: iso(j.closed_at),
    value,
    valueDecimals: VALUE_DECIMALS,
    tag1: TAG1,
    tag2: o.tag2,
    ...(j.locked_tx ? { proofOfPayment: { fromAddress: getAddress(j.customer), toAddress: getAddress(o.desk), chainId: String(o.chainId), txHash: j.locked_tx } } : {}),
    factor: {
      job: j.id,
      page: `${o.site}/jobs/${j.id}`,
      outcome: full ? "paid in full" : "settled at half",
      agent: getAddress(j.agent),
      customer: getAddress(j.customer),
      priceWei: j.price,
      deliveredAt: j.delivered_at ? iso(j.delivered_at) : null,
      onTime: !j.late,
      income: o.tag2,
      desk: getAddress(o.desk),
      lockedTx: j.locked_tx || null,
      settledTx: o.settledTx,
    },
  };
  const body = JSON.stringify(file);
  return { file, body, hash: keccak256(toHex(body)), value };
}

// ---------- the identity registry, read ----------

/** How often the whole registry is read again (an identity's wallet or owner can change), and the new ones. */
const FULL_EVERY_MS = 24 * 3_600_000;
/** Requests in one pass at most. A reading of the new identities asks for fewer at a time: most of them are not there yet. */
const BATCHES_PER_PASS = 8;
const NEW_BATCH = 50;

interface ScanState { next: number; end: number | null; sweep: number; running: "full" | "new" | null; fullAt: number; newAt: number; /** agents on the desk when the last whole reading began */ agents?: number }

export interface Erc8004Deps {
  db: EngineDb;
  chain: Chain;
  chainId: number;
  desk: string;
  explorer: string;
  /** the wall clock, ms */
  now: () => number;
  /** the chain's time now, seconds */
  nowS: () => number;
  /** the gas wallet: the address every entry is written from, or null when the engine holds no key */
  writer: () => string | null;
  /** whether `address` signed the words: a wallet, or an account through one of its keys */
  signed: (address: string, message: string, signature: unknown) => Promise<boolean>;
  /** how a job came to its agent (./factorscore.ts) */
  sourceOf: (agent: string, job: number) => IncomeSource;
  /** whether two addresses are run by the same hand (./subjobs.ts) */
  sameHand?: (a: string, b: string) => boolean;
  log: (line: string) => void;
}

export type LinkAnswer = { status: number; body: Record<string, unknown> };

export interface Erc8004Json {
  agentId: string;
  registry: string;
  reputation: string;
  /** the address Factor writes from: what an app passes to getSummary(agentId, [reviewer], "factor", "") */
  reviewer: string | null;
  linked: "found" | "signed";
  via: "wallet" | "owner";
  linkedAt: string;
  /** null while the identity is the agent's on the chain; otherwise why it no longer is, and nothing more is written */
  lost: string | null;
  /** entries written and mined */
  entries: number;
  /** on their way, or settled jobs waiting to be written */
  waiting: number;
  /** the average value of the entries written: 100 means every one was paid in full */
  average: number | null;
  items: { job: number; value: number; kind: string; tx: string | null; index: number | null; at: string; past: boolean; mined: boolean }[];
  /** the identity on an ERC-8004 explorer and the registry on Robinhood Chain's own */
  links: { registry: string };
}

export class Erc8004 {
  readonly store: Erc8004Store;

  constructor(readonly cfg: Erc8004Config, private d: Erc8004Deps) {
    this.store = new Erc8004Store(d.db);
  }

  get registry(): string {
    return registryOf(this.d.chainId, this.cfg.identity);
  }

  private scanState(): ScanState {
    return this.d.db.getJson<ScanState>("erc8004:scan") ?? { next: 0, end: null, sweep: 0, running: null, fullAt: 0, newAt: 0 };
  }

  /** The owner and agentWallet of each identity, many in one request. owner null: there is no such identity. */
  async identities(ids: number[]): Promise<{ id: number; owner: string | null; wallet: string | null }[]> {
    const id_ = this.cfg.identity as Hex;
    const calls = ids.flatMap((id) => [
      { target: id_, allowFailure: true, callData: encodeFunctionData({ abi: erc8004IdentityAbi, functionName: "ownerOf", args: [BigInt(id)] }) },
      { target: id_, allowFailure: true, callData: encodeFunctionData({ abi: erc8004IdentityAbi, functionName: "getAgentWallet", args: [BigInt(id)] }) },
    ]);
    const out = await this.d.chain.read<readonly { success: boolean; returnData: Hex }[]>({ to: MULTICALL3, abi: multicall3Abi as Abi, functionName: "aggregate3", args: [calls] });
    const addr = (r: { success: boolean; returnData: Hex } | undefined, fn: "ownerOf" | "getAgentWallet"): string | null => {
      if (!r?.success || r.returnData === "0x") return null;
      try {
        const a = String(decodeFunctionResult({ abi: erc8004IdentityAbi, functionName: fn, data: r.returnData })).toLowerCase();
        return /^0x0{40}$/.test(a) ? null : a;
      } catch {
        return null;
      }
    };
    return ids.map((id, i) => ({ id, owner: addr(out[2 * i], "ownerOf"), wallet: addr(out[2 * i + 1], "getAgentWallet") }));
  }

  /**
   * One step of reading the identity registry: the whole of it once a day, the identities made since every few
   * minutes, at most BATCHES_PER_PASS requests a pass. Identities are numbered from 0 with none ever taken away, so
   * the first number whose owner cannot be read is where the registry ends. Then the links that follow from it.
   */
  async scan(): Promise<string> {
    const db = this.d.db;
    const agents = new Set((db.q("SELECT address FROM desk_agents").all() as { address: string }[]).map((r) => r.address));
    if (agents.size === 0) return "no agent on the desk yet";
    const st = this.scanState();
    const now = this.d.now();
    if (!st.running) {
      // the whole registry again once a day, and soon after an agent joins the desk: it may have had an identity before
      const joined = agents.size > (st.agents ?? 0) && now - st.fullAt >= Math.min(600, 2 * this.cfg.scanEveryS) * 1000;
      if (now - st.fullAt >= FULL_EVERY_MS || joined) Object.assign(st, { running: "full", next: this.cfg.scanFrom, sweep: st.sweep + 1, agents: agents.size });
      else if (now - st.newAt >= this.cfg.scanEveryS * 1000) Object.assign(st, { running: "new", next: Math.max(st.end ?? 0, this.cfg.scanFrom) });
      else return `the registry was read ${Math.round((now - st.newAt) / 1000)} s ago`;
    }
    let finished = false;
    const add = (agent: string, id: number, via: "wallet" | "owner") =>
      db.q("INSERT INTO erc8004_found (agent, agent_id, via, sweep) VALUES (?, ?, ?, ?) ON CONFLICT(agent, agent_id) DO UPDATE SET via = excluded.via, sweep = excluded.sweep").run(agent, String(id), via, st.sweep);
    const batch = st.running === "new" ? Math.min(NEW_BATCH, this.cfg.scanBatch) : this.cfg.scanBatch;
    for (let b = 0; b < BATCHES_PER_PASS && !finished; b++) {
      const got = await this.identities(Array.from({ length: batch }, (_, i) => st.next + i));
      db.tx(() => {
        for (const r of got) {
          if (r.owner === null) {
            st.end = r.id;
            finished = true;
            break;
          }
          // an identity whose agentWallet is one agent and whose owner is another counts for each, each its own way
          if (r.wallet && agents.has(r.wallet)) add(r.wallet, r.id, "wallet");
          if (agents.has(r.owner) && r.owner !== r.wallet) add(r.owner, r.id, "owner");
        }
      });
      if (!finished) st.next += batch;
    }
    let said = `read the registry up to identity ${finished ? st.end : st.next}`;
    if (finished) {
      const full = st.running === "full";
      // a whole sweep: what it did not see again is no longer an agent's
      if (full) {
        db.q("DELETE FROM erc8004_found WHERE sweep < ?").run(st.sweep);
        st.fullAt = now;
      }
      st.newAt = now;
      st.running = null;
      said = `read the registry: ${st.end} identities`;
      const made = this.applyFound(agents, full);
      if (made) said += `, ${made} agent${made === 1 ? "" : "s"} linked`;
    }
    db.setJson("erc8004:scan", st);
    return said;
  }

  /**
   * Links that follow from what the registry says: an agent with no link gets the identity whose agentWallet is its
   * wallet, or failing that the one it owns, when there is exactly one. After a whole sweep a link whose identity is no
   * longer the agent's is marked lost (and found again when it is). Returns how many agents were linked.
   */
  applyFound(agents: Set<string>, full: boolean): number {
    const db = this.d.db;
    const now = this.d.now();
    let made = 0;
    const rows = db.q("SELECT DISTINCT agent FROM erc8004_found").all() as { agent: string }[];
    for (const { agent } of rows) {
      if (!agents.has(agent)) continue;
      const link = this.store.link(agent);
      const found = this.store.found(agent);
      if (link) {
        if (link.agent_id !== null && link.lost && found.some((f) => f.agent_id === link.agent_id)) this.store.lose(agent, null, now);
        continue;
      }
      const wallet = found.filter((f) => f.via === "wallet");
      const owner = found.filter((f) => f.via === "owner");
      const pick = wallet.length === 1 ? wallet[0] : wallet.length === 0 && owner.length === 1 ? owner[0] : null;
      if (!pick) continue;
      this.store.setLink({ agent, agent_id: pick.agent_id, how: "found", via: pick.via, linked_at: this.d.nowS(), signed_at: null, signature: null, lost: null, checked_at: now });
      this.d.log(`[erc8004] ${agent} is ERC-8004 identity #${pick.agent_id} (its ${pick.via === "wallet" ? "agentWallet" : "owner"}): linked`);
      made++;
    }
    if (full) {
      for (const l of this.store.links()) {
        if (l.lost) continue;
        if (!this.store.found(l.agent).some((f) => f.agent_id === l.agent_id)) this.store.lose(l.agent, `identity #${l.agent_id} is no longer this agent's: its owner and its agentWallet are other addresses now`, now);
      }
    }
    return made;
  }

  /** Whether identity `agentId` is `agent`'s on the chain now: its agentWallet or its owner. */
  async holds(agent: string, agentId: string): Promise<{ ok: true; via: "wallet" | "owner"; owner: string } | { ok: false; why: string; missing?: boolean }> {
    const [r] = await this.identities([Number(agentId)]).catch(async () => {
      // a registry with no Multicall3 beside it (a test chain): asked one by one
      const owner = await this.d.chain.read<string>({ to: this.cfg.identity, abi: erc8004IdentityAbi as Abi, functionName: "ownerOf", args: [BigInt(agentId)] }).then((x) => x.toLowerCase()).catch(() => null);
      const wallet = owner ? await this.d.chain.read<string>({ to: this.cfg.identity, abi: erc8004IdentityAbi as Abi, functionName: "getAgentWallet", args: [BigInt(agentId)] }).then((x) => x.toLowerCase()) : null;
      return [{ id: Number(agentId), owner, wallet: wallet && !/^0x0{40}$/.test(wallet) ? wallet : null }];
    });
    if (!r?.owner) return { ok: false, why: `there is no ERC-8004 identity #${agentId} on Robinhood Chain`, missing: true };
    if (r.wallet === agent) return { ok: true, via: "wallet", owner: r.owner };
    if (r.owner === agent) return { ok: true, via: "owner", owner: r.owner };
    return { ok: false, why: `identity #${agentId} is not this agent's: its owner is ${r.owner} and its agentWallet is ${r.wallet ?? "not set"}` };
  }

  /**
   * An agent links its identity, or says it wants none (agentId null): signed by the agent's own wallet (or one of its
   * account's keys). The identity must be the agent's on the chain: its agentWallet is the agent's wallet, or the agent
   * owns it.
   */
  async link(body: Record<string, unknown>): Promise<LinkAnswer> {
    const no = (status: number, error: string): LinkAnswer => ({ status, body: { error } });
    if (!this.cfg.enabled) return no(503, "ERC-8004 is switched off for now");
    const agent = normalizeAddress(body.agent);
    if (!agent) return no(400, "agent is not an address");
    const raw = body.agentId;
    const agentId = raw === null || raw === "none" ? null : typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : typeof raw === "string" && /^\d{1,30}$/.test(raw) ? BigInt(raw).toString() : undefined;
    if (agentId === undefined) return no(400, "agentId is the identity's number, like 42, or null for none");
    const at = typeof body.at === "number" && Number.isSafeInteger(body.at) ? body.at : null;
    if (at === null || Math.abs(Math.floor(this.d.now() / 1000) - at) > 600) return no(400, "the signature's time is more than ten minutes from now: sign again");
    if (!(await this.d.signed(agent, linkMessage({ agent, agentId, registry: this.registry, at }), body.signature))) return no(401, "the signature is not this agent's wallet's");
    if (!this.d.db.q("SELECT 1 FROM desk_agents WHERE address = ?").get(agent)) return no(404, "this wallet has not registered as an agent on the desk");
    const had = this.store.link(agent);
    if (had?.signed_at && at <= had.signed_at) return no(409, "a newer link is already stored");
    const now = this.d.now();
    if (agentId === null) {
      this.store.setLink({ agent, agent_id: null, how: "signed", via: "none", linked_at: this.d.nowS(), signed_at: at, signature: String(body.signature), lost: null, checked_at: now });
      return { status: 200, body: { ok: true, agentId: null } };
    }
    const h = await this.holds(agent, agentId);
    if (!h.ok) return no(h.missing ? 404 : 403, `${h.why}. Link it from the wallet that owns it, or set this agent's wallet as its agentWallet first`);
    const writer = this.d.writer();
    if (writer && h.owner === writer) return no(409, `Factor writes entries from ${writer}, which owns identity #${agentId}: the registry does not let an identity's owner write to its own reputation`);
    const same = had?.agent_id === agentId;
    this.store.setLink({ agent, agent_id: agentId, how: "signed", via: h.via, linked_at: same && had ? had.linked_at : this.d.nowS(), signed_at: at, signature: String(body.signature), lost: null, checked_at: now });
    this.d.log(`[erc8004] ${agent} signed that it is ERC-8004 identity #${agentId}`);
    return { status: 200, body: { ok: true, agentId, via: h.via, registry: this.registry } };
  }

  // ---------- what is to be written ----------

  /**
   * Settled jobs of linked agents with no entry yet: those settled since the link first, oldest first, then (with the
   * backfill on) the ones from before it, oldest first.
   */
  due(limit: number): { job: JobRow; link: LinkRow; past: boolean }[] {
    const rows = this.d.db.q(
      `SELECT j.*, l.agent_id AS l_agent_id, l.linked_at AS l_linked_at FROM desk_jobs j JOIN erc8004_links l ON l.agent = j.agent
       WHERE l.agent_id IS NOT NULL AND l.lost IS NULL AND j.state IN (?, ?) AND j.dirty = 0 AND j.closed_at > 0
         AND NOT EXISTS (SELECT 1 FROM erc8004_entries e WHERE e.job_id = j.id AND e.status IN ('sent', 'done', 'refused', 'skipped'))
         AND (j.closed_at >= l.linked_at OR ? = 1)
       ORDER BY (j.closed_at >= l.linked_at) DESC, j.closed_at, j.id LIMIT ?`,
    ).all(STATE.settled, STATE.half, this.cfg.backfill ? 1 : 0, limit) as (JobRow & { l_agent_id: string; l_linked_at: number })[];
    return rows.map(({ l_agent_id: _id, l_linked_at, ...job }) => ({ job, link: this.store.link(job.agent)!, past: job.closed_at < l_linked_at }));
  }

  /** Why a job is not written at all, or null: a demonstration, or a job its agent locked for itself. */
  notWritten(job: JobRow): string | null {
    if (this.d.db.q("SELECT 1 FROM demo_jobs WHERE job_id = ?").get(job.id)) return "a demonstration job: Factor's own customer hired Factor's own agent";
    if (job.customer === job.agent || this.d.sameHand?.(job.customer, job.agent)) return "the agent locked this job for itself";
    return null;
  }

  /** The entry for a job, as it will be written: the call, and the row that holds its file. */
  entry(job: JobRow, link: LinkRow, writer: string, past: boolean): { call: CallSpec; row: Omit<EntryRow, "created_at" | "updated_at"> } {
    const settledTx = (this.d.db.q("SELECT tx_hash FROM ledger WHERE job_id = ? AND kind IN ('settled', 'half') ORDER BY n DESC LIMIT 1").get(job.id) as { tx_hash: string } | undefined)?.tx_hash ?? null;
    const tag2 = TAG2[this.d.sourceOf(job.agent, job.id)] ?? TAG2.jobs;
    const agentId = link.agent_id!;
    const had = this.store.entry(job.id);
    // a file made for an earlier try is kept word for word, as long as it is for the same identity and writer
    const made = had && had.agent_id === agentId && had.writer === writer ? { body: had.body, hash: had.hash as Hex, value: had.value } : feedbackFile({ chainId: this.d.chainId, identity: this.cfg.identity, agentId, writer, desk: this.d.desk, site: this.cfg.site, job, settledTx, tag2 });
    const uri = `${this.cfg.site}/api/v1/erc8004/feedback/${job.id}`;
    const call: CallSpec = { to: this.cfg.reputation, abi: erc8004ReputationAbi as Abi, functionName: "giveFeedback", args: [BigInt(agentId), BigInt(made.value), VALUE_DECIMALS, TAG1, tag2, "", uri, made.hash] };
    return { call, row: { job_id: job.id, agent: job.agent, agent_id: agentId, writer, value: made.value, tag2, uri, hash: made.hash, body: made.body, past: past ? 1 : 0, status: "queued", tx_hash: null, feedback_index: null, block: null, error: null } };
  }

  /**
   * The registry's count of entries from the writer for an identity, against Factor's notes. More on the chain than in
   * the notes means something was written that Factor does not know of: nothing more is written to that identity until
   * that is looked at, so a job can never be written twice.
   */
  async guard(agentId: string, writer: string): Promise<string | null> {
    const onChain = await this.d.chain.read<bigint>({ to: this.cfg.reputation, abi: erc8004ReputationAbi as Abi, functionName: "getLastIndex", args: [BigInt(agentId), writer] });
    const ours = this.store.written(agentId, writer);
    return onChain > BigInt(ours) ? `the registry holds ${onChain} entries from ${writer} for identity #${agentId}, and Factor's notes ${ours}: nothing more is written to it until that is looked at` : null;
  }

  /** What the entries cost the gas wallet in the last 24 hours, at the most it could have paid a gas. */
  spentToday(): bigint {
    const rows = this.d.db.q("SELECT status, gas_used, gas_limit, max_fee_wei FROM engine_actions WHERE kind = 'erc8004' AND mode = 'live' AND tx_hash IS NOT NULL AND created_at >= ?").all(this.d.now() - 86_400_000) as { status: string; gas_used: string | null; gas_limit: string | null; max_fee_wei: string | null }[];
    let sum = 0n;
    for (const r of rows) {
      const fee = BigInt(r.max_fee_wei ?? "0");
      sum += BigInt(r.gas_used ?? (r.status === "signed" || r.status === "sent" ? (r.gas_limit ?? "0") : "0")) * fee;
    }
    return sum;
  }

  /** The entry's number in the registry, from the transaction's logs. */
  indexOf(r: Receipt): number | null {
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== this.cfg.reputation) continue;
      try {
        const d = decodeEventLog({ abi: erc8004ReputationAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
        if (d.eventName === "NewFeedback") return Number((d.args as { feedbackIndex: bigint }).feedbackIndex);
      } catch {
        // another event
      }
    }
    return null;
  }

  /** A transaction of an entry's, mined: written, or (reverted) back in the queue for another try. */
  landed(job: number, hash: string, r: Receipt): void {
    const now = this.d.now();
    if (r.ok) {
      this.store.mark(job, { status: "done", tx_hash: hash, feedback_index: this.indexOf(r), block: Number(r.blockNumber), error: null }, now);
      this.d.log(`[erc8004] job ${job} is on the agent's ERC-8004 reputation: ${hash}`);
    } else this.store.mark(job, { status: "queued", tx_hash: null, error: `the transaction reverted (${hash})` }, now);
  }

  // ---------- what the site and apps read ----------

  json(agent: string): Erc8004Json | null {
    const link = this.store.link(agent);
    if (!link || link.agent_id === null) return null;
    const c = this.store.counts(agent);
    // on its way, and settled jobs not written yet (a queued entry is one of those)
    const waiting = c.sent + this.due(500).filter((x) => x.job.agent === agent).length;
    const items = this.store.entries(agent, 20).map((e) => ({
      job: e.job_id, value: e.value, kind: e.tag2, tx: e.tx_hash, index: e.feedback_index, at: new Date(e.updated_at).toISOString(), past: !!e.past, mined: e.status === "done",
    }));
    return {
      agentId: link.agent_id, registry: this.registry, reputation: getAddress(this.cfg.reputation), reviewer: this.d.writer() ? getAddress(this.d.writer()!) : null,
      linked: link.how, via: link.via === "none" ? "wallet" : link.via, linkedAt: new Date(link.linked_at * 1000).toISOString(), lost: link.lost,
      entries: c.done, waiting, average: c.done ? Math.round((c.sum / c.done) * 10) / 10 : null, items,
      links: { registry: `${this.d.explorer}/address/${getAddress(this.cfg.identity)}` },
    };
  }

  /** What /v1/erc8004 says of the whole: whether it is on, where, and from which address entries are written. */
  about(): Record<string, unknown> {
    const c = this.store.counts();
    return {
      enabled: this.cfg.enabled, backfill: this.cfg.backfill, chainId: this.d.chainId, identityRegistry: getAddress(this.cfg.identity), reputationRegistry: getAddress(this.cfg.reputation), registry: this.registry,
      reviewer: this.d.writer() ? getAddress(this.d.writer()!) : null, tag1: TAG1, tag2: Object.values(TAG2), values: { paidInFull: VALUE.settled, settledAtHalf: VALUE.half, decimals: VALUE_DECIMALS },
      linked: this.store.links().filter((l) => !l.lost).length, entries: c.done, waiting: c.sent + c.queued,
    };
  }

  /** The file an entry points at, word for word, once its entry is on its way or written. */
  file(job: number): string | null {
    const e = this.store.entry(job);
    return e && (e.status === "sent" || e.status === "done") ? e.body : null;
  }
}
