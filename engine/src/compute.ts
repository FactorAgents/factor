// Compute credit: the third kind of advance, made usable.
//
// When an agent draws an advance "as compute", the desk pays the ETH to the gateway's address and never to the
// agent. This is the gateway. It turns that ETH into credit, in dollars at the ETH price of the moment, and lets the
// agent spend the credit on one thing only: calls to a model, through this server. The credit cannot be withdrawn,
// sent on or cashed out. That is what makes it safe for the pool to advance it to an agent with a short record.
//
//   what the chain says        what the gateway does
//   Advanced (as compute)      a lot of credit for that agent, priced in dollars
//   Settled / SettledAtHalf    the job repaid the pool: what is left of the lot is the agent's to keep using
//   Refunded, the pool lost    the pool takes back what it lost, and no more, from what was not spent, as ETH
//   Refunded, the bond paid    the agent's own bond repaid the pool: what is left of the lot is the agent's
//   ComputePaid (a coin)       the agent's coin paid its compute share to the gateway (./coins.ts): a lot of credit
//                              that is the agent's own from the start, paid by its coin and by no job
//   Drawn (a line, as compute) a draw on a credit line paid to the gateway (./lines.ts): a lot of credit for the line's
//                              key, kept when the line is repaid in full; if the line defaults, the line pool takes
//                              back what it lost from what was not spent, and that ETH goes to the line contract
//
//   GET  /v1/compute/models             the models and what they cost here
//   GET  /v1/compute/credit/<address>   what an agent has left
//   POST /v1/compute/key                a key, for the agent's signature
//   GET  /v1/compute/balance            the same as credit, for the key's agent
//   POST /v1/compute/v1/messages        a call to Claude, in Anthropic's own shape, paid from the credit
//   GET  /v1/compute/v1/models          every model of the second door, in OpenAI's shape
//   POST /v1/compute/v1/chat/completions a call to any of them (Claude, GPT, Gemini, Grok, DeepSeek, Llama,
//                                        Mistral and the rest), in OpenAI's shape, through OpenRouter
//
// The agent proves who it is with a signature from its wallet and is handed a key. With the key it calls one of the
// two doors. /v1/messages takes the same request as Anthropic's Messages API; /v1/chat/completions the same as
// OpenAI's, the shape OpenRouter speaks for hundreds of models. Either way the agent uses a library it already has
// and only changes the address. Each call is priced at what the model cost (the tokens the model maker reports, or
// what OpenRouter says it charged for the call) plus a small margin, and taken off the credit.
//
// What it will not do: forward anything it cannot price (server-side tools, betas, other speed tiers), go over the
// credit (the worst a request could cost is held back before it is sent), or keep what was asked or answered. It
// writes down who called, which model, how many tokens and what it cost. Nothing else.

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { recoverMessageAddress, type Hex } from "viem";
import { normalizeAddress } from "./chain/address.js";
import type { EngineDb, EventRow } from "./chain/db.js";
import { stopped } from "./switches.js";

/** Dollars per million tokens, as the model maker lists them. */
export interface Price { in: number; out: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }

// Anthropic's list prices, read from its pricing page on 2026-10-13. COMPUTE_MODELS replaces the whole table.
export const DEFAULT_MODELS: Record<string, Price> = {
  "claude-haiku-4-5-20251001": { in: 1, out: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
  "claude-opus-5-5": { in: 4, out: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  "claude-fable-5-1": { in: 10, out: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
};

export interface ComputeConfig {
  /** COMPUTE_MODE=on and a model key is set. Off: credit is still written down as it is drawn, and nothing is served. */
  enabled: boolean;
  /** COMPUTE_DIRECT=on: the first door, Claude on the owner's own Anthropic key, is open. */
  direct: boolean;
  upstream: string; // COMPUTE_UPSTREAM_URL
  models: Record<string, Price>;
  markupBps: number; // COMPUTE_MARKUP_BPS: on top of the list price, for turning ETH into dollars
  maxTokens: number; // COMPUTE_MAX_TOKENS: the most output one request may ask for
  maxBodyBytes: number;
  keyTtlS: number;
  inFlight: number; // requests one agent may have under way at once
  inFlightAll: number; // COMPUTE_IN_FLIGHT_ALL: and all agents together
  dailyMicro: number; // COMPUTE_DAILY_USD: the most the gateway spends with the model maker in a day (UTC), as millionths
  callMicro: number; // COMPUTE_CALL_USD: the most one call may cost at its worst, so no single call empties a lot
  agentDayMicro: number; // COMPUTE_AGENT_DAILY_USD: the most one agent may spend in a day (UTC), whatever its credit
  /**
   * The second door: OpenRouter, on with OPENROUTER_API_KEY. Its models and prices are read from its own list; a
   * model dearer than the caps is left out (COMPUTE_MAX_IN_USD, COMPUTE_MAX_OUT_USD, per million tokens). Factor's
   * own balance there is looked at every few minutes (COMPUTE_FLOAT_CHECK_S), and below COMPUTE_FLOAT_FLOOR_USD no
   * call is sent: the owner tops it up.
   */
  router: { enabled: boolean; url: string; refreshMs: number; maxInPerM: number; maxOutPerM: number; floorMicro: number; floatCheckMs: number };
  /** why it is off, when the owner meant it to be on */
  note: string | null;
}

type Env = Record<string, string | undefined>;

export function readCompute(env: Env, problems: string[] = []): ComputeConfig {
  const on = (env.COMPUTE_MODE ?? "").trim().toLowerCase() === "on";
  // Claude straight from Anthropic only when the owner says so (COMPUTE_DIRECT=on): the key may be there for other
  // things, and selling its calls on is the owner's decision. Claude is served through OpenRouter all the same.
  const direct = (env.COMPUTE_DIRECT ?? "").trim().toLowerCase() === "on";
  const hasClaudeKey = direct && !!env.ANTHROPIC_API_KEY?.trim();
  const hasRouterKey = !!env.OPENROUTER_API_KEY?.trim();
  const hasKey = hasClaudeKey || hasRouterKey;
  let models = DEFAULT_MODELS;
  const raw = env.COMPUTE_MODELS?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<Price>>;
      const table: Record<string, Price> = {};
      for (const [id, p] of Object.entries(parsed)) {
        if (!/^[a-z0-9][a-z0-9.-]{2,80}$/.test(id) || !(Number(p.in) > 0) || !(Number(p.out) > 0)) throw new Error(id);
        table[id] = { in: Number(p.in), out: Number(p.out), cacheWrite5m: Number(p.cacheWrite5m ?? Number(p.in) * 1.25), cacheWrite1h: Number(p.cacheWrite1h ?? Number(p.in) * 2), cacheRead: Number(p.cacheRead ?? Number(p.in) * 0.1) };
      }
      if (Object.keys(table).length === 0) throw new Error("empty");
      models = table;
    } catch {
      problems.push('COMPUTE_MODELS must be JSON like {"claude-sonnet-5-5":{"in":2,"out":10}}: dollars per million tokens for each model');
    }
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
  const upstream = (env.COMPUTE_UPSTREAM_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(upstream)) problems.push("COMPUTE_UPSTREAM_URL is not an http(s) address");
  const routerUrl = (env.COMPUTE_ROUTER_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(routerUrl)) problems.push("COMPUTE_ROUTER_URL is not an http(s) address");
  return {
    enabled: on && hasKey,
    direct: on && hasClaudeKey,
    upstream,
    models,
    markupBps: int("COMPUTE_MARKUP_BPS", 500, 0, 5000),
    maxTokens: int("COMPUTE_MAX_TOKENS", 16_000, 1, 200_000),
    maxBodyBytes: int("COMPUTE_MAX_BODY_BYTES", 2_000_000, 1000, 20_000_000),
    keyTtlS: 7 * 86400,
    inFlight: int("COMPUTE_IN_FLIGHT", 4, 1, 64),
    inFlightAll: int("COMPUTE_IN_FLIGHT_ALL", 32, 1, 1024),
    dailyMicro: int("COMPUTE_DAILY_USD", 5, 1, 1_000_000) * 1_000_000,
    callMicro: int("COMPUTE_CALL_USD", 1, 1, 1000) * 1_000_000,
    agentDayMicro: int("COMPUTE_AGENT_DAILY_USD", 2, 1, 100_000) * 1_000_000,
    router: {
      enabled: on && hasRouterKey, url: routerUrl, refreshMs: 6 * 3600_000,
      maxInPerM: int("COMPUTE_MAX_IN_USD", 20, 1, 10_000), maxOutPerM: int("COMPUTE_MAX_OUT_USD", 80, 1, 10_000),
      floorMicro: int("COMPUTE_FLOAT_FLOOR_USD", 2, 0, 100_000) * 1_000_000, floatCheckMs: int("COMPUTE_FLOAT_CHECK_S", 300, 0, 86_400) * 1000,
    },
    note: on && !hasKey ? "COMPUTE_MODE is on and OPENROUTER_API_KEY is not set (nor ANTHROPIC_API_KEY with COMPUTE_DIRECT=on): compute credit is written down as it is drawn, and no model is served until a key is there." : null,
  };
}

// ---------- the books ----------

export interface Lot { tx_hash: string; log_index: number; block: number; at: number; job_id: number; agent: string; wei: string; usd_micro: number | null; spent_micro: number; state: "open" | "kept" | "closed"; back_wei: string; back_tx: string | null; source?: "advance" | "coin" | "line"; line?: string | null }

/** ETH in wei as millionths of a dollar, at a Chainlink price with 8 decimals. Rounded down: credit is never overstated. */
export const usdMicro = (wei: bigint, ethUsd8: bigint): number => Number((wei * ethUsd8) / 10n ** 20n);

export interface Usage { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }

/** What a call cost, in millionths of a dollar: the list price for each kind of token, plus the margin, rounded up. */
export function costMicro(u: Usage, p: Price, markupBps: number): number {
  // a dollar per million tokens is a millionth of a dollar per token, so tokens times the price IS millionths
  const list = u.input * p.in + u.output * p.out + u.cacheWrite5m * p.cacheWrite5m + u.cacheWrite1h * p.cacheWrite1h + u.cacheRead * p.cacheRead;
  return Math.max(0, Math.ceil((list * (10_000 + markupBps)) / 10_000 - 1e-9));
}

// ---------- the second door's models ----------

/** What OpenRouter lists for a model, in dollars per million tokens; `request` and `image` in dollars each. */
export interface RouterPrice { prompt: number; completion: number; reasoning: number; cacheRead: number; cacheWrite: number; request: number; image: number }
export interface RouterModel { id: string; name: string; context: number; price: RouterPrice }

/**
 * OpenRouter's model list as this gateway uses it: only models it can price and that answer in text. Left out: the
 * free ones (they come with their own limits and terms), the router that picks a model for you (no price of its own),
 * and anything that makes pictures or sound.
 */
export function readRouterModels(body: unknown, caps: { maxInPerM: number; maxOutPerM: number } = { maxInPerM: Infinity, maxOutPerM: Infinity }): Map<string, RouterModel> {
  const out = new Map<string, RouterModel>();
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const m of data as Record<string, unknown>[]) {
    const id = m?.id;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._\-/:]{2,120}$/i.test(id) || /:(free|online)$/i.test(id) || id.startsWith("openrouter/")) continue;
    const outs = (m.architecture as { output_modalities?: unknown } | undefined)?.output_modalities;
    if (Array.isArray(outs) && outs.some((o) => o !== "text")) continue;
    const p = (m.pricing ?? {}) as Record<string, unknown>;
    // per token as text, or missing for nothing; anything else (a negative "-1" for "it depends") cannot be priced
    const per = (v: unknown, scale: number): number | null => {
      if (v === undefined || v === null || v === "") return 0;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n * scale * 1e6) / 1e6 : null;
    };
    const price = { prompt: per(p.prompt, 1e6), completion: per(p.completion, 1e6), reasoning: per(p.internal_reasoning, 1e6), cacheRead: per(p.input_cache_read, 1e6), cacheWrite: per(p.input_cache_write, 1e6), request: per(p.request, 1), image: per(p.image, 1) };
    if (Object.values(price).some((v) => v === null) || price.prompt! + price.completion! <= 0) continue;
    // dearer than the owner allows: one call could cost more than credit is meant for
    if (Math.max(price.prompt!, price.cacheWrite!) > caps.maxInPerM || Math.max(price.completion!, price.reasoning!) > caps.maxOutPerM) continue;
    out.set(id, { id, name: typeof m.name === "string" ? m.name.slice(0, 120) : id, context: Number(m.context_length) > 0 ? Math.floor(Number(m.context_length)) : 0, price: price as RouterPrice });
  }
  return out;
}

/**
 * What a call through the second door cost, in millionths of a dollar: what OpenRouter says it charged for it, or,
 * when it does not say, its list price for the tokens. Plus the margin, rounded up.
 */
export function routerCostMicro(u: Usage & { reportedUsd: number | null }, p: RouterPrice, markupBps: number): number {
  const fresh = Math.max(0, u.input - u.cacheRead);
  const list = u.reportedUsd !== null ? u.reportedUsd * 1e6 : fresh * p.prompt + u.cacheRead * (p.cacheRead || p.prompt) + u.output * Math.max(p.completion, p.reasoning) + p.request * 1e6;
  return Math.max(0, Math.ceil((list * (10_000 + markupBps)) / 10_000 - 1e-9));
}

/** OpenRouter's list, read when it is first needed and again every few hours. A list that cannot be read leaves the last one in place. */
export class RouterCatalog {
  private models = new Map<string, RouterModel>();
  private readAt = 0;
  private loading: Promise<void> | null = null;

  constructor(private url: string, private refreshMs: number, private log: (line: string) => void, private caps?: { maxInPerM: number; maxOutPerM: number }, private now: () => number = Date.now) {}

  /** The models, waiting for the list only while there is none yet. */
  async get(): Promise<Map<string, RouterModel>> {
    if (this.now() - this.readAt > this.refreshMs && !this.loading) this.loading = this.load();
    if (this.models.size === 0 && this.loading) await this.loading;
    return this.models;
  }

  size(): number { return this.models.size; }
  list(): RouterModel[] { return [...this.models.values()]; }

  private async load(): Promise<void> {
    try {
      const r = await fetch(`${this.url}/models`, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`it answered ${r.status}`);
      const models = readRouterModels(await r.json(), this.caps);
      if (models.size === 0) throw new Error("it listed no model this gateway can price");
      this.models = models;
      this.readAt = this.now();
      this.log(`[compute] OpenRouter's list read: ${models.size} models`);
    } catch (e) {
      // tried again in a minute; the last list stays meanwhile
      this.readAt = this.now() - this.refreshMs + 60_000;
      this.log(`[compute] OpenRouter's list could not be read: ${(e as Error).message?.split("\n")[0]}`);
    } finally {
      this.loading = null;
    }
  }
}

/**
 * Factor's own balance at OpenRouter: what pays for the calls until the owner turns the ETH of the credit into more of
 * it. Looked at every few minutes. Unknown (OpenRouter did not say) never stops a call: a known low balance does.
 */
export class RouterFloat {
  private micro: number | null = null;
  private readAt = 0;
  private loading: Promise<void> | null = null;
  private warned = false;
  private stale = false;

  constructor(private url: string, private key: string, private floorMicro: number, private checkMs: number, private log: (line: string) => void, private now: () => number = Date.now) {}

  /** Whether calls may go out: the balance is not known to be under the floor. */
  async ok(): Promise<boolean> {
    // while it is low, looked at every minute, so a top-up is seen soon
    const every = this.warned ? Math.min(this.checkMs, 60_000) : this.checkMs;
    if (this.now() - this.readAt >= every && !this.loading) this.loading = this.load();
    if (this.loading && (this.micro === null || this.stale || this.checkMs === 0)) await this.loading;
    return this.micro === null || this.micro >= this.floorMicro;
  }

  /** What is left there, in dollars, as last seen; null when not known. */
  usd(): number | null { return this.micro === null ? null : this.micro / 1e6; }

  /** OpenRouter said the account is empty: it counts as nothing left until it is read again. */
  forget(): void {
    this.micro = 0;
    this.readAt = 0;
    this.stale = true;
  }

  private async load(): Promise<void> {
    try {
      const r = await fetch(`${this.url}/key`, { headers: { authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(10_000) });
      const d = ((await r.json()) as { data?: { limit_remaining?: unknown; limit?: unknown; usage?: unknown } }).data;
      let left = typeof d?.limit_remaining === "number" ? d.limit_remaining : null;
      if (left === null) {
        // no limit set on the key: the account's own credits say it
        const c = await fetch(`${this.url}/credits`, { headers: { authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(10_000) });
        const cd = ((await c.json()) as { data?: { total_credits?: unknown; total_usage?: unknown } }).data;
        if (typeof cd?.total_credits === "number" && typeof cd?.total_usage === "number") left = cd.total_credits - cd.total_usage;
      }
      this.micro = left === null ? null : Math.floor(left * 1e6);
      const low = this.micro !== null && this.micro < this.floorMicro;
      if (low && !this.warned) this.log(`[compute] Factor's balance at OpenRouter is $${(this.micro! / 1e6).toFixed(2)}, under the floor of $${(this.floorMicro / 1e6).toFixed(2)}: no call is sent until it is topped up`);
      if (!low && this.warned) this.log("[compute] Factor's balance at OpenRouter is above the floor again");
      this.warned = low;
    } catch (e) {
      this.log(`[compute] Factor's balance at OpenRouter could not be read: ${(e as Error).message?.split("\n")[0]}`);
    } finally {
      this.readAt = this.now();
      this.loading = null;
      this.stale = false;
    }
  }
}

export class ComputeStore {
  constructor(private db: EngineDb) {}

  /** A compute advance, as the desk's log says it: a lot of credit for the agent. Written once. */
  addLot(e: EventRow, ethUsd8: string | null): void {
    const wei = BigInt(String(e.args.amount)) - BigInt(String(e.args.fee));
    const usd = ethUsd8 ? usdMicro(wei, BigInt(ethUsd8)) : null;
    this.db.q("INSERT OR IGNORE INTO compute_lots (tx_hash, log_index, block, at, job_id, agent, wei, usd_micro) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(e.tx_hash, e.log_index, e.block, e.at, Number(e.args.id), normalizeAddress(e.args.agent), wei.toString(), usd);
  }

  /**
   * The agent's coin paid its compute share to the gateway (./coins.ts): a lot of credit that is the agent's own at
   * once. No job stands behind it, so nothing can take it back. Written once.
   */
  addCoinLot(e: { tx_hash: string; log_index: number; block: number; at: number }, agent: string, wei: bigint, ethUsd8: string | null): boolean {
    const usd = ethUsd8 ? usdMicro(wei, BigInt(ethUsd8)) : null;
    return this.db.q("INSERT OR IGNORE INTO compute_lots (tx_hash, log_index, block, at, job_id, agent, wei, usd_micro, state, source) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'kept', 'coin')").run(e.tx_hash, e.log_index, e.block, e.at, agent, wei.toString(), usd).changes === 1;
  }

  /** What an agent's coin has paid into its compute credit, and how much of that its calls have spent, in millionths of a dollar. */
  coinCredit(agent: string): { lots: number; wei: string; grantedMicro: number; spentMicro: number } {
    const r = this.db.q("SELECT COUNT(*) AS n, COALESCE(SUM(usd_micro), 0) AS granted, COALESCE(SUM(spent_micro), 0) AS spent FROM compute_lots WHERE agent = ? AND source = 'coin'").get(agent) as { n: number; granted: number; spent: number };
    const wei = (this.db.q("SELECT wei FROM compute_lots WHERE agent = ? AND source = 'coin'").all(agent) as { wei: string }[]).reduce((n, l) => n + BigInt(l.wei), 0n);
    return { lots: r.n, wei: wei.toString(), grantedMicro: r.granted, spentMicro: r.spent };
  }

  /**
   * A draw on a credit line, as compute (./lines.ts): a lot of credit for the line's key, open until the line is repaid
   * in full. `wei` is what reached the gateway. Written once.
   */
  addLineLot(e: { tx_hash: string; log_index: number; block: number; at: number }, key: string, account: string, wei: bigint, ethUsd8: string | null): boolean {
    const usd = ethUsd8 ? usdMicro(wei, BigInt(ethUsd8)) : null;
    return this.db.q("INSERT OR IGNORE INTO compute_lots (tx_hash, log_index, block, at, job_id, agent, wei, usd_micro, state, source, line) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'open', 'line', ?)").run(e.tx_hash, e.log_index, e.block, e.at, key, wei.toString(), usd, account).changes === 1;
  }

  /** The line was repaid in full: what is left of its credit is the agent's own. */
  keepLine(account: string): void {
    this.db.q("UPDATE compute_lots SET state = 'kept' WHERE line = ? AND state = 'open'").run(account);
  }

  /** The line defaulted: the line pool takes back what it lost, and no more, from the line's credit not spent. */
  closeLine(account: string, lost: bigint): void {
    const lots = this.db.q("SELECT * FROM compute_lots WHERE line = ? AND state = 'open' ORDER BY block, log_index").all(account) as Lot[];
    this.closeLots(lots, lost);
  }

  /** What a line's draws as compute became, and what its calls spent of it, in dollars. */
  lineCredit(account: string): { grantedUsd: number; spentUsd: number } {
    const r = this.db.q("SELECT COALESCE(SUM(usd_micro), 0) AS granted, COALESCE(SUM(spent_micro), 0) AS spent FROM compute_lots WHERE line = ?").get(account) as { granted: number; spent: number };
    return { grantedUsd: r.granted / 1e6, spentUsd: r.spent / 1e6 };
  }

  /** Lots drawn while no ETH price was known are priced as soon as one is. */
  priceWaiting(ethUsd8: string | null): number {
    if (!ethUsd8) return 0;
    const waiting = this.db.q("SELECT tx_hash, log_index, wei, back_wei FROM compute_lots WHERE usd_micro IS NULL AND state != 'closed'").all() as { tx_hash: string; log_index: number; wei: string; back_wei: string }[];
    // less whatever of it the pool has taken back since
    for (const l of waiting) this.db.q("UPDATE compute_lots SET usd_micro = ? WHERE tx_hash = ? AND log_index = ?").run(usdMicro(BigInt(l.wei) - BigInt(l.back_wei), BigInt(ethUsd8)), l.tx_hash, l.log_index);
    return waiting.length;
  }

  /** The job settled: it repaid the pool, so what is left of its credit is the agent's own. */
  keep(jobId: number): void {
    this.db.q("UPDATE compute_lots SET state = 'kept' WHERE job_id = ? AND state = 'open' AND source != 'line'").run(jobId);
  }

  /**
   * The job was refunded and the pool lost on it. The pool takes back what it lost and no more, out of the ETH of
   * the job's credit that was not spent: that much of the credit is gone, and the ETH is marked to go back.
   */
  close(jobId: number, lost: bigint): void {
    const lots = this.db.q("SELECT * FROM compute_lots WHERE job_id = ? AND state = 'open' AND source != 'line' ORDER BY block, log_index").all(jobId) as Lot[];
    this.closeLots(lots, lost);
  }

  private closeLots(lots: Lot[], lost: bigint): void {
    let left = lost;
    for (const l of lots) {
      const wei = BigInt(l.wei);
      const priced = l.usd_micro !== null && l.usd_micro > 0;
      const unspent = priced ? (wei * BigInt(Math.max(0, l.usd_micro! - l.spent_micro))) / BigInt(l.usd_micro!) : l.spent_micro === 0 ? wei : 0n;
      const take = unspent < left ? unspent : left;
      left -= take;
      const all = take === unspent;
      // the credit that goes with the ETH taken back, rounded up: credit is never overstated
      const gone = !priced || take === 0n ? 0 : all ? l.usd_micro! - l.spent_micro : Math.min(l.usd_micro! - l.spent_micro, Number((BigInt(l.usd_micro! - l.spent_micro) * take + unspent - 1n) / unspent));
      this.db.q("UPDATE compute_lots SET state = ?, usd_micro = ?, back_wei = ? WHERE tx_hash = ? AND log_index = ?").run(all && take > 0n ? "closed" : "kept", priced ? l.usd_micro! - gone : l.usd_micro, take.toString(), l.tx_hash, l.log_index);
    }
  }

  lots(agent: string): Lot[] {
    return this.db.q("SELECT * FROM compute_lots WHERE agent = ? ORDER BY block, log_index").all(agent) as Lot[];
  }

  /** What an agent has left to spend, in millionths of a dollar. */
  balance(agent: string): number {
    return (this.db.q("SELECT COALESCE(SUM(usd_micro - spent_micro), 0) AS n FROM compute_lots WHERE agent = ? AND usd_micro IS NOT NULL AND state != 'closed'").get(agent) as { n: number }).n;
  }

  /** Take a cost off an agent's credit, oldest lot first. Returns what could not be covered (credit ran out). */
  charge(agent: string, micro: number): number {
    return this.db.tx(() => {
      let left = micro;
      const lots = this.db.q("SELECT tx_hash, log_index, usd_micro, spent_micro FROM compute_lots WHERE agent = ? AND usd_micro IS NOT NULL AND state != 'closed' AND usd_micro > spent_micro ORDER BY block, log_index").all(agent) as { tx_hash: string; log_index: number; usd_micro: number; spent_micro: number }[];
      for (const l of lots) {
        if (left <= 0) break;
        const take = Math.min(left, l.usd_micro - l.spent_micro);
        this.db.q("UPDATE compute_lots SET spent_micro = spent_micro + ? WHERE tx_hash = ? AND log_index = ?").run(take, l.tx_hash, l.log_index);
        left -= take;
      }
      return left;
    });
  }

  record(u: { agent: string; model: string; usage: Usage; cost: number; unpaid: number; status: number; requestId: string; ms: number }): void {
    this.db.q("INSERT INTO compute_usage (at, agent, model, input, output, cache_write, cache_read, cost_micro, unpaid_micro, status, request_id, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      this.db.now(), u.agent, u.model, u.usage.input, u.usage.output, u.usage.cacheWrite5m + u.usage.cacheWrite1h, u.usage.cacheRead, u.cost, u.unpaid, u.status, u.requestId, u.ms,
    );
  }

  /** ETH the gateway holds that the desk's pool took back from lots, and has not been sent to the desk yet. */
  owedToPool(): { wei: bigint; lots: { tx_hash: string; log_index: number }[] } {
    const lots = this.db.q("SELECT tx_hash, log_index, back_wei FROM compute_lots WHERE back_tx IS NULL AND back_wei != '0' AND source != 'line'").all() as { tx_hash: string; log_index: number; back_wei: string }[];
    return { wei: lots.reduce((n, l) => n + BigInt(l.back_wei), 0n), lots };
  }

  /** The same for the line pool: what defaulted lines took back from their compute credit, not yet sent to the line contract. */
  owedToLine(): { wei: bigint; lots: { tx_hash: string; log_index: number }[] } {
    const lots = this.db.q("SELECT tx_hash, log_index, back_wei FROM compute_lots WHERE back_tx IS NULL AND back_wei != '0' AND source = 'line'").all() as { tx_hash: string; log_index: number; back_wei: string }[];
    return { wei: lots.reduce((n, l) => n + BigInt(l.back_wei), 0n), lots };
  }

  /**
   * ETH the gateway must still be able to give back: the unspent part of credit whose job is not closed yet. If
   * that job is refunded at a loss, this is what goes back to the pool.
   */
  backingWei(): bigint {
    const open = this.db.q("SELECT wei, usd_micro, spent_micro FROM compute_lots WHERE state = 'open'").all() as { wei: string; usd_micro: number | null; spent_micro: number }[];
    return open.reduce((n, l) => n + (l.usd_micro && l.usd_micro > 0 ? (BigInt(l.wei) * BigInt(Math.max(0, l.usd_micro - l.spent_micro))) / BigInt(l.usd_micro) : BigInt(l.wei)), 0n);
  }

  sentBack(lots: { tx_hash: string; log_index: number }[], tx: string): void {
    this.db.tx(() => { for (const l of lots) this.db.q("UPDATE compute_lots SET back_tx = ? WHERE tx_hash = ? AND log_index = ?").run(tx, l.tx_hash, l.log_index); });
  }

  /** What one agent's calls since midnight UTC cost together, in millionths of a dollar. */
  agentSpentToday(agent: string): number {
    const now = this.db.now();
    return (this.db.q("SELECT COALESCE(SUM(cost_micro), 0) AS n FROM compute_usage WHERE agent = ? AND at >= ?").get(agent, now - (now % 86_400_000)) as { n: number }).n;
  }

  /** What every call since midnight UTC cost together, in millionths of a dollar. */
  spentToday(): number {
    const now = this.db.now();
    return (this.db.q("SELECT COALESCE(SUM(cost_micro), 0) AS n FROM compute_usage WHERE at >= ?").get(now - (now % 86_400_000)) as { n: number }).n;
  }

  totals(): { lots: number; grantedMicro: number; spentMicro: number; outstandingMicro: number; calls: number; unpaidMicro: number; owedToPoolWei: string } {
    const l = this.db.q("SELECT COUNT(*) AS lots, COALESCE(SUM(usd_micro), 0) AS granted, COALESCE(SUM(spent_micro), 0) AS spent, COALESCE(SUM(CASE WHEN state != 'closed' AND usd_micro IS NOT NULL THEN usd_micro - spent_micro ELSE 0 END), 0) AS outstanding FROM compute_lots").get() as { lots: number; granted: number; spent: number; outstanding: number };
    const u = this.db.q("SELECT COUNT(*) AS calls, COALESCE(SUM(unpaid_micro), 0) AS unpaid FROM compute_usage").get() as { calls: number; unpaid: number };
    return { lots: l.lots, grantedMicro: l.granted, spentMicro: l.spent, outstandingMicro: l.outstanding, calls: u.calls, unpaidMicro: u.unpaid, owedToPoolWei: this.owedToPool().wei.toString() };
  }

  // ---- keys: only their hashes are kept ----

  addKey(agent: string, ttlS: number): { key: string; expiresAt: number } {
    const key = `fck_${randomBytes(24).toString("base64url")}`;
    const now = Math.floor(this.db.now() / 1000);
    this.db.q("INSERT INTO compute_keys (hash, agent, created_at, expires_at) VALUES (?, ?, ?, ?)").run(hashOf(key), agent, now, now + ttlS);
    // an agent keeps its newest few keys: the older ones stop working
    this.db.q("DELETE FROM compute_keys WHERE agent = ? AND hash NOT IN (SELECT hash FROM compute_keys WHERE agent = ? ORDER BY created_at DESC, rowid DESC LIMIT 5)").run(agent, agent);
    this.db.q("DELETE FROM compute_keys WHERE expires_at < ?").run(now);
    return { key, expiresAt: now + ttlS };
  }

  agentOf(key: string): string | null {
    const row = this.db.q("SELECT agent, expires_at FROM compute_keys WHERE hash = ?").get(hashOf(key)) as { agent: string; expires_at: number } | undefined;
    return row && row.expires_at >= Math.floor(this.db.now() / 1000) ? row.agent : null;
  }
}

const hashOf = (key: string): string => createHash("sha256").update(key).digest("hex");

/** What the desk's logs mean for compute credit. Called for every one of them, beside ../desk.ts. */
export function applyCompute(store: ComputeStore, e: EventRow, ethUsd8: string | null): void {
  if (e.event === "Advanced" && Number(e.args.kind) === 2) store.addLot(e, ethUsd8);
  else if (e.event === "Settled" || e.event === "SettledAtHalf") store.keep(Number(e.args.id));
  // a refund the agent's bond covered in full repaid the pool as a settlement would have: the credit was paid for
  else if (e.event === "Refunded") {
    const lost = BigInt(String(e.args.lost));
    if (lost > 0n) store.close(Number(e.args.id), lost);
    else store.keep(Number(e.args.id));
  }
}

// ---------- the gateway ----------

export const keyMessage = (address: string, at: number): string => `Factor compute key\naddress: ${address}\nat: ${at}`;

// What a request may carry. Anything else is something this gateway cannot price or does not pass on.
const ALLOWED = new Set(["model", "messages", "system", "max_tokens", "temperature", "top_p", "top_k", "stop_sequences", "stream", "tools", "tool_choice", "thinking", "output_config", "metadata"]);
// The same for the second door. Left out on purpose: more than one answer (n), other models to fall back on, a choice
// of provider, plugins and web search (billed apart from tokens), pictures or sound out.
const ALLOWED_CHAT = new Set(["model", "messages", "max_tokens", "max_completion_tokens", "temperature", "top_p", "top_k", "min_p", "top_a", "stop", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "response_format", "seed", "frequency_penalty", "presence_penalty", "repetition_penalty", "logit_bias", "logprobs", "top_logprobs", "reasoning", "user", "metadata"]);
// what may be in a message: words and pictures (pictures are priced each); a file or sound is priced in ways the
// list does not say
const PARTS = new Set(["text", "image_url"]);
const usd = (micro: number): string => `$${(micro / 1e6).toFixed(micro < 10_000 ? 6 : 4)}`;

interface Fail { status: number; type: string; message: string }
const fail = (status: number, type: string, message: string): Fail => ({ status, type, message });
const NO_KEY = "That key is not one of Factor's compute keys, or it has run out. Sign for a new one.";

/** The owner's keys with the model makers: sent upstream, never anywhere else. */
export interface ModelKeys { anthropic: string | null; router: string | null }

export class Gateway {
  private reserved = new Map<string, { micro: number; calls: number }>();
  private underWay = 0; // calls of all agents together, and the worst they could cost
  private underWayMicro = 0;
  readonly catalog: RouterCatalog | null;
  readonly float: RouterFloat | null;

  constructor(
    readonly cfg: ComputeConfig,
    readonly store: ComputeStore,
    private db: EngineDb,
    private keys: ModelKeys,
    private log: (line: string) => void,
    // asks an account whether one of its keys signed a text (see ./accounts.ts); without it only wallets sign
    private accountSigned: ((address: string, message: string, signature: unknown) => Promise<boolean>) | null = null,
  ) {
    this.catalog = cfg.enabled && cfg.router.enabled && keys.router ? new RouterCatalog(cfg.router.url, cfg.router.refreshMs, log, cfg.router) : null;
    this.float = this.catalog && keys.router ? new RouterFloat(cfg.router.url, keys.router, cfg.router.floorMicro, cfg.router.floatCheckMs, log) : null;
    // read the list now, so the first call does not wait for it
    if (this.catalog) void this.catalog.get();
  }

  private up = (n: number) => Math.round(n * (10_000 + this.cfg.markupBps)) / 10_000;

  /** What anybody may know: whether it is on, the models and what they cost here. */
  about(): { enabled: boolean; markupPct: number; maxTokens: number; models: { id: string; inUsd: number; outUsd: number }[]; router: { enabled: boolean; models: number }; limits: { callUsd: number; agentDayUsd: number } } {
    const on = this.cfg.enabled && !stopped(this.db, "compute");
    return {
      enabled: on, markupPct: this.cfg.markupBps / 100, maxTokens: this.cfg.maxTokens,
      models: this.keys.anthropic ? Object.entries(this.cfg.models).map(([id, p]) => ({ id, inUsd: this.up(p.in), outUsd: this.up(p.out) })) : [],
      router: { enabled: on && !!this.catalog, models: this.catalog?.size() ?? 0 },
      limits: { callUsd: this.cfg.callMicro / 1e6, agentDayUsd: this.cfg.agentDayMicro / 1e6 },
    };
  }

  /** Every model of the second door with its price here, in the shape OpenAI's library reads. */
  private async routerModels(): Promise<Record<string, unknown>> {
    const models = this.catalog ? [...(await this.catalog.get()).values()] : [];
    return {
      object: "list",
      data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.id.split("/")[0], name: m.name, context_length: m.context, pricing: { inUsd: this.up(m.price.prompt), outUsd: this.up(m.price.completion) } })),
    };
  }

  /** Everything under /v1/compute/. Always answers. */
  async http(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(body)); };
    const refuse = (f: Fail) => json(f.status, { type: "error", error: { type: f.type, message: f.message } });
    try {
      if (path === "/v1/compute/models" && req.method === "GET") return json(200, this.about());
      if (path === "/v1/compute/v1/models" && req.method === "GET") return json(200, await this.routerModels());
      // what an agent has left is as public as the advance that paid for it
      const credit = /^\/v1\/compute\/credit\/(0x[0-9a-fA-F]{40})$/.exec(path);
      if (credit && req.method === "GET") return json(200, this.balanceOf(credit[1]!.toLowerCase()));
      if (path === "/v1/compute/key" && req.method === "POST") {
        // a key costs a signature to check, and for an account a question to the chain: a caller gets a few a minute
        if (this.tooMany(req)) return refuse(fail(429, "rate_limit_error", "Too many requests for a key. Try again in a minute."));
        const r = await this.mint(JSON.parse((await readBody(req, 4096)).toString("utf8")) as Record<string, unknown>);
        return "status" in r ? refuse(r) : json(200, r);
      }
      const agent = this.who(req);
      if (path === "/v1/compute/balance" && req.method === "GET") return agent ? json(200, this.balanceOf(agent)) : refuse(fail(401, "authentication_error", NO_KEY));
      if ((path === "/v1/compute/v1/messages" || path === "/v1/compute/v1/chat/completions") && req.method === "POST") {
        if (!agent) return refuse(fail(401, "authentication_error", NO_KEY));
        const f = path.endsWith("/messages") ? await this.messages(agent, req, res) : await this.chat(agent, req, res);
        if (f) refuse(f);
        return;
      }
      return refuse(fail(404, "not_found_error", "There is nothing at this address."));
    } catch (e) {
      const big = (e as Error).message === "too large";
      const bad = e instanceof SyntaxError;
      if (!res.headersSent) refuse(big ? fail(413, "request_too_large", `A request may be ${this.cfg.maxBodyBytes} bytes at most.`) : bad ? fail(400, "invalid_request_error", "The body is not JSON.") : fail(500, "api_error", "The gateway could not answer."));
      else res.end();
      if (!big && !bad) this.log(`[compute] failed: ${(e as Error).message?.split("\n")[0]}`);
    }
  }

  private asked = new Map<string, { n: number; from: number }>();
  private tooMany(req: IncomingMessage): boolean {
    const forwarded = req.headers["x-forwarded-for"];
    const from = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const seen = this.asked.get(from);
    if (this.asked.size > 10_000) this.asked.clear();
    if (!seen || now - seen.from > 60_000) { this.asked.set(from, { n: 1, from: now }); return false; }
    return ++seen.n > 12;
  }

  private who(req: IncomingMessage): string | null {
    const header = req.headers["x-api-key"] ?? (typeof req.headers.authorization === "string" ? req.headers.authorization.replace(/^Bearer\s+/i, "") : undefined);
    const key = Array.isArray(header) ? header[0] : header;
    return typeof key === "string" && /^fck_[A-Za-z0-9_-]{20,64}$/.test(key) ? this.store.agentOf(key) : null;
  }

  /** An agent's wallet signs for a key. The wallet must be a registered agent. */
  async mint(body: Record<string, unknown>): Promise<{ key: string; expiresAt: string; agent: string } | Fail> {
    const address = normalizeAddress(body.address);
    if (!address) return fail(400, "invalid_request_error", "address is not an address.");
    const at = body.at;
    if (typeof at !== "number" || !Number.isSafeInteger(at) || Math.abs(Math.floor(this.db.now() / 1000) - at) > 600) return fail(400, "invalid_request_error", "The signature's time is more than ten minutes from now: sign again.");
    let signer: string | null = null;
    try {
      if (typeof body.signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(body.signature)) signer = (await recoverMessageAddress({ message: keyMessage(address, at), signature: body.signature as Hex })).toLowerCase();
    } catch {
      signer = null;
    }
    if (signer !== address && !(this.accountSigned && (await this.accountSigned(address, keyMessage(address, at), body.signature)))) return fail(401, "authentication_error", "The signature is not this agent's wallet's.");
    if (!this.db.q("SELECT 1 FROM desk_agents WHERE address = ?").get(address)) return fail(404, "not_found_error", "This wallet has not registered as an agent on the desk.");
    const k = this.store.addKey(address, this.cfg.keyTtlS);
    return { key: k.key, expiresAt: new Date(k.expiresAt * 1000).toISOString(), agent: address };
  }

  balanceOf(agent: string): Record<string, unknown> {
    const held = this.reserved.get(agent)?.micro ?? 0;
    const micro = Math.max(0, this.store.balance(agent) - held);
    return {
      agent, balanceUsd: micro / 1e6, enabled: this.cfg.enabled,
      lots: this.store.lots(agent).map((l) => ({ job: l.job_id, at: new Date(l.at * 1000).toISOString(), usd: l.usd_micro === null ? null : l.usd_micro / 1e6, spentUsd: l.spent_micro / 1e6, state: l.state, ...(l.source === "coin" ? { paidBy: "coin" } : l.source === "line" ? { paidBy: "line" } : {}) })),
    };
  }

  /**
   * The worst a request could cost is held back before it is sent, so calls made at the same moment cannot spend
   * the same credit twice. Returns why not, or null when it is held.
   */
  private hold(agent: string, worst: number): Fail | null {
    const cfg = this.cfg;
    const held = this.reserved.get(agent) ?? { micro: 0, calls: 0 };
    if (worst > cfg.callMicro) return fail(400, "invalid_request_error", `This request could cost up to ${usd(worst)}, and one call may cost ${usd(cfg.callMicro)} at most here. Lower max_tokens or send less.`);
    if (held.calls >= cfg.inFlight) return fail(429, "rate_limit_error", `An agent may have ${cfg.inFlight} requests under way at once.`);
    if (this.underWay >= cfg.inFlightAll) return fail(429, "rate_limit_error", "The gateway is busy. Try again in a moment.");
    // the owner's own ceiling on a day, whatever the credit outstanding: the calls under way count at their worst
    if (this.store.spentToday() + this.underWayMicro + worst > cfg.dailyMicro) return fail(429, "rate_limit_error", "The gateway has reached what it spends in a day. The credit is kept: try again after midnight UTC.");
    // one agent's own ceiling on a day: its calls under way count at their worst
    if (this.store.agentSpentToday(agent) + held.micro + worst > cfg.agentDayMicro) return fail(429, "rate_limit_error", `An agent may spend ${usd(cfg.agentDayMicro)} a day here. The credit is kept: try again after midnight UTC.`);
    const free = this.store.balance(agent) - held.micro;
    if (free <= 0) return fail(402, "billing_error", "This agent has no compute credit. Draw an advance as compute on a job it was hired for, or let its coin's fees pay for it.");
    if (worst > free) return fail(402, "billing_error", `This request could cost up to ${usd(worst)} and the agent's compute credit is ${usd(free)}. Lower max_tokens, send less, or draw more as compute.`);
    this.reserved.set(agent, { micro: held.micro + worst, calls: held.calls + 1 });
    this.underWay++;
    this.underWayMicro += worst;
    return null;
  }

  /** What was really used is taken off the credit, what was held back is let go, and the call is written down. */
  private settle(agent: string, worst: number, call: { model: string; usage: Usage; cost: number; status: number; requestId: string; t0: number }): void {
    const unpaid = call.cost > 0 ? this.store.charge(agent, call.cost) : 0;
    this.release(agent, worst);
    this.store.record({ agent, model: call.model, usage: call.usage, cost: call.cost, unpaid, status: call.status, requestId: call.requestId, ms: Date.now() - call.t0 });
  }

  /** One call to Claude in Anthropic's shape, paid from the agent's credit. Returns why not, or null when it has answered. */
  private async messages(agent: string, req: IncomingMessage, res: ServerResponse): Promise<Fail | null> {
    const cfg = this.cfg;
    if (!cfg.enabled) return fail(503, "api_error", "Compute credit is not switched on yet. Credit that was drawn is kept and can be used when it is.");
    if (!this.keys.anthropic) return fail(503, "api_error", "This door is not open here. Use /v1/chat/completions, where Claude is there too as anthropic/<model>.");
    // the owner's switch (./switches.ts)
    if (stopped(this.db, "compute")) return fail(503, "api_error", "Compute credit is paused for now. Credit that was drawn is kept and can be used when it is back.");
    const raw = await readBody(req, cfg.maxBodyBytes);
    const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "invalid_request_error", "The body is not a JSON object.");
    for (const k of Object.keys(body)) if (!ALLOWED.has(k)) return fail(400, "invalid_request_error", `"${k}" is not something Factor's compute gateway passes on. It takes: ${[...ALLOWED].join(", ")}.`);
    const model = String(body.model ?? "");
    const price = cfg.models[model];
    if (!price) return fail(400, "invalid_request_error", `"${model}" is not a model compute credit can be spent on. The models are: ${Object.keys(cfg.models).join(", ")}.`);
    const maxTokens = body.max_tokens;
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1) return fail(400, "invalid_request_error", "max_tokens is needed, as a whole number.");
    if (maxTokens > cfg.maxTokens) return fail(400, "invalid_request_error", `max_tokens may be ${cfg.maxTokens} at most here.`);
    // Only tools the caller runs itself. A tool the model maker runs (web search, code execution) is billed apart
    // from tokens, which this gateway does not price.
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools)) return fail(400, "invalid_request_error", "tools must be a list.");
      for (const t of body.tools as { type?: unknown }[]) if (t?.type !== undefined && t.type !== "custom") return fail(400, "invalid_request_error", `Tools the model maker runs ("${String(t.type)}") cannot be paid with compute credit. Tools your agent runs itself can.`);
    }
    delete body.metadata; // nothing about the caller is passed on

    // A token is a byte at least, so the request's size bounds its input from above; input costs most when it is
    // written to the cache, which only a request that asks for caching can do.
    const most = raw.length + 1000;
    const caches = raw.includes("cache_control");
    const worst = costMicro({ input: caches ? 0 : most, output: maxTokens, cacheWrite5m: 0, cacheWrite1h: caches ? most : 0, cacheRead: 0 }, price, cfg.markupBps);
    const no = this.hold(agent, worst);
    if (no) return no;

    const t0 = Date.now();
    const usage: Usage = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
    let status = 0;
    let requestId = "";
    try {
      const upstream = await fetch(`${cfg.upstream}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.keys.anthropic, "anthropic-version": typeof req.headers["anthropic-version"] === "string" ? req.headers["anthropic-version"] : "2023-06-01" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      status = upstream.status;
      requestId = upstream.headers.get("request-id") ?? "";
      const type = upstream.headers.get("content-type") ?? "application/json";
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...(requestId ? { "request-id": requestId } : {}) });
      if (body.stream === true && status === 200 && upstream.body) await passStream(upstream.body, res, (data) => readUsage(data, usage));
      else {
        const text = await upstream.text();
        res.end(text);
        if (status === 200) readUsage(text, usage);
      }
    } catch (e) {
      if (!res.headersSent) {
        this.release(agent, worst);
        return fail(502, "api_error", "The model did not answer. Nothing was taken from the credit.");
      }
      res.end();
      this.log(`[compute] a call broke off part way: ${(e as Error).message?.split("\n")[0]}`);
    }
    this.settle(agent, worst, { model, usage, cost: costMicro(usage, price, cfg.markupBps), status, requestId, t0 });
    return null;
  }

  /** One call to any model of the second door, in OpenAI's shape, through OpenRouter. Returns why not, or null when it has answered. */
  private async chat(agent: string, req: IncomingMessage, res: ServerResponse): Promise<Fail | null> {
    const cfg = this.cfg;
    if (!cfg.enabled) return fail(503, "api_error", "Compute credit is not switched on yet. Credit that was drawn is kept and can be used when it is.");
    if (!this.catalog || !this.keys.router) return fail(503, "api_error", "This door is not open here. Use /v1/messages for Claude.");
    if (stopped(this.db, "compute")) return fail(503, "api_error", "Compute credit is paused for now. Credit that was drawn is kept and can be used when it is back.");
    const raw = await readBody(req, cfg.maxBodyBytes);
    const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "invalid_request_error", "The body is not a JSON object.");
    for (const k of Object.keys(body)) if (!ALLOWED_CHAT.has(k)) return fail(400, "invalid_request_error", `"${k}" is not something Factor's compute gateway passes on. It takes: ${[...ALLOWED_CHAT].join(", ")}.`);
    const models = await this.catalog.get();
    if (models.size === 0) return fail(503, "api_error", "The list of models could not be read just now. Nothing was taken: try again in a minute.");
    if (this.float && !(await this.float.ok())) return fail(503, "api_error", "The gateway cannot reach the models just now. Nothing was taken from the credit: try again later.");
    const model = String(body.model ?? "");
    const m = models.get(model);
    if (!m) return fail(400, "invalid_request_error", `"${model}" is not a model compute credit can be spent on. The models and their prices are at /v1/compute/v1/models; they are named like anthropic/claude-sonnet-4.5 or openai/gpt-5.`);
    // max_completion_tokens is OpenAI's newer name for max_tokens: one of the two, and no more than the gateway allows
    const asked = body.max_completion_tokens ?? body.max_tokens;
    if (typeof asked !== "number" || !Number.isInteger(asked) || asked < 1) return fail(400, "invalid_request_error", "max_tokens is needed, as a whole number.");
    if (asked > cfg.maxTokens || (typeof body.max_tokens === "number" && body.max_tokens > cfg.maxTokens)) return fail(400, "invalid_request_error", `max_tokens may be ${cfg.maxTokens} at most here.`);
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools)) return fail(400, "invalid_request_error", "tools must be a list.");
      for (const t of body.tools as { type?: unknown }[]) if (t?.type !== "function") return fail(400, "invalid_request_error", `Only tools your agent runs itself (type "function") can be paid with compute credit, not "${String(t?.type)}".`);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) return fail(400, "invalid_request_error", "messages is needed, as a list.");
    let pictures = 0;
    for (const msg of body.messages as { content?: unknown }[]) {
      if (!Array.isArray(msg?.content)) continue;
      for (const part of msg.content as { type?: unknown }[]) {
        if (!PARTS.has(String(part?.type))) return fail(400, "invalid_request_error", `A message may hold text and pictures here, not "${String(part?.type)}".`);
        if (part.type === "image_url") pictures++;
      }
    }
    delete body.metadata; // nothing about the caller is passed on
    delete body.user;
    // OpenRouter says what each call cost when asked; in a stream, in its last event
    body.usage = { include: true };
    if (body.stream === true) body.stream_options = { ...(typeof body.stream_options === "object" && body.stream_options ? body.stream_options : {}), include_usage: true };

    // the worst: every byte a token at the dearer of the input prices, every token asked for at the dearer of the
    // output prices, every picture at its price, and the fee per call
    const p = m.price;
    const worst = Math.ceil(((raw.length + 1000) * Math.max(p.prompt, p.cacheWrite) + asked * Math.max(p.completion, p.reasoning) + (p.request + pictures * p.image) * 1e6) * (10_000 + cfg.markupBps) / 10_000);
    const no = this.hold(agent, worst);
    if (no) return no;

    const t0 = Date.now();
    const usage: Usage & { reportedUsd: number | null } = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, reportedUsd: null };
    const seen = { id: "" };
    let status = 0;
    try {
      const upstream = await fetch(`${cfg.router.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.keys.router}`, "http-referer": "https://factoragents.fun", "x-title": "Factor" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      status = upstream.status;
      // Factor's own account with OpenRouter is empty: the owner's to top up, and nothing for the agent to pay for
      if (status === 402) {
        await upstream.body?.cancel();
        this.release(agent, worst);
        this.log("[compute] OpenRouter says Factor's account has run out of credit: top it up");
      this.float?.forget();
        return fail(503, "api_error", "The gateway cannot reach the models just now. Nothing was taken from the credit: try again later.");
      }
      res.writeHead(status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      if (body.stream === true && status === 200 && upstream.body) await passStream(upstream.body, res, (data) => readRouterUsage(data, usage, seen));
      else {
        const text = await upstream.text();
        res.end(text);
        if (status === 200) readRouterUsage(text, usage, seen);
      }
    } catch (e) {
      if (!res.headersSent) {
        this.release(agent, worst);
        return fail(502, "api_error", "The model did not answer. Nothing was taken from the credit.");
      }
      res.end();
      this.log(`[compute] a call broke off part way: ${(e as Error).message?.split("\n")[0]}`);
    }
    this.settle(agent, worst, { model, usage, cost: status === 200 ? routerCostMicro(usage, p, cfg.markupBps) : 0, status, requestId: seen.id, t0 });
    return null;
  }

  private release(agent: string, micro: number): void {
    this.underWay = Math.max(0, this.underWay - 1);
    this.underWayMicro = Math.max(0, this.underWayMicro - micro);
    const held = this.reserved.get(agent);
    if (!held) return;
    if (held.calls <= 1) this.reserved.delete(agent);
    else this.reserved.set(agent, { micro: Math.max(0, held.micro - micro), calls: held.calls - 1 });
  }
}

/** A stream passed on as it arrives; each event's data is handed to `read` on the way through. */
async function passStream(body: ReadableStream<Uint8Array>, res: ServerResponse, read: (data: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let tail = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    res.write(chunk);
    tail += decoder.decode(chunk, { stream: true });
    const lines = tail.split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith("data:")) read(line.slice(5));
  }
  if (tail.startsWith("data:")) read(tail.slice(5));
  res.end();
}

/** The counts and the cost out of an OpenRouter answer, or out of one event of its stream. */
function readRouterUsage(text: string, into: Usage & { reportedUsd: number | null }, seen: { id: string }): void {
  let d: { id?: unknown; usage?: Record<string, unknown> };
  try {
    d = JSON.parse(text);
  } catch {
    return; // "[DONE]", or a line that is no event
  }
  if (!seen.id && typeof d?.id === "string") seen.id = d.id.slice(0, 120);
  const u = d?.usage;
  if (!u || typeof u !== "object") return;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  into.input = Math.max(into.input, n(u.prompt_tokens));
  into.output = Math.max(into.output, n(u.completion_tokens));
  into.cacheRead = Math.max(into.cacheRead, n((u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens));
  if (typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0) into.reportedUsd = Math.max(into.reportedUsd ?? 0, u.cost);
}

/** The token counts out of an answer, or out of one event of a stream. The largest count seen is kept. */
function readUsage(text: string, into: Usage): void {
  let d: { usage?: Record<string, unknown>; message?: { usage?: Record<string, unknown> } };
  try {
    d = JSON.parse(text);
  } catch {
    return;
  }
  const u = d?.usage ?? d?.message?.usage;
  if (!u || typeof u !== "object") return;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const split = (u.cache_creation ?? {}) as Record<string, unknown>;
  const write1h = n(split.ephemeral_1h_input_tokens);
  const write5m = Math.max(n(split.ephemeral_5m_input_tokens), n(u.cache_creation_input_tokens) - write1h);
  into.input = Math.max(into.input, n(u.input_tokens));
  into.output = Math.max(into.output, n(u.output_tokens));
  into.cacheWrite5m = Math.max(into.cacheWrite5m, write5m);
  into.cacheWrite1h = Math.max(into.cacheWrite1h, write1h);
  into.cacheRead = Math.max(into.cacheRead, n(u.cache_read_input_tokens));
}

function readBody(req: IncomingMessage, most: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > most) {
        reject(new Error("too large"));
        req.resume();
      } else parts.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}
