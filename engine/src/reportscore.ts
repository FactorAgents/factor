// Factor Credit Reports: the score. One public, versioned formula, factor-report/1.1.0, that turns what the chain shows
// of an agent into a number from 0 to 1000, with every point explained (docs/REPORTS.md has it in words).
//
// This file is pure: it is handed what was read (./reports.ts reads it) and gives back the score, its parts, its pulls,
// its flags, the points each source brought and what would raise it. The same inputs always give the same answer, and
// it uses plain arithmetic, square roots and one base-2 logarithm, rounded down at the end of each part.
//
// 1.1.0 (10 Nov 2026) is 1.0.0 calibrated to what this young chain shows: paid work full at 0.05 ETH paid on a log scale,
// a customer from 0.003 ETH of work, a repayment unit of $10 held 7 days, time active as the span of counted activity up to
// 90 days, a paying client's word 50. The rules against gaming it and every pull are as strict as before, and a loan now
// counts toward reliability only when it would count toward a week (docs/REPORTS.md, section 11).
//
// The weights, in order of what matters most:
//
//   Paid work      400   jobs paid on the Factor desk, by customers who are not the agent's own hand
//   Repayment      250   Factor advances repaid by their jobs, Factor credit lines repaid on time, loans repaid on Priors
//   Feedback       150   what DISTINCT paying clients say of it: Factor's paid reviews, and ERC-8004 entries from wallets
//                        that paid it on the desk
//   Time active    100   the weeks with counted activity
//   Reliability    100   on time, as a share of everything delivered or repaid, and work checked by validators
//
// and the pulls, taken off the sum: a default (an advance or a loan not repaid, an early half kept, a credit line in
// default) 300 each, a job not delivered 100 each, a job settled at half 25 each, a credit line repaid late 50 each.
//
// The report moves no money. The desk's limits are the desk's (its bond plus the fees its jobs paid), the contracts have
// no owner, and nothing here is read by any of them.

export const REPORT_VERSION = "factor-report/1.1.0";

const DAY = 86_400;
const WEEK = 7 * DAY;
const ETH = 10n ** 18n;

/** Every number of the formula, as the API and docs/REPORTS.md give them. */
export const FORMULA = {
  version: REPORT_VERSION,
  max: 1000,
  parts: { work: 400, repayment: 250, feedback: 150, time: 100, reliability: 100 },
  work: {
    /** the value of the jobs paid, on a log scale from the smallest job (0.001 ETH): 200 × log2(1 + paid ÷ 0.001) ÷ log2(51), all of it at 0.05 ETH */
    valueMax: 200, valueFullEth: 0.05, valueStepEth: 0.001,
    /** a customer counts once the jobs it paid in full come to 0.003 ETH of work, three of the smallest */
    customerPaidMinWei: "3000000000000000", perCustomer: 30, customersMax: 150,
    perJob: 5, jobsMax: 50,
  },
  repayment: {
    /** the room fills on a square root of the units repaid: 102 points for 1 unit, 176 for 3, 250 for 6 */
    unitsForMax: 6,
    /** a loan is one whole unit at $10 or more held 7 days or more; smaller or shorter, its share of that */
    loanFullUsd: 10, loanFullDays: 7,
    /** a Factor pool advance is half a unit at 0.002 ETH or more: the job's locked payment already covered it */
    advanceFullEth: 0.002, advanceWeight: 0.5,
    lineOnTime: 1, lineLate: 0.25,
    /** in each 30 days the biggest repayment counts in full, the second half, the third a third, and so on */
    windowDays: 30,
  },
  feedback: { positive: 50, neutral: 15, negative: -50, max: 150, positiveFrom: 70, neutralFrom: 40 },
  /** the days from the first counted activity to the latest, all of it at 90; a loan counts as activity from $10 held a day */
  time: { fullDays: 90, max: 100, realLoanUsd: 10, realLoanDays: 1 },
  reliability: { onTimeMax: 80, fullAtCount: 5, loansPerWindow: 4, perValidator: 10, validationsMax: 20, validationPass: 50 },
  pulls: { default: 300, missed: 100, half: 25, lineLate: 50 },
  flags: { freshDays: 14, quickMinutes: 60, loopLoans: 10, massMaker: 25 },
} as const;

// ---------- what goes in ----------

/** Where a fact came from: one of the sources in docs/REPORTS-SOURCES.md. */
export type SourceKey = "factor-desk" | "factor-lines" | "priors" | "erc8004-reputation" | "erc8004-validation" | "factor-reviews" | "erc8004-identity";
export const SOURCE_NAME: Record<SourceKey, string> = {
  "factor-desk": "Factor desk",
  "factor-lines": "Factor credit lines",
  priors: "Loans on Priors",
  "erc8004-reputation": "ERC-8004 reputation",
  "erc8004-validation": "ERC-8004 validation",
  "factor-reviews": "Factor paid reviews",
  "erc8004-identity": "ERC-8004 identity",
};

/** A job on the Factor desk locked for one of the agent's wallets. Amounts in wei, as text; times in chain seconds. */
export interface DeskJobIn {
  id: number;
  customer: string;
  price: string;
  fee: string;
  /** the desk's own numbers: 4 settled in full, 5 settled at half, 6 declined, 7 refunded; others are open */
  state: number;
  lockedAt: number;
  closedAt: number;
  deliveredAt: number;
  late: boolean;
  fromPool: string;
  early: string;
  /** a demonstration: Factor's own customer hired Factor's own agent */
  demo: boolean;
}

/** A loan on Priors (CreditPool v1 or v2). principalMicro: USDG with its 6 decimals, as a whole number. */
export interface LoanIn {
  pool: string;
  id: number;
  principalMicro: number;
  borrowedAt: number;
  dueAt: number;
  recipient: string;
  repaidAt: number | null;
  payer: string | null;
  defaultedAt: number | null;
}

/** An entry on the ERC-8004 reputation registry for the agent's identity. */
export interface FeedbackIn { client: string; index: number; value: string; decimals: number; tag1: string; tag2: string; revoked: boolean; at: number }
/** A paid review on Factor (./reviews.ts): only the wallet that paid for the job can write one. */
export interface ReviewIn { job: number; reviewer: string; stars: number; at: number; self: string | null }
/** An answered request on the ERC-8004 validation registry. */
export interface ValidationIn { validator: string; response: number; tag: string; at: number }

export interface ReportInput {
  /** the chain's time now, seconds */
  nowS: number;
  /** when the identity was registered, or the desk agent was, seconds; null when unknown */
  registeredAt: number | null;
  /** the wallets that are the agent: its identity's owner and agentWallet, its desk address */
  wallets: string[];
  /** the wallet that registered the identity, and how many identities that wallet registered in all */
  maker: { address: string; identities: number } | null;
  /** Factor's own agent (house): scored the same way, and listed apart */
  factorOwn: boolean;
  /** why an address is the agent's own hand, or null (its wallets, its maker, a wallet of an identity the same maker made, Factor's own links) */
  own: (address: string) => string | null;
  desk: DeskJobIn[];
  line: { onTime: number; late: number; defaulted: boolean } | null;
  loans: LoanIn[];
  /** how many agents' loans each wallet received, and repaid: a wallet shared by several agents splits its credit */
  loanShare: (wallet: string, as: "recipient" | "payer") => number;
  /** contracts that repay for an agent out of the agent's own money (Priors' autopay and income router): never "shared" */
  helpers: Set<string>;
  feedback: FeedbackIn[];
  /** the address Factor writes its own job entries from: those are the desk's jobs, counted as paid work */
  factorWriter: string | null;
  reviews: ReviewIn[];
  validations: ValidationIn[];
}

// ---------- what comes out ----------

export type PartKey = keyof typeof FORMULA.parts;
export interface ReportPart { key: PartKey; name: string; points: number; max: number; why: string; lines: string[] }
export interface ReportPull { key: "default" | "missed" | "half" | "lineLate"; count: number; points: number; why: string }
export interface ReportFlag { key: string; title: string; words: string; effect: string; count: number; tone: "info" | "warn" | "bad" }
export interface SourcePoints { source: SourceKey; name: string; points: number }
export interface ReportCounts {
  deskJobsPaid: number; deskJobsHalf: number; deskValueWei: string; deskCustomers: number; deskCustomersAll: number;
  advancesRepaid: number; lineOnTime: number; lineLate: number;
  loans: number; loansRepaid: number; loansLate: number; loansOpen: number; loanUsd: number; loanUnits: number;
  defaults: number; missed: number;
  payingClients: number; opinionsNotCounted: number;
  validations: number; activeWeeks: number; onTime: number; late: number;
}
export interface ScoreResult {
  version: string;
  score: number;
  of: 1000;
  /** a record with nothing counted yet: no paid job, no repayment, no paying client's word */
  blank: boolean;
  parts: ReportPart[];
  pulls: ReportPull[];
  flags: ReportFlag[];
  sources: SourcePoints[];
  raise: string[];
  counts: ReportCounts;
  firstAt: number | null;
  lastAt: number | null;
}

// ---------- helpers ----------

const ethOf = (wei: bigint): number => Number(wei / 10n ** 9n) / 1e9;
const big = (s: string | null | undefined): bigint => { try { return BigInt(s || "0"); } catch { return 0n; } };
const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
const usd = (micro: number): string => `$${(micro / 1e6).toLocaleString("en-US", { maximumFractionDigits: micro < 10e6 ? 2 : 0 })}`;
const ethText = (wei: bigint): string => { const e = ethOf(wei); return `${e >= 1 ? e.toFixed(3) : e >= 0.01 ? e.toFixed(4) : e.toPrecision(2)} ETH`; };
const down = (x: number): number => Math.floor(x + 1e-9);
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** A value on a 0 to 100 scale, or null when the entry's value is not one (a count, a profit, a balance). */
export function onHundred(value: string, decimals: number): number | null {
  const v = big(value);
  if (v < 0n || decimals > 30) return null;
  const scaled = Number(v) / 10 ** decimals;
  return Number.isFinite(scaled) && scaled >= 0 && scaled <= 100 ? scaled : null;
}

/** The first tag of a paid review a customer wrote to ERC-8004 through Factor (./reviews.ts): its value is stars, 1 to 5. */
export const REVIEW_TAG = "factorReview";
/** Entries that are another system's score or statement, not what a client thinks of the work: never counted as feedback. */
export const NOT_AN_OPINION = /score|statement|report|rank|rating-index/i;

/** Stars from 1 to 5, or null. */
export function starsOf(value: string, decimals: number): number | null {
  const v = onHundred(value, decimals);
  return v !== null && Number.isInteger(v) && v >= 1 && v <= 5 ? v : null;
}

/** The weight of one repaid loan, before the 30-day rule: its size and how long it was held, each up to one. */
export function loanWeight(l: Pick<LoanIn, "principalMicro" | "borrowedAt" | "repaidAt">): number {
  if (l.repaidAt === null) return 0;
  const size = Math.min(1, l.principalMicro / (FORMULA.repayment.loanFullUsd * 1e6));
  const held = Math.min(1, Math.max(0, l.repaidAt - l.borrowedAt) / (FORMULA.repayment.loanFullDays * DAY));
  return size * held;
}

/**
 * The 30-day rule: repayments are put in windows of 30 days counted from the first, and in each the biggest counts in
 * full, the second half, the third a third. Looping many small repayments adds less and less.
 */
export function windowed<T>(items: T[], at: (x: T) => number, weight: (x: T) => number, tie: (x: T) => string): { total: number; raw: number; windows: Map<number, T[]> } {
  if (!items.length) return { total: 0, raw: 0, windows: new Map() };
  const start = Math.min(...items.map(at));
  const span = FORMULA.repayment.windowDays * DAY;
  const windows = new Map<number, T[]>();
  for (const x of items) {
    const w = Math.floor((at(x) - start) / span);
    const list = windows.get(w) ?? [];
    list.push(x);
    windows.set(w, list);
  }
  let total = 0, raw = 0;
  for (const list of windows.values()) {
    list.sort((a, b) => weight(b) - weight(a) || (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0));
    list.forEach((x, k) => { total += weight(x) / (k + 1); raw += weight(x); });
  }
  return { total, raw, windows };
}

/** Points that fill on a log scale counted in `step`s: `max` once `x` reaches `full`. */
const logged = (x: number, step: number, full: number, max: number): number => (x <= 0 ? 0 : down(max * Math.min(1, Math.log2(1 + x / step) / Math.log2(1 + full / step))));

/** Points that fill on a square root: `max` once `x` reaches `full`. */
const rooted = (x: number, full: number, max: number): number => down(max * Math.min(1, Math.sqrt(Math.max(0, x) / full)));

/** Split `points` between sources by their shares, whole points, the remainder to the largest shares. */
function share(points: number, shares: Partial<Record<SourceKey, number>>): Partial<Record<SourceKey, number>> {
  const entries = (Object.entries(shares) as [SourceKey, number][]).filter(([, s]) => s > 0);
  const total = entries.reduce((a, [, s]) => a + s, 0);
  const out: Partial<Record<SourceKey, number>> = {};
  if (!total || points <= 0) return out;
  let given = 0;
  const rests: { k: SourceKey; r: number }[] = [];
  for (const [k, s] of entries) {
    const exact = (points * s) / total;
    out[k] = Math.floor(exact);
    given += out[k]!;
    rests.push({ k, r: exact - Math.floor(exact) });
  }
  rests.sort((a, b) => b.r - a.r || (a.k < b.k ? -1 : 1));
  for (let i = 0; given < points; i++, given++) out[rests[i % rests.length]!.k]! += 1;
  return out;
}

// ---------- the formula ----------

export function scoreReport(x: ReportInput): ScoreResult {
  const F = FORMULA;
  const flags: ReportFlag[] = [];
  const mine = new Set(x.wallets.map((w) => w.toLowerCase()));
  const activity: { at: number; source: SourceKey }[] = [];

  // ---- the Factor desk ----
  const counted: DeskJobIn[] = [];
  const selfJobs: DeskJobIn[] = [];
  let demoJobs = 0;
  for (const j of x.desk) {
    if (j.state !== 4 && j.state !== 5) continue;
    if (j.demo) { demoJobs++; continue; }
    if (x.own(j.customer)) { selfJobs.push(j); continue; }
    counted.push(j);
  }
  const full = counted.filter((j) => j.state === 4);
  const half = counted.filter((j) => j.state === 5);
  const value = full.reduce((a, j) => a + big(j.price), 0n) + half.reduce((a, j) => a + big(j.price) / 2n, 0n);
  const paidBy = new Map<string, bigint>();
  for (const j of full) paidBy.set(j.customer, (paidBy.get(j.customer) ?? 0n) + big(j.price));
  const customersAll = new Set(counted.map((j) => j.customer)).size;
  const customers = [...paidBy.values()].filter((f) => f >= BigInt(F.work.customerPaidMinWei)).length;
  const valuePts = logged(ethOf(value), F.work.valueStepEth, F.work.valueFullEth, F.work.valueMax);
  const custPts = Math.min(F.work.customersMax, customers * F.work.perCustomer);
  const jobPts = Math.min(F.work.jobsMax, full.length * F.work.perJob);
  const workPts = Math.min(F.parts.work, valuePts + custPts + jobPts);
  for (const j of counted) activity.push({ at: j.closedAt, source: "factor-desk" });
  if (selfJobs.length) flags.push({ key: "own-jobs", title: "Paid by its own hand", tone: "warn", count: selfJobs.length, words: `${n(selfJobs.length, "job")} on the desk ${selfJobs.length === 1 ? "was" : "were"} paid by a wallet that is the agent's own: its owner, its own wallet, the wallet that made it, or a wallet tied to it.`, effect: "Not counted anywhere in the score. Spending on yourself is not income." });
  if (demoJobs) flags.push({ key: "demo-jobs", title: "Demonstration jobs", tone: "info", count: demoJobs, words: `${n(demoJobs, "job")} ${demoJobs === 1 ? "was" : "were"} Factor's own customer hiring Factor's own agent, to show the desk at work.`, effect: "Not counted." });

  // ---- repayment ----
  type Unit = { at: number; w: number; source: SourceKey; key: string };
  const units: Unit[] = [];
  // Factor pool advances repaid by their own jobs
  const advances = counted.filter((j) => big(j.fromPool) > 0n);
  for (const j of advances) units.push({ at: j.closedAt, w: F.repayment.advanceWeight * Math.min(1, ethOf(big(j.fromPool)) / F.repayment.advanceFullEth), source: "factor-desk", key: `d${j.id}` });
  // credit lines: marks without times, so each counts as its own window's first
  const lineUnits = x.line ? x.line.onTime * F.repayment.lineOnTime + x.line.late * F.repayment.lineLate : 0;
  // loans on Priors
  const quick: LoanIn[] = [];
  let sharedLoans = 0, sharedBy = 0;
  const loanW = new Map<string, number>();
  for (const l of x.loans) {
    if (l.repaidAt === null) continue;
    let w = loanWeight(l);
    const r = l.recipient.toLowerCase(), p = (l.payer ?? "").toLowerCase();
    const rs = mine.has(r) ? 1 : x.loanShare(r, "recipient");
    const ps = !p || mine.has(p) || p === r || x.helpers.has(p) ? 1 : x.loanShare(p, "payer");
    const split = Math.max(rs, ps, 1);
    if (split > 1) { w /= split; sharedLoans++; sharedBy = Math.max(sharedBy, split); }
    if (l.repaidAt - l.borrowedAt < F.flags.quickMinutes * 60 && p === r) quick.push(l);
    loanW.set(`${l.pool}:${l.id}`, w);
    units.push({ at: l.repaidAt, w, source: "priors", key: `p${l.pool}:${l.id}` });
  }
  const win = windowed(units, (u) => u.at, (u) => u.w, (u) => u.key);
  const totalUnits = win.total + lineUnits;
  const repayPts = rooted(totalUnits, F.repayment.unitsForMax, F.parts.repayment);
  const unitsBy: Partial<Record<SourceKey, number>> = { "factor-lines": lineUnits };
  for (const list of win.windows.values()) list.forEach((u, k) => { unitsBy[u.source] = (unitsBy[u.source] ?? 0) + u.w / (k + 1); });
  const loops = [...win.windows.values()].map((list) => list.filter((u) => u.source === "priors").length).filter((c) => c >= F.flags.loopLoans);
  if (loops.length) {
    const most = Math.max(...loops);
    const cut = win.raw - win.total;
    flags.push({ key: "loop-loans", title: "Many small loans in a loop", tone: "warn", count: loops.reduce((a, b) => a + b, 0), words: `Up to ${most} loans repaid within 30 days. Taking a loan and giving it back again and again shows the agent can pay money back, not that it earns any.`, effect: `In each 30 days the biggest repayment counts in full, the second half, the third a third. ${cut > 0.005 ? `That left out ${cut.toFixed(2)} of ${win.raw.toFixed(2)} repayment units.` : "Each of these loans was worth little to begin with."}` });
  }
  if (quick.length) flags.push({ key: "quick-loans", title: "Borrowed and returned unused", tone: "warn", count: quick.length, words: `${n(quick.length, "loan")} ${quick.length === 1 ? "was" : "were"} repaid within an hour by the same wallet ${quick.length === 1 ? "it was" : "they were"} paid to. Money that comes straight back was never spent on anything.`, effect: "A loan counts by its size and by how long it was held, up to 7 days: a loan held an hour is worth under 1% of one held a week." });
  if (sharedLoans) flags.push({ key: "shared-wallet", title: "Loans through a shared wallet", tone: "warn", count: sharedLoans, words: `${n(sharedLoans, "loan")} went to, or ${sharedLoans === 1 ? "was" : "were"} repaid by, a wallet that also takes or repays loans for other agents (up to ${sharedBy} agents). Agents run from the same wallet are one hand.`, effect: `Each such loan's credit is split between the agents that share the wallet.` });

  // ---- feedback from paying clients ----
  const paying = new Set(counted.map((j) => j.customer));
  type Opinion = { client: string; at: number; tone: "positive" | "neutral" | "negative"; source: SourceKey };
  const latest = new Map<string, Opinion>();
  let notCounted = 0, selfOpinions = 0, unpaidOpinions = 0, notRating = 0;
  const take = (o: Opinion) => { const had = latest.get(o.client); if (!had || o.at >= had.at) latest.set(o.client, o); };
  for (const r of x.reviews) {
    if (r.self || x.own(r.reviewer)) { selfOpinions++; continue; }
    take({ client: r.reviewer, at: r.at, tone: r.stars >= 4 ? "positive" : r.stars === 3 ? "neutral" : "negative", source: "factor-reviews" });
  }
  for (const f of x.feedback) {
    if (f.revoked) continue;
    const c = f.client.toLowerCase();
    if (x.factorWriter && c === x.factorWriter) continue; // the desk's own entry for a paid job: counted as paid work
    if (x.own(c)) { selfOpinions++; notCounted++; continue; }
    if (!paying.has(c)) { unpaidOpinions++; notCounted++; continue; }
    if (f.tag1 === "factor" || NOT_AN_OPINION.test(f.tag1)) { notRating++; notCounted++; continue; }
    // a paid review written to ERC-8004 by the customer itself (./reviews.ts): stars from 1 to 5
    const stars = f.tag1 === REVIEW_TAG ? starsOf(f.value, f.decimals) : null;
    const v = stars !== null ? null : onHundred(f.value, f.decimals);
    if (stars === null && v === null) { notRating++; notCounted++; continue; }
    const tone = stars !== null ? (stars >= 4 ? "positive" : stars === 3 ? "neutral" : "negative") : v! >= F.feedback.positiveFrom ? "positive" : v! >= F.feedback.neutralFrom ? "neutral" : "negative";
    take({ client: c, at: f.at, tone, source: "erc8004-reputation" });
  }
  const opinions = [...latest.values()];
  const fbRaw = opinions.reduce((a, o) => a + (o.tone === "positive" ? F.feedback.positive : o.tone === "neutral" ? F.feedback.neutral : F.feedback.negative), 0);
  const fbPts = clamp(fbRaw, 0, F.feedback.max);
  for (const o of opinions) activity.push({ at: o.at, source: o.source });
  if (selfOpinions) flags.push({ key: "own-feedback", title: "Feedback from its own hand", tone: "warn", count: selfOpinions, words: `${n(selfOpinions, "entry", "entries")} came from the agent's owner, its own wallet, the wallet that made it, or a wallet tied to them.`, effect: "Not counted. Nobody vouches for themselves." });
  if (unpaidOpinions) flags.push({ key: "unpaid-feedback", title: "Feedback from wallets that never paid it", tone: "info", count: unpaidOpinions, words: `${n(unpaidOpinions, "entry", "entries")} on ERC-8004 came from wallets with no paid job with this agent on the chain: other services' scores and statements, upvotes, and notes.`, effect: "Shown, not counted. Only a client that paid for work can move the score." });

  // ---- validations ----
  const validators = new Set<string>();
  for (const v of x.validations) if (v.response >= F.reliability.validationPass && !x.own(v.validator)) validators.add(v.validator.toLowerCase());
  const valPts = Math.min(F.reliability.validationsMax, validators.size * F.reliability.perValidator);
  for (const v of x.validations) if (validators.has(v.validator.toLowerCase())) activity.push({ at: v.at, source: "erc8004-validation" });

  // ---- reliability: on time ----
  let onTime = 0, late = 0;
  for (const j of counted) if (j.deliveredAt > 0) (j.late ? late++ : onTime++);
  if (x.line) { onTime += x.line.onTime; late += x.line.late; }
  const repaid = x.loans.filter((l) => l.repaidAt !== null).sort((a, b) => a.repaidAt! - b.repaidAt! || a.id - b.id);
  let loansLate = 0;
  if (repaid.length) {
    const start = repaid[0]!.repaidAt!;
    const per = new Map<number, number>();
    for (const l of repaid) {
      const isLate = l.repaidAt! > l.dueAt;
      if (isLate) loansLate++;
      // a loan shows reliability only when it was a real one: $10 or more, held a day or more (as for a week of activity)
      if (l.principalMicro < F.time.realLoanUsd * 1e6 || l.repaidAt! - l.borrowedAt < F.time.realLoanDays * DAY) continue;
      const w = Math.floor((l.repaidAt! - start) / (FORMULA.repayment.windowDays * DAY));
      const k = per.get(w) ?? 0;
      if (k >= F.reliability.loansPerWindow) continue;
      per.set(w, k + 1);
      if (isLate) late++;
      else onTime++;
    }
  }
  const seen = onTime + late;
  const onTimePts = seen ? down(F.reliability.onTimeMax * (onTime / seen) * Math.min(1, seen / F.reliability.fullAtCount)) : 0;
  const relPts = Math.min(F.parts.reliability, onTimePts + valPts);

  // ---- time active: weeks with counted activity ----
  for (const u of units) if (u.source === "factor-desk") activity.push({ at: u.at, source: "factor-desk" });
  for (const l of repaid) if (l.principalMicro >= F.time.realLoanUsd * 1e6 && l.repaidAt! - l.borrowedAt >= F.time.realLoanDays * DAY && (loanW.get(`${l.pool}:${l.id}`) ?? 0) > 0) activity.push({ at: l.repaidAt!, source: "priors" });
  const weeks = new Map<number, SourceKey>();
  for (const a of [...activity].sort((p, q) => p.at - q.at)) if (a.at > 0 && !weeks.has(Math.floor(a.at / WEEK))) weeks.set(Math.floor(a.at / WEEK), a.source);
  const times = activity.map((a) => a.at).filter((t) => t > 0);
  const spanDays = times.length ? (Math.max(...times) - Math.min(...times)) / DAY : 0;
  const timePts = down(F.time.max * Math.min(1, spanDays / F.time.fullDays));

  // ---- pulls ----
  const pulls: ReportPull[] = [];
  const refundedDrew = x.desk.filter((j) => j.state === 7 && (big(j.fromPool) > 0n || big(j.early) > 0n));
  const refundedClean = x.desk.filter((j) => j.state === 7 && big(j.fromPool) === 0n && big(j.early) === 0n);
  const loanDefaults = x.loans.filter((l) => l.defaultedAt !== null);
  const defaults = refundedDrew.length + loanDefaults.length + (x.line?.defaulted ? 1 : 0);
  if (defaults) pulls.push({ key: "default", count: defaults, points: -defaults * F.pulls.default, why: [refundedDrew.length ? `${n(refundedDrew.length, "job")} on the desk drawn on and not delivered` : "", loanDefaults.length ? `${n(loanDefaults.length, "loan")} on Priors marked in default` : "", x.line?.defaulted ? "its Factor credit line in default" : ""].filter(Boolean).join(", ") + `: ${F.pulls.default} points off each.` });
  if (refundedClean.length) pulls.push({ key: "missed", count: refundedClean.length, points: -refundedClean.length * F.pulls.missed, why: `${n(refundedClean.length, "job")} on the desk not delivered by its time and refunded to the customer: ${F.pulls.missed} points off each.` });
  if (half.length) pulls.push({ key: "half", count: half.length, points: -half.length * F.pulls.half, why: `${n(half.length, "job")} the customer rejected, settled at half: ${F.pulls.half} points off each.` });
  if (x.line && x.line.late) pulls.push({ key: "lineLate", count: x.line.late, points: -x.line.late * F.pulls.lineLate, why: `Its Factor credit line repaid late ${n(x.line.late, "time")}: ${F.pulls.lineLate} points off each.` });
  if (defaults) flags.push({ key: "default", title: "Defaulted", tone: "bad", count: defaults, words: "Money it was advanced or lent was not paid back, or a customer's early half was kept without the work.", effect: `${F.pulls.default} points off for each, whatever else it has done.` });
  if (refundedClean.length) flags.push({ key: "missed", title: "Missed deliveries", tone: "bad", count: refundedClean.length, words: `${n(refundedClean.length, "job")} ${refundedClean.length === 1 ? "was" : "were"} not delivered in time and the customer was refunded.`, effect: `${F.pulls.missed} points off for each.` });

  // ---- other flags ----
  if (x.registeredAt && x.nowS - x.registeredAt < F.flags.freshDays * DAY) {
    const days = Math.max(0, Math.floor((x.nowS - x.registeredAt) / DAY));
    flags.push({ key: "fresh", title: "New on the chain", tone: "info", count: 1, words: `Registered ${days === 0 ? "today" : `${n(days, "day")} ago`}. A new identity has had no time to show a record.`, effect: "Time active can only count the weeks it has been here: the score cannot run ahead of its record." });
  }
  if (x.maker && x.maker.identities >= F.flags.massMaker && !mine.has(x.maker.address.toLowerCase())) flags.push({ key: "mass-maker", title: "One of many from the same wallet", tone: "info", count: x.maker.identities, words: `Its identity was registered by a wallet that registered ${x.maker.identities.toLocaleString("en-US")} identities. That is how a platform or a farm makes agents.`, effect: "Jobs, loans and feedback between agents made by the same wallet are not counted: they are one hand." });
  if (x.factorOwn) flags.push({ key: "factor-own", title: "Factor's own agent", tone: "info", count: 1, words: "Run by Factor itself, and marked that way wherever it shows.", effect: "Scored by the same formula, and ranked apart from everyone else's agents." });

  // ---- the score ----
  const sum = workPts + repayPts + fbPts + timePts + relPts;
  const pulled = pulls.reduce((a, p) => a + p.points, 0);
  const score = clamp(sum + pulled, 0, F.max);
  const blank = counted.length === 0 && totalUnits === 0 && opinions.length === 0 && validators.size === 0;

  const parts: ReportPart[] = [
    {
      key: "work", name: "Paid work", points: workPts, max: F.parts.work,
      why: counted.length ? `${n(full.length, "job")} paid in full${half.length ? ` and ${half.length} at half` : ""} on the Factor desk, ${ethText(value)} in all, from ${n(customersAll, "customer")}.` : "No job paid on the Factor desk by a customer who is not its own hand.",
      lines: [
        `Value: ${valuePts} of ${F.work.valueMax}. ${ethText(value)} paid; all 200 points at ${F.work.valueFullEth} ETH, on a log scale from the smallest job.`,
        `Customers: ${custPts} of ${F.work.customersMax}. ${n(customers, "customer")} whose jobs paid in full came to 0.003 ETH or more, ${F.work.perCustomer} each.${customersAll > customers ? ` ${customersAll - customers} more paid it less than that.` : ""}`,
        `Jobs: ${jobPts} of ${F.work.jobsMax}. ${n(full.length, "job")} paid in full, ${F.work.perJob} each.`,
      ],
    },
    {
      key: "repayment", name: "Repayment", points: repayPts, max: F.parts.repayment,
      why: totalUnits > 0 ? `${totalUnits.toFixed(2)} repayment units: ${[advances.length ? `${n(advances.length, "advance")} from the Factor pool repaid by ${advances.length === 1 ? "its job" : "their jobs"}` : "", x.line && (x.line.onTime || x.line.late) ? `a Factor credit line repaid ${n(x.line.onTime + x.line.late, "time")}` : "", repaid.length ? `${n(repaid.length, "loan")} repaid on Priors` : ""].filter(Boolean).join(", ")}.` : x.loans.length ? "Its loans have not been repaid yet." : "Nothing borrowed and repaid yet.",
      lines: [
        `A loan is one unit at $${F.repayment.loanFullUsd} or more held ${F.repayment.loanFullDays} days or more, and its share of one when smaller or shorter. A Factor pool advance is up to half a unit; a credit line repaid on time is one.`,
        `In each 30 days the biggest repayment counts in full, the second half, the third a third.`,
        `${repayPts} of ${F.parts.repayment}: the room fills on a square root of the units, all of it at ${F.repayment.unitsForMax}.`,
      ],
    },
    {
      key: "feedback", name: "Paying clients' feedback", points: fbPts, max: F.parts.feedback,
      why: opinions.length ? `${n(opinions.length, "paying client")} said something: ${opinions.filter((o) => o.tone === "positive").length} good, ${opinions.filter((o) => o.tone === "neutral").length} middling, ${opinions.filter((o) => o.tone === "negative").length} bad.` : "No client that paid it has said anything yet.",
      lines: [
        `Each paying client counts once, by what it said last: ${F.feedback.positive} for good (4 or 5 stars, or ${F.feedback.positiveFrom} or more of 100), ${F.feedback.neutral} for middling, ${F.feedback.negative} for bad.`,
        notCounted ? `${n(notCounted, "entry", "entries")} on ERC-8004 not counted: not from a paying client, from its own hand, or not a rating.` : "Feedback from wallets that never paid it is shown and never counted.",
      ],
    },
    {
      key: "time", name: "Time active", points: timePts, max: F.parts.time,
      why: weeks.size ? `Counted activity over ${n(Math.floor(spanDays), "day")}, in ${n(weeks.size, "week")}.` : "No counted activity yet.",
      lines: [`The days from its first counted activity to its latest, all ${F.time.max} points at ${F.time.fullDays} days: a paid job, a repayment that counts, a paying client's word. A loan counts from $${F.time.realLoanUsd} held a day.`],
    },
    {
      key: "reliability", name: "Reliability", points: relPts, max: F.parts.reliability,
      why: seen ? `${onTime} of ${seen} on time${validators.size ? `, and work checked by ${n(validators.size, "validator")}` : ""}.` : validators.size ? `Work checked by ${n(validators.size, "validator")}.` : "Nothing delivered or repaid yet to be on time with.",
      lines: [
        `On time: ${onTimePts} of ${F.reliability.onTimeMax}. Jobs delivered by their due time, credit line and loan repayments by theirs; the share on time, in full from ${F.reliability.fullAtCount} of them. A loan counts from $${F.time.realLoanUsd} held a day, up to ${F.reliability.loansPerWindow} in each 30 days.`,
        `Checked work: ${valPts} of ${F.reliability.validationsMax}. ${F.reliability.perValidator} for each validator that passed its work on ERC-8004 (${F.reliability.validationPass} or more of 100).`,
      ],
    },
  ];

  // points per source
  const by: Partial<Record<SourceKey, number>> = { "factor-desk": workPts };
  const add = (o: Partial<Record<SourceKey, number>>) => { for (const [k, v] of Object.entries(o) as [SourceKey, number][]) by[k] = (by[k] ?? 0) + v; };
  add(share(repayPts, unitsBy));
  const fbBy: Partial<Record<SourceKey, number>> = {};
  for (const o of opinions) if (o.tone !== "negative") fbBy[o.source] = (fbBy[o.source] ?? 0) + (o.tone === "positive" ? 3 : 1);
  add(share(fbPts, fbBy));
  const wkBy: Partial<Record<SourceKey, number>> = {};
  for (const s of weeks.values()) wkBy[s] = (wkBy[s] ?? 0) + 1;
  add(share(timePts, wkBy));
  const otBy: Partial<Record<SourceKey, number>> = { "factor-desk": counted.filter((j) => j.deliveredAt > 0 && !j.late).length, "factor-lines": x.line?.onTime ?? 0 };
  otBy.priors = Math.max(0, onTime - (otBy["factor-desk"] ?? 0) - (otBy["factor-lines"] ?? 0));
  add(share(onTimePts, otBy));
  add({ "erc8004-validation": valPts });
  const sources: SourcePoints[] = (Object.keys(SOURCE_NAME) as SourceKey[]).map((s) => ({ source: s, name: SOURCE_NAME[s], points: by[s] ?? 0 })).filter((s) => s.points > 0).sort((a, b) => b.points - a.points);

  // ---- what raises it ----
  const raise: string[] = [];
  if (defaults) raise.push(`Nothing makes up for a default quickly: each costs ${F.pulls.default} points, more than most records earn in a month.`);
  if (workPts < F.parts.work) {
    if (!counted.length) raise.push("Take paid work on the Factor desk. A job paid by a customer is what counts most: up to 400 points.");
    else if (custPts < F.work.customersMax) raise.push(`More customers: each new customer whose jobs come to 0.003 ETH of work adds ${F.work.perCustomer} points, up to ${F.work.customersMax}.`);
    else if (valuePts < F.work.valueMax) raise.push(`More paid work: the value part reaches ${F.work.valueMax} at ${F.work.valueFullEth} ETH paid.`);
  }
  if (repayPts < F.parts.repayment) raise.push(totalUnits > 0 ? `Fewer, larger, longer repayments: a loan of $${F.repayment.loanFullUsd} held ${F.repayment.loanFullDays} days counts as much as hundreds of $5 loans returned in an hour.` : "Draw an advance on a paid job, or open a Factor credit line, and repay it: repayment is the second largest part.");
  if (fbPts < F.feedback.max) raise.push(paying.size ? "Ask the customers who paid for a review: only paying clients' words count." : `Feedback counts once clients pay for work: a review from a paying customer adds up to ${F.feedback.positive}.`);
  if (timePts < F.time.max) raise.push(`Keep working: time active fills as its record runs longer, all of it at ${F.time.fullDays} days from its first counted activity.`);
  if (onTimePts < F.reliability.onTimeMax && seen) raise.push("Deliver and repay by the due time: reliability is the share on time.");
  if (selfJobs.length || selfOpinions) raise.push("Stop paying or reviewing itself: none of it counts.");

  return {
    version: REPORT_VERSION, score, of: 1000, blank, parts, pulls, flags, sources, raise: raise.slice(0, 5),
    counts: {
      deskJobsPaid: full.length, deskJobsHalf: half.length, deskValueWei: value.toString(), deskCustomers: customers, deskCustomersAll: customersAll,
      advancesRepaid: advances.length, lineOnTime: x.line?.onTime ?? 0, lineLate: x.line?.late ?? 0,
      loans: x.loans.length, loansRepaid: repaid.length, loansLate, loansOpen: x.loans.filter((l) => l.repaidAt === null && l.defaultedAt === null).length,
      loanUsd: Math.round(x.loans.reduce((a, l) => a + l.principalMicro, 0) / 1e6), loanUnits: Math.round((unitsBy.priors ?? 0) * 100) / 100,
      defaults, missed: refundedClean.length, payingClients: opinions.length, opinionsNotCounted: notCounted,
      validations: validators.size, activeWeeks: weeks.size, onTime, late,
    },
    firstAt: ((t) => (t.length ? Math.min(...t) : null))(activity.map((a) => a.at).filter((t) => t > 0)),
    lastAt: ((t) => (t.length ? Math.max(...t) : null))(activity.map((a) => a.at).filter((t) => t > 0)),
  };
}

export { ETH as WEI_PER_ETH, usd as usdText, ethText };
