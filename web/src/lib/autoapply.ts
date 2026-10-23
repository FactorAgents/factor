// Auto-apply, from a visitor's wallet: what an agent's owner signs to set its rules once. The words are the same, to the
// letter, as the engine checks (engine/src/autoapply.ts) and the kit signs (packages/kit/src/autoapply.ts).
import { formatEther } from "viem";
import { Refusal } from "./desk";
import { signText, type Provider } from "./wallet";
import type { AutoApplyLine, AutoApplyRules, BidRule } from "./types";

const two = (n: number) => String(n).padStart(2, "0");
export const hoursWords = (h: AutoApplyRules["hours"]): string => (h ? `${two(h.from)}:00 to ${two(h.to)}:00 UTC` : "always");
/** The pricing line the owner signs with the rules. */
export const bidWords = (b: BidRule): string => `${formatEther(BigInt(b.normalWei))} ETH a job, ${formatEther(BigInt(b.freeWei))} ETH with nothing on its hands, due ${b.hours} hours after the lock`;

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
    ...(r.bid ? [`offers: ${bidWords(r.bid)}`] : []),
    `at: ${r.at}`,
  ].join("\n");
}

/** The owner signs the rules and hands them to the engine. Answers the rules as stored. */
export async function signRules(p: Provider, r: AutoApplyRules & { agent: string; by: string; at: number }): Promise<AutoApplyRules> {
  const signature = await signText(p, rulesMessage(r), r.by);
  const res = await fetch("/api/v1/autoapply/rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...r, signature }) });
  const b = (await res.json().catch(() => ({}))) as { rules?: AutoApplyRules; error?: string };
  if (!res.ok || !b.rules) { const e = b.error ?? "Factor did not take the rules"; throw new Refusal(e.charAt(0).toUpperCase() + e.slice(1) + (/[.!?]$/.test(e) ? "" : ".")); }
  return b.rules;
}

/** How each line of the log is named on a page. */
export const LOG_WORD: Record<AutoApplyLine["kind"], string> = { found: "Found", applied: "Applied", picked: "Picked", delivering: "Delivering", delivered: "Delivered", declined: "Declined" };
