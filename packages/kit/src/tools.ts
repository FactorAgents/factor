// Factor as tools an assistant can use: the same calls as the library, each with a description an assistant can
// act on and an answer in words.
//
// An assistant spends real ETH with these, so two caps sit in front of it, kept by this process and not by the
// assistant: the most one job may cost, and the most that may leave the wallet in one day (hires and bond added).
// A call over a cap is refused before anything is sent. What was spent today is kept in a small file, so a restart
// does not reset the day.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatEther } from "viem";
import { z } from "zod";
import { bountyParts, Factor, Refusal, toWei, type Agent, type Bounty, type CoinPermission, type Job, type MilestonePlan, type ModelReceiptInput, type VerdictModel, type VerifiedErc8004, type Verifier, type VerifierCase, type VerifiersAbout } from "./index.js";
import { CASE_WORDS, makerName, VERIFIERS_GASLESS } from "./verifiers.js";
import { askedText } from "./ask.js";
import { reviewsText } from "./reviews.js";
import { builderRecordText } from "./hey.js";

export interface Limits {
  /** the most one job may cost, in wei */
  perJob: bigint;
  /** the most that may leave the wallet in one day (UTC), in wei */
  perDay: bigint;
  /** the folder the day's spending is kept in */
  dir: string;
}

export const DEFAULT_LIMITS = { perJobEth: "0.05", perDayEth: "0.2" };

export function limitsFrom(env: Record<string, string | undefined>): Limits {
  return {
    perJob: toWei(env.FACTOR_MAX_JOB_ETH?.trim() || DEFAULT_LIMITS.perJobEth),
    perDay: toWei(env.FACTOR_MAX_DAY_ETH?.trim() || DEFAULT_LIMITS.perDayEth),
    dir: env.FACTOR_KIT_DIR?.trim() || join(homedir(), ".factor-kit"),
  };
}

const eth = (wei: bigint): string => formatEther(wei);
const OPEN_ID = z.string().regex(/^0x[0-9a-f]{64}$/).describe("The open job's number: 0x and 64 hex characters");
const FIRM_SLUG = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/).describe("The firm's short name, like the-research-desk");
const BOUNTY_ID = z.number().int().positive().describe("The bounty's number");
const MILESTONE_ID = z.number().int().positive().describe("The job in stages' number");
const PLAN_ID = z.string().regex(/^0x[0-9a-f]{64}$/).describe("The plan's number: 0x and 64 hex characters");
const today = (): string => new Date().toISOString().slice(0, 10);

/** What has left a wallet today through these tools. */
export class Spending {
  constructor(private limits: Limits, private address: string) {}

  private file(): string {
    return join(this.limits.dir, `spent-${this.address}.json`);
  }

  today(): bigint {
    try {
      const d = JSON.parse(readFileSync(this.file(), "utf8")) as { day: string; wei: string };
      return d.day === today() ? BigInt(d.wei) : 0n;
    } catch {
      return 0n;
    }
  }

  /** Refuses an amount over a cap. `job`: it is the price of one job. */
  check(amount: bigint, job: boolean): void {
    if (job && amount > this.limits.perJob) throw new Refusal(`${eth(amount)} ETH is over this assistant's cap of ${eth(this.limits.perJob)} ETH for one job. The wallet's owner sets that cap (FACTOR_MAX_JOB_ETH).`, "over_cap");
    const spent = this.today();
    if (spent + amount > this.limits.perDay) throw new Refusal(`That would bring today's spending to ${eth(spent + amount)} ETH, over this assistant's cap of ${eth(this.limits.perDay)} ETH a day (${eth(spent)} ETH spent so far). The wallet's owner sets that cap (FACTOR_MAX_DAY_ETH).`, "over_cap");
  }

  add(amount: bigint): void {
    mkdirSync(this.limits.dir, { recursive: true });
    writeFileSync(this.file(), JSON.stringify({ day: today(), wei: (this.today() + amount).toString() }));
  }
}

export interface Tool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  /** false: it sends a transaction or a signature, so it needs the wallet's key */
  readOnly: boolean;
  run(factor: Factor, args: Record<string, unknown>, spending: Spending | null): Promise<string>;
}

const agentLine = (a: Agent): string => `${a.name}${a.house ? " (house agent)" : ""}: ${a.does || "no description"}. Score ${a.score} of 1000, ${a.settled} jobs settled${a.settledAtHalf ? `, ${a.settledAtHalf} rejected` : ""}${a.barred ? ", barred from the pool" : ""}. Address ${a.address}.`;
const jobLine = (j: Job): string => `Job ${j.n}${j.title ? ` "${j.title}"` : ""}: ${j.state}, ${j.priceEth} ETH, due ${j.dueAt}${j.advances.length ? `, ${j.advances.reduce((n, a) => n + a.eth, 0)} ETH advanced` : ""}. Agent ${j.agentId}, customer ${j.customer}.${j.parent ? ` Part of job ${j.parent.n}.` : ""}`;
const forJob = z.number().int().positive().optional().describe("The number of a job this wallet's agent is doing, when it buys this as part of that job: it is then linked under that job (agents that hire agents)");
const subjobLine = (d: { subjob?: { parent: number } | null; subjobNote?: string }): string => (d.subjob ? ` It is linked under job ${d.subjob.parent}.` : d.subjobNote ? ` It could not be linked under the job: ${d.subjobNote}` : "");
const jobId = z.number().int().positive().describe("The job's number");
const bountyLine = (b: Bounty): string => {
  const now: Record<string, string> = {
    open: `taking entries until ${b.deadline}`,
    choosing: `entries closed; its poster picks by ${b.pickUntil}`,
    ending: `its time is up: a close ${b.next === "returns" ? "sends everything back to the poster" : "splits the prize between the entrants"}`,
    picked: `${b.winner?.name ?? "an agent"} was picked${b.job ? `, job ${b.job.n}` : ""}, and delivers it`,
    won: `won by ${b.winner?.name ?? "an agent"}`,
    unpicked: `nobody was picked in time: split between ${b.paidTo ?? b.entries} entrant${(b.paidTo ?? b.entries) === 1 ? "" : "s"}${b.shareEth ? `, ${b.shareEth} ETH each` : ""}`,
    undelivered: "its winner did not deliver",
    empty: "nobody entered",
  };
  return `Bounty ${b.id}${b.title ? ` "${b.title}"` : ""}: a prize of ${b.prizeEth} ETH, ${b.bondEth} ETH bond to enter${b.minScore ? `, Factor Score ${b.minScore} or more` : ""}. ${b.entries} of ${b.slots} entries; ${now[b.status] ?? b.status}.`;
};
const STAGE_WORD: Record<string, string> = { waiting: "not started", open: "on the desk", delivered: "delivered, waiting for the customer", paid: "paid", missed: "missed", declined: "declined", rejected: "rejected", returned: "never started, back to the customer" };
const planLine = (m: MilestonePlan): string => `Job in stages ${m.id}${m.title ? ` "${m.title}"` : ""}: ${m.count} stages, ${m.totalEth} ETH locked by ${m.customer} for ${m.agent.name}. ${m.state === "running" ? `Stage ${m.current} is on the desk` : m.state === "done" ? "Every stage was paid" : `It ended: a stage was ${m.state}${m.returnedEth ? `, ${m.returnedEth} ETH went back to the customer` : ""}`}.`;
const stageLines = (m: MilestonePlan): string => m.stages.map((x) => `  ${x.n}. ${x.title ?? "(no words yet)"}: ${x.priceEth} ETH, ${STAGE_WORD[x.status] ?? x.status}${x.job ? `, job ${x.job.n}` : ""}${x.dueAt ? `, due ${x.dueAt}` : x.expectedDueAt ? `, about ${x.expectedDueAt} if every stage before it is accepted on its due date` : ""}`).join("\n");
const amount = z.string().regex(/^\d{1,9}(\.\d{1,18})?$/).describe('ETH as text, like "0.04"');

// ---------- verifiers, in words ----------
const CASE_ID = z.number().int().positive().describe("The case's number");
const ACCEPT = z.boolean().describe("true: the work meets the brief. false: it does not");
const REASON = z.string().min(1).max(4000).describe("What was checked and why, in plain text: 1 to 4,000 characters. Hashed exactly as given: the hash goes on the chain and the words to Factor, where anyone can read them");
const RECEIPT = z.object({
  provider: z.string().min(1).max(40).describe('The model provider the call went through, like "openrouter"'),
  generation_id: z.string().min(1).max(200).describe("The provider's id of the call"),
  model: z.string().min(1).max(200).describe("The model asked for"),
  request_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("0x and the keccak256 of the exact request body sent to the provider, UTF-8"),
  output_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("0x and the keccak256 of the model's answer text, UTF-8"),
}).strict().optional().describe("A model receipt, when the verdict came from a model call: the kit adds it at the end of the reasons before they are hashed, so the verdict commits on the chain to that provider call and those exact texts. Factor shows it as declared: a provider's record can only be read with the key that made the call");
const receiptOf = (r: unknown): { receipt?: ModelReceiptInput } => {
  if (!r) return {};
  const x = r as { provider: string; generation_id: string; model: string; request_hash: string; output_hash: string };
  return { receipt: { provider: x.provider, generationId: x.generation_id, model: x.model, requestHash: x.request_hash, outputHash: x.output_hash } };
};
const modelText = (m?: VerdictModel): string => {
  if (!m) return "";
  const r = m.receipt;
  const head = m.mark === "checked" ? `model receipt checked by Factor (${m.makerName})` : `model declared (${m.makerName})`;
  if (!r) return ` Its model: ${head}.`;
  return ` Its model: ${head}; receipt from ${r.provider}, call ${r.generationId}, ${r.modelAsked} asked${r.modelReported && r.modelReported !== r.modelAsked ? `, ${r.modelReported} reported` : ""}${r.matches === false && r.why ? `; it did not match at the provider: ${r.why}` : ""}${r.url ? `, ${r.url}` : ""}.`;
};
const said = (response: number | null): string => (response === 100 ? "100 (accept)" : response === 0 ? "0 (reject)" : "its answer");
const erc8004Text = (e: VerifiedErc8004): string => {
  const who = e.validator ? `the verifier ${e.validator}` : "the verifier";
  const why = e.why ? ` ${e.why.charAt(0).toUpperCase()}${e.why.slice(1).replace(/([^.!?])$/, "$1.")}` : "";
  switch (e.state) {
    case "off": return `ERC-8004 validation: off.${why}`;
    case "no-identity": return `ERC-8004 validation: none, the agent has no ERC-8004 identity linked on Factor.${why}`;
    case "no-verdict": return `ERC-8004 validation: none yet, no verdict has been carried out.${why}`;
    case "prepared": return `ERC-8004 validation: prepared. The owner of identity #${e.agentId} asks ${who} to validate the case file with factor_verified_8004_request; ${who} then answers ${said(e.response)}.${why}`;
    case "requested": return `ERC-8004 validation: requested ${e.requestedAt ?? ""}. ${who.charAt(0).toUpperCase()}${who.slice(1)} answers ${said(e.response)} with factor_verifier_8004_respond; Factor's own verifiers answer by themselves.${why}`;
    case "answered": return `On ERC-8004: ${who} answered ${said(e.response)} ${e.answeredAt ?? ""} for identity #${e.agentId}, tag ${e.tag}, on the Validation Registry ${e.registry}. The case file: ${e.file}.${why}`;
    default: return `ERC-8004 validation: ${e.state}.${why}`;
  }
};
const VERIFIERS_OFF = "Verifiers are not switched on on Factor yet: the verifier tools are not available.";
const short = (a: string): string => `${a.slice(0, 6)}...${a.slice(-4)}`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const verifierLine = (v: Verifier): string => `${v.name ?? v.address} (${v.makerName}${v.house ? ", one of Factor's own" : ""}): ${v.standing ? `standing since ${v.since}` : "no standing (its bond is under 0.01 ETH)"}, ${v.freeEth} ETH free and ${v.lockedEth} ETH staked on ${plural(v.open, "open case")}. ${plural(v.checks, "first check")}, ${plural(v.panels, "panel")}; ${v.right} right and ${v.wrong} wrong${v.rightPct !== null ? ` (${v.rightPct}% right)` : ""}, ${plural(v.hidden, "seat")} never revealed, struck ${plural(v.struck, "time")}. Earned ${v.earnedEth} ETH, lost ${v.lostEth} ETH.${v.receipts ? ` Model receipts: ${v.receipts.checked} checked by Factor, ${v.receipts.declared} declared.` : ""} Address ${v.address}.`;
const NEXT_WORD: Record<string, string> = { check: "waiting for a verifier's first check", dispute: "the side the verdict goes against may dispute it", seats: "its panel is seating", reveals: "its panel is revealing", step: "its time has come: anyone can step it (factor_verified_step)", customer: "the customer's to accept or reject, by the desk's own rule" };
const caseLine = (c: VerifierCase): string => {
  const now = c.state === "working" && !c.deliveredAt ? "the agent is working" : CASE_WORDS[c.state] ?? c.state;
  return `Case ${c.id}, job ${c.job.n}${c.title ? ` "${c.title}"` : ""}: ${c.priceEth} ETH for ${c.agent.name ?? c.agent.address}, fee ${c.feeEth} ETH, a verdict stakes ${c.stakeEth} ETH, a dispute costs ${c.disputeBondEth} ETH. ${now.charAt(0).toUpperCase()}${now.slice(1)}${c.next ? `; ${NEXT_WORD[c.next] ?? c.next}${c.nextAt ? ` (${c.nextAt})` : ""}` : ""}.${c.forYou ? c.forYou.can ? " This wallet may check or sit now." : ` This wallet may not: ${c.forYou.why ?? "Factor did not say why"}.` : ""}`;
};
const cut = (t: string, most: number) => (t.length > most ? `${t.slice(0, most)}\n[... ${t.length - most} more characters on the case's page]` : t);
const caseText = (c: VerifierCase): string => [
  caseLine(c),
  `Customer ${c.customer}, agent ${c.agent.address}. Hired ${c.hiredAt}.`,
  c.deadlines ? `Delivered ${c.deliveredAt}. First check by ${c.deadlines.checkBy}${c.deadlines.disputeBy ? `; a dispute by ${c.deadlines.disputeBy}` : ""}; panel seats and strikes until ${c.deadlines.seatBy}; reveals until ${c.deadlines.revealBy}; the desk's own end ${c.deadlines.reviewBy}.` : "The agent has not delivered on the desk yet.",
  c.brief ? `The brief:\n${cut(c.brief, 4000)}` : "The job's words have not reached Factor yet.",
  c.work ? `The delivered work (${c.work.kind === "html" ? "a page of HTML" : "text"}, ${c.work.at}):\n${cut(c.work.text, 6000)}` : c.deliveredAt ? "The delivered work has not been published to Factor yet." : "",
  c.first ? `First verdict: ${c.first.accept ? "accept" : "reject"}, by ${c.first.verifier.name ?? c.first.verifier.address} (${c.first.verifier.makerName}) at ${c.first.at}.${c.first.reason ? ` Its reasons:\n${cut(c.first.reason, 2000)}` : ` Its reasons' hash: ${c.first.reasonHash}.`}${modelText(c.first.model)}` : "",
  c.dispute ? `Disputed by the ${c.dispute.by} (${c.dispute.address}) at ${c.dispute.at}, with a bond of ${c.dispute.bondEth} ETH.` : "",
  ...(c.seats ?? []).map((x) => `Seat ${x.seat}: ${x.verifier.name ?? x.verifier.address} (${x.makerName}), ${x.vote ? `voted ${x.vote}` : "sealed, not revealed"}${x.reason ? `: ${cut(x.reason, 600)}` : ""}.${modelText(x.model)}${x.ties.length ? ` What Factor's records tie it to a side by: ${x.ties.join("; ")}.` : ""}`),
  ...(c.struck ?? []).map((x) => `Struck by the ${x.by} at ${x.at}: ${x.verifier}.`),
  c.decided ? `Decided by ${c.decided.how === "first-check" ? "the first verdict" : c.decided.how === "panel" ? `the panel (${c.decided.votesAccept} for accept, ${c.decided.votesReject} for reject)` : c.decided.how}: ${c.decided.verdict ?? "the customer decides"}.` : "",
  c.paid?.length ? `Paid to verifiers: ${c.paid.map((p) => `${short(p.verifier)} ${p.eth} ETH`).join(", ")}.` : "",
  c.slashed?.length ? `Lost by verifiers: ${c.slashed.map((p) => `${short(p.verifier)} ${p.eth} ETH`).join(", ")}.` : "",
  c.ended ? `Ended ${c.ended.at}: ${c.ended.state} (${c.ended.how}), ${c.ended.toCustomerEth} ETH back to the customer.` : "",
  c.erc8004 ? erc8004Text(c.erc8004) : "",
].filter(Boolean).join("\n");
const aboutText = (r: VerifiersAbout): string => {
  const x = r.rules;
  return [
    ...(r.enabled ? [`Verifiers are on: the contract ${r.contract}, on Robinhood Chain.`] : [VERIFIERS_OFF]),
    `A customer hires an agent with a verifier and pays a verification fee on top of the price (at least ${x.minFeeEth} ETH, at most the price). Once the work is delivered, one bonded verifier checks it against the brief within ${x.checkH} hours. The side its verdict goes against may dispute it within ${x.disputeH} hours, for a bond of ${x.disputePct}% of the price (at least ${x.minDisputeEth} ETH); a panel of up to ${x.panel} verifiers, each on a different model maker, seals its verdicts until ${x.seatH} hours after the delivery and reveals them until ${x.revealH} hours. The majority of the revealed votes decides; the first verdict breaks a tie. Everything ends inside the desk's ${x.reviewH} hours.`,
    `A verifier joins with a bond of at least ${x.minBondEth} ETH and stakes ${x.stakePct}% of the job's price (at least ${x.minStakeEth} ETH) on each verdict: a wrong call loses ${x.wrongLossPct}% of the stake, a panel seat never revealed all of it. What it earns is added to its free bond, taken out with factor_verifier_withdraw.`,
    ...(r.totals ? [`${plural(r.totals.cases, "case")} (${r.totals.open} open, ${r.totals.disputed} disputed, ${plural(r.totals.panels, "panel")}), ${plural(r.totals.verifiers, "verifier")} with ${r.totals.bondedEth} ETH bonded; ${r.totals.feesPaidEth} ETH paid to verifiers, ${r.totals.slashedEth} ETH lost by wrong or silent calls.`] : []),
    `Model makers: ${r.makers.map((m) => `${m.id} ${m.name} (${m.models})`).join(", ")}; 16 to 255 another maker. A declared maker cannot be checked on the chain: it is public, and a switch starts a verifier's standing again.`,
    ...(r.erc8004 ? [r.erc8004.enabled ? `Verified jobs go on the ERC-8004 Validation Registry (${r.erc8004.registry}, tag ${r.erc8004.tag}): the agent identity's owner asks, and the verifier whose verdict was carried out answers 100 for accept or 0 for reject.` : "Factor does not prepare ERC-8004 validations of verified jobs right now."] : []),
    r.house.length ? `Factor's own verifiers, with bonds of their own: ${r.house.map((h) => `${h.address} (${h.makerName}, ${h.model})`).join(", ")}.` : "Factor runs no verifier of its own right now.",
  ].join("\n");
};
/** The verifier tools that act on the chain: from a plain wallet only, never through a Factor account. */
export const VERIFIER_WRITE_TOOLS = ["factor_verifier_join", "factor_verifier_add_bond", "factor_verifier_withdraw", "factor_verifier_check", "factor_verifier_sit", "factor_verifier_reveal", "factor_hire_with_verifier", "factor_verified_accept", "factor_verified_reject", "factor_verified_concede", "factor_verified_dispute", "factor_verified_strike", "factor_verified_step", "factor_verified_8004_request", "factor_verifier_8004_respond"] as const;

export const TOOLS: Tool[] = [
  {
    name: "factor_overview", readOnly: true, input: {},
    description: "Factor in figures: the pool that advances agents, jobs settled, agents registered, and the rules (how much of a job can be advanced, the fees, the deadlines). Start here.",
    async run(f) {
      const s = await f.state();
      const p = s.params;
      return [
        `Factor: a customer locks the price of a job for an AI agent; the agent may draw up to ${p.advanceMaxPct}% of it before delivering; the job repays it when it settles.`,
        `Pool ${s.stats.poolEth} ETH (${s.stats.outEth} ETH out with agents). ${s.stats.settledJobs} jobs settled, ${s.stats.jobs} locked in all, ${s.stats.agents} agents.`,
        `Rules: smallest job ${p.minJobEth} ETH; ${p.advanceFeePct}% fee on an advance; ${p.jobFeePct}% fee on a settled job, paid by the agent; ${p.graceHours} hours of grace after the due time, then the job is refunded; ${p.reviewHours} hours for the customer to accept or reject a delivery, then it settles by itself; a rejected job settles at half.`,
        this_wallet(f),
      ].join("\n");
    },
  },
  {
    name: "factor_agents", readOnly: true, input: { limit: z.number().int().min(1).max(50).optional().describe("How many, best score first. 10 when not given") },
    description: "The agents that can be hired on Factor, best score first, each with what it does, its score and its record.",
    async run(f, a) {
      const list = (await f.agents()).slice(0, (a.limit as number | undefined) ?? 10);
      return list.length ? list.map(agentLine).join("\n") : "No agent has registered on Factor yet.";
    },
  },
  {
    name: "factor_agent", readOnly: true, input: { agent: z.string().describe("The agent's name or address") },
    description: "One agent in full: its record, its limit with the pool, and its latest jobs.",
    async run(f, a) {
      const page = await f.agent(String(a.agent));
      if (!page) return `There is no agent "${a.agent}" on Factor.`;
      const g = page.agent;
      return [agentLine(g), ...(g.service ? [`One of Factor's own agents. What to put in the brief: ${g.service.needs} It delivers ${g.service.delivers}, and takes a job from ${g.service.fromEth} ETH.`] : []), `Bond ${g.bondEth} ETH, fees paid in ${g.feesPaidEth} ETH, limit with the pool ${g.limitEth} ETH, can draw ${g.canDrawEth} ETH now. On time ${g.onTimePct}%.`, ...page.jobs.slice(0, 8).map(jobLine)].join("\n");
    },
  },
  {
    name: "factor_job", readOnly: true, input: { job: jobId },
    description: "One job: its state, its price, what was advanced on it, what it paid, everything that happened to it, its brief, and the work itself when the agent showed it.",
    async run(f, a) {
      const page = await f.job(a.job as number);
      if (!page) return `There is no job ${a.job} on Factor (a new one shows up a few seconds after it is locked).`;
      const j = page.job;
      const closed = j.state === "settled" || j.state === "half" ? ` Paid to the agent ${j.paidEth} ETH, job fee ${j.feeEth} ETH.` : j.backEth !== undefined ? ` ${j.backEth} ETH went back to the customer.` : "";
      const cut = (t: string, most: number) => (t.length > most ? `${t.slice(0, most)}\n[... ${t.length - most} more characters on the job's page]` : t);
      return [
        jobLine(j) + closed,
        ...(page.note ? [`The agent declined it: ${page.note}.`] : []),
        ...page.events.map((e) => `${e.at} ${e.kind}: ${e.text} (${e.amount})`),
        ...(page.brief ? [`The brief:\n${cut(page.brief, 1500)}`] : []),
        ...(page.work ? [page.work.kind === "html" ? `The work is a page of ${page.work.text.length} characters of HTML, shown on the job's page.` : `The work:\n${cut(page.work.text, 6000)}`] : []),
        ...(page.tree ? [`It is part of a chain of work: ${page.tree.nodes.length} jobs, use factor_job_tree to see it.`] : []),
        ...(page.hiring?.open ? [`Its agent can hire other agents for parts of it: ${page.hiring.freeEth} ETH of its price is left to hire with, due before ${page.hiring.dueBefore}.`] : []),
      ].join("\n");
    },
  },
  {
    name: "factor_my_jobs", readOnly: true, input: { as: z.enum(["customer", "agent"]).describe("Jobs this wallet locked (customer), or jobs locked for it (agent)") },
    description: "This wallet's own jobs: the ones it hired agents for, or the ones it was hired for. Use it to find a job that needs accepting, rejecting, drawing on or delivering.",
    async run(f, a) {
      const me = need(f);
      const jobs = await f.jobs(a.as === "agent" ? { agent: me } : { customer: me });
      return jobs.length ? jobs.map(jobLine).join("\n") : `This wallet has no jobs as ${a.as === "agent" ? "an agent" : "a customer"} yet.`;
    },
  },
  {
    name: "factor_ledger", readOnly: true, input: { show: z.enum(["locked", "advanced", "settled", "refunded", "burned"]).optional(), limit: z.number().int().min(1).max(50).optional() },
    description: "The newest lines of Factor's public ledger: payments locked, advances, deliveries, settlements, refunds and burns.",
    async run(f, a) {
      const lines = await f.ledger({ show: a.show as string | undefined, limit: (a.limit as number | undefined) ?? 15 });
      return lines.length ? lines.map((e) => `${e.at} ${e.jobId ? `job ${Number(e.jobId)} ` : ""}${e.kind}: ${e.text} (${e.amount})`).join("\n") : "Nothing of that kind yet.";
    },
  },
  {
    name: "factor_hire", readOnly: false,
    input: { agent: z.string().describe("The agent's name or address"), price: amount, title: z.string().min(3).max(80).describe("What you want done, in one line without links"), brief: z.string().min(1).max(12000).optional().describe("The details the agent works from, at any length up to 12,000 characters. Anyone can read it on the job's page. Factor's own agents need one: factor_agent says what to put in it"), due_in_hours: z.number().min(1).max(720).optional().describe("24 when not given"), allow_early: z.boolean().optional().describe("true lets the agent take up to half of this payment before delivering; that part is NOT refunded if it does not deliver. false when not given") },
    description: "Hire an agent: lock the price of a job for it. THIS SPENDS ETH from the wallet: it is held by the desk and paid to the agent when it delivers, or comes back if it does not deliver in time. It cannot be cancelled. Confirm the agent, the price and the due time with the user first unless they already gave them.",
    async run(f, a, spending) {
      need(f);
      const price = toWei(String(a.price));
      spending?.check(price, true);
      const r = await f.hire({ agent: String(a.agent), price, title: String(a.title), ...(typeof a.brief === "string" ? { brief: a.brief } : {}), dueInHours: a.due_in_hours as number | undefined, allowEarly: a.allow_early === true });
      spending?.add(price);
      return `Job ${r.jobId} is locked: ${eth(price)} ETH for ${a.agent}${r.titled ? `, titled "${a.title}"` : " (its title could not be saved; set it with factor_set_title)"}${typeof a.brief === "string" ? (r.briefed ? ", with its brief" : " (its brief could not be saved)") : ""}. Transaction ${r.explorer}. The agent now has until the due time to deliver; use factor_job to follow it.`;
    },
  },
  {
    name: "factor_accept", readOnly: false, input: { job: jobId },
    description: "Accept a delivery as its customer: the agent is paid now. Only do this when the user is satisfied with what was delivered.",
    async run(f, a) {
      const r = await f.accept(a.job as number);
      return `Job ${a.job} is accepted and the agent is paid. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_reject", readOnly: false, input: { job: jobId },
    description: "Reject a delivery as its customer, within 24 hours of it. THE JOB SETTLES AT HALF: half of the price comes back, the other half is the agent's. There is no judge and it cannot be undone. Only on the user's clear say-so.",
    async run(f, a) {
      const r = await f.reject(a.job as number);
      return `Job ${a.job} is rejected and settled at half: half of its price is back in the wallet. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_set_title", readOnly: false, input: { job: jobId, title: z.string().min(3).max(80) },
    description: "Say what a job is about, as the customer who locked it. A signature, not a transaction: it costs nothing.",
    async run(f, a) {
      await f.title(a.job as number, String(a.title));
      return `Job ${a.job} is titled "${a.title}".`;
    },
  },
  {
    name: "factor_register", readOnly: false, input: {},
    description: "Make this wallet an agent on Factor. One transaction, once. After it customers can lock jobs for this wallet.",
    async run(f) {
      const r = await f.register();
      return `This wallet (${f.address}) is registered as an agent. Transaction ${r.explorer}. Give it a name with factor_set_profile.`;
    },
  },
  {
    name: "factor_set_profile", readOnly: false, input: { name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/).describe("3 to 24 characters: small letters, digits and single dashes, like lumen-07"), does: z.string().min(3).max(80).describe("One line on what the agent does, without links") },
    description: "Give this agent the name it goes by and one line on what it does. A signature, not a transaction: it costs nothing.",
    async run(f, a) {
      await f.profile({ name: String(a.name), does: String(a.does) });
      return `The agent goes by ${a.name}: "${a.does}".`;
    },
  },
  {
    name: "factor_bond", readOnly: false, input: { action: z.enum(["add", "take"]), amount },
    description: "Add to this agent's bond, or take bond out. A bond is the agent's own ETH held by the desk: it raises its limit with the pool by the same amount, pays first if it does not repay an advance, and can leave only while nothing is owed to the pool. ADDING SPENDS ETH from the wallet until it is taken out again.",
    async run(f, a, spending) {
      const wei = toWei(String(a.amount));
      if (a.action === "add") {
        spending?.check(wei, false);
        const r = await f.addBond(wei);
        spending?.add(wei);
        return `${eth(wei)} ETH added to the bond. Transaction ${r.explorer}.`;
      }
      const r = await f.takeBond(wei);
      return `${eth(wei)} ETH of bond is back in the wallet. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_can_draw", readOnly: true, input: { job: jobId },
    description: "What can be drawn as an advance on a job right now, as the desk itself says: early from the customer's payment (if they allowed it) and from the pool. Check this before factor_draw.",
    async run(f, a) {
      const c = await f.canDraw(a.job as number);
      return `On job ${a.job}: ${c.fromPool} ETH from the pool (or as compute), ${c.early} ETH early from the customer's payment. The two share the job's half, so drawing one lowers the other.`;
    },
  },
  {
    name: "factor_account", readOnly: true, input: {},
    description: "The Factor account this assistant acts through, when it has one (FACTOR_GASLESS=1): its address, the ETH in it, and how many of its actions Factor has paid the gas of today. ETH for a job has to be sent to this address first.",
    async run(f) {
      if (!f.gasless) return f.address ? `This assistant acts as the wallet ${f.address} and pays its own gas. It has no Factor account.` : "No wallet key is set.";
      const a = await f.accountInfo();
      return `Factor account ${a.address} holds ${a.balanceEth} ETH. Factor has paid the gas of ${a.ordersToday} of its actions today, of ${a.ordersPerDay} a day. Its key is ${a.signer}, which needs no ETH. To put ETH in, send it to ${a.address} on Robinhood Chain.`;
    },
  },
  {
    name: "factor_compute_credit", readOnly: true, input: { agent: z.string().optional().describe("The agent's name or address. Left out: this wallet's own") },
    description: "What an agent has left of its compute credit, in dollars: advances drawn as compute (and what its coin's fees or its credit line paid in), which are spent on model calls through Factor and cannot be withdrawn. Also what it spent through raeto/auto and on which models, and which models it buys and what they cost.",
    async run(f, a) {
      const [c, s] = await Promise.all([f.computeCredit(a.agent as string | undefined), f.state()]);
      const usd = (n: number) => `$${n.toFixed(n > 0 && n < 1 ? 4 : 2)}`;
      const lots = c.lots.map((l) => `${l.paidBy === "coin" ? "its coin's fees" : l.paidBy === "line" ? "its credit line" : `job ${l.job}`}: ${l.usd === null ? "being priced" : `${usd(l.spentUsd)} of ${usd(l.usd)} spent`}${l.state === "closed" ? " (refunded, closed)" : ""}`).join("; ");
      const direct = s.compute?.models.length ? ` Claude directly, per million tokens: ${s.compute.models.map((m) => `${m.id} ${usd(m.inUsd)} in / ${usd(m.outUsd)} out`).join(", ")}.` : "";
      const router = s.compute?.router?.enabled ? ` And ${s.compute.router.models} models from every maker (GPT, Claude, Gemini, Grok, DeepSeek, Llama, Mistral and more): factor_compute_models lists them.` : "";
      const raeto = s.compute?.raeto ? ` Or raeto/auto, which picks the model for each request: a call costs what Raeto charged for it, with its ${s.compute.raeto.feePct}% fee and Factor's margin.` : "";
      const models = s.compute?.enabled ? `${direct}${router}${raeto}` : " Compute credit is not switched on yet.";
      const spent = c.raeto ? ` Through raeto/auto: ${usd(c.raeto.spentUsd)} on ${c.raeto.calls} call${c.raeto.calls === 1 ? "" : "s"}${c.raeto.models.length ? ` (${c.raeto.models.slice(0, 5).map((m) => `${m.model} ${usd(m.usd)}`).join(", ")})` : ""}.` : "";
      return `${usd(c.balanceUsd)} of compute credit left.${lots ? ` From ${lots}.` : " No advance has been drawn as compute."}${spent}${models}`;
    },
  },
  {
    name: "factor_compute_models", readOnly: true, input: { search: z.string().optional().describe('Part of a model\'s name or maker, like "gpt", "claude", "deepseek" or "raeto". Left out: the 25 cheapest') },
    description: "The models compute credit can be spent on, from every maker, with what each costs through Factor in dollars a million tokens. While Factor serves it, also raeto/auto and its variants, which pick the model for each request and cost what Raeto charged for the call. Use a model's id with factor_ask_model.",
    async run(f, a) {
      const all = await f.computeModels(a.search as string | undefined);
      if (!all.length) return a.search ? `No model has "${String(a.search)}" in its name.` : "No model is served yet: compute credit through every maker is not switched on.";
      const auto = all.filter((m) => m.auto);
      const priced = all.filter((m) => !m.auto);
      const shown = [...priced].sort((x, y) => x.inUsd + x.outUsd - (y.inUsd + y.outUsd)).slice(0, 25);
      const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
      const routes = auto.length ? `${auto.map((m) => `${m.id} (${m.name})`).join("; ")}. A call through any of them costs what Raeto charged for it, with the margin: none has a price of its own.` : "";
      const list = priced.length ? `${priced.length} model${priced.length === 1 ? "" : "s"}${priced.length > shown.length ? `, the ${shown.length} cheapest shown` : ""}, per million tokens: ${shown.map((m) => `${m.id} ${usd(m.inUsd)} in / ${usd(m.outUsd)} out`).join("; ")}.` : "";
      return [routes, list].filter(Boolean).join("\n");
    },
  },
  {
    name: "factor_ask_model", readOnly: false,
    input: {
      model: z.string().describe('The model\'s id, like "openai/gpt-5" or "anthropic/claude-sonnet-4.5", or "raeto/auto" for Raeto to pick one for this request (factor_compute_models lists them)'),
      prompt: z.string().describe("What to ask it"),
      system: z.string().optional().describe("How it should answer, when that matters"),
      max_tokens: z.number().int().min(1).max(200_000).optional().describe("The longest answer, in tokens. 1024 when not given"),
    },
    description: "Ask any model, paid from this agent's compute credit (advances drawn as compute on its jobs). With raeto/auto, Raeto picks the model for this request, and the answer says which one and what it cost. The credit is spent only on what the call really cost; it is not ETH from the wallet. Factor refuses a call the credit cannot cover before it is sent.",
    async run(f, a) {
      const r = await f.askModel(a.prompt as string, { model: a.model as string, ...(a.system ? { system: a.system as string } : {}), ...(a.max_tokens ? { maxTokens: a.max_tokens as number } : {}) });
      return `${r.text}\n\n(${r.model}${r.model !== a.model && String(a.model).startsWith("raeto/") ? `, picked by ${String(a.model)}` : ""}: ${r.inputTokens} tokens in, ${r.outputTokens} out, ${r.costUsd !== undefined ? `$${r.costUsd.toFixed(6)} ` : ""}paid from compute credit.)`;
    },
  },
  {
    name: "factor_draw", readOnly: false, input: { job: jobId, amount, from: z.enum(["pool", "compute", "early"]).describe("pool: the pool advances it to the agent. compute: the pool pays it to Factor's compute gateway, where it is credit for model calls and never reaches a wallet. early: out of the customer's own payment, when they allowed it") },
    description: "Draw an advance on a job this agent was hired for, before delivering it. A 1% fee comes off what is drawn. The job repays a pool or compute advance when it settles; if the agent does not deliver, its bond pays and the pool never advances it again.",
    async run(f, a) {
      const wei = toWei(String(a.amount));
      const r = await f.draw(a.job as number, wei, a.from as "pool" | "compute" | "early");
      return `${eth(wei)} ETH drawn on job ${a.job} (${a.from}), less the 1% fee. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_deliver", readOnly: false, input: { job: jobId, work: z.string().min(1).describe("What was handed to the customer: the text itself, or the link to it. Only its fingerprint goes on the chain"), show: z.boolean().optional().describe("true also puts the work itself on the job's page, where anybody can read it") },
    description: "Deliver a job as its agent. Hand the work to the customer the way you agreed first; this records the fingerprint of it on the chain as the proof of what was delivered and when. The customer then has 24 hours to accept or reject, after which the job settles by itself and the agent is paid.",
    async run(f, a) {
      const r = await f.deliver(a.job as number, String(a.work), { show: a.show === true });
      return `Job ${a.job} is delivered${a.show === true ? (r.shown ? ", and the work is on its page" : " (the work could not be put on its page)") : ""}. Fingerprint ${r.proof}. Transaction ${r.explorer}. Keep the work exactly as it was given: the same text gives the same fingerprint.`;
    },
  },
  {
    name: "factor_decline", readOnly: false, input: { job: jobId },
    description: "Say no to a job as its agent, before drawing on it. The customer has everything back and the agent's record is not marked.",
    async run(f, a) {
      const r = await f.decline(a.job as number);
      return `Job ${a.job} is declined; its customer has the payment back. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_sign_up", readOnly: false,
    input: { name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/).describe("3 to 24 characters: small letters, digits and single dashes, like lumen-07"), does: z.string().min(3).max(80).describe("One line on what the agent does, without links") },
    description: "Sign this wallet up as an agent in one step: register it on the desk (one transaction, once, only if it has not yet) and give it its name and what it does (a signature). After it, anybody can lock a job for it and it can make Pay with Factor links.",
    async run(f, a) {
      const r = await f.signUp({ name: String(a.name), does: String(a.does) });
      return `${a.name} is an agent on Factor${r.registered ? ` (registered now, transaction ${r.hash})` : " (it was registered already)"}: "${a.does}". Make a payment link with factor_create_pay_link.`;
    },
  },
  {
    name: "factor_create_pay_link", readOnly: false,
    input: {
      price: amount, title: z.string().min(3).max(80).describe("What the buyer gets, in one line without links"),
      brief: z.string().max(2000).optional().describe("The details of what is sold, up to 2,000 characters. Anyone with the link reads it"),
      due_in_hours: z.number().int().min(1).max(720).optional().describe("Hours the agent has once paid. 24 when not given"),
      allow_early: z.boolean().optional().describe("true lets the agent draw up to half of the payment before delivering. false when not given"),
      expires_in_days: z.number().min(1).max(365).optional().describe("When the link stops working. 30 days when not given"),
      months: z.number().int().min(2).max(24).optional().describe("Makes it a subscribe link: a monthly plan of this many months, the price each month, each month due a month after it is locked. The title is then 60 characters at most"),
    },
    description: "Make a Pay with Factor link for this agent's work: a page anybody can pay with a wallet or a passkey, and an x402 address another agent's program can pay. With months, a subscribe link: the buyer puts this agent on a monthly plan, each month locked on Robinhood Chain (paid on its page, not over x402). The buyer's payment is locked on Robinhood Chain until delivery; a rejected delivery settles at half. Signed by this agent's key, so nobody can change the price or the terms. A signature, not a transaction: it costs nothing.",
    async run(f, a) {
      const r = await f.createPayLink({ price: String(a.price), title: String(a.title), ...(typeof a.brief === "string" ? { brief: a.brief } : {}), dueInHours: a.due_in_hours as number | undefined, allowEarly: a.allow_early === true, expiresInDays: a.expires_in_days as number | undefined, ...(typeof a.months === "number" ? { months: a.months } : {}) });
      if (r.link.months) return `The subscribe link: ${r.url}\nIt sells "${r.link.title}" as a monthly plan of ${r.link.months} months at ${eth(BigInt(r.link.price))} ETH each month, until ${new Date(r.link.exp * 1000).toISOString()}.${r.published ? " It is shown on this agent's page." : ""}`;
      return `The link: ${r.url}\nFor another agent's program (x402): ${r.x402}\nIt sells "${r.link.title}" for ${eth(BigInt(r.link.price))} ETH, due ${r.link.due} hours after payment, until ${new Date(r.link.exp * 1000).toISOString()}.${r.published ? " It is shown on this agent's page." : ""}`;
    },
  },
  {
    name: "factor_pay_link_info", readOnly: true, input: { link: z.string().describe("A Pay with Factor link, or its x402 address") },
    description: "What a Pay with Factor link sells, checked by Factor: the agent really signed it, it has not expired, the agent is on the desk, and what the buyer pays (the price, and the deal's small share that buys and burns $FACTOR).",
    async run(f, a) {
      const i = await f.payLinkInfo(String(a.link));
      const page = await f.agent(i.link.agent).catch(() => null);
      return [
        `"${i.link.title}" from ${page?.agent.name ?? i.link.agent}: ${i.priceEth} ETH, plus ${i.burnEth} ETH that buys and burns $FACTOR. Due ${i.link.due} hours after payment. ${i.link.early ? "The agent may draw up to half before it delivers; that part is not refunded if it does not deliver." : "Nothing is drawn from the payment before delivery."}`,
        ...(i.link.brief ? [`The brief: ${i.link.brief}`] : []),
        page ? `The agent: score ${page.agent.score} of 1000, ${page.agent.settled} jobs settled, ${page.agent.settledAtHalf} settled at half.` : "",
        i.registered ? "" : `It cannot be paid: ${i.error}`,
        i.paused ? `New jobs are paused: ${i.paused}` : "",
      ].filter(Boolean).join("\n");
    },
  },
  {
    name: "factor_pay_link", readOnly: false, input: { link: z.string().describe("A Pay with Factor link"), for_job: forJob },
    description: "Pay a Pay with Factor link: lock its price for its agent on Robinhood Chain and add its small share to $FACTOR's burn. THIS SPENDS ETH from the wallet: the price is held by the desk and paid to the agent when it delivers, comes back if it does not deliver in time, and half comes back if the delivery is rejected. It cannot be cancelled. Read it with factor_pay_link_info and confirm with the user first unless they already said to pay it.",
    async run(f, a, spending) {
      const i = await f.payLinkInfo(String(a.link));
      const total = BigInt(i.totalWei);
      spending?.check(total, true);
      const d = await f.payLink(String(a.link), { maxEth: total, ...(a.for_job ? { forJob: a.for_job as number } : {}) });
      spending?.add(total);
      return `Job ${d.jobId} is locked: ${eth(d.priceWei)} ETH for "${i.link.title}"${d.burnTx ? `, and ${eth(d.burnWei)} ETH went to the burn` : ""}.${subjobLine(d)} ${d.jobUrl} Transaction ${d.explorer}. Use factor_job to follow it, then factor_accept or factor_reject once it is delivered.`;
    },
  },
  {
    name: "factor_pay_x402", readOnly: false, input: { url: z.string().url().describe("The x402 address of an agent's work"), max_eth: amount.optional().describe("The most to spend on it, the burn included"), for_job: forJob },
    description: "Buy another agent's work over x402: read the 402 the address answers, pay it on Factor's desk (only to Factor's desk, and only for the agent its signed link names), and get the job's number. THIS SPENDS ETH from the wallet, held by the desk until delivery as with factor_pay_link.",
    async run(f, a, spending) {
      const url = String(a.url);
      const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
      const body = r ? ((await r.json().catch(() => ({}))) as { accepts?: { scheme: string; maxAmountRequired: string }[] }) : {};
      const offer = body.accepts?.find((x) => x.scheme === "factor-lock");
      if (!r || r.status !== 402 || !offer || !/^\d{1,30}$/.test(offer.maxAmountRequired)) return "That address does not ask for a payment Factor can make.";
      const total = BigInt(offer.maxAmountRequired);
      const cap = a.max_eth ? toWei(String(a.max_eth)) : null;
      if (cap !== null && total > cap) return `It costs ${eth(total)} ETH with its burn, over the ${eth(cap)} ETH allowed. Nothing was sent.`;
      spending?.check(total, true);
      const d = await f.payX402(url, { maxEth: total, ...(a.for_job ? { forJob: a.for_job as number } : {}) });
      spending?.add(total);
      return `Job ${d.jobId} is locked through x402: ${eth(d.priceWei)} ETH${d.burnTx ? `, and ${eth(d.burnWei)} ETH to the burn` : ""}.${subjobLine(d)} ${d.jobUrl} Transaction ${d.explorer}.`;
    },
  },
  {
    name: "factor_hire_for_job", readOnly: false,
    input: {
      parent_job: jobId.describe("The job this wallet's agent is doing, that the other agent does part of"),
      agent: z.string().describe("The agent to hire: its name or address"),
      price: amount,
      brief: z.string().max(12000).describe("What the other agent should do, at any length up to 12,000 characters. Anyone can read it on the job's page. Factor's own agents need one: factor_agent says what to put in it"),
      title: z.string().min(3).max(80).optional().describe("One line without links. \"Part of job N\" when not given"),
      due_in_hours: z.number().min(1).max(720).optional().describe("Hours from now. It must be before the parent job is due; when not given, a quarter of the time left before it, at most a day"),
      allow_early: z.boolean().optional().describe("true lets the hired agent take up to half before delivering; that part is NOT refunded if it does not deliver. false when not given"),
    },
    description: "Hire another agent for part of a job this wallet's agent is doing, paid from this wallet (where the job's advance and its pay arrive). THIS SPENDS ETH: the price is locked on Robinhood Chain as a job whose customer is this agent, plus 1% of it that buys and burns $FACTOR. The hired agent delivers to this agent, which then accepts (it is paid) or rejects (it settles at half) with factor_accept or factor_reject. Factor links it under the job and refuses a hire over what is left of the job's price, due after the job, more than two levels deep, or of an agent of the same owner. Confirm the agent and the price with the user first unless they already gave them.",
    async run(f, a, spending) {
      need(f);
      const price = toWei(String(a.price));
      const burn = (price + 99n) / 100n;
      spending?.check(price + burn, true);
      const r = await f.hireForJob(a.parent_job as number, String(a.agent), price, String(a.brief), { ...(typeof a.title === "string" ? { title: a.title } : {}), dueInHours: a.due_in_hours as number | undefined, allowEarly: a.allow_early === true, maxEth: price + burn });
      spending?.add(r.priceWei + (r.burnTx ? r.burnWei : 0n));
      return `Job ${r.jobId} is locked for ${a.agent}: ${eth(r.priceWei)} ETH${r.burnTx ? `, and ${eth(r.burnWei)} ETH to the burn` : ""}. ${r.linked ? `It is linked under job ${r.parentJobId}, ${r.depth} level${r.depth === 1 ? "" : "s"} under the customer's job.` : `It could not be linked under job ${r.parentJobId}: ${r.note ?? "Factor did not answer"} The money is locked as an ordinary job of this wallet's.`} ${r.jobUrl} Transaction ${r.explorer}. Accept or reject it with factor_accept or factor_reject once it is delivered.`;
    },
  },
  {
    name: "factor_job_tree", readOnly: true, input: { job: jobId },
    description: "The chain of work a job is part of: the customer's job, the agents its agent hired for parts of it, and whom they hired in turn. Each with its state, price, the burn its deal added, and whether the desk confirms the link.",
    async run(f, a) {
      const t = await f.jobTree(a.job as number);
      if (!t) return `Job ${a.job} hired nobody, and is not part of another job.`;
      const lines = t.nodes.map((n) => `${"  ".repeat(n.depth)}${n.depth === 0 ? "Customer's job" : "Hired"} ${n.job}${n.title ? ` "${n.title}"` : ""}: agent ${n.agent}, customer ${n.customer}, ${n.state}, ${n.priceEth} ETH${n.burnEth ? `, ${n.burnEth} ETH to the burn` : ""}${n.canReject ? ". Its customer may still reject the delivery" : ""}${n.depth > 0 && n.verified === false ? ". THE DESK DOES NOT CONFIRM THIS LINK" : ""}.`);
      return [...lines, `${t.burn.deals} deal${t.burn.deals === 1 ? "" : "s"} in it added ${t.burn.eth} ETH to the burn.`].join("\n");
    },
  },
  {
    name: "factor_reject_sub_jobs", readOnly: false, input: { parent_job: jobId },
    description: "When the customer rejected a job this wallet's agent hired for (it settled at half), pass the rejection down: reject the deliveries of its sub-jobs still within their 24 hours. EACH SETTLES AT HALF: half of its price comes back, the other half is its agent's. There is no judge and it cannot be undone. Only on the user's clear say-so: it is a choice, never required.",
    async run(f, a) {
      const r = await f.rejectSubJobs(a.parent_job as number);
      if (!r.rejected.length && !r.left.length) return `Job ${a.parent_job} has no sub-jobs of this wallet's.`;
      return [
        ...r.rejected.map((x) => `Job ${x.jobId} is rejected and settled at half (transaction ${x.hash}).`),
        ...r.left.map((x) => `Job ${x.jobId} was not rejected: ${x.why}.`),
      ].join("\n");
    },
  },
  {
    name: "factor_record", readOnly: true, input: { agent: z.string().describe("The agent's name or address") },
    description: "An agent's public record, worked out from the chain: jobs delivered, on time, settled at half, refunded, advances repaid, volume, customers, deals paid with Factor, its score, and whether Factor's signed attestation of it checks out.",
    async run(f, a) {
      const r = await f.record(String(a.agent));
      const v = await f.verifyRecord(r).catch(() => ({ ok: false, why: "it could not be checked" }));
      const j = r.jobs;
      return [
        `${r.name} (${r.agent}): score ${r.score} of 1000${r.barred ? ", barred from the pool" : ""}.`,
        `Jobs: ${j.delivered} delivered (${j.onTime} on time, ${j.late} late), ${j.settled} settled, ${j.settledAtHalf} settled at half, ${j.refunded} refunded (${j.refundedAfterDrawing} after drawing on them), ${j.declined} declined, ${j.open} open. Volume ${r.volumeEth} ETH, ${r.customers} customers counted by the desk (${r.distinctCustomers} different ones).`,
        `Advances: ${r.advances.repaid} repaid, ${r.advances.notRepaid} not repaid. Paid with Factor: ${r.payWithFactor.deals} deals, ${r.payWithFactor.burnedEth} ETH to the burn.`,
        ...(r.hiring?.hiredBy.length ? [`Hired by: ${r.hiring.hiredBy.map((x) => `${x.name} (${x.jobs} job${x.jobs === 1 ? "" : "s"})`).join(", ")}.`] : []),
        ...(r.hiring?.hires.length ? [`Hires: ${r.hiring.hires.map((x) => `${x.name} (${x.jobs} job${x.jobs === 1 ? "" : "s"})`).join(", ")}.`] : []),
        ...(r.plans && (r.plans.active || r.plans.monthsDelivered) ? [`Monthly clients: ${r.plans.active} plan${r.plans.active === 1 ? "" : "s"} running for ${r.plans.clients} client${r.plans.clients === 1 ? "" : "s"}, ${r.plans.monthlyEth} ETH a month; ${r.plans.monthsDelivered} month${r.plans.monthsDelivered === 1 ? "" : "s"} delivered, ${r.plans.monthsSettled} settled.`] : []),
        `As of block ${r.block}. Attestation: ${v.ok ? `signed by Factor (${r.attestation?.signer})` : `not confirmed, ${v.why}`}.`,
      ].join("\n");
    },
  },
  {
    name: "factor_check_agent", readOnly: true, input: { agent: z.string().describe('The agent\'s name, its address, or its ERC-8004 identity as "8004:42"') },
    description: "Check an agent before hiring it, anywhere: its Factor Score, its record, how much it can still draw on its credit line, and what its Guarantee covers, in one answer Factor signs. The signature is checked here. Every figure is read from Robinhood Chain.",
    async run(f, a) {
      const c = await f.checkAgent(String(a.agent));
      const r = c.record;
      return [
        `${c.agent.name} (${c.agent.address})${c.agent.factorOwn ? ", one of Factor's own agents" : ""}: Factor Score ${c.score.value} of 1000${c.score.barred ? ", barred from the pool" : ""}.`,
        `Record: ${r.settled} jobs paid in full, ${r.settledAtHalf} settled at half, ${r.refunded} refunded, ${r.declined} declined; ${r.onTime} on time and ${r.late} late; ${r.distinctCustomers} different customers; ${r.volumeEth} ETH of work.`,
        c.line ? `Credit line: ${c.line.status}, ${c.line.headroomEth} ETH left to draw of a ${c.line.limitEth} ETH limit${c.line.owedEth ? `, ${c.line.owedEth} ETH owed` : ""}.` : "No credit line.",
        c.guarantee ? (c.guarantee.selling ? `Guarantee: covers up to ${c.guarantee.upToEth} ETH on one job (${c.guarantee.sharePct}% of a price at most), from a ${c.guarantee.bondEth} ETH bond; ${c.guarantee.covers} covers, ${c.guarantee.paidOut} paid out.` : `Guarantee: none on offer now (bond ${c.guarantee.bondEth} ETH).`) : "No Guarantee.",
        ...(c.agent.erc8004 ? [`ERC-8004 identity #${c.agent.erc8004.agentId}.`] : []),
        ...(c.verified ? [`Hired with a verifier: ${c.verified.jobs} jobs, ${c.verified.accepted} accepted, ${c.verified.rejected} rejected, ${c.verified.disputed} disputed.${c.verified.onErc8004 ? ` On ERC-8004: ${c.verified.onErc8004.count} validations, ${c.verified.onErc8004.avgResponse} of 100 on average.` : ""}`] : []),
        `Signed by Factor and checked; as of block ${c.block}. Hire it: ${c.hire}`,
      ].join("\n");
    },
  },
  {
    name: "factor_hire_link", readOnly: true,
    input: {
      agent: z.string().describe("The agent's name or address"),
      price: z.string().regex(/^\d{1,6}(\.\d{1,18})?$/).optional().describe('The price in ETH, as text, like "0.01". At least 0.001'),
      title: z.string().min(3).max(80).optional().describe("What is wanted, in one line of 3 to 80 characters, without links"),
      brief: z.string().max(2000).optional().describe("The details. Anyone can read a brief on the job's page, so nothing private"),
      due_hours: z.number().int().min(1).max(720).optional().describe("Hours the agent has once it is paid"),
      early: z.boolean().optional().describe("true: the agent may draw half of it before it delivers"),
      cover: z.boolean().optional().describe("true: hire it with cover from its Guarantee, when it sells cover"),
    },
    description: "A link a person opens to hire an agent through Factor: the pay flow on factoragents.fun, filled in. They lock the payment on Robinhood Chain from their own wallet or a passkey account and sign everything there; nothing is paid by making or opening the link, and no key is needed for it. Give this when the person wants to hire and should pay themselves.",
    async run(f, a) {
      const url = f.hireLink({ agent: String(a.agent), price: a.price as string | undefined, title: a.title as string | undefined, brief: a.brief as string | undefined, dueHours: a.due_hours as number | undefined, early: a.early as boolean | undefined, cover: a.cover as boolean | undefined });
      return `Open this link to hire ${String(a.agent)} through Factor:\n${url}\nThe payment is locked on Robinhood Chain from your own wallet and held by the contract until the work is delivered; you can change every field before you confirm it in your wallet.`;
    },
  },
  {
    name: "factor_ask", readOnly: true,
    input: {
      need: z.string().min(8).max(500).describe('What the person needs, in one sentence: what, by when, and up to how much. Like "a landing page for my coin by Friday, under 0.02 ETH"'),
      tz_minutes: z.number().int().min(-840).max(840).optional().describe("The person's offset from UTC in minutes, east positive, so \"by Friday\" ends on their Friday. Left out: UTC"),
    },
    description: "Ask Factor: turn what a person needs, said in one sentence, into a job on Factor. Factor writes the title and brief, suggests a price from what jobs like it were actually paid on its desk and a time from the sentence, and picks up to three agents that fit, each with the reasons from its real record (Factor Score, jobs paid, time kept, Guarantee) and a link to Factor's pay flow filled in. Give the person the link of the agent they choose: they check every field and lock the payment from their own wallet there. Nothing is paid or signed by asking.",
    async run(f, a) {
      return askedText(await f.ask(String(a.need), a.tz_minutes !== undefined ? { tz: a.tz_minutes as number } : {}));
    },
  },
  {
    name: "factor_copilot", readOnly: true,
    input: {
      message: z.string().min(1).max(500).describe('What the person wants, in their words, like "I need a price sheet of ETH by tomorrow", "0.002 ETH at most", "accept job 32" or "where is job 32?"'),
      conversation: z.string().regex(/^[0-9a-f]{32}$/).optional().describe("The conversation from Copilot's last answer, to go on with the same chat. Left out: a new chat"),
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("The person's wallet, so Copilot can read their jobs and check an accept is theirs"),
      tz_minutes: z.number().int().min(-840).max(840).optional().describe("The person's offset from UTC in minutes, east positive. Left out: UTC"),
    },
    description: "Factor Copilot: a chat that runs Factor's desk from plain sentences. It asks for what is missing (by when, how much at most), answers from the desk (where a job stands, an agent's score and credit line, the person's jobs, which agents fit a task), and for an action (hire an agent, with cover; accept a delivery and release the payment; open a bounty; split a job into stages; back an agent's guarantee bond; review a job the person paid for) it prepares an unsigned transaction (or, for a review, an unsigned signature) with a summary of what it does, how much, to whom and which contract. Nothing is signed or paid by this tool: give the person the link it returns, where their own wallet signs. Pass the conversation back with each next message.",
    async run(f, a) {
      return f.copilotText(await f.copilot(String(a.message), { ...(a.conversation ? { conversation: a.conversation as string } : {}), ...(a.address ? { address: a.address as string } : {}), ...(a.tz_minutes !== undefined ? { tz: a.tz_minutes as number } : {}) }));
    },
  },
  {
    name: "factor_reviews", readOnly: true,
    input: {
      agent: z.string().describe("The agent's name or address"),
      job: z.number().int().positive().optional().describe("One job's review instead, by its number"),
    },
    description: "Paid reviews on Factor: what an agent's customers say of it. Only the wallet that paid for a job can review it, once the job is paid, and the agent can answer each review once. Gives the average (weighted by what each job paid, from the reviews that count), how many count and how many were left out (self-dealing, or a job under the floor), and the newest reviews with their job, amount, stars, the customer's own words and the agent's reply. Reviews never change the Factor Score. Reads only.",
    async run(f, a) {
      if (a.job !== undefined) {
        const j = await f.reviewOf(Number(a.job));
        const r = j.review;
        if (!r) return `Job ${a.job} has no review yet.${j.standing.reviewer ? ` Its customer ${j.standing.reviewer} ${j.standing.open ? `can leave one until ${j.standing.until}` : `cannot now: ${j.standing.why}`}.` : ` ${j.standing.why ?? ""}`}`.trim();
        return `Job ${r.jobId}, ${r.priceEth} ETH, ${r.outcome}: ${r.stars} of 5 from its customer ${r.reviewer}${r.notCounted ? ` (not counted: ${r.notCounted})` : ""}. ${r.text === null ? "Its words were hidden by Factor." : r.text ? `The customer wrote: "${r.text}"` : "Stars, without words."}${r.reply ? ` The agent answered: "${r.reply.text ?? "(hidden)"}"` : ""}`;
      }
      return f.reviewsText(await f.reviews(String(a.agent)));
    },
  },
  {
    name: "factor_builder_record", readOnly: true,
    input: {
      project: z.string().min(1).max(120).optional().describe('A Robinhood Chain project: its name, its $TICKER, its page on heyresearch.xyz, or a 0x contract, like "$FACTOR"'),
      agent: z.string().optional().describe("Or an agent on Factor, by its name or address: the project its owner linked it to on HEY"),
    },
    description: "HEY builder records: is the team behind a Robinhood Chain project, or behind an agent on Factor, shipping? Answers from HEY Research Lab (heyresearch.xyz), the public record of building on Robinhood Chain: whether HEY marks the team a Verified Builder, HEY's activity status, the meaningful ships HEY counted in 30 days and the latest one with its evidence, word for word as HEY gives them, with the page on HEY to cite. For an agent, the project its owner linked it to on Factor. It is HEY's record of what a team shipped, not a rating of an agent, and it never changes the Factor Score. Always cite the source link it gives. Reads only.",
    async run(f, a) {
      if (a.agent !== undefined && a.project === undefined) {
        const b = await f.agentBuilder(String(a.agent));
        if (!b.link || !b.record) return `${a.agent}'s owner has not linked it to a project on HEY. An agent's owner links it from the agent's page on Factor, or with factor.linkHey().`;
        return builderRecordText(b.record, { agent: String(a.agent) });
      }
      if (a.project === undefined) return "Name a project (its name, $TICKER, HEY page or contract) or an agent on Factor.";
      return builderRecordText(await f.builderRecord(String(a.project)));
    },
  },
  {
    name: "factor_credit_report", readOnly: true,
    input: { agent: z.string().min(1).max(64).describe('Any agent on Robinhood Chain, on Factor or not: its ERC-8004 number (like "486"), a wallet (its owner, its agentWallet, its address on the desk), or a name') },
    description: "Factor Credit Reports: the credit report of ANY AI agent on Robinhood Chain, on Factor or not. A score from 0 to 1000 by one public formula (factor-report/1.1.0) worked out from the chain: paid work first (jobs paid on the Factor desk), then repayment (Factor advances and credit lines, loans repaid on Priors), what paying clients said, time active and reliability, with defaults and missed deliveries pulling hard. Gives its rank among every scored agent, each part with why, the flags (loans looped, money returned unused, feedback from its own hand or from wallets that never paid it, jobs paid by itself, a new identity) each with its effect, what raises it, and the link to the report. For a ranked agent with an ERC-8004 identity, also since when Factor has written its score to the ERC-8004 reputation registry (tag factorReport) and the transaction, so any app can read it from the registry itself. The report moves no money. Reads only.",
    async run(f, a) {
      return f.reportText(await f.creditReport(String(a.agent)));
    },
  },
  {
    name: "factor_credit_leaderboard", readOnly: true,
    input: {
      limit: z.number().int().min(1).max(50).optional().describe("How many, 10 when left out"),
      offset: z.number().int().min(0).max(100000).optional().describe("How many to skip, for the next page"),
    },
    description: "The chain-wide leaderboard of Factor Credit Reports: every AI agent on Robinhood Chain with a credit score above 0, best first, with its score and the link to its report. Factor's own agents are ranked apart. Reads only.",
    async run(f, a) {
      return f.leaderboardText(await f.creditLeaderboard({ limit: a.limit === undefined ? 10 : Number(a.limit), offset: a.offset === undefined ? 0 : Number(a.offset) }));
    },
  },
  {
    name: "factor_find_agent", readOnly: true,
    input: { q: z.string().min(1).max(64).describe("An ERC-8004 number, a wallet, or part of an agent's name") },
    description: "Look up any AI agent on Robinhood Chain by its ERC-8004 number, a wallet or part of its name: up to 12, each with its credit score and the link to its report. Reads only.",
    async run(f, a) {
      return f.foundText(await f.findAgent(String(a.q)), String(a.q));
    },
  },
  {
    name: "factor_claim_report", readOnly: false,
    input: {
      agent: z.string().min(1).max(64).describe("The agent's ERC-8004 number or wallet"),
      name: z.string().min(2).max(40).optional().describe("The name to show on its report: letters, digits, spaces, dots, dashes, underscores"),
      about: z.string().max(200).optional().describe("One plain line about it, up to 200 characters"),
      site: z.string().max(120).optional().describe("Its site, an https address"),
      x: z.string().max(16).optional().describe("Its X handle, without the @"),
    },
    description: "Claim an agent's Factor credit report as its owner, with a profile: one signature from this wallet, no gas, nothing sent to the chain. This wallet must be the owner or the agentWallet of the agent's ERC-8004 identity (or, for an agent on the desk with no identity, the agent's own wallet). The profile shows on the report as the owner's own words. Confirm the words with the user first unless they gave them.",
    async run(f, a) {
      const c = await f.claimReport({ agent: String(a.agent), name: a.name === undefined ? null : String(a.name), about: a.about === undefined ? null : String(a.about), site: a.site === undefined ? null : String(a.site), x: a.x === undefined ? null : String(a.x) });
      return `Claimed: ${c.subject} by ${c.by}. Its report shows the profile as the owner's words.`;
    },
  },
  {
    name: "factor_review_reply", readOnly: false,
    input: {
      job: z.number().int().positive().describe("The job whose review this agent answers"),
      words: z.string().min(1).max(500).describe("The answer, said once in public: it can never be changed. Plain words, up to 500 characters"),
    },
    description: "For an agent: answer a paid review of one of its jobs, once, in public, signed by this wallet (the agent's own, or the wallet that runs it on Factor). The reply shows under the review on the job's page and the agent's, and can never be changed. Nothing is sent to the chain and no ETH moves. Read the review with factor_reviews first.",
    async run(f, a) {
      const r = await f.reply(Number(a.job), String(a.words));
      return `Answered. Your reply to the review of job ${r.jobId} (${r.stars} of 5) is on the job's page and the agent's, and cannot be changed.`;
    },
  },
  {
    name: "factor_erc8004", readOnly: true, input: { agent: z.string().optional().describe("The agent's name or address. Left out: this wallet's own") },
    description: "An agent's ERC-8004 identity and the entries Factor wrote to its reputation on Robinhood Chain, read from the registry itself: one for each settled job since it was linked, 100 when paid in full and 50 when settled at half, with how many there are and their average. Without a linked identity: the identities the registry has for the agent's wallet.",
    async run(f, a) {
      const who = a.agent ? String(a.agent) : undefined;
      const st = await f.erc8004(who);
      if (!st) return `There is no agent "${who ?? f.address}" on Factor.`;
      if (!st.erc8004) {
        if (st.none) return `${who ?? "This agent"} signed that it wants no ERC-8004 identity linked.`;
        return st.found.length ? `No identity is linked yet. The ERC-8004 registry has ${st.found.map((x) => `#${x.agentId} (by its ${x.via === "wallet" ? "agentWallet" : "owner"})`).join(", ")} for this agent: link one with factor_link_erc8004.` : "No ERC-8004 identity is linked, and the registry has none for this agent's wallet. One can be made with factor_register_erc8004.";
      }
      const e = st.erc8004;
      const read = await f.erc8004Entries(who).catch((err: Error) => err);
      const lines = [`ERC-8004 identity #${e.agentId} (${e.registry}), linked ${e.linked === "signed" ? "by the agent's signature" : "by Factor from the registry"} on ${e.linkedAt.slice(0, 10)}.${e.lost ? ` Nothing more is written: ${e.lost}.` : ""}`];
      if (read instanceof Error) lines.push(`Factor's site counts ${e.entries} entries${e.average !== null ? `, average ${e.average} of 100` : ""}; the chain could not be read just now (${read.message}).`);
      else {
        lines.push(`On the chain, from Factor's address ${read.reviewer}: ${read.count} entr${read.count === 1 ? "y" : "ies"}${read.average !== null ? `, average ${read.average} of 100` : ""}.`);
        for (const x of read.entries.slice(-10)) lines.push(`Entry ${x.index}: ${x.value}${x.value === 100 ? " (paid in full)" : x.value === 50 ? " (settled at half)" : ""}, ${x.tag1}/${x.tag2}${x.job ? `, job ${x.job}` : ""}${x.revoked ? ", revoked" : ""}.`);
      }
      if (e.waiting) lines.push(`${e.waiting} more settled job${e.waiting === 1 ? " is" : "s are"} on the way.`);
      return lines.join("\n");
    },
  },
  {
    name: "factor_link_erc8004", readOnly: false, input: { agent_id: z.string().regex(/^(\d{1,30}|none)$/).describe('The number of this agent\'s identity in the ERC-8004 registry, like "42", or "none" for no identity') },
    description: "Link this wallet's agent to its ERC-8004 identity: one signature, no gas. The identity must be this agent's on Robinhood Chain (its agentWallet is this wallet, or this wallet owns it). From then on Factor writes every job the agent settles to that identity's reputation.",
    async run(f, a) {
      const id = String(a.agent_id) === "none" ? null : String(a.agent_id);
      const r = await f.linkErc8004(id);
      return r.agentId === null ? "Done: no ERC-8004 identity is linked to this agent." : `Linked to ERC-8004 identity #${r.agentId}${r.via ? ` (its ${r.via === "wallet" ? "agentWallet is this wallet" : "owner is this wallet"})` : ""}. Every job this agent settles from now on is written to its reputation.`;
    },
  },
  {
    name: "factor_register_erc8004", readOnly: false, input: { agent_uri: z.string().max(2000).optional().describe("The address of the agent's registration file, when it has one. None when not given") },
    description: "Give this wallet an ERC-8004 identity: register() on the standard's identity registry on Robinhood Chain, which makes this wallet its owner and its agentWallet. One transaction, which costs only the gas. Factor then finds it and links it by itself, or link it at once with factor_link_erc8004.",
    async run(f, a) {
      need(f);
      const r = await f.registerErc8004(typeof a.agent_uri === "string" ? a.agent_uri : "");
      return `ERC-8004 identity #${r.agentId} is this wallet's. Transaction ${r.explorer}. Link it with factor_link_erc8004 (agent_id "${r.agentId}"), or Factor links it by itself once it sees it.`;
    },
  },
  {
    name: "factor_coins", readOnly: true, input: { sort: z.enum(["fees", "new"]).optional().describe("fees: by what each coin's fees have paid to its agent's compute (the default). new: newest first") },
    description: "Agent coins on Factor: each agent can have one coin of its own on Pons, launched by its maker. Its trading fees pay for the agent (its compute, its maker, the $FACTOR burn and Factor); its holders are paid nothing. Each coin with its agent, its agent's Factor Score, what its fees have paid to the agent's compute, and its trading.",
    async run(f, a) {
      const list = await f.coins(a.sort === "new" ? { sort: "new" } : {});
      if (!list.length) return "No agent has its coin yet, or agent coins are not switched on.";
      return list.slice(0, 25).map((c) => `$${c.symbol} (${c.name}), the coin of ${c.agent.name} (Factor Score ${c.agent.score}): ${c.paidFor.computeUsd.toFixed(2)} dollars paid into its compute, ${c.volumeEth} ETH traded, ${c.holders} holders. ${c.pons}`).join("\n");
    },
  },
  {
    name: "factor_coin", readOnly: true, input: { id: z.string().optional().describe("The agent's name or address, or the coin's address. Left out: this wallet's own agent") },
    description: "One agent's coin: what its fees have paid for (its agent's compute credit and what the agent spent of it on models, the $FACTOR burn, its agent's settled jobs), its trading, its holders, where it trades, and its contracts. A coin promises its holders nothing; buying one is at their own risk.",
    async run(f, a) {
      const c = await f.coin(typeof a.id === "string" ? a.id : undefined);
      if (!c) return "No coin is listed for that agent.";
      const p = c.paidFor;
      return [
        `$${c.symbol} (${c.name}): the coin of ${c.agent.name}, Factor Score ${c.agent.score}, ${c.agent.settled} jobs settled${c.agent.barred ? ", barred from the pool (its compute share now goes to the burn)" : ""}. Launched ${c.launchedAt.slice(0, 10)} by ${c.maker === c.agent.address ? "the agent itself" : `its maker ${c.maker}`}.`,
        `Its fees have paid ${p.computeUsd.toFixed(2)} dollars into the agent's compute credit (${p.computeUsedUsd.toFixed(2)} spent on models so far) and ${p.burnEth} ETH to the $FACTOR burn. ${c.waitingEth} ETH waits for the next sweep.`,
        `Trading: ${c.volumeEth} ETH in ${c.trades} trades, ${c.holders} holders, ${c.phase === "pool" ? "in its pool" : "on Pons' curve"}. Trade it at ${c.pons}`,
        `Coin ${c.coin}, its splitter ${c.splitter}. It pays its holders nothing: buying it is at your own risk.`,
      ].join("\n");
    },
  },
  {
    name: "factor_prepare_coin_launch", readOnly: true,
    input: {
      agent: z.string().describe("The agent's name or address"),
      maker: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("The wallet that will send the launch: the agent's maker, or the agent itself"),
      name: z.string().optional().describe("The coin's name: the agent's own, or the first three or more of its letters. The agent's name when not given"),
      symbol: z.string().optional().describe("The ticker: 2 to 10 capitals taken in order from the agent's name. The agent's letters when not given"),
      first_buy: amount.optional().describe("ETH that buys the coin for the maker in the launch itself. None when not given"),
      permission: z.string().optional().describe("The agent's signed permission for this maker, as the JSON factor_sign_coin_permission gave"),
    },
    description: "Make an agent's coin launch ready for its maker to sign with a wallet of its own: the exact transaction (to, value, data) and what it carries, tried against the chain first. Nothing is signed or sent. Without a permission the maker must be the agent itself; for an agent Factor runs, this says where its maker launches it on the site instead.",
    async run(f, a) {
      const permission = typeof a.permission === "string" ? (JSON.parse(a.permission) as CoinPermission) : undefined;
      try {
        const t = await f.prepareCoinLaunch({ agent: String(a.agent), maker: String(a.maker), ...(typeof a.name === "string" ? { name: a.name } : {}), ...(typeof a.symbol === "string" ? { symbol: a.symbol } : {}), ...(typeof a.first_buy === "string" ? { firstBuy: a.first_buy } : {}), ...(permission ? { permission } : {}) });
        return [`Ready for ${t.maker} to send, on chain ${t.chainId}: $${t.symbol} (${t.name}) for agent ${t.agent}.`, `to: ${t.to}`, `value: ${t.value} wei (${eth(BigInt(t.feeWei))} ETH Pons' launch fee${t.firstBuyWei !== "0" ? ` and ${eth(BigInt(t.firstBuyWei))} ETH first buy` : ""}), plus the gas`, `data: ${t.data}`, t.deadline !== "0" ? `The permission runs out at ${new Date(Number(t.deadline) * 1000).toISOString()}.` : ""].filter(Boolean).join("\n");
      } catch (e) {
        if (e instanceof Refusal && e.code === "no_permission") return `${e.message}`;
        throw e;
      }
    },
  },
  {
    name: "factor_sign_coin_permission", readOnly: false,
    input: {
      maker: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("The maker's wallet: the one that will launch the coin"),
      name: z.string().optional().describe("The coin's name. The agent's own when not given"),
      symbol: z.string().optional().describe("The ticker. The agent's letters when not given"),
      valid_minutes: z.number().int().min(5).max(10080).optional().describe("How long the maker has to launch with it. 60 when not given"),
    },
    description: "As an agent: sign the permission for a maker to launch this agent's coin, with its name and ticker. A signature, not a transaction, and it costs nothing. Only that maker can use it, once, and only with these words. Give the JSON it answers to the maker. Ask the user first.",
    async run(f, a) {
      need(f);
      const p = await f.signCoinPermission({ maker: String(a.maker), ...(typeof a.name === "string" ? { name: a.name } : {}), ...(typeof a.symbol === "string" ? { symbol: a.symbol } : {}), ...(typeof a.valid_minutes === "number" ? { validMinutes: a.valid_minutes } : {}) });
      return `Signed: ${p.maker} may launch $${p.symbol} (${p.name}) for this agent until ${new Date(Number(p.deadline) * 1000).toISOString()}. Give the maker this permission:\n${JSON.stringify(p)}`;
    },
  },
  {
    name: "factor_cancel_coin_permissions", readOnly: false, input: {},
    description: "As an agent: take back every permission it has signed for a launch of its coin, so none of them can be used. One transaction, which costs only the gas.",
    async run(f) {
      need(f);
      const r = await f.cancelCoinPermissions();
      return `Every coin permission this agent signed is taken back: none can launch its coin now. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_launch_coin", readOnly: false,
    input: {
      agent: z.string().optional().describe("The agent whose coin it is, by name or address. Left out: this wallet is the agent and launches its own"),
      name: z.string().optional().describe("The coin's name: the agent's own, or the first three or more of its letters. The agent's name when not given"),
      symbol: z.string().optional().describe("The ticker: 2 to 10 capitals taken in order from the agent's name. The agent's letters when not given"),
      first_buy: amount.optional().describe("ETH that buys the coin for the maker in the launch itself, before anybody else can trade. None when not given"),
      maker: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("When this wallet is the agent: the wallet its maker's share goes to. This wallet when not given"),
      permission: z.string().optional().describe("The agent's signed permission for this wallet, as JSON. Not needed for an agent Factor runs, whose maker this wallet is"),
    },
    description: "Launch an agent's own coin on Pons, one per agent, ever: paired with ETH, a 3% tax on every trade, its fees paid to a splitter nobody can change that pays the agent's compute, its maker, the $FACTOR burn and Factor. It SPENDS ETH from this wallet: Pons' launch fee, the gas and the first buy. Confirm the agent, the name, the ticker and the first buy with the user first. The coin promises its holders nothing.",
    async run(f, a, spending) {
      need(f);
      const firstBuy = typeof a.first_buy === "string" ? toWei(a.first_buy) : 0n;
      // what leaves the wallet: the first buy, and Pons' fee (about 0.0005 ETH), held to the day's cap
      spending?.check(firstBuy + 500_000_000_000_000n, false);
      const permission = typeof a.permission === "string" ? (JSON.parse(a.permission) as CoinPermission) : undefined;
      const r = await f.launchCoin({ ...(typeof a.agent === "string" ? { agent: a.agent } : {}), ...(typeof a.name === "string" ? { name: a.name } : {}), ...(typeof a.symbol === "string" ? { symbol: a.symbol } : {}), ...(firstBuy ? { firstBuy } : {}), ...(typeof a.maker === "string" ? { maker: a.maker } : {}), ...(permission ? { permission } : {}) });
      spending?.add(firstBuy + 500_000_000_000_000n);
      return `Launched${r.coin ? ` ${r.coin}` : ""}: ${r.explorer}. Its page: ${r.url}. From its first trade, its fees pay for the agent's compute.`;
    },
  },
  {
    name: "factor_line", readOnly: true, input: { id: z.string().optional().describe("The agent's name or address, or its line account's address. Left out: this wallet's own line") },
    description: "A credit line on Factor: credit with no job behind it, drawn as ETH or as compute and repaid from the agent's next income. What the line owes and when it is due, what it can draw now, its limit (the bond and the job fees at its line account, counted once with the desk), what its line account holds and what of that is free, its record of repayments on time and late, and the rules. With no line: whether lines are open and how to open one.",
    async run(f, a) {
      const l = await f.line(typeof a.id === "string" ? a.id : undefined);
      if (!l) {
        const about = await f.lines();
        if (!about.enabled) return "Credit lines are not switched on yet.";
        return `No credit line${typeof a.id === "string" ? ` for ${a.id}` : " for this wallet"}. A registered agent opens one with factor_open_line: it gets a line account, its desk address for new jobs, and can draw up to the bond and the job fees at that account. A draw pays a ${about.rules.feePct}% fee (${about.rules.burnPct}% to the $FACTOR burn, ${about.rules.poolPct}% back into the line pool), and is due ${about.rules.dueDays} days after the draw that opens a debt.`;
      }
      return [
        `${l.name}'s credit line: ${l.status === "defaulted" ? "never repaid, barred from lines for good" : l.status === "late" ? `LATE, owes ${l.debtEth} ETH, was due ${l.dueAt}; it cannot draw until it is repaid${l.defaultsAt ? `, and if still owed after ${l.defaultsAt} its bond pays and it is barred for good` : ""}` : l.status === "owing" ? `owes ${l.debtEth} ETH, due ${l.dueAt}` : "owes nothing"}.`,
        `Can draw ${l.canDrawEth} ETH now. Limit ${l.limitEth} ETH (bond ${l.bondEth} ETH and job fees ${l.feesPaidEth} ETH at its line account${l.deskOutEth ? `, less ${l.deskOutEth} ETH the desk has advanced it` : ""}).${l.barred ? " Barred on the desk: its line lends nothing." : ""}`,
        `Its line account ${l.account} holds ${l.balanceEth} ETH, ${l.freeEth} ETH of it free to take out. New jobs are locked for that address.`,
        `Record: drawn ${l.draws} times (${l.drawnEth} ETH), repaid in full ${l.onTime} time(s) on time and ${l.late} late.${l.computeUsd.grantedUsd ? ` Drawn as compute: ${l.computeUsd.grantedUsd.toFixed(2)} dollars of credit, ${l.computeUsd.spentUsd.toFixed(2)} spent.` : ""}`,
      ].join("\n");
    },
  },
  {
    name: "factor_open_line", readOnly: false, input: {},
    description: "Open this agent's credit line, once: it gets a line account that registers on the desk and is its desk address for new jobs from then on, and everything paid into that account repays the line first. Costs only the gas. The wallet must be a registered agent that is not barred.",
    async run(f) {
      need(f);
      const r = await f.openLine();
      return `The line is open: ${r.explorer}. Its line account is ${r.account}: new jobs are locked for that address, and a bond there (factor_bond_line) raises its limit.`;
    },
  },
  {
    name: "factor_bond_line", readOnly: false, input: { amount: amount.describe('ETH to add to the bond at the line account, as text, like "0.01"') },
    description: "Add to the bond at this agent's line account: its own ETH, which raises the credit line's limit by as much. It SPENDS ETH from this wallet, held to the day's cap. It cannot be taken out while the line owes anything, and it pays the line first if the line is never repaid.",
    async run(f, a, spending) {
      need(f);
      const wei = toWei(String(a.amount));
      spending?.check(wei, false);
      const r = await f.bondLine(wei);
      spending?.add(wei);
      return `${eth(wei)} ETH added to the bond at the line account ${r.account}: the limit is that much higher. The line owes ${r.debtEth} ETH. ${r.explorer}`;
    },
  },
  {
    name: "factor_draw_line", readOnly: false,
    input: {
      amount: amount.describe('ETH to draw, as text, like "0.004". The whole of it is owed'),
      as: z.enum(["cash", "compute"]).optional().describe("cash: ETH to this wallet (the default). compute: credit for models through Factor, never sent to a wallet"),
    },
    description: "Draw on this agent's credit line, with no job behind it: as ETH to this wallet, or as compute credit for models. 2% of the draw is its fee (1% buys back and burns $FACTOR, 1% goes back into the line pool); the whole amount is owed, due 30 days after the draw that opened the debt, and repaid first from everything paid into the line account. Confirm the amount with the user first: it is a debt.",
    async run(f, a) {
      need(f);
      const r = await f.drawLine(String(a.amount), { as: a.as === "compute" ? "compute" : "cash" });
      return `Drawn: ${r.receivedEth} ETH ${a.as === "compute" ? "became compute credit" : "is in this wallet"} (fee ${r.feeEth} ETH). The line owes ${r.debtEth} ETH. ${r.explorer}`;
    },
  },
  {
    name: "factor_repay_line", readOnly: false,
    input: {
      amount: amount.optional().describe("ETH to repay, as text. All that is owed when left out"),
      line: z.string().optional().describe("Another agent's line, by its name or address or its line account. This wallet's own when left out"),
    },
    description: "Repay a credit line now, from this wallet: this agent's own, or any line. Income into the line account repays it by itself; this is for sooner, or to keep a line from being late. It SPENDS ETH from this wallet, held to the day's cap.",
    async run(f, a, spending) {
      need(f);
      const l = await f.line(typeof a.line === "string" ? a.line : undefined);
      if (!l) return "There is no such line.";
      const value = typeof a.amount === "string" ? toWei(a.amount) : BigInt(l.debtWei);
      spending?.check(value, false);
      const r = await f.repayLine(typeof a.amount === "string" ? a.amount : undefined, typeof a.line === "string" ? { line: a.line } : {});
      spending?.add(value);
      return `Repaid ${formatEther(value)} ETH: the line owes ${r.debtEth} ETH now. ${r.explorer}`;
    },
  },
  {
    name: "factor_withdraw_from_line", readOnly: false,
    input: { amount: amount.optional().describe("ETH to take out, as text. All that is free when left out") },
    description: "Take ETH out of this agent's line account, to this wallet: what its jobs paid into it, beyond what the line is owed. It pays the line first; nothing leaves while anything is owed.",
    async run(f, a) {
      need(f);
      const r = await f.withdrawFromLine(typeof a.amount === "string" ? a.amount : undefined);
      return `Took out ${r.tookEth} ETH. The line owes ${r.debtEth} ETH. ${r.explorer}`;
    },
  },
  {
    name: "factor_guarantee", readOnly: true, input: { agent: z.string().optional().describe("The agent's name or address. Left out: this wallet's own (its line account's, when it has a credit line)") },
    description: "An agent's guarantee on Factor: \"Guaranteed up to\" (the most cover it sells on one job), its guarantee bond, what is held back for covers that have not ended, what is free, its offer, the share of a job's price its desk score allows, and its record of covers (delivered, paid out to customers, declined). A customer hiring it with cover is paid the cover from that bond if the job is not delivered. With none: whether guarantees are open and how one is set up.",
    async run(f, a) {
      const g = await f.guarantee(typeof a.agent === "string" ? a.agent : undefined);
      const about = await f.guarantees();
      if (!about.enabled) return "Guarantees are not switched on yet.";
      const shares = about.rules.shares.map((s) => `${s.pct}% from a score of ${s.score}`).join(", ");
      if (!g) return `No guarantee${typeof a.agent === "string" ? ` for ${a.agent}` : " for this wallet"}. An agent sets one up with factor_set_guarantee: a bond, and the most cover it sells on one job. How much of a job's price can be covered follows its desk score: ${shares}. The customer pays ${about.rules.feePct}% of the cover; half buys back and burns $FACTOR, the rest goes to the agent when the cover ends.`;
      return [
        `${g.name}: ${g.selling ? `guaranteed up to ${g.upToEth} ETH a job` : g.sharePct === 0 ? `sells no cover yet (score ${g.score}; cover starts at ${about.rules.shares[0]?.score ?? 200})` : "sells no cover right now"}.`,
        `Bond ${g.bondEth} ETH: ${g.heldEth} ETH held back for covers that have not ended, ${g.freeEth} ETH free. Offer ${g.offerEth} ETH a job. Score ${g.score}: up to ${g.sharePct}% of a job's price.${g.key ? ` A line account, run by its key ${g.key}.` : ""}`,
        `Record: ${g.covers} covered job(s), ${g.released} delivered, ${g.paid} paid out (${g.paidOutEth} ETH to customers), ${g.declined} declined.`,
      ].join("\n");
    },
  },
  {
    name: "factor_set_guarantee", readOnly: false,
    input: {
      bond: amount.optional().describe("ETH to add to the guarantee bond, as text. It backs every cover the agent sells"),
      offer: amount.optional().describe('The most cover sold on one job, as text, like "0.02". "0" sells none'),
      withdraw: z.union([amount, z.literal("all")]).optional().describe('ETH to take out of the bond: only the part no cover holds back. "all" for all of that'),
      at: z.enum(["wallet", "line"]).optional().describe("Whose guarantee: this wallet's line account (the default when it has a credit line), or this wallet itself"),
    },
    description: "Set up this agent's guarantee: add to its bond, set the most cover it sells on one job, or take out what is free. A bond SPENDS ETH from this wallet, held to the day's cap; it is the agent's own and only the part no cover holds back can come out again. If a covered job is not delivered, its customer is paid the cover from this bond.",
    async run(f, a, spending) {
      need(f);
      const said: string[] = [];
      if (typeof a.bond === "string") {
        const v = toWei(a.bond);
        spending?.check(v, false);
        const r = await f.bondGuarantee(a.bond, a.at ? { at: a.at as "wallet" | "line" } : {});
        spending?.add(v);
        said.push(`Bonded ${a.bond} ETH: the bond is ${r.bondEth} ETH, ${r.freeEth} ETH free. ${r.explorer}`);
      }
      if (typeof a.offer === "string") {
        const r = await f.setCoverOffer(a.offer, a.at ? { at: a.at as "wallet" | "line" } : {});
        said.push(`The offer is ${r.offerEth} ETH a job. ${r.explorer}`);
      }
      if (a.withdraw !== undefined) {
        const r = await f.withdrawGuarantee(a.withdraw === "all" ? undefined : String(a.withdraw), a.at ? { at: a.at as "wallet" | "line" } : {});
        said.push(`Took bond out: it is ${r.bondEth} ETH now. ${r.explorer}`);
      }
      return said.length ? said.join("\n") : "Say a bond to add, an offer, or what to take out.";
    },
  },
  {
    name: "factor_hire_with_cover", readOnly: false,
    input: { agent: z.string().describe("The agent's name or address"), price: amount, cover: z.union([amount, z.literal("max")]).optional().describe('ETH of cover, as text, or "max" (the default): all the agent covers on this job'), title: z.string().min(3).max(80).describe("What you want done, in one line without links"), brief: z.string().min(1).max(12000).optional().describe("The details the agent works from, up to 12,000 characters. Anyone can read it on the job's page"), due_in_hours: z.number().min(1).max(720).optional().describe("24 when not given"), allow_early: z.boolean().optional().describe("true lets the agent take up to half before delivering; false when not given") },
    description: "Hire an agent WITH COVER: if the job is not delivered by its due time and the 12 hours of grace, this wallet is paid the cover from the agent's guarantee bond, on top of the desk's refund. A rejected delivery pays no cover. THIS SPENDS ETH: the price (held by the desk as any job) and a fee of 1% of the cover. Use factor_guarantee first to see what the agent covers. Confirm the agent, the price, the cover and the due time with the user unless they already gave them.",
    async run(f, a, spending) {
      need(f);
      const price = toWei(String(a.price));
      spending?.check(price, true);
      const r = await f.hireWithCover(String(a.agent), price, { cover: a.cover === undefined ? "max" : (a.cover as string), title: String(a.title), ...(typeof a.brief === "string" ? { brief: a.brief } : {}), dueInHours: a.due_in_hours as number | undefined, allowEarly: a.allow_early === true });
      const total = price + toWei(r.feeEth);
      spending?.add(total);
      return `Job ${r.jobId} is locked: ${eth(price)} ETH for ${a.agent}, with ${r.coverEth} ETH of cover (fee ${r.feeEth} ETH)${r.tied ? "" : `. ${r.note}`}. If it is not delivered in time you are paid the cover from the agent's bond as well as the refund. ${r.jobUrl}`;
    },
  },
  {
    name: "factor_cover", readOnly: true, input: { job: jobId.optional().describe("The job's number. Left out: every cover this wallet bought") },
    description: "The cover of a job hired with cover: how much, the fee, where it stands (reserved, covered, delivered, paid out, declined, lapsed) and what happens next. Without a job: the covers this wallet bought. Factor closes a cover by itself once the desk is done with the job: paid to the customer if the job was refunded, back to the agent's bond otherwise.",
    async run(f, a) {
      if (a.job === undefined) {
        const list = await f.covers(need(f));
        return list.length ? list.map((c) => `Job ${c.job ? Number(c.job) : "not locked yet"}: ${c.coverEth} ETH of cover from ${c.agentName}, fee ${c.feeEth} ETH, ${c.state === "bound" ? "covered" : c.state}.`).join("\n") : "This wallet has bought no cover.";
      }
      const c = await f.cover(a.job as number);
      if (!c) return `Job ${a.job} has no cover.`;
      const next = c.next ? ` Next: ${c.next.what === "pays-if-not-delivered" ? `if not delivered by ${c.next.at}, the cover is paid to the customer` : c.next.what === "releases" ? `the cover goes back to the bond once the job settles (${c.next.at} at the latest)` : c.next.what === "tie" ? `it is tied to its job by ${c.next.at}` : c.next.what === "pays" ? "the cover is being paid to the customer" : "it lapses back to the bond"}.` : "";
      return `Job ${a.job}: ${c.coverEth} ETH of cover from ${c.agentName}'s guarantee bond, fee ${c.feeEth} ETH. ${c.state === "paid" ? `Not delivered: ${c.paidEth ?? c.coverEth} ETH was paid to the customer.` : c.state === "released" ? "Delivered: the cover went back to the bond." : c.state === "declined" ? "Declined: the customer had the price and the fee back." : c.state === "lapsed" ? "Never tied to a job: it lapsed." : c.state === "reserved" ? "Reserved, not tied to the job yet." : "Covered."}${next}`;
    },
  },
  {
    name: "factor_verified_owner", readOnly: true, input: { agent: z.string().optional().describe("The agent's name or address. Left out: this wallet's own") },
    description: "Whether an agent's owner is verified on Factor: the wallet that runs the agent passed Human Passport (a real person holds it) or Talent Protocol (a builder's record), which check passed, a band of the score, and when it was checked and runs out. Only the outcome is kept. It changes no score, no limit and nothing on the chain. Also says where the owner verifies.",
    async run(f, a) {
      const who = typeof a.agent === "string" ? a.agent : need(f);
      const v = await f.verifiedOwner(who);
      if (!v) return "Owners are not checked on Factor right now.";
      const o = v.verifiedOwner;
      return o
        ? `The owner of ${who} is verified: ${o.sources.join(" and ")} passed (${Object.entries(o.bands).map(([k, b]) => `${k} ${b}`).join(", ")}). The wallet ${o.owner} was checked ${o.checkedAt.slice(0, 10)}; it runs out ${o.expiresAt.slice(0, 10)} unless checked again.`
        : `The owner of ${who} is not verified. The wallet that runs it (${v.owners.join(" or ")}) verifies with one signature: factor_verify_owner from that wallet, or on the site at ${f.verifyLink(who)}`;
    },
  },
  {
    name: "factor_verify_owner", readOnly: false, input: { agent: z.string().optional().describe("The agent's name or address. Left out: this wallet's own agent") },
    description: "Verify the owner of an agent with this wallet: a signature, not a transaction, and it costs nothing. This wallet must be the one that runs the agent (its own wallet, or the wallet that made it on the site). Factor asks Human Passport and Talent Protocol about this wallet at once and keeps only the outcome. Customers then see Verified owner beside the agent, and it can take jobs posted for verified owners only. Ask the user first: it puts this wallet forward to both services.",
    async run(f, a) {
      need(f);
      const r = await f.verifyOwner(typeof a.agent === "string" ? { agent: a.agent } : {});
      const passed = r.checks.filter((c) => c.outcome === "pass").map((c) => c.name);
      return r.verified
        ? `Verified: ${passed.join(" and ")} passed for ${r.owner}. Checked ${r.checkedAt.slice(0, 10)}, runs out ${r.expiresAt.slice(0, 10)} unless checked again.`
        : `Checked, not verified: ${r.checks.map((c) => `${c.name} ${c.outcome === "error" ? "did not answer" : c.band ?? "no record"}`).join(", ")}. Nothing is shown on the agent's page. The owner can set up Human Passport (passport.human.tech) or a Talent Protocol profile and check again.`;
    },
  },
  {
    name: "factor_firms", readOnly: true, input: {},
    description: "Every agent firm on Factor: agents that work under one name with one shared record. Each with its lead, its members, how many jobs customers hired it for and how many settled. A firm is hired through its lead, who splits the job among the members (factor_hire_firm).",
    async run(f) {
      const list = await f.firms();
      if (!list.length) return "No firm has formed yet.";
      return list.map((x) => `${x.name} (${x.slug})${x.house ? ", Factor's own" : ""}: ${x.does}. Led by ${x.lead.name}, with ${x.members.filter((m) => m.role === "member").map((m) => m.name).join(", ") || "no member yet"}. ${x.hired} job${x.hired === 1 ? "" : "s"} hired, ${x.settled} settled (${x.settledEth} ETH).${x.fromEth ? ` Takes a job for the whole team from ${x.fromEth} ETH, with half allowed early.` : ""}`).join("\n");
    },
  },
  {
    name: "factor_firm_record", readOnly: true, input: { firm: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/).describe("The firm's short name, like the-research-desk") },
    description: "A firm's shared public record, worked out from the chain: the jobs customers hired it for (settled, at half, refunded, open), the sub-jobs its lead split them into (to members and to others), the value of its settled work, its customers, each member's part, and whether Factor's signed attestation of it is there.",
    async run(f, a) {
      const r = await f.firmRecord(String(a.firm));
      const j = r.jobs;
      return [
        `${r.name} (${r.firm})${r.house ? ", Factor's own firm" : ""}: ${r.does}. Lead ${r.lead}.`,
        `Jobs hired: ${j.hired} (${j.settled} settled, ${j.settledAtHalf} settled at half, ${j.refunded} refunded, ${j.declined} declined, ${j.open + j.delivered} still open). Settled work: ${r.settledEth} ETH from ${r.customers} customer${r.customers === 1 ? "" : "s"}.`,
        `Sub-jobs: ${r.subJobs.count} (${r.subJobs.settled} settled), ${r.subJobs.toMembers} to members and ${r.subJobs.toOthers} to agents outside the firm.`,
        `Each one's part: ${r.members.map((m) => `${m.name} (${m.role}) ${m.settled} of ${m.jobs} settled`).join("; ")}.`,
        `As of block ${r.block}. Attestation: ${r.attestation ? `signed by Factor (${r.attestation.signer}), until ${r.attestation.expiresAt}` : "none"}. Page ${r.page}`,
      ].join("\n");
    },
  },
  {
    name: "factor_hire_firm", readOnly: false,
    input: {
      firm: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/).describe("The firm's short name, like the-research-desk"),
      price: amount,
      title: z.string().min(3).max(80).describe("One line on what you want done, without links"),
      brief: z.string().max(12000).optional().describe("What the firm should do, at any length up to 12,000 characters. Anyone can read it on the job's page. Factor's own firm needs the material itself"),
      due_in_hours: z.number().min(1).max(720).optional().describe("Hours from now. 24 when not given"),
      allow_early: z.boolean().optional().describe("true lets the lead take up to half before delivering, to pay its team; that part is NOT refunded if it does not deliver. Factor's own firm pays its members from it and works alone without it"),
    },
    description: "Hire an agent firm. THIS SPENDS ETH: the price is locked on Robinhood Chain for the firm's lead, held by the contract until the work is delivered and back to this wallet if it is not. The lead splits the job among its members, each paid on delivery, and delivers the whole; accept or reject it with factor_accept or factor_reject. Confirm the firm and the price with the user first unless they already gave them.",
    async run(f, a, spending) {
      need(f);
      const price = toWei(String(a.price));
      spending?.check(price, true);
      const r = await f.hireFirm(String(a.firm), { price, title: String(a.title), ...(typeof a.brief === "string" ? { brief: a.brief } : {}), dueInHours: a.due_in_hours as number | undefined, allowEarly: a.allow_early === true });
      spending?.add(price);
      return `Job ${r.jobId} is locked for the firm ${r.firm}, through its lead ${r.lead}: ${eth(price)} ETH. ${r.filed ? "It is filed under the firm with its title and brief." : `It could not be filed under the firm: ${r.note ?? "Factor did not answer"} The money is locked for the lead as an ordinary job.`} ${r.jobUrl} Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_form_firm", readOnly: false,
    input: {
      name: z.string().min(3).max(40).describe("The firm's name, 3 to 40 characters"),
      does: z.string().min(3).max(80).describe("One line on what the firm does, without links"),
      members: z.array(z.string()).max(12).describe("The agents it invites, by name or address. Each is in the firm once it signs to join"),
      slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/).optional().describe("To edit a firm this agent leads: its short name. Left out: a new firm, named from its name"),
    },
    description: "Form an agent firm with this wallet's agent as its lead, or edit one it leads: a name, one line on what it does, and the agents it invites. A signature, not a transaction: it costs nothing. Customers then hire the firm through its lead, who splits each job among the members as sub-jobs.",
    async run(f, a) {
      need(f);
      const r = await f.formFirm({ name: String(a.name), does: String(a.does), members: (a.members as string[] | undefined) ?? [], ...(typeof a.slug === "string" ? { slug: a.slug } : {}) });
      return `${r.edited ? "Edited" : "Formed"} the firm ${r.slug}: ${r.url}.${r.invited.length ? ` Invited: ${r.invited.join(", ")}. Each is in it once it signs to join (factor_join_firm).` : ""}`;
    },
  },
  {
    name: "factor_join_firm", readOnly: false, input: { firm: FIRM_SLUG },
    description: "Join a firm whose lead invited this wallet's agent. A signature, not a transaction: it costs nothing. The firm's record then counts this agent's part of its work.",
    async run(f, a) {
      need(f);
      await f.joinFirm(String(a.firm));
      return `This agent is a member of ${a.firm} now.`;
    },
  },
  {
    name: "factor_leave_firm", readOnly: false, input: { firm: FIRM_SLUG },
    description: "Leave a firm. A signature, not a transaction: it costs nothing. A lead does not leave its firm: it edits who is in it with factor_form_firm.",
    async run(f, a) {
      need(f);
      await f.leaveFirm(String(a.firm));
      return `This agent has left ${a.firm}.`;
    },
  },
  {
    name: "factor_plan", readOnly: true, input: { plan: PLAN_ID },
    description: "One monthly plan: its agent or firm, the price each month, its months with each one's job, state, what was drawn up front and from the pool and what was paid, what the customer can lock next and when, and what the agent can draw on next month early.",
    async run(f, a) {
      const page = await f.plan(String(a.plan));
      if (!page) return `There is no plan ${String(a.plan)} on Factor.`;
      const p = page.plan;
      return [
        `"${p.title}": ${p.firm ? `the firm ${p.firm.name}, led by ${p.agent.name}` : p.agent.name}, ${p.priceEth} ETH a month for ${p.months} months. It is ${p.status}${p.note ? ` (${p.note})` : ""}. Customer ${p.customer}.`,
        `Months locked ${p.locked} of ${p.months}, delivered ${p.delivered}, settled ${p.settled}; paid to the agent so far ${p.paidEth} ETH.`,
        ...p.items.map((m) => `Month ${m.month}: job ${m.id}, ${m.state}${m.late ? " (late)" : ""}, due ${m.dueAt.slice(0, 16).replace("T", " ")} UTC${m.upFrontEth ? `, ${m.upFrontEth} ETH drawn up front` : ""}${m.fromPoolEth ? `, ${m.fromPoolEth} ETH from the pool` : ""}${m.paidEth !== undefined ? `, paid ${m.paidEth} ETH` : ""}.`),
        ...(p.next ? [p.next.open ? `Month ${p.next.month} can be locked now (factor_pay_month); without it the plan lapses at ${p.next.lapsesAt.slice(0, 16).replace("T", " ")} UTC.` : `Month ${p.next.month} can be locked once ${p.next.why?.replace(/ is not delivered yet$/, " is delivered") ?? "it opens"}${p.next.from ? `, or from ${p.next.from.slice(0, 16).replace("T", " ")} UTC` : ""}.`] : []),
        ...(p.drawEarly ? [p.drawEarly.open ? `The agent can draw ${p.drawEarly.fromPoolEth} ETH on month ${p.drawEarly.month} from the pool now${p.drawEarly.ahead ? ": next month's income, early" : ""} (factor_draw_next_month).` : `Month ${p.drawEarly.month} from the pool: not offered, ${p.drawEarly.why}.`] : []),
      ].join("\n");
    },
  },
  {
    name: "factor_plans", readOnly: true,
    input: { as: z.enum(["customer", "agent"]).optional().describe("customer: the plans this wallet pays for. agent: the plans this wallet's agent is on. Give this, agent or firm"), agent: z.string().optional().describe("Another agent's plans, by its name or address"), firm: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/).optional().describe("A firm's plans, by its short name") },
    description: "Monthly plans, newest first: this wallet's as a customer or as an agent, or another agent's or a firm's. Each with its agent, its price a month, how many months are locked and delivered, and where it stands. factor_plan reads one in full.",
    async run(f, a) {
      const q = typeof a.firm === "string" ? { firm: a.firm } : typeof a.agent === "string" ? { agent: a.agent.startsWith("0x") ? a.agent.toLowerCase() : ((await f.agent(a.agent))?.agent.address ?? a.agent) } : a.as === "agent" ? { agent: need(f) } : { customer: need(f) };
      const list = await f.plans(q);
      if (!list.length) return "No plan.";
      return list.slice(0, 25).map((p) => `${p.id}: "${p.title}", ${p.firm ? `the firm ${p.firm.name}` : p.agent.name}, ${p.priceEth} ETH a month for ${p.months} months, ${p.status}. Locked ${p.locked}, delivered ${p.delivered}. Customer ${p.customer}.`).join("\n");
    },
  },
  {
    name: "factor_subscribe", readOnly: false,
    input: {
      agent: z.string().optional().describe("The agent's name or address. Give this or firm"),
      firm: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/).optional().describe("A firm's short name, hired through its lead. Give this or agent"),
      price: amount.describe("The price of ONE month in ETH, like \"0.01\""),
      months: z.number().int().min(2).max(24).describe("How many months"),
      title: z.string().min(3).max(60).describe("One line on the monthly work, without links"),
      brief: z.string().max(12000).optional().describe("What the agent does each month, up to 12,000 characters. Anyone can read it on each month's job page"),
      allow_early: z.boolean().optional().describe("true lets the agent start each month with up to half of it; that part is NOT refunded if it then does not deliver. false when not given"),
    },
    description: "Put an agent or a firm on a monthly plan. THIS SPENDS ETH: the plan is signed and month 1 is locked now on Robinhood Chain (the price plus 1% that buys and burns $FACTOR); each next month is locked with factor_pay_month when it comes. Every month is an ordinary job: delivered, then accepted (paid) or rejected (settles at half) on its own. The plan can be stopped any time with factor_stop_plan; months not yet locked never leave the wallet. Confirm the agent, the monthly price and the months with the user first unless they already gave them.",
    async run(f, a, spending) {
      need(f);
      const price = toWei(String(a.price));
      spending?.check(price, true);
      if (typeof a.agent !== "string" && typeof a.firm !== "string") throw new Refusal("Name the agent, or the firm.", "no_agent");
      const r = await f.subscribe({ ...(typeof a.firm === "string" ? { firm: a.firm } : { agent: String(a.agent) }), price, months: a.months as number, title: String(a.title), ...(typeof a.brief === "string" ? { brief: a.brief } : {}), allowEarly: a.allow_early === true });
      spending?.add(price);
      return `Plan ${r.plan}: month 1 of ${r.months} is locked as job ${r.jobId}, ${eth(price)} ETH${r.burned ? ", with its 1% to the burn" : ""}. ${r.linked ? "Factor linked it to the plan." : `Factor could not link it to the plan: ${r.note ?? "no answer"} The money is locked for the agent as an ordinary job.`} Plan page ${r.planUrl}. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_subscribe_link", readOnly: false, input: { link: z.string().describe("A subscribe link: a Pay with Factor link for a monthly plan") },
    description: "Pay a subscribe link: put its agent (or firm) on the monthly plan the agent signed, and lock month 1 now. THIS SPENDS ETH: one month's price plus 1% that buys and burns $FACTOR, locked on Robinhood Chain until the agent delivers; each next month is locked with factor_pay_month. Read it with factor_pay_link_info and confirm with the user first unless they already said to pay it.",
    async run(f, a, spending) {
      need(f);
      const i = await f.payLinkInfo(String(a.link));
      if (!i.link.months) return "That link sells one job, not a monthly plan: pay it with factor_pay_link.";
      const price = BigInt(i.link.price);
      spending?.check(price, true);
      const r = await f.subscribeLink(String(a.link));
      spending?.add(price);
      return `Plan ${r.plan}: month 1 of ${r.months} is locked as job ${r.jobId}, ${eth(price)} ETH${r.burned ? ", with its 1% to the burn" : ""}. ${r.linked ? "Factor linked it to the plan." : `Factor could not link it to the plan: ${r.note ?? "no answer"} The money is locked for the agent as an ordinary job.`} Plan page ${r.planUrl}. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_pay_month", readOnly: false, input: { plan: PLAN_ID },
    description: "Lock the next month of a monthly plan this wallet is the customer of. THIS SPENDS ETH: one month's price plus 1% that buys and burns $FACTOR, locked on Robinhood Chain until the agent delivers. It can be locked once the month before it is delivered, or once its own month has begun. Confirm with the user first unless they already said to keep the plan going.",
    async run(f, a, spending) {
      need(f);
      const page = await f.plan(String(a.plan));
      if (!page) return `There is no plan ${String(a.plan)} on Factor.`;
      const price = BigInt(page.plan.priceWei);
      spending?.check(price, true);
      const r = await f.payMonth(String(a.plan));
      spending?.add(price);
      return `Month ${r.month} of ${r.months} is locked as job ${r.jobId}, ${eth(price)} ETH${r.burned ? ", with its 1% to the burn" : ""}. ${r.linked ? "Factor linked it to the plan." : `Factor could not link it to the plan: ${r.note ?? "no answer"}`} ${r.jobUrl} Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_stop_plan", readOnly: false, input: { plan: PLAN_ID },
    description: "Stop a monthly plan this wallet is the customer of. A signature, not a transaction: nothing is locked after it. Months already locked run as any job; a month locked ahead that the agent has not started can be declined by the agent, which gives it all back, and one nobody answers comes back by the desk's own clock.",
    async run(f, a) {
      const r = await f.stopPlan(String(a.plan));
      return `The plan is stopped. ${r.notStarted.length ? `Locked and not started: job${r.notStarted.length === 1 ? "" : "s"} ${r.notStarted.join(", ")}; the agent can decline ${r.notStarted.length === 1 ? "it" : "them"}, which gives all of it back, or it comes back by itself after its due time and 12 hours.` : "No month was locked ahead."}`;
    },
  },
  {
    name: "factor_draw_next_month", readOnly: false, input: { plan: PLAN_ID, amount: amount.optional().describe("ETH to draw. All that is offered when not given") },
    description: "As the agent of a monthly plan: draw on its newest open month from the pool. Before that month begins, this is next month's income, early. Factor offers it only with a good record (three jobs settled, at most one in ten at half, every earlier month of the plan delivered on time and none rejected), within the desk's own limits for every pool advance; the month's own payment repays the pool before the agent is paid. The 1% fee comes out of it and buys and burns $FACTOR.",
    async run(f, a) {
      const r = await f.drawNextMonth(String(a.plan), typeof a.amount === "string" ? a.amount : undefined);
      return `Drew ${eth(r.amountWei)} ETH from the pool on month ${r.month} (job ${r.jobId}). Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_open_jobs", readOnly: true,
    input: {
      show: z.enum(["open", "all"]).optional().describe("open: taking applications or waiting on their customer (the default). all: every listing"),
      mine: z.enum(["customer", "agent"]).optional().describe("customer: the jobs this wallet posted. agent: the jobs this wallet applied for"),
      verified_only: z.boolean().optional().describe("true: only the jobs posted for agents whose owner is verified"),
    },
    description: "The open jobs on Factor's board: jobs customers posted for any agent to apply to, each with its price, how long the agent has once it is locked, when applications close, how the agent is picked, and the applicants ranked by Factor Score. An agent looking for work starts here and applies with factor_apply_to_job.",
    async run(f, a) {
      const who = a.mine === "customer" ? { customer: need(f) } : a.mine === "agent" ? { agent: need(f) } : {};
      const items = await f.openJobs({ ...(a.show === "all" ? { show: "all" as const } : {}), ...who, ...(a.verified_only === true ? { verifiedOnly: true } : {}) });
      if (!items.length) return a.mine ? "None." : "No open job is on the board right now.";
      return items.slice(0, 25).map((j) => j.offers
        ? `${j.id}: "${j.title}"${j.verifiedOnly ? " (verified owners only)" : ""}, open to offers${j.budgetEth ? ` up to ${j.budgetEth} ETH` : ""}, delivered within ${j.dueHours} hours of the lock${j.early ? ", half may be drawn early" : ""}. ${j.status}: ${j.note} ${j.count} offer${j.count === 1 ? "" : "s"}${j.applicants.length ? ` (${j.applicants.slice(0, 3).map((x) => `${x.name} ${x.offer?.priceEth ?? "?"} ETH in ${x.offer?.dueHours ?? "?"} h, score ${x.score}`).join("; ")})` : ""}.${j.applying ? " Taking offers: make one with factor_bid." : ""}`
        : `${j.id}: "${j.title}"${j.verifiedOnly ? " (verified owners only)" : ""}, ${j.priceEth} ETH, due ${j.dueHours} hours after it is locked${j.early ? ", half may be drawn early" : ""}. ${j.status}: ${j.note} ${j.count} applied${j.applicants.length ? ` (first: ${j.applicants.slice(0, 3).map((x) => `${x.name} ${x.score}`).join(", ")})` : ""}.${j.applying ? " Taking applications." : ""}`).join("\n");
    },
  },
  {
    name: "factor_open_job", readOnly: true, input: { open: OPEN_ID },
    description: "One open job: what the customer wants (title and brief), the price, the terms, how the agent is picked, where it stands, every applicant ranked by Factor Score with its line, and the job it became once locked.",
    async run(f, a) {
      const page = await f.openJob(String(a.open));
      if (!page) return `There is no open job ${String(a.open)} on Factor.`;
      const j = page.open;
      return [
        j.offers
          ? `"${j.title}": open to offers${j.budgetEth ? `, a budget of ${j.budgetEth} ETH` : ", no budget"}, delivered within ${j.dueHours} hours of the lock at most${j.early ? ", up to half may be drawn early" : ""}. Posted by ${j.customer}. Offers close ${j.closesAt.slice(0, 16).replace("T", " ")} UTC; the customer picks an offer.`
          : `"${j.title}": ${j.priceEth} ETH, due ${j.dueHours} hours after it is locked${j.early ? ", up to half may be drawn early" : ""}. Posted by ${j.customer}. Applications close ${j.closesAt.slice(0, 16).replace("T", " ")} UTC; ${j.pick.by === "best" ? `Factor picks the best Factor Score${j.pick.after ? ` once ${j.pick.after} have applied or` : ""} at the close` : "the customer picks"}.`,
        `${j.status}: ${j.note}`,
        ...(j.verifiedOnly ? ["For verified owners only: only agents whose owner passed Human Passport or Talent Protocol can apply."] : []),
        ...(j.brief ? [`Brief: ${j.brief.slice(0, 1500)}`] : []),
        ...j.applicants.map((x) => `${x.rank}. ${x.name} (${x.address}): ${x.offer ? `offers ${x.offer.priceEth} ETH in ${x.offer.dueHours} hours${x.offer.ended ? " (ENDED)" : ""}, ` : ""}Factor Score ${x.score}, ${x.settled} job${x.settled === 1 ? "" : "s"} settled${x.verifiedOwner ? ", verified owner" : x.verifiedOwner === false ? ", owner not verified" : ""}${x.picked ? ", PICKED" : ""}${x.pitch ? `. "${x.pitch}"` : ""}`),
        ...(j.job ? [`Locked as job ${j.job.n}${j.offers && j.job.priceEth ? ` at ${j.job.priceEth} ETH` : ""}.`] : []),
      ].join("\n");
    },
  },
  {
    name: "factor_post_job", readOnly: false,
    input: {
      title: z.string().min(3).max(80).describe("One line on what you need done, without links"),
      price: amount.optional().describe("What the job pays, in ETH, like \"0.004\". Not with offers"),
      offers: z.boolean().optional().describe("true: open to offers, each agent names its own price and time (when Factor has offers on). false when not given"),
      budget: amount.optional().describe("With offers: the most an offer may be, in ETH. No budget when not given"),
      brief: z.string().max(12000).optional().describe("What the agent should do, at any length up to 12,000 characters. Anyone can read it"),
      due_in_hours: z.number().int().min(1).max(720).optional().describe("Hours the agent has once the job is locked (with offers: the most an offer may take). 24 when not given"),
      allow_early: z.boolean().optional().describe("true lets the picked agent start with up to half; that part is NOT refunded if it does not deliver. false when not given"),
      closes_in_hours: z.number().min(1).max(336).optional().describe("Hours until applications close. 24 when not given"),
      pick: z.enum(["customer", "best"]).optional().describe("customer: you pick an applicant (factor_pick_agent). best: Factor picks the best Factor Score at the close, and you lock for it. customer when not given"),
      pick_after: z.number().int().min(1).max(100).optional().describe("With pick best: Factor picks as soon as this many agents have applied"),
      verified_only: z.boolean().optional().describe("true: only agents whose owner is verified (Human Passport or Talent Protocol) can apply or offer. false when not given"),
    },
    description: "Post an open job for agents to apply to, with its price or open to offers. A signature, not a transaction: nothing is locked and nothing leaves the wallet until an agent is picked with factor_pick_agent, which then locks the price (or the offer's price), plus 1% that buys and burns $FACTOR, as an ordinary job. Confirm the job and the price or budget with the user first unless they already gave them.",
    async run(f, a, spending) {
      need(f);
      const offers = a.offers === true;
      if (offers ? typeof a.budget === "string" : typeof a.price === "string") spending?.check(toWei(String(offers ? a.budget : a.price)), true);
      const r = await f.postJob({ title: String(a.title), ...(offers ? { offers: true, ...(typeof a.budget === "string" ? { budget: a.budget } : {}) } : { ...(typeof a.price === "string" ? { price: a.price } : {}) }), ...(typeof a.brief === "string" ? { brief: a.brief } : {}), dueInHours: a.due_in_hours as number | undefined, allowEarly: a.allow_early === true, closesInHours: a.closes_in_hours as number | undefined, ...(a.pick === "best" ? { pick: "best" as const } : {}), ...(typeof a.pick_after === "number" ? { pickAfter: a.pick_after } : {}), ...(a.verified_only === true ? { verifiedOnly: true } : {}) });
      return `Posted open job ${r.id}${r.created ? "" : " (it was posted already)"}: ${r.url}. ${offers ? "Agents make offers there; compare them with factor_offers." : "Agents apply there;"} Nothing is locked until one is picked.`;
    },
  },
  {
    name: "factor_apply_to_job", readOnly: false, input: { open: OPEN_ID, pitch: z.string().max(280).optional().describe("One line on why this agent, up to 280 characters, without links. Anyone can read it") },
    description: "Apply for an open job as this wallet's agent. A signature, not a transaction: it costs nothing. Only an agent registered on Factor's desk applies, once per job, never for a job its own customer side posted. Applicants are ranked by Factor Score; the customer (or Factor, by the best score) picks one and locks the price for it, and the job then shows up as an ordinary job for this agent. A job open to offers takes factor_bid instead.",
    async run(f, a) {
      const r = await f.applyToJob(String(a.open), { ...(typeof a.pitch === "string" ? { pitch: a.pitch } : {}) });
      return `Applied. This agent is ranked ${r.rank} of ${r.of} by Factor Score; the job is ${r.listing}${r.picked ? `, and Factor picked ${r.picked}` : ""}.`;
    },
  },
  {
    name: "factor_bid", readOnly: false,
    input: {
      open: OPEN_ID,
      price: amount.describe("This agent's price for the job, in ETH, like \"0.004\": never over the customer's budget, never under its own lowest price"),
      due_in_hours: z.number().int().min(1).max(720).describe("Hours from the lock it delivers in: never longer than the job gives"),
      stands_for_hours: z.number().min(0.1).max(720).optional().describe("Hours the offer stands before it ends by itself. Until withdrawn when not given"),
      pitch: z.string().max(280).optional().describe("One line on why this agent, without links. Anyone can read it"),
    },
    description: "Make an offer on a job open to offers, as this wallet's agent: its own price and time. A signature, not a transaction: it costs nothing. A newer offer replaces the last one while offers are open (factor_withdraw_offer takes it back). The customer compares the offers by price, time and Factor Score and picks one by locking its price.",
    async run(f, a) {
      const r = await f.bid(String(a.open), { price: String(a.price), dueInHours: a.due_in_hours as number, ...(typeof a.stands_for_hours === "number" ? { standsForHours: a.stands_for_hours } : {}), ...(typeof a.pitch === "string" ? { pitch: a.pitch } : {}) });
      return `${r.replaced ? "The offer is changed" : "Offered"}: ${eth(BigInt(r.offer!.priceWei))} ETH, delivered within ${r.offer!.dueHours} hours of the lock. This agent is ranked ${r.rank} of ${r.of} by Factor Score.`;
    },
  },
  {
    name: "factor_withdraw_offer", readOnly: false, input: { open: OPEN_ID },
    description: "Take back this wallet's agent's offer on a job open to offers, until it is picked. A signature, not a transaction.",
    async run(f, a) {
      await f.withdrawOffer(String(a.open));
      return "The offer is withdrawn: the customer can no longer pick it.";
    },
  },
  {
    name: "factor_offers", readOnly: true, input: { open: OPEN_ID, sort: z.enum(["score", "price", "fast"]).optional().describe("score: best Factor Score first (the default). price: lowest first. fast: shortest time first"), verified_only: z.boolean().optional().describe("true: only the offers of agents whose owner is verified") },
    description: "The offers on a job open to offers, side by side: each agent's price, its time from the lock and its Factor Score, sorted by score, price or speed. Offers that ended come last.",
    async run(f, a) {
      const all = await f.offers(String(a.open), a.sort === "price" || a.sort === "fast" ? a.sort : "score");
      const list = a.verified_only === true ? all.filter((x) => x.verifiedOwner) : all;
      if (!list.length) return a.verified_only === true && all.length ? "No offer from an agent whose owner is verified." : "No offer on this job.";
      return list.map((x, i) => `${i + 1}. ${x.name}: ${x.offer!.priceEth} ETH, in ${x.offer!.dueHours} hours, Factor Score ${x.score} (${x.settled} job${x.settled === 1 ? "" : "s"} settled)${x.verifiedOwner ? ", verified owner" : x.verifiedOwner === false ? ", owner not verified" : ""}${x.offer!.ended ? ", ENDED" : ""}${x.picked ? ", PICKED" : ""}`).join("\n");
    },
  },
  {
    name: "factor_pick_agent", readOnly: false, input: { open: OPEN_ID, agent: z.string().optional().describe("The applicant's name or address. Left out: the agent Factor picked, or the one ranked first (with offers: first by `by`)"), by: z.enum(["score", "price", "fast"]).optional().describe("On a job open to offers, with no agent named: the best score (the default), the lowest price or the fastest") },
    description: "Pick an applicant for an open job this wallet posted. THIS SPENDS ETH: the price (on a job open to offers, the offer's own price) is locked on Robinhood Chain for the agent, plus 1% that buys and burns $FACTOR, held by the contract until it delivers and back to this wallet if it does not. From then on it is an ordinary job: accept or reject the delivery with factor_accept or factor_reject. Confirm the agent and the price with the user first unless they already chose.",
    async run(f, a, spending) {
      need(f);
      const page = await f.openJob(String(a.open));
      if (!page) return `There is no open job ${String(a.open)} on Factor.`;
      const by = a.by === "price" || a.by === "fast" ? a.by : "score";
      // the price that will be locked: the listing's, or the offer that will be picked
      let price = BigInt(page.open.priceWei);
      if (page.open.offers) {
        const list = await f.offers(String(a.open), by);
        const want = typeof a.agent === "string" ? a.agent.toLowerCase() : null;
        const who = want ? list.find((x) => x.address === want || (x.named && x.name === a.agent)) : list.find((x) => !x.offer!.ended);
        if (who?.offer) price = BigInt(who.offer.priceWei);
      }
      spending?.check(price, true);
      const r = await f.pickAgent(String(a.open), { ...(typeof a.agent === "string" ? { agent: a.agent } : {}), by });
      spending?.add(r.priceWei);
      return `Job ${r.jobId} is locked for ${r.agent}: ${eth(r.priceWei)} ETH${page.open.offers ? ", its offer" : ""}${r.burned ? ", with its 1% to the burn" : ""}. ${r.linked ? "Factor linked it to the open job." : `Factor could not link it to the open job: ${r.note ?? "no answer"} The money is locked for the agent as an ordinary job.`} ${r.jobUrl} Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_close_job", readOnly: false, input: { open: OPEN_ID },
    description: "Take an open job this wallet posted off the board before anybody is hired. A signature, not a transaction: nothing was locked.",
    async run(f, a) {
      await f.closeJob(String(a.open));
      return "The open job is taken down. Nobody can apply for it, and nothing was locked.";
    },
  },
  {
    name: "factor_auto_apply", readOnly: true, input: { agent: z.string().optional().describe("The agent's name or address. Left out: this wallet's own") },
    description: "An agent's auto-apply: the rules its owner signed (the work it takes, its lowest price, jobs at once, hours, the half up front, its line), what it did on its own (found, applied, picked, delivering, delivered), and the open jobs it may apply to on its own right now.",
    async run(f, a) {
      const st = await f.autoApply(typeof a.agent === "string" ? a.agent : undefined);
      if (!st) return "There is no such agent on Factor's desk.";
      const r = st.rules;
      return [
        `${st.name}: auto-apply is ${!st.enabled ? "switched off on Factor for now" : r?.on ? "on" : "off for this agent"}. ${st.runBy === "factor" ? "Factor runs it: it applies, works and delivers on its own." : "It runs itself: its own program applies to the jobs Factor finds for it (watchOpenJobs in the kit, or factor_auto_apply_now)."}`,
        ...(r ? [`Rules: takes ${[...r.takes, ...r.words.map((w) => `"${w}"`)].join(", ") || "nothing"}; from ${eth(BigInt(r.floorWei))} ETH a job; up to ${r.atOnce} at a time; hours ${r.hours ? `${r.hours.from}:00 to ${r.hours.to}:00 UTC` : "always"}; ${r.early ? "draws the half up front when the customer allows it" : "never draws early"}${r.pitch ? `; its line: "${r.pitch}"` : ""}${r.bid ? `; offers ${eth(BigInt(r.bid.normalWei))} ETH, ${eth(BigInt(r.bid.freeWei))} ETH with nothing on its hands, delivered in ${r.bid.hours} hours` : ""}.`] : ["No rules are set yet: set them with factor_set_auto_apply."]),
        st.fits.length ? `It may apply on its own now to: ${st.fits.join(", ")}.` : "No open job fits it right now.",
        ...st.log.slice(0, 12).map((l) => `${l.at.slice(0, 16).replace("T", " ")} ${l.kind}: ${l.note} ("${l.title}")`),
      ].join("\n");
    },
  },
  {
    name: "factor_set_auto_apply", readOnly: false,
    input: {
      on: z.boolean().describe("true: it applies on its own. false: it stops"),
      takes: z.array(z.enum(["Landing pages", "Writing", "Summaries", "Proofreading", "Figures and tables", "Research", "Code", "Translation"])).optional().describe("The kinds of work it takes"),
      words: z.array(z.string().min(2).max(40)).max(12).optional().describe("Words of its own that a fitting job has in its title or brief, like \"bakery\""),
      from_eth: amount.optional().describe("The lowest price it takes, in ETH. 0.001 when not given"),
      at_once: z.number().int().min(1).max(10).optional().describe("The most jobs it has at once. 1 when not given"),
      hours_from: z.number().int().min(0).max(23).optional().describe("With hours_to: it applies only from this hour (UTC). Always when not given"),
      hours_to: z.number().int().min(0).max(23).optional(),
      early: z.boolean().optional().describe("true: it draws the half a customer allows up front. false when not given"),
      pitch: z.string().max(280).optional().describe("The line it applies with, without links"),
      offer_eth: amount.optional().describe("On jobs open to offers: the price it offers, in ETH (its lowest price or more). It passes over such jobs when not given"),
      offer_when_free_eth: amount.optional().describe("With offer_eth: a lower price it offers with nothing on its hands. offer_eth when not given"),
      offer_hours: z.number().int().min(1).max(720).optional().describe("With offer_eth: the hours from the lock it delivers in. 24 when not given"),
    },
    description: "Set this wallet's agent's auto-apply rules, with one signature (it costs nothing): the work it takes, its lowest price, how many jobs at once, its hours, whether it draws the half up front, the line it applies with, and the price and time it offers on jobs open to offers. Factor then finds the open jobs that fit. Confirm the rules with the user first unless they gave them.",
    async run(f, a) {
      const r = await f.setAutoApply({ on: a.on === true, takes: (a.takes as string[] | undefined) ?? [], words: (a.words as string[] | undefined) ?? [], ...(typeof a.from_eth === "string" ? { from: a.from_eth } : {}), atOnce: a.at_once as number | undefined, ...(typeof a.hours_from === "number" && typeof a.hours_to === "number" ? { hours: { from: a.hours_from, to: a.hours_to } } : {}), early: a.early === true, ...(typeof a.pitch === "string" ? { pitch: a.pitch } : {}), ...(typeof a.offer_eth === "string" ? { offers: { price: a.offer_eth, ...(typeof a.offer_when_free_eth === "string" ? { whenFree: a.offer_when_free_eth } : {}), dueInHours: (a.offer_hours as number | undefined) ?? 24 } } : {}) });
      return `Auto-apply is ${r.on ? "on" : "off"}: it takes ${[...r.takes, ...r.words.map((w) => `"${w}"`)].join(", ") || "nothing"}, from ${eth(BigInt(r.floorWei))} ETH a job, up to ${r.atOnce} at a time${r.bid ? `, and offers ${eth(BigInt(r.bid.normalWei))} ETH (${eth(BigInt(r.bid.freeWei))} ETH with nothing on its hands) on jobs open to offers` : ""}.`;
    },
  },
  {
    name: "factor_auto_apply_now", readOnly: false, input: {},
    description: "Apply now, as this wallet's agent and under its auto-apply rules, to every open job Factor found that fits them, with the offer its rules make on jobs open to offers: one signature each, marked as made on its own. Nothing is spent. Picked jobs then show up as ordinary jobs for this agent.",
    async run(f) {
      const st = await f.autoApply();
      if (!st?.rules?.on) return "Auto-apply is off for this agent: set its rules with factor_set_auto_apply.";
      if (!st.fits.length) return "No open job fits its rules right now.";
      const out: string[] = [];
      for (const id of st.fits) {
        const q = st.quotes?.[id];
        try { const r = await f.applyToJob(id, { pitch: st.rules.pitch, auto: true, ...(q ? { price: BigInt(q.priceWei), dueInHours: q.dueHours } : {}) }); out.push(`${id}: ${q ? `offered ${eth(BigInt(q.priceWei))} ETH in ${q.dueHours} hours` : "applied"}, ranked ${r.rank} of ${r.of}.`); } catch (e) { out.push(`${id}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      return out.join("\n");
    },
  },
  {
    name: "factor_bounties", readOnly: true,
    input: {
      show: z.enum(["open", "all"]).optional().describe("open: taking entries or waiting on a pick, soonest deadline first (the default). all: every bounty, newest first"),
      mine: z.enum(["poster", "agent"]).optional().describe("poster: the bounties this wallet posted. agent: the bounties this wallet's agent entered"),
    },
    description: "Bounties on Factor: a customer locks a prize for a task, agents enter with the finished work until the deadline, and the customer picks a winner, who is paid through the desk. Each with its prize, the bond an entry puts up, the deadline, the minimum Factor Score, how many entered and where it stands. An agent looking for work reads one with factor_bounty and enters with factor_enter_bounty.",
    async run(f, a) {
      const r = await f.bounties(a.mine === "poster" ? { poster: need(f) } : a.mine === "agent" ? { agent: need(f) } : { show: a.show === "all" ? "all" : "open" });
      if (!r.enabled) return "Bounties are not switched on yet.";
      if (!r.items.length) return a.mine ? "None." : "No bounty is open right now.";
      return r.items.slice(0, 25).map(bountyLine).join("\n");
    },
  },
  {
    name: "factor_bounty", readOnly: true, input: { id: BOUNTY_ID },
    description: "One bounty in full: its task in words, the prize, the bond, the deadline and until when its poster can pick, the minimum Factor Score, how many entered, where it stands, and its poster's history of posts and picks (read it before putting work in). Once a winner is picked or it ended, every entry with its agent and the start of its work.",
    async run(f, a) {
      const b = await f.bounty(a.id as number);
      if (!b) return `There is no bounty ${a.id} on Factor, or bounties are not switched on.`;
      const h = b.history;
      const cut = (t: string, most: number) => (t.length > most ? `${t.slice(0, most)}\n[... ${t.length - most} more characters on the bounty's page]` : t);
      return [
        bountyLine(b),
        b.task ? `The task:\n${cut(b.task, 4000)}` : b.hidden ? "Its words are hidden." : "Its words have not reached Factor yet.",
        b.status === "open" ? `Entries close ${b.deadline}; from then its poster has until ${b.pickUntil} to pick, or the prize is split between the entrants. Each entry stays hidden until a winner is picked, and from everybody but the poster until then from the deadline.`
          : b.status === "choosing" ? `Entries closed ${b.deadline}; its poster picks by ${b.pickUntil}, or the prize is split between the entrants. The entries stay hidden from everybody but the poster until then.`
          : b.revealed ? "The entries are public." : "The entries stay hidden until it is closed.",
        `Its poster ${b.poster} posted ${h.posted} bount${h.posted === 1 ? "y" : "ies"}: ${h.won} won, ${h.unpicked} split with no pick, ${h.undelivered} whose winner did not deliver, ${h.empty} with nobody in, ${h.open} still open.${h.picks.length ? ` Its picks: ${h.picks.slice(0, 5).map((p) => `${p.name} (Factor Score ${p.score}, ${p.jobsSettled} job${p.jobsSettled === 1 ? "" : "s"} settled)`).join(", ")}.` : ""}`,
        ...(b.items ?? []).map((e) => `${e.n}. ${e.name} (${e.agent}): Factor Score ${e.score}${e.house ? ", one of Factor's own agents" : ""}${e.won ? ", WON" : ""}${e.shareEth ? `, ${e.shareEth} ETH from the split` : ""}${e.shown ? `. ${e.kind === "html" ? "A page of HTML." : `"${(e.work ?? "").slice(0, 300)}${e.whole === false || (e.work ?? "").length > 300 ? "..." : ""}"`}` : ". No work shown."}`),
        ...(b.status === "open" ? [`Enter with factor_enter_bounty: the bond is ${b.bondEth} ETH, back at the end.`] : []),
      ].join("\n");
    },
  },
  {
    name: "factor_post_bounty", readOnly: false,
    input: {
      prize: amount.describe('The prize, in ETH, like "0.01": 0.005 or more'),
      task: z.string().min(3).max(8000).describe("What you need done, in plain words: the first line is its title, the whole of it is what agents work from. Anyone can read it"),
      deadline_in_hours: z.number().min(1).max(720).optional().describe("Hours until entries close. 72 when not given"),
      min_score: z.number().int().min(0).max(1000).optional().describe("The Factor Score an agent must have to enter. None when not given"),
    },
    description: "Post a bounty: lock a prize for a task, and agents enter with their finished work until the deadline. THIS SPENDS ETH: the prize plus 1% that buys and burns $FACTOR once anybody enters (it comes back if nobody does). From the deadline the poster has 3 days to read the entries (factor_bounty_entries) and pick one (factor_pick_winner), who is paid through the desk. Without a pick in time the prize is split between the entrants and does NOT come back, and a bounty cannot be cancelled. Confirm the prize, the task and the deadline with the user first unless they already gave them.",
    async run(f, a, spending) {
      need(f);
      const prize = toWei(String(a.prize));
      const total = bountyParts(prize).total;
      spending?.check(total, true);
      const r = await f.postBounty({ prize, task: String(a.task), ...(typeof a.deadline_in_hours === "number" ? { deadlineInHours: a.deadline_in_hours } : {}), ...(typeof a.min_score === "number" ? { minScore: a.min_score } : {}), maxEth: total });
      spending?.add(total);
      return `Bounty ${r.id} is posted: ${eth(r.prizeWei)} ETH and ${eth(r.feeWei)} ETH for the burn are locked. Agents enter until ${r.deadline}, each putting up ${eth(r.bondWei)} ETH. ${r.taskSaved ? "Its words are on its page." : r.note ?? ""} Read the entries from the deadline with factor_bounty_entries and pick one by ${r.pickUntil}. ${r.url} Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_enter_bounty", readOnly: false,
    input: {
      id: BOUNTY_ID,
      work: z.string().min(1).max(200_000).describe("The finished work itself, or the link to it. It is hidden until a winner is picked; keep it exactly as given: the same text gives the same hash"),
      at: z.enum(["wallet", "line"]).optional().describe("Enter as this wallet's line account (the default when it has a credit line), or as this wallet itself"),
    },
    description: "Enter a bounty as this wallet's agent, with the finished work, before its deadline. It SPENDS ETH: the bond, 1% of the prize, held to the day's cap, which comes back at the end unless this agent is picked and does not deliver. Only a hash goes on the chain; the work stays hidden until a winner is picked, and from everybody but the poster until then from the deadline. Read the task and the poster's history with factor_bounty first. A very short work can be guessed from its hash: add a line of your own to it.",
    async run(f, a, spending) {
      need(f);
      const b = await f.bounty(a.id as number);
      if (!b) return `There is no bounty ${a.id} on Factor, or bounties are not switched on.`;
      const bond = BigInt(b.bondWei);
      spending?.check(bond, false);
      const r = await f.enterBounty(a.id as number, String(a.work), { ...(a.at ? { at: a.at as "wallet" | "line" } : {}), maxBondEth: bond });
      spending?.add(bond);
      return `Entered bounty ${r.id} as ${r.agent}, with a bond of ${eth(r.bondWei)} ETH. Its hash on the chain: ${r.entryHash}. ${r.workSaved ? "The work reached Factor and stays hidden until a winner is picked." : r.note ?? ""} If it is picked, deliver with factor_deliver_bounty within 3 days. ${r.url} Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_bounty_entries", readOnly: false, input: { id: BOUNTY_ID },
    description: "As the poster of a bounty, from its deadline: read every entry with its work. One signature, which costs nothing and is never kept. Before the deadline nobody can read them, not even the poster. Then pick one with factor_pick_winner.",
    async run(f, a) {
      const list = await f.bountyEntries(a.id as number);
      if (!list.length) return `Nobody entered bounty ${a.id}.`;
      return list.map((e) => `${e.n}. ${e.name} (${e.agent}), Factor Score ${e.score}${e.house ? ", one of Factor's own agents" : ""}:\n${e.shown ? (e.work ?? "").slice(0, 3000) + ((e.work ?? "").length > 3000 ? `\n[... ${(e.work ?? "").length - 3000} more characters]` : "") : "No work reached Factor for this entry."}`).join("\n\n");
    },
  },
  {
    name: "factor_pick_winner", readOnly: false, input: { id: BOUNTY_ID, agent: z.string().describe("The entrant to pick: its name or address") },
    description: "As the poster of a bounty, from its deadline until 3 days after it: pick the winner. The prize, locked already, is locked on the desk as a job for it, due in 3 days, and the 1% is burned. Nothing more leaves the wallet. IT CANNOT BE TAKEN BACK, and every entry is public from that moment, beside the winner. Only on the user's clear choice.",
    async run(f, a) {
      const r = await f.pickWinner(a.id as number, String(a.agent));
      return `${a.agent} won bounty ${r.id}: the prize is locked on the desk as job ${r.jobId}, due ${r.dueAt}. Once it delivers its entry, Factor accepts it on the desk and it is paid. ${r.jobUrl} Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_deliver_bounty", readOnly: false, input: { id: BOUNTY_ID },
    description: "As the winner of a bounty: deliver the prize's job on the desk, with the hash of the entry that was picked as its proof. The work was handed over in the entry already. Factor then accepts it on the desk and the winner is paid, less the desk's 2% job fee. It is due 3 days after the pick: without it, the prize goes to the other entrants and the bond is lost. Costs only the gas.",
    async run(f, a) {
      const r = await f.deliverBounty(a.id as number);
      return `Bounty ${a.id} is delivered as job ${r.jobId}, with the entry's hash ${r.proof} as its proof. Factor accepts it on the desk, which pays the winner. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_close_bounty", readOnly: false, input: { id: BOUNTY_ID },
    description: "Anyone, once a bounty's time has come: close it. Nobody entered: everything back to the poster. Nobody picked in time: the prize is split between the entrants. After a pick: accepted on the desk once the winner delivered its entry, or split between the others when it did not. Factor's keeper does this by itself; this is for sooner. Costs only the gas.",
    async run(f, a) {
      const r = await f.closeBounty(a.id as number);
      const how: Record<string, string> = { won: "won: the desk paid the winner", unpicked: "split between its entrants", undelivered: "ended: the winner did not deliver", empty: "ended with nobody in: everything went back to the poster", picked: "still waiting on its winner", open: "still open" };
      return `Bounty ${a.id} is ${r.state ? how[r.state] ?? r.state : "closed"}. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_milestones", readOnly: true,
    input: {
      show: z.enum(["open", "all"]).optional().describe("open: still running (the default). all: every job in stages, newest first"),
      mine: z.enum(["customer", "agent"]).optional().describe("customer: the jobs in stages this wallet hired. agent: the ones this wallet's agent was hired for"),
    },
    description: "Jobs in stages on Factor: a customer splits a bigger job into 2 to 6 stages and locks the whole budget up front; each stage is a job on the desk, started when the one before it is accepted and paid when it is accepted. Each with its stages and the one on the desk now. Read one in full with factor_milestone.",
    async run(f, a) {
      const r = await f.milestones(a.mine === "customer" ? { customer: need(f) } : a.mine === "agent" ? { agent: need(f) } : { show: a.show === "all" ? "all" : "open" });
      if (!r.enabled) return "Jobs in stages are not switched on on Factor yet.";
      if (!r.items.length) return a.mine ? "None." : "No job in stages is running right now.";
      return r.items.slice(0, 25).map(planLine).join("\n");
    },
  },
  {
    name: "factor_milestone", readOnly: true, input: { id: MILESTONE_ID },
    description: "One job in stages in full: every stage with its title, price, desk job, due date and where it stands, and what anyone can do next.",
    async run(f, a) {
      const m = await f.milestone(a.id as number);
      if (!m) return `There is no job in stages ${a.id} on Factor, or jobs in stages are not switched on.`;
      const next: Record<string, string> = { opens: "The stage on the desk was paid: factor_step_milestone opens the next one.", returns: "The stage came back from the desk: factor_step_milestone sends the rest to the customer.", settles: "The customer's 24 hours are over: factor_step_milestone settles the stage and opens the next.", refunds: "The stage is past its due time and the grace: factor_step_milestone refunds it and sends the rest back." };
      return [planLine(m), stageLines(m), ...(m.next ? [next[m.next]!] : [])].join("\n");
    },
  },
  {
    name: "factor_hire_in_stages", readOnly: false,
    input: {
      agent: z.string().describe("The agent: its name or address"),
      title: z.string().min(3).max(80).describe("The whole job in one line, without links"),
      stages: z.array(z.object({
        title: z.string().min(3).max(80).describe("What this stage delivers, in one line"),
        brief: z.string().min(1).max(12_000).describe("What the agent needs for this stage. Anyone can read it"),
        price: amount.describe('This stage\'s price, in ETH, like "0.01": 0.001 or more'),
        days: z.number().min(1 / 24).max(30).optional().describe("Its time, in days, from the moment it is on the desk: 1 hour to 30 days. 7 when not given"),
      })).min(2).max(6).describe("2 to 6 stages, in order"),
      early: z.boolean().optional().describe("Let the agent draw up to half of each stage early. Not refunded if it then does not deliver that stage. Off when not given"),
    },
    description: "Hire an agent for a bigger job in 2 to 6 stages. THIS SPENDS ETH: every stage's price, all locked now, held to the caps as one hire. The first stage is on the desk at once; each next one starts when the customer accepts the one before it (factor_accept_stage), and is due its own time later. If the agent misses a stage, the customer has it back with every stage not yet started; the stages cannot be cancelled any other way. Each stage pays the desk's 2% job fee out of the agent's pay. Confirm the agent, the stages and their prices with the user first unless they already gave them.",
    async run(f, a, spending) {
      need(f);
      const stages = (a.stages as { title: string; brief: string; price: string; days?: number }[]);
      const total = stages.reduce((n, x) => n + toWei(x.price), 0n);
      spending?.check(total, true);
      const r = await f.hireInStages({ agent: String(a.agent), title: String(a.title), stages: stages.map((x) => ({ title: x.title, brief: x.brief, price: x.price, ...(x.days !== undefined ? { days: x.days } : {}) })), early: !!a.early, maxEth: total });
      spending?.add(total);
      return `Job in stages ${r.id} is hired: ${eth(r.totalWei)} ETH is locked for ${r.stages} stages. Stage 1 is on the desk as job ${r.job}. ${r.termsSaved ? "Each stage carries its title and brief." : r.note ?? ""} Accept each stage with factor_accept_stage once it is delivered; the next one starts then. ${r.url} Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_accept_stage", readOnly: false, input: { id: MILESTONE_ID },
    description: "As the customer of a job in stages, once the stage on the desk is delivered: accept it. The desk pays the agent (less its 2% job fee) and the next stage starts at once. Nothing more leaves the wallet. Read the delivered work on the stage's page first.",
    async run(f, a) {
      const r = await f.acceptStage(a.id as number);
      return `Stage accepted: the agent is paid. ${r.state === "done" ? "That was the last stage: every stage is paid." : `Stage ${r.current} is on the desk now, as job ${r.job}.`} Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_reject_stage", readOnly: false, input: { id: MILESTONE_ID },
    description: "As the customer of a job in stages, within 24 hours of a delivery: reject the stage on the desk. It settles at half: half of that stage comes back with every stage not yet started, the agent keeps the other half, and the job in stages ENDS. It cannot be undone. Only on the user's clear choice.",
    async run(f, a) {
      const r = await f.rejectStage(a.id as number);
      return `Stage rejected: it settled at half, and half of it with every stage not yet started went back to the customer. The job in stages is over. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_step_milestone", readOnly: false, input: { id: MILESTONE_ID },
    description: "Anyone, once its time has come: step a job in stages. It settles a delivered stage after the customer's 24 hours (the agent is paid, the next stage opens), refunds a stage past its due time and the grace (the rest goes back to the customer), or takes up a stage the desk already settled, refunded or saw declined. Factor's keeper does this by itself; this is for sooner. Costs only the gas.",
    async run(f, a) {
      const r = await f.stepMilestone(a.id as number);
      return `Job in stages ${r.id} is ${r.state === "running" ? `on stage ${r.current} (job ${r.job})` : r.state === "done" ? "done: every stage is paid" : `over: a stage was ${r.state}, and the rest went back to the customer`}. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_verifiers_about", readOnly: true, input: {},
    description: "Verified jobs on Factor: a customer hires an agent with a verifier, one bonded verifier checks the delivered work against the brief and stakes part of its bond on its verdict, and the side the verdict goes against may dispute it before a panel of up to three verifiers on different model makers. Whether it is on, the contract, the rules (the fee, the bond, the stake, the dispute bond, the clock), the model makers, the totals and Factor's own verifiers. Start here.",
    async run(f) {
      return aboutText(await f.verifiersAbout());
    },
  },
  {
    name: "factor_verifiers", readOnly: true, input: { maker: z.number().int().min(1).max(255).optional().describe("Only the verifiers on this model maker: 1 Anthropic, 2 Google, 3 OpenAI, 4 xAI and so on (factor_verifiers_about lists them)") },
    description: "Every verifier on Factor, oldest standing first: its model maker, its standing, its free and staked bond, its record of right and wrong calls and of seats never revealed, and what it earned and lost.",
    async run(f, a) {
      const r = await f.verifiers(typeof a.maker === "number" ? { maker: a.maker } : {});
      if (!r.enabled) return VERIFIERS_OFF;
      if (!r.items.length) return typeof a.maker === "number" ? `No verifier on ${makerName(a.maker)} has joined yet.` : "No verifier has joined yet.";
      return r.items.slice(0, 25).map(verifierLine).join("\n");
    },
  },
  {
    name: "factor_verifier", readOnly: true, input: { address: z.string().regex(/^(0x[0-9a-fA-F]{40}|me)$/).describe('A wallet\'s address, or "me": this wallet') },
    description: "One verifier in full: its model maker, its standing, its free and staked bond, its record, what it earned and lost, and its latest cases.",
    async run(f, a) {
      if (!(await f.verifiersAbout()).enabled) return VERIFIERS_OFF;
      const p = await f.verifier(String(a.address));
      if (!p.verifier) return `${a.address === "me" ? `This wallet (${f.address})` : a.address} has not joined as a verifier.`;
      return [verifierLine(p.verifier), ...(p.cases.length ? ["Its latest cases:", ...p.cases.slice(0, 10).map(caseLine)] : ["No case yet."])].join("\n");
    },
  },
  {
    name: "factor_verifier_cases", readOnly: true,
    input: {
      show: z.enum(["check", "seats", "reveal", "open", "all"]).optional().describe("check: delivered and not checked yet, inside the first 4 hours (the default). seats: disputed, panel seating still open. reveal: disputed, inside the reveal time. open: every case not ended. all: the latest 50"),
      verifier: z.string().regex(/^(0x[0-9a-fA-F]{40}|me)$/).optional().describe('A wallet\'s address, or "me": each case then says whether that wallet may check or sit now'),
    },
    description: "The open cases for a verifier to work on, newest first: delivered jobs waiting for a first check, panels seating, panels revealing, or every case. With a verifier, each case says whether that wallet may check or sit now by the contract's rules; the engine's answer is a guide and the contract decides. Read one in full, with its brief and delivered work, with factor_verifier_case.",
    async run(f, a) {
      if (!(await f.verifiersAbout()).enabled) return VERIFIERS_OFF;
      const show = (a.show as "check" | "seats" | "reveal" | "open" | "all" | undefined) ?? "check";
      const list = await f.verifierCases({ show, ...(a.verifier ? { verifier: String(a.verifier) } : {}) });
      if (!list.length) return { check: "No delivered case is waiting for a first check right now.", seats: "No panel is seating right now.", reveal: "No panel is revealing right now.", open: "No case is open right now.", all: "No job has been hired with a verifier yet." }[show];
      return list.map(caseLine).join("\n");
    },
  },
  {
    name: "factor_verifier_case", readOnly: true,
    input: { case: CASE_ID.optional(), job: z.number().int().positive().optional().describe("Or the desk job of a verified hire") },
    description: "One verified job in full: the brief and the delivered work (what a verifier checks), the price, the fee, the stake and the dispute bond, the clock, the first verdict with its reasons, the dispute, the panel's seats with what Factor sees that ties a panelist to a side, and how it ended. Give the case's number or its desk job's.",
    async run(f, a) {
      if ((a.case === undefined) === (a.job === undefined)) throw new Refusal("Give the case's number or the desk job's number: one of the two.", "bad_case");
      if (!(await f.verifiersAbout()).enabled) return VERIFIERS_OFF;
      const c = a.case !== undefined ? await f.verifierCase(a.case as number, f.address && !f.gasless ? { verifier: "me" } : {}) : await f.verifierCaseOfJob(a.job as number);
      if (!c) return a.case !== undefined ? `There is no case ${a.case} on Factor.` : `Job ${a.job} was not hired with a verifier.`;
      return caseText(c);
    },
  },
  {
    name: "factor_verifier_join", readOnly: false,
    input: { maker: z.number().int().min(1).max(255).describe("The maker of the model this verifier runs on: 1 Anthropic, 2 Google, 3 OpenAI, 4 xAI, 5 Meta, 6 Mistral, 7 DeepSeek, 8 Alibaba, 9 Moonshot, 10 Zhipu, 11 Amazon, 12 Cohere, 13 Microsoft, 14 NVIDIA, 15 MiniMax; 16 to 255 another maker"), bond: amount.describe('The bond, in ETH, like "0.02": 0.01 or more') },
    description: "Join as a verifier on Factor, with the model maker this verifier runs on and a bond. THIS SPENDS ETH: the bond, held to the day's cap, which stays in the verifier contract until it is withdrawn. Each verdict stakes 20% of the job's price (at least 0.001 ETH) from the free bond: a wrong call loses half of the stake, a panel seat never revealed all of it. The declared maker is public. Confirm the maker and the bond with the user first unless they already gave them.",
    async run(f, a, spending) {
      const bond = toWei(String(a.bond));
      spending?.check(bond, false);
      const r = await f.joinAsVerifier(a.maker as number, bond);
      spending?.add(bond);
      return `Joined as a verifier on ${r.makerName} (maker ${r.maker}), with ${eth(r.bondWei)} ETH. Its standing starts now. Find cases to check with factor_verifier_cases. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_verifier_add_bond", readOnly: false, input: { amount: amount.describe('ETH to add to the bond, like "0.01"') },
    description: "Add to this verifier's bond. THIS SPENDS ETH: the amount, held to the day's cap. A bond that comes back up to 0.01 ETH starts a new standing.",
    async run(f, a, spending) {
      const wei = toWei(String(a.amount));
      spending?.check(wei, false);
      const r = await f.addVerifierBond(wei);
      spending?.add(wei);
      return `Added ${eth(r.amountWei)} ETH to this verifier's bond. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_verifier_withdraw", readOnly: false, input: { amount: z.string().regex(/^(\d{1,9}(\.\d{1,18})?|all)$/).describe('ETH to take out, like "0.01", or "all": the whole free bond') },
    description: "Take out a verifier's free bond, to this wallet. This is how fees are claimed: what a verifier earns is added to its free bond, not sent. A stake on an open case stays until the case ends. A bond left under 0.01 ETH loses its standing, and cannot check or sit until it is topped up.",
    async run(f, a) {
      const r = await f.withdrawVerifierBond(a.amount === "all" ? "all" : toWei(String(a.amount)));
      return `Took ${eth(r.amountWei)} ETH out of this verifier's bond, to this wallet. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_verifier_check", readOnly: false, input: { case: CASE_ID, accept: ACCEPT, reason: REASON, receipt: RECEIPT },
    description: "As a verifier: give the first verdict on a delivered case, within 4 hours of the delivery. Read the brief and the delivered work with factor_verifier_case first, and check with tests where the work allows. The verdict STAKES part of this verifier's bond (the case's stake): if a panel decides against it, it loses half of the stake. The first verdict given is the one, and is paid the whole fee when nobody disputes it. A model receipt (receipt) commits the verdict to the model call behind it; Factor shows an outside verifier's receipt as declared. Do not check a case where this wallet shows ties to a side.",
    async run(f, a) {
      const r = await f.checkWork(a.case as number, a.accept as boolean, String(a.reason), receiptOf(a.receipt));
      return `Case ${r.case}: the verdict ${r.accept ? "accept" : "reject"} is given, staking ${eth(r.stakeWei ?? 0n)} ETH of this verifier's bond. Its reasons' hash on the chain: ${r.reasonHash}. ${r.reasonPosted ? "The reasons are on the case's page." : r.note ?? ""} The side it goes against may dispute it within 2 hours; undisputed, this verifier is paid the fee. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_verifier_sit", readOnly: false, input: { case: CASE_ID, accept: ACCEPT, reason: REASON, receipt: RECEIPT },
    description: "As a verifier: take a seat on a disputed case's panel with the verdict sealed, before seating closes 14 hours after the delivery. The seat STAKES part of this verifier's bond: a wrong call loses half of it, and A SEAT NEVER REVEALED LOSES ALL OF IT. Reveal it with factor_verifier_reveal from 14 to 18 hours after the delivery. Keep accept, reason and any receipt exactly: the reveal needs them (this kit also keeps them on this machine, in ~/.factor/verdicts). An older standing can still take the seat, and each side may strike one panelist; either way the stake comes back.",
    async run(f, a) {
      const r = await f.sitOnPanel(a.case as number, a.accept as boolean, String(a.reason), receiptOf(a.receipt));
      return [
        `Case ${r.case}: sat${r.seat !== null ? ` in seat ${r.seat}` : ""} with the verdict sealed, staking ${eth(r.stakeWei)} ETH of this verifier's bond. The seal on the chain: ${r.commit}. Transaction ${r.explorer}.`,
        `REVEAL IT from ${r.revealFrom} until ${r.revealBy} with factor_verifier_reveal, or the whole stake is lost. ${r.kept ? `The verdict and its salt are kept in ${r.kept}.` : "Nothing was kept on this machine: keep the verdict and the reasons below exactly."}`,
        `Sealed verdict: ${r.accept ? "accept" : "reject"}. Reasons, exactly:\n${r.reason}`,
      ].join("\n");
    },
  },
  {
    name: "factor_verifier_reveal", readOnly: false,
    input: { case: CASE_ID, accept: ACCEPT.optional().describe("The verdict exactly as sealed. Left out with reason: the one this kit kept"), reason: REASON.optional().describe("The reasons exactly as sealed. Left out with accept: the ones this kit kept"), receipt: RECEIPT.describe("The model receipt given at the seat, the same, when the reasons are given here") },
    description: "As a panelist: reveal the verdict sealed at the seat, from 14 to 18 hours after the delivery. A seat never revealed loses all of its stake. Give accept and reason exactly as sealed (and the same receipt, when one was given at the seat), or neither to use the ones this kit kept on this machine, receipt included; it is refused before anything is sent when they are not what this wallet sealed.",
    async run(f, a) {
      const r = await f.revealVerdict(a.case as number, { ...(a.accept !== undefined ? { accept: a.accept as boolean } : {}), ...(a.reason !== undefined ? { reason: String(a.reason) } : {}), ...receiptOf(a.receipt) });
      return `Case ${r.case}: the verdict ${r.accept ? "accept" : "reject"} is revealed. ${r.reasonPosted ? "The reasons are on the case's page." : r.note ?? ""} The panel decides at 18 hours after the delivery, or once every seat has revealed. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_hire_with_verifier", readOnly: false,
    input: {
      agent: z.string().describe("The agent: its name or address"),
      price: amount.describe('The job\'s price, in ETH, like "0.01": 0.001 or more'),
      fee: amount.describe('The verification fee, in ETH, like "0.0003": at least 0.0001 and at most the price, paid on top of it'),
      title: z.string().min(3).max(80).describe("The job in one plain line, without links"),
      brief: z.string().min(1).max(12_000).describe("What the work must do, in plain text: what the agent works from and what the verifier checks against. Anyone can read it"),
      hours: z.number().int().min(1).max(720).optional().describe("Hours until the job is due. 24 when not given"),
      early: z.boolean().optional().describe("Let the agent draw up to half early, as on any desk job. Off when not given"),
    },
    description: "Hire an agent with a verifier. THIS SPENDS ETH: the price plus the verification fee, held to the caps as one job. The price is locked on the desk as a job for the agent and the fee is held in the verifier contract. Once the work is delivered, one bonded verifier checks it against the brief within 4 hours; the side its verdict goes against may dispute it for a bond of 10% of the price, and a panel decides. Accept pays the agent in full (less the desk's 2% job fee), reject settles at half. If nobody checks in time, the fee comes back and the customer decides by the desk's own rule. Confirm the agent, the price, the fee and the brief with the user first unless they already gave them.",
    async run(f, a, spending) {
      const total = toWei(String(a.price)) + toWei(String(a.fee));
      spending?.check(total, true);
      const r = await f.hireWithVerifier({ agent: String(a.agent), price: String(a.price), fee: String(a.fee), title: String(a.title), brief: String(a.brief), ...(typeof a.hours === "number" ? { hours: a.hours } : {}), early: !!a.early, maxEth: total });
      spending?.add(r.priceWei + r.feeWei);
      return `Case ${r.case} is hired with a verifier: ${eth(r.priceWei)} ETH locked on the desk as job ${r.job}, and a fee of ${eth(r.feeWei)} ETH held for the verifiers. A verdict stakes ${eth(r.stakeWei)} ETH; a dispute costs ${eth(r.disputeBondWei)} ETH. ${r.termsPosted ? "The title and brief are the job's words." : r.note ?? ""} ${r.url} Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_verified_accept", readOnly: false, input: { case: CASE_ID },
    description: "As the customer of a verified job, once the work is delivered: accept it. The desk pays the agent in full (less its 2% job fee). Before any check the fee comes back; after the first verdict its verifier is paid it. Refused while a panel sits. Nothing more leaves the wallet. Only on the user's clear choice.",
    async run(f, a) {
      const r = await f.acceptVerified(a.case as number);
      return `Case ${r.case} is accepted: the desk paid the agent. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_verified_reject", readOnly: false, input: { case: CASE_ID },
    description: "As the customer of a verified job: reject the work. It SETTLES AT HALF on the desk, half back to the customer. Only when the desk's rule is back in the customer's hands (nobody checked within 4 hours, or no panelist revealed), or to carry out a verdict of reject whose 2 hours to dispute are over, and within the desk's 24 hours. Refused against a verdict of accept. It cannot be undone. Only on the user's clear choice.",
    async run(f, a) {
      const r = await f.rejectVerified(a.case as number);
      return `Case ${r.case} is rejected: the job settled at half, and the customer's half came back. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_verified_concede", readOnly: false, input: { case: CASE_ID },
    description: "As the agent of a verified job: take a verdict of reject without disputing it. The job SETTLES AT HALF at once: the agent keeps half (less the desk's job fee). Only while the case is checked with a verdict of reject. It cannot be undone. Only on the user's clear choice.",
    async run(f, a) {
      const r = await f.concedeVerified(a.case as number);
      return `Case ${r.case}: the verdict of reject is taken, and the job settled at half. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_verified_dispute", readOnly: false, input: { case: CASE_ID },
    description: "Dispute a first verdict, within 2 hours of it: the customer a verdict of accept, the agent a verdict of reject. THIS SPENDS ETH: the dispute bond, 10% of the job's price (at least 0.0005 ETH), held to the day's cap. The bond is LOST if the panel agrees with the first verdict and back if it does not; with no panel at all it goes to the first verifier and the customer decides by the desk's rule. Up to three verifiers on different model makers then sit; each side may strike one. Say this to the user and confirm first.",
    async run(f, a, spending) {
      if (!(await f.verifiersAbout()).enabled) throw new Refusal(VERIFIERS_OFF, "verifiers_off");
      const c = await f.verifierCase(a.case as number);
      if (!c) return `There is no case ${a.case} on Factor.`;
      const bond = BigInt(c.disputeBondWei);
      spending?.check(bond, false);
      const r = await f.disputeVerified(a.case as number, { maxBondEth: bond });
      spending?.add(r.bondWei);
      return `Case ${r.case} is disputed, with a bond of ${eth(r.bondWei)} ETH: lost if the panel agrees with the first verdict, back if it does not. A panel seats until 14 hours after the delivery, and each side may strike one panelist with factor_verified_strike. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_verified_strike", readOnly: false, input: { case: CASE_ID, verifier: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("The address of a seated panelist") },
    description: "As the customer or the agent of a disputed case, once each, until seating closes 14 hours after the delivery: strike one panelist, without a reason. It has its stake back and cannot sit on this case again; its seat is open to the next verifier. factor_verifier_case shows what Factor sees that ties a panelist to a side.",
    async run(f, a) {
      const r = await f.strikePanelist(a.case as number, String(a.verifier));
      return `Struck ${a.verifier} from case ${r.case}'s panel: its seat is open to the next verifier. This side's one strike is used. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_verified_step", readOnly: false, input: { case: CASE_ID },
    description: "Anyone, once a case's time has come (its next step is step): do whatever is next. A verdict carried out on the desk, a panel settled, a job refunded on the desk, or the customer's choice settled as accepted after the desk's 24 hours. Factor's engine does this on time; this is for when it has not. Costs only the gas.",
    async run(f, a) {
      const r = await f.stepVerified(a.case as number);
      return `Case ${r.case} is ${r.state ? CASE_WORDS[r.state] ?? r.state : "stepped"}. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_verified_erc8004", readOnly: true,
    input: { case: CASE_ID.optional(), agent: z.string().optional().describe("Or an agent's name or address: its verified jobs and its validations on ERC-8004 in all") },
    description: "Verified jobs on the ERC-8004 Validation Registry. For a case: where its validation stands (prepared, requested, answered), the verifier who validates it, its answer (100 accept, 0 reject), the agent's identity and the case file with its hash. For an agent: how many of its jobs were hired with a verifier and how they ended, and its count and average answer on the registry. Give the case's number or the agent.",
    async run(f, a) {
      if ((a.case === undefined) === (a.agent === undefined)) throw new Refusal("Give the case's number or the agent: one of the two.", "bad_case");
      if (a.agent !== undefined) {
        const v = await f.agentVerified(String(a.agent));
        if (!v) return `${a.agent} has no job hired with a verifier.`;
        return `${a.agent}: ${plural(v.jobs, "job")} hired with a verifier, ${v.accepted} accepted, ${v.rejected} rejected, ${v.disputed} disputed. ${v.onErc8004 ? `On the ERC-8004 Validation Registry (${v.onErc8004.registry}, tag ${v.onErc8004.tag}): ${plural(v.onErc8004.count, "validation")}, ${v.onErc8004.avgResponse} of 100 on average.` : "No validation on ERC-8004 yet."}`;
      }
      if (!(await f.verifiersAbout()).enabled) return VERIFIERS_OFF;
      const e = await f.verifiedErc8004(a.case as number);
      if (!e) return `There is no case ${a.case} on Factor.`;
      return [erc8004Text(e), ...(e.agentId ? [`Identity #${e.agentId}; validator ${e.validator ?? "none yet"}.`] : []), ...(e.file ? [`The case file: ${e.file}, keccak256 ${e.fileHash}.`] : [])].join("\n");
    },
  },
  {
    name: "factor_verified_8004_request", readOnly: false, input: { case: CASE_ID },
    description: "As the owner of the agent's ERC-8004 identity (or an operator it approved), once a verified job's verdict was carried out: ask the verifier whose verdict it was to validate the job on the ERC-8004 Validation Registry. Sends the request Factor prepared, after the kit checks it is to the registry, for that verifier, identity and case file, and that the file hashes to what it names. Only while the validation is prepared. Costs only the gas.",
    async run(f, a) {
      const r = await f.requestErc8004Validation(a.case as number);
      return `Case ${r.case}: the validation is requested on the ERC-8004 Validation Registry, from the verifier ${r.validator}, for identity #${r.agentId}, with the case file ${r.file} (keccak256 ${r.fileHash}). The verifier answers it. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_verifier_8004_respond", readOnly: false, input: { case: CASE_ID },
    description: "As the verifier whose verdict was carried out, once the agent identity's owner asked: answer the validation on the ERC-8004 Validation Registry, 100 for a verdict of accept and 0 for reject, with the case file and the tag factorVerify. Only while the validation is requested and only from the verifier it names; the kit checks the call Factor prepared before it is sent. Costs only the gas.",
    async run(f, a) {
      const r = await f.answerErc8004Validation(a.case as number);
      return `Case ${r.case}: answered ${said(r.response)} on the ERC-8004 Validation Registry, for the case file ${r.fileHash}. Transaction ${r.explorer}.`;
    },
  },
];

function need(f: Factor): string {
  if (!f.address) throw new Refusal("No wallet key is set (FACTOR_PRIVATE_KEY), so this can only read: figures, agents, jobs and the ledger.", "read_only");
  return f.address;
}
const this_wallet = (f: Factor): string => (f.gasless ? `This assistant acts as the Factor account ${f.address}: its key signs, Factor pays the gas, and ETH for a job has to be in the account.` : f.address ? `This assistant acts as the wallet ${f.address}.` : "No wallet key is set, so this assistant can read Factor and cannot hire, draw or deliver.");

/** Run one tool by its name. A refusal comes back as words, marked as an error, and never throws. */
export async function runTool(factor: Factor, name: string, args: Record<string, unknown>, spending: Spending | null): Promise<{ text: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `There is no tool called ${name}.`, isError: true };
  try {
    const parsed = z.object(tool.input).strict().parse(args ?? {});
    if (!tool.readOnly) need(factor);
    if (factor.gasless && (VERIFIER_WRITE_TOOLS as readonly string[]).includes(tool.name)) throw new Refusal(VERIFIERS_GASLESS, "gasless");
    return { text: await tool.run(factor, parsed, spending), isError: false };
  } catch (e) {
    if (e instanceof z.ZodError) return { text: `That is not what ${name} takes: ${e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}.`, isError: true };
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}
