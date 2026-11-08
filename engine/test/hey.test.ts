// HEY builder records, against a stand-in for HEY Research Lab's API built from HEY's own answers (./hey-fixtures.ts): no
// request leaves the machine. The client (the x-hey-integration header on every call, the free key, answers kept and
// shared, the limit a minute, a 429 waited out, a slow or down HEY), the records (by name, $TICKER, HEY page or contract;
// HEY's facts as HEY gives them, and no market figure or score among them), the endpoints, an agent's link signed by its
// owner, the switch, the Factor Score untouched, and Copilot and Ask answering from it.

import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_VERSION, HEY_INTEGRATION, HeyAway, HeyClient, heyLinkMessage, HeyRecords, queryOf, readHey, recordText, type BuilderRecord, type HeyFetch } from "../src/hey.js";
import { profileMessage } from "../src/profiles.js";
import { ETH, FakeChain } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";
import { FACTOR_CARD, FACTOR_SNAPSHOT } from "./hey-fixtures.js";

// anvil's public test keys: worth nothing anywhere
const ownerKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const otherKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const A1 = ownerKey.address.toLowerCase(), B1 = otherKey.address.toLowerCase();
const ADMIN = "an-admin-key-of-twenty-four-or-more";
const TOKEN = "0x47c5ea4d85c4c1a81f26124580a80b0b7a581cc0";
const FOLLOWUP = "0x72a4fe4e9b83d5f6608ed1dac92ac0490f54cdcf";
const LONE = "0x00000000000000000000000000000000000c0de1";
type Body = Record<string, any>;

/** A project HEY has published with no token on the chain: read from its snapshot alone. */
const QUIET_SNAPSHOT = {
  identity: { slug: "quiet-tools", name: "Quiet Tools", projectKind: "OTHER", researchLevel: "LISTED", url: "https://heyresearch.xyz/project/quiet-tools" },
  build: { activityStatus: "DORMANT", activityMeasured: true, lastShippedAt: "2026-08-31T23:59:00.000Z", buildMomentum: 0 },
  evidenceSummary: { meaningfulEvents30d: 0 },
  latestChanges: { available: true, items: [{ id: "state:abc:activity_status:1", type: "build.dormant", occurredAt: null, precision: "OBSERVED", summary: "Activity status moved from Quiet to Dormant", evidence: [{ id: "state:abc", label: "HEY state record" }], source: "hey_state" }] },
  asOf: "2026-11-08T15:00:00.000Z",
  disclaimer: "Public, source-backed activity HEY recorded.",
};
const project = (name: string, slug: string, over: Record<string, unknown> = {}) => ({ type: "project", name, target: `/project/${slug}`, slug, status: "Dormant", ...over });

/** The stand-in: HEY's answers by path, every request seen with its headers. */
function fakeHey(o: { down?: boolean; slowMs?: number; status?: number; retryAfter?: string } = {}) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const state = { ...o };
  const answer = (path: string): { status: number; body: unknown } => {
    if (path.startsWith("/search/suggest?q=")) {
      const q = decodeURIComponent(path.slice(18)).toLowerCase();
      if (q === "factor" || q === "$factor") return { status: 200, body: { q, suggestions: [project("Factor", "factor", { symbol: "FACTOR", contract: TOKEN, status: "Shipping · Verified Builder" }), project("Factor MCP", "factordao-factor-mcp"), { type: "launch", name: "Open Factor", symbol: "FACTOR", contract: "0x53c5f0d3af00ac7a15b12868715b2c7ce0940f76" }] } };
      if (q === "quiet tools") return { status: 200, body: { q, suggestions: [project("Quiet Tools", "quiet-tools")] } };
      if (q === "twin") return { status: 200, body: { q, suggestions: [project("Twin", "twin-labs-twin"), project("Twin", "twin-org-twin"), project("Twins", "twins")] } };
      if (q === "fact") return { status: 200, body: { q, suggestions: [project("Factor", "factor", { symbol: "FACTOR", contract: TOKEN })] } };
      return { status: 200, body: { q, suggestions: [] } };
    }
    if (path === "/projects/factor/snapshot") return { status: 200, body: FACTOR_SNAPSHOT };
    if (path === "/projects/quiet-tools/snapshot") return { status: 200, body: QUIET_SNAPSHOT };
    if (path.startsWith("/projects/")) return { status: 404, body: { error: "not_found", message: "No published project has that slug.", retryable: false } };
    if (path === `/v1/builder?chain=4663&token=${TOKEN}`) return { status: 200, body: FACTOR_CARD };
    if (path === `/contracts/4663/${TOKEN}` || path === `/contracts/4663/${FOLLOWUP}`) return { status: 200, body: { chainId: 4663, address: path.slice(-42), associatedProject: { slug: "factor", name: "Factor", url: "https://heyresearch.xyz/project/factor" } } };
    if (path === `/contracts/4663/${LONE}`) return { status: 200, body: { chainId: 4663, address: LONE, associatedProject: null } };
    return { status: 404, body: { error: "not_found", message: "HEY holds no record of that.", retryable: false } };
  };
  const fetch: HeyFetch = async (url, init) => {
    seen.push({ url, headers: { ...init.headers } });
    if (state.down) throw new TypeError("fetch failed");
    if (state.slowMs) await new Promise((res, no) => { const t = setTimeout(res, state.slowMs); init.signal.addEventListener("abort", () => { clearTimeout(t); no(new Error("aborted")); }); });
    if (state.status) return { status: state.status, headers: { get: (n: string) => (n === "retry-after" ? state.retryAfter ?? null : null) }, json: async () => ({ error: "rate_limited" }) };
    const a = answer(url.replace(/^https:\/\/heyresearch\.xyz\/api/, ""));
    return { status: a.status, headers: { get: () => null }, json: async () => a.body };
  };
  return { fetch, seen, state };
}

/** Every request ever made to the stand-ins in this file, to check the header on each of them at the end. */
const everySeen: { url: string; headers: Record<string, string> }[][] = [];
const fake = (o: Parameters<typeof fakeHey>[0] = {}) => { const f = fakeHey(o); everySeen.push(f.seen); return f; };

function client(o: { env?: Record<string, string>; key?: string; f?: ReturnType<typeof fakeHey>; clock?: { t: number }; allowed?: () => boolean } = {}) {
  const f = o.f ?? fake();
  const clock = o.clock ?? { t: 1_800_000_000_000 };
  const c = new HeyClient(readHey({ HEY: "on", ...o.env }), { fetch: f.fetch, now: () => clock.t, key: () => o.key, allowed: o.allowed });
  return { c, f, clock, records: new HeyRecords(c) };
}

/** Every key of an object, all the way down: what a record carries, by name. */
const keysOf = (x: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(x)) for (const y of x) keysOf(y, out);
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { out.add(k); keysOf(v, out); }
  return out;
};

describe("the settings and the words", () => {
  it("is off unless HEY=on; the header names Factor and the engine's version; the limits hold to HEY's", () => {
    expect(readHey({})).toMatchObject({ enabled: false, base: "https://heyresearch.xyz/api", timeoutMs: 8000, freshMs: 600_000, perMinute: 60, integration: HEY_INTEGRATION });
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(ENGINE_VERSION).toBe(pkg.version);
    expect(HEY_INTEGRATION).toBe(`factor/${pkg.version}`);
    expect(readHey({ HEY: "on", HEY_PER_MIN: "120", HEY_CACHE_S: "60", HEY_API_URL: "http://127.0.0.1:9/api/" })).toMatchObject({ enabled: true, perMinute: 120, freshMs: 60_000, base: "http://127.0.0.1:9/api" });
    const problems: string[] = [];
    readHey({ HEY: "yes", HEY_PER_MIN: "500", HEY_CACHE_S: "5", HEY_API_URL: "http://example.com/api" }, problems);
    expect(problems).toHaveLength(4);
  });

  it("reads what a person types as a contract, a HEY page or words", () => {
    expect(queryOf("0x47C5eA4d85c4c1A81F26124580A80B0b7A581CC0")).toEqual({ kind: "contract", address: TOKEN });
    expect(queryOf("https://heyresearch.xyz/project/factor?utm_source=x")).toEqual({ kind: "slug", slug: "factor" });
    expect(queryOf("  $FACTOR ")).toEqual({ kind: "words", text: "$FACTOR" });
    expect([queryOf(""), queryOf("$$$"), queryOf("x".repeat(121)), queryOf(42)]).toEqual([null, null, null, null]);
  });

  it("signs readable words", () => {
    expect(heyLinkMessage({ agent: A1, project: "factor", at: 1_800_000_000 })).toBe(`Factor: link an agent to its maker's project on HEY\nagent: ${A1}\nproject: factor\nat: 1800000000`);
  });
});

describe("the client", () => {
  it("sends x-hey-integration on every call, and the free key only when one is set", async () => {
    const { c, f } = client();
    await c.get("/projects/factor/snapshot");
    expect(f.seen[0]!.headers).toEqual({ accept: "application/json", "x-hey-integration": HEY_INTEGRATION });
    const keyed = client({ key: "hey_free_key_123" });
    await keyed.c.get("/projects/factor/snapshot");
    expect(keyed.f.seen[0]!.headers).toMatchObject({ "x-hey-integration": HEY_INTEGRATION, authorization: "Bearer hey_free_key_123" });
    // a key that is not one is never sent
    const odd = client({ key: "two words\nhere" });
    await odd.c.get("/projects/factor/snapshot");
    expect(odd.f.seen[0]!.headers.authorization).toBeUndefined();
  });

  it("keeps an answer for HEY_CACHE_S, a not-found for two minutes, and shares a call asked for twice at once", async () => {
    const { c, f, clock } = client();
    const [a, b] = await Promise.all([c.get("/projects/factor/snapshot"), c.get("/projects/factor/snapshot")]);
    expect(f.seen).toHaveLength(1);
    expect(a.body).toBe(b.body);
    clock.t += 599_000;
    await c.get("/projects/factor/snapshot");
    expect(f.seen).toHaveLength(1);
    clock.t += 2_000;
    await c.get("/projects/factor/snapshot");
    expect(f.seen).toHaveLength(2);
    expect((await c.get("/projects/nope/snapshot")).status).toBe(404);
    clock.t += 60_000;
    await c.get("/projects/nope/snapshot");
    expect(f.seen).toHaveLength(3);
    clock.t += 61_000;
    await c.get("/projects/nope/snapshot");
    expect(f.seen).toHaveLength(4);
    expect(c.counts).toMatchObject({ calls: 4, kept: 2 });
  });

  it("makes HEY_PER_MIN calls a minute at most, and gives a kept answer meanwhile", async () => {
    const { c, f, clock } = client({ env: { HEY_PER_MIN: "2", HEY_CACHE_S: "60" } });
    await c.get("/projects/factor/snapshot");
    await c.get("/projects/quiet-tools/snapshot");
    await expect(c.get("/projects/other/snapshot")).rejects.toThrow(/enough for this minute/);
    expect(f.seen).toHaveLength(2);
    clock.t += 61_000;
    // the first answer is past its time and the minute is new: asked again
    await c.get("/projects/factor/snapshot");
    await c.get("/projects/quiet-tools/snapshot");
    const kept = await c.get("/projects/factor/snapshot");
    expect(kept.stale).toBe(false);
    clock.t += 61_000;
    await c.get("/projects/factor/snapshot");
    await c.get("/projects/quiet-tools/snapshot");
    // over the limit, with an answer kept from before: the kept one, marked stale
    clock.t += 1;
    const over = await c.get("/projects/other/snapshot").catch((e: unknown) => e);
    expect(over).toBeInstanceOf(HeyAway);
  });

  it("waits out a 429 for as long as retry-after says", async () => {
    const f = fake({ status: 429, retryAfter: "45" });
    const { c, clock } = client({ f });
    await expect(c.get("/projects/factor/snapshot")).rejects.toMatchObject({ retryAfterS: 45 });
    f.state.status = undefined;
    clock.t += 30_000;
    await expect(c.get("/projects/factor/snapshot")).rejects.toThrow(/wait a moment/);
    expect(f.seen).toHaveLength(1);
    clock.t += 16_000;
    expect((await c.get("/projects/factor/snapshot")).status).toBe(200);
    expect(f.seen).toHaveLength(2);
  });

  it("drops a call that takes too long, and gives the last answer, marked stale, while HEY is down", async () => {
    const slow = fake({ slowMs: 5_000 });
    const s = client({ f: slow, env: { HEY_TIMEOUT_S: "1" } });
    const t0 = Date.now();
    await expect(s.c.get("/projects/factor/snapshot")).rejects.toThrow(/did not answer in time/);
    expect(Date.now() - t0).toBeLessThan(3_000);
    const f = fake();
    const { c, clock } = client({ f });
    const first = await c.get("/projects/factor/snapshot");
    f.state.down = true;
    clock.t += 3_600_000;
    const again = await c.get("/projects/factor/snapshot");
    expect(again).toMatchObject({ status: 200, stale: true, at: first.at });
    await expect(c.get("/projects/quiet-tools/snapshot")).rejects.toThrow(/could not be reached/);
    f.state.down = false;
    f.state.status = 503;
    clock.t += 1_000;
    expect((await c.get("/projects/factor/snapshot")).stale).toBe(true);
    // past a day, an old answer is not given any more
    clock.t += 86_400_000;
    await expect(c.get("/projects/factor/snapshot")).rejects.toThrow(/answered 503/);
    expect(c.lastError?.message).toMatch(/503/);
  });

  it("asks HEY nothing while it is not allowed", async () => {
    const { c, f } = client({ allowed: () => false });
    await expect(c.get("/projects/factor/snapshot")).rejects.toThrow(/switched off/);
    expect(f.seen).toHaveLength(0);
  });
});

describe("builder records", () => {
  const card = FACTOR_CARD as unknown as Record<string, unknown>;

  it("by name: HEY's builder card, its facts under HEY's own names and as HEY gave them, with the source", async () => {
    const { records, f } = client();
    const r = (await records.lookup("Factor")) as BuilderRecord;
    expect(r).toMatchObject({ found: true, source: "HEY Research Lab", sourceUrl: "https://heyresearch.xyz/project/factor", badgeUrl: "https://heyresearch.xyz/api/badge/factor", from: "builder card", stale: false, integration: HEY_INTEGRATION, project: { slug: "factor", name: "Factor", symbol: "FACTOR", contract: TOKEN } });
    for (const k of ["verified_builder", "research_level", "hey_status", "hey_status_label", "hey_status_help", "last_activity_at", "meaningful_ships_30d", "latest_meaningful_ship", "latest_release", "latest_deployment", "repo_url", "token_verification", "as_of"] as const) expect(r.facts[k], k).toEqual(card[k]);
    expect(r.facts.latest_change).toEqual({ summary: FACTOR_CARD.latest_change.summary, occurred_at: FACTOR_CARD.latest_change.occurred_at, precision: FACTOR_CARD.latest_change.precision, evidence_id: FACTOR_CARD.latest_change.evidence_id, url: FACTOR_CARD.latest_change.url });
    expect(r.disclaimer).toBe(FACTOR_CARD.disclaimer);
    expect(r.read).toEqual(["https://heyresearch.xyz/api/projects/factor/snapshot", `https://heyresearch.xyz/api/v1/builder?chain=4663&token=${TOKEN}`]);
    expect(f.seen.map((x) => x.url)).toEqual(["https://heyresearch.xyz/api/search/suggest?q=Factor", ...r.read]);
  });

  it("carries no market figure, no valuation and none of HEY's own computed figures: a builder record only", async () => {
    const { records } = client();
    const r = await records.lookup("factor");
    const keys = [...keysOf(r)];
    for (const banned of [/market/i, /momentum/i, /valuation/i, /discovery/i, /liquidity/i, /price/i, /volume/i, /rank/i, /score/i, /signal/i]) expect(keys.filter((k) => banned.test(k)), String(banned)).toEqual([]);
  });

  it("by $TICKER, by its HEY page, by its token and by another contract HEY ties to it: the same project", async () => {
    const { records } = client();
    for (const q of ["$FACTOR", "https://heyresearch.xyz/project/factor", TOKEN.toUpperCase().replace("0X", "0x"), FOLLOWUP]) {
      const r = await records.lookup(q);
      expect(r, q).toMatchObject({ found: true, project: { slug: "factor", contract: TOKEN } });
    }
  });

  it("a project with no token: its snapshot's facts, HEY's status said as HEY's pages say it", async () => {
    const { records } = client();
    const r = (await records.lookup("Quiet Tools")) as BuilderRecord;
    expect(r).toMatchObject({ found: true, from: "snapshot", disclaimer: null, project: { slug: "quiet-tools", name: "Quiet Tools", symbol: null, contract: null } });
    expect(r.facts).toMatchObject({ verified_builder: false, research_level: "LISTED", hey_status: "DORMANT", hey_status_label: "Dormant", meaningful_ships_30d: 0, last_activity_at: "2026-08-31T23:59:00.000Z", latest_meaningful_ship: null });
    expect(r.facts.latest_change).toMatchObject({ summary: "Activity status moved from Quiet to Dormant", precision: "OBSERVED" });
  });

  it("not on HEY: several of one name, none, a contract HEY does not know or ties to nothing; HEY away", async () => {
    const { records, f } = client();
    const twin = await records.lookup("twin");
    expect(twin).toMatchObject({ found: false, why: expect.stringMatching(/2 projects called twin/) });
    expect(!twin.found && twin.candidates?.map((c) => c.slug)).toEqual(["twin-labs-twin", "twin-org-twin"]);
    const fact = await records.lookup("fact");
    expect(fact).toMatchObject({ found: false, candidates: [{ slug: "factor", sourceUrl: "https://heyresearch.xyz/project/factor" }] });
    expect(await records.lookup("nothing at all")).toMatchObject({ found: false, why: "HEY has no project called nothing at all" });
    expect(await records.lookup("0x000000000000000000000000000000000000dead")).toMatchObject({ found: false, why: expect.stringMatching(/holds no record/) });
    expect(await records.lookup(LONE)).toMatchObject({ found: false, why: expect.stringMatching(/ties it to no project/) });
    expect(await records.lookup("$$")).toMatchObject({ found: false, why: expect.stringMatching(/^name a project/) });
    f.state.down = true;
    expect(await records.lookup("Quiet Tools")).toMatchObject({ found: false, away: true, why: expect.stringMatching(/could not be reached/) });
  });

  it("in words: HEY's facts as HEY's, this team ships, the source, never a rating", async () => {
    const { records } = client();
    const t = recordText(await records.lookup("factor"));
    expect(t).toMatch(/^Factor \(\$FACTOR\): its builder record on HEY Research Lab/);
    expect(t).toContain("HEY marks it a Verified Builder: this team ships.");
    expect(t).toContain("HEY's status: Shipping (Shipped something meaningful in the last 7 days).");
    expect(t).toContain("Meaningful ships HEY counted in 30 days: 5.");
    expect(t).toContain("Source: https://heyresearch.xyz/project/factor");
    expect(t).toContain("not a rating, and it never changes the Factor Score");
    expect(t).not.toMatch(/[\u2014\u2013]/);
    expect(recordText(await records.lookup("twin"))).toMatch(/^Not on HEY: HEY has 2 projects called twin/);
  });
});

// ---------- on the engine ----------

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

async function desk(more: Record<string, string> = {}, f = fake()): Promise<Rig & { hey: ReturnType<typeof fakeHey> }> {
  const chain = new FakeChain();
  chain.fund(ETH);
  for (const a of [A1, B1]) chain.register(a);
  const r = await rig("live", { chain, more: { HEY: "on", ENGINE_ADMIN_KEY: ADMIN, ...more }, heyFetch: f.fetch });
  rigs.push(r);
  await r.engine.watchOnce();
  return Object.assign(r, { hey: f });
}
let caller = 0;
// each write from a caller of its own, so the limit on writes from one address is not what a test meets
const post = async (r: Rig, path: string, body: unknown, admin?: string): Promise<Body> => { const a = (await r.engine.post(path, body, `10.0.0.${++caller % 250}`, admin))!; return { status: a.status, ...(a.body as Body) }; };
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? ""), "1.2.3.4"))!; return { status: a.status, ...(a.body as Body) }; };
async function link(r: Rig, project: string, o: { key?: typeof ownerKey; agent?: string; by?: string; at?: number } = {}): Promise<Body> {
  const key = o.key ?? ownerKey;
  const agent = o.agent ?? A1, by = o.by ?? key.address.toLowerCase(), at = o.at ?? r.chain.time;
  const signature = await key.signMessage({ message: heyLinkMessage({ agent, project, at }) });
  return post(r, "/v1/hey/link", { agent, by, project, at, signature });
}
async function name(r: Rig, key: typeof ownerKey, n: string, does: string): Promise<void> {
  const address = key.address.toLowerCase(), at = r.chain.time;
  const signature = await key.signMessage({ message: profileMessage(address, n, does, at) });
  expect((await r.engine.post("/v1/agents/profile", { address, name: n, does, at, signature }, "1.2.3.4"))!.status).toBe(200);
}

describe("the endpoints", () => {
  it("off unless HEY=on: nothing shows, nothing is taken, and HEY is asked nothing", async () => {
    const r = await desk({ HEY: "off" });
    expect(await get(r, "/v1/hey")).toEqual({ status: 200, enabled: false });
    expect(await get(r, "/v1/hey/record?q=factor")).toEqual({ status: 200, enabled: false });
    expect(await get(r, `/v1/hey/agent/${A1}`)).toEqual({ status: 200, enabled: false });
    expect((await link(r, "factor")).status).toBe(503);
    expect(((await get(r, "/v1/state")).hey as Body).enabled).toBe(false);
    expect(r.hey.seen).toHaveLength(0);
  });

  it("on: what it is, Factor's own page and badge in the state, and a project's record by what is typed", async () => {
    const r = await desk();
    expect(await get(r, "/v1/hey")).toMatchObject({ enabled: true, source: "HEY Research Lab", project: "https://heyresearch.xyz/project/factor", badge: "https://heyresearch.xyz/api/badge/factor", integration: HEY_INTEGRATION, words: { mark: "Verified Builder on HEY: this team ships." } });
    expect((await get(r, "/v1/state")).hey).toEqual({ enabled: true, project: "https://heyresearch.xyz/project/factor", badge: "https://heyresearch.xyz/api/badge/factor" });
    expect(await get(r, "/v1/hey/record?q=%24FACTOR")).toMatchObject({ status: 200, enabled: true, found: true, sourceUrl: "https://heyresearch.xyz/project/factor", facts: { verified_builder: true, hey_status_label: "Shipping" } });
    expect(await get(r, "/v1/hey/record?q=twin")).toMatchObject({ status: 200, found: false });
    expect((await get(r, "/v1/hey/record?q=")).status).toBe(400);
    expect((await get(r, "/v1/hey/agent/0x00000000000000000000000000000000000000ff")).status).toBe(404);
  });

  it("an agent's owner links it to its maker's project by slug or contract, or unlinks it; the rest are refused", async () => {
    const r = await desk();
    expect(await get(r, `/v1/hey/agent/${A1}`)).toMatchObject({ enabled: true, agent: A1, link: null, record: null, owners: [A1] });
    // another wallet, a signature that is not the wallet's, a project HEY has not published
    expect(await link(r, "factor", { key: otherKey, agent: A1 })).toMatchObject({ status: 403 });
    const forged = await otherKey.signMessage({ message: heyLinkMessage({ agent: A1, project: "factor", at: r.chain.time }) });
    expect(await post(r, "/v1/hey/link", { agent: A1, by: A1, project: "factor", at: r.chain.time, signature: forged })).toMatchObject({ status: 401 });
    expect(await link(r, "no-such-project")).toMatchObject({ status: 404, error: expect.stringMatching(/only a project HEY has published/) });
    expect(await link(r, "Not A Slug!")).toMatchObject({ status: 400 });
    expect(await link(r, "factor", { at: r.chain.time - 3600 })).toMatchObject({ status: 400 });
    expect(await link(r, "factor", { agent: "0x00000000000000000000000000000000000000ff", by: A1 })).toMatchObject({ status: 404 });
    // the owner, by slug
    const at = r.chain.time;
    expect(await link(r, "factor", { at })).toMatchObject({ status: 200, ok: true, link: { slug: "factor", name: "Factor", contract: null, sourceUrl: "https://heyresearch.xyz/project/factor", by: A1 } });
    expect(await link(r, "factor", { at })).toMatchObject({ status: 409 });
    const page = await get(r, `/v1/hey/agent/${A1}`);
    expect(page).toMatchObject({ link: { slug: "factor", by: A1 }, record: { found: true, sourceUrl: "https://heyresearch.xyz/project/factor", facts: { verified_builder: true, meaningful_ships_30d: 5 } } });
    // by a contract HEY ties to the project: the contract is kept as it was named
    r.chain.time += 20;
    expect(await link(r, FOLLOWUP)).toMatchObject({ status: 200, link: { slug: "factor", contract: FOLLOWUP } });
    // unlinked
    r.chain.time += 20;
    expect(await link(r, "none")).toMatchObject({ status: 200, link: null });
    expect(await get(r, `/v1/hey/agent/${A1}`)).toMatchObject({ link: null, record: null });
  });

  it("never touches the Factor Score, the record or the limit", async () => {
    const r = await desk();
    const before = await get(r, `/v1/agents/${A1}`);
    expect((await link(r, "factor")).status).toBe(200);
    const after = await get(r, `/v1/agents/${A1}`);
    expect(after.agent).toEqual(before.agent);
    expect(after.factorScore).toEqual(before.factorScore);
  });

  it("the owner's switch: HEY is asked nothing and nothing shows; the links are kept for when it is back", async () => {
    const r = await desk();
    expect((await link(r, "factor")).status).toBe(200);
    const calls = r.hey.seen.length;
    expect((await post(r, "/v1/admin/switch", { what: "hey", on: false }, ADMIN)).status).toBe(200);
    expect(await get(r, "/v1/hey/record?q=quiet%20tools")).toEqual({ status: 200, enabled: false });
    expect(await get(r, `/v1/hey/agent/${A1}`)).toEqual({ status: 200, enabled: false });
    expect(((await get(r, "/v1/state")).hey as Body).enabled).toBe(false);
    expect((await link(r, "none")).status).toBe(503);
    expect(r.hey.seen).toHaveLength(calls);
    expect((await post(r, "/v1/admin/switch", { what: "hey", on: true }, ADMIN)).status).toBe(200);
    expect(await get(r, `/v1/hey/agent/${A1}`)).toMatchObject({ link: { slug: "factor" } });
  });

  it("the owner's health answer: the calls made and the header, never the key", async () => {
    const r = await desk({ HEY_API_KEY: "hey_secret_free_key" });
    await get(r, "/v1/hey/record?q=factor");
    expect(r.hey.seen.every((x) => x.headers.authorization === "Bearer hey_secret_free_key")).toBe(true);
    const h = r.engine.hey!.health();
    expect(h).toMatchObject({ on: true, integration: HEY_INTEGRATION, keyed: true, calls: 3, failed: 0, linked: 0 });
    expect(JSON.stringify(h)).not.toContain("hey_secret_free_key");
    expect(r.lines.join("\n")).not.toContain("hey_secret_free_key");
    expect(r.lines.some((l) => l.startsWith(`[hey] on: builder records are read from https://heyresearch.xyz with x-hey-integration: ${HEY_INTEGRATION}, kept 600 s, 60 calls a minute at most, with Factor's free key`))).toBe(true);
  });
});

describe("Copilot and Ask", () => {
  async function copilot(more: Record<string, string> = {}) {
    const r = await desk({ COPILOT: "on", COPILOT_PER_MIN: "100", ASK: "on", ...more });
    await name(r, ownerKey, "lumen-07", "Writes short market notes, every figure checked");
    await name(r, otherKey, "page-maker", "Builds a landing page from a short brief");
    return r;
  }
  const chat = async (r: Rig, msgs: string[]): Promise<Body[]> => {
    const out: Body[] = [];
    let conversation: string | undefined;
    for (const text of msgs) {
      const a = await post(r, "/v1/copilot", { text, conversation, tz: 0 });
      out.push(a);
      conversation = a.conversation ?? conversation;
    }
    return out;
  };

  it("answers whether a project's team ships from HEY's record, by code, with the source", async () => {
    const r = await copilot();
    const [a] = await chat(r, ["Is the team behind $FACTOR still shipping?"]);
    expect(a).toMatchObject({ status: 200, intent: "builder", written: "plain", reply: { kind: "answer", source: { name: "HEY Research Lab", url: "https://heyresearch.xyz/project/factor" } } });
    expect(a!.reply.text).toMatch(/^Factor's builder record on HEY Research Lab, the public record of building on Robinhood Chain, in HEY's own words\. It says what the team shipped; it is not a rating, and it never changes the Factor Score\.$/);
    expect(a!.reply.facts).toEqual(["Verified Builder on HEY: this team ships.", "HEY's status: Shipping. Shipped something meaningful in the last 7 days.", "Meaningful ships HEY counted in 30 days: 5.", "Latest ship HEY recorded: Code changes, week starting 2026-11-02 (to 2026-11-08), 2026-11-07.", "Source: https://heyresearch.xyz/project/factor"]);
    expect(a!.reply.action).toBeNull();
  });

  it("the team behind an agent: the project its owner linked, or that there is none; asks which when nothing is named", async () => {
    const r = await copilot();
    const [none] = await chat(r, ["is the team behind lumen-07 shipping?"]);
    expect(none!.reply).toMatchObject({ kind: "answer", text: "lumen-07's owner has not linked it to a project on HEY. An agent's owner can link it to its maker's project on HEY from the agent's page." });
    expect((await link(r, "factor")).status).toBe(200);
    const [linked] = await chat(r, ["is the team behind lumen-07 shipping?"]);
    expect(linked!.reply.text).toMatch(/^lumen-07 is linked by its owner to Factor on HEY\. Factor's builder record/);
    expect(linked!.reply.choices).toEqual(["Hire lumen-07", "What is lumen-07's score?"]);
    const [q, a] = await chat(r, ["is anyone building it?", "Quiet Tools"]);
    expect(q!.reply).toMatchObject({ kind: "question", text: "Which project, or which agent? Name it, its $TICKER, or its contract on Robinhood Chain." });
    expect(a).toMatchObject({ intent: "builder", reply: { kind: "answer", source: { url: "https://heyresearch.xyz/project/quiet-tools" } } });
    expect(a!.reply.facts).toContain("HEY's status: Dormant.");
    expect(a!.reply.facts).not.toContain("Verified Builder on HEY: this team ships.");
    const [twin] = await chat(r, ["who builds Twin?"]);
    expect(twin!.reply).toMatchObject({ kind: "answer", text: "HEY has 2 projects called Twin: say which, by its HEY page or its contract.", choices: ["Is Twin shipping?", "Is Twin shipping?"] });
  });

  it("while HEY is off Copilot says it is not open, and asks HEY nothing", async () => {
    const r = await copilot({ HEY: "off" });
    const [a] = await chat(r, ["Is the team behind $FACTOR still shipping?"]);
    expect(a!.reply).toMatchObject({ kind: "refusal", text: "Builder records from HEY are not open just now." });
    expect(r.hey.seen).toHaveLength(0);
  });

  it("Ask: a picked agent linked to its maker's project carries HEY's word on it, after the picks, which it never changes", async () => {
    const r = await copilot();
    const sentence = { text: "Short market notes on ETH and NVDA by tomorrow", tz: 0 };
    const before = await post(r, "/v1/ask", sentence);
    expect((await link(r, "factor")).status).toBe(200);
    const after = await post(r, "/v1/ask", sentence);
    const pick = (after.agents as Body[]).find((x) => x.address === A1)!;
    expect(pick.builder).toEqual({ project: "Factor", status: "Shipping", verifiedBuilder: true, sourceUrl: "https://heyresearch.xyz/project/factor" });
    expect((after.agents as Body[]).map((x) => [x.name, x.score, x.priceEth, x.reasons])).toEqual((before.agents as Body[]).map((x) => [x.name, x.score, x.priceEth, x.reasons]));
    expect((after.agents as Body[]).filter((x) => x.address !== A1).every((x) => x.builder === undefined)).toBe(true);
  });
});

describe("the header", () => {
  it("was on every request made to HEY in this file", () => {
    const all = everySeen.flat();
    expect(all.length).toBeGreaterThan(40);
    for (const x of all) expect(x.headers["x-hey-integration"], x.url).toBe(HEY_INTEGRATION);
    expect(all.every((x) => x.url.startsWith("https://heyresearch.xyz/api/"))).toBe(true);
  });
});
