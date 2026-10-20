// ERC-8004, on the made-up chain with the registries modelled as the deployed 2.0.0 keeps them: an agent on the desk
// is found in the identity registry and linked, or signs which identity is its own; every job of a linked agent that
// settles is written to its reputation once (100 paid in full, 50 at half, tags "factor" and how the job came, a file
// whose keccak256 is the hash on the chain); the past jobs only with the backfill; and the guards: the identity must
// still be the agent's, the registry's own count is checked against Factor's notes, the day's gas, the owner's switch,
// a job the registry refuses for good is set aside, demonstrations and jobs an agent locked for itself are not written.

import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { feedbackFile, linkMessage, readErc8004, registryOf, IDENTITY_REGISTRY, REPUTATION_REGISTRY, TAG1, VALUE } from "../src/erc8004.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

// anvil's public test keys: worth nothing anywhere
const agentKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const otherKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const AGENT = agentKey.address.toLowerCase(), OTHER = otherKey.address.toLowerCase();
const BUYER = "0x00000000000000000000000000000000000b0e01";
const PRICE = ETH / 100n;
const REGISTRY = registryOf(4663, IDENTITY_REGISTRY);
type Body = Record<string, any>;

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

async function desk(more: Record<string, string> = {}, chain = new FakeChain()): Promise<Rig> {
  chain.fund(ETH);
  for (const a of [AGENT, OTHER]) if (!chain.agents.has(a)) chain.register(a);
  const r = await rig("live", { chain, more: { ERC8004: "on", ...more } });
  rigs.push(r);
  await r.engine.watchOnce();
  return r;
}

const get = async (r: Rig, path: string): Promise<Body> => { const a = (await r.engine.handle(path))!; return { status: a.status, ...(a.body as Body) }; };
const post = async (r: Rig, path: string, body: unknown): Promise<Body> => { const a = (await r.engine.post(path, body, "1.2.3.4"))!; return { status: a.status, ...(a.body as Body) }; };

/** A job locked for the agent, delivered, and accepted (or rejected: settled at half). */
async function settle(r: Rig, o: { agent?: string; customer?: string; half?: boolean } = {}): Promise<number> {
  const id = r.chain.lock(o.customer ?? BUYER, o.agent ?? AGENT, PRICE);
  r.chain.deliver(id);
  if (o.half) r.chain.reject(id);
  else r.chain.accept(id);
  await r.engine.watchOnce();
  return id;
}

const sends = (r: Rig) => r.chain.sends("giveFeedback");

describe("the switches and the words", () => {
  it("is off unless ERC8004=on, the backfill too, and points at the standard's registries on Robinhood Chain", () => {
    expect(readErc8004({})).toMatchObject({ enabled: false, backfill: false, identity: IDENTITY_REGISTRY, reputation: REPUTATION_REGISTRY, gasDayWei: 2_000_000_000_000_000n, perPass: 5, site: "https://factoragents.fun" });
    expect(readErc8004({ ERC8004: "on", ERC8004_BACKFILL: "on" })).toMatchObject({ enabled: true, backfill: true });
    const problems: string[] = [];
    readErc8004({ ERC8004: "yes", ERC8004_GAS_DAY_WEI: "0.1", ERC8004_PER_PASS: "0" }, problems);
    expect(problems).toHaveLength(3);
    expect(REGISTRY).toBe("eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
  });

  it("an agent signs plain words, the same to the letter in the kit and on the site", () => {
    expect(linkMessage({ agent: AGENT, agentId: "42", registry: REGISTRY, at: 1_760_000_000 })).toBe(`Factor: link an ERC-8004 identity\nagent: ${AGENT}\nagentId: 42\nregistry: ${REGISTRY}\nat: 1760000000`);
    expect(linkMessage({ agent: AGENT, agentId: null, registry: REGISTRY, at: 1 })).toContain("agentId: none");
  });

  it("the file an entry points at: the standard's fields, Factor's own beside them, fixed, and its hash is keccak256 of its words", () => {
    const job = { id: 7, dirty: 0, locked_block: 1, locked_at: 100, locked_tx: `0x${"1".repeat(64)}`, customer: BUYER, agent: AGENT, price: "10000000000000000", due_at: 500, allow_early: 0, state: 4, early: "0", from_pool: "0", delivered_at: 200, late: 0, proof: "0x", closed_at: 300, paid: "0", back: "0", fee: "0", not_repaid: "0" };
    const a = feedbackFile({ chainId: 4663, identity: IDENTITY_REGISTRY, agentId: "42", writer: A.bot, desk: A.desk, site: "https://factoragents.fun", job, settledTx: `0x${"2".repeat(64)}`, tag2: "job" });
    expect(a.file).toMatchObject({ agentRegistry: REGISTRY, agentId: 42, value: 100, valueDecimals: 0, tag1: "factor", tag2: "job", createdAt: "1970-01-01T00:05:00.000Z", factor: { job: 7, outcome: "paid in full", page: "https://factoragents.fun/jobs/7", priceWei: "10000000000000000", onTime: true } });
    expect(a.file.clientAddress).toMatch(/^eip155:4663:0x[0-9a-fA-F]{40}$/);
    expect(a.file.proofOfPayment).toMatchObject({ chainId: "4663", txHash: job.locked_tx });
    expect(a.hash).toBe(keccak256(toHex(a.body)));
    // what the engine serves is the parsed file written out again: the very same words
    expect(JSON.stringify(JSON.parse(a.body))).toBe(a.body);
    expect(feedbackFile({ chainId: 4663, identity: IDENTITY_REGISTRY, agentId: "42", writer: A.bot, desk: A.desk, site: "https://factoragents.fun", job, settledTx: null, tag2: "job" }).body).not.toBe(a.body);
    const half = feedbackFile({ chainId: 4663, identity: IDENTITY_REGISTRY, agentId: "42", writer: A.bot, desk: A.desk, site: "https://factoragents.fun", job: { ...job, state: 5, late: 1 }, settledTx: null, tag2: "monthly" });
    expect(half.value).toBe(VALUE.half);
    expect(half.file.factor).toMatchObject({ outcome: "settled at half", onTime: false, income: "monthly" });
  });
});

describe("linking", () => {
  it("finds the agent in the identity registry by its agentWallet and links it; nothing is written while ERC8004 is off", async () => {
    const chain = new FakeChain();
    for (let i = 0; i < 3; i++) chain.identity(`0x${String(i + 1).padStart(40, "9")}`);
    const off = await desk({ ERC8004: "" }, chain);
    const id = chain.identity(AGENT);
    await settle(off);
    await off.turn();
    expect(sends(off)).toHaveLength(0);
    expect((await get(off, `/v1/agents/${AGENT}`)).erc8004).toBeUndefined();
    expect(chain.calls.some((c) => c.what === "aggregate3")).toBe(false);
    await off.engine.stop();

    const r = await desk({}, chain);
    await r.turn();
    const page = await get(r, `/v1/erc8004/${AGENT}`);
    expect(page.erc8004).toMatchObject({ agentId: String(id), linked: "found", via: "wallet", lost: null, registry: REGISTRY });
    expect(page.erc8004.reviewer.toLowerCase()).toBe(A.bot);
  });

  it("several identities: none is picked, and the agent signs which one; only its own, and a newer signature wins", async () => {
    const r = await desk();
    const first = r.chain.identity(AGENT);
    const second = r.chain.identity(AGENT);
    const stranger = r.chain.identity(OTHER);
    await r.turn();
    let page = await get(r, `/v1/erc8004/${AGENT}`);
    expect(page.erc8004).toBeNull();
    expect(page.found.map((f: Body) => f.agentId)).toEqual([String(first), String(second)]);

    const sign = async (agentId: string | null, at = r.chain.time, key = agentKey) => ({ agent: AGENT, agentId, at, signature: await key.signMessage({ message: linkMessage({ agent: AGENT, agentId, registry: REGISTRY, at }) }) });
    expect((await post(r, "/v1/erc8004/link", await sign(String(stranger)))).status).toBe(403);
    expect((await post(r, "/v1/erc8004/link", await sign("999"))).status).toBe(404);
    expect((await post(r, "/v1/erc8004/link", await sign(String(second), r.chain.time, otherKey))).status).toBe(401);
    expect((await post(r, "/v1/erc8004/link", await sign(String(second), r.chain.time - 3600))).status).toBe(400);
    const ok = await post(r, "/v1/erc8004/link", await sign(String(second)));
    expect(ok).toMatchObject({ status: 200, agentId: String(second), via: "wallet" });
    expect((await post(r, "/v1/erc8004/link", await sign(String(first), r.chain.time - 5))).status).toBe(409);
    page = await get(r, `/v1/erc8004/${AGENT}`);
    expect(page.erc8004).toMatchObject({ agentId: String(second), linked: "signed" });
    // "none": the agent wants nothing linked, and the registry is not asked to link it again
    expect((await post(r, "/v1/erc8004/link", await sign(null, r.chain.time + 1))).status).toBe(200);
    await r.turn();
    expect((await get(r, `/v1/erc8004/${AGENT}`))).toMatchObject({ erc8004: null, none: true });
  });

  it("an agent that joins the desk with an identity made before is found soon after, not a day later", async () => {
    const r = await desk();
    r.chain.identity(OTHER);
    await r.turn(); // the whole registry read: OTHER is found and linked
    const lateKey = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
    const LATE = lateKey.address.toLowerCase();
    const id = r.chain.identity(LATE);
    r.chain.mine(1, 400);
    await r.turn(); // the new identities: LATE is not on the desk yet
    expect((await get(r, `/v1/erc8004/${OTHER}`)).erc8004).not.toBeNull();
    r.chain.register(LATE);
    r.chain.mine(1, 700);
    await r.turn();
    await r.turn();
    expect((await get(r, `/v1/erc8004/${LATE}`)).erc8004).toMatchObject({ agentId: String(id), linked: "found" });
  });

  it("refuses an identity the gas wallet owns: the registry would refuse every entry for it", async () => {
    const r = await desk();
    const id = r.chain.identity(A.bot, AGENT);
    await r.turn();
    // found by its agentWallet, and linked: the writes are what the registry refuses (below)
    expect((await get(r, `/v1/erc8004/${AGENT}`)).erc8004.agentId).toBe(String(id));
    const at = r.chain.time + 1;
    const signature = await agentKey.signMessage({ message: linkMessage({ agent: AGENT, agentId: String(id), registry: REGISTRY, at }) });
    expect((await post(r, "/v1/erc8004/link", { agent: AGENT, agentId: String(id), at, signature }))).toMatchObject({ status: 409 });
  });
});

describe("writing", () => {
  it("writes each settled job once: the value, the tags, the file's address and hash; read back from the chain and the API", async () => {
    const r = await desk();
    const id = r.chain.identity(AGENT);
    await r.turn(); // found and linked
    const paid = await settle(r);
    const half = await settle(r, { half: true });
    await r.turn();
    expect(sends(r)).toHaveLength(2);
    const onChain = r.chain.entriesOf(id, A.bot);
    expect(onChain.map((e) => [e.value, e.decimals, e.tag1, e.tag2])).toEqual([[100n, 0, TAG1, "job"], [50n, 0, TAG1, "job"]]);
    expect(onChain[0]!.uri).toBe(`https://factoragents.fun/api/v1/erc8004/feedback/${paid}`);
    // the file, served word for word: its hash is the one on the chain
    const file = await get(r, `/v1/erc8004/feedback/${paid}`);
    const { status: _s, ...words } = file;
    expect(keccak256(toHex(JSON.stringify(words)))).toBe(onChain[0]!.hash);
    expect(words).toMatchObject({ agentId: id, value: 100, tag1: "factor", factor: { job: paid, outcome: "paid in full" } });
    expect((await get(r, `/v1/erc8004/feedback/${half}`)).factor.outcome).toBe("settled at half");
    // more passes, and a restart on the same file: nothing is written twice
    await r.turn();
    await r.turn();
    expect(sends(r)).toHaveLength(2);
    const again = await rig("live", { chain: r.chain, sqlite: r.sqlite, more: { ERC8004: "on" } });
    rigs.push(again);
    await again.turn();
    await again.turn();
    expect(sends(r)).toHaveLength(2);
    // what the agent's page, the record and /v1/erc8004 say
    const agent = await get(r, `/v1/agents/${AGENT}`);
    expect(agent.erc8004).toMatchObject({ agentId: String(id), entries: 2, waiting: 0, average: 75 });
    expect(agent.erc8004.items.map((x: Body) => [x.job, x.value, x.index, x.mined])).toEqual([[half, 50, 2, true], [paid, 100, 1, true]]);
    expect((await get(r, `/v1/record/${AGENT}`)).erc8004).toMatchObject({ agentId: String(id), entries: 2 });
    expect(await get(r, "/v1/erc8004")).toMatchObject({ enabled: true, entries: 2, linked: 1, tag1: "factor", values: { paidInFull: 100, settledAtHalf: 50 } });
  });

  it("only the jobs settled since the link, unless the backfill is on: then the past ones once, marked as such", async () => {
    const r = await desk();
    const before = await settle(r);
    r.chain.identity(AGENT);
    r.chain.mine(1, 60);
    await r.turn();
    const after = await settle(r);
    await r.turn();
    expect(sends(r).map((s) => (s.tx.call!.args![6] as string).split("/").pop())).toEqual([String(after)]);
    await r.engine.stop();
    const b = await rig("live", { chain: r.chain, sqlite: r.sqlite, more: { ERC8004: "on", ERC8004_BACKFILL: "on" } });
    rigs.push(b);
    await b.turn();
    await b.turn();
    expect(sends(r).map((s) => (s.tx.call!.args![6] as string).split("/").pop())).toEqual([String(after), String(before)]);
    const items = (await get(b, `/v1/agents/${AGENT}`)).erc8004.items as Body[];
    expect(items.find((x) => x.job === before)!.past).toBe(true);
  });

  it("dry mode shows what it would write and writes nothing", async () => {
    const chain = new FakeChain();
    chain.fund(ETH);
    chain.register(AGENT);
    chain.identity(AGENT);
    const r = await rig("dry", { chain, more: { ERC8004: "on" } });
    rigs.push(r);
    await r.turn();
    await settle(r);
    await r.turn();
    expect(sends(r)).toHaveLength(0);
    expect(r.db.lastAction("erc8004")).toMatchObject({ status: "dry", mode: "dry" });
  });
});

describe("the guards", () => {
  it("a job the registry refuses for good is set aside and never sent again", async () => {
    const r = await desk();
    r.chain.identity(A.bot, AGENT); // the gas wallet owns it: the registry says "Self-feedback not allowed"
    await r.turn();
    const id = await settle(r);
    await r.turn();
    await r.turn();
    expect(sends(r)).toHaveLength(0);
    const row = r.sqlite.prepare("SELECT status, error FROM erc8004_entries WHERE job_id = ?").get(id) as Body;
    expect(row.status).toBe("refused");
    expect(row.error).toMatch(/Self-feedback not allowed/);
  });

  it("an identity that is no longer the agent's takes no more entries", async () => {
    const r = await desk();
    const id = r.chain.identity(AGENT);
    await r.turn();
    r.chain.identities[id] = { owner: OTHER, wallet: null, approved: null }; // handed on: the registry clears its agentWallet
    await settle(r);
    await r.turn();
    expect(sends(r)).toHaveLength(0);
    expect((await get(r, `/v1/agents/${AGENT}`)).erc8004.lost).toMatch(/not this agent's/);
  });

  it("more entries on the chain than in Factor's notes: nothing more is written to that identity", async () => {
    const r = await desk();
    const id = r.chain.identity(AGENT);
    await r.turn();
    r.chain.feedback.set(`${id}:${A.bot}`, [{ value: 100n, decimals: 0, tag1: "factor", tag2: "job", uri: "", hash: "0x" }]);
    await settle(r);
    await r.turn();
    expect(sends(r)).toHaveLength(0);
    expect(r.lines.some((l) => /nothing more is written to it until that is looked at/.test(l))).toBe(true);
  });

  it("demonstrations, and jobs an agent locked for itself, are not written", async () => {
    const r = await desk();
    r.chain.identity(AGENT);
    await r.turn();
    const self = await settle(r, { customer: AGENT });
    await r.turn();
    expect(sends(r)).toHaveLength(0);
    expect((r.sqlite.prepare("SELECT status FROM erc8004_entries WHERE job_id = ?").get(self) as Body).status).toBe("skipped");
  });

  it("the owner's switch stops the writing at once; what settled meanwhile is written once it is on again", async () => {
    const r = await desk();
    r.chain.identity(AGENT);
    await r.turn();
    turn(r.db, "erc8004", false, "looking at something");
    await settle(r);
    await r.turn();
    expect(sends(r)).toHaveLength(0);
    turn(r.db, "erc8004", true);
    await r.turn();
    expect(sends(r)).toHaveLength(1);
  });

  it("the day's gas: once the entries have cost what ERC8004_GAS_DAY_WEI allows, the rest wait", async () => {
    // room for one entry at its most (218,000 gas and a quarter more, at the made-up chain's 0.022 gwei), not two
    const one = ((218_000n * 12_500n) / 10_000n) * 22_000_000n;
    const r = await desk({ ERC8004_GAS_DAY_WEI: String(one + one / 2n) });
    r.chain.identity(AGENT);
    await r.turn();
    await settle(r);
    await settle(r);
    await r.turn();
    expect(sends(r)).toHaveLength(1);
    expect((await get(r, "/v1/health")).actions.erc8004.result).toMatch(/over the most allowed/);
  });

  it("a write that never reached the chain goes back in the queue with the same file, and is written once", async () => {
    const r = await desk();
    const id = r.chain.identity(AGENT);
    await r.turn();
    const job = await settle(r);
    r.chain.dropSends = true;
    await r.turn();
    const first = r.sqlite.prepare("SELECT status, hash FROM erc8004_entries WHERE job_id = ?").get(job) as Body;
    r.chain.dropSends = false;
    for (let i = 0; i < 4; i++) { r.wall.extra += 3_600_000; await r.turn(); }
    expect(r.chain.entriesOf(id, A.bot)).toHaveLength(1);
    expect(r.chain.entriesOf(id, A.bot)[0]!.hash).toBe(first.hash);
  });
});
