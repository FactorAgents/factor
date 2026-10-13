// The engine's actions on the fee path, against a chain made up for the test: the sweep (its trigger, its
// minimum, its interval) and the burn (a minimum from a quote, never zero), and what every action shares: the
// simulation first, the lock, the gas caps, one transaction at a time, retries, and a restart that sends nothing
// twice.

import { describe, expect, it } from "vitest";
import type { Abi } from "viem";
import { factorBurnPotAbi } from "../../src/abi/index.js";
import { actState, attempt, minimumOut } from "../../src/chain/act.js";
import { A, ETH, FakeChain, MINTED } from "./fake.js";
import { rig } from "./harness.js";

const FEE = (ETH * 37n) / 1000n; // what a 1 ETH trade leaves for the fee address
const detail = (row: { detail: string } | null) => JSON.parse(row!.detail) as Record<string, string | boolean>;

describe("watch mode", () => {
  it("reads and never acts: no simulation, no estimate, no send, whatever is waiting", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    chain.potEth = ETH;
    const r = await rig("watch", { chain });
    await r.turn();
    await r.turn();
    expect(chain.calls.filter((c) => ["simulate", "estimateGas", "send", "fees", "nonces"].includes(c.kind))).toEqual([]);
    expect(r.db.actions()).toEqual([]);
  });
});

describe("collect and split", () => {
  it("sweeps when fees are waiting, and the split is 70 / 20 / 10 to the wei", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(1);
    const a = r.db.lastAction("sweep")!;
    expect(a).toMatchObject({ status: "done", mode: "live", nonce: 0 });
    expect(a.tx_hash).toBe(chain.sends("sweep")[0].hash);
    expect(detail(a)).toMatchObject({ waiting: FEE.toString() });
    await r.engine.watchOnce();
    const s = r.db.splits(1)[0];
    expect(BigInt(s.to_admin)).toBe((FEE * 7000n) / 10000n);
    expect(BigInt(s.to_pool)).toBe((FEE * 1000n) / 10000n);
    expect(BigInt(s.to_burn)).toBe(FEE - (FEE * 7000n) / 10000n - (FEE * 1000n) / 10000n);
    expect(BigInt(s.to_admin) + BigInt(s.to_burn) + BigInt(s.to_pool)).toBe(FEE);
    // the pool's tenth is in the desk, as pool
    expect(chain.pool).toBe(BigInt(s.to_pool));
    // the burn share reached the pot (and, the pot being ready, was spent on a burn in the same pass)
    expect(chain.potEth + chain.totalEthBurned).toBe(BigInt(s.to_burn));
    expect(s.tx_hash).toBe(a.tx_hash);
  });

  it("does not sweep dust: the minimum, and never less than its own gas many times over", async () => {
    const chain = new FakeChain();
    chain.trade(ETH / 10_000n); // 0.0001 ETH: under the 0.0003 minimum
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.sends()).toHaveLength(0);
    expect(r.db.actions()).toEqual([]);
    expect(actState(r.engine.ctx!, "sweep").result).toContain("under the minimum of 0.0003 ETH");
    // gas gets dear: 280,000 gas at 1 gwei is 0.00028 ETH, and a sweep must move 20 times that
    chain.trade(ETH / 1000n);
    chain.gasPrice = 10n ** 9n;
    await r.turn();
    expect(chain.sends()).toHaveLength(0);
    expect(actState(r.engine.ctx!, "sweep").result).toContain("under the minimum of 0.0056 ETH");
    chain.gasPrice = 22_000_000n;
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(1);
  });

  it("sweeps at most once every ten minutes, whoever made the last one", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(1);
    chain.trade(FEE);
    chain.mine(1, 599);
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(1);
    expect(actState(r.engine.ctx!, "sweep").result).toContain("not before 600 s");
    chain.mine(1, 2);
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(2);
    // a stranger's sweep counts too: the engine's own waits ten minutes from it
    chain.mine(1, 700);
    chain.trade(FEE);
    chain["run"]({ to: A.splitter, abi: [], functionName: "sweep" }, A.admin, true, `0x${"cc".repeat(32)}`);
    chain.trade(FEE);
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(2);
  });

  it("in dry mode simulates the sweep, writes down what it would send, and sends nothing", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    const r = await rig("dry", { chain });
    await r.turn();
    expect(chain.calls.filter((c) => c.kind === "simulate" && c.what === "sweep").length).toBeGreaterThan(0);
    expect(chain.calls.filter((c) => c.kind === "estimateGas" && c.what === "sweep")).toHaveLength(1);
    expect(chain.sends()).toHaveLength(0);
    const a = r.db.lastAction("sweep")!;
    expect(a).toMatchObject({ status: "dry", mode: "dry", tx_hash: null });
    expect(detail(a)).toMatchObject({ waiting: FEE.toString(), gasEstimate: "280000", gasLimit: "350000" });
    expect(r.lines.join("\n")).toContain("[dry] would send sweep");
    expect(chain.curveFees).toBe(FEE); // nothing moved
    // and it is not written down again every pass: the next one is ten minutes on
    await r.turn();
    await r.turn();
    expect(r.db.actions("sweep")).toHaveLength(1);
  });

  it("claims a credit in $FACTOR and sends it to the burn pot, only when there is one", async () => {
    const chain = new FakeChain();
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.calls.filter((c) => c.what === "claimToken")).toEqual([]);
    chain.factorCredit = 5000n * ETH;
    chain.mine();
    await r.turn();
    expect(chain.sends("claimToken")).toHaveLength(1);
    expect(chain.potFactor).toBe(5000n * ETH);
    expect(r.db.lastAction("claim_token")).toMatchObject({ status: "done" });
  });
});

describe("buy back and burn", () => {
  it("works out the minimum for the whole planned amount, a tolerance under the quote", () => {
    expect(minimumOut(1000n, 1000n, 500_000n, 100)).toBe(495_000n);
    // a part-filled quote: the contract scales the minimum by what was spent, so it is written for all of it
    expect(minimumOut(1000n, 400n, 200_000n, 100)).toBe(495_000n);
    expect(minimumOut(1000n, 1000n, 500_000n, 0)).toBe(500_000n);
    // nothing bought, nothing spent, nothing planned: no minimum, and so no burn
    expect(minimumOut(1000n, 1000n, 0n, 100)).toBe(0n);
    expect(minimumOut(1000n, 0n, 500n, 100)).toBe(0n);
    expect(minimumOut(0n, 0n, 0n, 100)).toBe(0n);
    expect(minimumOut(1000n, 1000n, -5n, 100)).toBe(0n);
  });

  it("burns when the pot says it may, with a minimum 1% under a fresh quote, and the supply falls", async () => {
    const chain = new FakeChain();
    chain.potEth = (ETH * 555n) / 100_000n; // 15% of a 0.037 ETH fee
    const r = await rig("live", { chain });
    await r.turn();
    const sent = chain.sends("burn");
    expect(sent).toHaveLength(1);
    const quote = chain.potEth === 0n ? ((ETH * 555n) / 100_000n) * chain.tokensPerEth : 0n;
    const min = sent[0].tx.call!.args![0] as bigint;
    expect(min).toBe((quote * 9900n) / 10000n);
    expect(min > 0n).toBe(true);
    // the quote came from the burn itself, simulated and not sent, before anything was sent
    const order = chain.calls.filter((c) => c.what === "burn").map((c) => `${c.kind}:${String(c.args?.[0])}`);
    expect(order[0]).toBe("simulate:0");
    expect(order[order.length - 1]).toBe(`send:${min}`);
    expect(chain.supply).toBe(MINTED - quote);
    expect(detail(r.db.lastAction("burn"))).toMatchObject({ minTokensOut: min.toString(), toleranceBps: 100, quoteBought: quote.toString(), capped: false, partFilled: false });
    await r.engine.watchOnce();
    expect(r.db.burns(5)).toEqual([expect.objectContaining({ n: 1, eth_in: ((ETH * 555n) / 100_000n).toString(), tokens_burned: quote.toString(), caller: A.bot })]);
  });

  it("never sends a burn with a zero minimum, at the trigger or at the last door", async () => {
    const chain = new FakeChain();
    chain.potEth = ETH / 100n;
    chain.tokensPerEth = 0n; // a quote that buys nothing
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.sends()).toHaveLength(0);
    expect(actState(r.engine.ctx!, "burn").result).toContain("no burn is sent without a minimum");
    expect(actState(r.engine.ctx!, "burn").fails).toBe(1);
    // and whatever called it, attempt() will not carry a burn with no minimum
    const pot = { to: A.burnPot, abi: factorBurnPotAbi as Abi, functionName: "burn" };
    await expect(attempt(r.engine.ctx!, "burn", "", { ...pot, args: [0n] }, {}, 10n ** 12n)).rejects.toThrow("never sent with a zero minimum");
    await expect(attempt(r.engine.ctx!, "burn", "", { ...pot, args: [] }, {}, 10n ** 12n)).rejects.toThrow("never sent with a zero minimum");
    expect(chain.sends()).toHaveLength(0);
    expect(r.db.locks()).toEqual([]);
  });

  it("does not count $FACTOR the pot already held as bought", async () => {
    const chain = new FakeChain();
    chain.potEth = ETH / 100n;
    chain.potFactor = 1_000_000n * ETH; // sent on by claimToken
    const r = await rig("live", { chain });
    await r.turn();
    const min = chain.sends("burn")[0].tx.call!.args![0] as bigint;
    expect(min).toBe((((ETH / 100n) * chain.tokensPerEth) * 9900n) / 10000n);
    expect(chain.supply).toBe(MINTED - (ETH / 100n) * chain.tokensPerEth - 1_000_000n * ETH);
  });

  it("waits while the pot says a burn is not allowed yet", async () => {
    const chain = new FakeChain();
    chain.potEth = ETH / 100n;
    chain.startedAt = chain.time - 600; // launched ten minutes ago: no burn in the first thirty
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.calls.filter((c) => c.what === "burn")).toEqual([]);
    expect(actState(r.engine.ctx!, "burn").result).toContain("waits for the next burn");
    chain.mine(1, 1201);
    await r.turn();
    expect(chain.sends("burn")).toHaveLength(1);
    // and a pot holding too little waits for more
    chain.potEth = ETH / 10_000n;
    chain.mine(1, 3600);
    await r.turn();
    expect(chain.sends("burn")).toHaveLength(1);
  });

  it("leaves what is over the pot's own cap for the following intervals", async () => {
    const chain = new FakeChain();
    chain.potEth = ETH;
    chain.depthCap = ETH / 4n; // 1% of the market's depth is a quarter of what the pot holds
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.sends("burn")).toHaveLength(1);
    expect(chain.potEth).toBe((ETH * 3n) / 4n);
    expect(detail(r.db.lastAction("burn"))).toMatchObject({ capped: true, planned: (ETH / 4n).toString(), potBalance: ETH.toString() });
    expect(actState(r.engine.ctx!, "burn").result).toContain("waits for the following intervals");
    // nothing is forced: the next slice goes when the pot's interval has passed, and not before
    chain.mine(1, 900);
    await r.turn();
    expect(chain.sends("burn")).toHaveLength(1);
    chain.mine(1, 901);
    await r.turn();
    expect(chain.sends("burn")).toHaveLength(2);
    expect(chain.potEth).toBe(ETH / 2n);
  });

  it("holds a part-filled burn to the quoted price", async () => {
    const chain = new FakeChain();
    chain.potEth = ETH / 10n;
    chain.fillBps = 4000n; // the pool's price limit stops the swap at 40%
    const r = await rig("live", { chain });
    await r.turn();
    const min = chain.sends("burn")[0].tx.call!.args![0] as bigint;
    expect(min).toBe((((ETH / 10n) * chain.tokensPerEth) * 9900n) / 10000n); // written for the whole planned amount
    expect(r.db.lastAction("burn")).toMatchObject({ status: "done" });
    expect(detail(r.db.lastAction("burn"))).toMatchObject({ partFilled: true });
    expect(chain.potEth).toBe((ETH * 6n) / 100n);
  });

  it("is refused by the chain when the price moved past the tolerance between the quote and the send, and tries again later", async () => {
    const chain = new FakeChain();
    chain.potEth = ETH / 100n;
    const r = await rig("live", { chain });
    // somebody buys in front of the burn: by the time it is mined the same ETH buys 3% less
    const signer = r.engine.ctx!.signer!;
    const send = signer.send.bind(signer);
    signer.send = async (tx, onSigned) => {
      chain.tokensPerEth = (chain.tokensPerEth * 97n) / 100n;
      return send(tx, onSigned);
    };
    await r.turn();
    expect(chain.sends("burn")).toHaveLength(1);
    expect(r.db.lastAction("burn")).toMatchObject({ status: "failed", error: "the transaction reverted" });
    expect(chain.supply).toBe(MINTED); // nothing was bought at the worse price
    expect(chain.potEth).toBe(ETH / 100n);
    // it waits before the next try, then quotes again at the new price and goes through
    signer.send = send;
    await r.turn();
    expect(chain.sends("burn")).toHaveLength(1);
    r.wall.extra += 121_000;
    await r.turn();
    expect(chain.sends("burn")).toHaveLength(2);
    expect(r.db.lastAction("burn")).toMatchObject({ status: "done" });
    expect(actState(r.engine.ctx!, "burn").fails).toBe(0);
  });

  it("in dry mode quotes and simulates, and sends nothing", async () => {
    const chain = new FakeChain();
    chain.potEth = ETH / 100n;
    const r = await rig("dry", { chain });
    await r.turn();
    await r.turn();
    expect(chain.sends()).toHaveLength(0);
    expect(r.db.actions("burn")).toHaveLength(1);
    const a = r.db.lastAction("burn")!;
    expect(a.status).toBe("dry");
    expect(BigInt(detail(a).minTokensOut as string) > 0n).toBe(true);
    expect(chain.potEth).toBe(ETH / 100n);
  });
});

describe("what every action shares", () => {
  it("simulates exactly the call it is about to send, and sends nothing the chain would refuse", async () => {
    const chain = new FakeChain();
    chain.potEth = ETH / 100n;
    chain.marketOpen = false; // between graduation and the pool: nowhere to buy
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.sends()).toHaveLength(0);
    // preview() says not ready, so not even a quote was asked for
    expect(chain.calls.filter((c) => c.what === "burn")).toEqual([]);
    // a call the chain refuses at the last look is written down as refused, not sent
    const out = await attempt(r.engine.ctx!, "burn", "", { to: A.burnPot, abi: factorBurnPotAbi as Abi, functionName: "burn", args: [1n] }, { why: "test" }, 10n ** 12n);
    expect(out).toMatchObject({ status: "failed", why: "the contract refuses it: MarketNotReady" });
    expect(r.db.lastAction("burn")).toMatchObject({ status: "failed", error: "the contract refuses it: MarketNotReady", tx_hash: null });
    expect(chain.sends()).toHaveLength(0);
  });

  it("makes one attempt at a time: a held lock is respected, and one nobody released runs out", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    const r = await rig("live", { chain });
    await r.engine.watchOnce();
    // another attempt (a pass that has not finished) holds the sweep's lock
    r.sqlite.prepare("INSERT INTO engine_locks (name, holder, taken_at, expires_at) VALUES ('sweep', 'someone else', ?, ?)").run(chain.time * 1000, chain.time * 1000 + 170_000);
    await r.engine.actOnce();
    expect(chain.sends()).toHaveLength(0);
    expect(actState(r.engine.ctx!, "sweep").result).toBe("another attempt holds the lock");
    // its holder died: when the lock has run out the sweep goes ahead, and leaves no lock behind
    r.wall.extra += 171_000;
    await r.engine.actOnce();
    expect(chain.sends("sweep")).toHaveLength(1);
    expect(r.db.locks()).toEqual([]);
    // the lock itself: taken once, not twice, free again when released
    expect(r.db.lock("burn", 1000)).toBe(true);
    expect(r.db.lock("burn", 1000)).toBe(false);
    r.db.unlock("burn");
    expect(r.db.lock("burn", 1000)).toBe(true);
  });

  it("sends nothing that would use more gas than its cap", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    chain.gasOf.sweep = 600_000n; // with a quarter to spare that is 750,000: over the sweep's 700,000
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.sends()).toHaveLength(0);
    expect(r.db.lastAction("sweep")).toMatchObject({ status: "failed", error: "it would need 750000 gas, over the cap of 700000" });
    expect(actState(r.engine.ctx!, "sweep").fails).toBe(1);
  });

  it("waits while gas costs more than the cap, without counting it a failure", async () => {
    const chain = new FakeChain();
    chain.trade(ETH); // plenty waiting, so it is not the minimum that stops it
    chain.gasPrice = 3n * 10n ** 9n; // 3 gwei: over the 2 gwei cap
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.sends()).toHaveLength(0);
    expect(r.db.actions()).toEqual([]);
    expect(actState(r.engine.ctx!, "sweep")).toMatchObject({ result: "gas is at 3 gwei, over the cap of 2: waiting for it to fall", fails: 0 });
    chain.gasPrice = 22_000_000n;
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(1);
  });

  it("does not send what the bot wallet cannot pay the gas for", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    chain.balances.set(A.bot, 1000n);
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.sends()).toHaveLength(0);
    expect(r.db.lastAction("sweep")!.error).toContain("not enough for the gas");
  });

  it("retries after a failure with a wait that doubles, and not before", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    chain.rejectSends = true; // the node refuses every send
    const r = await rig("live", { chain });
    await r.turn();
    expect(r.db.lastAction("sweep")).toMatchObject({ status: "failed" });
    expect(r.db.lastAction("sweep")!.error).toContain("insufficient funds");
    const first = actState(r.engine.ctx!, "sweep");
    expect(first.fails).toBe(1);
    expect(first.nextAt).toBe(chain.time * 1000 + r.wall.extra + 60_000);
    await r.turn();
    expect(r.db.actions("sweep")).toHaveLength(1); // not retried inside the wait
    r.wall.extra += 61_000;
    await r.turn();
    expect(r.db.actions("sweep")).toHaveLength(2);
    expect(actState(r.engine.ctx!, "sweep").fails).toBe(2);
    expect(actState(r.engine.ctx!, "sweep").nextAt - (chain.time * 1000 + r.wall.extra)).toBe(120_000);
    // the node takes it now: the retry goes through and the count starts over
    chain.rejectSends = false;
    r.wall.extra += 121_000;
    await r.turn();
    expect(r.db.lastAction("sweep")).toMatchObject({ status: "done" });
    expect(actState(r.engine.ctx!, "sweep")).toMatchObject({ fails: 0, nextAt: 0 });
    expect(r.lines.filter((l) => l.includes("Trying again in"))).toHaveLength(2);
  });

  it("when the request fails and nobody knows if the node took it, looks for it first and sends nothing else", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    chain.potEth = ETH / 100n;
    chain.dropSends = true; // the connection drops: the node never got it
    const r = await rig("live", { chain, more: { ENGINE_STUCK_AFTER_MS: "90000" } });
    await r.turn();
    const a = r.db.lastAction("sweep")!;
    expect(a).toMatchObject({ status: "sent", nonce: 0 });
    expect(a.tx_hash).toMatch(/^0x[0-9a-f]{64}$/); // its hash was written down before the send
    expect(a.error).toContain("the node did not confirm taking it");
    chain.dropSends = false;
    // nothing else goes out while it may still be on its way: not the burn, not a second sweep
    await r.turn();
    await r.turn();
    expect(r.db.actions()).toHaveLength(1);
    expect(chain.curveFees).toBe(FEE);
    // a minute and a half on, with nothing of the bot's in the node's hands, it is known never to have arrived
    r.wall.extra += 91_000;
    await r.turn();
    expect(r.db.action(a.id)).toMatchObject({ status: "failed", error: "it never reached the chain" });
    // and its own trigger sends it again
    await r.turn();
    expect(r.db.lastAction("sweep")).toMatchObject({ status: "done" });
    expect(chain.curveFees).toBe(0n);
    expect(chain.sends("burn")).toHaveLength(1);
  });

  it("when the node took it and the reply was lost, finds it mined and does not send it again", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    chain.loseReply = true;
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.curveFees).toBe(0n); // it was mined
    expect(r.db.lastAction("sweep")).toMatchObject({ status: "sent" });
    chain.loseReply = false;
    chain.trade(FEE);
    await r.turn();
    expect(r.db.lastAction("sweep")).toMatchObject({ status: "done", error: null });
    expect(r.db.actions("sweep")).toHaveLength(1);
    expect(chain.sends("sweep")).toHaveLength(1);
  });

  it("sends one transaction at a time: while one is on its way, nothing else goes", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    chain.potEth = ETH / 100n;
    chain.hold = true; // the sweep is sent and sits in the mempool
    const r = await rig("live", { chain });
    await r.turn();
    expect(chain.sends()).toHaveLength(1);
    expect(r.db.lastAction("sweep")).toMatchObject({ status: "sent", nonce: 0 });
    expect(r.db.lastAction("sweep")!.tx_hash).toBe(chain.sends("sweep")[0].hash);
    // the burn is ready too, but the bot has a transaction out
    await r.turn();
    await r.turn();
    expect(chain.sends()).toHaveLength(1);
    chain.hold = false;
    chain.release();
    await r.turn(); // the sweep's receipt is found, and the burn goes
    expect(r.db.lastAction("sweep")).toMatchObject({ status: "done" });
    expect(chain.sends("burn")).toHaveLength(1);
    expect(chain.sends("sweep")).toHaveLength(1);
  });

  it("after a restart with a transaction on its way, finds it and sends nothing twice", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    chain.hold = true;
    const r = await rig("live", { chain });
    await r.turn();
    const hash = chain.sends("sweep")[0].hash;
    expect(r.db.lastAction("sweep")).toMatchObject({ status: "sent", tx_hash: hash });
    // the process dies; the transaction is mined while it is down
    await r.engine.stop();
    chain.hold = false;
    chain.release();
    chain.trade(FEE); // and more fees have come in since
    const again = await rig("live", { chain, sqlite: r.sqlite });
    await again.turn();
    expect(again.db.lastAction("sweep")).toMatchObject({ status: "done", tx_hash: hash });
    expect(again.lines.join("\n")).toContain("is mined (found on a later look)");
    // the new fees wait for the interval like any others: no second sweep was sent on the restart
    expect(chain.sends("sweep")).toHaveLength(1);
    expect(again.db.actions("sweep")).toHaveLength(1);
  });

  it("after a restart between writing an action down and signing it, knows it never went", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    const r = await rig("live", { chain });
    await r.engine.watchOnce();
    r.db.addAction({ kind: "sweep", mode: "live", status: "signed", nonce: 0 });
    await r.engine.actOnce();
    expect(r.db.actions("sweep").map((a) => [a.status, a.error])).toEqual([["done", null], ["failed", "it was never sent"]]);
    expect(chain.sends("sweep")).toHaveLength(1);
  });

  it("replaces a transaction that is stuck, so it does not hold up everything after it", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    chain.hold = true;
    const r = await rig("live", { chain, more: { ENGINE_STUCK_AFTER_MS: "90000" } });
    await r.turn();
    const stuck = chain.sends("sweep")[0];
    r.wall.extra += 60_000;
    await r.turn();
    expect(chain.sends()).toHaveLength(1); // not long enough yet
    r.wall.extra += 31_000;
    chain.hold = false;
    await r.turn();
    // an empty transfer to the bot itself, on the same nonce, at twice the going fee
    const replacement = chain.sends("transfer")[0];
    expect(replacement.tx).toMatchObject({ call: null, nonce: stuck.tx.nonce, fees: { maxFeePerGas: chain.gasPrice * 2n } });
    expect(r.lines.join("\n")).toContain("was stuck");
    await r.turn();
    const rows = r.db.actions().map((a) => [a.kind, a.status]);
    expect(rows).toContainEqual(["unstick", "done"]);
    expect(r.db.action(r.db.actions("sweep").at(-1)!.id)).toMatchObject({ status: "replaced" });
    // the wallet is free again, and the sweep's own trigger sends it anew
    chain.mine(1, 601);
    await r.turn();
    expect(r.db.lastAction("sweep")).toMatchObject({ status: "done" });
    expect(chain.curveFees).toBe(0n);
  });

  it("on a chain that is not moving, replaces a stuck transaction once per wait, each time dearer, and never past the gas cap", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    chain.hold = true; // nothing is mined at all
    const r = await rig("live", { chain, more: { ENGINE_STUCK_AFTER_MS: "90000" } });
    await r.turn();
    r.wall.extra += 91_000;
    for (let i = 0; i < 4; i++) await r.turn();
    expect(chain.sends("transfer")).toHaveLength(1); // one replacement, not one a pass
    expect(chain.sends("transfer")[0].tx.fees.maxFeePerGas).toBe(chain.gasPrice * 2n);
    r.wall.extra += 91_000;
    for (let i = 0; i < 4; i++) await r.turn();
    expect(chain.sends("transfer")).toHaveLength(2);
    expect(chain.sends("transfer")[1].tx.fees.maxFeePerGas).toBe(chain.gasPrice * 4n);
    expect(chain.sends("sweep")).toHaveLength(1);
    // gas itself gone mad: no replacement is sent at a price over the cap
    chain.gasPrice = 5n * 10n ** 9n;
    r.wall.extra += 91_000;
    await r.turn();
    expect(chain.sends("transfer")).toHaveLength(2);
    expect(r.lines.join("\n")).toContain("over the cap of 20: waiting");
  });

  it("an action that goes wrong does not stop the ones after it", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    chain.potEth = ETH / 100n;
    const r = await rig("live", { chain });
    await r.engine.watchOnce();
    const simulate = chain.simulate.bind(chain);
    chain.simulate = (call, from) => (call.functionName === "sweep" ? Promise.reject(new Error("socket hang up")) : simulate(call, from));
    const pass = await r.engine.actOnce();
    expect(pass.said.sweep).toBe("socket hang up");
    expect(chain.sends("burn")).toHaveLength(1);
  });

  it("stops the pass when the node turns it away, so the loop can wait longer", async () => {
    const chain = new FakeChain();
    chain.trade(FEE);
    const r = await rig("live", { chain });
    await r.engine.watchOnce();
    chain.busy = true;
    await expect(r.engine.actOnce()).rejects.toThrow("Status: 403");
    expect(r.db.actions()).toEqual([]);
  });
});
