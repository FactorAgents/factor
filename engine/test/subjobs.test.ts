// Agents that hire agents, on the made-up chain: a job's agent signs a hire for part of it, locks it from its own
// wallet, and the engine links the lock under the job. Every rule the engine holds a hire to, each on its own: the
// room left of the parent's price, the due time, how deep and how many, nobody hiring itself or its own hand, only
// agents on the desk, only the parent's own agent. Then the chain of work as the page draws it, the records, the
// burn of each deal, and what a rejection up the chain leaves the hiring agent to choose.

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { hireMessage, planIdOf, readSubjobs, type HirePlan, type TreeJson } from "../src/subjobs.js";
import { encodePayLink, payLinkMessage, type PayLink } from "../src/pay.js";
import type { RecordJson } from "../src/record.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

// anvil's public test keys: worth nothing anywhere
const mainKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const subKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const sub2Key = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
const sub3Key = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const MAIN = mainKey.address.toLowerCase(), SUB = subKey.address.toLowerCase(), SUB2 = sub2Key.address.toLowerCase(), SUB3 = sub3Key.address.toLowerCase();
const BUYER = "0x00000000000000000000000000000000000b0e01";
const STRANGER = "0x00000000000000000000000000000000000000e7";
const PRICE = ETH / 25n; // 0.04
const DAY = 86_400;

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

async function desk(more: Record<string, string> = {}): Promise<Rig> {
  const chain = new FakeChain();
  chain.fund(ETH);
  for (const a of [MAIN, SUB, SUB2, SUB3]) chain.register(a);
  const r = await rig("live", { chain, more: { SUBJOBS: "on", ...more } });
  rigs.push(r);
  await r.engine.watchOnce();
  return r;
}

const post = async (r: Rig, path: string, body: unknown) => (await r.engine.post(path, body, "1.2.3.4"))!;
const get = async (r: Rig, path: string) => (await r.engine.handle(path))!;
type Key = typeof mainKey;

/** A customer's job for the main agent, read by the engine. */
async function parentJob(r: Rig, o: { agent?: string; price?: bigint; dueInS?: number; customer?: string } = {}): Promise<number> {
  const id = r.chain.lock(o.customer ?? BUYER, o.agent ?? MAIN, o.price ?? PRICE, o.dueInS ?? 2 * DAY, true);
  await r.engine.watchOnce();
  return id;
}

/** The hirer signs a plan for part of `parent`. */
async function plan(r: Rig, parent: number, o: { key?: Key; agent?: string; price?: bigint; dueInS?: number; early?: boolean; title?: string; brief?: string } = {}) {
  const p: HirePlan = { parent, agent: o.agent ?? SUB, price: (o.price ?? PRICE / 4n).toString(), dueAt: r.chain.time + (o.dueInS ?? DAY), early: o.early ?? true, title: o.title ?? "Read the contract's dates", brief: o.brief ?? "Every date, one per line.", at: r.chain.time };
  const signature = await (o.key ?? mainKey).signMessage({ message: hireMessage(p) });
  const a = await post(r, "/v1/subjobs/plan", { ...p, signature });
  return { a, p, id: planIdOf(p) };
}

/** Signs, locks exactly what was signed from the hirer's wallet, and links it. */
async function hire(r: Rig, parent: number, o: Parameters<typeof plan>[2] & { hirer?: string; burn?: boolean } = {}) {
  const { a, p, id } = await plan(r, parent, o);
  expect(a.status, String(a.body.error)).toBe(200);
  const hirer = o.hirer ?? (o.key ? o.key.address.toLowerCase() : MAIN);
  const lock = r.chain.lockTx(hirer, p.agent, BigInt(p.price), p.dueAt - r.chain.time, p.early);
  const burnTx = o.burn ? r.chain.transfer(hirer, A.burnPot, BigInt(p.price) / 100n) : undefined;
  const linked = await post(r, "/v1/subjobs/link", { plan: id, job: lock.id, lockTx: lock.hash, ...(burnTx ? { burnTx } : {}) });
  await r.engine.watchOnce();
  return { linked, job: lock.id, lock, planId: id, p };
}

describe("the switch and the words", () => {
  it("is off unless SUBJOBS=on, two levels deep and five under one job by default", () => {
    expect(readSubjobs({})).toEqual({ enabled: false, maxDepth: 2, perParent: 5, planLifeS: 900 });
    expect(readSubjobs({ SUBJOBS: "on", SUBJOBS_MAX_DEPTH: "3", SUBJOBS_PER_PARENT: "8" })).toMatchObject({ enabled: true, maxDepth: 3, perParent: 8 });
    const problems: string[] = [];
    expect(readSubjobs({ SUBJOBS_MAX_DEPTH: "9", SUBJOBS_PER_PARENT: "0" }, problems)).toMatchObject({ maxDepth: 2, perParent: 5 });
    expect(problems).toHaveLength(2);
  });

  it("signs readable words, the same the kit and the site build", () => {
    const p: HirePlan = { parent: 12, agent: SUB, price: (PRICE / 4n).toString(), dueAt: 1_800_000_000, early: true, title: "Read the contract's dates", brief: "", at: 1_799_990_000 };
    expect(hireMessage(p)).toBe([
      "Factor: hire an agent for part of a job",
      "parent job: 12",
      `agent: ${SUB}`,
      "price: 0.01 ETH",
      "due: 1800000000",
      "early: up to half may be drawn before delivery",
      "title: Read the contract's dates",
      "brief: none",
      "at: 1799990000",
    ].join("\n"));
    expect(planIdOf(p)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses every hire while it is off, and while the owner has paused new jobs", async () => {
    const off = await desk({ SUBJOBS: "" });
    const parent = await parentJob(off);
    expect((await plan(off, parent)).a.status).toBe(503);
    expect(((await get(off, "/v1/state")).body as { subjobs: { enabled: boolean } }).subjobs.enabled).toBe(false);
    const on = await desk();
    const p2 = await parentJob(on);
    turn(on.db, "hiring", false, "Looking at something");
    const paused = (await plan(on, p2)).a;
    expect(paused.status).toBe(409);
    expect(paused.body.error).toBe("Looking at something");
  });
});

describe("a hire", () => {
  it("is signed, locked from the agent's own wallet, and linked under the job, readable by anybody", async () => {
    const r = await desk();
    const parent = await parentJob(r);
    const { linked, job, planId } = await hire(r, parent);
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ ok: true, job, parent, root: parent, depth: 1, hirer: MAIN, agent: SUB, via: "kit" });
    // the sub-job is an ordinary job on the desk, its customer the parent's agent, with the title and brief the plan signed
    const page = (await get(r, `/v1/jobs/${job}`)).body as { job: { customer: string; title: string; parent?: { n: number; depth: number } }; brief: string; tree: TreeJson };
    expect(page.job).toMatchObject({ customer: MAIN, title: "Read the contract's dates", parent: { n: parent, depth: 1 } });
    expect(page.brief).toBe("Every date, one per line.");
    // the chain of work, from the customer's job down, with the words and signature that link the two
    const tree = page.tree;
    expect(tree.root).toBe(parent);
    expect(tree.nodes.map((n) => [n.job, n.parent, n.depth, n.customer, n.agent])).toEqual([[parent, null, 0, BUYER, MAIN], [job, parent, 1, MAIN, SUB]]);
    expect(tree.nodes[1]).toMatchObject({ verified: true, state: "locked", priceEth: 0.01 });
    const proof = tree.nodes[1]!.hire!;
    expect(proof.by).toBe(MAIN);
    expect(await mainKey.signMessage({ message: proof.message })).toBe(proof.signature);
    expect(proof.message).toContain(`parent job: ${parent}`);
    // the same tree from the parent's page and on its own path
    expect(((await get(r, `/v1/jobs/${parent}`)).body as { tree: TreeJson }).tree.nodes).toHaveLength(2);
    expect(((await get(r, `/v1/jobs/${parent}/tree`)).body as unknown as TreeJson).nodes).toHaveLength(2);
    // asked again for the same job, the same answer: a hirer can retry safely
    const again = await post(r, "/v1/subjobs/link", { plan: planId, job, lockTx: r.engine.subjobs!.store.link(job)!.lock_tx });
    expect(again.body).toMatchObject({ ok: true, job });
    // a job that hired nobody has no tree
    const lone = await parentJob(r);
    expect((await get(r, `/v1/jobs/${lone}/tree`)).status).toBe(404);
    expect(((await get(r, `/v1/jobs/${lone}`)).body as { tree?: unknown }).tree).toBeUndefined();
  });

  it("is signed by the job's own agent and nobody else, and only while the job is open", async () => {
    const r = await desk();
    const parent = await parentJob(r);
    const forged = (await plan(r, parent, { key: sub2Key })).a;
    expect(forged.status).toBe(401);
    expect(String(forged.body.error)).toMatch(/only the agent of a job can hire/);
    r.chain.deliver(parent);
    await r.engine.watchOnce();
    expect(String((await plan(r, parent)).a.body.error)).toMatch(/no longer open/);
    expect((await plan(r, 999)).a.status).toBe(404);
  });

  it("is for an agent on the desk, never the hirer itself", async () => {
    const r = await desk();
    const parent = await parentJob(r);
    expect(String((await plan(r, parent, { agent: STRANGER })).a.body.error)).toMatch(/not registered/);
    expect(String((await plan(r, parent, { agent: MAIN })).a.body.error)).toMatch(/cannot hire itself/);
  });

  it("never reaches back up the chain: the customer at the top, or an agent above, cannot be hired under it", async () => {
    const r = await desk();
    // the customer at the top is an agent too
    const parent = await parentJob(r, { customer: SUB3 });
    expect(String((await plan(r, parent, { agent: SUB3 })).a.body.error)).toMatch(/already in this chain/);
    const { job } = await hire(r, parent, { agent: SUB });
    // the agent it hired would hire the main agent back: a loop
    expect(String((await plan(r, job, { key: subKey, agent: MAIN })).a.body.error)).toMatch(/already in this chain/);
  });

  it("never hires an agent run by the same hand: a key of its account, Factor's own pair, a maker and what it is paid to", async () => {
    const r = await desk({ FACTOR_HOUSE_AGENTS: `${MAIN},${SUB2}` });
    const parent = await parentJob(r);
    // SUB is a Factor account with MAIN's wallet as one of its keys
    r.db.q("INSERT INTO account_keys (account, kind, a, b, credential, added_at) VALUES (?, 1, ?, ?, '0x', 0)").run(SUB, `0x${"0".repeat(24)}${MAIN.slice(2)}`, `0x${"0".repeat(64)}`);
    expect(String((await plan(r, parent, { agent: SUB })).a.body.error)).toMatch(/same hand/);
    // two of Factor's own agents
    expect(String((await plan(r, parent, { agent: SUB2 })).a.body.error)).toMatch(/same hand/);
    // an agent made on the site whose earnings go to the hirer
    r.db.q("INSERT INTO hosted_agents (owner, name, does, instructions, price_wei, payout, created_at) VALUES (?, 'made-one', 'Does a thing for you', 'x', '1000000000000000', ?, 0)").run(SUB3, MAIN);
    expect(String((await plan(r, parent, { agent: SUB3 })).a.body.error)).toMatch(/same hand/);
  });
});

describe("the room left of the parent's price", () => {
  it("never lets the sub-jobs together pass the parent's price, counting the plans that hold room", async () => {
    const r = await desk();
    const parent = await parentJob(r); // 0.04
    await hire(r, parent, { agent: SUB, price: (PRICE * 3n) / 4n }); // 0.03
    // a plan holds its room until it lapses: 0.01 is left, and a plan takes it
    const held = await plan(r, parent, { agent: SUB2, price: PRICE / 4n });
    expect(held.a.status).toBe(200);
    const over = (await plan(r, parent, { agent: SUB3, price: ETH / 1000n }));
    expect(String(over.a.body.error)).toMatch(/nothing is left/);
    const page = (await get(r, `/v1/jobs/${parent}`)).body as { hiring: { open: boolean; freeEth: number; used: number } };
    expect(page.hiring).toMatchObject({ open: false, freeEth: 0, used: 2 });
    // fifteen minutes on, the plan that was never locked lets its room go
    r.chain.mine(1, 16 * 60);
    await r.engine.watchOnce();
    expect((await plan(r, parent, { agent: SUB3, price: PRICE / 4n })).a.status).toBe(200);
  });

  it("says what is left in ETH, and gives room back when a sub-job is declined or settles at half", async () => {
    const r = await desk();
    const parent = await parentJob(r);
    const a = await hire(r, parent, { agent: SUB, price: PRICE / 2n }); // 0.02
    expect(String((await plan(r, parent, { agent: SUB2, price: (PRICE * 3n) / 4n })).a.body.error)).toMatch(/only 0.02 ETH is left/);
    r.chain.decline(a.job);
    await r.engine.watchOnce();
    const b = await hire(r, parent, { agent: SUB2, price: PRICE / 2n });
    r.chain.deliver(b.job);
    r.chain.reject(b.job); // half of it came back to the main agent
    await r.engine.watchOnce();
    const h = ((await get(r, `/v1/jobs/${parent}`)).body as { hiring: { freeEth: number } }).hiring;
    expect(h.freeEth).toBe(0.03);
  });
});

describe("the due time, the depth and the count", () => {
  it("is due before the parent", async () => {
    const r = await desk();
    const parent = await parentJob(r, { dueInS: DAY });
    expect(String((await plan(r, parent, { dueInS: DAY })).a.body.error)).toMatch(/due before the job/);
    expect(String((await plan(r, parent, { dueInS: 1800 })).a.body.error)).toMatch(/at least an hour/);
    expect((await plan(r, parent, { dueInS: DAY - 3600 })).a.status).toBe(200);
  });

  it("goes two levels under the customer's job and no deeper", async () => {
    const r = await desk();
    const parent = await parentJob(r, { dueInS: 3 * DAY });
    const one = await hire(r, parent, { agent: SUB, dueInS: 2 * DAY });
    const two = await hire(r, one.job, { key: subKey, agent: SUB2, price: PRICE / 8n, dueInS: DAY });
    expect(two.linked.body).toMatchObject({ depth: 2, root: parent, parent: one.job });
    const three = await plan(r, two.job, { key: sub2Key, agent: SUB3, price: PRICE / 16n, dueInS: DAY / 2 });
    expect(String(three.a.body.error)).toMatch(/2 levels under a customer's job cannot hire again/);
    const tree = ((await get(r, `/v1/jobs/${two.job}/tree`)).body as unknown as TreeJson);
    expect(tree.nodes.map((n) => [n.job, n.depth])).toEqual([[parent, 0], [one.job, 1], [two.job, 2]]);
  });

  it("holds a job to its number of sub-jobs", async () => {
    const r = await desk({ SUBJOBS_PER_PARENT: "2" });
    const parent = await parentJob(r);
    await hire(r, parent, { agent: SUB, price: PRICE / 8n });
    await hire(r, parent, { agent: SUB2, price: PRICE / 8n });
    expect(String((await plan(r, parent, { agent: SUB3, price: PRICE / 8n })).a.body.error)).toMatch(/2 sub-jobs at most/);
  });
});

describe("the link to the lock", () => {
  it("takes only the lock the plan signed, made by the hirer before the plan lapsed", async () => {
    const r = await desk();
    const parent = await parentJob(r);
    const { p, id } = await plan(r, parent);
    const linkOf = (lock: { id: number; hash: string }) => post(r, "/v1/subjobs/link", { plan: id, job: lock.id, lockTx: lock.hash });
    expect(String((await linkOf(r.chain.lockTx(MAIN, SUB, PRICE / 2n, p.dueAt - r.chain.time, true))).body.error)).toMatch(/price/);
    expect(String((await linkOf(r.chain.lockTx(MAIN, SUB2, BigInt(p.price), p.dueAt - r.chain.time, true))).body.error)).toMatch(/another agent/);
    expect(String((await linkOf(r.chain.lockTx(MAIN, SUB, BigInt(p.price), p.dueAt - r.chain.time + 60, true))).body.error)).toMatch(/due at another time/);
    expect(String((await linkOf(r.chain.lockTx(MAIN, SUB, BigInt(p.price), p.dueAt - r.chain.time, false))).body.error)).toMatch(/early advance/);
    // somebody else locks the same thing: it is their job, not the main agent's sub-job
    expect(String((await linkOf(r.chain.lockTx(SUB3, SUB, BigInt(p.price), p.dueAt - r.chain.time, true))).body.error)).toMatch(/not locked by the agent who signed/);
    expect((await post(r, "/v1/subjobs/link", { plan: id, job: 77, lockTx: `0x${"12".repeat(32)}` })).status).toBe(404);
    // the right lock, too late: the plan had lapsed
    r.chain.mine(1, 16 * 60);
    const late = await linkOf(r.chain.lockTx(MAIN, SUB, BigInt(p.price), p.dueAt - r.chain.time, true));
    expect(late.status).toBe(410);
    expect(String(late.body.error)).toMatch(/ordinary job of yours/);
  });

  it("links one job to one plan", async () => {
    const r = await desk();
    const parent = await parentJob(r);
    const a = await hire(r, parent, { agent: SUB, price: PRICE / 8n });
    const b = await plan(r, parent, { agent: SUB2, price: PRICE / 8n });
    expect(String((await post(r, "/v1/subjobs/link", { plan: b.id, job: a.job, lockTx: a.lock.hash })).body.error)).toMatch(/already linked to another plan/);
    expect(String((await post(r, "/v1/subjobs/link", { plan: a.planId, job: a.job + 1, lockTx: a.lock.hash })).body.error)).toMatch(/did not lock that job/);
  });
});

describe("the burn of every deal", () => {
  it("counts the hirer's 1% beside a sub-job it locked itself, once", async () => {
    const r = await desk();
    const parent = await parentJob(r);
    const a = await hire(r, parent, { agent: SUB, burn: true });
    expect(a.linked.body).toMatchObject({ burned: true, burnWei: (PRICE / 400n).toString() });
    // the same transfer again, for another sub-job
    const b = await plan(r, parent, { agent: SUB2 });
    const lock = r.chain.lockTx(MAIN, SUB2, BigInt(b.p.price), b.p.dueAt - r.chain.time, true);
    const used = r.engine.subjobs!.store.link(a.job)!.burn_tx!;
    expect((await post(r, "/v1/subjobs/link", { plan: b.id, job: lock.id, lockTx: lock.hash, burnTx: used })).body).toMatchObject({ ok: true, burned: false, burnNote: expect.stringMatching(/already counted/) });
  });

  it("links a pay link bought for a job, and over x402 too: each deal adds its own burn", async () => {
    const r = await desk();
    // the customer pays the main agent's own link: the first deal
    const sign = async (l: PayLink, key: Key) => encodePayLink(l, await key.signMessage({ message: payLinkMessage(l) }));
    const mainLink: PayLink = { v: 1, agent: MAIN, price: PRICE.toString(), title: "Summarise a contract", brief: "", due: 48, early: true, exp: r.chain.time + 30 * DAY, id: "00000000000000a1" };
    const top = r.chain.lockTx(BUYER, MAIN, PRICE, 48 * 3600, true);
    await post(r, "/v1/pay/deal", { link: await sign(mainLink, mainKey), job: top.id, lockTx: top.hash, burnTx: r.chain.transfer(BUYER, A.burnPot, PRICE / 100n) });
    await r.engine.watchOnce();
    // the main agent buys SUB's link as part of it, through the checkout's road
    const subLink: PayLink = { v: 1, agent: SUB, price: (PRICE / 4n).toString(), title: "Every date in a contract", brief: "", due: 24, early: true, exp: r.chain.time + 30 * DAY, id: "00000000000000b1" };
    const one = await plan(r, top.id, { agent: SUB, price: PRICE / 4n, dueInS: 24 * 3600, title: subLink.title, brief: "" });
    const lock1 = r.chain.lockTx(MAIN, SUB, PRICE / 4n, 24 * 3600, true);
    const d1 = await post(r, "/v1/pay/deal", { link: await sign(subLink, subKey), job: lock1.id, lockTx: lock1.hash, burnTx: r.chain.transfer(MAIN, A.burnPot, PRICE / 400n), plan: one.id });
    expect(d1.body).toMatchObject({ ok: true, burned: true, subjob: { job: lock1.id, parent: top.id, depth: 1, via: "checkout" } });
    // and SUB2's over x402
    const x: PayLink = { ...subLink, agent: SUB2, id: "00000000000000c1", early: false };
    const xToken = await sign(x, sub2Key);
    const two = await plan(r, top.id, { agent: SUB2, price: PRICE / 4n, dueInS: 24 * 3600, early: false, title: x.title, brief: "" });
    const lock2 = r.chain.lockTx(MAIN, SUB2, PRICE / 4n, 24 * 3600, false);
    const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "factor-lock", network: "robinhood-chain", payload: { job: lock2.id, lockTx: lock2.hash, burnTx: r.chain.transfer(MAIN, A.burnPot, PRICE / 400n), plan: two.id } })).toString("base64");
    const ask = await r.engine.x402(`/v1/x402/${xToken}`, undefined, "x");
    expect((ask.body.accepts as { extra: { forAJob?: string } }[])[0]!.extra.forAJob).toMatch(/plan/);
    const paid = await r.engine.x402(`/v1/x402/${xToken}`, header, "x");
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ burned: true, subjob: { job: lock2.id, via: "x402" } });
    await r.engine.watchOnce();
    // one customer job, three deals, three burns: shown together on the job's page
    const tree = ((await get(r, `/v1/jobs/${top.id}`)).body as { tree: TreeJson }).tree;
    expect(tree.burn).toEqual({ deals: 3, eth: 0.0006 });
    expect(tree.nodes.map((n) => n.burnEth)).toEqual([0.0004, 0.0001, 0.0001]);
    // the deal's title is the seller's link's, as on any deal
    expect(tree.nodes[1]!.title).toBe("Every date in a contract");
  });

  it("leaves a deal standing as an ordinary one when its plan does not fit, and says why", async () => {
    const r = await desk();
    const parent = await parentJob(r);
    const subLink: PayLink = { v: 1, agent: SUB, price: (PRICE / 4n).toString(), title: "Every date in a contract", brief: "", due: 24, early: true, exp: r.chain.time + 30 * DAY, id: "00000000000000d1" };
    const token = encodePayLink(subLink, await subKey.signMessage({ message: payLinkMessage(subLink) }));
    const lock = r.chain.lockTx(MAIN, SUB, PRICE / 4n, 24 * 3600, true);
    const d = await post(r, "/v1/pay/deal", { link: token, job: lock.id, lockTx: lock.hash, plan: `0x${"ab".repeat(32)}` });
    expect(d.body).toMatchObject({ ok: true, subjobNote: expect.stringMatching(/no such plan/) });
    expect(r.engine.subjobs!.store.link(lock.id)).toBeNull();
  });
});

describe("money flows down, and a rejection up the chain", () => {
  it("settles each sub-job like any job, and leaves the hirer to choose to reject the deliveries still open when its own job was rejected", async () => {
    const r = await desk();
    const parent = await parentJob(r);
    const a = await hire(r, parent, { agent: SUB, price: PRICE / 4n });
    const b = await hire(r, parent, { agent: SUB2, price: PRICE / 4n });
    // SUB delivers and the main agent accepts at once: paid in full, whatever happens above
    r.chain.deliver(a.job);
    r.chain.accept(a.job);
    // SUB2 delivers; the main agent delivers its own job, and the customer rejects it
    r.chain.deliver(b.job);
    r.chain.deliver(parent);
    r.chain.reject(parent);
    await r.engine.watchOnce();
    let tree = ((await get(r, `/v1/jobs/${parent}`)).body as { tree: TreeJson }).tree;
    expect(tree.nodes.map((n) => [n.job, n.state, !!n.canReject])).toEqual([[parent, "half", false], [a.job, "settled", false], [b.job, "delivered", true]]);
    // the main agent chooses to pass it down: the desk's own rule, half back
    r.chain.reject(b.job);
    await r.engine.watchOnce();
    tree = ((await get(r, `/v1/jobs/${parent}`)).body as { tree: TreeJson }).tree;
    expect(tree.nodes.map((n) => [n.state, !!n.canReject])).toEqual([["half", false], ["settled", false], ["half", false]]);
    // the choice ends with the delivery's 24 hours
    const c = await (async () => { const p2 = await parentJob(r); const h = await hire(r, p2, { agent: SUB3, price: PRICE / 4n }); r.chain.deliver(h.job); r.chain.deliver(p2); r.chain.reject(p2); r.chain.mine(1, DAY + 60); await r.engine.watchOnce(); return p2; })();
    const late = ((await get(r, `/v1/jobs/${c}/tree`)).body as unknown as TreeJson).nodes[1]!;
    expect(late.canReject).toBeUndefined();
  });
});

describe("the records", () => {
  it("say who hired an agent and whom it hired, on its page and in its public record, and nothing when there is nothing", async () => {
    const r = await desk();
    const parent = await parentJob(r);
    await hire(r, parent, { agent: SUB, price: PRICE / 8n });
    await hire(r, parent, { agent: SUB, price: PRICE / 8n, title: "A second part" });
    await hire(r, parent, { agent: SUB2, price: PRICE / 8n });
    const main = (await get(r, `/v1/agents/${MAIN}`)).body as { hiring?: { hires: { address: string; jobs: number }[]; hiredBy: unknown[] } };
    expect(main.hiring!.hires).toEqual([expect.objectContaining({ address: SUB, jobs: 2 }), expect.objectContaining({ address: SUB2, jobs: 1 })]);
    expect(main.hiring!.hiredBy).toEqual([]);
    const sub = (await get(r, `/v1/record/${SUB}`)).body as unknown as RecordJson;
    expect(sub.hiring.hiredBy).toEqual([expect.objectContaining({ address: MAIN, jobs: 2 })]);
    expect(sub.hiring.hires).toEqual([]);
    // an agent nobody hired and who hired nobody: no hiring on its page at all
    expect(((await get(r, `/v1/agents/${SUB3}`)).body as { hiring?: unknown }).hiring).toBeUndefined();
    // the agent's list of jobs says which job each sub-job is part of
    const jobs = ((await r.engine.handle("/v1/jobs", new URLSearchParams({ agent: SUB })))!.body as { items: { parent?: { n: number } }[] }).items;
    expect(jobs.every((j) => j.parent?.n === parent)).toBe(true);
  });
});
