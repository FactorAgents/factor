// Raeto as a route for compute credit. An agent with credit names raeto/auto (or one of its variants) at the gateway's
// second door, with the key it already has, and Raeto picks the model for each request. Nothing else about credit
// changes: the same hold, the same caps, the same margin, and only what was really charged is taken off.
//
//   RAETO=on             off by default, and with it off nothing here runs and nothing anywhere changes
//   RAETO_API_KEY        the owner's key at Raeto. Read when the gateway is made, sent to Raeto only, never logged,
//                        stored or returned
//   RAETO_URL            https://api.raeto.cc/v1
//   RAETO_MAX_IN_USD     the dearest input the hold assumes, dollars per million tokens, before Raeto's fee: 5
//   RAETO_MAX_OUT_USD    the same for output: 25
//   RAETO_TIMEOUT_S      how long a call may take: 600
//   RAETO_FLOAT_FLOOR_USD  below this at Raeto no call is sent: 1
//   RAETO_FLOAT_CHECK_S  how often the balance there is looked at: 300
//   HOUSE_RAETO=on       Factor's own agents ask raeto/auto too, under their existing daily ceiling; off by default
//   HOUSE_RAETO_MODEL    which of the variants they ask: raeto/auto
//
// What the real API does, read from calls made on 2 Nov 2026 (the stand-in, scripts/stub-raeto.ts, answers the same):
//
//   - a whole answer has what was taken in the header x-raeto-cost, in dollars
//   - a streamed answer has no such header. On an auto call its last chunk carries { raeto: { model, cost_usd, ... } }
//   - usage.cost in either is what the model provider charged Raeto, before Raeto's fee and its routing fee. It is far
//     under what was taken (0.0000026 against 0.000032 on a short call) and is only ever a last resort here
//   - an error's body can carry the account's user_id, so it is never passed on: only its message, on a 400
//
// A hold has to be the worst a call could cost, and raeto/auto has no price of its own. So the hold assumes the ceilings
// above for every byte and token, and an agent is never charged more than was held. If Raeto ever charged more than the
// ceiling, the difference is written down as unpaid and the owner is told in the log.

export const RAETO_MODELS: { id: string; name: string }[] = [
  { id: "raeto/auto", name: "Raeto picks the model for each request" },
  { id: "raeto/auto:cheap", name: "Raeto picks the model, and keeps the cheap answer" },
  { id: "raeto/auto:fast", name: "Raeto picks the model, quickest first" },
  { id: "raeto/auto:code", name: "Raeto picks the model, for code" },
  { id: "raeto/auto:reason", name: "Raeto picks the model, for hard reasoning" },
  { id: "raeto/auto:vision", name: "Raeto picks the model, among those that read pictures" },
  { id: "raeto/auto:tools", name: "Raeto picks the model, among those that call tools" },
  { id: "raeto/auto:json", name: "Raeto picks the model, among those that answer in JSON" },
  { id: "raeto/auto:long", name: "Raeto picks the model, among those with a long memory" },
];
const IDS = new Set(RAETO_MODELS.map((m) => m.id));
export const isRaetoModel = (id: unknown): boolean => typeof id === "string" && IDS.has(id);

/** Raeto's fee on a model's price, and the most its routing fee is, as its pricing page has them on 2 Nov 2026. */
export const RAETO_FEE_BPS = 800;
export const RAETO_ROUTE_FEE_MICRO = 200;
/** A picture's tokens are not in the size of a request that only links to it: this many are assumed for each. */
const PICTURE_TOKENS = 10_000;
/** Answers in a row with no cost on them, after which no call is sent for ten minutes: Raeto's answers have changed. */
export const RAETO_BLIND_LIMIT = 5;
export const RAETO_BLIND_MS = 600_000;

export interface RaetoConfig {
  enabled: boolean;
  url: string;
  maxInPerM: number;
  maxOutPerM: number;
  timeoutMs: number;
  floorMicro: number;
  floatCheckMs: number;
  house: boolean;
  houseModel: string;
  /** why it is off, when the owner meant it to be on */
  note: string | null;
}

type Env = Record<string, string | undefined>;

export const takeRaetoKey = (env: Env = process.env): string | null => env.RAETO_API_KEY?.trim() || null;

/** Off, nothing is read and nothing can be wrong: a stray setting never stops an engine that does not use Raeto. */
export function readRaeto(env: Env, problems: string[] = []): RaetoConfig {
  const on = (env.RAETO ?? "").trim().toLowerCase() === "on";
  const off: RaetoConfig = { enabled: false, url: "https://api.raeto.cc/v1", maxInPerM: 5, maxOutPerM: 25, timeoutMs: 600_000, floorMicro: 1_000_000, floatCheckMs: 300_000, house: false, houseModel: "raeto/auto", note: null };
  if (!on) return off;
  if (!takeRaetoKey(env)) return { ...off, note: "RAETO is on and RAETO_API_KEY is not set: raeto/auto is not served, and everything else goes on as it was." };
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const v = env[name]?.trim();
    if (!v) return fallback;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}: it is "${v}"`);
      return fallback;
    }
    return Number(v);
  };
  const url = (env.RAETO_URL?.trim() || off.url).replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(url)) problems.push("RAETO_URL is not an http(s) address");
  const houseModel = env.HOUSE_RAETO_MODEL?.trim() || off.houseModel;
  if (!isRaetoModel(houseModel)) problems.push(`HOUSE_RAETO_MODEL must be one of ${[...IDS].join(", ")}: it is "${houseModel}"`);
  return {
    enabled: true, url, houseModel, note: null,
    maxInPerM: int("RAETO_MAX_IN_USD", off.maxInPerM, 1, 1000),
    maxOutPerM: int("RAETO_MAX_OUT_USD", off.maxOutPerM, 1, 1000),
    timeoutMs: int("RAETO_TIMEOUT_S", 600, 1, 3600) * 1000,
    floorMicro: int("RAETO_FLOAT_FLOOR_USD", 1, 0, 100_000) * 1_000_000,
    floatCheckMs: int("RAETO_FLOAT_CHECK_S", 300, 0, 86_400) * 1000,
    house: (env.HOUSE_RAETO ?? "").trim().toLowerCase() === "on",
  };
}

// ---------- what a call may cost, and what it did ----------

/** Dollars in millionths for one request at its worst: the ceilings, Raeto's fee, its routing fee, Factor's margin. */
export function raetoWorstMicro(bytes: number, asked: number, pictures: number, c: Pick<RaetoConfig, "maxInPerM" | "maxOutPerM">, markupBps: number): number {
  const list = (bytes + 1000 + pictures * PICTURE_TOKENS) * c.maxInPerM + asked * c.maxOutPerM;
  return Math.ceil(((list * (10_000 + RAETO_FEE_BPS)) / 10_000 + RAETO_ROUTE_FEE_MICRO) * (10_000 + markupBps) / 10_000);
}

export interface RaetoSeen {
  id: string;
  model: string;
  /** Raeto's own figure for a stream, in dollars */
  costUsd: number | null;
  input: number;
  output: number;
  cacheRead: number;
  /** usage.cost: what the provider charged Raeto, before Raeto's fees */
  providerUsd: number | null;
  sawUsage: boolean;
  answered: boolean;
  failed: boolean;
}
export const newSeen = (): RaetoSeen => ({ id: "", model: "", costUsd: null, input: 0, output: 0, cacheRead: 0, providerUsd: null, sawUsage: false, answered: false, failed: false });

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const money = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Dollars in the header, or null when it is not there or is not a figure. */
export function headerUsd(v: string | null): number | null {
  if (!v || !/^\d+(\.\d+)?(e-?\d+)?$/i.test(v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** What one whole answer, or one chunk of a stream, says. */
export function absorb(d: Record<string, unknown>, into: RaetoSeen): void {
  if (!into.id && typeof d.id === "string") into.id = d.id.slice(0, 120);
  if (typeof d.model === "string") into.model = d.model.slice(0, 120);
  if (d.error) into.failed = true;
  const choices = d.choices;
  if (Array.isArray(choices) && choices.length) {
    into.answered = true;
    if ((choices[0] as { finish_reason?: unknown })?.finish_reason === "error") into.failed = true;
  }
  const u = d.usage as Record<string, unknown> | undefined;
  if (u && typeof u === "object") {
    into.sawUsage = true;
    into.input = Math.max(into.input, count(u.prompt_tokens));
    into.output = Math.max(into.output, count(u.completion_tokens));
    into.cacheRead = Math.max(into.cacheRead, count((u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens));
    into.providerUsd = money(u.cost) ?? into.providerUsd;
  }
  const r = d.raeto as Record<string, unknown> | undefined;
  if (r && typeof r === "object") {
    if (typeof r.model === "string") into.model = r.model.slice(0, 120);
    into.costUsd = money(r.cost_usd) ?? into.costUsd;
  }
}

export interface RaetoPrice {
  /** what was taken from Factor's balance at Raeto, in millionths of a dollar; a fraction of one is kept */
  upstreamMicro: number;
  /** what the agent's credit pays: that and the margin, rounded up, and never more than was held */
  chargeMicro: number;
  /** where the figure came from; anything but the first two means Raeto did not say */
  from: "header" | "chunk" | "usage" | "tokens" | "hold";
  /** what the hold did not cover, for the books */
  shortMicro: number;
}

/**
 * What a call that was answered cost. Raeto's own figure when it gave one. Without it, what the provider charged it with
 * Raeto's fees on top; without that, the tokens at the ceilings; with no tokens either, the hold.
 */
export function priceCall(seen: RaetoSeen, header: number | null, worst: number, c: Pick<RaetoConfig, "maxInPerM" | "maxOutPerM">, markupBps: number): RaetoPrice {
  const withMargin = (micro: number) => Math.ceil((micro * (10_000 + markupBps)) / 10_000 - 1e-9);
  const fees = (micro: number) => (micro * (10_000 + RAETO_FEE_BPS)) / 10_000 + RAETO_ROUTE_FEE_MICRO;
  let upstream: number;
  let from: RaetoPrice["from"];
  if (header !== null) { upstream = header * 1e6; from = "header"; }
  else if (seen.costUsd !== null) { upstream = seen.costUsd * 1e6; from = "chunk"; }
  else if (seen.providerUsd !== null) { upstream = fees(seen.providerUsd * 1e6); from = "usage"; }
  else if (seen.input + seen.output > 0) { upstream = fees(seen.input * c.maxInPerM + seen.output * c.maxOutPerM); from = "tokens"; }
  else return { upstreamMicro: (worst * 10_000) / (10_000 + markupBps), chargeMicro: worst, from: "hold", shortMicro: 0 };
  const whole = withMargin(upstream);
  return { upstreamMicro: upstream, chargeMicro: Math.min(whole, worst), from, shortMicro: Math.max(0, whole - worst) };
}

/** Raeto's figures in an answer become what the agent actually pays, so what it reads is what its credit shows. */
export function showCharge(d: Record<string, unknown>, chargeMicro: number): void {
  const u = d.usage as Record<string, unknown> | undefined;
  if (u && typeof u === "object") {
    u.cost = chargeMicro / 1e6;
    delete u.cost_details;
    delete u.is_byok;
  }
  const r = d.raeto as Record<string, unknown> | undefined;
  if (r && typeof r === "object") d.raeto = { model: r.model, cost_usd: chargeMicro / 1e6 };
}

// ---------- when Raeto says no ----------

export interface RaetoRefusal {
  status: number;
  type: string;
  message: string;
  /** for the owner's log: the type Raeto gave, never its body */
  owner: string | null;
  /** the account there has run out, so the balance is read again */
  empty: boolean;
}

const NOT_NOW = "The gateway cannot reach the models just now. Nothing was taken from the credit: try again later.";

/** A refusal from Raeto as the agent sees it. Only a 400's message is passed on, and an account id never is. */
export function raetoRefusal(status: number, text: string): RaetoRefusal {
  let type = "";
  let message = "";
  try {
    const e = (JSON.parse(text) as { error?: { type?: unknown; message?: unknown } }).error;
    type = typeof e?.type === "string" ? e.type.slice(0, 60) : "";
    message = typeof e?.message === "string" ? e.message.slice(0, 300) : "";
  } catch { /* not JSON: the status says enough */ }
  const owner = `Raeto answered ${status}${type ? ` (${type})` : ""}`;
  if (status === 402 && type === "task_budget_reached") return { status: 402, type: "billing_error", message: "This job's compute budget is used up. Nothing was taken from the credit for this call.", owner: null, empty: false };
  if (status === 402) return { status: 503, type: "api_error", message: NOT_NOW, owner: `${owner}: top up or raise the key's cap`, empty: true };
  if (status === 401 || status === 403) return { status: 503, type: "api_error", message: NOT_NOW, owner: `${owner}: look at the key in Raeto's console`, empty: false };
  if (status === 409) return { status: 409, type: "rate_limit_error", message: "This agent kept sending the same request, so it was stopped before reaching a model. Nothing was taken from the credit. Change the request or wait a few minutes.", owner: null, empty: false };
  if (status === 429) return { status: 429, type: "rate_limit_error", message: "Too many requests are going to the models just now. Nothing was taken from the credit. Try again in a moment.", owner, empty: false };
  if (status >= 400 && status < 500) return { status: 400, type: "invalid_request_error", message: message || "The model's service refused this request. Nothing was taken from the credit.", owner: null, empty: false };
  return { status: 502, type: "api_error", message: "The model did not answer. Nothing was taken from the credit.", owner, empty: false };
}

// ---------- Factor's balance at Raeto ----------

/** What the key can still spend at Raeto, looked at every few minutes. Unknown never stops a call: a known low balance does. */
export class RaetoFloat {
  private micro: number | null = null;
  private feePctSeen: number | null = null;
  private readAt = 0;
  private loading: Promise<void> | null = null;
  private warned = false;

  constructor(private url: string, private key: string, private floorMicro: number, private checkMs: number, private log: (line: string) => void, private now: () => number = Date.now) {}

  async ok(): Promise<boolean> {
    const every = this.warned ? Math.min(this.checkMs, 60_000) : this.checkMs;
    if (this.now() - this.readAt >= every && !this.loading) this.loading = this.load();
    if (this.loading && (this.micro === null || this.checkMs === 0 || this.readAt === 0)) await this.loading;
    return this.micro === null || this.micro >= this.floorMicro;
  }

  usd(): number | null { return this.micro === null ? null : this.micro / 1e6; }
  feePct(): number | null { return this.feePctSeen; }

  /** Raeto said the account or the key has run out: nothing is left until it is read again. */
  forget(): void {
    this.micro = 0;
    this.readAt = 0;
  }

  private async load(): Promise<void> {
    try {
      const r = await fetch(`${this.url}/me`, { headers: { authorization: `Bearer ${this.key}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`it answered ${r.status}`);
      const d = (await r.json()) as { available_usd?: unknown; balance_usd?: unknown; fee_pct?: unknown };
      const left = money(d.available_usd) ?? money(d.balance_usd);
      this.micro = left === null ? null : Math.floor(left * 1e6);
      this.feePctSeen = money(d.fee_pct) ?? this.feePctSeen;
      const low = this.micro !== null && this.micro < this.floorMicro;
      if (low && !this.warned) this.log(`[compute] Factor's balance at Raeto is $${(this.micro! / 1e6).toFixed(2)}, under the floor of $${(this.floorMicro / 1e6).toFixed(2)}: no call is sent there until it is topped up`);
      if (!low && this.warned) this.log("[compute] Factor's balance at Raeto is above the floor again");
      this.warned = low;
    } catch (e) {
      this.log(`[compute] Factor's balance at Raeto could not be read: ${(e as Error).message?.split("\n")[0]}`);
    } finally {
      this.readAt = this.now();
      this.loading = null;
    }
  }
}

// ---------- what a job's credit went on ----------

/** The part of a call taken from one lot of credit. */
export interface RaetoSlice { job: number; source: "advance" | "coin" | "line"; line: string | null; micro: number }

export interface RaetoSpend { spentUsd: number; calls: number; models: { model: string; tier: string; calls: number; usd: number }[] }

export interface RaetoDb { q(text: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }; now(): number; tx<T>(fn: () => T): T }

/** Which model answered and what it cost, by the job whose credit paid. Never what was asked or answered. */
export class RaetoBooks {
  constructor(private db: RaetoDb) {}

  add(c: { agent: string; asked: string; model: string; tier: string; requestId: string; upstreamMicro: number; from: string }, slices: RaetoSlice[]): void {
    this.db.tx(() => {
      for (const s of slices) this.db.q("INSERT INTO compute_raeto_spend (at, agent, job_id, source, line, asked, model, tier, request_id, cost_micro, upstream_micro, cost_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(this.db.now(), c.agent, s.job, s.source, s.line, c.asked, c.model, c.tier, c.requestId, s.micro, c.upstreamMicro, c.from);
    });
  }

  private summary(where: string, ...args: unknown[]): RaetoSpend | null {
    const rows = this.db.q(`SELECT model, tier, COUNT(DISTINCT request_id) AS calls, SUM(cost_micro) AS micro FROM compute_raeto_spend WHERE ${where} GROUP BY model, tier ORDER BY micro DESC`).all(...args) as { model: string; tier: string; calls: number; micro: number }[];
    if (!rows.length) return null;
    const calls = (this.db.q(`SELECT COUNT(DISTINCT request_id) AS n FROM compute_raeto_spend WHERE ${where}`).get(...args) as { n: number }).n;
    return { spentUsd: rows.reduce((n, r) => n + r.micro, 0) / 1e6, calls, models: rows.map((r) => ({ model: r.model, tier: r.tier, calls: r.calls, usd: r.micro / 1e6 })) };
  }

  forJob(job: number): RaetoSpend | null { return job > 0 ? this.summary("job_id = ? AND source = 'advance'", job) : null; }
  forAgent(agent: string): RaetoSpend | null { return this.summary("agent = ?", agent); }
}

// ---------- Factor's own agents ----------

export interface RaetoAsker { url: string; key: string; model: string; timeoutMs: number }

/** One question from one of Factor's own agents, in the shape its service hands over. What it cost is Raeto's figure. */
export async function askRaeto(r: RaetoAsker, a: { system: string; user: string; maxTokens: number }, agent: string | undefined): Promise<{ text: string; input: number; output: number; costMicro: number; model: string }> {
  const res = await fetch(`${r.url}/chat/completions`, {
    method: "POST", redirect: "error",
    headers: { "content-type": "application/json", authorization: `Bearer ${r.key}`, "x-raeto-agent": agent ?? "factor-house" },
    body: JSON.stringify({ model: r.model, max_tokens: a.maxTokens, messages: [{ role: "system", content: a.system }, { role: "user", content: a.user }] }),
    signal: AbortSignal.timeout(Math.min(r.timeoutMs, 240_000)),
  });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`Raeto answered ${res.status}`); }
  const header = headerUsd(res.headers.get("x-raeto-cost"));
  const d = (await res.json()) as Record<string, unknown>;
  const seen = newSeen();
  absorb(d, seen);
  const text = String(((d.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content) ?? "");
  if (seen.failed || !text) throw new Error("Raeto gave no answer");
  // the day's ceiling counts what was taken at Raeto; with no figure, the provider's with Raeto's fees on top
  const micro = header !== null ? header * 1e6 : seen.costUsd !== null ? seen.costUsd * 1e6 : ((seen.providerUsd ?? 0) * 1e6 * (10_000 + RAETO_FEE_BPS)) / 10_000 + RAETO_ROUTE_FEE_MICRO;
  return { text, input: seen.input, output: seen.output, costMicro: Math.ceil(micro), model: seen.model };
}
