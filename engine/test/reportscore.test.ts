// Factor Credit Reports, the formula (src/reportscore.ts, docs/REPORTS.md): every part on its own, every pull, and each
// trick the anti-gaming rules are for, carried out and shown not to pay: loans looped, money borrowed and returned unused,
// a wallet shared by many agents, feedback from the agent's own hand or from wallets that never paid it, jobs paid by
// itself, a fresh identity, an identity from a wallet that made thousands. And the same input always gives the same score.

import { describe, expect, it } from "vitest";
import { FORMULA, REPORT_VERSION, loanWeight, onHundred, scoreReport, windowed, type DeskJobIn, type FeedbackIn, type LoanIn, type ReportInput, type ReviewIn } from "../src/reportscore.js";

const NOW = 1_800_000_000;
const DAY = 86_400;
const ETH = 10n ** 18n;
const AGENT = "0x00000000000000000000000000000000000a6e01";
const OWNER = "0x00000000000000000000000000000000000a6e02";
const MAKER = "0x00000000000000000000000000000000000a6e03";
const cust = (i: number) => `0x0000000000000000000000000000000000c0${String(i).padStart(4, "0")}`;

function input(o: Partial<ReportInput> = {}): ReportInput {
  const wallets = o.wallets ?? [AGENT, OWNER];
  return {
    nowS: NOW, registeredAt: NOW - 200 * DAY, wallets, maker: null, factorOwn: false,
    own: (a) => (wallets.includes(a.toLowerCase()) ? "its own wallet" : null),
    desk: [], line: null, loans: [], loanShare: () => 1, helpers: new Set(), feedback: [], factorWriter: null, reviews: [], validations: [],
    ...o,
  };
}

let jobN = 0;
function job(o: Partial<DeskJobIn> & { customer: string; priceEth?: number } ): DeskJobIn {
  const price = BigInt(Math.round((o.priceEth ?? 0.05) * 1e6)) * 10n ** 12n;
  return { id: ++jobN, price: price.toString(), fee: (price / 50n).toString(), state: 4, lockedAt: NOW - 30 * DAY, closedAt: NOW - 20 * DAY, deliveredAt: NOW - 21 * DAY, late: false, fromPool: "0", early: "0", demo: false, ...o };
}

let loanN = 0;
function loan(o: Partial<LoanIn> & { usd?: number; heldS?: number; at?: number } = {}): LoanIn {
  const at = o.at ?? NOW - 40 * DAY;
  const held = o.heldS ?? 7 * DAY;
  return { pool: "0xpool", id: ++loanN, principalMicro: Math.round((o.usd ?? 25) * 1e6), borrowedAt: at, dueAt: at + 30 * DAY, recipient: AGENT, repaidAt: at + held, payer: AGENT, defaultedAt: null, ...o };
}

const part = (r: ReturnType<typeof scoreReport>, k: string) => r.parts.find((p) => p.key === k)!.points;
const flag = (r: ReturnType<typeof scoreReport>, k: string) => r.flags.find((f) => f.key === k);

describe("the formula's frame", () => {
  it("is versioned, sums to 1000, and an agent with nothing counted scores 0 and says so", () => {
    expect(REPORT_VERSION).toBe("factor-report/1.1.0");
    expect(Object.values(FORMULA.parts).reduce((a, b) => a + b, 0)).toBe(1000);
    const r = scoreReport(input());
    expect(r).toMatchObject({ score: 0, of: 1000, blank: true, version: REPORT_VERSION, pulls: [] });
    expect(r.parts.map((p) => p.key)).toEqual(["work", "repayment", "feedback", "time", "reliability"]);
    expect(r.raise[0]).toMatch(/Take paid work on the Factor desk/);
  });

  it("gives the same answer for the same input, in any order of its rows", () => {
    const desk = [job({ customer: cust(1) }), job({ customer: cust(2), state: 5 }), job({ customer: cust(3), late: true })];
    const loans = Array.from({ length: 30 }, (_, i) => loan({ usd: 5 + i, heldS: 3600 * (i + 1), at: NOW - (60 - i) * DAY }));
    const a = scoreReport(input({ desk, loans }));
    const b = scoreReport(input({ desk: [...desk].reverse(), loans: [...loans].reverse() }));
    expect(b).toEqual(a);
  });

  it("is never below 0 nor above 1000, and its sources add up to its parts when nothing pulls", () => {
    const desk = Array.from({ length: 40 }, (_, i) => job({ customer: cust(i), priceEth: 0.5, closedAt: NOW - i * 7 * DAY }));
    const r = scoreReport(input({ desk, loans: Array.from({ length: 20 }, (_, i) => loan({ usd: 100, at: NOW - i * 31 * DAY })) }));
    expect(r.score).toBeLessThanOrEqual(1000);
    expect(r.sources.reduce((a, s) => a + s.points, 0)).toBe(r.parts.reduce((a, p) => a + p.points, 0));
    const bad = scoreReport(input({ loans: [loan({ repaidAt: null, payer: null, defaultedAt: NOW - DAY })] }));
    expect(bad.score).toBe(0);
  });
});

describe("paid work", () => {
  it("counts value on a log scale, full at 0.05 ETH, customers from 0.003 ETH of work, and jobs, up to 400", () => {
    // one customer, one job of 0.05 ETH: the value part is full, and the customer counts
    const one = scoreReport(input({ desk: [job({ customer: cust(1), priceEth: 0.05 })] }));
    expect(part(one, "work")).toBe(200 + 30 + 5);
    const small = scoreReport(input({ desk: [job({ customer: cust(1), priceEth: 0.004 })] }));
    expect(part(small, "work")).toBe(Math.floor(200 * Math.log2(1 + 0.004 / 0.001) / Math.log2(51)) + 30 + 5);
    // a customer under the bar is not counted as one, but its money is
    const dust = scoreReport(input({ desk: [job({ customer: cust(1), priceEth: 0.002 })] }));
    expect(part(dust, "work")).toBe(Math.floor(200 * Math.log2(1 + 0.002 / 0.001) / Math.log2(51)) + 0 + 5);
    expect(dust.counts).toMatchObject({ deskCustomers: 0, deskCustomersAll: 1 });
    const lots = scoreReport(input({ desk: Array.from({ length: 30 }, (_, i) => job({ customer: cust(i), priceEth: 0.1 })) }));
    expect(part(lots, "work")).toBe(400);
  });

  it("does not count jobs paid by the agent's own hand, or Factor's demonstrations, and says so", () => {
    const r = scoreReport(input({ desk: [job({ customer: OWNER }), job({ customer: cust(9), demo: true }), job({ customer: cust(1) })] }));
    expect(r.counts.deskJobsPaid).toBe(1);
    expect(flag(r, "own-jobs")).toMatchObject({ count: 1, tone: "warn" });
    expect(flag(r, "demo-jobs")).toMatchObject({ count: 1 });
    const self = scoreReport(input({ desk: [job({ customer: OWNER, priceEth: 1 })] }));
    expect(self.score).toBe(0);
    expect(self.blank).toBe(true);
  });

  it("takes 25 for each job settled at half, and counts half its value", () => {
    const r = scoreReport(input({ desk: [job({ customer: cust(1), state: 5, priceEth: 0.04 })] }));
    expect(r.counts.deskValueWei).toBe((2n * 10n ** 16n).toString());
    expect(r.pulls).toEqual([expect.objectContaining({ key: "half", count: 1, points: -25 })]);
  });
});

describe("repayment and the loan tricks", () => {
  it("weighs a loan by size and time held, up to one unit at $10 for 7 days", () => {
    expect(loanWeight({ principalMicro: 10e6, borrowedAt: 0, repaidAt: 7 * DAY })).toBe(1);
    expect(loanWeight({ principalMicro: 5e6, borrowedAt: 0, repaidAt: 3600 })).toBeCloseTo(0.5 / 168, 8);
    expect(loanWeight({ principalMicro: 500e6, borrowedAt: 0, repaidAt: 30 * DAY })).toBe(1);
    const r = scoreReport(input({ loans: [loan()] }));
    expect(part(r, "repayment")).toBe(Math.floor(250 * Math.sqrt(1 / 6)));
  });

  it("looping hundreds of $7 loans returned within the hour is worth less than one real loan", () => {
    const loops = Array.from({ length: 700 }, (_, i) => loan({ usd: 7, heldS: 1800, at: NOW - 60 * DAY + i * 3 * 3600 }));
    const looped = scoreReport(input({ loans: loops }));
    const real = scoreReport(input({ loans: [loan({ usd: 25, heldS: 7 * DAY })] }));
    expect(part(looped, "repayment")).toBeLessThan(part(real, "repayment"));
    expect(flag(looped, "loop-loans")).toMatchObject({ tone: "warn" });
    expect(flag(looped, "quick-loans")).toMatchObject({ count: 700 });
    expect(flag(looped, "loop-loans")!.effect).toMatch(/the second half, the third a third/);
  });

  it("gives diminishing credit inside 30 days: the second counts half, the third a third", () => {
    const w = windowed([1, 2, 3].map((i) => ({ at: i * DAY, w: 1, k: String(i) })), (x) => x.at, (x) => x.w, (x) => x.k);
    expect(w.total).toBeCloseTo(1 + 1 / 2 + 1 / 3, 10);
    const apart = windowed([1, 2, 3].map((i) => ({ at: i * 31 * DAY, w: 1, k: String(i) })), (x) => x.at, (x) => x.w, (x) => x.k);
    expect(apart.total).toBe(3);
  });

  it("splits a loan's credit between the agents that share the wallet it went to or was repaid from", () => {
    const SHARED = "0x0000000000000000000000000000000000005a4e";
    const alone = scoreReport(input({ loans: [loan({ recipient: SHARED, payer: SHARED })], loanShare: () => 1 }));
    const shared = scoreReport(input({ loans: [loan({ recipient: SHARED, payer: SHARED })], loanShare: (w) => (w === SHARED ? 6 : 1) }));
    expect(part(shared, "repayment")).toBeLessThan(part(alone, "repayment"));
    expect(flag(shared, "shared-wallet")).toMatchObject({ count: 1 });
    // the agent's own wallets and Priors' own repaying contracts are never "shared"
    const HELPER = "0x0000000000000000000000000000000000000ae1";
    const helped = scoreReport(input({ loans: [loan({ payer: HELPER })], loanShare: (w) => (w === HELPER ? 50 : 1), helpers: new Set([HELPER]) }));
    expect(flag(helped, "shared-wallet")).toBeUndefined();
    expect(part(helped, "repayment")).toBe(part(alone, "repayment"));
  });

  it("counts a Factor pool advance repaid by its job as up to half a unit, and a credit line repaid on time as one", () => {
    const adv = scoreReport(input({ desk: [job({ customer: cust(1), fromPool: (ETH / 100n).toString() })] }));
    expect(adv.counts.advancesRepaid).toBe(1);
    expect(part(adv, "repayment")).toBe(Math.floor(250 * Math.sqrt(0.5 / 6)));
    const line = scoreReport(input({ line: { onTime: 3, late: 0, defaulted: false } }));
    expect(part(line, "repayment")).toBe(Math.floor(250 * Math.sqrt(3 / 6)));
  });
});

describe("feedback from paying clients", () => {
  const fb = (o: Partial<FeedbackIn>): FeedbackIn => ({ client: cust(1), index: 1, value: "90", decimals: 0, tag1: "", tag2: "", revoked: false, at: NOW - DAY, ...o });
  const paid = [job({ customer: cust(1) }), job({ customer: cust(2) })];

  it("counts a paying client's rating once, by what it said last", () => {
    const r = scoreReport(input({ desk: paid, feedback: [fb({ value: "20", at: NOW - 5 * DAY }), fb({ value: "95", index: 2, at: NOW - DAY })] }));
    expect(part(r, "feedback")).toBe(50);
    expect(r.counts.payingClients).toBe(1);
    const bad = scoreReport(input({ desk: paid, feedback: [fb({ value: "10" }), fb({ client: cust(2), value: "100" })] }));
    expect(part(bad, "feedback")).toBe(0); // 50 - 50
  });

  it("never counts the agent's own hand, wallets that never paid it, revoked entries, values that are not ratings, or Factor's own job entries", () => {
    const WRITER = "0x000000000000000000000000000000000000f4c7";
    const r = scoreReport(input({
      desk: paid, factorWriter: WRITER,
      feedback: [fb({ client: OWNER }), fb({ client: cust(77) }), fb({ revoked: true }), fb({ client: cust(2), value: "4150840869069319800", decimals: 18 }), fb({ client: cust(2), value: "-5" }), fb({ client: WRITER, value: "100" })],
    }));
    expect(part(r, "feedback")).toBe(0);
    expect(flag(r, "own-feedback")).toMatchObject({ count: 1 });
    expect(flag(r, "unpaid-feedback")).toMatchObject({ count: 1 });
    expect(onHundred("4500", 2)).toBe(45);
    expect(onHundred("101", 0)).toBeNull();
  });

  it("reads a paid review written to ERC-8004 as stars, and a score or a statement as no opinion at all", () => {
    expect(part(scoreReport(input({ desk: paid, feedback: [fb({ tag1: "factorReview", value: "5" })] })), "feedback")).toBe(50);
    expect(part(scoreReport(input({ desk: paid, feedback: [fb({ tag1: "factorReview", value: "2" })] })), "feedback")).toBe(0);
    for (const tag1 of ["factorScore", "priors-score", "credit.statement", "account.statement", "factor"]) expect(scoreReport(input({ desk: paid, feedback: [fb({ tag1, value: "99" })] })).counts.payingClients, tag1).toBe(0);
  });

  it("counts a paid review from the customer, and not one marked self-dealing", () => {
    const rv = (o: Partial<ReviewIn>): ReviewIn => ({ job: 1, reviewer: cust(1), stars: 5, at: NOW - DAY, self: null, ...o });
    expect(part(scoreReport(input({ desk: paid, reviews: [rv({}), rv({ reviewer: cust(2), stars: 3 })] })), "feedback")).toBe(65);
    expect(part(scoreReport(input({ desk: paid, reviews: [rv({ self: "the agent's own wallet" })] })), "feedback")).toBe(0);
  });
});

describe("time, reliability and the pulls", () => {
  it("counts the days from the first counted activity to the latest, all of it at 90", () => {
    const desk = Array.from({ length: 4 }, (_, i) => job({ customer: cust(1), closedAt: NOW - i * 7 * DAY - DAY }));
    expect(part(scoreReport(input({ desk })), "time")).toBe(Math.floor(100 * 21 / 90));
    const long = Array.from({ length: 4 }, (_, i) => job({ customer: cust(1), closedAt: NOW - i * 40 * DAY - DAY }));
    expect(part(scoreReport(input({ desk: long })), "time")).toBe(100);
    // tiny loans make no activity: a loan counts from $10 held a day
    expect(part(scoreReport(input({ loans: Array.from({ length: 20 }, (_, i) => loan({ usd: 6, heldS: 600, at: NOW - i * 7 * DAY - 3 * DAY })) })), "time")).toBe(0);
  });

  it("scores the share on time, in full from five, and validators that passed its work, never its own", () => {
    const desk = Array.from({ length: 10 }, (_, i) => job({ customer: cust(i), late: i < 2 }));
    expect(scoreReport(input({ desk })).counts).toMatchObject({ onTime: 8, late: 2 });
    expect(part(scoreReport(input({ desk })), "reliability")).toBe(64);
    const V = "0x00000000000000000000000000000000000ba11d";
    const v = scoreReport(input({ validations: [{ validator: V, response: 90, tag: "", at: NOW - DAY }, { validator: OWNER, response: 100, tag: "", at: NOW - DAY }, { validator: cust(5), response: 10, tag: "", at: NOW - DAY }] }));
    expect(part(v, "reliability")).toBe(10);
  });

  it("counts no loop toward reliability: only a loan of $10 held a day shows the agent repays on time", () => {
    const loops = Array.from({ length: 200 }, (_, i) => loan({ usd: 7, heldS: 1800, at: NOW - 60 * DAY + i * 3 * 3600 }));
    expect(part(scoreReport(input({ loans: loops })), "reliability")).toBe(0);
    const real = Array.from({ length: 5 }, (_, i) => loan({ usd: 20, heldS: 3 * DAY, at: NOW - 200 * DAY + i * 35 * DAY }));
    expect(part(scoreReport(input({ loans: real })), "reliability")).toBe(80);
  });

  it("pulls hard for a default and a missed delivery, whoever the customer was", () => {
    const desk = [job({ customer: cust(1) }), job({ customer: cust(2), state: 7, fromPool: "1000", deliveredAt: 0 }), job({ customer: OWNER, state: 7, deliveredAt: 0 })];
    const r = scoreReport(input({ desk, loans: [loan({ repaidAt: null, payer: null, defaultedAt: NOW - DAY })] }));
    expect(r.pulls.find((p) => p.key === "default")).toMatchObject({ count: 2, points: -600 });
    expect(r.pulls.find((p) => p.key === "missed")).toMatchObject({ count: 1, points: -100 });
    expect(flag(r, "default")!.tone).toBe("bad");
    expect(r.score).toBe(0);
    expect(scoreReport(input({ line: { onTime: 0, late: 0, defaulted: true } })).pulls[0]).toMatchObject({ key: "default", points: -300 });
    expect(scoreReport(input({ line: { onTime: 2, late: 1, defaulted: false } })).pulls[0]).toMatchObject({ key: "lineLate", points: -50 });
  });
});

describe("the flags for who an agent is", () => {
  it("flags a fresh identity, and lets time count only what it has", () => {
    const r = scoreReport(input({ registeredAt: NOW - 3 * DAY }));
    expect(flag(r, "fresh")).toMatchObject({ tone: "info" });
    expect(flag(r, "fresh")!.words).toMatch(/3 days ago/);
    expect(flag(scoreReport(input({ registeredAt: NOW - 30 * DAY })), "fresh")).toBeUndefined();
  });

  it("flags an identity from a wallet that made many, and does not count dealings between them", () => {
    const SIBLING = "0x00000000000000000000000000000000005151b1";
    const own = (a: string) => ([AGENT, OWNER].includes(a) ? "its own" : a === SIBLING ? "a wallet of another agent registered by the same wallet" : null);
    const r = scoreReport(input({ maker: { address: MAKER, identities: 10_000 }, own, desk: [job({ customer: SIBLING, priceEth: 0.5 })], feedback: [{ client: SIBLING, index: 1, value: "100", decimals: 0, tag1: "", tag2: "", revoked: false, at: NOW }] }));
    expect(flag(r, "mass-maker")!.words).toMatch(/10,000 identities/);
    expect(r.score).toBe(0);
  });

  it("marks Factor's own agents, scored the same way", () => {
    const desk = [job({ customer: cust(1) })];
    const a = scoreReport(input({ desk, factorOwn: true }));
    expect(flag(a, "factor-own")).toBeTruthy();
    expect(a.score).toBe(scoreReport(input({ desk })).score);
  });
});
