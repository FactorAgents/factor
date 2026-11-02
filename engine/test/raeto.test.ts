// raeto/auto at the compute gateway, end to end on the made-up chain, with the stand-in for Raeto (scripts/stub-raeto.ts,
// shaped from the real API's answers): nothing is ever spent. What a call sends, what it costs, what is never charged,
// what never leaves the engine, and that with the switch off nothing has changed.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyMessage, readCompute, ComputeStore } from "../src/compute.js";
import { askRaeto, headerUsd, isRaetoModel, newSeen, priceCall, RAETO_BLIND_LIMIT, RAETO_MODELS, raetoRefusal, raetoWorstMicro, readRaeto } from "../src/raeto.js";
import { turn } from "../src/switches.js";
import { raetoStub, type RaetoStub } from "../scripts/stub-raeto.js";
import { ETH, FakeChain, K } from "./chain/fake.js";
import { rig, wallet, type Rig } from "./chain/harness.js";

const agentKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d"); // anvil's, worth nothing
const AGENT = agentKey.address.toLowerCase();
const CUSTOMER = wallet(0xc1);
const RAETO_KEY = "sk-raeto-test-the-owners-key-that-must-never-leave";
const CEILING = { maxInPerM: 5, maxOutPerM: 25 };

const servers: Server[] = [];
const stubs: RaetoStub[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stubs.splice(0).map((s) => s.close()));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => { s.closeAllConnections(); s.close(() => done()); })));
});

interface World extends Rig { stub: RaetoStub; url: string; job: number; key: string }

async function world(o: { more?: Record<string, string>; draw?: bigint } = {}): Promise<World> {
  const chain = new FakeChain();
  chain.fund(ETH);
  chain.register(AGENT);
  chain.bond(AGENT, ETH / 50n);
  const job = chain.lock(CUSTOMER, AGENT, ETH / 10n);
  chain.draw(job, o.draw ?? ETH / 50n, K.compute);
  const stub = await raetoStub(RAETO_KEY);
  stubs.push(stub);
  const r = await rig("watch", { chain, more: { COMPUTE_MODE: "on", RAETO: "on", RAETO_API_KEY: RAETO_KEY, RAETO_URL: stub.url, RAETO_FLOAT_CHECK_S: "0", ...o.more } });
  await r.engine.watchOnce();
  const server = createServer((req, res) => { if (!r.engine.compute(req, res, (req.url ?? "/").split("?")[0]!)) { res.writeHead(503); res.end("{}"); } });
  servers.push(server);
  const url = await new Promise<string>((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  const at = chain.time;
  const k = (await (await fetch(`${url}/v1/compute/key`, { method: "POST", body: JSON.stringify({ address: AGENT, at, signature: await agentKey.signMessage({ message: keyMessage(AGENT, at) }) }) })).json()) as { key: string };
  return { ...r, stub, url, job, key: k.key };
}

const ask = (w: World, body: Record<string, unknown> = {}, say = "Say hello") =>
  fetch(`${w.url}/v1/compute/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${w.key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "raeto/auto", max_tokens: 100, messages: [{ role: "user", content: say }], ...body }) });
const balance = async (w: World) => (await (await fetch(`${w.url}/v1/compute/balance`, { headers: { "x-api-key": w.key } })).json()) as { balanceUsd: number; lots: { job: number; spentUsd: number }[]; raeto?: { spentUsd: number; calls: number } };
const usage = (w: World) => w.sqlite.prepare("SELECT * FROM compute_usage ORDER BY id").all() as Record<string, number | string>[];
const spend = (w: World) => w.sqlite.prepare("SELECT * FROM compute_raeto_spend ORDER BY id").all() as Record<string, number | string>[];
const refusal = async (r: Response) => ({ status: r.status, ...((await r.json()) as { error: { type: string; message: string } }).error });
const dollars = (micro: number) => 49.5 - micro / 1e6;
const withMargin = (usd: number) => Math.ceil(usd * 1e6 * 1.05 - 1e-9);

describe("the settings", () => {
  it("is off by default, reads nothing and can find nothing wrong when off", () => {
    const problems: string[] = [];
    expect(readRaeto({ RAETO_MAX_IN_USD: "banana", RAETO_URL: "nonsense", RAETO_API_KEY: RAETO_KEY }, problems)).toMatchObject({ enabled: false, note: null });
    expect(problems).toEqual([]);
    // and a key at Raeto alone does not turn compute on
    expect(readCompute({ COMPUTE_MODE: "on", RAETO_API_KEY: RAETO_KEY }).enabled).toBe(false);
  });

  it("on with no key says why, stops nothing, and serves nothing", () => {
    const problems: string[] = [];
    const c = readCompute({ COMPUTE_MODE: "on", RAETO: "on", OPENROUTER_API_KEY: "or" }, problems);
    expect(problems).toEqual([]);
    expect(c.enabled).toBe(true);
    expect(c.raeto.enabled).toBe(false);
    expect(c.raeto.note).toContain("RAETO_API_KEY");
  });

  it("opens the gateway with Raeto's key alone, and only with COMPUTE_MODE on", () => {
    expect(readCompute({ COMPUTE_MODE: "on", RAETO: "on", RAETO_API_KEY: RAETO_KEY })).toMatchObject({ enabled: true, note: null, raeto: { enabled: true, url: "https://api.raeto.cc/v1", maxInPerM: 5, maxOutPerM: 25, house: false } });
    expect(readCompute({ RAETO: "on", RAETO_API_KEY: RAETO_KEY }).enabled).toBe(false);
  });

  it("says what is wrong with a bad setting when it is on", () => {
    const problems: string[] = [];
    readRaeto({ RAETO: "on", RAETO_API_KEY: RAETO_KEY, RAETO_MAX_OUT_USD: "x", RAETO_URL: "ftp://a", HOUSE_RAETO_MODEL: "openai/gpt-5" }, problems);
    expect(problems).toHaveLength(3);
  });

  it("knows the nine models the real list has, and no other", () => {
    expect(RAETO_MODELS.map((m) => m.id)).toEqual(["raeto/auto", "raeto/auto:cheap", "raeto/auto:fast", "raeto/auto:code", "raeto/auto:reason", "raeto/auto:vision", "raeto/auto:tools", "raeto/auto:json", "raeto/auto:long"]);
    for (const no of ["raeto/auto:free", "openai/gpt-5", 5, null]) expect(isRaetoModel(no)).toBe(false);
  });
});

describe("what a call may cost, and what it did", () => {
  it("holds every byte and token at the ceilings, with Raeto's fees and Factor's margin", () => {
    // (100 + 1000) x 5 + 200 x 25 = 10,500; and 8% = 11,340; and the routing fee = 11,540; and 5% = 12,117
    expect(raetoWorstMicro(100, 200, 0, CEILING, 500)).toBe(12_117);
    // a picture counts for 10,000 tokens of input
    expect(raetoWorstMicro(100, 200, 1, CEILING, 500)).toBe(12_117 + Math.ceil(50_000 * 1.08 * 1.05));
  });

  it("takes Raeto's own figure first: the header, then the last chunk", () => {
    const seen = { ...newSeen(), input: 10, output: 10, providerUsd: 0.0000025 };
    expect(priceCall(seen, 0.000032, 10_000, CEILING, 500)).toMatchObject({ chargeMicro: 34, from: "header", shortMicro: 0 });
    expect(priceCall({ ...seen, costUsd: 0.000026 }, null, 10_000, CEILING, 500)).toMatchObject({ chargeMicro: 28, from: "chunk" });
  });

  it("without it, what the provider charged with Raeto's fees; then the tokens at the ceilings; then the hold", () => {
    // $0.0001 provider: 100 x 1.08 + 200 = 308, and 5%
    expect(priceCall({ ...newSeen(), providerUsd: 0.0001 }, null, 10_000, CEILING, 500)).toMatchObject({ chargeMicro: 324, from: "usage" });
    // 10 x 5 + 10 x 25 = 300; x 1.08 + 200 = 524; and 5%
    expect(priceCall({ ...newSeen(), input: 10, output: 10 }, null, 10_000, CEILING, 500)).toMatchObject({ chargeMicro: 551, from: "tokens" });
    expect(priceCall(newSeen(), null, 10_000, CEILING, 500)).toMatchObject({ chargeMicro: 10_000, from: "hold" });
  });

  it("never charges more than was held, and writes down the difference", () => {
    expect(priceCall(newSeen(), 1, 10_000, CEILING, 500)).toMatchObject({ chargeMicro: 10_000, shortMicro: 1_040_000 });
  });

  it("does not take a header that is not a figure", () => {
    for (const v of [null, "", "free", "-1", "NaN", "Infinity", "1,5"]) expect(headerUsd(v)).toBeNull();
    expect(headerUsd("0.00003200")).toBe(0.000032);
  });

  it("passes on a 400's words and nothing else of a refusal", () => {
    const r = raetoRefusal(400, JSON.stringify({ error: { message: "nope is not a valid model ID", code: 400 }, user_id: "user_abc" }));
    expect(r).toMatchObject({ status: 400, message: "nope is not a valid model ID" });
    expect(JSON.stringify(r)).not.toContain("user_abc");
    expect(raetoRefusal(502, "<html>").status).toBe(502);
  });
});

describe("a call", () => {
  it("goes to Raeto with the owner's key, tagged with the agent and its job, and costs what Raeto took and the margin", async () => {
    const w = await world();
    const r = await ask(w, { temperature: 0.2, user: "who-i-am", metadata: { a: 1 } });
    expect(r.status).toBe(200);
    const sent = w.stub.seen[0]!;
    expect(sent.headers.authorization).toBe(`Bearer ${RAETO_KEY}`);
    expect(sent.headers["x-raeto-agent"]).toBe(AGENT);
    expect(sent.headers["x-raeto-task"]).toBe(`factor-job-${w.job}`);
    // all of the job's credit, in Raeto's dollars: $49.50 less the margin
    expect(sent.headers["x-raeto-task-budget"]).toBe("47.142857");
    // nothing of the agent's key, and nothing about who asked
    expect(JSON.stringify(sent)).not.toContain(w.key);
    expect(sent.body).toEqual({ model: "raeto/auto", max_tokens: 100, messages: [{ role: "user", content: "Say hello" }], temperature: 0.2 });

    const charged = withMargin(w.stub.charged[0]!);
    const d = (await r.json()) as { model: string; choices: { message: { content: string } }[]; usage: Record<string, unknown> };
    expect(d.choices[0]!.message.content).toContain("stand-in");
    // what the agent reads is what it paid
    expect(r.headers.get("x-factor-cost-usd")).toBe((charged / 1e6).toFixed(6));
    expect(d.usage.cost).toBe(charged / 1e6);
    expect(d.usage.cost_details).toBeUndefined();
    expect(r.headers.get("x-raeto-model")).toBe("mistralai/mistral-small-3.2-24b-instruct");
    expect(r.headers.get("x-raeto-tier")).toBe("fast");
    expect(r.headers.get("x-raeto-cost")).toBeNull();

    expect((await balance(w)).balanceUsd).toBeCloseTo(dollars(charged), 6);
    expect(usage(w)).toMatchObject([{ agent: AGENT, model: "raeto/auto", cost_micro: charged, unpaid_micro: 0, status: 200 }]);
    expect(spend(w)).toMatchObject([{ agent: AGENT, job_id: w.job, source: "advance", asked: "raeto/auto", model: "mistralai/mistral-small-3.2-24b-instruct", tier: "fast", cost_micro: charged, cost_from: "header" }]);
    expect(spend(w)[0]!.upstream_micro).toBeCloseTo(w.stub.charged[0]! * 1e6, 3);
  });

  it("takes every variant the list has", async () => {
    const w = await world();
    for (const m of RAETO_MODELS) expect((await ask(w, { model: m.id })).status).toBe(200);
    expect(w.stub.seen.map((s) => s.body.model)).toEqual(RAETO_MODELS.map((m) => m.id));
  });

  it("is passed on as it arrives when it is a stream, and the last chunk says what the agent paid", async () => {
    const w = await world();
    const r = await ask(w, { stream: true });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = await r.text();
    expect(text).toContain('"content":"plain "');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(w.stub.seen[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(text).not.toContain("OPENROUTER");
    expect(text).toContain(": processing");
    const charged = withMargin(w.stub.charged[0]!);
    const last = JSON.parse(text.split("\n").filter((l) => l.includes('"raeto"'))[0]!.slice(5)) as { raeto: Record<string, unknown>; usage: Record<string, unknown> };
    expect(last.raeto).toEqual({ model: "mistralai/mistral-small-3.2-24b-instruct", cost_usd: charged / 1e6 });
    expect(last.usage.cost).toBe(charged / 1e6);
    expect(spend(w)).toMatchObject([{ cost_micro: charged, cost_from: "chunk" }]);
    expect(usage(w)[0]!.output).toBe(40);
  });

  it("holds the worst while it runs, and lets go of all but what it cost", async () => {
    const w = await world();
    let open!: () => void;
    w.stub.gate = new Promise((done) => { open = done; });
    const going = ask(w);
    await vi.waitFor(() => expect(w.stub.seen).toHaveLength(1));
    const during = await balance(w);
    expect(during.balanceUsd).toBeLessThan(49.5 - 0.003);
    open();
    w.stub.gate = null;
    await (await going).text();
    const after = await balance(w);
    expect(after.balanceUsd).toBeCloseTo(dollars(withMargin(w.stub.charged[0]!)), 6);
    expect(after.balanceUsd).toBeGreaterThan(during.balanceUsd);
  });

  it("calls at the same moment cannot spend the same credit twice", async () => {
    // a little credit: 0.0002 ETH less the fee, at $2,500, is 49.5 cents... held at the worst, few can run at once
    const w = await world({ draw: ETH / 200_000n });
    let open!: () => void;
    w.stub.gate = new Promise((done) => { open = done; });
    const all = [ask(w, { max_tokens: 200 }), ask(w, { max_tokens: 200 }), ask(w, { max_tokens: 200 })];
    await vi.waitFor(() => expect(w.stub.seen.length).toBeGreaterThan(0));
    open();
    w.stub.gate = null;
    const statuses = (await Promise.all(all)).map((r) => r.status);
    expect(statuses).toContain(402);
    expect(statuses).toContain(200);
  });

  it("a retry a tier up costs what the answer cost, once, and shows the model that answered", async () => {
    const w = await world();
    const r = await ask(w, {}, "[stub:retry] Say hello");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-raeto-model")).toBe("anthropic/claude-sonnet-5.5");
    expect(r.headers.get("x-raeto-tier")).toBe("top");
    expect(w.stub.seen).toHaveLength(1);
    expect(spend(w)).toMatchObject([{ model: "anthropic/claude-sonnet-5.5", tier: "top", cost_micro: withMargin(w.stub.charged[0]!) }]);
  });
});

describe("what is never charged", () => {
  const free = async (w: World) => {
    expect((await balance(w)).balanceUsd).toBe(49.5);
    expect(spend(w)).toHaveLength(0);
    // and nothing stays held
    expect(usage(w).every((u) => u.cost_micro === 0)).toBe(true);
    expect((await ask(w)).status).toBe(200);
  };

  it("too many requests: said as such, with Raeto's wait", async () => {
    const w = await world();
    const r = await ask(w, {}, "[stub:429] x");
    expect(r.headers.get("retry-after")).toBe("7");
    expect(await refusal(r)).toMatchObject({ status: 429, type: "rate_limit_error" });
    await free(w);
  });

  it("Raeto failing", async () => {
    const w = await world();
    expect(await refusal(await ask(w, {}, "[stub:500] x"))).toMatchObject({ status: 502, type: "api_error" });
    expect(await refusal(await ask(w, {}, "[stub:502] x"))).toMatchObject({ status: 502, type: "api_error" });
    expect(w.lines.join("\n")).toContain("Raeto answered 500");
    await free(w);
  });

  it("Raeto not answering in time", async () => {
    const w = await world({ more: { RAETO_TIMEOUT_S: "1" } });
    expect(await refusal(await ask(w, {}, "[stub:timeout] x"))).toMatchObject({ status: 502, message: expect.stringContaining("Nothing was taken") });
    await free(w);
  });

  it("Raeto not there at all", async () => {
    const w = await world({ more: { RAETO_URL: "http://127.0.0.1:1/v1" } });
    expect(await refusal(await ask(w))).toMatchObject({ status: 502 });
    expect((await balance(w)).balanceUsd).toBe(49.5);
    expect(spend(w)).toHaveLength(0);
  });

  it("the owner's account or key: not the agent's to hear about, and the owner is told", async () => {
    const w = await world();
    expect(await refusal(await ask(w, {}, "[stub:401] x"))).toMatchObject({ status: 503, type: "api_error" });
    expect(await refusal(await ask(w, {}, "[stub:402] x"))).toMatchObject({ status: 503, type: "api_error" });
    expect(w.lines.join("\n")).toContain("insufficient_balance");
    await free(w);
  });

  it("the same request over and over, stopped at Raeto", async () => {
    const w = await world();
    expect(await refusal(await ask(w, {}, "[stub:409] x"))).toMatchObject({ status: 409 });
    await free(w);
  });

  it("a 400: Raeto's words go back, and the account's id does not", async () => {
    const w = await world();
    const r = await ask(w, {}, "[stub:400] x");
    const text = await r.text();
    expect(r.status).toBe(400);
    expect(text).toContain("not a valid model ID");
    expect(text).not.toContain("user_stub");
    await free(w);
  });

  it("an answer with no reply in it", async () => {
    const w = await world();
    expect(await refusal(await ask(w, {}, "[stub:empty] x"))).toMatchObject({ status: 502 });
    await free(w);
  });

  it("a stream that broke off before saying what it cost", async () => {
    const w = await world();
    await (await ask(w, { stream: true }, "[stub:break] x")).text().catch(() => "");
    await vi.waitFor(() => expect(usage(w)).toHaveLength(1));
    expect(usage(w)[0]).toMatchObject({ cost_micro: 0, status: 502 });
    await free(w);
  });

  it("a stream that ended in an error", async () => {
    const w = await world();
    await (await ask(w, { stream: true }, "[stub:errorchunk] x")).text();
    await vi.waitFor(() => expect(usage(w)).toHaveLength(1));
    await free(w);
  });

  it("a job's budget Raeto stopped: the agent's to hear about, and the owner's balance is not in doubt", async () => {
    const w = await world();
    expect(await refusal(await ask(w, {}, "[stub:budget] x"))).toMatchObject({ status: 402, type: "billing_error", message: expect.stringContaining("budget") });
    expect(w.lines.join("\n")).not.toContain("top up");
    await free(w);
  });

  it("too little credit to hold the call: the gateway says so itself, and Raeto never hears of it", async () => {
    const w = await world();
    w.sqlite.prepare("UPDATE compute_lots SET usd_micro = 1").run();
    expect(await refusal(await ask(w))).toMatchObject({ status: 402, type: "billing_error" });
    expect(w.stub.seen).toHaveLength(0);
  });
});

describe("when Raeto does not say what it cost", () => {
  it("prices from what the provider charged, with Raeto's fees", async () => {
    const w = await world();
    const r = await ask(w, {}, "[stub:nocost] x");
    const provider = ((await r.json()) as { usage: { cost: number } }).usage.cost;
    expect(provider).toBeGreaterThan(0);
    expect(spend(w)[0]).toMatchObject({ cost_from: "usage" });
    expect(w.lines.join("\n")).toContain("did not say what it cost");
  });

  it("charges the hold when it says nothing at all, and never more", async () => {
    const w = await world();
    await (await ask(w, {}, "[stub:nousage] x")).text();
    expect(spend(w)[0]).toMatchObject({ cost_from: "hold" });
    expect(usage(w)[0]!.cost_micro).toBeGreaterThan(1000);
  });

  it("a stream with no cost in its last chunk", async () => {
    const w = await world();
    await (await ask(w, { stream: true }, "[stub:nocost] x")).text();
    expect(spend(w)[0]).toMatchObject({ cost_from: "usage" });
  });

  it("after five in a row sends nothing for ten minutes, then tries again", async () => {
    const w = await world();
    for (let i = 0; i < RAETO_BLIND_LIMIT; i++) await (await ask(w, {}, `[stub:nocost] ${i}`)).text();
    expect(w.lines.join("\n")).toContain("no call goes there");
    const sent = w.stub.seen.length;
    expect(await refusal(await ask(w))).toMatchObject({ status: 503 });
    expect(w.stub.seen).toHaveLength(sent);
    const later = Date.now() + 601_000;
    vi.spyOn(Date, "now").mockImplementation(() => later);
    expect((await ask(w)).status).toBe(200);
    // a figure again: all is well
    expect((await ask(w, {}, "two")).status).toBe(200);
  });

  it("the balance held against a charge over the ceiling stays held to the ceiling", async () => {
    const w = await world();
    const r = await ask(w, {}, "[stub:dear] x");
    expect(r.status).toBe(200);
    const row = usage(w)[0]!;
    expect(row.cost_micro).toBeLessThan(100_000);
    expect(row.unpaid_micro).toBeGreaterThan(50_000_000);
    expect(w.lines.join("\n")).toContain("more than the hold");
  });
});

describe("the caps hold for it", () => {
  it("refuses before Raeto hears of it", async () => {
    const w = await world();
    for (const [body, words] of [
      [{ max_tokens: undefined }, "max_tokens"],
      [{ max_tokens: 200_000 }, "at most here"],
      [{ tools: [{ type: "web_search" }] }, "function"],
      [{ messages: [] }, "messages"],
      [{ models: ["a"] }, "passes on"],
      [{ messages: [{ role: "user", content: [{ type: "file", file: {} }] }] }, "text and pictures"],
    ] as [Record<string, unknown>, string][]) {
      const f = await refusal(await ask(w, body));
      expect(f.status).toBe(400);
      expect(f.message).toContain(words);
    }
    expect(w.stub.seen).toHaveLength(0);
  });

  it("the most one call may cost", async () => {
    const w = await world({ more: { COMPUTE_CALL_USD: "1" } });
    // 16,000 tokens at $25 and the rest is under a dollar; more than the call's cap needs a bigger ceiling
    const dear = await world({ more: { COMPUTE_CALL_USD: "1", RAETO_MAX_OUT_USD: "100" } });
    expect((await refusal(await ask(dear, { max_tokens: 16_000 }))).message).toContain("one call may cost");
    expect((await ask(w, { max_tokens: 16_000 })).status).toBe(200);
  });

  it("what one agent may spend in a day, with the calls under way at their worst", async () => {
    const w = await world({ more: { COMPUTE_AGENT_DAILY_USD: "1" } });
    w.sqlite.prepare("INSERT INTO compute_usage (at, agent, model, input, output, cache_write, cache_read, cost_micro, status) VALUES (?, ?, 'x', 0, 0, 0, 0, 999999, 200)").run(w.db.now(), AGENT);
    expect((await refusal(await ask(w))).status).toBe(429);
    expect(w.stub.seen).toHaveLength(0);
  });

  it("what the gateway spends in a day counts its calls", async () => {
    const w = await world({ more: { COMPUTE_DAILY_USD: "1" } });
    await (await ask(w)).text();
    expect(new ComputeStore(w.db).spentToday()).toBeGreaterThan(0);
    w.sqlite.prepare("UPDATE compute_usage SET cost_micro = 999999").run();
    expect((await refusal(await ask(w))).status).toBe(429);
  });

  it("no call goes out while Factor's balance at Raeto is under the floor", async () => {
    const w = await world();
    w.stub.available = 0.5;
    expect(await refusal(await ask(w))).toMatchObject({ status: 503 });
    expect(w.stub.seen).toHaveLength(0);
    expect(w.lines.join("\n")).toContain("under the floor");
    expect((await balance(w)).balanceUsd).toBe(49.5);
    w.stub.available = 4;
    expect((await ask(w)).status).toBe(200);
  });

  it("the balance not being readable stops nothing", async () => {
    const w = await world();
    w.stub.available = Number.NaN; // goes out as null
    expect((await ask(w)).status).toBe(200);
    expect(w.stub.meCalls).toBeGreaterThan(0);
  });

  it("a refused look at the balance: the owner is told, and the call still goes", async () => {
    const w = await world();
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((u, init) => (String(u).endsWith("/me") ? Promise.resolve(new Response("{}", { status: 500 })) : real(u, init)));
    expect((await ask(w)).status).toBe(200);
    expect(w.lines.join("\n")).toContain("could not be read");
  });
});

describe("what a job's credit went on", () => {
  it("is shown by job and by agent, across two jobs when a call spans their credit, and not while the switch is off", async () => {
    const chain = new FakeChain();
    chain.fund(ETH);
    chain.register(AGENT);
    chain.bond(AGENT, ETH / 50n);
    // two small draws: 0.000001 ETH less the fee is about a quarter of a cent each at $2,500
    const one = chain.lock(CUSTOMER, AGENT, ETH / 10n);
    chain.draw(one, ETH / 1_000_000n, K.compute);
    const two = chain.lock(CUSTOMER, AGENT, ETH / 10n);
    chain.draw(two, ETH / 100n, K.compute);
    const r = await rigFrom(chain);
    const first = await askRig(r);
    expect(first.status).toBe(200);
    // the first lot paid, and a call that could run on past it carries no budget
    expect(r.stub.seen[0]!.headers["x-raeto-task"]).toBe(`factor-job-${one}`);
    expect(r.stub.seen[0]!.headers["x-raeto-task-budget"]).toBeUndefined();
    await (await askRig(r, "[stub:retry] again")).text();

    const slices = r.rig.sqlite.prepare("SELECT job_id, cost_micro, model FROM compute_raeto_spend ORDER BY id").all() as { job_id: number; cost_micro: number; model: string }[];
    expect(new Set(slices.map((s) => s.job_id)).has(one)).toBe(true);
    const jobPage = (await r.rig.engine.handle(`/v1/jobs/${one}`))!.body as { raetoSpend?: { calls: number; spentUsd: number; models: { model: string; tier: string }[] } };
    expect(jobPage.raetoSpend?.calls).toBeGreaterThan(0);
    expect(jobPage.raetoSpend?.models[0]?.model).toBeTruthy();
    const agentPage = (await r.rig.engine.handle(`/v1/agents/${AGENT}`))!.body as { raetoSpend?: { calls: number } };
    expect(agentPage.raetoSpend?.calls).toBe(2);

    turn(r.rig.db, "raeto", false, "a test");
    expect(((await r.rig.engine.handle(`/v1/jobs/${one}`))!.body as Record<string, unknown>).raetoSpend).toBeUndefined();
    expect(((await r.rig.engine.handle(`/v1/agents/${AGENT}`))!.body as Record<string, unknown>).raetoSpend).toBeUndefined();
  });

  it("a coin's credit is tagged as the coin's, and a job's own page does not count it", async () => {
    const w = await world();
    const store = new ComputeStore(w.db);
    w.sqlite.prepare("DELETE FROM compute_lots").run();
    store.addCoinLot({ tx_hash: "0xc01", log_index: 0, block: 1, at: 1 }, AGENT, ETH / 100n, "250000000000");
    await (await ask(w)).text();
    expect(w.stub.seen[0]!.headers["x-raeto-task"]).toBe(`factor-coin-${AGENT}`);
    expect(((await w.engine.handle(`/v1/jobs/${w.job}`))!.body as Record<string, unknown>).raetoSpend).toBeUndefined();
    expect((await balance(w)).raeto?.calls).toBe(1);
  });
});

async function rigFrom(chain: FakeChain) {
  const stub = await raetoStub(RAETO_KEY);
  stubs.push(stub);
  const r = await rig("watch", { chain, more: { COMPUTE_MODE: "on", RAETO: "on", RAETO_API_KEY: RAETO_KEY, RAETO_URL: stub.url } });
  await r.engine.watchOnce();
  const server = createServer((req, res) => { if (!r.engine.compute(req, res, (req.url ?? "/").split("?")[0]!)) { res.writeHead(503); res.end("{}"); } });
  servers.push(server);
  const url = await new Promise<string>((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  const at = chain.time;
  const k = (await (await fetch(`${url}/v1/compute/key`, { method: "POST", body: JSON.stringify({ address: AGENT, at, signature: await agentKey.signMessage({ message: keyMessage(AGENT, at) }) }) })).json()) as { key: string };
  return { rig: r, stub, url, key: k.key };
}
const askRig = (r: Awaited<ReturnType<typeof rigFrom>>, say = "Say hello") =>
  fetch(`${r.url}/v1/compute/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${r.key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "raeto/auto", max_tokens: 100, messages: [{ role: "user", content: say }] }) });

describe("the owner's key", () => {
  it("is in no answer, no log line, no row and no state", async () => {
    const w = await world();
    const seen: string[] = [];
    for (const say of ["Say hello", "[stub:401] x", "[stub:402] x", "[stub:400] x", "[stub:429] x", "[stub:500] x", "[stub:nocost] x"]) seen.push(await (await ask(w, {}, say)).text());
    seen.push(await (await ask(w, { stream: true })).text());
    for (const path of ["/v1/state", "/v1/health", `/v1/agents/${AGENT}`, `/v1/jobs/${w.job}`]) seen.push(JSON.stringify((await w.engine.handle(path))!.body));
    for (const path of ["/v1/compute/models", "/v1/compute/v1/models", `/v1/compute/credit/${AGENT}`]) seen.push(await (await fetch(`${w.url}${path}`)).text());
    const rows = (w.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => JSON.stringify(w.sqlite.prepare(`SELECT * FROM "${t.name}"`).all()));
    expect(JSON.stringify([seen, w.lines, rows])).not.toContain(RAETO_KEY);
    expect(JSON.stringify([seen, rows])).not.toContain("user_stub");
  });

  it("is not forwarded where an answer tries to send the call", async () => {
    const elsewhere: string[] = [];
    const trap = createServer((req, res) => { elsewhere.push(String(req.headers.authorization)); res.end("{}"); });
    servers.push(trap);
    const trapUrl = await new Promise<string>((done) => trap.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(trap.address() as AddressInfo).port}`)));
    const redirector = createServer((_req, res) => { res.writeHead(307, { location: `${trapUrl}/v1/chat/completions` }); res.end(); });
    servers.push(redirector);
    const redirectUrl = await new Promise<string>((done) => redirector.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(redirector.address() as AddressInfo).port}/v1`)));
    const w = await world({ more: { RAETO_URL: redirectUrl, RAETO_FLOAT_FLOOR_USD: "0" } });
    expect((await ask(w)).status).toBe(502);
    expect(elsewhere).toEqual([]);
    expect((await balance(w)).balanceUsd).toBe(49.5);
  });
});

describe("switched off", () => {
  it("RAETO not on: nothing about it anywhere, and raeto/auto is a model like any unknown one", async () => {
    const w = await world({ more: { RAETO: "off", ANTHROPIC_API_KEY: "sk-ant-x", COMPUTE_DIRECT: "on" } });
    expect(await refusal(await ask(w))).toMatchObject({ status: 503, message: expect.stringContaining("not open here") });
    expect(w.stub.seen).toHaveLength(0);
    expect(w.stub.meCalls).toBe(0);
    const s = (await w.engine.handle("/v1/state"))!.body as { compute: Record<string, unknown> };
    expect(s.compute.raeto).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain("raeto");
    expect(await (await fetch(`${w.url}/v1/compute/v1/models`)).text()).not.toContain("raeto");
    expect(await (await fetch(`${w.url}/v1/compute/credit/${AGENT}`)).text()).not.toContain("raeto");
    const h = (await w.engine.handle("/v1/health"))!.body as { compute: Record<string, unknown> };
    expect(h.compute.raetoFloatUsd).toBeUndefined();
  });

  it("the owner's switch: stops it at once without a restart, and it comes back as it was", async () => {
    const w = await world();
    const about = async () => ((await w.engine.handle("/v1/state"))!.body as { compute: { raeto?: { models: string[]; holdInUsd: number; holdOutUsd: number; feePct: number } } }).compute.raeto;
    expect((await about())?.models).toHaveLength(9);
    expect(await about()).toMatchObject({ holdInUsd: 5.67, holdOutUsd: 28.35, feePct: 8 });
    const list = async () => ((await (await fetch(`${w.url}/v1/compute/v1/models`)).json()) as { data: { id: string }[] }).data.map((m) => m.id);
    expect(await list()).toContain("raeto/auto");
    await (await ask(w)).text();
    turn(w.db, "raeto", false, "a test");
    expect(await refusal(await ask(w))).toMatchObject({ status: 503, message: expect.stringContaining("paused") });
    expect(await about()).toBeUndefined();
    expect(await list()).toEqual([]);
    expect((await balance(w)).raeto).toBeUndefined();
    turn(w.db, "raeto", true);
    expect((await ask(w)).status).toBe(200);
    expect(await about()).toBeDefined();
  });

  it("compute's own switch stops it too", async () => {
    const w = await world();
    turn(w.db, "compute", false, "a test");
    expect(await refusal(await ask(w))).toMatchObject({ status: 503, message: expect.stringContaining("paused") });
    expect(w.stub.seen).toHaveLength(0);
  });

  it("the other models are as they were beside it: an unknown name is still refused", async () => {
    const w = await world();
    expect(await refusal(await ask(w, { model: "openai/gpt-5" }))).toMatchObject({ status: 400, message: expect.stringContaining("not a model") });
    expect(await refusal(await ask(w, { model: "raeto/auto:free" }))).toMatchObject({ status: 400 });
  });
});

describe("Factor's own agents", () => {
  it("ask with the system prompt, the agent's tag and Raeto's own figure for the day's ceiling", async () => {
    const stub = await raetoStub(RAETO_KEY);
    stubs.push(stub);
    const a = await askRaeto({ url: stub.url, key: RAETO_KEY, model: "raeto/auto", timeoutMs: 5000 }, { system: "You are a reader.", user: "Read this.", maxTokens: 50 }, "0xabc");
    expect(a.text).toContain("stand-in");
    expect(a.costMicro).toBe(Math.ceil(stub.charged[0]! * 1e6));
    expect(a.model).toBe("mistralai/mistral-small-3.2-24b-instruct");
    expect(stub.seen[0]!.headers["x-raeto-agent"]).toBe("0xabc");
    expect(stub.seen[0]!.body.messages).toEqual([{ role: "system", content: "You are a reader." }, { role: "user", content: "Read this." }]);
  });

  it("say it failed when Raeto fails, for the usual model to take over", async () => {
    const stub = await raetoStub(RAETO_KEY);
    stubs.push(stub);
    const r = { url: stub.url, key: RAETO_KEY, model: "raeto/auto", timeoutMs: 5000 };
    await expect(askRaeto(r, { system: "s", user: "[stub:500] x", maxTokens: 5 }, undefined)).rejects.toThrow("Raeto answered 500");
    await expect(askRaeto(r, { system: "s", user: "[stub:empty] x", maxTokens: 5 }, undefined)).rejects.toThrow("no answer");
  });
});
