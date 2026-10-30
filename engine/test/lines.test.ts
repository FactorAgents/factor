// Credit lines on the made-up chain: the line contract and its line accounts are modelled here (FakeChain.extra), and
// their logs are written in the real encoding, so the engine reads them with the real ABIs. What is checked: the
// switch and the settings; a line opened, drawn, repaid and shown on its page, on both its agent's pages and on the
// first page; a draw as compute becoming the key's compute credit, kept when the line is repaid and taken back when it
// defaults, with the ETH sent to the line contract; the keeper's sweep of income into a line that owes, only when it
// is worth the gas or the line is due within a day, and its recovery of a line 30 days past due; the record carried
// over into the Factor Score, with the line's marks; a line account signing for its key; and the owner's switch.

import { encodeAbiParameters, encodeEventTopics, type Abi, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { factorLineAbi } from "../src/abi/index.js";
import type { CallSpec } from "../src/chain/chain.js";
import { readLines } from "../src/lines.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain, GOOD_SIGNATURE } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

const LINE = "0x00000000000000000000000000000000001114e0";
const KEY = "0x00000000000000000000000000000000000a6e71";
const ACCOUNT = "0x0000000000000000000000000000000000ac1171";
const OTHER_KEY = "0x00000000000000000000000000000000000a6e72";
const OTHER_ACCOUNT = "0x0000000000000000000000000000000000ac1172";
const SEEDER = "0x0000000000000000000000000000000000005eed";
const DAY = 86_400;

interface ModelLine { key: string; account: string; debt: bigint; dueAt: number; defaulted: boolean; draws: number; onTime: number; late: number; drawn: bigint; repaid: bigint }

/** The line contract, as the engine asks it things and as the keeper's calls change it. */
class Model {
  lines: ModelLine[] = [];
  pool = 0n; out = 0n; lost = 0n; seeded = 0n; drawnAll = 0n; burned = 0n; toPool = 0n; repaidAll = 0n; recovered = 0n;
  constructor(private chain: FakeChain) {
    chain.extra = { answer: (c) => this.answer(c), run: (c, _f, commit, tx) => this.run(c, commit, tx) };
  }

  by(a: string): ModelLine | undefined {
    const x = a.toLowerCase();
    return this.lines.find((l) => l.account === x || l.key === x);
  }

  private room(l: ModelLine): bigint {
    const ag = this.chain.agents.get(l.account)!;
    const limit = ag.barred || l.defaulted ? 0n : ag.bond + ag.feesPaid;
    const can = limit > ag.advancedNow ? limit - ag.advancedNow : 0n;
    if (l.debt > 0n && this.chain.time > l.dueAt) return 0n;
    return can > l.debt ? can - l.debt : 0n;
  }

  answer(call: CallSpec): unknown {
    const to = call.to.toLowerCase(), fn = call.functionName, a = call.args ?? [];
    if (to === LINE) {
      const l = a.length ? this.by(String(a[0])) : undefined;
      if (fn === "line" && l) return { key: l.key, openedAt: 0, dueAt: l.dueAt, defaulted: l.defaulted, draws: l.draws, onTime: l.onTime, late: l.late, debt: l.debt, drawn: l.drawn, repaid: l.repaid };
      if (fn === "limit" && l) { const ag = this.chain.agents.get(l.account)!; return l.defaulted || ag.barred ? 0n : ag.bond + ag.feesPaid; }
      if (fn === "room" && l) return this.room(l);
      if (fn === "canDraw" && l) return this.room(l);
      const totals: Record<string, bigint> = { pool: this.pool, out: this.out, lost: this.lost, poolRoom: ((this.pool + this.out) * 8000n) / 10000n - this.out, owedTotal: 0n, totalPoolIn: this.seeded, totalDrawn: this.drawnAll, totalBurned: this.burned, totalFeesToPool: this.toPool, totalRepaid: this.repaidAll, totalRecovered: this.recovered, lineCount: BigInt(this.lines.length) };
      if (fn in totals) return totals[fn];
    }
    const acct = this.lines.find((l) => l.account === to);
    if (acct && fn === "isValidSignature") return a[1] === GOOD_SIGNATURE ? "0x1626ba7e" : "0xffffffff";
    return undefined;
  }

  run(call: CallSpec, commit: boolean, tx: string): unknown {
    const to = call.to.toLowerCase();
    const acct = this.lines.find((l) => l.account === to);
    if (acct && call.functionName === "sweep") {
      const bal = this.chain.balances.get(acct.account) ?? 0n;
      const paid = bal < acct.debt ? bal : acct.debt;
      if (commit && paid > 0n) { this.chain.balances.set(acct.account, bal - paid); this.repay(acct, paid, acct.account, tx); }
      return paid;
    }
    if (to === LINE && call.functionName === "recover") {
      const l = this.by(String(call.args![0]))!;
      if (!l.defaulted && this.chain.time <= l.dueAt + 30 * DAY) throw new Error("TooSoon");
      if (!commit) return null;
      const ag = this.chain.agents.get(l.account)!;
      const have = this.chain.balances.get(l.account) ?? 0n;
      if (l.debt > have && ag.advancedNow === 0n && ag.bond > 0n) { const take = l.debt - have < ag.bond ? l.debt - have : ag.bond; ag.bond -= take; this.chain.balances.set(l.account, have + take); }
      const bal = this.chain.balances.get(l.account) ?? 0n;
      const paid = bal < l.debt ? bal : l.debt;
      if (paid > 0n) { this.chain.balances.set(l.account, bal - paid); this.repay(l, paid, l.account, tx); }
      if (l.debt > 0n && !l.defaulted) { l.defaulted = true; this.out -= l.debt; this.lost += l.debt; this.log("Defaulted", { account: l.account, key: l.key, debt: l.debt }, tx); }
      return null;
    }
    return undefined;
  }

  log(eventName: string, args: Record<string, unknown>, tx?: string) {
    const abi = factorLineAbi as Abi;
    const ev = abi.find((x) => x.type === "event" && x.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
    const rest = ev.inputs.filter((i) => !i.indexed);
    return this.chain.push({ address: LINE, topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[], data: encodeAbiParameters(rest, rest.map((i) => args[i.name]) as never), ...(tx ? { transactionHash: tx } : {}) });
  }

  seed(amount: bigint): void {
    this.chain.mine();
    this.pool += amount; this.seeded += amount;
    this.log("PoolIn", { from: SEEDER, amount });
  }

  open(key: string, account: string): ModelLine {
    this.chain.mine();
    const l: ModelLine = { key: key.toLowerCase(), account: account.toLowerCase(), debt: 0n, dueAt: 0, defaulted: false, draws: 0, onTime: 0, late: 0, drawn: 0n, repaid: 0n };
    this.lines.push(l);
    this.log("Opened", { key, account });
    this.chain.register(account);
    return l;
  }

  draw(l: ModelLine, amount: bigint, compute: boolean): void {
    this.chain.mine();
    const burned = amount / 100n, toPool = (amount * 2n) / 100n - burned;
    if (l.debt === 0n) l.dueAt = this.chain.time + 30 * DAY;
    l.debt += amount; l.drawn += amount; l.draws++;
    this.pool = this.pool - amount + toPool; this.out += amount; this.drawnAll += amount; this.burned += burned; this.toPool += toPool;
    if (compute) this.chain.balances.set(this.chain.gatewayAddr, (this.chain.balances.get(this.chain.gatewayAddr) ?? 0n) + amount - burned - toPool);
    this.log("Drawn", { account: l.account, key: l.key, amount, burned, toPool, asCompute: compute, dueAt: BigInt(l.dueAt) });
  }

  repay(l: ModelLine, amount: bigint, from: string, tx?: string): void {
    if (!tx) this.chain.mine();
    const late = this.chain.time > l.dueAt;
    l.debt -= amount; l.repaid += amount; this.pool += amount; this.repaidAll += amount;
    if (l.defaulted) { this.lost -= amount; this.recovered += amount; }
    else { this.out -= amount; if (l.debt === 0n) { if (late) l.late++; else l.onTime++; } }
    if (l.debt === 0n) l.dueAt = 0;
    this.log("Repaid", { account: l.account, from, amount, debt: l.debt, late }, tx);
  }
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

const LINES_ON = { LINES: "on", FACTOR_LINE: LINE, FACTOR_LINE_BLOCK: "5000" };

async function world(o: { more?: Record<string, string>; mode?: "live" | "dry"; gatewayIsBot?: boolean } = {}): Promise<{ r: Rig; chain: FakeChain; model: Model }> {
  const chain = new FakeChain();
  if (o.gatewayIsBot) chain.gatewayAddr = A.bot;
  chain.fund(ETH);
  chain.register(KEY);
  chain.register(OTHER_KEY);
  const model = new Model(chain);
  const r = await rig(o.mode ?? "live", { chain, more: { ...LINES_ON, ...o.more } });
  rigs.push(r);
  r.db.q("INSERT INTO agent_profiles (address, name, name_key, does, signed_at) VALUES (?, ?, ?, ?, ?)").run(KEY, "report-lead", "report-lead", "writes weekly reports", 1);
  await r.engine.watchOnce();
  return { r, chain, model };
}

type Body = Record<string, any>;
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? "")))!; return { status: a.status, ...(a.body as Body) }; };

describe("the settings", () => {
  it("are off unless LINES=on, and say why they cannot run", () => {
    expect(readLines({}).enabled).toBe(false);
    expect(readLines({ LINES: "on" }).note).toMatch(/FACTOR_LINE is not set/);
    expect(readLines({ LINES: "on", FACTOR_LINE: LINE }).note).toMatch(/FACTOR_LINE_BLOCK/);
    expect(readLines(LINES_ON).note).toBeNull();
    const problems: string[] = [];
    readLines({ FACTOR_LINE: "nope", FACTOR_LINE_BLOCK: "x", LINES_SWEEP_MIN_WEI: "0.1", LINES_PER_PASS: "0" }, problems);
    expect(problems).toHaveLength(4);
  });

  it("off, nothing is read or shown, and the first page says lines are off", async () => {
    const { r, model } = await world({ more: { LINES: "" } });
    model.seed(ETH / 10n);
    model.open(KEY, ACCOUNT);
    await r.engine.watchOnce();
    expect(r.db.count("lines")).toBe(0);
    const list = await get(r, "/v1/lines");
    expect(list).toMatchObject({ enabled: false, items: [] });
    expect((await get(r, "/v1/state")).lines.enabled).toBe(false);
    expect((await get(r, `/v1/lines/${KEY}`)).status).toBe(404);
    expect((await get(r, "/v1/agents/report-lead")).line).toBeUndefined();
  });
});

describe("a line, read from the chain", () => {
  it("is shown on its page, both of its agent's pages, the list and the first page", async () => {
    const { r, model, chain } = await world();
    model.seed(ETH / 10n);
    const l = model.open(KEY, ACCOUNT);
    chain.bond(ACCOUNT, ETH / 100n);
    model.draw(l, ETH / 200n, false);
    await r.engine.watchOnce();
    const one = await get(r, "/v1/lines/report-lead");
    expect(one.status).toBe(200);
    expect(one.line).toMatchObject({ key: KEY, account: ACCOUNT, name: "report-lead", named: true, status: "owing", debtEth: 0.005, draws: 1, limitEth: 0.01, roomEth: 0.005, bondEth: 0.01 });
    expect(one.line.moves.map((m: Body) => m.kind)).toEqual(["draw", "open"]);
    expect((await get(r, `/v1/lines/${ACCOUNT}`)).line.key).toBe(KEY);
    const list = await get(r, "/v1/lines");
    expect(list).toMatchObject({ enabled: true, contract: LINE, lines: 1, owing: 1, rules: { feePct: 2, dueDays: 30, defaultDays: 30, poolOutMaxPct: 80 } });
    expect(list.pool).toMatchObject({ seededEth: 0.1, outEth: 0.005, drawnEth: 0.005 });
    const keyPage = await get(r, "/v1/agents/report-lead");
    expect(keyPage.line.account).toBe(ACCOUNT);
    expect(keyPage.agent.line).toMatchObject({ role: "key", account: ACCOUNT, status: "owing" });
    // the line account goes by its key's name
    const acctPage = await get(r, `/v1/agents/${ACCOUNT}`);
    expect(acctPage.agent).toMatchObject({ name: "report-lead", named: true, line: { role: "account", key: KEY } });
    const s = await get(r, "/v1/state");
    expect(s.lines).toMatchObject({ enabled: true, lines: 1, owing: 1 });
    // nothing anywhere says how the fees are shared out beyond the rulebook's own words
    expect(JSON.stringify([one, list, s.lines])).not.toMatch(/70%|admin|owner/i);
  });

  it("counts a repayment on time and a late one, and clears the due time when the debt is gone", async () => {
    const { r, model, chain } = await world();
    model.seed(ETH / 10n);
    const l = model.open(KEY, ACCOUNT);
    chain.bond(ACCOUNT, ETH / 100n);
    model.draw(l, ETH / 200n, false);
    model.repay(l, ETH / 200n, KEY);
    model.draw(l, ETH / 200n, false);
    chain.mine(1, 31 * DAY);
    model.repay(l, ETH / 200n, KEY);
    await r.engine.watchOnce();
    const one = (await get(r, `/v1/lines/${KEY}`)).line;
    expect(one).toMatchObject({ status: "open", debtEth: 0, dueAt: null, onTime: 1, late: 1, drawnEth: 0.01, repaidEth: 0.01 });
    expect(one.moves[0]).toMatchObject({ kind: "repay", late: true, debtEth: 0 });
  });
});

describe("a draw as compute", () => {
  it("is the key's compute credit, kept once the line is repaid", async () => {
    const { r, model, chain } = await world();
    model.seed(ETH / 10n);
    const l = model.open(KEY, ACCOUNT);
    chain.bond(ACCOUNT, ETH / 100n);
    model.draw(l, ETH / 100n, true);
    await r.engine.watchOnce();
    const credit = r.engine.gateway!.balanceOf(KEY) as { balanceUsd: number; lots: Body[] };
    expect(credit.lots).toHaveLength(1);
    expect(credit.lots[0]).toMatchObject({ job: 0, state: "open", paidBy: "line" });
    expect(credit.balanceUsd).toBeCloseTo(24.5, 2); // 0.0098 ETH at $2,500
    expect(r.db.q("SELECT wei, source, line FROM compute_lots").get()).toEqual({ wei: "9800000000000000", source: "line", line: ACCOUNT });
    model.repay(l, ETH / 100n, KEY);
    await r.engine.watchOnce();
    expect((r.engine.gateway!.balanceOf(KEY) as { lots: Body[] }).lots[0].state).toBe("kept");
    expect((await get(r, `/v1/lines/${KEY}`)).line.computeUsd.grantedUsd).toBeCloseTo(24.5, 2);
  });

  it("goes back to the line pool, unspent, when the line defaults: the keeper sends the ETH to the line contract", async () => {
    const { r, model, chain } = await world({ gatewayIsBot: true });
    model.seed(ETH / 10n);
    const l = model.open(KEY, ACCOUNT);
    chain.bond(ACCOUNT, ETH / 100n);
    model.draw(l, ETH / 100n, true);
    // no bond left to take at the default: the whole draw is lost, and its unspent credit goes back
    chain.agents.get(ACCOUNT)!.bond = 0n;
    chain.mine(1, 61 * DAY);
    await r.turn(); // the keeper recovers it, it defaults
    await r.turn(); // the unspent credit goes back
    expect(model.lines[0]!.defaulted).toBe(true);
    const lot = r.db.q("SELECT state, back_wei, back_tx FROM compute_lots").get() as Body;
    expect(lot.state).toBe("closed");
    expect(lot.back_wei).toBe("9800000000000000");
    const sent = chain.sends("pay");
    expect(sent.at(-1)!.tx.pay).toEqual({ to: LINE, value: 9_800_000_000_000_000n });
    expect(lot.back_tx).not.toBeNull();
  });
});

describe("the keeper", () => {
  it("sweeps income waiting in a line account that owes, once it is worth the gas", async () => {
    const { r, model, chain } = await world();
    model.seed(ETH / 10n);
    const l = model.open(KEY, ACCOUNT);
    chain.bond(ACCOUNT, ETH / 100n);
    model.draw(l, ETH / 200n, false);
    chain.balances.set(ACCOUNT, 10_000_000_000_000n); // 0.00001: under the 0.00002 floor
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(0);
    chain.balances.set(ACCOUNT, ETH / 1000n);
    chain.mine(1, 20); // what an account holds is read again every 15 seconds
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(1);
    expect(l.debt).toBe(ETH / 200n - ETH / 1000n);
  });

  it("sweeps whatever waits when the line is due within a day", async () => {
    const { r, model, chain } = await world();
    model.seed(ETH / 10n);
    const l = model.open(KEY, ACCOUNT);
    chain.bond(ACCOUNT, ETH / 100n);
    model.draw(l, ETH / 200n, false);
    chain.balances.set(ACCOUNT, 10_000_000_000_000n);
    chain.mine(1, 29 * DAY + 3600);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(1);
  });

  it("recovers a line 30 days past due, and not a second before", async () => {
    const { r, model, chain } = await world();
    model.seed(ETH / 10n);
    const l = model.open(KEY, ACCOUNT);
    chain.bond(ACCOUNT, ETH / 100n);
    model.draw(l, ETH / 200n, false);
    chain.mine(1, 59 * DAY);
    await r.turn();
    expect(chain.sends("recover")).toHaveLength(0);
    chain.mine(1, 2 * DAY);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("recover")).toHaveLength(1);
    await r.engine.watchOnce();
    // the bond paid it: late, not defaulted
    expect((await get(r, `/v1/lines/${KEY}`)).line).toMatchObject({ status: "open", late: 1, defaulted: false });
  });

  it("does nothing while the owner's lines switch is off, and the lines are hidden", async () => {
    const { r, model, chain } = await world();
    model.seed(ETH / 10n);
    const l = model.open(KEY, ACCOUNT);
    chain.bond(ACCOUNT, ETH / 100n);
    model.draw(l, ETH / 200n, false);
    chain.balances.set(ACCOUNT, ETH / 100n);
    turn(r.db, "lines", false, "a test");
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(0);
    expect((await get(r, "/v1/lines")).items).toEqual([]);
    expect((await get(r, "/v1/agents/report-lead")).line).toBeUndefined();
    turn(r.db, "lines", true);
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(1);
  });
});

describe("the record, carried over", () => {
  it("counts the key and its line account as one agent, with the line's marks", async () => {
    const { r, model, chain } = await world();
    model.seed(ETH / 10n);
    const l = model.open(KEY, ACCOUNT);
    // a job paid at the old address and one at the line account
    const a = chain.lock("0x00000000000000000000000000000000000c0571", KEY, ETH / 10n);
    chain.deliver(a);
    chain.accept(a);
    const b = chain.lock("0x00000000000000000000000000000000000c0572", ACCOUNT, ETH / 10n);
    chain.deliver(b);
    chain.accept(b);
    chain.bond(ACCOUNT, ETH / 100n);
    model.draw(l, ETH / 200n, false);
    model.repay(l, ETH / 200n, KEY);
    await r.engine.watchOnce();
    const page = await get(r, "/v1/agents/report-lead");
    const fs = page.factorScore;
    expect(fs.parts.find((p: Body) => p.key === "jobs").value).toBe("2");
    expect(fs.parts.find((p: Body) => p.key === "repaid").value).toBe("1");
    expect(fs.line).toMatchObject({ role: "key", other: ACCOUNT, onTime: 1, late: 0, defaulted: false });
    expect(fs.check).toMatch(/as one record/);
    // the list shows the same number for both sides
    const items = (await get(r, "/v1/agents")).items as Body[];
    expect(items.find((x) => x.address === KEY)!.score).toBe(fs.score);
    expect(items.find((x) => x.address === ACCOUNT)!.score).toBe(fs.score);
    // late takes 50 off
    model.draw(l, ETH / 200n, false);
    chain.mine(1, 31 * DAY);
    model.repay(l, ETH / 200n, KEY);
    await r.engine.watchOnce();
    const late = (await get(r, "/v1/agents/report-lead")).factorScore;
    expect(late.line.late).toBe(1);
    expect(late.line.points).toBe(-50);
  });

  it("a default sets the score to 0", async () => {
    const { r, model, chain } = await world();
    model.seed(ETH / 10n);
    const l = model.open(KEY, ACCOUNT);
    const b = chain.lock("0x00000000000000000000000000000000000c0572", ACCOUNT, ETH);
    chain.deliver(b);
    chain.accept(b);
    model.draw(l, ETH / 100n, false);
    chain.mine(1, 61 * DAY);
    await r.turn();
    await r.engine.watchOnce();
    const fs = (await get(r, "/v1/agents/report-lead")).factorScore;
    expect(fs.score).toBe(0);
    expect(fs.zero).toMatch(/did not repay its credit line/);
    expect((await get(r, `/v1/lines/${KEY}`)).line.status).toBe("defaulted");
  });
});

describe("signatures", () => {
  it("a line account signs for its key: a compute key for the account's address", async () => {
    const { r, model } = await world();
    model.open(KEY, ACCOUNT);
    await r.engine.watchOnce();
    const at = Math.floor(r.chain.time);
    const ok = await r.engine.gateway!.mint({ address: ACCOUNT, at, signature: GOOD_SIGNATURE });
    expect("key" in ok).toBe(true);
    const no = await r.engine.gateway!.mint({ address: OTHER_ACCOUNT, at, signature: GOOD_SIGNATURE });
    expect("key" in no).toBe(false);
  });
});
