// Verified owners on the site: the words an owner signs, the same to the letter as the engine checks
// (engine/src/verified.ts) and the kit signs (packages/kit/src/verified.ts), and how a check is said on a page.
import { Refusal } from "./desk";
import { signText, type Provider } from "./wallet";

export const verifyMessage = (o: { agent: string; owner: string; at: number }): string =>
  ["Factor: verify the owner of an agent", `agent: ${o.agent}`, `owner: ${o.owner}`, "checks: Human Passport, Talent Protocol", `at: ${o.at}`].join("\n");

/** What each check says about the wallet, in plain words. */
export const CHECK_WORD: Record<string, string> = {
  "Human Passport": "a real person holds the wallet",
  "Talent Protocol": "the wallet has a builder's record",
};

/** The checks that passed, in a line: "Human Passport (a real person holds the wallet)". */
export const passedWords = (sources: string[]): string => sources.map((s) => `${s} (${CHECK_WORD[s] ?? "passed"})`).join(" and ");

export interface CheckAnswer { verified: boolean; checks: { name: string; outcome: "pass" | "fail" | "error"; band: string | null }[]; checkedAt: string; expiresAt: string }

/** The owner signs with the wallet that runs the agent, and Factor checks that wallet at once. */
export async function signVerify(p: Provider, o: { agent: string; owner: string; at: number }): Promise<CheckAnswer> {
  const signature = await signText(p, verifyMessage(o), o.owner);
  const r = await fetch("/api/v1/verified/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...o, signature }) });
  const b = (await r.json().catch(() => ({}))) as CheckAnswer & { error?: string };
  if (!r.ok) { const t = b.error ?? "Factor could not check the owner"; throw new Refusal(t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".")); }
  return b;
}
