// The credit report for an agent on the NEAR desk: one public formula, pure (the same input always gives the same
// report). It follows Factor's credit reports on Robinhood Chain: paid work counts most, then advances repaid by
// delivered work, then delivering on time, paying the agents it hires, and time active; defaults and refunds pull
// the score down; and nothing the agent paid itself through its own accounts counts.

export const VERSION = "factor-near-report/0.1.0";

const DAY = 86_400_000;
const YOCTO = 10n ** 24n;

export const FORMULA = {
  parts: {
    paidWork: { max: 400, name: "Paid work" },
    repayment: { max: 250, name: "Advances repaid" },
    reliability: { max: 150, name: "On time" },
    hiring: { max: 100, name: "Pays who it hires" },
    time: { max: 100, name: "Time active" },
  },
  paidWork: { valueMax: 200, step: 0.1, full: 5, perCustomer: 30, customerMax: 150, customerMin: 0.3, perJob: 5, jobMax: 50 },
  repayment: { fullAdvance: 0.5, units: 6, windowDays: 30 },
  reliability: { full: 5 },
  hiring: { perAgent: 25 },
  time: { fullDays: 90 },
  pulls: { default: 300, missed: 100, half: 25 },
  freshDays: 14,
} as const;

export type JobStatus = "Open" | "Working" | "Delivered" | "Paid" | "Half" | "Refunded" | "Cancelled";

/** A desk job as the desk returns it (amounts as decimal strings in the token's smallest unit). */
export interface DeskJob {
  id: number;
  customer: string;
  payer: string;
  agent: string | null;
  token: string | null;
  price: string;
  advanced: string;
  reserved: string;
  parent: number | null;
  status: JobStatus;
  created_ms: string;
  due_ms: string;
  delivered_ms: string | null;
  closed_ms: string | null;
  note?: string | null;
}

/** Why two accounts are run by the same hand, or null. */
export type SameHand = (a: string, b: string) => string | null;

export interface ScoreInput {
  agent: string;
  jobs: DeskJob[];
  sameHand: SameHand;
  /** Factor's own accounts (the desk, its fee account, its demo infrastructure): never a paying client. */
  own: Set<string>;
  /** Accounts that only carry money for someone else (NEAR Intents): the customer they name is the counterparty. */
  carriers: Set<string>;
  /** NEAR per unit of each token (a token's smallest unit to NEAR); a token missing here is not valued. */
  nearPerUnit: Record<string, number>;
  /** When the agent's account was created, if known. */
  createdMs?: number;
  nowMs: number;
}

export interface Part {
  key: keyof typeof FORMULA.parts;
  name: string;
  points: number;
  max: number;
  why: string;
}
export interface Pull {
  key: "default" | "missed" | "half";
  count: number;
  points: number;
  why: string;
}
export interface Flag {
  key: string;
  words: string;
}
export interface CountedJob {
  id: number;
  role: "agent" | "hirer";
  counterparty: string;
  status: JobStatus;
  valueNear: number;
  counted: boolean;
  why: string;
}

export interface Report {
  version: string;
  agent: string;
  score: number;
  parts: Part[];
  pulls: Pull[];
  flags: Flag[];
  jobs: CountedJob[];
  raise: string[];
  totals: { jobs: number; counted: number; excluded: number; earnedNear: number };
}

const down = (x: number): number => Math.floor(x + 1e-9);
const big = (s: string | null | undefined): bigint => {
  try {
    return BigInt(s ?? "0");
  } catch {
    return 0n;
  }
};
const toNear = (amount: bigint, token: string | null, rates: Record<string, number>): number | null => {
  if (!token) return Number((amount * 1_000_000n) / YOCTO) / 1e6;
  const r = rates[token];
  return r === undefined ? null : Number(amount) * r;
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Everyone whose money a job is, up the chain of sub-jobs: the counterparties that must not be the agent's hand. */
export function moneyFrom(job: DeskJob, byId: Map<number, DeskJob>, carriers: Set<string>): string[] {
  const out: string[] = [];
  let j: DeskJob | undefined = job;
  for (let depth = 0; j && depth < 6; depth++) {
    out.push(j.customer);
    if (!carriers.has(j.payer)) out.push(j.payer);
    j = j.parent === null ? undefined : byId.get(j.parent);
  }
  return [...new Set(out)];
}

/** Whether a job's money came from the agent's own hand or Factor's own, and why. */
export function ownMoney(agent: string, job: DeskJob, byId: Map<number, DeskJob>, x: Pick<ScoreInput, "sameHand" | "own" | "carriers">): string | null {
  for (const who of moneyFrom(job, byId, x.carriers)) {
    if (who === agent) return job.parent !== null ? `the sub-job's money came back from ${agent} itself` : `${agent} paid itself`;
    const why = x.sameHand(agent, who);
    if (why) return why;
    if (x.own.has(who)) return `${who} is Factor's own and never a paying client`;
  }
  return null;
}

export function scoreReport(x: ScoreInput): Report {
  const F = FORMULA;
  const byId = new Map(x.jobs.map((j) => [j.id, j]));
  const mine = x.jobs.filter((j) => j.agent === x.agent);
  const flags: Flag[] = [];
  const listed: CountedJob[] = [];

  // ── which jobs count ──
  const counted: { job: DeskJob; value: number; cp: string }[] = [];
  let unvalued = 0;
  for (const j of mine) {
    const why = ownMoney(x.agent, j, byId, x);
    const cp = j.customer;
    const value = toNear(big(j.price), j.token, x.nearPerUnit);
    const settled = j.status === "Paid" || j.status === "Half";
    if (value === null && settled) unvalued++;
    const v = value ?? 0;
    if (why) listed.push({ id: j.id, role: "agent", counterparty: cp, status: j.status, valueNear: v, counted: false, why });
    else {
      listed.push({ id: j.id, role: "agent", counterparty: cp, status: j.status, valueNear: v, counted: settled, why: settled ? "paid by a customer that is not its own hand" : "not settled yet" });
      if (settled) counted.push({ job: j, value: v, cp });
    }
  }
  const excluded = listed.filter((l) => !l.counted && l.why !== "not settled yet" && l.role === "agent");
  if (excluded.length)
    flags.push({ key: "own-jobs", words: `${plural(excluded.length, "job")} left out: ${[...new Set(excluded.map((e) => e.why))].join("; ")}` });
  if (unvalued) flags.push({ key: "no-price", words: `${plural(unvalued, "token job")} with no price for its token: not valued` });

  // ── paid work ──
  const value = counted.reduce((s, c) => s + (c.job.status === "Half" ? c.value / 2 : c.value), 0);
  const P = F.paidWork;
  const valuePts = value <= 0 ? 0 : down(P.valueMax * Math.min(1, Math.log2(1 + value / P.step) / Math.log2(1 + P.full / P.step)));
  const byCustomer = new Map<string, number>();
  for (const c of counted.filter((c) => c.job.status === "Paid")) byCustomer.set(c.cp, (byCustomer.get(c.cp) ?? 0) + c.value);
  const goodCustomers = [...byCustomer.values()].filter((v) => v >= P.customerMin).length;
  const fullJobs = counted.filter((c) => c.job.status === "Paid").length;
  const paidWork = Math.min(F.parts.paidWork.max, valuePts + Math.min(P.customerMax, goodCustomers * P.perCustomer) + Math.min(P.jobMax, fullJobs * P.perJob));

  // ── advances repaid by delivered work, the 30-day rule ──
  const repaid = counted
    .filter((c) => big(c.job.advanced) > 0n)
    .map((c) => ({ at: Number(c.job.closed_ms ?? c.job.created_ms), unit: Math.min(1, (toNear(big(c.job.advanced), c.job.token, x.nearPerUnit) ?? 0) / F.repayment.fullAdvance) }));
  const windows = new Map<number, number[]>();
  const first = Math.min(...repaid.map((r) => r.at), Infinity);
  for (const r of repaid) {
    const w = Math.floor((r.at - first) / (F.repayment.windowDays * DAY));
    windows.set(w, [...(windows.get(w) ?? []), r.unit]);
  }
  let units = 0;
  for (const us of windows.values()) us.sort((a, b) => b - a).forEach((u, k) => (units += u / (k + 1)));
  const repayment = down(F.parts.repayment.max * Math.min(1, Math.sqrt(units / F.repayment.units)));

  // ── on time ──
  const delivered = counted.filter((c) => c.job.delivered_ms);
  const onTime = delivered.filter((c) => Number(c.job.delivered_ms) <= Number(c.job.due_ms)).length;
  const reliability = delivered.length ? down(F.parts.reliability.max * (onTime / delivered.length) * Math.min(1, delivered.length / F.reliability.full)) : 0;

  // ── pays who it hires ──
  const hired = x.jobs.filter((j) => j.parent !== null && j.customer === x.agent && j.agent);
  const paidOut = new Set<string>();
  for (const h of hired) {
    const sub = h.agent as string;
    const own = sub === x.agent || x.sameHand(x.agent, sub) || x.own.has(sub);
    const settled = h.status === "Paid" || h.status === "Half";
    listed.push({ id: h.id, role: "hirer", counterparty: sub, status: h.status, valueNear: toNear(big(h.price), h.token, x.nearPerUnit) ?? 0, counted: settled && !own, why: own ? `${sub} is its own hand` : settled ? "it paid the agent it hired" : "not settled yet" });
    if (settled && !own) paidOut.add(sub);
  }
  const hiring = Math.min(F.parts.hiring.max, paidOut.size * F.hiring.perAgent);

  // ── time active ──
  const times = counted.map((c) => Number(c.job.closed_ms ?? c.job.created_ms));
  const days = times.length ? (Math.max(...times) - Math.min(...times)) / DAY : 0;
  const time = down(F.parts.time.max * Math.min(1, days / F.time.fullDays));

  // ── pulls: whoever the customer was ──
  const defaults = mine.filter((j) => j.status === "Refunded" && big(j.advanced) + big(j.reserved) > 0n).length;
  const missed = mine.filter((j) => j.status === "Refunded" && big(j.advanced) + big(j.reserved) === 0n).length;
  const halves = mine.filter((j) => j.status === "Half").length;
  const pulls: Pull[] = [
    { key: "default" as const, count: defaults, points: defaults * F.pulls.default, why: "drew on a job and did not deliver it" },
    { key: "missed" as const, count: missed, points: missed * F.pulls.missed, why: "did not deliver a job by its time, nothing drawn" },
    { key: "half" as const, count: halves, points: halves * F.pulls.half, why: "the customer rejected the delivery: settled at half" },
  ].filter((p) => p.count > 0);

  const parts: Part[] = [
    { key: "paidWork", name: F.parts.paidWork.name, points: paidWork, max: F.parts.paidWork.max, why: `${value.toFixed(2)} NEAR of paid work from ${plural(byCustomer.size, "customer")}, ${plural(fullJobs, "job")} paid in full` },
    { key: "repayment", name: F.parts.repayment.name, points: repayment, max: F.parts.repayment.max, why: `${plural(repaid.length, "advance")} settled out of the job's own payment (${units.toFixed(2)} units of 6)` },
    { key: "reliability", name: F.parts.reliability.name, points: reliability, max: F.parts.reliability.max, why: `${onTime} of ${plural(delivered.length, "delivery", "deliveries")} by the due time` },
    { key: "hiring", name: F.parts.hiring.name, points: hiring, max: F.parts.hiring.max, why: `paid ${plural(paidOut.size, "agent")} it hired for part of a job` },
    { key: "time", name: F.parts.time.name, points: time, max: F.parts.time.max, why: `${days.toFixed(1)} days between its first and latest counted job` },
  ];
  const sum = parts.reduce((s, p) => s + p.points, 0) - pulls.reduce((s, p) => s + p.points, 0);

  if (x.own.has(x.agent)) flags.push({ key: "factor-own", words: "an account of Factor's own: scored the same, listed apart" });
  if (x.createdMs !== undefined && x.nowMs - x.createdMs < F.freshDays * DAY)
    flags.push({ key: "fresh", words: `the account was created ${Math.max(0, Math.floor((x.nowMs - x.createdMs) / DAY))} days ago` });

  const raise: string[] = [];
  if (byCustomer.size < 5) raise.push("take paid work from more customers on the desk");
  if (paidWork < F.parts.paidWork.max) raise.push("deliver more paid jobs");
  if (repaid.length < 6) raise.push("draw advances on jobs and deliver them: each one repaid by its job counts");
  if (delivered.length < F.reliability.full) raise.push("deliver by the due time, five jobs or more");
  if (paidOut.size < 4) raise.push("hire other agents for parts of a job and pay them");
  if (time < F.parts.time.max) raise.push("keep working week after week");

  return {
    version: VERSION,
    agent: x.agent,
    score: Math.max(0, sum),
    parts,
    pulls,
    flags,
    jobs: listed.sort((a, b) => a.id - b.id),
    raise,
    totals: { jobs: mine.length, counted: counted.length, excluded: excluded.length, earnedNear: value },
  };
}
