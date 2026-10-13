// An agent's score and its limit with the pool, worked out from its record exactly as the desk does
// (FactorDesk.score, limit and canDraw). The desk's own answer is the truth; this is the same arithmetic, so that
// the site can show every agent's score without asking the chain for each one, and show the parts it is made of.

import type { AgentRecord } from "./desk.js";

export interface ScorePart {
  name: string;
  value: string;
  points: number;
  max: number;
}

const capped = (v: bigint | number, max: number): number => {
  const n = typeof v === "bigint" ? (v > BigInt(max) ? max : Number(v)) : v;
  return Math.min(n, max);
};

/** The five parts, before anything is taken off. `nowS` is the chain's time in seconds. */
export function scoreParts(r: AgentRecord, nowS: number): ScorePart[] {
  const fees = BigInt(r.feesPaid);
  const days = r.firstSettledAt > 0 && nowS > r.firstSettledAt ? Math.floor((nowS - r.firstSettledAt) / 86_400) : 0;
  return [
    { name: "Fees paid into the pool", value: fees.toString(), points: capped(fees / 500_000_000_000_000n, 350), max: 350 },
    { name: "Different customers", value: String(r.customers), points: capped(r.customers * 25, 250), max: 250 },
    { name: "Jobs settled", value: String(r.settled), points: capped(r.settled * 10, 200), max: 200 },
    { name: "Days since its first job", value: String(days), points: capped(days * 2, 100), max: 100 },
    { name: "Advances repaid", value: String(r.advancesRepaid), points: capped(r.advancesRepaid * 10, 100), max: 100 },
  ];
}

/** 0 to 1000. 0 once an advance was not repaid or an early advance was kept without delivering. */
export function scoreOf(r: AgentRecord, nowS: number): number {
  if (r.advancesNotRepaid > 0 || r.earlyKept > 0) return 0;
  const sum = scoreParts(r, nowS).reduce((n, p) => n + p.points, 0);
  return Math.max(0, sum - r.settledAtHalf * 50);
}

/** How far the pool goes for it: its bond plus the fees its jobs have paid in. Nothing once barred. */
export function limitOf(r: AgentRecord): bigint {
  return r.barred ? 0n : BigInt(r.bond) + BigInt(r.feesPaid);
}

export function canDrawOf(r: AgentRecord): bigint {
  const limit = limitOf(r);
  const out = BigInt(r.advancedNow);
  return limit > out ? limit - out : 0n;
}
