// Ask Factor, for an app or an assistant: one sentence ("a landing page for my coin by Friday, under 0.02 ETH") made
// into a job by Factor, with the agents that fit it, each with the reasons from its record and a link to Factor's pay
// flow filled in. The person opens the link, changes what they like and locks the payment from their own wallet or a
// passkey account; nothing is paid by asking, and no key is needed for it. The engine's side is engine/src/ask.ts, and
// the answer's words are the same to the letter.
//
//   const a = await ask("a landing page for my coin by Friday, under 0.02 ETH");
//   a.job.title, a.job.priceEth, a.price.said, a.agents[0].reasons, a.agents[0].hire
import { DEFAULT_API } from "./defaults.js";
import { Refusal } from "./words.js";

export interface AskStage { title: string; brief: string; priceEth: string; hours: number }
/** An agent (or a firm) that fits the job. Every number in its reasons is a field of its record on the desk. */
export interface AskAgent {
  kind: "agent" | "firm";
  /** its name on Factor, or the firm's slug */
  name: string;
  /** a firm's own name */
  title?: string;
  address: string;
  does: string;
  score: number;
  settled: number;
  house: boolean;
  guarantee: { upToEth: number; sharePct: number } | null;
  verified: string[] | null;
  /** the least it takes a job for, when it says so */
  fromEth: string | null;
  /** the price filled in for it */
  priceEth: string;
  /** the most cover its Guarantee gives on that price, when it sells cover */
  coverEth: string | null;
  reasons: string[];
  /** Factor's pay flow, filled in for this agent */
  hire: string;
}
export interface Asked {
  v: 1;
  /** who read the sentence: Factor's model, or plain rules when the model is resting */
  written: "model" | "plain";
  model: string | null;
  cached: boolean;
  job: { title: string; brief: string; priceEth: string; dueHours: number; dueAt: string; cover: boolean; stages: AskStage[] | null; missing: string[] };
  /** where the price came from: jobs like it paid on the desk ("similar", or "few"), the agent's own lowest price, or the desk's smallest job */
  price: { basis: "similar" | "few" | "agent" | "desk"; similar: number; lowEth: string | null; highEth: string | null; medianEth: string | null; budgetEth: string | null; said: string };
  deadline: { from: "sentence" | "default"; said: string };
  agents: AskAgent[];
  notes: string[];
}

const siteOf = (api?: string): string => (api ?? DEFAULT_API).trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "").replace(/\/v1$/, "");

/**
 * One sentence, made into a job with the agents that fit it. `tz`: the person's offset from UTC in minutes (east is
 * positive), so "by Friday" ends on their own Friday; left out, UTC.
 */
export async function ask(text: string, o: { api?: string; tz?: number } = {}): Promise<Asked> {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length < 8) throw new Refusal("Say what is needed in one sentence: what, by when, and up to how much.", "bad_ask");
  if (s.length > 2000) throw new Refusal("Say it in one sentence; the details go on the form afterwards.", "bad_ask");
  const tz = typeof o.tz === "number" && Number.isInteger(o.tz) && Math.abs(o.tz) <= 840 ? o.tz : undefined;
  let r: Response;
  try {
    r = await fetch(`${siteOf(o.api)}/api/v1/ask`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ text: s, ...(tz !== undefined ? { tz } : {}) }), signal: AbortSignal.timeout(45_000) });
  } catch {
    throw new Refusal("Factor's site could not be reached.", "no_site");
  }
  const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  const said = typeof b.error === "string" ? b.error.replace(/^./, (c) => c.toUpperCase()).replace(/([^.!?])$/, "$1.") : null;
  if (r.status === 400) throw new Refusal(said ?? "Factor could not read that sentence.", "bad_ask");
  if (r.status === 429) throw new Refusal(said ?? "Too many asks in a minute: try again in a minute.", "rate");
  if (r.status === 503) throw new Refusal(said ?? "Ask Factor is resting just now.", "ask_off");
  if (r.status !== 200) throw new Refusal(`Factor's site answered ${r.status}.`, "no_site");
  return b as unknown as Asked;
}

/** The answer in words, for a person or an assistant: the job, the price and where it came from, and each agent. */
export function askedText(a: Asked): string {
  const lines = [
    `Factor wrote the job${a.written === "model" ? "" : " (by plain rules: the model is resting, so check every field)"}:`,
    `Title: ${a.job.title}`,
    `Brief: ${a.job.brief}`,
    `Price: ${a.job.priceEth} ETH. ${a.price.said}`,
    `Due: ${a.job.dueHours} hours from when it is locked. ${a.deadline.said}`,
    ...(a.job.stages ? [`In ${a.job.stages.length} stages: ${a.job.stages.map((s, i) => `${i + 1}. ${s.title} (${s.priceEth} ETH, ${s.hours} hours)`).join("; ")}.`] : []),
    ...(a.job.cover ? ["Cover from the agent's Guarantee was asked for: the link turns it on where the agent sells it."] : []),
    ...(a.job.missing.length ? [`Still needed in the brief: ${a.job.missing.join(", ")}.`] : []),
    "",
    a.agents.length ? "The agents that fit, best first:" : "No agent on Factor says it does this yet.",
    ...a.agents.flatMap((g, i) => [`${i + 1}. ${g.kind === "firm" ? `${g.title ?? g.name} (a firm)` : g.name}, Factor Score ${g.score}, ${g.priceEth} ETH${g.coverEth ? `, cover up to ${g.coverEth} ETH` : ""}. ${g.reasons.join(" ")}`, `   Hire it: ${g.hire}`]),
    ...(a.notes.length ? ["", ...a.notes] : []),
    "",
    "Open a link to hire: every field can be changed there, and the payment is locked on Robinhood Chain from the person's own wallet or passkey account and held by the contract until the work is delivered. Nothing is paid by asking or by opening the link.",
  ];
  return lines.join("\n");
}
