// The kit's own behaviour, with a made-up site and node behind it: what it refuses before it would send anything,
// how it reads amounts, and that what it signs is to the letter what the engine checks.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { factorDeskAbi } from "../src/abi/FactorDesk.js";
import { Factor, profileMessage, proofOf, Refusal, titleMessage, toWei } from "../src/index.js";
import { limitsFrom, runTool, Spending, TOOLS } from "../src/tools.js";
import { WORDS } from "../src/words.js";
import { profileMessage as engineProfile, titleMessage as engineTitle } from "../../../engine/src/profiles.js";
import { AGENTS, DESK, KEY, stub, type Stub } from "./stub.js";

let s: Stub;
beforeAll(async () => { s = await stub(); });
afterAll(async () => { await s.close(); });
const connect = (over: Record<string, unknown> = {}) => Factor.connect({ api: s.api, rpcUrl: s.rpc, ...over });
const refusal = async (p: Promise<unknown>): Promise<Refusal> => { try { await p; } catch (e) { if (e instanceof Refusal) return e; throw e; } throw new Error("it was not refused"); };

describe("amounts", () => {
  it("reads ETH written as text on its digits, to the wei", () => {
    expect(toWei("0.04")).toBe(40_000_000_000_000_000n);
    expect(toWei("1")).toBe(10n ** 18n);
    expect(toWei("0.000000000000000001")).toBe(1n);
    expect(toWei(" 12.5 ")).toBe(12_500_000_000_000_000_000n);
    expect(toWei(7n)).toBe(7n);
  });

  it("refuses a plain number, and anything that is not an amount", () => {
    expect(() => toWei(0.04 as never)).toThrow(/as text, like "0.04"/);
    for (const bad of ["", "abc", "-1", "1e18", "0.0000000000000000001", "1,5", ".5", "0x10"]) expect(() => toWei(bad), bad).toThrow(Refusal);
    expect(() => toWei(-1n)).toThrow(Refusal);
  });
});

describe("what a wallet signs", () => {
  it("is to the letter what the engine checks", () => {
    expect(profileMessage("0xabc", "lumen-07", "Summarises long documents", 1_791_000_000)).toBe(engineProfile("0xabc", "lumen-07", "Summarises long documents", 1_791_000_000));
    expect(titleMessage(12, "Summarise a contract", 1_791_000_000)).toBe(engineTitle(12, "Summarise a contract", 1_791_000_000));
  });

  it("fingerprints a delivery the same way every time, and differently for different work", () => {
    expect(proofOf("the summary")).toBe(proofOf("the summary"));
    expect(proofOf("the summary")).not.toBe(proofOf("the summary "));
    expect(proofOf("the summary")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("the desk's refusals", () => {
  it("has plain words for every one of them", () => {
    const errors = (factorDeskAbi as readonly { type: string; name?: string }[]).filter((x) => x.type === "error").map((x) => x.name!);
    expect(errors.length).toBeGreaterThan(15);
    for (const name of errors) expect(WORDS[name], name).toBeTypeOf("function");
    expect(WORDS.OverHalf([0n])).toBe("Half of this job is already advanced. Nothing more can be drawn on it.");
    expect(WORDS.OverLimit([4_000_000_000_000_000n])).toBe("The agent's limit with the pool allows 0.004 ETH more right now.");
    expect(WORDS.TooSmall([10n ** 15n])).toBe("The smallest job is 0.001 ETH.");
  });
});

describe("connecting", () => {
  afterEach(() => { s.node.chainId = 4663; s.node.code = "0x6080"; s.site.state.contracts.desk = DESK; });

  it("reads the desk from the site and checks it on the chain", async () => {
    const f = await connect();
    expect(f.desk).toBe(DESK);
    expect(f.address).toBeNull();
    expect(s.node.calls).toContain("eth_getCode");
    const keyed = await connect({ privateKey: KEY });
    expect(keyed.address).toBe("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
    // a key with or without its 0x is the same key
    expect((await connect({ privateKey: KEY.slice(2) })).address).toBe(keyed.address);
  });

  it("will not send anything to an address with no contract at it", async () => {
    s.node.code = "0x";
    const r = await refusal(connect({ privateKey: KEY }));
    expect(r.code).toBe("no_desk");
    expect(r.message).toContain("Nothing will be sent to it.");
  });

  it("refuses a node on another chain, a site with no desk, and a key that is not one", async () => {
    s.node.chainId = 1;
    expect((await refusal(connect())).code).toBe("wrong_chain");
    s.node.chainId = 4663;
    s.site.state.contracts.desk = null;
    expect((await refusal(connect())).code).toBe("not_live");
    s.site.state.contracts.desk = DESK;
    expect((await refusal(connect({ privateKey: "0x1234" }))).code).toBe("bad_key");
    expect((await refusal(Factor.connect({ api: "http://127.0.0.1:9", rpcUrl: s.rpc }))).code).toBe("no_site");
  });

  it("never puts the key in an error or in anything it sends to the site", async () => {
    const f = await connect({ privateKey: KEY });
    const r = await refusal(f.hire({ agent: "nobody-here", price: "0.01" }));
    expect(JSON.stringify([r.message, s.posts, JSON.stringify(f)])).not.toContain(KEY.slice(2));
  });
});

describe("without a key", () => {
  it("reads everything and sends nothing", async () => {
    const f = await connect();
    expect((await f.agents()).map((a) => a.name)).toEqual(["lumen-07", "page-smith"]);
    expect((await f.agent("lumen-07"))?.agent.address).toBe(AGENTS[0].address);
    expect(await f.agent("nobody-here")).toBeNull();
    expect((await f.job(12))?.job.title).toBe("Summarise a contract");
    expect(await f.job(99)).toBeNull();
    for (const p of [f.hire({ agent: "lumen-07", price: "0.01" }), f.register(), f.accept(12), f.draw(12, "0.01"), f.deliver(12, "x"), f.addBond("0.01"), f.profile({ name: "lumen-08", does: "Something useful" }), f.me()]) expect((await refusal(p)).code).toBe("read_only");
  });
});

describe("before anything is sent", () => {
  it("refuses a bad amount, a bad job number, a bad name, a bad due time and an agent that does not exist", async () => {
    const f = await connect({ privateKey: KEY });
    const before = s.node.calls.length;
    expect((await refusal(f.hire({ agent: "lumen-07", price: 0.04 as never }))).code).toBe("bad_amount");
    expect((await refusal(f.hire({ agent: "nobody-here", price: "0.04" }))).code).toBe("no_agent");
    expect((await refusal(f.hire({ agent: "lumen-07", price: "0.04", dueInHours: 0.5 }))).code).toBe("bad_due");
    expect((await refusal(f.hire({ agent: "lumen-07", price: "0.04", dueInHours: 1000 }))).code).toBe("bad_due");
    expect((await refusal(f.hire({ agent: "lumen-07", price: "0.04", title: "see https://evil.example" }))).code).toBe("bad_text");
    expect((await refusal(f.accept(0))).code).toBe("bad_job");
    expect((await refusal(f.accept(1.5))).code).toBe("bad_job");
    expect((await refusal(f.draw(12, "0.01", "bank" as never))).code).toBe("bad_kind");
    expect((await refusal(f.deliver(12, "  "))).code).toBe("no_work");
    expect((await refusal(f.profile({ name: "Lumen 07", does: "Something useful" }))).code).toBe("bad_name");
    expect((await refusal(f.profile({ name: "lumen-07", does: "x" }))).code).toBe("bad_text");
    // none of it reached the node as a transaction or a simulation
    expect(s.node.calls.slice(before).filter((m) => m === "eth_sendRawTransaction" || m === "eth_call")).toEqual([]);
    expect(s.posts).toEqual([]);
  });
});

describe("the assistant's caps", () => {
  const dir = mkdtempSync(join(tmpdir(), "factor-kit-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => vi.useRealTimers());
  const limits = limitsFrom({ FACTOR_MAX_JOB_ETH: "0.05", FACTOR_MAX_DAY_ETH: "0.12", FACTOR_KIT_DIR: dir });

  it("has defaults, and reads the owner's own", () => {
    const d = limitsFrom({});
    expect(d.perJob).toBe(toWei("0.05"));
    expect(d.perDay).toBe(toWei("0.2"));
    expect(d.dir).toMatch(/\.factor-kit$/);
    expect(limits.perDay).toBe(toWei("0.12"));
    expect(() => limitsFrom({ FACTOR_MAX_JOB_ETH: "lots" })).toThrow(Refusal);
  });

  it("refuses one job over the cap, and a day over the cap, and remembers the day across a restart", () => {
    const spend = new Spending(limits, "0xaaa");
    expect(() => spend.check(toWei("0.06"), true)).toThrow(/over this assistant's cap of 0.05 ETH for one job/);
    spend.check(toWei("0.05"), true);
    spend.add(toWei("0.05"));
    spend.add(toWei("0.05"));
    // a new process, the same wallet, the same day
    const again = new Spending(limits, "0xaaa");
    expect(again.today()).toBe(toWei("0.1"));
    expect(() => again.check(toWei("0.03"), true)).toThrow(/over this assistant's cap of 0.12 ETH a day \(0.1 ETH spent so far\)/);
    again.check(toWei("0.02"), true);
    // another wallet has its own day
    expect(new Spending(limits, "0xbbb").today()).toBe(0n);
  });

  it("starts a new day at midnight UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T23:59:00Z"));
    const spend = new Spending(limits, "0xccc");
    spend.add(toWei("0.12"));
    expect(() => spend.check(1n, false)).toThrow(Refusal);
    vi.setSystemTime(new Date("2026-10-14T00:01:00Z"));
    expect(spend.today()).toBe(0n);
    spend.check(toWei("0.05"), true);
  });
});

describe("the tools", () => {
  it("have a name, a description and an input each, and say which of them send something", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["factor_overview", "factor_agents", "factor_agent", "factor_job", "factor_my_jobs", "factor_ledger", "factor_hire", "factor_accept", "factor_reject", "factor_set_title", "factor_register", "factor_set_profile", "factor_bond", "factor_can_draw", "factor_draw", "factor_deliver", "factor_decline"]);
    for (const t of TOOLS) expect(t.description.length, t.name).toBeGreaterThan(40);
    expect(TOOLS.filter((t) => t.readOnly).map((t) => t.name)).toEqual(["factor_overview", "factor_agents", "factor_agent", "factor_job", "factor_my_jobs", "factor_ledger", "factor_can_draw"]);
    // the ones that spend or cannot be undone say so in capitals, where an assistant will not miss it
    for (const name of ["factor_hire", "factor_reject", "factor_bond"]) expect(TOOLS.find((t) => t.name === name)!.description).toMatch(/SPENDS ETH|SETTLES AT HALF/);
  });

  it("answer in words", async () => {
    const f = await connect();
    const overview = await runTool(f, "factor_overview", {}, null);
    expect(overview.isError).toBe(false);
    expect(overview.text).toContain("Pool 0.62 ETH");
    expect(overview.text).toContain("No wallet key is set");
    const agents = await runTool(f, "factor_agents", { limit: 1 }, null);
    expect(agents.text).toBe("lumen-07: Summarises long documents. Score 624 of 1000, 4 jobs settled. Address 0x00000000000000000000000000000000000000a1.");
    expect((await runTool(f, "factor_agent", { agent: "page-smith" }, null)).text).toContain("page-smith (house agent): Builds a landing page.");
    expect((await runTool(f, "factor_job", { job: 12 }, null)).text).toContain('Job 12 "Summarise a contract": delivered, 0.04 ETH');
    expect((await runTool(f, "factor_job", { job: 99 }, null)).text).toContain("There is no job 99");
  });

  it("refuse what is not theirs to take, in words and without throwing", async () => {
    const f = await connect();
    expect(await runTool(f, "factor_nothing", {}, null)).toEqual({ text: "There is no tool called factor_nothing.", isError: true });
    const bad = await runTool(f, "factor_job", { job: "twelve" }, null);
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("That is not what factor_job takes");
    // something slipped in beside what the tool takes is refused, not ignored
    expect((await runTool(f, "factor_job", { job: 12, to: "0xdead" }, null)).isError).toBe(true);
    expect((await runTool(f, "factor_hire", { agent: "lumen-07", price: 0.04, title: "Summarise a contract" }, null)).isError).toBe(true);
    const noKey = await runTool(f, "factor_hire", { agent: "lumen-07", price: "0.04", title: "Summarise a contract" }, null);
    expect(noKey).toEqual({ text: "No wallet key is set (FACTOR_PRIVATE_KEY), so this can only read: figures, agents, jobs and the ledger.", isError: true });
  });

  it("stop a hire over the owner's cap before anything is sent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factor-kit-"));
    const f = await connect({ privateKey: KEY });
    const spending = new Spending(limitsFrom({ FACTOR_MAX_JOB_ETH: "0.02", FACTOR_KIT_DIR: dir }), f.address!);
    const before = s.node.calls.length;
    const r = await runTool(f, "factor_hire", { agent: "lumen-07", price: "0.04", title: "Summarise a contract" }, spending);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("0.04 ETH is over this assistant's cap of 0.02 ETH for one job");
    expect(s.node.calls.slice(before)).toEqual([]);
    expect(spending.today()).toBe(0n);
    rmSync(dir, { recursive: true, force: true });
  });
});
