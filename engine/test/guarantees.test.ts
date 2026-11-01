// Guarantees on the made-up chain: the guarantee contract is modelled here (FakeChain.extra), and its logs are written in
// the real encoding, so the engine reads them with the real ABI. What is checked: the switch and the settings; a bond,
// an offer and a cover read and shown on the agent's page, the job's page, the lists and the first page; the keeper
// tying a reservation to the job locked on its terms (and not to another), closing a covered job that was delivered,
// refunding and paying one that was not in one call, and letting an untied reservation lapse; the record; the owner's
// switch.

import { encodeAbiParameters, encodeEventTopics, type Abi, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { factorGuaranteeAbi } from "../src/abi/index.js";
import type { CallSpec } from "../src/chain/chain.js";
import { readGuarantees, sharePct } from "../src/guarantees.js";
import { turn } from "../src/switches.js";
import { ETH, FakeChain } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

const G = "0x0000000000000000000000000000000000006a7e";
const AGENT = "0x00000000000000000000000000000000000a6e71";
const OTHER = "0x00000000000000000000000000000000000a6e72";
const BUYER = "0x0000000000000000000000000000000000b0e701";
const STRANGER = "0x0000000000000000000000000000000000b0e702";
const DAY = 86_400;
const FEE = (x: bigint) => x / 100n;
const STATE = { reserved: 1, bound: 2, released: 3, paid: 4, declined: 5, lapsed: 6 } as const;

interface ModelCover { id: number; customer: string; agent: string; price: bigint; dueAt: number; early: boolean; amount: bigint; fee: bigint; afterJob: number; expiresAt: number; state: number; job: number }
interface ModelBond { bond: bigint; reserved: bigint; offer: bigint; covers: number; released: number; paid: number; declined: number; lapsed: number; coveredTotal: bigint; paidTotal: bigint; feesEarned: bigint }

/** The guarantee contract, as the engine asks it things and as the keeper's calls change it. */
class Model {
  covers: ModelCover[] = [];
  bonds = new Map<string, ModelBond>();
  scores = new Map<string, number>();
  covered = 0n; paidAll = 0n; fees = 0n; burned = 0n;
  constructor(private chain: FakeChain) {
    chain.extra = { answer: (c) => this.answer(c), run: (c, _f, commit, tx) => this.run(c, commit, tx) };
  }

  b(agent: string): ModelBond {
    const a = agent.toLowerCase();
    if (!this.bonds.has(a)) this.bonds.set(a, { bond: 0n, reserved: 0n, offer: 0n, covers: 0, released: 0, paid: 0, declined: 0, lapsed: 0, coveredTotal: 0n, paidTotal: 0n, feesEarned: 0n });
    return this.bonds.get(a)!;
  }

  answer(call: CallSpec): unknown {
    if (call.to.toLowerCase() !== G) return undefined;
    const fn = call.functionName, a = call.args ?? [];
    if (fn === "bondOf") return this.b(String(a[0]));
    if (fn === "scoreOf") return BigInt(this.scores.get(String(a[0]).toLowerCase()) ?? 0);
    if (fn === "keyOf") return "0x0000000000000000000000000000000000000000";
    if (fn === "cover") {
      const c = this.covers.find((x) => x.id === Number(a[0]));
      return c ? { customer: c.customer, dueAt: c.dueAt, expiresAt: c.expiresAt, state: c.state, allowEarly: c.early, agent: c.agent, price: c.price, amount: c.amount, fee: c.fee, afterJob: BigInt(c.afterJob), job: BigInt(c.job) } : { state: 0, afterJob: 0n, job: 0n };
    }
    const open = this.covers.filter((c) => c.state === STATE.reserved || c.state === STATE.bound);
    const totals: Record<string, bigint> = {
      bonds: [...this.bonds.values()].reduce((n, x) => n + x.bond, 0n), reserved: open.reduce((n, c) => n + c.amount, 0n), feesHeld: open.reduce((n, c) => n + c.fee, 0n),
      owedTotal: 0n, totalCovered: this.covered, totalPaid: this.paidAll, totalFees: this.fees, totalBurned: this.burned, coverCount: BigInt(this.covers.length),
    };
    return fn in totals ? totals[fn] : undefined;
  }

  run(call: CallSpec, commit: boolean, tx: string): unknown {
    if (call.to.toLowerCase() !== G) return undefined;
    const fn = call.functionName, a = call.args ?? [];
    if (fn === "bind") {
      const c = this.covers.find((x) => x.id === Number(a[0]))!;
      const job = this.chain.jobs.get(Number(a[1]));
      if (c.state !== STATE.reserved) throw new Error("WrongState");
      if (this.chain.time > c.expiresAt) throw new Error("Expired");
      if (!job || Number(a[1]) <= c.afterJob || job.customer !== c.customer || job.agent !== c.agent || job.price !== c.price || job.dueAt !== c.dueAt || job.allowEarly !== c.early) throw new Error("NotTheJob");
      if (!commit) return null;
      c.state = STATE.bound;
      c.job = Number(a[1]);
      const b = this.b(c.agent);
      b.covers++;
      b.coveredTotal += c.amount;
      this.covered += c.amount;
      this.log("Bound", { id: BigInt(c.id), job: BigInt(c.job), agent: c.agent }, tx);
      return null;
    }
    if (fn === "lapse") {
      const c = this.covers.find((x) => x.id === Number(a[0]))!;
      if (c.state !== STATE.reserved || this.chain.time <= c.expiresAt) throw new Error("TooSoon");
      if (!commit) return null;
      this.end(c, STATE.lapsed, tx);
      return null;
    }
    if (fn === "close") {
      const c = this.covers.find((x) => x.job === Number(a[0]) && x.state === STATE.bound);
      if (!c) throw new Error("NoCover");
      const j = this.chain.jobs.get(c.job)!;
      let state = j.state;
      if ((state === 1 || state === 2) && this.chain.time > j.dueAt + 12 * 3600) state = 7;
      if (state === 3 && this.chain.time >= j.deliveredAt + DAY) state = 4;
      if (![4, 5, 6, 7].includes(state)) throw new Error("NotFinished");
      if (!commit) return null;
      if (state === 7 && j.state !== 7) (this.chain as unknown as { refundJob(id: number, tx: string): void }).refundJob(c.job, tx);
      if (state === 4 && j.state !== 4) (this.chain as unknown as { settleJob(id: number, tx: string): void }).settleJob(c.job, tx);
      this.end(c, state === 7 ? STATE.paid : state === 6 ? STATE.declined : STATE.released, tx);
      return null;
    }
    return undefined;
  }

  private end(c: ModelCover, how: number, tx: string): void {
    const b = this.b(c.agent);
    c.state = how;
    b.reserved -= c.amount;
    let paid = 0n, toAgent = 0n, burned = 0n, back = 0n;
    if (how === STATE.paid) { b.bond -= c.amount; b.paid++; b.paidTotal += c.amount; this.paidAll += c.amount; paid = c.amount; }
    if (how === STATE.released) b.released++;
    if (how === STATE.lapsed) b.lapsed++;
    if (how === STATE.declined) { b.declined++; back = c.fee; } else { burned = c.fee / 2n; toAgent = c.fee - burned; b.feesEarned += toAgent; this.fees += c.fee; this.burned += burned; }
    this.log("Closed", { id: BigInt(c.id), job: BigInt(c.job), agent: c.agent, how, paid, toAgent, burned, feeBack: back }, tx);
  }

  log(eventName: string, args: Record<string, unknown>, tx?: string) {
    const abi = factorGuaranteeAbi as Abi;
    const ev = abi.find((x) => x.type === "event" && x.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
    const rest = ev.inputs.filter((i) => !i.indexed);
    return this.chain.push({ address: G, topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[], data: encodeAbiParameters(rest, rest.map((i) => args[i.name]) as never), ...(tx ? { transactionHash: tx } : {}) });
  }

  bond(agent: string, amount: bigint): void {
    this.chain.mine();
    const b = this.b(agent);
    b.bond += amount;
    this.log("BondAdded", { agent, from: agent, amount, bond: b.bond });
  }

  offer(agent: string, amount: bigint): void {
    this.chain.mine();
    this.b(agent).offer = amount;
    this.log("OfferSet", { agent, offer: amount });
  }

  reserve(customer: string, agent: string, price: bigint, dueIn: number, amount: bigint, early = false): ModelCover {
    this.chain.mine();
    const c: ModelCover = { id: this.covers.length + 1, customer: customer.toLowerCase(), agent: agent.toLowerCase(), price, dueAt: this.chain.time + dueIn, early, amount, fee: FEE(amount), afterJob: this.chain.jobCount, expiresAt: this.chain.time + 3600, state: STATE.reserved, job: 0 };
    this.covers.push(c);
    this.b(agent).reserved += amount;
    this.log("Reserved", { id: BigInt(c.id), customer, agent, amount, fee: c.fee, price, dueAt: BigInt(c.dueAt), allowEarly: early, expiresAt: BigInt(c.expiresAt) });
    return c;
  }

  /** The customer's lock on exactly the reserved terms. */
  lockFor(c: ModelCover): number {
    return this.chain.lock(c.customer, c.agent, c.price, c.dueAt - this.chain.time, c.early);
  }
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

const ON = { GUARANTEES: "on", FACTOR_GUARANTEE: G, FACTOR_GUARANTEE_BLOCK: "5000" };

async function world(o: { more?: Record<string, string>; mode?: "live" | "dry" } = {}): Promise<{ r: Rig; chain: FakeChain; model: Model }> {
  const chain = new FakeChain();
  chain.fund(ETH);
  chain.register(AGENT);
  chain.register(OTHER);
  const model = new Model(chain);
  model.scores.set(AGENT, 420);
  const r = await rig(o.mode ?? "live", { chain, more: { ...ON, ...o.more } });
  rigs.push(r);
  r.db.q("INSERT INTO agent_profiles (address, name, name_key, does, signed_at) VALUES (?, ?, ?, ?, ?)").run(AGENT, "report-lead", "report-lead", "writes weekly reports", 1);
  await r.engine.watchOnce();
  return { r, chain, model };
}

type Body = Record<string, any>;
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? "")))!; return { status: a.status, ...(a.body as Body) }; };

describe("the settings", () => {
  it("are off unless GUARANTEES=on, and say why they cannot run", () => {
    expect(readGuarantees({}).enabled).toBe(false);
    expect(readGuarantees({ GUARANTEES: "on" }).note).toMatch(/FACTOR_GUARANTEE is not set/);
    expect(readGuarantees({ GUARANTEES: "on", FACTOR_GUARANTEE: G }).note).toMatch(/FACTOR_GUARANTEE_BLOCK/);
    expect(readGuarantees(ON).note).toBeNull();
    const problems: string[] = [];
    readGuarantees({ FACTOR_GUARANTEE: "nope", FACTOR_GUARANTEE_BLOCK: "x", GUARANTEES_PER_PASS: "0" }, problems);
    expect(problems).toHaveLength(3);
  });

  it("the share of a price follows the contract's steps", () => {
    expect([0, 199, 200, 399, 400, 599, 600, 799, 800, 1000].map(sharePct)).toEqual([0, 0, 25, 25, 50, 50, 75, 75, 100, 100]);
  });

  it("off, nothing is read or shown, and the first page says guarantees are off", async () => {
    const { r, model } = await world({ more: { GUARANTEES: "" } });
    model.bond(AGENT, ETH / 10n);
    model.offer(AGENT, ETH / 50n);
    await r.engine.watchOnce();
    expect(r.db.count("guarantee_bonds")).toBe(0);
    expect(await get(r, "/v1/guarantees")).toMatchObject({ enabled: false, agents: [], covers: [] });
    expect((await get(r, "/v1/state")).guarantees.enabled).toBe(false);
    expect((await get(r, "/v1/agents/report-lead")).guarantee).toBeUndefined();
  });
});

describe("a guarantee, read from the chain", () => {
  it("shows the agent's bond, offer and share on its page, in the lists and on the first page", async () => {
    const { r, model } = await world();
    model.bond(AGENT, ETH / 10n);
    model.offer(AGENT, ETH / 50n);
    await r.engine.watchOnce();
    const page = await get(r, "/v1/agents/report-lead");
    expect(page.guarantee).toMatchObject({ bondEth: 0.1, freeEth: 0.1, offerEth: 0.02, upToEth: 0.02, score: 420, sharePct: 50, selling: true, covers: 0 });
    expect(page.agent.guarantee).toEqual({ upToEth: 0.02, sharePct: 50 });
    const list = await get(r, "/v1/guarantees");
    expect(list).toMatchObject({ enabled: true, contract: G, rules: { feePct: 1, burnPctOfFee: 50, windowMin: 60 } });
    expect(list.agents.map((x: Body) => x.name)).toEqual(["report-lead"]);
    expect((await get(r, "/v1/state")).guarantees).toMatchObject({ enabled: true, totals: { bondsEth: 0.1, agents: 1 } });
    expect((await get(r, "/v1/agents")).items.find((x: Body) => x.address === AGENT).guarantee).toEqual({ upToEth: 0.02, sharePct: 50 });
    expect((await get(r, `/v1/record/${AGENT}`)).guarantee).toMatchObject({ upToEth: 0.02, sharePct: 50, bondEth: 0.1, covers: 0 });
  });

  it("an agent whose score allows no share sells no cover, whatever it bonded", async () => {
    const { r, model } = await world();
    model.scores.set(OTHER, 150);
    model.bond(OTHER, ETH / 10n);
    model.offer(OTHER, ETH / 50n);
    await r.engine.watchOnce();
    expect((await get(r, `/v1/guarantees/agent/${OTHER}`)).guarantee).toMatchObject({ sharePct: 0, upToEth: 0, selling: false });
    expect((await get(r, `/v1/agents/${OTHER}`)).agent.guarantee).toBeUndefined();
  });
});

describe("the keeper", () => {
  it("ties a reservation to the job locked on its terms, not to another, and closes it when the job is delivered", async () => {
    const { r, model, chain } = await world();
    model.bond(AGENT, ETH / 10n);
    model.offer(AGENT, ETH / 50n);
    const c = model.reserve(BUYER, AGENT, ETH / 25n, DAY, ETH / 100n);
    chain.lock(BUYER, AGENT, ETH / 25n + 1n, DAY); // another price: not its job
    chain.lock(STRANGER, AGENT, ETH / 25n, DAY); // another customer
    const job = model.lockFor(c);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("bind")).toHaveLength(1);
    expect(chain.sends("bind")[0]!.tx.call!.args).toEqual([1n, BigInt(job)]);
    await r.engine.watchOnce();
    const one = await get(r, `/v1/jobs/${job}`);
    expect(one.cover).toMatchObject({ id: 1, coverEth: 0.01, feeEth: 0.0001, state: "bound", job: String(job).padStart(4, "0"), next: { what: "pays-if-not-delivered" } });
    expect(one.job.cover).toMatchObject({ id: 1, coverEth: 0.01, state: "bound" });
    chain.deliver(job);
    chain.accept(job);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("close")).toHaveLength(1);
    await r.engine.watchOnce();
    expect((await get(r, `/v1/guarantees/job/${job}`)).cover).toMatchObject({ state: "released", toAgentEth: 0.00005, burnedEth: 0.00005, paidEth: 0 });
    expect((await get(r, "/v1/agents/report-lead")).guarantee).toMatchObject({ covers: 1, released: 1, heldEth: 0 });
  });

  it("pays the cover when the job is not delivered: close refunds it on the desk first, one transaction", async () => {
    const { r, model, chain } = await world();
    model.bond(AGENT, ETH / 10n);
    model.offer(AGENT, ETH / 50n);
    const c = model.reserve(BUYER, AGENT, ETH / 25n, 2 * 3600, ETH / 100n);
    const job = model.lockFor(c);
    await r.engine.watchOnce();
    await r.turn();
    await r.engine.watchOnce();
    chain.mine(1, 2 * 3600 + 12 * 3600);
    await r.turn();
    expect(chain.sends("close")).toHaveLength(0); // the grace is not over yet, to the second
    chain.mine(1, 1);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("close")).toHaveLength(1);
    expect(chain.sends("refund")).toHaveLength(0); // the desk's own refund step found it closed
    await r.engine.watchOnce();
    const cover = (await get(r, `/v1/guarantees/cover/1`)).cover;
    expect(cover).toMatchObject({ state: "paid", paidEth: 0.01, customer: BUYER });
    expect((await get(r, `/v1/jobs/${job}`)).job.state).toBe("refunded");
    expect((await get(r, "/v1/agents/report-lead")).guarantee).toMatchObject({ paid: 1, paidOutEth: 0.01, bondEth: 0.09 });
    expect((await get(r, `/v1/record/${AGENT}`)).guarantee).toMatchObject({ paidOut: 1, paidOutEth: 0.01 });
    expect(r.lines.some((l) => /was not delivered, 0\.0100 ETH paid to its customer/.test(l))).toBe(true);
  });

  it("lets an untied reservation lapse after its hour", async () => {
    const { r, model, chain } = await world();
    model.bond(AGENT, ETH / 10n);
    model.offer(AGENT, ETH / 50n);
    model.reserve(BUYER, AGENT, ETH / 25n, DAY, ETH / 100n);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("lapse")).toHaveLength(0);
    chain.mine(1, 3600 + 61);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("lapse")).toHaveLength(1);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/guarantees/cover/1")).cover.state).toBe("lapsed");
  });

  it("a declined job gives the fee back", async () => {
    const { r, model, chain } = await world();
    model.bond(AGENT, ETH / 10n);
    model.offer(AGENT, ETH / 50n);
    const c = model.reserve(BUYER, AGENT, ETH / 25n, DAY, ETH / 100n);
    const job = model.lockFor(c);
    await r.engine.watchOnce();
    await r.turn();
    chain.decline(job);
    await r.engine.watchOnce();
    await r.turn();
    await r.engine.watchOnce();
    expect((await get(r, "/v1/guarantees/cover/1")).cover).toMatchObject({ state: "declined", feeBackEth: 0.0001 });
  });

  it("does nothing while the owner's guarantees switch is off, and guarantees are hidden", async () => {
    const { r, model, chain } = await world();
    model.bond(AGENT, ETH / 10n);
    model.offer(AGENT, ETH / 50n);
    const c = model.reserve(BUYER, AGENT, ETH / 25n, DAY, ETH / 100n);
    model.lockFor(c);
    turn(r.db, "guarantees", false, "a test");
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("bind")).toHaveLength(0);
    expect((await get(r, "/v1/guarantees")).agents).toEqual([]);
    expect((await get(r, "/v1/agents/report-lead")).guarantee).toBeUndefined();
    turn(r.db, "guarantees", true);
    await r.turn();
    expect(chain.sends("bind")).toHaveLength(1);
  });

  it("in dry mode it only shows what it would send", async () => {
    const { r, model, chain } = await world({ mode: "dry" });
    model.bond(AGENT, ETH / 10n);
    model.offer(AGENT, ETH / 50n);
    const c = model.reserve(BUYER, AGENT, ETH / 25n, DAY, ETH / 100n);
    model.lockFor(c);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("bind")).toHaveLength(0);
    expect(r.lines.some((l) => /\[dry\] would send guarantee bind:1/.test(l))).toBe(true);
  });
});

describe("a customer's covers", () => {
  it("are listed by the customer's address", async () => {
    const { r, model } = await world();
    model.bond(AGENT, ETH / 10n);
    model.offer(AGENT, ETH / 50n);
    model.reserve(BUYER, AGENT, ETH / 25n, DAY, ETH / 100n);
    await r.engine.watchOnce();
    const mine = await get(r, `/v1/guarantees/customer/${BUYER}`);
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ agentName: "report-lead", state: "reserved", next: { what: "tie" } });
    // nothing anywhere says how the token's fees are shared out
    expect(JSON.stringify([mine, await get(r, "/v1/guarantees")])).not.toMatch(/70%|admin|owner/i);
  });
});
