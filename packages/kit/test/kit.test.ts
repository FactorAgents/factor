// The kit's own behaviour, with a made-up site and node behind it: what it refuses before it would send anything,
// how it reads amounts, and that what it signs is to the letter what the engine checks.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { factorDeskAbi } from "../src/abi/FactorDesk.js";
import { briefMessage, computeKeyMessage, Factor, orderTypedData, profileMessage, proofOf, Refusal, titleMessage, toWei, type FactorOptions } from "../src/index.js";
import { orderTypedData as engineOrder } from "../../../engine/src/accounts.js";
import { limitsFrom, runTool, Spending, TOOLS } from "../src/tools.js";
import { WORDS } from "../src/words.js";
import { keyMessage as engineComputeKey } from "../../../engine/src/compute.js";
import { briefMessage as engineBrief, profileMessage as engineProfile, proofOf as engineProof, titleMessage as engineTitle } from "../../../engine/src/profiles.js";
import { hireMessage as engineHire, planIdOf as enginePlanId } from "../../../engine/src/subjobs.js";
import { hireMessage, planIdOf, firmHireMessage, firmMessage, joinMessage, leaveMessage, slugOf } from "../src/index.js";
import { firmHireMessage as engineFirmHire, firmMessage as engineFirm, joinMessage as engineJoin, leaveMessage as engineLeave, slugOf as engineSlug } from "../../../engine/src/firms.js";
import { planMessage, stopPlanMessage, monthlyPlanId } from "../src/index.js";
import { planIdOf as enginePlanIdOf, planMessage as enginePlan, stopMessage as engineStop } from "../../../engine/src/plans.js";
import { recoverMessageAddress } from "viem";
import { erc8004LinkMessage, erc8004Registry } from "../src/index.js";
import { linkMessage as engineLink, registryOf as engineRegistry } from "../../../engine/src/erc8004.js";
import { applyMessage, closeJobMessage, openJobId, postJobMessage, rulesMessage, withdrawMessage } from "../src/index.js";
import { rulesMessage as engineRules } from "../../../engine/src/autoapply.js";
import { applyMessage as engineApply, closeMessage as engineClose, openJobIdOf as engineOpenJobId, postMessage as enginePost, withdrawMessage as engineWithdraw } from "../../../engine/src/openjobs.js";
import { verifyOwnerMessage } from "../src/index.js";
import { verifyMessage as engineVerify } from "../../../engine/src/verified.js";
import { AGENTS, DESK, JOB, KEY, state, stub, type Stub } from "./stub.js";

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
    expect(c).toEqual({ baseURL: `${s.api}/api/v1/compute`, openaiBaseURL: `${s.api}/api/v1/compute/v1`, apiKey: "fck_a-key-from-the-stub-0123456789ab", expiresAt: "2099-01-01T00:00:00.000Z", balanceUsd: 49.5, models: [{ id: "claude-sonnet-5-5", inUsd: 2.1, outUsd: 10.5 }], maxTokens: 16_000 });
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
    expect(TOOLS.map((t) => t.name)).toEqual(["factor_overview", "factor_agents", "factor_agent", "factor_job", "factor_my_jobs", "factor_ledger", "factor_hire", "factor_accept", "factor_reject", "factor_set_title", "factor_register", "factor_set_profile", "factor_bond", "factor_can_draw", "factor_account", "factor_compute_credit", "factor_compute_models", "factor_ask_model", "factor_draw", "factor_deliver", "factor_decline", "factor_sign_up", "factor_create_pay_link", "factor_pay_link_info", "factor_pay_link", "factor_pay_x402", "factor_hire_for_job", "factor_job_tree", "factor_reject_sub_jobs", "factor_record", "factor_erc8004", "factor_link_erc8004", "factor_verified_owner", "factor_verify_owner", "factor_firms", "factor_firm_record", "factor_hire_firm", "factor_plan", "factor_subscribe", "factor_pay_month", "factor_stop_plan", "factor_draw_next_month", "factor_open_jobs", "factor_open_job", "factor_post_job", "factor_apply_to_job", "factor_bid", "factor_withdraw_offer", "factor_offers", "factor_pick_agent", "factor_close_job", "factor_auto_apply", "factor_set_auto_apply", "factor_auto_apply_now"]);
    for (const t of TOOLS) expect(t.description.length, t.name).toBeGreaterThan(40);
    expect(TOOLS.filter((t) => t.readOnly).map((t) => t.name)).toEqual(["factor_overview", "factor_agents", "factor_agent", "factor_job", "factor_my_jobs", "factor_ledger", "factor_can_draw", "factor_account", "factor_compute_credit", "factor_compute_models", "factor_pay_link_info", "factor_job_tree", "factor_record", "factor_erc8004", "factor_verified_owner", "factor_firms", "factor_firm_record", "factor_plan", "factor_open_jobs", "factor_open_job", "factor_offers", "factor_auto_apply"]);
    // the ones that spend or cannot be undone say so in capitals, where an assistant will not miss it
    for (const name of ["factor_hire", "factor_reject", "factor_bond", "factor_pay_link", "factor_pay_x402", "factor_hire_for_job", "factor_reject_sub_jobs", "factor_hire_firm", "factor_subscribe", "factor_pay_month", "factor_pick_agent"]) expect(TOOLS.find((t) => t.name === name)!.description).toMatch(/SPENDS ETH|SETTLES AT HALF/);
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

describe("agents that hire agents", () => {
  const plan = { parent: 12, agent: AGENTS[1].address, price: "10000000000000000", dueAt: 1_800_000_000, early: false, title: "Part of job 0012", brief: "The dates, one per line.", at: 1_799_990_000 };
  const far = new Date(Date.now() + 3 * 86_400_000).toISOString();
  afterEach(() => { s.site.state.subjobs = undefined; s.site.state.jobs = [JOB]; s.site.jobExtra = {}; s.site.tree = null; });

  it("signs a hire to the letter the engine checks", () => {
    expect(hireMessage(plan)).toBe(engineHire(plan));
    expect(planIdOf(plan)).toBe(enginePlanId(plan));
    expect(hireMessage({ ...plan, brief: "", early: true })).toBe(engineHire({ ...plan, brief: "", early: true }));
  });

  it("refuses before anything is signed or sent: switched off, another agent's job, itself, no room, the job already closed, a due time after the job's", async () => {
    const f = await connect({ privateKey: KEY });
    const before = s.node.calls.length;
    expect((await refusal(f.hireForJob(12, "page-smith", "0.01", "Build it"))).code).toBe("subjobs_off");
    s.site.state.subjobs = { enabled: true, maxDepth: 2, perParent: 5 };
    expect((await refusal(f.hireForJob(12, "page-smith", "0.01", "Build it"))).code).toBe("not_your_job");
    s.site.state.jobs = [{ ...JOB, agentId: f.address!, state: "advanced", dueAt: far }];
    s.site.jobExtra = { hiring: { open: true, freeEth: 0.02, freeWei: "20000000000000000", used: 0, perParent: 5, depth: 0, maxDepth: 2, dueBefore: far } };
    expect((await refusal(f.hireForJob(12, f.address!, "0.01", "Build it"))).code).toBe("self_hire");
    expect((await refusal(f.hireForJob(12, "lumen-07", "0.03", "Read it"))).message).toBe("Only 0.02 ETH is left of job 12's price to hire with.");
    expect((await refusal(f.hireForJob(12, "lumen-07", 0.01 as never, "Read it"))).code).toBe("bad_amount");
    s.site.jobExtra = { hiring: { open: false, why: "the job is no longer open", freeEth: 0.02, freeWei: "20000000000000000", used: 0, perParent: 5, depth: 0, maxDepth: 2, dueBefore: far } };
    expect((await refusal(f.hireForJob(12, "lumen-07", "0.01", "Read it"))).message).toBe("Job 12 cannot hire now: the job is no longer open.");
    // nothing reached the node as a transaction or a simulation, and nothing was signed or posted
    expect(s.node.calls.slice(before).filter((m) => m === "eth_sendRawTransaction" || m === "eth_call")).toEqual([]);
    expect(s.posts.filter((p) => p.path.startsWith("/subjobs"))).toEqual([]);
    s.site.jobExtra = { hiring: { open: true, freeEth: 0.02, freeWei: "20000000000000000", used: 0, perParent: 5, depth: 0, maxDepth: 2, dueBefore: far } };
    expect((await refusal(f.hireForJob(12, "lumen-07", "0.01", "Read it", { dueInHours: 100 }))).code).toBe("bad_due");
  });

  it("signs the hire with the wallet's own key and hands it to Factor before it would lock anything", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.state.subjobs = { enabled: true, maxDepth: 2, perParent: 5 };
    s.site.state.jobs = [{ ...JOB, agentId: f.address!, state: "advanced", dueAt: far }];
    s.site.jobExtra = { hiring: { open: true, freeEth: 0.02, freeWei: "20000000000000000", used: 0, perParent: 5, depth: 0, maxDepth: 2, dueBefore: far } };
    // a site that names no burn pot: refused there, after the plan and before any lock
    s.site.state.contracts = { ...s.site.state.contracts, burnPot: null };
    const r = await refusal(f.hireForJob(12, "lumen-07", "0.01", "Every date in the contract.", { maxEth: "0.0101" }));
    expect(r.code, r.message).toBe("wrong_pot");
    const sent = s.posts.filter((p) => p.path === "/subjobs/plan").at(-1)!.body as Record<string, unknown> & { signature: `0x${string}` };
    expect(sent).toMatchObject({ parent: 12, agent: AGENTS[0].address, price: "10000000000000000", early: false, title: "Part of job 0012", brief: "Every date in the contract." });
    const words = hireMessage(sent as unknown as Parameters<typeof hireMessage>[0]);
    expect((await recoverMessageAddress({ message: words, signature: sent.signature })).toLowerCase()).toBe(f.signer);
    // due before the job, at least an hour away
    expect(Number(sent.dueAt)).toBeLessThan(Date.parse(far) / 1000);
    expect(Number(sent.dueAt)).toBeGreaterThan(Date.now() / 1000 + 3600);
    // a cap under the price and its burn is refused once Factor has said what the burn is
    expect((await refusal(f.hireForJob(12, "lumen-07", "0.01", "Every date in the contract.", { maxEth: "0.01" }))).code).toBe("over_cap");
  });

  it("reads the chain of work, and the tools say it in words", async () => {
    const f = await connect();
    expect(await f.jobTree(12)).toBeNull();
    expect((await runTool(f, "factor_job_tree", { job: 12 }, null)).text).toBe("Job 12 hired nobody, and is not part of another job.");
    s.site.tree = { root: 12, burn: { deals: 2, eth: 0.0005 }, nodes: [
      { job: 12, id: "0012", parent: null, depth: 0, customer: "0xc1", agent: AGENTS[0].address, state: "half", priceEth: 0.04, title: "Summarise a contract", lockTx: "0x1", burnEth: 0.0004, via: "checkout", verified: true },
      { job: 13, id: "0013", parent: 12, depth: 1, customer: AGENTS[0].address, agent: AGENTS[1].address, state: "delivered", priceEth: 0.01, title: "The dates", lockTx: "0x2", burnEth: 0.0001, via: "kit", verified: true, canReject: true },
    ] };
    const text = (await runTool(f, "factor_job_tree", { job: 13 }, null)).text;
    expect(text).toContain("Customer's job 12 \"Summarise a contract\"");
    expect(text).toContain("  Hired 13 \"The dates\"");
    expect(text).toContain("Its customer may still reject the delivery");
    expect(text).toContain("2 deals in it added 0.0005 ETH to the burn.");
    // the tool that spends asks for a key, and is capped like a hire
    expect((await runTool(f, "factor_hire_for_job", { parent_job: 12, agent: "lumen-07", price: "0.01", brief: "x" }, null)).text).toMatch(/No wallet key is set/);
  });
});


describe("agent firms", () => {
  const LEAD = "0x00000000000000000000000000000000000000a1", MEMBER = "0x00000000000000000000000000000000000000a2";
  const firm = { slug: "figure-check-co", name: "Figure Check Co", does: "Market notes, every figure checked", house: false, lead: { address: LEAD, name: "lumen-07", named: true }, members: [{ address: LEAD, name: "lumen-07", named: true, role: "lead", since: null, part: { jobs: 2, settled: 1, settledEth: 0.01, settledWei: "10000000000000000" } }, { address: MEMBER, name: "page-smith", named: true, role: "member", since: null, part: { jobs: 1, settled: 1, settledEth: 0.002, settledWei: "2000000000000000" } }], since: "2026-10-18T00:00:00.000Z", hired: 2, settled: 1, settledEth: 0.01 };

  it("signs to the letter the words the engine checks", () => {
    const f = { slug: "figure-check-co", name: "Figure Check Co", does: "Market notes", lead: LEAD, members: [MEMBER], at: 1_800_000_000 };
    expect(firmMessage(f)).toBe(engineFirm(f));
    expect(joinMessage({ slug: f.slug, lead: LEAD, member: MEMBER, at: 1 })).toBe(engineJoin({ slug: f.slug, lead: LEAD, member: MEMBER, at: 1 }));
    expect(leaveMessage({ slug: f.slug, member: MEMBER, at: 1 })).toBe(engineLeave({ slug: f.slug, member: MEMBER, at: 1 }));
    for (const brief of ["", "Line one\nLine two"]) expect(firmHireMessage({ slug: f.slug, lead: LEAD, job: 9, title: "A note", brief, at: 1 })).toBe(engineFirmHire({ slug: f.slug, lead: LEAD, job: 9, title: "A note", brief, at: 1 }));
    for (const n of ["Figure Check & Co.", "  The   Research Desk ", "Ünïcode Desk"]) expect(slugOf(n)).toBe(engineSlug(n));
    const link = { v: 1 as const, agent: LEAD, price: "10000000000000000", title: "A note", brief: "", due: 24, early: true, exp: 1_800_000_000, id: "0123456789abcdef" };
    expect(payLinkMessage({ ...link, firm: "figure-check-co" })).toBe(enginePayLink({ ...link, firm: "figure-check-co" }));
    expect(payLinkMessage(link)).toBe(enginePayLink(link));
  });

  it("forms a firm with the agents named, signed by the lead's own key", async () => {
    const f = await connect({ privateKey: KEY });
    const r = await f.formFirm({ name: "Figure Check Co", does: "Market notes, every figure checked", members: ["page-smith"] });
    expect(r).toMatchObject({ slug: "figure-check-co", edited: false, invited: [AGENTS[1]!.address] });
    expect(r.url).toMatch(/\/firms\/figure-check-co$/);
    const sent = s.posts.at(-1)!;
    expect(sent.path).toBe("/firms/form");
    const b = sent.body as { name: string; does: string; lead: string; members: string[]; at: number; signature: `0x${string}`; slug: string };
    expect((await recoverMessageAddress({ message: engineFirm(b), signature: b.signature })).toLowerCase()).toBe(b.lead);
    expect((await refusal(f.formFirm({ name: "Figure Check Co", does: "Market notes", members: ["nobody-here"] }))).code).toBe("no_agent");
  });

  it("reads firms and a firm's record, and its tools say them in words", async () => {
    s.site.firms = [firm];
    s.site.firm = { enabled: true, firm, record: null, jobs: [], links: [] };
    s.site.firmRecord = { version: 1, firm: "figure-check-co", name: "Figure Check Co", does: "Market notes", house: false, lead: LEAD, chainId: 4663, desk: DESK, block: 100, asOf: "", since: "", members: [{ address: LEAD, name: "lumen-07", role: "lead", jobs: 2, settled: 1, settledWei: "1" }], jobs: { hired: 2, open: 1, delivered: 0, settled: 1, settledAtHalf: 0, declined: 0, refunded: 0 }, subJobs: { count: 3, settled: 2, toMembers: 2, toOthers: 1 }, settledWei: "10000000000000000", settledEth: "0.01", customers: 1, page: "https://factoragents.fun/firms/figure-check-co", badge: "", attestation: null };
    const f = await connect();
    expect((await f.firms()).map((x) => x.slug)).toEqual(["figure-check-co"]);
    expect((await f.firm("figure-check-co"))?.firm.lead.name).toBe("lumen-07");
    expect(await f.firm("Not A Slug")).toBeNull();
    expect((await f.firmRecord("figure-check-co")).subJobs.toOthers).toBe(1);
    s.site.firmRecord = null;
    expect((await refusal(f.firmRecord("no-such-firm-x"))).code).toBe("no_firm");
    expect((await runTool(f, "factor_firms", {}, null)).text).toMatch(/Figure Check Co \(figure-check-co\): Market notes, every figure checked\. Led by lumen-07, with page-smith\. 2 jobs hired, 1 settled/);
    s.site.firmRecord = { ...(s.site.firm as { firm: unknown }), version: 1, firm: "figure-check-co", name: "Figure Check Co", does: "Market notes", house: false, lead: LEAD, block: 100, members: [{ address: LEAD, name: "lumen-07", role: "lead", jobs: 2, settled: 1, settledWei: "1" }], jobs: { hired: 2, open: 1, delivered: 0, settled: 1, settledAtHalf: 0, declined: 0, refunded: 0 }, subJobs: { count: 3, settled: 2, toMembers: 2, toOthers: 1 }, settledEth: "0.01", customers: 1, page: "https://factoragents.fun/firms/figure-check-co", attestation: null };
    expect((await runTool(f, "factor_firm_record", { firm: "figure-check-co" }, null)).text).toMatch(/Sub-jobs: 3 \(2 settled\), 2 to members and 1 to agents outside the firm/);
    expect((await runTool(f, "factor_hire_firm", { firm: "figure-check-co", price: "0.01", title: "A note" }, null)).text).toMatch(/No wallet key is set/);
  });

  it("hires a firm only while firms are on, and sells a firm's work by link only as its lead", async () => {
    s.site.firm = { enabled: true, firm, record: null, jobs: [], links: [] };
    const f = await connect({ privateKey: KEY });
    s.site.state = state();
    expect((await refusal(f.hireFirm("figure-check-co", { price: "0.01", title: "A note" }))).code).toBe("firms_off");
    s.site.state = state({ firms: { enabled: true, count: 1, mostMembers: 8, items: [] } } as never);
    s.site.firm = null;
    expect((await refusal(f.hireFirm("no-such-firm-x", { price: "0.01", title: "A note" }))).code).toBe("no_firm");
    s.site.firm = { enabled: true, firm, record: null, jobs: [], links: [] };
    expect((await refusal(f.hireFirm("figure-check-co", { price: "0.02", title: "A note", maxEth: "0.01" }))).code).toBe("over_cap");
    expect((await refusal(f.createPayLink({ price: "0.01", title: "A note", firm: "figure-check-co" }))).code).toBe("not_lead");
    s.site.state = state();
  });
});

describe("monthly clients", () => {
  const AGENT = "0x00000000000000000000000000000000000000a1", ME = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  const ID = `0x${"cd".repeat(32)}`;
  const plan = (over: Record<string, unknown> = {}) => ({
    id: ID, status: "active", customer: "0x00000000000000000000000000000000000000c1", agent: { address: AGENT, name: "lumen-07", named: true }, title: "A weekly market note", brief: "", priceEth: 0.01, priceWei: "10000000000000000", months: 2, early: true, via: "kit",
    signedAt: "2026-10-19T08:00:00.000Z", startAt: "2026-10-19T08:00:00.000Z", stoppedAt: null, locked: 1, delivered: 1, settled: 0, paidEth: 0, lockedEth: 0.01,
    items: [{ month: 1, job: 12, id: "0012", state: "delivered", dueAt: "2026-11-18T08:00:00.000Z", beginsAt: "2026-10-19T08:00:00.000Z", late: false, upFrontEth: 0.005, fromPoolEth: 0, burnEth: 0.0001, lockTx: "0xabc" }],
    next: { month: 2, open: true, dueAt: "2026-11-18T09:00:00.000Z", lapsesAt: "2026-12-18T07:00:00.000Z" },
    drawEarly: { month: 2, job: 13, ahead: true, open: false, why: "the agent has settled 0 jobs: next month early takes 3", fromPoolEth: 0, fromPoolWei: "0", upFrontEth: 0.005 },
    signed: { message: "", signature: "0x", by: "0x00000000000000000000000000000000000000c1" }, ...over,
  });

  it("signs to the letter the words the engine checks, and a subscribe link says its months", () => {
    const p = { customer: ME, agent: AGENT, price: "10000000000000000", months: 6, early: true, title: "A weekly market note", brief: "Line one\nLine two", at: 1_800_000_000 };
    expect(planMessage(p)).toBe(enginePlan(p));
    expect(planMessage({ ...p, firm: "the-weekly-note", early: false, brief: "" })).toBe(enginePlan({ ...p, firm: "the-weekly-note", early: false, brief: "" }));
    expect(monthlyPlanId(p)).toBe(enginePlanIdOf(p));
    expect(stopPlanMessage({ plan: ID, customer: ME, at: 1 })).toBe(engineStop({ plan: ID, customer: ME, at: 1 }));
    const link = { v: 1 as const, agent: AGENT, price: "10000000000000000", title: "A note", brief: "", due: 720, early: true, exp: 1_800_000_000, id: "0123456789abcdef", months: 6 };
    expect(payLinkMessage(link)).toBe(enginePayLink(link));
  });

  it("subscribes only while plans are on, within the months and the caps", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.state = state();
    expect((await refusal(f.subscribe({ agent: "lumen-07", price: "0.01", months: 2, title: "A note" }))).code).toBe("plans_off");
    s.site.state = state({ plans: { enabled: true, mostMonths: 12, active: 0, clients: 0, monthlyEth: 0 } } as never);
    expect((await refusal(f.subscribe({ agent: "lumen-07", price: "0.01", months: 13, title: "A note" }))).code).toBe("bad_months");
    expect((await refusal(f.subscribe({ agent: "lumen-07", price: "0.0001", months: 2, title: "A note" }))).code).toBe("bad_amount");
    expect((await refusal(f.subscribe({ agent: "nobody-here", price: "0.01", months: 2, title: "A note" }))).code).toBe("no_agent");
    expect((await refusal(f.subscribe({ agent: "lumen-07", price: "0.01", months: 2, title: "x".repeat(61) }))).code).toBe("bad_text");
    // the plan is signed by the customer's own key; a month over the cap is never locked
    const before = s.posts.length;
    expect((await refusal(f.subscribe({ agent: "lumen-07", price: "0.01", months: 2, title: "A note", maxEth: "0.005" }))).code).toBe("over_cap");
    const sent = s.posts.slice(before).find((x) => x.path === "/plans/create")!;
    const b = sent.body as { customer: string; agent: string; price: string; months: number; early: boolean; title: string; brief: string; at: number; signature: `0x${string}` };
    expect(b).toMatchObject({ agent: AGENT, months: 2, price: "10000000000000000", early: false, via: "kit" });
    expect((await recoverMessageAddress({ message: enginePlan(b), signature: b.signature })).toLowerCase()).toBe(b.customer);
    s.site.state = state();
  });

  it("reads a plan, and keeps each side to its own calls", async () => {
    s.site.plan = { enabled: true, plan: plan(), jobs: [], burnWei: "100000000000000" };
    const f = await connect({ privateKey: KEY });
    expect((await f.plan(ID))?.plan.title).toBe("A weekly market note");
    expect(await f.plan("0x12")).toBeNull();
    expect((await refusal(f.payMonth(ID))).code).toBe("not_your_plan");
    expect((await refusal(f.drawNextMonth(ID))).code).toBe("not_your_plan");
    s.site.plan = { enabled: true, plan: plan({ agent: { address: f.address, name: "me", named: true } }), jobs: [], burnWei: "0" };
    expect((await refusal(f.drawNextMonth(ID))).code).toBe("not_offered");
    s.site.plan = { enabled: true, plan: plan({ customer: f.address, next: { month: 2, open: false, why: "month 1 is not delivered yet", from: "2026-11-18T08:00:00.000Z", lapsesAt: "2026-12-18T07:00:00.000Z" } }), jobs: [], burnWei: "0" };
    expect((await refusal(f.payMonth(ID))).message).toMatch(/Month 2 cannot be locked yet: month 1 is not delivered yet, or from 2026-11-18 08:00 UTC/);
    s.site.plan = { enabled: true, plan: plan(), jobs: [], burnWei: "0" };
    const text = (await runTool(f, "factor_plan", { plan: ID }, null)).text;
    expect(text).toMatch(/"A weekly market note": lumen-07, 0.01 ETH a month for 2 months\. It is active/);
    expect(text).toMatch(/Month 1: job 0012, delivered, due 2026-11-18 08:00 UTC, 0.005 ETH drawn up front/);
    expect(text).toMatch(/Month 2 can be locked now/);
    expect(text).toMatch(/Month 2 from the pool: not offered, the agent has settled 0 jobs/);
    expect((await refusal(f.createPayLink({ price: "0.01", title: "A note", months: 30 }))).code).toBe("bad_months");
    s.site.plan = null;
  });
});

describe("ERC-8004", () => {
  it("links an identity with the agent's own signature, over the engine's words to the letter, and refuses a number that is not one", async () => {
    expect(erc8004Registry(4663)).toBe(engineRegistry(4663, "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"));
    const words = { agent: AGENTS[0]!.address, agentId: "42", registry: erc8004Registry(4663), at: 1_760_000_000 };
    expect(erc8004LinkMessage(words)).toBe(engineLink(words));
    expect(erc8004LinkMessage({ ...words, agentId: null })).toBe(engineLink({ ...words, agentId: null }));
    const f = await connect({ privateKey: KEY });
    expect(await f.linkErc8004(42)).toEqual({ agentId: "42", via: "wallet" });
    const sent = s.posts.at(-1)!;
    expect(sent.path).toBe("/erc8004/link");
    const b = sent.body as { agent: string; agentId: string; at: number; signature: `0x${string}` };
    expect((await recoverMessageAddress({ message: engineLink({ agent: b.agent, agentId: b.agentId, registry: erc8004Registry(4663), at: b.at }), signature: b.signature })).toLowerCase()).toBe(f.address);
    expect((await f.linkErc8004(null)).agentId).toBeNull();
    expect((await refusal(f.linkErc8004("forty-two"))).code).toBe("bad_identity");
    expect((await refusal((await connect()).linkErc8004(1))).code).toBe("read_only");
  });

  it("its tool says what the registry has for an agent, linked or not", async () => {
    const f = await connect();
    s.site.erc8004 = { enabled: true, agent: AGENTS[0]!.address, erc8004: null, found: [{ agentId: "5", via: "wallet" }, { agentId: "9", via: "owner" }], registry: erc8004Registry(4663), reviewer: null };
    expect((await runTool(f, "factor_erc8004", { agent: "lumen-07" }, null)).text).toMatch(/No identity is linked yet\. The ERC-8004 registry has #5 \(by its agentWallet\), #9 \(by its owner\)/);
    s.site.erc8004 = { ...(s.site.erc8004 as object), found: [], none: true };
    expect((await runTool(f, "factor_erc8004", { agent: "lumen-07" }, null)).text).toMatch(/wants no ERC-8004 identity linked/);
    s.site.erc8004 = null;
    expect((await runTool(f, "factor_erc8004", { agent: "nobody-here" }, null)).text).toMatch(/There is no agent "nobody-here"/);
  });
});


describe("open jobs", () => {
  const ID = `0x${"ef".repeat(32)}`;
  const C1 = "0x00000000000000000000000000000000000000c1";
  const listing = (over: Record<string, unknown> = {}) => ({
    id: ID, status: "open", note: "Taking applications until 2026-10-22 08:00 UTC. The customer picks an applicant by locking the price for it.", customer: C1, title: "Check the figures in our note", brief: "",
    priceEth: 0.004, priceWei: "4000000000000000", burnWei: "40000000000000", dueHours: 48, early: true, postedAt: "2026-10-21T08:00:00.000Z", closesAt: "2026-10-22T08:00:00.000Z", pick: { by: "customer" },
    applying: true, count: 2, most: 20,
    applicants: [
      { rank: 1, address: AGENTS[0]!.address, name: "lumen-07", named: true, house: false, score: 624, settled: 4, customers: 2, onTimePct: 100, barred: false, pitch: "Four jobs settled, all on time", appliedAt: "2026-10-21T08:10:00.000Z" },
      { rank: 2, address: AGENTS[1]!.address, name: "page-smith", named: true, house: true, score: 580, settled: 4, customers: 2, onTimePct: 100, barred: false, pitch: "", appliedAt: "2026-10-21T08:05:00.000Z" },
    ],
    ...over,
  });

  it("signs to the letter the words the engine checks", () => {
    const p = { customer: C1, price: "4000000000000000", dueHours: 48, early: true, title: "Check the figures", brief: "Line one\nLine two", closesAt: 1_800_000_000, pick: { by: "best" as const, after: 3 }, at: 1_799_990_000 };
    expect(postJobMessage(p)).toBe(enginePost(p));
    expect(postJobMessage({ ...p, pick: { by: "customer" }, early: false, brief: "" })).toBe(enginePost({ ...p, pick: { by: "customer" }, early: false, brief: "" }));
    expect(openJobId(p)).toBe(engineOpenJobId(p));
    expect(applyMessage({ open: ID, agent: C1, pitch: "", at: 1 })).toBe(engineApply({ open: ID, agent: C1, pitch: "", at: 1 }));
    expect(applyMessage({ open: ID, agent: C1, pitch: "On time, every time", at: 1 })).toBe(engineApply({ open: ID, agent: C1, pitch: "On time, every time", at: 1 }));
    expect(closeJobMessage({ open: ID, customer: C1, at: 1 })).toBe(engineClose({ open: ID, customer: C1, at: 1 }));
  });

  it("posts only while open jobs are on, signed by the customer's own key, with nothing locked", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.state = state();
    expect((await refusal(f.postJob({ title: "Check the figures", price: "0.004" }))).code).toBe("openjobs_off");
    s.site.state = state({ openJobs: { enabled: true, maxApplicants: 20, open: 0, applicants: 0, hired: 0 } } as never);
    expect((await refusal(f.postJob({ title: "Check the figures", price: "0.0001" }))).code).toBe("bad_amount");
    expect((await refusal(f.postJob({ title: "Check the figures", price: "0.004", closesInHours: 400 }))).code).toBe("bad_close");
    expect((await refusal(f.postJob({ title: "Check the figures", price: "0.004", pickAfter: 3 }))).code).toBe("bad_pick");
    expect((await refusal(f.postJob({ title: "see https://example.com", price: "0.004" }))).code).toBe("bad_text");
    const calls = s.node.calls.length;
    const r = await f.postJob({ title: "Check the figures", price: "0.004", dueInHours: 48, allowEarly: true, closesInHours: 6, pick: "best", pickAfter: 3 });
    expect(r).toMatchObject({ id: ID, created: true, burnWei: 40_000_000_000_000n });
    expect(r.url).toMatch(/\/open-jobs\/0x(ef){32}$/);
    // a signature, and no transaction: nothing was sent to the node
    expect(s.node.calls.slice(calls).filter((m) => m === "eth_sendRawTransaction" || m === "eth_sendTransaction")).toEqual([]);
    const b = s.posts.at(-1)!.body as { customer: string; price: string; dueHours: number; early: boolean; title: string; brief: string; closesAt: number; pick: string; pickAfter: number; at: number; signature: `0x${string}`; via: string };
    expect(b).toMatchObject({ price: "4000000000000000", dueHours: 48, early: true, pick: "best", pickAfter: 3, via: "kit" });
    expect(b.closesAt - b.at).toBe(6 * 3600);
    const words = enginePost({ customer: b.customer, price: b.price, dueHours: b.dueHours, early: b.early, title: b.title, brief: b.brief, closesAt: b.closesAt, pick: { by: "best", after: b.pickAfter }, at: b.at });
    expect((await recoverMessageAddress({ message: words, signature: b.signature })).toLowerCase()).toBe(b.customer);
    s.site.state = state();
  });

  it("applies with the agent's own signature and a line of its own, and refuses what it cannot apply for", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.openJob = { enabled: true, open: listing() };
    const r = await f.applyToJob(ID, { pitch: "Four jobs settled, all on time" });
    expect(r).toEqual({ open: ID, rank: 1, of: 1, listing: "open" });
    const b = s.posts.at(-1)!.body as { open: string; agent: string; pitch: string; at: number; signature: `0x${string}` };
    expect(b.agent).toBe(f.address);
    expect((await recoverMessageAddress({ message: engineApply(b), signature: b.signature })).toLowerCase()).toBe(f.address);
    expect((await refusal(f.applyToJob(ID, { pitch: "my site is https://example.com" }))).code).toBe("bad_text");
    s.site.openJob = { enabled: true, open: listing({ customer: f.address }) };
    expect((await refusal(f.applyToJob(ID))).code).toBe("self_hire");
    s.site.openJob = { enabled: true, open: listing({ applying: false, why: "applications for this job have closed" }) };
    expect((await refusal(f.applyToJob(ID))).message).toBe("Applications for this job have closed.");
    expect((await refusal((await connect()).applyToJob(ID))).code).toBe("read_only");
    s.site.openJob = null;
    expect((await refusal(f.applyToJob(ID))).code).toBe("no_open_job");
  });

  it("picks only for the customer's own listing, an applicant, the one Factor picked, under the cap", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.openJob = { enabled: true, open: listing() };
    expect((await refusal(f.pickAgent(ID))).code).toBe("not_your_job");
    s.site.openJob = { enabled: true, open: listing({ customer: f.address }) };
    expect((await refusal(f.pickAgent(ID, { agent: "nobody-here" }))).code).toBe("not_an_applicant");
    expect((await refusal(f.pickAgent(ID, { maxEth: "0.004" }))).code).toBe("over_cap");
    s.site.openJob = { enabled: true, open: listing({ customer: f.address, status: "picked", picked: { address: AGENTS[1]!.address, name: "page-smith", named: true, by: "factor", at: "2026-10-22T08:00:00.000Z" } }) };
    expect((await refusal(f.pickAgent(ID, { agent: "lumen-07" }))).code).toBe("factor_picked");
    s.site.openJob = { enabled: true, open: listing({ customer: f.address, job: { n: 7, id: "0007", lockTx: "0xabc", burnEth: 0 } }) };
    expect((await refusal(f.pickAgent(ID))).code).toBe("hired");
    s.site.openJob = { enabled: true, open: listing({ customer: f.address, applicants: [], count: 0 }) };
    expect((await refusal(f.pickAgent(ID))).code).toBe("no_applicants");
    s.site.openJob = null;
  });

  it("the tools read the board and one listing in words, and close one with a signature", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.openJobs = [listing()];
    s.site.openJob = { enabled: true, open: listing() };
    const board = (await runTool(f, "factor_open_jobs", {}, null)).text;
    expect(board).toMatch(/"Check the figures in our note", 0.004 ETH, due 48 hours after it is locked, half may be drawn early\. open: /);
    expect(board).toMatch(/2 applied \(first: lumen-07 624, page-smith 580\)\. Taking applications\./);
    const one = (await runTool(f, "factor_open_job", { open: ID }, null)).text;
    expect(one).toMatch(/1\. lumen-07 \(0x0+a1\): Factor Score 624, 4 jobs settled\. "Four jobs settled, all on time"/);
    expect(one).toMatch(/2\. page-smith/);
    expect((await runTool(f, "factor_close_job", { open: ID }, null)).text).toMatch(/taken down/);
    const b = s.posts.at(-1)!.body as { open: string; at: number; signature: `0x${string}` };
    expect(s.posts.at(-1)!.path).toBe("/openjobs/close");
    expect((await recoverMessageAddress({ message: engineClose({ open: b.open, customer: f.address!, at: b.at }), signature: b.signature })).toLowerCase()).toBe(f.address);
    s.site.openJobs = [];
    s.site.openJob = null;
  });
});

describe("auto-apply", () => {
  let s: Stub;
  beforeAll(async () => { s = await stub(); });
  afterAll(async () => { await s.close(); });
  const connect = (o: Partial<FactorOptions> = {}) => Factor.connect({ api: s.api, rpcUrl: s.rpc, ...o });
  const ID = `0x${"ef".repeat(32)}`;
  const RULES = { on: true, takes: ["Landing pages"], words: ["bakery"], floorWei: "3000000000000000", atOnce: 2, hours: null, early: true, pitch: "One page from your brief" };
  const status = (over: Record<string, unknown> = {}) => ({ enabled: true, agent: "", name: "page-smith", runBy: "self", setters: [], kinds: [], rules: RULES, log: [{ kind: "applied", open: ID, title: "A one-page site for our bakery", note: "Applied with one signature, ranked 1 of 1 by Factor Score", at: "2026-10-22T08:00:00.000Z" }], fits: [ID], limits: { perAgentHour: 6, perHour: 60, atOnceMost: 10 }, ...over });

  it("signs to the letter the words the engine checks", () => {
    const r = { ...RULES, agent: "0x00000000000000000000000000000000000000a2", by: "0x00000000000000000000000000000000000000c1", at: 1_800_000_000 };
    expect(rulesMessage(r)).toBe(engineRules(r));
    expect(rulesMessage({ ...r, on: false, takes: [], words: [], hours: { from: 22, to: 6 }, early: false, pitch: "", atOnce: 1 })).toBe(engineRules({ ...r, on: false, takes: [], words: [], hours: { from: 22, to: 6 }, early: false, pitch: "", atOnce: 1 }));
  });

  it("sets the rules with the agent's own signature while auto-apply is on, and refuses rules that make no sense", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.state = state();
    expect((await refusal(f.setAutoApply({ takes: ["Landing pages"] }))).code).toBe("autoapply_off");
    s.site.state = state({ autoApply: { enabled: true, agents: 0, applied: 0 } } as never);
    expect((await refusal(f.setAutoApply({ takes: ["Anything"] }))).code).toBe("bad_kind");
    expect((await refusal(f.setAutoApply({}))).code).toBe("bad_kind");
    expect((await refusal(f.setAutoApply({ takes: ["Code"], from: "0.0001" }))).code).toBe("bad_amount");
    expect((await refusal(f.setAutoApply({ takes: ["Code"], atOnce: 11 }))).code).toBe("bad_count");
    expect((await refusal(f.setAutoApply({ takes: ["Code"], hours: { from: 3, to: 3 } }))).code).toBe("bad_hours");
    expect((await refusal(f.setAutoApply({ words: ["see https://example.com"] }))).code).toBe("bad_text");
    const r = await f.setAutoApply({ takes: ["Landing pages"], words: ["bakery"], from: "0.003", atOnce: 2, early: true, pitch: "One page from your brief" });
    expect(r).toMatchObject({ on: true, takes: ["Landing pages"], floorWei: "3000000000000000", atOnce: 2, early: true });
    const b = s.posts.at(-1)!.body as typeof RULES & { agent: string; by: string; at: number; signature: `0x${string}` };
    expect(s.posts.at(-1)!.path).toBe("/autoapply/rules");
    expect(b.agent).toBe(f.address);
    expect((await recoverMessageAddress({ message: engineRules(b), signature: b.signature })).toLowerCase()).toBe(f.address);
    s.site.state = state();
  });

  it("applies on its own to what Factor found, marked as automatic, from a watch that stops", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.autoApply = status({ agent: f.address });
    s.site.openJob = { enabled: true, open: { id: ID, status: "open", note: "", customer: "0x00000000000000000000000000000000000000c1", title: "A one-page site for our bakery", brief: "", priceEth: 0.004, priceWei: "4000000000000000", burnWei: "0", dueHours: 24, early: true, postedAt: "", closesAt: "", pick: { by: "customer" }, applying: true, count: 0, most: 20, applicants: [] } };
    const applied: string[] = [];
    const w = f.watchOpenJobs({ onApplied: (a) => applied.push(`${a.open} ${a.title}`), everyMs: 60_000 });
    for (let i = 0; i < 50 && !applied.length; i++) await new Promise((r) => setTimeout(r, 20));
    w.stop();
    await w.done;
    expect(applied).toEqual([`${ID} A one-page site for our bakery`]);
    const b = s.posts.filter((p) => p.path === "/openjobs/apply").at(-1)!.body as { pitch: string; auto: boolean };
    expect(b).toMatchObject({ pitch: "One page from your brief", auto: true });
    const said = (await runTool(f, "factor_auto_apply", {}, null)).text;
    expect(said).toMatch(/auto-apply is on\. It runs itself/);
    expect(said).toMatch(/Rules: takes Landing pages, "bakery"; from 0\.003 ETH a job; up to 2 at a time; hours always; draws the half up front/);
    expect(said).toMatch(/applied: Applied with one signature/);
    expect((await runTool(f, "factor_auto_apply_now", {}, null)).text).toMatch(/applied, ranked 1 of 1/);
    s.site.autoApply = null;
    s.site.openJob = null;
  });
});

describe("offers", () => {
  let s: Stub;
  beforeAll(async () => { s = await stub(); });
  afterAll(async () => { await s.close(); });
  const connect = (o: Partial<FactorOptions> = {}) => Factor.connect({ api: s.api, rpcUrl: s.rpc, ...o });
  const ID = `0x${"cd".repeat(32)}`;
  const C1 = "0x00000000000000000000000000000000000000c1";
  const offer = (milli: number, hours: number, over: Record<string, unknown> = {}) => ({ priceWei: (BigInt(milli) * 10n ** 15n).toString(), priceEth: milli / 1000, burnWei: (BigInt(milli) * 10n ** 13n).toString(), dueHours: hours, changes: 0, ...over });
  const listing = (over: Record<string, unknown> = {}) => ({
    id: ID, status: "open", note: "Taking offers until 2026-10-23 18:00 UTC.", customer: C1, title: "Check every figure in our quarterly note", brief: "",
    priceEth: 0, priceWei: "0", burnWei: "0", offers: true, budgetWei: "6000000000000000", budgetEth: 0.006, dueHours: 48, early: true, postedAt: "2026-10-23T08:00:00.000Z", closesAt: "2026-10-23T18:00:00.000Z", pick: { by: "customer" },
    applying: true, count: 3, most: 20,
    applicants: [
      { rank: 1, address: AGENTS[0]!.address, name: "lumen-07", named: true, house: false, score: 624, settled: 4, customers: 2, onTimePct: 100, barred: false, pitch: "", appliedAt: "", offer: offer(5, 24) },
      { rank: 2, address: AGENTS[1]!.address, name: "page-smith", named: true, house: true, score: 580, settled: 4, customers: 2, onTimePct: 100, barred: false, pitch: "", appliedAt: "", offer: offer(4, 12) },
      { rank: 3, address: "0x00000000000000000000000000000000000000d3", name: "quill-02", named: true, house: false, score: 300, settled: 1, customers: 1, onTimePct: 100, barred: false, pitch: "", appliedAt: "", offer: offer(3, 6, { ended: true }) },
    ],
    ...over,
  });
  const on = () => state({ openJobs: { enabled: true, maxApplicants: 20, open: 0, applicants: 0, hired: 0, bids: true }, autoApply: { enabled: true, agents: 0, applied: 0 } } as never);

  it("signs to the letter the words the engine checks", () => {
    const p = { customer: C1, price: "6000000000000000", dueHours: 48, early: true, title: "Check the figures", brief: "", closesAt: 1_800_000_000, pick: { by: "customer" as const }, at: 1_799_990_000, offers: true };
    expect(postJobMessage(p)).toBe(enginePost(p));
    expect(postJobMessage({ ...p, price: "0" })).toBe(enginePost({ ...p, price: "0" }));
    expect(openJobId(p)).toBe(engineOpenJobId(p));
    const o = { open: ID, agent: C1, pitch: "On time", at: 1, offer: { priceWei: "4500000000000000", dueHours: 24, until: null } };
    expect(applyMessage(o)).toBe(engineApply(o));
    expect(applyMessage({ ...o, offer: { ...o.offer, until: 1_800_000_000 } })).toBe(engineApply({ ...o, offer: { ...o.offer, until: 1_800_000_000 } }));
    expect(withdrawMessage({ open: ID, agent: C1, at: 1 })).toBe(engineWithdraw({ open: ID, agent: C1, at: 1 }));
    const r = { on: true, takes: ["Research"], words: [], floorWei: "3000000000000000", atOnce: 2, hours: null, early: true, pitch: "", bid: { normalWei: "5000000000000000", freeWei: "4000000000000000", hours: 24 }, agent: C1, by: C1, at: 1 };
    expect(rulesMessage(r)).toBe(engineRules(r));
  });

  it("posts a job open to offers only while offers are on, with a budget or none, and never picked by Factor", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.state = state({ openJobs: { enabled: true, maxApplicants: 20, open: 0, applicants: 0, hired: 0 } } as never);
    expect((await refusal(f.postJob({ title: "Check the figures", offers: true }))).code).toBe("offers_off");
    s.site.state = on();
    expect((await refusal(f.postJob({ title: "Check the figures", offers: true, price: "0.004" }))).code).toBe("bad_amount");
    expect((await refusal(f.postJob({ title: "Check the figures", offers: true, budget: "0.0001" }))).code).toBe("bad_amount");
    expect((await refusal(f.postJob({ title: "Check the figures", offers: true, pick: "best" }))).code).toBe("bad_pick");
    expect((await refusal(f.postJob({ title: "Check the figures" }))).code).toBe("bad_amount");
    await f.postJob({ title: "Check the figures", offers: true, budget: "0.006", dueInHours: 48 });
    const b = s.posts.at(-1)!.body as { customer: string; price: string; dueHours: number; early: boolean; title: string; brief: string; closesAt: number; pick: string; at: number; signature: `0x${string}`; offers: boolean };
    expect(b).toMatchObject({ price: "6000000000000000", offers: true, pick: "customer" });
    const words = enginePost({ customer: b.customer, price: b.price, dueHours: b.dueHours, early: b.early, title: b.title, brief: b.brief, closesAt: b.closesAt, pick: { by: "customer" }, at: b.at, offers: true });
    expect((await recoverMessageAddress({ message: words, signature: b.signature })).toLowerCase()).toBe(b.customer);
    await f.postJob({ title: "Check the figures", offers: true });
    expect((s.posts.at(-1)!.body as { price: string }).price).toBe("0");
    s.site.state = state();
  });

  it("bids with the agent's own signature, within the budget and the job's time, and withdraws", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.openJob = { enabled: true, open: listing() };
    expect((await refusal(f.applyToJob(ID))).code).toBe("needs_offer");
    expect((await refusal(f.bid(ID, { price: "0.007", dueInHours: 24 }))).code).toBe("over_budget");
    expect((await refusal(f.bid(ID, { price: "0.004", dueInHours: 49 }))).code).toBe("bad_due");
    expect((await refusal(f.bid(ID, { price: "0.0001", dueInHours: 24 }))).code).toBe("bad_amount");
    const r = await f.bid(ID, { price: "0.0045", dueInHours: 24, standsForHours: 6, pitch: "Every figure, twice" });
    expect(r).toMatchObject({ rank: 1, of: 1, offer: { priceWei: "4500000000000000", dueHours: 24 } });
    const b = s.posts.at(-1)!.body as { open: string; agent: string; pitch: string; at: number; signature: `0x${string}`; priceWei: string; dueHours: number; until: number };
    expect(b).toMatchObject({ priceWei: "4500000000000000", dueHours: 24, until: b.at + 6 * 3600 });
    const words = engineApply({ open: b.open, agent: b.agent, pitch: b.pitch, at: b.at, offer: { priceWei: b.priceWei, dueHours: b.dueHours, until: b.until } });
    expect((await recoverMessageAddress({ message: words, signature: b.signature })).toLowerCase()).toBe(f.address);
    // a job with a fixed price takes no offer
    s.site.openJob = { enabled: true, open: listing({ offers: false, priceWei: "4000000000000000", priceEth: 0.004 }) };
    expect((await refusal(f.bid(ID, { price: "0.004", dueInHours: 24 }))).code).toBe("fixed_price");
    expect(await f.withdrawOffer(ID)).toEqual({ withdrawn: true });
    const w = s.posts.at(-1)!;
    expect(w.path).toBe("/openjobs/withdraw");
    const wb = w.body as { open: string; agent: string; at: number; signature: `0x${string}` };
    expect((await recoverMessageAddress({ message: engineWithdraw(wb), signature: wb.signature })).toLowerCase()).toBe(f.address);
    s.site.openJob = null;
  });

  it("reads the offers side by side, sorted by score, price or speed, ended ones last, and picks at the offer's own price", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.openJob = { enabled: true, open: listing() };
    expect((await f.offers(ID)).map((x) => x.name)).toEqual(["lumen-07", "page-smith", "quill-02"]);
    expect((await f.offers(ID, "price")).map((x) => x.name)).toEqual(["page-smith", "lumen-07", "quill-02"]);
    expect((await f.offers(ID, "fast")).map((x) => x.name)).toEqual(["page-smith", "lumen-07", "quill-02"]);
    s.site.openJob = { enabled: true, open: listing({ customer: f.address }) };
    // the cap meets the offer's own price and its burn: never the budget
    expect((await refusal(f.pickAgent(ID, { maxEth: "0.004" }))).message).toMatch(/It costs 0\.00505 ETH with its burn/);
    expect((await refusal(f.pickAgent(ID, { by: "price", maxEth: "0.004" }))).message).toMatch(/It costs 0\.00404 ETH with its burn/);
    expect((await refusal(f.pickAgent(ID, { agent: "quill-02" }))).code).toBe("offer_ended");
    const tool = (await runTool(f, "factor_offers", { open: ID, sort: "price" }, null)).text;
    expect(tool.split("\n")[0]).toBe("1. page-smith: 0.004 ETH, in 12 hours, Factor Score 580 (4 jobs settled)");
    expect(tool).toMatch(/3\. quill-02: 0\.003 ETH, in 6 hours, Factor Score 300 \(1 job settled\), ENDED/);
    const one = (await runTool(f, "factor_open_job", { open: ID }, null)).text;
    expect(one).toMatch(/open to offers, a budget of 0\.006 ETH/);
    expect(one).toMatch(/2\. page-smith \(0x[0-9a-f]+\): offers 0\.004 ETH in 12 hours, Factor Score 580/);
    s.site.openJob = null;
  });

  it("offers on its own what its rules make, or what its program prices, and the tools set and say the pricing", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.state = on();
    expect((await refusal(f.setAutoApply({ takes: ["Research"], from: "0.003", offers: { price: "0.002", dueInHours: 24 } }))).code).toBe("bad_amount");
    expect((await refusal(f.setAutoApply({ takes: ["Research"], from: "0.003", offers: { price: "0.005", whenFree: "0.006", dueInHours: 24 } }))).code).toBe("bad_amount");
    const r = await f.setAutoApply({ takes: ["Research"], from: "0.003", offers: { price: "0.005", whenFree: "0.004", dueInHours: 24 } });
    expect(r.bid).toEqual({ normalWei: "5000000000000000", freeWei: "4000000000000000", hours: 24 });
    const rb = s.posts.at(-1)!.body as Parameters<typeof engineRules>[0] & { signature: `0x${string}` };
    expect((await recoverMessageAddress({ message: engineRules(rb), signature: rb.signature })).toLowerCase()).toBe(f.address);
    const RULES = { on: true, takes: ["Research"], words: [], floorWei: "3000000000000000", atOnce: 2, hours: null, early: false, pitch: "", bid: r.bid };
    s.site.autoApply = { enabled: true, agent: f.address, name: "lumen-07", runBy: "self", setters: [], kinds: [], rules: RULES, log: [], fits: [ID], quotes: { [ID]: { priceWei: "4000000000000000", dueHours: 24 } }, limits: { perAgentHour: 6, perHour: 60, atOnceMost: 10 } };
    s.site.openJob = { enabled: true, open: listing({ applicants: [], count: 0 }) };
    const watchOnce = async (o: Parameters<Factor["watchOpenJobs"]>[0] = {}) => {
      const applied: string[] = [];
      const w = f.watchOpenJobs({ ...o, onApplied: (a) => applied.push(a.open), everyMs: 60_000 });
      for (let i = 0; i < 50 && !applied.length; i++) await new Promise((res) => setTimeout(res, 20));
      w.stop();
      await w.done;
      return applied;
    };
    expect(await watchOnce()).toEqual([ID]);
    expect(s.posts.filter((p) => p.path === "/openjobs/apply").at(-1)!.body).toMatchObject({ auto: true, priceWei: "4000000000000000", dueHours: 24 });
    // its own program prices it
    expect(await watchOnce({ price: (job, quote) => ({ price: quote.priceWei + 500_000_000_000_000n, dueInHours: Math.min(12, job.dueHours) }) })).toEqual([ID]);
    expect(s.posts.filter((p) => p.path === "/openjobs/apply").at(-1)!.body).toMatchObject({ auto: true, priceWei: "4500000000000000", dueHours: 12 });
    const said = (await runTool(f, "factor_auto_apply", {}, null)).text;
    expect(said).toMatch(/offers 0\.005 ETH, 0\.004 ETH with nothing on its hands, delivered in 24 hours/);
    expect((await runTool(f, "factor_auto_apply_now", {}, null)).text).toMatch(/offered 0\.004 ETH in 24 hours, ranked 1 of 1/);
    expect((await runTool(f, "factor_bid", { open: ID, price: "0.0045", due_in_hours: 24 }, null)).text).toMatch(/Offered: 0\.0045 ETH, delivered within 24 hours of the lock/);
    expect((await runTool(f, "factor_withdraw_offer", { open: ID }, null)).text).toMatch(/withdrawn/);
    s.site.autoApply = null;
    s.site.openJob = null;
    s.site.state = state();
  });
});

describe("verified owners", () => {
  it("signs the engine's words to the letter, as the owner wallet, and says what was checked", async () => {
    const words = { agent: AGENTS[0]!.address, owner: "0x00000000000000000000000000000000000000b1", at: 1_760_000_000 };
    expect(verifyOwnerMessage(words)).toBe(engineVerify(words));
    const f = await connect({ privateKey: KEY });
    const r = await f.verifyOwner({ agent: AGENTS[0]!.address });
    expect(r).toMatchObject({ verified: true, owner: f.address, checks: [{ name: "Human Passport", outcome: "pass" }, { name: "Talent Protocol", outcome: "fail" }] });
    const sent = s.posts.at(-1)!;
    expect(sent.path).toBe("/verified/check");
    const b = sent.body as { agent: string; owner: string; at: number; signature: `0x${string}` };
    expect(b.agent).toBe(AGENTS[0]!.address);
    expect((await recoverMessageAddress({ message: engineVerify({ agent: b.agent, owner: b.owner, at: b.at }), signature: b.signature })).toLowerCase()).toBe(f.address);
    // by name, and its own agent when none is named
    await f.verifyOwner({ agent: "lumen-07" });
    expect((s.posts.at(-1)!.body as { agent: string }).agent).toBe(AGENTS[0]!.address);
    await f.verifyOwner();
    expect((s.posts.at(-1)!.body as { agent: string }).agent).toBe(f.address);
    expect((await refusal((await connect()).verifyOwner())).code).toBe("read_only");
    expect(f.verifyLink("lumen-07")).toMatch(/\/agents\/lumen-07#verified$/);
  });

  it("posts a job for verified owners only in the engine's words, filters the board, and refuses while it is off", async () => {
    const f = await connect({ privateKey: KEY });
    s.site.state = state({ openJobs: { enabled: true, maxApplicants: 20, open: 0, applicants: 0, hired: 0 } });
    expect((await refusal(f.postJob({ title: "A one-page site", price: "0.004", verifiedOnly: true }))).code).toBe("verified_off");
    s.site.state = state({ openJobs: { enabled: true, maxApplicants: 20, open: 0, applicants: 0, hired: 0 }, verified: { enabled: true, checks: [], needs: "any", validDays: 30, how: "", kept: "", agents: 0 } });
    await f.postJob({ title: "A one-page site", price: "0.004", verifiedOnly: true });
    const b = s.posts.at(-1)!.body as Record<string, unknown> & { signature: `0x${string}` };
    expect(b.verifiedOnly).toBe(true);
    const text = { customer: f.address!, price: String(b.price), dueHours: Number(b.dueHours), early: !!b.early, title: String(b.title), brief: String(b.brief), closesAt: Number(b.closesAt), pick: { by: "customer" as const }, at: Number(b.at), verifiedOnly: true };
    expect(postJobMessage(text)).toBe(enginePost(text));
    expect(postJobMessage(text)).toContain("\nwho: verified owners only\n");
    expect((await recoverMessageAddress({ message: enginePost(text), signature: b.signature })).toLowerCase()).toBe(f.address);
    s.site.openJobs = [{ id: `0x${"ab".repeat(32)}`, title: "A one-page site", verifiedOnly: true, offers: false, priceEth: 0.004, dueHours: 24, early: false, status: "open", note: "Taking applications.", count: 0, applicants: [], applying: true }];
    expect((await runTool(f, "factor_open_jobs", { verified_only: true }, null)).text).toMatch(/"A one-page site" \(verified owners only\)/);
    s.site.state = state();
  });

  it("its tools say whether an owner is verified, and where it verifies when it is not", async () => {
    const f = await connect({ privateKey: KEY });
    expect((await runTool(f, "factor_verified_owner", { agent: "lumen-07" }, null)).text).toBe("Owners are not checked on Factor right now.");
    s.site.verified = { enabled: true, agent: AGENTS[0]!.address, owners: [AGENTS[0]!.address], verifiedOwner: null };
    expect((await runTool(f, "factor_verified_owner", { agent: "lumen-07" }, null)).text).toMatch(/is not verified\. The wallet that runs it .* verifies with one signature: factor_verify_owner .*\/agents\/lumen-07#verified$/);
    s.site.verified = { enabled: true, agent: AGENTS[0]!.address, owners: [AGENTS[0]!.address], verifiedOwner: { verified: true, sources: ["Human Passport"], bands: { "Human Passport": "20 to 29" }, checkedAt: "2026-10-24T09:00:00.000Z", expiresAt: "2026-11-23T09:00:00.000Z", owner: AGENTS[0]!.address } };
    expect((await runTool(f, "factor_verified_owner", { agent: "lumen-07" }, null)).text).toMatch(/owner is verified: Human Passport passed \(Human Passport 20 to 29\)\. .* checked 2026-10-24; it runs out 2026-11-23/);
    expect((await runTool(f, "factor_verify_owner", {}, null)).text).toMatch(/^Verified: Human Passport passed for 0x/);
    s.site.verified = null;
  });
});
