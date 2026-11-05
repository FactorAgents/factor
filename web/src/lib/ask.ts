// Ask Factor on the site (engine/src/ask.ts): the shape of an answer, the sentences offered to try, and the hire form's
// address built from what the customer kept or changed. Nothing here is hired: the hire form is the existing one, and
// the customer locks the job there from their own wallet or passkey account.

export interface AskStage { title: string; brief: string; priceEth: string; hours: number }
export interface AskAgent {
  kind: "agent" | "firm";
  name: string;
  title?: string;
  address: string;
  does: string;
  score: number;
  settled: number;
  house: boolean;
  guarantee: { upToEth: number; sharePct: number } | null;
  verified: string[] | null;
  fromEth: string | null;
  priceEth: string;
  coverEth: string | null;
  reasons: string[];
  hire: string;
}
export interface AskAnswer {
  v: 1;
  written: "model" | "plain";
  model: string | null;
  cached: boolean;
  job: { title: string; brief: string; priceEth: string; dueHours: number; dueAt: string; cover: boolean; stages: AskStage[] | null; missing: string[] };
  price: { basis: "similar" | "few" | "agent" | "desk"; similar: number; lowEth: string | null; highEth: string | null; medianEth: string | null; budgetEth: string | null; said: string };
  deadline: { from: "sentence" | "default"; said: string };
  agents: AskAgent[];
  notes: string[];
}

/** Sentences a visitor can try with one press. */
export const TRIES = [
  "A landing page for my coin by Friday, under 0.02 ETH",
  "A price sheet of ETH, NVDA and TSLA from Chainlink, today",
  "Proofread my launch post and list every change, with a guarantee",
];

/** What the hire form gets: the agent, the job as the customer left it, and stages when it is in parts. */
export interface HireDraft { agent: AskAgent; title: string; brief: string; priceEth: string; hours: number; cover: boolean; stages: AskStage[] | null }

/** The existing hire form's address, filled in from the draft: every field can still be changed there. */
export function hireHref(d: HireDraft): string {
  const q = new URLSearchParams();
  if (d.agent.kind === "firm") q.set("firm", d.agent.name);
  else q.set("agent", d.agent.name);
  q.set("price", d.priceEth.trim());
  if (d.title.trim()) q.set("title", d.title.trim().slice(0, 80));
  if (d.brief.trim()) q.set("brief", d.brief.trim().slice(0, 2000));
  q.set("due", String(d.hours));
  if (d.cover) q.set("cover", "1");
  if (d.stages?.length) {
    q.set("stages", "1");
    q.set("plan", JSON.stringify(d.stages.map((s) => [s.title, s.brief, s.priceEth, s.hours])));
  }
  q.set("via", "ask");
  return `/hire?${q}`;
}

/** The stages a hire link carries, checked: 2 to 6, each a title, a brief, a price and whole hours. Null when they are not. */
export function stagesFromLink(raw: string | undefined): AskStage[] | null {
  if (!raw || raw.length > 20_000) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v) || v.length < 2 || v.length > 6) return null;
    const out: AskStage[] = [];
    for (const x of v) {
      if (!Array.isArray(x) || x.length !== 4) return null;
      const [title, brief, priceEth, hours] = x as unknown[];
      if (typeof title !== "string" || typeof brief !== "string" || typeof priceEth !== "string" || !/^\d{1,6}(\.\d{1,18})?$/.test(priceEth) || typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 720) return null;
      out.push({ title: title.slice(0, 80), brief: brief.slice(0, 2000), priceEth, hours });
    }
    return out;
  } catch {
    return null;
  }
}

/** Hours, the way the form says a time. */
export const hoursWord = (h: number): string => (h % 24 === 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h} hour${h === 1 ? "" : "s"}`);
