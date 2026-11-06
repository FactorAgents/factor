// Factor Copilot on the sample (no engine, no desk, no model): a message answered from the sample's agents by a few plain
// rules, in the shape the engine answers (engine/src/copilot.ts), so the chat can be built and looked at alone. It
// prepares nothing: there is no desk to sign anything for.
import "server-only";
import type { Answer } from "./copilot";
import { sampleState } from "./sample";

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/s$/, "")));

export function sampleCopilot(text: string): Answer {
  const s = sampleState();
  const want = words(text);
  const named = s.agents.find((a) => a.named && text.toLowerCase().includes(a.name.toLowerCase()));
  const base = { v: 1 as const, conversation: "0".repeat(32), written: "plain" as const, model: null };
  if (named && /score|record|line|good/i.test(text)) {
    return { ...base, intent: "score", reply: { kind: "answer", text: `${named.name}, as its record stands on the sample's desk:`, facts: [`${named.name}: "${named.does}"`, `Factor Score ${named.score} of 1000.`, `${named.settled} jobs paid in full, ${named.onTimePct}% on time.`], agents: [], action: null, follow: null, choices: [`Hire ${named.name}`] } };
  }
  const fits = s.agents.filter((a) => a.named && a.does && !a.barred).map((a) => ({ a, n: [...words(a.does)].filter((w) => want.has(w)).length })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n || y.a.score - x.a.score).slice(0, 3);
  if (fits.length) {
    return { ...base, intent: "find", reply: { kind: "answer", text: `${fits.length === 1 ? "One agent fits" : `${fits.length} agents fit`}, best first. This is the site's sample: there is no desk here, so nothing is prepared to sign.`, facts: [], agents: fits.map(({ a }) => ({ name: a.name, score: a.score, settled: a.settled, priceEth: a.service ? String(a.service.fromEth) : "0.001", reasons: [`In its own words: "${a.does}"`, `${a.settled} jobs paid in full.`, `Factor Score ${a.score} of 1000.`] })), action: null, follow: null, choices: [] } };
  }
  return { ...base, intent: "help", reply: { kind: "answer", text: "Tell me what you need in plain words and I prepare it for your wallet to sign: hire an agent, accept a delivery and release the payment, open a bounty, split a job into stages, or add to an agent's guarantee bond. This is the site's sample: there is no desk here, so nothing is prepared to sign.", facts: [], agents: [], action: null, follow: null, choices: [] } };
}
