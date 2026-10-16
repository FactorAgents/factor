// The kit's own behaviour, with a made-up site and node behind it: what it refuses before it would send anything,
// how it reads amounts, and that what it signs is to the letter what the engine checks.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { factorDeskAbi } from "../src/abi/FactorDesk.js";
import { briefMessage, computeKeyMessage, Factor, orderTypedData, profileMessage, proofOf, Refusal, titleMessage, toWei } from "../src/index.js";
import { orderTypedData as engineOrder } from "../../../engine/src/accounts.js";
import { limitsFrom, runTool, Spending, TOOLS } from "../src/tools.js";
import { WORDS } from "../src/words.js";
import { keyMessage as engineComputeKey } from "../../../engine/src/compute.js";
import { briefMessage as engineBrief, profileMessage as engineProfile, proofOf as engineProof, titleMessage as engineTitle } from "../../../engine/src/profiles.js";
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
    expect(computeKeyMessage("0xabc", 1_791_000_000)).toBe(engineComputeKey("0xabc", 1_791_000_000));
    expect(briefMessage(12, "A lease", "Line one.\n\nLine two.", 1_791_000_000)).toBe(engineBrief(12, "A lease", "Line one.\n\nLine two.", 1_791_000_000));
    // the fingerprint an agent puts on the chain is the one the site holds shown work to
    expect(proofOf("The summary: twelve points.")).toBe(engineProof("The summary: twelve points."));
    // an order of an account: the kit's typed data is the engine's, which the end-to-end run holds to the contract's
    const calls = [{ to: DESK, value: 40_000_000_000_000_000n, data: "0x12345678" as const }, { to: AGENTS[0].address, value: 1n, data: "0x" as const }];
    expect(orderTypedData(AGENTS[1].address, 4663, calls, 7n, 1_791_000_600n)).toEqual(engineOrder(AGENTS[1].address, 4663, calls, 7, 1_791_000_600));
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

describe("compute credit", () => {
  it("signs for a key and hands back what the model maker's own library needs", async () => {
    const f = await connect({ privateKey: KEY });
    const before = s.posts.length;
    const c = await f.compute();
    expect(c).toEqual({ baseURL: `${s.api}/api/v1/compute`, openaiBaseURL: `${s.api}/api/v1/compute/v1`, apiKey: "fck_a-key-from-the-stub-0123456789ab", expiresAt: "2026-10-20T00:00:00.000Z", balanceUsd: 49.5, models: [{ id: "claude-sonnet-5-5", inUsd: 2.1, outUsd: 10.5 }], maxTokens: 16_000 });
    const sent = s.posts[before]!;
    expect(sent.path).toBe("/compute/key");
    const body = sent.body as { address: string; at: number; signature: string };
    expect(Object.keys(body).sort()).toEqual(["address", "at", "signature"]);
    expect(body.address).toBe(f.address!.toLowerCase());
    expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(JSON.stringify(sent)).not.toContain(KEY.slice(2));
    s.posts.splice(before); // the tests after this one count what was sent
  });

  it("reads what any agent has left, by name or address, without a key", async () => {
    const f = await connect();
    expect((await f.computeCredit("lumen-07")).balanceUsd).toBe(12.5);
    expect((await f.computeCredit(AGENTS[1].address)).balanceUsd).toBe(49.5);
    expect((await refusal(f.computeCredit("nobody-here"))).code).toBe("no_agent");
    expect((await refusal(f.computeCredit())).code).toBe("read_only");
    expect((await refusal(f.compute())).code).toBe("read_only");
    const said = await runTool(f, "factor_compute_credit", { agent: "lumen-07" }, null);
    expect(said).toEqual({ isError: false, text: "$12.50 of compute credit left. From job 12: $0.00 of $49.50 spent. Claude directly, per million tokens: claude-sonnet-5-5 $2.10 in / $10.50 out." });
    s.site.state.compute.router = { enabled: true, models: 2 };
    expect((await runTool(f, "factor_compute_credit", { agent: "lumen-07" }, null)).text).toContain("And 2 models from every maker");
    delete s.site.state.compute.router;
  });

  it("while it is switched off, hands out no key and draws nothing as compute, before anything is sent", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.state.compute.enabled = false;
    const calls = s.node.calls.length, posts = s.posts.length;
    expect((await refusal(f.compute())).code).toBe("compute_off");
    expect((await refusal(f.draw(12, "0.01", "compute"))).code).toBe("compute_off");
    expect(s.node.calls.length).toBe(calls);
    expect(s.posts.length).toBe(posts);
    expect((await runTool(f, "factor_compute_credit", {}, null)).text).toContain("Compute credit is not switched on yet.");
    expect((await refusal(f.askModel("Hi", { model: "openai/gpt-5" }))).code).toBe("compute_off");
    expect(s.posts.length).toBe(posts);
    s.site.state.compute.enabled = true;
  });

  it("lists every model of the second door with its price, and finds them by name or maker", async () => {
    const f = await connect();
    expect(await f.computeModels()).toEqual([
      { id: "openai/gpt-5", name: "OpenAI: GPT-5", maker: "openai", contextLength: 400_000, inUsd: 1.3125, outUsd: 10.5 },
      { id: "deepseek/deepseek-chat", name: "DeepSeek V3", maker: "deepseek", contextLength: 128_000, inUsd: 0.2625, outUsd: 0.84 },
    ]);
    expect((await f.computeModels("DEEPSEEK")).map((m) => m.id)).toEqual(["deepseek/deepseek-chat"]);
    expect(await f.computeModels("nothing-like-it")).toEqual([]);
    expect((await runTool(f, "factor_compute_models", {}, null)).text).toBe("2 models, per million tokens: deepseek/deepseek-chat $0.263 in / $0.840 out; openai/gpt-5 $1.31 in / $10.50 out.");
    expect((await runTool(f, "factor_compute_models", { search: "llama" }, null)).text).toBe('No model has "llama" in its name.');
  });

  it("asks any model in one line, signing for a key once and using it until it runs out", async () => {
    const f = await connect({ privateKey: KEY });
    const before = s.posts.length;
    const a = await f.askModel("Say hello", { model: "openai/gpt-5", system: "Be brief.", maxTokens: 200 });
    expect(a).toEqual({ text: "Hello from the model", model: "openai/gpt-5", inputTokens: 10, outputTokens: 5 });
    const sent = s.posts.slice(before);
    expect(sent.map((p) => p.path)).toEqual(["/compute/key", "/compute/v1/chat/completions"]);
    expect(sent[1]!.auth).toBe("Bearer fck_a-key-from-the-stub-0123456789ab");
    expect(sent[1]!.body).toEqual({ model: "openai/gpt-5", max_tokens: 200, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Say hello" }] });
    // Claude by its own name goes through Anthropic's shape, with the same key: no second signature
    expect(await f.askModel("Say hello", { model: "claude-sonnet-5-5" })).toEqual({ text: "Hello from Claude", model: "claude-sonnet-5-5", inputTokens: 12, outputTokens: 4 });
    expect(s.posts.slice(before).map((p) => p.path)).toEqual(["/compute/key", "/compute/v1/chat/completions", "/compute/v1/messages"]);
    expect(s.posts.at(-1)!.body).toEqual({ model: "claude-sonnet-5-5", max_tokens: 1024, messages: [{ role: "user", content: "Say hello" }] });
    expect(JSON.stringify(s.posts.slice(before))).not.toContain(KEY.slice(2));
    expect((await runTool(f, "factor_ask_model", { model: "openai/gpt-5", prompt: "Say hello" }, null)).text).toBe("Hello from the model\n\n(openai/gpt-5: 10 tokens in, 5 out, paid from compute credit.)");
    s.posts.splice(before);
  });

  it("says why the gateway refused, and refuses an empty question before anything is sent", async () => {
    const f = await connect({ privateKey: KEY });
    const posts = s.posts.length;
    expect((await refusal(f.askModel("  ", { model: "openai/gpt-5" }))).code).toBe("no_prompt");
    expect((await refusal(f.askModel("Hi", { model: "" }))).code).toBe("no_model");
    expect((await refusal(f.askModel("Hi", { model: "openai/gpt-5", maxTokens: 1.5 }))).code).toBe("bad_request");
    expect(s.posts.length).toBe(posts);
    s.site.refuse = 402;
    const r = await refusal(f.askModel("Hi", { model: "openai/gpt-5" }));
    expect(r).toMatchObject({ code: "no_credit", message: "This agent has no compute credit." });
    expect((await runTool(f, "factor_ask_model", { model: "openai/gpt-5", prompt: "Hi" }, null)).isError).toBe(true);
    s.site.refuse = null;
    s.posts.splice(posts);
  });
});

describe("one of Factor's own agents", () => {
  it("is not hired with no brief or under its price: said before anything is locked", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.state.agents[1].service = { needs: "Say what the page is for.", delivers: "a page", fromEth: 0.003 };
    const calls = s.node.calls.length, posts = s.posts.length;
    const none = await refusal(f.hire({ agent: "page-smith", price: "0.01", title: "A page" }));
    expect(none.code).toBe("no_brief");
    expect(none.message).toBe("page-smith works from a brief. Say what the page is for.");
    expect((await refusal(f.hire({ agent: "page-smith", price: "0.001", brief: "A page for a tea shop." }))).code).toBe("under_price");
    expect((await refusal(f.hire({ agent: "lumen-07", price: "0.01", brief: "x".repeat(12_001) }))).code).toBe("bad_text");
    expect(s.node.calls.length).toBe(calls);
    expect(s.posts.length).toBe(posts);
    expect((await runTool(f, "factor_agent", { agent: "page-smith" }, null)).text).toContain("What to put in the brief: Say what the page is for. It delivers a page, and takes a job from 0.003 ETH.");
    delete s.site.state.agents[1].service;
  });

  it("a brief is signed with the job's title, by the wallet that locked it", async () => {
    const f = await connect({ privateKey: KEY });
    const before = s.posts.length;
    await f.brief(12, "Line one.\r\nLine two.", "Summarise a contract");
    const sent = s.posts[before]!;
    expect(sent.path).toBe("/jobs/brief");
    expect(sent.body).toMatchObject({ job: 12, title: "Summarise a contract", brief: "Line one.\nLine two." });
    expect((sent.body as { signature: string }).signature).toMatch(/^0x[0-9a-f]{130}$/);
    s.posts.splice(before);
  });
});

describe("while new jobs are paused", () => {
  it("nothing is locked through the kit, and the reason given is Factor's own", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.state.paused = "New jobs are paused for now. Jobs already locked run as they were.";
    const calls = s.node.calls.length;
    const r = await refusal(f.hire({ agent: "lumen-07", price: "0.01", title: "A summary" }));
    expect(r.code).toBe("paused");
    expect(r.message).toBe("New jobs are paused for now. Jobs already locked run as they were.");
    expect(s.node.calls.length).toBe(calls);
    expect((await runTool(f, "factor_hire", { agent: "lumen-07", price: "0.01", title: "A summary" }, null)).text).toBe("New jobs are paused for now. Jobs already locked run as they were.");
    s.site.state.paused = null;
  });
});

describe("gasless", () => {
  it("is refused in words while accounts are not switched on, and without a key", async () => {
    expect((await refusal(connect({ privateKey: KEY, gasless: true }))).code).toBe("accounts_off");
    expect((await refusal(connect({ gasless: true }))).code).toBe("read_only");
    // a wallet of its own has no account to take ETH out of
    const f = await connect({ privateKey: KEY });
    expect(f.gasless).toBe(false);
    expect((await refusal(f.withdraw(AGENTS[0].address, "0.01"))).code).toBe("not_gasless");
    expect((await refusal(f.accountInfo())).code).toBe("not_gasless");
    expect((await runTool(f, "factor_account", {}, null)).text).toContain("pays its own gas");
  });

  it("will not use an account maker that is not a contract on the chain", async () => {
    s.site.state.accounts = { enabled: true, factory: "0x00000000000000000000000000000000000acc07", ordersPerDay: 40 };
    s.node.code = "0x";
    // the desk is checked first, and with no code anywhere that is what it says
    expect((await refusal(connect({ privateKey: KEY, gasless: true }))).code).toBe("no_desk");
    s.node.code = "0x6080";
    s.site.state.accounts = { enabled: false, factory: null, ordersPerDay: 40 };
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
    expect(TOOLS.map((t) => t.name)).toEqual(["factor_overview", "factor_agents", "factor_agent", "factor_job", "factor_my_jobs", "factor_ledger", "factor_hire", "factor_accept", "factor_reject", "factor_set_title", "factor_register", "factor_set_profile", "factor_bond", "factor_can_draw", "factor_account", "factor_compute_credit", "factor_compute_models", "factor_ask_model", "factor_draw", "factor_deliver", "factor_decline", "factor_sign_up", "factor_create_pay_link", "factor_pay_link_info", "factor_pay_link", "factor_pay_x402", "factor_record"]);
    for (const t of TOOLS) expect(t.description.length, t.name).toBeGreaterThan(40);
    expect(TOOLS.filter((t) => t.readOnly).map((t) => t.name)).toEqual(["factor_overview", "factor_agents", "factor_agent", "factor_job", "factor_my_jobs", "factor_ledger", "factor_can_draw", "factor_account", "factor_compute_credit", "factor_compute_models", "factor_pay_link_info", "factor_record"]);
    // the ones that spend or cannot be undone say so in capitals, where an assistant will not miss it
    for (const name of ["factor_hire", "factor_reject", "factor_bond", "factor_pay_link", "factor_pay_x402"]) expect(TOOLS.find((t) => t.name === name)!.description).toMatch(/SPENDS ETH|SETTLES AT HALF/);
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

// ---------- Pay with Factor ----------

import { privateKeyToAccount } from "viem/accounts";
import { encodePayLink, payLinkMessage, readPayLink, RECORD_TYPES, tokenOf, verifyRecord, x402PaymentHeader, type AgentRecord, type PayLink, type RecordMessage } from "../src/index.js";
import { decodePayLink as engineDecode, payLinkMessage as enginePayLink } from "../../../engine/src/pay.js";
import { RECORD_TYPES as engineRecordTypes, recordTypedData } from "../../../engine/src/record.js";

const AGENT_KEY = privateKeyToAccount(KEY);
const link = (over: Partial<PayLink> = {}): PayLink => ({ v: 1, agent: AGENT_KEY.address.toLowerCase(), price: "40000000000000000", title: "Summarise a contract", brief: "Every date and every amount.", due: 24, early: true, exp: 1_800_000_000, id: "0123456789abcdef", ...over });

describe("a Pay with Factor link", () => {
  it("is signed with the very words the engine checks, and travels in a form the engine reads back", async () => {
    for (const l of [link(), link({ brief: "", early: false, price: "1000000000000000", due: 720 })]) expect(payLinkMessage(l)).toBe(enginePayLink(l));
    const token = encodePayLink(link(), await AGENT_KEY.signMessage({ message: payLinkMessage(link()) }));
    const back = engineDecode(token);
    expect(typeof back).toBe("object");
    expect((back as { link: PayLink }).link).toEqual(link());
    expect(readPayLink(`https://factoragents.fun/pay/${token}`)?.link).toEqual(link());
    expect(tokenOf(`https://factoragents.fun/api/v1/x402/${token}`)).toBe(token);
    expect(tokenOf("https://example.com/something")).toBeNull();
    // the record's shape is the engine's, field for field
    expect(RECORD_TYPES).toEqual(engineRecordTypes);
    expect(JSON.parse(atob(x402PaymentHeader({ job: 7, lockTx: "0xab" })))).toEqual({ x402Version: 1, scheme: "factor-lock", network: "robinhood-chain", payload: { job: 7, lockTx: "0xab", burnTx: null } });
  });

  it("is made and signed by the agent's own key, and shown on its page", async () => {
    const f = await connect({ privateKey: KEY });
    const before = s.posts.length;
    const made = await f.createPayLink({ price: "0.04", title: "Summarise a contract", brief: "Every date.", dueInHours: 48, allowEarly: true });
    expect(made.url).toBe(`${s.api}/pay/${made.token}`);
    expect(made.x402).toBe(`${s.api}/api/v1/x402/${made.token}`);
    expect(made.link).toMatchObject({ agent: f.address, price: "40000000000000000", due: 48, early: true });
    expect(made.published).toBe(true);
    expect(s.posts.slice(before)).toEqual([{ path: "/pay/links", body: { link: made.token } }]);
    const back = readPayLink(made.token)!;
    const { recoverMessageAddress } = await import("viem");
    expect((await recoverMessageAddress({ message: payLinkMessage(back.link), signature: back.signature })).toLowerCase()).toBe(f.address);
  });

  it("refuses a link it would not sell, before anything is signed", async () => {
    const f = await connect({ privateKey: KEY });
    expect((await refusal(f.createPayLink({ price: "0.0001", title: "Too cheap" }))).code).toBe("bad_amount");
    expect((await refusal(f.createPayLink({ price: "0.01", title: "A brief too long", brief: "x".repeat(2001) }))).code).toBe("bad_text");
    expect((await refusal(f.createPayLink({ price: "0.01", title: "Due never", dueInHours: 0 }))).code).toBe("bad_due");
    expect((await refusal(f.createPayLink({ price: "0.01", title: "see https://example.com" }))).code).toBe("bad_text");
  });

  it("is not paid over the cap, for an agent that has not signed up, or with a burn pot that is not Factor's", async () => {
    const f = await connect({ privateKey: KEY });
    const token = encodePayLink(link(), await AGENT_KEY.signMessage({ message: payLinkMessage(link()) }));
    const info = { id: "0x1", link: link(), registered: true, paused: null, priceWei: "40000000000000000", priceEth: "0.04", burnWei: "400000000000000", burnEth: "0.0004", totalWei: "40400000000000000", desk: DESK, burnPot: "0x00000000000000000000000000000000000b0b07", url: "", x402: "" };
    s.site.payInfo = () => ({ status: 200, body: info });
    s.site.state.contracts.burnPot = "0x00000000000000000000000000000000000b0b07";
    const before = s.node.calls.length;
    expect((await refusal(f.payLink(token, { maxEth: "0.04" }))).code).toBe("over_cap");
    s.site.payInfo = () => ({ status: 200, body: { ...info, registered: false, error: "this agent has not signed up on Factor yet" } });
    expect((await refusal(f.payLink(token))).code).toBe("not_registered");
    s.site.payInfo = () => ({ status: 200, body: { ...info, burnPot: "0x00000000000000000000000000000000000000ee" } });
    expect((await refusal(f.payLink(token))).code).toBe("wrong_pot");
    s.site.payInfo = () => ({ status: 410, body: { error: "this link expired on 2026-10-01 00:00 UTC. Ask the agent for a new one" } });
    const old = await refusal(f.payLink(token));
    expect(old.code).toBe("expired");
    expect(old.message).toMatch(/expired.*Ask the agent for a new one\./);
    // nothing was sent to the chain for any of them
    expect(s.node.calls.slice(before).filter((c) => c === "eth_sendRawTransaction" || c === "eth_sendTransaction")).toEqual([]);
    s.site.payInfo = null;
  });

  it("over x402, pays only Factor's desk, for the agent the signed link names", async () => {
    const f = await connect({ privateKey: KEY });
    const token = encodePayLink(link(), await AGENT_KEY.signMessage({ message: payLinkMessage(link()) }));
    const extra = { chainId: 4663, link: token, desk: DESK, agent: link().agent, priceWei: link().price, burnWei: "400000000000000", burnPot: "0x00000000000000000000000000000000000b0b07", dueInHours: 24, allowEarly: true, linkId: "0x1", brief: "" };
    const offer = { scheme: "factor-lock", network: "robinhood-chain", maxAmountRequired: "40400000000000000", resource: "", description: "", mimeType: "application/json", payTo: "0x00000000000000000000000000000000000000ee", maxTimeoutSeconds: 600, asset: "0x0000000000000000000000000000000000000000", extra };
    s.site.x402 = { status: 402, body: { x402Version: 1, error: "X-PAYMENT header is required", accepts: [offer] } };
    expect((await refusal(f.payX402(`${s.api}/api/v1/x402/${token}`))).code).toBe("wrong_desk");
    s.site.x402 = { status: 402, body: { x402Version: 1, accepts: [{ ...offer, scheme: "exact" }] } };
    expect((await refusal(f.payX402(`${s.api}/api/v1/x402/${token}`))).code).toBe("not_x402");
    s.site.x402 = { status: 200, body: {} };
    expect((await refusal(f.payX402(`${s.api}/api/v1/x402/${token}`))).code).toBe("not_x402");
    s.site.x402 = null;
  });
});

describe("an agent's record", () => {
  const signer = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
  async function signed(over: Partial<RecordMessage> = {}): Promise<AgentRecord> {
    const message = { agent: AGENTS[0].address, block: 100, delivered: 5, onTime: 4, late: 1, settled: 4, settledAtHalf: 1, refunded: 0, advancesRepaid: 2, advancesNotRepaid: 0, customers: 3, volume: "200000000000000000", score: 410, barred: false, issuedAt: 1_790_000_000, expiresAt: 4_000_000_000, ...over };
    const signature = await signer.signTypedData(recordTypedData(4663, DESK, message) as never);
    return { version: 1, agent: AGENTS[0].address, chainId: 4663, desk: DESK, attestation: { signer: signer.address.toLowerCase(), signature, digest: "0x", message, issuedAt: "", expiresAt: "" } } as unknown as AgentRecord;
  }

  it("checks Factor's attestation by its signature alone, and catches one figure changed, an expired one and another signer", async () => {
    const rec = await signed();
    expect(await verifyRecord(rec, { signer: signer.address })).toEqual({ ok: true });
    const changed = { ...rec, attestation: { ...rec.attestation!, message: { ...rec.attestation!.message, settled: 40 } } };
    expect((await verifyRecord(changed, { signer: signer.address })).ok).toBe(false);
    expect((await verifyRecord(rec, { signer: AGENT_KEY.address })).why).toMatch(/signed by/);
    expect((await verifyRecord(await signed({ expiresAt: 1_700_000_000 }), { signer: signer.address })).why).toMatch(/expired/);
    expect((await verifyRecord({ ...rec, attestation: null }, { signer: signer.address })).why).toMatch(/no attestation/);
  });

  it("is read by name or address, and the tool says whether Factor signed it", async () => {
    const f = await connect();
    s.site.record = { ...(await signed()), name: "lumen-07", score: 410, barred: false, jobs: { locked: 6, open: 1, delivered: 5, onTime: 4, late: 1, settled: 4, settledAtHalf: 1, declined: 0, refunded: 0, refundedAfterDrawing: 0, unanswered: 0 }, advances: { repaid: 2, notRepaid: 0, earlyKept: 0 }, volumeEth: "0.2", customers: 3, distinctCustomers: 3, payWithFactor: { deals: 2, burnedWei: "800000000000000", burnedEth: "0.0008" }, block: 100 };
    const text = (await runTool(f, "factor_record", { agent: "lumen-07" }, null)).text;
    expect(text).toContain("lumen-07");
    expect(text).toContain("5 delivered (4 on time, 1 late)");
    expect(text).toContain("Paid with Factor: 2 deals, 0.0008 ETH to the burn");
    expect(text).toContain("signed by Factor");
    s.site.record = null;
    expect((await refusal(f.record("nobody-here"))).code).toBe("no_agent");
  });
});
