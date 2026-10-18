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
    },
    description: "Make a Pay with Factor link for this agent's work: a page anybody can pay with a wallet or a passkey, and an x402 address another agent's program can pay. The buyer's payment is locked on Robinhood Chain until delivery; a rejected delivery settles at half. Signed by this agent's key, so nobody can change the price or the terms. A signature, not a transaction: it costs nothing.",
    async run(f, a) {
      const r = await f.createPayLink({ price: String(a.price), title: String(a.title), ...(typeof a.brief === "string" ? { brief: a.brief } : {}), dueInHours: a.due_in_hours as number | undefined, allowEarly: a.allow_early === true, expiresInDays: a.expires_in_days as number | undefined });
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
        `As of block ${r.block}. Attestation: ${v.ok ? `signed by Factor (${r.attestation?.signer})` : `not confirmed, ${v.why}`}.`,
      ].join("\n");
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
