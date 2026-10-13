// Factor's own agents, on the made-up chain, with a stand-in for the model maker: no model is ever called. What a
// customer's brief and an agent's published work are, how the three agents are put up, what each does with a job,
// when one declines, and what none of it ever says.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { KIND } from "../src/accounts.js";
import { houseSigner, readHouse, takeHouseSeed, type HouseSigner } from "../src/house/house.js";
import { FEEDS } from "../src/house/feeds.js";
import { SERVICES, tickersIn } from "../src/house/services.js";
import { briefMessage, briefText, proofOf } from "../src/profiles.js";
import { A, ETH, FakeChain, GOOD_SIGNATURE } from "./chain/fake.js";
import { rig, TEST_KEY, wallet, type Rig } from "./chain/harness.js";

const customerKey = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const CUSTOMER = customerKey.address.toLowerCase();
const MODEL_KEY = "sk-ant-test-0000-the-owners-key-with-the-model-maker";
const [page, reader, prices] = SERVICES as [typeof SERVICES[0], typeof SERVICES[0], typeof SERVICES[0]];

// the house agents' keys are stood in for: the made-up accounts take one fixed signature as their owner's
const signerFor = (name: string): HouseSigner => ({ address: wallet(0xa000 + SERVICES.findIndex((s) => s.name === name)), signTypedData: async () => GOOD_SIGNATURE });
const accountOf = (name: string) => FakeChain.accountOf({ kind: KIND.wallet, a: `0x${"0".repeat(24)}${signerFor(name).address.slice(2)}`, b: `0x${"0".repeat(64)}` });
const PAGE = accountOf("page-smith"), READER = accountOf("plain-reader"), PRICES = accountOf("price-desk");

// ---- the stand-in for the model maker ----

interface Seen { headers: IncomingMessage["headers"]; body: { model: string; max_tokens: number; system: string; messages: { content: string }[] } }
interface Model { url: string; seen: Seen[]; say: (seen: Seen) => string; fail: number }
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => { s.closeAllConnections(); s.close(() => done()); })));
});
const A_PAGE = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Tide Tea</title><style>body{font-family:system-ui}</style></head><body><h1>Tide Tea</h1><p>Loose leaf tea, posted weekly.</p><a href="#">Start</a></body></html>';
const A_READING = "IN ONE LINE\nA lease for two years.\n\nWHAT IT SAYS\n- The tenant pays monthly.\n\nWHAT TO WATCH FOR\n- It renews by itself.\n\nDATES AND AMOUNTS\n- Two years.";
async function model(): Promise<Model> {
  const m: Model = { url: "", seen: [], fail: 0, say: (s) => (s.body.system.includes("page-smith") ? A_PAGE : A_READING) };
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const seen = { headers: req.headers, body: JSON.parse(Buffer.concat(parts).toString("utf8")) as Seen["body"] };
      m.seen.push(seen);
      if (m.fail > 0) { m.fail--; res.writeHead(529, { "content-type": "application/json" }); return void res.end('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}'); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: m.say(seen) }], usage: { input_tokens: 2000, output_tokens: 1000 } }));
    });
  });
  servers.push(server);
  m.url = await new Promise((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  return m;
}

// ---- the engine with its agents put up ----

type Body = Record<string, any>;
const post = async (r: Rig, path: string, body: unknown, from = "1.1.1.1"): Promise<Body> => { const a = (await r.engine.post(path, body, from))!; return { status: a.status, ...(a.body as Body) }; };
const get = async (r: Rig, path: string): Promise<Body> => { const a = (await r.engine.handle(path))!; return { status: a.status, ...(a.body as Body) }; };
interface World extends Rig { m: Model }
/** One look by the agents, then the chain catching up: a few of these carry a job from locked to delivered. */
const round = async (w: Rig, n = 1) => { for (let i = 0; i < n; i++) { await w.engine.houseOnce(); await w.turn(); await w.engine.watchOnce(); } };

async function world(more: Record<string, string> = {}, key = true): Promise<World> {
  const m = await model();
  const chain = new FakeChain();
  chain.balances.set(A.bot, ETH);
  const w = await rig("live", { chain, houseSigners: signerFor, more: { HOUSE_MODE: "on", FACTOR_ACCOUNTS: A.accounts, HOUSE_UPSTREAM_URL: m.url, ...(key ? { ANTHROPIC_API_KEY: MODEL_KEY } : {}), ...more } });
  await w.engine.watchOnce();
  await round(w, 4);
  return { ...w, m };
}

const LEASE = `This lease is made between the landlord and the tenant for the flat at 4 Mill Lane. ${"The tenant pays the rent on the first of each month and keeps the flat in good order. ".repeat(4)}It runs for two years and renews by itself unless either side gives three months of notice.`;
/** A customer locks a job for an agent and signs its brief, as the site does. */
async function hire(w: Rig, agent: string, price: bigint, brief: string | null, title = "A job"): Promise<number> {
  const id = w.chain.lock(CUSTOMER, agent, price);
  await w.engine.watchOnce();
  if (brief !== null) {
    const at = w.chain.time;
    const signature = await customerKey.signMessage({ message: briefMessage(id, title, brief, at) });
    expect((await post(w, "/v1/jobs/brief", { job: id, title, brief, at, signature })).status).toBe(200);
  }
  return id;
}
const jobOf = (w: Rig, id: number) => get(w, `/v1/jobs/${id}`);

describe("the settings", () => {
  it("are off until they are switched on, and need a maker of accounts and a key to make the agents' keys from", () => {
    expect(readHouse({})).toMatchObject({ enabled: false, note: null, model: "claude-sonnet-5-5", dailyMicro: 10_000_000, payout: null, briefWaitS: 900 });
    expect(readHouse({ HOUSE_MODE: "on", BOT_PRIVATE_KEY: TEST_KEY }).note).toContain("FACTOR_ACCOUNTS is not set");
    expect(readHouse({ HOUSE_MODE: "on", FACTOR_ACCOUNTS: A.accounts }).note).toContain("no key");
    expect(readHouse({ HOUSE_MODE: "on", FACTOR_ACCOUNTS: A.accounts, BOT_PRIVATE_KEY: TEST_KEY, HOUSE_PAYOUT: A.admin, HOUSE_DAILY_USD: "3" })).toMatchObject({ enabled: true, payout: A.admin, dailyMicro: 3_000_000 });
    const problems: string[] = [];
    readHouse({ HOUSE_MODE: "on", HOUSE_PAYOUT: "nowhere", HOUSE_AGENTS_KEY: "short", HOUSE_DAILY_USD: "0" }, problems);
    expect(problems).toHaveLength(3);
  });

  it("make each agent a key of its own from one secret, which is never the gas wallet's own key", () => {
    const seed = takeHouseSeed({ BOT_PRIVATE_KEY: TEST_KEY })!;
    expect(seed).toMatch(/^0x[0-9a-f]{64}$/);
    expect(seed).not.toBe(TEST_KEY);
    expect(takeHouseSeed({ BOT_PRIVATE_KEY: TEST_KEY })).toBe(seed);
    const keys = SERVICES.map((s) => houseSigner(seed, s.name).address);
    expect(new Set(keys).size).toBe(3);
    expect(keys).not.toContain(privateKeyToAccount(TEST_KEY).address.toLowerCase());
    // the owner's own secret, when there is one, is what they are made from instead
    const own = `0x${"7".repeat(64)}` as Hex;
    expect(takeHouseSeed({ BOT_PRIVATE_KEY: TEST_KEY, HOUSE_AGENTS_KEY: own })).toBe(own);
    expect(houseSigner(own, "page-smith").address).not.toBe(keys[0]);
    expect(takeHouseSeed({})).toBeNull();
  });
});

describe("what each service makes of a brief and of an answer", () => {
  it("price-desk takes a ticker only when it is written as one", () => {
    expect(tickersIn("NVDA, TSLA and ETH please").map((f) => f.symbol)).toEqual(["NVDA", "TSLA", "ETH"]);
    expect(tickersIn("send me the link to meta and a coin").map((f) => f.symbol)).toEqual([]);
    expect(tickersIn("$link $Meta nvda NVDA NVDA.").map((f) => f.symbol)).toEqual(["LINK", "META", "NVDA"]);
    expect(tickersIn("BTC.B and BTC")).toHaveLength(2);
    expect(tickersIn("XYZQ ABCD")).toEqual([]);
    expect(prices.refuses("what is the market doing")).toContain("no ticker it knows");
    expect(prices.refuses("NVDA")).toBeNull();
    expect(FEEDS.length).toBeGreaterThan(40);
    expect(new Set(FEEDS.map((f) => f.address)).size).toBe(FEEDS.length);
    expect(new Set(FEEDS.map((f) => f.symbol)).size).toBe(FEEDS.length);
  });

  it("page-smith hands over a whole page with nothing in it that runs", () => {
    const dirty = `Here you go:\n\`\`\`html\n<!DOCTYPE html><html><head><script src="https://evil.example/x.js"></script><style>a{}</style></head><body onload="steal()"><a href="javascript:alert(1)" onclick='x()'>Go</a><script>alert(1)</script><p>Hello</p></body></html>\n\`\`\`\nHope it helps.`;
    const done = page.finish!(dirty) as { work: string };
    expect(done.work.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(done.work.endsWith("</html>")).toBe(true);
    expect(done.work).not.toMatch(/<script|onload|onclick|javascript:|evil\.example|Hope it helps/i);
    expect(done.work).toContain("<p>Hello</p>");
    expect(page.finish!("DECLINE: it asks visitors for their recovery phrase.")).toEqual({ decline: "it asks visitors for their recovery phrase." });
    expect(page.finish!("<!doctype html><html><body>cut off in the mid")).toEqual({ decline: "it could not make a whole page from this brief" });
    expect(page.finish!("I cannot help with that.")).toHaveProperty("decline");
    expect(page.refuses("a page")).toContain("too short");
    expect(page.ask!("Tide Tea", "x".repeat(50)).system).toContain("No JavaScript at all");
  });

  it("plain-reader needs a text to read, and says what its reading is not", () => {
    expect(reader.refuses("see https://example.org/terms")).toContain("paste the text itself");
    expect(reader.refuses(LEASE)).toBeNull();
    expect((reader.finish!(A_READING) as { work: string }).work.endsWith("It is not legal advice.")).toBe(true);
    expect(reader.finish!("DECLINE: this is a picture of a cat, not a text.")).toEqual({ decline: "this is a picture of a cat, not a text." });
    expect(reader.finish!("ok")).toHaveProperty("decline");
  });
});

describe("a brief, and the work shown", () => {
  it("a brief is the customer's, signed with the job's title, and anybody can read it on the job's page", async () => {
    const w = await rig("live", { more: { FACTOR_ACCOUNTS: A.accounts } });
    w.chain.register(wallet(0xa1));
    const id = w.chain.lock(CUSTOMER, wallet(0xa1), ETH / 100n);
    await w.engine.watchOnce();
    const at = w.chain.time;
    const brief = "Line one.\n\nLine two, with a link the agent will not open: https://example.org/terms";
    const sign = (t: string, b: string, when = at) => customerKey.signMessage({ message: briefMessage(id, t, b, when) });
    const stranger = privateKeyToAccount(TEST_KEY);
    expect(await post(w, "/v1/jobs/brief", { job: id, title: "A lease", brief, at, signature: await stranger.signMessage({ message: briefMessage(id, "A lease", brief, at) }) })).toMatchObject({ status: 401 });
    expect(await post(w, "/v1/jobs/brief", { job: id, title: "A lease", brief, at, signature: await sign("Another title", brief) })).toMatchObject({ status: 401 });
    expect(await post(w, "/v1/jobs/brief", { job: id, title: "A lease", brief, at, signature: await sign("A lease", brief) })).toMatchObject({ status: 200 });
    expect(await jobOf(w, id)).toMatchObject({ brief, work: null, job: { title: "A lease" } });
    // a newer one takes its place, an older signature cannot put the old one back, and a title is not needed
    expect((await post(w, "/v1/jobs/brief", { job: id, title: "", brief: "Shorter.", at: at + 5, signature: await sign("", "Shorter.", at + 5) })).status).toBe(200);
    expect((await post(w, "/v1/jobs/brief", { job: id, title: "A lease", brief, at, signature: await sign("A lease", brief) })).status).toBe(409);
    expect(await jobOf(w, id)).toMatchObject({ brief: "Shorter.", job: { title: "A lease" } });
    for (const bad of ["", "x".repeat(12_001), "hidden​text", "a\u0000b"]) expect((await post(w, "/v1/jobs/brief", { job: id, title: "", brief: bad, at: at + 9, signature: await sign("", bad, at + 9) })).status, JSON.stringify(bad.slice(0, 12))).toBe(400);
    expect((await post(w, "/v1/jobs/brief", { job: 99, title: "", brief, at, signature: await sign("", brief) })).status).toBe(404);
    expect(briefText("a\r\nb\tc")).toBe("a\nb\tc");
  });

  it("the work is shown only when its fingerprint is the proof on the chain, whoever sends it", async () => {
    const w = await rig("live", { more: { FACTOR_ACCOUNTS: A.accounts, ENGINE_ADMIN_KEY: "an-admin-key-of-24-characters" } });
    const agent = wallet(0xa1);
    w.chain.register(agent);
    const id = w.chain.lock(CUSTOMER, agent, ETH / 100n);
    await w.engine.watchOnce();
    const work = "The summary: twelve points and three risks.";
    expect(await post(w, "/v1/jobs/delivery", { job: id, work })).toMatchObject({ status: 409 });
    w.chain.deliver(id, proofOf(work));
    await w.engine.watchOnce();
    expect(await post(w, "/v1/jobs/delivery", { job: id, work: "Something else entirely." })).toMatchObject({ status: 400, error: "that is not what was delivered: its fingerprint is not the one the desk holds for this job" });
    expect((await jobOf(w, id)).work).toBeNull();
    expect((await post(w, "/v1/jobs/delivery", { job: id, work }, "9.9.9.9")).status).toBe(200);
    expect((await jobOf(w, id)).work).toMatchObject({ kind: "text", text: work });
    expect((await post(w, "/v1/jobs/delivery", { job: 99, work })).status).toBe(404);
    expect((await post(w, "/v1/jobs/delivery", { job: id, work: "x".repeat(200_001) })).status).toBe(400);
    // the owner can take a job's words off the site: its title, brief and work together
    expect((await w.engine.post("/v1/admin/hide", { what: "job", key: id }, "1.1.1.1", "an-admin-key-of-24-characters"))!.status).toBe(200);
    expect(await jobOf(w, id)).toMatchObject({ work: null, brief: null });
  });
});

describe("the three agents", () => {
  it("are put up by the engine itself: an account each, registered on the desk, under names nobody else can take", async () => {
    const w = await world();
    expect(w.chain.sends("create")).toHaveLength(3);
    const agents = (await get(w, "/v1/agents")).items as Body[];
    expect(agents.map((a) => a.name).sort()).toEqual(["page-smith", "plain-reader", "price-desk"]);
    for (const a of agents) expect(a).toMatchObject({ house: true, named: true });
    expect(agents.find((a) => a.name === "page-smith")).toMatchObject({ address: PAGE, does: page.does, service: { needs: page.needs, delivers: page.delivers, fromEth: 0.003 } });
    expect(agents.find((a) => a.name === "price-desk")!.service.fromEth).toBe(0.001);
    // nobody else can call an agent of theirs by one of those names
    const squatter = privateKeyToAccount(TEST_KEY);
    w.chain.register(squatter.address.toLowerCase());
    await w.engine.watchOnce();
    const at = w.chain.time;
    const { profileMessage } = await import("../src/profiles.js");
    const signature = await squatter.signMessage({ message: profileMessage(squatter.address.toLowerCase(), "page-smith", "Builds pages too", at) });
    expect(await post(w, "/v1/agents/profile", { address: squatter.address.toLowerCase(), name: "page-smith", does: "Builds pages too", at, signature })).toMatchObject({ status: 400, error: "that name is not available" });
    // a name follows the agent that does the work: were the agents' keys ever changed, the old address loses it
    const { Profiles } = await import("../src/profiles.js");
    const profiles = new Profiles(w.db, () => w.chain.time * 1000);
    profiles.house(wallet(0xdead), "page-smith", page.does);
    profiles.house(PAGE, "page-smith", page.does);
    expect(((await get(w, "/v1/agents/page-smith")).agent as Body).address).toBe(PAGE);
    expect(w.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_profiles WHERE address = ?").get(wallet(0xdead))).toEqual({ n: 0 });
    // set up once: later passes send nothing
    const sent = w.chain.sends().length;
    await round(w, 2);
    expect(w.chain.sends()).toHaveLength(sent);
    expect((await get(w, "/v1/health")).house).toMatchObject({ enabled: true, model: "claude-sonnet-5-5", agents: [{ name: "page-smith", address: PAGE, ready: true }, { name: "plain-reader", ready: true }, { name: "price-desk", ready: true }], delivered: 0 });
  });

  it("without a key for the model only the one that asks nobody is put up", async () => {
    const w = await world({}, false);
    expect(((await get(w, "/v1/agents")).items as Body[]).map((a) => a.name)).toEqual(["price-desk"]);
    const id = await hire(w, PRICES, ETH / 1000n, "NVDA and ETH");
    await round(w, 3);
    expect((await jobOf(w, id)).job.state).toBe("delivered");
    expect(w.m.seen).toHaveLength(0);
  });

  it("are not put up at all while the engine only reads, or the switch is off", async () => {
    const off = await rig("live", { more: { FACTOR_ACCOUNTS: A.accounts }, houseSigners: signerFor });
    await off.engine.watchOnce();
    await round(off, 2);
    expect(off.chain.sends()).toHaveLength(0);
    expect((await get(off, "/v1/health")).house).toMatchObject({ enabled: false, agents: [] });
    const watching = await rig("watch", { more: { HOUSE_MODE: "on", FACTOR_ACCOUNTS: A.accounts, BOT_PRIVATE_KEY: TEST_KEY }, houseSigners: signerFor });
    await watching.engine.watchOnce();
    await round(watching, 2);
    expect(watching.chain.sends()).toHaveLength(0);
  });
});

describe("a job", () => {
  it("for plain-reader: read once by the model, delivered with the work's fingerprint, and shown on the job's page", async () => {
    const w = await world();
    const id = await hire(w, READER, ETH / 500n, LEASE, "A lease for a flat");
    await round(w, 3);
    expect(w.m.seen).toHaveLength(1);
    const asked = w.m.seen[0]!;
    expect(asked.headers["x-api-key"]).toBe(MODEL_KEY);
    expect(asked.body).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 1800 });
    expect(asked.body.system).toContain("plain-reader");
    expect(asked.body.messages[0]!.content).toContain(LEASE);
    expect(asked.body.messages[0]!.content).toContain("A lease for a flat");
    const page_ = await jobOf(w, id);
    expect(page_.job).toMatchObject({ state: "delivered", agentId: READER, customer: CUSTOMER });
    expect(page_.work.kind).toBe("text");
    expect(page_.work.text).toContain("WHAT TO WATCH FOR");
    expect(page_.work.text.endsWith("It is not legal advice.")).toBe(true);
    // what is shown is what is on the chain
    expect(w.chain.jobs.get(id)!.proof).toBe(proofOf(page_.work.text));
    // nothing more is asked or sent for it afterwards
    const sent = w.chain.sends().length;
    await round(w, 3);
    expect(w.m.seen).toHaveLength(1);
    expect(w.chain.sends()).toHaveLength(sent);
    // 2,000 tokens in and 1,000 out on Sonnet: 1.4 cents, counted against the day
    expect((await get(w, "/v1/health")).house).toMatchObject({ delivered: 1, declined: 0, underWay: 0, spentTodayMicro: 14_000 });
    // the customer accepts, and the agent's account is paid like anybody's
    w.chain.accept(id);
    await w.engine.watchOnce();
    expect((await jobOf(w, id)).job).toMatchObject({ state: "settled", paidEth: 0.00196 });
  });

  it("for page-smith: a whole page, kept as a page", async () => {
    const w = await world();
    const id = await hire(w, PAGE, ETH / 200n, "A page for Tide Tea, a small shop that posts loose leaf tea every week. Calm, plain, for people who like tea.", "Tide Tea");
    await round(w, 3);
    const got = await jobOf(w, id);
    expect(got.job.state).toBe("delivered");
    expect(got.work).toMatchObject({ kind: "html", text: A_PAGE });
    expect(w.m.seen[0]!.body.max_tokens).toBe(8000);
    expect(w.chain.jobs.get(id)!.proof).toBe(proofOf(A_PAGE));
  });

  it("for price-desk: read from the feeds themselves, with no model asked", async () => {
    const w = await world();
    const nvda = FEEDS.find((f) => f.symbol === "NVDA")!, eth = FEEDS.find((f) => f.symbol === "ETH")!;
    w.chain.feedPrices.set(nvda.address, 22_415_000_000n);
    expect(eth.address).toBe("0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9"); // the same feed the engine prices burns with
    w.chain.ethUsd = 251_603_000_000n;
    w.chain.feedPrices.set(FEEDS.find((f) => f.symbol === "ENA")!.address, 21_300_000n);
    w.chain.feedAgeS = 3 * 3600;
    const id = await hire(w, PRICES, ETH / 1000n, "NVDA, ETH and ENA, and whatever XYZQ is");
    await round(w, 3);
    const text = (await jobOf(w, id)).work.text as string;
    expect(text).toMatch(/NVDA\s+\$224\.15\s+updated 3 hours before/);
    expect(text).toMatch(/ETH\s+\$2,516\.03/);
    expect(text).toMatch(/ENA\s+\$0\.213000/);
    expect(text).toContain("read at ");
    expect(text).toContain(nvda.address);
    expect(text).toContain("Between sessions and at weekends the last price stands");
    expect(text).not.toContain("XYZQ");
    expect(w.m.seen).toHaveLength(0);
    expect((await get(w, "/v1/health")).house.spentTodayMicro).toBe(0);
  });

  it("is delivered once even when the engine stops between doing the work and sending it", async () => {
    const w = await world();
    const id = await hire(w, READER, ETH / 500n, LEASE);
    // the work is done and kept, and the delivery is still only queued when everything stops
    await w.engine.houseOnce();
    expect(w.m.seen).toHaveLength(1);
    expect(w.sqlite.prepare("SELECT state FROM house_jobs WHERE job_id = ?").get(id)).toEqual({ state: "delivering" });
    await w.engine.stop();
    const again = await rig("live", { chain: w.chain, sqlite: w.sqlite, houseSigners: signerFor, more: { HOUSE_MODE: "on", FACTOR_ACCOUNTS: A.accounts, HOUSE_UPSTREAM_URL: w.m.url, ANTHROPIC_API_KEY: MODEL_KEY } });
    await again.engine.watchOnce();
    await round(again, 4);
    expect(w.m.seen).toHaveLength(1);
    expect(w.chain.sends("execute").filter((s) => String(s.tx.call!.args![0]).length > 0)).toBeDefined();
    expect((await jobOf(again, id)).job.state).toBe("delivered");
    expect(w.chain.jobs.get(id)!.proof).toBe(proofOf((await jobOf(again, id)).work.text));
  });

  it("is tried again when the model does not answer, and declined when it never does", async () => {
    const w = await world();
    w.m.fail = 1;
    const id = await hire(w, READER, ETH / 500n, LEASE);
    await round(w, 1);
    expect((await jobOf(w, id)).job.state).toBe("locked");
    w.wall.extra += 60_000;
    await round(w, 3);
    expect((await jobOf(w, id)).job.state).toBe("delivered");
    expect(w.m.seen).toHaveLength(2);

    w.m.fail = 99;
    const second = await hire(w, READER, ETH / 500n, LEASE);
    for (let i = 0; i < 4; i++) { await round(w, 2); w.wall.extra += 10 * 60_000; }
    const got = await jobOf(w, second);
    expect(got.job).toMatchObject({ state: "declined", backEth: 0.002 });
    expect(got.note).toBe("plain-reader could not do the work this time");
    expect(w.m.seen).toHaveLength(2 + 3);
  });
});

describe("a job it does not take", () => {
  it("is declined at once with the reason, and the customer has everything back", async () => {
    const w = await world();
    const before = w.chain.paid.get(CUSTOMER) ?? 0n;
    const cheap = await hire(w, PAGE, ETH / 1000n, "A page for Tide Tea, a small shop that posts loose leaf tea every week.");
    const vague = await hire(w, READER, ETH / 500n, "please read this https://example.org/terms");
    const noTicker = await hire(w, PRICES, ETH / 1000n, "how is the market");
    await round(w, 4);
    expect(await jobOf(w, cheap)).toMatchObject({ job: { state: "declined", backEth: 0.001 }, note: "the price is under what page-smith takes a job for (0.003 ETH)" });
    expect(await jobOf(w, vague)).toMatchObject({ job: { state: "declined" }, note: "there is no text to read in the brief: paste the text itself (it does not open links)" });
    expect(await jobOf(w, noTicker)).toMatchObject({ job: { state: "declined" }, note: "no ticker it knows was named: write them in capitals, like NVDA, TSLA, ETH" });
    expect((w.chain.paid.get(CUSTOMER) ?? 0n) - before).toBe(ETH / 1000n + ETH / 500n + ETH / 1000n);
    expect(w.m.seen).toHaveLength(0);
    expect((await get(w, "/v1/health")).house).toMatchObject({ declined: 3, delivered: 0 });
    // declining leaves no mark on an agent's record
    expect(((await get(w, "/v1/agents")).items as Body[]).every((a) => a.notDelivered === 0 && a.unanswered === 0)).toBe(true);
  });

  it("waits a while for the brief, and declines when none comes", async () => {
    const w = await world({ HOUSE_BRIEF_WAIT_S: "600" });
    const id = await hire(w, READER, ETH / 500n, null);
    await round(w, 2);
    expect((await jobOf(w, id)).job.state).toBe("locked");
    w.chain.mine(1, 601);
    await round(w, 3);
    expect(await jobOf(w, id)).toMatchObject({ job: { state: "declined" }, note: "no brief came with the job, and plain-reader cannot work without one" });
  });

  it("when the model itself says no, or the day's spending is used up", async () => {
    const w = await world({ HOUSE_DAILY_USD: "1" });
    w.m.say = () => "DECLINE: the brief asks for a page that passes itself off as a bank's sign-in.";
    const fake = await hire(w, PAGE, ETH / 200n, "A sign-in page that looks exactly like a well known bank, to collect what people type.");
    await round(w, 3);
    expect(await jobOf(w, fake)).toMatchObject({ job: { state: "declined" }, note: "the brief asks for a page that passes itself off as a bank's sign-in." });
    // what the day has cost so far is past the ceiling: the next job is not started
    w.sqlite.prepare("UPDATE house_jobs SET cost_micro = 1000000 WHERE job_id = ?").run(fake);
    const asked = w.m.seen.length;
    const late = await hire(w, READER, ETH / 500n, LEASE);
    await round(w, 3);
    expect(await jobOf(w, late)).toMatchObject({ job: { state: "declined" }, note: "plain-reader has taken all the jobs it takes in a day: hire it again tomorrow" });
    expect(w.m.seen).toHaveLength(asked);
    // the one that asks nobody still works
    const sheet = await hire(w, PRICES, ETH / 1000n, "NVDA");
    await round(w, 3);
    expect((await jobOf(w, sheet)).job.state).toBe("delivered");
  });
});

describe("what they earn, and what is never said", () => {
  it("goes on to the address the owner named, when there is enough of it", async () => {
    const w = await world({ HOUSE_PAYOUT: A.admin });
    const id = await hire(w, PRICES, ETH / 100n, "NVDA");
    await round(w, 3);
    w.chain.accept(id);
    // the made-up desk pays the agent's account; the account then holds what the job paid
    w.chain.balances.set(PRICES, (ETH / 100n) * 98n / 100n);
    w.wall.extra += 11 * 60_000;
    await round(w, 3);
    expect(w.chain.balances.get(A.admin)).toBe((ETH / 100n) * 98n / 100n);
    expect(w.chain.balances.get(PRICES)).toBe(0n);
    // under the least worth sending, it stays where it is
    w.chain.balances.set(PRICES, ETH / 1000n);
    w.wall.extra += 11 * 60_000;
    await round(w, 2);
    expect(w.chain.balances.get(PRICES)).toBe(ETH / 1000n);
  });

  it("the model's key and the agents' keys are in nothing the engine says or keeps", async () => {
    const w = await world();
    const id = await hire(w, READER, ETH / 500n, LEASE);
    await round(w, 3);
    w.m.fail = 5;
    await hire(w, PAGE, ETH / 200n, "A page for Tide Tea, a small shop that posts loose leaf tea every week.");
    await round(w, 2);
    const answers = [];
    for (const path of ["/v1/state", "/v1/health", "/v1/agents", `/v1/jobs/${id}`, "/v1/ledger"]) answers.push(JSON.stringify((await w.engine.handle(path))!.body));
    const tables = (w.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => JSON.stringify(w.sqlite.prepare(`SELECT * FROM ${t.name}`).all()));
    const all = [...answers, ...w.lines, ...tables].join("\n");
    expect(all).not.toContain(MODEL_KEY);
    expect(all).not.toContain("sk-ant");
    expect(all).not.toContain(TEST_KEY.slice(2));
    expect(all).not.toContain(takeHouseSeed({ BOT_PRIVATE_KEY: TEST_KEY })!.slice(2));
    expect(w.lines.join("\n")).toContain("[house] plain-reader delivered job");
  });
});
