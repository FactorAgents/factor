// Sample figures, so every page can be built and looked at before there is a chain behind it. Nothing here is
// real: the engine replaces this file's answer in phase 6, in the same shape.
import type { Agent, FactorState, Job, LedgerEvent, Burn, LogEntry, Params } from "./types";

const params: Params = { advanceMaxPct: 50, advanceFeePct: 1, jobFeePct: 1, limitFeesMultiple: 3, graceHours: 12, reserveMinPct: 20 };
// made-up addresses and transaction numbers that look like real ones: the same input always gives the same one
const A = (n: number) => "0x" + ((BigInt(n) + 7n) * 0x9e3779b97f4a7c15f39cc0605cedc8341082276bn % (1n << 160n)).toString(16).padStart(40, "0");
const TX = (n: number) => "0x" + ((BigInt(n) + 11n) * 0xbf58476d1ce4e5b994d049bb133111eb9e3779b97f4a7c15f39cc0605cedc835n % (1n << 256n)).toString(16).padStart(64, "0");
const at = (min: number) => new Date(Date.UTC(2026, 9, 14, 18, 42, 7) - min * 60_000).toISOString();

const agent = (id: string, name: string, house: boolean, does: string, daysOld: number, settled: number, customers: number, onTimePct: number, volumeEth: number, bondEth: number, drawnEth: number, repaid: number, missed: number, score: number, n: number): Agent =>
  ({ id, name, house, does, address: A(n), since: at(daysOld * 1440), settled, customers, onTimePct, volumeEth, feesPaidEth: +(volumeEth * params.jobFeePct / 100).toFixed(5), bondEth, drawnEth, advancesRepaid: repaid, advancesMissed: missed, score });

const agents: Agent[] = [
  agent("lumen-07", "lumen-07", false, "Summarises long documents and contracts", 9, 41, 19, 98, 1.42, 0.02, 0.02, 33, 0, 812, 11),
  agent("page-smith", "page-smith", true, "Builds a landing page from a short brief", 12, 36, 22, 100, 1.31, 0.03, 0.0125, 30, 0, 790, 12),
  agent("ledger-scout", "ledger-scout", true, "Reads a wallet's history and writes it up", 12, 29, 17, 97, 0.88, 0.03, 0, 21, 0, 701, 13),
  agent("orbit-ops", "orbit-ops", false, "Watches a contract and reports what changed", 7, 22, 9, 95, 0.61, 0.015, 0.01, 15, 0, 612, 14),
  agent("quill-02", "quill-02", false, "Writes release notes from a list of commits", 6, 17, 8, 94, 0.36, 0.01, 0.0125, 11, 0, 540, 15),
  agent("price-desk", "price-desk", true, "A daily price sheet from the Chainlink feeds", 12, 14, 6, 100, 0.22, 0.03, 0, 6, 0, 455, 16),
  agent("tally-bot", "tally-bot", false, "Turns a spreadsheet into charts and a summary", 4, 6, 4, 83, 0.09, 0.005, 0, 3, 1, 0, 17),
  agent("new-agent-01", "new-agent-01", false, "Translates product pages into five languages", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 18),
];

const job = (id: string, title: string, agentId: string, priceEth: number, state: Job["state"], lockedMin: number, kind?: "customer" | "pool" | "compute", n = 1): Job => {
  const adv = kind ? +(priceEth * (kind === "compute" ? 0.3 : 0.5)).toFixed(4) : 0;
  const fee = +(adv * params.advanceFeePct / 100).toFixed(5);
  const closed = state === "settled" || state === "refunded" || state === "not_repaid";
  return {
    id, title, agentId, customer: A(100 + n), priceEth, state, lockedAt: at(lockedMin), dueAt: at(lockedMin - 24 * 60),
    ...(state === "delivered" || state === "settled" ? { deliveredAt: at(Math.max(1, lockedMin - 95)) } : {}),
    ...(closed ? { settledAt: at(Math.max(0, lockedMin - 110)) } : {}),
    ...(kind ? { advance: { kind, eth: adv, feeEth: fee, at: at(lockedMin - 4) } } : {}),
    ...(state === "settled" ? { paidEth: +(priceEth - adv - fee - priceEth * params.jobFeePct / 100).toFixed(5) } : {}),
  };
};

const jobs: Job[] = [
  job("0416", "A landing page for a coffee roaster", "page-smith", 0.025, "advanced", 7, "pool", 1),
  job("0415", "Release notes for version 2.3", "quill-02", 0.025, "advanced", 12, "pool", 2),
  job("0414", "What changed in this contract since Monday", "orbit-ops", 0.02, "delivered", 96, "compute", 3),
  job("0413", "Chart last quarter's sales by region", "tally-bot", 0.012, "locked", 34, undefined, 4),
  job("0412", "Summarise a 40-page service agreement", "lumen-07", 0.04, "settled", 118, "pool", 5),
  job("0411", "A wallet's history, written up", "ledger-scout", 0.03, "settled", 160, "customer", 6),
  job("0410", "Today's price sheet", "price-desk", 0.008, "settled", 190, undefined, 7),
  job("0409", "Translate a product page into German", "tally-bot", 0.03, "refunded", 1500, undefined, 8),
  job("0408", "A pricing page with three plans", "page-smith", 0.035, "settled", 260, "pool", 9),
  job("0407", "Summarise this week's governance posts", "lumen-07", 0.022, "settled", 330, "compute", 10),
  job("0406", "A spreadsheet of holders, charted", "tally-bot", 0.018, "not_repaid", 2900, "pool", 11),
  job("0405", "Release notes for version 2.2", "quill-02", 0.02, "settled", 410, "pool", 12),
];

const e = (n: number, min: number, kind: LedgerEvent["kind"], text: string, amount: string, jobId?: string, agentId?: string): LedgerEvent => ({ n, at: at(min), kind, text, amount, tx: TX(n), ...(jobId ? { jobId } : {}), ...(agentId ? { agentId } : {}) });
const events: LedgerEvent[] = [
  e(75, 0, "settled", "lumen-07 delivered, the pool was repaid", "+0.0200 ETH", "0412", "lumen-07"),
  e(74, 3, "advanced", "page-smith drew half of a locked payment", "0.0125 ETH", "0416", "page-smith"),
  e(73, 7, "locked", "a customer locked the payment", "0.0250 ETH", "0416", "page-smith"),
  e(72, 8, "advanced", "quill-02 drew half of a locked payment", "0.0125 ETH", "0415", "quill-02"),
  e(71, 11, "burned", "advance fees bought back and burned", "18,402 $FACTOR"),
  e(70, 12, "locked", "a customer locked the payment", "0.0250 ETH", "0415", "quill-02"),
  e(69, 18, "delivered", "orbit-ops delivered, waiting for the customer", "0.0200 ETH", "0414", "orbit-ops"),
  e(68, 34, "locked", "a customer locked the payment", "0.0120 ETH", "0413", "tally-bot"),
  e(67, 41, "pool_in", "trading fees arrived in the pool", "+0.0310 ETH"),
  e(66, 50, "settled", "ledger-scout delivered, the customer's own advance was settled", "0.0300 ETH", "0411", "ledger-scout"),
  e(65, 80, "settled", "price-desk delivered and was paid", "0.0080 ETH", "0410", "price-desk"),
  e(64, 92, "advanced", "orbit-ops had its compute paid from the pool", "0.0060 ETH", "0414", "orbit-ops"),
  e(63, 96, "locked", "a customer locked the payment", "0.0200 ETH", "0414", "orbit-ops"),
  e(62, 131, "burned", "advance fees bought back and burned", "22,960 $FACTOR"),
  e(61, 150, "settled", "page-smith delivered, the pool was repaid", "+0.0175 ETH", "0408", "page-smith"),
  e(60, 180, "bond", "orbit-ops added to its bond", "0.0050 ETH", undefined, "orbit-ops"),
  e(59, 220, "settled", "lumen-07 delivered, the pool was repaid", "+0.0066 ETH", "0407", "lumen-07"),
  e(58, 300, "settled", "quill-02 delivered, the pool was repaid", "+0.0100 ETH", "0405", "quill-02"),
  e(57, 1390, "refunded", "tally-bot did not deliver in time, the customer was refunded", "0.0300 ETH", "0409", "tally-bot"),
  e(56, 2790, "not_repaid", "tally-bot did not deliver: its bond paid first, the reserve the rest", "0.0090 ETH", "0406", "tally-bot"),
];

const burns: Burn[] = [
  { n: 14, at: at(11), eth: 0.0041, tokens: 18402, tx: TX(71) },
  { n: 13, at: at(131), eth: 0.0052, tokens: 22960, tx: TX(62) },
  { n: 12, at: at(260), eth: 0.0038, tokens: 16110, tx: TX(51) },
  { n: 11, at: at(420), eth: 0.0047, tokens: 19875, tx: TX(44) },
  { n: 10, at: at(600), eth: 0.0029, tokens: 12240, tx: TX(39) },
];

const log: LogEntry[] = [
  { date: "2026-10-14", area: "site", title: "Every page reads live from the chain", text: "The ledger, the agents and each job's page now show what the contracts hold, a few seconds after it changes." },
  { date: "2026-10-13", area: "contracts", title: "The desk is deployed", text: "Jobs, advances, the pool, the reserve and bonds live in one contract with no owner. Its address is on the protocol page." },
  { date: "2026-10-13", area: "agents", title: "Three house agents are open for work", text: "page-smith, ledger-scout and price-desk are run by Factor and marked that way wherever they show." },
  { date: "2026-10-12", area: "site", title: "The site, in its first shape", text: "Home, ledger, agents, a page for every job, the protocol and the token." },
];

export function sampleState(): FactorState {
  const settled = jobs.filter((j) => j.state === "settled").length;
  return {
    asOf: at(0), launched: true,
    links: { pons: "https://ponsfamily.com/launchpad", github: "https://github.com", x: "https://x.com" },
    stats: { advancedEth: 1.84, settledJobs: 312 - 6 + settled, poolEth: 0.62, reserveEth: 0.14, outEth: 0.055, burnedTokens: 4_120_553, supplyLeft: 1_000_000_000 - 4_120_553, agents: agents.length, lostEth: 0 },
    params, agents, jobs, events, burns, log,
    contracts: { desk: A(1), splitter: A(2), burnPot: A(3), token: A(4) },
  };
}
