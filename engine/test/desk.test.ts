// The desk through the engine, on the made-up chain: what it writes down of jobs, agents and the ledger, how it
// finds its way back after a reorg, and the jobs it closes itself when their time is up.

import { describe, expect, it } from "vitest";
import { actState } from "../src/chain/act.js";
import { snapshotOf } from "../src/chain/context.js";
import { DeskStore, STATE } from "../src/desk.js";
import { A, ETH, FakeChain, K, S } from "./chain/fake.js";
import { rig, wallet } from "./chain/harness.js";

const AGENT = wallet(0xa1);
const OTHER = wallet(0xa2);
const CUSTOMER = wallet(0xc1);
const P = ETH / 25n; // 0.04 ETH, the rulebook's example

/** The rulebook's example on the made-up chain: 0.04 locked, 0.02 advanced from the pool, delivered. */
function example(chain = new FakeChain()): { chain: FakeChain; id: number } {
  chain.fund(ETH);
  chain.register(AGENT);
  chain.bond(AGENT, ETH / 50n);
  const id = chain.lock(CUSTOMER, AGENT, P);
  chain.draw(id, P / 2n, K.pool);
  chain.deliver(id);
  return { chain, id };
}

describe("what the engine writes down of the desk", () => {
  it("keeps each job as the desk holds it, and each advance", async () => {
    const { chain, id } = example();
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    const store = new DeskStore(r.db);
    const j = store.job(id)!;
    expect(j).toMatchObject({ id, dirty: 0, customer: CUSTOMER, agent: AGENT, price: P.toString(), state: STATE.delivered, early: "0", from_pool: (P / 2n).toString(), allow_early: 0, late: 0 });
    expect(j.delivered_at).toBe(chain.time);
    expect(j.due_at).toBe(chain.jobs.get(id)!.dueAt);
    expect(store.advances(id)).toEqual([expect.objectContaining({ job_id: id, agent: AGENT, kind: K.pool, amount: (P / 2n).toString(), fee: (P / 200n).toString() })]);
    const a = store.agent(AGENT)!;
    expect(a.dirty).toBe(0);
    expect(a.record).toMatchObject({ registered: true, barred: false, bond: (ETH / 50n).toString(), advancedNow: (P / 2n).toString(), settled: 0 });
  });

  it("reads the desk's books at the head", async () => {
    const { chain } = example();
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    const d = snapshotOf(r.db)!.desk;
    expect(d).toMatchObject({ pool: (ETH - P / 2n).toString(), out: (P / 2n).toString(), held: P.toString(), bonds: (ETH / 50n).toString(), owedTotal: "0", jobCount: 1, totalAdvanced: (P / 2n).toString(), totalAdvanceFees: (P / 200n).toString() });
    expect(BigInt(d.balance)).toBe(BigInt(d.pool) + BigInt(d.held) + BigInt(d.bonds) + BigInt(d.owedTotal));
  });

  it("writes one line of the ledger for each thing that happened, in order", async () => {
    const { chain, id } = example();
    chain.accept(id);
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    const lines = new DeskStore(r.db).ledger(50).reverse();
    expect(lines.map((l) => [l.kind, l.job_id, l.amount, l.note])).toEqual([
      ["pool_in", null, ETH.toString(), "gift"],
      ["bond", null, (ETH / 50n).toString(), "added"],
      ["locked", id, P.toString(), ""],
      ["advanced", id, (P / 2n).toString(), "pool"],
      ["delivered", id, P.toString(), ""],
      ["settled", id, (P / 2n).toString(), "repaid"],
    ]);
    // numbered as they are written, and each with its transaction
    expect(lines.map((l) => l.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lines.every((l) => /^0x[0-9a-f]{64}$/.test(l.tx_hash))).toBe(true);
    // the job is closed with what it paid, to the wei of the rulebook's example
    const j = new DeskStore(r.db).job(id)!;
    expect(j).toMatchObject({ state: STATE.settled, paid: ((P * 48n) / 100n).toString(), fee: ((P * 2n) / 100n).toString(), back: "0" });
    expect(j.closed_at).toBe(chain.time);
    expect(new DeskStore(r.db).agent(AGENT)!.record).toMatchObject({ settled: 1, advancesRepaid: 1, feesPaid: ((P * 2n) / 100n).toString(), advancedNow: "0", onTime: 1 });
  });

  it("writes a refund that left the pool unpaid as two lines, and marks the agent", async () => {
    const chain = new FakeChain();
    chain.fund(ETH);
    chain.register(AGENT);
    // a limit of 0.03 from one settled job of 1.5 ETH, and no bond
    const first = chain.lock(CUSTOMER, AGENT, (ETH * 3n) / 2n);
    chain.deliver(first);
    chain.accept(first);
    const id = chain.lock(CUSTOMER, AGENT, ETH / 10n, 3600);
    chain.draw(id, (ETH * 3n) / 100n, K.pool);
    chain.mine(1, 13 * 3600 + 1);
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.sends("refund")).toHaveLength(1);
    await r.engine.watchOnce();
    const store = new DeskStore(r.db);
    const lines = store.ledger(10, { jobId: id }).reverse();
    expect(lines.map((l) => [l.kind, l.amount, l.note])).toEqual([
      ["locked", (ETH / 10n).toString(), ""],
      ["advanced", ((ETH * 3n) / 100n).toString(), "pool"],
      ["refunded", (ETH / 10n).toString(), "drew"],
      ["not_repaid", ((ETH * 3n) / 100n).toString(), JSON.stringify({ fromBond: "0", lost: ((ETH * 3n) / 100n).toString() })],
    ]);
    expect(store.job(id)).toMatchObject({ state: STATE.refunded, back: (ETH / 10n).toString(), not_repaid: ((ETH * 3n) / 100n).toString() });
    expect(store.agent(AGENT)!.record).toMatchObject({ barred: true, advancesNotRepaid: 1, notDelivered: 1 });
    expect(snapshotOf(r.db)!.desk.totalLost).toBe(((ETH * 3n) / 100n).toString());
  });

  it("writes a rejected job and a declined one", async () => {
    const chain = new FakeChain();
    chain.register(AGENT);
    const half = chain.lock(CUSTOMER, AGENT, ETH);
    chain.deliver(half);
    chain.reject(half);
    const no = chain.lock(CUSTOMER, AGENT, ETH / 2n);
    chain.decline(no);
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    const store = new DeskStore(r.db);
    expect(store.job(half)).toMatchObject({ state: STATE.half, back: (ETH / 2n).toString(), paid: ((ETH * 49n) / 100n).toString(), fee: (ETH / 100n).toString() });
    expect(store.job(no)).toMatchObject({ state: STATE.declined, back: (ETH / 2n).toString(), paid: "0" });
    expect(store.ledger(10).map((l) => l.kind)).toEqual(["declined", "locked", "half", "delivered", "locked"]);
    expect(store.agent(AGENT)!.record).toMatchObject({ settledAtHalf: 1, settled: 0 });
  });

  it("reads the same stretch twice and writes nothing twice", async () => {
    const { chain, id } = example();
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    const before = r.db.count("ledger");
    r.db.setCursor("desk", 5000n);
    const again = await r.engine.watchOnce();
    expect(again.fresh).toBe(0);
    expect(r.db.count("ledger")).toBe(before);
    expect(new DeskStore(r.db).advances(id)).toHaveLength(1);
  });

  it("goes on from where it stopped, a few rows at a time, when there is much to read back", async () => {
    const chain = new FakeChain();
    chain.register(AGENT);
    for (let i = 0; i < 7; i++) chain.lock(CUSTOMER, AGENT, ETH / 100n);
    const r = await rig("watch", { chain, more: { ENGINE_DESK_READS_PER_PASS: "3" } });
    await r.engine.watchOnce();
    const dirty = () => (r.sqlite.prepare("SELECT COUNT(*) AS n FROM desk_jobs WHERE dirty = 1").get() as { n: number }).n;
    expect(dirty()).toBe(4);
    await r.engine.watchOnce();
    await r.engine.watchOnce();
    expect(dirty()).toBe(0);
    expect(new DeskStore(r.db).jobCount()).toBe(7);
  });

  it("takes back a job that a reorg removed, and reads every other row again", async () => {
    const chain = new FakeChain();
    chain.register(AGENT);
    const kept = chain.lock(CUSTOMER, AGENT, ETH / 10n, 86400, true);
    chain.mine(30);
    const r = await rig("watch", { chain, more: { ENGINE_CONFIRMATIONS: "0" } });
    await r.engine.watchOnce();
    const gone = chain.lock(CUSTOMER, AGENT, ETH / 5n);
    chain.draw(kept, ETH / 100n, K.early);
    await r.engine.watchOnce();
    expect(new DeskStore(r.db).job(kept)).toMatchObject({ state: STATE.advanced, early: (ETH / 100n).toString() });
    expect(new DeskStore(r.db).job(gone)).not.toBeNull();
    // the chain changes its mind about the last two blocks: the second job never was, and the first was not drawn on
    chain.reorg(2);
    chain.jobs.delete(gone);
    chain.jobCount = 1;
    chain.deskHeld = ETH / 10n;
    chain.jobs.get(kept)!.state = S.locked;
    chain.jobs.get(kept)!.early = 0n;
    chain.mine(3);
    const pass = await r.engine.watchOnce();
    expect(pass.rewoundTo).not.toBeNull();
    const store = new DeskStore(r.db);
    expect(store.job(gone)).toBeNull();
    expect(store.job(kept)).toMatchObject({ state: STATE.locked, early: "0", dirty: 0 });
    expect(store.ledger(10).map((l) => l.kind)).toEqual(["locked"]);
    expect(store.advances(kept)).toEqual([]);
  });
});

describe("closing the jobs that are due", () => {
  it("settles a delivered job once its customer's 24 hours are over, and not a second before", async () => {
    const { chain, id } = example();
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.sends("settle")).toHaveLength(0);
    expect(actState(r.engine.ctx!, "settle_job").result).toBe("no delivered job is past its customer's day");
    chain.mine(1, 24 * 3600 - 1 - 0);
    await r.turn();
    // the delivery was two blocks before the first reading: one second short
    chain.mine(1, 1);
    await r.turn();
    expect(chain.sends("settle")).toHaveLength(1);
    expect(chain.sends("settle")[0].tx.call!.args).toEqual([BigInt(id)]);
    expect(r.db.lastAction("settle_job", String(id))).toMatchObject({ status: "done", mode: "live" });
    // the pool has its advance back and the fee, and the engine's copy says so at once
    expect(chain.pool).toBe(ETH + (P * 2n) / 100n);
    expect(new DeskStore(r.db).job(id)).toMatchObject({ state: STATE.settled, dirty: 0 });
    await r.turn();
    expect(chain.sends("settle")).toHaveLength(1);
  });

  it("refunds a job once its due time and the 12 hours of grace are past", async () => {
    const chain = new FakeChain();
    chain.register(AGENT);
    const id = chain.lock(CUSTOMER, AGENT, ETH / 10n, 3600);
    const r = await rig("live", { chain });
    // refundable from the second after the due time and the grace, which is 13 hours and one second after the lock
    chain.mine(1, 13 * 3600);
    await r.turn();
    expect(chain.sends("refund")).toHaveLength(0);
    chain.mine(1, 1);
    await r.turn();
    expect(chain.sends("refund")).toHaveLength(1);
    expect(chain.paid.get(CUSTOMER)).toBe(ETH / 10n);
    const store = new DeskStore(r.db);
    expect(store.job(id)).toMatchObject({ state: STATE.refunded });
    // the agent never touched it: no mark
    expect(store.agent(AGENT)!.record).toMatchObject({ unanswered: 1, notDelivered: 0, barred: false });
    await r.engine.watchOnce();
    expect(store.ledger(1)[0]).toMatchObject({ kind: "refunded", note: "" });
  });

  it("closes a few jobs a pass, oldest first, and the rest on the following passes", async () => {
    const chain = new FakeChain();
    chain.register(AGENT);
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(chain.lock(CUSTOMER, AGENT, ETH / 100n, 3600 + i * 60));
    chain.mine(1, 14 * 3600);
    const r = await rig("live", { chain, more: { ENGINE_JOBS_PER_PASS: "2" } });
    await r.turn();
    expect(chain.sends("refund").map((s) => Number(s.tx.call!.args![0]))).toEqual(ids.slice(0, 2));
    expect(actState(r.engine.ctx!, "refund_job").result).toContain("2 refunded, 3 more waiting");
    await r.turn();
    await r.turn();
    expect(chain.sends("refund").map((s) => Number(s.tx.call!.args![0]))).toEqual(ids);
  });

  it("does not send what somebody else already did", async () => {
    const { chain, id } = example();
    const r = await rig("live", { chain });
    await r.turn();
    chain.mine(1, 24 * 3600 + 5);
    // the engine's copy still says delivered; the customer accepts in the very block before the engine acts
    chain.accept(id);
    await r.engine.actOnce();
    expect(chain.sends("settle")).toHaveLength(0);
    expect(r.db.lastAction("settle_job", String(id))).toMatchObject({ status: "failed" });
    expect(new DeskStore(r.db).job(id)).toMatchObject({ state: STATE.settled });
    await r.turn();
    expect(r.db.actions("settle_job")).toHaveLength(1);
  });

  it("only shows what it would do in dry mode, and sends nothing in watch mode", async () => {
    const { chain, id } = example();
    chain.mine(1, 25 * 3600);
    const dry = await rig("dry", { chain });
    await dry.turn();
    expect(chain.sends()).toHaveLength(0);
    expect(dry.db.lastAction("settle_job", String(id))).toMatchObject({ status: "dry", mode: "dry" });
    expect(actState(dry.engine.ctx!, "settle_job").result).toContain("would settle 1");
    // and it is not shown again every pass
    await dry.turn();
    expect(dry.db.actions("settle_job")).toHaveLength(1);
    const watch = await rig("watch", { chain });
    await watch.turn();
    expect(watch.db.actions()).toEqual([]);
  });

  it("leaves a job that cannot be closed alone for a while, and goes on with the others", async () => {
    const chain = new FakeChain();
    chain.register(AGENT);
    chain.register(OTHER);
    const stuck = chain.lock(CUSTOMER, AGENT, ETH / 100n, 3600);
    const fine = chain.lock(CUSTOMER, OTHER, ETH / 100n, 3700);
    chain.mine(1, 14 * 3600);
    const r = await rig("live", { chain });
    await r.engine.watchOnce();
    // the engine's copy of the first job is made wrong on purpose: the desk will refuse to refund it
    chain.jobs.get(stuck)!.dueAt += 10 * 86400;
    await r.engine.actOnce();
    expect(r.db.lastAction("refund_job", String(stuck))).toMatchObject({ status: "failed" });
    expect(r.db.lastAction("refund_job", String(fine))).toMatchObject({ status: "done" });
    expect(chain.sends("refund")).toHaveLength(1);
    // read again from the desk, the first job is no longer due, so it is not tried again
    await r.turn();
    expect(r.db.actions("refund_job")).toHaveLength(2);
  });

  it("delivers an advance fee the burn pot was not sent", async () => {
    const chain = new FakeChain();
    chain.potRefuses = true;
    chain.fund(ETH);
    chain.register(AGENT);
    chain.bond(AGENT, ETH);
    const id = chain.lock(CUSTOMER, AGENT, ETH);
    chain.draw(id, ETH / 2n, K.pool);
    expect(chain.owed.get(A.burnPot)).toBe(ETH / 200n);
    const r = await rig("live", { chain });
    await r.turn();
    // still refusing: tried, failed, and left for later
    expect(r.db.lastAction("collect")).toMatchObject({ status: "failed" });
    expect(chain.sends("collect")).toHaveLength(0);
    chain.potRefuses = false;
    r.wall.extra += 3600_000;
    await r.turn();
    expect(chain.sends("collect")).toHaveLength(1);
    expect(chain.sends("collect")[0].tx.call!.args).toEqual([A.burnPot]);
    expect(chain.owed.get(A.burnPot)).toBe(0n);
    expect(actState(r.engine.ctx!, "collect").result).toContain("delivered 0.005 ETH to the burn pot");
    await r.turn();
    expect(chain.sends("collect")).toHaveLength(1);
  });
});
