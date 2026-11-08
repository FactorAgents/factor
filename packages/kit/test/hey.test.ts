// HEY builder records in the kit, against a made-up Factor site: a project's record and an agent's link read through the
// site (the kit never calls HEY itself: Factor's engine does, with its x-hey-integration header), in data and in words
// with the source; refusals before anything is asked; an owner's link signed with the key in the same words the engine
// checks (engine/src/hey.ts); the tool factor_builder_record an assistant gets; and Ask's builder line.
import { recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { heyLinkMessage as engineHeyLinkMessage, recordText as engineRecordText, type HeyLookup as EngineLookup } from "../../../engine/src/hey.js";
import { agentBuilder, askedText, builderRecord, builderRecordText, Factor, heyLinkMessage, type Asked, type BuilderRecord } from "../src/index.js";
import { runTool, TOOLS } from "../src/tools.js";
import { AGENTS, KEY, stub, type Stub } from "./stub.js";

let s: Stub;
beforeAll(async () => { s = await stub(); });
afterAll(async () => { await s.close(); });
const ME = privateKeyToAccount(KEY).address.toLowerCase();
const AGENT = AGENTS[0].address;

const RECORD: BuilderRecord = {
  found: true, source: "HEY Research Lab", sourceUrl: "https://heyresearch.xyz/project/factor", badgeUrl: "https://heyresearch.xyz/api/badge/factor",
  project: { slug: "factor", name: "Factor", symbol: "FACTOR", contract: "0x47c5ea4d85c4c1a81f26124580a80b0b7a581cc0" },
  facts: {
    verified_builder: true, research_level: "VERIFIED_BUILDER", hey_status: "SHIPPING", hey_status_label: "Shipping", hey_status_help: "Shipped something meaningful in the last 7 days.",
    last_activity_at: "2026-11-07T17:27:39.000Z", meaningful_ships_30d: 5,
    latest_meaningful_ship: { title: "Code changes, week starting 2026-11-02 (to 2026-11-08)", url: "https://github.com/factoragents/factor", timestamp: "2026-11-07T17:27:39.000Z", kind: "CODE_ACTIVITY", evidence_id: "ship:cd88c1d6", evidence_link: "https://heyresearch.xyz/evidence/ship:cd88c1d6" },
    latest_change: null, latest_release: null, latest_deployment: null, repo_url: "https://github.com/FactorAgents/factor", token_verification: "VERIFIED", as_of: "2026-11-08T15:17:23.357Z",
  },
  disclaimer: "HEY reports what a team shipped and how it knows. It is not a rating, not a verdict, and says nothing about what a token will do.",
  read: ["https://heyresearch.xyz/api/projects/factor/snapshot"], readAt: "2026-11-08T15:30:00.000Z", stale: false, from: "builder card", integration: "factor/0.1.0",
};

const urls: string[] = [];
const real = globalThis.fetch;
let linked: Record<string, unknown> | null = null;
beforeEach(() => {
  urls.length = 0;
  linked = null;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => { urls.push(String(input)); return real(input, init); }) as typeof fetch;
  s.site.hey = async (method, path, body) => {
    if (method === "GET" && path.startsWith("/hey/record?q=")) {
      const q = decodeURIComponent(path.slice(14));
      return q === "$FACTOR" || q === "factor" ? { status: 200, body: { enabled: true, ...RECORD } } : { status: 200, body: { enabled: true, found: false, why: `HEY has no project called ${q}`, source: "HEY Research Lab", sourceUrl: `https://heyresearch.xyz/search?q=${q}` } };
    }
    if (method === "GET" && path === `/hey/agent/${AGENT}`) return { status: 200, body: { enabled: true, agent: AGENT, link: linked ? { slug: "factor", name: "Factor", contract: null, sourceUrl: RECORD.sourceUrl, by: ME, at: "2026-11-08T15:00:00.000Z" } : null, record: linked ? RECORD : null, owners: [AGENT, ME] } };
    if (method === "GET" && path === "/hey/agent/lumen-07") return { status: 200, body: { enabled: true, agent: AGENT, link: null, record: null, owners: [AGENT] } };
    if (method === "POST" && path === "/hey/link") { linked = body; return { status: 200, body: { ok: true, link: { slug: "factor", name: "Factor", contract: null, sourceUrl: RECORD.sourceUrl, by: ME, at: "2026-11-08T15:00:00.000Z" } } }; }
    return { status: 404, body: { error: "no such agent" } };
  };
});
afterEach(() => { globalThis.fetch = real; });

describe("reading", () => {
  it("a project's record through Factor's site, never from HEY directly; in words with the source", async () => {
    const r = await builderRecord("$FACTOR", { api: s.api });
    expect(r).toMatchObject({ found: true, sourceUrl: "https://heyresearch.xyz/project/factor", facts: { verified_builder: true, meaningful_ships_30d: 5 } });
    expect(urls).toEqual([`${s.api}/api/v1/hey/record?q=%24FACTOR`]);
    expect(urls.some((u) => u.includes("heyresearch.xyz"))).toBe(false);
    const t = builderRecordText(r);
    expect(t).toBe(engineRecordText(r as unknown as EngineLookup));
    expect(t).toContain("HEY marks it a Verified Builder: this team ships.");
    expect(t).toContain("Source: https://heyresearch.xyz/project/factor (read 2026-11-08 15:30 UTC).");
    expect(t).toContain("not a rating, and it never changes the Factor Score");
    expect(t).not.toMatch(/[\u2014\u2013]/);
    const none = await builderRecord("nobody here", { api: s.api });
    expect(builderRecordText(none)).toMatch(/^Not on HEY: HEY has no project called nobody here\./);
  });

  it("refuses before asking, and says when HEY records are off", async () => {
    expect(() => builderRecord("", { api: s.api })).toThrow(/Name the project/);
    expect(() => agentBuilder("not an agent!", { api: s.api })).toThrow(/Name the agent/);
    expect(urls).toEqual([]);
    s.site.hey = async () => ({ status: 200, body: { enabled: false } });
    await expect(builderRecord("factor", { api: s.api })).rejects.toMatchObject({ code: "hey_off" });
  });
});

describe("an owner's link", () => {
  it("signs the engine's own words with the key, and hands the link to the site", async () => {
    expect(heyLinkMessage({ agent: AGENT, project: "factor", at: 1 })).toBe(engineHeyLinkMessage({ agent: AGENT, project: "factor", at: 1 }));
    const f = await Factor.connect({ api: s.api, rpcUrl: s.rpc, privateKey: KEY });
    const l = await f.linkHey("factor", { agent: AGENT });
    expect(l).toMatchObject({ slug: "factor", sourceUrl: "https://heyresearch.xyz/project/factor" });
    const b = linked as { agent: string; by: string; project: string; at: number; signature: Hex };
    expect(b).toMatchObject({ agent: AGENT, by: ME, project: "factor" });
    expect((await recoverMessageAddress({ message: engineHeyLinkMessage({ agent: AGENT, project: "factor", at: b.at }), signature: b.signature })).toLowerCase()).toBe(ME);
    // a contract is signed as it will be checked: lowercase
    await f.linkHey("0x47C5eA4d85c4c1A81F26124580A80B0b7A581CC0", { agent: AGENT });
    expect((linked as { project: string }).project).toBe("0x47c5ea4d85c4c1a81f26124580a80b0b7a581cc0");
    await expect(f.linkHey("Not A Slug!", { agent: AGENT })).rejects.toMatchObject({ code: "bad_project" });
    const reader = await Factor.connect({ api: s.api, rpcUrl: s.rpc });
    await expect(reader.linkHey("factor", { agent: AGENT })).rejects.toMatchObject({ code: "read_only" });
  });
});

describe("for an assistant", () => {
  const tool = TOOLS.find((t) => t.name === "factor_builder_record")!;

  it("factor_builder_record reads only, cites HEY's page, and says it is not a rating", async () => {
    expect(tool.readOnly).toBe(true);
    expect(tool.description).toMatch(/HEY Research Lab/);
    expect(tool.description).toMatch(/not a rating of an agent, and it never changes the Factor Score/);
    expect(tool.description).toMatch(/cite the source link/);
    const f = await Factor.connect({ api: s.api, rpcUrl: s.rpc });
    const a = await runTool(f, "factor_builder_record", { project: "$FACTOR" }, null);
    expect(a.isError).toBe(false);
    expect(a.text).toContain("Source: https://heyresearch.xyz/project/factor");
    const none = await runTool(f, "factor_builder_record", { agent: "lumen-07" }, null);
    expect(none.text).toBe("lumen-07's owner has not linked it to a project on HEY. An agent's owner links it from the agent's page on Factor, or with factor.linkHey().");
    linked = { project: "factor" };
    const viaAgent = await runTool(f, "factor_builder_record", { agent: AGENT }, null);
    expect(viaAgent.text).toMatch(new RegExp(`^${AGENT} is linked by its owner to Factor on HEY\\. Factor \\(\\$FACTOR\\): its builder record`));
    expect(urls.some((u) => u.includes("heyresearch.xyz"))).toBe(false);
    s.site.hey = async () => ({ status: 200, body: { enabled: false } });
    const off = await runTool(f, "factor_builder_record", { project: "factor" }, null);
    expect(off).toMatchObject({ isError: true, text: expect.stringMatching(/switched off/) });
  });

  it("Ask's answer in words carries a picked agent's builder line, with the source", () => {
    const asked = { v: 1, written: "plain", model: null, cached: false, job: { title: "Notes", brief: "Notes", priceEth: "0.002", dueHours: 24, dueAt: "2026-11-09T00:00:00.000Z", cover: false, stages: null, missing: [] }, price: { basis: "desk", similar: 0, lowEth: null, highEth: null, medianEth: null, budgetEth: null, said: "" }, deadline: { from: "default", said: "" }, notes: [],
      agents: [{ kind: "agent", name: "lumen-07", address: AGENT, does: "Notes", score: 624, settled: 4, house: false, guarantee: null, verified: null, fromEth: null, priceEth: "0.002", coverEth: null, reasons: ["Paid for 4 jobs."], hire: "https://factoragents.fun/hire", builder: { project: "Factor", status: "Shipping", verifiedBuilder: true, sourceUrl: "https://heyresearch.xyz/project/factor" } }] } as unknown as Asked;
    expect(askedText(asked)).toContain("   Builder record on HEY: Factor, Shipping, a Verified Builder (this team ships). https://heyresearch.xyz/project/factor");
  });
});
