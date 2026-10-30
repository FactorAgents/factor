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
import { Factor, Refusal, toWei, type Agent, type CoinPermission, type Job } from "./index.js";

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
    description: "What an agent has left of its compute credit, in dollars: advances drawn as compute, which are spent on model calls through Factor and cannot be withdrawn. Also says which models it buys and what they cost.",
    async run(f, a) {
      const [c, s] = await Promise.all([f.computeCredit(a.agent as string | undefined), f.state()]);
      const usd = (n: number) => `$${n.toFixed(n > 0 && n < 1 ? 4 : 2)}`;
      const lots = c.lots.map((l) => `job ${l.job}: ${l.usd === null ? "being priced" : `${usd(l.spentUsd)} of ${usd(l.usd)} spent`}${l.state === "closed" ? " (refunded, closed)" : ""}`).join("; ");
      const direct = s.compute?.models.length ? ` Claude directly, per million tokens: ${s.compute.models.map((m) => `${m.id} ${usd(m.inUsd)} in / ${usd(m.outUsd)} out`).join(", ")}.` : "";
      const router = s.compute?.router?.enabled ? ` And ${s.compute.router.models} models from every maker (GPT, Claude, Gemini, Grok, DeepSeek, Llama, Mistral and more): factor_compute_models lists them.` : "";
      const models = s.compute?.enabled ? `${direct}${router}` : " Compute credit is not switched on yet.";
      return `${usd(c.balanceUsd)} of compute credit left.${lots ? ` From ${lots}.` : " No advance has been drawn as compute."}${models}`;
    },
  },
  {
    name: "factor_compute_models", readOnly: true, input: { search: z.string().optional().describe('Part of a model\'s name or maker, like "gpt", "claude" or "deepseek". Left out: the 25 cheapest') },
    description: "The models compute credit can be spent on, from every maker, with what each costs through Factor in dollars a million tokens. Use a model's id with factor_ask_model.",
    async run(f, a) {
      const all = await f.computeModels(a.search as string | undefined);
      if (!all.length) return a.search ? `No model has "${String(a.search)}" in its name.` : "No model is served yet: compute credit through every maker is not switched on.";
      const shown = [...all].sort((x, y) => x.inUsd + x.outUsd - (y.inUsd + y.outUsd)).slice(0, 25);
      const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
      return `${all.length} model${all.length === 1 ? "" : "s"}${all.length > shown.length ? `, the ${shown.length} cheapest shown` : ""}, per million tokens: ${shown.map((m) => `${m.id} ${usd(m.inUsd)} in / ${usd(m.outUsd)} out`).join("; ")}.`;
    },
  },
  {
    name: "factor_ask_model", readOnly: false,
    input: {
      model: z.string().describe('The model\'s id, like "openai/gpt-5" or "anthropic/claude-sonnet-4.5" (factor_compute_models lists them)'),
      prompt: z.string().describe("What to ask it"),
      system: z.string().optional().describe("How it should answer, when that matters"),
      max_tokens: z.number().int().min(1).max(200_000).optional().describe("The longest answer, in tokens. 1024 when not given"),
    },
    description: "Ask any model, paid from this agent's compute credit (advances drawn as compute on its jobs). The credit is spent only on what the call really cost; it is not ETH from the wallet. Factor refuses a call the credit cannot cover before it is sent.",
    async run(f, a) {
      const r = await f.askModel(a.prompt as string, { model: a.model as string, ...(a.system ? { system: a.system as string } : {}), ...(a.max_tokens ? { maxTokens: a.max_tokens as number } : {}) });
      return `${r.text}\n\n(${r.model}: ${r.inputTokens} tokens in, ${r.outputTokens} out, paid from compute credit.)`;
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
    name: "factor_erc8004", readOnly: true, input: { agent: z.string().optional().describe("The agent's name or address. Left out: this wallet's own") },
    description: "An agent's ERC-8004 identity and the entries Factor wrote to its reputation on Robinhood Chain, read from the registry itself: one for each settled job since it was linked, 100 when paid in full and 50 when settled at half, with how many there are and their average. Without a linked identity: the identities the registry has for the agent's wallet.",
    async run(f, a) {
      const who = a.agent ? String(a.agent) : undefined;
      const st = await f.erc8004(who);
      if (!st) return `There is no agent "${who ?? f.address}" on Factor.`;
      if (!st.erc8004) {
        if (st.none) return `${who ?? "This agent"} signed that it wants no ERC-8004 identity linked.`;
        return st.found.length ? `No identity is linked yet. The ERC-8004 registry has ${st.found.map((x) => `#${x.agentId} (by its ${x.via === "wallet" ? "agentWallet" : "owner"})`).join(", ")} for this agent: link one with factor_link_erc8004.` : "No ERC-8004 identity is linked, and the registry has none for this agent's wallet. One can be made with the kit's registerErc8004().";
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
      return `The line is open: ${r.explorer}. Its line account is ${r.account}: new jobs are locked for that address, and its bond (factor_line shows the limit) is added with the kit's bondLine.`;
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
    return { text: await tool.run(factor, parsed, spending), isError: false };
  } catch (e) {
    if (e instanceof z.ZodError) return { text: `That is not what ${name} takes: ${e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}.`, isError: true };
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}
