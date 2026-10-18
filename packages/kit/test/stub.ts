// A made-up Factor site and a made-up node, for the tests that need nothing but the kit's own behaviour: what it
// refuses before it would send anything, and what its tools say. The real thing is scripts/e2e.ts.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Agent, Job, State } from "../src/types.js";

export const DESK = "0x00000000000000000000000000000000000de5c0";
export const KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // one of anvil's public test keys

const agent = (name: string, address: string, score: number, over: Partial<Agent> = {}): Agent => ({
  id: address, name, named: true, address, house: false, does: "Summarises long documents", since: "2026-10-01T00:00:00.000Z", settled: 4, settledAtHalf: 0, notDelivered: 0, unanswered: 0, customers: 2,
  onTimePct: 100, volumeEth: 0.2, feesPaidEth: 0.004, bondEth: 0.02, drawnEth: 0, limitEth: 0.024, canDrawEth: 0.024, advancesRepaid: 2, advancesMissed: 0, barred: false, score, scoreParts: [], ...over,
});
export const AGENTS = [agent("lumen-07", "0x00000000000000000000000000000000000000a1", 624), agent("page-smith", "0x00000000000000000000000000000000000000a2", 580, { house: true, does: "Builds a landing page" })];
export const JOB: Job = {
  id: "0012", n: 12, title: "Summarise a contract", agentId: AGENTS[0].address, customer: "0x00000000000000000000000000000000000000c1", priceEth: 0.04, state: "delivered",
  lockedAt: "2026-10-13T08:00:00.000Z", dueAt: "2026-10-14T08:00:00.000Z", allowEarly: false, late: false, deliveredAt: "2026-10-13T09:00:00.000Z", advances: [{ kind: "pool", eth: 0.02, feeEth: 0.0002, at: "2026-10-13T08:05:00.000Z" }], tx: "0xabc",
};

export function state(over: Partial<State> = {}): State {
  return {
    asOf: new Date().toISOString(), launched: true, links: { pons: null, github: null, x: null },
    stats: { advancedEth: 1.2, settledJobs: 31, jobs: 40, poolEth: 0.62, reserveEth: 0.124, outEth: 0.03, heldEth: 0.1, burnedTokens: 1000, supplyLeft: 999_999_000, agents: 2, lostEth: 0 },
    params: { advanceMaxPct: 50, advanceFeePct: 1, jobFeePct: 2, graceHours: 12, reviewHours: 24, rejectedPct: 50, reserveMinPct: 20, minJobEth: 0.001 },
    agents: AGENTS, jobs: [JOB], events: [], contracts: { desk: DESK, splitter: null, burnPot: null, token: null, explorer: "https://explorer.example" },
    compute: { enabled: true, markupPct: 5, maxTokens: 16_000, models: [{ id: "claude-sonnet-5-5", inUsd: 2.1, outUsd: 10.5 }] },
    accounts: { enabled: false, factory: null, ordersPerDay: 40 }, paused: null, ...over,
  };
}

export interface Stub { api: string; rpc: string; site: { state: State; refuse: number | null; payInfo: ((token: string) => { status: number; body: unknown }) | null; x402: { status: number; body: unknown } | null; record: unknown; jobExtra: Record<string, unknown>; tree: unknown; firms: unknown[]; firm: unknown; firmRecord: unknown }; node: { chainId: number; code: string; calls: string[] }; posts: { path: string; body: unknown; auth?: string }[]; close(): Promise<void> }

export async function stub(): Promise<Stub> {
  const site = { state: state(), refuse: null as number | null, payInfo: null as Stub["site"]["payInfo"], x402: null as Stub["site"]["x402"], record: null as unknown, jobExtra: {} as Record<string, unknown>, tree: null as unknown, firms: [] as unknown[], firm: null as unknown, firmRecord: null as unknown };
  const node = { chainId: 4663, code: "0x6080", calls: [] as string[] };
  const posts: { path: string; body: unknown; auth?: string }[] = [];
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const body = (req: import("node:http").IncomingMessage) => new Promise<string>((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });
  const web = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0].replace("/api/v1", "");
    if (req.method === "POST") {
      posts.push({ path, body: JSON.parse(await body(req)), ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
      // the compute gateway: a model's answer, in the shape of the door that was called
      if (path === "/compute/v1/chat/completions" || path === "/compute/v1/messages") {
        if (site.refuse) return json(res, site.refuse, { type: "error", error: { type: "billing_error", message: "this agent has no compute credit" } });
        const m = (posts.at(-1)!.body as { model: string }).model;
        return json(res, 200, path.endsWith("messages")
          ? { type: "message", model: m, content: [{ type: "text", text: "Hello from Claude" }], usage: { input_tokens: 12, output_tokens: 4 } }
          : { id: "gen-1", model: m, choices: [{ message: { role: "assistant", content: "Hello from the model" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      }
      // agents that hire agents: the plan is taken and holds room, as the engine would answer
      if (path === "/subjobs/plan") return json(res, 200, { ok: true, plan: `0x${"ab".repeat(32)}`, burnWei: "100000000000000", depth: 1 });
      // agent firms: a firm formed as it was signed
      if (path === "/firms/form") { const b = posts.at(-1)!.body as { slug: string; members: string[] }; return json(res, 200, { ok: true, firm: b.slug, edited: false, invited: b.members }); }
      return json(res, 200, path === "/compute/key" ? { key: "fck_a-key-from-the-stub-0123456789ab", expiresAt: "2026-10-20T00:00:00.000Z", agent: (posts.at(-1)!.body as { address: string }).address } : { ok: true });
    }
    const credit = /^\/compute\/credit\/(0x[0-9a-f]{40})$/.exec(path);
    if (credit) return json(res, 200, { agent: credit[1], balanceUsd: credit[1] === AGENTS[0].address ? 12.5 : 49.5, enabled: site.state.compute.enabled, lots: [{ job: 12, at: "2026-10-13T10:00:00.000Z", usd: 49.5, spentUsd: 0, state: "open" }] });
    if (path === "/state") return json(res, 200, site.state);
    // Pay with Factor: what the test puts here is what the site says
    const link = /^\/pay\/link\/(.+)$/.exec(path);
    if (link) { const a = site.payInfo?.(link[1]) ?? { status: 404, body: { error: "not found" } }; return json(res, a.status, a.body); }
    if (path.startsWith("/x402/")) return site.x402 ? json(res, site.x402.status, site.x402.body) : json(res, 404, { error: "not found" });
    if (path === "/record/signer") return json(res, 200, { signer: (site.record as { attestation?: { signer: string } } | null)?.attestation?.signer ?? null });
    if (path.startsWith("/record/")) return site.record ? json(res, 200, site.record) : json(res, 404, { error: "no such agent" });
    if (path === "/compute/v1/models") return json(res, 200, { object: "list", data: [
      { id: "openai/gpt-5", object: "model", owned_by: "openai", name: "OpenAI: GPT-5", context_length: 400_000, pricing: { inUsd: 1.3125, outUsd: 10.5 } },
      { id: "deepseek/deepseek-chat", object: "model", owned_by: "deepseek", name: "DeepSeek V3", context_length: 128_000, pricing: { inUsd: 0.2625, outUsd: 0.84 } },
    ] });
    if (path === "/firms") return json(res, 200, { enabled: true, items: site.firms });
    if (/^\/firms\/[a-z0-9-]+\/record$/.test(path)) return site.firmRecord ? json(res, 200, site.firmRecord) : json(res, 404, { error: "no such firm" });
    if (/^\/firms\/[a-z0-9-]+$/.test(path)) return site.firm ? json(res, 200, site.firm) : json(res, 404, { error: "no such firm" });
    if (path === "/agents") return json(res, 200, { items: site.state.agents });
    if (path === "/jobs") return json(res, 200, { total: 1, more: false, items: site.state.jobs });
    if (path === "/ledger") return json(res, 200, { total: 0, more: false, items: [] });
    const a = /^\/agents\/(.+)$/.exec(path);
    if (a) { const g = site.state.agents.find((x) => x.address === a[1].toLowerCase() || x.name === a[1]); return g ? json(res, 200, { agent: g, jobs: site.state.jobs, events: [] }) : json(res, 404, { error: "no such agent" }); }
    const t = /^\/jobs\/(\d+)\/tree$/.exec(path);
    if (t) return site.tree ? json(res, 200, site.tree) : json(res, 404, { error: "that job hired nobody" });
    const j = /^\/jobs\/(\d+)$/.exec(path);
    if (j) { const g = site.state.jobs.find((x) => x.n === Number(j[1])); return g ? json(res, 200, { job: g, agent: site.state.agents[0], events: [], ...site.jobExtra }) : json(res, 404, { error: "no such job" }); }
    json(res, 404, { error: "not found" });
  });
  const rpc = createServer(async (req, res) => {
    const call = JSON.parse(await body(req)) as { id: number; method: string } | { id: number; method: string }[];
    const one = (c: { id: number; method: string }) => {
      node.calls.push(c.method);
      const block = { number: "0x10", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"10".repeat(32)}`, timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x1", transactions: [], miner: `0x${"00".repeat(20)}`, extraData: "0x", logsBloom: `0x${"00".repeat(256)}`, nonce: "0x0000000000000000", difficulty: "0x0", sha3Uncles: `0x${"00".repeat(32)}`, size: "0x1", stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, transactionsRoot: `0x${"00".repeat(32)}`, uncles: [], mixHash: `0x${"00".repeat(32)}` };
      const result = c.method === "eth_chainId" ? `0x${node.chainId.toString(16)}` : c.method === "eth_getCode" ? node.code : c.method === "eth_blockNumber" ? "0x10" : c.method === "eth_getBlockByNumber" ? block : null;
      return result === null ? { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: `the stub node does not do ${c.method}` } } : { jsonrpc: "2.0", id: c.id, result };
    };
    json(res, 200, Array.isArray(call) ? call.map(one) : one(call));
  });
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
  const [wp, rp] = await Promise.all([listen(web), listen(rpc)]);
  return { api: `http://127.0.0.1:${wp}`, rpc: `http://127.0.0.1:${rp}`, site, node, posts, close: () => new Promise<void>((r) => { web.close(); rpc.close(); r(); }) };
}
