// Sample figures, in exactly the engine's shape, so every page can be built, looked at and tested with no chain
// behind it. Nothing here is real. It is shown only when FACTOR_SAMPLE=1 (see data.ts): a site with no engine shows
// an empty desk, never these.
import type { Advance, Agent, AgentPage, Burn, FactorState, Job, JobPage, LedgerEvent, Page, Params, ScorePart } from "./types";

// the rulebook's numbers (docs/RULEBOOK.md, section 9)
const params: Params = { advanceMaxPct: 50, advanceFeePct: 1, jobFeePct: 2, graceHours: 12, reviewHours: 24, rejectedPct: 50, reserveMinPct: 20, minJobEth: 0.001 };
// made-up addresses and transaction numbers that look like real ones: the same input always gives the same one
const A = (n: number) => "0x" + ((BigInt(n) + 7n) * 0x9e3779b97f4a7c15f39cc0605cedc8341082276bn % (1n << 160n)).toString(16).padStart(40, "0");
const TX = (n: number) => "0x" + ((BigInt(n) + 11n) * 0xbf58476d1ce4e5b994d049bb133111eb9e3779b97f4a7c15f39cc0605cedc835n % (1n << 256n)).toString(16).padStart(64, "0");
const NOW = Date.UTC(2026, 9, 14, 18, 42, 7);
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
const round = (n: number) => +n.toFixed(6);

// The score by the desk's own formula (FactorDesk.score), so the sample's scores are worked out and never typed in.
function scoreParts(a: { feesPaidEth: number; customers: number; settled: number; advancesRepaid: number; advancesMissed: number }, days: number): ScorePart[] {
  const part = (name: string, value: string, raw: number, max: number): ScorePart => ({ name, value, points: Math.min(max, Math.floor(raw + 1e-9)), max });
  return [
    part("Fees paid into the pool", `${a.feesPaidEth.toFixed(4)} ETH`, a.feesPaidEth / 0.0005, 350),
    part("Different customers", String(a.customers), a.customers * 25, 250),
    part("Jobs settled", String(a.settled), a.settled * 10, 200),
    part("Days since its first job", String(days), days * 2, 100),
    part("Advances repaid", String(a.advancesRepaid), a.advancesRepaid * 10, 100),
  ];
}

// half and missed: jobs settled at half, and [jobs drawn on and not delivered, advances not repaid, jobs left unanswered].
const agent = (name: string, house: boolean, does: string, daysOld: number, settled: number, customers: number, onTimePct: number, volumeEth: number, bondEth: number, drawnEth: number, repaid: number, half: number, missed: [number, number, number], n: number): Agent => {
  const feesPaidEth = round(volumeEth * params.jobFeePct / 100), barred = missed[1] > 0;
  const parts = scoreParts({ feesPaidEth, customers, settled, advancesRepaid: repaid, advancesMissed: missed[1] }, settled ? daysOld : 0);
  const limitEth = barred ? 0 : round(bondEth + feesPaidEth);
  return {
    id: A(n), name, named: true, address: A(n), house, does, since: at(daysOld * 1440), settled, settledAtHalf: half, notDelivered: missed[0], unanswered: missed[2], customers, onTimePct, volumeEth, feesPaidEth, bondEth, drawnEth,
    limitEth, canDrawEth: round(Math.max(0, limitEth - drawnEth)), advancesRepaid: repaid, advancesMissed: missed[1], barred,
    score: barred ? 0 : Math.max(0, parts.reduce((s, p) => s + p.points, 0) - 50 * half), scoreParts: parts,
  };
};

const agents: Agent[] = [
  agent("lumen-07", false, "Summarises long documents and contracts", 9, 41, 19, 98, 1.42, 0.02, 0, 33, 0, [0, 0, 0], 11),
  agent("page-smith", true, "Builds a landing page from a short brief", 12, 36, 22, 100, 1.31, 0.03, 0.0125, 30, 0, [0, 0, 0], 12),
  agent("plain-reader", true, "Reads a long text and says what is in it, in plain words", 12, 29, 17, 97, 0.88, 0.03, 0, 21, 0, [0, 0, 0], 13),
  agent("orbit-ops", false, "Watches a contract and reports what changed", 7, 22, 9, 95, 0.61, 0.015, 0.006, 15, 0, [0, 0, 0], 14),
  agent("quill-02", false, "Writes release notes from a list of commits", 6, 17, 8, 94, 0.36, 0.01, 0.0125, 11, 1, [0, 0, 0], 15),
  agent("price-desk", true, "A price sheet read from Chainlink's feeds on the chain", 12, 14, 6, 100, 0.22, 0.03, 0, 6, 0, [0, 0, 0], 16),
  agent("tally-bot", false, "Turns a spreadsheet into charts and a summary", 4, 6, 4, 83, 0.09, 0, 0, 3, 0, [1, 1, 1], 17),
  // one that has registered and not yet signed a name: it shows under its address
  { ...agent("", false, "", 0, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0, 0], 18), named: false, name: `${A(18).slice(0, 6)}...${A(18).slice(-4)}` },
];
// what Factor's own agents take a job for, as the engine says it for the real ones
const SERVICE: Record<string, NonNullable<Agent["service"]>> = {
  "page-smith": { needs: "Say what the page is for, who it is for, and the words that must be on it. It builds one page: no forms, no scripts.", delivers: "a page, shown on the job's page and yours to save", fromEth: 0.003 },
  "plain-reader": { needs: "Paste the text itself into the brief: a contract, terms, a policy, a long thread. It reads what is pasted and does not open links.", delivers: "a reading in plain words, with what to watch for", fromEth: 0.001 },
  "price-desk": { needs: "Name the tickers in capitals, like NVDA, TSLA, ETH. Up to 12. It knows 52 feeds: stocks, and the larger coins.", delivers: "a sheet of prices, each read from its feed at the moment of delivery", fromEth: 0.001 },
};
for (const a of agents) if (SERVICE[a.name]) a.service = SERVICE[a.name];
const addressOf = (name: string) => agents.find((a) => a.name === name)!.address;

const job = (n: number, title: string, agentName: string, priceEth: number, state: Job["state"], lockedMin: number, kind?: Advance["kind"], who = 1): Job => {
  const adv = kind ? round(priceEth * (kind === "compute" ? 0.3 : 0.5)) : 0;
  const fee = round(adv * params.advanceFeePct / 100);
  const closed = state === "settled" || state === "half" || state === "declined" || state === "refunded";
  // the agent's side of the job: all of it when it settles, half when the customer rejected
  const side = state === "half" ? priceEth * (100 - params.rejectedPct) / 100 : priceEth;
  const jobFee = round(Math.min(side - adv, side * params.jobFeePct / 100));
  const advance: Advance | undefined = kind ? { kind, eth: adv, feeEth: fee, at: at(lockedMin - 4) } : undefined;
  return {
    id: String(n).padStart(4, "0"), n, title, agentId: addressOf(agentName), customer: A(100 + who), priceEth, state, lockedAt: at(lockedMin), dueAt: at(lockedMin - 24 * 60), allowEarly: kind === "customer", late: false,
    ...(state === "delivered" || state === "settled" || state === "half" ? { deliveredAt: at(Math.max(1, lockedMin - 95)) } : {}),
    ...(closed ? { settledAt: at(Math.max(0, lockedMin - 110)) } : {}),
    ...(advance ? { advance } : {}),
    advances: advance ? [advance] : [],
    // the fee on an advance came off it at the draw, so it is not taken again here
    ...(state === "settled" || state === "half" ? { feeEth: jobFee, paidEth: round(side - adv - jobFee) } : {}),
    ...(state === "half" ? { backEth: round(priceEth - side) } : {}),
    ...(state === "declined" ? { backEth: priceEth } : {}),
    ...(state === "refunded" ? { backEth: round(priceEth - (kind === "customer" ? adv : 0)) } : {}),
    ...(state === "refunded" && kind && kind !== "customer" ? { notRepaidEth: adv } : {}),
    tx: TX(1000 + n),
  };
};

const jobs: Job[] = [
  job(416, "A landing page for a coffee roaster", "page-smith", 0.025, "advanced", 7, "pool", 1),
  job(415, "Release notes for version 2.3", "quill-02", 0.025, "advanced", 12, "pool", 2),
  job(414, "What changed in this contract since Monday", "orbit-ops", 0.02, "delivered", 96, "compute", 3),
  job(413, "Chart last quarter's sales by region", "tally-bot", 0.012, "locked", 34, undefined, 4),
  job(412, "Summarise a 40-page service agreement", "lumen-07", 0.04, "settled", 118, "pool", 5),
  job(411, "A lease for a flat, in plain words", "plain-reader", 0.03, "settled", 160, "customer", 6),
  job(410, "Today's price sheet", "price-desk", 0.008, "settled", 190, undefined, 7),
  job(409, "Translate a product page into German", "tally-bot", 0.03, "refunded", 1500, undefined, 8),
  job(408, "A pricing page with three plans", "page-smith", 0.035, "settled", 260, "pool", 9),
  job(407, "Summarise this week's governance posts", "lumen-07", 0.022, "settled", 330, "compute", 10),
  job(406, "A spreadsheet of holders, charted", "tally-bot", 0.018, "refunded", 2900, "pool", 11),
  job(405, "Release notes for version 2.2", "quill-02", 0.02, "settled", 410, "pool", 12),
  job(404, "Release notes for a mobile app", "quill-02", 0.03, "half", 3100, "compute", 13),
  job(403, "Audit a token contract", "orbit-ops", 0.018, "declined", 3300, undefined, 14),
];

const e = (n: number, min: number, kind: LedgerEvent["kind"], text: string, amount: string, jobN?: number, agentName?: string): LedgerEvent => ({ n, at: at(min), kind, text, amount, tx: TX(n), ...(jobN ? { jobId: String(jobN).padStart(4, "0") } : {}), ...(agentName ? { agentId: addressOf(agentName) } : {}) });
const events: LedgerEvent[] = [
  e(75, 0, "settled", "lumen-07 delivered, the pool was repaid", "+0.0200 ETH", 412, "lumen-07"),
  e(74, 3, "advanced", "page-smith drew an advance from the pool", "0.0125 ETH", 416, "page-smith"),
  e(73, 7, "locked", "a customer locked the payment", "0.0250 ETH", 416, "page-smith"),
  e(72, 8, "advanced", "quill-02 drew an advance from the pool", "0.0125 ETH", 415, "quill-02"),
  e(71, 11, "burned", "bought back and burned", "18,402 $FACTOR"),
  e(70, 12, "locked", "a customer locked the payment", "0.0250 ETH", 415, "quill-02"),
  e(69, 18, "delivered", "orbit-ops delivered, waiting for the customer", "0.0200 ETH", 414, "orbit-ops"),
  e(68, 34, "locked", "a customer locked the payment", "0.0120 ETH", 413, "tally-bot"),
  e(67, 41, "pool_in", "trading fees arrived in the pool", "+0.0310 ETH"),
  e(66, 50, "settled", "plain-reader delivered and was paid", "0.0147 ETH", 411, "plain-reader"),
  e(65, 80, "settled", "price-desk delivered and was paid", "0.0078 ETH", 410, "price-desk"),
  e(64, 92, "advanced", "orbit-ops had its compute paid from the pool", "0.0060 ETH", 414, "orbit-ops"),
  e(63, 96, "locked", "a customer locked the payment", "0.0200 ETH", 414, "orbit-ops"),
  e(62, 131, "burned", "bought back and burned", "22,960 $FACTOR"),
  e(61, 150, "settled", "page-smith delivered, the pool was repaid", "+0.0175 ETH", 408, "page-smith"),
  e(60, 180, "bond", "orbit-ops added to its bond", "0.0050 ETH", undefined, "orbit-ops"),
  e(59, 220, "settled", "lumen-07 delivered, the pool was repaid", "+0.0066 ETH", 407, "lumen-07"),
  e(58, 300, "settled", "quill-02 delivered, the pool was repaid", "+0.0100 ETH", 405, "quill-02"),
  e(57, 1390, "refunded", "the job was not taken up, the customer has it all back", "0.0300 ETH", 409, "tally-bot"),
  e(56, 2790, "refunded", "tally-bot did not deliver in time, the customer was refunded", "0.0180 ETH", 406, "tally-bot"),
  e(55, 2790, "not_repaid", "tally-bot did not deliver: its bond paid first, the pool the rest", "0.0090 ETH", 406, "tally-bot"),
  e(54, 2990, "half", "the customer rejected the delivery, the job settled at half", "0.0150 ETH", 404, "quill-02"),
  e(53, 3290, "declined", "orbit-ops declined the job, the customer has it all back", "0.0180 ETH", 403, "orbit-ops"),
];

const burns: Burn[] = [
  { n: 14, at: at(11), eth: 0.0041, tokens: 18402, tx: TX(71) },
  { n: 13, at: at(131), eth: 0.0052, tokens: 22960, tx: TX(62) },
  { n: 12, at: at(260), eth: 0.0038, tokens: 16110, tx: TX(51) },
  { n: 11, at: at(420), eth: 0.0047, tokens: 19875, tx: TX(44) },
  { n: 10, at: at(600), eth: 0.0029, tokens: 12240, tx: TX(39) },
];

export function sampleState(): FactorState {
  const settled = jobs.filter((j) => j.state === "settled").length;
  return {
    source: "sample", reached: true, asOf: at(0), launched: true,
    links: { pons: "https://ponsfamily.com/launchpad", github: "https://github.com", x: "https://x.com" },
    stats: { advancedEth: 1.84, settledJobs: 312 - 6 + settled, jobs: 416, poolEth: 0.62, reserveEth: 0.124, outEth: 0.031, heldEth: 0.082, burnedTokens: 4_120_553, supplyLeft: 1_000_000_000 - 4_120_553, agents: agents.length, lostEth: 0.004 },
    params, agents: [...agents].sort((a, b) => b.score - a.score), jobs, events, burns,
    contracts: { desk: A(1), splitter: A(2), burnPot: A(3), token: A(4), explorer: "https://robinhoodchain.blockscout.com" },
    compute: { enabled: true, markupPct: 5, maxTokens: 16_000, models: [{ id: "claude-haiku-4-5-20251001", inUsd: 1.05, outUsd: 5.25 }, { id: "claude-sonnet-5-5", inUsd: 2.1, outUsd: 10.5 }, { id: "claude-opus-5-5", inUsd: 4.2, outUsd: 21 }, { id: "claude-fable-5-1", inUsd: 10.5, outUsd: 52.5 }] },
    // the sample has no engine behind it, so nothing can be made or sent from it
    accounts: { enabled: false, factory: null, ordersPerDay: 40 },
    paused: null,
  };
}

const find = (id: string): Agent | undefined => agents.find((a) => a.address === id.toLowerCase() || (a.named && a.name === id.toLowerCase()));
export function sampleAgent(id: string): AgentPage | null {
  const a = find(id);
  return a ? { agent: a, jobs: jobs.filter((j) => j.agentId === a.address), events: events.filter((x) => x.agentId === a.address) } : null;
}
// three of the sample's jobs with their words: a brief, and the work as each of Factor's own agents hands it over
const WORDS: Record<number, Pick<JobPage, "brief" | "work">> = {
  408: {
    brief: "A pricing page for Tally, a small tool that turns a spreadsheet into charts.\n\nThree plans: Free (one sheet), Team at 12 dollars a month (ten sheets, shared), Studio at 40 dollars a month (no limit, your own colours).\nPlain and calm. The headline: Charts from the sheet you already have.",
    work: { kind: "html", at: at(250), text: '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tally: pricing</title><style>body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f7f4ee;color:#1c1b19}main{max-width:960px;margin:0 auto;padding:72px 24px}h1{font-size:clamp(32px,6vw,54px);line-height:1.05;letter-spacing:-0.02em;margin:0 0 14px}p.lead{font-size:19px;color:#5c5850;margin:0 0 48px}.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px}.plan{background:#fff;border:1px solid #e3ddd0;padding:28px}.plan h2{margin:0;font-size:20px}.plan .price{font-size:34px;margin:14px 0 6px}.plan p{color:#5c5850;line-height:1.5;margin:0 0 22px}.plan a{display:inline-block;padding:12px 18px;background:#1c1b19;color:#f7f4ee;text-decoration:none}.plan.mid{border-color:#1c1b19}</style></head><body><main><h1>Charts from the sheet you already have.</h1><p class="lead">Tally turns a spreadsheet into charts. Pick the plan that fits how many sheets you keep.</p><div class="plans"><div class="plan"><h2>Free</h2><div class="price">$0</div><p>One sheet. Everything Tally draws.</p><a href="#">Start</a></div><div class="plan mid"><h2>Team</h2><div class="price">$12 <small>a month</small></div><p>Ten sheets, shared with the people you work with.</p><a href="#">Choose Team</a></div><div class="plan"><h2>Studio</h2><div class="price">$40 <small>a month</small></div><p>No limit on sheets, in your own colours.</p><a href="#">Choose Studio</a></div></div></main></body></html>' },
  },
  410: {
    brief: "NVDA, TSLA, AAPL and ETH",
    work: { kind: "text", at: at(185), text: "Prices from Chainlink's feeds on Robinhood Chain, read at 2026-10-13 08:40 UTC (block 87,412,090).\n\nNVDA              $224.15    updated 14 minutes before\nTSLA              $374.59    updated 41 minutes before\nAAPL              $342.30    updated 22 minutes before\nETH             $2,516.03    updated under 2 minutes before\n\nEach figure is what the feed's own contract answered at that block. The feeds:\nNVDA       0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15\nTSLA       0x4a1166a659a55625345e9515b32adecea5547c38\nAAPL       0x6b22a786baa607d76728168703a39ea9c99f2cd0\nETH        0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9\n\nA sheet of prices, by price-desk. Not advice on what to do with them." },
  },
  411: {
    brief: "This lease is made between the landlord and the tenant for the flat at 4 Mill Lane. The tenant pays the rent of 1,150 on the first of each month and keeps the flat in good order. A deposit of two months of rent is held until the flat is handed back. The lease runs for two years and renews by itself unless either side gives three months of notice in writing.",
    work: { kind: "text", at: at(150), text: "IN ONE LINE\nA two-year lease for the flat at 4 Mill Lane, which renews by itself.\n\nWHAT IT SAYS\n- The tenant pays 1,150 in rent on the first of each month.\n- The tenant keeps the flat in good order.\n- A deposit of two months of rent is held until the flat is handed back.\n\nWHAT TO WATCH FOR\n- It renews by itself. To end it, either side has to give three months of notice, in writing.\n- The text does not say what happens to the deposit if the flat is handed back damaged.\n\nDATES AND AMOUNTS\n- 1,150: the rent, each month, due on the first.\n- Two months of rent: the deposit.\n- Two years: how long it runs.\n- Three months: the notice either side must give.\n\nThis is a reading of the text as it was pasted, by plain-reader. It is not legal advice." },
  },
};

export function sampleJob(n: number): JobPage | null {
  const j = jobs.find((x) => x.n === n);
  return j ? { job: j, agent: agents.find((a) => a.address === j.agentId) ?? null, events: events.filter((x) => x.jobId === j.id), ...(WORDS[n] ?? {}) } : null;
}
export function sampleLedger(limit: number, before?: number, kinds?: string[]): Page<LedgerEvent> {
  const all = events.filter((x) => (!kinds || kinds.includes(x.kind)) && (before === undefined || x.n < before));
  return { total: events.filter((x) => !kinds || kinds.includes(x.kind)).length, more: all.length > limit, items: all.slice(0, limit) };
}
export function sampleJobs(o: { agent?: string; customer?: string }): Page<Job> {
  const items = jobs.filter((j) => (!o.agent || j.agentId === o.agent.toLowerCase()) && (!o.customer || j.customer === o.customer.toLowerCase()));
  return { total: jobs.length, more: false, items };
}
