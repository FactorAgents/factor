// The score and the limit, against the same cases the contract's own tests use (contracts/test/Desk.t.sol), so the
// two cannot drift apart unnoticed.

import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/desk.js";
import { canDrawOf, limitOf, scoreOf, scoreParts } from "../src/score.js";

const ETH = 10n ** 18n;
const T0 = 1_791_288_000;
const record = (over: Partial<AgentRecord>): AgentRecord => ({
  registered: true, barred: false, firstSettledAt: 0, settled: 0, settledAtHalf: 0, notDelivered: 0, unanswered: 0, customers: 0, onTime: 0, late: 0,
  advancesRepaid: 0, advancesNotRepaid: 0, earlyKept: 0, bond: "0", feesPaid: "0", advancedNow: "0", volume: "0", ...over,
});

describe("the score", () => {
  it("is nothing for an agent with no record", () => {
    expect(scoreOf(record({}), T0)).toBe(0);
  });

  it("follows the formula: test_theScoreFollowsTheFormula", () => {
    // two settled jobs of 1 ETH from two customers, one with an advance repaid
    const r = record({ settled: 2, customers: 2, advancesRepaid: 1, feesPaid: ((ETH * 4n) / 100n).toString(), firstSettledAt: T0 });
    expect(scoreOf(r, T0)).toBe(160);
    expect(scoreOf(r, T0 + 3 * 86400 + 3600)).toBe(166);
    // a rejected job of 1 ETH: its fee on the half adds 20, the rejection takes 50
    const half = { ...r, settledAtHalf: 1, feesPaid: ((ETH * 5n) / 100n).toString() };
    expect(scoreOf(half, T0 + 3 * 86400 + 3600)).toBe(166 + 20 - 50);
    // a job it never answered costs nothing
    expect(scoreOf({ ...half, unanswered: 1 }, T0 + 3 * 86400 + 3600)).toBe(136);
    // a job it drew on and did not deliver ends the score
    expect(scoreOf({ ...half, notDelivered: 1, earlyKept: 1, barred: true }, T0 + 9 * 86400)).toBe(0);
    expect(scoreOf({ ...half, notDelivered: 1, advancesNotRepaid: 1, barred: true }, T0 + 9 * 86400)).toBe(0);
  });

  it("stops at its caps: test_theScoreStopsAtItsCaps", () => {
    const r = record({ settled: 21, customers: 11, feesPaid: (21n * ETH / 5n).toString(), firstSettledAt: T0 });
    expect(scoreOf(r, T0)).toBe(350 + 250 + 200);
    expect(scoreOf(r, T0 + 400 * 86400)).toBe(900);
    expect(scoreOf({ ...r, advancesRepaid: 50 }, T0 + 400 * 86400)).toBe(1000);
  });

  it("never goes under zero, and shows its five parts", () => {
    const r = record({ settledAtHalf: 5, settled: 1, firstSettledAt: T0 });
    expect(scoreOf(r, T0)).toBe(0);
    expect(scoreParts(r, T0).map((p) => [p.points, p.max])).toEqual([[0, 350], [0, 250], [10, 200], [0, 100], [0, 100]]);
  });

  it("counts a point for every 0.0005 ETH of fees, rounded down", () => {
    expect(scoreOf(record({ feesPaid: "499999999999999" }), T0)).toBe(0);
    expect(scoreOf(record({ feesPaid: "500000000000000" }), T0)).toBe(1);
    expect(scoreOf(record({ feesPaid: (ETH * 1000n).toString() }), T0)).toBe(350);
  });
});

describe("the limit with the pool", () => {
  it("is the bond plus the fees paid, counted once, less what is out", () => {
    const r = record({ bond: (ETH / 50n).toString(), feesPaid: ((ETH * 8n) / 10000n).toString(), advancedNow: (ETH / 100n).toString() });
    expect(limitOf(r)).toBe(ETH / 50n + (ETH * 8n) / 10000n);
    expect(canDrawOf(r)).toBe(ETH / 100n + (ETH * 8n) / 10000n);
  });

  it("is nothing once the agent is barred, whatever it posts", () => {
    const r = record({ barred: true, bond: ETH.toString(), feesPaid: ETH.toString() });
    expect(limitOf(r)).toBe(0n);
    expect(canDrawOf(r)).toBe(0n);
  });
});
