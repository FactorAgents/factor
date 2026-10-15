// Compute credit against the real OpenRouter, with Factor's own key: the one test here that spends real money, a few
// cents. It is skipped unless it is asked for, so `npm test` never spends anything:
//
//   FACTOR_LIVE_ROUTER=1 OPENROUTER_API_KEY=… npx vitest run test/compute.live.test.ts
//
// The chain is the made-up one: an agent hired for 0.1 ETH draws 0.02 of it as compute ($49.50 of credit at $2,500).
// It signs for a key, calls three real models from three makers (one of them streamed), and every call must come
// back answered and cost exactly what OpenRouter charged plus the margin. Then the job settles and the credit stays.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { ComputeStore, keyMessage } from "../src/compute.js";
import { ETH, FakeChain, K } from "./chain/fake.js";
import { rig, wallet } from "./chain/harness.js";

const LIVE = process.env.FACTOR_LIVE_ROUTER === "1" && !!process.env.OPENROUTER_API_KEY?.trim();
const agentKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d"); // anvil's, worth nothing
const AGENT = agentKey.address.toLowerCase();

const servers: Server[] = [];
afterAll(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

interface Model { id: string; pricing: { inUsd: number; outUsd: number } }

describe.skipIf(!LIVE)("compute credit, against the real OpenRouter", () => {
  it("answers three makers' models, charges what each call cost, and leaves the rest with the agent when the job settles", { timeout: 180_000 }, async () => {
    const chain = new FakeChain();
    chain.fund(ETH);
    chain.register(AGENT);
    chain.bond(AGENT, ETH / 50n);
    const job = chain.lock(wallet(0xc1), AGENT, ETH / 10n);
    chain.draw(job, ETH / 50n, K.compute);
    const w = await rig("watch", { chain, more: { COMPUTE_MODE: "on", OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY!.trim() } });
    await w.engine.watchOnce();
    const url = await new Promise<string>((done) => {
      const s = createServer((req, res) => { if (!w.engine.compute(req, res, (req.url ?? "/").split("?")[0]!)) { res.writeHead(503); res.end("{}"); } });
      servers.push(s);
      s.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    });
    const store = new ComputeStore(w.db);
    expect(store.balance(AGENT)).toBe(49_500_000);

    // OpenRouter's own list, with the caps applied
    const list = (await (await fetch(`${url}/v1/compute/v1/models`)).json()) as { data: Model[] };
    console.log(`[live] ${list.data.length} models served`);
    expect(list.data.length).toBeGreaterThan(50);
    // plain chat models, so a short answer is words and not thinking; the cheapest of a maker when the first is gone
    const pick = (ids: string[], maker: string) => list.data.find((m) => ids.includes(m.id)) ?? list.data.filter((m) => m.id.startsWith(`${maker}/`)).sort((a, b) => a.pricing.outUsd - b.pricing.outUsd)[0]!;
    const picks = [pick(["openai/gpt-4o-mini", "openai/gpt-4.1-mini"], "openai"), pick(["anthropic/claude-haiku-4.5", "anthropic/claude-3.5-haiku", "anthropic/claude-3-haiku"], "anthropic"), pick(["deepseek/deepseek-chat-v3.1", "deepseek/deepseek-chat"], "deepseek")];
    for (const p of picks) expect(p, "a model from each of the three makers").toBeTruthy();

    const at = Math.floor(w.db.now() / 1000);
    const k = (await (await fetch(`${url}/v1/compute/key`, { method: "POST", body: JSON.stringify({ address: AGENT, at, signature: await agentKey.signMessage({ message: keyMessage(AGENT, at) }) }) })).json()) as { key: string };

    let spent = 0;
    for (const [i, m] of picks.entries()) {
      const stream = i === 2;
      const r = await fetch(`${url}/v1/compute/v1/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${k.key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: m.id, max_tokens: 120, stream, messages: [{ role: "user", content: "Reply with one short sentence: what is Robinhood Chain?" }] }),
      });
      const text = await r.text();
      expect(r.status, `${m.id} answered`).toBe(200);
      const said = stream
        ? text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => (JSON.parse(l.slice(6)) as { choices?: { delta?: { content?: string | null } }[] }).choices?.[0]?.delta?.content ?? "").join("")
        : (JSON.parse(text) as { choices: { message: { content: string | null } }[] }).choices[0]!.message.content ?? "";
      const row = w.sqlite.prepare("SELECT * FROM compute_usage ORDER BY id DESC LIMIT 1").get() as { model: string; input: number; output: number; cost_micro: number; unpaid_micro: number; status: number };
      // what OpenRouter said it charged, read back from the answer itself
      const reported = stream
        ? (JSON.parse(text.split("\n").filter((l) => l.startsWith("data: {") && l.includes('"usage"')).at(-1)!.slice(6)) as { usage: { cost: number } }).usage.cost
        : (JSON.parse(text) as { usage: { cost: number } }).usage.cost;
      console.log(`[live] ${m.id}${stream ? " (streamed)" : ""}: "${said.trim().slice(0, 90)}" | ${row.input} in, ${row.output} out | OpenRouter charged $${reported.toFixed(6)}, credit charged $${(row.cost_micro / 1e6).toFixed(6)}`);
      expect(said.trim().length).toBeGreaterThan(0);
      expect(row).toMatchObject({ model: m.id, status: 200, unpaid_micro: 0 });
      expect(row.cost_micro).toBe(Math.ceil((reported * 1e6 * 10_500) / 10_000 - 1e-9));
      expect(row.cost_micro).toBeGreaterThan(0);
      spent += row.cost_micro;
    }
    expect(store.balance(AGENT)).toBe(49_500_000 - spent);

    // the job settles: what is left of the credit is the agent's to keep using
    chain.deliver(job);
    chain.accept(job);
    await w.engine.watchOnce();
    expect(store.lots(AGENT)[0]).toMatchObject({ state: "kept" });
    expect(store.balance(AGENT)).toBe(49_500_000 - spent);
    console.log(`[live] all three calls together: $${(spent / 1e6).toFixed(6)} of credit; the job settled and $${(store.balance(AGENT) / 1e6).toFixed(4)} stays with the agent`);
    // the key is in nothing the engine wrote
    expect(JSON.stringify([w.lines, w.sqlite.prepare("SELECT * FROM compute_usage").all()])).not.toContain(process.env.OPENROUTER_API_KEY!.trim());
  });
});
