// The agent treasury on the made-up chain: the treasury contract is modelled here (FakeChain.extra) and its logs are written
// in the real encoding, so the engine reads them with the real ABI. What is checked: the switch and the settings; a treasury
// read from the chain, shown on its agent's page, in the list, on the first page and by its own routes with the next run as
// the contract previews it; a compute prepayment becoming the agent's own compute credit, even while the owner's switch is
// off; the keeper running a treasury only when its preview says there is something to do, and not again before its time; each
// step of a run as a receipt on the agent's page and on its credit report, with the score the same to the point; Factor's own
// shown and not counted; the owner's switch; dry mode.

import { encodeAbiParameters, encodeEventTopics, type Abi, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { factorTreasuryAbi } from "../src/abi/index.js";
import type { CallSpec } from "../src/chain/chain.js";
import { readTreasury } from "../src/treasury.js";
import { turn } from "../src/switches.js";
import { ETH, FakeChain } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

const TC = "0x00000000000000000000000000000000007ea501";
const AGENT = "0x00000000000000000000000000000000000b0001";
const OTHER = "0x00000000000000000000000000000000000b0002";
const OWN = "0x00000000000000000000000000000000000a0002"; // one of Factor's own wallets
const GATEWAY = "0x000000000000000000000000000000000000e001";
const LINE_ACCOUNT = "0x00000000000000000000000000000000000b00aa";

interface Rules { floor: bigint; repay: boolean; repayDaily: bigint; compute: boolean; computeDaily: bigint; claims: boolean; claimsDaily: bigint; claimMaxPrice: bigint; claimMinDiscountBps: number; claimMinScore: number; claimDeliveredOnly: boolean; guarantee: boolean; guaranteeUpTo: bigint; vouch: boolean; vouchUpTo: bigint }
const NO_RULES: Rules = { floor: 0n, repay: false, repayDaily: 0n, compute: false, computeDaily: 0n, claims: false, claimsDaily: 0n, claimMaxPrice: 0n, claimMinDiscountBps: 0, claimMinScore: 0, claimDeliveredOnly: false, guarantee: false, guaranteeUpTo: 0n, vouch: false, vouchUpTo: 0n };
interface T { balance: bigint; rules: Rules; debt: bigint; computeToday: bigint; gBond: bigint; vBond: bigint; repaid: bigint; compute: bigint; guarantee: bigint; vouch: bigint; runs: number; deposited: bigint }

/** The treasury contract, as the engine asks things and as the keeper's run changes them: the same order and arithmetic. */
class Model {
  ts = new Map<string, T>();
  constructor(private chain: FakeChain) {
    chain.extra = { answer: (c) => this.answer(c), run: (c, _f, commit, tx) => this.run(c, commit, tx) };
  }

  t(agent: string): T {
    const k = agent.toLowerCase();
    if (!this.ts.has(k)) this.ts.set(k, { balance: 0n, rules: { ...NO_RULES }, debt: 0n, computeToday: 0n, gBond: 0n, vBond: 0n, repaid: 0n, compute: 0n, guarantee: 0n, vouch: 0n, runs: 0, deposited: 0n });
    return this.ts.get(k)!;
  }

  plan(agent: string): { repay: bigint; compute: bigint; guarantee: bigint; vouch: bigint; blocked: boolean } {
    const t = this.t(agent), r = t.rules;
    const min = (a: bigint, b: bigint) => (a < b ? a : b);
    let room = t.balance > r.floor ? t.balance - r.floor : 0n;
    const step = (x: bigint) => (x >= ETH / 10_000n ? x : 0n);
    let repay = 0n;
    if (r.repay) {
      repay = min(t.debt, min(room, r.repayDaily));
      room -= repay;
      if (repay !== t.debt) return { repay, compute: 0n, guarantee: 0n, vouch: 0n, blocked: true };
    }
    const compute = r.compute ? step(min(room, r.computeDaily > t.computeToday ? r.computeDaily - t.computeToday : 0n)) : 0n;
    room -= compute;
    const guarantee = r.guarantee && t.gBond < r.guaranteeUpTo ? step(min(r.guaranteeUpTo - t.gBond, room)) : 0n;
    room -= guarantee;
    const vouch = r.vouch && t.vBond < r.vouchUpTo ? step(min(r.vouchUpTo - t.vBond, room)) : 0n;
    return { repay, compute, guarantee, vouch, blocked: false };
  }

  answer(call: CallSpec): unknown {
    if (call.to.toLowerCase() !== TC) return undefined;
    const fn = call.functionName, a = call.args ?? [];
    const t = this.t(String(a[0] ?? AGENT));
    if (fn === "balanceOf") return t.balance;
    if (fn === "rulesOf") return t.rules;
    if (fn === "totalsOf") return { deposited: t.deposited, withdrawn: 0n, repaid: t.repaid, compute: t.compute, claims: 0n, guarantee: t.guarantee, vouch: t.vouch, runs: t.runs, claimsBought: 0 };
    if (fn === "preview") {
      const p = this.plan(String(a[0]));
      return [p.repay, p.compute, (a[1] as bigint[]).map(() => 0n), p.guarantee, p.vouch, p.blocked];
    }
    return undefined;
  }

  run(call: CallSpec, commit: boolean, tx: string): unknown {
    if (call.to.toLowerCase() !== TC || call.functionName !== "run") return undefined;
    const agent = String(call.args?.[0]).toLowerCase();
    const t = this.t(agent), p = this.plan(agent);
    const spent = p.repay + p.compute + p.guarantee + p.vouch;
    if (spent === 0n) throw new Error("NothingToDo");
    if (!commit) return null;
    if (p.repay) { t.debt -= p.repay; t.repaid += p.repay; this.log("LineRepaid", { agent, account: LINE_ACCOUNT, amount: p.repay, debt: t.debt }, tx); }
    if (p.compute) { t.computeToday += p.compute; t.compute += p.compute; this.log("ComputePrepaid", { agent, gateway: GATEWAY, amount: p.compute }, tx); }
    if (p.guarantee) { t.gBond += p.guarantee; t.guarantee += p.guarantee; this.log("GuaranteeBacked", { agent, deskAddress: agent, amount: p.guarantee, bond: t.gBond }, tx); }
    if (p.vouch) { t.vBond += p.vouch; t.vouch += p.vouch; this.log("VouchBacked", { agent, deskAddress: agent, amount: p.vouch, bond: t.vBond }, tx); }
    t.balance -= spent;
    t.runs += 1;
    this.log("Ran", { agent, by: "0x00000000000000000000000000000000000000b0", spent, balance: t.balance }, tx);
    return null;
  }

  log(eventName: string, args: Record<string, unknown>, tx?: string) {
    const abi = factorTreasuryAbi as Abi;
    const ev = abi.find((x) => x.type === "event" && x.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean; components?: unknown }[] };
    const rest = ev.inputs.filter((i) => !i.indexed);
    return this.chain.push({ address: TC, topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[], data: encodeAbiParameters(rest as never, rest.map((i) => args[i.name]) as never), ...(tx ? { transactionHash: tx } : {}) });
  }

  deposit(agent: string, amount: bigint): void {
    this.chain.mine();
    const t = this.t(agent);
    t.balance += amount;
    t.deposited += amount;
    this.log("Deposited", { agent, from: agent, amount, balance: t.balance });
  }

  withdraw(agent: string, amount: bigint): void {
    this.chain.mine();
    const t = this.t(agent);
    t.balance -= amount;
    this.log("Withdrawn", { agent, to: agent, amount, balance: t.balance });
  }

  setRules(agent: string, r: Partial<Rules>): void {
    this.chain.mine();
    const t = this.t(agent);
    t.rules = { ...NO_RULES, ...r };
    this.log("RulesSet", { agent, rules: t.rules });
  }
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

const ON = { TREASURY: "on", FACTOR_TREASURY: TC, FACTOR_TREASURY_BLOCK: "5000", REPORTS_FACTOR_WALLETS: OWN };

async function world(o: { more?: Record<string, string>; mode?: "live" | "dry" } = {}): Promise<{ r: Rig; chain: FakeChain; model: Model }> {
  const chain = new FakeChain();
  chain.fund(ETH);
  for (const a of [AGENT, OTHER]) chain.register(a);
  const model = new Model(chain);
  const r = await rig(o.mode ?? "live", { chain, more: { ...ON, ...o.more } });
  rigs.push(r);
  const named = (a: string, n: string) => r.db.q("INSERT INTO agent_profiles (address, name, name_key, does, signed_at) VALUES (?, ?, ?, ?, ?)").run(a, n, n, "does work", 1);
  named(AGENT, "saver");
  named(OTHER, "spender");
  await r.engine.watchOnce();
  return { r, chain, model };
}

type Body = Record<string, any>;
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? "")))!; return { status: a.status, ...(a.body as Body) }; };
const ran = (chain: FakeChain) => chain.sends("run").filter((s) => s.tx.call?.to.toLowerCase() === TC);
const E = (n: number) => (ETH * BigInt(Math.round(n * 1e6))) / 1_000_000n;
/** An agent with 1 ETH in, a floor of 0.5, a line owing 0.01 and every use it can have here on. */
const ready = (model: Model, agent = AGENT) => {
  model.deposit(agent, ETH);
  model.t(agent).debt = E(0.01);
  model.setRules(agent, { floor: E(0.5), repay: true, repayDaily: ETH, compute: true, computeDaily: E(0.02), guarantee: true, guaranteeUpTo: E(0.03), vouch: true, vouchUpTo: E(0.04) });
};

describe("the settings", () => {
  it("are off unless TREASURY=on, and say why they cannot run", () => {
    expect(readTreasury({}).enabled).toBe(false);
    expect(readTreasury({ TREASURY: "on" }).note).toMatch(/FACTOR_TREASURY is not set/);
    expect(readTreasury({ TREASURY: "on", FACTOR_TREASURY: TC }).note).toMatch(/FACTOR_TREASURY_BLOCK/);
    expect(readTreasury(ON).note).toBeNull();
    expect(readTreasury(ON)).toMatchObject({ perPass: 5, everyMin: 30 });
    const problems: string[] = [];
    readTreasury({ FACTOR_TREASURY: "nope", FACTOR_TREASURY_BLOCK: "x", TREASURY_PER_PASS: "0", TREASURY_EVERY_MIN: "0" }, problems);
    expect(problems).toHaveLength(4);
  });

  it("off, nothing is read, shown or run, and an agent's route answers 404", async () => {
    const { r, chain, model } = await world({ more: { TREASURY: "" } });
    ready(model);
    await r.turn();
    expect(r.db.count("treasury_agents")).toBe(0);
    expect(ran(chain)).toHaveLength(0);
    expect(await get(r, "/v1/treasury")).toMatchObject({ enabled: false, treasuries: [], totals: null });
    expect(await get(r, "/v1/treasury/about")).toMatchObject({ enabled: false, rules: { maxClaims: 10, order: ["repay", "compute", "claims", "guarantee", "vouch"] } });
    expect((await get(r, "/v1/state")).treasury.enabled).toBe(false);
    expect((await get(r, "/v1/treasury/saver")).status).toBe(404);
    expect((await get(r, "/v1/agents/saver")).treasury).toBeUndefined();
  });
});

describe("a treasury, read from the chain", () => {
  it("shows what it holds, its rules and the next run as the contract previews it", async () => {
    const { r, model } = await world({ mode: "dry" });
    ready(model);
    await r.engine.watchOnce();
    await r.engine.watchOnce();
    const t = (await get(r, "/v1/treasury/saver")).treasury;
    expect(t).toMatchObject({
      agent: AGENT, name: "saver", balance: ETH.toString(), balanceEth: 1, spendable: E(0.5).toString(), factorOwn: false, runs: [],
      rules: { floor: E(0.5).toString(), repay: { on: true, daily: ETH.toString() }, compute: { on: true, daily: E(0.02).toString() }, claims: { on: false }, guarantee: { on: true, upTo: E(0.03).toString() }, vouch: { on: true, upTo: E(0.04).toString() } },
      next: { repay: E(0.01).toString(), compute: E(0.02).toString(), buy: "0", guarantee: E(0.03).toString(), vouch: E(0.04).toString(), total: E(0.1).toString(), lineFirst: false },
    });
    // by its address too, and the next run alone
    expect((await get(r, `/v1/treasury/${AGENT}`)).treasury.balance).toBe(ETH.toString());
    expect(await get(r, "/v1/treasury/saver/preview")).toMatchObject({ agent: AGENT, next: { total: E(0.1).toString() }, order: ["repay", "compute", "claims", "guarantee", "vouch"] });
    expect((await get(r, "/v1/agents/saver")).treasury).toMatchObject({ balance: ETH.toString() });
    const list = await get(r, "/v1/treasury");
    expect(list).toMatchObject({ enabled: true, contract: TC, fromBlock: "5000", totals: { treasuries: 1, held: ETH.toString(), runs: 0, factorOwn: 0 } });
    expect(list.treasuries).toHaveLength(1);
    expect((await get(r, "/v1/state")).treasury).toMatchObject({ enabled: true, totals: { treasuries: 1 } });
    expect(r.lines.some((l) => /\[treasury\] saver's treasury: 1\.0000 ETH put in/.test(l))).toBe(true);
    expect(JSON.stringify([t, list])).not.toMatch(/70%|admin|owner/i);
  });

  it("an address that never used its treasury reads as an empty one, and an unknown name as 404", async () => {
    const { r } = await world();
    expect((await get(r, "/v1/treasury/spender")).treasury).toMatchObject({ agent: OTHER, balance: "0", rules: null, runs: [], next: null });
    expect((await get(r, "/v1/treasury/nobody-here")).status).toBe(404);
    expect((await get(r, "/v1/agents/spender")).treasury).toBeUndefined();
  });

  it("a withdrawal is read at once, and a treasury of Factor's own is shown and not counted", async () => {
    const { r, model } = await world();
    model.deposit(AGENT, ETH);
    model.deposit(OWN, ETH);
    model.withdraw(AGENT, E(0.25));
    await r.engine.watchOnce();
    await r.engine.watchOnce();
    expect((await get(r, "/v1/treasury/saver")).treasury.balance).toBe(E(0.75).toString());
    expect((await get(r, `/v1/treasury/${OWN}`)).treasury.factorOwn).toBe(true);
    expect((await get(r, "/v1/treasury/about")).totals).toMatchObject({ treasuries: 1, held: E(0.75).toString(), factorOwn: 1 });
  });
});

describe("the keeper", () => {
  it("runs a treasury when its preview says there is something to do, each step a receipt, and not again before its time", async () => {
    const { r, chain, model } = await world();
    ready(model);
    await r.turn();
    await r.turn();
    expect(ran(chain)).toHaveLength(1);
    expect(ran(chain)[0]!.tx.call?.args).toEqual([AGENT, []]);
    r.wall.extra += 61_000;
    await r.engine.watchOnce();
    await r.engine.watchOnce();
    const t = (await get(r, "/v1/treasury/saver")).treasury;
    expect(t.balance).toBe(E(0.9).toString());
    expect(t.totals).toMatchObject({ runs: 1, repaid: E(0.01).toString(), compute: E(0.02).toString(), guarantee: E(0.03).toString(), vouch: E(0.04).toString() });
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({ spent: E(0.1).toString(), skipped: 0 });
    expect(t.runs[0].steps.map((s: Body) => s.kind)).toEqual(["repay", "compute", "guarantee", "vouch"]);
    expect(t.runs[0].steps[0].text).toBe("Repaid 0.0100 ETH of its credit line: the line owes nothing");
    expect(t.runs[0].steps[1].text).toBe("Prepaid 0.0200 ETH of compute at the gateway");
    expect(t.runs[0].steps[3].text).toBe("Added 0.0400 ETH to its vouching bond");
    // nothing more to do today: the preview says so, and the keeper sends nothing
    expect(t.next.total).toBe("0");
    r.wall.extra += 3_600_000;
    await r.turn();
    expect(ran(chain)).toHaveLength(1);
    // the next day's compute: a second run, but only once its 30 minutes are over
    model.t(AGENT).computeToday = 0n;
    r.wall.extra += 61_000;
    await r.turn();
    await r.turn();
    expect(ran(chain)).toHaveLength(2);
  });

  it("holds one treasury to TREASURY_EVERY_MIN between runs", async () => {
    const { r, chain, model } = await world();
    model.deposit(AGENT, ETH);
    model.setRules(AGENT, { compute: true, computeDaily: E(0.02) });
    await r.turn();
    await r.turn();
    expect(ran(chain)).toHaveLength(1);
    model.t(AGENT).computeToday = 0n;
    r.wall.extra += 10 * 60_000;
    await r.turn();
    await r.turn();
    expect(ran(chain)).toHaveLength(1);
    r.wall.extra += 21 * 60_000;
    await r.turn();
    await r.turn();
    expect(ran(chain)).toHaveLength(2);
  });

  it("the line first: while it still owes, the run only repays", async () => {
    const { r, chain, model } = await world();
    model.deposit(AGENT, ETH);
    model.t(AGENT).debt = E(0.05);
    model.setRules(AGENT, { repay: true, repayDaily: E(0.01), compute: true, computeDaily: E(0.02) });
    await r.engine.watchOnce();
    await r.engine.watchOnce();
    expect((await get(r, "/v1/treasury/saver")).treasury.next).toMatchObject({ repay: E(0.01).toString(), compute: "0", lineFirst: true });
    await r.turn();
    expect(ran(chain)).toHaveLength(1);
    r.wall.extra += 61_000;
    await r.engine.watchOnce();
    await r.engine.watchOnce();
    expect((await get(r, "/v1/treasury/saver")).treasury.runs[0].steps.map((s: Body) => s.kind)).toEqual(["repay"]);
  });

  it("a compute prepayment becomes the agent's own compute credit, read even while the owner's switch is off", async () => {
    const { r, chain, model } = await world();
    turn(r.db, "treasury", false, "a test");
    model.deposit(AGENT, ETH);
    chain.mine();
    model.log("ComputePrepaid", { agent: AGENT, gateway: GATEWAY, amount: E(0.02) });
    await r.engine.watchOnce();
    const credit = r.engine.gateway!.balanceOf(AGENT) as { balanceUsd: number; lots: Body[] };
    // 0.02 ETH at $2,500
    expect(credit.balanceUsd).toBeCloseTo(50, 5);
    expect(credit.lots[0]).toMatchObject({ paidBy: "treasury", state: "kept" });
    // hidden while the switch is off, and nothing is run
    expect((await get(r, "/v1/treasury/saver")).status).toBe(404);
    expect((await get(r, "/v1/treasury")).treasuries).toEqual([]);
  });

  it("does nothing while the owner's treasury switch is off, and goes on when it is back", async () => {
    const { r, chain, model } = await world();
    ready(model);
    turn(r.db, "treasury", false, "a test");
    await r.turn();
    await r.turn();
    expect(ran(chain)).toHaveLength(0);
    expect((await get(r, "/v1/agents/saver")).treasury).toBeUndefined();
    turn(r.db, "treasury", true);
    await r.turn();
    expect(ran(chain)).toHaveLength(1);
  });

  it("in dry mode it only shows what it would send", async () => {
    const { r, chain, model } = await world({ mode: "dry" });
    ready(model);
    await r.turn();
    await r.turn();
    expect(ran(chain)).toHaveLength(0);
    expect(r.lines.some((l) => /\[dry\] would send treasury run:/.test(l))).toBe(true);
  });
});

describe("the credit report", () => {
  const REPORTS = { REPORTS: "on", REPORTS_FROM_BLOCK: "0", REPORTS_SPAN: "1000", REPORTS_PRIORS: "off", REPORTS_CONFIRMATIONS: "0" };
  async function reported(more: Record<string, string>): Promise<{ r: Rig; id: number }> {
    const chain = new FakeChain();
    chain.fund(ETH);
    chain.register(AGENT);
    const id = chain.identity(AGENT, AGENT);
    const model = new Model(chain);
    const r = await rig("live", { chain, copilotModel: null, more: { ...ON, ...REPORTS, ...more } });
    rigs.push(r);
    ready(model);
    await r.turn();
    await r.turn();
    r.wall.extra += 61_000;
    await r.engine.watchOnce();
    while (!r.engine.reports!.caughtUp()) await r.engine.reports!.pass();
    await r.engine.reports!.pass();
    r.engine.reports!.scoreAll();
    return { r, id };
  }

  it("carries each step of its treasury's runs as a receipt, and changes no point of the score", async () => {
    const { r, id } = await reported({});
    const rep = await get(r, `/v1/reports/agent/${id}`);
    expect(rep.status).toBe(200);
    expect(rep.treasury).toMatchObject({ agent: AGENT, runs: 1 });
    expect(rep.treasury.receipts.map((x: Body) => x.kind).sort()).toEqual(["compute", "guarantee", "repay", "vouch"]);
    expect(rep.treasury.receipts.every((x: Body) => /^0x/.test(x.tx) && x.text.length > 10)).toBe(true);
    // the same chain with the treasury off: the same report to the point, without the receipts
    const off = await reported({ TREASURY: "" });
    const plain = await get(off.r, `/v1/reports/agent/${off.id}`);
    expect(plain.treasury).toBeNull();
    const strip = (x: Body) => { const { treasury: _a, asOf: _b, block: _c, ...rest } = x; return rest; };
    expect(strip(rep)).toEqual(strip(plain));
  });
});

describe("the health answer", () => {
  it("counts treasuries, the ones holding ETH and the runs", async () => {
    const { r, model } = await world();
    ready(model);
    await r.turn();
    await r.turn();
    const h = r.engine.treasury!.health();
    expect(h).toMatchObject({ reading: true, on: true, contract: TC, treasuries: 1, holding: 1, runs: 1, everyMin: 30 });
  });
});
