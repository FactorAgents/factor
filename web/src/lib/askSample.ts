// Ask Factor on the sample (no engine, no model): a sentence read by plain rules against the sample's agents and jobs,
// in the shape the engine answers (engine/src/ask.ts), so the box and the result can be built and looked at alone.
import "server-only";
import type { AskAgent, AskAnswer } from "./ask";
import { sampleState } from "./sample";

const STOP = new Set("a an the and or for of to in on at by with from my our your me i need want please some under over below eth usd today tomorrow friday days hours".split(" "));
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/s$/, "")));

export function sampleAsk(text: string): AskAnswer {
  const s = sampleState();
  const want = words(text);
  const title = text.split(/[,.]/)[0]!.trim().slice(0, 80).replace(/^./, (c) => c.toUpperCase());
  const fits = s.agents.filter((a) => a.named && a.does && !a.barred).map((a) => ({ a, n: [...words(a.does)].filter((w) => want.has(w)).length })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n || y.a.score - x.a.score).slice(0, 3);
  const prices = s.jobs.filter((j) => j.state === "settled" && fits.some((f) => f.a.address === j.agentId)).map((j) => j.priceEth).sort((x, y) => x - y);
  const mid = prices.length ? prices[Math.floor(prices.length / 2)]! : 0.001;
  const price = String(Number(mid.toFixed(4)));
  const agents: AskAgent[] = fits.map(({ a }) => ({
    kind: "agent", name: a.name, address: a.address, does: a.does, score: a.score, settled: a.settled, house: a.house, guarantee: a.guarantee ?? null, verified: a.verifiedOwner?.sources ?? null,
    fromEth: a.service ? String(a.service.fromEth) : null, priceEth: price, coverEth: a.guarantee ? String(Math.min(a.guarantee.upToEth, (mid * a.guarantee.sharePct) / 100)) : null,
    reasons: [`In its own words: "${a.does}"`, a.settled ? `${a.settled} job${a.settled === 1 ? "" : "s"} paid in full for ${a.customers} customer${a.customers === 1 ? "" : "s"}.` : "No job settled on the desk yet: it has no record to go by.", `Factor Score ${a.score} of 1000.`, ...(a.guarantee ? [`Backed by its Guarantee: up to ${a.guarantee.upToEth} ETH of cover on one job.`] : [])],
    hire: "",
  }));
  return {
    v: 1, written: "plain", model: null, cached: false,
    job: { title: title.length >= 3 ? title : "A job", brief: text, priceEth: price, dueHours: 72, dueAt: new Date(Date.now() + 72 * 3_600_000).toISOString(), cover: /guarantee|cover/i.test(text), stages: null, missing: [] },
    price: { basis: prices.length >= 3 ? "similar" : prices.length ? "few" : "desk", similar: prices.length, lowEth: prices.length ? String(prices[0]) : null, highEth: prices.length ? String(prices.at(-1)) : null, medianEth: prices.length ? String(mid) : null, budgetEth: null, said: prices.length ? `${prices.length} job${prices.length === 1 ? "" : "s"} like it were paid in full on the sample's desk.` : "Nothing like it was paid on the sample's desk." },
    deadline: { from: "default", said: "3 days: your sentence names no deadline." },
    agents,
    notes: ["This is the site's sample: no engine is running, so the sentence is read by plain rules."],
  };
}
