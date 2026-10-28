// Agent coins on the made-up chain: the launcher, a coin's splitter, its curve and the coin itself are modelled here
// (FakeChain.extra), and their logs are written in the real encoding, so the engine reads them with the real ABIs.
// What is checked: the switch and the settings, the name rule, a launch read from the chain and shown on the coin's
// page, the agent's page, the lists and the first page; a coin's compute share becoming the agent's own compute
// credit, paid by its coin, even when the coin was launched in the same stretch of blocks; trades, volume and holders;
// the keeper's sweep only when it is worth the gas, and its retry of a refused share; a coin whose name breaks the rule;
// the owner's switch; and the permission Factor signs for an agent it runs, and every way it refuses.

import { encodeAbiParameters, encodeEventTopics, getAddress, recoverTypedDataAddress, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { agentCoinLauncherAbi, agentCoinSplitterAbi } from "../src/abi/index.js";
import type { CallSpec } from "../src/chain/chain.js";
import { EngineDb, open } from "../src/chain/db.js";
import { coinAskMessage, coinDescription, coinLogo, coinNameProblem, Coins, CURVE_BUY, CURVE_SELL, POOL_SWAP, readCoins, suggestCoin, TRANSFER, type PermissionTypedData } from "../src/coins.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

const LAUNCHER = "0x00000000000000000000000000000000000c01a1";
const POOL_MANAGER = "0x0000000000000000000000000000000000000909";
const HOOK = "0x0000000000000000000000000000000000000404";
const ZERO = "0x0000000000000000000000000000000000000000";
const AGENT = "0x00000000000000000000000000000000000a6e71";
const MAKER = "0x0000000000000000000000000000000000000a4e";
const BUYER = "0x00000000000000000000000000000000000b0e12";
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const topic = (a: string) => `0x${a.slice(2).padStart(64, "0")}` as Hex;

interface ModelCoin { agent: string; coin: string; splitter: string; curve: string; maker: string; name: string; symbol: string; waiting: bigint; escrow: bigint; pending: bigint; split: bigint; toCompute: bigint; toBurn: bigint; computePaid: bigint; computeBurned: bigint; phase: number; refuseGateway: boolean; barred: boolean }

/** The launcher, each coin's splitter, curve and token, and the parts of Pons the engine asks about them. */
class Model {
  coins: ModelCoin[] = [];
  private n = 0;
  constructor(private chain: FakeChain) {
    chain.extra = { answer: (c) => this.answer(c), run: (c, _f, commit) => this.run(c, commit) };
  }

  private by(a: string, field: "splitter" | "coin" | "agent") { return this.coins.find((c) => c[field] === a.toLowerCase()); }

  answer(call: CallSpec): unknown {
    const to = call.to.toLowerCase(), fn = call.functionName, a = call.args ?? [];
    if (to === LAUNCHER) {
      if (fn === "factory") return A.factory;
      if (fn === "escrow") return A.escrow;
      if (fn === "launchFee") return 5n * 10n ** 14n;
      if (fn === "nonces") return 0n;
      if (fn === "coinOf") return this.by(String(a[0]).toLowerCase(), "agent")?.coin ?? ZERO;
    }
    if (to === A.factory && fn === "poolManager") return POOL_MANAGER;
    if (to === A.factory && fn === "memeHook") return HOOK;
    if (to === A.factory && fn === "getLaunchedToken") { const c = this.by(String(a[0]).toLowerCase(), "coin"); if (c) return { phase: c.phase, poolFee: 0, tickSpacing: 200, exists: true }; }
    if (to === A.escrow && fn === "balanceOf") { const c = this.by(String(a[0]).toLowerCase(), "splitter"); if (c) return c.escrow; }
    const t = this.by(to, "coin");
    if (t && fn === "name") return t.name;
    if (t && fn === "symbol") return t.symbol;
    if (t && fn === "logo") return coinLogo("https://factoragents.fun", t.agent);
    const s = this.by(to, "splitter");
    if (s) {
      const m: Record<string, bigint> = { unsplit: 0n, pending: s.pending, totalSplit: s.split, totalToCompute: s.toCompute, totalToBurn: s.toBurn, totalComputePaid: s.computePaid, totalComputeBurned: s.computeBurned, totalCoinBurned: 0n };
      if (fn in m) return m[fn];
    }
    return undefined;
  }

  run(call: CallSpec, commit: boolean): unknown {
    const s = this.by(call.to.toLowerCase(), "splitter");
    if (!s) return undefined;
    if (call.functionName === "retry") {
      if (commit && s.pending > 0n && !s.refuseGateway) { this.paid(s, s.pending); s.pending = 0n; }
      return null;
    }
    if (call.functionName !== "sweep") return undefined;
    const amount = s.waiting + s.escrow;
    if (commit && amount > 0n) { s.waiting = 0n; s.escrow = 0n; this.split(s, amount); }
    return amount;
  }

  /** The splitter's split, as it logs it: the four shares, and ComputePaid when the gateway took its share. */
  split(s: ModelCoin, amount: bigint, tx?: string): void {
    const c = (amount * 4000n) / 10000n, m = (amount * 2000n) / 10000n, o = (amount * 2000n) / 10000n, b = amount - c - m - o;
    s.split += amount; s.toCompute += c; s.toBurn += b;
    this.log(s.splitter, agentCoinSplitterAbi as Abi, "Split", { amount, toCompute: c, toMaker: m, toBurn: b, toOwner: o, computePushed: !s.refuseGateway && !s.barred, makerPushed: true, burnPushed: true, ownerPushed: true }, tx);
    if (s.barred) { s.computeBurned += c; this.log(s.splitter, agentCoinSplitterAbi as Abi, "ComputeBurned", { agent: s.agent, amount: c }, tx); }
    else if (s.refuseGateway) s.pending += c;
    else this.paid(s, c, tx);
  }

  private paid(s: ModelCoin, c: bigint, tx?: string): void {
    s.computePaid += c;
    this.log(s.splitter, agentCoinSplitterAbi as Abi, "ComputePaid", { agent: s.agent, amount: c }, tx);
  }

  log(address: string, abi: Abi, eventName: string, args: Record<string, unknown>, tx?: string) {
    const ev = abi.find((x) => x.type === "event" && x.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
    const rest = ev.inputs.filter((i) => !i.indexed);
    return this.chain.push({ address, topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[], data: encodeAbiParameters(rest, rest.map((i) => args[i.name]) as never), ...(tx ? { transactionHash: tx } : {}) });
  }

  /** A coin launched for `agent` by `maker`, with an opening buy: the launcher's log, the mint, and the first buy. */
  launch(agent: string, maker: string, name: string, symbol: string, o: { bySignature?: boolean; tx?: string } = {}): ModelCoin {
    this.chain.mine();
    const k = ++this.n;
    const at = (x: number) => `0x${(0xc000 + k * 16 + x).toString(16).padStart(40, "0")}`;
    const c: ModelCoin = { agent, coin: at(1), splitter: at(2), curve: at(3), maker, name, symbol, waiting: 0n, escrow: 0n, pending: 0n, split: 0n, toCompute: 0n, toBurn: 0n, computePaid: 0n, computeBurned: 0n, phase: 0, refuseGateway: false, barred: false };
    this.coins.push(c);
    const tx = o.tx ?? `0x${"7a".repeat(31)}${k.toString(16).padStart(2, "0")}`;
    this.chain.push({ address: c.coin, topics: [TRANSFER, topic(ZERO), topic(c.curve)], data: `0x${word(10n ** 27n)}`, transactionHash: tx });
    this.log(LAUNCHER, agentCoinLauncherAbi as Abi, "CoinLaunched", { agent, coin: c.coin, maker, splitter: c.splitter, curve: c.curve, bySignature: o.bySignature ?? true, openingBuyEth: ETH / 100n, openingBuyTokens: 10n ** 24n }, tx);
    this.chain.push({ address: c.coin, topics: [TRANSFER, topic(c.curve), topic(maker)], data: `0x${word(10n ** 24n)}`, transactionHash: tx });
    return c;
  }

  /** Somebody buys on the curve: the curve's log, the transfer, and fees left for the splitter. */
  buy(c: ModelCoin, who: string, eth: bigint, tokens: bigint): void {
    this.chain.mine();
    const tx = `0x${(Math.random() * 1e16).toString(16).replace(".", "").padEnd(64, "b").slice(0, 64)}`;
    this.chain.push({ address: c.curve, topics: [CURVE_BUY as Hex, topic(who), topic(who)], data: `0x${word(eth)}${word(tokens)}${word(eth / 100n)}${word((eth * 3n) / 100n)}`, transactionHash: tx });
    this.chain.push({ address: c.coin, topics: [TRANSFER, topic(c.curve), topic(who)], data: `0x${word(tokens)}`, transactionHash: tx });
    c.waiting += (eth * 37n) / 1000n;
  }

  sell(c: ModelCoin, who: string, eth: bigint, tokens: bigint): void {
    this.chain.mine();
    const tx = `0x${(Math.random() * 1e16).toString(16).replace(".", "").padEnd(64, "c").slice(0, 64)}`;
    this.chain.push({ address: c.curve, topics: [CURVE_SELL as Hex, topic(who), topic(who)], data: `0x${word(tokens)}${word(eth)}${word(eth / 100n)}${word((eth * 3n) / 100n)}`, transactionHash: tx });
    this.chain.push({ address: c.coin, topics: [TRANSFER, topic(who), topic(c.curve)], data: `0x${word(tokens)}`, transactionHash: tx });
    c.waiting += (eth * 37n) / 1000n;
  }
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

const COINS_ON = { AGENT_COINS: "on", FACTOR_COIN_LAUNCHER: LAUNCHER, FACTOR_COIN_LAUNCHER_BLOCK: "5000" };

async function world(o: { more?: Record<string, string>; mode?: "live" | "dry" } = {}): Promise<{ r: Rig; chain: FakeChain; model: Model }> {
  const chain = new FakeChain();
  chain.fund(ETH);
  chain.register(AGENT);
  const model = new Model(chain);
  const r = await rig(o.mode ?? "live", { chain, more: { ...COINS_ON, ...o.more } });
  rigs.push(r);
  r.db.q("INSERT INTO agent_profiles (address, name, name_key, does, signed_at) VALUES (?, ?, ?, ?, ?)").run(AGENT, "page-smith", "page-smith", "writes landing pages", 1);
  await r.engine.watchOnce();
  return { r, chain, model };
}

type Body = Record<string, any>;
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? "")))!; return { status: a.status, ...(a.body as Body) }; };

describe("the settings", () => {
  it("are off unless AGENT_COINS=on, and say why they cannot run", () => {
    expect(readCoins({}).enabled).toBe(false);
    expect(readCoins({ AGENT_COINS: "on" }).note).toMatch(/FACTOR_COIN_LAUNCHER is not set/);
    expect(readCoins({ AGENT_COINS: "on", FACTOR_COIN_LAUNCHER: LAUNCHER }).note).toMatch(/FACTOR_COIN_LAUNCHER_BLOCK/);
    expect(readCoins(COINS_ON).note).toBeNull();
    const problems: string[] = [];
    readCoins({ FACTOR_COIN_LAUNCHER: "nope", FACTOR_COIN_LAUNCHER_BLOCK: "x", COINS_MIN_SWEEP_WEI: "0.1", COINS_SWEEP_EVERY_S: "-1", COINS_SITE_URL: "http://x" }, problems);
    expect(problems).toHaveLength(5);
  });
});

describe("the name rule", () => {
  it("takes the agent's name, a short form of it, and a ticker of its letters in order", () => {
    expect(coinNameProblem("page-smith", "Page Smith", "SMITH")).toBeNull();
    expect(coinNameProblem("page-smith", "Page Smith", "PAGESMITH")).toBeNull();
    expect(coinNameProblem("page-smith", "Page", "PGS")).toBeNull();
    expect(coinNameProblem("page-smith", "pagesmith", "PS")).toBeNull();
    expect(suggestCoin("page-smith")).toEqual({ name: "Page Smith", symbol: "PAGESMITH" });
    expect(coinNameProblem("page-smith", suggestCoin("page-smith").name, suggestCoin("page-smith").symbol)).toBeNull();
  });

  it("refuses another name, another order, another brand, and an agent with no name", () => {
    expect(coinNameProblem("page-smith", "Smith Page", "SMITH")).toMatch(/carries the agent's name/);
    expect(coinNameProblem("page-smith", "Pa", "PA")).toMatch(/2 to 32|carries/);
    expect(coinNameProblem("page-smith", "Page Smith", "HTIMS")).toMatch(/letters of the agent's name/);
    expect(coinNameProblem("page-smith", "Page Smith", "smith")).toMatch(/capital letters/);
    expect(coinNameProblem("claude-helper", "Claude Helper", "CLAUDE")).toMatch(/another brand/);
    expect(coinNameProblem("eth", "Eth", "ETH")).toMatch(/another brand/);
    expect(coinNameProblem(null, "Page Smith", "SMITH")).toMatch(/no name yet/);
  });

  it("writes a coin's description with no promise and its own risk", () => {
    const d = coinDescription("Page Smith");
    expect(d).toMatch(/at your own risk/);
    expect(d).not.toMatch(/%|Robinhood|—/);
  });
});

describe("a coin, read from the chain", () => {
  it("is shown with its agent: on the coin's page, the agent's page, the lists and the first page", async () => {
    const { r, model } = await world();
    const c = model.launch(AGENT, MAKER, "Page Smith", "SMITH");
    await r.engine.watchOnce();
    const list = await get(r, "/v1/coins");
    expect(list.enabled).toBe(true);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ coin: c.coin, name: "Page Smith", symbol: "SMITH", maker: MAKER, bySignature: true, listed: true, openingBuyEth: 0.01, agent: { address: AGENT, name: "page-smith", named: true } });
    const one = await get(r, "/v1/coins/page-smith");
    expect(one.status).toBe(200);
    expect(one.pons).toBe(`https://ponsfamily.com/launchpad/${c.coin}`);
    expect((await get(r, `/v1/coins/${c.coin}`)).symbol).toBe("SMITH");
    expect((await get(r, `/v1/coins/${AGENT}`)).symbol).toBe("SMITH");
    const page = await get(r, "/v1/agents/page-smith");
    expect(page.agent.coin).toEqual({ coin: c.coin, symbol: "SMITH" });
    expect(page.coin.symbol).toBe("SMITH");
    expect((await get(r, "/v1/agents")).items.find((a: Body) => a.address === AGENT).coin.symbol).toBe("SMITH");
    const s = await get(r, "/v1/state");
    expect(s.coins).toMatchObject({ enabled: true, launcher: LAUNCHER, count: 1 });
    expect(s.coins.items[0].symbol).toBe("SMITH");
    const about = await get(r, "/v1/coins/about");
    expect(about).toMatchObject({ enabled: true, launcher: LAUNCHER, launchFeeWei: "500000000000000", tax: "3%" });
    // and nothing anywhere says how the fees are shared out
    expect(JSON.stringify([list, one, page, about])).not.toMatch(/40%|20%|toMaker|toOwner|MAKER_BPS/);
  });

  it("turns the coin's compute share into the agent's own compute credit, paid by its coin", async () => {
    const { r, model, chain } = await world();
    // launched and paid in the same stretch of blocks: the splitter's logs are read although it was new
    const c = model.launch(AGENT, MAKER, "Page Smith", "SMITH");
    model.buy(c, BUYER, ETH, 10n ** 24n);
    chain.mine();
    model.split(c, (ETH * 37n) / 1000n);
    c.waiting = 0n;
    await r.engine.watchOnce();
    const credit = r.engine.gateway!.balanceOf(AGENT) as { balanceUsd: number; lots: Body[] };
    // 0.0148 ETH at the made-up chain's price
    expect(credit.lots).toHaveLength(1);
    expect(credit.lots[0]).toMatchObject({ job: 0, state: "kept", paidBy: "coin" });
    expect(credit.balanceUsd).toBeGreaterThan(0);
    const lot = r.db.q("SELECT * FROM compute_lots WHERE agent = ?").get(AGENT) as Body;
    expect(lot).toMatchObject({ wei: "14800000000000000", source: "coin", state: "kept" });
    // read again from the start: nothing is written twice
    r.db.q("UPDATE engine_cursors SET block = 4999 WHERE watcher = 'coins'").run();
    await r.engine.watchOnce();
    expect(r.db.count("compute_lots")).toBe(1);
    expect(r.db.count("coin_splits")).toBe(1);
    const one = await get(r, "/v1/coins/page-smith");
    expect(one.paidFor.computeEth).toBeCloseTo(0.0148, 6);
    expect(one.paidFor.computeUsd).toBeGreaterThan(0);
    expect(one.sweeps).toHaveLength(1);
  });

  it("counts its trades, its volume and its holders, in the pool too after graduation", async () => {
    const { r, model, chain } = await world();
    const c = model.launch(AGENT, MAKER, "Page Smith", "SMITH");
    model.buy(c, BUYER, ETH, 10n ** 24n);
    model.sell(c, BUYER, ETH / 2n, 10n ** 23n);
    await r.engine.watchOnce();
    let one = await get(r, "/v1/coins/page-smith");
    expect(one).toMatchObject({ trades: 2, buys: 1, holders: 2 });
    expect(one.volumeEth).toBeCloseTo(1.5, 6);
    expect(one.recent.map((x: Body) => x.side)).toEqual(["sell", "buy"]);
    // graduation: its pool's swaps are read by the pool's id
    c.phase = 2;
    await r.engine.watchOnce();
    await new Promise((res) => setTimeout(res, 5));
    r.db.q("UPDATE coins SET state_at = 0").run();
    await r.engine.watchOnce();
    const { keccak256 } = await import("viem");
    const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [ZERO, c.coin as Hex, 0, 200, HOOK]));
    chain.mine();
    chain.push({ address: POOL_MANAGER, topics: [POOL_SWAP, id, topic(BUYER)], data: `0x${word((1n << 256n) - ETH / 4n)}${word(10n ** 22n)}${word(1n)}${word(1n)}${word(0n)}${word(0n)}` });
    await r.engine.watchOnce();
    one = await get(r, "/v1/coins/page-smith");
    expect(one.phase).toBe("pool");
    expect(one.trades).toBe(3);
    expect(one.volumeEth).toBeCloseTo(1.75, 6);
  });

  it("does not list a coin whose name breaks the rule, and lists it when the agent's name fits it", async () => {
    const { r, model } = await world();
    model.launch(AGENT, MAKER, "Moon Rocket", "MOON", { bySignature: false });
    await r.engine.watchOnce();
    expect((await get(r, "/v1/coins")).items).toHaveLength(0);
    expect((await get(r, "/v1/coins/page-smith")).status).toBe(404);
    expect((await get(r, "/v1/agents/page-smith")).agent.coin).toBeUndefined();
    r.db.q("UPDATE agent_profiles SET name = 'moon-rocket', name_key = 'moon-rocket' WHERE address = ?").run(AGENT);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/coins")).items).toHaveLength(1);
  });
});

describe("the keeper", () => {
  it("sweeps a coin once its fees are worth the gas, and not again before its time", async () => {
    const { r, model, chain } = await world({ more: { COINS_CHECK_EVERY_S: "0" } });
    const c = model.launch(AGENT, MAKER, "Page Smith", "SMITH");
    await r.engine.watchOnce();
    model.buy(c, BUYER, ETH / 1000n, 10n ** 21n); // 0.000037 ETH of fees: not worth it
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(0);
    model.buy(c, BUYER, ETH, 10n ** 24n);
    await r.turn();
    expect(chain.sends("sweep").filter((s) => s.tx.call!.to === c.splitter)).toHaveLength(1);
    expect(c.split).toBeGreaterThan(0n);
    await r.engine.watchOnce();
    expect(r.db.count("coin_splits")).toBe(1);
    expect(r.db.q("SELECT COUNT(*) AS n FROM compute_lots WHERE source = 'coin'").get()).toEqual({ n: 1 });
    // more fees, but the last sweep was minutes ago
    model.buy(c, BUYER, ETH, 10n ** 24n);
    await r.turn();
    expect(chain.sends("sweep").filter((s) => s.tx.call!.to === c.splitter)).toHaveLength(1);
    chain.warpTo(chain.time + 3601);
    await r.turn();
    expect(chain.sends("sweep").filter((s) => s.tx.call!.to === c.splitter)).toHaveLength(2);
    const h = await get(r, "/v1/health");
    expect(h.coins).toMatchObject({ coins: 1, listed: 1, on: true });
    expect(h.actions.coin_sweep.done).toBeGreaterThanOrEqual(2);
  });

  it("retries a share the gateway refused, and credits it only when it arrives", async () => {
    const { r, model, chain } = await world({ more: { COINS_CHECK_EVERY_S: "0" } });
    const c = model.launch(AGENT, MAKER, "Page Smith", "SMITH");
    c.refuseGateway = true;
    model.buy(c, BUYER, ETH, 10n ** 24n);
    await r.turn();
    await r.engine.watchOnce();
    expect(r.db.count("compute_lots")).toBe(0);
    c.refuseGateway = false;
    r.db.q("UPDATE coins SET state_at = 0").run();
    chain.warpTo(chain.time + 7 * 3600);
    await r.engine.watchOnce();
    await r.turn();
    expect(chain.sends("retry")).toHaveLength(1);
    await r.engine.watchOnce();
    expect(r.db.q("SELECT COUNT(*) AS n FROM compute_lots WHERE source = 'coin'").get()).toEqual({ n: 1 });
  });

  it("only says what it would send in dry mode", async () => {
    const { r, model, chain } = await world({ mode: "dry", more: { COINS_CHECK_EVERY_S: "0" } });
    const c = model.launch(AGENT, MAKER, "Page Smith", "SMITH");
    model.buy(c, BUYER, ETH, 10n ** 24n);
    await r.turn();
    expect(chain.sends()).toHaveLength(0);
    expect(r.lines.some((l) => /would send coin_sweep/.test(l))).toBe(true);
  });
});

describe("the owner's switch", () => {
  it("hides every coin and stops the sweeps, and the chain is still read so no credit is missed", async () => {
    const { r, model, chain } = await world({ more: { COINS_CHECK_EVERY_S: "0" } });
    const c = model.launch(AGENT, MAKER, "Page Smith", "SMITH");
    turn(r.db, "coins", false, "looking at something");
    model.buy(c, BUYER, ETH, 10n ** 24n);
    await r.turn();
    expect(chain.sends("sweep").filter((s) => s.tx.call!.to === c.splitter)).toHaveLength(0);
    expect((await get(r, "/v1/coins")).enabled).toBe(false);
    expect((await get(r, "/v1/coins")).items).toHaveLength(0);
    expect((await get(r, "/v1/agents/page-smith")).agent.coin).toBeUndefined();
    expect((await get(r, "/v1/state")).coins.enabled).toBe(false);
    // somebody sweeps it themselves: the agent's credit is there all the same
    chain.mine();
    model.split(c, ETH / 100n);
    await r.engine.watchOnce();
    expect(r.db.q("SELECT COUNT(*) AS n FROM compute_lots WHERE source = 'coin'").get()).toEqual({ n: 1 });
    turn(r.db, "coins", true);
    expect((await get(r, "/v1/coins")).items).toHaveLength(1);
  });
});

describe("a permission for an agent Factor runs", () => {
  // anvil's public test keys: worth nothing anywhere
  const agentKey = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
  const makerKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
  const strangerKey = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
  const maker = makerKey.address.toLowerCase();

  function coins(o: { on?: boolean; runs?: boolean; t?: number } = {}) {
    const chain = new FakeChain();
    const model = new Model(chain);
    const db = new EngineDb(open(":memory:"), () => chain.time * 1000);
    db.q("INSERT INTO agent_profiles (address, name, name_key, does, signed_at) VALUES (?, ?, ?, ?, ?)").run(AGENT, "page-smith", "page-smith", "writes", 1);
    const lines: string[] = [];
    const c = new Coins({
      cfg: readCoins(o.on === false ? {} : COINS_ON), db, chain, chainId: 4663, desk: A.desk, nowS: () => o.t ?? chain.time, now: () => chain.time * 1000, log: (l) => lines.push(l),
      names: () => new Map([[AGENT, { name: "page-smith" }]]),
      setters: (a) => (a === AGENT ? [maker] : []),
      signerFor: (a) => (o.runs === false || a !== AGENT ? null : { signTyped: (t: PermissionTypedData) => agentKey.signTypedData(t) }),
      signed: async (address, message, signature) => { const { verifyMessage } = await import("viem"); return verifyMessage({ address: address as Hex, message, signature: signature as Hex }).catch(() => false); },
      record: (a) => (a === AGENT ? { score: 400, settled: 3, barred: false, house: false, hosted: true } : null),
    });
    return { c, chain, model, db, lines };
  }

  const ask = async (k: typeof makerKey, o: { agent?: string; maker?: string; name?: string; symbol?: string; at: number }) => {
    const b = { agent: o.agent ?? AGENT, maker: o.maker ?? maker, name: o.name ?? "Page Smith", symbol: o.symbol ?? "SMITH", at: o.at };
    return { ...b, signature: await k.signMessage({ message: coinAskMessage(b) }) };
  };

  it("is signed by the agent's key for its maker, over the words the launcher checks", async () => {
    const { c, chain } = coins();
    const a = await c.permission(await ask(makerKey, { at: chain.time }));
    expect(a.status).toBe(200);
    const b = a.body as Body;
    expect(b).toMatchObject({ agent: AGENT, maker, name: "Page Smith", symbol: "SMITH", launcher: LAUNCHER, chainId: 4663, nonce: "0", logo: coinLogo("https://factoragents.fun", AGENT), description: coinDescription("Page Smith") });
    const signer = await recoverTypedDataAddress({
      domain: { name: "Factor agent coins", version: "1", chainId: 4663, verifyingContract: getAddress(LAUNCHER) },
      types: { Permission: [{ name: "agent", type: "address" }, { name: "maker", type: "address" }, { name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "logo", type: "string" }, { name: "description", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Permission",
      message: { agent: AGENT as Hex, maker: maker as Hex, name: b.name, symbol: b.symbol, logo: b.logo, description: b.description, nonce: 0n, deadline: BigInt(b.deadline) },
      signature: b.signature,
    });
    expect(signer).toBe(agentKey.address);
    expect(Number(b.deadline)).toBe(chain.time + 3600);
  });

  it("is refused to anyone but the maker, for a bad name, an old signature, an agent with a coin, and an agent Factor does not run", async () => {
    const { c, chain, model } = coins();
    expect((await c.permission(await ask(strangerKey, { maker: strangerKey.address.toLowerCase(), at: chain.time }))).status).toBe(403);
    expect((await c.permission({ ...(await ask(makerKey, { at: chain.time })), signature: (await ask(strangerKey, { at: chain.time })).signature })).status).toBe(401);
    expect((await c.permission(await ask(makerKey, { name: "Moon Rocket", symbol: "MOON", at: chain.time }))).body.error).toMatch(/carries the agent's name/);
    expect((await c.permission(await ask(makerKey, { at: chain.time - 3600 }))).status).toBe(400);
    expect((await c.permission(await ask(makerKey, { agent: "0x00000000000000000000000000000000000000e1", at: chain.time }))).status).toBe(404);
    model.launch(AGENT, maker, "Page Smith", "SMITH");
    expect((await c.permission(await ask(makerKey, { at: chain.time }))).status).toBe(409);
    expect((await coins({ runs: false }).c.permission(await ask(makerKey, { at: chain.time }))).body.error).toMatch(/does not run this agent/);
    expect((await coins({ on: false }).c.permission(await ask(makerKey, { at: chain.time }))).status).toBe(503);
  });
});
