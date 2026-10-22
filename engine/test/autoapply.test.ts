// Auto-apply, on the made-up chain, with a stand-in for the model maker: no model is ever called. An owner signs an
// agent's rules once; the engine finds the open jobs that fit; an agent Factor runs applies with its own key, is
// picked, draws the half up front its rules allow and delivers on its own; an agent that runs itself applies from its
// own program, held to the same rules. Then the limits, each on its own: who may set the rules, the work it takes, its
// price, its hours, its jobs at once, the hourly caps, its owner's own jobs, a paused agent, and the owner's switch.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { KIND } from "../src/accounts.js";
import { inHours, readAutoApply, rulesMessage, takesWork, type Rules } from "../src/autoapply.js";
import type { HouseSigner } from "../src/house/house.js";
import { hostedMessage } from "../src/house/hosted.js";
import { SERVICES } from "../src/house/services.js";
import { applyMessage, openJobIdOf, postMessage, type OpenJobText } from "../src/openjobs.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain, GOOD_SIGNATURE } from "./chain/fake.js";
import { rig, wallet, type Rig } from "./chain/harness.js";

// anvil's public test keys: worth nothing anywhere
const buyerKey = privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
const aKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const makerKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const strangerKey = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
const low = (k: { address: string }) => k.address.toLowerCase();
const BUYER = low(buyerKey), A1 = low(aKey), MAKER = low(makerKey);
const HOUR = 3600;
const MODEL_KEY = "sk-ant-test-0000-the-owners-key-with-the-model-maker";
type Key = typeof buyerKey;
type Body = Record<string, any>;

// the agents Factor runs: made-up accounts that take one fixed signature as their key's, for orders and for words
const numberOf = (name: string) => { const i = SERVICES.findIndex((s) => s.name === name); return i >= 0 ? 0xa000 + i : 0xb000 + [...name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 0xfff, 7); };
const signerFor = (name: string): HouseSigner => ({ address: wallet(numberOf(name)), signTypedData: async () => GOOD_SIGNATURE, signMessage: async () => GOOD_SIGNATURE });
const accountOf = (name: string) => FakeChain.accountOf({ kind: KIND.wallet, a: `0x${"0".repeat(24)}${signerFor(name).address.slice(2)}`, b: `0x${"0".repeat(64)}` });
const PAGE = accountOf("page-smith");

const PAGE_HTML = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Crumb</title><style>body{font-family:system-ui}</style></head><body><h1>Crumb bakery</h1><p>Bread every morning from seven.</p><a href="#">Find us</a></body></html>';
const servers: Server[] = [];
const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => { s.closeAllConnections(); s.close(() => done()); })));
});
async function model(): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: PAGE_HTML }], usage: { input_tokens: 2000, output_tokens: 1000 } })); });
  });
  servers.push(server);
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

const post = async (r: Rig, path: string, body: unknown, from = "1.2.3.4"): Promise<Body> => { const a = (await r.engine.post(path, body, from))!; return { status: a.status, ...(a.body as Body) }; };
const get = async (r: Rig, path: string): Promise<Body> => { const a = (await r.engine.handle(path))!; return { status: a.status, ...(a.body as Body) }; };
/** One look by the agents, then the chain catching up (and auto-apply's pass with it). */
const round = async (w: Rig, n = 1) => { for (let i = 0; i < n; i++) { await w.engine.houseOnce(); await w.turn(); await w.engine.watchOnce(); } };

/** A desk with Factor's own agents on it, open jobs and auto-apply on, and one agent with a wallet of its own. */
async function world(more: Record<string, string> = {}): Promise<Rig> {
  const url = await model();
  const chain = new FakeChain();
  chain.balances.set(A.bot, ETH);
  chain.register(A1);
  const w = await rig("live", { chain, houseSigners: signerFor, more: { HOUSE_MODE: "on", FACTOR_ACCOUNTS: A.accounts, HOUSE_UPSTREAM_URL: url, ANTHROPIC_API_KEY: MODEL_KEY, OPENJOBS: "on", AUTOAPPLY: "on", ...more } });
  rigs.push(w);
  await w.engine.watchOnce();
  await round(w, 8);
  return w;
}

const RULES: Rules = { on: true, takes: ["Landing pages"], words: [], floorWei: (ETH * 3n / 1000n).toString(), atOnce: 1, hours: null, early: true, pitch: "One page from your brief, delivered on its own" };
/** The rules, signed: by a key, or by an account of Factor's (the made-up chain takes its fixed signature). */
async function setRules(w: Rig, agent: string, o: Partial<Rules> = {}, by: { key?: Key; account?: string } = {}, at = w.chain.time): Promise<Body> {
  const r = { ...RULES, ...o };
  const who = by.key ? low(by.key) : by.account ?? agent;
  const signature = by.key ? await by.key.signMessage({ message: rulesMessage({ ...r, agent, by: who, at }) }) : GOOD_SIGNATURE;
  return post(w, "/v1/autoapply/rules", { agent, by: who, ...r, at, signature });
}

const BRIEF = "Our hours, the menu and where to find us, on one calm page. We open at seven and bake until noon.";
async function postJob(w: Rig, o: Partial<OpenJobText> & { key?: Key } = {}): Promise<string> {
  const key = o.key ?? buyerKey;
  const p: OpenJobText = { customer: low(key), price: o.price ?? (ETH / 250n).toString(), dueHours: o.dueHours ?? 24, early: o.early ?? true, title: o.title ?? "A one-page site for our bakery", brief: o.brief ?? BRIEF, closesAt: o.closesAt ?? w.chain.time + 6 * HOUR, pick: o.pick ?? { by: "customer" }, at: o.at ?? w.chain.time };
  const signature = await key.signMessage({ message: postMessage(p) });
  const a = await post(w, "/v1/openjobs/post", { customer: p.customer, price: p.price, dueHours: p.dueHours, early: p.early, title: p.title, brief: p.brief, closesAt: p.closesAt, pick: p.pick.by, at: p.at, signature });
  expect(a.status).toBe(200);
  return openJobIdOf(p);
}
const listing = async (w: Rig, id: string) => (await get(w, `/v1/openjobs/${id}`)).open as Body;
const kinds = async (w: Rig, agent: string) => ((await get(w, `/v1/autoapply/${agent}`)).log as Body[]).map((l) => l.kind).reverse();

/** An agent with a wallet of its own applies from its own program, saying the application is automatic. */
async function applyAuto(w: Rig, open: string, key: Key = aKey, pitch = ""): Promise<Body> {
  const at = w.chain.time;
  const signature = await key.signMessage({ message: applyMessage({ open, agent: low(key), pitch, at }) });
  return post(w, "/v1/openjobs/apply", { open, agent: low(key), pitch, at, signature, auto: true });
}

/** The customer locks the price for an agent on the chain and links it to the listing. */
async function lockFor(w: Rig, open: string, agent: string, early = true): Promise<number> {
  const { id, hash } = w.chain.lockTx(BUYER, agent, ETH / 250n, 24 * HOUR, early);
  await w.engine.watchOnce();
  expect((await post(w, "/v1/openjobs/hire", { open, job: id, lockTx: hash })).status).toBe(200);
  return id;
}

describe("the switch, the words and the matching", () => {
  it("is off unless AUTOAPPLY=on, six applications an hour for an agent and sixty for all by default", () => {
    expect(readAutoApply({})).toMatchObject({ enabled: false, perAgentHour: 6, perHour: 60 });
    expect(readAutoApply({ AUTOAPPLY: "on", AUTOAPPLY_PER_AGENT_HOUR: "2", AUTOAPPLY_PER_HOUR: "10" })).toMatchObject({ enabled: true, perAgentHour: 2, perHour: 10 });
    const problems: string[] = [];
    readAutoApply({ AUTOAPPLY_PER_AGENT_HOUR: "0", AUTOAPPLY_PER_HOUR: "x" }, problems);
    expect(problems).toHaveLength(2);
  });

  it("signs readable words, the same the kit and the site build", () => {
    expect(rulesMessage({ ...RULES, words: ["bakery", "menu"], agent: A1, by: MAKER, at: 1_800_000_000 })).toBe([
      "Factor: auto-apply rules for an agent",
      `agent: ${A1}`,
      `set by: ${MAKER}`,
      "on: yes",
      "takes: Landing pages",
      "words: bakery, menu",
      "from: 0.003 ETH a job",
      "at a time: up to 1 job",
      "hours: always",
      "early half: drawn up front when the customer allows it",
      "pitch: One page from your brief, delivered on its own",
      "at: 1800000000",
    ].join("\n"));
    const off = rulesMessage({ ...RULES, on: false, takes: [], atOnce: 3, hours: { from: 9, to: 17 }, early: false, pitch: "", agent: A1, by: A1, at: 1 });
    expect(off).toContain("on: no\ntakes: none\nwords: none\n");
    expect(off).toContain("at a time: up to 3 jobs\nhours: 09:00 to 17:00 UTC\nearly half: never\npitch: none\n");
  });

  it("finds the work by its kinds and its own words, where a word starts", () => {
    expect(takesWork({ takes: ["Landing pages"], words: [] }, "A one-page site for our bakery", "")).toBe(true);
    expect(takesWork({ takes: ["Landing pages"], words: [] }, "Our new website", "")).toBe(true);
    expect(takesWork({ takes: ["Landing pages"], words: [] }, "Check the figures in our note", "Forty of them")).toBe(false);
    expect(takesWork({ takes: [], words: ["bakery"] }, "Copy for a shop", "It is a bakery in town")).toBe(true);
    expect(takesWork({ takes: ["Summaries"], words: [] }, "Summarise our contract", "")).toBe(true);
    expect(takesWork({ takes: ["Code"], words: [] }, "A barcode sticker", "")).toBe(false);
    expect(takesWork({ takes: [], words: ["menu"] }, "Our menus", "")).toBe(true);
  });

  it("keeps to its hours, across midnight too", () => {
    const at = (h: number) => Date.UTC(2026, 9, 22, h, 30) / 1000;
    expect(inHours(null, at(3))).toBe(true);
    expect(inHours({ from: 9, to: 17 }, at(9))).toBe(true);
    expect(inHours({ from: 9, to: 17 }, at(17))).toBe(false);
    expect(inHours({ from: 22, to: 6 }, at(23))).toBe(true);
    expect(inHours({ from: 22, to: 6 }, at(5))).toBe(true);
    expect(inHours({ from: 22, to: 6 }, at(12))).toBe(false);
  });
});

describe("an agent Factor runs, on its own", () => {
  it("finds an open job that fits, applies with its own key, is picked, draws half up front and delivers", async () => {
    const w = await world();
    expect(await setRules(w, PAGE)).toMatchObject({ status: 200, ok: true, rules: { on: true, takes: ["Landing pages"], atOnce: 1, early: true } });
    expect((await get(w, "/v1/state")).autoApply).toEqual({ enabled: true, perAgentHour: 6, agents: 1, applied: 0 });
    const id = await postJob(w);
    await round(w);
    const l = await listing(w, id);
    expect(l.applicants).toHaveLength(1);
    expect(l.applicants[0]).toMatchObject({ name: "page-smith", house: true, auto: true, pitch: RULES.pitch });
    expect(await kinds(w, PAGE)).toEqual(["found", "applied"]);
    // a second job that fits: found, but it has one job on its hands, the most its rules allow
    const id2 = await postJob(w, { title: "A landing page for our tea shop", at: w.chain.time + 1 });
    await round(w);
    expect((await listing(w, id2)).applicants).toHaveLength(0);
    expect((await get(w, `/v1/autoapply/${PAGE}`)).fits).toEqual([]);
    // the customer picks it: the price is locked, and Factor's own job flow takes it from there
    const job = await lockFor(w, id, PAGE);
    await round(w, 6);
    const j = (await get(w, `/v1/jobs/${job}`)).job as Body;
    expect(j.state).toBe("delivered");
    expect(w.chain.jobs.get(job)!.early).toBe(ETH / 500n);
    const log = (await get(w, `/v1/autoapply/page-smith`)).log as Body[];
    expect(log.filter((x) => x.open === id).map((x) => x.kind).reverse()).toEqual(["found", "applied", "picked", "delivering", "delivered"]);
    expect(log.find((x) => x.kind === "picked")).toMatchObject({ note: `Picked: 0.004 ETH locked as job ${String(job).padStart(4, "0")}, half drawn up front`, job: { n: job } });
    expect(log.find((x) => x.kind === "delivering")!.note).toBe('Drew 0.002 ETH up front and is delivering "A one-page site for our bakery"');
    // delivered, its hands are free again: the second job is applied to on its own
    expect((await listing(w, id2)).applicants).toMatchObject([{ name: "page-smith", auto: true }]);
    expect(((await get(w, `/v1/autoapply/page-smith`)).log as Body[]).filter((x) => x.open === id2).map((x) => x.kind).reverse()).toEqual(["found", "applied"]);
    expect((await get(w, "/v1/state")).autoApply).toMatchObject({ agents: 1, applied: 2 });
  });

  it("draws nothing up front when its rules say never, and applies for nothing it would decline", async () => {
    const w = await world();
    await setRules(w, PAGE, { early: false, atOnce: 5 });
    const cheap = await postJob(w, { price: (ETH / 500n).toString() });
    const short = await postJob(w, { brief: "A page.", at: w.chain.time + 1 });
    const other = await postJob(w, { title: "Check every figure in our note", brief: "Forty figures, each against its source.", at: w.chain.time + 2 });
    const good = await postJob(w, { at: w.chain.time + 3 });
    await round(w);
    for (const id of [cheap, short, other]) expect((await listing(w, id)).applicants).toHaveLength(0);
    const job = await lockFor(w, good, PAGE);
    await round(w, 6);
    expect(w.chain.jobs.get(job)!).toMatchObject({ early: 0n });
    expect(((await get(w, `/v1/autoapply/${PAGE}`)).log as Body[]).find((x) => x.kind === "delivering")!.note).toBe('Delivering "A one-page site for our bakery"');
  });

  it("is set by its maker when it was made on the site, and never applies to its maker's own job, or while paused", async () => {
    const w = await world({ HOSTED_MODE: "on" });
    const at = w.chain.time;
    const instructions = "Build one plain landing page from the brief. Plain words, one call to action, nothing invented.";
    const signature = await makerKey.signMessage({ message: hostedMessage(MAKER, "crumb-pages", "Builds a landing page from a short brief", "0.002", MAKER, keccak256(toHex(instructions)), at) });
    expect((await post(w, "/v1/agents/make", { owner: MAKER, name: "crumb-pages", does: "Builds a landing page from a short brief", instructions, priceEth: "0.002", payout: MAKER, at, signature })).status).toBe(200);
    await round(w, 6);
    const HOSTED = accountOf("hosted 1");
    expect(await setRules(w, HOSTED, {}, { key: strangerKey })).toMatchObject({ status: 403 });
    expect(await setRules(w, HOSTED, {}, { key: makerKey })).toMatchObject({ status: 200 });
    expect((await get(w, `/v1/autoapply/${HOSTED}`))).toMatchObject({ runBy: "factor", setters: [MAKER], rules: { on: true } });
    const own = await postJob(w, { key: makerKey });
    await round(w);
    expect((await listing(w, own)).applicants).toHaveLength(0);
    // paused by its maker: nothing
    await w.db.q("UPDATE hosted_agents SET paused = 1 WHERE owner = ?").run(MAKER);
    const id = await postJob(w);
    await round(w);
    expect((await listing(w, id)).applicants).toHaveLength(0);
    await w.db.q("UPDATE hosted_agents SET paused = 0 WHERE owner = ?").run(MAKER);
    await round(w);
    expect((await listing(w, id)).applicants).toMatchObject([{ name: "crumb-pages", hosted: true, auto: true }]);
  });

  it("stops at once with the owner's switch, and every application by hand goes on", async () => {
    const w = await world();
    await setRules(w, PAGE);
    turn(w.db, "autoapply", false, "");
    const id = await postJob(w);
    await round(w, 2);
    expect((await listing(w, id)).applicants).toHaveLength(0);
    expect((await get(w, "/v1/state")).autoApply.enabled).toBe(false);
    expect((await applyAuto(w, id)).status).toBe(409);
    turn(w.db, "autoapply", true);
    await round(w);
    expect((await listing(w, id)).applicants).toMatchObject([{ name: "page-smith", auto: true }]);
  });
});

describe("an agent that runs itself", () => {
  it("sets its own rules; Factor finds the jobs, and its program applies under them, marked as on its own", async () => {
    const w = await world();
    expect(await setRules(w, A1, { words: ["bakery"], takes: [] }, { key: aKey })).toMatchObject({ status: 200 });
    const id = await postJob(w);
    const notIt = await postJob(w, { title: "Check every figure in our note", brief: "Forty figures, each against its source.", at: w.chain.time + 1 });
    await round(w);
    const mine = await get(w, `/v1/autoapply/${A1}`);
    expect(mine).toMatchObject({ runBy: "self", setters: [], fits: [id] });
    expect(((mine.log as Body[]).map((x) => x.kind))).toEqual(["found"]);
    // Factor never applies for it: it holds no key of the agent's
    expect((await listing(w, id)).applicants).toHaveLength(0);
    expect(await applyAuto(w, notIt)).toMatchObject({ status: 409, error: "its rules do not take this job: not work it takes" });
    expect(await applyAuto(w, id)).toMatchObject({ status: 200, rank: 1 });
    expect((await listing(w, id)).applicants).toMatchObject([{ address: A1, auto: true }]);
    expect(await kinds(w, A1)).toEqual(["found", "applied"]);
    // picked and locked: the story is followed from the desk, and its own program delivers
    const job = await lockFor(w, id, A1);
    w.chain.draw(job, ETH / 500n, 0);
    await round(w);
    w.chain.deliver(job);
    await round(w);
    expect(await kinds(w, A1)).toEqual(["found", "applied", "picked", "delivering", "delivered"]);
  });

  it("is held to its price, its hours, its jobs at once and the hourly caps", async () => {
    const w = await world({ AUTOAPPLY_PER_AGENT_HOUR: "2" });
    const hour = new Date(w.chain.time * 1000).getUTCHours();
    await setRules(w, A1, { atOnce: 5, hours: { from: (hour + 2) % 24, to: (hour + 4) % 24 }, floorWei: (ETH / 200n).toString() }, { key: aKey });
    const cheap = await postJob(w);
    expect(await applyAuto(w, cheap)).toMatchObject({ status: 409 });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await postJob(w, { price: (ETH / 100n).toString(), at: w.chain.time + i }));
    expect((await applyAuto(w, ids[0]!)).error).toContain("outside its hours");
    await setRules(w, A1, { atOnce: 5, floorWei: (ETH / 200n).toString() }, { key: aKey }, w.chain.time + 1);
    expect((await get(w, `/v1/autoapply/${A1}`)).fits).toEqual(ids);
    expect((await applyAuto(w, ids[0]!)).status).toBe(200);
    expect((await applyAuto(w, ids[1]!)).status).toBe(200);
    expect((await applyAuto(w, ids[2]!)).error).toContain("applied 2 times in the last hour");
    // two standing applications, and a rule of two at once: nothing more fits
    await setRules(w, A1, { atOnce: 2, floorWei: (ETH / 200n).toString() }, { key: aKey }, w.chain.time + 2);
    w.chain.time += 2 * HOUR;
    await w.engine.watchOnce();
    expect((await get(w, `/v1/autoapply/${A1}`)).fits).toEqual([]);
    expect((await applyAuto(w, ids[2]!)).error).toContain("2 jobs on its hands");
  });
});

describe("the rules themselves", () => {
  it("are signed by the agent or whoever runs it, and refused otherwise or when they make no sense", async () => {
    const w = await world();
    expect(await setRules(w, A1, {}, { key: strangerKey })).toMatchObject({ status: 403 });
    expect(await setRules(w, A1, {}, { account: A1 })).toMatchObject({ status: 401 });
    expect(await setRules(w, wallet(0xdead), {}, { key: aKey })).toMatchObject({ status: 409, error: "that agent has not registered on the desk" });
    expect(await setRules(w, A1, { takes: [], words: [] }, { key: aKey })).toMatchObject({ status: 400 });
    expect(await setRules(w, A1, { takes: ["Anything"] }, { key: aKey })).toMatchObject({ status: 400 });
    expect(await setRules(w, A1, { words: ["see https://x.example"] }, { key: aKey })).toMatchObject({ status: 400 });
    expect(await setRules(w, A1, { floorWei: "1000" }, { key: aKey })).toMatchObject({ status: 400 });
    expect(await setRules(w, A1, { atOnce: 11 }, { key: aKey })).toMatchObject({ status: 400 });
    expect(await setRules(w, A1, { hours: { from: 9, to: 9 } }, { key: aKey })).toMatchObject({ status: 400 });
    expect(await setRules(w, A1, {}, { key: aKey }, w.chain.time - 3600)).toMatchObject({ status: 400 });
    // the owner's switch for Factor's own agents: their rules are set by Factor's admin, or the agent's own key
    expect((await get(w, `/v1/autoapply/${PAGE}`))).toMatchObject({ runBy: "factor", setters: [A.admin], rules: null });
    const first = await setRules(w, A1, { on: false, takes: [] }, { key: aKey });
    expect(first).toMatchObject({ status: 200, rules: { on: false } });
    expect(await setRules(w, A1, { on: false, takes: [] }, { key: aKey })).toMatchObject({ status: 200 });
    expect((await get(w, "/v1/state")).autoApply).toMatchObject({ agents: 0 });
  });

  it("are refused while auto-apply is off, and an automatic application with them", async () => {
    const w = await world({ AUTOAPPLY: "" });
    expect(await setRules(w, A1, {}, { key: aKey })).toMatchObject({ status: 503 });
    const id = await postJob(w);
    expect(await applyAuto(w, id)).toMatchObject({ status: 409, error: "auto-apply is switched off for now" });
    expect((await get(w, "/v1/state")).autoApply).toEqual({ enabled: false, perAgentHour: 6, agents: 0, applied: 0 });
  });
});
