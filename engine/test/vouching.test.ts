// Vouching on the made-up chain: the vouching contract, the line contract's line() and the guarantee contract's cover() are
// modelled here (FakeChain.extra), and the vouching contract's logs are written in the real encoding, so the engine reads
// them with the real ABI. What is checked: the switch and the settings; a vouch offered, accepted and shown on the agent's
// page, the voucher's, the lists, the record, the first page and a covered job's page; the keeper settling a line vouch
// only once its 30 days are over and the line owes nothing, settling one whose line defaulted, settling one whose line is
// due to be recovered, settling a cover vouch once its job is refunded, and withdrawing an offer nobody accepted; ties and
// Factor's own shown and not counted; the owner's switch; dry mode.

import { encodeAbiParameters, encodeEventTopics, type Abi, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { factorVouchAbi } from "../src/abi/index.js";
import type { CallSpec } from "../src/chain/chain.js";
import { readVouching } from "../src/vouching.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain, S } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

const VC = "0x0000000000000000000000000000000000000c0c";
const LINE = "0x0000000000000000000000000000000000001e1e";
const G = "0x0000000000000000000000000000000000006a7e";
const VOUCHER = "0x00000000000000000000000000000000000a0001";
const OWN = "0x00000000000000000000000000000000000a0002"; // one of Factor's own wallets
const KEY = "0x00000000000000000000000000000000000b0001"; // a newer agent's key
const ACCOUNT = "0x00000000000000000000000000000000000b0002"; // its line account
const COVERED = "0x00000000000000000000000000000000000c0001";
const BUYER = "0x0000000000000000000000000000000000d0e701";
const DAY = 86_400;
const ST = { offered: 1, active: 2, kept: 3, failed: 4, returned: 5, withdrawn: 6 } as const;

interface MV { id: number; voucher: string; agent: string; kind: 0 | 1; subject: bigint; amount: bigint; fee: bigint; offeredAt: number; startedAt: number; endsAt: number; state: number; payer: string; debtAtOffer: bigint; paid: bigint; paidTo: string }
interface MB { bond: bigint; held: bigint; vouches: number; kept: number; failed: number; returned: number; vouchedTotal: bigint; lostTotal: bigint; earned: bigint }
interface ML { key: string; dueAt: number; defaulted: boolean; debt: bigint }
interface MC { state: number; job: number; customer: string; price: bigint; amount: bigint }

/** The vouching contract, the lines and the covers it reads, as the engine asks things and as the keeper's calls change them. */
class Model {
  vouches: MV[] = [];
  bonds = new Map<string, MB>();
  scores = new Map<string, number>();
  lines = new Map<string, ML>();
  covers = new Map<number, MC>();
  constructor(private chain: FakeChain) {
    chain.extra = { answer: (c) => this.answer(c), run: (c, _f, commit, tx) => this.run(c, commit, tx) };
  }

  b(v: string): MB {
    const a = v.toLowerCase();
    if (!this.bonds.has(a)) this.bonds.set(a, { bond: 0n, held: 0n, vouches: 0, kept: 0, failed: 0, returned: 0, vouchedTotal: 0n, lostTotal: 0n, earned: 0n });
    return this.bonds.get(a)!;
  }

  answer(call: CallSpec): unknown {
    const to = call.to.toLowerCase(), fn = call.functionName, a = call.args ?? [];
    if (to === LINE && fn === "line") return this.lines.get(String(a[0]).toLowerCase()) ?? { key: "0x0000000000000000000000000000000000000000", dueAt: 0, defaulted: false, debt: 0n };
    if (to === G && fn === "cover") return this.covers.get(Number(a[0])) ?? { state: 0, job: 0n, customer: "0x0000000000000000000000000000000000000000", price: 0n, amount: 0n };
    if (to !== VC) return undefined;
    if (fn === "line") return LINE;
    if (fn === "guarantee") return G;
    if (fn === "desk") return A.desk;
    if (fn === "voucherOf") return this.b(String(a[0]));
    if (fn === "scoreOf") return BigInt(this.scores.get(String(a[0]).toLowerCase()) ?? 0);
    if (fn === "vouch") return this.vouches.find((v) => v.id === Number(a[0])) ?? { debtAtOffer: 0n };
    const open = this.vouches.filter((v) => v.state === ST.offered || v.state === ST.active);
    const totals: Record<string, bigint> = {
      bonds: [...this.bonds.values()].reduce((n, x) => n + x.bond, 0n), held: open.reduce((n, v) => n + v.amount, 0n), feesHeld: this.vouches.filter((v) => v.state === ST.active).reduce((n, v) => n + v.fee, 0n),
      owedTotal: 0n, totalVouched: this.vouches.filter((v) => v.startedAt).reduce((n, v) => n + v.amount, 0n), totalPaid: this.vouches.reduce((n, v) => n + v.paid, 0n),
      totalEarned: [...this.bonds.values()].reduce((n, x) => n + x.earned, 0n), totalBurned: 0n, vouchCount: BigInt(this.vouches.length),
    };
    return fn in totals ? totals[fn] : undefined;
  }

  run(call: CallSpec, commit: boolean, tx: string): unknown {
    if (call.to.toLowerCase() !== VC) return undefined;
    const fn = call.functionName, a = call.args ?? [];
    const v = this.vouches.find((x) => x.id === Number(a[0]));
    if (!v) throw new Error("WrongState");
    if (fn === "withdraw") {
      if (v.state !== ST.offered || this.chain.time <= v.offeredAt + 7 * DAY) throw new Error("TooSoon");
      if (!commit) return null;
      v.state = ST.withdrawn;
      this.b(v.voucher).held -= v.amount;
      this.log("Withdrawn", { id: BigInt(v.id), voucher: v.voucher }, tx);
      return null;
    }
    if (fn === "settle") {
      if (v.state !== ST.active) throw new Error("WrongState");
      let how: number;
      let loss = 0n, to = "0x0000000000000000000000000000000000000000";
      if (v.kind === 0) {
        const account = `0x${v.subject.toString(16).padStart(40, "0")}`;
        const l = this.lines.get(account)!;
        if (!l.defaulted && l.debt > 0n && this.chain.time > l.dueAt + 30 * DAY) { if (commit) l.defaulted = true; }
        const defaulted = l.defaulted || (l.debt > 0n && this.chain.time > l.dueAt + 30 * DAY);
        const backed = l.debt > 0n && l.dueAt - 30 * DAY <= v.endsAt;
        if (defaulted && backed) { how = ST.failed; loss = l.debt; to = LINE; }
        else if (this.chain.time > v.endsAt && !backed) how = ST.kept;
        else throw new Error("NotYet");
      } else {
        const c = this.covers.get(Number(v.subject))!;
        const j = this.chain.jobs.get(c.job)!;
        if (c.state === 2 && j.state === S.refunded) c.state = commit ? 4 : c.state;
        const state = c.state === 2 && j.state === S.refunded ? 4 : c.state;
        if (state === 3) how = ST.kept;
        else if (state === 4) { how = ST.failed; loss = v.amount; to = c.customer; }
        else if (state === 5) how = ST.returned;
        else throw new Error("NotYet");
      }
      if (!commit) return null;
      const b = this.b(v.voucher);
      b.held -= v.amount;
      v.state = how;
      let toVoucher = 0n, burned = 0n, paid = 0n, back = 0n;
      if (how === ST.kept) { toVoucher = v.fee / 2n; burned = v.fee - toVoucher; b.bond += toVoucher; b.earned += toVoucher; b.kept++; }
      if (how === ST.failed) { paid = loss < v.fee + v.amount ? loss : v.fee + v.amount; const fromFee = paid < v.fee ? paid : v.fee; burned = v.fee - fromFee; b.bond -= paid - fromFee; b.lostTotal += paid - fromFee; b.failed++; v.paid = paid; v.paidTo = to; }
      if (how === ST.returned) { back = v.fee; b.returned++; }
      this.log("Settled", { id: BigInt(v.id), voucher: v.voucher, agent: v.agent, how, toVoucher, burned, paid, paidTo: to, feeBack: back }, tx);
      return null;
    }
    return undefined;
  }

  log(eventName: string, args: Record<string, unknown>, tx?: string) {
    const abi = factorVouchAbi as Abi;
    const ev = abi.find((x) => x.type === "event" && x.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
    const rest = ev.inputs.filter((i) => !i.indexed);
    return this.chain.push({ address: VC, topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[], data: encodeAbiParameters(rest, rest.map((i) => args[i.name]) as never), ...(tx ? { transactionHash: tx } : {}) });
  }

  bond(voucher: string, amount: bigint): void {
    this.chain.mine();
    const b = this.b(voucher);
    b.bond += amount;
    this.log("BondAdded", { voucher, from: voucher, amount, bond: b.bond });
  }

  offer(voucher: string, agent: string, kind: 0 | 1, subject: bigint, amount: bigint): MV {
    this.chain.mine();
    const v: MV = { id: this.vouches.length + 1, voucher: voucher.toLowerCase(), agent: agent.toLowerCase(), kind, subject, amount, fee: amount / 50n, offeredAt: this.chain.time, startedAt: 0, endsAt: 0, state: ST.offered, payer: "", debtAtOffer: 0n, paid: 0n, paidTo: "" };
    this.vouches.push(v);
    this.b(voucher).held += amount;
    this.log("Offered", { id: BigInt(v.id), voucher, agent, kind, subject, amount, fee: v.fee, expiresAt: BigInt(v.offeredAt + 7 * DAY) });
    return v;
  }

  accept(v: MV, payer: string): void {
    this.chain.mine();
    v.state = ST.active;
    v.startedAt = this.chain.time;
    v.endsAt = v.kind === 0 ? this.chain.time + 30 * DAY : 0;
    v.payer = payer;
    const b = this.b(v.voucher);
    b.vouches++;
    b.vouchedTotal += v.amount;
    this.log("Accepted", { id: BigInt(v.id), agent: v.agent, payer, fee: v.fee, endsAt: BigInt(v.endsAt) });
  }
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

const ON = { VOUCHING: "on", FACTOR_VOUCH: VC, FACTOR_VOUCH_BLOCK: "5000", REPORTS_FACTOR_WALLETS: OWN };

async function world(o: { more?: Record<string, string>; mode?: "live" | "dry" } = {}): Promise<{ r: Rig; chain: FakeChain; model: Model }> {
  const chain = new FakeChain();
  chain.fund(ETH);
  for (const a of [VOUCHER, OWN, KEY, ACCOUNT, COVERED]) chain.register(a);
  const model = new Model(chain);
  model.scores.set(VOUCHER, 323);
  model.scores.set(OWN, 340);
  model.lines.set(ACCOUNT, { key: KEY, dueAt: 0, defaulted: false, debt: 0n });
  const r = await rig(o.mode ?? "live", { chain, more: { ...ON, ...o.more } });
  rigs.push(r);
  const named = (a: string, n: string) => r.db.q("INSERT INTO agent_profiles (address, name, name_key, does, signed_at) VALUES (?, ?, ?, ?, ?)").run(a, n, n, "does work", 1);
  named(VOUCHER, "report-lead");
  named(ACCOUNT, "new-agent");
  named(COVERED, "covered-agent");
  await r.engine.watchOnce();
  return { r, chain, model };
}

type Body = Record<string, any>;
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? "")))!; return { status: a.status, ...(a.body as Body) }; };
const lineVouch = (model: Model, voucher = VOUCHER) => { model.bond(voucher, ETH / 25n); const v = model.offer(voucher, ACCOUNT, 0, BigInt(ACCOUNT), ETH / 100n); model.accept(v, KEY); return v; };

describe("the settings", () => {
  it("are off unless VOUCHING=on, and say why they cannot run", () => {
    expect(readVouching({}).enabled).toBe(false);
    expect(readVouching({ VOUCHING: "on" }).note).toMatch(/FACTOR_VOUCH is not set/);
    expect(readVouching({ VOUCHING: "on", FACTOR_VOUCH: VC }).note).toMatch(/FACTOR_VOUCH_BLOCK/);
    expect(readVouching(ON).note).toBeNull();
    const problems: string[] = [];
    readVouching({ FACTOR_VOUCH: "nope", FACTOR_VOUCH_BLOCK: "x", VOUCHING_PER_PASS: "0" }, problems);
    expect(problems).toHaveLength(3);
  });

  it("off, nothing is read or shown, and the first page says vouching is off", async () => {
    const { r, model } = await world({ more: { VOUCHING: "" } });
    lineVouch(model);
    await r.engine.watchOnce();
    expect(r.db.count("vouch_vouches")).toBe(0);
    expect(await get(r, "/v1/vouches")).toMatchObject({ enabled: false, vouchers: [], items: [] });
    expect((await get(r, "/v1/state")).vouching.enabled).toBe(false);
    expect((await get(r, "/v1/agents/new-agent")).vouching).toBeUndefined();
    expect((await get(r, "/v1/vouches/1")).status).toBe(404);
  });
});

describe("a vouch, read from the chain", () => {
  it("shows who vouched and on what terms on the agent's page, the voucher's, the lists, the record and the first page", async () => {
    const { r, model } = await world();
    lineVouch(model);
    await r.engine.watchOnce();
    await r.engine.watchOnce();
    const page = await get(r, "/v1/agents/new-agent");
    expect(page.vouching).toMatchObject({ agent: ACCOUNT, standing: 1, backedEth: 0.01, kept: 0, failed: 0, notCounted: 0 });
    expect(page.vouching.received[0]).toMatchObject({ id: 1, kind: "line", state: "active", voucherName: "report-lead", agentName: "new-agent", agentKey: KEY, amountEth: 0.01, feeEth: 0.0002, counts: true, factorOwn: false, ties: [], line: { account: ACCOUNT, owesEth: 0, defaulted: false }, next: { what: "ends" } });
    // the key's address finds the same agent
    expect((await get(r, `/v1/vouches/agent/${KEY}`)).agent.agent).toBe(ACCOUNT);
    const lead = await get(r, "/v1/agents/report-lead");
    expect(lead.vouching.voucher).toMatchObject({ bondEth: 0.04, heldEth: 0.01, freeEth: 0.03, perAgentEth: 0.01, score: 323, strong: true, vouches: 1, standing: 1 });
    const list = await get(r, "/v1/vouches");
    expect(list).toMatchObject({ enabled: true, contract: VC, rules: { minScore: 300, maxSharePct: 25, feePct: 2, voucherPctOfFee: 50, lineTermDays: 30, offerDays: 7 } });
    expect(list.vouchers.map((x: Body) => x.name)).toEqual(["report-lead"]);
    expect(list.items).toHaveLength(1);
    expect((await get(r, "/v1/vouches?state=kept")).items).toHaveLength(0);
    expect((await get(r, `/v1/vouches/line/${ACCOUNT}`)).items).toHaveLength(1);
    expect((await get(r, "/v1/vouches/1")).vouch.id).toBe(1);
    expect((await get(r, "/v1/state")).vouching).toMatchObject({ enabled: true, totals: { vouches: 1, standing: 1, vouchedEth: 0.01 } });
    expect((await get(r, `/v1/record/${ACCOUNT}`)).vouched).toEqual({ standing: 1, backedEth: 0.01, kept: 0, failed: 0 });
    // nothing anywhere says how the token's fees are shared out
    expect(JSON.stringify([page, list])).not.toMatch(/70%|admin|owner/i);
  });

  it("a voucher of Factor's own is shown apart and not counted; so is a tied one", async () => {
    const { r, model, chain } = await world();
    lineVouch(model, OWN);
    // the newer agent has paid the voucher for a job on the desk: a ring Factor's records show
    const job = chain.lock(ACCOUNT, VOUCHER, ETH / 100n, DAY);
    chain.deliver(job);
    chain.accept(job);
    model.bond(VOUCHER, ETH / 25n);
    const v = model.offer(VOUCHER, ACCOUNT, 0, BigInt(ACCOUNT), ETH / 100n);
    model.accept(v, KEY);
    await r.engine.watchOnce();
    await r.engine.watchOnce();
    const page = await get(r, "/v1/agents/new-agent");
    expect(page.vouching).toMatchObject({ standing: 0, notCounted: 2 });
    const own = page.vouching.received.find((x: Body) => x.voucher === OWN);
    expect(own).toMatchObject({ factorOwn: true, counts: false });
    const tied = page.vouching.received.find((x: Body) => x.voucher === VOUCHER);
    expect(tied.counts).toBe(false);
    expect(tied.ties.join(" ")).toMatch(/ring/);
    const list = await get(r, "/v1/vouches");
    expect(list.factorOwn.map((x: Body) => x.voucher)).toEqual([OWN]);
    expect(list.vouchers.map((x: Body) => x.voucher)).toEqual([VOUCHER]);
    expect((await get(r, `/v1/record/${ACCOUNT}`)).vouched).toBeUndefined();
  });
});

describe("the keeper", () => {
  it("settles a line vouch only once its 30 days are over and the line owes nothing: kept", async () => {
    const { r, model, chain } = await world();
    lineVouch(model);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("settle")).toHaveLength(0);
    chain.mine(1, 30 * DAY);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("settle")).toHaveLength(0); // to the second
    chain.mine(1, 1);
    r.wall.extra += 61_000;
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("settle")).toHaveLength(1);
    await r.engine.watchOnce();
    const one = (await get(r, "/v1/vouches/1")).vouch;
    expect(one).toMatchObject({ state: "kept", toVoucherEth: 0.0001, burnedEth: 0.0001, paidEth: 0 });
    expect(r.lines.some((l) => /vouch 1: kept; report-lead earned 0\.000100 ETH/.test(l))).toBe(true);
    expect((await get(r, `/v1/record/${ACCOUNT}`)).vouched).toEqual({ standing: 0, backedEth: 0, kept: 1, failed: 0 });
  });

  it("waits while the debt open at the end is owed, and settles once the line defaults: the pool is paid", async () => {
    const { r, model, chain } = await world();
    const v = lineVouch(model);
    const line = model.lines.get(ACCOUNT)!;
    line.debt = ETH / 200n; // 0.005 drawn now
    line.dueAt = chain.time + 30 * DAY;
    chain.mine(1, 31 * DAY);
    r.wall.extra += 61_000;
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("settle")).toHaveLength(0);
    expect((await get(r, "/v1/vouches/1")).vouch.next.what).toBe("waits-for-repayment");
    chain.mine(1, 30 * DAY); // past the due time and the 30 days after: recoverable, so settle recovers and pays
    r.wall.extra += 61_000;
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("settle")).toHaveLength(1);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/vouches/1")).vouch).toMatchObject({ state: "failed", paidEth: 0.005, paidTo: LINE });
    expect(v.state).toBe(ST.failed);
    expect(r.lines.some((l) => /did not repay or deliver; 0\.005000 ETH paid/.test(l))).toBe(true);
  });

  it("settles a cover vouch once its job is refunded: the customer is paid; the job's page shows the vouch", async () => {
    const { r, model, chain } = await world();
    const job = chain.lock(BUYER, COVERED, ETH / 25n, 2 * 3600);
    model.covers.set(1, { state: 2, job, customer: BUYER, price: ETH / 25n, amount: ETH / 100n });
    model.bond(VOUCHER, ETH / 25n);
    const v = model.offer(VOUCHER, COVERED, 1, 1n, ETH / 100n);
    model.accept(v, COVERED);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("settle")).toHaveLength(0);
    expect((await get(r, "/v1/vouches/1")).vouch).toMatchObject({ kind: "cover", cover: { id: 1, job: String(job).padStart(4, "0"), customer: BUYER, state: "bound" }, next: { what: "pays-if-not-delivered" } });
    chain.mine(1, 2 * 3600 + 12 * 3600 + 1);
    chain.refund(job);
    r.wall.extra += 61_000;
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("settle")).toHaveLength(1);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/vouches/1")).vouch).toMatchObject({ state: "failed", paidEth: 0.01, paidTo: BUYER });
  });

  it("withdraws an offer nobody accepted within its seven days", async () => {
    const { r, model, chain } = await world();
    model.bond(VOUCHER, ETH / 25n);
    model.offer(VOUCHER, ACCOUNT, 0, BigInt(ACCOUNT), ETH / 100n);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("withdraw")).toHaveLength(0);
    expect((await get(r, "/v1/vouches/1")).vouch.next.what).toBe("accept");
    chain.mine(1, 7 * DAY + 61);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("withdraw")).toHaveLength(1);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/vouches/1")).vouch.state).toBe("withdrawn");
    expect((await get(r, "/v1/agents/new-agent")).vouching).toBeUndefined();
  });

  it("does nothing while the owner's vouching switch is off, and vouches are hidden", async () => {
    const { r, model, chain } = await world();
    lineVouch(model);
    chain.mine(1, 30 * DAY + 1);
    turn(r.db, "vouching", false, "a test");
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("settle")).toHaveLength(0);
    expect((await get(r, "/v1/vouches")).items).toEqual([]);
    expect((await get(r, "/v1/agents/new-agent")).vouching).toBeUndefined();
    turn(r.db, "vouching", true);
    await r.turn();
    expect(chain.sends("settle")).toHaveLength(1);
  });

  it("in dry mode it only shows what it would send", async () => {
    const { r, model, chain } = await world({ mode: "dry" });
    lineVouch(model);
    chain.mine(1, 30 * DAY + 1);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("settle")).toHaveLength(0);
    expect(r.lines.some((l) => /\[dry\] would send vouch settle:1/.test(l))).toBe(true);
  });
});
