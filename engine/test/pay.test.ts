// Pay with Factor on the made-up chain: a link an agent signed, read and checked; a job locked through it, matched
// against the lock's own log; what the buyer added to the burn, read from its transaction; the same over x402; the
// links an agent shows; and the record another app reads, with an attestation it can check.

import { keccak256, recoverTypedDataAddress, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { decodePayLink, dealBurnWei, encodePayLink, payLinkId, payLinkMessage, readPay, type PayLink } from "../src/pay.js";
import { recordTypedData, type RecordJson } from "../src/record.js";
import { A, ETH, FakeChain, K } from "./chain/fake.js";
import { rig, TEST_KEY, type Rig } from "./chain/harness.js";
import { recordSigner } from "../src/record.js";

// anvil's public test keys: worth nothing anywhere
const agentKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const otherKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const AGENT = agentKey.address.toLowerCase();
const BUYER = "0x00000000000000000000000000000000000b0e01";
const PRICE = ETH / 25n; // 0.04

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

async function desk(more: Record<string, string> = {}): Promise<Rig> {
  const chain = new FakeChain();
  chain.fund(ETH);
  chain.register(AGENT);
  const r = await rig("live", { chain, more });
  rigs.push(r);
  await r.engine.watchOnce();
  return r;
}

const linkOf = (chain: FakeChain, over: Partial<PayLink> = {}): PayLink => ({ v: 1, agent: AGENT, price: PRICE.toString(), title: "Summarise a 40-page contract", brief: "Read it and list every date and every amount.", due: 24, early: true, exp: chain.time + 30 * 86400, id: "0123456789abcdef", ...over });
const sign = async (l: PayLink, key = agentKey): Promise<string> => encodePayLink(l, await key.signMessage({ message: payLinkMessage(l) }));
const get = async (r: Rig, path: string) => (await r.engine.handle(path))!;
const post = async (r: Rig, path: string, body: unknown) => (await r.engine.post(path, body, "1.2.3.4"))!;

describe("a link", () => {
  it("is the facts and the agent's signature, and comes back out the same", async () => {
    const chain = new FakeChain();
    const l = linkOf(chain);
    const token = await sign(l);
    const got = decodePayLink(token);
    expect(typeof got).toBe("object");
    expect((got as { link: PayLink }).link).toEqual(l);
    // what is signed is readable, and is the same text the kit and the site build (their tests hold the same lines)
    expect(payLinkMessage({ ...l, exp: 1_800_000_000 })).toBe([
      "Factor: Pay with Factor link",
      `agent: ${AGENT}`,
      "price: 0.04 ETH",
      "title: Summarise a 40-page contract",
      `brief: ${keccak256(toHex("Read it and list every date and every amount."))}`,
      "due: 24 hours after it is paid",
      "early: up to half may be drawn before delivery",
      "expires: 1800000000",
      "id: 0123456789abcdef",
    ].join("\n"));
    expect(payLinkId(l)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses what is not one: a price under the smallest job, a long brief, a due time out of range, no id", () => {
    const chain = new FakeChain();
    const bad = (over: Partial<PayLink>) => decodePayLink(`${Buffer.from(JSON.stringify(linkOf(chain, over))).toString("base64url")}.${"A".repeat(88)}`);
    expect(bad({ price: "100" })).toMatch(/smallest job/);
    expect(bad({ brief: "x".repeat(2001) })).toMatch(/brief/);
    expect(bad({ due: 0 })).toMatch(/due time/);
    expect(bad({ due: 721 })).toMatch(/due time/);
    expect(bad({ title: "see https://example.com now" })).toMatch(/title/);
    expect(bad({ id: "nope" })).toMatch(/id/);
    expect(decodePayLink("hello")).toMatch(/not a Pay with Factor link/);
  });

  it("adds a share of the price to the burn, rounded up", () => {
    expect(dealBurnWei(PRICE, 100)).toBe(PRICE / 100n);
    expect(dealBurnWei(1001n, 100)).toBe(11n);
    expect(dealBurnWei(PRICE, 0)).toBe(0n);
    expect(readPay({}).burnBps).toBe(100);
    const problems: string[] = [];
    expect(readPay({ PAY_BURN_BPS: "5000" }, problems).burnBps).toBe(100);
    expect(problems[0]).toMatch(/PAY_BURN_BPS/);
  });
});

describe("reading a link", () => {
  it("says what it sells, what the buyer pays and where each part goes", async () => {
    const r = await desk();
    const token = await sign(linkOf(r.chain));
    const a = await get(r, `/v1/pay/link/${token}`);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ registered: true, priceEth: "0.04", burnEth: "0.0004", totalWei: (PRICE + PRICE / 100n).toString(), desk: A.desk, burnPot: A.burnPot, paused: null });
    expect(String(a.body.url)).toBe(`https://factoragents.fun/pay/${token}`);
    expect(String(a.body.x402)).toBe(`https://factoragents.fun/api/v1/x402/${token}`);
  });

  it("refuses a link somebody changed, one another wallet signed, and one that expired, politely", async () => {
    const r = await desk();
    const l = linkOf(r.chain);
    const token = await sign(l);
    // the price changed on the way: the signature no longer covers it
    const [, sig] = token.split(".");
    const cheaper = `${Buffer.from(JSON.stringify({ ...l, price: (PRICE / 2n).toString() })).toString("base64url")}.${sig}`;
    const changed = await get(r, `/v1/pay/link/${cheaper}`);
    expect(changed.status).toBe(400);
    expect(String(changed.body.error)).toMatch(/changed after its agent signed it/);
    expect((await get(r, `/v1/pay/link/${await sign(l, otherKey)}`)).status).toBe(400);
    const old = await get(r, `/v1/pay/link/${await sign(linkOf(r.chain, { exp: r.chain.time - 10 }))}`);
    expect(old.status).toBe(410);
    expect(String(old.body.error)).toMatch(/expired on .* Ask the agent for a new one/);
    expect((await get(r, `/v1/pay/link/${await sign(linkOf(r.chain, { exp: r.chain.time + 400 * 86400 }))}`)).status).toBe(400);
  });

  it("says so when the agent has not signed up, and locks nothing for it", async () => {
    const r = await desk();
    const stranger = otherKey.address.toLowerCase();
    const a = await get(r, `/v1/pay/link/${await sign(linkOf(r.chain, { agent: stranger }), otherKey)}`);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ registered: false });
    expect(String(a.body.error)).toMatch(/has not signed up/);
  });

  it("is switched off with PAY=off", async () => {
    const r = await desk({ PAY: "off" });
    expect((await get(r, `/v1/pay/link/${await sign(linkOf(r.chain))}`)).status).toBe(503);
  });
});

describe("a deal", () => {
  it("is a job locked through the link, checked against the lock's own log, with the burn read from its transaction", async () => {
    const r = await desk();
    const l = linkOf(r.chain);
    const token = await sign(l);
    const { id, hash } = r.chain.lockTx(BUYER, AGENT, PRICE, 24 * 3600, true);
    const burnTx = r.chain.transfer(BUYER, A.burnPot, PRICE / 100n);
    const a = await post(r, "/v1/pay/deal", { link: token, job: id, lockTx: hash, burnTx });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ ok: true, job: id, customer: BUYER, agent: AGENT, burned: true, burnWei: (PRICE / 100n).toString() });
    // asked again, the same answer: a buyer whose page reloaded can send it twice
    expect((await post(r, "/v1/pay/deal", { link: token, job: id, lockTx: hash, burnTx })).body).toMatchObject({ ok: true, burned: true });
    // the job carries the link's title and brief, and says it was paid with Factor
    await r.engine.watchOnce();
    const job = (await get(r, `/v1/jobs/${id}`)).body as { job: { title: string; deal?: { via: string; burnEth: number } }; brief: string };
    expect(job.job.title).toBe(l.title);
    expect(job.brief).toBe(l.brief);
    expect(job.job.deal).toEqual({ via: "checkout", burnEth: 0.0004 });
    const s = (await get(r, "/v1/state")).body as { pay: { enabled: boolean; deals: number; burnedEth: number } };
    expect(s.pay).toMatchObject({ enabled: true, deals: 1, burnedEth: 0.0004 });
  });

  it("refuses a job that is not what the link says: another price, another agent, another due time, early not as said", async () => {
    const r = await desk();
    r.chain.register(otherKey.address);
    const token = await sign(linkOf(r.chain));
    const try_ = async (lock: { id: number; hash: string }) => post(r, "/v1/pay/deal", { link: token, job: lock.id, lockTx: lock.hash });
    expect(String((await try_(r.chain.lockTx(BUYER, AGENT, PRICE / 2n, 24 * 3600, true))).body.error)).toMatch(/price/);
    expect(String((await try_(r.chain.lockTx(BUYER, otherKey.address, PRICE, 24 * 3600, true))).body.error)).toMatch(/another agent/);
    expect(String((await try_(r.chain.lockTx(BUYER, AGENT, PRICE, 2 * 3600, true))).body.error)).toMatch(/due at another time/);
    expect(String((await try_(r.chain.lockTx(BUYER, AGENT, PRICE, 24 * 3600, false))).body.error)).toMatch(/early advance/);
    // a lock's due time a few minutes off (the buyer's clock) is the link's all the same
    expect((await try_(r.chain.lockTx(BUYER, AGENT, PRICE, 24 * 3600 + 300, true))).status).toBe(200);
    // a transaction that is no lock, and one the chain does not have
    const plain = r.chain.transfer(BUYER, A.burnPot, 1n);
    expect(String((await post(r, "/v1/pay/deal", { link: token, job: 1, lockTx: plain })).body.error)).toMatch(/did not lock that job/);
    expect((await post(r, "/v1/pay/deal", { link: token, job: 1, lockTx: `0x${"12".repeat(32)}` })).status).toBe(404);
  });

  it("counts a burn only when it is the buyer's own, big enough, and not counted for another deal", async () => {
    const r = await desk();
    const token = await sign(linkOf(r.chain));
    const lock = () => r.chain.lockTx(BUYER, AGENT, PRICE, 24 * 3600, true);
    const a = lock();
    const fromSomebodyElse = r.chain.transfer("0x00000000000000000000000000000000000000e1", A.burnPot, PRICE / 100n);
    expect((await post(r, "/v1/pay/deal", { link: token, job: a.id, lockTx: a.hash, burnTx: fromSomebodyElse })).body).toMatchObject({ ok: true, burned: false, burnNote: expect.stringMatching(/another wallet/) });
    const tooSmall = r.chain.transfer(BUYER, A.burnPot, PRICE / 1000n);
    expect((await post(r, "/v1/pay/deal", { link: token, job: a.id, lockTx: a.hash, burnTx: tooSmall })).body).toMatchObject({ burned: false, burnNote: expect.stringMatching(/under the deal's/) });
    const refused = r.chain.transfer(BUYER, A.burnPot, PRICE / 100n, false);
    expect((await post(r, "/v1/pay/deal", { link: token, job: a.id, lockTx: a.hash, burnTx: refused })).body).toMatchObject({ burned: false, burnNote: expect.stringMatching(/refused/) });
    const toSomewhereElse = r.chain.transfer(BUYER, "0x00000000000000000000000000000000000000e2", PRICE / 100n);
    expect((await post(r, "/v1/pay/deal", { link: token, job: a.id, lockTx: a.hash, burnTx: toSomewhereElse })).body).toMatchObject({ burned: false, burnNote: expect.stringMatching(/not a transfer to the burn pot/) });
    // the burn can follow the lock: a buyer who sent it a moment later still has the deal counted
    const good = r.chain.transfer(BUYER, A.burnPot, PRICE / 100n);
    expect((await post(r, "/v1/pay/deal", { link: token, job: a.id, lockTx: a.hash, burnTx: good })).body).toMatchObject({ burned: true });
    // and one transfer counts for one deal only
    const b = lock();
    expect((await post(r, "/v1/pay/deal", { link: token, job: b.id, lockTx: b.hash, burnTx: good })).body).toMatchObject({ burned: false, burnNote: expect.stringMatching(/already counted/) });
  });

  it("takes a link that expired after the job was locked, and not one that had expired before", async () => {
    const r = await desk();
    const token = await sign(linkOf(r.chain, { exp: r.chain.time + 3600 }));
    const early = r.chain.lockTx(BUYER, AGENT, PRICE, 24 * 3600, true);
    r.chain.mine(1, 7200);
    expect((await post(r, "/v1/pay/deal", { link: token, job: early.id, lockTx: early.hash })).status).toBe(200);
    const late = r.chain.lockTx(BUYER, AGENT, PRICE, 24 * 3600, true);
    expect((await post(r, "/v1/pay/deal", { link: token, job: late.id, lockTx: late.hash })).status).toBe(410);
  });
});

describe("x402", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

  it("answers 402 with what to pay, and the job's number once the lock is on the chain", async () => {
    const r = await desk();
    const token = await sign(linkOf(r.chain, { early: false }));
    const ask = await r.engine.x402(`/v1/x402/${token}`, undefined, `https://factoragents.fun/api/v1/x402/${token}`);
    expect(ask.status).toBe(402);
    const accepts = (ask.body.accepts as Record<string, any>[])[0]!;
    expect(accepts).toMatchObject({ scheme: "factor-lock", network: "robinhood-chain", maxAmountRequired: (PRICE + PRICE / 100n).toString(), payTo: A.desk, asset: "0x0000000000000000000000000000000000000000", description: "Summarise a 40-page contract" });
    expect(accepts.extra).toMatchObject({ agent: AGENT, priceWei: PRICE.toString(), burnWei: (PRICE / 100n).toString(), burnPot: A.burnPot, dueInHours: 24, allowEarly: false });
    // the paying agent's program locks the price and adds to the burn, then asks again with the proof of it
    const { id, hash } = r.chain.lockTx(BUYER, AGENT, PRICE, 24 * 3600, false);
    const burnTx = r.chain.transfer(BUYER, A.burnPot, PRICE / 100n);
    const paid = await r.engine.x402(`/v1/x402/${token}`, b64({ x402Version: 1, scheme: "factor-lock", network: "robinhood-chain", payload: { job: id, lockTx: hash, burnTx } }), "x");
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ ok: true, job: id, burned: true });
    expect(JSON.parse(Buffer.from(paid.headers["x-payment-response"]!, "base64").toString())).toMatchObject({ success: true, transaction: hash, network: "robinhood-chain", payer: BUYER, job: id });
    expect(r.engine.pay!.store.deal(id)?.via).toBe("x402");
  });

  it("answers 402 again for a payment that is not one, in words", async () => {
    const r = await desk();
    const token = await sign(linkOf(r.chain));
    const bad = await r.engine.x402(`/v1/x402/${token}`, "not base64 json", "x");
    expect(bad.status).toBe(402);
    expect(bad.body.error).toMatch(/not base64 of JSON/);
    const other = await r.engine.x402(`/v1/x402/${token}`, b64({ x402Version: 1, scheme: "exact", network: "base", payload: {} }), "x");
    expect(other.body.error).toMatch(/not of the scheme factor-lock/);
    const notYet = await r.engine.x402(`/v1/x402/${token}`, b64({ x402Version: 1, scheme: "factor-lock", network: "robinhood-chain", payload: { job: 7, lockTx: `0x${"ab".repeat(32)}` } }), "x");
    expect(notYet.status).toBe(402);
    expect(notYet.body.error).toMatch(/again in a few seconds/);
    expect((await r.engine.x402(`/v1/x402/hello`, undefined, "x")).status).toBe(404);
  });
});

describe("an agent's links", () => {
  it("shows the links its agent publishes, until they expire, and only ones the agent signed", async () => {
    const r = await desk();
    const token = await sign(linkOf(r.chain));
    expect((await post(r, "/v1/pay/links", { link: token })).status).toBe(200);
    expect((await post(r, "/v1/pay/links", { link: await sign(linkOf(r.chain), otherKey) })).status).toBe(400);
    const items = ((await get(r, `/v1/pay/links/${AGENT}`)).body as { items: { title: string; priceEth: string; url: string }[] }).items;
    expect(items).toEqual([expect.objectContaining({ title: "Summarise a 40-page contract", priceEth: "0.04", url: `https://factoragents.fun/pay/${token}` })]);
    const short = await sign(linkOf(r.chain, { id: "fedcba9876543210", exp: r.chain.time + 60 }));
    await post(r, "/v1/pay/links", { link: short });
    r.chain.mine(1, 120);
    await r.engine.watchOnce();
    expect(((await get(r, `/v1/pay/links/${AGENT}`)).body as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe("the record", () => {
  it("is the desk's own figures for the agent, with an attestation another app can check", async () => {
    const r = await desk();
    const token = await sign(linkOf(r.chain));
    // one deal paid with Factor and settled, one rejected, one nobody answered
    const a = r.chain.lockTx(BUYER, AGENT, PRICE, 24 * 3600, true);
    await post(r, "/v1/pay/deal", { link: token, job: a.id, lockTx: a.hash, burnTx: r.chain.transfer(BUYER, A.burnPot, PRICE / 100n) });
    r.chain.draw(a.id, PRICE / 2n, K.early);
    r.chain.deliver(a.id);
    r.chain.accept(a.id);
    const b = r.chain.lock(BUYER, AGENT, PRICE);
    r.chain.deliver(b);
    r.chain.reject(b);
    r.chain.lock("0x00000000000000000000000000000000000b0e02", AGENT, PRICE, 3600);
    await r.engine.watchOnce();
    await r.engine.watchOnce();
    const rec = (await get(r, `/v1/record/${AGENT}`)).body as unknown as RecordJson;
    expect(rec).toMatchObject({
      version: 1, agent: AGENT, chainId: 4663, desk: A.desk,
      jobs: { locked: 3, open: 1, delivered: 2, onTime: 1, settled: 1, settledAtHalf: 1, declined: 0, refunded: 0 },
      advances: { repaid: 0, notRepaid: 0, earlyKept: 0 },
      volumeWei: PRICE.toString(), distinctCustomers: 1,
      payWithFactor: { deals: 1, burnedWei: (PRICE / 100n).toString() },
    });
    // the attestation is the record's figures, signed by the key the engine publishes
    const signer = ((await get(r, "/v1/record/signer")).body as { signer: string }).signer;
    expect(signer).toBe(recordSigner({ BOT_PRIVATE_KEY: TEST_KEY })!.address);
    const att = rec.attestation!;
    expect(att.signer).toBe(signer);
    const by = await recoverTypedDataAddress({ ...recordTypedData(4663, A.desk, att.message), signature: att.signature as Hex } as never);
    expect(by.toLowerCase()).toBe(signer);
    expect(att.message).toMatchObject({ agent: AGENT, settled: 1, settledAtHalf: 1, delivered: 2, volume: PRICE.toString() });
    // changed by one, it is no longer Factor's
    const forged = await recoverTypedDataAddress({ ...recordTypedData(4663, A.desk, { ...att.message, settled: 9 }), signature: att.signature as Hex } as never);
    expect(forged.toLowerCase()).not.toBe(signer);
    expect((await get(r, "/v1/record/0x0000000000000000000000000000000000000009")).status).toBe(404);
  });

  it("is signed by RECORD_SIGNING_KEY when the owner set one, and has no attestation without any key", () => {
    const own = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
    expect(recordSigner({ RECORD_SIGNING_KEY: own })!.address).toBe(privateKeyToAccount(own).address.toLowerCase());
    expect(recordSigner({})).toBeNull();
    // derived from the gas wallet's key for this use alone: never the gas wallet's own address
    expect(recordSigner({ BOT_PRIVATE_KEY: TEST_KEY })!.address).not.toBe(privateKeyToAccount(TEST_KEY).address.toLowerCase());
  });
});
