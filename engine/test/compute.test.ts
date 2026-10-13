// Compute credit, end to end on the made-up chain, with a stand-in for the model maker: no model is ever called.
// What an advance drawn "as compute" becomes, how an agent gets a key, what a call costs, what the gateway refuses,
// and what happens to credit when its job ends.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { actState } from "../src/chain/act.js";
import { ComputeStore, costMicro, DEFAULT_MODELS, keyMessage, readCompute, usdMicro } from "../src/compute.js";
import { A, ETH, FakeChain, K } from "./chain/fake.js";
import { rig, wallet, type Rig } from "./chain/harness.js";

// anvil's built-in test keys: public and worth nothing anywhere
const agentKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const otherKey = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const AGENT = agentKey.address.toLowerCase();
const OTHER = otherKey.address.toLowerCase();
const CUSTOMER = wallet(0xc1);
const MODEL_KEY = "sk-ant-test-0000-the-owners-key-with-the-model-maker";
const SONNET = "claude-sonnet-5-5";
const ON = { COMPUTE_MODE: "on", ANTHROPIC_API_KEY: MODEL_KEY };

// ---- the stand-in for the model maker ----

interface Seen { headers: IncomingMessage["headers"]; body: Record<string, unknown> }
interface Upstream { url: string; seen: Seen[]; next: { status?: number; usage?: Record<string, unknown>; stream?: boolean; hold?: Promise<void>; drop?: boolean }; close(): Promise<void> }

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => { s.closeAllConnections(); s.close(() => done()); })));
});

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function upstream(): Promise<Upstream> {
  const up: Upstream = { url: "", seen: [], next: {}, close: async () => {} };
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", async () => {
      up.seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown> });
      const n = up.next;
      if (n.hold) await n.hold;
      if (n.drop) return void req.socket.destroy();
      const usage = n.usage ?? { input_tokens: 1000, output_tokens: 200 };
      if (n.status && n.status !== 200) {
        res.writeHead(n.status, { "content-type": "application/json", "request-id": "req_refused" });
        return void res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "the model maker said no" } }));
      }
      if (n.stream) {
        // the way the model maker streams: the input count first, the output count as it grows
        res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_stream" });
        const out = Number(usage.output_tokens ?? 0);
        const events: [string, unknown][] = [
          ["message_start", { type: "message_start", message: { id: "msg_1", usage: { ...usage, output_tokens: 1 } } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: out } }],
          ["message_stop", { type: "message_stop" }],
        ];
        for (const [name, data] of events) {
          const text = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
          // cut in the middle, as a network does
          res.write(text.slice(0, 17));
          await new Promise((r) => setTimeout(r, 2));
          res.write(text.slice(17));
        }
        return void res.end();
      }
      res.writeHead(200, { "content-type": "application/json", "request-id": "req_ok" });
      res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: up.seen.at(-1)!.body.model, content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn", usage }));
    });
  });
  up.url = await listen(server);
  return up;
}

// ---- the engine with its compute door open, as main.ts opens it ----

interface World extends Rig { up: Upstream; url: string; job: number }

async function serve(r: Rig): Promise<string> {
  return listen(createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (!r.engine.compute(req, res, path)) { res.writeHead(503); res.end("{}"); }
  }));
}

/** An agent hired for 0.1 ETH that drew 0.02 of it as compute: 0.0198 ETH after the fee, $49.50 at $2,500. */
async function world(o: { mode?: "watch" | "dry" | "live"; more?: Record<string, string>; chain?: FakeChain; draw?: bigint } = {}): Promise<World> {
  const chain = o.chain ?? new FakeChain();
  chain.fund(ETH);
  chain.register(AGENT);
  chain.bond(AGENT, ETH / 50n);
  const job = chain.lock(CUSTOMER, AGENT, ETH / 10n);
  chain.draw(job, o.draw ?? ETH / 50n, K.compute);
  const up = await upstream();
  const r = await rig(o.mode ?? "watch", { chain, more: { ...ON, COMPUTE_UPSTREAM_URL: up.url, ...o.more } });
  await r.engine.watchOnce();
  return { ...r, up, url: await serve(r), job };
}

async function keyFor(w: World, account = agentKey, at = w.chain.time): Promise<Response> {
  const address = account.address.toLowerCase();
  return fetch(`${w.url}/v1/compute/key`, { method: "POST", body: JSON.stringify({ address, at, signature: await account.signMessage({ message: keyMessage(address, at) }) }) });
}
const newKey = async (w: World) => ((await (await keyFor(w)).json()) as { key: string }).key;

const call = (w: World, key: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  fetch(`${w.url}/v1/compute/v1/messages`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json", ...headers }, body: JSON.stringify({ model: SONNET, max_tokens: 500, messages: [{ role: "user", content: "Say hello" }], ...body }) });
const balance = async (w: World, key: string) => (await (await fetch(`${w.url}/v1/compute/balance`, { headers: { "x-api-key": key } })).json()) as { balanceUsd: number; enabled: boolean; lots: { job: number; usd: number | null; spentUsd: number; state: string }[] };
const refusal = async (r: Response) => ({ status: r.status, ...((await r.json()) as { error: { type: string; message: string } }).error });
const store = (w: Rig) => new ComputeStore(w.db);
const usageRows = (w: Rig) => w.sqlite.prepare("SELECT * FROM compute_usage ORDER BY id").all() as Record<string, number | string>[];

describe("the settings", () => {
  it("is off until it is switched on and there is a key, and says why when only one of the two is there", () => {
    expect(readCompute({})).toMatchObject({ enabled: false, note: null, markupBps: 500, maxTokens: 16_000, upstream: "https://api.anthropic.com", inFlight: 4, inFlightAll: 32, dailyMicro: 100_000_000 });
    expect(readCompute({ ANTHROPIC_API_KEY: MODEL_KEY })).toMatchObject({ enabled: false, note: null });
    const half = readCompute({ COMPUTE_MODE: "on" });
    expect(half.enabled).toBe(false);
    expect(half.note).toContain("ANTHROPIC_API_KEY is not set");
    expect(readCompute(ON)).toMatchObject({ enabled: true, note: null, models: DEFAULT_MODELS });
  });

  it("takes the owner's own price table and margin, and names what it cannot read", () => {
    const c = readCompute({ ...ON, COMPUTE_MODELS: '{"claude-sonnet-5-5":{"in":2,"out":10}}', COMPUTE_MARKUP_BPS: "0", COMPUTE_MAX_TOKENS: "4000" });
    expect(c.models).toEqual({ "claude-sonnet-5-5": { in: 2, out: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 } });
    expect(c).toMatchObject({ markupBps: 0, maxTokens: 4000 });
    const problems: string[] = [];
    readCompute({ ...ON, COMPUTE_MODELS: "{not json", COMPUTE_MARKUP_BPS: "9000", COMPUTE_UPSTREAM_URL: "ftp://x" }, problems);
    expect(problems).toHaveLength(3);
    expect(problems.join(" ")).not.toContain(MODEL_KEY);
    const free: string[] = [];
    readCompute({ ...ON, COMPUTE_MODELS: '{"claude-sonnet-5-5":{"in":0,"out":10}}' }, free);
    expect(free).toHaveLength(1);
  });

  it("turns ETH into dollars rounded down, and tokens into a cost rounded up", () => {
    // 0.0198 ETH at $2,500.00 is $49.50
    expect(usdMicro((ETH * 198n) / 10_000n, 2_500n * 10n ** 8n)).toBe(49_500_000);
    expect(usdMicro(1n, 2_500n * 10n ** 8n)).toBe(0);
    const p = DEFAULT_MODELS[SONNET]!;
    // 1,000 in at $2 and 200 out at $10 a million: $0.004, and 5% on top
    expect(costMicro({ input: 1000, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, p, 500)).toBe(4200);
    expect(costMicro({ input: 1, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, p, 500)).toBe(3);
    expect(costMicro({ input: 0, output: 0, cacheWrite5m: 1000, cacheWrite1h: 1000, cacheRead: 10_000 }, p, 0)).toBe(2500 + 4000 + 1000);
    expect(costMicro({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, p, 500)).toBe(0);
  });
});

describe("credit", () => {
  it("a compute advance is credit for the agent, in dollars at the ETH price of the moment", async () => {
    const w = await world();
    expect(store(w).lots(AGENT)).toMatchObject([{ job_id: w.job, agent: AGENT, wei: ((ETH / 50n) * 99n / 100n).toString(), usd_micro: 49_500_000, spent_micro: 0, state: "open" }]);
    expect(store(w).balance(AGENT)).toBe(49_500_000);
    // an advance paid to the agent itself is no credit
    const other = w.chain.lock(CUSTOMER, AGENT, ETH / 10n, 86400, true);
    w.chain.draw(other, ETH / 100n, K.early);
    await w.engine.watchOnce();
    expect(store(w).lots(AGENT)).toHaveLength(1);
    // and the same logs read twice are the same credit
    w.db.forgetChain();
    await w.engine.watchOnce();
    expect(store(w).balance(AGENT)).toBe(49_500_000);
  });

  it("is told to anybody as a price list, and to the owner as totals", async () => {
    const w = await world();
    const s = (await w.engine.handle("/v1/state"))!.body as { compute: { enabled: boolean; markupPct: number; maxTokens: number; models: { id: string; inUsd: number; outUsd: number }[] } };
    expect(s.compute).toMatchObject({ enabled: true, markupPct: 5, maxTokens: 16_000 });
    expect(s.compute.models.find((m) => m.id === SONNET)).toEqual({ id: SONNET, inUsd: 2.1, outUsd: 10.5 });
    expect(await (await fetch(`${w.url}/v1/compute/models`)).json()).toEqual(s.compute);
    const h = (await w.engine.handle("/v1/health"))!.body as { compute: Record<string, unknown> };
    expect(h.compute).toMatchObject({ enabled: true, lots: 1, grantedMicro: 49_500_000, spentMicro: 0, outstandingMicro: 49_500_000, calls: 0, owedToPoolWei: "0", note: null });
  });

  it("drawn while no ETH price was known is priced as soon as one is", async () => {
    const chain = new FakeChain();
    chain.feedsDown = true;
    const w = await world({ chain });
    expect(store(w).lots(AGENT)[0]).toMatchObject({ usd_micro: null });
    const key = await newKey(w);
    expect((await balance(w, key)).balanceUsd).toBe(0);
    expect((await refusal(await call(w, key))).status).toBe(402);
    chain.feedsDown = false;
    chain.mine();
    await w.engine.watchOnce();
    expect((await balance(w, key)).balanceUsd).toBe(49.5);
  });
});

describe("the key", () => {
  it("is given for the agent's own signature, and only its hash is kept", async () => {
    const w = await world();
    const r = await keyFor(w);
    expect(r.status).toBe(200);
    const k = (await r.json()) as { key: string; agent: string; expiresAt: string };
    expect(k.key).toMatch(/^fck_[A-Za-z0-9_-]{32}$/);
    expect(k.agent).toBe(AGENT);
    expect(Date.parse(k.expiresAt)).toBe((w.chain.time + 7 * 86400) * 1000);
    const rows = w.sqlite.prepare("SELECT * FROM compute_keys").all() as { hash: string; agent: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(k.key);
    expect(rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await balance(w, k.key)).toMatchObject({ balanceUsd: 49.5, enabled: true, lots: [{ job: w.job, usd: 49.5, spentUsd: 0, state: "open" }] });
    // what an agent has left is public, as the advance that paid for it is
    expect(await (await fetch(`${w.url}/v1/compute/credit/${agentKey.address}`)).json()).toEqual(await balance(w, k.key));
    expect(await (await fetch(`${w.url}/v1/compute/credit/${OTHER}`)).json()).toMatchObject({ balanceUsd: 0, lots: [] });
    // the same key the model maker's own library would send as a bearer
    expect((await fetch(`${w.url}/v1/compute/balance`, { headers: { authorization: `Bearer ${k.key}` } })).status).toBe(200);
  });

  it("is refused for another wallet's signature, an old one, and a wallet that is no agent", async () => {
    const w = await world();
    const at = w.chain.time;
    const forged = await fetch(`${w.url}/v1/compute/key`, { method: "POST", body: JSON.stringify({ address: AGENT, at, signature: await otherKey.signMessage({ message: keyMessage(AGENT, at) }) }) });
    expect(await refusal(forged)).toMatchObject({ status: 401, type: "authentication_error" });
    expect(await refusal(await keyFor(w, agentKey, at - 601))).toMatchObject({ status: 400 });
    expect(await refusal(await keyFor(w, agentKey, at + 601))).toMatchObject({ status: 400 });
    expect(await refusal(await keyFor(w, otherKey))).toMatchObject({ status: 404, type: "not_found_error" });
    expect(await refusal(await fetch(`${w.url}/v1/compute/key`, { method: "POST", body: JSON.stringify({ address: "nobody", at, signature: "0x" }) }))).toMatchObject({ status: 400 });
    expect(await refusal(await fetch(`${w.url}/v1/compute/key`, { method: "POST", body: "{not json" }))).toMatchObject({ status: 400 });
    expect(w.sqlite.prepare("SELECT COUNT(*) AS n FROM compute_keys").get()).toEqual({ n: 0 });
  });

  it("stops working when it runs out, and an agent keeps only its newest five", async () => {
    const w = await world();
    const keys: string[] = [];
    for (let i = 0; i < 6; i++) {
      keys.push(await newKey(w));
      w.chain.mine(1, 10);
    }
    const works = async (k: string) => (await fetch(`${w.url}/v1/compute/balance`, { headers: { "x-api-key": k } })).status;
    expect(await works(keys[0]!)).toBe(401);
    expect(await works(keys[1]!)).toBe(200);
    expect(await works(keys[5]!)).toBe(200);
    w.chain.mine(1, 7 * 86400 + 60);
    expect(await works(keys[5]!)).toBe(401);
    for (const bad of ["", "fck_short", "sk-ant-something-else", `fck_${"a".repeat(32)}`]) expect(await works(bad)).toBe(401);
    expect(await refusal(await call(w, `fck_${"a".repeat(32)}`))).toMatchObject({ status: 401, type: "authentication_error" });
    expect(w.up.seen).toHaveLength(0);
  });
});

describe("a call", () => {
  it("goes to the model maker with the owner's key, comes back as it was answered, and costs what was used", async () => {
    const w = await world();
    const key = await newKey(w);
    const r = await call(w, key, { system: "Be brief.", temperature: 0.2, metadata: { user_id: "who-i-am" } }, { "anthropic-version": "2023-06-01", "anthropic-beta": "something-new", "x-forwarded-for": "9.9.9.9" });
    expect(r.status).toBe(200);
    expect(r.headers.get("request-id")).toBe("req_ok");
    expect(await r.json()).toMatchObject({ type: "message", content: [{ type: "text", text: "Hello" }], usage: { input_tokens: 1000, output_tokens: 200 } });
    // what the model maker was sent: the owner's key, never the agent's, and nothing about who asked
    const sent = w.up.seen[0]!;
    expect(sent.headers["x-api-key"]).toBe(MODEL_KEY);
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent.headers["anthropic-beta"]).toBeUndefined();
    expect(sent.headers["x-forwarded-for"]).toBeUndefined();
    expect(sent.headers.authorization).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain(key);
    expect(sent.body).toEqual({ model: SONNET, max_tokens: 500, messages: [{ role: "user", content: "Say hello" }], system: "Be brief.", temperature: 0.2 });
    // 1,000 in and 200 out on Sonnet, with the margin: $0.0042
    expect((await balance(w, key)).balanceUsd).toBe(49.5 - 0.0042);
    expect(usageRows(w)).toMatchObject([{ agent: AGENT, model: SONNET, input: 1000, output: 200, cache_write: 0, cache_read: 0, cost_micro: 4200, unpaid_micro: 0, status: 200, request_id: "req_ok" }]);
    // what was asked and what was answered is nowhere in the books
    const everything = JSON.stringify([usageRows(w), w.sqlite.prepare("SELECT * FROM compute_lots").all(), w.lines]);
    expect(everything).not.toContain("Say hello");
    expect(everything).not.toContain("Be brief");
  });

  it("counts the cache at its own prices", async () => {
    const w = await world();
    const key = await newKey(w);
    w.up.next = { usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 3000, cache_read_input_tokens: 20_000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } } };
    await (await call(w, key, { system: [{ type: "text", text: "A long instruction.", cache_control: { type: "ephemeral" } }] })).text();
    // 100 x 2 + 50 x 10 + 1000 x 2.5 + 2000 x 4 + 20000 x 0.1 = 13,200 and 5%
    expect(usageRows(w)[0]).toMatchObject({ input: 100, output: 50, cache_write: 3000, cache_read: 20_000, cost_micro: 13_860 });
  });

  it("is passed on as it arrives when it is a stream, and the count is read on the way through", async () => {
    const w = await world();
    const key = await newKey(w);
    w.up.next = { stream: true, usage: { input_tokens: 800, output_tokens: 300 } };
    const r = await call(w, key, { stream: true });
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = await r.text();
    expect(text).toContain("event: message_start");
    expect(text.match(/text_delta/g)).toHaveLength(2);
    expect(text.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
    // 800 x 2 + 300 x 10 = 4,600 and 5%
    expect(usageRows(w)[0]).toMatchObject({ input: 800, output: 300, cost_micro: 4830, status: 200 });
    expect(store(w).balance(AGENT)).toBe(49_500_000 - 4830);
  });

  it("the model maker refused costs nothing, and its own words are passed back", async () => {
    const w = await world();
    const key = await newKey(w);
    w.up.next = { status: 400 };
    const r = await call(w, key);
    expect(await refusal(r)).toMatchObject({ status: 400, message: "the model maker said no" });
    expect(store(w).balance(AGENT)).toBe(49_500_000);
    expect(usageRows(w)[0]).toMatchObject({ cost_micro: 0, status: 400 });
    // and nothing is held back afterwards
    w.up.next = {};
    expect((await call(w, key)).status).toBe(200);
  });

  it("takes nothing when the model maker cannot be reached", async () => {
    const w = await world();
    const key = await newKey(w);
    w.up.next = { drop: true };
    expect(await refusal(await call(w, key))).toMatchObject({ status: 502, type: "api_error" });
    expect((await balance(w, key)).balanceUsd).toBe(49.5);
    expect(usageRows(w)).toHaveLength(0);
  });

  it("spends the oldest credit first", async () => {
    const w = await world({ draw: ETH / 500n }); // $4.95
    const second = w.chain.lock(CUSTOMER, AGENT, ETH / 10n);
    w.chain.draw(second, ETH / 100n, K.compute); // $24.75
    await w.engine.watchOnce();
    const key = await newKey(w);
    w.up.next = { usage: { input_tokens: 2_000_000, output_tokens: 100_000 } }; // $5.25 with the margin
    await (await call(w, key, { max_tokens: 1000, messages: [{ role: "user", content: "x" }] })).text();
    expect((await balance(w, key)).lots).toMatchObject([{ job: w.job, usd: 4.95, spentUsd: 4.95 }, { job: second, usd: 24.75, spentUsd: 0.3 }]);
  });
});

describe("what the gateway refuses", () => {
  it("anything it cannot price or will not pass on, before the model maker hears of it", async () => {
    const w = await world();
    const key = await newKey(w);
    const no = async (body: Record<string, unknown>) => refusal(await call(w, key, body));
    expect(await no({ model: "gpt-something" })).toMatchObject({ status: 400, type: "invalid_request_error" });
    expect((await no({ model: "gpt-something" })).message).toContain(SONNET);
    expect((await no({ service_tier: "priority" })).message).toContain('"service_tier"');
    expect((await no({ speed: "fast" })).status).toBe(400);
    expect((await no({ betas: ["x"] })).status).toBe(400);
    expect((await no({ max_tokens: 16_001 })).message).toContain("16000");
    expect((await no({ max_tokens: 0 })).status).toBe(400);
    expect((await no({ max_tokens: "many" })).status).toBe(400);
    expect((await no({ tools: [{ type: "web_search_20250305", name: "web_search" }] })).message).toContain("web_search_20250305");
    expect((await no({ tools: "all" })).status).toBe(400);
    expect(await refusal(await fetch(`${w.url}/v1/compute/v1/messages`, { method: "POST", headers: { "x-api-key": key }, body: "[1,2]" }))).toMatchObject({ status: 400 });
    expect(await refusal(await fetch(`${w.url}/v1/compute/v1/messages`, { method: "POST", headers: { "x-api-key": key }, body: "{oops" }))).toMatchObject({ status: 400, message: "The body is not JSON." });
    expect(await refusal(await fetch(`${w.url}/v1/compute/somewhere`, { headers: { "x-api-key": key } }))).toMatchObject({ status: 404 });
    expect(w.up.seen).toHaveLength(0);
    expect(usageRows(w)).toHaveLength(0);
    // a tool the agent runs itself is fine
    expect((await call(w, key, { tools: [{ name: "look_up", description: "Looks something up.", input_schema: { type: "object", properties: {} } }], tool_choice: { type: "auto" } })).status).toBe(200);
  });

  it("a request that is too large", async () => {
    const w = await world({ more: { COMPUTE_MAX_BODY_BYTES: "2000" } });
    const key = await newKey(w);
    expect(await refusal(await call(w, key, { system: "x".repeat(3000) }))).toMatchObject({ status: 413, type: "request_too_large" });
    expect(w.up.seen).toHaveLength(0);
  });

  it("an agent with no credit, and a request that could cost more than the credit left", async () => {
    const w = await world({ draw: ETH / 100_000n }); // 0.0000099 ETH after the fee: about 2.5 cents
    const key = await newKey(w);
    expect(store(w).balance(AGENT)).toBe(24_750);
    // 2,000 tokens out on Sonnet could cost 2.1 cents by themselves, and the request's own size comes on top
    const r = await refusal(await call(w, key, { max_tokens: 2200 }));
    expect(r).toMatchObject({ status: 402, type: "billing_error" });
    expect(r.message).toContain("Lower max_tokens");
    expect(w.up.seen).toHaveLength(0);
    expect((await call(w, key, { max_tokens: 1500 })).status).toBe(200);
    // an agent that never drew as compute
    w.chain.register(OTHER);
    w.chain.mine();
    await w.engine.watchOnce();
    const none = ((await (await keyFor(w, otherKey)).json()) as { key: string }).key;
    expect(await refusal(await call(w, none))).toMatchObject({ status: 402, message: "This agent has no compute credit. Draw an advance as compute on a job it was hired for." });
  });

  it("the same credit spent twice by calls made at the same moment", async () => {
    const w = await world({ draw: ETH / 100_000n }); // about 2.5 cents
    const key = await newKey(w);
    let release = () => {};
    w.up.next = { hold: new Promise<void>((done) => { release = done; }), usage: { input_tokens: 50, output_tokens: 1500 } };
    // each could cost 1.6 cents at the worst: one fits, two do not
    const first = call(w, key, { max_tokens: 1500 });
    while (w.up.seen.length === 0) await new Promise((r) => setTimeout(r, 2));
    expect((await balance(w, key)).balanceUsd).toBeLessThan(0.01);
    const second = await refusal(await call(w, key, { max_tokens: 1500 }));
    expect(second).toMatchObject({ status: 402, type: "billing_error" });
    release();
    expect((await first).status).toBe(200);
    await (await first).text();
    // what was really used is what was taken: 50 x 2 + 1500 x 10 and 5%
    expect(store(w).balance(AGENT)).toBe(24_750 - 15_855);
    expect(usageRows(w)).toHaveLength(1);
    expect(store(w).totals().unpaidMicro).toBe(0);
  });

  it("more requests under way at once than an agent may have", async () => {
    const w = await world({ more: { COMPUTE_IN_FLIGHT: "2" } });
    const key = await newKey(w);
    let release = () => {};
    w.up.next = { hold: new Promise<void>((done) => { release = done; }) };
    const under = [call(w, key), call(w, key)];
    while (w.up.seen.length < 2) await new Promise((r) => setTimeout(r, 2));
    expect(await refusal(await call(w, key))).toMatchObject({ status: 429, type: "rate_limit_error" });
    release();
    for (const r of await Promise.all(under)) expect(r.status).toBe(200);
    w.up.next = {};
    expect((await call(w, key)).status).toBe(200);
  });
});

describe("the owner's own ceilings", () => {
  it("turns calls away once the day's spending is reached, keeps the credit, and starts again at midnight UTC", async () => {
    const w = await world({ more: { COMPUTE_DAILY_USD: "1" } });
    const key = await newKey(w);
    w.up.next = { usage: { input_tokens: 0, output_tokens: 94_000 } }; // 98.7 cents
    expect((await call(w, key)).status).toBe(200);
    w.up.next = {};
    // 0.4 cents more would fit, the worst this request could cost (its size and 16,000 tokens out) would not
    const r = await refusal(await call(w, key, { max_tokens: 16_000 }));
    expect(r).toMatchObject({ status: 429, type: "rate_limit_error" });
    expect(r.message).toContain("after midnight UTC");
    expect(w.up.seen).toHaveLength(1);
    expect((await balance(w, key)).balanceUsd).toBe(49.5 - 0.987);
    expect(((await w.engine.handle("/v1/health"))!.body as { compute: { todayMicro: number; dailyMicro: number } }).compute).toMatchObject({ todayMicro: 987_000, dailyMicro: 1_000_000 });
    w.chain.mine(1, 86_400);
    expect((await call(w, key, { max_tokens: 16_000 })).status).toBe(200);
  });

  it("holds all agents together to a number of calls under way", async () => {
    const w = await world({ more: { COMPUTE_IN_FLIGHT_ALL: "1" } });
    const key = await newKey(w);
    let release = () => {};
    w.up.next = { hold: new Promise<void>((done) => { release = done; }) };
    const first = call(w, key);
    while (w.up.seen.length < 1) await new Promise((r) => setTimeout(r, 2));
    expect(await refusal(await call(w, key))).toMatchObject({ status: 429, message: "The gateway is busy. Try again in a moment." });
    release();
    expect((await first).status).toBe(200);
    w.up.next = {};
    expect((await call(w, key)).status).toBe(200);
  });
});

describe("when the job ends", () => {
  it("a job that settled leaves what is left of its credit with the agent", async () => {
    const w = await world();
    const key = await newKey(w);
    await (await call(w, key)).text();
    w.chain.deliver(w.job);
    w.chain.accept(w.job);
    await w.engine.watchOnce();
    expect(await balance(w, key)).toMatchObject({ balanceUsd: 49.5 - 0.0042, lots: [{ state: "kept" }] });
    expect((await call(w, key)).status).toBe(200);
    expect(store(w).owedToPool().wei).toBe(0n);
  });

  it("a refund the agent's bond covered leaves the credit too: the bond paid for it", async () => {
    const w = await world({ mode: "live" });
    const key = await newKey(w);
    w.chain.mine(1, 37 * 3600);
    await w.turn();
    expect(w.chain.sends("refund")).toHaveLength(1);
    await w.engine.watchOnce();
    expect(await balance(w, key)).toMatchObject({ balanceUsd: 49.5, lots: [{ state: "kept" }] });
    expect(store(w).owedToPool().wei).toBe(0n);
  });

  /** An agent whose limit is over its bond (fees it has paid count), so a refund can cost the pool. */
  async function lossy(mode: "watch" | "dry" | "live", gatewayIsBot = true): Promise<World & { lost: bigint }> {
    const chain = new FakeChain();
    if (gatewayIsBot) chain.gatewayAddr = A.bot;
    chain.fund(ETH);
    chain.register(AGENT);
    chain.bond(AGENT, ETH / 100n);
    // a first job settled: 0.004 of fees paid, so the limit is 0.014
    const first = chain.lock(CUSTOMER, AGENT, ETH / 10n);
    chain.draw(first, ETH / 100n, K.pool);
    chain.deliver(first);
    chain.accept(first);
    const job = chain.lock(CUSTOMER, AGENT, ETH / 10n);
    const limit = chain.agents.get(AGENT)!.bond + chain.agents.get(AGENT)!.feesPaid;
    chain.draw(job, limit, K.compute);
    const up = await upstream();
    const r = await rig(mode, { chain, more: { ...ON, COMPUTE_UPSTREAM_URL: up.url } });
    await r.engine.watchOnce();
    return { ...r, up, url: await serve(r), job, lost: limit - ETH / 100n };
  }

  it("a refund the pool lost on: the pool takes back what it lost from what was not spent, and no more", async () => {
    const w = await lossy("live");
    const key = await newKey(w);
    const lot = store(w).lots(AGENT)[0]!;
    await (await call(w, key)).text();
    const poolBefore = w.chain.pool;
    w.chain.mine(1, 37 * 3600);
    await w.turn(); // the keeper refunds the job
    await w.turn(); // the refund is read, and the ETH goes back
    await w.turn();
    expect(w.chain.sends("refund")).toHaveLength(1);
    const after = store(w).lots(AGENT)[0]!;
    expect(BigInt(after.back_wei)).toBe(w.lost);
    expect(after.state).toBe("kept");
    // the credit that went with it: the same share of the dollars, rounded up
    const unspentWei = (BigInt(lot.wei) * BigInt(lot.usd_micro! - 4200)) / BigInt(lot.usd_micro!);
    const gone = Number((BigInt(lot.usd_micro! - 4200) * w.lost + unspentWei - 1n) / unspentWei);
    expect(after.usd_micro).toBe(lot.usd_micro! - gone);
    expect((await balance(w, key)).balanceUsd).toBe((lot.usd_micro! - gone - 4200) / 1e6);
    // and the ETH really went to the desk, once
    const pays = w.chain.sends("pay");
    expect(pays).toHaveLength(1);
    expect(pays[0]!.tx.pay).toEqual({ to: A.desk, value: w.lost });
    expect(w.chain.pool - poolBefore).toBeGreaterThanOrEqual(w.lost);
    expect(after.back_tx).toBe(pays[0]!.hash);
    expect(store(w).owedToPool().wei).toBe(0n);
    expect(w.db.lastAction("return_compute")).toMatchObject({ status: "done" });
    const ledger = ((await w.engine.handle("/v1/ledger", new URLSearchParams("show=pool")))!.body as { items: { text: string; amount: string; tx: string }[] }).items;
    expect(ledger[0]).toMatchObject({ text: "compute credit nobody spent went back to the pool", tx: pays[0]!.hash });
    await w.turn();
    expect(w.chain.sends("pay")).toHaveLength(1);
    // read again from the start, nothing is given back and nothing is sent twice
    w.db.forgetChain();
    await w.turn();
    await w.turn();
    expect(store(w).lots(AGENT)[0]).toEqual(after);
    expect(w.chain.sends("pay")).toHaveLength(1);
  });

  it("takes all of what is left when the pool lost more than that, and the key buys nothing more", async () => {
    const w = await lossy("live");
    const key = await newKey(w);
    const lot = store(w).lots(AGENT)[0]!;
    // nearly all of it spent: what is left is less than the pool lost
    w.up.next = { usage: { input_tokens: 0, output_tokens: 2_500_000 } };
    await (await call(w, key, { max_tokens: 16_000 })).text();
    const left = lot.usd_micro! - 26_250_000;
    expect(left).toBeGreaterThan(0);
    expect(store(w).balance(AGENT)).toBe(left);
    w.chain.mine(1, 37 * 3600);
    await w.turn();
    await w.turn();
    await w.turn();
    const after = store(w).lots(AGENT)[0]!;
    expect(after.state).toBe("closed");
    expect(BigInt(after.back_wei)).toBe((BigInt(lot.wei) * BigInt(left)) / BigInt(lot.usd_micro!));
    expect(BigInt(after.back_wei)).toBeLessThan(w.lost);
    expect(w.chain.sends("pay")[0]!.tx.pay!.value).toBe(BigInt(after.back_wei));
    expect((await balance(w, key)).balanceUsd).toBe(0);
    expect(await refusal(await call(w, key))).toMatchObject({ status: 402 });
  });

  it("in dry mode says what it would send back, and sends nothing", async () => {
    const w = await lossy("dry");
    w.chain.mine(1, 37 * 3600);
    w.chain.refund(w.job);
    await w.turn();
    expect(store(w).owedToPool().wei).toBe(w.lost);
    expect(actState(w.engine.ctx!, "return_compute").result).toContain("would send");
    expect(w.db.lastAction("return_compute")).toMatchObject({ status: "dry" });
    expect(w.chain.sends()).toHaveLength(0);
    expect(store(w).lots(AGENT)[0]!.back_tx).toBeNull();
  });

  it("says so when the gas wallet is not the desk's gateway, and sends nothing from the wrong wallet", async () => {
    const w = await lossy("live", false);
    w.chain.mine(1, 37 * 3600);
    await w.turn();
    await w.turn();
    await w.turn();
    expect(store(w).owedToPool().wei).toBe(w.lost);
    expect(actState(w.engine.ctx!, "return_compute").result).toContain("the gas wallet is not the desk's gateway");
    expect(w.chain.sends("pay")).toHaveLength(0);
    expect(((await w.engine.handle("/v1/health"))!.body as { compute: { owedToPoolWei: string } }).compute.owedToPoolWei).toBe(w.lost.toString());
  });
});

describe("a count nobody could have expected", () => {
  it("more used than the worst the request could have cost takes the credit to nothing, never under, and is written down", async () => {
    const w = await world({ draw: ETH / 100_000n }); // about 2.5 cents
    const key = await newKey(w);
    w.up.next = { usage: { input_tokens: 0, output_tokens: 10_000 } }; // 10.5 cents, on a request that asked for 500 tokens
    await (await call(w, key)).text();
    expect(store(w).balance(AGENT)).toBe(0);
    expect(usageRows(w)[0]).toMatchObject({ cost_micro: 105_000, unpaid_micro: 105_000 - 24_750 });
    expect(store(w).totals()).toMatchObject({ spentMicro: 24_750, unpaidMicro: 80_250, outstandingMicro: 0 });
    expect(await refusal(await call(w, key))).toMatchObject({ status: 402 });
  });
});

describe("switched off", () => {
  it("writes the credit down all the same, hands out keys, and serves no model", async () => {
    const w = await world({ more: { COMPUTE_MODE: "off" } });
    expect(((await w.engine.handle("/v1/state"))!.body as { compute: { enabled: boolean } }).compute.enabled).toBe(false);
    const key = await newKey(w);
    expect(await balance(w, key)).toMatchObject({ balanceUsd: 49.5, enabled: false });
    expect(await refusal(await call(w, key))).toMatchObject({ status: 503, type: "api_error" });
    expect(w.up.seen).toHaveLength(0);
  });

  it("with the switch on and no key, says why to the owner and serves no model", async () => {
    const w = await world({ more: { ANTHROPIC_API_KEY: "" } });
    const key = await newKey(w);
    expect((await call(w, key)).status).toBe(503);
    expect(w.lines.join("\n")).toContain("[compute] NOT ON");
    expect(((await w.engine.handle("/v1/health"))!.body as { compute: { note: string } }).compute.note).toContain("ANTHROPIC_API_KEY is not set");
  });
});

describe("the owner's key", () => {
  it("is in nothing the engine says: not its log, not its answers, not its database", async () => {
    const w = await world();
    const key = await newKey(w);
    const answers: string[] = [];
    answers.push(await (await call(w, key)).text());
    w.up.next = { status: 401 };
    answers.push(await (await call(w, key)).text());
    w.up.next = { drop: true };
    answers.push(await (await call(w, key)).text());
    answers.push(await (await call(w, key, { model: "nope" })).text());
    for (const path of ["/v1/state", "/v1/health", "/v1/agents", "/v1/ledger"]) answers.push(JSON.stringify((await w.engine.handle(path))!.body));
    answers.push(await (await fetch(`${w.url}/v1/compute/models`)).text(), JSON.stringify(await balance(w, key)));
    const tables = (w.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => JSON.stringify(w.sqlite.prepare(`SELECT * FROM ${t.name}`).all()));
    const all = [...answers, ...w.lines, ...tables].join("\n");
    expect(all).not.toContain(MODEL_KEY);
    expect(all).not.toContain("sk-ant");
    // nor the agent's key, anywhere but the one answer that handed it over
    expect(all).not.toContain(key);
    expect(w.up.seen.length).toBeGreaterThan(0);
  });
});
