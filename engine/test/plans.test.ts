// Monthly clients, on the made-up chain: a customer signs a plan, locks each month as an ordinary job, the agent
// starts each month with half, delivers, the customer accepts; next month can be locked once this month is delivered,
// and with a good record the agent can draw on it from the pool before its month begins. Then the rules: what a month
// must be, stopping a plan, a plan that ends or lapses, a plan with a firm, a subscribe link, the burn, the switch.

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { firmHireMessage, firmMessage, joinMessage } from "../src/firms.js";
import { encodePayLink, payLinkMessage, type PayLink } from "../src/pay.js";
import { MONTH_S, monthTitle, planIdOf, planMessage, readPlans, stopMessage, type PlanJson, type PlansSummaryJson, type PlanText } from "../src/plans.js";
import { profileMessage } from "../src/profiles.js";
import { A, ETH, FakeChain, K } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

// anvil's public test keys: worth nothing anywhere
const agentKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const memberKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const buyerKey = privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
const otherKey = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const AGENT = agentKey.address.toLowerCase(), MEMBER = memberKey.address.toLowerCase(), BUYER = buyerKey.address.toLowerCase(), OTHER = otherKey.address.toLowerCase();
const PRICE = ETH / 100n; // 0.01 a month
const DAY = 86_400;
type Key = typeof agentKey;
type Body = Record<string, any>;

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

async function desk(more: Record<string, string> = {}): Promise<Rig> {
  const chain = new FakeChain();
  chain.fund(ETH);
  for (const a of [AGENT, MEMBER, OTHER]) chain.register(a);
  const r = await rig("live", { chain, more: { PLANS: "on", FIRMS: "on", SUBJOBS: "on", ...more } });
  rigs.push(r);
  await r.engine.watchOnce();
  return r;
}

const post = async (r: Rig, path: string, body: unknown): Promise<Body> => { const a = (await r.engine.post(path, body, "1.2.3.4"))!; return { status: a.status, ...(a.body as Body) }; };
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? "")))!; return { status: a.status, ...(a.body as Body) }; };

/** The customer signs a plan. */
async function sign(r: Rig, o: Partial<PlanText> & { key?: Key; link?: string } = {}): Promise<{ id: string; a: Body; p: PlanText }> {
  const key = o.key ?? buyerKey;
  const p: PlanText = { customer: key.address.toLowerCase(), agent: o.agent ?? AGENT, ...(o.firm ? { firm: o.firm } : {}), price: o.price ?? PRICE.toString(), months: o.months ?? 2, early: o.early ?? true, title: o.title ?? "A weekly market note", brief: o.brief ?? "Every Monday: what moved, every figure checked.", at: o.at ?? r.chain.time };
  const signature = await key.signMessage({ message: planMessage(p) });
  const a = await post(r, "/v1/plans/create", { ...p, signature, ...(o.link ? { link: o.link } : {}) });
  return { id: planIdOf(p), a, p };
}

/** The customer locks a month on the chain (and its burn), and links it to the plan. */
async function lockMonth(r: Rig, plan: string, o: { dueInS?: number; price?: bigint; early?: boolean; agent?: string; customer?: string; burn?: bigint } = {}): Promise<{ job: number; a: Body }> {
  const { id, hash } = r.chain.lockTx(o.customer ?? BUYER, o.agent ?? AGENT, o.price ?? PRICE, o.dueInS ?? 30 * DAY, o.early ?? true);
  const burnTx = o.burn === 0n ? undefined : r.chain.transfer(o.customer ?? BUYER, A.burnPot, o.burn ?? PRICE / 100n);
  await r.engine.watchOnce();
  return { job: id, a: await post(r, "/v1/plans/month", { plan, job: id, lockTx: hash, ...(burnTx ? { burnTx } : {}) }) };
}

const page = async (r: Rig, id: string): Promise<PlanJson> => { await r.engine.watchOnce(); return (await get(r, `/v1/plans/${id}`)).plan as PlanJson; };

/** A record good enough for next month early: three settled jobs, and a bond the pool's limit counts. */
async function goodRecord(r: Rig, agent = AGENT): Promise<void> {
  const a = r.chain.agents.get(agent)!;
  a.settled = 5;
  a.onTime = 5;
  r.chain.bond(agent, PRICE);
  await r.engine.watchOnce();
}

describe("the switch and the words", () => {
  it("is off unless PLANS=on, twelve months at most and three settled jobs for next month early by default", () => {
    expect(readPlans({})).toMatchObject({ enabled: false, mostMonths: 12, nextMinSettled: 3 });
    expect(readPlans({ PLANS: "on", PLANS_MAX_MONTHS: "6", PLANS_NEXT_MIN_SETTLED: "0" })).toMatchObject({ enabled: true, mostMonths: 6, nextMinSettled: 0 });
    const problems: string[] = [];
    readPlans({ PLANS_MAX_MONTHS: "1" }, problems);
    expect(problems).toHaveLength(1);
  });

  it("signs readable words, the same the kit and the site build", () => {
    const p: PlanText = { customer: BUYER, agent: AGENT, price: "1000000000000000", months: 3, early: true, title: "A note", brief: "", at: 1_800_000_000 };
    expect(planMessage(p)).toBe(["Factor: a monthly plan", `customer: ${BUYER}`, `agent: ${AGENT}`, "price: 0.001 ETH a month", "months: 3", "early: up to half of each month may be drawn before delivery", "title: A note", "brief: none", "at: 1800000000"].join("\n"));
    expect(planMessage({ ...p, firm: "the-weekly-note", early: false })).toContain(`agent: ${AGENT}\nfirm: the-weekly-note\nprice:`);
    expect(planMessage({ ...p, early: false })).toContain("early: nothing before delivery");
    expect(stopMessage({ plan: "0xab", customer: BUYER, at: 1 })).toBe(`Factor: stop a monthly plan\nplan: 0xab\ncustomer: ${BUYER}\nat: 1`);
    expect(monthTitle(2, 6, "A note")).toBe("Month 2 of 6: A note");
  });

  it("refuses every write while it is off, and says so on the first page", async () => {
    const r = await desk({ PLANS: "" });
    expect((await sign(r)).a.status).toBe(503);
    expect((await get(r, "/v1/state")).plans).toMatchObject({ enabled: false, active: 0 });
  });
});

describe("a plan, month by month", () => {
  it("locks each month as a job, starts each with half, and next month early comes from the pool by the record", async () => {
    const r = await desk();
    const { id, a } = await sign(r);
    expect(a).toMatchObject({ status: 200, ok: true, plan: id, created: true });
    // signed, nothing locked yet
    expect((await page(r, id)).status).toBe("waiting");

    // month 1: locked for 30 days, with its burn
    const m1 = await lockMonth(r, id);
    expect(m1.a).toMatchObject({ status: 200, month: 1, months: 2, job: m1.job, burned: true });
    let p = await page(r, id);
    expect(p).toMatchObject({ status: "active", locked: 1, delivered: 0, priceEth: 0.01, months: 2, early: true });
    expect(p.items[0]).toMatchObject({ month: 1, job: m1.job, state: "locked", burnEth: 0.0001 });
    // the next month waits for this one to be delivered (or for its own month to begin)
    expect(p.next).toMatchObject({ month: 2, open: false });
    expect(p.next!.why).toMatch(/month 1 is not delivered yet/);
    // the month's job says what it is, in the customer's signed words
    const job = await get(r, `/v1/jobs/${m1.job}`);
    expect(job.job).toMatchObject({ title: monthTitle(1, 2, "A weekly market note"), plan: { id, month: 1, months: 2 } });
    expect(job.brief).toBe("Every Monday: what moved, every figure checked.");

    // up front: half of month 1, out of the month's own payment
    r.chain.draw(m1.job, PRICE / 2n, K.early);
    r.chain.deliver(m1.job);
    p = await page(r, id);
    expect(p.items[0]).toMatchObject({ state: "delivered", upFrontEth: 0.005 });
    expect(p.next).toMatchObject({ month: 2, open: true });

    // month 2 is locked ahead, as soon as month 1 is delivered: due 30 days after its lock (the desk's longest)
    const m2 = await lockMonth(r, id);
    expect(m2.a).toMatchObject({ status: 200, month: 2 });
    p = await page(r, id);
    expect(p.items[1]!.state).toBe("locked");
    // next month early: an agent without a record of three settled jobs is not offered it
    expect(p.drawEarly).toMatchObject({ month: 2, job: m2.job, ahead: true, open: false });
    expect(p.drawEarly!.why).toMatch(/settled 0 jobs/);
    await goodRecord(r);
    p = await page(r, id);
    // the desk's own limit: half of the month, the agent's bond and fees, the pool's room, the least of them
    expect(p.drawEarly).toMatchObject({ month: 2, ahead: true, open: true, fromPoolEth: 0.005 });
    r.chain.draw(m2.job, PRICE / 2n, K.pool);
    p = await page(r, id);
    expect(p.items[1]).toMatchObject({ state: "advanced", fromPoolEth: 0.005 });
    expect(p.drawEarly).toMatchObject({ open: false, why: "half of the month is drawn already" });

    // each month is accepted on its own; the pool is repaid out of month 2's own payment
    r.chain.accept(m1.job);
    r.chain.deliver(m2.job);
    r.chain.accept(m2.job);
    p = await page(r, id);
    expect(p).toMatchObject({ status: "done", locked: 2, delivered: 2, settled: 2 });
    expect(p.items.map((x) => x.state)).toEqual(["settled", "settled"]);
    expect(p.next).toBeNull();
    expect(r.chain.agents.get(AGENT)!.advancedNow).toBe(0n);
    // anyone can check what the customer signed
    expect(p.signed.by).toBe(BUYER);
    expect(await buyerKey.signMessage({ message: p.signed.message })).toBe(p.signed.signature);
  });

  it("puts the recurring income on the agent's page, its record and the first page", async () => {
    const r = await desk();
    const signature = await agentKey.signMessage({ message: profileMessage(AGENT, "report-lead", "Writes short market notes", r.chain.time) });
    await post(r, "/v1/agents/profile", { address: AGENT, name: "report-lead", does: "Writes short market notes", at: r.chain.time, signature });
    const { id } = await sign(r, { months: 3 });
    const m1 = await lockMonth(r, id);
    r.chain.deliver(m1.job);
    r.chain.accept(m1.job);
    await r.engine.watchOnce();
    const agentPage = await get(r, `/v1/agents/${AGENT}`);
    expect(agentPage.plans as PlansSummaryJson).toMatchObject({ active: 1, clients: 1, monthlyEth: 0.01, monthsDelivered: 1, monthsSettled: 1, plans: 1 });
    expect((agentPage.plans as PlansSummaryJson).items[0]).toMatchObject({ id, status: "active", months: 3, locked: 1, delivered: 1 });
    const rec = await get(r, "/v1/record/report-lead");
    expect(rec.plans).toEqual({ active: 1, clients: 1, monthlyWei: PRICE.toString(), monthlyEth: "0.01", monthsDelivered: 1, monthsSettled: 1 });
    expect((await get(r, "/v1/state")).plans).toMatchObject({ enabled: true, active: 1, clients: 1, monthlyEth: 0.01 });
    // the lists, by agent and by customer
    expect(((await get(r, `/v1/plans?agent=${AGENT}`)).items as PlanJson[]).map((x) => x.id)).toEqual([id]);
    expect(((await get(r, `/v1/plans?customer=${BUYER}`)).items as PlanJson[]).map((x) => x.id)).toEqual([id]);
    expect((await get(r, "/v1/plans")).status).toBe(400);
    // an agent with no plan shows no figures for it
    expect((await get(r, `/v1/agents/${OTHER}`)).plans).toBeUndefined();
    expect((await get(r, `/v1/record/${OTHER}`)).plans).toMatchObject({ active: 0, monthlyWei: "0" });
  });

  it("locks the next month when its own month begins, due at that month's end", async () => {
    const r = await desk();
    const { id } = await sign(r);
    const m1 = await lockMonth(r, id);
    const start = r.chain.jobs.get(m1.job)!.dueAt - MONTH_S;
    // not delivered, and month 2 has not begun: refused
    expect(String((await lockMonth(r, id)).a.error)).toMatch(/once month 1 is delivered, or from/);
    r.chain.warpTo(start + MONTH_S + 60);
    const m2 = await lockMonth(r, id, { dueInS: start + 2 * MONTH_S - r.chain.time - 1 });
    expect(m2.a.status, m2.a.error).toBe(200);
    // the agent is late with month 1: not delivered by its due time and grace, the desk refunds it, and the plan ends
    r.chain.warpTo(start + MONTH_S + 13 * 3600);
    r.chain.refund(m1.job);
    const p = await page(r, id);
    expect(p.status).toBe("ended");
    expect(p.note).toMatch(/month 1 was not delivered/);
  });
});

describe("what a month must be", () => {
  it("is the plan to the letter: its customer, agent, price, early switch and due time, in order", async () => {
    const r = await desk();
    const { id } = await sign(r);
    expect(String((await lockMonth(r, id, { price: PRICE * 2n })).a.error)).toMatch(/price a month/);
    expect(String((await lockMonth(r, id, { agent: OTHER })).a.error)).toMatch(/another agent/);
    expect(String((await lockMonth(r, id, { customer: OTHER })).a.error)).toMatch(/not locked by the plan's customer/);
    expect(String((await lockMonth(r, id, { early: false })).a.error)).toMatch(/early start/);
    expect(String((await lockMonth(r, id, { dueInS: 7 * DAY })).a.error)).toMatch(/30 days after it is locked/);
    // a job that is not the plan's stands as an ordinary job; the plan still waits for its first month
    expect((await page(r, id)).status).toBe("waiting");
    const m1 = await lockMonth(r, id);
    expect(m1.a.status).toBe(200);
    // asked again for the same job, the same answer; another plan cannot take it
    const again = await post(r, "/v1/plans/month", { plan: id, job: m1.job, lockTx: (await get(r, `/v1/jobs/${m1.job}`)).job.tx });
    expect(again).toMatchObject({ status: 200, month: 1 });
    r.chain.deliver(m1.job);
    await lockMonth(r, id);
    expect(String((await lockMonth(r, id)).a.error)).toMatch(/all locked already/);
  });

  it("is signed by the customer, for an agent on the desk that is not the customer or run by the same hand", async () => {
    const r = await desk();
    const forged = { customer: BUYER, agent: AGENT, price: PRICE.toString(), months: 2, early: true, title: "A note", brief: "", at: r.chain.time };
    expect((await post(r, "/v1/plans/create", { ...forged, signature: await otherKey.signMessage({ message: planMessage(forged) }) })).status).toBe(401);
    expect(String((await sign(r, { agent: BUYER })).a.error)).toMatch(/its own monthly client/);
    expect(String((await sign(r, { agent: "0x00000000000000000000000000000000000000aa" })).a.error)).toMatch(/not registered/);
    expect(String((await sign(r, { months: 1 })).a.error)).toMatch(/2 to 12 months/);
    expect(String((await sign(r, { months: 13 })).a.error)).toMatch(/2 to 12 months/);
    expect(String((await sign(r, { price: "1000" })).a.error)).toMatch(/0.001 ETH at least/);
    expect(String((await sign(r, { title: "x".repeat(61) })).a.error)).toMatch(/3 to 60 characters/);
    expect(String((await sign(r, { at: r.chain.time - 3600 })).a.error)).toMatch(/ten minutes/);
    // the same words twice are the same plan
    const at = r.chain.time;
    const one = await sign(r, { at });
    const two = await sign(r, { at });
    expect(two.a).toMatchObject({ status: 200, plan: one.id, created: false });
  });

  it("lapses when its first month is not locked within a day, or a month is not locked in its month", async () => {
    const r = await desk();
    const { id } = await sign(r);
    r.chain.warpTo(r.chain.time + DAY + 60);
    expect((await page(r, id)).status).toBe("lapsed");
    expect(String((await lockMonth(r, id)).a.error)).toMatch(/lapsed/);
    const two = await sign(r);
    const m1 = await lockMonth(r, two.id);
    r.chain.deliver(m1.job);
    r.chain.accept(m1.job);
    r.chain.warpTo(r.chain.jobs.get(m1.job)!.dueAt + MONTH_S);
    const p = await page(r, two.id);
    expect(p.status).toBe("lapsed");
    expect(p.note).toMatch(/month 2 was not locked in its month/);
  });
});

describe("stopping a plan", () => {
  it("is the customer's signature; no month is locked after it, and a month locked ahead and not started can go back", async () => {
    const r = await desk();
    const { id } = await sign(r, { months: 4 });
    const m1 = await lockMonth(r, id);
    r.chain.deliver(m1.job);
    const m2 = await lockMonth(r, id);
    const at = r.chain.time;
    expect((await post(r, "/v1/plans/stop", { plan: id, at, signature: await otherKey.signMessage({ message: stopMessage({ plan: id, customer: BUYER, at }) }) })).status).toBe(401);
    const stopped = await post(r, "/v1/plans/stop", { plan: id, at, signature: await buyerKey.signMessage({ message: stopMessage({ plan: id, customer: BUYER, at }) }) });
    expect(stopped).toMatchObject({ status: 200, stopped: true, notStarted: [m2.job] });
    const p = await page(r, id);
    expect(p).toMatchObject({ status: "stopped", next: null });
    expect(p.note).toMatch(/after 2 of 4 months/);
    // the agent declines the month it had not started: the customer has all of it back
    expect(r.engine.plans!.stoppedMonth(m2.job)).toMatch(/goes back to them/);
    expect(r.engine.plans!.stoppedMonth(m1.job)).toBeNull();
    r.chain.decline(m2.job);
    await r.engine.watchOnce();
    expect(r.engine.plans!.stoppedMonth(m2.job)).toBeNull();
    // and nothing more is linked
    r.chain.accept(m1.job);
    expect(String((await lockMonth(r, id)).a.error)).toMatch(/stopped this plan/);
  });
});

describe("a plan with a firm", () => {
  it("is hired through the lead, and every month is the firm's job", async () => {
    const r = await desk();
    const form = { slug: "the-weekly-note", name: "The Weekly Note", does: "A one-page market note each week", lead: AGENT, members: [MEMBER], at: r.chain.time };
    expect((await post(r, "/v1/firms/form", { ...form, signature: await agentKey.signMessage({ message: firmMessage(form) }) })).status).toBe(200);
    expect((await post(r, "/v1/firms/join", { firm: form.slug, member: MEMBER, at: r.chain.time, signature: await memberKey.signMessage({ message: joinMessage({ slug: form.slug, lead: AGENT, member: MEMBER, at: r.chain.time }) }) })).status).toBe(200);
    const { id, a } = await sign(r, { firm: "the-weekly-note" });
    expect(a.status, a.error).toBe(200);
    const m1 = await lockMonth(r, id);
    expect(m1.a).toMatchObject({ status: 200, firm: "the-weekly-note" });
    const job = await get(r, `/v1/jobs/${m1.job}`);
    expect(job.job.firm).toMatchObject({ slug: "the-weekly-note", part: false });
    expect(job.job.plan).toMatchObject({ id, month: 1 });
    const p = await page(r, id);
    expect(p.firm).toEqual({ slug: "the-weekly-note", name: "The Weekly Note", house: false });
    const firmPage = await get(r, "/v1/firms/the-weekly-note");
    expect(firmPage.plans).toMatchObject({ active: 1, clients: 1, monthlyEth: 0.01 });
    // a member of the firm cannot be its monthly client
    expect(String((await sign(r, { key: memberKey, firm: "the-weekly-note" })).a.error)).toMatch(/cannot hire itself/);
    expect(String((await sign(r, { firm: "no-such-firm" })).a.error)).toMatch(/no such firm/);
    void firmHireMessage;
  });
});

describe("a subscribe link", () => {
  async function link(r: Rig, more: Partial<PayLink> = {}): Promise<{ token: string; l: PayLink }> {
    const l: PayLink = { v: 1, agent: AGENT, price: PRICE.toString(), title: "A weekly market note", brief: "Every Monday: what moved, every figure checked.", due: 720, early: true, exp: r.chain.time + 30 * DAY, id: "0123456789abcdef", months: 3, ...more };
    return { token: encodePayLink(l, await agentKey.signMessage({ message: payLinkMessage(l) })), l };
  }

  it("is signed by the agent with its months, and a plan bought through it is the link's terms", async () => {
    const r = await desk();
    const { token, l } = await link(r);
    expect(payLinkMessage(l)).toContain("monthly: 3 months, this price each month");
    expect(payLinkMessage({ ...l, months: undefined })).not.toContain("monthly");
    const info = await get(r, `/v1/pay/link/${token}`);
    expect(info.link.months).toBe(3);
    // the plan the link describes
    const { id, a } = await sign(r, { months: 3, link: token });
    expect(a.status, a.error).toBe(200);
    expect((await page(r, id)).via).toBe("link");
    // another plan than the link's terms is refused
    expect(String((await sign(r, { months: 2, link: token })).a.error)).toMatch(/not the link's terms/);
    // a subscribe link is not a deal, and x402 does not carry it
    const lock = r.chain.lockTx(BUYER, AGENT, PRICE, 30 * DAY, true);
    expect(String((await post(r, "/v1/pay/deal", { link: token, job: lock.id, lockTx: lock.hash })).error)).toMatch(/monthly plan/);
    expect((await r.engine.x402(`/v1/x402/${token}`, undefined, "x")).status).toBe(409);
    // a subscribe link's month is 720 hours
    const bad = await link(r, { due: 24 });
    expect((await get(r, `/v1/pay/link/${bad.token}`)).status).toBe(400);
  });
});

describe("the burn", () => {
  it("counts one transfer for one month only", async () => {
    const r = await desk();
    const { id } = await sign(r);
    const { id: job, hash } = r.chain.lockTx(BUYER, AGENT, PRICE, 30 * DAY, true);
    const burnTx = r.chain.transfer(BUYER, A.burnPot, PRICE / 100n);
    await r.engine.watchOnce();
    expect(await post(r, "/v1/plans/month", { plan: id, job, lockTx: hash, burnTx })).toMatchObject({ status: 200, burned: true });
    r.chain.deliver(job);
    const two = r.chain.lockTx(BUYER, AGENT, PRICE, 30 * DAY, true);
    await r.engine.watchOnce();
    expect(await post(r, "/v1/plans/month", { plan: id, job: two.id, lockTx: two.hash, burnTx })).toMatchObject({ status: 200, burned: false, burnNote: expect.stringMatching(/already counted/) });
    // a short burn does not count
    const { id: id3 } = await sign(r, { title: "Another note" });
    const three = await lockMonth(r, id3, { burn: 1n });
    expect(three.a).toMatchObject({ status: 200, burned: false });
  });
});

describe("next month early", () => {
  it("is offered only after every month before it was delivered on time and none was rejected", async () => {
    const r = await desk();
    await goodRecord(r);
    const { id } = await sign(r, { months: 3 });
    const m1 = await lockMonth(r, id);
    // delivered late: past its due time, inside the grace
    r.chain.warpTo(r.chain.jobs.get(m1.job)!.dueAt + 3600);
    r.chain.deliver(m1.job);
    const start = r.chain.jobs.get(m1.job)!.dueAt - MONTH_S;
    await lockMonth(r, id, { dueInS: start + 2 * MONTH_S - r.chain.time });
    const p = await page(r, id);
    expect(p.drawEarly).toMatchObject({ month: 2, open: false });
    expect(p.drawEarly!.why).toMatch(/month 1 of this plan was delivered late/);
  });

  it("stops at the agent's limit with the pool, as every pool advance does", async () => {
    const r = await desk();
    await goodRecord(r);
    const a = r.chain.agents.get(AGENT)!;
    // the bond the record counted is all its limit: 0.01; 0.008 of it out on another job already
    const side = r.chain.lock(OTHER, AGENT, ETH / 50n, DAY, false);
    r.chain.draw(side, (ETH * 8n) / 1000n, K.pool);
    expect(a.advancedNow).toBe((ETH * 8n) / 1000n);
    const { id } = await sign(r);
    const m1 = await lockMonth(r, id);
    r.chain.deliver(m1.job);
    await lockMonth(r, id);
    const p = await page(r, id);
    expect(p.drawEarly).toMatchObject({ open: true, fromPoolEth: 0.002 });
  });
});
