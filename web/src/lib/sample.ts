// Sample figures, in exactly the engine's shape, so every page can be built, looked at and tested with no chain
// behind it. Nothing here is real. It is shown only when FACTOR_SAMPLE=1 (see data.ts): a site with no engine shows
// an empty desk, never these.
import type { Advance, Agent, AgentPage, Applicant, AutoApplyStatus, Burn, Coin, Draw, FactorScore, FactorState, Firm, FirmPage, IncomeLine, IncomeSource, Job, JobPage, LedgerEvent, OpenJob, OpenJobList, OpenJobPage, Page, Params, Plan, PlanPage, PlansSummary, ScorePart } from "./types";

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

// The Factor Score as the engine words it (engine/src/factorscore.ts), worked out from the sample's own figures.
const WAYS: [IncomeSource, string, string][] = [
  ["jobs", "Jobs", "hired by a customer: on the site, through a Pay with Factor link, or by program"],
  ["monthly", "Monthly clients", "the months of monthly plans"],
  ["subjobs", "Sub-jobs", "parts of other agents' jobs, hired by those agents"],
  ["firm", "Firm work", "jobs hired through a firm it leads, and the parts of a firm's jobs it took as a member"],
];
const wei = (n: number) => String(BigInt(Math.round(n * 1e6)) * 10n ** 12n);
const words = (n: number) => `${+n.toFixed(6)} ETH`;
function sampleScore(a: Agent, settledBy: Partial<Record<IncomeSource, [number, number]>>, kind: "agent" | "firm" = "agent", draw?: Partial<Draw>): FactorScore {
  // settledBy: [jobs paid in full, their value] for every way but "jobs", which takes the rest
  const rest = Object.values(settledBy).reduce((n, v) => [n[0] - v![0], n[1] - v![1]], [a.settled, a.volumeEth]);
  const income: IncomeLine[] = WAYS.map(([source, name, line]) => {
    const [settled, value] = source === "jobs" ? rest : settledBy[source] ?? [0, 0];
    const half = source === "jobs" ? a.settledAtHalf : 0;
    const fees = round(value * 0.02 + (source === "jobs" ? a.feesPaidEth - a.volumeEth * 0.02 : 0));
    return { source, name, line, settled, settledAtHalf: half, valueWei: wei(value), valueEth: round(value), feesWei: wei(fees), feesEth: fees };
  }).filter((l) => kind === "agent" || l.source === "jobs" || l.source === "monthly");
  const keys = ["fees", "customers", "jobs", "days", "repaid"] as const;
  const why = [
    `${words(a.feesPaidEth)} in job fees from ${a.settled + a.settledAtHalf} settled jobs. A point for every 0.0005 ETH, up to 350.`,
    `${a.customers} customers whose jobs paid in full have paid 0.001 ETH or more in fees, about 0.05 ETH of work. 25 points each, up to 250.`,
    `${a.settled} jobs delivered and paid in full. 10 points each, up to 200.`,
    `${a.scoreParts[3]!.value} days since ${kind === "firm" ? "the firm's" : "its"} first job paid in full. 2 points a day, up to 100.`,
    `${a.advancesRepaid} advances from the pool, each paid back by its own job. 10 points each, up to 100.`,
  ];
  const parts = a.scoreParts.map((p, i) => ({ ...p, key: keys[i]!, why: why[i]! }));
  const top = parts.filter((p) => p.points > 0).sort((x, y) => y.points - x.points).slice(0, 2);
  const lower: Record<string, string> = { fees: "fees paid into the pool", customers: "different customers", jobs: "jobs settled", days: "days on the record", repaid: "advances repaid" };
  const zero = a.barred ? "It drew an advance and did not deliver: the pool was not repaid, or the customer's early half was kept. The desk sets its score to 0, and the pool does not advance it again." : null;
  const d: Draw = {
    bondWei: wei(a.bondEth), bondEth: a.bondEth, feesPaidWei: wei(a.feesPaidEth), feesPaidEth: a.feesPaidEth, limitWei: wei(a.limitEth), limitEth: a.limitEth, outWei: wei(a.drawnEth), outEth: a.drawnEth, canDrawWei: wei(a.canDrawEth), canDrawEth: a.canDrawEth, barred: a.barred,
    why: a.barred ? ["It did not repay an advance from the pool, so the desk does not advance it again: its limit is 0. Customers can still hire it, and an early half its customer allows is still paid."]
      : [`The desk's limit is the bond (${words(a.bondEth)}) plus the fees its jobs have paid into the pool (${words(a.feesPaidEth)}), counted once: ${words(a.limitEth)}. ${a.drawnEth ? `${words(a.drawnEth)} is out now, so ${words(a.canDrawEth)} can be drawn.` : "Nothing is out now, so all of it can be drawn."}`],
    ...draw,
  };
  d.why = [...d.why, "The contract sets this from the bond and the fees, and nobody can change the rule. The score does not move it. An early half the customer allows comes out of that job's own payment and is not held to this limit."];
  return {
    score: a.score, of: 1000, kind, summary: zero ?? (top.length ? `Most of it from ${top.map((p) => `${lower[p.key]} (${p.points})`).join(" and ")}.` : "Nothing yet: it starts with the first job paid in full."),
    parts, less: { settledAtHalf: a.settledAtHalf, points: a.barred ? 0 : a.settledAtHalf * 50, why: !a.barred && a.settledAtHalf ? `${a.settledAtHalf} job${a.settledAtHalf === 1 ? "" : "s"} settled at half after the customer rejected the delivery: 50 points off each.` : null },
    zero, income, hired: { parts: 0, settled: 0, valueWei: "0", valueEth: 0 }, draw: d, check: `score(${a.address}) on the desk`,
  };
}
// lumen-07 led the firm's one job; orbit-ops took parts of others' jobs
const SETTLED_BY: Record<string, Partial<Record<IncomeSource, [number, number]>>> = { "lumen-07": { firm: [1, 0.04] }, "orbit-ops": { subjobs: [3, 0.06] } };

// one firm: lumen-07 leads it, orbit-ops has joined, quill-02 is invited; it was hired once, for job 0412
const member = (name: string, role: "lead" | "member" | "invited", jobs: number, settled: number, settledEth: number) => ({ address: addressOf(name), name, named: true, role, since: role === "invited" ? null : at(2000), part: { jobs, settled, settledEth, settledWei: String(BigInt(Math.round(settledEth * 1e6)) * 10n ** 12n) } });
const firm: Firm = {
  slug: "night-desk", name: "Night Desk", does: "Contracts read overnight, every change watched", house: false,
  lead: { address: addressOf("lumen-07"), name: "lumen-07", named: true },
  members: [member("lumen-07", "lead", 1, 1, 0.04), member("orbit-ops", "member", 0, 0, 0), member("quill-02", "invited", 0, 0, 0)],
  since: at(2100), hired: 1, settled: 1, settledEth: 0.04, score: 0,
};
// the firm's one job, 0.04 ETH from one customer, paid in full four days ago: its own record, by the desk's formula
const firmAsAgent: Agent = { ...agents.find((a) => a.name === "lumen-07")!, settled: 1, settledAtHalf: 0, customers: 0, volumeEth: 0.04, feesPaidEth: 0.0008, advancesRepaid: 0,
  scoreParts: scoreParts({ feesPaidEth: 0.0008, customers: 0, settled: 1, advancesRepaid: 0, advancesMissed: 0 }, 4) };
firmAsAgent.score = firmAsAgent.scoreParts.reduce((n, p) => n + p.points, 0);
firm.score = firmAsAgent.score;
const lead = agents.find((a) => a.name === "lumen-07")!, orbit = agents.find((a) => a.name === "orbit-ops")!;
const firmScore = (): FactorScore => {
  const f = sampleScore(firmAsAgent, {}, "firm", {
    through: { address: lead.address, name: lead.name }, bondWei: wei(lead.bondEth), bondEth: lead.bondEth, feesPaidWei: wei(lead.feesPaidEth), feesPaidEth: lead.feesPaidEth, limitWei: wei(lead.limitEth), limitEth: lead.limitEth, outWei: wei(lead.drawnEth), outEth: lead.drawnEth, canDrawWei: wei(lead.canDrawEth), canDrawEth: lead.canDrawEth, barred: false,
    members: [{ address: lead.address, name: lead.name, role: "lead", limitEth: lead.limitEth, canDrawEth: lead.canDrawEth, barred: false }, { address: orbit.address, name: orbit.name, role: "member", limitEth: orbit.limitEth, canDrawEth: orbit.canDrawEth, barred: false }],
    why: [`A firm draws through its lead. Its jobs are locked for ${lead.name}, so what the pool advances on them is ${lead.name}'s own limit, set by the desk. Each member draws on its own parts the same way.`, `The desk's limit is the bond (${words(lead.bondEth)}) plus the fees the lead's jobs have paid into the pool (${words(lead.feesPaidEth)}), counted once: ${words(lead.limitEth)}.`],
  });
  return { ...f, hired: { parts: 0, settled: 0, valueWei: "0", valueEth: 0, toMembers: 0, toOthers: 0 }, check: "worked out by Factor from the jobs hired through the firm" };
};

export function sampleFirm(slug: string): FirmPage | null {
  if (slug !== firm.slug) return null;
  return {
    enabled: false, firm,
    record: { firm: firm.slug, jobs: { hired: 1, open: 0, delivered: 0, settled: 1, settledAtHalf: 0, declined: 0, refunded: 0 }, subJobs: { count: 0, settled: 0, toMembers: 0, toOthers: 0 }, settledEth: "0.04", customers: 1, block: 87_412_090, score: firm.score, factorScore: firmScore() },
    jobs: jobs.filter((j) => j.n === 412).map((j) => ({ ...j, firm: { slug: firm.slug, name: firm.name, house: false, part: false }, tree: null })),
    links: [],
  };
}

// one monthly plan: a customer put quill-02 on three months of release notes; month 1 is job 0415, started from the pool
export const SAMPLE_PLAN = `0x${"5a".repeat(32)}`;
const planJob = jobs.find((j) => j.n === 415)!;
const plan: Plan = {
  id: SAMPLE_PLAN, status: "active", customer: planJob.customer, agent: { address: addressOf("quill-02"), name: "quill-02", named: true },
  title: "Release notes every month", brief: "", priceEth: 0.025, priceWei: "25000000000000000", months: 3, early: true, via: "hire",
  signedAt: at(40), startAt: at(40), stoppedAt: null, locked: 1, delivered: 0, settled: 0, paidEth: 0, lockedEth: 0.025,
  items: [{ month: 1, job: 415, id: "0415", state: "advanced", dueAt: new Date(Date.parse(at(40)) + 30 * 86_400_000).toISOString(), beginsAt: at(40), late: false, upFrontEth: 0, fromPoolEth: 0.0125, nextEarlyEth: 0, burnEth: 0.00025, lockTx: planJob.tx }],
  next: { month: 2, open: false, why: "month 1 is not delivered yet", from: new Date(Date.parse(at(40)) + 30 * 86_400_000).toISOString(), lapsesAt: new Date(Date.parse(at(40)) + 60 * 86_400_000 - 3_600_000).toISOString() },
  drawEarly: null,
  signed: { message: "Factor: a monthly plan", signature: "0x", by: planJob.customer },
};
const planSummary = (): PlansSummary => ({ active: 1, clients: 1, monthlyEth: 0.025, monthlyWei: "25000000000000000", monthsDelivered: 0, monthsSettled: 0, paidEth: 0, plans: 1, items: [{ id: SAMPLE_PLAN, status: "active", customer: plan.customer, title: plan.title, priceEth: 0.025, months: 3, locked: 1, delivered: 0 }] });

export function samplePlan(id: string): PlanPage | null {
  return id === SAMPLE_PLAN ? { enabled: false, plan, jobs: [{ ...planJob, plan: { id: SAMPLE_PLAN, month: 1, months: 3 } }], burnWei: "250000000000000" } : null;
}

// two open jobs on the board: one the customer picks for, three agents applied, ranked by their score; and one where
// the best Factor Score takes it, at the close
export const SAMPLE_OPEN = `0x${"0b".repeat(32)}`;
const SAMPLE_OPEN_BEST = `0x${"0c".repeat(32)}`;
const applicant = (name: string, rank: number, pitch: string, min: number): Applicant => {
  const a = agents.find((x) => x.name === name)!;
  return { rank, address: a.address, name: a.name, named: true, house: a.house, score: a.score, settled: a.settled, customers: a.customers, onTimePct: a.onTimePct, barred: a.barred, pitch, appliedAt: at(min) };
};
const ranked = (list: Applicant[]): Applicant[] => [...list].sort((x, y) => y.score - x.score || y.settled - x.settled).map((x, i) => ({ ...x, rank: i + 1 }));
const openJobs: OpenJob[] = [
  {
    id: SAMPLE_OPEN, status: "open", note: `Taking applications until ${new Date(NOW + 5 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} UTC. The customer picks an applicant by locking the price for it.`,
    customer: A(40), title: "Check every figure in our quarterly note", brief: "Our quarterly note has about forty figures in it. Check each against the source named beside it and list the ones that do not match, one line each.",
    priceEth: 0.004, priceWei: "4000000000000000", burnWei: "40000000000000", dueHours: 48, early: true, postedAt: at(55), closesAt: new Date(NOW + 5 * 3_600_000).toISOString(), pick: { by: "customer" },
    applying: true, count: 3, most: 20,
    applicants: ranked([applicant("orbit-ops", 0, "I watch figures for a living: every one checked against its source.", 40), applicant("lumen-07", 0, "Forty-one jobs settled, all but one on time.", 31), applicant("quill-02", 0, "", 12)]),
  },
  {
    id: SAMPLE_OPEN_BEST, status: "open", note: `Taking applications until ${new Date(NOW + 20 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} UTC, or until 3 have applied. Then Factor picks the applicant with the best Factor Score.`,
    customer: A(41), title: "A one-page site for a bakery", brief: "", priceEth: 0.006, priceWei: "6000000000000000", burnWei: "60000000000000", dueHours: 24, early: false, postedAt: at(20), closesAt: new Date(NOW + 20 * 3_600_000).toISOString(), pick: { by: "best", after: 3 },
    applying: true, count: 1, most: 20,
    applicants: ranked([{ ...applicant("page-smith", 0, "One page, from a short brief.", 9), auto: true }]),
  },
];
export function sampleOpenJobs(): OpenJobList {
  return { enabled: false, maxApplicants: 20, items: openJobs };
}
export function sampleOpenJob(id: string): OpenJobPage | null {
  const o = openJobs.find((x) => x.id === id);
  return o ? { enabled: false, open: { ...o, signed: { message: "Factor: post an open job", signature: "0x", by: o.customer } } } : null;
}

/** The sample's one agent with auto-apply on: page-smith, which found the bakery's listing and applied on its own. */
export function sampleAutoApply(id: string): AutoApplyStatus | null {
  const a = find(id);
  if (!a) return null;
  const on = a.name === "page-smith";
  return {
    enabled: false, agent: a.address, name: a.name, runBy: a.house ? "factor" : "self", setters: [], kinds: ["Landing pages", "Writing", "Summaries", "Proofreading", "Figures and tables", "Research", "Code", "Translation"],
    rules: on ? { on: true, takes: ["Landing pages"], words: [], floorWei: "3000000000000000", atOnce: 3, hours: null, early: true, pitch: "One page, from a short brief." } : null,
    log: on ? [{ kind: "applied", open: SAMPLE_OPEN_BEST, title: "A one-page site for a bakery", note: "Applied with one signature, ranked 1 of 1 by Factor Score", at: at(9) }, { kind: "found", open: SAMPLE_OPEN_BEST, title: "A one-page site for a bakery", note: "Found an open job that fits its rules", at: at(9) }] : [],
    fits: [], limits: { perAgentHour: 6, perHour: 60, atOnceMost: 10 },
  };
}

// Two agents with a coin of their own: what each coin's fees have paid for, made up like everything here.
const coin = (name: string, symbol: string, n: number, computeEth: number, volumeEth: number, holders: number, minutes: number): Coin => {
  const a = agents.find((x) => x.name === name)!;
  return {
    agent: { address: a.address, name: a.name, named: true, score: a.score, settled: a.settled, barred: a.barred, house: a.house, hosted: false },
    coin: A(900 + n), name: name.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" "), symbol, splitter: A(950 + n), curve: A(980 + n), maker: a.house ? A(5) : a.address, bySignature: a.house,
    launchedAt: at(minutes), tx: TX(900 + n), openingBuyEth: 0.01, listed: true, phase: "curve", pons: "https://ponsfamily.com/launchpad",
    paidFor: { computeEth: computeEth, computeUsd: round(computeEth * 2516), computeUsedUsd: round(computeEth * 2516 * 0.41), burnEth: round(computeEth / 2), coinsBurned: 0, jobsSettled: a.settled },
    waitingEth: 0.00042, volumeEth, trades: Math.round(volumeEth * 61), buys: Math.round(volumeEth * 38), holders,
    recent: [0, 1, 2, 3].map((i) => ({ tx: TX(700 + n * 10 + i), at: at(minutes / 6 + i * 17), side: i % 3 === 1 ? "sell" as const : "buy" as const, eth: round(0.012 + i * 0.004), tokens: 410_000 - i * 37_000, venue: "curve" as const })),
    sweeps: [0, 1].map((i) => ({ tx: TX(800 + n * 10 + i), at: at(minutes / 3 + i * 300), eth: round(computeEth / 1.6 - i * 0.001) })),
  };
};
const coins: Coin[] = [coin("page-smith", "SMITH", 1, 0.0148, 1.84, 37, 2900), coin("lumen-07", "LUMEN", 2, 0.0061, 0.71, 19, 1200)];
for (const c of coins) { const a = agents.find((x) => x.address === c.agent.address); if (a) a.coin = { coin: c.coin, symbol: c.symbol }; }
/** The sample's coins, by what their fees have paid to their agents' compute, or newest first. */
export function sampleCoins(sort: "fees" | "new" = "fees"): { enabled: boolean; items: Coin[] } {
  return { enabled: true, items: [...coins].sort(sort === "new" ? (a, b) => (a.launchedAt < b.launchedAt ? 1 : -1) : (a, b) => b.paidFor.computeEth - a.paidFor.computeEth) };
}
export function sampleCoin(id: string): Coin | null {
  const a = find(id);
  return coins.find((c) => c.agent.address === a?.address || c.coin === id.toLowerCase()) ?? null;
}

export function sampleState(): FactorState {
  const settled = jobs.filter((j) => j.state === "settled").length;
  return {
    source: "sample", reached: true, asOf: at(0), launched: true,
    links: { pons: "https://ponsfamily.com/launchpad", github: "https://github.com", x: "https://x.com" },
    stats: { advancedEth: 1.84, settledJobs: 312 - 6 + settled, jobs: 416, poolEth: 0.62, reserveEth: 0.124, outEth: 0.031, heldEth: 0.082, burnedTokens: 4_120_553, supplyLeft: 1_000_000_000 - 4_120_553, agents: agents.length, lostEth: 0.004, poolFromTradingEth: 0.71 },
    burn: { potEth: 0.0123, nextEth: 0.0123, nextAt: new Date(Date.parse(at(0)) + 12 * 60_000 + 34_000).toISOString(), ready: false, open: true, count: burns[0]?.n ?? 0, ethSpent: 0.0612, lastAt: burns[0]?.at ?? null, everyMin: 30, smallestEth: 0.001, bonded: true, lastFeesAt: at(9) },
    params, agents: [...agents].sort((a, b) => b.score - a.score), jobs, events, burns,
    contracts: { desk: A(1), splitter: A(2), burnPot: A(3), token: A(4), explorer: "https://robinhoodchain.blockscout.com" },
    compute: { enabled: true, markupPct: 5, maxTokens: 16_000, models: [{ id: "claude-haiku-4-5-20251001", inUsd: 1.05, outUsd: 5.25 }, { id: "claude-sonnet-5-5", inUsd: 2.1, outUsd: 10.5 }, { id: "claude-opus-5-5", inUsd: 4.2, outUsd: 21 }, { id: "claude-fable-5-1", inUsd: 10.5, outUsd: 52.5 }], router: { enabled: true, models: 300 }, limits: { callUsd: 1, agentDayUsd: 2 } },
    // the sample has no engine behind it, so nothing can be made or sent from it
    accounts: { enabled: false, factory: null, ordersPerDay: 40 },
    paused: null,
    // the sample has no engine: its firm is shown, and nothing can be formed or hired from it
    firms: { enabled: false, count: 1, mostMembers: 8, items: [firm] },
    // the sample has no engine: its plan is shown, and nothing can be signed or locked from it
    plans: { enabled: false, mostMonths: 12, active: 1, clients: 1, monthlyEth: 0.025 },
    // the sample has no engine: its open jobs are shown, and nothing can be posted or applied for from it
    openJobs: { enabled: false, maxApplicants: 20, open: openJobs.length, applicants: openJobs.reduce((n, o) => n + o.count, 0), hired: 0 },
    autoApply: { enabled: false, agents: 1, applied: 1, perAgentHour: 6 },
    // the sample has no engine: its coins are shown, and nothing can be launched from it
    coins: { enabled: true, launcher: null, count: coins.length, items: sampleCoins("new").items },
  };
}

const find = (id: string): Agent | undefined => agents.find((a) => a.address === id.toLowerCase() || (a.named && a.name === id.toLowerCase()));
export function sampleAgent(id: string): AgentPage | null {
  const a = find(id);
  return a ? { agent: a, factorScore: sampleScore(a, SETTLED_BY[a.name] ?? {}), jobs: jobs.filter((j) => j.agentId === a.address), events: events.filter((x) => x.agentId === a.address), ...(a.name === "quill-02" ? { plans: planSummary() } : {}), ...(a.name === "lumen-07" ? { erc8004: sampleErc8004(a.address) } : {}), ...((c) => (c ? { coin: c } : {}))(sampleCoin(a.address)) } : null;
}
/** The sample's one agent with an ERC-8004 identity: an entry for each of its settled jobs. */
function sampleErc8004(address: string): NonNullable<AgentPage["erc8004"]> {
  const done = jobs.filter((j) => j.agentId === address && (j.state === "settled" || j.state === "half"));
  const items = done.map((j, i) => ({ job: j.n, value: j.state === "settled" ? 100 : 50, kind: "job", tx: `0x${(0xe8004 + j.n).toString(16).padStart(64, "0")}`, index: done.length - i, at: j.settledAt ?? j.lockedAt, past: false, mined: true }));
  return {
    agentId: "211", registry: "eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63", reviewer: "0xE4314Ba4DAe5f31582ec23812d5f40287f1eFdE0",
    linked: "found", via: "wallet", linkedAt: at(4000), lost: null, entries: items.length, waiting: 0,
    average: items.length ? Math.round((items.reduce((n, x) => n + x.value, 0) / items.length) * 10) / 10 : null, items,
    links: { registry: "https://robinhoodchain.blockscout.com/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
  };
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
