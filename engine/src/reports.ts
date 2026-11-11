// Factor Credit Reports (docs/REPORTS.md, docs/REPORTS-SOURCES.md): a public credit report and score for every AI agent
// on Robinhood Chain, not only those on Factor. "We scored every AI agent on the chain."
//
//   GET  /v1/reports                  whether it is on, the formula's version, what has been read, the totals and the spread
//   GET  /v1/reports/formula          every number of the formula (./reportscore.ts)
//   GET  /v1/reports/top?limit=&offset=&own=   the leaderboard: every scored agent, best first
//   GET  /v1/reports/find?q=          look up any agent: its ERC-8004 number, a wallet, or a name
//   GET  /v1/reports/agent/<id>       one agent's credit report: score, parts, pulls, flags, sources, timeline, what raises it
//   GET  /v1/reports/signed/<id>      the same in short, as a text Factor signs (EIP-191), like Factor everywhere's answers
//   GET  /v1/reports/erc8004/<id>     its entry on ERC-8004: written (./reportserc8004.ts), or the entry prepared and not yet sent
//   POST /v1/reports/claim            the agent's owner signs to claim its report and add a profile
//
// An agent is its ERC-8004 identity (its number in the identity registry, with its owner and its agentWallet), and an
// agent on the Factor desk with no identity is its desk wallet. What is read, and how (docs/REPORTS-SOURCES.md):
//
//   ERC-8004    the identity, reputation and validation registries' logs, from the block they were made, read in spans of
//               REPORTS_SPAN blocks (100,000), newest first, then followed as the chain grows; each identity's owner and
//               agentWallet read at the head through Multicall3, a few hundred at a time
//   Priors      the two CreditPool contracts' Borrowed, Repaid and Defaulted logs: every loan, who it went to, who repaid it
//               and when. REPORTS_PRIORS=off leaves them out
//   Factor      the desk's jobs and agents, its credit lines, and Factor's paid reviews, as the engine already keeps them
//
// Every log span is read at most once and kept, so a restart goes on where it stopped (a cursor for each source, in the
// database). A span the node finds too big is halved; a node that turns requests away is waited out by the loop. The time
// of an event is read from the headers of the span's two ends, and placed between them by its block (the node sends no
// time with a log; within a span of 100,000 blocks that is within about half a minute).
//
// The report moves no money. Nothing here is read by a contract or by the desk's limits: those are the desk's own.
//
// Switches: REPORTS=on (off unless it is said) reads and answers; the owner's "reports" switch (./switches.ts) hides every
// report at once and stops the reading, without a restart. Turned back on, the reading goes on from its cursors.

import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Abi, type Hex } from "viem";
import { erc8004IdentityAbi, erc8004ReputationAbi, erc8004ValidationAbi, multicall3Abi } from "./abi/index.js";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import { tooMany, type Chain, type ChainLog } from "./chain/chain.js";
import type { EngineDb } from "./chain/db.js";
import { IDENTITY_REGISTRY, MULTICALL3, REPUTATION_REGISTRY, VALIDATION_REGISTRY } from "./erc8004.js";
import { seal, type AnswerSigner, type Sealed } from "./everywhere.js";
import { FORMULA, NOT_AN_OPINION, REPORT_VERSION, REVIEW_TAG, SOURCE_NAME, onHundred, scoreReport, starsOf, type DeskJobIn, type FeedbackIn, type LoanIn, type ReportInput, type ReviewIn, type ScoreResult, type SourceKey, type ValidationIn } from "./reportscore.js";
import { REPORT_ERC8004_SCHEMA, REPORT_TAG1, reportFile, type ReportOnChain } from "./reportserc8004.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

// ---------- where things are ----------

/** Priors' two credit pools on Robinhood Chain, from the deployment records in Priors' public repository (deployments/4663.json, 4663.v2.json). */
export const PRIORS_POOLS: { address: string; version: 1 | 2; from: number }[] = [
  { address: "0x0259889e6ebab1a18cee7e62bc5b9648fb6c44e5", version: 1, from: 68_593_823 },
  { address: "0x281210097f0de7a8fb6f87310af0f089c9c8de21", version: 2, from: 71_702_460 },
];
/** Priors' contracts that repay a loan out of the agent's own money (autopay, the income router, the keeper's helper). */
export const PRIORS_HELPERS = ["0x72b510af4e66e5960ab9b975e0bdcf80239e83a0", "0x496744225ed59a5215dd4d1a551a6b6350f58ace", "0x3ba233d2ac1c6233c5fa954c2daad83fccfe5372"];
/**
 * Factor's own wallets that are not house agents: the wallets of Factor's own test runs and demonstrations, as the repo's test
 * records name them (docs/*-mainnet-test.txt, contracts/broadcast) and as the keys of Factor's demo runs hold them (the
 * demo folders' keys/*.json and the customer wallets of the firms and sub-jobs demonstrations). An agent run from any of them
 * is Factor's own: scored the same way and ranked apart, and none of them is ever a paying client of another. Anvil's public
 * test key, which some fork runs used, is left out: anyone can sign with it. REPORTS_FACTOR_WALLETS adds more.
 */
export const FACTOR_WALLETS = [
  // the live test runs
  "0x50a9bf50c3337d5db03efdf89deb0f5a0b908f17", // the demo wallet
  "0x4af5cbd7baad4ae2f09d45fd9b55bd49214b2c5f", // the demo wallet's line account
  "0x74325c9644973d9c7a293bdfc970a573a38419e1", // report-lead, a test agent (the sub-jobs demonstration's lead)
  "0x81027d545af18b118da212221e76eb9925bbfb39", // fact-checker, a test agent (the sub-jobs demonstration's helper)
  "0x3b6a28461a953647af240a6bed96eb42b046b170", // the firms and sub-jobs demonstrations' customer
  "0xa733ee43ea13fd8e8777a003f49df37ff07a2d0f", // charts, the firms demonstration's member
  "0x363fce131ebeca451f2c0da118eb50f6ee2e83f3", // the Pay with Factor demonstration's agent (a passkey account)
  "0xf68614c35672e3265558f514bb818d5eef4e9ad9", // the Pay with Factor demonstration's buyer (a passkey account)
  "0xafa96b2f796968da543b77e9d1a04f80321acd04", // the admin wallet
  "0xe4314ba4dae5f31582ec23812d5f40287f1efde0", // the gas wallet
  // the demonstrations' other keys
  "0xd6cc5411b79f7f784668b76fef16380bbfe28457", // ERC-8004 demonstration, agent
  "0xf1a0acefeb7d000b76c6d050c23bc22869254c1f", // ERC-8004 demonstration, customer
  "0xf041bdd73d9587ec661997438452e90f59598a1e", // auto-apply demonstration, customer
  "0xcbb95864e57fe5915da83e40955762cd33f98d4d", // auto-apply demonstration, earlier customer
  "0xaec822869e4afca6929f70d19542375215dcb90b", // bids demonstration, crumb
  "0xb2d54e78300a7213d897f777c6370a71ebd31c92", // bids demonstration, customer
  "0x8a1dedb2c17b12e6885af43fc6f7231fa37906b6", // bids demonstration, earlier customer
  "0xc3a2875b8f52f3913e267d30374879c21927de41", // bids demonstration, proof
  "0x400e0af71e304ecfdca85ef878ce0d71b03a9a25", // open jobs demonstration, customer
  "0x49e73f2f56227e8cfe47f96583c451e9daa5313d", // open jobs demonstration, page-smith
  "0x25eb219ca1fa4219dea81f4afe23b06228831169", // open jobs demonstration, plain-reader
  "0xfa1ebd0b478e674b6813d7c1dac643bcfdcdf77d", // open jobs demonstration, red-pen
  "0x0d771ba1458ea283bd27d09624e11e011cabc42f", // verified owners demonstration, customer
  "0x29933fa3b3652c30a73e6b610e1e04b77b9d7ddf", // verified owners demonstration, earlier customer
  "0xc965bcf580d87be5c75fa3a8a94d52e231996b40", // verified owners demonstration, loaf
  "0xa67a5d42f2765bee03607557645a47b261535c56", // verified owners demonstration, quick
];

/** The first block with a log of the ERC-8004 registries on Robinhood Chain (found by reading back: nothing before it). */
export const ERC8004_FROM = 12_000_000;
/** The tag of a report's ERC-8004 entry (./reportserc8004.ts writes them). */
export { REPORT_TAG1 } from "./reportserc8004.js";

const priorsV2Abi = parseAbi([
  "event Borrowed(uint256 indexed loanId, uint256 indexed agentId, uint256 indexed sponsorId, uint256 principal, uint256 fee, uint64 dueAt, address to)",
  "event Repaid(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint256 fee, address payer)",
  "event Defaulted(uint256 indexed loanId, uint256 indexed agentId, uint256 indexed sponsorId, uint256 principal, uint256 sharesBurnt, address owner)",
]);
const priorsV1Abi = parseAbi([
  "event Borrowed(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint256 fee, uint64 dueAt, address to)",
  "event Repaid(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint256 fee, address payer)",
  "event Defaulted(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint256 liableSponsor, uint256 badDebt)",
]);
const identityEvents = parseAbi([
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)",
]);
const reputationEvents = parseAbi([
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)",
]);

// ---------- the configuration ----------

export interface ReportsConfig {
  /** REPORTS=on: off unless it is said */
  enabled: boolean;
  identity: string;
  reputation: string;
  validation: string;
  /** REPORTS_FROM_BLOCK: where the ERC-8004 registries' logs start */
  fromBlock: number;
  /** REPORTS_PRIORS=off: Priors' loans left out */
  priors: boolean;
  pools: { address: string; version: 1 | 2; from: number }[];
  helpers: string[];
  /** Factor's own wallets that are not house agents (FACTOR_WALLETS, and REPORTS_FACTOR_WALLETS) */
  factorWallets: string[];
  /** REPORTS_SPAN: blocks in one log query (100,000: the node's reliable size) */
  span: number;
  /** REPORTS_PER_PASS: log queries in one pass at most */
  perPass: number;
  /** REPORTS_EVERY_S: seconds between passes once everything is read */
  everyS: number;
  /** REPORTS_SCORE_EVERY_S: how often every agent is scored again */
  scoreEveryS: number;
  /** blocks behind the head that are read: a reorg deeper than this is not followed */
  confirmations: number;
  site: string;
}

export function readReports(env: Env, problems: string[] = []): ReportsConfig {
  const sw = (name: string, def: boolean): boolean => {
    const raw = (env[name] ?? "").trim().toLowerCase();
    if (raw && raw !== "on" && raw !== "off") problems.push(`${name} must be on or off: it is "${env[name]}"`);
    return raw ? raw === "on" : def;
  };
  const whole = (name: string, def: number, min: number, max: number): number => {
    const v = env[name]?.trim();
    if (!v) return def;
    if (/^\d{1,12}$/.test(v) && Number(v) >= min && Number(v) <= max) return Number(v);
    problems.push(`${name} must be a whole number from ${min} to ${max}: it is "${v}"`);
    return def;
  };
  // REPORTS_PRIORS_POOLS: other pools than Priors' own two, for a copy of the chain or a test: "1:0x...@block,2:0x...@block"
  let pools = PRIORS_POOLS;
  const rawPools = env.REPORTS_PRIORS_POOLS?.trim();
  if (rawPools) {
    const got = rawPools.split(",").map((x) => /^([12]):(0x[0-9a-fA-F]{40})@(\d{1,12})$/.exec(x.trim()));
    if (got.every((m) => m)) pools = got.map((m) => ({ version: Number(m![1]) as 1 | 2, address: m![2]!.toLowerCase(), from: Number(m![3]) }));
    else problems.push(`REPORTS_PRIORS_POOLS must be version:address@block with commas between, like 2:0x2812...@71702460: it is "${rawPools}"`);
  }
  const factorWallets = [...FACTOR_WALLETS];
  for (const raw of (env.REPORTS_FACTOR_WALLETS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const a = normalizeAddress(raw);
    if (a) factorWallets.push(a);
    else problems.push(`REPORTS_FACTOR_WALLETS holds something that is not an address: "${raw}"`);
  }
  return {
    enabled: sw("REPORTS", false),
    identity: IDENTITY_REGISTRY, reputation: REPUTATION_REGISTRY, validation: VALIDATION_REGISTRY,
    fromBlock: whole("REPORTS_FROM_BLOCK", ERC8004_FROM, 0, 10_000_000_000),
    priors: sw("REPORTS_PRIORS", true),
    pools, helpers: PRIORS_HELPERS, factorWallets,
    span: whole("REPORTS_SPAN", 100_000, 10, 1_000_000),
    perPass: whole("REPORTS_PER_PASS", 40, 1, 2000),
    everyS: whole("REPORTS_EVERY_S", 60, 5, 86_400),
    scoreEveryS: whole("REPORTS_SCORE_EVERY_S", 300, 10, 86_400),
    confirmations: whole("REPORTS_CONFIRMATIONS", 20, 0, 10_000),
    site: (env.FACTOR_SITE_URL?.trim() || "https://factoragents.fun").replace(/\/+$/, ""),
  };
}

// ---------- the books ----------

const SCHEMA = `
-- Factor Credit Reports (./reports.ts). What was read of the chain, kept so a restart goes on where it stopped.
CREATE TABLE IF NOT EXISTS report_identities (
  agent_id INTEGER PRIMARY KEY,
  maker TEXT,                        -- the wallet that registered it (the Registered log's owner: the one who paid for it)
  owner TEXT,                        -- ownerOf at the head, at read_at
  wallet TEXT,                       -- getAgentWallet at the head, at read_at
  uri TEXT,
  uri_block INTEGER NOT NULL DEFAULT 0,
  name TEXT,                         -- from a registration file on the chain itself (a data: address), or NULL
  about TEXT,
  registered_block INTEGER,
  registered_at INTEGER,
  read_at INTEGER                    -- ms; NULL: its owner and wallet were never read
);
CREATE INDEX IF NOT EXISTS report_identities_owner ON report_identities (owner);
CREATE INDEX IF NOT EXISTS report_identities_wallet ON report_identities (wallet);
CREATE INDEX IF NOT EXISTS report_identities_maker ON report_identities (maker);
CREATE TABLE IF NOT EXISTS report_feedback (
  agent_id INTEGER NOT NULL,
  client TEXT NOT NULL,
  idx INTEGER NOT NULL,
  value TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  tag1 TEXT NOT NULL,
  tag2 TEXT NOT NULL,
  uri TEXT NOT NULL,
  block INTEGER NOT NULL,
  at INTEGER NOT NULL,
  tx TEXT NOT NULL,
  PRIMARY KEY (agent_id, client, idx)
);
CREATE TABLE IF NOT EXISTS report_revoked (agent_id INTEGER NOT NULL, client TEXT NOT NULL, idx INTEGER NOT NULL, PRIMARY KEY (agent_id, client, idx));
CREATE TABLE IF NOT EXISTS report_validations (
  request TEXT PRIMARY KEY,
  agent_id INTEGER,
  validator TEXT,
  requested_at INTEGER,
  response INTEGER,
  tag TEXT,
  responded_at INTEGER
);
CREATE INDEX IF NOT EXISTS report_validations_agent ON report_validations (agent_id);
CREATE TABLE IF NOT EXISTS report_loans (
  pool TEXT NOT NULL,
  loan_id INTEGER NOT NULL,
  agent_id INTEGER,
  principal TEXT,
  due_at INTEGER,
  recipient TEXT,
  borrowed_at INTEGER,
  borrowed_tx TEXT,
  repaid_at INTEGER,
  payer TEXT,
  defaulted_at INTEGER,
  PRIMARY KEY (pool, loan_id)
);
CREATE INDEX IF NOT EXISTS report_loans_agent ON report_loans (agent_id);
CREATE TABLE IF NOT EXISTS report_times (block INTEGER PRIMARY KEY, at INTEGER NOT NULL);
-- Every agent's score, as the last scoring pass made it: what the leaderboard and the look-up read.
CREATE TABLE IF NOT EXISTS report_scores (
  subject TEXT PRIMARY KEY,          -- "8004:<n>" for an identity, the wallet for a desk agent with none
  agent_id INTEGER,
  wallet TEXT,
  name TEXT,
  score INTEGER NOT NULL,
  work INTEGER NOT NULL, repayment INTEGER NOT NULL, feedback INTEGER NOT NULL, time INTEGER NOT NULL, reliability INTEGER NOT NULL,
  pulled INTEGER NOT NULL,
  flags TEXT NOT NULL,               -- the flags' keys, with commas
  sources TEXT NOT NULL,             -- the sources that brought points, with commas
  factor_own INTEGER NOT NULL,
  blank INTEGER NOT NULL,
  first_at INTEGER, last_at INTEGER
);
CREATE INDEX IF NOT EXISTS report_scores_rank ON report_scores (factor_own, score DESC);
-- An agent's owner claimed its report: its words, signed.
CREATE TABLE IF NOT EXISTS report_claims (
  subject TEXT PRIMARY KEY,
  by TEXT NOT NULL,
  name TEXT, about TEXT, site TEXT, x TEXT,
  signed_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS report_hidden (subject TEXT PRIMARY KEY);
`;

// ---------- what the API answers ----------

export interface ReportSubject {
  subject: string;
  agentId: string | null;
  name: string;
  /** where the name comes from: a claim signed by its owner, Factor's desk, its registration file on the chain, or none */
  nameFrom: "claim" | "factor" | "chain" | "none";
  about: string | null;
  owner: string | null;
  agentWallet: string | null;
  maker: string | null;
  desk: string[];
  registeredAt: string | null;
  uri: string | null;
  factorOwn: boolean;
}

export interface TimelineItem { at: string; source: SourceKey; kind: string; text: string; counted: boolean; why?: string; tx?: string }

export interface ReportJson extends Omit<ScoreResult, "firstAt" | "lastAt"> {
  enabled: true;
  agent: ReportSubject;
  rank: number | null;
  of: 1000;
  ranked: number;
  firstAt: string | null;
  lastAt: string | null;
  asOf: string;
  block: number | null;
  timeline: TimelineItem[];
  /** what others wrote of it on ERC-8004, newest first: each entry with whether it counts and why */
  erc8004: { client: string; tag1: string; tag2: string; value: string; at: string; counted: boolean; why: string }[];
  claim: { by: string; name: string | null; about: string | null; site: string | null; x: string | null; signedAt: string } | null;
  links: { page: string; card: string; badge: string; signed: string; erc8004: string | null; desk: string | null };
  /** its score on the ERC-8004 reputation registry, written by Factor (./reportserc8004.ts); null for an agent with no identity */
  onChain: ReportOnChain | null;
}

export interface ReportRow { subject: string; agentId: string | null; wallet: string | null; name: string; score: number; parts: Record<string, number>; pulled: number; flags: string[]; sources: string[]; factorOwn: boolean; rank: number | null; lastAt: string | null }

export interface ReportsDeps {
  db: EngineDb;
  chain: Pick<Chain, "logs" | "block" | "read" | "head">;
  chainId: number;
  /** the chain's explorer, for links a person opens in a browser */
  explorer: string;
  now: () => number;
  /** the chain's time now, seconds */
  nowS: () => number;
  log: (line: string) => void;
  /** the Factor desk's agents, as the engine keeps them */
  deskAgents: () => { address: string; registeredAt: number }[];
  /** the jobs locked for a desk agent, with whether each was a demonstration */
  deskJobs: (agent: string) => DeskJobIn[];
  /** a desk agent's credit line marks, while lines are read */
  lineOf: (agent: string) => { onTime: number; late: number; defaulted: boolean } | null;
  /** a desk agent's paid reviews, while they are on */
  reviewsOf: (agent: string) => ReviewIn[];
  /** the ERC-8004 identity Factor linked a desk agent to (./erc8004.ts), or null */
  linkOf: (agent: string) => string | null;
  /** whether two addresses are run by the same hand, as Factor's own records show (./subjobs.ts) */
  sameHand: (a: string, b: string) => boolean;
  /** Factor's own agents and wallets */
  factorOwn: (address: string) => boolean;
  /** a desk agent's name on Factor */
  nameOf: (address: string) => string | null;
  /** the address Factor writes its own job entries to ERC-8004 from */
  factorWriter: () => string | null;
  /** whether `address` signed the words: a wallet, or an account through one of its keys */
  signed: (address: string, message: string, signature: unknown) => Promise<boolean>;
  /** the key that signs answers (./everywhere.ts) */
  signer: () => AnswerSigner | null;
  /** a report's place on ERC-8004 (./reportserc8004.ts), by its identity's number */
  onChain?: (agentId: string) => ReportOnChain | null;
}

interface Shared { makers: Map<string, number>; walletMakers: Map<string, Set<string>>; recipients: Map<string, number>; payers: Map<string, number>; deskReg: Map<string, number>; loanWallets: Map<number, Set<string>> }
interface Cursor { start: number; down: number | null; up: number | null; top: number | null }

const iso = (s: number | null | undefined): string | null => (s ? new Date(s * 1000).toISOString() : null);
const clean = (s: unknown, most: number): string | null => {
  if (typeof s !== "string") return null;
  const t = s.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, most) : null;
};

/** The registration file, when it is on the chain itself (a data: address): its name and description. Never fetched from elsewhere. */
export function registrationOf(uri: string): { name: string | null; about: string | null } {
  try {
    let text: string | null = null;
    const b64 = /^data:application\/json;base64,([A-Za-z0-9+/=]+)$/.exec(uri);
    if (b64) text = Buffer.from(b64[1]!, "base64").toString("utf8");
    else if (/^data:application\/json(;charset=utf-8|;utf8)?,/i.test(uri)) text = decodeURIComponent(uri.slice(uri.indexOf(",") + 1));
    if (!text || text.length > 64_000) return { name: null, about: null };
    const j = JSON.parse(text) as { name?: unknown; description?: unknown };
    return { name: clean(j.name, 48), about: clean(j.description, 240) };
  } catch {
    return { name: null, about: null };
  }
}

/** The two reasons an entry counts, as entryWhy says them. */
const CLIENT_WORD = "a paying client's word";
const PAID_REVIEW = "a paying client's paid review";
const COUNTED = new Set([CLIENT_WORD, PAID_REVIEW]);

/** The words an owner signs to claim its agent's report. The same to the letter in the kit and on the site. */
export const claimMessage = (o: { subject: string; by: string; name: string | null; about: string | null; site: string | null; x: string | null; at: number }): string =>
  ["Factor: claim a credit report", `agent: ${o.subject}`, `by: ${o.by}`, `name: ${o.name ?? ""}`, `about: ${o.about ?? ""}`, `site: ${o.site ?? ""}`, `x: ${o.x ?? ""}`, `at: ${o.at}`].join("\n");

export class Reports {
  private lastScoreAt = 0;
  private changed = true;
  private busy = false;

  constructor(readonly cfg: ReportsConfig, private d: ReportsDeps) {
    d.db.db.exec(SCHEMA);
    d.db.db.exec(REPORT_ERC8004_SCHEMA);
  }

  on(): boolean {
    return this.cfg.enabled && !stopped(this.d.db, "reports");
  }

  // ---------- reading the chain ----------

  private cursor(source: string, start: number): Cursor {
    return this.d.db.getJson<Cursor>(`reports:cursor:${source}`) ?? { start, down: null, up: null, top: null };
  }

  private setCursor(source: string, c: Cursor): void {
    this.d.db.setJson(`reports:cursor:${source}`, c);
  }

  /** A block's time, from the header (kept). */
  private async timeOf(block: number): Promise<number> {
    const had = this.d.db.q("SELECT at FROM report_times WHERE block = ?").get(block) as { at: number } | undefined;
    if (had) return had.at;
    const b = await this.d.chain.block(BigInt(block));
    if (!b) throw new Error(`the node has no block ${block}`);
    this.d.db.q("INSERT OR REPLACE INTO report_times (block, at) VALUES (?, ?)").run(block, b.timestamp);
    return b.timestamp;
  }

  /** The time of a block between two read ends: placed by its number. */
  private between(block: number, a: { block: number; at: number }, b: { block: number; at: number }): number {
    if (b.block <= a.block) return a.at;
    return Math.round(a.at + ((b.at - a.at) * (block - a.block)) / (b.block - a.block));
  }

  /** Every log of the filter between two blocks, halving a span the node finds too big. */
  private async logs(from: number, to: number, address: string[]): Promise<ChainLog[]> {
    try {
      return await this.d.chain.logs(BigInt(from), BigInt(to), { address });
    } catch (e) {
      if (!tooMany((e as Error).message ?? "") || from >= to) throw e;
      const mid = Math.floor((from + to) / 2);
      return [...(await this.logs(from, mid, address)), ...(await this.logs(mid + 1, to, address))];
    }
  }

  /** One span of one source: read, timed and kept. */
  private async span(source: "8004" | "priors", from: number, to: number): Promise<number> {
    const address = source === "8004" ? [this.cfg.identity, this.cfg.reputation, this.cfg.validation] : this.cfg.pools.map((p) => p.address);
    const [a, b] = [{ block: from, at: await this.timeOf(from) }, { block: to, at: await this.timeOf(to) }];
    const got = await this.logs(from, to, address);
    const at = (l: ChainLog) => (l.timestamp && l.timestamp > 0 ? l.timestamp : this.between(Number(l.blockNumber), a, b));
    this.d.db.tx(() => {
      for (const l of got) (source === "8004" ? this.take8004(l, at(l)) : this.takePriors(l, at(l)));
    });
    if (got.length) this.changed = true;
    return got.length;
  }

  private take8004(l: ChainLog, at: number): void {
    const db = this.d.db;
    const addr = l.address.toLowerCase();
    const topics = l.topics as [Hex, ...Hex[]];
    const block = Number(l.blockNumber);
    if (addr === this.cfg.identity) {
      let e;
      try { e = decodeEventLog({ abi: identityEvents, topics, data: l.data }); } catch { return; }
      if (e.eventName === "Registered") {
        const { agentId, agentURI, owner } = e.args;
        const r = registrationOf(agentURI);
        db.q(`INSERT INTO report_identities (agent_id, maker, uri, uri_block, name, about, registered_block, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(agent_id) DO UPDATE SET maker = excluded.maker, registered_block = excluded.registered_block, registered_at = excluded.registered_at,
            uri = CASE WHEN report_identities.uri_block > excluded.uri_block THEN report_identities.uri ELSE excluded.uri END,
            name = CASE WHEN report_identities.uri_block > excluded.uri_block THEN report_identities.name ELSE excluded.name END,
            about = CASE WHEN report_identities.uri_block > excluded.uri_block THEN report_identities.about ELSE excluded.about END,
            uri_block = MAX(report_identities.uri_block, excluded.uri_block)`).run(Number(agentId), owner.toLowerCase(), agentURI.slice(0, 2000), block, r.name, r.about, block, at);
      } else if (e.eventName === "URIUpdated") {
        const { agentId, newURI } = e.args;
        const r = registrationOf(newURI);
        db.q(`INSERT INTO report_identities (agent_id, uri, uri_block, name, about) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(agent_id) DO UPDATE SET uri = CASE WHEN report_identities.uri_block > excluded.uri_block THEN report_identities.uri ELSE excluded.uri END,
            name = CASE WHEN report_identities.uri_block > excluded.uri_block THEN report_identities.name ELSE excluded.name END,
            about = CASE WHEN report_identities.uri_block > excluded.uri_block THEN report_identities.about ELSE excluded.about END,
            uri_block = MAX(report_identities.uri_block, excluded.uri_block)`).run(Number(agentId), newURI.slice(0, 2000), block, r.name, r.about);
      }
      return;
    }
    if (addr === this.cfg.reputation) {
      let e;
      try { e = decodeEventLog({ abi: reputationEvents, topics, data: l.data }); } catch { return; }
      if (e.eventName === "NewFeedback") {
        const a = e.args;
        db.q("INSERT OR IGNORE INTO report_feedback (agent_id, client, idx, value, decimals, tag1, tag2, uri, block, at, tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          Number(a.agentId), a.clientAddress.toLowerCase(), Number(a.feedbackIndex), a.value.toString(), Number(a.valueDecimals), a.tag1.slice(0, 64), a.tag2.slice(0, 64), a.feedbackURI.startsWith("data:") ? "data:" : a.feedbackURI.slice(0, 300), block, at, l.transactionHash);
      } else if (e.eventName === "FeedbackRevoked") {
        const a = e.args;
        db.q("INSERT OR IGNORE INTO report_revoked (agent_id, client, idx) VALUES (?, ?, ?)").run(Number(a.agentId), a.clientAddress.toLowerCase(), Number(a.feedbackIndex));
      }
      return;
    }
    if (addr === this.cfg.validation) {
      let e;
      try { e = decodeEventLog({ abi: erc8004ValidationAbi, topics, data: l.data }); } catch { return; }
      if (e.eventName === "ValidationRequest") {
        const a = e.args;
        db.q("INSERT INTO report_validations (request, agent_id, validator, requested_at) VALUES (?, ?, ?, ?) ON CONFLICT(request) DO UPDATE SET agent_id = excluded.agent_id, validator = excluded.validator, requested_at = excluded.requested_at").run(a.requestHash, Number(a.agentId), a.validatorAddress.toLowerCase(), at);
      } else if (e.eventName === "ValidationResponse") {
        const a = e.args;
        // the newest answer to a request stands (a validator may answer again)
        db.q(`INSERT INTO report_validations (request, agent_id, validator, response, tag, responded_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(request) DO UPDATE SET agent_id = excluded.agent_id, validator = excluded.validator,
            response = CASE WHEN IFNULL(report_validations.responded_at, 0) > excluded.responded_at THEN report_validations.response ELSE excluded.response END,
            tag = CASE WHEN IFNULL(report_validations.responded_at, 0) > excluded.responded_at THEN report_validations.tag ELSE excluded.tag END,
            responded_at = MAX(IFNULL(report_validations.responded_at, 0), excluded.responded_at)`).run(a.requestHash, Number(a.agentId), a.validatorAddress.toLowerCase(), Number(a.response), a.tag.slice(0, 64), at);
      }
    }
  }

  private takePriors(l: ChainLog, at: number): void {
    const pool = this.cfg.pools.find((p) => p.address === l.address.toLowerCase());
    if (!pool) return;
    let e;
    try { e = decodeEventLog({ abi: pool.version === 2 ? priorsV2Abi : priorsV1Abi, topics: l.topics as [Hex, ...Hex[]], data: l.data }); } catch { return; }
    const db = this.d.db;
    const a = e.args as Record<string, unknown>;
    const id = Number(a.loanId as bigint);
    const agent = Number(a.agentId as bigint);
    if (e.eventName === "Borrowed") {
      db.q(`INSERT INTO report_loans (pool, loan_id, agent_id, principal, due_at, recipient, borrowed_at, borrowed_tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pool, loan_id) DO UPDATE SET agent_id = excluded.agent_id, principal = excluded.principal, due_at = excluded.due_at, recipient = excluded.recipient, borrowed_at = excluded.borrowed_at, borrowed_tx = excluded.borrowed_tx`)
        .run(pool.address, id, agent, String(a.principal), Number(a.dueAt as bigint), String(a.to).toLowerCase(), at, l.transactionHash);
    } else if (e.eventName === "Repaid") {
      db.q("INSERT INTO report_loans (pool, loan_id, agent_id, repaid_at, payer) VALUES (?, ?, ?, ?, ?) ON CONFLICT(pool, loan_id) DO UPDATE SET repaid_at = excluded.repaid_at, payer = excluded.payer")
        .run(pool.address, id, agent, at, String(a.payer).toLowerCase());
    } else if (e.eventName === "Defaulted") {
      db.q("INSERT INTO report_loans (pool, loan_id, agent_id, defaulted_at) VALUES (?, ?, ?, ?) ON CONFLICT(pool, loan_id) DO UPDATE SET defaulted_at = excluded.defaulted_at")
        .run(pool.address, id, agent, at);
    }
  }

  /**
   * One source's step: what the chain added since the last pass first (newest first), then on down toward the source's
   * first block. `budget` is the log queries it may make. Returns the queries made.
   */
  private async source(source: "8004" | "priors", start: number, head: number, budget: number): Promise<number> {
    const c = this.cursor(source, start);
    if (c.start !== start) Object.assign(c, { start, down: c.down === null ? null : Math.max(c.down, start - 1) });
    if (c.top === null) Object.assign(c, { top: head, up: head, down: head });
    let used = 0;
    // up: the new blocks, so a report is never behind the head by more than a pass
    while (used < budget && c.up! < head) {
      const from = c.up! + 1, to = Math.min(head, c.up! + this.cfg.span);
      await this.span(source, from, to);
      c.up = to;
      used++;
      this.setCursor(source, c);
    }
    // down: the past, newest first
    while (used < budget && c.down! >= c.start) {
      const to = c.down!, from = Math.max(c.start, to - this.cfg.span + 1);
      await this.span(source, from, to);
      c.down = from - 1;
      used++;
      this.setCursor(source, c);
    }
    return used;
  }

  /** The owner and agentWallet of identities, read at the head, a few hundred at a time. */
  private async readIdentities(budget: number): Promise<number> {
    const db = this.d.db;
    const st = db.getJson<{ next: number; fullAt: number }>("reports:ids") ?? { next: 0, fullAt: 0 };
    const now = this.d.now();
    let used = 0;
    const read = async (ids: number[]) => {
      const calls = ids.flatMap((id) => [
        { target: this.cfg.identity as Hex, allowFailure: true, callData: encodeFunctionData({ abi: erc8004IdentityAbi, functionName: "ownerOf", args: [BigInt(id)] }) },
        { target: this.cfg.identity as Hex, allowFailure: true, callData: encodeFunctionData({ abi: erc8004IdentityAbi, functionName: "getAgentWallet", args: [BigInt(id)] }) },
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
      db.tx(() => ids.forEach((id, i) => db.q("UPDATE report_identities SET owner = ?, wallet = ?, read_at = ? WHERE agent_id = ?").run(addr(out[2 * i], "ownerOf"), addr(out[2 * i + 1], "getAgentWallet"), now, id)));
      used++;
      this.changed = true;
    };
    // the ones never read first
    while (used < budget) {
      const ids = (db.q("SELECT agent_id FROM report_identities WHERE read_at IS NULL ORDER BY agent_id DESC LIMIT 250").all() as { agent_id: number }[]).map((r) => r.agent_id);
      if (!ids.length) break;
      await read(ids);
    }
    // then all of them again, every six hours: an owner or a wallet can change
    if (used < budget && (st.next > 0 || now - st.fullAt > 6 * 3_600_000)) {
      const most = (db.q("SELECT IFNULL(MAX(agent_id), -1) AS m FROM report_identities").get() as { m: number }).m;
      while (used < budget && st.next <= most) {
        const ids = (db.q("SELECT agent_id FROM report_identities WHERE agent_id >= ? ORDER BY agent_id LIMIT 250").all(st.next) as { agent_id: number }[]).map((r) => r.agent_id);
        if (!ids.length) break;
        await read(ids);
        st.next = ids[ids.length - 1]! + 1;
      }
      if (st.next > most) Object.assign(st, { next: 0, fullAt: now });
      db.setJson("reports:ids", st);
    }
    return used;
  }

  /** Whether everything is read down to each source's first block. */
  caughtUp(): boolean {
    const a = this.cursor("8004", this.cfg.fromBlock);
    const p = this.cursor("priors", this.priorsStart());
    return a.down !== null && a.down < a.start && (!this.cfg.priors || (p.down !== null && p.down < p.start));
  }

  private priorsStart(): number {
    return Math.min(...this.cfg.pools.map((p) => p.from));
  }

  /**
   * One pass: the chain read as far as this pass's budget goes, the identities' owners and wallets, then every agent
   * scored again when something changed and the last scoring is old enough. Returns what it did, in words.
   */
  async pass(): Promise<string> {
    if (!this.on()) return "reports are off";
    if (this.busy) return "a pass is under way";
    this.busy = true;
    try {
      const head = Number((await this.d.chain.head()).number) - this.cfg.confirmations;
      let budget = this.cfg.perPass;
      const said: string[] = [];
      const a = await this.source("8004", this.cfg.fromBlock, head, Math.ceil(budget / (this.cfg.priors ? 2 : 1)));
      budget -= a;
      const p = this.cfg.priors ? await this.source("priors", this.priorsStart(), head, Math.max(1, budget)) : 0;
      said.push(`read ${a + p} span${a + p === 1 ? "" : "s"}`);
      const ids = await this.readIdentities(4);
      if (ids) said.push(`${ids} batch${ids === 1 ? "" : "es"} of identities`);
      const now = this.d.now();
      const due = now - this.lastScoreAt >= (this.caughtUp() ? this.cfg.scoreEveryS : Math.min(120, this.cfg.scoreEveryS)) * 1000;
      if (this.changed && due) {
        const n = this.scoreAll();
        said.push(`scored ${n.toLocaleString("en-US")} agents`);
      }
      return said.join(", ");
    } finally {
      this.busy = false;
    }
  }

  // ---------- who an agent is ----------

  private identity(id: number): { agent_id: number; maker: string | null; owner: string | null; wallet: string | null; uri: string | null; name: string | null; about: string | null; registered_at: number | null } | null {
    return (this.d.db.q("SELECT agent_id, maker, owner, wallet, uri, name, about, registered_at FROM report_identities WHERE agent_id = ?").get(id) as never) ?? null;
  }

  /** The identity a desk agent is, or null: Factor's link, else the one whose agentWallet it is, else the one it owns when it owns exactly one. */
  private identityOfDesk(address: string): number | null {
    const link = this.d.linkOf(address);
    if (link !== null && /^\d+$/.test(link)) return Number(link);
    const w = this.d.db.q("SELECT agent_id FROM report_identities WHERE wallet = ? ORDER BY agent_id LIMIT 1").get(address) as { agent_id: number } | undefined;
    if (w) return w.agent_id;
    const o = this.d.db.q("SELECT agent_id FROM report_identities WHERE owner = ? LIMIT 2").all(address) as { agent_id: number }[];
    return o.length === 1 ? o[0]!.agent_id : null;
  }

  /** Every desk agent, by the subject it belongs to. */
  private deskBySubject(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const a of this.d.deskAgents()) {
      const id = this.identityOfDesk(a.address);
      const key = id === null ? a.address : `8004:${id}`;
      out.set(key, [...(out.get(key) ?? []), a.address]);
    }
    return out;
  }

  /** What the formula needs that is the same for every agent: who made which wallets, and who took and repaid whose loans. */
  private sharedKept: { at: number; v: Shared } | null = null;
  private shared(fresh = false): Shared {
    if (!fresh && this.sharedKept && this.d.now() - this.sharedKept.at < 60_000) return this.sharedKept.v;
    const db = this.d.db;
    const deskReg = new Map(this.d.deskAgents().map((a) => [a.address, a.registeredAt]));
    const makers = new Map<string, number>();
    const walletMakers = new Map<string, Set<string>>();
    for (const r of db.q("SELECT maker, owner, wallet FROM report_identities WHERE maker IS NOT NULL").all() as { maker: string; owner: string | null; wallet: string | null }[]) {
      makers.set(r.maker, (makers.get(r.maker) ?? 0) + 1);
      for (const w of [r.owner, r.wallet]) if (w) { const s = walletMakers.get(w) ?? new Set(); s.add(r.maker); walletMakers.set(w, s); }
    }
    const recipients = new Map<string, number>(), payers = new Map<string, number>();
    for (const r of db.q("SELECT recipient AS w, COUNT(DISTINCT agent_id) AS n FROM report_loans WHERE recipient IS NOT NULL GROUP BY recipient").all() as { w: string; n: number }[]) recipients.set(r.w, r.n);
    for (const r of db.q("SELECT payer AS w, COUNT(DISTINCT agent_id) AS n FROM report_loans WHERE payer IS NOT NULL GROUP BY payer").all() as { w: string; n: number }[]) payers.set(r.w, r.n);
    // the wallets each identity's loans went to and were repaid from: who funds it, where the chain shows it
    const loanWallets = new Map<number, Set<string>>();
    for (const r of db.q("SELECT DISTINCT agent_id, recipient AS w FROM report_loans WHERE recipient IS NOT NULL UNION SELECT DISTINCT agent_id, payer AS w FROM report_loans WHERE payer IS NOT NULL").all() as { agent_id: number; w: string }[]) {
      if (this.cfg.helpers.includes(r.w)) continue;
      const s = loanWallets.get(r.agent_id) ?? new Set<string>();
      s.add(r.w);
      loanWallets.set(r.agent_id, s);
    }
    const v = { makers, walletMakers, recipients, payers, deskReg, loanWallets };
    this.sharedKept = { at: this.d.now(), v };
    return v;
  }

  /** Everything the formula is handed for one agent. */
  private inputOf(subject: string, desk: string[], sh: Shared, rows?: { loans?: LoanIn[]; feedback?: FeedbackIn[]; validations?: ValidationIn[] }): { input: ReportInput; who: ReportSubject; feedbackRows: FeedbackIn[] } {
    const idm = /^8004:(\d+)$/.exec(subject);
    const id = idm ? Number(idm[1]) : null;
    const ident = id !== null ? this.identity(id) : null;
    const wallets = [...new Set([ident?.owner, ident?.wallet, ...desk].filter((x): x is string => !!x))];
    const maker = ident?.maker ?? null;
    // Factor's own: a house agent, or an agent run from one of Factor's own wallets (its owner, its wallet, its maker)
    const factorWallet = (a: string): boolean => this.d.factorOwn(a) || this.cfg.factorWallets.includes(a) || a === this.d.factorWriter();
    const factorOwn = [...desk, ident?.owner, ident?.wallet, maker].some((a) => !!a && factorWallet(a));
    const funding = id !== null ? sh.loanWallets.get(id) : undefined;
    const own = (address: string): string | null => {
      const a = address.toLowerCase();
      if (ident?.owner === a) return "its owner";
      if (ident?.wallet === a) return "its agentWallet";
      if (desk.includes(a)) return "its own wallet on the desk";
      if (maker && a === maker) return "the wallet that registered it";
      if (maker && sh.walletMakers.get(a)?.has(maker)) return "a wallet of another agent registered by the same wallet";
      // the same operator, either way round: a wallet of an identity one of its wallets registered, or the wallet that registered one of its wallets' identities
      for (const w of wallets) if (sh.walletMakers.get(a)?.has(w)) return "a wallet of an identity this agent's own wallet registered";
      for (const w of wallets) if (sh.walletMakers.get(w)?.has(a)) return "the wallet that registered an identity of this agent's wallets";
      for (const w of wallets) if (sh.walletMakers.get(a) && sh.walletMakers.get(w) && [...sh.walletMakers.get(a)!].some((m) => sh.walletMakers.get(w)!.has(m))) return "a wallet of another agent made by the same wallet";
      // the wallet its loans went to or were repaid from: whoever funds it
      if (funding?.has(a)) return "a wallet that took or repaid its loans";
      for (const dsk of desk) if (this.d.sameHand(dsk, a)) return "run by the same hand, as Factor's own records show";
      // Factor's own wallets pay in Factor's own tests and demonstrations: never a paying client of anyone
      if (factorWallet(a)) return factorOwn ? "another of Factor's own wallets" : "one of Factor's own test wallets";
      return null;
    };
    const db = this.d.db;
    const loans = rows?.loans ?? (id === null ? [] : (db.q("SELECT * FROM report_loans WHERE agent_id = ? AND borrowed_at IS NOT NULL").all(id) as LoanRow[]).map(loanIn));
    const feedback = rows?.feedback ?? (id === null ? [] : (db.q("SELECT f.*, (r.idx IS NOT NULL) AS revoked FROM report_feedback f LEFT JOIN report_revoked r ON r.agent_id = f.agent_id AND r.client = f.client AND r.idx = f.idx WHERE f.agent_id = ?").all(id) as FeedbackRow[]).map(feedbackIn));
    const validations = rows?.validations ?? (id === null ? [] : (db.q("SELECT validator, response, tag, responded_at FROM report_validations WHERE agent_id = ? AND response IS NOT NULL").all(id) as { validator: string; response: number; tag: string; responded_at: number }[]).map((v) => ({ validator: v.validator, response: v.response, tag: v.tag, at: v.responded_at })));
    const jobs = desk.flatMap((a) => this.d.deskJobs(a));
    const lines = desk.map((a) => this.d.lineOf(a)).filter((x): x is NonNullable<typeof x> => !!x);
    const line = lines.length ? { onTime: lines.reduce((s, l) => s + l.onTime, 0), late: lines.reduce((s, l) => s + l.late, 0), defaulted: lines.some((l) => l.defaulted) } : null;
    const reviews = desk.flatMap((a) => this.d.reviewsOf(a));
    const deskReg = desk.map((a) => sh.deskReg.get(a) ?? 0).filter((t) => t > 0);
    const registeredAt = ident?.registered_at ?? (deskReg.length ? Math.min(...deskReg) : null);
    const claim = this.claimOf(subject);
    const factorName = desk.map((a) => this.d.nameOf(a)).find((x) => !!x) ?? null;
    const hidden = !!db.q("SELECT 1 FROM report_hidden WHERE subject = ?").get(subject);
    const chainName = hidden ? null : ident?.name ?? null;
    const name = claim?.name ?? factorName ?? chainName ?? (id !== null ? `Agent #${id}` : shortAddress(subject));
    const who: ReportSubject = {
      subject, agentId: id === null ? null : String(id), name, nameFrom: claim?.name ? "claim" : factorName ? "factor" : chainName ? "chain" : "none",
      about: claim?.about ?? (hidden ? null : ident?.about ?? null), owner: ident?.owner ?? null, agentWallet: ident?.wallet ?? null, maker, desk,
      registeredAt: iso(registeredAt), uri: hidden ? null : ident?.uri && !ident.uri.startsWith("data:") ? ident.uri : null, factorOwn,
    };
    const input: ReportInput = {
      nowS: this.d.nowS(), registeredAt, wallets, maker: maker ? { address: maker, identities: sh.makers.get(maker) ?? 1 } : null, factorOwn, own,
      desk: jobs, line, loans, loanShare: (w, as) => (as === "recipient" ? sh.recipients.get(w) : sh.payers.get(w)) ?? 1, helpers: new Set(this.cfg.helpers),
      feedback, factorWriter: this.d.factorWriter(), reviews, validations,
    };
    return { input, who, feedbackRows: feedback };
  }

  /**
   * Every agent scored again: every identity on the registry, and every desk agent with none. Kept in report_scores,
   * which the leaderboard and the look-up read. Returns how many.
   */
  scoreAll(): number {
    const db = this.d.db;
    const sh = this.shared(true);
    const bySubject = this.deskBySubject();
    // every agent's rows in one read each, rather than one query per agent
    const loans = new Map<number, LoanIn[]>(), feedback = new Map<number, FeedbackIn[]>(), validations = new Map<number, ValidationIn[]>();
    for (const r of db.q("SELECT * FROM report_loans WHERE borrowed_at IS NOT NULL").all() as LoanRow[]) { const l = loans.get(r.agent_id) ?? []; l.push(loanIn(r)); loans.set(r.agent_id, l); }
    for (const r of db.q("SELECT f.*, (r.idx IS NOT NULL) AS revoked FROM report_feedback f LEFT JOIN report_revoked r ON r.agent_id = f.agent_id AND r.client = f.client AND r.idx = f.idx").all() as FeedbackRow[]) { const l = feedback.get(r.agent_id) ?? []; l.push(feedbackIn(r)); feedback.set(r.agent_id, l); }
    for (const r of db.q("SELECT agent_id, validator, response, tag, responded_at FROM report_validations WHERE response IS NOT NULL").all() as { agent_id: number; validator: string; response: number; tag: string; responded_at: number }[]) { const l = validations.get(r.agent_id) ?? []; l.push({ validator: r.validator, response: r.response, tag: r.tag, at: r.responded_at }); validations.set(r.agent_id, l); }
    const ids = (db.q("SELECT agent_id FROM report_identities WHERE maker IS NOT NULL").all() as { agent_id: number }[]).map((r) => `8004:${r.agent_id}`);
    const subjects = [...new Set([...ids, ...bySubject.keys()])];
    const ins = db.q(`INSERT INTO report_scores (subject, agent_id, wallet, name, score, work, repayment, feedback, time, reliability, pulled, flags, sources, factor_own, blank, first_at, last_at)
      VALUES (@subject, @agent_id, @wallet, @name, @score, @work, @repayment, @feedback, @time, @reliability, @pulled, @flags, @sources, @factor_own, @blank, @first_at, @last_at)`);
    db.tx(() => {
      db.q("DELETE FROM report_scores").run();
      for (const subject of subjects) {
        const id = subject.startsWith("8004:") ? Number(subject.slice(5)) : null;
        const { input, who } = this.inputOf(subject, bySubject.get(subject) ?? [], sh, { loans: id === null ? [] : loans.get(id) ?? [], feedback: id === null ? [] : feedback.get(id) ?? [], validations: id === null ? [] : validations.get(id) ?? [] });
        const r = scoreReport(input);
        const part = (k: string) => r.parts.find((p) => p.key === k)?.points ?? 0;
        ins.run({
          subject, agent_id: id, wallet: who.agentWallet ?? who.desk[0] ?? who.owner, name: who.name, score: r.score, work: part("work"), repayment: part("repayment"), feedback: part("feedback"), time: part("time"), reliability: part("reliability"),
          pulled: r.pulls.reduce((a, p) => a + p.points, 0), flags: r.flags.map((f) => f.key).join(","), sources: r.sources.map((s) => s.source).join(","), factor_own: who.factorOwn ? 1 : 0, blank: r.blank ? 1 : 0, first_at: r.firstAt, last_at: r.lastAt,
        });
      }
    });
    this.lastScoreAt = this.d.now();
    this.changed = false;
    return subjects.length;
  }

  // ---------- looking an agent up ----------

  /** The subject an id names: an ERC-8004 number (42, #42, 8004:42), a wallet (its owner, its agentWallet, its desk address), or a name. */
  resolve(raw: string): string | null {
    const s = decodeURIComponent(raw).trim();
    const n = /^(?:#|8004:)?(\d{1,12})$/.exec(s);
    if (n) return this.identity(Number(n[1])) ? `8004:${Number(n[1])}` : null;
    const a = normalizeAddress(s);
    const db = this.d.db;
    if (a) {
      const sc = db.q("SELECT subject FROM report_scores WHERE subject = ? OR wallet = ?").get(a, a) as { subject: string } | undefined;
      if (sc) return sc.subject;
      const desk = this.d.deskAgents().find((x) => x.address === a);
      if (desk) { const id = this.identityOfDesk(a); return id === null ? a : `8004:${id}`; }
      const w = db.q("SELECT agent_id FROM report_identities WHERE wallet = ? ORDER BY agent_id LIMIT 1").get(a) as { agent_id: number } | undefined;
      if (w) return `8004:${w.agent_id}`;
      const o = db.q("SELECT agent_id FROM report_identities WHERE owner = ? ORDER BY agent_id LIMIT 1").get(a) as { agent_id: number } | undefined;
      return o ? `8004:${o.agent_id}` : null;
    }
    if (!/^[\w .-]{2,48}$/.test(s)) return null;
    const byName = db.q("SELECT subject FROM report_scores WHERE lower(name) = lower(?) ORDER BY score DESC, subject LIMIT 1").get(s) as { subject: string } | undefined;
    return byName?.subject ?? null;
  }

  /** Up to 12 agents for what someone typed: a number, a wallet, or part of a name. */
  find(q: string): ReportRow[] {
    const s = q.trim().slice(0, 64);
    if (!s) return [];
    const exact = this.resolve(s);
    const db = this.d.db;
    const rows = exact ? (db.q("SELECT * FROM report_scores WHERE subject = ?").all(exact) as ScoreRow[]) : [];
    if (!exact && /^[\w .-]{2,48}$/.test(s) && !/^0x/i.test(s)) {
      const like = `%${s.replace(/[%_]/g, "")}%`;
      rows.push(...(db.q("SELECT * FROM report_scores WHERE name LIKE ? ORDER BY score DESC, subject LIMIT 12").all(like) as ScoreRow[]));
    }
    return rows.slice(0, 12).map((r) => this.row(r));
  }

  private rankOf(subject: string, score: number, factorOwn: boolean): number | null {
    if (factorOwn || score <= 0) return null;
    const above = (this.d.db.q("SELECT COUNT(*) AS n FROM report_scores WHERE factor_own = 0 AND (score > ? OR (score = ? AND subject < ?))").get(score, score, subject) as { n: number }).n;
    return above + 1;
  }

  private row(r: ScoreRow, rank?: number | null): ReportRow {
    return {
      subject: r.subject, agentId: r.agent_id === null ? null : String(r.agent_id), wallet: r.wallet, name: r.name, score: r.score,
      parts: { work: r.work, repayment: r.repayment, feedback: r.feedback, time: r.time, reliability: r.reliability }, pulled: r.pulled,
      flags: r.flags ? r.flags.split(",") : [], sources: r.sources ? r.sources.split(",") : [], factorOwn: !!r.factor_own,
      rank: rank === undefined ? this.rankOf(r.subject, r.score, !!r.factor_own) : rank, lastAt: iso(r.last_at),
    };
  }

  /** The leaderboard: every scored agent, best first. Factor's own agents are listed apart (own=1), never ranked. */
  top(limit: number, offset: number, own = false): { items: ReportRow[]; total: number } {
    const db = this.d.db;
    // Factor's own are listed whole, a score of 0 among them: every agent Factor runs, apart from everyone else's
    const where = own ? "factor_own = 1" : "factor_own = 0 AND score > 0";
    const total = (db.q(`SELECT COUNT(*) AS n FROM report_scores WHERE ${where}`).get() as { n: number }).n;
    const rows = db.q(`SELECT * FROM report_scores WHERE ${where} ORDER BY score DESC, subject LIMIT ? OFFSET ?`).all(limit, offset) as ScoreRow[];
    return { total, items: rows.map((r, i) => this.row(r, own ? null : offset + i + 1)) };
  }

  /** What /v1/reports says of the whole. */
  about(): Record<string, unknown> {
    const db = this.d.db;
    const c = (sql: string, ...args: unknown[]) => (db.q(sql).get(...args) as { n: number }).n;
    const cur = (source: string, start: number) => {
      const x = this.cursor(source, start);
      return { from: start, readDownTo: x.down === null ? null : Math.max(start, x.down + 1), readUpTo: x.up, done: x.down !== null && x.down < start };
    };
    const buckets = [[1, 99], [100, 249], [250, 499], [500, 749], [750, 1000]] as const;
    return {
      enabled: this.on(), version: REPORT_VERSION, chainId: this.d.chainId,
      found: c("SELECT COUNT(*) AS n FROM report_scores"),
      identities: c("SELECT COUNT(*) AS n FROM report_identities WHERE maker IS NOT NULL"),
      scored: c("SELECT COUNT(*) AS n FROM report_scores WHERE score > 0"),
      ranked: c("SELECT COUNT(*) AS n FROM report_scores WHERE score > 0 AND factor_own = 0"),
      withRecord: c("SELECT COUNT(*) AS n FROM report_scores WHERE blank = 0"),
      spread: [{ from: 0, to: 0, n: c("SELECT COUNT(*) AS n FROM report_scores WHERE score = 0") }, ...buckets.map(([a, b]) => ({ from: a, to: b, n: c("SELECT COUNT(*) AS n FROM report_scores WHERE score BETWEEN ? AND ?", a, b) }))],
      bySource: (Object.keys(SOURCE_NAME) as SourceKey[]).map((s) => ({ source: s, name: SOURCE_NAME[s], agents: c("SELECT COUNT(*) AS n FROM report_scores WHERE (',' || sources || ',') LIKE ?", `%,${s},%`) })),
      read: {
        erc8004: { ...cur("8004", this.cfg.fromBlock), feedback: c("SELECT COUNT(*) AS n FROM report_feedback"), revoked: c("SELECT COUNT(*) AS n FROM report_revoked"), validationRequests: c("SELECT COUNT(*) AS n FROM report_validations WHERE requested_at IS NOT NULL"), validationResponses: c("SELECT COUNT(*) AS n FROM report_validations WHERE response IS NOT NULL") },
        priors: this.cfg.priors ? { ...cur("priors", this.priorsStart()), loans: c("SELECT COUNT(*) AS n FROM report_loans WHERE borrowed_at IS NOT NULL"), repaid: c("SELECT COUNT(*) AS n FROM report_loans WHERE repaid_at IS NOT NULL"), defaulted: c("SELECT COUNT(*) AS n FROM report_loans WHERE defaulted_at IS NOT NULL"), pools: this.cfg.pools.map((p) => getAddress(p.address)) } : null,
        factor: { agents: this.d.deskAgents().length },
      },
      caughtUp: this.caughtUp(),
      scoredAt: this.lastScoreAt ? new Date(this.lastScoreAt).toISOString() : null,
      registries: { identity: getAddress(this.cfg.identity), reputation: getAddress(this.cfg.reputation), validation: getAddress(this.cfg.validation) },
      signer: this.d.signer()?.address ?? null,
    };
  }

  // ---------- one report ----------

  /** One agent's credit report, worked out now from what was read. null: no such agent. */
  report(raw: string): ReportJson | null {
    const subject = this.resolve(raw);
    if (!subject) return null;
    const desk = this.deskBySubject().get(subject) ?? [];
    const sh = this.shared();
    const { input, who, feedbackRows } = this.inputOf(subject, desk, sh);
    const r = scoreReport(input);
    const page = `${this.cfg.site}/reports/${who.agentId ?? subject}`;
    const ranked = (this.d.db.q("SELECT COUNT(*) AS n FROM report_scores WHERE score > 0 AND factor_own = 0").get() as { n: number }).n;
    const whyOf = this.entryWhy(input);
    const erc8004 = [...feedbackRows].sort((a, b) => b.at - a.at).slice(0, 30).map((f) => {
      const why = whyOf(f);
      return { client: f.client.toLowerCase(), tag1: f.tag1, tag2: f.tag2, value: valueText(f.value, f.decimals), at: new Date(f.at * 1000).toISOString(), counted: COUNTED.has(why), why };
    });
    const claim = this.claimOf(subject);
    return {
      enabled: true, ...r, agent: who, rank: this.rankOf(subject, r.score, who.factorOwn), ranked,
      firstAt: iso(r.firstAt), lastAt: iso(r.lastAt), asOf: new Date(input.nowS * 1000).toISOString(), block: this.cursor("8004", this.cfg.fromBlock).up,
      timeline: this.timeline(input, who, r),
      erc8004,
      onChain: who.agentId ? this.d.onChain?.(who.agentId) ?? null : null,
      claim: claim ? { by: claim.by, name: claim.name, about: claim.about, site: claim.site, x: claim.x, signedAt: new Date(claim.signed_at * 1000).toISOString() } : null,
      links: {
        page, card: `${this.cfg.site}/api/v1/reports/${who.agentId ?? subject}/card.png`, badge: `${this.cfg.site}/api/v1/reports/${who.agentId ?? subject}/badge.svg`, signed: `${this.cfg.site}/api/v1/reports/signed/${who.agentId ?? subject}`,
        erc8004: who.agentId ? `${this.d.explorer}/token/${getAddress(this.cfg.identity)}/instance/${who.agentId}` : null, desk: desk.length ? `${this.cfg.site}/agents/${this.d.nameOf(desk[0]!) ?? desk[0]}` : null,
      },
    };
  }

  /** Why an entry on ERC-8004 counts as a paying client's word, or why not: the formula's own rules (./reportscore.ts), in words. */
  private entryWhy(input: ReportInput): (f: FeedbackIn) => string {
    const paying = new Set(input.desk.filter((j) => (j.state === 4 || j.state === 5) && !j.demo && !input.own(j.customer)).map((j) => j.customer));
    const writer = this.d.factorWriter();
    return (f) => {
      const c = f.client.toLowerCase();
      return f.revoked ? "revoked by its writer"
        : (writer && c === writer) || f.tag1 === "factor" ? "Factor's own entry for a paid job on the desk: the job is counted under paid work"
        : input.own(c) ? `from ${input.own(c)}`
        : !paying.has(c) ? "this wallet never paid the agent for a job on the chain"
        : NOT_AN_OPINION.test(f.tag1) ? "a score or a statement, not a client's opinion of the work"
        : f.tag1 === REVIEW_TAG ? (starsOf(f.value, f.decimals) === null ? "not stars from 1 to 5" : PAID_REVIEW)
        : onHundred(f.value, f.decimals) === null ? "not a rating from 0 to 100" : CLIENT_WORD;
    };
  }

  /** What happened, newest first: its registration, its jobs, its loans day by day, what was said of it, and checks. */
  private timeline(x: ReportInput, who: ReportSubject, r: ScoreResult): TimelineItem[] {
    const out: (TimelineItem & { t: number })[] = [];
    const push = (t: number, source: SourceKey, kind: string, text: string, counted: boolean, why?: string, tx?: string) => { if (t > 0) out.push({ t, at: new Date(t * 1000).toISOString(), source, kind, text, counted, ...(why ? { why } : {}), ...(tx ? { tx } : {}) }); };
    if (who.registeredAt && who.agentId) push(Math.floor(Date.parse(who.registeredAt) / 1000), "erc8004-identity", "registered", `Registered as ERC-8004 identity #${who.agentId}${who.maker ? ` by ${shortAddress(who.maker)}` : ""}`, false, "an identity is not a record");
    for (const j of x.desk) {
      const own = x.own(j.customer);
      const price = Number(BigInt(j.price) / 10n ** 12n) / 1e6;
      if (j.state === 4 || j.state === 5) push(j.closedAt, "factor-desk", j.state === 4 ? "paid" : "half", `Job ${j.id} ${j.state === 4 ? "paid in full" : "settled at half"}: ${price} ETH${j.deliveredAt ? (j.late ? ", delivered late" : ", delivered on time") : ""}`, !j.demo && !own, j.demo ? "a demonstration" : own ? `paid by ${own}` : undefined);
      else if (j.state === 7) push(j.closedAt || j.lockedAt, "factor-desk", BigInt(j.fromPool || "0") > 0n || BigInt(j.early || "0") > 0n ? "default" : "missed", `Job ${j.id} not delivered, refunded to its customer${BigInt(j.fromPool || "0") > 0n ? " after drawing on the pool" : BigInt(j.early || "0") > 0n ? " after drawing its early half" : ""}`, true);
    }
    // loans, a day at a time: a looping agent can have hundreds
    const days = new Map<number, { borrowed: number; repaid: number; usd: number; late: number; quick: number; last: number }>();
    for (const l of x.loans) {
      if (l.defaultedAt) push(l.defaultedAt, "priors", "default", `Loan ${l.id} on Priors marked in default: $${(l.principalMicro / 1e6).toFixed(2)}`, true);
      if (l.repaidAt === null) continue;
      const day = Math.floor(l.repaidAt / 86_400);
      const d = days.get(day) ?? { borrowed: 0, repaid: 0, usd: 0, late: 0, quick: 0, last: 0 };
      d.repaid++; d.usd += l.principalMicro / 1e6; if (l.repaidAt > l.dueAt) d.late++; if (l.repaidAt - l.borrowedAt < 3600) d.quick++; d.last = Math.max(d.last, l.repaidAt);
      days.set(day, d);
    }
    for (const d of days.values()) push(d.last, "priors", "repaid", `${d.repaid === 1 ? "A loan" : `${d.repaid} loans`} repaid on Priors, $${Math.round(d.usd).toLocaleString("en-US")} in all${d.late ? `, ${d.late} late` : ""}`, true, d.quick === d.repaid && d.repaid > 1 ? "each held under an hour: counted for very little" : d.repaid > 3 ? "the 30-day rule counts each further loan for less" : undefined);
    for (const v of x.reviews) push(v.at, "factor-reviews", "review", `A paid review: ${v.stars} of 5 stars`, !v.self && !x.own(v.reviewer), v.self ? "self-dealing" : undefined);
    // what was said of it on ERC-8004, a writer and a day at a time, each with why it counts or not
    const whyOf = this.entryWhy(x);
    const fbDays = new Map<string, { n: number; t: number; client: string; tag: string; why: string; counted: boolean }>();
    for (const f of x.feedback) {
      if (f.revoked) continue;
      const k = `${f.client}:${f.tag1}:${Math.floor(f.at / 86_400)}`;
      const why = whyOf(f);
      const g = fbDays.get(k) ?? { n: 0, t: 0, client: f.client, tag: f.tag1, why, counted: false };
      g.n++; g.t = Math.max(g.t, f.at); g.counted ||= COUNTED.has(why); fbDays.set(k, g);
    }
    for (const g of fbDays.values()) push(g.t, "erc8004-reputation", "feedback", `${g.n === 1 ? "An entry" : `${g.n} entries`} on ERC-8004 from ${shortAddress(g.client)}${g.tag ? ` (${g.tag})` : ""}`, g.counted, g.counted ? undefined : g.why);
    for (const v of x.validations) push(v.at, "erc8004-validation", "validation", `Work checked on ERC-8004 by ${shortAddress(v.validator)}: ${v.response} of 100`, v.response >= FORMULA.reliability.validationPass && !x.own(v.validator));
    void r;
    return out.sort((a, b) => b.t - a.t).slice(0, 40).map(({ t: _t, ...i }) => i);
  }

  /** The report in short, as a text Factor signs (EIP-191), good for ten minutes. */
  async signed(raw: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const signer = this.d.signer();
    if (!signer) return { status: 503, body: { error: "there is no key to sign answers with on this engine" } };
    const r = this.report(raw);
    if (!r) return { status: 404, body: { error: "no agent by that number, wallet or name" } };
    const nowS = this.d.nowS();
    const data = {
      v: 1, kind: "factor.report", version: r.version, chainId: this.d.chainId, block: r.block, issuedAt: nowS, expiresAt: nowS + 600,
      agent: { subject: r.agent.subject, agentId: r.agent.agentId, name: r.agent.name, owner: r.agent.owner, agentWallet: r.agent.agentWallet, desk: r.agent.desk },
      score: r.score, of: 1000, rank: r.rank, parts: Object.fromEntries(r.parts.map((p) => [p.key, p.points])), pulled: r.pulls.reduce((a, p) => a + p.points, 0),
      flags: r.flags.map((f) => f.key), sources: r.sources.map((s) => ({ source: s.source, points: s.points })), page: r.links.page,
      erc8004: r.onChain?.written ? { score: r.onChain.score, version: r.onChain.version, tx: r.onChain.tx, index: r.onChain.index, since: r.onChain.since, registry: r.onChain.registry, tag1: r.onChain.tag1 } : null,
    };
    const s: Sealed = await seal(signer, data);
    return { status: 200, body: s as unknown as Record<string, unknown> };
  }

  /**
   * A report's entry on ERC-8004. Once Factor has written it (./reportserc8004.ts): where it stands, its transaction and
   * its file. Before: the entry prepared, exactly the call that would be sent, its data and its file, not sent.
   */
  erc8004Prepared(raw: string): Record<string, unknown> | null {
    const r = this.report(raw);
    if (!r || !r.agent.agentId) return null;
    const on = r.onChain;
    if (on?.written) return { ...on, written: true, sent: true };
    const writer = this.d.factorWriter();
    const parts = Object.fromEntries(r.parts.map((p) => [p.key, p.points]));
    const made = reportFile({ chainId: this.d.chainId, identity: this.cfg.identity, agentId: r.agent.agentId, writer, site: this.cfg.site, score: r.score, parts, block: r.block, atS: Math.floor(Date.parse(r.asOf) / 1000) });
    const uri = `${this.cfg.site}/api/v1/reports/erc8004/${r.agent.agentId}`;
    const args = [BigInt(r.agent.agentId), BigInt(r.score), made.file.valueDecimals, REPORT_TAG1, made.file.tag2, "", uri, made.hash] as const;
    const ranked = r.score > 0 && !r.agent.factorOwn;
    return {
      written: false, prepared: true, sent: false,
      why: r.agent.factorOwn ? "Not written: Factor's own agents are ranked apart, and their reports are not written to ERC-8004."
        : !ranked ? "Not written: a score of 0 is not ranked, and only ranked agents' reports are written to ERC-8004."
        : "Not written yet: Factor writes every ranked agent's report to ERC-8004 a few at a time, within a gas cap a day. The entry it writes has its own address for its file, /api/v1/erc8004/report/<n>.",
      to: getAddress(this.cfg.reputation), function: "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
      args: args.map((a) => (typeof a === "bigint" ? a.toString() : a)), data: encodeFunctionData({ abi: erc8004ReputationAbi, functionName: "giveFeedback", args }),
      file: made.file, body: made.body, hash: made.hash, writer: writer ? getAddress(writer) : null,
      selfFeedback: writer && (r.agent.owner === writer) ? "the writer owns this identity: the registry would refuse it" : null,
    };
  }

  /**
   * The agents a report entry can be written for: every scored agent with an ERC-8004 identity that is ranked, or whose
   * report Factor wrote before (so a fall to 0 is written too). With its parts, whether it is Factor's own, and its
   * identity's owner and agentWallet as last read.
   */
  writable(): { agentId: string; score: number; parts: Record<string, number>; factorOwn: boolean; owner: string | null; wallet: string | null }[] {
    const rows = this.d.db.q(`SELECT s.agent_id, s.score, s.work, s.repayment, s.feedback, s.time, s.reliability, s.factor_own, i.owner, i.wallet FROM report_scores s LEFT JOIN report_identities i ON i.agent_id = s.agent_id
      WHERE s.agent_id IS NOT NULL AND ((s.score > 0 AND s.factor_own = 0) OR EXISTS (SELECT 1 FROM report_erc8004 e WHERE e.agent_id = CAST(s.agent_id AS TEXT) AND e.status = 'done'))`).all() as { agent_id: number; score: number; work: number; repayment: number; feedback: number; time: number; reliability: number; factor_own: number; owner: string | null; wallet: string | null }[];
    return rows.map((r) => ({ agentId: String(r.agent_id), score: r.score, parts: { work: r.work, repayment: r.repayment, feedback: r.feedback, time: r.time, reliability: r.reliability }, factorOwn: !!r.factor_own, owner: r.owner, wallet: r.wallet }));
  }

  /** The block the ERC-8004 registries are read to. */
  readTo(): number | null {
    return this.cursor("8004", this.cfg.fromBlock).up;
  }

  // ---------- claiming a report ----------

  claimOf(subject: string): { by: string; name: string | null; about: string | null; site: string | null; x: string | null; signed_at: number } | null {
    return (this.d.db.q("SELECT by, name, about, site, x, signed_at FROM report_claims WHERE subject = ? AND hidden = 0").get(subject) as never) ?? null;
  }

  /** Who may claim a subject: its identity's owner or agentWallet as the chain has them now, or the desk wallet of one with none. */
  private async claimers(subject: string): Promise<string[]> {
    const m = /^8004:(\d+)$/.exec(subject);
    if (!m) return [subject];
    const id = BigInt(m[1]!);
    const read = async (fn: "ownerOf" | "getAgentWallet") => (await this.d.chain.read<string>({ to: this.cfg.identity, abi: erc8004IdentityAbi as Abi, functionName: fn, args: [id] }).catch(() => null))?.toLowerCase() ?? null;
    return [await read("ownerOf"), await read("getAgentWallet")].filter((x): x is string => !!x && !/^0x0{40}$/.test(x));
  }

  /**
   * The owner claims its agent's report: { agent, by, name?, about?, site?, x?, at, signature }, signed by `by`, which must
   * be the identity's owner or its agentWallet on the chain now. The profile shows on the report as the owner's words.
   */
  async claim(b: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const no = (status: number, error: string) => ({ status, body: { error } });
    if (!this.on()) return no(503, "credit reports are switched off for now");
    const subject = typeof b.agent === "string" || typeof b.agent === "number" ? this.resolve(String(b.agent)) : null;
    if (!subject) return no(404, "no agent by that number or wallet");
    const by = normalizeAddress(b.by);
    if (!by) return no(400, "by is the wallet that signs");
    const name = b.name === undefined || b.name === null || b.name === "" ? null : typeof b.name === "string" && /^[\p{L}\p{N} ._-]{2,40}$/u.test(b.name.trim()) ? b.name.trim() : undefined;
    if (name === undefined) return no(400, "a name is 2 to 40 letters, digits, spaces, dots, dashes or underscores");
    const about = b.about === undefined || b.about === null || b.about === "" ? null : typeof b.about === "string" && clean(b.about, 200) === b.about ? b.about : undefined;
    if (about === undefined) return no(400, "about is one plain line of up to 200 characters, without < or >");
    const site = b.site === undefined || b.site === null || b.site === "" ? null : typeof b.site === "string" && /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[\w./?=&%#-]*)?$/i.test(b.site.trim()) && b.site.trim().length <= 120 ? b.site.trim() : undefined;
    if (site === undefined) return no(400, "a site is an https address");
    const x = b.x === undefined || b.x === null || b.x === "" ? null : typeof b.x === "string" && /^[A-Za-z0-9_]{1,15}$/.test(b.x) ? b.x : undefined;
    if (x === undefined) return no(400, "an X handle is up to 15 letters, digits or underscores, without the @");
    const at = typeof b.at === "number" && Number.isSafeInteger(b.at) ? b.at : null;
    if (at === null || Math.abs(Math.floor(this.d.now() / 1000) - at) > 600) return no(400, "the signature's time is more than ten minutes from now: sign again");
    const message = claimMessage({ subject, by, name, about, site, x, at });
    if (!(await this.d.signed(by, message, b.signature))) return no(401, "the signature is not this wallet's");
    const may = await this.claimers(subject);
    if (!may.includes(by)) return no(403, subject.startsWith("8004:") ? `only the identity's owner or its agentWallet can claim it: ${may.map((w) => shortAddress(w)).join(" or ") || "the chain names neither"}` : "only the agent's own wallet can claim it");
    const had = this.d.db.q("SELECT signed_at FROM report_claims WHERE subject = ?").get(subject) as { signed_at: number } | undefined;
    if (had && at <= had.signed_at) return no(409, "a newer claim is already stored");
    this.d.db.q("INSERT INTO report_claims (subject, by, name, about, site, x, signed_at, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET by = excluded.by, name = excluded.name, about = excluded.about, site = excluded.site, x = excluded.x, signed_at = excluded.signed_at, signature = excluded.signature, hidden = 0")
      .run(subject, by, name, about, site, x, at, String(b.signature));
    this.d.db.q("UPDATE report_scores SET name = ? WHERE subject = ?").run(name ?? (subject.startsWith("8004:") ? this.identity(Number(subject.slice(5)))?.name ?? `Agent #${subject.slice(5)}` : shortAddress(subject)), subject);
    this.d.log(`[reports] ${subject} claimed by ${by}`);
    return { status: 200, body: { ok: true, subject, by } };
  }

  /** The owner hides an agent's name and words read from the chain or claimed (/v1/admin/hide "report-name"). */
  hide(raw: string, hidden: boolean): boolean {
    const subject = this.resolve(raw) ?? (/^8004:\d+$/.test(raw) ? raw : null);
    if (!subject) return false;
    if (hidden) this.d.db.q("INSERT OR IGNORE INTO report_hidden (subject) VALUES (?)").run(subject);
    else this.d.db.q("DELETE FROM report_hidden WHERE subject = ?").run(subject);
    this.d.db.q("UPDATE report_claims SET hidden = ? WHERE subject = ?").run(hidden ? 1 : 0, subject);
    this.changed = true;
    this.lastScoreAt = 0;
    return true;
  }

  /** For the owner's health answer. */
  health(): Record<string, unknown> {
    return { on: this.on(), caughtUp: this.caughtUp(), cursors: { erc8004: this.cursor("8004", this.cfg.fromBlock), priors: this.cfg.priors ? this.cursor("priors", this.priorsStart()) : null }, scoredAt: this.lastScoreAt ? new Date(this.lastScoreAt).toISOString() : null };
  }
}

/** A report in plain words, for a person or an assistant. The same to the letter in the kit (packages/kit/src/reports.ts). */
export function reportText(r: Pick<ReportJson, "agent" | "score" | "rank" | "ranked" | "version" | "parts" | "pulls" | "flags" | "raise" | "links" | "blank"> & { onChain?: Pick<ReportOnChain, "written" | "since" | "tx" | "txUrl"> | null }): string {
  const who = `${r.agent.name}${r.agent.agentId ? ` (ERC-8004 #${r.agent.agentId})` : ""}`;
  const lines = [`${who}: ${r.score} of 1000 on its Factor credit report${r.rank ? `, ${ordinal(r.rank)} of ${r.ranked.toLocaleString("en-US")} agents scored on Robinhood Chain` : r.agent.factorOwn ? ", one of Factor's own agents, ranked apart" : ""} (${r.version}).`];
  if (r.blank) lines.push("Nothing counts on its record yet: no paid job, no repayment, no paying client's word.");
  lines.push(r.parts.map((p) => `${p.name} ${p.points} of ${p.max}`).join(", ") + ".");
  for (const p of r.parts) if (p.points > 0) lines.push(`${p.name}: ${p.why}`);
  for (const p of r.pulls) lines.push(`Pulled: ${p.why}`);
  for (const f of r.flags) lines.push(`${f.title}: ${f.words} ${f.effect}`);
  if (r.raise.length) lines.push(`What raises it: ${r.raise[0]}`);
  if (r.onChain?.written && r.onChain.since) lines.push(`On ERC-8004 since ${r.onChain.since.slice(0, 10)}: any app reads this score from the reputation registry (tag factorReport). ${r.onChain.txUrl ?? r.onChain.tx ?? ""}`.trim());
  lines.push(`The report: ${r.links.page}`);
  lines.push("Worked out from the chain by one public formula. It moves no money.");
  return lines.join("\n");
}

const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

// ---------- rows ----------

interface LoanRow { pool: string; loan_id: number; agent_id: number; principal: string | null; due_at: number | null; recipient: string | null; borrowed_at: number | null; repaid_at: number | null; payer: string | null; defaulted_at: number | null }
interface FeedbackRow { agent_id: number; client: string; idx: number; value: string; decimals: number; tag1: string; tag2: string; at: number; revoked: number }
interface ScoreRow { subject: string; agent_id: number | null; wallet: string | null; name: string; score: number; work: number; repayment: number; feedback: number; time: number; reliability: number; pulled: number; flags: string; sources: string; factor_own: number; blank: number; first_at: number | null; last_at: number | null }

const loanIn = (r: LoanRow): LoanIn => ({ pool: r.pool, id: r.loan_id, principalMicro: Number(r.principal ?? "0"), borrowedAt: r.borrowed_at ?? 0, dueAt: r.due_at ?? 0, recipient: r.recipient ?? "", repaidAt: r.repaid_at, payer: r.payer, defaultedAt: r.defaulted_at });
const feedbackIn = (r: FeedbackRow): FeedbackIn => ({ client: r.client, index: r.idx, value: r.value, decimals: r.decimals, tag1: r.tag1, tag2: r.tag2, revoked: !!r.revoked, at: r.at });

/** An entry's value, read with its decimals: "4.5", "-0.04", "100". */
export function valueText(value: string, decimals: number): string {
  try {
    const v = BigInt(value);
    if (decimals <= 0 || decimals > 36) return v.toString();
    const neg = v < 0n, a = neg ? -v : v, base = 10n ** BigInt(decimals);
    const frac = (a % base).toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "");
    return `${neg ? "-" : ""}${(a / base).toString()}${frac ? `.${frac}` : ""}`;
  } catch {
    return value;
  }
}
