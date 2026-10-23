// Offers on open jobs, on the made-up chain: a customer posts a job open to offers (with a budget, or none), agents
// make offers of their own price and time with one signature each, a newer offer replaces the old one, an offer can
// end or be withdrawn, and the customer picks one by locking that offer's price on the desk. Then every money path on
// its own: the agent's own lowest price, the customer's budget, the job's hours, the lock that must be the offer the
// agent stood by, the burn at the offer's price, and the switch that holds it all back until it is turned on.

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { rulesMessage, type Rules } from "../src/autoapply.js";
import { applyMessage, openJobIdOf, postMessage, readOpenJobs, withdrawMessage, type Offer, type OpenJobJson, type OpenJobText } from "../src/openjobs.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain, K } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

// anvil's public test keys: worth nothing anywhere
const buyerKey = privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
const aKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const bKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const cKey = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
const low = (k: { address: string }) => k.address.toLowerCase();
const BUYER = low(buyerKey), A1 = low(aKey), B1 = low(bKey), C1 = low(cKey);
const MILLI = ETH / 1000n;
const BUDGET = 6n * MILLI; // 0.006
const HOUR = 3600;
type Key = typeof buyerKey;
type Body = Record<string, any>;

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

async function desk(more: Record<string, string> = {}): Promise<Rig> {
  const chain = new FakeChain();
  chain.fund(ETH);
  for (const a of [A1, B1, C1]) chain.register(a);
  const r = await rig("live", { chain, more: { OPENJOBS: "on", BIDS: "on", ...more } });
  rigs.push(r);
  await r.engine.watchOnce();
  return r;
}

const post = async (r: Rig, path: string, body: unknown): Promise<Body> => { const a = (await r.engine.post(path, body, "1.2.3.4"))!; return { status: a.status, ...(a.body as Body) }; };
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? "")))!; return { status: a.status, ...(a.body as Body) }; };
const page = async (r: Rig, id: string): Promise<OpenJobJson> => { await r.engine.watchOnce(); return (await get(r, `/v1/openjobs/${id}`)).open as OpenJobJson; };

/** The customer signs a listing: open to offers unless `offers: false`. */
async function postJob(r: Rig, o: Partial<OpenJobText> & { key?: Key } = {}): Promise<{ id: string; a: Body; p: OpenJobText }> {
  const key = o.key ?? buyerKey;
  const offers = o.offers ?? true;
  const p: OpenJobText = { customer: low(key), price: o.price ?? BUDGET.toString(), dueHours: o.dueHours ?? 48, early: o.early ?? true, title: o.title ?? "Check every figure in our quarterly note", brief: o.brief ?? "Every figure against its source, one line each.", closesAt: o.closesAt ?? r.chain.time + 6 * HOUR, pick: o.pick ?? { by: "customer" }, at: o.at ?? r.chain.time, ...(offers ? { offers: true } : {}) };
  const signature = await key.signMessage({ message: postMessage(p) });
  const a = await post(r, "/v1/openjobs/post", { customer: p.customer, price: p.price, dueHours: p.dueHours, early: p.early, title: p.title, brief: p.brief, closesAt: p.closesAt, pick: p.pick.by, at: p.at, signature, ...(offers ? { offers: true } : {}) });
  return { id: openJobIdOf(p), a, p };
}

/** An agent signs its offer (or, with `offer: null`, a plain application). */
async function bid(r: Rig, open: string, key: Key, o: { price?: bigint; hours?: number; until?: number | null; pitch?: string; at?: number; offer?: null } = {}): Promise<Body> {
  const at = o.at ?? r.chain.time;
  const offer: Offer | null = o.offer === null ? null : { priceWei: (o.price ?? 4n * MILLI).toString(), dueHours: o.hours ?? 24, until: o.until ?? null };
  const pitch = o.pitch ?? "";
  const signature = await key.signMessage({ message: applyMessage({ open, agent: low(key), pitch, at, ...(offer ? { offer } : {}) }) });
  return post(r, "/v1/openjobs/apply", { open, agent: low(key), pitch, at, signature, ...(offer ? { priceWei: offer.priceWei, dueHours: offer.dueHours, ...(offer.until !== null ? { until: offer.until } : {}) } : {}) });
}

async function withdraw(r: Rig, open: string, key: Key, at = r.chain.time): Promise<Body> {
  const signature = await key.signMessage({ message: withdrawMessage({ open, agent: low(key), at }) });
  return post(r, "/v1/openjobs/withdraw", { open, agent: low(key), at, signature });
}

/** The customer locks a price for an agent on the chain (and its burn), and links it to the listing. */
async function lockFor(r: Rig, open: string, agent: string, o: { price: bigint; dueH: number; early?: boolean; burn?: bigint }): Promise<{ job: number; a: Body; lockTx: string }> {
  const { id, hash } = r.chain.lockTx(BUYER, agent, o.price, o.dueH * HOUR, o.early ?? true);
  const burnTx = o.burn === 0n ? undefined : r.chain.transfer(BUYER, A.burnPot, o.burn ?? o.price / 100n);
  await r.engine.watchOnce();
  return { job: id, lockTx: hash, a: await post(r, "/v1/openjobs/hire", { open, job: id, lockTx: hash, ...(burnTx ? { burnTx } : {}) }) };
}

const later = async (r: Rig, seconds: number) => { r.chain.mine(1, seconds); await r.engine.watchOnce(); };

describe("the switch and the words", () => {
  it("is off unless BIDS=on, with ten changes of an offer by default", () => {
    expect(readOpenJobs({ OPENJOBS: "on" })).toMatchObject({ enabled: true, bids: false, offerChanges: 10 });
    expect(readOpenJobs({ OPENJOBS: "on", BIDS: "on", OFFERS_CHANGES: "3" })).toMatchObject({ bids: true, offerChanges: 3 });
    const problems: string[] = [];
    readOpenJobs({ OFFERS_CHANGES: "0" }, problems);
    expect(problems).toHaveLength(1);
  });

  it("signs readable words, and leaves the words of a job with a fixed price as they were", () => {
    const p: OpenJobText = { customer: BUYER, price: "6000000000000000", dueHours: 48, early: true, title: "Check the figures", brief: "", closesAt: 1_800_000_000, pick: { by: "customer" }, at: 1_799_990_000 };
    expect(postMessage(p)).toContain("price: 0.006 ETH\ndue: 48 hours after it is locked\n");
    expect(postMessage({ ...p, offers: true })).toBe([
      "Factor: post an open job",
      `customer: ${BUYER}`,
      "price: open to offers, up to 0.006 ETH",
      "due: as offered, at most 48 hours after it is locked",
      "early: up to half may be drawn before delivery",
      "title: Check the figures",
      "brief: none",
      "applications close: 1800000000",
      "pick: by the customer",
      "at: 1799990000",
    ].join("\n"));
    expect(postMessage({ ...p, offers: true, price: "0" })).toContain("price: open to offers\n");
    // a job open to offers is another listing than the same words with a fixed price
    expect(openJobIdOf({ ...p, offers: true })).not.toBe(openJobIdOf(p));
    expect(applyMessage({ open: "0xab", agent: A1, pitch: "", at: 1 })).toBe(`Factor: apply for an open job\nopen job: 0xab\nagent: ${A1}\npitch: none\nat: 1`);
    expect(applyMessage({ open: "0xab", agent: A1, pitch: "", at: 1, offer: { priceWei: "4000000000000000", dueHours: 24, until: null } })).toBe(`Factor: apply for an open job\nopen job: 0xab\nagent: ${A1}\npitch: none\noffer: 0.004 ETH, due 24 hours after it is locked\ngood until: withdrawn\nat: 1`);
    expect(applyMessage({ open: "0xab", agent: A1, pitch: "", at: 1, offer: { priceWei: "4000000000000000", dueHours: 24, until: 1_800_000_000 } })).toContain("good until: 1800000000\n");
    expect(withdrawMessage({ open: "0xab", agent: A1, at: 1 })).toBe(`Factor: withdraw an offer\nopen job: 0xab\nagent: ${A1}\nat: 1`);
  });

  it("while BIDS is off: no job open to offers, and a job with a fixed price works as it did", async () => {
    const r = await desk({ BIDS: "" });
    expect((await get(r, "/v1/state")).openJobs).toMatchObject({ enabled: true, bids: false });
    expect((await postJob(r)).a).toMatchObject({ status: 503, error: expect.stringMatching(/offers are switched off/) });
    const fixed = await postJob(r, { offers: false, price: (4n * MILLI).toString() });
    expect(fixed.a.status).toBe(200);
    expect(await bid(r, fixed.id, aKey, { offer: null })).toMatchObject({ status: 200, rank: 1 });
    expect(await page(r, fixed.id)).toMatchObject({ offers: false, priceWei: (4n * MILLI).toString() });
    expect((await page(r, fixed.id)).applicants[0]!.offer).toBeUndefined();
  });

  it("the owner's switch stops new jobs open to offers and new offers at once, and lets an offer be withdrawn and a lock be linked", async () => {
    const r = await desk();
    const { id } = await postJob(r);
    expect((await bid(r, id, aKey)).status).toBe(200);
    expect((await bid(r, id, bKey, { price: 5n * MILLI })).status).toBe(200);
    turn(r.db, "bids", false, "A look at offers");
    expect((await get(r, "/v1/state")).openJobs).toMatchObject({ bids: false });
    expect((await postJob(r, { title: "Another job open to offers" })).a.status).toBe(503);
    expect((await bid(r, id, cKey)).status).toBe(503);
    expect((await bid(r, id, aKey, { price: 3n * MILLI, at: r.chain.time + 1 })).status).toBe(503);
    expect((await withdraw(r, id, bKey)).status).toBe(200);
    // the customer had already locked the offer: the lock is linked all the same
    expect((await lockFor(r, id, A1, { price: 4n * MILLI, dueH: 24 })).a).toMatchObject({ status: 200, agent: A1 });
    turn(r.db, "bids", true);
    expect((await get(r, "/v1/state")).openJobs).toMatchObject({ bids: true });
  });
});

describe("posting a job open to offers", () => {
  it("takes a budget or none, and the longest time it gives; the listing has no price of its own", async () => {
    const r = await desk();
    const { id, a } = await postJob(r);
    expect(a).toMatchObject({ status: 200, created: true, offers: true, burnWei: "0" });
    const o = await page(r, id);
    expect(o).toMatchObject({ status: "open", offers: true, priceWei: "0", priceEth: 0, burnWei: "0", budgetWei: BUDGET.toString(), budgetEth: 0.006, dueHours: 48 });
    expect(o.note).toMatch(/Taking offers until .* Each agent names its own price and time/);
    expect(o.signed!.message).toContain("price: open to offers, up to 0.006 ETH");
    const none = await postJob(r, { price: "0", title: "A job with no budget" });
    expect(none.a.status).toBe(200);
    const n = await page(r, none.id);
    expect(n.offers).toBe(true);
    expect(n.budgetWei).toBeUndefined();
  });

  it("refuses a budget under the smallest job, and Factor picking a price for anybody", async () => {
    const r = await desk();
    expect((await postJob(r, { price: (MILLI / 2n).toString() })).a.error).toMatch(/a budget is 0.001 ETH at least, or none/);
    expect((await postJob(r, { pick: { by: "best" } })).a.error).toMatch(/picked by its customer/);
    // a job with a fixed price still needs its price
    expect((await postJob(r, { offers: false, price: "0" })).a.error).toMatch(/smallest job/);
  });
});

describe("making an offer", () => {
  it("carries the agent's own price and time, signed with it, and the listing shows each beside its Factor Score", async () => {
    const r = await desk();
    const { id } = await postJob(r);
    expect(await bid(r, id, aKey, { price: 4n * MILLI, hours: 24, pitch: "Every figure checked twice" })).toMatchObject({ status: 200, rank: 1, of: 1, offer: { priceWei: (4n * MILLI).toString(), dueHours: 24, until: null } });
    expect((await bid(r, id, bKey, { price: 5500n * MILLI / 1000n, hours: 6 })).status).toBe(200);
    const o = await page(r, id);
    const a = o.applicants.find((x) => x.address === A1)!;
    expect(a.offer).toEqual({ priceWei: (4n * MILLI).toString(), priceEth: 0.004, burnWei: (4n * MILLI / 100n).toString(), dueHours: 24, changes: 0 });
    expect(o.applicants.find((x) => x.address === B1)!.offer).toMatchObject({ priceEth: 0.0055, dueHours: 6 });
    // anyone can check the offer against the words the agent signed
    expect(a.signed!.message).toContain("offer: 0.004 ETH, due 24 hours after it is locked\ngood until: withdrawn");
    expect(await aKey.signMessage({ message: a.signed!.message })).toBe(a.signed!.signature);
  });

  it("must have an offer on a job open to offers, and none on a job with a fixed price", async () => {
    const r = await desk();
    const { id } = await postJob(r);
    expect((await bid(r, id, aKey, { offer: null })).error).toMatch(/open to offers: send the price/);
    const fixed = await postJob(r, { offers: false, price: (4n * MILLI).toString(), title: "A job with its price" });
    const signature = await aKey.signMessage({ message: applyMessage({ open: fixed.id, agent: A1, pitch: "", at: r.chain.time }) });
    expect((await post(r, "/v1/openjobs/apply", { open: fixed.id, agent: A1, pitch: "", at: r.chain.time, signature, priceWei: "1", dueHours: 1 })).error).toMatch(/fixed price: apply without an offer/);
  });

  it("is never over the customer's budget, never under the smallest job, never longer than the job gives", async () => {
    const r = await desk();
    const { id } = await postJob(r);
    expect((await bid(r, id, aKey, { price: BUDGET + 1n })).error).toMatch(/over the customer's budget of 0.006 ETH/);
    expect((await bid(r, id, aKey, { price: MILLI - 1n })).error).toMatch(/0.001 ETH at least/);
    expect((await bid(r, id, aKey, { hours: 49 })).error).toMatch(/1 to 48 hours after the lock/);
    expect((await bid(r, id, aKey, { hours: 0 })).error).toMatch(/1 to 48 hours/);
    expect((await bid(r, id, aKey, { until: r.chain.time + 60 })).error).toMatch(/5 minutes to 30 days/);
    expect((await bid(r, id, aKey, { price: BUDGET })).status).toBe(200);
    // with no budget, any price from the smallest job up
    const none = await postJob(r, { price: "0", title: "No budget at all" });
    expect((await bid(r, none.id, aKey, { price: 50n * MILLI })).status).toBe(200);
  });

  it("is never under the agent's own lowest price, as its owner signed it in its auto-apply rules", async () => {
    const r = await desk({ AUTOAPPLY: "on" });
    const rules: Rules = { on: false, takes: ["Research"], words: [], floorWei: (3n * MILLI).toString(), atOnce: 1, hours: null, early: false, pitch: "" };
    const at = r.chain.time;
    const signature = await aKey.signMessage({ message: rulesMessage({ ...rules, agent: A1, by: A1, at }) });
    expect((await post(r, "/v1/autoapply/rules", { agent: A1, by: A1, ...rules, at, signature })).status).toBe(200);
    const { id } = await postJob(r);
    // its rules are off: its lowest price still holds for every offer it makes, by hand or on its own
    expect((await bid(r, id, aKey, { price: 2n * MILLI })).error).toMatch(/under the agent's own lowest price, in its auto-apply rules, 0.003 ETH/);
    expect((await bid(r, id, aKey, { price: 3n * MILLI })).status).toBe(200);
    // an agent without rules is held to the smallest job only
    expect((await bid(r, id, bKey, { price: MILLI })).status).toBe(200);
  });

  it("is one per agent: a newer offer replaces the old one while offers are open, kept in the books, a few times at most", async () => {
    const r = await desk({ OFFERS_CHANGES: "2" });
    const { id } = await postJob(r);
    const first = await bid(r, id, aKey, { price: 5n * MILLI });
    expect(first.status).toBe(200);
    // the same words again answer the same
    expect(await bid(r, id, aKey, { price: 5n * MILLI })).toMatchObject({ status: 200, rank: 1 });
    await later(r, 30);
    expect(await bid(r, id, aKey, { price: 4n * MILLI, hours: 12 })).toMatchObject({ status: 200, replaced: true, of: 1, offer: { priceWei: (4n * MILLI).toString(), dueHours: 12 } });
    // asked again with that same signature: the same answer, still saying it replaced the first
    expect(await bid(r, id, aKey, { price: 4n * MILLI, hours: 12 })).toMatchObject({ status: 200, replaced: true, offer: { priceWei: (4n * MILLI).toString() } });
    const o = await page(r, id);
    expect(o.count).toBe(1);
    expect(o.applicants[0]!.offer).toMatchObject({ priceEth: 0.004, dueHours: 12, changes: 1 });
    expect((r.db.q("SELECT bid_wei, how FROM open_job_offers_past WHERE open_id = ?").all(id) as Body[])).toEqual([{ bid_wei: (5n * MILLI).toString(), how: "replaced" }]);
    // an older signature never replaces a newer offer
    expect((await bid(r, id, aKey, { price: 3n * MILLI, at: r.chain.time - 60 })).error).toMatch(/newer offer/);
    await later(r, 30);
    expect((await bid(r, id, aKey, { price: 3500n * MILLI / 1000n })).status).toBe(200);
    await later(r, 30);
    expect((await bid(r, id, aKey, { price: 3n * MILLI })).error).toMatch(/2 times at most/);
    // once offers close, an offer stands as it is
    const soon = await postJob(r, { title: "Offers close soon", closesAt: r.chain.time + HOUR + 60 });
    expect((await bid(r, soon.id, bKey)).status).toBe(200);
    await later(r, 2 * HOUR);
    expect((await bid(r, soon.id, bKey, { price: 3n * MILLI })).error).toMatch(/closed/);
    expect((await page(r, soon.id)).status).toBe("choosing");
  });

  it("can be withdrawn by its agent until it is picked, and made again while offers are open", async () => {
    const r = await desk();
    const { id } = await postJob(r);
    await bid(r, id, aKey);
    await bid(r, id, bKey, { price: 5n * MILLI });
    // only the agent's own signature takes it back
    const at = r.chain.time;
    const forged = await bKey.signMessage({ message: withdrawMessage({ open: id, agent: A1, at }) });
    expect((await post(r, "/v1/openjobs/withdraw", { open: id, agent: A1, at, signature: forged })).status).toBe(401);
    const signature = await aKey.signMessage({ message: withdrawMessage({ open: id, agent: A1, at }) });
    expect(await post(r, "/v1/openjobs/withdraw", { open: id, agent: A1, at, signature })).toMatchObject({ status: 200, withdrawn: true });
    expect(await post(r, "/v1/openjobs/withdraw", { open: id, agent: A1, at, signature })).toMatchObject({ status: 200, withdrawn: true });
    let o = await page(r, id);
    expect(o.count).toBe(1);
    expect(o.applicants.map((x) => x.address)).toEqual([B1]);
    expect((await withdraw(r, id, cKey)).status).toBe(404);
    // made again, it is a new offer
    await later(r, 30);
    expect((await bid(r, id, aKey, { price: 3n * MILLI })).status).toBe(200);
    o = await page(r, id);
    expect(o.applicants.find((x) => x.address === A1)!.offer).toMatchObject({ priceEth: 0.003, changes: 0 });
    // picked, it is the job: nothing left to withdraw
    expect((await lockFor(r, id, B1, { price: 5n * MILLI, dueH: 24 })).a.status).toBe(200);
    expect((await withdraw(r, id, bKey)).error).toMatch(/locked already/);
    // a job with a fixed price has no offer to withdraw
    const fixed = await postJob(r, { offers: false, price: (4n * MILLI).toString(), title: "A job with its price" });
    await bid(r, fixed.id, aKey, { offer: null });
    expect((await withdraw(r, fixed.id, aKey)).error).toMatch(/fixed price/);
  });

  it("ends when the agent said: shown as ended, and never locked after", async () => {
    const r = await desk();
    const { id } = await postJob(r);
    expect((await bid(r, id, aKey, { until: r.chain.time + 2 * HOUR })).status).toBe(200);
    expect((await page(r, id)).applicants[0]!.offer).toMatchObject({ until: new Date((r.chain.time + 2 * HOUR) * 1000).toISOString() });
    expect((await page(r, id)).applicants[0]!.offer!.ended).toBeUndefined();
    await later(r, 3 * HOUR);
    expect((await page(r, id)).applicants[0]!.offer!.ended).toBe(true);
    const locked = await lockFor(r, id, A1, { price: 4n * MILLI, dueH: 24 });
    expect(locked.a.error).toMatch(/offer had ended before the job was locked/);
    expect((await page(r, id)).status).toBe("open");
  });
});

describe("the customer picks an offer", () => {
  it("by locking that offer's price, due that offer's hours later: half of it up front as usual, the burn at its price", async () => {
    const r = await desk();
    const { id } = await postJob(r);
    await bid(r, id, aKey, { price: 5n * MILLI, hours: 24 });
    await bid(r, id, bKey, { price: 4n * MILLI, hours: 12 });
    // the customer picks the lower price
    const hired = await lockFor(r, id, B1, { price: 4n * MILLI, dueH: 12 });
    expect(hired.a).toMatchObject({ status: 200, agent: B1, pickedBy: "customer", burned: true, priceWei: (4n * MILLI).toString(), burnWei: (4n * MILLI / 100n).toString() });
    const o = await page(r, id);
    expect(o).toMatchObject({ status: "hired", job: { n: hired.job, priceEth: 0.004, burnEth: 0.00004 }, picked: { address: B1, by: "customer" } });
    expect(o.note).toMatch(/at 0.004 ETH, the offer the customer picked/);
    const job = await get(r, `/v1/jobs/${hired.job}`);
    expect(job.job).toMatchObject({ customer: BUYER, agentId: B1, open: { id, by: "customer", offers: true } });
    // on the desk: the offer's price, and half of it is what the agent may draw before delivery
    expect(r.chain.jobs.get(hired.job)).toMatchObject({ price: 4n * MILLI, dueAt: expect.any(Number), allowEarly: true });
    expect(() => r.chain.draw(hired.job, 2n * MILLI + 1n, K.early)).toThrow(/OverHalf/);
    r.chain.draw(hired.job, 2n * MILLI, K.early);
    expect(r.chain.jobs.get(hired.job)!.early).toBe(2n * MILLI);
    r.chain.deliver(hired.job);
    r.chain.accept(hired.job);
    await r.engine.watchOnce();
    expect(((await get(r, `/v1/agents/${B1}`)).agent as { settled: number }).settled).toBe(1);
  });

  it("never links a lock that is not the offer: the listing's budget, another price or time, or an agent with no offer", async () => {
    const r = await desk();
    const { id } = await postJob(r);
    await bid(r, id, aKey, { price: 4n * MILLI, hours: 24 });
    expect((await lockFor(r, id, A1, { price: BUDGET, dueH: 24, burn: 0n })).a.error).toMatch(/price or time is not .*offer/);
    expect((await lockFor(r, id, A1, { price: 4n * MILLI, dueH: 48, burn: 0n })).a.error).toMatch(/price or time is not .*offer/);
    expect((await lockFor(r, id, A1, { price: 4n * MILLI, dueH: 24, early: false, burn: 0n })).a.error).toMatch(/early advance/);
    expect((await lockFor(r, id, B1, { price: 4n * MILLI, dueH: 24, burn: 0n })).a.error).toMatch(/made no offer/);
    // each stands on the desk as an ordinary job of the customer's; the listing is still open
    expect((await page(r, id)).status).toBe("open");
    expect((await lockFor(r, id, A1, { price: 4n * MILLI, dueH: 24 })).a.status).toBe(200);
  });

  it("counts the burn at the offer's price: less is not burned", async () => {
    const r = await desk();
    const { id } = await postJob(r);
    await bid(r, id, aKey, { price: 5n * MILLI });
    const short = await lockFor(r, id, A1, { price: 5n * MILLI, dueH: 24, burn: 4n * MILLI / 100n });
    expect(short.a).toMatchObject({ status: 200, burned: false, burnNeededWei: (5n * MILLI / 100n).toString() });
    expect(short.a.burnNote).toMatch(/under the job's 0.00005 ETH/);
  });

  it("links a lock already on its way as the agent changed or withdrew its offer, and not one made long after", async () => {
    const r = await desk();
    const one = await postJob(r, { title: "The first job" });
    await bid(r, one.id, aKey, { price: 5n * MILLI });
    // the customer's lock is mined; a moment later the agent lowers its offer: the lock was at the offer that stood
    const { id: job, hash } = r.chain.lockTx(BUYER, A1, 5n * MILLI, 24 * HOUR, true);
    await later(r, 20);
    expect((await bid(r, one.id, aKey, { price: 4n * MILLI })).status).toBe(200);
    await r.engine.watchOnce();
    expect(await post(r, "/v1/openjobs/hire", { open: one.id, job, lockTx: hash })).toMatchObject({ status: 200, agent: A1, priceWei: (5n * MILLI).toString() });
    // withdrawn long before the lock: not the agent's offer any more
    const two = await postJob(r, { title: "The second job" });
    await bid(r, two.id, aKey, { price: 5n * MILLI });
    expect((await withdraw(r, two.id, aKey)).status).toBe(200);
    await later(r, 600);
    expect((await lockFor(r, two.id, A1, { price: 5n * MILLI, dueH: 24, burn: 0n })).a.error).toMatch(/made no offer/);
  });

  it("expires when the customer locks no offer in time, and nothing was taken from anybody", async () => {
    const r = await desk();
    const { id } = await postJob(r, { closesAt: r.chain.time + 2 * HOUR });
    await bid(r, id, aKey);
    await later(r, 3 * HOUR);
    expect((await page(r, id)).note).toMatch(/Offers closed. The customer can lock the price of one of the 1 offer until/);
    await later(r, 24 * HOUR);
    const o = await page(r, id);
    expect(o.status).toBe("expired");
    expect(o.note).toMatch(/did not lock an offer in time/);
    expect((await lockFor(r, id, A1, { price: 4n * MILLI, dueH: 24, burn: 0n })).a.error).toMatch(/expired/);
  });
});
