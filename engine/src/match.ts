// "Just say what you need": a customer writes the job in plain words, and this picks the agent on the desk that
// fits it, says its price, and writes the brief the way that agent asks for one. The customer then locks the job
// themselves, as always: nothing here moves money or hires anybody.
//
// The model only chooses among the agents it is shown and words the brief from what the customer wrote. It is told
// to add no fact of its own: what an agent needs and the customer did not say is left as a [placeholder] and listed,
// so the customer fills it in. Its answer is checked before anybody sees it: an agent that is not on the list, or an
// answer that is not the JSON asked for, is no answer.
//
// A day's spending is capped (MATCH_DAILY_USD, 1 by default): past it the box says to pick an agent by hand until
// the next day. The same words asked again within ten minutes get the same answer without a second call.

import type { Ask } from "./activity.js";

export interface Candidate {
  name: string;
  does: string;
  /** what its brief must contain, for an agent that says so (Factor's own) */
  needs?: string;
  /** the least it takes a job for, when it has a price of its own */
  fromEth?: number | null;
}

export interface Match {
  agent: string | null;
  fromEth: number | null;
  brief: string;
  why: string;
  missing: string[];
}

export type MatchAnswer = { ok: true; match: Match; cached: boolean } | { ok: false; status: number; error: string };

export interface MatcherOptions {
  ask: Ask;
  /** dollars per million tokens, in and out */
  price?: { in: number; out: number };
  dailyUsd?: number;
  now?: () => number;
}

const SYSTEM = `You match a customer's job to one agent on Factor, a desk where AI agents take paid jobs.

You are given the agents, each with its name, what it does and, for some, what its brief must contain. Choose the ONE agent that fits the job best, and write the brief that agent will get.

Rules:
- Choose only a name from the list, written exactly as it is there. If no agent on the list can do the job, choose null.
- The brief is the message the customer sends to the agent. Write it from what the customer wrote, in plain words, in the order the agent's brief must follow. Never copy the agent's own description or its "brief must contain" text into the brief.
- Add nothing the customer did not say: no facts, audience, purpose, names, numbers, dates, prices or text of your own. Keep the customer's own words where you can.
- Where the agent needs something the customer did not give (including a thing the customer mentions but did not supply, like "with the opening hours"), put a short placeholder in square brackets in the brief, like [the opening hours], and list it under "missing".
- If the customer pasted text, code or data for the job, keep it in the brief word for word.
- "why" is one short sentence for the customer saying why this agent fits. If you chose null, say what kind of agent the job would need.
- No long dashes. No emojis.

Answer with JSON only, nothing before or after it:
{"agent": "<name or null>", "brief": "<the brief>", "why": "<one sentence>", "missing": ["<what is missing>"]}`;

const TEN_MIN = 10 * 60_000;
const day = (ms: number) => Math.floor(ms / 86_400_000);

/** The first JSON object in a model's answer, or null. */
function jsonOf(text: string): Record<string, unknown> | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// A small model sometimes copies the agent's own "what the brief must contain" into the brief: every sentence of it is
// taken out again, so the agent gets the customer's words and nothing of its own instructions.
function withoutNeeds(brief: string, needs?: string): string {
  if (!needs) return brief;
  let out = brief.split(needs).join(" ");
  for (const sentence of needs.split(/(?<=[.!?:])\s+/).map((x) => x.trim()).filter((x) => x.length > 12)) out = out.split(sentence).join(" ");
  return out.replace(/[ \t]{2,}/g, " ").replace(/^\s+/gm, "").trim();
}

const clean = (s: string, most: number) => s.replace(/[\u2014\u2013]/g, ",").replace(/\s+\n/g, "\n").trim().slice(0, most);

export class Matcher {
  private spent = 0;
  private spentDay = -1;
  private memo = new Map<string, { at: number; match: Match }>();
  private readonly dailyUsd: number;
  private readonly now: () => number;

  constructor(private o: MatcherOptions) {
    this.dailyUsd = o.dailyUsd ?? 1;
    this.now = o.now ?? Date.now;
  }

  /** What today's matching has cost so far, in dollars. */
  spentToday(): number {
    return day(this.now()) === this.spentDay ? this.spent : 0;
  }

  async match(text: string, candidates: Candidate[]): Promise<MatchAnswer> {
    const words = text.replace(/\s+/g, " ").trim();
    if (words.length < 8) return { ok: false, status: 400, error: "say a little more about the job: what it is and what you want back" };
    if (text.length > 4000) return { ok: false, status: 400, error: "that is too long to match: say what the job is in a few lines, and paste the material into the brief afterwards" };
    if (!candidates.length) return { ok: false, status: 503, error: "there are no agents on the desk to match yet" };

    const key = words.toLowerCase();
    const hit = this.memo.get(key);
    if (hit && this.now() - hit.at < TEN_MIN) return { ok: true, match: hit.match, cached: true };

    const today = day(this.now());
    if (today !== this.spentDay) { this.spentDay = today; this.spent = 0; }
    if (this.spent >= this.dailyUsd) return { ok: false, status: 429, error: "matching is resting until tomorrow: pick an agent from the list for now" };

    const list = candidates.map((c) => `- ${c.name}: ${c.does}${c.needs ? ` (its brief must contain: ${c.needs})` : ""}`).join("\n");
    let got: Awaited<ReturnType<Ask>>;
    try {
      got = await this.o.ask(SYSTEM, `The agents:\n${list}\n\nThe customer wrote:\n"""\n${text.trim()}\n"""`, 1500);
    } catch {
      return { ok: false, status: 502, error: "matching did not answer just now: try again, or pick an agent from the list" };
    }
    const p = this.o.price ?? { in: 1, out: 5 };
    this.spent += (got.input * p.in + got.output * p.out) / 1e6;

    const j = jsonOf(got.text);
    if (!j) return { ok: false, status: 502, error: "matching gave no usable answer: try again, or pick an agent from the list" };
    const wanted = typeof j.agent === "string" ? j.agent.trim().toLowerCase() : null;
    const chosen = wanted ? candidates.find((c) => c.name.toLowerCase() === wanted) ?? null : null;
    if (wanted && !chosen) return { ok: false, status: 502, error: "matching named an agent that is not on the desk: try again, or pick one from the list" };
    const match: Match = {
      agent: chosen?.name ?? null,
      fromEth: chosen?.fromEth ?? null,
      brief: chosen && typeof j.brief === "string" ? clean(withoutNeeds(j.brief, chosen.needs), 6000) : "",
      why: typeof j.why === "string" ? clean(j.why, 280) : "",
      missing: Array.isArray(j.missing) ? j.missing.filter((m): m is string => typeof m === "string" && !!m.trim()).map((m) => clean(m, 120)).slice(0, 6) : [],
    };
    if (chosen && !match.brief) return { ok: false, status: 502, error: "matching gave no brief: try again, or pick an agent from the list" };
    this.memo.set(key, { at: this.now(), match });
    if (this.memo.size > 2_000) this.memo.clear();
    return { ok: true, match, cached: false };
  }
}

export const matchOn = (env: Record<string, string | undefined>): boolean => (env.MATCH ?? "on").trim().toLowerCase() !== "off";
