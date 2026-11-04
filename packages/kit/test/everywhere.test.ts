// Factor everywhere in the kit, against a made-up site that answers with the engine's own signed answers: an answer is
// taken only when it is signed by the signer the app keeps and has not run out; the link to the pay flow and the
// embed's snippet are what the site reads; a marketplace's calls carry its key; a webhook is checked to the byte; and
// the two tools an assistant gets.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { answerSigner, hireUrl as engineHireUrl, seal as engineSeal } from "../../../engine/src/everywhere.js";
import { SCORE_TAG1 as engineScoreTag } from "../../../engine/src/erc8004score.js";
import { checkAgent, checkAgents, embedSnippet, everywhereSigner, Factor, FactorConnect, hireLink, Refusal, SCORE_TAG, verifyAnswer, verifyWebhook } from "../src/index.js";
import { runTool, TOOLS } from "../src/tools.js";
import { AGENTS, stub, type Stub } from "./stub.js";

let s: Stub;
beforeAll(async () => { s = await stub(); });
afterAll(async () => { await s.close(); });
const SIGNER = answerSigner({ EVERYWHERE_SIGNING_KEY: `0x${"42".repeat(32)}` })!;
const STRANGER = answerSigner({ EVERYWHERE_SIGNING_KEY: `0x${"43".repeat(32)}` })!;
const now = () => Math.floor(Date.now() / 1000);
const AGENT = AGENTS[0]!.address;
const answerOf = (over: Record<string, unknown> = {}) => ({
  v: 1, kind: "factor.agent", chainId: 4663, desk: "0x487eb282e9aa56ae871c15a16c5b061b9d2faa6f", block: 105_000_000, issuedAt: now(), expiresAt: now() + 600,
  agent: { address: AGENT, name: "lumen-07", named: true, does: "Summarises long documents", since: "2026-10-01T00:00:00.000Z", page: "https://factoragents.fun/agents/lumen-07", factorOwn: false, erc8004: { agentId: "42", registry: "eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" } },
  score: { value: 624, of: 1000, barred: false, check: `score(${AGENT}) on the desk` },
  record: { settled: 4, settledAtHalf: 0, delivered: 4, onTime: 4, late: 0, refunded: 0, declined: 0, customers: 2, distinctCustomers: 2, volumeEth: "0.2", advancesRepaid: 2, advancesNotRepaid: 0 },
  line: { status: "open", limitEth: 0.024, owedEth: 0, headroomEth: 0.024, dueAt: null },
  guarantee: { selling: true, upToEth: 0.01, sharePct: 75, bondEth: 0.05, freeEth: 0.04, covers: 3, delivered: 3, paidOut: 0, paidOutEth: 0 },
  hire: "https://factoragents.fun/hire?agent=lumen-07", ...over,
});
beforeEach(() => {
  s.site.everywhereAbout = { enabled: true, signer: SIGNER.address, holdsS: 600, mostAtOnce: 25, perMinute: 120, connect: { enabled: true }, scores: { enabled: true, tag1: "factorScore", reviewer: null } };
  s.site.everywhere = null;
  s.site.connect = null;
});

describe("an answer", () => {
  it("is taken only when the signer the app keeps signed it, word for word, and it has not run out", async () => {
    const sealed = await engineSeal(SIGNER, answerOf());
    expect(await verifyAnswer(sealed, { signer: SIGNER.address })).toMatchObject({ ok: true, data: { score: { value: 624 } } });
    // the signer the answer names is never trusted on its own
    const forged = await engineSeal(STRANGER, answerOf({ score: { value: 1000, of: 1000, barred: false, check: "" } }));
    expect(await verifyAnswer({ ...forged, signer: SIGNER.address }, { signer: SIGNER.address })).toMatchObject({ ok: false, why: /not Factor's/ });
    expect(await verifyAnswer({ ...sealed, answer: sealed.answer.replace('"value":624', '"value":900') }, { signer: SIGNER.address })).toMatchObject({ ok: false });
    expect(await verifyAnswer(await engineSeal(SIGNER, answerOf({ expiresAt: now() - 1 })), { signer: SIGNER.address })).toMatchObject({ ok: false, why: /run out/ });
    expect(await verifyAnswer(sealed, { signer: "nobody" })).toMatchObject({ ok: false });
  });

  it("checkAgent reads it from the site and checks it; by an ERC-8004 identity too; a forged one is refused in words", async () => {
    const asked: string[] = [];
    s.site.everywhere = (path) => { asked.push(path); return path.startsWith("agent/") ? { status: 200, body: null } : null; };
    const good = await engineSeal(SIGNER, answerOf());
    s.site.everywhere = (path, auth) => { asked.push(`${path}|${auth}`); return path === "agent/8004%3A42" || path === "agent/lumen-07" ? { status: 200, body: good } : null; };
    expect((await checkAgent("lumen-07", { api: s.api, signer: SIGNER.address })).score.value).toBe(624);
    expect((await checkAgent("8004:42", { api: s.api })).agent.erc8004?.agentId).toBe("42"); // the signer read from the site
    expect(await everywhereSigner({ api: s.api })).toBe(SIGNER.address);
    expect((await (async () => { try { await checkAgent("nobody-here", { api: s.api, signer: SIGNER.address }); } catch (e) { return e; } })()) as Refusal).toBeInstanceOf(Refusal);
    await expect(checkAgent("<b>", { api: s.api })).rejects.toThrow(/address, its name/);
    const forged = await engineSeal(STRANGER, answerOf());
    s.site.everywhere = () => ({ status: 200, body: forged });
    await expect(checkAgent("lumen-07", { api: s.api, signer: SIGNER.address })).rejects.toThrow(/did not check out/);
    s.site.everywhere = () => ({ status: 429, body: { error: "too many" } });
    await expect(checkAgent("lumen-07", { api: s.api, signer: SIGNER.address })).rejects.toThrow(/in a minute/);
    s.site.everywhereAbout = { enabled: false, signer: null };
    s.site.everywhere = () => ({ status: 200, body: good });
    await expect(checkAgent("lumen-07", { api: s.api })).rejects.toThrow(/switched off/);
  });

  it("checkAgents asks for up to 25 in one answer", async () => {
    const many = await engineSeal(SIGNER, { ...answerOf(), kind: "factor.agents", items: [answerOf()], missing: ["nobody-here"] });
    s.site.everywhere = (path) => (path.startsWith("agents?ids=lumen-07,nobody-here") ? { status: 200, body: many } : null);
    const got = await checkAgents(["lumen-07", "nobody-here"], { api: s.api, signer: SIGNER.address });
    expect(got.items).toHaveLength(1);
    expect(got.missing).toEqual(["nobody-here"]);
    await expect(checkAgents(Array(26).fill("lumen-07"), { api: s.api })).rejects.toThrow(/1 to 25/);
  });
});

describe("the pay flow, the embed, the tag", () => {
  it("a hire link is the site's pay flow filled in, as the engine names it", () => {
    expect(hireLink({ agent: "lumen-07" })).toBe(engineHireUrl("https://factoragents.fun", { agent: "lumen-07" }));
    const u = new URL(hireLink({ agent: "lumen-07", price: "0.01", title: "Summarise   one contract", brief: "Ten pages.", dueHours: 24, early: true, cover: true, site: "https://factoragents.fun/api/v1" }));
    expect(u.origin + u.pathname).toBe("https://factoragents.fun/hire");
    expect(Object.fromEntries(u.searchParams)).toEqual({ agent: "lumen-07", price: "0.01", title: "Summarise one contract", brief: "Ten pages.", due: "24", early: "1", cover: "1" });
    expect(() => hireLink({ agent: "lumen-07", price: "1e3" })).toThrow(/ETH as text/);
    expect(() => hireLink({ agent: "<x>" })).toThrow(/name or address/);
  });

  it("the embed's snippet is one element and one script from the site, nothing else", () => {
    expect(embedSnippet({ agent: "lumen-07" })).toBe('<div data-factor-agent="lumen-07" data-factor-show="score guarantee hire"></div>\n<script src="https://factoragents.fun/embed.js" async></script>');
    expect(embedSnippet({ agent: "8004:42", show: ["score"], theme: "dark", site: "http://127.0.0.1:3600" })).toContain('data-factor-show="score" data-factor-theme="dark"');
    expect(() => embedSnippet({ agent: '"><script>' })).toThrow();
  });

  it("the score's tag is the engine's", () => {
    expect(SCORE_TAG).toBe(engineScoreTag);
  });
});

describe("Factor Connect", () => {
  it("registers with no personal data, and every call after carries the key", async () => {
    const key = `fc_${"ab".repeat(6)}_${"K".repeat(43)}`;
    const seen: { path: string; body: Record<string, unknown>; auth: string }[] = [];
    s.site.connect = (path, body, auth) => {
      seen.push({ path, body, auth });
      if (path === "register") return { status: 200, body: { ok: true, id: "ab".repeat(6), key } };
      if (path === "hire") return { status: 200, body: { ok: true, ticket: "0".repeat(20), url: "https://factoragents.fun/hire?ticket=" + "0".repeat(20), expiresAt: "2026-11-06T00:00:00.000Z" } };
      if (path === "rotate") return { status: 200, body: { ok: true, key: key.replace("K", "L") } };
      if (path === "me" && auth !== `Bearer ${key.replace("K", "L")}`) return { status: 401, body: { error: "send the marketplace's key" } };
      return { status: 200, body: { ok: true } };
    };
    const { connect } = await FactorConnect.register({ name: "Agent Bazaar", site: "https://bazaar.example", hook: "https://bazaar.example/hooks/factor", api: s.api });
    expect(seen[0]).toMatchObject({ path: "register", body: { name: "Agent Bazaar", site: "https://bazaar.example", hook: "https://bazaar.example/hooks/factor" }, auth: "" });
    const t = await connect.hire({ agent: AGENT, price: "0.01", title: "Summarise one contract", dueHours: 24, cover: "0.005", ref: "order-77" });
    expect(t.url).toContain("/hire?ticket=");
    expect(seen.at(-1)).toMatchObject({ path: "hire", auth: `Bearer ${key}`, body: { priceWei: "10000000000000000", coverWei: "5000000000000000", dueHours: 24, early: false, ref: "order-77" } });
    await connect.rotate();
    expect((await connect.me()).ok).toBe(true);
    expect(() => new FactorConnect("not-a-key")).toThrow(/Connect key/);
    s.site.connect = () => ({ status: 401, body: { error: "send the marketplace's key: Authorization: Bearer fc_..." } });
    await expect(connect.ping()).rejects.toThrow(/marketplace's key/);
  });

  it("a webhook is Factor's only with the very bytes it was signed over", async () => {
    const body = JSON.stringify({ v: 1, event: "job.paid", delivery: "d1", job: { id: 7 } });
    const sig = await SIGNER.sign(body);
    expect(await verifyWebhook(body, sig, SIGNER.address)).toBe(true);
    expect(await verifyWebhook(body.replace("7", "8"), sig, SIGNER.address)).toBe(false);
    expect(await verifyWebhook(body, sig, STRANGER.address)).toBe(false);
    expect(await verifyWebhook(body, undefined, SIGNER.address)).toBe(false);
  });
});

describe("the tools", () => {
  it("factor_check_agent says the score, the record, the line and the Guarantee, checked; factor_hire_link gives the pay flow with no key", async () => {
    const good = await engineSeal(SIGNER, answerOf());
    s.site.everywhere = () => ({ status: 200, body: good });
    const f = await Factor.connect({ api: s.api, rpcUrl: s.rpc });
    const c = await runTool(f, "factor_check_agent", { agent: "lumen-07" }, null);
    expect(c.isError).toBe(false);
    expect(c.text).toMatch(/Factor Score 624 of 1000/);
    expect(c.text).toMatch(/0.024 ETH left to draw/);
    expect(c.text).toMatch(/covers up to 0.01 ETH/);
    expect(c.text).toMatch(/Signed by Factor and checked/);
    const h = await runTool(f, "factor_hire_link", { agent: "lumen-07", price: "0.01", title: "Summarise one contract", due_hours: 24 }, null);
    expect(h.isError).toBe(false);
    expect(h.text).toContain("/hire?agent=lumen-07&price=0.01&title=Summarise+one+contract&due=24");
    expect(h.text).not.toMatch(/guarantee[sd]? (a |your )?(return|profit)/i);
    expect(TOOLS.filter((t) => t.name === "factor_check_agent" || t.name === "factor_hire_link").every((t) => t.readOnly)).toBe(true);
    // a key never reaches either: they read, and make a link
    expect(privateKeyToAccount(`0x${"42".repeat(32)}`).address.toLowerCase()).toBe(SIGNER.address);
  });
});
