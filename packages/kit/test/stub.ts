// A made-up Factor site and a made-up node, for the tests that need nothing but the kit's own behaviour: what it
// refuses before it would send anything, and what its tools say. The real thing is scripts/e2e.ts.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, toFunctionSelector, type Abi, type Hex } from "viem";
import { factorBountyAbi } from "../src/abi/FactorBounty.js";
import { entryHashOf as engineEntryHash } from "../../../engine/src/bounties.js";
import type { Agent, Job, State } from "../src/types.js";

export const DESK = "0x00000000000000000000000000000000000de5c0";
export const COIN_LAUNCHER = "0x00000000000000000000000000000000000c01a1";
export const BOUNTY = "0x00000000000000000000000000000000000b0a7e";
const B = factorBountyAbi as Abi;
/** A bounty as the made-up bounty contract holds it. */
export interface ChainBounty { poster: string; deadline: number; minScore: number; state: number; bondsBack: boolean; winner: string; prize: bigint; fee: bigint; bond: bigint; job: bigint; task: Hex }
const LAUNCH_FEE = toFunctionSelector("launchFee()");
const NONCES = toFunctionSelector("nonces(address)");
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

export const MILESTONES_OFF = { enabled: false, contract: null, chainId: 4663, rules: { minStages: 2, maxStages: 6, minStageEth: 0.001, minTimeH: 1, maxTimeD: 30, jobFeePct: 2, advanceFeePct: 1, graceH: 12, reviewH: 24, titleChars: 80, briefChars: 12_000, termsBytes: 40_000 }, totals: null };
export const BOUNTIES_OFF = { enabled: false, contract: null, chainId: 4663, rules: { burnPct: 1, bondPct: 1, jobFeePct: 2, minPrizeEth: 0.005, maxEntries: 25, minOpenH: 1, maxOpenD: 30, pickD: 3, deliverD: 3, graceH: 12, taskBytes: 8000, workBytes: 200_000 }, totals: null };

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

export interface Stub { api: string; rpc: string; site: { coins: unknown[]; coin: unknown; coinsAbout: unknown; state: State; refuse: number | null; payInfo: ((token: string) => { status: number; body: unknown }) | null; x402: { status: number; body: unknown } | null; record: unknown; jobExtra: Record<string, unknown>; tree: unknown; firms: unknown[]; firm: unknown; firmRecord: unknown; plan: unknown; plans: unknown[]; erc8004: unknown; openJob: unknown; openJobs: unknown[]; autoApply: unknown; verified: unknown; line: unknown; linesAbout: unknown; guarantee: unknown; cover: unknown; guaranteesAbout: unknown; covers: unknown[]; bountiesAbout: unknown; bounties: unknown[]; bounty: unknown; bountyEntry: unknown; agentBounties: unknown; bountyPoster: unknown; bountyRead: unknown[]; milestonesAbout: unknown; milestones: unknown[]; milestone: unknown; burns: unknown[]; payLinks: unknown[]; raeto: boolean; credit: Record<string, unknown>; everywhereAbout: unknown; everywhere: ((path: string, auth: string) => { status: number; body: unknown } | null) | null; connect: ((path: string, body: Record<string, unknown>, auth: string) => { status: number; body: unknown }) | null; ask: ((body: Record<string, unknown>) => { status: number; body: unknown }) | null; copilot: ((body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>) | null; reviews: ((method: "GET" | "POST", path: string, body: Record<string, unknown> | null) => Promise<{ status: number; body: unknown }>) | null }; node: { chainId: number; code: string; calls: string[]; bounties: Map<number, ChainBounty>; entries: Map<string, { hash: Hex; at: number }>; refuse: Record<string, { error: string; args: unknown[] }> }; posts: { path: string; body: unknown; auth?: string }[]; close(): Promise<void> }

export async function stub(): Promise<Stub> {
  const site = { coins: [] as unknown[], coin: null as unknown, coinsAbout: { enabled: false, launcher: null } as unknown, state: state(), refuse: null as number | null, payInfo: null as Stub["site"]["payInfo"], x402: null as Stub["site"]["x402"], record: null as unknown, jobExtra: {} as Record<string, unknown>, tree: null as unknown, firms: [] as unknown[], firm: null as unknown, firmRecord: null as unknown, plan: null as unknown, plans: [] as unknown[], erc8004: null as unknown, openJob: null as unknown, openJobs: [] as unknown[], autoApply: null as unknown, verified: null as unknown, line: null as unknown, linesAbout: { enabled: false, contract: null, chainId: 4663, rules: { feePct: 2, burnPct: 1, poolPct: 1, dueDays: 30, defaultDays: 30, minDrawEth: 0.0001, poolOutMaxPct: 80 }, pool: null, lines: 0, owing: 0 } as unknown, guarantee: null as unknown, cover: null as unknown, guaranteesAbout: { enabled: false, contract: null, chainId: 4663, rules: { feePct: 1, burnPctOfFee: 50, minCoverEth: 0.0001, windowMin: 60, graceH: 12, shares: [{ score: 200, pct: 25 }, { score: 400, pct: 50 }, { score: 600, pct: 75 }, { score: 800, pct: 100 }] }, totals: null } as unknown, covers: [] as unknown[], bountiesAbout: BOUNTIES_OFF as unknown, bounties: [] as unknown[], bounty: null as unknown, bountyEntry: null as unknown, agentBounties: null as unknown, bountyPoster: null as unknown, bountyRead: [] as unknown[], milestonesAbout: MILESTONES_OFF as unknown, milestones: [] as unknown[], milestone: null as unknown, burns: [] as unknown[], payLinks: [] as unknown[], raeto: false, credit: {} as Record<string, unknown>, everywhereAbout: { enabled: false, signer: null } as unknown, everywhere: null as Stub["site"]["everywhere"], connect: null as Stub["site"]["connect"], ask: null as Stub["site"]["ask"], copilot: null as Stub["site"]["copilot"], reviews: null as Stub["site"]["reviews"] };
  const node = { chainId: 4663, code: "0x6080", calls: [] as string[], bounties: new Map<number, ChainBounty>(), entries: new Map<string, { hash: Hex; at: number }>(), refuse: {} as Record<string, { error: string; args: unknown[] }> };
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
        // raeto/auto: the model Raeto picked, and what the call took from the credit, as the gateway says them
        if (m.startsWith("raeto/auto")) { res.writeHead(200, { "content-type": "application/json", "x-factor-route": "raeto", "x-raeto-model": "deepseek/deepseek-chat", "x-factor-cost-usd": "0.000412" }); return res.end(JSON.stringify({ id: "gen-2", model: "deepseek/deepseek-chat", choices: [{ message: { role: "assistant", content: "Hello from the model Raeto picked" } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000412 }, raeto: { model: "deepseek/deepseek-chat", cost_usd: 0.000412 } })); }
        return json(res, 200, path.endsWith("messages")
          ? { type: "message", model: m, content: [{ type: "text", text: "Hello from Claude" }], usage: { input_tokens: 12, output_tokens: 4 } }
          : { id: "gen-1", model: m, choices: [{ message: { role: "assistant", content: "Hello from the model" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      }
      // Ask Factor: whatever the test answers for a sentence
      if (path === "/ask") { const a = site.ask?.(posts.at(-1)!.body as Record<string, unknown>) ?? { status: 503, body: { error: "Ask Factor is resting just now: pick an agent from the list and hire it from the form" } }; return json(res, a.status, a.body); }
      // Factor Copilot: whatever the test answers for a message
      // paid reviews: whatever the test answers, as the site's own door would
      if (path.startsWith("/reviews")) { const a = (await site.reviews?.("POST", path, posts.at(-1)!.body as Record<string, unknown>)) ?? { status: 503, body: { error: "paid reviews are switched off for now" } }; return json(res, a.status, a.body); }
      if (path === "/copilot") { const a = (await site.copilot?.(posts.at(-1)!.body as Record<string, unknown>)) ?? { status: 503, body: { error: "Factor Copilot is resting just now: every form on the site works as always" } }; return json(res, a.status, a.body); }
      // Factor Connect: whatever the test answers for a marketplace
      if (path.startsWith("/connect/") && site.connect) { const a = site.connect(path.slice(9), posts.at(-1)!.body as Record<string, unknown>, String(req.headers.authorization ?? "")); return json(res, a.status, a.body); }
      // agents that hire agents: the plan is taken and holds room, as the engine would answer
      if (path === "/subjobs/plan") return json(res, 200, { ok: true, plan: `0x${"ab".repeat(32)}`, burnWei: "100000000000000", depth: 1 });
      // agent firms: a firm formed as it was signed
      // ERC-8004: a link taken as it was signed
      // open jobs: a listing taken as it was signed, and an application ranked first of one
      if (path === "/openjobs/post") return json(res, 200, { ok: true, open: `0x${"ef".repeat(32)}`, created: true, burnWei: "40000000000000" });
      if (path === "/openjobs/apply") return json(res, 200, { ok: true, open: (posts.at(-1)!.body as { open: string }).open, rank: 1, of: 1, listing: "open" });
      // auto-apply: the rules taken as they were signed
      if (path === "/autoapply/rules") { const b = posts.at(-1)!.body as Record<string, unknown>; return json(res, 200, { ok: true, agent: b.agent, rules: { on: b.on, takes: b.takes, words: b.words, floorWei: b.floorWei, atOnce: b.atOnce, hours: b.hours, early: b.early, pitch: b.pitch, ...(b.bid ? { bid: b.bid } : {}) } }); }
      // offers: an offer taken back as it was signed
      if (path === "/openjobs/withdraw") return json(res, 200, { ok: true, open: (posts.at(-1)!.body as { open: string }).open, withdrawn: true });
      // verified owners: the owner checked as the engine would answer, Human Passport passing
      if (path === "/verified/check") { const b = posts.at(-1)!.body as { agent: string; owner: string }; return json(res, 200, { ok: true, agent: b.agent, owner: b.owner, verified: true, checks: [{ name: "Human Passport", outcome: "pass", band: "20 to 29" }, { name: "Talent Protocol", outcome: "fail", band: "no record" }], checkedAt: "2026-10-24T09:00:00.000Z", expiresAt: "2026-11-23T09:00:00.000Z" }); }
      // agent coins: the permission Factor signs for an agent it runs, as the engine would answer it
      if (path === "/coins/permission") { const b = posts.at(-1)!.body as { agent: string; maker: string; name: string; symbol: string }; return json(res, 200, { agent: b.agent, maker: b.maker, name: b.name, symbol: b.symbol, logo: `https://factoragents.fun/api/v1/coins/logo/${b.agent}`, description: "d", nonce: "0", deadline: "4102444800", signature: `0x${"5e".repeat(65)}`, launcher: COIN_LAUNCHER, chainId: 4663 }); }
      if (path === "/erc8004/link") { const b = posts.at(-1)!.body as { agentId: string | null }; return json(res, 200, { ok: true, agentId: b.agentId, ...(b.agentId ? { via: "wallet" } : {}) }); }
      if (path === "/firms/form") { const b = posts.at(-1)!.body as { slug: string; members: string[] }; return json(res, 200, { ok: true, firm: b.slug, edited: false, invited: b.members }); }
      // bounties: a poster's read answers the entries it was given; a task or a work is taken as it was sent
      if (path === "/bounties/read") return json(res, site.bountyRead.length ? 200 : 409, site.bountyRead.length ? { id: (posts.at(-1)!.body as { id: number }).id, items: site.bountyRead } : { error: "the entries open to the poster at the deadline, once nobody can enter any more" });
      return json(res, 200, path === "/compute/key" ? { key: "fck_a-key-from-the-stub-0123456789ab", expiresAt: "2099-01-01T00:00:00.000Z", agent: (posts.at(-1)!.body as { address: string }).address } : { ok: true });
    }
    const credit = /^\/compute\/credit\/(0x[0-9a-f]{40})$/.exec(path);
    if (credit) return json(res, 200, { agent: credit[1], balanceUsd: credit[1] === AGENTS[0].address ? 12.5 : 49.5, enabled: site.state.compute.enabled, lots: [{ job: 12, at: "2026-10-13T10:00:00.000Z", usd: 49.5, spentUsd: 0, state: "open" }], ...site.credit });
    if (path === "/state") return json(res, 200, site.state);
    if (path.startsWith("/reviews")) { const a = (await site.reviews?.("GET", path + (req.url?.includes("?") ? `?${req.url.split("?")[1]}` : ""), null)) ?? { status: 200, body: { enabled: false } }; return json(res, a.status, a.body); }
    // Factor everywhere (src/everywhere.ts): whatever the test put there, as the site's own answers
    if (path === "/everywhere") return json(res, 200, site.everywhereAbout);
    if (path.startsWith("/everywhere/")) { const a = site.everywhere?.((req.url ?? "").replace(/^\/api\/v1\/everywhere\//, ""), String(req.headers.authorization ?? "")); return a ? json(res, a.status, a.body) : json(res, 404, { error: "no such agent" }); }
    // Pay with Factor: what the test puts here is what the site says
    const link = /^\/pay\/link\/(.+)$/.exec(path);
    if (link) { const a = site.payInfo?.(link[1]) ?? { status: 404, body: { error: "not found" } }; return json(res, a.status, a.body); }
    if (path.startsWith("/x402/")) return site.x402 ? json(res, site.x402.status, site.x402.body) : json(res, 404, { error: "not found" });
    if (path === "/record/signer") return json(res, 200, { signer: (site.record as { attestation?: { signer: string } } | null)?.attestation?.signer ?? null });
    if (path.startsWith("/record/")) return site.record ? json(res, 200, site.record) : json(res, 404, { error: "no such agent" });
    if (path === "/compute/v1/models") return json(res, 200, { object: "list", data: [
      ...(site.raeto ? [{ id: "raeto/auto", object: "model", created: 0, owned_by: "raeto", name: "Raeto picks the model for each request" }, { id: "raeto/auto:cheap", object: "model", created: 0, owned_by: "raeto", name: "Raeto picks the model, and keeps the cheap answer" }] : []),
      { id: "openai/gpt-5", object: "model", owned_by: "openai", name: "OpenAI: GPT-5", context_length: 400_000, pricing: { inUsd: 1.3125, outUsd: 10.5 } },
      { id: "deepseek/deepseek-chat", object: "model", owned_by: "deepseek", name: "DeepSeek V3", context_length: 128_000, pricing: { inUsd: 0.2625, outUsd: 0.84 } },
    ] });
    if (path === "/firms") return json(res, 200, { enabled: true, items: site.firms });
    if (path === "/coins") return json(res, 200, { enabled: true, items: site.coins });
    // credit lines: the rules and the pool, and one line as the engine answers it
    if (path === "/lines/about") return json(res, 200, site.linesAbout);
    if (path === "/lines") return json(res, 200, { ...(site.linesAbout as object), items: site.line ? [site.line] : [] });
    if (path.startsWith("/lines/")) return site.line ? json(res, 200, { line: site.line }) : json(res, 404, { error: "no such line" });
    // guarantees: the rules, one agent's guarantee and one job's cover, as the engine answers them
    if (path === "/guarantees/about") return json(res, 200, site.guaranteesAbout);
    if (path === "/guarantees") return json(res, 200, { ...(site.guaranteesAbout as object), agents: site.guarantee ? [site.guarantee] : [], covers: site.cover ? [site.cover] : [] });
    if (path.startsWith("/guarantees/agent/")) return site.guarantee ? json(res, 200, { guarantee: site.guarantee }) : json(res, 404, { error: "no guarantee for that agent" });
    if (path.startsWith("/guarantees/job/")) return site.cover ? json(res, 200, { cover: site.cover }) : json(res, 404, { error: "no such cover" });
    if (path.startsWith("/guarantees/customer/")) return json(res, 200, { items: site.covers });
    // bounties: the rules and the board, one bounty, one entry, an agent's and a poster's, as the engine answers them
    if (path === "/bounties/about") return json(res, 200, site.bountiesAbout);
    if (path === "/bounties") return json(res, 200, { ...(site.bountiesAbout as object), items: site.bounties });
    const bm = /^\/bounties\/(\d+)\/mine\/(0x[0-9a-f]{40})$/.exec(path);
    if (bm) { const e = node.entries.get(`${bm[1]}:${bm[2]}`); return json(res, 200, { entered: !!e, workShown: !!e, ...(e ? { hash: e.hash } : {}) }); }
    if (/^\/bounties\/\d+\/entries\/0x[0-9a-f]{40}$/.test(path)) return site.bountyEntry ? json(res, 200, { entry: site.bountyEntry }) : json(res, 404, { error: "no such entry to read: entries are public once a winner is picked or the bounty ends" });
    if (path.startsWith("/bounties/agent/")) return json(res, 200, { bounties: site.agentBounties });
    if (path.startsWith("/bounties/poster/")) return site.bountyPoster ? json(res, 200, site.bountyPoster) : json(res, 404, { error: "bounties are switched off for now" });
    if (/^\/bounties\/\d+$/.test(path)) return site.bounty ? json(res, 200, site.bounty) : json(res, 404, { error: "no such bounty" });
    // milestones: the rules and the plans, one plan, the plan of a job, as the engine answers them
    if (path === "/milestones/about") return json(res, 200, site.milestonesAbout);
    if (path === "/milestones") return json(res, 200, { ...(site.milestonesAbout as object), items: site.milestones });
    if (/^\/milestones\/(job\/)?\d+$/.test(path)) return site.milestone ? json(res, 200, site.milestone) : json(res, 404, { error: "no such plan" });
    if (path === "/burns") return json(res, 200, { total: site.burns.length, more: false, items: site.burns });
    if (path.startsWith("/pay/links/")) return json(res, 200, { items: site.payLinks });
    if (path === "/coins/about") return json(res, 200, site.coinsAbout);
    if (path.startsWith("/coins/")) return site.coin ? json(res, 200, site.coin) : json(res, 404, { error: "no coin is listed for that" });
    if (path.startsWith("/verified/")) return site.verified ? json(res, 200, site.verified) : json(res, 200, { enabled: false, owners: [], verifiedOwner: null });
    if (path.startsWith("/erc8004/")) return site.erc8004 ? json(res, 200, site.erc8004) : json(res, 404, { error: "no such agent" });
    if (path === "/plans") return json(res, 200, { enabled: true, items: site.plans });
    if (path.startsWith("/autoapply/")) return site.autoApply ? json(res, 200, site.autoApply) : json(res, 404, { error: "no such agent" });
    if (path === "/openjobs") return json(res, 200, { enabled: true, maxApplicants: 20, items: site.openJobs });
    if (/^\/openjobs\/0x[0-9a-f]{64}$/.test(path)) return site.openJob ? json(res, 200, site.openJob) : json(res, 404, { error: "no such open job" });
    if (/^\/plans\/0x[0-9a-f]{64}$/.test(path)) return site.plan ? json(res, 200, site.plan) : json(res, 404, { error: "no such plan" });
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
      // the coin launcher's two reads: Pons' launch fee (0.0005 ETH) and an agent's permission number (0)
      const data = (c as { params?: [{ data?: string; input?: string }] }).params?.[0]?.data ?? (c as { params?: [{ input?: string }] }).params?.[0]?.input ?? "";
      const to = ((c as { params?: [{ to?: string }] }).params?.[0]?.to ?? "").toLowerCase();
      // the made-up bounty contract: its reads, and a refusal for a call the test names
      if (c.method === "eth_call" && to === BOUNTY) {
        const d = decodeFunctionData({ abi: B, data: data as Hex });
        const no = node.refuse[d.functionName];
        if (no) return { jsonrpc: "2.0", id: c.id, error: { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: B, errorName: no.error, args: no.args }) } };
        const a = (d.args ?? []) as readonly unknown[];
        const none: ChainBounty = { poster: `0x${"0".repeat(40)}`, deadline: 0, minScore: 0, state: 0, bondsBack: false, winner: `0x${"0".repeat(40)}`, prize: 0n, fee: 0n, bond: 0n, job: 0n, task: `0x${"0".repeat(64)}` };
        const out = d.functionName === "bounty" ? node.bounties.get(Number(a[0])) ?? none
          : d.functionName === "entryOf" ? node.entries.get(`${Number(a[0])}:${String(a[1]).toLowerCase()}`) ?? { hash: `0x${"0".repeat(64)}`, at: 0 }
          : d.functionName === "entryHash" ? engineEntryHash(BOUNTY, Number(a[0]), String(a[1]), a[2] as Hex)
          : d.functionName === "owed" ? 0n
          : null;
        if (out === null) return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: `the stub bounty contract does not do ${d.functionName}` } };
        return { jsonrpc: "2.0", id: c.id, result: encodeFunctionResult({ abi: B, functionName: d.functionName, result: out } as never) };
      }
      const call = c.method === "eth_call" ? (data.startsWith(LAUNCH_FEE) ? `0x${(5n * 10n ** 14n).toString(16).padStart(64, "0")}` : data.startsWith(NONCES) ? `0x${"0".repeat(64)}` : null) : null;
      const result = c.method === "eth_chainId" ? `0x${node.chainId.toString(16)}` : c.method === "eth_getCode" ? node.code : c.method === "eth_blockNumber" ? "0x10" : c.method === "eth_getBlockByNumber" ? block : call;
      return result === null ? { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: `the stub node does not do ${c.method}` } } : { jsonrpc: "2.0", id: c.id, result };
    };
    json(res, 200, Array.isArray(call) ? call.map(one) : one(call));
  });
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
  const [wp, rp] = await Promise.all([listen(web), listen(rpc)]);
  return { api: `http://127.0.0.1:${wp}`, rpc: `http://127.0.0.1:${rp}`, site, node, posts, close: () => new Promise<void>((r) => { web.close(); rpc.close(); r(); }) };
}
