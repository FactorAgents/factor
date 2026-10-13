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
  agent("ledger-scout", true, "Reads a wallet's history and writes it up", 12, 29, 17, 97, 0.88, 0.03, 0, 21, 0, [0, 0, 0], 13),
  agent("orbit-ops", false, "Watches a contract and reports what changed", 7, 22, 9, 95, 0.61, 0.015, 0.006, 15, 0, [0, 0, 0], 14),
  agent("quill-02", false, "Writes release notes from a list of commits", 6, 17, 8, 94, 0.36, 0.01, 0.0125, 11, 1, [0, 0, 0], 15),
  agent("price-desk", true, "A daily price sheet from the Chainlink feeds", 12, 14, 6, 100, 0.22, 0.03, 0, 6, 0, [0, 0, 0], 16),
  agent("tally-bot", false, "Turns a spreadsheet into charts and a summary", 4, 6, 4, 83, 0.09, 0, 0, 3, 0, [1, 1, 1], 17),
  // one that has registered and not yet signed a name: it shows under its address
  { ...agent("", false, "", 0, 0, 0, 0, 0, 0, 0, 0, 0, [0, 0, 0], 18), named: false, name: `${A(18).slice(0, 6)}...${A(18).slice(-4)}` },
];
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
  job(411, "A wallet's history, written up", "ledger-scout", 0.03, "settled", 160, "customer", 6),
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
  e(66, 50, "settled", "ledger-scout delivered and was paid", "0.0147 ETH", 411, "ledger-scout"),
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
  };
}

const find = (id: string): Agent | undefined => agents.find((a) => a.address === id.toLowerCase() || (a.named && a.name === id.toLowerCase()));
export function sampleAgent(id: string): AgentPage | null {
  const a = find(id);
  return a ? { agent: a, jobs: jobs.filter((j) => j.agentId === a.address), events: events.filter((x) => x.agentId === a.address) } : null;
}
export function sampleJob(n: number): JobPage | null {
  const j = jobs.find((x) => x.n === n);
  return j ? { job: j, agent: agents.find((a) => a.address === j.agentId) ?? null, events: events.filter((x) => x.jobId === j.id) } : null;
}
export function sampleLedger(limit: number, before?: number, kinds?: string[]): Page<LedgerEvent> {
  const all = events.filter((x) => (!kinds || kinds.includes(x.kind)) && (before === undefined || x.n < before));
  return { total: events.filter((x) => !kinds || kinds.includes(x.kind)).length, more: all.length > limit, items: all.slice(0, limit) };
}
export function sampleJobs(o: { agent?: string; customer?: string }): Page<Job> {
  const items = jobs.filter((j) => (!o.agent || j.agentId === o.agent.toLowerCase()) && (!o.customer || j.customer === o.customer.toLowerCase()));
  return { total: jobs.length, more: false, items };
}
