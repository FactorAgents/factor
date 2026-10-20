// The Factor Score. For an agent it is the desk's own score (FactorDesk.score), and these tests hold it to that: the
// number never differs from the desk's, the income behind it adds up to the desk's own fees and volume whichever way
// each job came, and the limit beside it is the desk's limit. For a firm it is the same formula over the firm's jobs,
// so the firm's bookkeeping is checked against the desk's own over random runs of jobs.

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/desk.js";
import { drawOf, ethWords, factorScore, incomeOf, partsWithWhy, recordOfJobs, summaryOf, type FactorScoreJson, type IncomeSource, type ScoreJob } from "../src/factorscore.js";
import { firmHireMessage, firmMessage, joinMessage, slugOf, type FirmJson, type FirmRecordJson } from "../src/firms.js";
import { planIdOf, planMessage, type PlanText } from "../src/plans.js";
import { profileMessage } from "../src/profiles.js";
import { canDrawOf, limitOf, scoreOf } from "../src/score.js";
import { hireMessage, type HirePlan } from "../src/subjobs.js";
import { A, ETH, FakeChain, K } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

const T0 = 1_791_288_000;
const DAY = 86_400;
const record = (over: Partial<AgentRecord>): AgentRecord => ({
  registered: true, barred: false, firstSettledAt: 0, settled: 0, settledAtHalf: 0, notDelivered: 0, unanswered: 0, customers: 0, onTime: 0, late: 0,
  advancesRepaid: 0, advancesNotRepaid: 0, earlyKept: 0, bond: "0", feesPaid: "0", advancedNow: "0", volume: "0", ...over,
});
const job = (id: number, state: number, price: bigint, o: Partial<ScoreJob> = {}): ScoreJob => ({
  id, state, customer: "0xc1", price: price.toString(), fee: state === 4 ? ((price * 2n) / 100n).toString() : state === 5 ? (price / 100n).toString() : "0", closed_at: T0, early: "0", from_pool: "0", ...o,
});

describe("amounts in words", () => {
  it("reads like the site: six places at most, no trailing zeros", () => {
    expect(ethWords(0n)).toBe("0 ETH");
    expect(ethWords(140_000_000_000_000n)).toBe("0.00014 ETH");
    expect(ethWords(ETH + ETH / 4n)).toBe("1.25 ETH");
    expect(ethWords(3n * ETH)).toBe("3 ETH");
    expect(ethWords(999n)).toBe("under 0.000001 ETH");
  });
});

describe("the income behind a score", () => {
  it("counts each settled job once, under the way it came, and adds up to the desk's fees and volume", () => {
    const jobs = [job(1, 4, ETH / 10n), job(2, 4, ETH / 20n), job(3, 5, ETH / 10n), job(4, 4, ETH / 100n), job(5, 7, ETH), job(6, 1, ETH), job(7, 4, ETH / 50n)];
    const way: Record<number, IncomeSource> = { 1: "jobs", 2: "monthly", 3: "monthly", 4: "subjobs", 7: "firm" };
    const lines = incomeOf(jobs, (id) => way[id] ?? "jobs");
    expect(lines.map((l) => l.source)).toEqual(["jobs", "monthly", "subjobs", "firm"]);
    expect(lines.map((l) => [l.settled, l.settledAtHalf])).toEqual([[1, 0], [1, 1], [1, 0], [1, 0]]);
    // the value is what the jobs paid in full were locked for, as the desk's volume counts it; a refunded or open job adds nothing
    const value = lines.reduce((n, l) => n + BigInt(l.valueWei), 0n);
    expect(value).toBe(ETH / 10n + ETH / 20n + ETH / 100n + ETH / 50n);
    // the fees include the half a rejected job still paid, as the desk's feesPaid does
    const fees = lines.reduce((n, l) => n + BigInt(l.feesWei), 0n);
    expect(fees).toBe(BigInt(recordOfJobs(jobs).feesPaid));
    expect(lines[1]).toMatchObject({ name: "Monthly clients", feesEth: 0.002 });
  });

  it("can be asked for only some ways, as a firm's is", () => {
    expect(incomeOf([job(1, 4, ETH / 10n)], () => "jobs", ["jobs", "monthly"]).map((l) => l.source)).toEqual(["jobs", "monthly"]);
  });
});

describe("a firm's jobs as one record", () => {
  it("follows the desk's own bookkeeping, customers counted once their full jobs paid 0.001 ETH in fees", () => {
    const r = recordOfJobs([
      job(1, 4, ETH / 10n, { customer: "0xa", closed_at: T0 + 50, from_pool: (ETH / 40n).toString() }), // 0.002 in fees: a customer
      job(2, 4, ETH / 100n, { customer: "0xb", closed_at: T0 }), // 0.0002: not yet
      job(3, 5, ETH / 10n, { customer: "0xb" }), // rejected: its fee counts, its customer does not
      job(4, 6, ETH), // declined: nothing
    ]);
    expect(r).toMatchObject({ settled: 2, settledAtHalf: 1, customers: 1, advancesRepaid: 1, firstSettledAt: T0, barred: false });
    expect(r.feesPaid).toBe(((ETH * 2n) / 1000n + (ETH * 2n) / 10_000n + ETH / 1000n).toString());
    expect(r.volume).toBe(((ETH * 11n) / 100n).toString());
  });

  it("is 0 once a job was refunded after drawing on it, from the pool or early", () => {
    const good = [job(1, 4, ETH / 10n)];
    expect(scoreOf(recordOfJobs(good), T0)).toBeGreaterThan(0);
    expect(scoreOf(recordOfJobs([...good, job(2, 7, ETH / 10n, { from_pool: "1" })]), T0)).toBe(0);
    expect(scoreOf(recordOfJobs([...good, job(2, 7, ETH / 10n, { early: "1" })]), T0)).toBe(0);
    // a job nobody drew on that went back costs nothing, as on the desk
    expect(scoreOf(recordOfJobs([...good, job(2, 7, ETH / 10n)]), T0)).toBe(scoreOf(recordOfJobs(good), T0));
  });
});

describe("the parts in words", () => {
  it("say what each part counts, and why a customer who paid is not counted yet", () => {
    const r = record({ settled: 6, feesPaid: "140000000000000", firstSettledAt: T0, advancesRepaid: 1 });
    const parts = partsWithWhy(r, T0 + 2 * DAY + 5, { kind: "agent", distinctCustomers: 2 });
    expect(parts.map((p) => [p.key, p.points])).toEqual([["fees", 0], ["customers", 0], ["jobs", 60], ["days", 4], ["repaid", 10]]);
    expect(parts[0]!.why).toBe("0.00014 ETH in job fees from 6 settled jobs. A point for every 0.0005 ETH, up to 350: the first point comes at 0.0005 ETH.");
    expect(parts[1]!.why).toMatch(/^0 customers whose jobs paid in full have paid 0\.001 ETH or more in fees.* 2 more customers have paid it and count once their jobs reach that/);
    expect(parts[2]!.why).toBe("6 jobs delivered and paid in full. 10 points each, up to 200.");
    expect(parts[3]!.why).toBe("2 days since its first job paid in full. 2 points a day, up to 100.");
    expect(parts[4]!.why).toBe("1 advance from the pool, each paid back by its own job. 10 points each, up to 100.");
    expect(summaryOf(74, parts, null)).toBe("Most of it from jobs settled (60) and advances repaid (10).");
    expect(summaryOf(0, partsWithWhy(record({}), T0, { kind: "agent", distinctCustomers: 0 }), null)).toBe("Nothing yet: it starts with the first job paid in full.");
    // a firm is spoken of as a firm
    expect(partsWithWhy(r, T0, { kind: "firm", distinctCustomers: 0 })[3]!.why).toMatch(/since the firm's first job/);
  });
});

describe("what can be drawn", () => {
  it("is the desk's limit, the bond plus the fees counted once, less what is out, and says so", () => {
    const r = record({ bond: (ETH / 50n).toString(), feesPaid: ((ETH * 8n) / 10_000n).toString(), advancedNow: (ETH / 100n).toString() });
    const income = incomeOf([job(1, 4, ETH / 50n), job(2, 4, ETH / 50n)], (id) => (id === 1 ? "jobs" : "monthly"));
    const d = drawOf(r, income);
    expect(BigInt(d.limitWei)).toBe(limitOf(r));
    expect(BigInt(d.canDrawWei)).toBe(canDrawOf(r));
    expect(d).toMatchObject({ bondEth: 0.02, feesPaidEth: 0.0008, limitEth: 0.0208, outEth: 0.01, canDrawEth: 0.0108, barred: false });
    expect(d.why[0]).toBe("The desk's limit is the bond (0.02 ETH) plus the fees its jobs have paid into the pool (0.0008 ETH), counted once: 0.0208 ETH. 0.01 ETH is out now, so 0.0108 ETH can be drawn.");
    expect(d.why[1]).toBe("Those fees came from jobs (0.0004 ETH), monthly clients (0.0004 ETH). Every job paid adds its fee to the limit and to the score alike.");
    // never that the score moves it
    expect(d.why.join(" ")).toMatch(/nobody can change the rule\. The score does not move it\./);
    expect(d.why.join(" ")).not.toMatch(/score (sets|raises|decides)/i);
  });

  it("is nothing for an agent the desk barred", () => {
    const d = drawOf(record({ barred: true, bond: "5", feesPaid: "5" }), []);
    expect(d).toMatchObject({ limitWei: "0", canDrawWei: "0", barred: true });
    expect(d.why[0]).toMatch(/does not advance it again: its limit is 0/);
  });
});

describe("an agent's Factor Score is the desk's score", () => {
  it("over every kind of record, with the parts and what is taken off adding up to it", () => {
    const cases: AgentRecord[] = [
      record({}),
      record({ settled: 2, customers: 2, advancesRepaid: 1, feesPaid: ((ETH * 4n) / 100n).toString(), firstSettledAt: T0 }),
      record({ settled: 3, settledAtHalf: 1, feesPaid: "900000000000000", firstSettledAt: T0 - 9 * DAY }),
      record({ settled: 30, customers: 14, feesPaid: (ETH / 2n).toString(), firstSettledAt: T0 - 400 * DAY, advancesRepaid: 40 }),
      record({ settled: 4, settledAtHalf: 1, advancesNotRepaid: 1, barred: true, feesPaid: "1000000000000000", firstSettledAt: T0 }),
      record({ settled: 1, settledAtHalf: 5, firstSettledAt: T0 }),
    ];
    for (const r of cases) {
      const f = factorScore({ kind: "agent", record: r, nowS: T0, distinctCustomers: r.customers, income: [], hired: { parts: 0, settled: 0, valueWei: "0", valueEth: 0 }, draw: drawOf(r, []), check: "score(x)" });
      expect(f.score).toBe(scoreOf(r, T0));
      expect(f.of).toBe(1000);
      if (!f.zero) expect(f.score).toBe(Math.max(0, f.parts.reduce((n, p) => n + p.points, 0) - f.less.points));
      else expect(f.score).toBe(0);
    }
  });
});

// ---------- on the made-up chain: every way an agent is paid, and a firm ----------

// anvil's public test keys: worth nothing anywhere
const leadKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const aKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const cKey = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const buyerKey = privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
const LEAD = leadKey.address.toLowerCase(), MA = aKey.address.toLowerCase(), MC = cKey.address.toLowerCase(), BUYER = buyerKey.address.toLowerCase();
type Body = Record<string, any>;

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});
const post = async (r: Rig, path: string, body: unknown): Promise<Body> => { const a = (await r.engine.post(path, body, "1.2.3.4"))!; return { status: a.status, ...(a.body as Body) }; };
const get = async (r: Rig, path: string): Promise<Body> => { const a = (await r.engine.handle(path))!; return { status: a.status, ...(a.body as Body) }; };

describe("on the desk", () => {
  it("brings an agent's jobs, monthly clients, sub-jobs and firm work into its score, and a firm gets one too", async () => {
    const chain = new FakeChain();
    chain.fund(ETH);
    for (const a of [LEAD, MA, MC]) chain.register(a);
    const r = await rig("live", { chain, more: { FIRMS: "on", SUBJOBS: "on", PLANS: "on" } });
    rigs.push(r);
    await r.engine.watchOnce();
    const at = () => r.chain.time;
    const signature = await leadKey.signMessage({ message: profileMessage(LEAD, "report-lead", "Writes market notes", at()) });
    expect((await post(r, "/v1/agents/profile", { address: LEAD, name: "report-lead", does: "Writes market notes", at: at(), signature })).status).toBe(200);

    // a firm: the lead and one member
    const f = { slug: slugOf("Figure Check Co"), name: "Figure Check Co", does: "Market notes where every figure is checked", lead: LEAD, members: [MA], at: at() };
    expect((await post(r, "/v1/firms/form", { ...f, signature: await leadKey.signMessage({ message: firmMessage(f) }) })).status).toBe(200);
    expect((await post(r, "/v1/firms/join", { firm: f.slug, member: MA, at: at(), signature: await aKey.signMessage({ message: joinMessage({ slug: f.slug, lead: LEAD, member: MA, at: at() }) }) })).status).toBe(200);
    // firm work: a job hired through the firm, split into a part for the member and one for an agent outside it
    const firmJob = chain.lock(BUYER, LEAD, ETH / 100n, 2 * DAY, true);
    await r.engine.watchOnce();
    const h = { slug: f.slug, lead: LEAD, job: firmJob, title: "A one-page market note", brief: "", at: at() };
    expect((await post(r, "/v1/firms/hire", { firm: f.slug, job: firmJob, title: h.title, brief: "", at: h.at, signature: await buyerKey.signMessage({ message: firmHireMessage(h) }) })).status).toBe(200);
    const sub = async (agent: string, price: bigint): Promise<number> => {
      const p: HirePlan = { parent: firmJob, agent, price: price.toString(), dueAt: at() + DAY, early: false, title: "Check every figure", brief: "", at: at() };
      const planned = await post(r, "/v1/subjobs/plan", { ...p, signature: await leadKey.signMessage({ message: hireMessage(p) }) });
      expect(planned.status, planned.error).toBe(200);
      const lock = chain.lockTx(LEAD, agent, price, DAY, false);
      expect((await post(r, "/v1/subjobs/link", { plan: planned.plan, job: lock.id, lockTx: lock.hash })).status).toBe(200);
      await r.engine.watchOnce();
      return lock.id;
    };
    const toMember = await sub(MA, ETH / 400n), toOutside = await sub(MC, ETH / 1000n);
    // a job of its own, paid with an advance from the pool, and a month of a monthly plan
    chain.bond(LEAD, ETH / 100n);
    const own = chain.lock(BUYER, LEAD, ETH / 20n, 2 * DAY, false);
    const p: PlanText = { customer: BUYER, agent: LEAD, price: (ETH / 100n).toString(), months: 2, early: true, title: "A weekly note", brief: "", at: at() };
    expect((await post(r, "/v1/plans/create", { ...p, signature: await buyerKey.signMessage({ message: planMessage(p) }) })).status).toBe(200);
    const month = chain.lockTx(BUYER, LEAD, ETH / 100n, 30 * DAY, true);
    const burnTx = chain.transfer(BUYER, A.burnPot, ETH / 10_000n);
    await r.engine.watchOnce();
    expect((await post(r, "/v1/plans/month", { plan: planIdOf(p), job: month.id, lockTx: month.hash, burnTx })).status).toBe(200);
    // the outside agent's own job
    const mcOwn = chain.lock(BUYER, MC, ETH / 500n, DAY, false);
    chain.draw(own, ETH / 200n, K.pool);
    for (const id of [toMember, toOutside, firmJob, own, month.id, mcOwn]) { chain.deliver(id); chain.accept(id); }
    chain.mine(1, 3 * DAY);
    await r.engine.watchOnce();

    // the lead: firm work, a job of its own, a monthly client; two parts it hired out
    const lead = await get(r, `/v1/agents/${LEAD}`);
    const fs = lead.factorScore as FactorScoreJson;
    expect(fs.kind).toBe("agent");
    expect(fs.score).toBe(lead.agent.score);
    expect(fs.income.map((l) => [l.source, l.settled])).toEqual([["jobs", 1], ["monthly", 1], ["subjobs", 0], ["firm", 1]]);
    expect(fs.income.reduce((n, l) => n + BigInt(l.feesWei), 0n)).toBe(chain.agents.get(LEAD)!.feesPaid);
    expect(fs.income.reduce((n, l) => n + BigInt(l.valueWei), 0n)).toBe(chain.agents.get(LEAD)!.volume);
    expect(fs.hired).toMatchObject({ parts: 2, settled: 2 });
    expect(fs.draw).toMatchObject({ limitEth: lead.agent.limitEth, canDrawEth: lead.agent.canDrawEth, bondEth: 0.01 });
    expect(fs.parts.find((x) => x.key === "repaid")!.points).toBe(10);
    // the member: its part of the firm's job is firm work; the outside agent's is a sub-job, beside a job of its own
    expect(((await get(r, `/v1/agents/${MA}`)).factorScore as FactorScoreJson).income.filter((l) => l.settled).map((l) => l.source)).toEqual(["firm"]);
    expect(((await get(r, `/v1/agents/${MC}`)).factorScore as FactorScoreJson).income.filter((l) => l.settled).map((l) => l.source)).toEqual(["jobs", "subjobs"]);

    // the record for any app: the same score, attested, with the Factor Score beside it
    const rec = await get(r, `/v1/record/${LEAD}`);
    expect(rec.factorScore.score).toBe(rec.score);
    expect(rec.attestation?.message.score ?? rec.score).toBe(fs.score);

    // the firm: the desk's formula over the job hired through it, drawn on through its lead
    const firmPage = await get(r, `/v1/firms/${f.slug}`);
    const firm = firmPage.firm as FirmJson;
    const ff = (firmPage.record as FirmRecordJson).factorScore;
    expect(ff.kind).toBe("firm");
    expect(firm.score).toBe(ff.score);
    // one job of 0.01 paid in full, three days ago: 10 for the job, 6 for the days; its 0.0002 of fees is no point yet
    expect(ff.score).toBe(16);
    expect(ff.income.map((l) => [l.source, l.settled])).toEqual([["jobs", 1], ["monthly", 0]]);
    expect(ff.hired).toMatchObject({ parts: 2, toMembers: 1, toOthers: 1 });
    expect(ff.draw.through).toEqual({ address: LEAD, name: "report-lead" });
    expect(ff.draw.limitEth).toBe(lead.agent.limitEth);
    expect(ff.draw.members!.map((m) => [m.address, m.role])).toEqual([[LEAD, "lead"], [MA, "member"]]);
    expect(((await get(r, `/v1/firms/${f.slug}/record`)) as FirmRecordJson).score).toBe(16);
    expect((await get(r, "/v1/firms")).items[0].score).toBe(16);
  });

  it("works a firm's score out of its jobs exactly as the desk works out an agent's, over random runs", async () => {
    // one agent, random jobs from a few customers: its jobs read back from the engine, as a firm's are, give the
    // desk's own record and score
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31), seed % n);
    for (let run = 0; run < 6; run++) {
      const chain = new FakeChain();
      chain.fund(ETH);
      chain.register(LEAD);
      chain.bond(LEAD, ETH / 10n);
      const r = await rig("live", { chain });
      rigs.push(r);
      const customers = ["0x00000000000000000000000000000000000000c1", "0x00000000000000000000000000000000000000c2", "0x00000000000000000000000000000000000000c3"];
      for (let i = 0; i < 12; i++) {
        const price = [ETH / 1000n, ETH / 100n, ETH / 20n][rand(3)]!;
        const id = chain.lock(customers[rand(3)]!, LEAD, price, DAY, true);
        const kind = rand(3);
        if (kind === 1) chain.draw(id, price / 4n, K.pool);
        if (kind === 2) chain.draw(id, price / 4n, K.early);
        const end = rand(10);
        if (end < 6) { chain.deliver(id); chain.accept(id); }
        else if (end < 8) { chain.deliver(id); chain.reject(id); }
        else if (end === 8) chain.decline(id);
        chain.mine(1, rand(2) * DAY);
      }
      await r.engine.watchOnce();
      await r.engine.watchOnce();
      const rows = r.db.q("SELECT id, state, customer, price, fee, closed_at, early, from_pool FROM desk_jobs WHERE agent = ?").all(LEAD) as ScoreJob[];
      const desk = chain.agents.get(LEAD)!;
      const ours = recordOfJobs(rows);
      expect([ours.settled, ours.settledAtHalf, ours.customers, ours.advancesRepaid, ours.firstSettledAt, ours.feesPaid, ours.volume]).toEqual([desk.settled, desk.settledAtHalf, desk.customers, desk.advancesRepaid, desk.firstSettledAt, desk.feesPaid.toString(), desk.volume.toString()]);
      const agent = (await get(r, `/v1/agents/${LEAD}`)).agent;
      expect(scoreOf(ours, chain.time)).toBe(agent.score);
    }
  });
});
