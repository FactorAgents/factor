// Milestones on the made-up chain: the milestone contract is modelled here (FakeChain.extra), and its logs are written in
// the real encoding, so the engine reads them with the real ABI. Each stage is a real job on the made-up desk, locked by
// the model with the contract as its customer. What is checked: the switch and the settings; a plan read and shown with
// every stage; the words taken only when they hash to what the plan holds, and each stage's brief from them; the
// keeper's every step; the stages on the agent's record and in its Factor Score's income; Factor's own agents doing the
// stages of a plan with the brief from its words; that no page view starts anything; the owner's switch.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeAbiParameters, encodeEventTopics, type Abi, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { KIND } from "../src/accounts.js";
import { factorMilestonesAbi } from "../src/abi/index.js";
import type { CallSpec } from "../src/chain/chain.js";
import type { HouseSigner } from "../src/house/house.js";
import { SERVICES } from "../src/house/services.js";
import { MILESTONE_RULES, parseTerms, readMilestones, termsHash, termsText, type Terms } from "../src/milestones.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain, GOOD_SIGNATURE, S } from "./chain/fake.js";
import { rig, wallet, type Rig } from "./chain/harness.js";

const M = "0x00000000000000000000000000000000006d1e57";
const CUSTOMER = "0x00000000000000000000000000000000000c0571";
const AGENT = "0x00000000000000000000000000000000000a6e71";
const DAY = 86_400;
const STAGE = ETH / 1000n; // 0.001
const ST = { running: 1, done: 2, missed: 3, declined: 4, rejected: 5 } as const;

interface ModelPlan { id: number; customer: string; agent: string; prices: bigint[]; times: number[]; early: boolean; terms: string; state: number; current: number; jobs: number[]; left: bigint }

type Desk = { settleJob(id: number, tx?: string): void; refundJob(id: number, tx?: string): void };

/** The milestone contract, as the engine asks it things and as the keeper's step changes it. */
class Model {
  items: ModelPlan[] = [];
  steps: number[] = [];
  paid = 0n;
  returned = 0n;
  constructor(private chain: FakeChain) {
    chain.extra = { answer: (c) => this.answer(c), run: (c, f, commit, tx) => this.run(c, f, commit, tx) };
  }

  private get desk(): Desk { return this.chain as unknown as Desk; }

  by(id: number): ModelPlan { return this.items.find((x) => x.id === id)!; }

  answer(call: CallSpec): unknown {
    if (call.to.toLowerCase() !== M) return undefined;
    const fn = call.functionName, a = call.args ?? [];
    if (fn === "plan") { const x = this.items.find((y) => y.id === Number(a[0])); return x ? { state: x.state, terms: x.terms, count: x.prices.length } : { state: 0, terms: `0x${"0".repeat(64)}`, count: 0 }; }
    const running = this.items.filter((x) => x.state === ST.running);
    const totals: Record<string, bigint> = {
      held: running.reduce((n, x) => n + x.left, 0n), atDesk: running.reduce((n, x) => n + x.prices[x.current]!, 0n), owedTotal: 0n,
      totalBudgets: this.items.reduce((n, x) => n + x.prices.reduce((s, p) => s + p, 0n), 0n), totalPaid: this.paid, totalReturned: this.returned, planCount: BigInt(this.items.length),
    };
    return fn in totals ? totals[fn] : undefined;
  }

  run(call: CallSpec, _from: string, commit: boolean, tx: string): unknown {
    if (call.to.toLowerCase() !== M) return undefined;
    if (call.functionName !== "step") throw new Error("not modelled");
    const x = this.by(Number(call.args![0]));
    if (x.state !== ST.running) throw new Error("WrongState");
    const job = x.jobs[x.current]!;
    const j = this.chain.jobs.get(job)!;
    if ((j.state === S.locked || j.state === S.advanced) && this.chain.time <= j.dueAt + 12 * 3600) throw new Error("TooSoon");
    if (j.state === S.delivered && this.chain.time < j.deliveredAt + DAY) throw new Error("TooSoon");
    if (!commit) return null;
    this.steps.push(x.id);
    if (j.state === S.locked || j.state === S.advanced) this.desk.refundJob(job, tx);
    if (j.state === S.delivered) this.desk.settleJob(job, tx);
    if (j.state === S.settled) this.paidStage(x, tx);
    else if (j.state === S.refunded) this.end(x, ST.missed, j.price - j.early, tx);
    else if (j.state === S.declined) this.end(x, ST.declined, j.price, tx);
    return null;
  }

  log(eventName: string, args: Record<string, unknown>, tx?: string) {
    const abi = factorMilestonesAbi as Abi;
    const ev = abi.find((x) => x.type === "event" && x.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
    const rest = ev.inputs.filter((i) => !i.indexed);
    return this.chain.push({ address: M, topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[], data: encodeAbiParameters(rest, rest.map((i) => args[i.name]) as never), ...(tx ? { transactionHash: tx as Hex } : {}) } as never);
  }

  post(terms: Terms, o: { prices?: bigint[]; times?: number[]; agent?: string; early?: boolean } = {}): ModelPlan {
    this.chain.mine();
    const prices = o.prices ?? terms.stages.map(() => STAGE);
    const times = o.times ?? terms.stages.map(() => DAY);
    const x: ModelPlan = { id: this.items.length + 1, customer: CUSTOMER, agent: (o.agent ?? AGENT).toLowerCase(), prices, times, early: !!o.early, terms: termsHash(termsText(terms)), state: ST.running, current: 0, jobs: [], left: prices.reduce((n, p) => n + p, 0n) };
    this.items.push(x);
    this.log("Posted", { id: BigInt(x.id), customer: x.customer, agent: x.agent, total: x.left, allowEarly: x.early, terms: x.terms, prices, times: times.map(BigInt) });
    this.open(x, 0);
    return x;
  }

  // the made-up chain mines a block for the desk's lock, so the log of the opening is its own (the real one shares the step's)
  private open(x: ModelPlan, i: number): void {
    x.current = i;
    x.left -= x.prices[i]!;
    const job = this.chain.lock(M, x.agent, x.prices[i]!, x.times[i], x.early);
    x.jobs[i] = job;
    this.log("Opened", { id: BigInt(x.id), stage: BigInt(i), job: BigInt(job), price: x.prices[i], dueAt: BigInt(this.chain.time + x.times[i]!) });
  }

  private paidStage(x: ModelPlan, tx?: string): void {
    const i = x.current;
    this.paid += x.prices[i]!;
    this.log("StagePaid", { id: BigInt(x.id), stage: BigInt(i), job: BigInt(x.jobs[i]!), price: x.prices[i] }, tx);
    if (i + 1 < x.prices.length) this.open(x, i + 1);
    else { x.state = ST.done; this.log("Ended", { id: BigInt(x.id), how: ST.done, stage: BigInt(i), job: BigInt(x.jobs[i]!), fromDesk: 0n, unstarted: 0n }, tx); }
  }

  private end(x: ModelPlan, how: number, fromDesk: bigint, tx?: string): void {
    const unstarted = x.left;
    x.state = how;
    x.left = 0n;
    this.returned += fromDesk + unstarted;
    this.log("Ended", { id: BigInt(x.id), how, stage: BigInt(x.current), job: BigInt(x.jobs[x.current]!), fromDesk, unstarted }, tx);
  }

  /** The customer accepts the stage on the desk, through the contract. */
  accept(id: number): void {
    const x = this.by(id);
    this.chain.accept(x.jobs[x.current]!);
    this.paidStage(x);
  }

  /** The customer rejects the stage on the desk, through the contract. */
  reject(id: number): void {
    const x = this.by(id);
    const job = x.jobs[x.current]!;
    this.chain.reject(job);
    this.end(x, ST.rejected, this.chain.jobs.get(job)!.price / 2n);
  }

  job(id: number): number { const x = this.by(id); return x.jobs[x.current]!; }
}

const rigs: Rig[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => { s.closeAllConnections(); s.close(() => done()); })));
});

const ON = { MILESTONES: "on", FACTOR_MILESTONES: M, FACTOR_MILESTONES_BLOCK: "5000" };

async function world(o: { more?: Record<string, string> } = {}): Promise<{ r: Rig; chain: FakeChain; model: Model }> {
  const chain = new FakeChain();
  chain.fund(ETH);
  chain.register(AGENT);
  const model = new Model(chain);
  const r = await rig("live", { chain, more: { ...ON, ...o.more } });
  rigs.push(r);
  r.db.q("INSERT INTO agent_profiles (address, name, name_key, does, signed_at) VALUES (?, ?, ?, ?, ?)").run(AGENT, "report-lead", "report-lead", "writes weekly reports", 1);
  await r.engine.watchOnce();
  return { r, chain, model };
}

type Body = Record<string, any>;
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? "")))!; return { status: a.status, ...(a.body as Body) }; };
const post = async (r: Rig, path: string, body: unknown, from = "1.1.1.1"): Promise<Body> => { const a = (await r.engine.post(path, body, from))!; return { status: a.status, ...(a.body as Body) }; };

const TERMS: Terms = {
  title: "A weekly report, in two parts",
  stages: [
    { title: "The outline", brief: "An outline of the weekly report: the five headings and a line under each." },
    { title: "The full report", brief: "The full report from the outline, about 600 words." },
  ],
};
const TEXT = termsText(TERMS);

describe("the settings and the words", () => {
  it("are off unless MILESTONES=on, and say why they cannot run", () => {
    expect(readMilestones({}).enabled).toBe(false);
    expect(readMilestones({ MILESTONES: "on" }).note).toMatch(/FACTOR_MILESTONES is not set/);
    expect(readMilestones({ MILESTONES: "on", FACTOR_MILESTONES: M }).note).toMatch(/FACTOR_MILESTONES_BLOCK/);
    expect(readMilestones(ON).note).toBeNull();
    expect(readMilestones(ON).perPass).toBe(5);
    const problems: string[] = [];
    readMilestones({ FACTOR_MILESTONES: "nope", FACTOR_MILESTONES_BLOCK: "x", MILESTONES_PER_PASS: "0" }, problems);
    expect(problems).toHaveLength(3);
  });

  it("the words are compact JSON in a fixed order, and are read back only when every title and brief is one", () => {
    expect(TEXT).toBe('{"title":"A weekly report, in two parts","stages":[{"title":"The outline","brief":"An outline of the weekly report: the five headings and a line under each."},{"title":"The full report","brief":"The full report from the outline, about 600 words."}]}');
    expect(parseTerms(TEXT, 2)).toEqual(TERMS);
    expect(parseTerms(TEXT, 3)).toMatch(/2 stages and the plan 3/);
    expect(parseTerms("not json", 2)).toMatch(/not JSON/);
    expect(parseTerms(termsText({ ...TERMS, title: "x" }), 2)).toMatch(/plan's title/);
    expect(parseTerms(termsText({ ...TERMS, stages: [TERMS.stages[0]!, { title: "See https://x.com", brief: "b" }] }), 2)).toMatch(/stage 2's title/);
    expect(parseTerms(termsText({ ...TERMS, stages: [TERMS.stages[0]!, { title: "Fine title", brief: "" }] }), 2)).toMatch(/stage 2's brief/);
  });

  it("off, nothing is read or shown, and the first page says milestones are off", async () => {
    const { r, model } = await world({ more: { MILESTONES: "" } });
    model.post(TERMS);
    await r.engine.watchOnce();
    expect(r.db.count("milestone_plans")).toBe(0);
    expect(await get(r, "/v1/milestones")).toMatchObject({ enabled: false, items: [] });
    expect((await get(r, "/v1/state")).milestones.enabled).toBe(false);
    expect((await get(r, "/v1/milestones/1")).status).toBe(404);
    expect((await get(r, "/v1/agents/report-lead")).milestones).toBeUndefined();
    expect((await post(r, "/v1/milestones/terms", { id: 1, terms: TEXT })).status).toBe(503);
  });
});

describe("a plan, read from the chain", () => {
  it("shows every stage, the first on the desk and the second waiting, and its words once they hash to what it holds", async () => {
    const { r, chain, model } = await world();
    const x = model.post(TERMS, { prices: [STAGE, 2n * STAGE], times: [DAY, 3 * DAY] });
    await r.engine.watchOnce();
    let p = await get(r, "/v1/milestones/1");
    expect(p).toMatchObject({ id: 1, customer: CUSTOMER, agent: { address: AGENT, name: "report-lead" }, totalEth: 0.003, count: 2, allowEarly: false, state: "running", current: 1, title: null });
    expect(p.stages[0]).toMatchObject({ n: 1, priceEth: 0.001, status: "open", job: { n: x.jobs[0] }, dueAt: new Date((chain.time + DAY) * 1000).toISOString() });
    expect(p.stages[1]).toMatchObject({ n: 2, priceEth: 0.002, status: "waiting", timeS: 3 * DAY, expectedDueAt: new Date((chain.time + 4 * DAY) * 1000).toISOString() });
    expect(p.stages[1].job).toBeUndefined();
    // other words are refused
    expect((await post(r, "/v1/milestones/terms", { id: 1, terms: termsText({ ...TERMS, title: "Another plan entirely" }) })).status).toBe(409);
    expect((await post(r, "/v1/milestones/terms", { id: 2, terms: TEXT })).status).toBe(404);
    expect((await post(r, "/v1/milestones/terms", { id: 1, terms: "" })).status).toBe(400);
    expect((await post(r, "/v1/milestones/terms", { id: 1, terms: "x".repeat(MILESTONE_RULES.termsBytes + 1) })).status).toBe(400);
    expect((await post(r, "/v1/milestones/terms", { id: 1, terms: TEXT })).status).toBe(200);
    p = await get(r, "/v1/milestones/1");
    expect(p.title).toBe(TERMS.title);
    expect(p.stages.map((s: Body) => s.title)).toEqual(["The outline", "The full report"]);
    // the stage on the desk carries its title and brief, and says which plan it is a stage of
    const job = await get(r, `/v1/jobs/${x.jobs[0]}`);
    expect(job.job.title).toBe("The outline");
    expect(job.brief).toMatch(/^An outline of the weekly report/);
    expect(job.brief).toMatch(/Stage 1 of 2/);
    expect(job.job.milestone).toMatchObject({ id: 1, stage: 1, count: 2, title: TERMS.title, customer: CUSTOMER, state: "running" });
    expect(await get(r, `/v1/milestones/job/${x.jobs[0]}`)).toMatchObject({ id: 1, stage: 1 });
    expect((await get(r, "/v1/milestones?show=open")).items.map((i: Body) => i.id)).toEqual([1]);
    expect((await get(r, `/v1/milestones/customer/${CUSTOMER}`)).plans).toBe(1);
    expect((await get(r, "/v1/state")).milestones.totals).toMatchObject({ plans: 1, running: 1, budgetsEth: 0.003, heldEth: 0.002 });
  });

  it("words can arrive before the engine has read the post, from the chain's own word", async () => {
    const { r, model } = await world();
    model.post(TERMS);
    expect((await post(r, "/v1/milestones/terms", { id: 1, terms: TEXT })).status).toBe(200);
    await r.engine.watchOnce();
    expect((await get(r, `/v1/jobs/${model.job(1)}`)).job.title).toBe("The outline");
  });

  it("each stage gets its own brief the moment it is on the desk, and stays paid on the record", async () => {
    const { r, chain, model } = await world();
    model.post(TERMS);
    await r.engine.watchOnce();
    await post(r, "/v1/milestones/terms", { id: 1, terms: TEXT });
    const job1 = model.job(1);
    chain.deliver(job1);
    model.accept(1);
    await r.engine.watchOnce();
    const job2 = model.job(1);
    expect(job2).toBe(job1 + 1);
    expect((await get(r, `/v1/jobs/${job2}`)).job.title).toBe("The full report");
    let p = await get(r, "/v1/milestones/1");
    expect(p.current).toBe(2);
    expect(p.stages.map((s: Body) => s.status)).toEqual(["paid", "open"]);
    chain.deliver(job2);
    model.accept(1);
    await r.engine.watchOnce();
    p = await get(r, "/v1/milestones/1");
    expect(p).toMatchObject({ state: "done", paidEth: 0.002 });
    expect(p.stages.map((s: Body) => s.status)).toEqual(["paid", "paid"]);
    const agent = await get(r, "/v1/agents/report-lead");
    expect(agent.milestones).toMatchObject({ plans: 1, done: 1, stagesPaid: 2, paidEth: 0.002 });
    const income = (agent.factorScore.income as Body[]).find((l) => l.source === "milestones");
    expect(income).toMatchObject({ name: "Milestones", settled: 2 });
    expect((await get(r, `/v1/record/${AGENT}`)).milestones).toMatchObject({ plans: 1, done: 1, stagesPaid: 2 });
  });
});

describe("the keeper", () => {
  it("leaves a delivered stage for the customer's day, then steps it: paid, and the next stage opens", async () => {
    const { r, chain, model } = await world();
    model.post(TERMS);
    await r.engine.watchOnce();
    chain.deliver(model.job(1));
    await r.turn();
    expect(model.steps).toEqual([]);
    chain.time += DAY;
    await r.turn();
    expect(model.steps).toEqual([1]);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/milestones/1")).current).toBe(2);
  });

  it("steps a stage past its due time and grace: the rest goes back", async () => {
    const { r, chain, model } = await world();
    model.post(TERMS);
    await r.engine.watchOnce();
    chain.time += DAY + 12 * 3600;
    await r.turn();
    expect(model.steps).toEqual([]);
    chain.time += 1;
    await r.turn();
    expect(model.steps).toEqual([1]);
    await r.engine.watchOnce();
    const p = await get(r, "/v1/milestones/1");
    expect(p).toMatchObject({ state: "missed", returnedEth: 0.002 });
    expect(p.stages.map((s: Body) => s.status)).toEqual(["missed", "returned"]);
  });

  it("steps a declined stage, and one the desk settled by itself", async () => {
    const { r, chain, model } = await world();
    model.post(TERMS);
    model.post(TERMS);
    await r.engine.watchOnce();
    chain.decline(model.job(1));
    chain.deliver(model.job(2));
    chain.time += DAY;
    (chain as unknown as Desk).settleJob(model.job(2));
    await r.turn();
    expect(model.steps.sort()).toEqual([1, 2]);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/milestones/1")).state).toBe("declined");
    expect((await get(r, "/v1/milestones/2")).current).toBe(2);
  });

  it("a reject ends the plan, and the record shows it", async () => {
    const { r, chain, model } = await world();
    model.post(TERMS);
    await r.engine.watchOnce();
    chain.deliver(model.job(1));
    model.reject(1);
    await r.turn();
    expect(model.steps).toEqual([]);
    const p = await get(r, "/v1/milestones/1");
    expect(p).toMatchObject({ state: "rejected", returnedEth: 0.0015 });
    expect(p.stages.map((s: Body) => s.status)).toEqual(["rejected", "returned"]);
  });

  it("the owner's switch hides plans and stops the keeper at once", async () => {
    const { r, chain, model } = await world();
    model.post(TERMS);
    await r.engine.watchOnce();
    turn(r.db, "milestones", false, "a look at it");
    chain.time += 2 * DAY;
    await r.turn();
    expect(model.steps).toEqual([]);
    expect(await get(r, "/v1/milestones")).toMatchObject({ enabled: false, items: [] });
    expect((await get(r, "/v1/state")).milestones.enabled).toBe(false);
    expect((await get(r, `/v1/jobs/${model.job(1)}`)).job.milestone).toBeUndefined();
    turn(r.db, "milestones", true);
    await r.turn();
    expect(model.steps).toEqual([1]);
  });

  it("the owner hides a plan's words, and the number stays", async () => {
    const { r, model } = await world({ more: { ENGINE_ADMIN_KEY: "an-admin-key-of-this-test-run-long-enough" } });
    model.post(TERMS);
    await r.engine.watchOnce();
    await post(r, "/v1/milestones/terms", { id: 1, terms: TEXT });
    const a = await r.engine.post("/v1/admin/hide", { what: "plan-terms", key: "1" }, "1.1.1.1", "an-admin-key-of-this-test-run-long-enough");
    expect(a!.status).toBe(200);
    expect(await get(r, "/v1/milestones/1")).toMatchObject({ id: 1, title: null, hidden: true });
    expect((await get(r, `/v1/jobs/${model.job(1)}`)).job.title).toBeFalsy();
  });
});

// ---------- Factor's own agents ----------

const numberOf = (name: string) => { const i = SERVICES.findIndex((s) => s.name === name); return i >= 0 ? 0xa000 + i : 0xb000 + [...name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 0xfff, 7); };
const signerFor = (name: string): HouseSigner => ({ address: wallet(numberOf(name)), signTypedData: async () => GOOD_SIGNATURE });
const accountOf = (name: string) => FakeChain.accountOf({ kind: KIND.wallet, a: `0x${"0".repeat(24)}${signerFor(name).address.slice(2)}`, b: `0x${"0".repeat(64)}` });
const PAGE_SMITH = accountOf("page-smith");
const A_PAGE = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Tide Tea</title><style>body{font-family:system-ui}</style></head><body><h1>Tide Tea</h1><p>Loose leaf tea, posted weekly.</p></body></html>';

interface StubModel { url: string; asks: number }
async function stubModel(): Promise<StubModel> {
  const m: StubModel = { url: "", asks: 0 };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      m.asks++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: A_PAGE }], usage: { input_tokens: 2000, output_tokens: 1000 } }));
    });
  });
  servers.push(server);
  m.url = await new Promise((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  return m;
}

const round = async (w: Rig, n = 1) => { for (let i = 0; i < n; i++) { await w.engine.houseOnce(); await w.turn(); await w.engine.watchOnce(); } };

describe("Factor's own agents", () => {
  it("do each stage of a plan from the brief its words give it, one after another, and no page view starts a model", async () => {
    const m = await stubModel();
    const chain = new FakeChain();
    chain.balances.set(A.bot, ETH);
    const model = new Model(chain);
    const r = await rig("live", { chain, houseSigners: signerFor, more: { ...ON, HOUSE_MODE: "on", FACTOR_ACCOUNTS: A.accounts, HOUSE_UPSTREAM_URL: m.url, ANTHROPIC_API_KEY: "sk-ant-test-0000-the-owners-key-with-the-model-maker" } });
    rigs.push(r);
    await r.engine.watchOnce();
    await round(r, 8);
    const pages: Terms = {
      title: "Two pages for our tea shop",
      stages: [
        { title: "The landing page", brief: "A landing page for our tea shop: we sell loose leaf tea, posted weekly." },
        { title: "The about page", brief: "An about page for the same tea shop: who we are and where the tea comes from." },
      ],
    };
    const price = (ETH * 3n) / 1000n;
    model.post(pages, { agent: PAGE_SMITH, prices: [price, price] });
    await r.engine.watchOnce();
    for (let i = 0; i < 3; i++) { await get(r, "/v1/milestones/1"); await get(r, "/v1/state"); }
    expect(m.asks).toBe(0);
    await post(r, "/v1/milestones/terms", { id: 1, terms: termsText(pages) });
    await round(r, 4);
    expect(m.asks).toBe(1);
    const job1 = model.job(1);
    expect(chain.jobs.get(job1)!.state).toBe(S.delivered);
    model.accept(1);
    await r.engine.watchOnce();
    await round(r, 4);
    expect(m.asks).toBe(2);
    expect(chain.jobs.get(model.job(1))!.state).toBe(S.delivered);
    model.accept(1);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/milestones/1")).state).toBe("done");
    expect((await get(r, `/v1/jobs/${job1}`)).work.kind).toBe("html");
  });
});
