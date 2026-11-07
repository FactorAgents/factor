// Factor everywhere, on the made-up chain: the answers any app reads (by address or ERC-8004 identity, one or many,
// signed and checked the way an app checks them, run out after ten minutes, held to a rate), Factor Connect (a
// marketplace registers, rotates its key, sets a hook, makes a hire link, the job locked on it is claimed only on its
// terms, and every step of the job reaches the hook as a webhook Factor signed, sent again when it is not taken), the
// owner's view and switches, and the Factor Score written to ERC-8004 (once there is work, again only when it moved
// meaningfully, the entry before revoked, the day's gas, the owner's switch).

import { createServer, type Server } from "node:http";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { answerSigner, eventsOf, hookProblem, hookSigned, opened, parseId, privateAddress, readEverywhere, type Sealed } from "../src/everywhere.js";
import { readScores, scoreFile, SCORE_DECIMALS, SCORE_TAG1 } from "../src/erc8004score.js";
import { IDENTITY_REGISTRY } from "../src/erc8004.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain } from "./chain/fake.js";
import { rig, TEST_KEY, type Rig } from "./chain/harness.js";

// anvil's public test keys: worth nothing anywhere
const agentKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const AGENT = agentKey.address.toLowerCase();
const OTHER = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6").address.toLowerCase();
const PRICE = ETH / 100n;
const ADMIN = "an-admin-key-of-twenty-four-or-more";
type Body = Record<string, any>;

const rigs: Rig[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
  for (const s of servers.splice(0)) await new Promise((res) => s.close(res));
});

async function desk(more: Record<string, string> = {}, chain = new FakeChain()): Promise<Rig> {
  chain.fund(ETH);
  for (const a of [AGENT, OTHER]) if (!chain.agents.has(a)) chain.register(a);
  const r = await rig("live", { chain, more: { EVERYWHERE: "on", ENGINE_ADMIN_KEY: ADMIN, CONNECT_LOCAL_HOOKS: "on", ...more } });
  rigs.push(r);
  await r.engine.watchOnce();
  return r;
}

const get = async (r: Rig, path: string, from = "1.2.3.4", key?: string): Promise<Body> => { const [p, q = ""] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q), from, key))!; return { status: a.status, ...(a.body as Body) }; };
const post = async (r: Rig, path: string, body: unknown, key?: string, from = "1.2.3.4", admin?: string): Promise<Body> => { const a = (await r.engine.post(path, body, from, admin, key))!; return { status: a.status, ...(a.body as Body) }; };
const signer = () => answerSigner({ BOT_PRIVATE_KEY: TEST_KEY })!.address;

/** A job locked for the agent, delivered and accepted, read by the engine. */
async function settle(r: Rig, customer = `0x${"b0e1".padStart(40, "0")}`, agent = AGENT): Promise<number> {
  const id = r.chain.lock(customer, agent, PRICE);
  r.chain.deliver(id);
  r.chain.accept(id);
  await r.engine.watchOnce();
  return id;
}

/** A hook on this machine: what it was sent, and what it answers. */
async function hook(answer = (): number => 200): Promise<{ url: string; got: { body: string; headers: Record<string, string | string[] | undefined> }[] }> {
  const got: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { got.push({ body, headers: req.headers }); res.writeHead(answer()); res.end("ok"); });
  });
  servers.push(s);
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", res));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}/factor`, got };
}

describe("the switches and the words", () => {
  it("is off unless EVERYWHERE=on; bad values are said; the key is the owner's or derived for this use alone", () => {
    expect(readEverywhere({})).toMatchObject({ enabled: false, perMinute: 120, site: "https://factoragents.fun", connect: { most: 500, registerPerHour: 3, ticketsPerHour: 200, localHooks: false } });
    const problems: string[] = [];
    readEverywhere({ EVERYWHERE: "yes", EVERYWHERE_PER_MIN: "0", EVERYWHERE_SIGNING_KEY: "0x12" }, problems);
    expect(problems).toHaveLength(3);
    const own = answerSigner({ EVERYWHERE_SIGNING_KEY: "0x" + "11".repeat(32), BOT_PRIVATE_KEY: TEST_KEY })!;
    expect(own.address).toBe(privateKeyToAccount(`0x${"11".repeat(32)}`).address.toLowerCase());
    const derived = answerSigner({ BOT_PRIVATE_KEY: TEST_KEY })!;
    // never the gas wallet's own key, and never the record's
    expect(derived.address).not.toBe(privateKeyToAccount(TEST_KEY).address.toLowerCase());
    expect(answerSigner({})).toBeNull();
    expect(readScores({})).toMatchObject({ enabled: false, step: 25, everyH: 24, perPass: 3, gasDayWei: 500_000_000_000_000n });
  });

  it("an agent is named by its address, its name, or its ERC-8004 identity in any of the standard's ways", () => {
    expect(parseId(AGENT.toUpperCase().replace("0X", "0x"))).toEqual({ kind: "address", address: AGENT });
    expect(parseId("report-lead")).toEqual({ kind: "name", name: "report-lead" });
    expect(parseId("8004:42")).toEqual({ kind: "erc8004", agentId: "42" });
    expect(parseId("erc8004:0042")).toEqual({ kind: "erc8004", agentId: "42" });
    expect(parseId(`eip155:4663:${IDENTITY_REGISTRY}:7`)).toEqual({ kind: "erc8004", agentId: "7" });
    expect(parseId("<script>")).toBeNull();
  });

  it("a hook must be https on a public address, and the name is looked up so it cannot point inside", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.8", "172.20.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(privateAddress(ip)).toBe(true);
    expect(privateAddress("93.184.216.34")).toBe(false);
    const pub = async () => ["93.184.216.34"], inside = async () => ["10.0.0.5"];
    expect(await hookProblem("https://market.example/hooks/factor", { localHooks: false, resolve: pub })).toBeNull();
    expect(await hookProblem("http://market.example/hooks", { localHooks: false, resolve: pub })).toMatch(/https/);
    expect(await hookProblem("https://market.example/hooks", { localHooks: false, resolve: inside })).toMatch(/private/);
    expect(await hookProblem("https://169.254.169.254/latest", { localHooks: false })).toMatch(/private/);
    expect(await hookProblem("https://user:pw@market.example/", { localHooks: false, resolve: pub })).toMatch(/password/);
    expect(await hookProblem("https://market.example:8443/", { localHooks: false, resolve: pub })).toMatch(/port/);
    expect(await hookProblem("https://intranet/", { localHooks: false, resolve: pub })).toMatch(/public name/);
    expect(await hookProblem("http://127.0.0.1:9999/x", { localHooks: false })).toMatch(/https/);
    expect(await hookProblem("http://127.0.0.1:9999/x", { localHooks: true })).toBeNull();
  });

  it("CONNECT_LOCAL_HOOKS is refused on an engine that sends, with a real node", () => {
    const keep = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const p: string[] = [];
      readEverywhere({ CONNECT_LOCAL_HOOKS: "on", ENGINE_MODE: "live", FACTOR_RPC_URLS: "https://rpc.mainnet.chain.robinhood.com" }, p);
      expect(p.join()).toMatch(/CONNECT_LOCAL_HOOKS/);
      const q: string[] = [];
      readEverywhere({ CONNECT_LOCAL_HOOKS: "on", ENGINE_MODE: "watch", FACTOR_RPC_URLS: "https://rpc.mainnet.chain.robinhood.com" }, q);
      expect(q).toHaveLength(0);
    } finally {
      process.env.VITEST = keep;
    }
  });
});

describe("the answers", () => {
  it("off unless it is on: the about says so and an agent is not answered", async () => {
    const r = await desk({ EVERYWHERE: "" });
    expect(await get(r, "/v1/everywhere")).toMatchObject({ status: 200, enabled: false, signer: null });
    expect((await get(r, `/v1/everywhere/agent/${AGENT}`)).status).toBe(503);
    expect((await get(r, "/v1/state")).everywhere).toMatchObject({ enabled: false });
  });

  it("one agent, signed: the app checks the signature against the signer it keeps, and a changed word or a run-out answer fails", async () => {
    const r = await desk();
    await settle(r);
    const about = await get(r, "/v1/everywhere");
    expect(about).toMatchObject({ enabled: true, signer: signer(), scheme: "eip191", holdsS: 600, mostAtOnce: 25, chainId: 4663 });
    const a = await get(r, `/v1/everywhere/agent/${AGENT}`);
    expect(a).toMatchObject({ status: 200, scheme: "eip191", signer: signer() });
    const got = await opened<Body>(a as unknown as Sealed, signer(), r.chain.time);
    expect(got.ok).toBe(true);
    const d = (got as { data: Body }).data;
    expect(d).toMatchObject({ v: 1, kind: "factor.agent", chainId: 4663, desk: A.desk, agent: { address: AGENT, named: false, factorOwn: false, erc8004: null }, score: { value: 10, of: 1000, barred: false }, record: { settled: 1, settledAtHalf: 0, refunded: 0 }, line: null, guarantee: null });
    expect(d.expiresAt - d.issuedAt).toBe(600);
    expect(d.hire).toBe(`https://factoragents.fun/hire?agent=${AGENT}`);
    expect(d.score.check).toContain(`score(${AGENT})`);
    // a word changed, another signer, a run-out answer
    expect((await opened({ ...(a as unknown as Sealed), answer: (a.answer as string).replace('"settled":1', '"settled":9') }, signer(), r.chain.time)).ok).toBe(false);
    expect((await opened(a as unknown as Sealed, OTHER, r.chain.time)).ok).toBe(false);
    expect(await opened(a as unknown as Sealed, signer(), r.chain.time + 601)).toMatchObject({ ok: false, why: /run out/ });
    // nobody: said in words
    expect(await get(r, `/v1/everywhere/agent/0x${"9".repeat(40)}`)).toMatchObject({ status: 404, error: /has not registered/ });
    expect(await get(r, "/v1/everywhere/agent/nobody-here")).toMatchObject({ status: 404, error: /no agent is called/ });
  });

  it("by an ERC-8004 identity: linked here, or found in the registry by its agentWallet", async () => {
    const r = await desk({ ERC8004: "on" });
    const id = r.chain.identity(AGENT);
    // not linked yet: the registry is asked
    let a = await get(r, `/v1/everywhere/agent/8004:${id}`);
    expect(a.status).toBe(200);
    expect(JSON.parse(a.answer).agent.address).toBe(AGENT);
    await r.turn(); // the registry read: linked
    r.chain.mine(1, 30);
    a = await get(r, `/v1/everywhere/agent/erc8004:${id}`);
    expect(JSON.parse(a.answer).agent.erc8004).toMatchObject({ agentId: String(id), registry: `eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` });
    expect(await get(r, "/v1/everywhere/agent/8004:999")).toMatchObject({ status: 404, error: /no ERC-8004 identity #999/ });
    const stranger = r.chain.identity("0x00000000000000000000000000000000000c0c0c");
    expect(await get(r, `/v1/everywhere/agent/8004:${stranger}`)).toMatchObject({ status: 404, error: /not an agent on Factor/ });
  });

  it("many at once: one signed answer, what is missing named, 25 at most", async () => {
    const r = await desk();
    const a = await get(r, `/v1/everywhere/agents?ids=${AGENT},${OTHER},0x${"9".repeat(40)}`);
    const d = (await opened<Body>(a as unknown as Sealed, signer(), r.chain.time) as { data: Body }).data;
    expect(d.kind).toBe("factor.agents");
    expect(d.items.map((x: Body) => x.agent.address)).toEqual([AGENT, OTHER]);
    expect(d.missing).toEqual([`0x${"9".repeat(40)}`]);
    expect((await get(r, `/v1/everywhere/agents?ids=${Array(26).fill(AGENT).join(",")}`)).status).toBe(400);
    expect((await get(r, "/v1/everywhere/agents")).status).toBe(400);
  });

  it("held to a rate from one caller, ten times more with a marketplace's key; the owner's switch stops it at once", async () => {
    const r = await desk({ EVERYWHERE_PER_MIN: "10" });
    for (let i = 0; i < 10; i++) expect((await get(r, `/v1/everywhere/agent/${AGENT}`, "5.5.5.5")).status).toBe(200);
    expect((await get(r, `/v1/everywhere/agent/${AGENT}`, "5.5.5.5")).status).toBe(429);
    expect((await get(r, `/v1/everywhere/agent/${AGENT}`, "6.6.6.6")).status).toBe(200);
    const key = (await post(r, "/v1/connect/register", { name: "Agent Bazaar", site: "https://bazaar.example" })).key;
    for (let i = 0; i < 30; i++) expect((await get(r, `/v1/everywhere/agent/${AGENT}`, "5.5.5.5", `Bearer ${key}`)).status).toBe(200);
    turn(r.db, "everywhere", false, "a look");
    expect((await get(r, `/v1/everywhere/agent/${AGENT}`, "7.7.7.7")).status).toBe(503);
    expect((await get(r, "/v1/state")).everywhere.enabled).toBe(false);
    expect((await post(r, "/v1/connect/register", { name: "Another", site: "https://another.example" }, undefined, "8.8.8.8")).status).toBe(503);
    turn(r.db, "everywhere", true);
    expect((await get(r, `/v1/everywhere/agent/${AGENT}`, "7.7.7.7")).status).toBe(200);
  });
});

describe("Factor Connect", () => {
  it("a marketplace registers once with no personal data, gets a key shown once, and only its fingerprint is kept", async () => {
    const r = await desk();
    for (const [body, why] of [[{ name: "x", site: "https://a.example" }, /name/], [{ name: "Agent Bazaar", site: "http://a.example" }, /site/], [{ name: "See https://x.y", site: "https://a.example" }, /name/], [{ name: "Agent Bazaar", site: "https://a.example", hook: "http://a.example/h" }, /https/]] as const) {
      expect(await post(r, "/v1/connect/register", body)).toMatchObject({ status: 400, error: why });
    }
    const m = await post(r, "/v1/connect/register", { name: "Agent Bazaar", site: "https://bazaar.example" });
    expect(m).toMatchObject({ status: 200, ok: true, name: "Agent Bazaar", hook: null });
    expect(m.key).toMatch(/^fc_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    const row = r.sqlite.prepare("SELECT * FROM connect_markets").get() as Body;
    expect(JSON.stringify(row)).not.toContain(m.key.split("_")[2]);
    // three an hour from one place
    await post(r, "/v1/connect/register", { name: "Two", site: "https://two.example" });
    await post(r, "/v1/connect/register", { name: "Three", site: "https://three.example" });
    expect((await post(r, "/v1/connect/register", { name: "Four", site: "https://four.example" })).status).toBe(429);
    expect((await post(r, "/v1/connect/register", { name: "Four", site: "https://four.example" }, undefined, "9.9.9.9")).status).toBe(200);
    // the key: no key, a wrong one, the right one; rotated, the old one stops at once
    expect((await post(r, "/v1/connect/me", {})).status).toBe(401);
    expect((await post(r, "/v1/connect/me", {}, m.key.slice(0, -2) + "AA")).status).toBe(401);
    expect(await post(r, "/v1/connect/me", {}, `Bearer ${m.key}`)).toMatchObject({ status: 200, name: "Agent Bazaar", signer: signer() });
    const fresh = await post(r, "/v1/connect/rotate", {}, m.key);
    expect((await post(r, "/v1/connect/me", {}, m.key)).status).toBe(401);
    expect((await post(r, "/v1/connect/me", {}, fresh.key)).status).toBe(200);
  });

  it("a hire link: the job's terms, checked; the customer locks on the site, and the job is the marketplace's only on those terms", async () => {
    const r = await desk();
    const { key } = await post(r, "/v1/connect/register", { name: "Agent Bazaar", site: "https://bazaar.example" });
    const ask = (b: Body) => post(r, "/v1/connect/hire", { agent: AGENT, priceWei: PRICE.toString(), title: "Summarise one contract", dueHours: 24, ...b }, key);
    expect(await ask({ agent: `0x${"9".repeat(40)}` })).toMatchObject({ status: 404 });
    expect(await ask({ priceWei: "1000" })).toMatchObject({ status: 400, error: /0.001 ETH/ });
    expect(await ask({ dueHours: 0 })).toMatchObject({ status: 400 });
    expect(await ask({ title: "go to https://x.y now" })).toMatchObject({ status: 400 });
    expect(await ask({ coverWei: (PRICE * 2n).toString() })).toMatchObject({ status: 400 });
    expect(await ask({ ref: "jane@example.com" })).toMatchObject({ status: 400, error: /personal/ });
    const t = await ask({ early: true, ref: "order-77", brief: "One contract, ten pages." });
    expect(t).toMatchObject({ status: 200, ok: true });
    expect(t.url).toBe(`https://factoragents.fun/hire?ticket=${t.ticket}`);
    const seen = await get(r, `/v1/connect/ticket/${t.ticket}`);
    expect(seen).toMatchObject({ status: 200, market: { name: "Agent Bazaar", site: "https://bazaar.example" }, agent: AGENT, priceWei: PRICE.toString(), dueHours: 24, early: true, title: "Summarise one contract", open: true, job: null });
    expect(JSON.stringify(seen)).not.toContain("order-77");
    // a job on other terms is not the marketplace's
    const wrongPrice = r.chain.lock(`0x${"c1".padStart(40, "0")}`, AGENT, PRICE * 2n, 86400, true);
    const noEarly = r.chain.lock(`0x${"c1".padStart(40, "0")}`, AGENT, PRICE, 86400, false);
    const wrongDue = r.chain.lock(`0x${"c1".padStart(40, "0")}`, AGENT, PRICE, 7 * 86400, true);
    const good = r.chain.lock(`0x${"c1".padStart(40, "0")}`, AGENT, PRICE, 86400, true);
    expect(await post(r, "/v1/connect/claim", { ticket: t.ticket, job: good })).toMatchObject({ status: 409, error: /not read that job/ });
    await r.engine.watchOnce();
    expect(await post(r, "/v1/connect/claim", { ticket: t.ticket, job: wrongPrice })).toMatchObject({ status: 400, error: /price/ });
    expect(await post(r, "/v1/connect/claim", { ticket: t.ticket, job: noEarly })).toMatchObject({ status: 400, error: /early/ });
    expect(await post(r, "/v1/connect/claim", { ticket: t.ticket, job: wrongDue })).toMatchObject({ status: 400, error: /due/ });
    expect(await post(r, "/v1/connect/claim", { ticket: t.ticket, job: good })).toMatchObject({ status: 200, ok: true, job: good, market: "Agent Bazaar" });
    expect(await post(r, "/v1/connect/claim", { ticket: t.ticket, job: good })).toMatchObject({ status: 200, already: true });
    expect(await post(r, "/v1/connect/claim", { ticket: t.ticket, job: wrongDue })).toMatchObject({ status: 409, error: /another job/ });
    expect((await get(r, `/v1/connect/ticket/${t.ticket}`))).toMatchObject({ open: false, job: good });
    // a link made before a job was locked cannot claim it, and a link runs out
    const t2 = await ask({ early: true });
    expect(await post(r, "/v1/connect/claim", { ticket: t2.ticket, job: wrongPrice })).toMatchObject({ status: 400 });
    r.chain.mine(1, 49 * 3600);
    const late = r.chain.lock(`0x${"c1".padStart(40, "0")}`, AGENT, PRICE, 86400, true);
    await r.engine.watchOnce();
    expect(await post(r, "/v1/connect/claim", { ticket: t2.ticket, job: late })).toMatchObject({ status: 400, error: /ran out/ });
  });

  it("every step of the job reaches the marketplace's hook as a webhook Factor signed, in order, once each", async () => {
    const r = await desk();
    const h = await hook();
    const { key } = await post(r, "/v1/connect/register", { name: "Agent Bazaar", site: "https://bazaar.example", hook: h.url });
    const t = await post(r, "/v1/connect/hire", { agent: AGENT, priceWei: PRICE.toString(), title: "Summarise one contract", dueHours: 24, ref: "order-77" }, key);
    const job = r.chain.lock(`0x${"c1".padStart(40, "0")}`, AGENT, PRICE, 86400, false);
    await r.engine.watchOnce();
    await post(r, "/v1/connect/claim", { ticket: t.ticket, job });
    await r.engine.connect!.pass();
    r.chain.deliver(job);
    await r.engine.watchOnce();
    await r.engine.connect!.pass();
    r.chain.accept(job);
    await r.engine.watchOnce();
    await r.engine.connect!.pass();
    await r.engine.connect!.pass();
    expect(h.got.map((x) => x.headers["x-factor-event"])).toEqual(["job.locked", "job.delivered", "job.paid"]);
    for (const g of h.got) {
      expect(g.headers["x-factor-signer"]).toBe(signer());
      expect(await hookSigned(g.body, String(g.headers["x-factor-signature"]), signer())).toBe(true);
      expect(await hookSigned(g.body.replace("order-77", "order-78"), String(g.headers["x-factor-signature"]), signer())).toBe(false);
    }
    const paid = JSON.parse(h.got[2]!.body);
    expect(paid).toMatchObject({ v: 1, event: "job.paid", ref: "order-77", ticket: t.ticket, chainId: 4663, job: { id: job, agent: AGENT, priceWei: PRICE.toString(), state: "paid", accepted: true } });
    expect((await post(r, "/v1/connect/me", {}, key)).hooks.map((x: Body) => x.status)).toEqual(["sent", "sent", "sent"]);
    // a ping, for a marketplace checking its side
    expect(await post(r, "/v1/connect/ping", {}, key)).toMatchObject({ status: 200, ok: true, sent: true, answered: 200 });
    expect(h.got.at(-1)!.headers["x-factor-event"]).toBe("ping");
  });

  it("with paid reviews on, the paid job's webhook says where its customer reviews it and until when", async () => {
    const r = await desk({ REVIEWS: "on" });
    const h = await hook();
    const { key } = await post(r, "/v1/connect/register", { name: "Agent Bazaar", site: "https://bazaar.example", hook: h.url });
    const t = await post(r, "/v1/connect/hire", { agent: AGENT, priceWei: PRICE.toString(), title: "Summarise one contract", dueHours: 24, ref: "order-79" }, key);
    const job = r.chain.lock(`0x${"c1".padStart(40, "0")}`, AGENT, PRICE, 86400, false);
    await r.engine.watchOnce();
    await post(r, "/v1/connect/claim", { ticket: t.ticket, job });
    await r.engine.connect!.pass();
    r.chain.deliver(job);
    r.chain.accept(job);
    await r.engine.watchOnce();
    await r.engine.connect!.pass();
    await r.engine.connect!.pass();
    const bodies = h.got.map((g) => JSON.parse(g.body));
    expect(bodies.find((b) => b.event === "job.locked").review).toBeUndefined();
    const paid = bodies.find((b) => b.event === "job.paid");
    expect(paid.review).toMatchObject({ page: `https://factoragents.fun/jobs/${String(job).padStart(4, "0")}#review`, stars: null });
    expect(Date.parse(paid.review.until)).toBeGreaterThan(r.chain.time * 1000 + 29 * 86_400_000);
  });

  it("a hook that does not take it is sent again later, then given up; a job that went straight to its end is told every step", async () => {
    const r = await desk();
    let answer = 500;
    const h = await hook(() => answer);
    const { key } = await post(r, "/v1/connect/register", { name: "Agent Bazaar", site: "https://bazaar.example", hook: h.url });
    const t = await post(r, "/v1/connect/hire", { agent: AGENT, priceWei: PRICE.toString(), title: "One job", dueHours: 24 }, key);
    const job = r.chain.lock(`0x${"c1".padStart(40, "0")}`, AGENT, PRICE, 86400, false);
    r.chain.deliver(job);
    r.chain.reject(job);
    await r.engine.watchOnce();
    await post(r, "/v1/connect/claim", { ticket: t.ticket, job });
    await r.engine.connect!.pass();
    expect(h.got.map((x) => x.headers["x-factor-event"])).toEqual(["job.locked", "job.delivered", "job.settled_at_half"]);
    await r.engine.connect!.pass(); // not due again yet
    expect(h.got).toHaveLength(3);
    r.chain.mine(1, 61);
    answer = 204;
    await r.engine.connect!.pass();
    expect(h.got).toHaveLength(6);
    const hooks = (await post(r, "/v1/connect/me", {}, key)).hooks as Body[];
    expect(hooks.every((x) => x.status === "sent" && x.tries === 2)).toBe(true);
    // one never taken: tried seven times over about a day, then failed
    answer = 500;
    await post(r, "/v1/connect/ping", {}, key);
    for (let i = 0; i < 8; i++) { r.chain.mine(1, 43_200); await r.engine.connect!.pass(); }
    expect((await post(r, "/v1/connect/me", {}, key)).hooks[0]).toMatchObject({ event: "ping", status: "failed", tries: 7, answered: 500 });
  });

  it("the owner lists every marketplace and blocks one; the connect switch stops Connect alone", async () => {
    const r = await desk();
    const { key, id } = await post(r, "/v1/connect/register", { name: "Agent Bazaar", site: "https://bazaar.example" });
    expect((await post(r, "/v1/admin/connect", { what: "list" }, undefined, "1.2.3.4", "wrong")).status).toBe(401);
    const list = await post(r, "/v1/admin/connect", { what: "list" }, undefined, "1.2.3.4", ADMIN);
    expect(list.items).toEqual([expect.objectContaining({ id, name: "Agent Bazaar", site: "https://bazaar.example", tickets: 0, jobs: 0, blocked: null })]);
    expect(JSON.stringify(list)).not.toContain("key_hash");
    expect(await post(r, "/v1/admin/connect", { what: "block", id, note: "sent spam" }, undefined, "1.2.3.4", ADMIN)).toMatchObject({ ok: true });
    expect(await post(r, "/v1/connect/me", {}, key)).toMatchObject({ status: 403, error: /sent spam/ });
    await post(r, "/v1/admin/connect", { what: "block", id, blocked: false }, undefined, "1.2.3.4", ADMIN);
    expect((await post(r, "/v1/connect/me", {}, key)).status).toBe(200);
    turn(r.db, "connect", false);
    expect((await post(r, "/v1/connect/me", {}, key)).status).toBe(503);
    expect((await get(r, `/v1/everywhere/agent/${AGENT}`)).status).toBe(200);
    expect((await get(r, "/v1/state")).everywhere.connect.enabled).toBe(false);
  });

  it("the events a job comes to, in order, from the desk's copy of it", () => {
    const j = { id: 1, state: 1, delivered_at: 0 } as never;
    expect(eventsOf(j)).toEqual(["job.locked"]);
    expect(eventsOf({ id: 1, state: 4, delivered_at: 5 } as never)).toEqual(["job.locked", "job.delivered", "job.paid"]);
    expect(eventsOf({ id: 1, state: 7, delivered_at: 0 } as never)).toEqual(["job.locked", "job.refunded"]);
    expect(eventsOf({ id: 1, state: 6, delivered_at: 0 } as never)).toEqual(["job.locked", "job.declined"]);
  });
});

describe("the Factor Score on ERC-8004", () => {
  const scores = (r: Rig, id: number) => r.chain.entriesOf(id, A.bot).filter((e) => e.tag1 === SCORE_TAG1);

  it("the file: the standard's fields and Factor's, the value with one decimal, its hash keccak256 of its words", () => {
    const a = scoreFile({ chainId: 4663, identity: IDENTITY_REGISTRY, agentId: "42", writer: A.bot, desk: A.desk, site: "https://factoragents.fun", agent: AGENT, name: "report-lead", score: 425, before: 390, block: 9, atS: 300 });
    expect(a.file).toMatchObject({ agentId: 42, value: 425, valueDecimals: 1, tag1: "factorScore", tag2: "", factor: { score: 425, of: 1000, reads: "42.5 of 100", before: 390, block: 9, page: "https://factoragents.fun/agents/report-lead" } });
    expect(a.hash).toBe(keccak256(toHex(a.body)));
    expect(JSON.stringify(JSON.parse(a.body))).toBe(a.body);
  });

  it("written once there is work, not again until it moves a step and a day has passed, and the entry before is revoked", async () => {
    const r = await desk({ ERC8004: "on", EVERYWHERE_SCORES: "on" });
    const id = r.chain.identity(AGENT);
    await r.turn(); // linked; no settled job yet: nothing written
    expect(scores(r, id)).toHaveLength(0);
    await settle(r);
    await r.turn();
    let s = scores(r, id);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ value: 10n, decimals: SCORE_DECIMALS, tag1: "factorScore", tag2: "" });
    const file = await get(r, "/v1/erc8004/score/1");
    expect(file).toMatchObject({ status: 200, value: 10, valueDecimals: 1, factor: { score: 10, before: null } });
    const { status: _s, ...body } = file;
    expect(s[0]!.hash).toBe(keccak256(toHex(JSON.stringify(body))));
    expect(s[0]!.uri).toBe("https://factoragents.fun/api/v1/erc8004/score/1");
    // the job entries are written beside it, under their own tag
    expect(r.chain.entriesOf(id, A.bot).filter((e) => e.tag1 === "factor")).toHaveLength(1);
    // moved by 20 (two more jobs): under a step, nothing
    await settle(r); await settle(r);
    await r.turn();
    expect(scores(r, id)).toHaveLength(1);
    // moved by 30, but within the day: nothing; after the day, written, and the one before revoked
    await settle(r);
    await r.turn();
    expect(scores(r, id)).toHaveLength(1);
    r.chain.mine(1, 25 * 3600);
    await r.engine.watchOnce();
    await r.turn();
    s = scores(r, id);
    expect(s.length).toBe(2);
    expect(Number(s[1]!.value)).toBeGreaterThanOrEqual(40);
    await r.turn();
    s = scores(r, id);
    expect(s[0]!.revoked).toBe(true);
    expect(s[1]!.revoked).toBeFalsy();
    const page = await get(r, `/v1/agents/${AGENT}`);
    expect(page.scoreOnChain).toMatchObject({ score: Number(s[1]!.value), tag1: "factorScore", agentId: String(id), written: 2 });
    expect((await get(r, "/v1/state")).everywhere.scores).toMatchObject({ enabled: true, entries: 2, agents: 1, tag1: "factorScore" });
  });

  it("nothing while it is off, or ERC8004 is off, or the owner stopped it; within the day's gas; never to an identity the gas wallet owns", async () => {
    const off = await desk({ ERC8004: "on" });
    const id = off.chain.identity(AGENT);
    await settle(off);
    await off.turn(); await off.turn();
    expect(scores(off, id)).toHaveLength(0);

    const r = await desk({ ERC8004: "on", EVERYWHERE_SCORES: "on" });
    const mine = r.chain.identity(AGENT);
    await settle(r);
    turn(r.db, "scores", false, "a look");
    await r.turn(); await r.turn();
    expect(scores(r, mine)).toHaveLength(0);
    turn(r.db, "scores", true);
    await r.turn();
    expect(scores(r, mine)).toHaveLength(1);

    const poor = await desk({ ERC8004: "on", EVERYWHERE_SCORES: "on", EVERYWHERE_SCORES_GAS_DAY_WEI: "1" });
    const pid = poor.chain.identity(AGENT);
    await settle(poor);
    await poor.turn(); await poor.turn();
    expect(scores(poor, pid)).toHaveLength(0);
  });
});
