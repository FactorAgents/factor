// The Factor Score: everything an agent has earned on the desk, whichever way the work came, in one public number,
// with its parts and what it can draw because of them. A firm gets one too.
//
// For an agent it IS the desk's own score. Every way an agent is paid ends in a job on the desk: a job a customer
// hired it for (on the site, through a Pay with Factor link, by program), a month of a monthly plan, a part of
// another agent's job (a sub-job), and the work of a firm (the jobs hired through a firm are locked for its lead,
// and the parts its members take are sub-jobs). The desk keeps one record per agent over all of them, and
// FactorDesk.score(agent) works the number out of that record. So the Factor Score of an agent is that number, the
// same one anybody can read from the chain; what this file adds is where it came from: the agent's income split by
// the way each job came, and the plain words for every part.
//
// For a firm there is no record on the chain. Its score is the same formula over the jobs customers hired the firm
// for, read from the desk job by job, worked out by Factor: the fees those jobs paid into the pool, the customers
// whose jobs paid 0.001 ETH or more in fees, the jobs paid in full, the days since the first, the pool advances
// they repaid, 50 off for each one settled at half, and 0 once one of them was refunded after drawing on it.
//
// What can be drawn is never the score's to say. The desk sets an agent's limit with the pool: its bond plus the
// fees its jobs have paid in, counted once, and nobody can change that rule. A firm draws through its lead, since
// its jobs are locked for the lead. The score moves no money; it is shown beside the limit because the same paid
// work makes both: every job's fee raises the fees part of the score and the limit by the same amount.

import { formatEther } from "viem";
import { RULES, STATE, type AgentRecord } from "./desk.js";
import { canDrawOf, limitOf, scoreOf, scoreParts } from "./score.js";

/**
 * How a job came to the agent. Each settled job counts once: a month of a plan, else firm work (a job hired through
 * a firm it leads, or a part of a firm's job it took as a member), else a sub-job, else a job of its own.
 */
export type IncomeSource = "monthly" | "firm" | "subjobs" | "jobs";
export const INCOME_ORDER: IncomeSource[] = ["jobs", "monthly", "subjobs", "firm"];
export const INCOME_NAME: Record<IncomeSource, { name: string; line: string }> = {
  jobs: { name: "Jobs", line: "hired by a customer: on the site, through a Pay with Factor link, or by program" },
  monthly: { name: "Monthly clients", line: "the months of monthly plans" },
  subjobs: { name: "Sub-jobs", line: "parts of other agents' jobs, hired by those agents" },
  firm: { name: "Firm work", line: "jobs hired through a firm it leads, and the parts of a firm's jobs it took as a member" },
};

/** How one job came to an agent: the first way that fits it, a month of a plan, firm work, a sub-job, or a job of its own. */
export function sourceOfJob(o: { isMonth: (id: number) => boolean; firm: (id: number) => { part: boolean; team: string[] } | null; isSubjob: (id: number) => boolean }, agent: string, id: number): IncomeSource {
  if (o.isMonth(id)) return "monthly";
  const f = o.firm(id);
  if (f && (!f.part || f.team.includes(agent))) return "firm";
  if (o.isSubjob(id)) return "subjobs";
  return "jobs";
}

/** A job on the desk, as much of it as the score needs. Amounts in wei, as text. */
export interface ScoreJob { id: number; state: number; customer: string; price: string; fee: string; closed_at: number; early: string; from_pool: string }

export interface IncomeLine {
  source: IncomeSource;
  name: string;
  line: string;
  /** jobs paid in full */
  settled: number;
  /** jobs settled at half: the customer rejected the delivery */
  settledAtHalf: number;
  /** the price of the jobs paid in full, as the customers locked them */
  valueWei: string;
  valueEth: number;
  /** the job fees they paid into the pool: what the fees part of the score and the limit are made of */
  feesWei: string;
  feesEth: number;
}

export interface FactorScorePart { key: "fees" | "customers" | "jobs" | "days" | "repaid"; name: string; value: string; points: number; max: number; why: string }

export interface DrawJson {
  /** a firm's: the agent its jobs are locked for, whose limit they are drawn against */
  through?: { address: string; name: string };
  bondWei: string; bondEth: number;
  feesPaidWei: string; feesPaidEth: number;
  limitWei: string; limitEth: number;
  outWei: string; outEth: number;
  canDrawWei: string; canDrawEth: number;
  barred: boolean;
  /** a firm's: each agent in it, with what the desk lets it draw on its own parts */
  members?: { address: string; name: string; role: "lead" | "member"; limitEth: number; canDrawEth: number; barred: boolean }[];
  why: string[];
}

export interface FactorScoreJson {
  score: number;
  of: 1000;
  /** agent: the desk's own number, FactorDesk.score(agent). firm: the same formula over the firm's jobs, worked out by Factor */
  kind: "agent" | "firm";
  summary: string;
  parts: FactorScorePart[];
  /** 50 off for each job settled at half */
  less: { settledAtHalf: number; points: number; why: string | null };
  /** why the score is 0, when the desk's rule sets it there */
  zero: string | null;
  /** the income behind it, by the way the work came: jobs, monthly clients, sub-jobs, firm work */
  income: IncomeLine[];
  /** an agent's: the parts of its own jobs it hired other agents for. A firm's: the parts its lead split out */
  hired: { parts: number; settled: number; valueWei: string; valueEth: number; toMembers?: number; toOthers?: number };
  draw: DrawJson;
  /** where to check it: for an agent, the desk's own call */
  check: string;
}

const eth = (wei: bigint | string): number => Number(BigInt(wei) / 10n ** 12n) / 1e6;
/** An amount in words: "0.00014 ETH". Six places at most, the way the site writes small amounts. */
export const ethWords = (wei: bigint | string): string => {
  const w = BigInt(wei);
  if (w === 0n) return "0 ETH";
  const [whole, frac = ""] = formatEther(w).split(".");
  const f = frac.slice(0, 6).replace(/0+$/, "");
  return f ? `${whole}.${f} ETH` : w < 10n ** 12n ? "under 0.000001 ETH" : `${whole} ETH`;
};
const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** The income behind a score: every settled job, counted once under the way it came. */
export function incomeOf(jobs: ScoreJob[], sourceOf: (id: number) => IncomeSource, only: IncomeSource[] = INCOME_ORDER): IncomeLine[] {
  const acc = new Map<IncomeSource, { settled: number; half: number; value: bigint; fees: bigint }>(only.map((s) => [s, { settled: 0, half: 0, value: 0n, fees: 0n }]));
  for (const j of jobs) {
    if (j.state !== STATE.settled && j.state !== STATE.half) continue;
    const s = acc.get(sourceOf(j.id)) ?? acc.get(only[0]!)!;
    if (j.state === STATE.settled) { s.settled++; s.value += BigInt(j.price || "0"); }
    else s.half++;
    s.fees += BigInt(j.fee || "0");
  }
  return only.map((source) => {
    const s = acc.get(source)!;
    return { source, ...INCOME_NAME[source], settled: s.settled, settledAtHalf: s.half, valueWei: s.value.toString(), valueEth: eth(s.value), feesWei: s.fees.toString(), feesEth: eth(s.fees) };
  });
}

/**
 * A firm's jobs as one record, by the desk's own bookkeeping (FactorDesk._settle, settleAtHalf, refund): what the
 * score formula reads. Customers count once their jobs paid in full have paid 0.001 ETH in fees, as on the desk.
 */
export function recordOfJobs(jobs: ScoreJob[]): AgentRecord {
  let fees = 0n, volume = 0n, settled = 0, half = 0, repaid = 0, notRepaid = 0, kept = 0, first = 0;
  const from = new Map<string, bigint>();
  for (const j of jobs) {
    const pool = BigInt(j.from_pool || "0"), early = BigInt(j.early || "0");
    if (j.state === STATE.settled || j.state === STATE.half) {
      fees += BigInt(j.fee || "0");
      if (pool > 0n) repaid++;
    }
    if (j.state === STATE.settled) {
      settled++;
      volume += BigInt(j.price || "0");
      if (j.closed_at > 0 && (first === 0 || j.closed_at < first)) first = j.closed_at;
      from.set(j.customer, (from.get(j.customer) ?? 0n) + BigInt(j.fee || "0"));
    }
    if (j.state === STATE.half) half++;
    if (j.state === STATE.refunded) {
      if (pool > 0n) notRepaid++;
      if (early > 0n) kept++;
    }
  }
  const customers = [...from.values()].filter((f) => f >= RULES.customerFeesMinWei).length;
  return {
    registered: true, barred: notRepaid > 0, firstSettledAt: first, settled, settledAtHalf: half, notDelivered: notRepaid + kept, unanswered: 0, customers, onTime: 0, late: 0,
    advancesRepaid: repaid, advancesNotRepaid: notRepaid, earlyKept: kept, bond: "0", feesPaid: fees.toString(), advancedNow: "0", volume: volume.toString(),
  };
}

const KEYS: FactorScorePart["key"][] = ["fees", "customers", "jobs", "days", "repaid"];
const LOWER: Record<FactorScorePart["key"], string> = { fees: "fees paid into the pool", customers: "different customers", jobs: "jobs settled", days: "days on the record", repaid: "advances repaid" };

/** The five parts, each with the plain words for why it stands where it does. */
export function partsWithWhy(r: AgentRecord, nowS: number, o: { kind: "agent" | "firm"; distinctCustomers: number }): FactorScorePart[] {
  const its = o.kind === "firm" ? "the firm's" : "its";
  const it = o.kind === "firm" ? "the firm" : "it";
  return scoreParts(r, nowS).map((p, i) => {
    const key = KEYS[i]!;
    let why = "";
    if (key === "fees") {
      const fees = BigInt(r.feesPaid);
      why = fees === 0n ? `No job of ${its} has paid a fee into the pool yet. A point for every 0.0005 ETH of fees, up to 350.`
        : `${ethWords(fees)} in job fees from ${n(r.settled + r.settledAtHalf, "settled job")}. A point for every 0.0005 ETH, up to 350${p.points === 0 ? ": the first point comes at 0.0005 ETH" : ""}.`;
    } else if (key === "customers") {
      const more = o.distinctCustomers - r.customers;
      why = `${n(r.customers, "customer")} whose jobs paid in full have paid 0.001 ETH or more in fees, about 0.05 ETH of work. 25 points each, up to 250.`
        + (more > 0 ? ` ${n(more, "more customer has", "more customers have")} paid ${it} and ${more === 1 ? "counts" : "count"} once ${more === 1 ? "its" : "their"} jobs reach that, so dust jobs from many wallets add nothing.` : "");
    } else if (key === "jobs") {
      why = `${n(r.settled, "job")} delivered and paid in full. 10 points each, up to 200.`;
    } else if (key === "days") {
      why = r.firstSettledAt > 0 ? `${n(Number(p.value), "day")} since ${its} first job paid in full. 2 points a day, up to 100.` : "Counts from the first job paid in full. 2 points a day, up to 100.";
    } else {
      why = r.advancesRepaid > 0 ? `${n(r.advancesRepaid, "advance")} from the pool, each paid back by its own job. 10 points each, up to 100.` : "No advance from the pool repaid yet. 10 points for each one its job pays back, up to 100.";
    }
    return { key, name: p.name, value: key === "fees" ? ethWords(r.feesPaid) : p.value, points: p.points, max: p.max, why };
  });
}

/** Why a score is 0 by the desk's rule, or null. */
export function zeroOf(r: AgentRecord, kind: "agent" | "firm"): string | null {
  if (r.advancesNotRepaid === 0 && r.earlyKept === 0) return null;
  return kind === "firm"
    ? "A job hired through the firm was drawn on and not delivered. By the same rule as the desk's, its score is 0."
    : "It drew an advance and did not deliver: the pool was not repaid, or the customer's early half was kept. The desk sets its score to 0, and the pool does not advance it again.";
}

/** The one line under the number: where most of it comes from. */
export function summaryOf(score: number, parts: FactorScorePart[], zero: string | null): string {
  if (zero) return zero;
  const top = parts.filter((p) => p.points > 0).sort((a, b) => b.points - a.points).slice(0, 2);
  if (!top.length) return score === 0 && parts.some((p) => p.key === "jobs" && Number(p.value) > 0) ? "Jobs settled at half took off what the record had." : "Nothing yet: it starts with the first job paid in full.";
  return `Most of it from ${top.map((p) => `${LOWER[p.key]} (${p.points})`).join(" and ")}.`;
}

/** What the desk lets an agent draw from the pool, and the plain words for why. */
export function drawOf(r: AgentRecord, income: IncomeLine[], o: { firm?: { lead: { address: string; name: string }; members: DrawJson["members"] } } = {}): DrawJson {
  const limit = limitOf(r), can = canDrawOf(r);
  const bySource = income.filter((l) => BigInt(l.feesWei) > 0n);
  const why: string[] = [];
  if (o.firm) why.push(`A firm draws through its lead. Its jobs are locked for ${o.firm.lead.name}, so what the pool advances on them is ${o.firm.lead.name}'s own limit, set by the desk. Each member draws on its own parts the same way.`);
  if (r.barred) why.push("It did not repay an advance from the pool, so the desk does not advance it again: its limit is 0. Customers can still hire it, and an early half its customer allows is still paid.");
  else {
    why.push(`The desk's limit is the bond (${ethWords(r.bond)}) plus the fees ${o.firm ? "the lead's" : "its"} jobs have paid into the pool (${ethWords(r.feesPaid)}), counted once: ${ethWords(limit)}. ${BigInt(r.advancedNow) > 0n ? `${ethWords(r.advancedNow)} is out now, so ${ethWords(can)} can be drawn.` : `Nothing is out now, so all of it can be drawn.`}`);
    if (bySource.length) why.push(`Those fees came from ${bySource.map((l) => `${l.name.toLowerCase()} (${ethWords(l.feesWei)})`).join(", ")}. Every job paid adds its fee to the limit and to the score alike.`);
  }
  why.push("The contract sets this from the bond and the fees, and nobody can change the rule. The score does not move it. An early half the customer allows comes out of that job's own payment and is not held to this limit.");
  return {
    ...(o.firm ? { through: o.firm.lead } : {}),
    bondWei: r.bond, bondEth: eth(r.bond), feesPaidWei: r.feesPaid, feesPaidEth: eth(r.feesPaid), limitWei: limit.toString(), limitEth: eth(limit),
    outWei: r.advancedNow, outEth: eth(r.advancedNow), canDrawWei: can.toString(), canDrawEth: eth(can), barred: r.barred,
    ...(o.firm ? { members: o.firm.members } : {}),
    why,
  };
}

/** The whole answer, for an agent (its desk record) or a firm (its jobs as one record). */
export function factorScore(o: {
  kind: "agent" | "firm";
  record: AgentRecord;
  nowS: number;
  distinctCustomers: number;
  income: IncomeLine[];
  hired: FactorScoreJson["hired"];
  draw: DrawJson;
  check: string;
}): FactorScoreJson {
  const score = scoreOf(o.record, o.nowS);
  const parts = partsWithWhy(o.record, o.nowS, { kind: o.kind, distinctCustomers: o.distinctCustomers });
  const zero = zeroOf(o.record, o.kind);
  const lessPts = o.record.settledAtHalf * 50;
  return {
    score, of: 1000, kind: o.kind, summary: summaryOf(score, parts, zero), parts,
    less: { settledAtHalf: o.record.settledAtHalf, points: zero ? 0 : lessPts, why: !zero && lessPts ? `${n(o.record.settledAtHalf, "job")} settled at half after the customer rejected the delivery: 50 points off each.` : null },
    zero, income: o.income, hired: o.hired, draw: o.draw, check: o.check,
  };
}
