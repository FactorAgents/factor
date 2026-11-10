// Credit reports for the site's sample mode (FACTOR_SAMPLE=1): made-up agents in the engine's real shapes
// (engine/src/reports.ts), so every report page draws without an engine. Never on the real site: the sample is refused
// whenever FACTOR_ENGINE_URL is set.
import type { Report, ReportRow, ReportsAbout } from "./reports";

const SITE = "https://factoragents.fun";
const wallet = (n: number) => `0x${n.toString(16).padStart(4, "0")}${"5a".repeat(18)}`;

const ROWS: ReportRow[] = [
  { subject: "8004:486", agentId: "486", wallet: wallet(486), name: "ledger-reader", score: 538, parts: { work: 262, repayment: 125, feedback: 30, time: 70, reliability: 51 }, pulled: 0, flags: [], sources: ["factor-desk", "factor-lines", "factor-reviews"], factorOwn: false, rank: 1, lastAt: "2026-11-09T14:00:00.000Z" },
  { subject: "8004:8729", agentId: "8729", wallet: wallet(8729), name: "steady-lender", score: 147, parts: { work: 0, repayment: 93, feedback: 0, time: 30, reliability: 24 }, pulled: 0, flags: ["unpaid-feedback"], sources: ["priors"], factorOwn: false, rank: 2, lastAt: "2026-11-08T13:00:00.000Z" },
  { subject: "8004:20852", agentId: "20852", wallet: wallet(20852), name: "report-writer", score: 102, parts: { work: 84, repayment: 8, feedback: 0, time: 30, reliability: 80 }, pulled: -100, flags: ["missed", "fresh"], sources: ["factor-desk"], factorOwn: false, rank: 3, lastAt: "2026-11-07T17:09:00.000Z" },
  { subject: "8004:467", agentId: "467", wallet: wallet(467), name: "loop-runner", score: 61, parts: { work: 0, repayment: 11, feedback: 0, time: 10, reliability: 40 }, pulled: 0, flags: ["loop-loans", "quick-loans", "unpaid-feedback"], sources: ["priors"], factorOwn: false, rank: 4, lastAt: "2026-11-09T22:00:00.000Z" },
];

export function sampleReportsAbout(): ReportsAbout {
  return {
    enabled: true, version: "factor-report/1.0.0", chainId: 4663, found: 22_880, identities: 22_841, scored: 418, ranked: 416, withRecord: 431,
    spread: [{ from: 0, to: 0, n: 22_462 }, { from: 1, to: 99, n: 384 }, { from: 100, to: 249, n: 31 }, { from: 250, to: 499, n: 2 }, { from: 500, to: 749, n: 1 }, { from: 750, to: 1000, n: 0 }],
    bySource: [{ source: "factor-desk", name: "Factor desk", agents: 11 }, { source: "factor-lines", name: "Factor credit lines", agents: 1 }, { source: "priors", name: "Loans on Priors", agents: 407 }, { source: "erc8004-reputation", name: "ERC-8004 reputation", agents: 2 }, { source: "erc8004-validation", name: "ERC-8004 validation", agents: 0 }, { source: "factor-reviews", name: "Factor paid reviews", agents: 1 }, { source: "erc8004-identity", name: "ERC-8004 identity", agents: 0 }],
    read: {
      erc8004: { from: 12_000_000, readDownTo: 12_000_000, readUpTo: 110_760_000, done: true, feedback: 11_320, revoked: 7_790, validationRequests: 10_527, validationResponses: 0 },
      priors: { from: 68_593_823, readDownTo: 68_593_823, readUpTo: 110_760_000, done: true, loans: 57_043, repaid: 56_755, defaulted: 11, pools: ["0x0259889e6EBab1a18CeE7e62Bc5B9648FB6C44e5", "0x281210097f0de7A8FB6F87310AF0f089c9C8DE21"] },
      factor: { agents: 46 },
    },
    caughtUp: true, scoredAt: "2026-11-10T09:00:00.000Z",
    registries: { identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63", validation: "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58" },
    signer: null,
  };
}

export function sampleReportsTop(offset = 0, own = false): { enabled: true; items: ReportRow[]; total: number } {
  if (own) return { enabled: true, total: 1, items: [{ subject: "0x00000000000000000000000000000000000f4c70", agentId: null, wallet: "0x00000000000000000000000000000000000f4c70", name: "page-smith", score: 40, parts: { work: 22, repayment: 0, feedback: 0, time: 10, reliability: 8 }, pulled: 0, flags: ["factor-own"], sources: ["factor-desk"], factorOwn: true, rank: null, lastAt: null }] };
  return { enabled: true, total: ROWS.length, items: ROWS.slice(offset) };
}

export function sampleReportsFind(q: string): { enabled: true; items: ReportRow[] } {
  const s = q.trim().toLowerCase().replace(/^#/, "");
  return { enabled: true, items: ROWS.filter((r) => r.agentId === s || r.wallet === s || r.name.includes(s)).slice(0, 12) };
}

export function sampleReport(id: string): Report | null {
  const row = ROWS.find((r) => r.agentId === id.replace(/^#/, "") || r.wallet === id.toLowerCase() || r.name === id);
  if (!row) return null;
  const loops = row.flags.includes("loop-loans");
  const desk = row.sources.includes("factor-desk");
  return {
    enabled: true, version: "factor-report/1.0.0", score: row.score, of: 1000, blank: false, rank: row.rank, ranked: 416,
    agent: { subject: row.subject, agentId: row.agentId, name: row.name, nameFrom: "chain", about: desk ? "Reads ledgers and statements and gives back the figures as a sheet." : "Borrows on its credit line and repays each loan.", owner: row.wallet, agentWallet: row.wallet, maker: row.wallet, desk: desk ? [row.wallet!] : [], registeredAt: "2026-10-04T10:00:00.000Z", uri: null, factorOwn: false },
    parts: [
      { key: "work", name: "Paid work", points: row.parts.work, max: 400, why: desk ? "14 jobs paid in full on the Factor desk, 0.4100 ETH in all, from 6 customers." : "No job paid on the Factor desk by a customer who is not its own hand.", lines: [] },
      { key: "repayment", name: "Repayment", points: row.parts.repayment, max: 250, why: loops ? "0.02 repayment units: 733 loans repaid on Priors." : "3.00 repayment units: 6 advances from the Factor pool repaid by their jobs, a Factor credit line repaid 2 times.", lines: [] },
      { key: "feedback", name: "Paying clients' feedback", points: row.parts.feedback, max: 150, why: row.parts.feedback ? "1 paying client said something: 1 good, 0 middling, 0 bad." : "No client that paid it has said anything yet.", lines: [] },
      { key: "time", name: "Time active", points: row.parts.time, max: 100, why: `Counted activity in ${row.parts.time / 10} weeks.`, lines: [] },
      { key: "reliability", name: "Reliability", points: row.parts.reliability, max: 100, why: "13 of 14 on time.", lines: [] },
    ],
    pulls: row.pulled ? [{ key: "missed", count: 1, points: row.pulled, why: "1 job on the desk not delivered by its time and refunded to the customer: 100 points off each." }] : [],
    flags: loops ? [
      { key: "loop-loans", title: "Many small loans in a loop", tone: "warn", count: 733, words: "Up to 412 loans repaid within 30 days. Taking a loan and giving it back again and again shows the agent can pay money back, not that it earns any.", effect: "In each 30 days the biggest repayment counts in full, the second half, the third a third. That left out 0.91 of 0.93 repayment units." },
      { key: "quick-loans", title: "Borrowed and returned unused", tone: "warn", count: 640, words: "640 loans were repaid within an hour by the same wallet they were paid to. Money that comes straight back was never spent on anything.", effect: "A loan counts by its size and by how long it was held, up to 7 days: a loan held an hour is worth under 1% of one held a week." },
    ] : row.pulled ? [{ key: "missed", title: "Missed deliveries", tone: "bad", count: 1, words: "1 job was not delivered in time and the customer was refunded.", effect: "100 points off for each." }] : [],
    sources: Object.entries(row.parts).filter(([, v]) => v > 0).length ? (desk ? [{ source: "factor-desk", name: "Factor desk", points: row.score - 30 }, { source: "factor-lines", name: "Factor credit lines", points: 30 }] : [{ source: "priors", name: "Loans on Priors", points: row.score }]) : [],
    raise: ["More customers: each new customer whose jobs pay about 0.05 ETH of work adds 30 points, up to 150.", "Keep working: each week with paid work or a repayment that counts adds 10, up to 100."],
    counts: {}, firstAt: "2026-10-12T09:00:00.000Z", lastAt: row.lastAt, asOf: "2026-11-10T09:00:00.000Z", block: 110_760_000,
    timeline: [
      { at: "2026-11-09T14:00:00.000Z", source: desk ? "factor-desk" : "priors", kind: "paid", text: desk ? "Job 41 paid in full: 0.05 ETH, delivered on time" : "A loan repaid on Priors, $25 in all", counted: true },
      { at: "2026-11-02T11:00:00.000Z", source: "erc8004-reputation", kind: "feedback", text: "An entry on ERC-8004 from 0x03af…7ac7 (credit.statement)", counted: false, why: "see the entries below for which count" },
      { at: "2026-10-04T10:00:00.000Z", source: "erc8004-identity", kind: "registered", text: `Registered as ERC-8004 identity #${row.agentId}`, counted: false, why: "an identity is not a record" },
    ],
    erc8004: [{ client: "0x03af41aeb1eea4da0572bbb6ab1b4c5331f17ac7", tag1: "credit.statement", tag2: "unsecured", value: "10", at: "2026-11-02T11:00:00.000Z", counted: false, why: "this wallet never paid the agent for a job on the chain" }],
    claim: null,
    links: { page: `${SITE}/reports/${row.agentId}`, card: `${SITE}/api/v1/reports/${row.agentId}/card.png`, badge: `${SITE}/api/v1/reports/${row.agentId}/badge.svg`, signed: `${SITE}/api/v1/reports/signed/${row.agentId}`, erc8004: null, desk: desk ? `${SITE}/agents/${row.name}` : null },
  };
}
