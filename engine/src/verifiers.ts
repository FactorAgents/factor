// Verifiers (docs/VERIFIERS.md; contracts/src/FactorVerifiers.sol): a customer hires an agent with a verifier, one
// bonded verifier checks the delivered work against its brief, the side its verdict goes against may dispute it, and a
// disputed job goes to a panel of verifiers on different model makers. The verdict is carried out on the desk by its own
// rules, all inside the desk's 24 hours after the delivery.
//
// What the engine does with them:
//
//   reads     the verifier contract's every log into chain_events and the tables here (cases, panel seats, what was
//             paid and lost, the verifiers), and each known verifier's record from the contract every half minute
//   keeps     a job's words (its title and brief) and each verifier's reasons, off the chain. Each is stored only when it
//             hashes to what the chain holds, so nothing has to be signed. A job's words become its desk job's title
//             and brief: what the agent works from and what the verifier checks against
//   keeper    every timed step: step(id) once a first verdict's two hours, a panel's time, the customer's time or a job's
//             due time and grace are over. Anyone may send it
//   house     Factor's own verifiers (VERIFIERS_HOUSE=on), one per model maker, each a Factor account of its own whose
//             bond the owner funds: the first check with tests where the work allows (./verifiercheck.ts) and a model
//             of its maker, and a sealed seat and a reveal on a panel. Never on a job where Factor is a side, never
//             above the day's spending cap on models
//
//   GET  /v1/verifiers/about                       whether verifiers are on, the contract, the rules, the makers, the totals
//   GET  /v1/verifiers                             the same, and every verifier (maker=)
//   GET  /v1/verifiers/<address>                   one verifier and its cases
//   GET  /v1/verifiers/cases                       cases (show=check|seats|reveal|open|all, verifier=)
//   GET  /v1/verifiers/case/<n>                    one case, whole (verifier=)
//   GET  /v1/verifiers/job/<n>                     the case of a desk job
//   POST /v1/verifiers/terms   { id, terms }       a job's words; must hash to what the case holds
//   POST /v1/verifiers/reason  { id, verifier, reason }  a verifier's reasons; must hash to its verdict on the chain
//
// Switches: VERIFIERS=on (off unless it is said), with FACTOR_VERIFIERS and FACTOR_VERIFIERS_BLOCK; VERIFIERS_HOUSE=on
// for Factor's own verifiers; and the owner's "verifiers" switch (./switches.ts), which hides every case and stops the
// keeper and Factor's own verifiers at once. Nothing anybody does on the chain depends on any of them.

import { concat, encodeFunctionData, formatEther, keccak256, toHex, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { factorVerifiersAbi } from "./abi/index.js";
import { KIND, type Accounts, type Call, type Key } from "./accounts.js";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import { readLogs, type CallSpec, type Chain, type ChainLog, type Head } from "./chain/chain.js";
import type { Ctx } from "./chain/context.js";
import type { EngineDb, EventRow } from "./chain/db.js";
import { decode } from "./chain/watch.js";
import { STATE } from "./desk.js";
import { FEEDS, FEED_ABI } from "./house/feeds.js";
import { briefText, oneLine } from "./profiles.js";
import { stopped } from "./switches.js";
import { checkPrompt, readAnswer, reasonText, runTests, verdictOf, type PriceOf } from "./verifiercheck.js";

type Env = Record<string, string | undefined>;

/** The model makers a verifier may declare: their numbers are the contract's; the names are Factor's. 16 to 255 are "another maker". */
export const MAKERS: { id: number; name: string; models: string }[] = [
  { id: 1, name: "Anthropic", models: "Claude" }, { id: 2, name: "Google", models: "Gemini" }, { id: 3, name: "OpenAI", models: "GPT" },
  { id: 4, name: "xAI", models: "Grok" }, { id: 5, name: "Meta", models: "Llama" }, { id: 6, name: "Mistral", models: "Mistral" },
  { id: 7, name: "DeepSeek", models: "DeepSeek" }, { id: 8, name: "Alibaba", models: "Qwen" }, { id: 9, name: "Moonshot", models: "Kimi" },
  { id: 10, name: "Zhipu", models: "GLM" }, { id: 11, name: "Amazon", models: "Nova" }, { id: 12, name: "Cohere", models: "Command" },
  { id: 13, name: "Microsoft", models: "Phi" }, { id: 14, name: "NVIDIA", models: "Nemotron" }, { id: 15, name: "MiniMax", models: "MiniMax" },
];
export const makerName = (id: number): string => MAKERS.find((m) => m.id === id)?.name ?? (id > 0 ? "another maker" : "none");

/** Factor's own verifiers: one model of each maker, cheap ones, each asked through OpenRouter. VERIFIERS_MODELS changes them ("1=anthropic/...,2=..."). */
export const HOUSE_MODELS: Record<number, string> = { 1: "anthropic/claude-haiku-4.5", 2: "google/gemini-2.5-flash", 3: "openai/gpt-5-mini", 7: "deepseek/deepseek-chat-v3.1" };

export interface VerifiersConfig {
  /** VERIFIERS=on: off unless it is said */
  enabled: boolean;
  /** FACTOR_VERIFIERS: the verifier contract, once deployed (contracts/deploy-verifiers.sh writes it) */
  contract: string | null;
  /** FACTOR_VERIFIERS_BLOCK: the block to read cases from */
  fromBlock: bigint | null;
  /** VERIFIERS_PER_PASS: how many cases the keeper steps in one pass */
  perPass: number;
  /** Factor's own verifiers: VERIFIERS_HOUSE=on, their models, and what they may spend on models in a day (VERIFIERS_DAILY_USD) */
  house: { enabled: boolean; models: Record<number, string>; dailyMicro: number };
  note: string | null;
}

export function readVerifiers(env: Env, problems: string[] = []): VerifiersConfig {
  const on = (env.VERIFIERS ?? "").trim().toLowerCase() === "on";
  const raw = env.FACTOR_VERIFIERS?.trim();
  const contract = raw ? normalizeAddress(raw) : null;
  if (raw && !contract) problems.push(`FACTOR_VERIFIERS is not an address: "${raw}"`);
  const rawBlock = env.FACTOR_VERIFIERS_BLOCK?.trim();
  let fromBlock: bigint | null = null;
  if (rawBlock) {
    if (/^\d+$/.test(rawBlock)) fromBlock = BigInt(rawBlock);
    else problems.push(`FACTOR_VERIFIERS_BLOCK must be a block number: it is "${rawBlock}"`);
  }
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const v = env[name]?.trim();
    if (!v) return fallback;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}: it is "${v}"`);
      return fallback;
    }
    return Number(v);
  };
  const models: Record<number, string> = { ...HOUSE_MODELS };
  const rawModels = env.VERIFIERS_MODELS?.trim();
  if (rawModels) {
    for (const k of Object.keys(models)) delete models[Number(k)];
    for (const part of rawModels.split(",").map((s) => s.trim()).filter(Boolean)) {
      const m = /^(\d{1,3})=([a-z0-9._/:-]{3,80})$/i.exec(part);
      if (!m || Number(m[1]) < 1 || Number(m[1]) > 255) { problems.push(`VERIFIERS_MODELS: "${part}" is not maker=model`); continue; }
      models[Number(m[1])] = m[2]!;
    }
    if (Object.keys(models).length < 3) problems.push("VERIFIERS_MODELS names fewer than three makers: a panel needs three");
  }
  let note: string | null = null;
  if (on && !contract) note = "VERIFIERS is on and FACTOR_VERIFIERS is not set: there is no verifier contract to read yet";
  else if (on && fromBlock === null) note = "VERIFIERS is on and FACTOR_VERIFIERS_BLOCK is not set: the block to read cases from";
  return {
    enabled: on, contract, fromBlock, perPass: int("VERIFIERS_PER_PASS", 5, 1, 100),
    house: { enabled: on && (env.VERIFIERS_HOUSE ?? "").trim().toLowerCase() === "on", models, dailyMicro: int("VERIFIERS_DAILY_USD", 2, 1, 1000) * 1_000_000 },
    note,
  };
}

/** The rules, as the contract has them (FactorVerifiers' constants): what the site says. */
export const VERIFIER_RULES = {
  minFeeEth: 0.0001, minBondEth: 0.01, stakePct: 20, minStakeEth: 0.001, wrongLossPct: 50, disputePct: 10, minDisputeEth: 0.0005, panel: 3,
  checkH: 4, disputeH: 2, seatH: 14, revealH: 18, reviewH: 24, reasonChars: 4000, titleChars: 80, briefChars: 12_000,
  minBondWei: 10n ** 16n, checkS: 4 * 3600, disputeS: 2 * 3600, seatS: 14 * 3600, revealS: 18 * 3600, reviewS: 24 * 3600, graceS: 12 * 3600,
} as const;

/** A job's words: compact JSON, keys in this order. The kit and the site write the same, to the letter. */
export interface Terms { title: string; brief: string }
export const termsText = (t: Terms): string => JSON.stringify({ title: t.title, brief: t.brief });
export const hashText = (text: string): Hex => keccak256(toHex(text));

/** A job's words read back from their text, or why they are not. */
export function parseTerms(text: string): Terms | string {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return "the words are not JSON"; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return "the words are a JSON object with a title and a brief";
  const o = v as Record<string, unknown>;
  const title = oneLine(o.title, 3, VERIFIER_RULES.titleChars);
  if (!title || title !== o.title) return `the title is one plain line of 3 to ${VERIFIER_RULES.titleChars} characters, without links`;
  const brief = briefText(o.brief);
  if (!brief || brief !== o.brief) return `the brief is plain text of up to ${VERIFIER_RULES.briefChars} characters`;
  return { title, brief };
}

/** A verifier's reasons, as they are kept: plain text with its line breaks, 1 to 4,000 characters. */
export function reasonOk(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > VERIFIER_RULES.reasonChars || !raw.trim()) return null;
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/.test(raw)) return null;
  return raw;
}

const VT = factorVerifiersAbi as Abi;
const CASE_STATES = ["none", "working", "checked", "disputed", "customer", "accepted", "rejected", "returned"] as const;
export type CaseState = Exclude<(typeof CASE_STATES)[number], "none">;
const HOWS = [null, "first-check", "panel", "customer", "clock", "not-delivered"] as const;
export type How = Exclude<(typeof HOWS)[number], null>;
const ENDED: CaseState[] = ["accepted", "rejected", "returned"];

export interface CaseRow {
  id: number; block: number; at: number; tx_hash: string; job: number; customer: string; agent: string; price: string; fee: string; stake: string; dispute_bond: string; terms_hash: string;
  state: CaseState; how: How | null; checker: string | null; first_accept: number | null; checked_at: number | null; check_tx: string | null; reason_hash: string | null;
  disputer: string | null; disputed_at: number | null; dispute_tx: string | null;
  decided_how: How | null; verdict: string | null; votes_accept: number; votes_reject: number; decided_at: number | null;
  ended_at: number | null; ended_tx: string | null; to_customer: string | null;
}
export interface SeatRow { case_id: number; verifier: string; block: number; seat: number; maker: number; since: number; sat_at: number; sat_tx: string; gone: string | null; gone_by: string | null; gone_at: number | null; vote: string | null; reason_hash: string | null; revealed_at: number | null }
interface VerifierRow { address: string; block: number; maker: number; since: number; joined_at: number; joined_tx: string; record: string; record_at: number }
/** A verifier's record as the contract holds it. Amounts in wei, as text. */
export interface Record_ { maker: number; since: number; open: number; checks: number; panels: number; right: number; wrong: number; hidden: number; struck: number; free: string; locked: string; earned: string; lost: string }
interface DeskJob { state: number; due_at: number; delivered_at: number; early: string; price: string }
interface HouseRow { case_id: number; verifier: string; role: string; state: string; accept: number | null; reason: string | null; salt: string | null; relay: string | null; cost_micro: number; tries: number; next_at: number; updated_at: number }

const SCHEMA = `
-- Verifiers (./verifiers.ts). A job's words and a verifier's reasons: never on the chain, and kept by a reindex.
CREATE TABLE IF NOT EXISTS verifier_terms (
  case_id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  at INTEGER NOT NULL,               -- ms
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS verifier_reasons (
  case_id INTEGER NOT NULL,
  verifier TEXT NOT NULL,
  body TEXT NOT NULL,
  at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (case_id, verifier)
);
-- Factor's own verifiers at work: one row for each case and verifier, a first check or a seat.
CREATE TABLE IF NOT EXISTS verifier_house (
  case_id INTEGER NOT NULL,
  verifier TEXT NOT NULL,
  role TEXT NOT NULL,                -- check | seat
  state TEXT NOT NULL,               -- checking | sending | sent | sealed | sat | revealing | revealed | gave_up
  accept INTEGER,
  reason TEXT,
  salt TEXT,
  relay TEXT,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  tries INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (case_id, verifier)
);
CREATE TABLE IF NOT EXISTS verifier_spend (
  day TEXT PRIMARY KEY,
  micro INTEGER NOT NULL
);
`;

/** Asks one model and says what it cost: text, and millionths of a dollar. */
export type Asker = (model: string, system: string, user: string) => Promise<{ text: string; costMicro: number }>;

/** A model asked through OpenRouter's chat completions. What it cost is OpenRouter's own figure when it gives one, and a high estimate otherwise. */
export function routerAsker(key: string, url = "https://openrouter.ai/api/v1"): Asker {
  return async (model, system, user) => {
    const res = await fetch(`${url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "Factor verifiers" },
      body: JSON.stringify({ model, max_tokens: 700, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }], usage: { include: true } }),
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`the model's router answered ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
    const text = body.choices?.[0]?.message?.content ?? "";
    const u = body.usage ?? {};
    const cost = typeof u.cost === "number" && u.cost >= 0 ? u.cost : ((u.prompt_tokens ?? 8000) * 3 + (u.completion_tokens ?? 700) * 15) / 1e6;
    return { text, costMicro: Math.ceil(cost * 1e6) };
  };
}

export interface VerifiersDeps {
  cfg: VerifiersConfig;
  db: EngineDb;
  chain: Chain;
  chainId: number;
  /** the chain's clock, seconds */
  nowS: () => number;
  /** the wall clock, ms */
  now: () => number;
  log: (line: string) => void;
  names: () => Map<string, { name: string; hidden?: number }>;
  /** what Factor's own records tie two wallets by, or null (the checks a review is held to: ./engine.ts) */
  ties: (a: string, b: string) => Promise<string | null>;
  /** whether a wallet is Factor's own: one of its agents, its demonstration customer */
  factorOwn: (address: string) => boolean;
  /** gives a desk job its title and brief, as its customer's own: the words were checked against the chain */
  brief: (job: number, by: string, title: string, brief: string) => void;
  /** the delivered work of a desk job, when it was published */
  work: (job: number) => { kind: string; body: string; at: number } | null;
  /** Factor's own verifiers: their key's seed, the accounts they act through, whether the engine sends, and the model */
  house?: { seed: Hex | null; accounts: () => Accounts | null; live: () => boolean; ask: Asker | null; priceOf?: PriceOf; signers?: (maker: number) => HouseVerifierSigner };
}

export interface HouseVerifierSigner { address: string; signTypedData: (typed: never) => Promise<Hex>; salt: (caseId: number) => Hex }

interface HouseVerifier { maker: number; model: string; signer: HouseVerifierSigner; key: Key; address: string | null; ready: boolean; noted: number }

/** The totals, read from the contract. */
export interface VerifierTotals { bonds: string; staked: string; fees: string; disputes: string; owed: string; atDesk: string; hired: string; feesPaid: string; slashed: string; count: number; at: number }

export class Verifiers {
  private totalsReadAt = 0;
  private recordsReadAt = 0;
  readonly house: HouseVerifier[] = [];
  private busy = false;

  constructor(readonly d: VerifiersDeps) {
    d.db.db.exec(SCHEMA);
    const h = d.house;
    if (d.cfg.house.enabled && h) {
      for (const [m, model] of Object.entries(d.cfg.house.models)) {
        const maker = Number(m);
        const signer = h.signers?.(maker) ?? (h.seed ? houseVerifierSigner(h.seed, maker) : null);
        if (!signer) continue;
        this.house.push({ maker, model, signer, key: { kind: KIND.wallet, a: `0x${"0".repeat(24)}${signer.address.slice(2)}` as Hex, b: `0x${"0".repeat(64)}` as Hex }, address: null, ready: false, noted: 0 });
      }
    }
  }

  /** Reading the chain: switched on and a contract to read. */
  reading(): boolean {
    return this.d.cfg.enabled && !!this.d.cfg.contract && this.d.cfg.fromBlock !== null;
  }

  /** Shown and kept: reading, and the owner has not stopped it. */
  on(): boolean {
    return this.reading() && !stopped(this.d.db, "verifiers");
  }

  // ---------- the books ----------

  row(id: number): CaseRow | null {
    return (this.d.db.q("SELECT * FROM verifier_cases WHERE id = ?").get(id) as CaseRow | undefined) ?? null;
  }

  /** The case a desk job belongs to, or null. */
  ofJob(job: number): CaseRow | null {
    return (this.d.db.q("SELECT * FROM verifier_cases WHERE job = ?").get(job) as CaseRow | undefined) ?? null;
  }

  seats(id: number): SeatRow[] {
    return this.d.db.q("SELECT * FROM verifier_seats WHERE case_id = ? ORDER BY sat_at, seat").all(id) as SeatRow[];
  }

  /** The seats a case's panel holds now: the ones nobody moved out or struck. */
  seated(id: number): SeatRow[] {
    return this.seats(id).filter((s) => s.gone === null).sort((a, b) => a.seat - b.seat);
  }

  private verifierRow(address: string): VerifierRow | null {
    return (this.d.db.q("SELECT * FROM verifier_list WHERE address = ?").get(address) as VerifierRow | undefined) ?? null;
  }

  record(address: string): Record_ | null {
    const r = this.verifierRow(address);
    if (!r) return null;
    try {
      const x = JSON.parse(r.record) as Record_;
      return x && typeof x.free === "string" ? x : null;
    } catch {
      return null;
    }
  }

  terms(id: number): Terms | null {
    const r = this.d.db.q("SELECT body, hidden FROM verifier_terms WHERE case_id = ?").get(id) as { body: string; hidden: number } | undefined;
    if (!r || r.hidden) return null;
    const t = parseTerms(r.body);
    return typeof t === "string" ? null : t;
  }

  private reason(id: number, verifier: string): string | null {
    const r = this.d.db.q("SELECT body, hidden FROM verifier_reasons WHERE case_id = ? AND verifier = ?").get(id, verifier) as { body: string; hidden: number } | undefined;
    return r && !r.hidden ? r.body : null;
  }

  totals(): VerifierTotals | null {
    return this.d.db.getJson<VerifierTotals>("verifiers:totals");
  }

  /** The owner hides a case's words, or a verifier's reasons (`<case>:<address>`). The case stays on the chain and on the site. */
  hide(what: "case-terms" | "reason", key: string, hidden: boolean): boolean {
    const h = hidden ? 1 : 0;
    if (what === "reason") {
      const [id, who] = key.split(":");
      return this.d.db.q("UPDATE verifier_reasons SET hidden = ? WHERE case_id = ? AND verifier = ?").run(h, Number(id), (who ?? "").toLowerCase()).changes > 0;
    }
    const id = Number(key);
    const n = this.d.db.q("UPDATE verifier_terms SET hidden = ? WHERE case_id = ?").run(h, id).changes;
    const c = this.row(id);
    if (c) {
      this.d.db.q("UPDATE job_titles SET hidden = ? WHERE job_id = ?").run(h, c.job);
      this.d.db.q("UPDATE job_briefs SET hidden = ? WHERE job_id = ?").run(h, c.job);
    }
    return n > 0;
  }

  // ---------- reading the chain ----------

  /** One log of the verifier contract's, written down. Returns a line for the engine's log, when it is worth one. Exported for the tests. */
  apply(log: ChainLog, at: number): string | null {
    const e = decode({ name: "verifiers" as never, abi: VT }, log, at);
    if (!e) return null;
    e.contract = "verifiers";
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
    const who = normalizeAddress(a.verifier) ?? "";
    switch (e.event) {
      case "Joined":
        db.q("INSERT OR IGNORE INTO verifier_list (address, block, maker, since, joined_at, joined_tx) VALUES (?, ?, ?, ?, ?, ?)").run(who, e.block, Number(a.maker), e.at, e.at, e.tx_hash);
        this.recordsReadAt = 0;
        return `${shortAddress(who)} joined as a verifier on ${makerName(Number(a.maker))}, with ${ethText(String(a.bond))} ETH`;
      case "MakerSet":
        db.q("UPDATE verifier_list SET maker = ? WHERE address = ?").run(Number(a.maker), who);
        return `${shortAddress(who)} now runs on ${makerName(Number(a.maker))}`;
      case "Standing":
        db.q("UPDATE verifier_list SET since = ? WHERE address = ?").run(Number(a.since), who);
        return null;
      case "BondAdded":
      case "Withdrawn":
        db.q("UPDATE verifier_list SET record_at = 0 WHERE address = ?").run(who);
        return null;
      case "Hired": {
        const customer = normalizeAddress(a.customer)!, agent = normalizeAddress(a.agent)!;
        db.q("INSERT OR IGNORE INTO verifier_cases (id, block, at, tx_hash, job, customer, agent, price, fee, stake, dispute_bond, terms_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          id, e.block, e.at, e.tx_hash, Number(a.job), customer, agent, String(a.price), String(a.fee), String(a.stake), String(a.disputeBond), String(a.terms).toLowerCase(),
        );
        this.briefJob(id);
        return `case ${id}: job ${Number(a.job)} hired with a verifier, ${ethText(String(a.price))} ETH for ${this.name(agent)} and a fee of ${ethText(String(a.fee))}`;
      }
      case "Checked": {
        const accept = a.accept === true || a.accept === "true";
        db.q("UPDATE verifier_cases SET state = 'checked', checker = ?, first_accept = ?, checked_at = ?, check_tx = ?, reason_hash = ? WHERE id = ?").run(who, accept ? 1 : 0, e.at, e.tx_hash, String(a.reason).toLowerCase(), id);
        this.houseReason(id, who, String(a.reason));
        db.q("UPDATE verifier_list SET record_at = 0 WHERE address = ?").run(who);
        return `case ${id}: ${shortAddress(who)} checked the work: ${accept ? "accept" : "reject"}`;
      }
      case "Disputed":
        db.q("UPDATE verifier_cases SET state = 'disputed', disputer = ?, disputed_at = ?, dispute_tx = ? WHERE id = ?").run(normalizeAddress(a.by), e.at, e.tx_hash, id);
        return `case ${id}: disputed by ${shortAddress(normalizeAddress(a.by) ?? "")}`;
      case "Sat": {
        const v = this.verifierRow(who);
        db.q("INSERT INTO verifier_seats (case_id, verifier, block, seat, maker, since, sat_at, sat_tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(case_id, verifier) DO UPDATE SET seat = excluded.seat, maker = excluded.maker, since = excluded.since, sat_at = excluded.sat_at, sat_tx = excluded.sat_tx, gone = NULL, gone_by = NULL, gone_at = NULL").run(
          id, who, e.block, Number(a.seat), Number(a.maker), v?.since ?? 0, e.at, e.tx_hash,
        );
        db.q("UPDATE verifier_list SET record_at = 0 WHERE address = ?").run(who);
        return `case ${id}: ${shortAddress(who)} (${makerName(Number(a.maker))}) took seat ${Number(a.seat) + 1}`;
      }
      case "Displaced":
        db.q("UPDATE verifier_seats SET gone = 'displaced', gone_by = ?, gone_at = ? WHERE case_id = ? AND verifier = ?").run(normalizeAddress(a.by), e.at, id, who);
        db.q("UPDATE verifier_list SET record_at = 0 WHERE address = ?").run(who);
        return `case ${id}: ${shortAddress(who)} moved out by an older standing`;
      case "Struck":
        db.q("UPDATE verifier_seats SET gone = 'struck', gone_by = ?, gone_at = ? WHERE case_id = ? AND verifier = ?").run(normalizeAddress(a.by), e.at, id, who);
        db.q("UPDATE verifier_list SET record_at = 0 WHERE address = ?").run(who);
        return `case ${id}: ${shortAddress(who)} struck from the panel`;
      case "Revealed": {
        const accept = a.accept === true || a.accept === "true";
        db.q("UPDATE verifier_seats SET vote = ?, reason_hash = ?, revealed_at = ? WHERE case_id = ? AND verifier = ?").run(accept ? "accept" : "reject", String(a.reason).toLowerCase(), e.at, id, who);
        this.houseReason(id, who, String(a.reason));
        return `case ${id}: ${shortAddress(who)} revealed ${accept ? "accept" : "reject"}`;
      }
      case "Decided": {
        const how = HOWS[Number(a.how)] ?? null;
        const verdict = Number(a.verdict) === 1 ? "accept" : Number(a.verdict) === 2 ? "reject" : null;
        db.q("UPDATE verifier_cases SET decided_how = ?, verdict = ?, votes_accept = ?, votes_reject = ?, decided_at = ? WHERE id = ?").run(how, verdict, Number(a.votesAccept), Number(a.votesReject), e.at, id);
        if (verdict === null) db.q("UPDATE verifier_cases SET state = 'customer' WHERE id = ? AND state IN ('working', 'checked', 'disputed')").run(id);
        this.recordsReadAt = 0;
        return `case ${id}: ${verdict ? `${how === "panel" ? "the panel" : "the first verdict"} decided ${verdict} (${Number(a.votesAccept)} to ${Number(a.votesReject)})` : "the customer decides now, by the desk's own rule"}`;
      }
      case "Paid":
      case "Slashed":
        db.q("INSERT OR IGNORE INTO verifier_money (case_id, verifier, kind, amount, block, at, tx_hash, log_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, who, e.event === "Paid" ? "paid" : "slashed", String(a.amount), e.block, e.at, e.tx_hash, e.log_index);
        db.q("UPDATE verifier_list SET record_at = 0 WHERE address = ?").run(who);
        return null;
      case "Ended": {
        const state = CASE_STATES[Number(a.state)] ?? "accepted";
        const how = HOWS[Number(a.how)] ?? null;
        db.q("UPDATE verifier_cases SET state = ?, how = ?, ended_at = ?, ended_tx = ?, to_customer = ? WHERE id = ?").run(state, how, e.at, e.tx_hash, String(a.toCustomer), id);
        return `case ${id}: ${state}${how ? `, by ${how.replace("-", " ")}` : ""}`;
      }
      case "Owed":
        return `${ethText(String(a.amount))} ETH waits in the verifier contract for ${shortAddress(normalizeAddress(a.who) ?? "")}, who refused it`;
      default:
        return null;
    }
  }

  /** A case's desk job gets its title and brief from the case's words, once both are here. */
  private briefJob(id: number): void {
    const c = this.row(id);
    const t = this.terms(id);
    if (!c || !t) return;
    this.d.brief(c.job, c.customer, t.title, `${t.brief}\n\n(Hired with a verifier: once it is delivered, a bonded verifier checks the work against this brief.)`);
  }

  /** The reasons one of Factor's own verifiers wrote, kept once the chain holds their hash. */
  private houseReason(id: number, who: string, hash: string): void {
    const h = this.d.db.q("SELECT reason FROM verifier_house WHERE case_id = ? AND verifier = ?").get(id, who) as { reason: string | null } | undefined;
    if (h?.reason && hashText(h.reason) === hash.toLowerCase()) this.d.db.q("INSERT OR IGNORE INTO verifier_reasons (case_id, verifier, body, at) VALUES (?, ?, ?, ?)").run(id, who, h.reason, this.d.now());
  }

  /** One pass of the verifier contract's logs, from where the last stopped to the safe head. Returns the lines worth logging. */
  async watch(ctx: Ctx, head: Head): Promise<string[]> {
    if (!this.reading()) return [];
    const { db, chain } = this.d;
    const safe = head.number - BigInt(ctx.params.confirmations);
    const start = (db.cursor("verifiers") ?? this.d.cfg.fromBlock! - 1n) + 1n;
    if (start > safe) return [];
    const lines: string[] = [];
    const span = BigInt(ctx.params.logSpan);
    let from = start;
    for (let n = 0; n < ctx.params.spansPerPass && from <= safe; n++) {
      const to = from + span - 1n > safe ? safe : from + span - 1n;
      let logs: ChainLog[] = [];
      await readLogs(chain, from, to, { address: [this.d.cfg.contract!] }, to - from + 1n, (got) => { logs = got; }, 1);
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
        db.setCursor("verifiers", to);
      });
      from = to + 1n;
    }
    for (const l of lines) this.d.log(`[verifiers] ${l}`);
    if (lines.length) this.totalsReadAt = 0;
    return lines;
  }

  /** The totals and every verifier's record whose record moved, once every half minute. */
  async refresh(): Promise<void> {
    if (!this.reading()) return;
    const now = this.d.now();
    const R = <T>(fn: string, args: unknown[] = []) => this.d.chain.read<T>({ to: this.d.cfg.contract!, abi: VT, functionName: fn, args });
    if (now - this.totalsReadAt > 30_000) {
      this.totalsReadAt = now;
      const [bonds, staked, fees, disputes, owed, atDesk, hired, feesPaid, slashed, count] = await Promise.all([
        R<bigint>("bonds"), R<bigint>("staked"), R<bigint>("fees"), R<bigint>("disputes"), R<bigint>("owedTotal"), R<bigint>("atDesk"), R<bigint>("totalHired"), R<bigint>("totalFeesPaid"), R<bigint>("totalSlashed"), R<bigint>("caseCount"),
      ]);
      this.d.db.setJson("verifiers:totals", { bonds: String(bonds), staked: String(staked), fees: String(fees), disputes: String(disputes), owed: String(owed), atDesk: String(atDesk), hired: String(hired), feesPaid: String(feesPaid), slashed: String(slashed), count: Number(count), at: now } satisfies VerifierTotals);
    }
    // a verifier's record is read again when something of it moved, and every ten minutes anyway
    const stale = this.d.db.q("SELECT address FROM verifier_list WHERE record_at < ? OR ? = 0 ORDER BY record_at LIMIT 20").all(now - 600_000, this.recordsReadAt) as { address: string }[];
    this.recordsReadAt = now;
    for (const { address } of stale) {
      const x = await R<{ maker: number; since: number | bigint; open: number; checks: number; panels: number; right: number; wrong: number; hidden: number; struck: number; free: bigint; locked: bigint; earned: bigint; lost: bigint }>("verifier", [address]);
      const rec: Record_ = { maker: Number(x.maker), since: Number(x.since), open: Number(x.open), checks: Number(x.checks), panels: Number(x.panels), right: Number(x.right), wrong: Number(x.wrong), hidden: Number(x.hidden), struck: Number(x.struck), free: String(x.free), locked: String(x.locked), earned: String(x.earned), lost: String(x.lost) };
      this.d.db.q("UPDATE verifier_list SET record = ?, record_at = ?, maker = ?, since = ? WHERE address = ?").run(JSON.stringify(rec), now, rec.maker, rec.since, address);
    }
  }

  // ---------- the clock ----------

  private deskJob(job: number): DeskJob | null {
    return (this.d.db.q("SELECT state, due_at, delivered_at, early, price FROM desk_jobs WHERE id = ?").get(job) as DeskJob | undefined) ?? null;
  }

  /** A case's times, from its delivery (seconds), or null before it is delivered. */
  deadlines(c: CaseRow, job: DeskJob | null): { checkBy: number; disputeBy: number | null; seatBy: number; revealBy: number; reviewBy: number } | null {
    const d = job?.delivered_at ?? 0;
    if (!d) return null;
    const R = VERIFIER_RULES;
    return { checkBy: d + R.checkS, disputeBy: c.checked_at ? c.checked_at + R.disputeS : null, seatBy: d + R.seatS, revealBy: d + R.revealS, reviewBy: d + R.reviewS };
  }

  /** What is next for a case on the chain's clock, and when; `step` means anyone's step(id) does it now. Exported for the tests. */
  next(c: CaseRow, job: DeskJob | null, t: number): { next: "work" | "check" | "dispute" | "seats" | "reveals" | "customer" | "step" | null; at: number | null } {
    if (ENDED.includes(c.state) || !job) return { next: null, at: null };
    // the desk moved around the contract: the job came back, or was settled after its 24 hours
    if (job.state === STATE.refunded || job.state === STATE.declined || job.state === STATE.settled) return { next: "step", at: null };
    if (job.state === STATE.locked || job.state === STATE.advanced) {
      const at = job.due_at + VERIFIER_RULES.graceS + 1;
      return t >= at ? { next: "step", at: null } : { next: "work", at };
    }
    if (job.state !== STATE.delivered) return { next: null, at: null };
    const dl = this.deadlines(c, job)!;
    if (c.state === "working") return t < dl.checkBy ? { next: "check", at: dl.checkBy } : { next: "step", at: null };
    if (c.state === "checked") return t < dl.disputeBy! ? { next: "dispute", at: dl.disputeBy } : { next: "step", at: null };
    if (c.state === "disputed") {
      if (t < dl.seatBy) return { next: "seats", at: dl.seatBy };
      const seated = this.seated(c.id);
      if (t < dl.revealBy && seated.some((s) => s.vote === null)) return { next: "reveals", at: dl.revealBy };
      return { next: "step", at: null };
    }
    if (c.state === "customer") return t < dl.reviewBy ? { next: "customer", at: dl.reviewBy } : { next: "step", at: null };
    return { next: null, at: null };
  }

  // ---------- the keeper ----------

  /**
   * The keeper's turn (./chain/act.ts calls it as the step "verifier", before the desk's own settling and refunding):
   * every case whose time has come is stepped. A few a pass, the oldest first.
   */
  async step(ctx: Ctx, head: Head, attempt: (kind: "verifier", ref: string, call: CallSpec, detail: Record<string, unknown>, feeCap: bigint) => Promise<{ status: string; why: string; hash?: string }>): Promise<string> {
    if (!this.reading()) return "verifiers are not switched on";
    if (stopped(this.d.db, "verifiers")) return "verifiers are stopped by the owner";
    const db = this.d.db;
    const t = head.timestamp;
    const said: string[] = [];
    let n = 0;
    const ready = (ref: string): boolean => {
      const prev = db.lastAction("verifier", ref);
      if (!prev) return true;
      if (prev.status === "signed" || prev.status === "sent") return false;
      if (prev.status === "done") return this.d.now() - prev.updated_at > 120_000;
      if (prev.status === "failed") return this.d.now() - prev.updated_at > 600_000;
      if (prev.status === "dry") return this.d.now() - prev.created_at > 1_800_000;
      return true;
    };
    const live = db.q("SELECT * FROM verifier_cases WHERE state IN ('working', 'checked', 'disputed', 'customer') ORDER BY id").all() as CaseRow[];
    for (const c of live) {
      if (n >= this.d.cfg.perPass || ctx.stopping()) break;
      if (this.next(c, this.deskJob(c.job), t).next !== "step") continue;
      const ref = `step:${c.id}:${c.state}`;
      if (!ready(ref)) continue;
      n++;
      const words = `step case ${c.id} (${c.state})`;
      const out = await attempt("verifier", ref, { to: this.d.cfg.contract!, abi: VT, functionName: "step", args: [BigInt(c.id)] }, { case: c.id, job: c.job, state: c.state }, ctx.params.maxGasWei);
      said.push(`${out.status === "dry" ? `would ${words}` : out.status === "done" ? words : `${words}: ${out.status}`}${out.status === "failed" || out.status === "skipped" ? ` (${out.why})` : ""}`);
      if (db.openActions().length > 0) break;
    }
    return said.length ? said.join("; ") : "no case needs a step";
  }

  // ---------- what is sent in, hashed against the chain ----------

  /** A job's words. They must hash to what the case holds; nothing else is taken, so nothing has to be signed. */
  async putTerms(body: Record<string, unknown>): Promise<Answer> {
    if (!this.on()) return no(503, "verifiers are switched off for now");
    const id = idOf(body.id);
    if (id === null) return no(400, "id is a case's number");
    const text = typeof body.terms === "string" ? body.terms : "";
    if (!text || Buffer.byteLength(text, "utf8") > 16_000) return no(400, "the words are JSON text of at most 16,000 bytes");
    const hash = this.row(id)?.terms_hash ?? (await this.chainTerms(id));
    if (!hash) return no(404, "there is no such case on the chain yet: try again in a moment");
    if (hash.toLowerCase() !== hashText(text)) return no(409, "these words do not hash to what the case holds");
    const t = parseTerms(text);
    if (typeof t === "string") return no(400, t);
    this.d.db.q("INSERT INTO verifier_terms (case_id, body, at) VALUES (?, ?, ?) ON CONFLICT(case_id) DO NOTHING").run(id, text, this.d.now());
    this.briefJob(id);
    return { status: 200, body: { ok: true, id } };
  }

  private async chainTerms(id: number): Promise<string | null> {
    const x = await this.d.chain.read<{ state: number | bigint; terms: string }>({ to: this.d.cfg.contract!, abi: VT, functionName: "getCase", args: [BigInt(id)] });
    return Number(x.state) === 0 ? null : x.terms;
  }

  /** A verifier's reasons. They must hash to its first verdict or its revealed vote on this case, as the engine has read them. */
  putReason(body: Record<string, unknown>): Answer {
    if (!this.on()) return no(503, "verifiers are switched off for now");
    const id = idOf(body.id);
    if (id === null) return no(400, "id is a case's number");
    const who = normalizeAddress(body.verifier);
    if (!who) return no(400, "verifier is not an address");
    const text = reasonOk(body.reason);
    if (text === null) return no(400, `the reasons are plain text of 1 to ${VERIFIER_RULES.reasonChars} characters`);
    const c = this.row(id);
    if (!c) return no(404, "there is no such case yet: try again in a moment");
    const seat = this.seats(id).find((s) => s.verifier === who);
    const hash = c.checker === who ? c.reason_hash : seat?.reason_hash ?? null;
    if (!hash) return no(409, "this verifier has no verdict on this case that the engine has read yet: try again in a moment");
    if (hash !== hashText(text)) return no(409, "these reasons do not hash to this verifier's verdict on the chain");
    this.d.db.q("INSERT INTO verifier_reasons (case_id, verifier, body, at) VALUES (?, ?, ?, ?) ON CONFLICT(case_id, verifier) DO NOTHING").run(id, who, text, this.d.now());
    return { status: 200, body: { ok: true } };
  }

  // ---------- what the site reads ----------

  private houseSet(): Set<string> {
    return new Set(this.house.filter((h) => h.address).map((h) => h.address!));
  }

  /** A verifier, short: as a case names it. */
  short(address: string): VerifierShort {
    const r = this.verifierRow(address);
    const p = this.d.names().get(address);
    return { address, name: p && !p.hidden ? p.name : null, maker: r?.maker ?? 0, makerName: makerName(r?.maker ?? 0), house: this.houseSet().has(address) };
  }

  verifierJson(address: string): VerifierJson | null {
    const r = this.verifierRow(address);
    if (!r) return null;
    const rec = this.record(address);
    const w = (x: string | undefined) => x ?? "0";
    const calls = (rec?.right ?? 0) + (rec?.wrong ?? 0);
    return {
      ...this.short(address), standing: (rec?.since ?? r.since) > 0, since: (rec?.since ?? r.since) > 0 ? iso(rec?.since ?? r.since) : null, joinedAt: iso(r.joined_at),
      freeEth: ethNum(w(rec?.free)), freeWei: w(rec?.free), lockedEth: ethNum(w(rec?.locked)), lockedWei: w(rec?.locked), open: rec?.open ?? 0,
      checks: rec?.checks ?? 0, panels: rec?.panels ?? 0, right: rec?.right ?? 0, wrong: rec?.wrong ?? 0, hidden: rec?.hidden ?? 0, struck: rec?.struck ?? 0,
      earnedEth: ethNum(w(rec?.earned)), lostEth: ethNum(w(rec?.lost)), rightPct: calls ? Math.round(((rec?.right ?? 0) / calls) * 100) : null,
    };
  }

  /** Every verifier, oldest standing first (no standing last). */
  verifierList(maker?: number): VerifierJson[] {
    const rows = this.d.db.q(`SELECT address FROM verifier_list ${maker ? "WHERE maker = ?" : ""} ORDER BY CASE WHEN since = 0 THEN 1 ELSE 0 END, since, joined_at LIMIT 200`).all(...(maker ? [maker] : [])) as { address: string }[];
    return rows.map((r) => this.verifierJson(r.address)!).filter(Boolean);
  }

  about(): VerifiersAbout {
    const on = this.on();
    const t = this.totals();
    const R = VERIFIER_RULES;
    const count = (sql: string) => (this.d.db.q(sql).get() as { n: number }).n;
    return {
      enabled: on, contract: on ? this.d.cfg.contract : null, chainId: this.d.chainId,
      rules: { minFeeEth: R.minFeeEth, minBondEth: R.minBondEth, stakePct: R.stakePct, minStakeEth: R.minStakeEth, wrongLossPct: R.wrongLossPct, disputePct: R.disputePct, minDisputeEth: R.minDisputeEth, panel: R.panel, checkH: R.checkH, disputeH: R.disputeH, seatH: R.seatH, revealH: R.revealH, reviewH: R.reviewH, reasonChars: R.reasonChars, titleChars: R.titleChars, briefChars: R.briefChars },
      makers: MAKERS,
      totals: on && t ? {
        cases: t.count, open: count("SELECT COUNT(*) AS n FROM verifier_cases WHERE state IN ('working', 'checked', 'disputed', 'customer')"), disputed: count("SELECT COUNT(*) AS n FROM verifier_cases WHERE disputer IS NOT NULL"),
        panels: count("SELECT COUNT(*) AS n FROM verifier_cases WHERE decided_how = 'panel'"), verifiers: count("SELECT COUNT(*) AS n FROM verifier_list"),
        bondedEth: ethNum((BigInt(t.bonds) + BigInt(t.staked)).toString()), feesPaidEth: ethNum(t.feesPaid), slashedEth: ethNum(t.slashed),
      } : null,
      house: on ? this.house.map((h) => ({ address: h.address, maker: h.maker, makerName: makerName(h.maker), model: h.model, joined: !!(h.address && this.verifierRow(h.address)) })) : [],
    };
  }

  /** One case whole. With `forWho`, whether that wallet may check or sit on it now, by the contract's rules. */
  async caseJson(c: CaseRow, forWho?: string | null): Promise<CaseJson> {
    const t = this.d.nowS();
    const job = this.deskJob(c.job);
    const words = this.terms(c.id);
    const work = job && job.state >= STATE.delivered && job.state <= STATE.half ? this.d.work(c.job) : null;
    const dl = this.deadlines(c, job);
    const nx = this.next(c, job, t);
    const named = (a: string) => ({ address: a, name: this.name(a) });
    const seats = await Promise.all(this.seated(c.id).map(async (s) => ({
      seat: s.seat, verifier: this.short(s.verifier), maker: s.maker, makerName: makerName(s.maker), since: s.since ? iso(s.since) : null,
      vote: s.vote as "accept" | "reject" | null, reasonHash: s.reason_hash, reason: s.vote ? this.reason(c.id, s.verifier) : null, ties: await this.tiesOf(c, s.verifier),
    })));
    const money = this.d.db.q("SELECT verifier, kind, amount FROM verifier_money WHERE case_id = ? ORDER BY log_index").all(c.id) as { verifier: string; kind: string; amount: string }[];
    const out: CaseJson = {
      id: c.id, job: { n: c.job, id: String(c.job).padStart(4, "0"), state: job ? DESK_STATES[job.state] ?? "locked" : "locked" },
      customer: c.customer, agent: named(c.agent),
      priceEth: ethNum(c.price), priceWei: c.price, feeEth: ethNum(c.fee), feeWei: c.fee, stakeEth: ethNum(c.stake), stakeWei: c.stake, disputeBondEth: ethNum(c.dispute_bond), disputeBondWei: c.dispute_bond,
      termsHash: c.terms_hash, title: words?.title ?? null, brief: words?.brief ?? null,
      work: work ? { kind: work.kind === "html" ? "html" : "text", text: work.body, at: new Date(work.at).toISOString() } : null,
      state: c.state, how: c.how, hiredAt: iso(c.at), tx: c.tx_hash,
      ...(job?.delivered_at ? { deliveredAt: iso(job.delivered_at) } : {}),
      ...(dl ? { deadlines: { checkBy: iso(dl.checkBy), disputeBy: dl.disputeBy ? iso(dl.disputeBy) : null, seatBy: iso(dl.seatBy), revealBy: iso(dl.revealBy), reviewBy: iso(dl.reviewBy) } } : {}),
      ...(c.checker ? { first: { verifier: this.short(c.checker), accept: c.first_accept === 1, at: iso(c.checked_at ?? 0), reasonHash: c.reason_hash ?? "", reason: this.reason(c.id, c.checker), tx: c.check_tx ?? "", ties: await this.tiesOf(c, c.checker) } } : {}),
      ...(c.disputer ? { dispute: { by: c.disputer === c.customer ? "customer" as const : "agent" as const, address: c.disputer, at: iso(c.disputed_at ?? 0), bondEth: ethNum(c.dispute_bond), tx: c.dispute_tx ?? "" } } : {}),
      seats,
      struck: (this.d.db.q("SELECT verifier, gone_by, gone_at FROM verifier_seats WHERE case_id = ? AND gone = 'struck'").all(c.id) as { verifier: string; gone_by: string; gone_at: number }[]).map((s) => ({ verifier: s.verifier, name: this.short(s.verifier).name, by: s.gone_by === c.customer ? "customer" as const : "agent" as const, at: iso(s.gone_at) })),
      ...(c.decided_at ? { decided: { how: c.decided_how ?? "first-check", verdict: c.verdict as "accept" | "reject" | null, votesAccept: c.votes_accept, votesReject: c.votes_reject, at: iso(c.decided_at) } } : {}),
      ...(money.some((m) => m.kind === "paid") ? { paid: sumBy(money.filter((m) => m.kind === "paid")) } : {}),
      ...(money.some((m) => m.kind === "slashed") ? { slashed: sumBy(money.filter((m) => m.kind === "slashed")) } : {}),
      ...(c.ended_at ? { ended: { state: c.state, how: c.how, at: iso(c.ended_at), tx: c.ended_tx ?? "", toCustomerEth: ethNum(c.to_customer ?? "0") } } : {}),
      next: nx.next === "work" ? null : nx.next, nextAt: nx.at ? iso(nx.at) : null,
    };
    if (forWho) out.forYou = await this.forYou(c, job, forWho, t);
    return out;
  }

  /** What Factor's own records tie a verifier to either side by: the checks a review is held to. */
  private async tiesOf(c: CaseRow, verifier: string): Promise<string[]> {
    const out: string[] = [];
    for (const [side, who] of [["the agent", c.agent], ["the customer", c.customer]] as const) {
      const why = await this.d.ties(who, verifier).catch(() => null);
      if (why) out.push(`${side}: ${why}`);
    }
    if (this.houseSet().has(verifier) && (this.d.factorOwn(c.agent) || this.d.factorOwn(c.customer))) out.push("Factor's own verifier, on a job where Factor is a side");
    return out;
  }

  /** Whether a wallet may check or sit on a case now, by the contract's own rules, as far as the engine's copy of the chain says. */
  async forYou(c: CaseRow, job: DeskJob | null, who: string, t: number): Promise<{ can: boolean; why?: string }> {
    const no_ = (why: string) => ({ can: false, why });
    const r = this.verifierRow(who);
    if (!r) return no_("this wallet has not joined as a verifier");
    const rec = this.record(who);
    if (!(rec?.since ?? r.since)) return no_("its bond is under 0.01 ETH, so it has no standing");
    if (who === c.customer || who === c.agent) return no_("it is a side of this case");
    const line = this.d.db.q("SELECT 1 FROM lines WHERE (key = ? AND account IN (?, ?)) LIMIT 1").get(who, c.customer, c.agent);
    if (line) return no_("it runs the line account on one side of this case");
    if (rec && BigInt(rec.free) < BigInt(c.stake)) return no_(`its free bond is under this case's stake of ${ethText(c.stake)} ETH`);
    const nx = this.next(c, job, t);
    if (c.state === "working") return nx.next === "check" ? { can: true } : no_(job?.delivered_at ? "the time for the first check is over" : "the work is not delivered yet");
    if (c.state !== "disputed" || nx.next !== "seats") return no_(c.state === "disputed" ? "seating has closed" : "the case has no panel to sit on now");
    if (who === c.checker) return no_("it gave the first verdict on this case");
    const all = this.seats(c.id);
    if (all.some((s) => s.verifier === who && s.gone === "struck")) return no_("a side struck it from this case");
    const seated = all.filter((s) => s.gone === null);
    if (seated.some((s) => s.verifier === who)) return no_("it holds a seat on this panel already");
    const since = rec?.since ?? r.since;
    const maker = rec?.maker ?? r.maker;
    const same = seated.find((s) => s.maker === maker);
    if (same) return since < same.since ? { can: true } : no_(`the ${makerName(maker)} seat is held by an older standing`);
    if (seated.length < VERIFIER_RULES.panel) return { can: true };
    const newest = seated.reduce((a, b) => (b.since > a.since ? b : a));
    return since < newest.since ? { can: true } : no_("the panel is full of older standings");
  }

  async json(id: number, forWho?: string | null): Promise<CaseJson | null> {
    const c = this.row(id);
    return c ? this.caseJson(c, forWho) : null;
  }

  /** Cases: needing a first check, with seats open, in their reveal time, open, or all; newest first. */
  async cases(show: string, forWho?: string | null, limit = 50): Promise<CaseJson[]> {
    const t = this.d.nowS();
    const db = this.d.db;
    let rows: CaseRow[];
    if (show === "all") rows = db.q("SELECT * FROM verifier_cases ORDER BY id DESC LIMIT ?").all(limit) as CaseRow[];
    else rows = (db.q("SELECT * FROM verifier_cases WHERE state IN ('working', 'checked', 'disputed', 'customer') ORDER BY id DESC LIMIT 500").all() as CaseRow[]).filter((c) => {
      if (show === "open") return true;
      const nx = this.next(c, this.deskJob(c.job), t).next;
      return show === "check" ? nx === "check" : show === "seats" ? nx === "seats" : show === "reveal" ? nx === "reveals" : false;
    }).slice(0, limit);
    return Promise.all(rows.map((c) => this.caseJson(c, forWho)));
  }

  /** A verifier and its cases: first checks and panel seats, newest first. */
  async verifierPage(address: string): Promise<{ verifier: VerifierJson | null; cases: CaseJson[] }> {
    const ids = this.d.db.q("SELECT id FROM verifier_cases WHERE checker = ? UNION SELECT case_id AS id FROM verifier_seats WHERE verifier = ? ORDER BY id DESC LIMIT 20").all(address, address) as { id: number }[];
    const cases = (await Promise.all(ids.map((r) => this.json(r.id)))).filter((x): x is CaseJson => !!x);
    return { verifier: this.verifierJson(address), cases };
  }

  /** How an agent's jobs with a verifier went, or null when it had none. */
  agentJson(address: string): AgentVerifiedJson | null {
    if (!this.on()) return null;
    const q = (sql: string) => (this.d.db.q(sql).get(address) as { n: number }).n;
    const jobs = q("SELECT COUNT(*) AS n FROM verifier_cases WHERE agent = ?");
    if (!jobs) return null;
    return {
      jobs, accepted: q("SELECT COUNT(*) AS n FROM verifier_cases WHERE agent = ? AND state = 'accepted'"), rejected: q("SELECT COUNT(*) AS n FROM verifier_cases WHERE agent = ? AND state = 'rejected'"),
      disputed: q("SELECT COUNT(*) AS n FROM verifier_cases WHERE agent = ? AND disputer IS NOT NULL"),
      disputesWon: q("SELECT COUNT(*) AS n FROM verifier_cases WHERE agent = ? AND disputer = agent AND verdict = 'accept' AND decided_how = 'panel'"),
      disputesLost: q("SELECT COUNT(*) AS n FROM verifier_cases WHERE agent = ? AND disputer = agent AND verdict = 'reject' AND decided_how = 'panel'"),
    };
  }

  /** For the owner's health answer. */
  health(): Record<string, unknown> {
    const count = (state: string) => (this.d.db.q("SELECT COUNT(*) AS n FROM verifier_cases WHERE state = ?").get(state) as { n: number }).n;
    return {
      reading: this.reading(), on: this.on(), contract: this.d.cfg.contract, working: count("working"), checked: count("checked"), disputed: count("disputed"), customer: count("customer"),
      totals: this.totals(), note: this.d.cfg.note,
      house: { enabled: this.d.cfg.house.enabled, spentTodayUsd: this.spentToday() / 1e6, capUsd: this.d.cfg.house.dailyMicro / 1e6, verifiers: this.house.map((h) => ({ maker: makerName(h.maker), model: h.model, address: h.address, ready: h.ready })) },
    };
  }

  // ---------- Factor's own verifiers ----------

  private today(): string {
    return new Date(this.d.now()).toISOString().slice(0, 10);
  }

  spentToday(): number {
    return (this.d.db.q("SELECT micro FROM verifier_spend WHERE day = ?").get(this.today()) as { micro: number } | undefined)?.micro ?? 0;
  }

  private spend(micro: number): void {
    this.d.db.q("INSERT INTO verifier_spend (day, micro) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET micro = micro + excluded.micro").run(this.today(), micro);
  }

  private houseRow(id: number, who: string): HouseRow | null {
    return (this.d.db.q("SELECT * FROM verifier_house WHERE case_id = ? AND verifier = ?").get(id, who) as HouseRow | undefined) ?? null;
  }

  private saveHouse(id: number, who: string, role: string, patch: Partial<Omit<HouseRow, "case_id" | "verifier" | "role">>): void {
    const now = this.d.now();
    this.d.db.q("INSERT OR IGNORE INTO verifier_house (case_id, verifier, role, state, updated_at) VALUES (?, ?, ?, 'checking', ?)").run(id, who, role, now);
    const keys = Object.keys(patch);
    if (keys.length) this.d.db.q(`UPDATE verifier_house SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE case_id = ? AND verifier = ?`).run(...Object.values(patch), now, id, who);
  }

  private call(fn: string, args: unknown[], value = 0n): Call {
    return { to: this.d.cfg.contract!, value, data: encodeFunctionData({ abi: VT, functionName: fn, args } as never) };
  }

  /** A verifier of Factor's own is a Factor account on the chain, has joined, and goes on with its bond. Each step once. */
  private async houseReady(h: HouseVerifier): Promise<boolean> {
    const accounts = this.d.house?.accounts();
    if (!accounts) return false;
    if (!h.address) h.address = await accounts.addressOfKey(h.key);
    const row = accounts.store.get(h.address);
    if (!row) {
      accounts.makeOwn(h.address, h.key);
      this.d.log(`[verifiers] Factor's ${makerName(h.maker)} verifier: its account ${h.address} is being made`);
      return false;
    }
    if (!row.deployed || accounts.store.open(h.address)) return false;
    const balance = await this.d.chain.balance(h.address);
    if (!this.verifierRow(h.address)) {
      if (balance < VERIFIER_RULES.minBondWei) {
        if (this.d.now() - h.noted > 3_600_000) {
          h.noted = this.d.now();
          this.d.log(`[verifiers] Factor's ${makerName(h.maker)} verifier waits for its bond: send 0.01 ETH or more to ${h.address}`);
        }
        return false;
      }
      await accounts.orderAs(h.address, [this.call("join", [h.maker], balance)], (typed) => h.signer.signTypedData(typed as never));
      this.d.log(`[verifiers] Factor's ${makerName(h.maker)} verifier joins with ${ethText(String(balance))} ETH`);
      return false;
    }
    // more ETH sent to the account later goes on its bond
    if (balance > 0n) {
      await accounts.orderAs(h.address, [this.call("addBond", [], balance)], (typed) => h.signer.signTypedData(typed as never));
      return false;
    }
    if (!h.ready) this.d.log(`[verifiers] Factor's ${makerName(h.maker)} verifier is ready, as ${h.address}, on ${h.model}`);
    h.ready = true;
    return true;
  }

  /** A check by one of Factor's own: the tests the work allows, then its own model. Null when it cannot be made now. */
  private async houseCheck(h: HouseVerifier, c: CaseRow): Promise<{ accept: boolean; reason: string; costMicro: number } | null> {
    const ask = this.d.house?.ask;
    const words = this.terms(c.id);
    const work = this.d.work(c.job);
    if (!ask || !words || !work) return null;
    if (this.spentToday() >= this.d.cfg.house.dailyMicro) return null;
    const symbols = ["ETH", ...FEEDS.map((f) => f.symbol)];
    const tests = await runTests(words.brief, work.body, this.d.house?.priceOf ?? null, symbols);
    const p = checkPrompt(words.title, words.brief, work.body, tests);
    const answer = await ask(h.model, p.system, p.user);
    this.spend(answer.costMicro);
    const read = readAnswer(answer.text) ?? { accept: false, reasons: "The model gave no verdict that could be read, so the work is not accepted on its word." };
    const accept = verdictOf(tests, read);
    return { accept, reason: reasonText(accept, tests, read.reasons, `${makerName(h.maker)}, ${h.model}`), costMicro: answer.costMicro };
  }

  /** Whether one of Factor's own may take this case at all: never where Factor is a side, or where its records tie it to one. */
  private async houseMay(h: HouseVerifier, c: CaseRow): Promise<boolean> {
    if (this.d.factorOwn(c.agent) || this.d.factorOwn(c.customer)) return false;
    return (await this.tiesOf(c, h.address!)).length === 0;
  }

  /**
   * One pass of Factor's own verifiers: the first check of a delivered case, a sealed seat on a disputed one, and a reveal
   * once seating has closed. One model call a pass at most, and none past the day's cap.
   */
  async housePass(): Promise<void> {
    if (!this.d.cfg.house.enabled || !this.on() || !this.d.house?.live() || this.busy || stopped(this.d.db, "keeper")) return;
    this.busy = true;
    try {
      const ready: HouseVerifier[] = [];
      for (const h of this.house) if (await this.houseReady(h).catch((e) => { this.d.log(`[verifiers] Factor's ${makerName(h.maker)} verifier: ${reasonOf(e)}`); return false; })) ready.push(h);
      if (!ready.length) return;
      const t = this.d.nowS();
      const accounts = this.d.house!.accounts()!;
      const order = (h: HouseVerifier, calls: Call[]) => accounts.orderAs(h.address!, calls, (typed) => h.signer.signTypedData(typed as never));
      let asked = false;
      const live = this.d.db.q("SELECT * FROM verifier_cases WHERE state IN ('working', 'disputed') ORDER BY id").all() as CaseRow[];
      for (const c of live) {
        const job = this.deskJob(c.job);
        const nx = this.next(c, job, t);
        // reveals first: a sealed seat never revealed loses its whole stake
        if (c.state === "disputed" && nx.next === "reveals") {
          for (const h of ready) {
            const row = this.houseRow(c.id, h.address!);
            const seat = this.seated(c.id).find((s) => s.verifier === h.address);
            if (!row || row.role !== "seat" || !seat || seat.vote !== null || row.state === "revealing" || row.accept === null || !row.reason || !row.salt) continue;
            const relay = await order(h, [this.call("reveal", [BigInt(c.id), row.accept === 1, hashText(row.reason), row.salt])]).catch((e) => { this.d.log(`[verifiers] case ${c.id}: the reveal was refused (${reasonOf(e)})`); return null; });
            if (relay) this.saveHouse(c.id, h.address!, "seat", { state: "revealing", relay });
          }
          continue;
        }
        if (asked) continue;
        if (c.state === "working" && nx.next === "check" && t < (nx.at ?? 0) - 900) {
          if (this.d.db.q("SELECT 1 FROM verifier_house WHERE case_id = ? AND role = 'check'").get(c.id)) continue;
          // the maker that checks turns with the case's number, among those that may take it and have the stake free
          const can: HouseVerifier[] = [];
          for (const h of ready) if ((await this.houseMay(h, c)) && BigInt(this.record(h.address!)?.free ?? "0") >= BigInt(c.stake)) can.push(h);
          if (!can.length) continue;
          const h = can[c.id % can.length]!;
          const done = await this.houseCheck(h, c).catch((e) => { this.d.log(`[verifiers] case ${c.id}: the check failed (${reasonOf(e)})`); return null; });
          if (!done) continue;
          asked = true;
          this.saveHouse(c.id, h.address!, "check", { accept: done.accept ? 1 : 0, reason: done.reason, cost_micro: done.costMicro });
          const relay = await order(h, [this.call("check", [BigInt(c.id), done.accept, hashText(done.reason)])]).catch((e) => { this.d.log(`[verifiers] case ${c.id}: the check was refused (${reasonOf(e)})`); return null; });
          this.saveHouse(c.id, h.address!, "check", relay ? { state: "sending", relay } : { state: "gave_up" });
          if (relay) this.d.log(`[verifiers] case ${c.id}: Factor's ${makerName(h.maker)} verifier checked it: ${done.accept ? "accept" : "reject"}`);
          continue;
        }
        if (c.state === "disputed" && nx.next === "seats" && t < (nx.at ?? 0) - 1200) {
          for (const h of ready) {
            if (asked) break;
            if (this.houseRow(c.id, h.address!)) continue;
            if (!(await this.houseMay(h, c))) continue;
            if (!(await this.forYou(c, job, h.address!, t)).can) continue;
            const done = await this.houseCheck(h, c).catch((e) => { this.d.log(`[verifiers] case ${c.id}: the check failed (${reasonOf(e)})`); return null; });
            if (!done) continue;
            asked = true;
            const salt = h.signer.salt(c.id);
            const commit = keccak256(encodeCommit(c.id, h.address!, done.accept, hashText(done.reason), salt));
            this.saveHouse(c.id, h.address!, "seat", { accept: done.accept ? 1 : 0, reason: done.reason, salt, cost_micro: done.costMicro });
            const relay = await order(h, [this.call("sit", [BigInt(c.id), commit])]).catch((e) => { this.d.log(`[verifiers] case ${c.id}: the seat was refused (${reasonOf(e)})`); return null; });
            this.saveHouse(c.id, h.address!, "seat", relay ? { state: "sealed", relay } : { state: "gave_up" });
            if (relay) this.d.log(`[verifiers] case ${c.id}: Factor's ${makerName(h.maker)} verifier took a seat, its verdict sealed`);
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

/** A verifier of Factor's own: its key made from the house seed and its maker, through a hash that cannot be run backwards. The salt of a seal from the same key and the case. */
export function houseVerifierSigner(seed: Hex, maker: number): HouseVerifierSigner {
  const key = keccak256(concat([seed, toHex(`factor house verifier ${maker}`)]));
  const account = privateKeyToAccount(key);
  return { address: account.address.toLowerCase(), signTypedData: (typed) => account.signTypedData(typed as never), salt: (caseId) => keccak256(concat([key, toHex(`seal ${caseId}`)])) };
}

/** abi.encode(uint256 id, address who, bool accept, bytes32 reason, bytes32 salt): what commitOf hashes. */
export function encodeCommit(id: number, who: string, accept: boolean, reason: Hex, salt: Hex): Hex {
  const word = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
  return `0x${word(BigInt(id).toString(16))}${word(who.toLowerCase())}${word(accept ? "1" : "0")}${word(reason)}${word(salt)}` as Hex;
}

type Answer = { status: number; body: Record<string, unknown> };
const no = (status: number, error: string): Answer => ({ status, body: { error } });
const idOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : null);
const reasonOf = (e: unknown): string => (e instanceof Error ? e.message.split("\n")[0]! : String(e));
const DESK_STATES: Record<number, string> = { 1: "locked", 2: "advanced", 3: "delivered", 4: "settled", 5: "half", 6: "declined", 7: "refunded" };
const sumBy = (rows: { verifier: string; amount: string }[]): { verifier: string; eth: number; wei: string }[] => {
  const m = new Map<string, bigint>();
  for (const r of rows) m.set(r.verifier, (m.get(r.verifier) ?? 0n) + BigInt(r.amount));
  return [...m].map(([verifier, wei]) => ({ verifier, eth: ethNum(wei.toString()), wei: wei.toString() }));
};

/** A Chainlink feed on the chain, read: the price in dollars, or null when there is no feed for the symbol. */
export function chainPriceOf(chain: Chain): PriceOf {
  const ETH_USD = "0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9";
  return async (symbol) => {
    const address = symbol === "ETH" ? ETH_USD : FEEDS.find((f) => f.symbol === symbol)?.address;
    if (!address) return null;
    const x = await chain.read<readonly [bigint, bigint, bigint, bigint, bigint]>({ to: address, abi: FEED_ABI as unknown as Abi, functionName: "latestRoundData" });
    const answer = Array.isArray(x) ? x[1] : (x as unknown as { answer: bigint }).answer;
    return Number(answer) / 1e8;
  };
}

// ---- the site's shape: web/src/lib/types.ts keeps the same by hand ----

export interface VerifierShort { address: string; name: string | null; maker: number; makerName: string; house: boolean }
export interface VerifierJson extends VerifierShort {
  standing: boolean; since: string | null; joinedAt: string;
  freeEth: number; freeWei: string; lockedEth: number; lockedWei: string; open: number;
  checks: number; panels: number; right: number; wrong: number; hidden: number; struck: number; earnedEth: number; lostEth: number; rightPct: number | null;
}
export interface VerifiersAbout {
  enabled: boolean; contract: string | null; chainId: number;
  rules: { minFeeEth: number; minBondEth: number; stakePct: number; minStakeEth: number; wrongLossPct: number; disputePct: number; minDisputeEth: number; panel: number; checkH: number; disputeH: number; seatH: number; revealH: number; reviewH: number; reasonChars: number; titleChars: number; briefChars: number };
  makers: { id: number; name: string; models: string }[];
  totals: { cases: number; open: number; disputed: number; panels: number; verifiers: number; bondedEth: number; feesPaidEth: number; slashedEth: number } | null;
  house: { address: string | null; maker: number; makerName: string; model: string; joined: boolean }[];
}
export interface CaseJson {
  id: number; job: { n: number; id: string; state: string }; customer: string; agent: { address: string; name: string };
  priceEth: number; priceWei: string; feeEth: number; feeWei: string; stakeEth: number; stakeWei: string; disputeBondEth: number; disputeBondWei: string;
  termsHash: string; title: string | null; brief: string | null; work: { kind: "text" | "html"; text: string; at: string } | null;
  state: CaseState; how: How | null; hiredAt: string; tx: string;
  deliveredAt?: string;
  deadlines?: { checkBy: string; disputeBy: string | null; seatBy: string; revealBy: string; reviewBy: string };
  first?: { verifier: VerifierShort; accept: boolean; at: string; reasonHash: string; reason: string | null; tx: string; ties: string[] };
  dispute?: { by: "customer" | "agent"; address: string; at: string; bondEth: number; tx: string };
  seats: { seat: number; verifier: VerifierShort; maker: number; makerName: string; since: string | null; vote: "accept" | "reject" | null; reasonHash: string | null; reason: string | null; ties: string[] }[];
  struck: { verifier: string; name: string | null; by: "customer" | "agent"; at: string }[];
  decided?: { how: How; verdict: "accept" | "reject" | null; votesAccept: number; votesReject: number; at: string };
  paid?: { verifier: string; eth: number; wei: string }[]; slashed?: { verifier: string; eth: number; wei: string }[];
  ended?: { state: CaseState; how: How | null; at: string; tx: string; toCustomerEth: number };
  next: "check" | "dispute" | "seats" | "reveals" | "step" | "customer" | null; nextAt: string | null;
  forYou?: { can: boolean; why?: string };
}
export interface AgentVerifiedJson { jobs: number; accepted: number; rejected: number; disputed: number; disputesWon: number; disputesLost: number }

const iso = (s: number): string => new Date(s * 1000).toISOString();
const ethNum = (wei: string): number => Number(formatEther(BigInt(wei)));
const ethText = (wei: string): string => {
  const n = ethNum(wei);
  return n >= 0.01 ? n.toFixed(4) : n.toFixed(6);
};
