// The Recoverable mark with Upoch (src/recoverable.ts): the rule agreed with Upoch, each of its four conditions alone,
// the reading of the Epoch contract (made up here) with what happens when it cannot be read, and the mark end to end on
// the made-up chain: in a credit report, on a desk agent's answer, in the list, behind RECOVERABLE=on and the owner's
// switch, and never in the score.

import { getAddress } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import type { CallSpec } from "../src/chain/chain.js";
import { open, EngineDb } from "../src/chain/db.js";
import { judgeWorkflow, linksOf, MARK_LINE, readRecoverable, Recoverable, recoveryOf, RECENT_DAYS, UPOCH_EPOCH, type AgentWallets, type WorkflowRead } from "../src/recoverable.js";
import { turn } from "../src/switches.js";
import { ETH, FakeChain } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

type Body = Record<string, any>;
const DAY = 86_400;
const NOW = 1_800_000_000; // seconds
const OWNER = "0x00000000000000000000000000000000000a0001";
const WALLET = "0x00000000000000000000000000000000000a0002";
const STRANGER = "0x00000000000000000000000000000000000a0003";
const GUARDIAN = "0x00000000000000000000000000000000000a0004";
const EXEC = "0x00000000000000000000000000000000000a0005";

/** A workflow that passes everything but the link, unless a test changes it. */
const wf = (o: Partial<WorkflowRead> = {}): WorkflowRead => ({ id: 5, owner: STRANGER, executors: [EXEC], guardians: [GUARDIAN], status: 0, guardianThreshold: 1, timelockSeconds: 86_400, checkpoints: 13, lastCheckpointAt: NOW - 3600, ...o });
const agent: AgentWallets = { owner: OWNER, agentWallet: WALLET };
const mark = (w: WorkflowRead[], who: AgentWallets = agent) => recoveryOf(who, w, NOW, { readAt: NOW * 1000, explorer: "https://robinhoodchain.blockscout.com" });

describe("the rule", () => {
  it("is Recoverable when one linked workflow is active, recent and has a guardian, with the evidence", () => {
    const m = mark([wf({ executors: [WALLET] })])!;
    expect(m.recoverable).toBe(true);
    expect(m.line).toBe(MARK_LINE);
    expect(m.workflow).toMatchObject({ id: 5, name: "Upoch workflow #5", recoverable: true, active: true, status: "active", recent: true, guardian: true, guardians: 1, guardianThreshold: 1, checkpoints: 13, ageDays: 0, why: [] });
    expect(m.workflow.link).toEqual([{ wallet: WALLET, is: "agentWallet", as: "executor" }]);
    expect(m.workflow.lastCheckpointAt).toBe(new Date((NOW - 3600) * 1000).toISOString());
    expect(m.rule.recentDays).toBe(7);
    expect(m.contractUrl).toBe(`https://robinhoodchain.blockscout.com/address/${getAddress(UPOCH_EPOCH)}`);
  });

  it("links by the identity's owner and by its agentWallet, each as the workflow's owner or an executor", () => {
    expect(linksOf(wf({ owner: OWNER }), agent)).toEqual([{ wallet: OWNER, is: "owner", as: "owner" }]);
    expect(linksOf(wf({ executors: [OWNER] }), agent)).toEqual([{ wallet: OWNER, is: "owner", as: "executor" }]);
    expect(linksOf(wf({ owner: WALLET }), agent)).toEqual([{ wallet: WALLET, is: "agentWallet", as: "owner" }]);
    expect(linksOf(wf({ executors: [EXEC, WALLET.toUpperCase().replace("0X", "0x")] }), agent)).toEqual([{ wallet: WALLET, is: "agentWallet", as: "executor" }]);
    for (const w of [wf({ owner: OWNER }), wf({ executors: [OWNER] }), wf({ owner: WALLET }), wf({ executors: [WALLET] })]) expect(mark([w])!.recoverable).toBe(true);
    // the owner alone, with no agentWallet, still links
    expect(mark([wf({ owner: OWNER })], { owner: OWNER, agentWallet: null })!.recoverable).toBe(true);
  });

  it("shows nothing for an agent no workflow is linked to, however good the workflow", () => {
    expect(mark([wf()])).toBeNull();
    expect(mark([wf({ owner: OWNER })], { owner: null, agentWallet: null })).toBeNull();
    expect(judgeWorkflow(wf(), NOW).recoverable).toBe(false);
    expect(judgeWorkflow(wf(), NOW).why).toContain("not linked to the agent's owner or agentWallet");
  });

  it("is not Recoverable while the workflow is paused", () => {
    const m = mark([wf({ owner: OWNER, status: 1 })])!;
    expect(m.recoverable).toBe(false);
    expect(m.workflow).toMatchObject({ active: false, status: "paused", recent: true, guardian: true, why: ["paused"] });
    expect(m.line).toBe("Not Recoverable now. Upoch workflow #5: paused.");
  });

  it(`is not Recoverable with a stale checkpoint: at most ${RECENT_DAYS} days, the same for every agent`, () => {
    expect(mark([wf({ owner: OWNER, lastCheckpointAt: NOW - 7 * DAY })])!.recoverable).toBe(true);
    const m = mark([wf({ owner: OWNER, lastCheckpointAt: NOW - 7 * DAY - 60 })])!;
    expect(m.recoverable).toBe(false);
    expect(m.workflow.recent).toBe(false);
    expect(m.workflow.why).toEqual(["its last checkpoint is 7.0 days old, more than 7"]);
    expect(mark([wf({ owner: OWNER, lastCheckpointAt: NOW - 12.2 * DAY })])!.workflow.ageDays).toBe(12.2);
  });

  it("never counts checkpoints alone: no guardian, or a threshold of 0, fails however fresh", () => {
    const none = mark([wf({ owner: OWNER, guardians: [], guardianThreshold: 0, timelockSeconds: 0, checkpoints: 212 })])!;
    expect(none.recoverable).toBe(false);
    expect(none.workflow.why).toEqual(["no guardian"]);
    // a guardian on the list with a threshold of 0 cannot restore it
    expect(mark([wf({ owner: OWNER, guardianThreshold: 0 })])!.recoverable).toBe(false);
  });

  it("never counts a timelock alone", () => {
    const m = mark([wf({ owner: OWNER, guardians: [], guardianThreshold: 0, timelockSeconds: 3600 })])!;
    expect(m.recoverable).toBe(false);
    expect(m.workflow).toMatchObject({ guardian: false, timelockSeconds: 3600, why: ["only a timelock, no guardian"] });
  });

  it("is not Recoverable with no checkpoint at all", () => {
    const m = mark([wf({ owner: OWNER, checkpoints: 0, lastCheckpointAt: null })])!;
    expect(m.recoverable).toBe(false);
    expect(m.workflow).toMatchObject({ recent: false, lastCheckpointAt: null, ageDays: null, why: ["no checkpoint yet"] });
  });

  it("needs only ONE linked workflow to pass, and shows that one: the agent's own wallet first, then the freshest", () => {
    const stale = wf({ id: 1, owner: OWNER, lastCheckpointAt: NOW - 22 * DAY });
    const noGuard = wf({ id: 4, owner: OWNER, guardians: [], guardianThreshold: 0 });
    const byOwner = wf({ id: 6, owner: OWNER, lastCheckpointAt: NOW - 60 });
    const byWallet = wf({ id: 5, owner: OWNER, executors: [WALLET], lastCheckpointAt: NOW - 9000 });
    const m = mark([stale, noGuard, byOwner, byWallet])!;
    expect(m.recoverable).toBe(true);
    expect(m.workflow.id).toBe(5);
    expect(m.workflows.map((w) => [w.id, w.recoverable])).toEqual([[5, true], [6, true], [4, false], [1, false]]);
    // with none passing, the one closest to it is shown, with why not
    const none = mark([stale, noGuard])!;
    expect(none.recoverable).toBe(false);
    expect(none.workflow.id).toBe(4);
  });
});

describe("the configuration", () => {
  it("is off unless RECOVERABLE=on, reads Upoch's contract every ten minutes, and refuses what makes no sense", () => {
    expect(readRecoverable({})).toEqual({ enabled: false, contract: UPOCH_EPOCH, everyS: 600 });
    expect(readRecoverable({ RECOVERABLE: "on", RECOVERABLE_EVERY_S: "120" })).toMatchObject({ enabled: true, everyS: 120 });
    const problems: string[] = [];
    readRecoverable({ RECOVERABLE: "yes", RECOVERABLE_EVERY_S: "5" }, problems);
    expect(problems).toHaveLength(2);
  });
});

// ---------- a made-up Epoch contract ----------

interface Wf { owner: string; executors: string[]; guardians: string[]; status: number; threshold: number; timelock: number; checkpoints: { timestamp: number }[] }

class Epoch {
  workflows: Wf[] = [];
  down = false;
  reads = 0;

  add(w: Partial<Wf> & { owner: string }): number {
    this.workflows.push({ executors: [], guardians: [GUARDIAN], status: 0, threshold: 1, timelock: 86_400, checkpoints: [], ...w });
    return this.workflows.length;
  }

  /** What a view call on the contract answers, in viem's shapes; undefined for any other contract. */
  answer(c: CallSpec): unknown {
    if (c.to.toLowerCase() !== UPOCH_EPOCH) return undefined;
    this.reads++;
    if (this.down) throw new Error("fetch failed");
    const a = (c.args ?? []) as bigint[];
    const w = this.workflows[Number(a[0]) - 1];
    if (c.functionName === "workflowCount") return BigInt(this.workflows.length);
    if (!w) throw new Error("UnknownWorkflow");
    if (c.functionName === "getWorkflow") return { owner: w.owner, pendingOwner: "0x0000000000000000000000000000000000000000", status: w.status, policy: { guardianThreshold: w.threshold, ownerApprovalRequired: false, ownerFallbackDelay: 0, timelock: w.timelock, approvalWindow: 0, executionWindow: 0 }, checkpointCount: BigInt(w.checkpoints.length), headSequence: BigInt(Math.max(0, w.checkpoints.length - 1)), headHash: `0x${"00".repeat(32)}`, activeProposalId: 0n, metadataURI: "" };
    if (c.functionName === "getGuardians") return w.guardians;
    if (c.functionName === "getExecutors") return w.executors;
    if (c.functionName === "getCheckpoint") { const p = w.checkpoints[Number(a[1])]; if (!p) throw new Error("UnknownCheckpoint"); return { timestamp: BigInt(p.timestamp) }; }
    throw new Error(`no ${c.functionName}`);
  }
}

describe("the reading", () => {
  const clock = { ms: NOW * 1000 };
  const made = (env: Record<string, string> = { RECOVERABLE: "on" }) => {
    const epoch = new Epoch();
    const db = new EngineDb(open(":memory:"), () => clock.ms);
    const lines: string[] = [];
    const rc = new Recoverable(readRecoverable(env), { db, chain: { read: async <T,>(c: CallSpec) => epoch.answer(c) as T }, explorer: null, now: () => clock.ms, log: (l) => lines.push(l) });
    return { epoch, db, rc, lines };
  };

  it("reads every workflow with view calls and marks from the reading; nothing before the first reading", async () => {
    clock.ms = NOW * 1000;
    const { epoch, rc } = made();
    epoch.add({ owner: STRANGER, executors: [WALLET], checkpoints: [{ timestamp: NOW - 50 * DAY }, { timestamp: NOW - 600 }] });
    epoch.add({ owner: OWNER, guardians: [], threshold: 0, timelock: 3600, checkpoints: [{ timestamp: NOW - 60 }] });
    expect(rc.of(agent)).toBeNull(); // asked before any reading: none yet, and a reading is started
    await new Promise((r) => setTimeout(r, 0));
    await rc.refresh();
    const m = rc.of(agent)!;
    expect(m.recoverable).toBe(true);
    expect(m.workflow).toMatchObject({ id: 1, checkpoints: 2, ageDays: 0, link: [{ wallet: WALLET, is: "agentWallet", as: "executor" }] });
    expect(m.workflows.map((w) => [w.id, w.why])).toEqual([[1, []], [2, ["only a timelock, no guardian"]]]);
    expect(rc.wallets().sort()).toEqual([STRANGER, WALLET].sort());
    expect(rc.about()).toMatchObject({ enabled: true, workflows: 2, recoverableWorkflows: [1] });
  });

  it("keeps the last good reading while the contract cannot be read, then shows nothing rather than a wrong mark", async () => {
    clock.ms = NOW * 1000;
    const { epoch, rc, lines } = made();
    epoch.add({ owner: OWNER, checkpoints: [{ timestamp: NOW - 60 }] });
    await rc.refresh();
    epoch.down = true;
    clock.ms += 11 * 60_000;
    await expect(rc.refresh()).rejects.toThrow();
    expect(lines.some((l) => /could not be read/.test(l))).toBe(true);
    expect(rc.of(agent)!.recoverable).toBe(true); // the last good reading, 11 minutes old
    clock.ms += 25 * 60_000;
    expect(rc.of(agent)).toBeNull(); // 36 minutes without a good reading: no mark at all
    expect(rc.wallets()).toEqual([]);
    epoch.down = false;
    await new Promise((r) => setTimeout(r, 0)); // the reading that ask started, while it was down, has failed by now
    await rc.refresh();
    expect(rc.of(agent)!.recoverable).toBe(true);
  });

  it("never shows a mark when the contract was never read", async () => {
    const { epoch, rc } = made();
    epoch.down = true;
    epoch.add({ owner: OWNER, checkpoints: [{ timestamp: NOW }] });
    await expect(rc.refresh()).rejects.toThrow();
    expect(rc.of(agent)).toBeNull();
  });

  it("reads nothing and shows nothing while off, or while the owner's switch is turned", async () => {
    const off = made({});
    off.epoch.add({ owner: OWNER, checkpoints: [{ timestamp: NOW }] });
    expect(await off.rc.refresh()).toBe("recoverable is off");
    expect(off.epoch.reads).toBe(0);
    expect(off.rc.of(agent)).toBeNull();
    const on = made();
    on.epoch.add({ owner: OWNER, checkpoints: [{ timestamp: NOW }] });
    await on.rc.refresh();
    turn(on.db, "recoverable", false, "a test");
    expect(on.rc.of(agent)).toBeNull();
    turn(on.db, "recoverable", true);
    expect(on.rc.of(agent)!.recoverable).toBe(true);
  });

  it("asks for a new reading in the background when a report finds the last one old, and never waits on it", async () => {
    clock.ms = NOW * 1000;
    const { epoch, rc } = made();
    const w = epoch.add({ owner: OWNER, checkpoints: [{ timestamp: NOW - 60 }] });
    await rc.refresh();
    const before = epoch.reads;
    expect(rc.of(agent)!.recoverable).toBe(true);
    expect(epoch.reads).toBe(before); // fresh: nothing asked
    epoch.workflows[w - 1]!.status = 1;
    clock.ms += 10 * 60_000;
    expect(rc.of(agent)!.recoverable).toBe(true); // answered from the last reading at once
    await new Promise((r) => setTimeout(r, 0));
    await rc.refresh(); // the reading it started, or a new one
    expect(epoch.reads).toBeGreaterThan(before);
    expect(rc.of(agent)!.workflow.status).toBe("paused");
  });
});

// ---------- end to end, on the made-up chain ----------

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

const get = async (r: Rig, path: string): Promise<Body> => { const [p, q = ""] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q), "1.2.3.4"))!; return { status: a.status, ...(a.body as Body) }; };

describe("the mark on Factor", () => {
  const DESK = "0x00000000000000000000000000000000000d0001";
  async function world(more: Record<string, string> = {}) {
    const chain = new FakeChain();
    chain.fund(ETH);
    // an identity on its own (Upoch's case: the agentWallet is a workflow's executor), a desk agent with an identity
    // whose owner owns a workflow, and an identity linked to a workflow with only a timelock
    const upoch = chain.identity(OWNER, WALLET);
    chain.register(DESK);
    const desk = chain.identity(STRANGER, DESK);
    const timelocked = chain.identity(EXEC, EXEC);
    chain.mine(5, 60);
    const epoch = new Epoch();
    epoch.add({ owner: OWNER, executors: [WALLET], checkpoints: [{ timestamp: chain.time - 3600 }] });
    epoch.add({ owner: STRANGER, executors: [GUARDIAN], checkpoints: [{ timestamp: chain.time - 2 * DAY }] });
    epoch.add({ owner: EXEC, guardians: [], threshold: 0, timelock: 3600, checkpoints: [{ timestamp: chain.time - 60 }] });
    chain.extra = { answer: (c) => epoch.answer(c), run: () => undefined };
    const r = await rig("watch", { chain, copilotModel: null, more: { REPORTS: "on", REPORTS_FROM_BLOCK: "0", REPORTS_SPAN: "1000", REPORTS_PRIORS: "off", REPORTS_CONFIRMATIONS: "0", RECOVERABLE: "on", ...more } });
    rigs.push(r);
    await r.engine.watchOnce();
    while (!r.engine.reports!.caughtUp()) await r.engine.reports!.pass();
    await r.engine.reports!.pass();
    r.engine.reports!.scoreAll();
    await r.engine.recoverableOnce();
    return { r, chain, epoch, ids: { upoch, desk, timelocked } };
  }

  it("puts the mark and its evidence in the credit report, and changes no point of the score", async () => {
    const { r, ids } = await world();
    const rep = await get(r, `/v1/reports/agent/${ids.upoch}`);
    expect(rep.status).toBe(200);
    expect(rep.recovery).toMatchObject({ recoverable: true, source: "upoch", line: MARK_LINE, workflow: { id: 1, name: "Upoch workflow #1", status: "active", guardians: 1, guardianThreshold: 1, checkpoints: 1, ageDays: 0, link: [{ wallet: WALLET, is: "agentWallet", as: "executor" }, { wallet: OWNER, is: "owner", as: "owner" }] } });
    expect(rep.recovery.contract).toBe(getAddress(UPOCH_EPOCH));
    // the same number written as 8004:<n> finds the same report
    expect((await get(r, `/v1/reports/agent/8004:${ids.upoch}`)).recovery.recoverable).toBe(true);
    // linked only by a timelock: shown as not Recoverable, with why
    const tl = await get(r, `/v1/reports/agent/${ids.timelocked}`);
    expect(tl.recovery).toMatchObject({ recoverable: false, workflow: { id: 3, why: ["only a timelock, no guardian"] } });
    // the score is the same with the mark off
    const { r: off } = await world({ RECOVERABLE: "off" });
    const plain = await get(off, `/v1/reports/agent/${ids.upoch}`);
    expect(plain.recovery).toBeNull();
    const { recovery: _a, asOf: _b, ...withMark } = rep;
    const { recovery: _c, asOf: _d, ...without } = plain;
    expect(withMark).toEqual(without);
  });

  it("puts the mark on a desk agent's answer by its identity, lists every Recoverable agent, and says it in the state", async () => {
    const { r, ids } = await world();
    const a = await get(r, `/v1/agents/${DESK}`);
    expect(a.recoverable).toMatchObject({ recoverable: true, agentId: String(ids.desk), workflow: { id: 2, link: [{ wallet: STRANGER, is: "owner", as: "owner" }] } });
    const list = await get(r, "/v1/recoverable");
    expect(list).toMatchObject({ enabled: true, source: "upoch", workflows: 3, recoverableWorkflows: [1, 2], identitiesRead: true, total: 2 });
    expect(list.items.map((i: Body) => [i.agentId, i.workflow.id])).toEqual([[String(ids.desk), 2], [String(ids.upoch), 1]]);
    expect(list.items[1].page).toBe(`https://factoragents.fun/reports/${ids.upoch}`);
    expect((await get(r, "/v1/state")).recoverable).toEqual({ enabled: true });
  });

  it("is gone everywhere with RECOVERABLE off or the owner's switch turned, and Upoch's contract is not read", async () => {
    const { r, ids, epoch } = await world({ RECOVERABLE: "off" });
    expect(epoch.reads).toBe(0);
    expect(await get(r, "/v1/recoverable")).toEqual({ status: 200, enabled: false });
    expect((await get(r, `/v1/agents/${DESK}`)).recoverable).toBeUndefined();
    expect((await get(r, "/v1/state")).recoverable).toEqual({ enabled: false });
    const on = await world();
    turn(on.r.db, "recoverable", false, "a test");
    on.r.engine["api"].forget();
    expect((await get(on.r, `/v1/reports/agent/${ids.upoch}`)).recovery).toBeNull();
    expect((await get(on.r, `/v1/agents/${DESK}`)).recoverable).toBeUndefined();
    expect(await get(on.r, "/v1/recoverable")).toEqual({ status: 200, enabled: false });
  });

  it("shows nothing when Upoch's contract cannot be read", async () => {
    const { r, chain, ids, epoch } = await world();
    epoch.down = true;
    chain.mine(1, 40 * 60);
    await r.engine.recoverableOnce().catch(() => undefined);
    r.engine["api"].forget();
    expect((await get(r, `/v1/reports/agent/${ids.upoch}`)).recovery).toBeNull();
    expect((await get(r, "/v1/recoverable")).total).toBe(0);
  });
});
