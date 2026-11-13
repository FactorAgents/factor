// Selling locked pay on the made-up chain: the claims contract is modelled here (FakeChain.extra) and its logs are written
// in the real encoding, so the engine reads them with the real ABI. What is checked: the switch and the settings; a claim
// listed and bought, shown on its job's page, the seller's and the buyer's agent pages, the lists and the first page; Factor's
// own shown and not counted; the keeper sweeping a pay account only once a sold claim's job can be ended, the shortfall shown
// as the account's debt, and the debt swept once the account holds ETH; the owner's switch; dry mode.

import { encodeAbiParameters, encodeEventTopics, type Abi, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { factorClaimsAbi } from "../src/abi/index.js";
import type { CallSpec } from "../src/chain/chain.js";
import { readClaims } from "../src/claims.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain, S } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

const CC = "0x0000000000000000000000000000000000000c1a";
const KEY = "0x00000000000000000000000000000000000b0001"; // the seller's key
const ACCOUNT = "0x00000000000000000000000000000000000b0002"; // its pay account, the job's agent on the desk
const CUSTOMER = "0x00000000000000000000000000000000000c0001";
const BUYER = "0x0000000000000000000000000000000000d0e701";
const OWN = "0x00000000000000000000000000000000000a0002"; // one of Factor's own wallets
const ZERO = "0x0000000000000000000000000000000000000000";
const ST = { listed: 1, sold: 2, paid: 3, closed: 4 } as const;

interface MC { id: number; account: string; job: number; face: bigint; price: bigint; state: number; seller: string; holder: string; buyer: string; paid: bigint; owing: bigint }

/** The claims contract, as the engine asks things and as the keeper's sweep changes them. */
class Model {
  claims: MC[] = [];
  debt = new Map<string, bigint>();
  constructor(private chain: FakeChain) {
    chain.extra = { answer: (c) => this.answer(c), run: (c, _f, commit, tx) => this.run(c, commit, tx) };
  }

  answer(call: CallSpec): unknown {
    if (call.to.toLowerCase() !== CC) return undefined;
    const fn = call.functionName, a = call.args ?? [];
    if (fn === "desk") return A.desk;
    if (fn === "claim") return this.claims.find((c) => c.id === Number(a[0])) ?? { state: 0, holder: ZERO, buyer: ZERO, seller: ZERO, paid: 0n, owing: 0n };
    if (fn === "debtOf") return this.debt.get(String(a[0]).toLowerCase()) ?? 0n;
    return undefined;
  }

  run(call: CallSpec, commit: boolean, tx: string): unknown {
    if (call.to.toLowerCase() !== CC || call.functionName !== "sweep") return undefined;
    const account = String(call.args?.[0]).toLowerCase();
    let did = false;
    for (const c of this.claims.filter((x) => x.account === account && (x.state === ST.listed || x.state === ST.sold))) {
      const j = this.chain.jobs.get(c.job)!;
      if ((j.state === S.locked || j.state === S.advanced) && this.chain.time > j.dueAt + 12 * 3600) { if (commit) this.chain.refund(c.job); did = true; }
      const ended = ([S.settled, S.half, S.declined, S.refunded] as number[]).includes(this.chain.jobs.get(c.job)!.state) || did;
      if (!ended) continue;
      did = true;
      if (!commit) continue;
      const refunded = this.chain.jobs.get(c.job)!.state === S.refunded;
      if (c.state === ST.listed) { c.state = ST.closed; this.log("Unlisted", { id: BigInt(c.id), job: BigInt(c.job) }, tx); continue; }
      c.state = ST.paid;
      c.paid = refunded ? 0n : c.face;
      c.owing = c.price > c.paid ? c.price - c.paid : 0n;
      this.debt.set(account, (this.debt.get(account) ?? 0n) + c.owing);
      this.log("Paid", { id: BigInt(c.id), job: BigInt(c.job), holder: c.holder, paid: c.paid, owing: c.owing }, tx);
    }
    const debt = this.debt.get(account) ?? 0n;
    const has = this.chain.balances.get(account) ?? 0n;
    if (debt > 0n && has > 0n) {
      did = true;
      if (commit) {
        const c = this.claims.find((x) => x.account === account && x.owing > 0n)!;
        const pay = has < c.owing ? has : c.owing;
        c.owing -= pay;
        this.debt.set(account, debt - pay);
        this.chain.balances.set(account, has - pay);
        this.log("Repaid", { id: BigInt(c.id), holder: c.holder, amount: pay, owing: c.owing }, tx);
      }
    }
    if (!did) throw new Error("NotEnded");
    return null;
  }

  log(eventName: string, args: Record<string, unknown>, tx?: string) {
    const abi = factorClaimsAbi as Abi;
    const ev = abi.find((x) => x.type === "event" && x.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
    const rest = ev.inputs.filter((i) => !i.indexed);
    return this.chain.push({ address: CC, topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[], data: encodeAbiParameters(rest, rest.map((i) => args[i.name]) as never), ...(tx ? { transactionHash: tx } : {}) });
  }

  open(key: string, account: string): void {
    this.chain.mine();
    this.log("Opened", { key, account });
  }

  list(account: string, job: number, face: bigint, price: bigint, seller = KEY): MC {
    this.chain.mine();
    const c: MC = { id: this.claims.length + 1, account: account.toLowerCase(), job, face, price, state: ST.listed, seller: seller.toLowerCase(), holder: ZERO, buyer: ZERO, paid: 0n, owing: 0n };
    this.claims.push(c);
    this.log("Listed", { id: BigInt(c.id), job: BigInt(job), account, face, price });
    return c;
  }

  buy(c: MC, buyer: string): void {
    this.chain.mine();
    c.state = ST.sold;
    c.holder = buyer.toLowerCase();
    c.buyer = buyer.toLowerCase();
    this.log("Bought", { id: BigInt(c.id), job: BigInt(c.job), buyer, seller: c.seller, price: c.price });
  }
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

const ON = { LOCKED_PAY: "on", FACTOR_CLAIMS: CC, FACTOR_CLAIMS_BLOCK: "5000", REPORTS_FACTOR_WALLETS: OWN };

async function world(o: { more?: Record<string, string>; mode?: "live" | "dry" } = {}): Promise<{ r: Rig; chain: FakeChain; model: Model }> {
  const chain = new FakeChain();
  chain.fund(ETH);
  for (const a of [ACCOUNT, BUYER]) chain.register(a);
  const model = new Model(chain);
  const r = await rig(o.mode ?? "live", { chain, more: { ...ON, ...o.more } });
  rigs.push(r);
  const named = (a: string, n: string) => r.db.q("INSERT INTO agent_profiles (address, name, name_key, does, signed_at) VALUES (?, ?, ?, ?, ?)").run(a, n, n, "does work", 1);
  named(ACCOUNT, "pay-agent");
  named(BUYER, "buyer-firm");
  await r.engine.watchOnce();
  return { r, chain, model };
}

type Body = Record<string, any>;
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? "")))!; return { status: a.status, ...(a.body as Body) }; };
const FACE = ETH / 100n - ETH / 5000n; // a 0.01 ETH job less its 2% fee
const PRICE = (FACE * 95n) / 100n; // 5% under
const swept = (chain: FakeChain) => chain.sends("sweep").filter((s) => s.tx.call?.to.toLowerCase() === CC);
const sold = (chain: FakeChain, model: Model, buyer = BUYER) => {
  model.open(KEY, ACCOUNT);
  const job = chain.lock(CUSTOMER, ACCOUNT, ETH / 100n, 2 * 3600);
  const c = model.list(ACCOUNT, job, FACE, PRICE);
  model.buy(c, buyer);
  return { job, c };
};

describe("the settings", () => {
  it("are off unless LOCKED_PAY=on, and say why they cannot run", () => {
    expect(readClaims({}).enabled).toBe(false);
    expect(readClaims({ LOCKED_PAY: "on" }).note).toMatch(/FACTOR_CLAIMS is not set/);
    expect(readClaims({ LOCKED_PAY: "on", FACTOR_CLAIMS: CC }).note).toMatch(/FACTOR_CLAIMS_BLOCK/);
    expect(readClaims(ON).note).toBeNull();
    expect(readClaims(ON).perPass).toBe(5);
    const problems: string[] = [];
    readClaims({ FACTOR_CLAIMS: "nope", FACTOR_CLAIMS_BLOCK: "x", LOCKED_PAY_PER_PASS: "0" }, problems);
    expect(problems).toHaveLength(3);
  });

  it("off, nothing is read or shown, and every claim route but the list and the rules answers 404", async () => {
    const { r, chain, model } = await world({ more: { LOCKED_PAY: "" } });
    sold(chain, model);
    await r.engine.watchOnce();
    expect(r.db.count("claims_claims")).toBe(0);
    expect(await get(r, "/v1/claims")).toMatchObject({ enabled: false, claims: [] });
    expect(await get(r, "/v1/claims/about")).toMatchObject({ enabled: false, totals: null, rules: { maxDiscountBps: 1000, maxOpen: 10 } });
    expect((await get(r, "/v1/state")).claims.enabled).toBe(false);
    expect((await get(r, "/v1/claims/1")).status).toBe(404);
    expect((await get(r, "/v1/claims/job/1")).status).toBe(404);
    expect((await get(r, "/v1/agents/pay-agent")).lockedPay).toBeUndefined();
  });
});

describe("a claim, read from the chain", () => {
  it("shows on its job's page, the seller's and the buyer's pages, the lists and the first page", async () => {
    const { r, chain, model } = await world();
    const { job } = sold(chain, model);
    await r.engine.watchOnce();
    await r.engine.watchOnce();
    const one = (await get(r, "/v1/claims/1")).claim;
    expect(one).toMatchObject({ id: 1, job, account: ACCOUNT, seller: KEY, state: "sold", face: FACE.toString(), price: PRICE.toString(), discountBps: 500, holder: BUYER, holderName: "buyer-firm", buyer: BUYER, paid: "0", owing: "0", jobState: "locked", factorOwn: false });
    expect(one.boughtTx).toMatch(/^0x/);
    expect((await get(r, `/v1/jobs/${job}`)).claim).toMatchObject({ id: 1, state: "sold" });
    expect((await get(r, `/v1/claims/job/${job}`)).claims).toHaveLength(1);
    const seller = await get(r, "/v1/agents/pay-agent");
    expect(seller.lockedPay).toMatchObject({ account: ACCOUNT, key: KEY, debt: "0" });
    expect(seller.lockedPay.claims).toHaveLength(1);
    // the key's address finds the same pay account
    expect((await get(r, `/v1/claims/agent/${KEY}`))).toMatchObject({ account: ACCOUNT, key: KEY });
    const buyer = await get(r, "/v1/agents/buyer-firm");
    expect(buyer.lockedPay).toMatchObject({ account: null, claims: [] });
    expect(buyer.lockedPay.bought[0]).toMatchObject({ id: 1, holder: BUYER });
    const list = await get(r, "/v1/claims");
    expect(list).toMatchObject({ enabled: true, contract: CC, fromBlock: "5000", totals: { claims: 1, listed: 0, sold: 1, faceSold: FACE.toString(), priceSold: PRICE.toString(), paid: "0", factorOwn: 0 } });
    expect(list.claims).toHaveLength(1);
    expect((await get(r, "/v1/claims?state=listed")).claims).toHaveLength(0);
    expect((await get(r, "/v1/state")).claims).toMatchObject({ enabled: true, totals: { sold: 1 } });
    expect(r.lines.some((l) => /\[lockedpay\] claim 1: buyer-firm bought it/.test(l))).toBe(true);
    expect(JSON.stringify([one, list])).not.toMatch(/70%|admin|owner/i);
  });

  it("a claim bought by one of Factor's own is shown, marked and not counted", async () => {
    const { r, chain, model } = await world();
    sold(chain, model, OWN);
    await r.engine.watchOnce();
    await r.engine.watchOnce();
    expect((await get(r, "/v1/claims/1")).claim.factorOwn).toBe(true);
    expect((await get(r, "/v1/claims/about")).totals).toMatchObject({ claims: 0, sold: 0, faceSold: "0", factorOwn: 1 });
  });
});

describe("the keeper", () => {
  it("sweeps only once a sold claim's job can be ended; the shortfall is the account's debt, swept once it holds ETH", async () => {
    const { r, chain, model } = await world();
    const { job } = sold(chain, model);
    await r.engine.watchOnce();
    await r.turn();
    expect(swept(chain)).toHaveLength(0);
    chain.mine(1, 2 * 3600 + 12 * 3600 + 1);
    r.wall.extra += 61_000;
    await r.engine.watchOnce();
    await r.turn();
    expect(swept(chain)).toHaveLength(1);
    expect(chain.jobs.get(job)!.state).toBe(S.refunded);
    r.wall.extra += 61_000;
    await r.engine.watchOnce();
    await r.engine.watchOnce();
    expect((await get(r, "/v1/claims/1")).claim).toMatchObject({ state: "paid", paid: "0", owing: PRICE.toString() });
    expect((await get(r, "/v1/agents/pay-agent")).lockedPay.debt).toBe(PRICE.toString());
    expect(r.lines.some((l) => /claim 1: job \d+ ended, 0\.000000 ETH to its holder, 0\.0093\d+ ETH owed by the pay account/.test(l))).toBe(true);
    // the account is paid something: its debt is swept to the holder
    chain.balances.set(ACCOUNT, ETH / 1000n);
    r.wall.extra += 600_000;
    await r.engine.watchOnce();
    await r.turn();
    expect(swept(chain)).toHaveLength(2);
    await r.engine.watchOnce();
    expect(BigInt((await get(r, "/v1/claims/1")).claim.owing)).toBe(PRICE - ETH / 1000n);
  });

  it("does nothing while the owner's lockedpay switch is off, and claims are hidden", async () => {
    const { r, chain, model } = await world();
    sold(chain, model);
    chain.mine(1, 15 * 3600);
    turn(r.db, "lockedpay", false, "a test");
    await r.engine.watchOnce();
    await r.turn();
    expect(swept(chain)).toHaveLength(0);
    expect((await get(r, "/v1/claims")).claims).toEqual([]);
    expect((await get(r, "/v1/claims/1")).status).toBe(404);
    turn(r.db, "lockedpay", true);
    await r.turn();
    expect(swept(chain)).toHaveLength(1);
  });

  it("in dry mode it only shows what it would send", async () => {
    const { r, chain, model } = await world({ mode: "dry" });
    sold(chain, model);
    chain.mine(1, 15 * 3600);
    await r.engine.watchOnce();
    await r.turn();
    expect(swept(chain)).toHaveLength(0);
    expect(r.lines.some((l) => /\[dry\] would send claims sweep:/.test(l))).toBe(true);
  });
});
