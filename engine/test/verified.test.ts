// Verified owners, on the made-up chain and with stand-ins for Human Passport and Talent Protocol: no request leaves the
// machine. The owner's signature (replay, address case, the wrong wallet), what each service answers (pass, fail, no
// record, too slow, down, no key), the outcome running out and being checked again, what is kept (never a score or a
// stamp), the board's filter, a job for verified owners only held by the engine and by auto-apply, and the switch.

import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { rulesMessage, type Rules } from "../src/autoapply.js";
import { firmMessage, slugOf } from "../src/firms.js";
import { EngineDb, open } from "../src/chain/db.js";
import { applyMessage, openJobIdOf, postMessage, type OpenJobText } from "../src/openjobs.js";
import { turn } from "../src/switches.js";
import { bandOf, outcomeOf, passportProvider, providersOf, readVerified, runChecks, talentProvider, Verified, verifyMessage, type Provider } from "../src/verified.js";
import { ETH, FakeChain } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

// anvil's public test keys: worth nothing anywhere
const ownerKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const otherKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const buyerKey = privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
type Key = typeof ownerKey;
const low = (k: { address: string }) => k.address.toLowerCase();
const A1 = low(ownerKey), B1 = low(otherKey), BUYER = low(buyerKey);
const HOUR = 3600, DAY = 86_400;
type Body = Record<string, any>;

/** A stand-in service: a score for each wallet, a delay, or a fault. Counts how often it was asked. */
function stand(source: "passport" | "talent", scores: Record<string, number | null>, o: { fail?: boolean; slowMs?: number } = {}): Provider & { asked: string[]; set(a: string, s: number | null): void; fail: boolean } {
  const p = {
    source, asked: [] as string[], fail: !!o.fail,
    set(a: string, s: number | null) { scores[a] = s; },
    async score(a: string) {
      p.asked.push(a);
      if (o.slowMs) await new Promise((r) => setTimeout(r, o.slowMs));
      if (p.fail) throw new Error(`${source === "passport" ? "Human Passport" : "Talent Protocol"} answered 502`);
      return a in scores ? scores[a]! : null;
    },
  };
  return p;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

async function desk(o: { more?: Record<string, string>; providers?: Provider[] } = {}): Promise<Rig> {
  const chain = new FakeChain();
  chain.fund(ETH);
  for (const a of [A1, B1]) chain.register(a);
  const r = await rig("live", { chain, more: { OPENJOBS: "on", VERIFIED: "on", ...o.more }, ...(o.providers ? { verifiedProviders: o.providers } : {}) });
  rigs.push(r);
  await r.engine.watchOnce();
  return r;
}

const post = async (r: Rig, path: string, body: unknown): Promise<Body> => { const a = (await r.engine.post(path, body, "1.2.3.4"))!; return { status: a.status, ...(a.body as Body) }; };
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? "")))!; return { status: a.status, ...(a.body as Body) }; };

/** The owner signs with its wallet for an agent (its own, by default) and asks for the check. */
async function verify(r: Rig, o: { key?: Key; agent?: string; owner?: string; at?: number; signature?: string } = {}): Promise<Body> {
  const key = o.key ?? ownerKey;
  const agent = o.agent ?? low(key), owner = o.owner ?? low(key), at = o.at ?? r.chain.time;
  const signature = o.signature ?? await key.signMessage({ message: verifyMessage({ agent: agent.toLowerCase(), owner: owner.toLowerCase(), at }) });
  return post(r, "/v1/verified/check", { agent, owner, at, signature });
}

async function postJob(r: Rig, o: Partial<OpenJobText> = {}): Promise<{ id: string; a: Body; p: OpenJobText }> {
  const p: OpenJobText = { customer: BUYER, price: (ETH / 250n).toString(), dueHours: 24, early: true, title: o.title ?? "A one-page site for our bakery", brief: "Our hours and the menu, on one calm page.", closesAt: r.chain.time + 6 * HOUR, pick: { by: "customer" }, at: o.at ?? r.chain.time, ...(o.offers ? { offers: true } : {}), ...(o.verifiedOnly ? { verifiedOnly: true } : {}) };
  const signature = await buyerKey.signMessage({ message: postMessage(p) });
  const a = await post(r, "/v1/openjobs/post", { customer: p.customer, price: p.price, dueHours: p.dueHours, early: p.early, title: p.title, brief: p.brief, closesAt: p.closesAt, pick: "customer", at: p.at, signature, ...(o.offers ? { offers: true } : {}), ...(o.verifiedOnly ? { verifiedOnly: true } : {}) });
  return { id: openJobIdOf(p), a, p };
}

async function apply(r: Rig, open: string, key: Key, o: { auto?: boolean; offer?: { priceWei: string; dueHours: number } } = {}): Promise<Body> {
  const at = r.chain.time;
  const offer = o.offer ? { ...o.offer, until: null } : undefined;
  const signature = await key.signMessage({ message: applyMessage({ open, agent: low(key), pitch: "", at, ...(offer ? { offer } : {}) }) });
  return post(r, "/v1/openjobs/apply", { open, agent: low(key), pitch: "", at, signature, ...(o.auto ? { auto: true } : {}), ...(offer ? { priceWei: offer.priceWei, dueHours: offer.dueHours } : {}) });
}

describe("the settings and the words", () => {
  it("is off unless VERIFIED=on; with no key nothing can be checked, and the stand-in is refused on a host", () => {
    expect(readVerified({})).toMatchObject({ enabled: false, needs: "any", passportMin: 20, talentMin: 40, sources: [], validS: 30 * DAY, recheckS: 7 * DAY });
    const bare = readVerified({ VERIFIED: "on" });
    expect(bare.sources).toEqual([]);
    expect(bare.note).toMatch(/no check has its key/);
    expect(readVerified({ VERIFIED: "on", HUMAN_PASSPORT_API_KEY: "k", HUMAN_PASSPORT_SCORER_ID: "123" }).sources).toEqual(["passport"]);
    // a Passport key without its scorer is no Passport check
    expect(readVerified({ VERIFIED: "on", HUMAN_PASSPORT_API_KEY: "k", TALENT_API_KEY: "t" }).sources).toEqual(["talent"]);
    expect(readVerified({ VERIFIED: "on", VERIFIED_FAKE: "on" })).toMatchObject({ sources: ["passport", "talent"], fake: { on: true } });
    const host = readVerified({ VERIFIED: "on", VERIFIED_FAKE: "on", RAILWAY_ENVIRONMENT: "production" });
    expect(host).toMatchObject({ sources: [], fake: { on: false } });
    expect(host.note).toMatch(/refused on a host/);
    expect(readVerified({ VERIFIED: "on", VERIFIED_FAKE: "on", NODE_ENV: "production" }).fake.on).toBe(false);
    expect(providersOf(readVerified({ VERIFIED: "on" }), {})).toEqual([]);
    const problems: string[] = [];
    readVerified({ VERIFIED_NEEDS: "most", HUMAN_PASSPORT_MIN_SCORE: "-3", VERIFIED_VALID_DAYS: "0" }, problems);
    expect(problems).toHaveLength(3);
    expect(readVerified({ VERIFIED_NEEDS: "all", HUMAN_PASSPORT_MIN_SCORE: "25.5", TALENT_MIN_SCORE: "80" })).toMatchObject({ needs: "all", passportMin: 25.5, talentMin: 80 });
  });

  it("signs readable words, and a job for every agent keeps the words and the number it had", () => {
    expect(verifyMessage({ agent: A1, owner: B1, at: 1_800_000_000 })).toBe(`Factor: verify the owner of an agent\nagent: ${A1}\nowner: ${B1}\nchecks: Human Passport, Talent Protocol\nat: 1800000000`);
    const p: OpenJobText = { customer: BUYER, price: "4000000000000000", dueHours: 24, early: true, title: "A page", brief: "", closesAt: 1_800_000_000, pick: { by: "customer" }, at: 1_799_990_000 };
    expect(postMessage(p)).not.toContain("who:");
    expect(postMessage({ ...p, verifiedOnly: true })).toBe(postMessage(p).replace("\nat: ", "\nwho: verified owners only\nat: "));
    expect(openJobIdOf({ ...p, verifiedOnly: true })).not.toBe(openJobIdOf(p));
  });

  it("keeps a band of a score, never the number", () => {
    expect([bandOf("passport", 3.1), bandOf("passport", 20), bandOf("passport", 27.4), bandOf("passport", 55), bandOf("passport", null)]).toEqual(["under 10", "20 to 29", "20 to 29", "40 or more", "no record"]);
    expect([bandOf("talent", 12), bandOf("talent", 79), bandOf("talent", 180), bandOf("talent", 999)]).toEqual(["under 40", "40 to 79", "170 to 249", "250 or more"]);
  });
});

describe("the services", () => {
  const answer = (status: number, body: unknown) => async () => ({ status, json: async () => body });

  it("Human Passport: the score of the v2 Stamps API, asked with the key and the scorer", async () => {
    const seen: { url: string; key: string }[] = [];
    const p = passportProvider("pk", "777", { fetch: async (url, init) => { seen.push({ url, key: init.headers["X-API-KEY"]! }); return { status: 200, json: async () => ({ address: A1, score: "27.40000", passing_score: true, threshold: "20.00000", stamps: { Google: { score: "0.5", dedup: false, expiration_date: "2027-01-01" } } }) }; } });
    expect(await p.score(A1, new AbortController().signal)).toBe(27.4);
    expect(seen).toEqual([{ url: `https://api.passport.xyz/v2/stamps/777/score/${A1}`, key: "pk" }]);
    expect(await passportProvider("pk", "1", { fetch: answer(404, {}) }).score(A1, new AbortController().signal)).toBeNull();
    await expect(passportProvider("pk", "1", { fetch: answer(500, {}) }).score(A1, new AbortController().signal)).rejects.toThrow(/answered 500/);
    await expect(passportProvider("pk", "1", { fetch: answer(200, { error: "x" }) }).score(A1, new AbortController().signal)).rejects.toThrow(/without a score/);
  });

  it("Talent Protocol: the Builder Score of a wallet; no profile is no record", async () => {
    const seen: string[] = [];
    const t = talentProvider("tk", { fetch: async (url) => { seen.push(url); return { status: 200, json: async () => ({ score: { points: 64, rank_position: 1200, slug: "builder_score", last_calculated_at: "2026-10-01" } }) }; } });
    expect(await t.score(A1, new AbortController().signal)).toBe(64);
    expect(seen).toEqual([`https://api.talentprotocol.com/score?id=${A1}&account_source=wallet&scorer_slug=builder_score`]);
    expect(await talentProvider("tk", { fetch: answer(404, { error: "Resource not found" }) }).score(A1, new AbortController().signal)).toBeNull();
    expect(await talentProvider("tk", { fetch: answer(200, {}) }).score(A1, new AbortController().signal)).toBeNull();
    await expect(talentProvider("tk", { fetch: answer(429, {}) }).score(A1, new AbortController().signal)).rejects.toThrow(/answered 429/);
  });

  it("pass, fail, too slow and down: a fault is never a fail, and one pass is enough unless all must", async () => {
    const cfg = { passportMin: 20, talentMin: 40, timeoutMs: 50 };
    const pass = stand("passport", { [A1]: 25 });
    const slow = stand("talent", { [A1]: 90 }, { slowMs: 400 });
    const r1 = await runChecks([pass, slow], A1, cfg);
    expect(r1).toMatchObject([{ source: "passport", outcome: "pass", band: "20 to 29" }, { source: "talent", outcome: "error", band: null, why: "Talent Protocol did not answer in time" }]);
    expect(outcomeOf(r1, "any")).toBe(true);
    expect(outcomeOf(r1, "all")).toBe(false);
    const r2 = await runChecks([stand("passport", { [A1]: 19.9 }), stand("talent", {})], A1, cfg);
    expect(r2.map((x) => x.outcome)).toEqual(["fail", "fail"]);
    expect(outcomeOf(r2, "any")).toBe(false);
    const r3 = await runChecks([stand("passport", {}, { fail: true }), stand("talent", {}, { fail: true })], A1, cfg);
    expect(outcomeOf(r3, "any")).toBeNull();
    expect(outcomeOf([], "any")).toBeNull();
  });
});

describe("the owner's signature", () => {
  it("links the owner wallet: verified at once, shown on the agent, its score, its record and the list", async () => {
    const passport = stand("passport", { [A1]: 27.4 });
    const r = await desk({ providers: [passport, stand("talent", {})] });
    const a = await verify(r);
    expect(a).toMatchObject({ status: 200, verified: true, owner: A1, checks: [{ name: "Human Passport", outcome: "pass", band: "20 to 29" }, { name: "Talent Protocol", outcome: "fail", band: "no record" }] });
    expect(passport.asked).toEqual([A1]);
    const page = await get(r, `/v1/agents/${A1}`);
    expect(page.agent.verifiedOwner).toMatchObject({ verified: true, sources: ["Human Passport"], bands: { "Human Passport": "20 to 29", "Talent Protocol": "no record" }, owner: A1 });
    expect(page.factorScore.verifiedOwner).toMatchObject({ sources: ["Human Passport"] });
    const rec = await get(r, `/v1/record/${A1}`);
    expect(rec.verifiedOwner).toMatchObject({ verified: true, sources: ["Human Passport"] });
    // the attested figures are the desk's alone
    expect(Object.keys(rec.attestation?.message ?? {})).not.toContain("verifiedOwner");
    const s = await get(r, "/v1/state");
    expect(s.verified).toMatchObject({ enabled: true, agents: 1, needs: "any", checks: [{ name: "Human Passport" }, { name: "Talent Protocol" }] });
    expect((s.agents as Body[]).find((x) => x.address === A1)?.verifiedOwner).toBeTruthy();
    expect((s.agents as Body[]).find((x) => x.address === B1)).not.toHaveProperty("verifiedOwner");
    expect(await get(r, `/v1/verified/${A1}`)).toMatchObject({ enabled: true, owners: [A1], verifiedOwner: { verified: true } });
  });

  it("refuses a signature sent again, an older one, a stale one, and the wrong wallet; takes any case of an address", async () => {
    const r = await desk({ providers: [stand("passport", { [A1]: 30 })] });
    // an agent that is not on the desk
    expect(await verify(r, { key: buyerKey })).toMatchObject({ status: 404 });
    const at = r.chain.time;
    const signature = await ownerKey.signMessage({ message: verifyMessage({ agent: A1, owner: A1, at }) });
    // the same addresses written with capitals: the same agent and owner
    expect(await verify(r, { agent: getAddress(A1), owner: getAddress(A1), at, signature })).toMatchObject({ status: 200, verified: true });
    expect(await verify(r, { at, signature })).toMatchObject({ status: 409, error: expect.stringMatching(/used already/) });
    expect(await verify(r, { at: at - 5 })).toMatchObject({ status: 409 });
    expect(await verify(r, { at: at - 3600 })).toMatchObject({ status: 400, error: expect.stringMatching(/ten minutes/) });
    // signed by another wallet than the one it names
    const forged = await otherKey.signMessage({ message: verifyMessage({ agent: A1, owner: A1, at: at + 1 }) });
    expect(await verify(r, { at: at + 1, signature: forged })).toMatchObject({ status: 401 });
    // a wallet that does not run the agent, signing in its own name
    expect(await verify(r, { key: otherKey, agent: A1, owner: B1, at: at + 2 })).toMatchObject({ status: 403, error: expect.stringMatching(/does not run this agent/) });
  });

  it("checks one agent at most once a minute, and a check nobody answered changes nothing", async () => {
    const passport = stand("passport", { [A1]: 30 });
    const r = await desk({ providers: [passport] });
    expect(await verify(r)).toMatchObject({ status: 200, verified: true });
    r.chain.mine(1, 10);
    expect(await verify(r)).toMatchObject({ status: 429 });
    r.chain.mine(1, 60);
    passport.fail = true;
    expect(await verify(r)).toMatchObject({ status: 503, error: expect.stringMatching(/answered 502.*Nothing was changed/) });
    expect((await get(r, `/v1/agents/${A1}`)).agent.verifiedOwner).toMatchObject({ verified: true });
  });

  it("an agent made on the site is verified by its maker's wallet, not by its own key", async () => {
    const sqlite = open(":memory:");
    const now = { t: 1_800_000_000 };
    const db = new EngineDb(sqlite, () => now.t * 1000);
    sqlite.prepare("INSERT INTO desk_agents (address, registered_block, registered_at) VALUES (?, 1, 1)").run("0x00000000000000000000000000000000000000aa");
    const AGENT = "0x00000000000000000000000000000000000000aa";
    const passport = stand("passport", { [A1]: 22, [AGENT]: 99 });
    const { recoverMessageAddress } = await import("viem");
    const v = new Verified({ cfg: readVerified({ VERIFIED: "on", VERIFIED_FAKE: "on" }), db, providers: [passport], now: () => now.t * 1000, log: () => undefined, setters: () => [A1],
      signed: async (address, message, signature) => (await recoverMessageAddress({ message, signature: signature as `0x${string}` })).toLowerCase() === address });
    expect(v.ownersOf(AGENT)).toEqual([AGENT, A1]);
    const at = now.t;
    const signature = await ownerKey.signMessage({ message: verifyMessage({ agent: AGENT, owner: A1, at }) });
    expect(await v.check({ agent: AGENT, owner: A1, at, signature })).toMatchObject({ status: 200, body: { verified: true, owner: A1 } });
    // the maker's wallet was checked, never the agent's own key
    expect(passport.asked).toEqual([A1]);
    expect(v.json(AGENT)).toMatchObject({ owner: A1 });
  });
});

describe("a firm", () => {
  it("is verified when its owner is: the lead's", async () => {
    const r = await desk({ providers: [stand("passport", { [A1]: 25 })], more: { FIRMS: "on" } });
    const f = { slug: slugOf("Figure Check Co"), name: "Figure Check Co", does: "Market notes where every figure is checked", lead: A1, members: [B1], at: r.chain.time };
    expect(await post(r, "/v1/firms/form", { ...f, signature: await ownerKey.signMessage({ message: firmMessage(f) }) })).toMatchObject({ status: 200 });
    expect((await get(r, `/v1/firms/${f.slug}`)).firm).not.toHaveProperty("verifiedOwner");
    await verify(r);
    expect((await get(r, `/v1/firms/${f.slug}`)).firm.verifiedOwner).toMatchObject({ sources: ["Human Passport"] });
    expect((await get(r, `/v1/firms/${f.slug}/record`)).verifiedOwner).toMatchObject({ sources: ["Human Passport"] });
    expect(((await get(r, "/v1/state")).firms.items as Body[])[0]?.verifiedOwner).toBeTruthy();
  });
});

describe("running out, and checked again", () => {
  it("runs out after its days; Factor checks it again on its own, and a fault leaves it as it was", async () => {
    const passport = stand("passport", { [A1]: 25 });
    const r = await desk({ providers: [passport], more: { VERIFIED_VALID_DAYS: "30", VERIFIED_RECHECK_HOURS: "168" } });
    await verify(r);
    const v = r.engine.verified!;
    // a week on: checked again, still passing
    r.chain.mine(1, 8 * DAY);
    v.soon();
    expect(await v.pass()).toBe(1);
    expect(passport.asked).toHaveLength(2);
    expect(v.store.get(A1)).toMatchObject({ verified: 1, how: "again" });
    // the service is down at the next check: nothing changes, and why is noted
    r.chain.mine(1, 8 * DAY);
    passport.fail = true;
    v.soon();
    expect(await v.pass()).toBe(0);
    expect(v.store.get(A1)).toMatchObject({ verified: 1, note: expect.stringMatching(/answered 502/) });
    expect(v.isVerified(A1)).toBe(true);
    // it stays down until the outcome runs out: then nobody says it is verified
    r.chain.mine(1, 23 * DAY);
    expect(v.isVerified(A1)).toBe(false);
    expect((await get(r, `/v1/agents/${A1}`)).agent).not.toHaveProperty("verifiedOwner");
    expect((await get(r, `/v1/record/${A1}`)).verifiedOwner).toBeNull();
    // the score drops below the line: checked again, and no longer verified
    passport.fail = false;
    passport.set(A1, 12);
    v.soon();
    expect(await v.pass()).toBe(1);
    expect(v.store.get(A1)).toMatchObject({ verified: 0, sources: "[]" });
  });

  it("keeps the outcome and nothing else: no score, no stamp, no name", async () => {
    const leaky: Provider = { source: "passport", score: async () => 27.4 };
    const r = await desk({ providers: [leaky, stand("talent", { [A1]: 63.7 })] });
    expect(await verify(r)).toMatchObject({ status: 200 });
    const row = r.engine.verified!.store.get(A1)!;
    expect(Object.keys(row).sort()).toEqual(["agent", "bands", "checked_at", "expires_at", "how", "note", "owner", "signature", "signed_at", "sources", "verified"]);
    expect(JSON.parse(row.bands)).toEqual({ passport: "20 to 29", talent: "40 to 79" });
    // nothing anywhere in the database holds the numbers the services gave
    const dump = (r.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => JSON.stringify(r.sqlite.prepare(`SELECT * FROM "${t.name}"`).all())).join("\n");
    expect(dump).not.toMatch(/27\.4|63\.7/);
    // and nothing in what the site reads either
    expect(JSON.stringify(await get(r, `/v1/agents/${A1}`))).not.toMatch(/27\.4|63\.7/);
  });
});

describe("for customers: the filter and the jobs for verified owners only", () => {
  it("a job for verified owners only: an agent whose owner is not verified is refused, a verified one applies and offers", async () => {
    const r = await desk({ providers: [stand("passport", { [A1]: 25 })], more: { BIDS: "on" } });
    const plain = await postJob(r, { title: "Any agent can do this" });
    const only = await postJob(r, { verifiedOnly: true, at: r.chain.time + 1 });
    expect(only.a).toMatchObject({ status: 200, verifiedOnly: true });
    // the board's filter: only the jobs for verified owners
    expect(((await get(r, "/v1/openjobs?verified=1")).items as Body[]).map((x) => x.id)).toEqual([only.id]);
    expect(((await get(r, "/v1/openjobs")).items as Body[]).map((x) => x.id).sort()).toEqual([plain.id, only.id].sort());
    expect((await get(r, `/v1/openjobs/${only.id}`)).open).toMatchObject({ verifiedOnly: true, signed: { message: expect.stringContaining("who: verified owners only") } });
    // nobody is verified yet
    expect(await apply(r, only.id, ownerKey)).toMatchObject({ status: 409, error: expect.stringMatching(/only agents whose owner is verified/) });
    expect(await apply(r, plain.id, otherKey)).toMatchObject({ status: 200 });
    await verify(r);
    expect(await apply(r, only.id, ownerKey)).toMatchObject({ status: 200, rank: 1 });
    expect(await apply(r, only.id, otherKey)).toMatchObject({ status: 409 });
    // where customers compare: each applicant says whether its owner is verified, plainly
    const plainPage = (await get(r, `/v1/openjobs/${plain.id}`)).open;
    expect(plainPage.applicants).toMatchObject([{ address: B1, verifiedOwner: false }]);
    expect((await get(r, `/v1/openjobs/${only.id}`)).open.applicants).toMatchObject([{ address: A1, verifiedOwner: true, verifiedAt: expect.any(String) }]);
    // a job open to offers for verified owners only: the same
    const offers = await postJob(r, { offers: true, verifiedOnly: true, at: r.chain.time + 2, title: "Offers from verified owners" });
    expect(offers.a).toMatchObject({ status: 200, offers: true, verifiedOnly: true });
    expect(await apply(r, offers.id, otherKey, { offer: { priceWei: (ETH / 250n).toString(), dueHours: 12 } })).toMatchObject({ status: 409 });
    expect(await apply(r, offers.id, ownerKey, { offer: { priceWei: (ETH / 250n).toString(), dueHours: 12 } })).toMatchObject({ status: 200 });
  });

  it("auto-apply passes over a job for verified owners only until the agent's owner is verified", async () => {
    const r = await desk({ providers: [stand("passport", { [A1]: 25 })], more: { AUTOAPPLY: "on" } });
    const rules: Rules = { on: true, takes: ["Landing pages"], words: [], floorWei: (ETH / 1000n).toString(), atOnce: 3, hours: null, early: true, pitch: "" };
    const at = r.chain.time;
    const signature = await ownerKey.signMessage({ message: rulesMessage({ ...rules, agent: A1, by: A1, at }) });
    expect(await post(r, "/v1/autoapply/rules", { agent: A1, by: A1, ...rules, at, signature })).toMatchObject({ status: 200 });
    const only = await postJob(r, { verifiedOnly: true });
    const plain = await postJob(r, { title: "A landing page for our shop", at: r.chain.time + 1 });
    await r.engine.watchOnce();
    expect((await get(r, `/v1/autoapply/${A1}`)).fits).toEqual([plain.id]);
    expect(await apply(r, only.id, ownerKey, { auto: true })).toMatchObject({ status: 409, error: expect.stringMatching(/owner is verified/) });
    await verify(r);
    await r.engine.watchOnce();
    expect(((await get(r, `/v1/autoapply/${A1}`)).fits as string[]).sort()).toEqual([plain.id, only.id].sort());
    expect(await apply(r, only.id, ownerKey, { auto: true })).toMatchObject({ status: 200 });
  });
});

describe("off, and the owner's switch", () => {
  it("off: nothing about it shows, nothing is asked, and a job for verified owners only cannot be posted", async () => {
    const passport = stand("passport", { [A1]: 25 });
    const r = await desk({ more: { VERIFIED: "" }, providers: [passport] });
    expect((await get(r, "/v1/state")).verified).toMatchObject({ enabled: false, agents: 0 });
    expect(await verify(r)).toMatchObject({ status: 503, error: expect.stringMatching(/switched off/) });
    expect(passport.asked).toEqual([]);
    const page = await get(r, `/v1/agents/${A1}`);
    expect(page.agent).not.toHaveProperty("verifiedOwner");
    expect(page.factorScore).not.toHaveProperty("verifiedOwner");
    expect(await get(r, `/v1/record/${A1}`)).not.toHaveProperty("verifiedOwner");
    expect((await postJob(r, { verifiedOnly: true })).a).toMatchObject({ status: 503, error: expect.stringMatching(/verified owners are switched off/) });
    const plain = await postJob(r);
    expect(plain.a.status).toBe(200);
    expect(await apply(r, plain.id, ownerKey)).toMatchObject({ status: 200 });
    expect((await get(r, `/v1/openjobs/${plain.id}`)).open.applicants[0]).not.toHaveProperty("verifiedOwner");
    // the filter is not one while it is off
    expect(((await get(r, "/v1/openjobs?verified=1")).items as Body[]).map((x) => x.id)).toEqual([plain.id]);
  });

  it("on with no key: unavailable, and it fails closed", async () => {
    const r = await desk();
    expect((await get(r, "/v1/state")).verified).toMatchObject({ enabled: false });
    expect(await verify(r)).toMatchObject({ status: 503, error: expect.stringMatching(/cannot be checked/) });
    expect((await postJob(r, { verifiedOnly: true })).a).toMatchObject({ status: 503 });
    expect(r.lines.some((l) => l.includes("[verified] NOT ON"))).toBe(true);
  });

  it("the switch hides every outcome at once and stops checks; a job for verified owners only then takes nobody", async () => {
    const r = await desk({ providers: [stand("passport", { [A1]: 25 })] });
    await verify(r);
    const only = await postJob(r, { verifiedOnly: true });
    turn(r.db, "verified", false, "a look at the checks");
    expect((await get(r, "/v1/state")).verified).toMatchObject({ enabled: false });
    expect((await get(r, `/v1/agents/${A1}`)).agent).not.toHaveProperty("verifiedOwner");
    expect(await verify(r, { at: r.chain.time + 1 })).toMatchObject({ status: 503, error: "a look at the checks" });
    expect(await apply(r, only.id, ownerKey)).toMatchObject({ status: 409 });
    turn(r.db, "verified", true);
    expect((await get(r, `/v1/agents/${A1}`)).agent.verifiedOwner).toMatchObject({ verified: true });
    expect(await apply(r, only.id, ownerKey)).toMatchObject({ status: 200 });
  });
});
