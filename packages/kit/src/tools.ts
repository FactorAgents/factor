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
import { Factor, Refusal, toWei, type Agent, type Job } from "./index.js";

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
const jobLine = (j: Job): string => `Job ${j.n}${j.title ? ` "${j.title}"` : ""}: ${j.state}, ${j.priceEth} ETH, due ${j.dueAt}${j.advances.length ? `, ${j.advances.reduce((n, a) => n + a.eth, 0)} ETH advanced` : ""}. Agent ${j.agentId}, customer ${j.customer}.`;
const jobId = z.number().int().positive().describe("The job's number");
const amount = z.string().regex(/^\d{1,9}(\.\d{1,18})?$/).describe('ETH as text, like "0.04"');

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
      return [agentLine(g), `Bond ${g.bondEth} ETH, fees paid in ${g.feesPaidEth} ETH, limit with the pool ${g.limitEth} ETH, can draw ${g.canDrawEth} ETH now. On time ${g.onTimePct}%.`, ...page.jobs.slice(0, 8).map(jobLine)].join("\n");
    },
  },
  {
    name: "factor_job", readOnly: true, input: { job: jobId },
    description: "One job: its state, its price, what was advanced on it, what it paid, and everything that happened to it.",
    async run(f, a) {
      const page = await f.job(a.job as number);
      if (!page) return `There is no job ${a.job} on Factor (a new one shows up a few seconds after it is locked).`;
      const j = page.job;
      const closed = j.state === "settled" || j.state === "half" ? ` Paid to the agent ${j.paidEth} ETH, job fee ${j.feeEth} ETH.` : j.backEth !== undefined ? ` ${j.backEth} ETH went back to the customer.` : "";
      return [jobLine(j) + closed, ...page.events.map((e) => `${e.at} ${e.kind}: ${e.text} (${e.amount})`)].join("\n");
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
    input: { agent: z.string().describe("The agent's name or address"), price: amount, title: z.string().min(3).max(80).describe("What you want done, in one line without links"), due_in_hours: z.number().min(1).max(720).optional().describe("24 when not given"), allow_early: z.boolean().optional().describe("true lets the agent take up to half of this payment before delivering; that part is NOT refunded if it does not deliver. false when not given") },
    description: "Hire an agent: lock the price of a job for it. THIS SPENDS ETH from the wallet: it is held by the desk and paid to the agent when it delivers, or comes back if it does not deliver in time. It cannot be cancelled. Confirm the agent, the price and the due time with the user first unless they already gave them.",
    async run(f, a, spending) {
      need(f);
      const price = toWei(String(a.price));
      spending?.check(price, true);
      const r = await f.hire({ agent: String(a.agent), price, title: String(a.title), dueInHours: a.due_in_hours as number | undefined, allowEarly: a.allow_early === true });
      spending?.add(price);
      return `Job ${r.jobId} is locked: ${eth(price)} ETH for ${a.agent}${r.titled ? `, titled "${a.title}"` : " (its title could not be saved; set it with factor_set_title)"}. Transaction ${r.explorer}. The agent now has until the due time to deliver; use factor_job to follow it.`;
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
    name: "factor_draw", readOnly: false, input: { job: jobId, amount, from: z.enum(["pool", "compute", "early"]).describe("pool: the pool advances it to the agent. compute: the pool pays it to the compute gateway for this job. early: out of the customer's own payment, when they allowed it") },
    description: "Draw an advance on a job this agent was hired for, before delivering it. A 1% fee comes off what is drawn. The job repays a pool or compute advance when it settles; if the agent does not deliver, its bond pays and the pool never advances it again.",
    async run(f, a) {
      const wei = toWei(String(a.amount));
      const r = await f.draw(a.job as number, wei, a.from as "pool" | "compute" | "early");
      return `${eth(wei)} ETH drawn on job ${a.job} (${a.from}), less the 1% fee. Transaction ${r.explorer}.`;
    },
  },
  {
    name: "factor_deliver", readOnly: false, input: { job: jobId, work: z.string().min(1).describe("What was handed to the customer: the text itself, or the link to it. Only its fingerprint goes on the chain") },
    description: "Deliver a job as its agent. Hand the work to the customer the way you agreed first; this records the fingerprint of it on the chain as the proof of what was delivered and when. The customer then has 24 hours to accept or reject, after which the job settles by itself and the agent is paid.",
    async run(f, a) {
      const r = await f.deliver(a.job as number, String(a.work));
      return `Job ${a.job} is delivered. Fingerprint ${r.proof}. Transaction ${r.explorer}. Keep the work exactly as it was given: the same text gives the same fingerprint.`;
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
];

function need(f: Factor): string {
  if (!f.address) throw new Refusal("No wallet key is set (FACTOR_PRIVATE_KEY), so this can only read: figures, agents, jobs and the ledger.", "read_only");
  return f.address;
}
const this_wallet = (f: Factor): string => (f.address ? `This assistant acts as the wallet ${f.address}.` : "No wallet key is set, so this assistant can read Factor and cannot hire, draw or deliver.");

/** Run one tool by its name. A refusal comes back as words, marked as an error, and never throws. */
export async function runTool(factor: Factor, name: string, args: Record<string, unknown>, spending: Spending | null): Promise<{ text: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `There is no tool called ${name}.`, isError: true };
  try {
    const parsed = z.object(tool.input).strict().parse(args ?? {});
    if (!tool.readOnly) need(factor);
    return { text: await tool.run(factor, parsed, spending), isError: false };
  } catch (e) {
    if (e instanceof z.ZodError) return { text: `That is not what ${name} takes: ${e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}.`, isError: true };
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}
