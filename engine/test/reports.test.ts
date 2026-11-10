// Factor Credit Reports, end to end on the made-up chain (src/reports.ts): the reading (newest first, span by span, a span
// the node finds too big halved, a restart going on where it stopped, each log read once), every agent on the registry
// scored, the API (the totals, the leaderboard, the look-up, one report, the signed answer, the ERC-8004 entry prepared and
// never sent), the owner's claim with its signature, and the switches.

import { encodeAbiParameters, encodeEventTopics, decodeFunctionData, keccak256, parseAbi, toHex, type Abi, type AbiEvent, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { erc8004ReputationAbi, erc8004ValidationAbi } from "../src/abi/index.js";
import { opened, type Sealed } from "../src/everywhere.js";
import { claimMessage, readReports, registrationOf, valueText, PRIORS_POOLS, REPORT_TAG1 } from "../src/reports.js";
import { REPORT_VERSION } from "../src/reportscore.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

// anvil's public test keys: worth nothing anywhere
const ownerKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const otherKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const SIGNING = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const OWNER = ownerKey.address.toLowerCase(), OTHER = otherKey.address.toLowerCase();
const AGENT = "0x00000000000000000000000000000000000a6e01";
const LOOPER = "0x00000000000000000000000000000000000100b1";
const SPONSOR = "0x00000000000000000000000000000000005b0a50";
const VALIDATOR = "0x000000000000000000000000000000000000ba11";
const POOL = "0x00000000000000000000000000000000000b0012";
const cust = (i: number) => `0x0000000000000000000000000000000000c0${String(i).padStart(4, "0")}`;
type Body = Record<string, any>;

const priorsAbi = parseAbi([
  "event Borrowed(uint256 indexed loanId, uint256 indexed agentId, uint256 indexed sponsorId, uint256 principal, uint256 fee, uint64 dueAt, address to)",
  "event Repaid(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint256 fee, address payer)",
  "event Defaulted(uint256 indexed loanId, uint256 indexed agentId, uint256 indexed sponsorId, uint256 principal, uint256 sharesBurnt, address owner)",
]);
const uriAbi = parseAbi(["event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)"]);

/** A log at the chain's current block, from any address, in any event's shape. */
function push(chain: FakeChain, address: string, abi: Abi, eventName: string, args: Record<string, unknown>): void {
  chain.mine();
  const event = abi.find((x) => x.type === "event" && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const rest = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(rest, rest.map((i) => args[i.name!]) as never);
  chain.allLogs.push({ address, topics, data, blockNumber: chain.number, transactionHash: `0x${"ab".repeat(31)}${(chain.allLogs.length % 256).toString(16).padStart(2, "0")}`, logIndex: 0 });
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

/** The world: a desk agent with an identity and paid work, a looper on Priors, a defaulter, and feedback of every kind. */
function world(): { chain: FakeChain; ids: { agent: number; looper: number; defaulter: number; blank: number } } {
  const chain = new FakeChain();
  chain.fund(ETH);
  chain.register(AGENT);
  const agent = chain.identity(OWNER, AGENT);
  push(chain, A.identity, uriAbi as Abi, "URIUpdated", { agentId: BigInt(agent), newURI: `data:application/json;base64,${Buffer.from(JSON.stringify({ name: "ledger-bot", description: "Reads ledgers." })).toString("base64")}`, updatedBy: OWNER });
  for (let i = 1; i <= 3; i++) {
    const id = chain.lock(cust(i), AGENT, ETH / 20n);
    chain.deliver(id);
    chain.accept(id);
  }
  // its own owner paying it: not counted
  const self = chain.lock(OWNER, AGENT, ETH / 20n);
  chain.deliver(self);
  chain.accept(self);
  const looper = chain.identity(LOOPER, LOOPER);
  const defaulter = chain.identity(OTHER, OTHER);
  const blank = chain.identity(cust(99), null);
  // the looper: forty $7 loans, each returned within the hour to the same wallet
  for (let n = 1; n <= 40; n++) {
    push(chain, POOL, priorsAbi as Abi, "Borrowed", { loanId: BigInt(n), agentId: BigInt(looper), sponsorId: 1n, principal: 7_000_000n, fee: 1000n, dueAt: BigInt(chain.time + 30 * 86400), to: LOOPER });
    chain.mine(1, 1200);
    push(chain, POOL, priorsAbi as Abi, "Repaid", { loanId: BigInt(n), agentId: BigInt(looper), principal: 7_000_000n, fee: 1000n, payer: LOOPER });
  }
  push(chain, POOL, priorsAbi as Abi, "Borrowed", { loanId: 41n, agentId: BigInt(defaulter), sponsorId: 1n, principal: 20_000_000n, fee: 1000n, dueAt: BigInt(chain.time + 86400), to: OTHER });
  chain.mine(1, 3 * 86400);
  push(chain, POOL, priorsAbi as Abi, "Defaulted", { loanId: 41n, agentId: BigInt(defaulter), sponsorId: 1n, principal: 20_000_000n, sharesBurnt: 5n, owner: OTHER });
  // feedback: a paying customer, the owner itself, a stranger, and one revoked
  const fb = (client: string, value: bigint, index: bigint) => chain.emit("reputation", "NewFeedback", { agentId: BigInt(agent), clientAddress: client, feedbackIndex: index, value, valueDecimals: 0, indexedTag1: "quality", tag1: "quality", tag2: "", endpoint: "", feedbackURI: "", feedbackHash: `0x${"00".repeat(32)}` });
  chain.mine();
  fb(cust(1), 95n, 1n);
  fb(OWNER, 100n, 1n);
  fb(cust(50), 100n, 1n);
  fb(cust(2), 90n, 1n);
  chain.mine();
  chain.emit("reputation", "FeedbackRevoked", { agentId: BigInt(agent), clientAddress: cust(2), feedbackIndex: 1n });
  // a validator passed its work
  push(chain, VALIDATION, erc8004ValidationAbi as Abi, "ValidationRequest", { validatorAddress: VALIDATOR, agentId: BigInt(agent), requestURI: "", requestHash: `0x${"11".repeat(32)}` });
  push(chain, VALIDATION, erc8004ValidationAbi as Abi, "ValidationResponse", { validatorAddress: VALIDATOR, agentId: BigInt(agent), requestHash: `0x${"11".repeat(32)}`, response: 100, responseURI: "", responseHash: `0x${"00".repeat(32)}`, tag: "" });
  chain.mine(5, 60);
  return { chain, ids: { agent, looper, defaulter, blank } };
}
const VALIDATION = "0x8004cc8439f36fd5f9f049d9ff86523df6daab58";

async function reading(chain: FakeChain, more: Record<string, string> = {}, sqlite?: Rig["sqlite"]): Promise<Rig> {
  const r = await rig("watch", { chain, sqlite, copilotModel: null, more: { REPORTS: "on", REPORTS_FROM_BLOCK: "0", REPORTS_SPAN: "25", REPORTS_PER_PASS: "4", REPORTS_CONFIRMATIONS: "0", REPORTS_PRIORS_POOLS: `2:${POOL}@0`, EVERYWHERE_SIGNING_KEY: SIGNING, ...more } });
  rigs.push(r);
  await r.engine.watchOnce();
  return r;
}

async function catchUp(r: Rig): Promise<number> {
  let passes = 0;
  while (!r.engine.reports!.caughtUp() && passes < 200) { await r.engine.reports!.pass(); passes++; }
  r.engine.reports!.scoreAll();
  return passes;
}

const get = async (r: Rig, path: string): Promise<Body> => { const [p, q = ""] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q), "1.2.3.4"))!; return { status: a.status, ...(a.body as Body) }; };
const post = async (r: Rig, path: string, body: unknown): Promise<Body> => { const a = (await r.engine.post(path, body, "1.2.3.4"))!; return { status: a.status, ...(a.body as Body) }; };

describe("the configuration", () => {
  it("is off unless REPORTS=on, reads Priors' two pools from where each began, and refuses what makes no sense", () => {
    expect(readReports({})).toMatchObject({ enabled: false, priors: true, span: 100_000, perPass: 40, fromBlock: 12_000_000, confirmations: 20 });
    expect(PRIORS_POOLS.map((p) => p.from)).toEqual([68_593_823, 71_702_460]);
    const problems: string[] = [];
    readReports({ REPORTS: "yes", REPORTS_SPAN: "5", REPORTS_PRIORS_POOLS: "3:0x1@1" }, problems);
    expect(problems).toHaveLength(3);
    expect(readReports({ REPORTS: "on", REPORTS_PRIORS: "off" })).toMatchObject({ enabled: true, priors: false });
  });

  it("reads an agent's name only from a registration file on the chain itself, never fetched", () => {
    expect(registrationOf(`data:application/json;base64,${Buffer.from('{"name":"a\\u0000<b>","description":"x"}').toString("base64")}`)).toEqual({ name: "a b", about: "x" });
    expect(registrationOf(`data:application/json;utf8,${encodeURIComponent('{"name":"plain"}')}`).name).toBe("plain");
    expect(registrationOf("https://example.com/agent.json")).toEqual({ name: null, about: null });
    expect(valueText("-41508408690693198", 18)).toBe("-0.0415");
    expect(valueText("95", 0)).toBe("95");
  });
});

describe("the reading", () => {
  it("reads newest first, then follows the head, each log once, and goes on after a restart where it stopped", async () => {
    const { chain, ids } = world();
    const head = Number(chain.number);
    const r = await reading(chain, { REPORTS_PER_PASS: "2" });
    await r.engine.reports!.pass();
    const c = r.db.getJson<{ down: number; up: number; top: number }>("reports:cursor:8004")!;
    expect(c.top).toBe(head);
    expect(c.down).toBeLessThan(head);
    expect(c.down).toBeGreaterThan(head - 30); // only the newest span so far
    await r.engine.stop();
    // a new engine on the same database goes on from the cursor
    const again = await reading(chain, {}, r.sqlite);
    await catchUp(again);
    expect(again.db.count("report_feedback")).toBe(4);
    expect(again.db.count("report_revoked")).toBe(1);
    expect((again.db.q("SELECT COUNT(*) AS n FROM report_loans WHERE agent_id = ?").get(ids.looper) as { n: number }).n).toBe(40);
    // what the chain adds afterwards is followed
    push(chain, POOL, priorsAbi as Abi, "Borrowed", { loanId: 99n, agentId: BigInt(ids.blank), sponsorId: 1n, principal: 30_000_000n, fee: 1000n, dueAt: BigInt(chain.time + 86400), to: cust(99) });
    chain.mine(3);
    await again.engine.reports!.pass();
    expect((again.db.q("SELECT COUNT(*) AS n FROM report_loans WHERE loan_id = 99").get() as { n: number }).n).toBe(1);
  });

  it("halves a span the node finds too big and still reads every log once", async () => {
    const { chain } = world();
    chain.tooManyAbove = 6n;
    const r = await reading(chain);
    await catchUp(r);
    expect(r.db.count("report_feedback")).toBe(4);
    expect((r.db.q("SELECT COUNT(*) AS n FROM report_loans").get() as { n: number }).n).toBe(41);
    expect(chain.calls.filter((c) => c.kind === "logs").length).toBeGreaterThan(10);
  });

  it("reads each identity's owner and agentWallet at the head, and times each event from its span's ends", async () => {
    const { chain, ids } = world();
    const r = await reading(chain);
    await catchUp(r);
    await r.engine.reports!.pass();
    const row = r.db.q("SELECT * FROM report_identities WHERE agent_id = ?").get(ids.agent) as Body;
    expect(row).toMatchObject({ owner: OWNER, wallet: AGENT, maker: OWNER, name: "ledger-bot", about: "Reads ledgers." });
    const l = r.db.q("SELECT borrowed_at, repaid_at FROM report_loans WHERE agent_id = ? AND loan_id = 1").get(ids.looper) as { borrowed_at: number; repaid_at: number };
    // placed between the two ends of its span, by block: never before it was borrowed, never after the head
    expect(l.repaid_at).toBeGreaterThan(l.borrowed_at);
    expect(l.repaid_at).toBeLessThanOrEqual(chain.time);
    const ends = r.db.q("SELECT MIN(at) AS a, MAX(at) AS b FROM report_times").get() as { a: number; b: number };
    expect(l.borrowed_at).toBeGreaterThanOrEqual(ends.a);
  });
});

describe("the reports", () => {
  it("scores every identity on the registry and the desk agent behind one, and ranks them", async () => {
    const { chain, ids } = world();
    const r = await reading(chain);
    await catchUp(r);
    const about = await get(r, "/v1/reports");
    expect(about).toMatchObject({ enabled: true, version: REPORT_VERSION, identities: 4, found: 4, caughtUp: true });
    expect(about.spread.reduce((a: number, b: Body) => a + b.n, 0)).toBe(4);
    const top = await get(r, "/v1/reports/top");
    expect(top.items[0]).toMatchObject({ agentId: String(ids.agent), name: "ledger-bot", rank: 1 });
    expect(top.items.find((x: Body) => x.agentId === String(ids.defaulter))).toBeUndefined();
    expect(top.items.every((x: Body) => x.score > 0)).toBe(true);
  });

  it("gives one agent's whole report: parts, flags, sources, timeline, the entries on ERC-8004 and why each counts or not", async () => {
    const { chain, ids } = world();
    const r = await reading(chain);
    await catchUp(r);
    const rep = await get(r, `/v1/reports/agent/${ids.agent}`);
    expect(rep).toMatchObject({ status: 200, version: REPORT_VERSION, agent: { agentId: String(ids.agent), name: "ledger-bot", nameFrom: "chain", owner: OWNER, agentWallet: AGENT, desk: [AGENT] } });
    expect(rep.counts).toMatchObject({ deskJobsPaid: 3, deskCustomers: 3, payingClients: 1, validations: 1 });
    expect(rep.flags.map((f: Body) => f.key)).toEqual(expect.arrayContaining(["own-jobs", "own-feedback", "unpaid-feedback"]));
    expect(rep.sources.map((s: Body) => s.source)).toEqual(expect.arrayContaining(["factor-desk", "erc8004-reputation", "erc8004-validation"]));
    const why = Object.fromEntries(rep.erc8004.map((e: Body) => [e.client, e]));
    expect(why[cust(1)]).toMatchObject({ counted: true });
    expect(why[OWNER].counted).toBe(false);
    expect(why[cust(50)].why).toMatch(/never paid/);
    expect(why[cust(2)].why).toMatch(/revoked/);
    expect(rep.timeline.length).toBeGreaterThan(3);
    expect(rep.links.page).toMatch(new RegExp(`/reports/${ids.agent}$`));
    // the same report by its wallet, its owner, and its name
    for (const id of [AGENT, OWNER, "ledger-bot", `%23${ids.agent}`]) expect((await get(r, `/v1/reports/agent/${id}`)).agent.agentId).toBe(String(ids.agent));
    expect((await get(r, "/v1/reports/agent/424242")).status).toBe(404);
  });

  it("finds an agent by number, wallet or part of its name", async () => {
    const { chain, ids } = world();
    const r = await reading(chain);
    await catchUp(r);
    expect((await get(r, `/v1/reports/find?q=${ids.looper}`)).items[0].agentId).toBe(String(ids.looper));
    expect((await get(r, `/v1/reports/find?q=${AGENT}`)).items[0].agentId).toBe(String(ids.agent));
    expect((await get(r, "/v1/reports/find?q=ledger")).items[0].name).toBe("ledger-bot");
    expect((await get(r, "/v1/reports/find?q=nobody-here")).items).toEqual([]);
  });

  it("shows the looper's tricks and the defaulter's default, each in plain words with its effect", async () => {
    const { chain, ids } = world();
    const r = await reading(chain);
    await catchUp(r);
    const looper = await get(r, `/v1/reports/agent/${ids.looper}`);
    // each loan was returned 20 minutes after it was taken; times are placed between a span's two ends, so a few may read longer
    expect(looper.flags.find((f: Body) => f.key === "quick-loans").count).toBeGreaterThanOrEqual(30);
    expect(looper.flags.find((f: Body) => f.key === "loop-loans")).toBeTruthy();
    expect(looper.parts.find((p: Body) => p.key === "repayment").points).toBeLessThan(40);
    expect(looper.parts.find((p: Body) => p.key === "reliability").points).toBe(0);
    const bad = await get(r, `/v1/reports/agent/${ids.defaulter}`);
    expect(bad).toMatchObject({ score: 0, rank: null });
    expect(bad.pulls[0]).toMatchObject({ key: "default", points: -300 });
  });

  it("signs a short answer any app can check, good for ten minutes", async () => {
    const { chain, ids } = world();
    const r = await reading(chain);
    await catchUp(r);
    const s = (await get(r, `/v1/reports/signed/${ids.agent}`)) as unknown as Sealed & { status: number };
    expect(s.status).toBe(200);
    const signer = privateKeyToAccount(SIGNING).address.toLowerCase();
    expect(s.signer).toBe(signer);
    const o = await opened<Body>(s, signer, chain.time);
    expect(o.ok).toBe(true);
    if (o.ok) expect(o.data).toMatchObject({ kind: "factor.report", version: REPORT_VERSION, agent: { agentId: String(ids.agent) }, expiresAt: expect.any(Number) });
    expect((await opened(s, OTHER, chain.time)).ok).toBe(false);
  });

  it("prepares the ERC-8004 entry a score would be, and sends nothing", async () => {
    const { chain, ids } = world();
    const r = await reading(chain);
    await catchUp(r);
    const before = chain.calls.filter((c) => c.kind === "send").length;
    const p = await get(r, `/v1/reports/erc8004/${ids.agent}`);
    expect(p).toMatchObject({ prepared: true, sent: false, to: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" });
    expect(p.hash).toBe(keccak256(toHex(p.body)));
    const call = decodeFunctionData({ abi: erc8004ReputationAbi, data: p.data });
    expect(call.functionName).toBe("giveFeedback");
    expect(call.args[3]).toBe(REPORT_TAG1);
    expect(chain.calls.filter((c) => c.kind === "send").length).toBe(before);
    expect(chain.sends("giveFeedback")).toHaveLength(0);
  });
});

describe("Factor's own, and one operator on both sides", () => {
  it("ranks an agent run from one of Factor's own wallets apart, and does not count jobs between Factor's own wallets", async () => {
    const { chain, ids } = world();
    const r = await reading(chain, { REPORTS_FACTOR_WALLETS: `${AGENT},${cust(1)}` });
    await catchUp(r);
    const rep = await get(r, `/v1/reports/agent/${ids.agent}`);
    expect(rep.agent.factorOwn).toBe(true);
    expect(rep.rank).toBeNull();
    expect(rep.flags.find((f: Body) => f.key === "factor-own").words).toMatch(/test agent Factor keeps the keys of/);
    expect(rep.counts.deskJobsPaid).toBe(2); // cust(1)'s job is Factor paying Factor; the owner's own job never counted
    expect((await get(r, "/v1/reports/top")).items.some((x: Body) => x.agentId === String(ids.agent))).toBe(false);
    expect((await get(r, "/v1/reports/top?own=1")).items.some((x: Body) => x.agentId === String(ids.agent))).toBe(true);
    // a Factor wallet hiring someone else's agent is not a paying client either
    const other = await reading(chain, { REPORTS_FACTOR_WALLETS: cust(2) });
    await catchUp(other);
    const o = await get(other, `/v1/reports/agent/${ids.agent}`);
    expect(o.agent.factorOwn).toBe(false);
    expect(o.counts.deskJobsPaid).toBe(2);
    expect(o.timeline.find((t: Body) => t.kind === "paid" && t.why?.includes("Factor's own test wallets"))).toBeTruthy();
    // the demo wallet and report-lead the repo names are Factor's own without being told
    expect(readReports({}).factorWallets).toEqual(expect.arrayContaining(["0x50a9bf50c3337d5db03efdf89deb0f5a0b908f17", "0x74325c9644973d9c7a293bdfc970a573a38419e1", "0x3b6a28461a953647af240a6bed96eb42b046b170"]));
    // anvil's public test key is never one of Factor's: anyone can sign with it
    expect(readReports({}).factorWallets).not.toContain("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });

  it("does not count a job from a wallet the agent's own wallet registered an identity for, or from a wallet that funds its loans", async () => {
    const { chain, ids } = world();
    // an identity registered by the agent's own wallet, whose agentWallet then hires the agent: one operator on both sides
    chain.identity(AGENT, cust(7));
    const a = chain.lock(cust(7), AGENT, ETH / 20n);
    chain.deliver(a);
    chain.accept(a);
    // a wallet its loans were paid to, hiring it
    push(chain, POOL, priorsAbi as Abi, "Borrowed", { loanId: 500n, agentId: BigInt(ids.agent), sponsorId: 1n, principal: 20_000_000n, fee: 1000n, dueAt: BigInt(chain.time + 30 * 86400), to: cust(8) });
    const b = chain.lock(cust(8), AGENT, ETH / 20n);
    chain.deliver(b);
    chain.accept(b);
    chain.mine(3, 60);
    const r = await reading(chain);
    await catchUp(r);
    await r.engine.watchOnce();
    await r.engine.reports!.pass();
    const rep = await get(r, `/v1/reports/agent/${ids.agent}`);
    expect(rep.counts.deskJobsPaid).toBe(3);
    expect(rep.flags.find((f: Body) => f.key === "own-jobs")).toMatchObject({ count: 3 });
    const why = rep.timeline.filter((t: Body) => t.kind === "paid" && !t.counted).map((t: Body) => t.why);
    expect(why).toEqual(expect.arrayContaining([expect.stringMatching(/an identity this agent's own wallet registered/), expect.stringMatching(/took or repaid its loans/), expect.stringMatching(/its owner/)]));
  });
});

describe("the assistants", () => {
  it("Copilot answers a credit report question about any agent on the chain, from the report, with its link", async () => {
    const { chain, ids } = world();
    const r = await reading(chain, { COPILOT: "on" });
    await catchUp(r);
    const a = await post(r, "/v1/copilot", { text: `what is the credit report of agent #${ids.agent}?` });
    expect(a.status).toBe(200);
    expect(a.intent).toBe("report");
    expect(a.reply.text).toMatch(/of 1000 on its Factor credit report/);
    expect(a.reply.facts[0]).toMatch(/^Score: \d+ of 1000/);
    expect(a.reply.source).toMatchObject({ name: "Factor Credit Reports", url: expect.stringMatching(new RegExp(`/reports/${ids.agent}$`)) });
    const q = await post(r, "/v1/copilot", { text: "show me a credit report" });
    expect(q.reply.kind).toBe("question");
    const b = await post(r, "/v1/copilot", { text: String(ids.looper), conversation: q.conversation });
    expect(b.reply.text).toMatch(/many small loans in a loop|borrowed and returned unused/);
    const none = await post(r, "/v1/copilot", { text: "credit score of agent #999999" });
    expect(none.reply.text).toMatch(/found no agent/);
  });
});

describe("claiming a report", () => {
  const sign = async (key: typeof ownerKey, o: { subject: string; name?: string | null; about?: string | null; site?: string | null; x?: string | null; at: number }) => {
    const m = { subject: o.subject, by: key.address.toLowerCase(), name: o.name ?? null, about: o.about ?? null, site: o.site ?? null, x: o.x ?? null, at: o.at };
    return { agent: o.subject.replace("8004:", ""), by: m.by, name: m.name, about: m.about, site: m.site, x: m.x, at: m.at, signature: await key.signMessage({ message: claimMessage(m) }) };
  };

  it("takes the owner's signed profile, and shows it as the owner's words", async () => {
    const { chain, ids } = world();
    const r = await reading(chain);
    await catchUp(r);
    const subject = `8004:${ids.agent}`;
    const ok = await post(r, "/v1/reports/claim", await sign(ownerKey, { subject, name: "Ledger Bot", about: "Reads ledgers for small firms.", site: "https://ledger.example", x: "ledgerbot", at: chain.time }));
    expect(ok).toMatchObject({ status: 200, ok: true });
    const rep = await get(r, `/v1/reports/agent/${ids.agent}`);
    expect(rep.agent).toMatchObject({ name: "Ledger Bot", nameFrom: "claim", about: "Reads ledgers for small firms." });
    expect(rep.claim).toMatchObject({ by: OWNER, site: "https://ledger.example", x: "ledgerbot" });
    expect((await get(r, "/v1/reports/find?q=Ledger Bot")).items[0].agentId).toBe(String(ids.agent));
  });

  it("refuses anyone but the identity's owner or agentWallet, a stale or forged signature, and bad words", async () => {
    const { chain, ids } = world();
    const r = await reading(chain);
    await catchUp(r);
    const subject = `8004:${ids.agent}`;
    expect(await post(r, "/v1/reports/claim", await sign(otherKey, { subject, name: "Mine now", at: chain.time }))).toMatchObject({ status: 403 });
    expect(await post(r, "/v1/reports/claim", await sign(ownerKey, { subject, name: "Old", at: chain.time - 3600 }))).toMatchObject({ status: 400 });
    const forged = await sign(otherKey, { subject, name: "Forged", at: chain.time });
    expect(await post(r, "/v1/reports/claim", { ...forged, by: OWNER })).toMatchObject({ status: 401 });
    expect(await post(r, "/v1/reports/claim", await sign(ownerKey, { subject, name: "<script>", at: chain.time }))).toMatchObject({ status: 400 });
    expect(await post(r, "/v1/reports/claim", await sign(ownerKey, { subject, site: "http://plain.example", at: chain.time }))).toMatchObject({ status: 400 });
    expect(await post(r, "/v1/reports/claim", { ...(await sign(ownerKey, { subject, at: chain.time })), agent: "999999" })).toMatchObject({ status: 404 });
  });
});

describe("the switches", () => {
  it("says nothing and reads nothing with REPORTS off, and the owner's switch hides it all at once", async () => {
    const { chain, ids } = world();
    const off = await reading(chain, { REPORTS: "off" });
    expect(await get(off, "/v1/reports")).toMatchObject({ enabled: false });
    expect(await off.engine.reports!.pass()).toBe("reports are off");
    expect((await get(off, "/v1/reports/formula")).version).toBe(REPORT_VERSION);
    const r = await reading(chain);
    await catchUp(r);
    turn(r.db, "reports", false, "a check");
    expect(await get(r, `/v1/reports/agent/${ids.agent}`)).toMatchObject({ enabled: false });
    expect(await post(r, "/v1/reports/claim", {})).toMatchObject({ status: 503 });
    turn(r.db, "reports", true);
    expect((await get(r, `/v1/reports/agent/${ids.agent}`)).status).toBe(200);
  });

  it("lets the owner hide a name read from the chain", async () => {
    const { chain, ids } = world();
    const r = await reading(chain, { ENGINE_ADMIN_KEY: "an-admin-key-of-24-chars-at-least" });
    await catchUp(r);
    const a = (await r.engine.post("/v1/admin/hide", { what: "report-name", key: String(ids.agent) }, "1.2.3.4", "an-admin-key-of-24-chars-at-least"))!;
    expect(a.status).toBe(200);
    const rep = await get(r, `/v1/reports/agent/${ids.agent}`);
    expect(rep.agent.name).not.toBe("ledger-bot");
  });
});
