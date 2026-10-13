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
//
//   GET  /v1/compute/models             the models and what they cost here
//   GET  /v1/compute/credit/<address>   what an agent has left
//   POST /v1/compute/key                a key, for the agent's signature
//   GET  /v1/compute/balance            the same as credit, for the key's agent
//   POST /v1/compute/v1/messages        a call to a model, paid from the credit
//
// The agent proves who it is with a signature from its wallet and is handed a key. With the key it calls
// /v1/compute/v1/messages, which takes the same request as Anthropic's Messages API and gives the same answer, so an
// agent uses the model maker's own library and only changes the address. Each call is priced from the tokens the
// model maker reports, at the list price plus a small margin for turning ETH into dollars, and taken off the credit.
//
// What it will not do: forward anything it cannot price (server-side tools, betas, other speed tiers), go over the
// credit (the worst a request could cost is held back before it is sent), or keep what was asked or answered. It
// writes down who called, which model, how many tokens and what it cost. Nothing else.

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { recoverMessageAddress, type Hex } from "viem";
import { normalizeAddress } from "./chain/address.js";
import type { EngineDb, EventRow } from "./chain/db.js";

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
  upstream: string; // COMPUTE_UPSTREAM_URL
  models: Record<string, Price>;
  markupBps: number; // COMPUTE_MARKUP_BPS: on top of the list price, for turning ETH into dollars
  maxTokens: number; // COMPUTE_MAX_TOKENS: the most output one request may ask for
  maxBodyBytes: number;
  keyTtlS: number;
  inFlight: number; // requests one agent may have under way at once
  inFlightAll: number; // COMPUTE_IN_FLIGHT_ALL: and all agents together
  dailyMicro: number; // COMPUTE_DAILY_USD: the most the gateway spends with the model maker in a day (UTC), as millionths
  /** why it is off, when the owner meant it to be on */
  note: string | null;
}

type Env = Record<string, string | undefined>;

export function readCompute(env: Env, problems: string[] = []): ComputeConfig {
  const on = (env.COMPUTE_MODE ?? "").trim().toLowerCase() === "on";
  const hasKey = !!env.ANTHROPIC_API_KEY?.trim();
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
  return {
    enabled: on && hasKey,
    upstream,
    models,
    markupBps: int("COMPUTE_MARKUP_BPS", 500, 0, 5000),
    maxTokens: int("COMPUTE_MAX_TOKENS", 16_000, 1, 200_000),
    maxBodyBytes: int("COMPUTE_MAX_BODY_BYTES", 2_000_000, 1000, 20_000_000),
    keyTtlS: 7 * 86400,
    inFlight: int("COMPUTE_IN_FLIGHT", 4, 1, 64),
    inFlightAll: int("COMPUTE_IN_FLIGHT_ALL", 32, 1, 1024),
    dailyMicro: int("COMPUTE_DAILY_USD", 100, 1, 1_000_000) * 1_000_000,
    note: on && !hasKey ? "COMPUTE_MODE is on and ANTHROPIC_API_KEY is not set: compute credit is written down as it is drawn, and no model is served until the key is there." : null,
  };
}

// ---------- the books ----------

export interface Lot { tx_hash: string; log_index: number; block: number; at: number; job_id: number; agent: string; wei: string; usd_micro: number | null; spent_micro: number; state: "open" | "kept" | "closed"; back_wei: string; back_tx: string | null }

/** ETH in wei as millionths of a dollar, at a Chainlink price with 8 decimals. Rounded down: credit is never overstated. */
export const usdMicro = (wei: bigint, ethUsd8: bigint): number => Number((wei * ethUsd8) / 10n ** 20n);

export interface Usage { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }

/** What a call cost, in millionths of a dollar: the list price for each kind of token, plus the margin, rounded up. */
export function costMicro(u: Usage, p: Price, markupBps: number): number {
  // a dollar per million tokens is a millionth of a dollar per token, so tokens times the price IS millionths
  const list = u.input * p.in + u.output * p.out + u.cacheWrite5m * p.cacheWrite5m + u.cacheWrite1h * p.cacheWrite1h + u.cacheRead * p.cacheRead;
  return Math.max(0, Math.ceil((list * (10_000 + markupBps)) / 10_000 - 1e-9));
}

export class ComputeStore {
  constructor(private db: EngineDb) {}

  /** A compute advance, as the desk's log says it: a lot of credit for the agent. Written once. */
  addLot(e: EventRow, ethUsd8: string | null): void {
    const wei = BigInt(String(e.args.amount)) - BigInt(String(e.args.fee));
    const usd = ethUsd8 ? usdMicro(wei, BigInt(ethUsd8)) : null;
    this.db.q("INSERT OR IGNORE INTO compute_lots (tx_hash, log_index, block, at, job_id, agent, wei, usd_micro) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(e.tx_hash, e.log_index, e.block, e.at, Number(e.args.id), normalizeAddress(e.args.agent), wei.toString(), usd);
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
    this.db.q("UPDATE compute_lots SET state = 'kept' WHERE job_id = ? AND state = 'open'").run(jobId);
  }

  /**
   * The job was refunded and the pool lost on it. The pool takes back what it lost and no more, out of the ETH of
   * the job's credit that was not spent: that much of the credit is gone, and the ETH is marked to go back.
   */
  close(jobId: number, lost: bigint): void {
    const lots = this.db.q("SELECT * FROM compute_lots WHERE job_id = ? AND state = 'open' ORDER BY block, log_index").all(jobId) as Lot[];
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

  /** ETH the gateway holds that the pool took back from lots, and has not been sent to the pool yet. */
  owedToPool(): { wei: bigint; lots: { tx_hash: string; log_index: number }[] } {
    const lots = this.db.q("SELECT tx_hash, log_index, back_wei FROM compute_lots WHERE back_tx IS NULL AND back_wei != '0'").all() as { tx_hash: string; log_index: number; back_wei: string }[];
    return { wei: lots.reduce((n, l) => n + BigInt(l.back_wei), 0n), lots };
  }

  sentBack(lots: { tx_hash: string; log_index: number }[], tx: string): void {
    this.db.tx(() => { for (const l of lots) this.db.q("UPDATE compute_lots SET back_tx = ? WHERE tx_hash = ? AND log_index = ?").run(tx, l.tx_hash, l.log_index); });
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
const usd = (micro: number): string => `$${(micro / 1e6).toFixed(micro < 10_000 ? 6 : 4)}`;

interface Fail { status: number; type: string; message: string }
const fail = (status: number, type: string, message: string): Fail => ({ status, type, message });

export class Gateway {
  private reserved = new Map<string, { micro: number; calls: number }>();
  private underWay = 0; // calls of all agents together, and the worst they could cost
  private underWayMicro = 0;

  constructor(
    readonly cfg: ComputeConfig,
    readonly store: ComputeStore,
    private db: EngineDb,
    private modelKey: string | null, // the owner's key with the model maker: sent upstream, never anywhere else
    private log: (line: string) => void,
    // asks an account whether one of its keys signed a text (see ./accounts.ts); without it only wallets sign
    private accountSigned: ((address: string, message: string, signature: unknown) => Promise<boolean>) | null = null,
  ) {}

  /** What anybody may know: whether it is on, the models and what they cost here. */
  about(): { enabled: boolean; markupPct: number; maxTokens: number; models: { id: string; inUsd: number; outUsd: number }[] } {
    const up = (n: number) => Math.round(n * (10_000 + this.cfg.markupBps)) / 10_000;
    return { enabled: this.cfg.enabled, markupPct: this.cfg.markupBps / 100, maxTokens: this.cfg.maxTokens, models: Object.entries(this.cfg.models).map(([id, p]) => ({ id, inUsd: up(p.in), outUsd: up(p.out) })) };
  }

  /** Everything under /v1/compute/. Always answers. */
  async http(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(body)); };
    const refuse = (f: Fail) => json(f.status, { type: "error", error: { type: f.type, message: f.message } });
    try {
      if (path === "/v1/compute/models" && req.method === "GET") return json(200, this.about());
      // what an agent has left is as public as the advance that paid for it
      const credit = /^\/v1\/compute\/credit\/(0x[0-9a-fA-F]{40})$/.exec(path);
      if (credit && req.method === "GET") return json(200, this.balanceOf(credit[1]!.toLowerCase()));
      if (path === "/v1/compute/key" && req.method === "POST") {
        const r = await this.mint(JSON.parse((await readBody(req, 4096)).toString("utf8")) as Record<string, unknown>);
        return "status" in r ? refuse(r) : json(200, r);
      }
      const agent = this.who(req);
      if (path === "/v1/compute/balance" && req.method === "GET") return agent ? json(200, this.balanceOf(agent)) : refuse(fail(401, "authentication_error", "That key is not one of Factor's compute keys, or it has run out. Sign for a new one."));
      if (path === "/v1/compute/v1/messages" && req.method === "POST") {
        if (!agent) return refuse(fail(401, "authentication_error", "That key is not one of Factor's compute keys, or it has run out. Sign for a new one."));
        const f = await this.messages(agent, req, res);
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
      lots: this.store.lots(agent).map((l) => ({ job: l.job_id, at: new Date(l.at * 1000).toISOString(), usd: l.usd_micro === null ? null : l.usd_micro / 1e6, spentUsd: l.spent_micro / 1e6, state: l.state })),
    };
  }

  /** One call to a model, paid from the agent's credit. Returns why not, or null when it has answered. */
  private async messages(agent: string, req: IncomingMessage, res: ServerResponse): Promise<Fail | null> {
    const cfg = this.cfg;
    if (!cfg.enabled || !this.modelKey) return fail(503, "api_error", "Compute credit is not switched on yet. Credit that was drawn is kept and can be used when it is.");
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

    // The worst this request could cost is held back before it is sent, so calls made at the same moment cannot
    // spend the same credit twice. A token is a byte at least, so the request's size bounds its input from above;
    // input costs most when it is written to the cache, which only a request that asks for caching can do.
    const most = raw.length + 1000;
    const caches = raw.includes("cache_control");
    const worst = costMicro({ input: caches ? 0 : most, output: maxTokens, cacheWrite5m: 0, cacheWrite1h: caches ? most : 0, cacheRead: 0 }, price, cfg.markupBps);
    const held = this.reserved.get(agent) ?? { micro: 0, calls: 0 };
    if (held.calls >= cfg.inFlight) return fail(429, "rate_limit_error", `An agent may have ${cfg.inFlight} requests under way at once.`);
    if (this.underWay >= cfg.inFlightAll) return fail(429, "rate_limit_error", "The gateway is busy. Try again in a moment.");
    // the owner's own ceiling on a day, whatever the credit outstanding: the calls under way count at their worst
    if (this.store.spentToday() + this.underWayMicro + worst > cfg.dailyMicro) return fail(429, "rate_limit_error", "The gateway has reached what it spends in a day. The credit is kept: try again after midnight UTC.");
    const free = this.store.balance(agent) - held.micro;
    if (free <= 0) return fail(402, "billing_error", "This agent has no compute credit. Draw an advance as compute on a job it was hired for.");
    if (worst > free) return fail(402, "billing_error", `This request could cost up to ${usd(worst)} and the agent's compute credit is ${usd(free)}. Lower max_tokens, send less, or draw more as compute.`);
    this.reserved.set(agent, { micro: held.micro + worst, calls: held.calls + 1 });
    this.underWay++;
    this.underWayMicro += worst;

    const t0 = Date.now();
    const usage: Usage = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
    let status = 0;
    let requestId = "";
    try {
      const upstream = await fetch(`${cfg.upstream}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.modelKey, "anthropic-version": typeof req.headers["anthropic-version"] === "string" ? req.headers["anthropic-version"] : "2023-06-01" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      status = upstream.status;
      requestId = upstream.headers.get("request-id") ?? "";
      const type = upstream.headers.get("content-type") ?? "application/json";
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...(requestId ? { "request-id": requestId } : {}) });
      if (body.stream === true && status === 200 && upstream.body) {
        // passed on as it arrives; the token counts are read from the stream's own events on the way through
        const decoder = new TextDecoder();
        let tail = "";
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk);
          tail += decoder.decode(chunk, { stream: true });
          const lines = tail.split("\n");
          tail = lines.pop() ?? "";
          for (const line of lines) if (line.startsWith("data:")) readUsage(line.slice(5), usage);
        }
        if (tail.startsWith("data:")) readUsage(tail.slice(5), usage);
        res.end();
      } else {
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
    // what was really used is taken off the credit, and what was held back is let go
    const cost = costMicro(usage, price, cfg.markupBps);
    const unpaid = cost > 0 ? this.store.charge(agent, cost) : 0;
    this.release(agent, worst);
    this.store.record({ agent, model, usage, cost, unpaid, status, requestId, ms: Date.now() - t0 });
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
