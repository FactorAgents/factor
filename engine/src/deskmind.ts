// The Desk: Factor's own mind. A credit officer that thinks out loud, in public, about money.
//
// It writes four kinds of note, each from facts the engine worked out itself:
//   - an opening file for each of Factor's own agents before the launch: what it does, and that with no record yet it
//     can draw only what its bond covers (the rule, said plainly)
//   - a credit file for every agent with a record, written again when its record changes: its jobs, customers, time
//     kept, advances repaid, its bond and fees, its score, and so what it may draw and why
//   - a reason for every advance: why this draw was allowed, in one or two sentences
//   - a letter once a day: what the desk saw the day before (before the launch, the chain it read; after it, the jobs,
//     the advances, the pool and the burns)
//
// The one rule that makes it worth reading: it never makes up a number. The figures come from the record; the model
// is asked only for the wording, and a note in which any number does not appear in its facts, or with a word the site
// never uses (invest, returns, profit, yield, guarantee), is thrown away and written plainly from the facts instead.
// Without a model key, past the day's ceiling (DESK_DAILY_USD), or when the model does not answer, the plain version
// is what it writes: the Desk never stops and never costs more than the ceiling.
//
//   DESK_MIND=off       no notes at all
//   DESK_MODEL          the model (claude-haiku-4-5-20251001 when not set): small notes, the cheapest is enough
//   DESK_DAILY_USD      what its notes may cost in a day (2 when not set); past it, plain notes until the next day
//   ANTHROPIC_API_KEY   the same key Factor's own agents use; read when a note is written, sent only to the model maker

import type Database from "better-sqlite3";

export type NoteKind = "opening" | "file" | "reason" | "letter";
export type Facts = Record<string, string | number | boolean>;

export interface Note { id: number; kind: NoteKind; subject: string; text: string; facts: Facts; model: string | null; costUsd: number; at: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS desk_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                -- opening | file | reason | letter
  subject TEXT NOT NULL,             -- an agent's name or address, an advance (tx:log), a day (YYYY-MM-DD)
  text TEXT NOT NULL,
  facts TEXT NOT NULL,               -- JSON: every figure the note was allowed to use
  model TEXT,                        -- the model that worded it, or NULL when it was written plainly from the facts
  cost_usd REAL NOT NULL DEFAULT 0,
  at INTEGER NOT NULL                -- ms
);
CREATE INDEX IF NOT EXISTS idx_desk_notes_subject ON desk_notes(kind, subject, at);
CREATE INDEX IF NOT EXISTS idx_desk_notes_at ON desk_notes(at);
`;

// ---------- the facts and the plain wording ----------

/** ETH from wei, at most four places, no trailing zeros. */
export function ethOf(wei: bigint | string): string {
  const w = BigInt(wei);
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The plain version of a note, written from its facts alone. Always true, never pretty. */
export function plainText(kind: NoteKind, f: Facts): string {
  switch (kind) {
    case "opening":
      return `${f.agent}: ${f.does}. No record yet, so until its first job is settled it can draw only what its bond covers, and never more than half of a job.`;
    case "file": {
      if (f.barred) return `${f.agent} is barred: an advance was not repaid or an early advance was kept without delivering. It can draw nothing from the pool.`;
      const record = Number(f.jobsSettled) === 0
        ? "No job settled yet."
        : `${plural(Number(f.jobsSettled), "job")} settled${Number(f.differentCustomers) > 0 ? ` for ${plural(Number(f.differentCustomers), "customer")}` : ""}, ${f.deliveredOnTime} delivered on time and ${f.deliveredLate} late; ${plural(Number(f.advancesRepaid), "advance")} repaid.`;
      return `${f.agent}: ${record} Bond ${f.bondEth} ETH, fees paid in ${f.feesPaidInEth} ETH, so it may draw up to ${f.limitWithPoolEth} ETH from the pool; ${f.freeToDrawNowEth} ETH is free now. Score ${f.scoreOutOf1000} of 1000.`;
    }
    case "reason":
      return String(f.advanceFrom).startsWith("the customer")
        ? `${f.agent} drew ${f.drawnEth} ETH on job ${f.job}, early money its customer allowed out of the ${f.lockedByTheCustomerEth} ETH they locked for it.`
        : `${f.agent} drew ${f.drawnEth} ETH from ${f.advanceFrom} on job ${f.job}: within half of the ${f.lockedByTheCustomerEth} ETH its customer locked, and within its limit of ${f.agentLimitWithPoolEth} ETH. The job pays it back.`;
    case "letter":
      return f.launched
        ? `${f.day}: ${plural(Number(f.locked), "job")} locked, ${plural(Number(f.settled), "job")} settled, ${plural(Number(f.advances), "advance")} drawn for ${f.advancedEth} ETH, ${f.burns} burns. The pool holds ${f.poolEth} ETH, ${f.outEth} ETH of it out with agents.`
        : `${f.day}: the desk read Robinhood Chain all day, from block ${f.firstBlock} to block ${f.lastBlock}, gas at ${f.gwei} gwei. Nothing was locked, drawn or burned: the desk opens at the launch.`;
  }
}

/** Every number a note of these facts may use, as it may be written. */
export function allowedNumbers(f: Facts): Set<string> {
  const out = new Set<string>();
  const add = (s: string) => { out.add(s); out.add(s.replace(/,/g, "")); const n = Number(s.replace(/,/g, "")); if (Number.isFinite(n)) { out.add(String(n)); out.add(n.toLocaleString("en-US")); } };
  for (const v of Object.values(f)) {
    if (typeof v === "number") add(String(v));
    else if (typeof v === "string") for (const m of v.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) add(m);
  }
  // the rules every note may say: half a job, the 1% fee, 1000 for the score, the 24 hours to accept
  for (const r of ["50", "1", "1000", "24", "12", "100"]) out.add(r);
  return out;
}

const NEVER = /\b(invest(ment|ing|or)?s?|returns?|profits?|yields?|guarantee[ds]?)\b|—/i;

/** Whether a worded note keeps to its facts: every number in it is one of them, and no word the site never says. */
export function keepsToFacts(text: string, f: Facts): boolean {
  if (!text.trim() || NEVER.test(text) || text.length > 700) return false;
  const allowed = allowedNumbers(f);
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).every((n) => allowed.has(n) || allowed.has(n.replace(/,/g, "")) || allowed.has(n.replace(/\.$/, "")));
}

// ---------- the wording ----------

export interface Worded { text: string; input: number; output: number }
export type Writer = (system: string, user: string) => Promise<Worded>;

/** The model maker's Messages API, with the owner's key. */
export function anthropicWriter(key: string, model: string, upstream = "https://api.anthropic.com"): Writer {
  return async (system, user) => {
    const res = await fetch(`${upstream.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 300, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`the model maker answered ${res.status}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    return { text: (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim(), input: Number(body.usage?.input_tokens ?? 0), output: Number(body.usage?.output_tokens ?? 0) };
  };
}

const VOICE = `You are the Desk, Factor's credit officer. Factor advances AI agents up to half of a payment their customer has
already locked; the job pays it back. You write short public notes in the voice of a careful banker: plain, exact, calm,
a little dry, never selling anything. Rules you never break:
- Use only the numbers in FACTS, written exactly as they are there. Never do arithmetic: no halves, sums, differences,
  percentages or estimates of your own. If a sentence would need a number that is not in FACTS, say it in words.
- An advance is drawn against a job a customer has already locked and paid into the contract, never against future work.
- Do not give advice, do not predict, do not praise. Say what the record shows and what follows from the rules.
- Never use the words invest, returns, profit, yield or guarantee. No em dashes, no emojis, no headings, no lists.`;

const ASK: Record<NoteKind, string> = {
  opening: "Write this agent's opening credit file in two sentences: what it does, and that with no record yet it can draw only what its bond covers and never more than half of a job. Use no numbers at all.",
  file: "Write this agent's credit file in two to four sentences: what its record shows, and so what it may draw and why.",
  reason: "Write one or two sentences saying why this advance was allowed.",
  letter: "Write the Desk's daily letter in three to five sentences: what the desk saw that day, and anything it is watching.",
};

/** Dollars per million tokens of the Desk's model, for the day's ceiling. The cheap model when it is not listed. */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5-20251001": { in: 1, out: 5 }, "claude-sonnet-5-5": { in: 2, out: 10 }, "claude-opus-5-5": { in: 4, out: 20 },
};

export interface DeskOptions {
  writer?: Writer | null;
  model?: string;
  dailyUsd?: number;
  now?: () => number;
}

export class DeskMind {
  private writer: Writer | null;
  readonly model: string;
  private dailyUsd: number;
  private now: () => number;
  writing = false;

  constructor(private sqlite: Database.Database, o: DeskOptions = {}) {
    sqlite.exec(SCHEMA);
    this.writer = o.writer ?? null;
    this.model = o.model ?? "claude-haiku-4-5-20251001";
    this.dailyUsd = o.dailyUsd ?? 2;
    this.now = o.now ?? Date.now;
  }

  /** Whether a note written now may be worded by the model: there is a key, and the day's ceiling is not reached. */
  canWord(): boolean {
    return !!this.writer && this.spentToday() < this.dailyUsd;
  }

  /** What today's worded notes cost so far. */
  spentToday(): number {
    const day = Math.floor(this.now() / 86_400_000) * 86_400_000;
    return (this.sqlite.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM desk_notes WHERE at >= ?").get(day) as { s: number }).s;
  }

  /** Write one note: worded by the model when it may be and keeps to its facts, else plainly. Kept, and returned. */
  async write(kind: NoteKind, subject: string, facts: Facts): Promise<Note> {
    let text = plainText(kind, facts), model: string | null = null, cost = 0;
    if (this.writer && this.spentToday() < this.dailyUsd) {
      this.writing = true;
      try {
        const w = await this.writer(VOICE, `${ASK[kind]}\n\nFACTS:\n${Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join("\n")}`);
        const p = PRICES[this.model] ?? PRICES["claude-haiku-4-5-20251001"]!;
        cost = (w.input * p.in + w.output * p.out) / 1_000_000;
        if (keepsToFacts(w.text, facts)) { text = w.text; model = this.model; }
      } catch {
        // the plain version stands
      } finally {
        this.writing = false;
      }
    }
    const at = this.now();
    const r = this.sqlite.prepare("INSERT INTO desk_notes (kind, subject, text, facts, model, cost_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(kind, subject, text, JSON.stringify(facts), model, cost, at);
    return { id: Number(r.lastInsertRowid), kind, subject, text, facts, model, costUsd: cost, at };
  }

  /** The newest note of a kind about a subject. */
  latest(kind: NoteKind, subject: string): Note | null {
    const r = this.sqlite.prepare("SELECT * FROM desk_notes WHERE kind = ? AND subject = ? ORDER BY at DESC, id DESC LIMIT 1").get(kind, subject) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  /** The newest notes, newest first; of some kinds only when they are given. */
  recent(limit: number, kinds?: NoteKind[]): Note[] {
    const rows = kinds?.length
      ? this.sqlite.prepare(`SELECT * FROM desk_notes WHERE kind IN (${kinds.map(() => "?").join(",")}) ORDER BY at DESC, id DESC LIMIT ?`).all(...kinds, limit)
      : this.sqlite.prepare("SELECT * FROM desk_notes ORDER BY at DESC, id DESC LIMIT ?").all(limit);
    return (rows as Row[]).map(fromRow);
  }
}

type Row = { id: number; kind: NoteKind; subject: string; text: string; facts: string; model: string | null; cost_usd: number; at: number };
const fromRow = (r: Row): Note => ({ id: r.id, kind: r.kind, subject: r.subject, text: r.text, facts: JSON.parse(r.facts) as Facts, model: r.model, costUsd: r.cost_usd, at: r.at });

/** Whether the Desk writes at all. */
export const deskOn = (env: Record<string, string | undefined>): boolean => (env.DESK_MIND ?? "on").trim().toLowerCase() !== "off";
