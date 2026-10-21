// Open jobs, on the made-up chain: a customer posts a job with its price and deadline, registered agents apply with a
// signature of their own, the applicants are ranked by Factor Score, and the customer picks one by locking the price
// for it (or Factor picks the best score at the close, or once N have applied). Then the rules, each on its own:
// registered agents only, never the customer's own hand, one application per agent, a cap per job, applications that
// close, the lock that must be the listing's terms, and the same answer when anything is asked twice.

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { applyMessage, closeMessage, openJobIdOf, postMessage, readOpenJobs, type OpenJobJson, type OpenJobText, type PickRule } from "../src/openjobs.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

// anvil's public test keys: worth nothing anywhere
const buyerKey = privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
const aKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const bKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const cKey = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
const dKey = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const low = (k: { address: string }) => k.address.toLowerCase();
const BUYER = low(buyerKey), A1 = low(aKey), B1 = low(bKey), C1 = low(cKey), D1 = low(dKey);
const PRICE = ETH / 250n; // 0.004
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
  for (const a of [A1, B1, C1, D1]) chain.register(a);
  const r = await rig("live", { chain, more: { OPENJOBS: "on", ...more } });
  rigs.push(r);
  await r.engine.watchOnce();
  return r;
}

const post = async (r: Rig, path: string, body: unknown): Promise<Body> => { const a = (await r.engine.post(path, body, "1.2.3.4"))!; return { status: a.status, ...(a.body as Body) }; };
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? "")))!; return { status: a.status, ...(a.body as Body) }; };
const page = async (r: Rig, id: string): Promise<OpenJobJson> => { await r.engine.watchOnce(); return (await get(r, `/v1/openjobs/${id}`)).open as OpenJobJson; };

/** A record on the desk: what the Factor Score is worked out from. */
async function record(r: Rig, agent: string, o: { settled: number; customers?: number; feesMilli?: number }): Promise<void> {
  const a = r.chain.agents.get(agent)!;
  a.settled = o.settled;
  a.onTime = o.settled;
  a.customers = o.customers ?? 0;
  a.feesPaid = BigInt(o.feesMilli ?? 0) * 10n ** 15n;
  a.firstSettledAt = o.settled ? r.chain.time - 86_400 : 0;
  r.chain.bond(agent, 1n); // a log of the desk's about the agent: the engine reads its record again
  await r.engine.watchOnce();
}

/** The customer signs a listing. */
async function postJob(r: Rig, o: Partial<OpenJobText> & { key?: Key; pickAfter?: number } = {}): Promise<{ id: string; a: Body; p: OpenJobText }> {
  const key = o.key ?? buyerKey;
  const pick: PickRule = o.pick ?? { by: "customer" };
  const p: OpenJobText = { customer: low(key), price: o.price ?? PRICE.toString(), dueHours: o.dueHours ?? 48, early: o.early ?? true, title: o.title ?? "Check the figures in our quarterly note", brief: o.brief ?? "Every figure against its source, one line each.", closesAt: o.closesAt ?? r.chain.time + 6 * HOUR, pick, at: o.at ?? r.chain.time };
  const signature = await key.signMessage({ message: postMessage(p) });
  const a = await post(r, "/v1/openjobs/post", { customer: p.customer, price: p.price, dueHours: p.dueHours, early: p.early, title: p.title, brief: p.brief, closesAt: p.closesAt, pick: pick.by, ...(pick.by === "best" && pick.after ? { pickAfter: pick.after } : {}), at: p.at, signature });
  return { id: openJobIdOf(p), a, p };
}

/** An agent signs that it applies. */
async function apply(r: Rig, open: string, key: Key, pitch = ""): Promise<{ a: Body; body: Body }> {
  const at = r.chain.time;
  const signature = await key.signMessage({ message: applyMessage({ open, agent: low(key), pitch, at }) });
  const body = { open, agent: low(key), pitch, at, signature };
  return { a: await post(r, "/v1/openjobs/apply", body), body };
}

/** The customer locks the price for an agent on the chain (and its burn), and links it to the listing. */
async function lockFor(r: Rig, open: string, agent: string, o: { price?: bigint; dueH?: number; early?: boolean; customer?: string; burn?: bigint } = {}): Promise<{ job: number; a: Body; lockTx: string }> {
  const { id, hash } = r.chain.lockTx(o.customer ?? BUYER, agent, o.price ?? PRICE, (o.dueH ?? 48) * HOUR, o.early ?? true);
  const burnTx = o.burn === 0n ? undefined : r.chain.transfer(o.customer ?? BUYER, A.burnPot, o.burn ?? PRICE / 100n);
  await r.engine.watchOnce();
  return { job: id, lockTx: hash, a: await post(r, "/v1/openjobs/hire", { open, job: id, lockTx: hash, ...(burnTx ? { burnTx } : {}) }) };
}

describe("the switch and the words", () => {
  it("is off unless OPENJOBS=on, twenty applicants and ten listings a customer by default", () => {
    expect(readOpenJobs({})).toMatchObject({ enabled: false, maxApplicants: 20, perCustomer: 10, lockWindowS: 86_400 });
    expect(readOpenJobs({ OPENJOBS: "on", OPENJOBS_MAX_APPLICANTS: "5", OPENJOBS_PER_CUSTOMER: "3" })).toMatchObject({ enabled: true, maxApplicants: 5, perCustomer: 3 });
    const problems: string[] = [];
    readOpenJobs({ OPENJOBS_MAX_APPLICANTS: "1", OPENJOBS_PER_CUSTOMER: "0" }, problems);
    expect(problems).toHaveLength(2);
  });

  it("signs readable words, the same the kit and the site build", () => {
    const p: OpenJobText = { customer: BUYER, price: "4000000000000000", dueHours: 48, early: true, title: "Check the figures", brief: "", closesAt: 1_800_000_000, pick: { by: "customer" }, at: 1_799_990_000 };
    expect(postMessage(p)).toBe([
      "Factor: post an open job",
      `customer: ${BUYER}`,
      "price: 0.004 ETH",
      "due: 48 hours after it is locked",
      "early: up to half may be drawn before delivery",
      "title: Check the figures",
      "brief: none",
      "applications close: 1800000000",
      "pick: by the customer",
      "at: 1799990000",
    ].join("\n"));
    expect(postMessage({ ...p, pick: { by: "best" } })).toContain("pick: best Factor Score, at the close\n");
    expect(postMessage({ ...p, pick: { by: "best", after: 3 } })).toContain("pick: best Factor Score, at the close or once 3 have applied\n");
    expect(postMessage({ ...p, early: false })).toContain("early: nothing before delivery");
    expect(applyMessage({ open: "0xab", agent: A1, pitch: "", at: 1 })).toBe(`Factor: apply for an open job\nopen job: 0xab\nagent: ${A1}\npitch: none\nat: 1`);
    expect(applyMessage({ open: "0xab", agent: A1, pitch: "I check figures for a living", at: 1 })).toContain("pitch: I check figures for a living\n");
    expect(closeMessage({ open: "0xab", customer: BUYER, at: 1 })).toBe(`Factor: close an open job\nopen job: 0xab\ncustomer: ${BUYER}\nat: 1`);
    expect(openJobIdOf(p)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses every write while it is off, and a new listing while the owner has paused new jobs", async () => {
    const off = await desk({ OPENJOBS: "" });
    expect((await postJob(off)).a.status).toBe(503);
    expect((await get(off, "/v1/state")).openJobs).toMatchObject({ enabled: false, open: 0 });
    const on = await desk();
    turn(on.db, "hiring", false, "Looking at something");
    const paused = (await postJob(on)).a;
    expect(paused).toMatchObject({ status: 409, error: "Looking at something" });
  });
});

describe("posting", () => {
  it("takes a signed listing once, and the same words again give the same listing", async () => {
    const r = await desk();
    const { id, a } = await postJob(r);
    expect(a).toMatchObject({ status: 200, ok: true, open: id, created: true, burnWei: (PRICE / 100n).toString() });
    const twice = await postJob(r);
    expect(twice.a).toMatchObject({ status: 200, open: id, created: false });
    const o = await page(r, id);
    expect(o).toMatchObject({ status: "open", applying: true, customer: BUYER, priceEth: 0.004, dueHours: 48, early: true, count: 0, most: 20, pick: { by: "customer" } });
    expect(o.note).toMatch(/The customer picks an applicant by locking the price for it/);
    // anyone can check what the customer signed
    expect(o.signed!.by).toBe(BUYER);
    expect(await buyerKey.signMessage({ message: o.signed!.message })).toBe(o.signed!.signature);
    // on the board and the first page
    expect(((await get(r, "/v1/openjobs")).items as OpenJobJson[]).map((x) => x.id)).toEqual([id]);
    expect((await get(r, "/v1/state")).openJobs).toMatchObject({ enabled: true, maxApplicants: 20, open: 1, applicants: 0, hired: 0 });
  });

  it("refuses what is not a listing: the price, the times, the pick, and a signature that is not the customer's", async () => {
    const r = await desk();
    expect((await postJob(r, { price: (ETH / 10_000n).toString() })).a.error).toMatch(/smallest job/);
    expect((await postJob(r, { closesAt: r.chain.time + 600 })).a.error).toMatch(/1 hour to 14 days/);
    expect((await postJob(r, { closesAt: r.chain.time + 15 * 86_400 })).a.error).toMatch(/1 hour to 14 days/);
    expect((await postJob(r, { dueHours: 0 })).a.error).toMatch(/dueHours/);
    expect((await postJob(r, { title: "see https://x.com" })).a.error).toMatch(/title/);
    expect((await postJob(r, { pick: { by: "best", after: 21 } })).a.error).toMatch(/pickAfter/);
    expect((await postJob(r, { at: r.chain.time - 3600 })).a.error).toMatch(/ten minutes/);
    // signed by another key than the customer's it names
    const p: OpenJobText = { customer: BUYER, price: PRICE.toString(), dueHours: 48, early: true, title: "Check the figures", brief: "", closesAt: r.chain.time + 6 * HOUR, pick: { by: "customer" }, at: r.chain.time };
    const forged = await post(r, "/v1/openjobs/post", { ...p, pick: "customer", signature: await aKey.signMessage({ message: postMessage(p) }) });
    expect(forged).toMatchObject({ status: 401 });
  });

  it("keeps a customer to OPENJOBS_PER_CUSTOMER listings open at once", async () => {
    const r = await desk({ OPENJOBS_PER_CUSTOMER: "2" });
    expect((await postJob(r, { title: "The first job" })).a.status).toBe(200);
    expect((await postJob(r, { title: "The second job" })).a.status).toBe(200);
    const third = await postJob(r, { title: "The third job" });
    expect(third.a).toMatchObject({ status: 429 });
    expect(third.a.error).toMatch(/2 open jobs at once/);
  });
});

describe("applying", () => {
  it("takes one signed application per registered agent, with its own line, and ranks them by Factor Score", async () => {
    const r = await desk();
    await record(r, A1, { settled: 2, customers: 1, feesMilli: 1 }); // 0.001 ETH of fees: 2 + 25 + 20 + 2 = 49
    await record(r, B1, { settled: 6, customers: 3, feesMilli: 4 }); // 8 + 75 + 60 + 2 = 145
    // C1 has no record at all: 0
    const { id } = await postJob(r);
    const a = await apply(r, id, aKey, "I check figures for a living");
    expect(a.a).toMatchObject({ status: 200, ok: true, open: id, agent: A1, rank: 1, of: 1, listing: "open" });
    expect((await apply(r, id, cKey)).a).toMatchObject({ status: 200, rank: 2, of: 2 });
    expect((await apply(r, id, bKey, "Six jobs settled, every one on time")).a).toMatchObject({ status: 200, rank: 1, of: 3 });
    const o = await page(r, id);
    expect(o.applicants.map((x) => [x.address, x.rank, x.score])).toEqual([[B1, 1, 145], [A1, 2, 49], [C1, 3, 0]]);
    expect(o.applicants[1]).toMatchObject({ pitch: "I check figures for a living", settled: 2, customers: 1, onTimePct: 100, barred: false });
    // the score is the very number the agent's own page shows
    expect(((await get(r, `/v1/agents/${B1}`)).agent as { score: number }).score).toBe(145);
    // anyone can check what each agent signed
    expect(await aKey.signMessage({ message: o.applicants[1]!.signed!.message })).toBe(o.applicants[1]!.signed!.signature);
    // the same signed application again: the same answer, nothing added
    const again = await post(r, "/v1/openjobs/apply", a.body);
    expect(again).toMatchObject({ status: 200, rank: 2, of: 3 });
    // another application by the same agent: one per agent per job
    const second = await apply(r, id, aKey, "A second try");
    expect(second.a.status).toBe(409);
    expect(second.a.error).toMatch(/one application per agent/);
    // an agent's applications, as its console reads them
    const mine = (await get(r, `/v1/openjobs?agent=${A1}`)).items as OpenJobJson[];
    expect(mine.map((x) => x.id)).toEqual([id]);
  });

  it("breaks a tie in score by jobs settled, then by who applied first", async () => {
    const r = await desk();
    const { id } = await postJob(r);
    await apply(r, id, cKey);
    r.chain.mine(1, 30);
    await apply(r, id, aKey);
    const o = await page(r, id);
    expect(o.applicants.map((x) => x.address)).toEqual([C1, A1]);
  });

  it("only takes registered agents, never the customer itself or its own hand, and a pitch without links", async () => {
    const r = await desk({ FACTOR_HOUSE_AGENTS: `${C1},${D1}` });
    const { id } = await postJob(r);
    const stranger = privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6");
    expect((await apply(r, id, stranger)).a.error).toMatch(/not registered/);
    // the customer is an agent on the desk itself, posting a job: it cannot apply for it
    const own = await postJob(r, { key: aKey, title: "A job of an agent's own" });
    expect((await apply(r, own.id, aKey)).a.error).toMatch(/its own job/);
    // B1 is a Factor account whose key is the customer's wallet: the same hand
    r.db.q("INSERT INTO account_keys (account, kind, a, b, credential, added_at) VALUES (?, 1, ?, ?, '0x', 0)").run(B1, `0x${"0".repeat(24)}${BUYER.slice(2)}`, `0x${"0".repeat(64)}`);
    expect((await apply(r, id, bKey)).a.error).toMatch(/same hand/);
    // Factor's own agents never apply for a job one of Factor's own posted
    const house = await postJob(r, { key: cKey, title: "Factor's own job" });
    expect((await apply(r, house.id, dKey)).a.error).toMatch(/same hand/);
    // a pitch is one plain line, without links
    expect((await apply(r, id, aKey, "see my site at example.com")).a.error).toMatch(/pitch/);
    expect((await apply(r, id, aKey, "Plain words only")).a.status).toBe(200);
  });

  it("holds a job to OPENJOBS_MAX_APPLICANTS, and closes it to applications at the time the customer set", async () => {
    const r = await desk({ OPENJOBS_MAX_APPLICANTS: "2" });
    const { id } = await postJob(r, { closesAt: r.chain.time + 2 * HOUR });
    await apply(r, id, aKey);
    await apply(r, id, bKey);
    const full = await apply(r, id, cKey);
    expect(full.a.status).toBe(409);
    expect(full.a.error).toMatch(/2 agents have applied already/);
    expect(await page(r, id)).toMatchObject({ status: "open", applying: false, count: 2 });
    const later = await postJob(r, { title: "A job that closes soon", closesAt: r.chain.time + HOUR + 60 });
    r.chain.mine(1, 2 * HOUR);
    await r.engine.watchOnce();
    expect((await apply(r, later.id, aKey)).a.error).toMatch(/applications for this job have closed/);
    // nobody applied before the close: it expired, and nothing was ever locked
    expect(await page(r, later.id)).toMatchObject({ status: "expired" });
    expect((await page(r, later.id)).note).toMatch(/Nobody applied/);
    // a closed listing is off the board, and still on show=all
    expect(((await get(r, "/v1/openjobs")).items as OpenJobJson[]).map((x) => x.id)).not.toContain(later.id);
    expect(((await get(r, "/v1/openjobs?show=all")).items as OpenJobJson[]).map((x) => x.id)).toContain(later.id);
  });
});

describe("the customer picks", () => {
  it("by locking the price for an applicant: an ordinary job from then on, linked both ways", async () => {
    const r = await desk();
    await record(r, B1, { settled: 6, customers: 3, feesMilli: 4 });
    const { id } = await postJob(r);
    await apply(r, id, aKey);
    await apply(r, id, bKey);
    // the customer picks the one ranked second: its own choice
    const hired = await lockFor(r, id, A1);
    expect(hired.a).toMatchObject({ status: 200, ok: true, open: id, job: hired.job, agent: A1, pickedBy: "customer", burned: true });
    const o = await page(r, id);
    expect(o).toMatchObject({ status: "hired", applying: false, job: { n: hired.job, burnEth: 0.00004 }, picked: { address: A1, by: "customer" } });
    expect(o.applicants.find((x) => x.address === A1)!.picked).toBe(true);
    // the desk job says where it came from, and carries the listing's title and brief as the customer signed them
    const job = await get(r, `/v1/jobs/${hired.job}`);
    expect(job.job).toMatchObject({ customer: BUYER, agentId: A1, title: "Check the figures in our quarterly note", open: { id, applicants: 2, by: "customer" } });
    expect(job.brief).toBe("Every figure against its source, one line each.");
    expect(((await get(r, `/v1/openjobs/${id}`)).job as { n: number }).n).toBe(hired.job);
    // asked again for the same job: the same answer
    expect(await post(r, "/v1/openjobs/hire", { open: id, job: hired.job, lockTx: hired.lockTx })).toMatchObject({ status: 200, job: hired.job });
    // applications are closed once it is hired
    expect((await apply(r, id, cKey)).a.error).toMatch(/hired an agent/);
    // a second lock is an ordinary job of the customer's, never a second job of the listing
    const second = await lockFor(r, id, B1, { burn: 0n });
    expect(second.a.status).toBe(409);
    expect(second.a.error).toMatch(/locked already, as job/);
    expect((await get(r, "/v1/state")).openJobs).toMatchObject({ open: 0, hired: 1 });
    // the agent's own work goes on as for any job: delivered and accepted, its record counts it
    r.chain.deliver(hired.job);
    r.chain.accept(hired.job);
    await r.engine.watchOnce();
    expect(((await get(r, `/v1/agents/${A1}`)).agent as { settled: number }).settled).toBe(1);
  });

  it("refuses a lock that is not the listing's terms: who, for whom, the price, the early switch, the due time", async () => {
    const r = await desk();
    const { id } = await postJob(r);
    await apply(r, id, aKey);
    expect((await lockFor(r, id, B1, { burn: 0n })).a.error).toMatch(/did not apply/);
    expect((await lockFor(r, id, A1, { price: PRICE * 2n, burn: 0n })).a.error).toMatch(/price/);
    expect((await lockFor(r, id, A1, { early: false, burn: 0n })).a.error).toMatch(/early advance/);
    expect((await lockFor(r, id, A1, { dueH: 24, burn: 0n })).a.error).toMatch(/48 hours after the lock/);
    expect((await lockFor(r, id, A1, { customer: C1, burn: 0n })).a.error).toMatch(/not locked by the open job's customer/);
    // each of those stands on the desk as an ordinary job; the listing is still open
    expect((await page(r, id)).status).toBe("open");
    expect((await lockFor(r, id, A1)).a.status).toBe(200);
  });

  it("has a day after the close to lock, then the listing expires", async () => {
    const r = await desk();
    const { id } = await postJob(r, { closesAt: r.chain.time + 2 * HOUR });
    await apply(r, id, aKey);
    r.chain.mine(1, 3 * HOUR);
    const o = await page(r, id);
    expect(o).toMatchObject({ status: "choosing", applying: false });
    expect(o.lockBy).toBeTruthy();
    r.chain.mine(1, 86_400);
    expect((await page(r, id)).status).toBe("expired");
    expect((await lockFor(r, id, A1)).a.error).toMatch(/expired on/);
  });

  it("can take the listing down before anybody is hired", async () => {
    const r = await desk();
    const { id } = await postJob(r);
    await apply(r, id, aKey);
    const at = r.chain.time;
    const forged = await post(r, "/v1/openjobs/close", { open: id, at, signature: await aKey.signMessage({ message: closeMessage({ open: id, customer: BUYER, at }) }) });
    expect(forged.status).toBe(401);
    const closed = await post(r, "/v1/openjobs/close", { open: id, at, signature: await buyerKey.signMessage({ message: closeMessage({ open: id, customer: BUYER, at }) }) });
    expect(closed).toMatchObject({ status: 200, closed: true });
    expect((await page(r, id)).status).toBe("closed");
    expect((await apply(r, id, bKey)).a.error).toMatch(/took this job down/);
    expect((await lockFor(r, id, A1)).a.error).toMatch(/took this job down/);
  });
});

describe("the best score takes it", () => {
  it("once the number the customer named have applied: Factor picks the best Factor Score at once", async () => {
    const r = await desk();
    await record(r, B1, { settled: 6, customers: 3, feesMilli: 4 });
    const { id } = await postJob(r, { pick: { by: "best", after: 2 } });
    expect((await page(r, id)).note).toMatch(/or until 2 have applied/);
    await apply(r, id, aKey);
    expect((await page(r, id)).status).toBe("open");
    const second = await apply(r, id, bKey);
    expect(second.a).toMatchObject({ status: 200, listing: "picked", picked: B1 });
    const o = await page(r, id);
    expect(o).toMatchObject({ status: "picked", applying: false, picked: { address: B1, by: "factor" } });
    expect(o.note).toMatch(/Factor picked .* by the best Factor Score/);
    // applications are closed, and only the picked agent can be locked for
    expect((await apply(r, id, cKey)).a.error).toMatch(/Factor has picked/);
    expect((await lockFor(r, id, A1, { burn: 0n })).a.error).toMatch(/Factor picked/);
    expect((await lockFor(r, id, B1)).a).toMatchObject({ status: 200, agent: B1, pickedBy: "factor" });
    expect((await page(r, id)).status).toBe("hired");
  });

  it("at the close: Factor picks the applicant ranked first then, and the customer can still pick by hand before it", async () => {
    const r = await desk();
    await record(r, A1, { settled: 2, customers: 1, feesMilli: 1 });
    const { id } = await postJob(r, { pick: { by: "best" }, closesAt: r.chain.time + 2 * HOUR });
    await apply(r, id, aKey);
    await apply(r, id, cKey);
    r.chain.mine(1, 3 * HOUR);
    const o = await page(r, id);
    expect(o).toMatchObject({ status: "picked", picked: { address: A1, by: "factor" } });
    expect(Date.parse(o.picked!.at)).toBe(Date.parse(o.closesAt));
    expect((await lockFor(r, id, C1, { burn: 0n })).a.error).toMatch(/Factor picked/);
    // by hand before the close, in a listing of the same rule
    const other = await postJob(r, { pick: { by: "best" }, title: "Another job of the same kind" });
    await apply(r, other.id, aKey);
    await apply(r, other.id, cKey);
    expect((await lockFor(r, other.id, C1)).a).toMatchObject({ status: 200, pickedBy: "customer" });
  });

  it("gives the customer a day after Factor's pick, then the listing expires", async () => {
    const r = await desk();
    const { id } = await postJob(r, { pick: { by: "best", after: 1 } });
    await apply(r, id, aKey);
    expect((await page(r, id)).status).toBe("picked");
    r.chain.mine(1, 86_400 + 60);
    expect((await page(r, id)).status).toBe("expired");
    expect((await lockFor(r, id, A1)).a.error).toMatch(/expired on/);
  });
});

describe("the burn and the books", () => {
  it("counts one transfer to the burn pot for one job only, and never a lock that is already a sub-job or a month", async () => {
    const r = await desk({ SUBJOBS: "on" });
    const one = await postJob(r, { title: "The first open job" });
    const two = await postJob(r, { title: "The second open job" });
    await apply(r, one.id, aKey);
    await apply(r, two.id, aKey);
    const first = await lockFor(r, one.id, A1, { burn: 0n });
    const burnTx = r.chain.transfer(BUYER, A.burnPot, PRICE / 100n);
    expect(await post(r, "/v1/openjobs/hire", { open: one.id, job: first.job, lockTx: first.lockTx, burnTx })).toMatchObject({ status: 200, burned: true });
    const second = await lockFor(r, two.id, A1, { burn: 0n });
    const reused = await post(r, "/v1/openjobs/hire", { open: two.id, job: second.job, lockTx: second.lockTx, burnTx });
    expect(reused).toMatchObject({ status: 200, burned: false });
    expect(reused.burnNote).toMatch(/already counted/);
  });
});
