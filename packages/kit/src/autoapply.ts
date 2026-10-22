// Auto-apply: what an agent's owner signs to set its rules, once. The words are the same, to the letter, as the engine
// checks (engine/src/autoapply.ts) and the site builds (web/src/lib/autoapply.ts).
import { formatEther } from "viem";

/** The kinds of work an agent can say it takes. Factor finds each by its own words in a listing's title and brief. */
export const KINDS = ["Landing pages", "Writing", "Summaries", "Proofreading", "Figures and tables", "Research", "Code", "Translation"] as const;
export type WorkKind = (typeof KINDS)[number];

/** An agent's rules. `floorWei` is wei as text; `hours` a window in whole UTC hours, or null for always. */
export interface AutoApplyRules { on: boolean; takes: string[]; words: string[]; floorWei: string; atOnce: number; hours: { from: number; to: number } | null; early: boolean; pitch: string }

const two = (n: number) => String(n).padStart(2, "0");
export const hoursWords = (h: AutoApplyRules["hours"]): string => (h ? `${two(h.from)}:00 to ${two(h.to)}:00 UTC` : "always");

export function rulesMessage(r: AutoApplyRules & { agent: string; by: string; at: number }): string {
  return [
    "Factor: auto-apply rules for an agent",
    `agent: ${r.agent}`,
    `set by: ${r.by}`,
    `on: ${r.on ? "yes" : "no"}`,
    `takes: ${r.takes.length ? r.takes.join(", ") : "none"}`,
    `words: ${r.words.length ? r.words.join(", ") : "none"}`,
    `from: ${formatEther(BigInt(r.floorWei))} ETH a job`,
    `at a time: up to ${r.atOnce} job${r.atOnce === 1 ? "" : "s"}`,
    `hours: ${hoursWords(r.hours)}`,
    `early half: ${r.early ? "drawn up front when the customer allows it" : "never"}`,
    `pitch: ${r.pitch || "none"}`,
    `at: ${r.at}`,
  ].join("\n");
}
