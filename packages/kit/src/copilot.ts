// Factor Copilot, for an app or an assistant: a chat that runs Factor's desk from plain sentences. Each message goes to
// Factor, which asks for what is missing, answers from the desk, and hands back a prepared, unsigned action when there is
// one: its calls (contract, function, value, data), a summary in plain words, and what was checked. Nothing is paid or
// signed by asking, and no key is needed for it. The person signs the action in their own wallet, on Factor's site (the
// conversation's link) or in the app's own wallet flow. The engine's side is engine/src/copilot.ts.
//
//   let c = await copilot("I need a price sheet of ETH and NVDA by tomorrow");
//   c = await copilot("0.002 ETH at most", { conversation: c.conversation });
//   c.reply.text, c.reply.action?.calls, c.reply.action?.lines
import { DEFAULT_API } from "./defaults.js";
import { Refusal } from "./words.js";

/** One call of a prepared action: unsigned, as it is sent to the contract. */
export interface CopilotCall { to: string; contract: "desk" | "guarantee" | "bounty" | "milestones"; fn: string; data: string; value: string; does: string }
export interface CopilotAction {
  id: string;
  kind: "hire" | "hire_cover" | "accept" | "accept_stage" | "bounty" | "milestones" | "back";
  /** what signing it does, in a line */
  title: string;
  /** what it does, how much, to whom, which contract */
  lines: [string, string][];
  calls: CopilotCall[];
  /** what is signed for free or sent after the calls: the brief, a bounty's words, the stages' words */
  after: { brief?: { title: string; brief: string }; task?: string; terms?: string; bind?: boolean } | null;
  totalWei: string;
  agent: { name: string; address: string } | null;
  job: number | null;
  chainId: number;
  expiresAt: string;
  checked: string[];
}
export interface CopilotReply {
  text: string;
  kind: "question" | "answer" | "action" | "refusal";
  facts: string[];
  agents: { name: string; score: number; settled: number; priceEth: string; reasons: string[] }[];
  action: CopilotAction | null;
  /** a job this chat follows: read it with factor_job, or on its page */
  follow: number | null;
  choices: string[];
}
export interface Copiloted { v: 1; conversation: string; written: "model" | "plain"; model: string | null; intent: string | null; reply: CopilotReply }

const siteOf = (api?: string): string => (api ?? DEFAULT_API).trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "").replace(/\/v1$/, "");

/**
 * One message to Copilot. `conversation`: the id of the chat it answers, from the last answer. `address`: the person's
 * wallet, so Copilot can read their jobs and check an accept is theirs. `tz`: their offset from UTC in minutes.
 */
export async function copilot(text: string, o: { api?: string; conversation?: string; address?: string; tz?: number } = {}): Promise<Copiloted> {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) throw new Refusal("Say what is needed, in plain words.", "bad_copilot");
  if (s.length > 2000) throw new Refusal("Say it in a sentence or two.", "bad_copilot");
  const tz = typeof o.tz === "number" && Number.isInteger(o.tz) && Math.abs(o.tz) <= 840 ? o.tz : undefined;
  const conversation = typeof o.conversation === "string" && /^[0-9a-f]{32}$/.test(o.conversation) ? o.conversation : undefined;
  const address = typeof o.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(o.address) ? o.address.toLowerCase() : undefined;
  let r: Response;
  try {
    r = await fetch(`${siteOf(o.api)}/api/v1/copilot`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ text: s, ...(conversation ? { conversation } : {}), ...(address ? { address } : {}), ...(tz !== undefined ? { tz } : {}) }), signal: AbortSignal.timeout(45_000) });
  } catch {
    throw new Refusal("Factor's site could not be reached.", "no_site");
  }
  const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  const said = typeof b.error === "string" ? b.error.replace(/^./, (c) => c.toUpperCase()).replace(/([^.!?])$/, "$1.") : null;
  if (r.status === 400) throw new Refusal(said ?? "Factor could not read that message.", "bad_copilot");
  if (r.status === 429) throw new Refusal(said ?? "Too many messages in a minute: try again in a minute.", "rate");
  if (r.status === 503) throw new Refusal(said ?? "Factor Copilot is resting just now.", "copilot_off");
  if (r.status !== 200) throw new Refusal(`Factor's site answered ${r.status}.`, "no_site");
  return b as unknown as Copiloted;
}

const ETH = (wei: string): string => { const n = BigInt(wei); const w = n / 10n ** 18n; const f = (n % 10n ** 18n).toString().padStart(18, "0").slice(0, 8).replace(/0+$/, ""); return f ? `${w}.${f}` : `${w}`; };

/** The reply in words, for a person or an assistant: what Copilot said, the facts, the agents, and a prepared action's card. */
export function copilotText(c: Copiloted, o: { api?: string } = {}): string {
  const r = c.reply;
  const lines = [r.text];
  if (r.facts.length) lines.push("", ...r.facts.map((f) => `- ${f}`));
  if (r.agents.length) lines.push("", ...r.agents.map((a, i) => `${i + 1}. ${a.name}, Factor Score ${a.score}, ${a.priceEth} ETH. ${a.reasons.join(" ")}`));
  if (r.action) {
    const a = r.action;
    lines.push("", `Prepared, not signed: ${a.title}`, ...a.lines.map(([k, v]) => `${k}: ${v}`), `In all: ${ETH(a.totalWei)} ETH, in ${a.calls.length === 1 ? "one transaction" : `${a.calls.length} transactions`} on Robinhood Chain (chain ${a.chainId}).`);
    lines.push(...a.calls.map((x, i) => `Call ${i + 1}: ${x.fn} on ${x.to} (${x.contract}), value ${ETH(x.value)} ETH. ${x.does}`));
    lines.push(`Good until ${a.expiresAt}. To sign it, open ${siteOf(o.api)}/copilot?c=${c.conversation} and press Sign in wallet; the person's own wallet confirms it there. Nothing is paid until they do.`);
  }
  if (r.choices.length) lines.push("", `They can answer: ${r.choices.map((x) => `"${x}"`).join(", ")}.`);
  lines.push("", `Conversation: ${c.conversation} (pass it with the next message).`);
  return lines.join("\n");
}
