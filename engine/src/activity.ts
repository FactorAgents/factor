// Before the launch: Factor's own agents at work, for real, a little at a time.
//
// Nothing happens on the desk before the launch, and the site makes nothing up. What can happen is the agents doing
// what they do, on their own account: every few minutes (about ACTIVITY_EVERY_MIN, 5, on average, never on the dot) one
// of them does one small real job and
// it is written down, so the receipt on the home page shows the platform working:
//   - price-desk reads ETH and a stock from Chainlink's feeds on the chain, the prices as the feeds have them
//   - gas-desk works out what a plain transfer costs right now, in dollars, from the chain's gas price and ETH's price
//   - now and then (ACTIVITY_PRACTICE_EVERY turns, 24: about every two hours) one of the agents that use a model does a
//     practice job on one of its demonstration briefs, with Factor's own key, and what it handed back is counted
// Every line says it is Factor's own agent working on its own; none of it is a customer's job. From the launch on it
// stops: then the receipt has the desk's own lines. ACTIVITY=off stops it before then too.

import type Database from "better-sqlite3";
import { FEEDS } from "./house/feeds.js";
import { SERVICES } from "./house/services.js";
import { BRIEFS } from "./house/demo.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS house_activity (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,               -- ms
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,                -- read | practice
  text TEXT NOT NULL,
  amount TEXT NOT NULL DEFAULT '',
  cost_usd REAL NOT NULL DEFAULT 0
);
`;

export interface Activity { n: number; at: number; agent: string; kind: "read" | "practice"; text: string; amount: string }

export type Ask = (system: string, user: string, maxTokens: number) => Promise<{ text: string; input: number; output: number }>;

/** The model maker's Messages API with Factor's own key, for the practice jobs. */
export function anthropicAsk(key: string, model: string, upstream = "https://api.anthropic.com"): Ask {
  return async (system, user, maxTokens) => {
    const res = await fetch(`${upstream.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: Math.min(maxTokens, 4_000), system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`the model maker answered ${res.status}`);
    const b = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    return { text: (b.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(""), input: Number(b.usage?.input_tokens ?? 0), output: Number(b.usage?.output_tokens ?? 0) };
  };
}

export interface ActivityOptions {
  urls: string[];
  ask?: Ask | null;
  /** dollars per million tokens of the practice model, in and out */
  price?: { in: number; out: number };
  everyMin?: number;
  practiceEvery?: number;
  launched?: () => boolean;
  now?: () => number;
  /** a number from 0 to 1: how long the next wait is, and which agent goes */
  random?: () => number;
  fetchFn?: typeof fetch;
}

const usd = (n: number, places = 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places })}`;
const ETH_FEED = FEEDS.find((f) => f.symbol === "ETH")!;
const STOCKS = FEEDS.filter((f) => f.kind === "equity");
const PRACTISED = SERVICES.filter((s) => s.ask && BRIEFS[s.name]?.length);

export class HouseActivity {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private on = false;
  private last: ("prices" | "gas")[] = [];
  private busy = false;
  private turnN = 0;
  private ethUsd: number | null = null;
  private readonly everyMs: number;
  private readonly practiceEvery: number;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly random: () => number;

  constructor(private sqlite: Database.Database, private o: ActivityOptions) {
    sqlite.exec(SCHEMA);
    this.everyMs = Math.max(1, o.everyMin ?? 5) * 60_000;
    this.practiceEvery = Math.max(2, o.practiceEvery ?? 24);
    this.now = o.now ?? Date.now;
    this.fetchFn = o.fetchFn ?? fetch;
    this.random = o.random ?? Math.random;
    this.turnN = (sqlite.prepare("SELECT COUNT(*) AS n FROM house_activity").get() as { n: number }).n;
  }

  start(): void {
    if (this.on) return;
    this.on = true;
    this.next(20_000);
  }

  stop(): void {
    this.on = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // the wait before the next job is anywhere from two fifths of the usual to nearly twice it, so the lines never come
  // on a beat: with the usual 5 minutes, between 2 and 9
  private next(ms = Math.round(this.everyMs * (0.4 + 1.4 * this.random()))): void {
    if (!this.on) return;
    this.timer = setTimeout(() => { void this.turn().finally(() => this.next()); }, ms);
    this.timer.unref?.();
  }

  latest(limit = 8): Activity[] {
    return this.sqlite.prepare("SELECT n, at, agent, kind, text, amount FROM house_activity ORDER BY n DESC LIMIT ?").all(limit) as Activity[];
  }

  private rpc = async (method: string, params: unknown[]): Promise<string | null> => {
    for (const url of this.o.urls) {
      try {
        const r = await this.fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(6_000) });
        if (!r.ok) continue;
        const j = (await r.json()) as { result?: unknown };
        if (typeof j.result === "string") return j.result;
      } catch { /* the next node */ }
    }
    return null;
  };

  /** A Chainlink feed's latest price in dollars (8 decimals), or null. */
  async feedUsd(address: string): Promise<number | null> {
    const hex = await this.rpc("eth_call", [{ to: address, data: "0xfeaf968c" }, "latest"]); // latestRoundData()
    if (!hex || hex.length < 2 + 64 * 2) return null;
    const answer = BigInt.asIntN(256, BigInt(`0x${hex.slice(2 + 64, 2 + 128)}`));
    return answer > 0n ? Number(answer) / 1e8 : null;
  }

  private write(agent: string, kind: "read" | "practice", text: string, amount = "", cost = 0): Activity {
    const at = this.now();
    const r = this.sqlite.prepare("INSERT INTO house_activity (at, agent, kind, text, amount, cost_usd) VALUES (?, ?, ?, ?, ?, ?)").run(at, agent, kind, text, amount, cost);
    return { n: Number(r.lastInsertRowid), at, agent, kind, text, amount };
  }

  /** price-desk at work: ETH and one stock, in turn, from Chainlink's feeds. */
  async prices(): Promise<Activity | null> {
    const stock = STOCKS[Math.floor(this.turnN / 2) % STOCKS.length]!;
    const [eth, st] = await Promise.all([this.feedUsd(ETH_FEED.address), this.feedUsd(stock.address)]);
    if (eth === null) return null;
    this.ethUsd = eth;
    return this.write("price-desk", "read", `read ETH at ${usd(eth)}${st !== null ? ` and ${stock.symbol} at ${usd(st)}` : ""} from Chainlink's feeds`, "");
  }

  /** gas-desk at work: what a plain transfer costs right now, in dollars. */
  async gas(): Promise<Activity | null> {
    const g = await this.rpc("eth_gasPrice", []);
    const eth = this.ethUsd ?? (await this.feedUsd(ETH_FEED.address));
    if (!g || eth === null) return null;
    const costUsd = (Number(BigInt(g)) * 21_000 / 1e18) * eth;
    return this.write("gas-desk", "read", `worked out that a plain transfer costs about ${usd(costUsd, 4)} right now`, "");
  }

  /** One of the agents that use a model, on one of its demonstration briefs. */
  async practice(): Promise<Activity | null> {
    if (!this.o.ask || !PRACTISED.length) return null;
    const turn = Math.floor(this.turnN / this.practiceEvery);
    const s = PRACTISED[turn % PRACTISED.length]!;
    const briefs = BRIEFS[s.name]!;
    const b = briefs[Math.floor(turn / PRACTISED.length) % briefs.length]!;
    const brief = typeof b.brief === "function" ? b.brief({ token: null, desk: "" }) : b.brief;
    const asked = s.ask!(b.title, brief);
    const got = await this.o.ask(asked.system, asked.user, asked.maxTokens);
    if (!got.text.trim()) return null;
    const p = this.o.price ?? { in: 2, out: 10 };
    const cost = (got.input * p.in + got.output * p.out) / 1e6;
    return this.write(s.name, "practice", `did a practice job on its own, "${b.title}": ${got.text.trim().length.toLocaleString("en-US")} characters handed back`, "", cost);
  }

  /** One turn: the next agent's small job, unless the launch has happened. */
  async turn(): Promise<Activity | null> {
    if (this.busy || this.o.launched?.()) return null;
    this.busy = true;
    try {
      const n = this.turnN++;
      if (this.o.ask && n % this.practiceEvery === this.practiceEvery - 1) return (await this.practice().catch(() => null)) ?? (await this.prices());
      // either agent, by chance, but not the same one three times running
      const [a, b] = this.last.slice(-2);
      const go = a && a === b ? (a === "prices" ? "gas" : "prices") : this.random() < 0.5 ? "prices" : "gas";
      this.last = [...this.last.slice(-1), go];
      return go === "prices" ? await this.prices() : await this.gas();
    } catch {
      return null;
    } finally {
      this.busy = false;
    }
  }
}

export const activityOn = (env: Record<string, string | undefined>): boolean => (env.ACTIVITY ?? "on").trim().toLowerCase() !== "off";
