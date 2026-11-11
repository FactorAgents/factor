// The work in the demo, with no paid API anywhere: a stub model that writes a draft from the brief, a stub
// checker that reads the draft line by line, and the two agents' prices. Everything here is deterministic, so a
// run can be checked against its fingerprints on the chain.

import { near, fmtNear, sha256 } from "../lib/near.ts";

export const BRIEF = [
  "Factor brief: a one-page note for an agent team.",
  "Question: how does an AI agent fund a job on NEAR from another chain?",
  "Cover: the 1Click quote, the deposit address, the status values, and where the money lands.",
  "Length: under 300 words. Plain sentences. Mark every claim that needs a source.",
].join("\n");

export const briefHash = (text: string = BRIEF): string => sha256(text);

/**
 * The stub model the agent pays compute for. It does not call any model: it builds the draft from the brief so the
 * demo spends nothing outside testnet. A real agent would call its model here with the advance it drew.
 */
export function stubModel(brief: string): { text: string; tokens: number } {
  const question = brief.split("\n").find((l) => l.startsWith("Question:"))?.slice(10).trim() ?? "the question";
  const text = [
    `Note: ${question}`,
    "1. The agent asks 1Click for a quote naming the asset it holds and the asset the job is priced in. [source: 1Click API, POST /v0/quote]",
    "2. The quote gives a deposit address on the agent's own chain and a deadline. [source: 1Click API, quote.depositAddress]",
    "3. The agent sends the amount to that address; solvers fill the swap through NEAR Intents. [source: NEAR Intents docs]",
    "4. GET /v0/status moves from PENDING_DEPOSIT to PROCESSING to SUCCESS, or to REFUNDED. [source: 1Click API, /v0/status]",
    "5. On SUCCESS the tokens arrive on NEAR with a message that locks the job on the desk in the same transfer. [source: Factor desk, ft_on_transfer]",
  ].join("\n");
  return { text, tokens: text.split(/\s+/).length * 4 };
}

/** What the sub-agent does for its part: it checks each numbered claim carries a source. */
export function stubCheck(draft: string): { text: string; passed: boolean } {
  const claims = draft.split("\n").filter((l) => /^\d+\./.test(l));
  const lines = claims.map((l) => `${l.slice(0, 2)} ${/\[source: [^\]]+\]/.test(l) ? "sourced" : "NO SOURCE"}`);
  const passed = lines.every((l) => l.endsWith("sourced"));
  return { text: [`Check of ${claims.length} claims`, ...lines, passed ? "Verdict: every claim names its source." : "Verdict: claims without a source."].join("\n"), passed };
}

// ── prices ──────────────────────────────────────────────────────────────────────────────────────────────

export const COMPUTE_PRICE = near("0.3"); // what the stub model's provider charges for the draft

/** The checker's ask and the least it takes. */
export const CHECKER = { ask: near("0.5"), floor: near("0.35") };

/**
 * The agent's one counter-offer. It plans the check at what is left of the job's half after compute, less a margin
 * it keeps for a second compute pass, and says why.
 */
export function counterOffer(half: bigint, spentOnCompute: bigint, ask: bigint): { offer: bigint; why: string } {
  const margin = near("0.3");
  const plan = half - spentOnCompute - margin;
  const offer = plan < ask ? plan : ask;
  const why = `the job can spend ${fmtNear(half)} NEAR before delivery; ${fmtNear(spentOnCompute)} went to compute and ${fmtNear(margin)} stays for a second pass, so the check is worth ${fmtNear(plan)}`;
  return { offer, why };
}

/** The checker's answer to a counter: it takes anything at or above its floor, once. */
export function checkerAnswers(offer: bigint): boolean {
  return offer >= CHECKER.floor;
}
