// The watchers, against a chain made up for the test: the splitter's and the burn pot's logs into the database once,
// from a cursor that survives a stop, a few blocks behind the head, and back again after a reorg.

import { describe, expect, it } from "vitest";
import { readLogs } from "../../src/chain/chain.js";
import { snapshotOf } from "../../src/chain/context.js";
import { A, ETH, FakeChain, MINTED } from "./fake.js";
import { rig, wallet } from "./harness.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "a")}`;
let made = 0;
// Anyone can sweep and anyone can burn: here a stranger does, so that the logs are on the chain without the engine.
function sweep(chain: FakeChain, fee = ETH): string {
  chain.trade(fee);
  const h = hash(++made);
  chain["run"]({ to: A.splitter, abi: [], functionName: "sweep" }, wallet(9), true, h);
  return h;
}
function burn(chain: FakeChain): string {
  chain.mine(1, 1800);
  const h = hash(++made);
  chain["run"]({ to: A.burnPot, abi: [], functionName: "burn", args: [1n] }, wallet(9), true, h);
  return h;
}

// A chain with one of everything on it.
function busyChain(): { chain: FakeChain; split: string; burned: string } {
  const chain = new FakeChain();
  const split = sweep(chain);
  chain.mine(3);
  const burned = burn(chain);
  chain.mine(2);
  return { chain, split, burned };
}

describe("the watchers", () => {
  it("read the contracts' logs and the mint into the database, with the block's time", async () => {
    const { chain, split, burned } = busyChain();
    const r = await rig("watch", { chain });
    const pass = await r.engine.watchOnce();
    expect(pass.fresh).toBe(4); // the mint, the split, the pool's share arriving in the desk, the burn
    expect(r.db.splits(10)).toEqual([
      expect.objectContaining({ tx_hash: split, amount: ETH.toString(), to_admin: ((ETH * 7n) / 10n).toString(), to_burn: ((ETH * 2n) / 10n).toString(), to_pool: (ETH / 10n).toString(), admin_pushed: 1, burn_pushed: 1, pool_pushed: 1 }),
    ]);
    const b = r.db.burns(10)[0];
    expect(b).toMatchObject({ tx_hash: burned, n: 1, caller: wallet(9), eth_in: ((ETH * 2n) / 10n).toString(), tokens_burned: ((ETH * 2n) / 10n * 500_000n).toString(), via_curve: 1 });
    expect(b.at).toBe(chain.time);
    expect(r.db.events("token", "Transfer")[0].args).toMatchObject({ from: "0x0000000000000000000000000000000000000000", value: MINTED.toString() });
    // every watcher has read to the head (no confirmations asked for in this test)
    expect(r.db.cursors().map((c) => [c.watcher, c.block])).toEqual(["burnPot", "desk", "splitter", "token"].map((w) => [w, Number(chain.number)]));
  });

  it("prices a burn in dollars at the ETH price it had when the engine saw it", async () => {
    const { chain } = busyChain();
    const r = await rig("watch", { chain });
    await r.engine.watchOnce(); // the first reading has no price yet when the burn is written
    expect(snapshotOf(r.db)!.ethUsd8).toBe((2_500n * 10n ** 8n).toString());
    sweep(chain);
    burn(chain);
    chain.ethUsd = 3_000n * 10n ** 8n; // the price moves after the engine's reading
    await r.engine.watchOnce();
    expect(r.db.burns(1)[0]).toMatchObject({ n: 2, eth_usd8: (2_500n * 10n ** 8n).toString() });
    expect(snapshotOf(r.db)!.ethUsd8).toBe((3_000n * 10n ** 8n).toString());
    // a feed that does not answer keeps the last price and stops nothing
    chain.feedsDown = true;
    chain.mine();
    await r.engine.watchOnce();
    expect(snapshotOf(r.db)!.ethUsd8).toBe((3_000n * 10n ** 8n).toString());
  });

  it("stays the confirmations behind the head", async () => {
    const { chain } = busyChain();
    const r = await rig("watch", { chain, more: { ENGINE_CONFIRMATIONS: "4" } });
    await r.engine.watchOnce();
    // the burn is 2 blocks under the head: not read yet
    expect(r.db.count("chain_burns")).toBe(0);
    expect(r.db.count("chain_splits")).toBe(1);
    expect(r.db.cursor("burnPot")).toBe(chain.number - 4n);
    chain.mine(2);
    await r.engine.watchOnce();
    expect(r.db.count("chain_burns")).toBe(1);
  });

  it("writes nothing twice when the same blocks are read again", async () => {
    const r = await rig("watch", { chain: busyChain().chain });
    await r.engine.watchOnce();
    const count = () => ({ events: r.db.count("chain_events"), splits: r.db.count("chain_splits"), burns: r.db.count("chain_burns") });
    const before = count();
    // every cursor back to the start: the whole chain is read again
    for (const c of r.db.cursors()) r.db.setCursor(c.watcher, 4999n);
    r.wall.extra += 60_000;
    const again = await r.engine.watchOnce();
    expect(again.fresh).toBe(0);
    expect(count()).toEqual(before);
  });

  it("goes on from its cursor: a long catch-up is read a stretch at a time and survives a stop in the middle", async () => {
    const chain = new FakeChain();
    for (let i = 0; i < 6; i++) {
      chain.mine(8);
      sweep(chain);
    }
    const r = await rig("watch", { chain, more: { ENGINE_LOG_SPAN: "10", ENGINE_SPANS_PER_PASS: "2" } });
    await r.engine.watchOnce();
    // two stretches of ten blocks, and no more in one pass
    expect(r.db.cursor("splitter")).toBe(5019n);
    expect(r.db.count("chain_splits")).toBe(2);
    // the node goes away in the middle of the next pass
    chain.down = true;
    await expect(r.engine.watchOnce()).rejects.toThrow("fetch failed");
    chain.down = false;
    expect(r.db.cursor("splitter")).toBe(5019n);
    // a new engine on the same database (a restart) carries on from the cursor, not from the deploy block
    const second = await rig("watch", { chain, sqlite: r.sqlite, more: { ENGINE_LOG_SPAN: "10", ENGINE_SPANS_PER_PASS: "2" } });
    chain.calls = [];
    await second.engine.watchOnce();
    const asked = chain.calls.filter((c) => c.kind === "logs").map((c) => c.what);
    expect(asked).toContain("5020-5029");
    expect(asked.some((w) => w.startsWith("5000-"))).toBe(false);
    for (let i = 0; i < 4; i++) await second.engine.watchOnce();
    expect(second.db.cursor("splitter")).toBe(chain.number);
    expect(second.db.count("chain_splits")).toBe(6);
  });

  it("halves a stretch the node refuses as too big, and still reads every log in it", async () => {
    const chain = new FakeChain();
    for (let i = 0; i < 5; i++) {
      chain.mine(6);
      sweep(chain);
    }
    chain.tooManyAbove = 6n;
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    expect(r.db.count("chain_splits")).toBe(5);
    expect(chain.calls.filter((c) => c.kind === "logs").length).toBeGreaterThan(10);
    // one block that alone is over the cap cannot be narrowed: it is said, not skipped
    await expect(readLogs({ logs: async () => Promise.reject(new Error("logs matched by query exceeds limit of 10000")) }, 5n, 5n, { address: A.splitter }, 10n, () => {})).rejects.toThrow("exceeds limit");
  });

  it("rewinds after a reorg: what was read above the fork is taken back and read again", async () => {
    const chain = new FakeChain();
    chain.mine(5);
    const stays = sweep(chain);
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    chain.mine(3);
    await r.engine.watchOnce();
    const gone = sweep(chain); // will be reorged out
    await r.engine.watchOnce();
    expect(r.db.splits(10).map((s) => s.tx_hash)).toEqual([gone, stays]);
    const cursorBefore = r.db.cursor("splitter")!;

    // the last two blocks are replaced by others: that split is not on the chain any more
    chain.reorg(2);
    chain.curveFees = 0n;
    const instead = sweep(chain, ETH / 2n); // and something else happened instead
    r.lines.length = 0;
    const pass = await r.engine.watchOnce();
    expect(pass.rewoundTo).not.toBeNull();
    expect(pass.rewoundTo! < cursorBefore).toBe(true);
    expect(r.lines.join("\n")).toContain("the chain changed under block");
    expect(r.db.splits(10).map((s) => s.tx_hash)).toEqual([instead, stays]); // below the fork: untouched
    expect(r.db.cursor("splitter")).toBe(chain.number);
    // and the next pass finds nothing wrong
    expect((await r.engine.watchOnce()).rewoundTo).toBeNull();
  });

  it("goes back to the deploy block when no block it remembers is on the chain any more", async () => {
    const chain = new FakeChain();
    sweep(chain);
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    chain.mine(2);
    await r.engine.watchOnce();
    chain.reorg(Number(chain.number - 5000n)); // everything since the deploy
    const only = sweep(chain);
    const pass = await r.engine.watchOnce();
    expect(pass.rewoundTo).toBe(4999n);
    expect(r.db.splits(10).map((s) => s.tx_hash)).toEqual([only]);
  });

  it("reads what the contracts hold from the chain itself: the supply, the pot, the next burn", async () => {
    const chain = new FakeChain();
    chain.potEth = (ETH * 3n) / 1000n;
    chain.supply = MINTED - 1234n * ETH;
    chain.phase = 2;
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    const s = snapshotOf(r.db)!;
    expect(s.block).toBe(Number(chain.number));
    expect(s.token).toEqual({ address: A.token, totalSupply: (MINTED - 1234n * ETH).toString() });
    expect(s.phase).toBe("pool");
    expect(s.burnPot).toMatchObject({ balance: ((ETH * 3n) / 1000n).toString(), nextAmount: ((ETH * 3n) / 1000n).toString(), ready: true, open: true, viaCurve: false });
    expect(s.splitter).toMatchObject({ unsplit: "0", adminPending: "0", burnPending: "0", totalSplit: "0" });
    expect(s.bot).toEqual({ address: A.bot, balance: (ETH / 100n).toString() });
  });

  it("waits for the token: nothing is cached as 'no token', and the mint is read once there is one", async () => {
    const chain = new FakeChain();
    chain.token = null;
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    expect(snapshotOf(r.db)!.token).toBeNull();
    expect(r.db.cursor("token")).toBeNull();
    expect(r.db.cursor("splitter")).toBe(chain.number);
    chain.token = A.token; // the launch
    chain.mine();
    await r.engine.watchOnce();
    expect(snapshotOf(r.db)!.token?.address).toBe(A.token);
    expect(r.db.events("token", "Transfer")).toHaveLength(1);
    expect(r.lines.join("\n")).toContain("$FACTOR is launched");
  });

  it("reads the two contracts with one query a pass, and looks for another mint only every few minutes", async () => {
    const { chain } = busyChain();
    const r = await rig("watch", { chain });
    await r.engine.watchOnce(); // the first pass finds the mint
    expect(r.db.events("token", "Transfer")).toHaveLength(1);
    sweep(chain);
    chain.mine(8);
    chain.calls = [];
    await r.engine.watchOnce();
    expect(chain.calls.filter((c) => c.kind === "logs")).toHaveLength(1); // one query for the splitter and the burn pot together
    expect(r.db.count("chain_splits")).toBe(2);
    expect(r.db.cursor("splitter")).toBe(chain.number);
    expect(r.db.cursor("token")).toBe(chain.number - 9n); // the mint watcher has not moved
    chain.mine(3000);
    chain.calls = [];
    await r.engine.watchOnce();
    expect(chain.calls.filter((c) => c.kind === "logs")).toHaveLength(2); // three thousand blocks on, it looks again
    expect(r.db.cursor("token")).toBe(chain.number);
  });

  it("asks the node nothing at all in a pass beyond a bounded handful of requests", async () => {
    const r = await rig("watch", { chain: busyChain().chain });
    await r.engine.watchOnce();
    r.chain.calls = [];
    await r.engine.watchOnce(); // nothing new
    const by = (k: string) => r.chain.calls.filter((c) => c.kind === k).length;
    expect(by("logs")).toBe(0); // every cursor is at the head already
    expect(by("head")).toBe(1);
    expect(by("block")).toBeLessThanOrEqual(2);
    expect(by("send") + by("simulate") + by("estimateGas")).toBe(0);
  });
});
