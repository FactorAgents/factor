// The engine as a whole, on the made-up chain: what the site is told before there is anything, what it is told of
// agents, jobs and the ledger, the names and titles people sign, and the owner's health answer.

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { AgentJson, EngineApi, EngineView, EventJson, FactorState, JobJson } from "../src/api.js";
import { DeskMind } from "../src/deskmind.js";
import { hostedMessage } from "../src/house/hosted.js";
import { keccak256, toHex } from "viem";
import { open } from "../src/chain/db.js";
import { Engine } from "../src/engine.js";
import { oneLine, profileMessage, titleMessage } from "../src/profiles.js";
import { A, ETH, FakeChain, K, MINTED } from "./chain/fake.js";
import { rig, wallet, type Rig } from "./chain/harness.js";

const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
});

const get = async (e: Engine, path: string, query = "") => (await e.handle(path, new URLSearchParams(query)))!;
const state = async (e: Engine) => (await get(e, "/v1/state")).body as unknown as FactorState;
const health = async (e: Engine) => (await get(e, "/v1/health")).body as Record<string, any>;

// two wallets with keys, so that they can sign: anvil's built-in test keys, public and worth nothing anywhere
const agentKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const customerKey = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const AGENT = agentKey.address.toLowerCase();
const CUSTOMER = customerKey.address.toLowerCase();
const HOUSE = wallet(0xa2);
const P = ETH / 25n;

// every key the site's type has (web/src/lib/types.ts), so a change on one side is noticed on the other
function expectShape(s: FactorState): void {
  expect(Object.keys(s).sort()).toEqual(["accounts", "activity", "agents", "asOf", "autoApply", "burn", "burns", "compute", "contracts", "desk", "erc8004", "events", "firms", "hosted", "jobs", "launched", "links", "openJobs", "params", "paused", "pay", "plans", "pulse", "roster", "signups", "source", "stats", "subjobs", "verified"]);
  // Factor's own agents are said in every answer, before the launch and after: fifteen, each with what it takes a job for
  const roster = (s as unknown as { roster: { name: string; does: string; fromEth: number }[] }).roster;
  expect(roster).toHaveLength(15);
  expect(roster[0]).toMatchObject({ name: "page-smith", fromEth: 0.003 });
  expect(s.paused).toBeNull();
  expect(Object.keys(s.accounts).sort()).toEqual(["enabled", "factory", "ordersPerDay"]);
  expect(Object.keys(s.compute).sort()).toEqual(["enabled", "limits", "markupPct", "maxTokens", "models", "router"]);
  expect(Object.keys(s.stats).sort()).toEqual(["advancedEth", "agents", "burnedTokens", "demoJobs", "heldEth", "jobs", "lostEth", "outEth", "poolEth", "poolFromTradingEth", "reserveEth", "settledJobs", "supplyLeft"]);
  expect(s.params).toEqual({ advanceMaxPct: 50, advanceFeePct: 1, jobFeePct: 2, graceHours: 12, reviewHours: 24, rejectedPct: 50, reserveMinPct: 20, minJobEth: 0.001 });
  expect(Object.keys(s.contracts).sort()).toEqual(["burnPot", "desk", "explorer", "splitter", "token"]);
  expect(Object.keys(s.links).sort()).toEqual(["github", "pons", "x"]);
}

/** A desk with some life in it: the rulebook's example settled, a job open, a house agent with nothing yet. */
async function busy(more: Record<string, string> = {}): Promise<Rig & { settled: number; openJob: number }> {
  const chain = new FakeChain();
  chain.fund(ETH);
  chain.register(AGENT);
  chain.register(HOUSE);
  chain.bond(AGENT, ETH / 50n);
  const settled = chain.lock(CUSTOMER, AGENT, P);
  chain.draw(settled, P / 2n, K.pool);
  chain.deliver(settled);
  chain.accept(settled);
  const openJob = chain.lock(CUSTOMER, AGENT, ETH / 10n, 86400, true);
  chain.draw(openJob, ETH / 100n, K.early);
  chain.draw(openJob, ETH / 50n, K.compute);
  const r = await rig("watch", { chain, more: { FACTOR_HOUSE_AGENTS: HOUSE, FACTOR_PONS_URL: "https://ponsfamily.com/launchpad/0xabc", ...more } });
  await r.engine.watchOnce();
  return { ...r, settled, openJob };
}

describe("signing up before there is anything", () => {
  it("takes an agent made on the site with the engine off, says making is open, and lists the sign-up", async () => {
    const engine = new Engine(open(":memory:"), { env: {}, chain: new FakeChain(), log: () => {} });
    engine.start();
    await engine.ready();
    const maker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const owner = maker.address.toLowerCase(), at = Math.floor(Date.now() / 1000);
    const instructions = "Write a haiku about whatever the customer names. Three lines of five, seven and five syllables.";
    const signature = await maker.signMessage({ message: hostedMessage(owner, "haiku-maker", "Writes a haiku about anything you name", "0.002", owner, keccak256(toHex(instructions)), at) });
    const r = await engine.post("/v1/agents/make", { owner, name: "haiku-maker", does: "Writes a haiku about anything you name", instructions, priceEth: "0.002", at, signature }, "1.2.3.4");
    expect(r).toMatchObject({ status: 200, body: { ok: true, waiting: true } });
    const s = (await state(engine)) as unknown as { hosted: { enabled: boolean; beforeLaunch?: boolean }; signups: { total: number; latest: { name: string }[] } };
    expect(s.hosted).toMatchObject({ enabled: true, beforeLaunch: true });
    expect(s.signups).toMatchObject({ total: 1, latest: [{ name: "haiku-maker" }] });
    expect(((await get(engine, `/v1/agents/made/${owner}`)).body as { items: { name: string; waiting: boolean }[] }).items).toEqual([expect.objectContaining({ name: "haiku-maker", waiting: true })]);
    await engine.stop();
  });
});

describe("before there is anything", () => {
  it("answers the empty state with the engine off, and asks no node anything", async () => {
    const chain = new FakeChain();
    const engine = new Engine(open(":memory:"), { env: {}, chain, log: () => {} });
    engine.start();
    await engine.ready();
    const s = await state(engine);
    expectShape(s);
    expect(s).toMatchObject({
      source: "engine", launched: false, agents: [], jobs: [], events: [], burns: [],
      stats: { advancedEth: 0, settledJobs: 0, poolEth: 0, outEth: 0, burnedTokens: 0, supplyLeft: 1_000_000_000, agents: 0 },
      contracts: { desk: null, burnPot: null, splitter: null, token: null, explorer: "https://robinhoodchain.blockscout.com" },
      links: { pons: null, github: null, x: null },
    });
    expect(chain.calls).toEqual([]);
    expect((await get(engine, "/v1/ledger")).body).toEqual({ total: 0, more: false, items: [] });
    expect((await get(engine, "/v1/agents/0x0000000000000000000000000000000000000001")).status).toBe(404);
    expect(await engine.handle("/v1/nothing")).toBeNull();
    expect((await engine.post("/v1/agents/profile", {}, "1.2.3.4"))!.status).toBe(400); // before the launch a name goes on the launch list: an empty one is refused
  });

  it("shows the desk before the token is launched: the contracts are open from the moment they exist", async () => {
    const chain = new FakeChain();
    chain.token = null;
    chain.fund(ETH / 10n);
    chain.register(AGENT);
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    const s = await state(r.engine);
    expectShape(s);
    expect(s.launched).toBe(false);
    expect(s.contracts).toMatchObject({ desk: A.desk, token: null });
    expect(s.stats).toMatchObject({ poolEth: 0.1, agents: 1, burnedTokens: 0, supplyLeft: 1_000_000_000 });
    expect(s.agents).toHaveLength(1);
  });
});

describe("what the site is told", () => {
  it("gives the whole first page in the site's shape", async () => {
    const r = await busy();
    const s = await state(r.engine);
    expectShape(s);
    expect(s.launched).toBe(true);
    expect(s.contracts).toEqual({ desk: A.desk, splitter: A.splitter, burnPot: A.burnPot, token: A.token, explorer: "https://robinhoodchain.blockscout.com" });
    expect(s.links.pons).toBe("https://ponsfamily.com/launchpad/0xabc");
    // the pool is everything that belongs to it: what is in the desk and what is out with agents
    expect(s.stats).toMatchObject({ jobs: 2, settledJobs: 1, agents: 2, poolEth: 1.0008, outEth: 0.02, reserveEth: 0.20016, heldEth: 0.09, lostEth: 0, advancedEth: 0.05, supplyLeft: Number(MINTED / ETH) });
    expect(s.jobs.map((j) => j.id)).toEqual(["0002", "0001"]);
    expect(s.agents.map((a) => a.id)).toEqual([AGENT, HOUSE]);
  });

  it("points the buy button at the token's own page on Pons when no address was set, and at the set one when it was", async () => {
    const chain = new FakeChain();
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    expect((await state(r.engine)).links.pons).toBe("https://ponsfamily.com/launchpad/0x00000000000000000000000000000000000Be157");
    const set = await busy();
    expect((await state(set.engine)).links.pons).toBe("https://ponsfamily.com/launchpad/0xabc");
    // before there is a token there is nowhere to buy it
    const early = new FakeChain();
    early.token = null;
    const e = await rig("watch", { chain: early });
    await e.engine.watchOnce();
    expect((await state(e.engine)).links.pons).toBeNull();
  });

  it("writes a settled job the way the rulebook's example reads", async () => {
    const r = await busy();
    const { job, agent, events } = (await get(r.engine, `/v1/jobs/${r.settled}`)).body as { job: JobJson; agent: AgentJson; events: EventJson[] };
    expect(job).toMatchObject({
      id: "0001", n: 1, title: "", agentId: AGENT, customer: CUSTOMER, priceEth: 0.04, state: "settled", allowEarly: false, late: false,
      advance: { kind: "pool", eth: 0.02, feeEth: 0.0002 }, paidEth: 0.0192, feeEth: 0.0008,
    });
    expect(job.advances).toEqual([expect.objectContaining({ kind: "pool", eth: 0.02, feeEth: 0.0002 })]);
    expect(job.settledAt).toBeDefined();
    expect(job.backEth).toBeUndefined();
    expect(agent.id).toBe(AGENT);
    expect(events.map((e) => [e.kind, e.amount])).toEqual([["settled", "+0.0200 ETH"], ["delivered", "0.0400 ETH"], ["advanced", "0.0200 ETH"], ["locked", "0.0400 ETH"]]);
    // the job's number with or without its zeros
    expect(((await get(r.engine, "/v1/jobs/0001")).body.job as JobJson).n).toBe(1);
    expect((await get(r.engine, "/v1/jobs/99")).status).toBe(404);
  });

  it("lists one agent's jobs and one customer's jobs", async () => {
    const r = await busy();
    const other = r.chain.lock(wallet(0xc9), HOUSE, ETH / 100n);
    await r.engine.watchOnce();
    const of = async (q: string) => ((await get(r.engine, "/v1/jobs", q)).body.items as JobJson[]).map((j) => j.n);
    expect(await of("")).toEqual([other, 2, 1]);
    expect(await of(`customer=${CUSTOMER}`)).toEqual([2, 1]);
    // an address in any case finds the same wallet
    expect(await of(`customer=${customerKey.address}`)).toEqual([2, 1]);
    expect(await of(`agent=${HOUSE}`)).toEqual([other]);
    expect(await of(`agent=${AGENT}&customer=${wallet(0xc9)}`)).toEqual([]);
    expect(await of("customer=not-an-address")).toEqual([other, 2, 1]);
  });

  it("adds a job's draws together for the bill and keeps each one", async () => {
    const r = await busy();
    const job = (await get(r.engine, `/v1/jobs/${r.openJob}`)).body.job as JobJson;
    expect(job).toMatchObject({ state: "advanced", allowEarly: true, priceEth: 0.1, advance: { kind: "compute", eth: 0.03, feeEth: 0.0003 } });
    expect(job.advances.map((a) => [a.kind, a.eth])).toEqual([["customer", 0.01], ["compute", 0.02]]);
    expect(job.paidEth).toBeUndefined();
    expect(job.settledAt).toBeUndefined();
  });

  it("gives each agent its record, its limit and its score with the parts it is made of", async () => {
    const r = await busy();
    const { agent, jobs, events } = (await get(r.engine, `/v1/agents/${AGENT}`)).body as { agent: AgentJson; jobs: JobJson[]; events: EventJson[] };
    expect(agent).toMatchObject({
      id: AGENT, address: AGENT, named: false, house: false, does: "", settled: 1, settledAtHalf: 0, notDelivered: 0, unanswered: 0, customers: 0, onTimePct: 100,
      volumeEth: 0.04, feesPaidEth: 0.0008, bondEth: 0.02, drawnEth: 0.02, limitEth: 0.0208, canDrawEth: 0.0008, advancesRepaid: 1, advancesMissed: 0, barred: false,
    });
    // 0.0008 ETH of fees is 1 point, one job 10, one advance repaid 10; no customer has paid 0.001 ETH in fees yet
    expect(agent.score).toBe(21);
    expect(agent.scoreParts.map((p) => [p.points, p.max])).toEqual([[1, 350], [0, 250], [10, 200], [0, 100], [10, 100]]);
    expect(agent.scoreParts[0].value).toBe("0.0008 ETH");
    expect(agent.name).toBe(`${AGENT.slice(0, 6)}...${AGENT.slice(-4)}`);
    expect(jobs.map((j) => j.n)).toEqual([2, 1]);
    expect(events[0]).toMatchObject({ kind: "advanced", agentId: AGENT });
    const all = (await get(r.engine, "/v1/agents")).body.items as AgentJson[];
    expect(all.map((a) => [a.id, a.house, a.score])).toEqual([[AGENT, false, 21], [HOUSE, true, 0]]);
  });

  it("prints the ledger in words, newest first, a page at a time, and filtered", async () => {
    const r = await busy();
    const short = `${AGENT.slice(0, 6)}...${AGENT.slice(-4)}`;
    const page = (await get(r.engine, "/v1/ledger", "limit=4")).body as { total: number; more: boolean; items: EventJson[] };
    expect(page.total).toBe(9);
    expect(page.more).toBe(true);
    expect(page.items.map((e) => [e.jobId, e.kind, e.text, e.amount])).toEqual([
      ["0002", "advanced", `${short} had its compute paid from the pool`, "0.0200 ETH"],
      ["0002", "advanced", `${short} drew an advance its customer allowed`, "0.0100 ETH"],
      ["0002", "locked", "a customer locked the payment", "0.1000 ETH"],
      ["0001", "settled", `${short} delivered, the pool was repaid`, "+0.0200 ETH"],
    ]);
    const older = (await get(r.engine, "/v1/ledger", `limit=10&before=${page.items[3].n}`)).body as { more: boolean; items: EventJson[] };
    expect(older.more).toBe(false);
    expect(older.items.map((e) => e.text)).toEqual([`${short} delivered, waiting for the customer`, `${short} drew an advance from the pool`, "a customer locked the payment", `${short} added to its bond`, "ETH was added to the pool"]);
    expect(older.items[4].amount).toBe("+1.0000 ETH");
    const advances = (await get(r.engine, "/v1/ledger", "show=advanced")).body as { total: number; items: EventJson[] };
    expect(advances.total).toBe(3);
    expect(advances.items.every((e) => e.kind === "advanced")).toBe(true);
    // a filter that is not one is ignored, never an error
    expect(((await get(r.engine, "/v1/ledger", "show=nonsense&limit=abc")).body as { total: number }).total).toBe(9);
  });

  it("says trading fees arrived in the pool, and writes a burn in tokens", async () => {
    const chain = new FakeChain();
    chain.trade(ETH);
    const r = await rig("live", { chain });
    await r.turn();
    chain.mine(1, 1800);
    await r.turn();
    await r.engine.watchOnce();
    const s = await state(r.engine);
    expect(s.events.map((e) => [e.kind, e.text, e.amount])).toEqual([
      ["burned", "bought back and burned", "100,000 $FACTOR"],
      ["pool_in", "trading fees arrived in the pool", "+0.1000 ETH"],
    ]);
    expect(s.burns).toEqual([expect.objectContaining({ n: 1, eth: 0.2, tokens: 100_000 })]);
    expect(s.stats).toMatchObject({ poolEth: 0.1, burnedTokens: 100_000, supplyLeft: 1_000_000_000 - 100_000, poolFromTradingEth: 0.1 });
    // the burn page's figures are the pot's own, as the chain has them
    expect(s.burn).toMatchObject({ count: 1, ethSpent: 0.2, everyMin: 30, smallestEth: 0.001 });
    expect(s.burn?.lastFeesAt).toEqual(expect.any(String)); // the fees that funded it arrived and were split
    expect(typeof s.burn?.bonded).toBe("boolean");
    expect(s.burn?.lastAt).toEqual(expect.any(String));
    const burns = (await get(r.engine, "/v1/burns")).body as { total: number; items: unknown[] };
    expect(burns.total).toBe(1);
  });

  it("words a job nobody took up differently from one an agent drew on and left", async () => {
    const chain = new FakeChain();
    chain.fund(ETH);
    chain.register(AGENT);
    chain.bond(AGENT, ETH);
    const ignored = chain.lock(CUSTOMER, AGENT, ETH / 100n, 3600);
    const taken = chain.lock(CUSTOMER, AGENT, ETH / 10n, 3600);
    chain.draw(taken, ETH / 20n, K.pool);
    chain.mine(1, 14 * 3600);
    const r = await rig("live", { chain });
    await r.turn();
    await r.engine.watchOnce();
    const lines = ((await get(r.engine, "/v1/ledger", "show=refunded")).body.items as EventJson[]).map((e) => [e.jobId, e.kind, e.text]);
    const short = `${AGENT.slice(0, 6)}...${AGENT.slice(-4)}`;
    expect(lines).toContainEqual([`000${ignored}`, "refunded", "the job was not taken up, the customer has it all back"]);
    expect(lines).toContainEqual([`000${taken}`, "refunded", `${short} did not deliver in time, the customer was refunded`]);
    expect(lines).toContainEqual([`000${taken}`, "not_repaid", `${short} did not deliver: its bond repaid the pool`]);
    const job = (await get(r.engine, `/v1/jobs/${taken}`)).body.job as JobJson;
    expect(job).toMatchObject({ state: "refunded", backEth: 0.1, notRepaidEth: 0.05 });
    const agent = (await get(r.engine, `/v1/agents/${AGENT}`)).body.agent as AgentJson;
    expect(agent).toMatchObject({ barred: true, score: 0, limitEth: 0, canDrawEth: 0, advancesMissed: 1, unanswered: 1, notDelivered: 1 });
  });
});

describe("the Desk on a working desk", () => {
  it("writes a credit file for each agent with a record and a reason for every advance, and the site is told them", async () => {
    const r = await busy();
    const e = r.engine as unknown as { sqlite: Database.Database; deskMind: DeskMind | null; api: EngineApi; view: () => EngineView };
    e.deskMind = new DeskMind(e.sqlite);
    await e.api.deskPass(e.view(), { openings: 15, files: 10, reasons: 10 });
    const d = e.deskMind;
    expect(d.latest("file", AGENT)?.text).toMatch(/1 job settled, 1 delivered on time and 0 late; 1 advance repaid\. Bond 0\.02 ETH/);
    expect(d.recent(50, ["reason"])).toHaveLength(3);
    const s = await state(r.engine);
    expect((s.agents.find((a) => a.id === AGENT) as AgentJson & { file?: { text: string } }).file?.text).toMatch(/may draw up to/);
    const advanced = s.events.filter((x) => x.kind === "advanced") as (EventJson & { why?: string })[];
    expect(advanced.length).toBeGreaterThan(0);
    expect(advanced.every((x) => typeof x.why === "string" && x.why.length > 20)).toBe(true);
    expect((s as unknown as { desk: { on: boolean; latest: unknown[] } }).desk).toMatchObject({ on: true });
    // nothing is written again while nothing changed
    expect(await e.api.deskPass(e.view(), { openings: 15, files: 10, reasons: 10 })).toBe(0);
  });
});

describe("names and titles, signed", () => {
  const nowS = (r: Rig) => r.chain.time;
  // each write from an address of its own, so that the limit on one address is not what these tests meet
  let callers = 0;
  const from = () => `10.0.0.${++callers}`;
  async function profile(r: Rig, over: Record<string, unknown> = {}, signer = agentKey) {
    const body = { address: AGENT, name: "lumen-07", does: "Summarises long documents and contracts", at: nowS(r), ...over } as { address: string; name: string; does: string; at: number };
    const signature = await signer.signMessage({ message: profileMessage(body.address, body.name, body.does, body.at) });
    return r.engine.post("/v1/agents/profile", { ...body, signature }, from());
  }
  async function title(r: Rig, job: number, text: string, signer = customerKey, at = nowS(r)) {
    const signature = await signer.signMessage({ message: titleMessage(job, text, at) });
    return r.engine.post("/v1/jobs/title", { job, title: text, at, signature }, from());
  }

  it("lets an agent name itself with its own wallet, and shows the name everywhere", async () => {
    const r = await busy();
    expect((await profile(r))!).toEqual({ status: 200, body: { ok: true } });
    const agent = (await get(r.engine, "/v1/agents/lumen-07")).body.agent as AgentJson;
    expect(agent).toMatchObject({ id: AGENT, name: "lumen-07", named: true, does: "Summarises long documents and contracts" });
    const s = await state(r.engine);
    expect(s.agents[0].name).toBe("lumen-07");
    expect(s.events[0].text).toBe("lumen-07 had its compute paid from the pool");
  });

  it("refuses a profile signed by another wallet, an old signature, a taken name, and text that is not a plain line", async () => {
    const r = await busy();
    expect((await profile(r, {}, customerKey))!.status).toBe(401);
    expect((await profile(r, { at: nowS(r) - 3600 }))!.status).toBe(400);
    for (const name of ["ab", "Lumen", "lumen_07", "-lumen", "lumen--07", "0xabcdef", "admin", "your-agent", "the-agents-name", "a".repeat(25)]) expect((await profile(r, { name }))!.status, name).toBe(400);
    for (const does of ["", "x", "see https://evil.example", "visit evil.com now", "a\nb", "<b>bold</b>", "z".repeat(81)]) expect((await profile(r, { does }))!.status, does).toBe(400);
    expect((await profile(r))!.status).toBe(200);
    // the same signature again puts nothing back
    expect((await profile(r))!.status).toBe(409);
    // a wallet that never registered has no profile
    const stranger = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
    const body = { address: stranger.address.toLowerCase(), name: "nobody-01", does: "Nothing at all", at: nowS(r) };
    const signature = await stranger.signMessage({ message: profileMessage(body.address, body.name, body.does, body.at) });
    expect((await r.engine.post("/v1/agents/profile", { ...body, signature }, from()))!.status).toBe(404);
    // and one agent to a name: the house agent's wallet cannot take it (it has no key here, so the name check is asked directly)
    expect(r.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_profiles").get()).toEqual({ n: 1 });
  });

  it("lets an agent change its name later, and frees the old one", async () => {
    const r = await busy();
    await profile(r);
    r.chain.mine(1, 60);
    expect((await profile(r, { name: "lumen-08", does: "Summarises long documents" }))!.status).toBe(200);
    expect((await get(r.engine, "/v1/agents/lumen-07")).status).toBe(404);
    expect(((await get(r.engine, "/v1/agents/lumen-08")).body.agent as AgentJson).does).toBe("Summarises long documents");
  });

  it("lets the customer who locked a job say what it is about, and nobody else", async () => {
    const r = await busy();
    expect((await title(r, r.settled, "Summarise a 40-page service agreement", agentKey))!.status).toBe(401);
    expect((await title(r, 99, "No such job at all"))!.status).toBe(404);
    expect((await title(r, r.settled, "see http://x.io"))!.status).toBe(400);
    expect((await title(r, r.settled, "Summarise a 40-page service agreement"))!.status).toBe(200);
    expect(((await get(r.engine, `/v1/jobs/${r.settled}`)).body.job as JobJson).title).toBe("Summarise a 40-page service agreement");
    expect((await state(r.engine)).jobs.map((j) => j.title)).toEqual(["", "Summarise a 40-page service agreement"]);
  });

  it("lets the owner hide a name or a title, and nobody without the key", async () => {
    const key = "an-owner-key-of-enough-length-1234";
    const r = await busy({ ENGINE_ADMIN_KEY: key });
    await profile(r);
    await title(r, r.settled, "Summarise a 40-page service agreement");
    expect((await r.engine.post("/v1/admin/hide", { what: "agent", key: AGENT }, "1.1.1.1"))!.status).toBe(401);
    expect((await r.engine.post("/v1/admin/hide", { what: "agent", key: AGENT }, "1.1.1.1", "wrong-key-of-the-same-length-12345"))!.status).toBe(401);
    expect((await r.engine.post("/v1/admin/hide", { what: "agent", key: AGENT }, "1.1.1.1", key))!.status).toBe(200);
    expect((await r.engine.post("/v1/admin/hide", { what: "job", key: r.settled }, "1.1.1.1", key))!.status).toBe(200);
    const s = await state(r.engine);
    expect(s.agents[0]).toMatchObject({ named: false, does: "" });
    expect(s.jobs[1].title).toBe("");
    // shown again
    expect((await r.engine.post("/v1/admin/hide", { what: "agent", key: AGENT, hidden: false }, "1.1.1.1", key))!.status).toBe(200);
    expect((await state(r.engine)).agents[0].name).toBe("lumen-07");
    // with no key set on the host, nothing can be hidden by anyone
    const open_ = await busy();
    expect((await open_.engine.post("/v1/admin/hide", { what: "agent", key: AGENT }, "1.1.1.1", key))!.status).toBe(401);
  });

  it("takes a few signed writes a minute from one address, and no more", async () => {
    const r = await busy();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await r.engine.post("/v1/jobs/title", { job: 1, title: "x" }, "5.5.5.5"))!.status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // somebody else is not held up by it
    expect((await r.engine.post("/v1/jobs/title", { job: 1, title: "x" }, "6.6.6.6"))!.status).toBe(400);
    expect((await r.engine.post("/v1/jobs/title", "not an object", "7.7.7.7"))!.status).toBe(400);
    expect(await r.engine.post("/v1/state", {}, "7.7.7.7")).toBeNull();
  });

  it("keeps names and titles through a reindex", async () => {
    const r = await busy();
    await profile(r);
    await title(r, r.settled, "Summarise a 40-page service agreement");
    r.db.forgetChain();
    expect(r.db.count("desk_jobs")).toBe(0);
    await r.engine.watchOnce();
    const s = await state(r.engine);
    expect(s.agents[0].name).toBe("lumen-07");
    expect(s.jobs[1].title).toBe("Summarise a 40-page service agreement");
    expect(s.events).toHaveLength(9);
  });

  it("holds text to one plain line", () => {
    expect(oneLine("  Builds   a landing page ", 3, 80)).toBe("Builds a landing page");
    expect(oneLine("a‮b reversed", 3, 80)).toBeNull();
    expect(oneLine("zero​width", 3, 80)).toBeNull();
    expect(oneLine(42, 3, 80)).toBeNull();
  });
});

describe("the owner's health answer", () => {
  it("shows the desk, what is due, and never a secret", async () => {
    const key = "an-owner-key-of-enough-length-1234";
    const chain = new FakeChain();
    chain.fund(ETH);
    chain.register(AGENT);
    const id = chain.lock(CUSTOMER, AGENT, ETH / 10n, 3600);
    chain.deliver(id);
    const late = chain.lock(CUSTOMER, AGENT, ETH / 10n, 3600);
    const r = await rig("dry", { chain, more: { ENGINE_ADMIN_KEY: key, BOT_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" } });
    await r.engine.watchOnce();
    chain.mine(1, 25 * 3600);
    await r.engine.watchOnce();
    const h = await health(r.engine);
    expect(h).toMatchObject({ mode: "dry", state: "running", launched: true, gateway: A.gateway, contracts: { desk: A.desk, splitter: A.splitter, burnPot: A.burnPot } });
    expect(h.desk).toMatchObject({ pool: ETH.toString(), jobCount: 2, agents: 1, jobsKnown: 2, waitingToBeRead: 0, dueToSettle: 1, dueToRefund: 1 });
    expect(Object.keys(h.actions).sort()).toEqual(["burn", "claim_token", "collect", "erc8004", "refund_job", "relay", "retry_split", "return_compute", "settle_job", "skim", "sweep"]);
    expect(h.watchers.map((w: { watcher: string }) => w.watcher)).toEqual(["burnPot", "desk", "splitter", "token"]);
    const text = JSON.stringify(h) + JSON.stringify(await state(r.engine));
    expect(text).not.toContain(key);
    expect(text).not.toContain("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    expect(late).toBe(2);
  });

  it("warns loudly if the desk ever held less than its books say", async () => {
    const chain = new FakeChain();
    chain.fund(ETH);
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    expect((await health(r.engine)).warnings.join(" ")).not.toContain("LESS THAN ITS BOOKS");
    chain.pool += ETH; // the books now claim an ETH that is not there
    Object.defineProperty(chain, "deskBalance", { get: () => ETH });
    chain.mine();
    await r.engine.watchOnce();
    expect((await health(r.engine)).warnings.join(" ")).toContain("THE DESK HOLDS LESS THAN ITS BOOKS SAY");
  });
});
