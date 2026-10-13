// The engine at boot: the addresses are checked against the node before anything is read or sent, a wrong one stops
// the engine with one plain line, a node that does not answer is not a wrong address, and the loops run by
// themselves, one pass at a time, and wait longer when the node turns them away.

import { afterEach, describe, expect, it } from "vitest";
import { open } from "../../src/chain/db.js";
import { Engine } from "../../src/engine.js";
import { A, ETH, FakeChain } from "./fake.js";
import { env, rig, wallet } from "./harness.js";

const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
});

async function until(fn: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("it did not happen in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("the boot check", () => {
  it("runs when the two addresses hold the contracts, wired to each other", async () => {
    const r = await rig("watch");
    expect(r.engine.state).toBe("running");
    expect(r.engine.problems).toEqual([]);
    expect(r.lines.join("\n")).toContain("the addresses hold the contracts they should: running");
    expect(r.engine.ctx!.facts.token).toBe(A.token);
  });

  it("stops with a plain line when an address has no contract", async () => {
    const chain = new FakeChain();
    chain.code_.delete(A.burnPot);
    const r = await rig("live", { chain });
    expect(r.engine.state).toBe("stopped");
    expect(r.engine.problems).toEqual([`FACTOR_BURN_POT is ${A.burnPot}, and there is no contract at that address on chain 4663`]);
    expect(r.lines.join("\n")).toContain("STOPPED: FACTOR_BURN_POT is");
    // nothing was read past the check, and nothing sent
    expect(chain.calls.filter((c) => ["logs", "simulate", "send"].includes(c.kind))).toEqual([]);
  });

  it("stops when the token is not the burn pot's", async () => {
    const other = wallet(0xdead);
    const r = await rig("watch", { more: { FACTOR_TOKEN: other } });
    expect(r.engine.state).toBe("stopped");
    expect(r.engine.problems).toEqual([`the burn pot's token() is ${A.token}, not FACTOR_TOKEN ${other}`]);
    // and when a token is named but nothing has been launched from that pot
    const chain = new FakeChain();
    chain.token = null;
    const early = await rig("watch", { chain, more: { FACTOR_TOKEN: A.token } });
    expect(early.engine.problems[0]).toContain("the burn pot's token() is not set (nothing is launched from it)");
    // the right token, in any case, is fine
    expect((await rig("watch", { more: { FACTOR_TOKEN: A.token.toUpperCase().replace("0X", "0x") } })).engine.state).toBe("running");
  });

  it("stops when the contracts are not wired to each other, or the admin is not the one named", async () => {
    const cases: [keyof FakeChain["wiring"], string][] = [
      ["splitterBurn", "the splitter sends its burn share to"],
      ["potSplitter", "the burn pot's splitter() is"],
    ];
    for (const [wire, says] of cases) {
      const chain = new FakeChain();
      chain.wiring[wire] = wallet(0xbad);
      const r = await rig("watch", { chain });
      expect(r.engine.state).toBe("stopped");
      expect(r.engine.problems[0]).toContain(says);
    }
    const r = await rig("watch", { more: { FACTOR_ADMIN: wallet(0x777) } });
    expect(r.engine.problems).toEqual([`the splitter's admin is ${A.admin}, not FACTOR_ADMIN ${wallet(0x777)}`]);
    expect((await rig("watch", { more: { FACTOR_ADMIN: A.admin } })).engine.state).toBe("running");
  });

  it("stops when an address holds some other contract, or the node is on another chain", async () => {
    // the two addresses given the wrong way round: neither answers the other's questions
    const swapped = await rig("watch", { more: { FACTOR_SPLITTER: A.burnPot, FACTOR_BURN_POT: A.splitter } });
    expect(swapped.engine.state).toBe("stopped");
    expect(swapped.engine.problems[0]).toContain("does not answer");
    const chain = new FakeChain();
    chain.id = 1;
    const wrong = await rig("watch", { chain });
    expect(wrong.engine.problems).toEqual(["the node is on chain 1, not 4663 (Robinhood Chain): FACTOR_RPC_URLS points somewhere else"]);
    const late = await rig("watch", { more: { FACTOR_DEPLOY_BLOCK: "999999999" } });
    expect(late.engine.problems[0]).toContain("past the chain's head");
  });

  it("does not take a node that does not answer for a wrong address: it waits and tries again", async () => {
    const chain = new FakeChain();
    chain.down = true;
    const r = await rig("watch", { chain });
    engines.push(r.engine);
    expect(r.engine.state).toBe("starting");
    expect(r.engine.problems).toEqual([]);
    expect(r.engine.lastError).toMatchObject({ where: "boot", message: "fetch failed" });
    expect(r.lines.join("\n")).toContain("trying again in 30 s");
  });

  it("warns, and goes on, when the gas wallet's key is the admin's", async () => {
    const chain = new FakeChain();
    const lines: string[] = [];
    const engine = new Engine(open(":memory:"), { env: env("live"), chain, signer: chain.signer(A.admin), log: (l) => lines.push(l), manual: true });
    engine.start();
    await engine.ready();
    expect(engine.state).toBe("running");
    expect(engine.warnings.join(" ")).toContain("the gas wallet must be a wallet of its own");
  });

  it("does not start on a configuration with something missing, and says what", async () => {
    const lines: string[] = [];
    const engine = new Engine(open(":memory:"), { env: { ENGINE_MODE: "live", FACTOR_SPLITTER: A.splitter }, log: (l) => lines.push(l) });
    engine.start();
    await engine.ready();
    expect(engine.state).toBe("stopped");
    expect(engine.ctx).toBeNull();
    expect(lines.filter((l) => l.includes("NOT STARTED"))).toHaveLength(4);
    expect(lines.join("\n")).toContain("FACTOR_BURN_POT is not set");
    expect(lines.join("\n")).toContain("FACTOR_DESK is not set");
    expect(lines.join("\n")).toContain("FACTOR_DEPLOY_BLOCK is not set");
    expect(lines.join("\n")).toContain("BOT_PRIVATE_KEY is not set");
  });

  it("in dry mode with a key set, tries everything as that key's wallet and sends nothing", async () => {
    // the key is in the environment (as on launch day's dry stage), the mode is dry
    const chain = new FakeChain();
    const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const engine = new Engine(open(":memory:"), { env: env("dry", { BOT_PRIVATE_KEY: KEY }), chain, log: () => {}, manual: true });
    engine.start();
    await engine.ready();
    expect(engine.ctx!.signer).toBeNull();
    expect(engine.ctx!.facts.bot).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    expect(engine.ctx!.facts.from).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    chain.trade(ETH);
    await engine.watchOnce();
    await engine.actOnce();
    expect(chain.sends()).toHaveLength(0);
    expect(chain.calls.some((c) => c.kind === "simulate" && c.what === "sweep")).toBe(true);
  });

  it("without any key, tries the calls as the admin: they are open to anyone", async () => {
    const chain = new FakeChain();
    const engine = new Engine(open(":memory:"), { env: env("dry"), chain, log: () => {}, manual: true });
    engine.start();
    await engine.ready();
    expect(engine.ctx!.facts.bot).toBeNull();
    expect(engine.ctx!.facts.from).toBe(A.admin);
  });

  it("reads the chain again from the deploy block when ENGINE_REINDEX holds a new value, once", async () => {
    const chain = new FakeChain();
    chain.trade(ETH);
    chain["run"]({ to: A.splitter, abi: [], functionName: "sweep" }, wallet(9), true, `0x${"ab".repeat(32)}`);
    const r = await rig("watch", { chain });
    await r.engine.watchOnce();
    expect(r.db.cursor("splitter")).toBe(chain.number);
    expect(r.db.count("chain_splits")).toBe(1);
    const again = await rig("watch", { chain, sqlite: r.sqlite, more: { ENGINE_REINDEX: "2026-10-12" } });
    expect(again.db.cursor("splitter")).toBeNull();
    expect(again.db.count("chain_splits")).toBe(0);
    await again.engine.watchOnce();
    expect(again.db.count("chain_splits")).toBe(1);
    // the same value at the next boot does nothing
    const third = await rig("watch", { chain, sqlite: r.sqlite, more: { ENGINE_REINDEX: "2026-10-12" } });
    expect(third.db.cursor("splitter")).toBe(chain.number);
  });
});

describe("the loops", () => {
  it("run by themselves: the chain is read and a sweep is sent with nobody calling anything", async () => {
    const chain = new FakeChain();
    chain.trade(ETH);
    const engine = new Engine(open(":memory:"), { env: env("live", { ENGINE_WATCH_EVERY_MS: "250", ENGINE_ACT_EVERY_MS: "250" }), chain, signer: chain.signer(), log: () => {}, now: () => chain.time * 1000, pollMs: 5 });
    engines.push(engine);
    engine.start();
    await until(() => chain.sends("sweep").length === 1, 5000);
    const health = (await engine.handle("/v1/health"))!.body as { state: string; loops: Record<string, { runs: number }> };
    expect(health.state).toBe("running");
    expect(health.loops.watch.runs).toBeGreaterThan(0);
    expect(health.loops.act.runs).toBeGreaterThan(0);
  });

  it("wait longer when the node turns them away, say so once, and come back", async () => {
    const chain = new FakeChain();
    const lines: string[] = [];
    const sqlite = open(":memory:");
    const engine = new Engine(sqlite, { env: env("watch", { ENGINE_WATCH_EVERY_MS: "250" }), chain, log: (l) => lines.push(l) });
    engines.push(engine);
    engine.start();
    await engine.ready();
    await until(() => (sqlite.prepare("SELECT COUNT(*) AS n FROM engine_cursors").get() as { n: number }).n === 4, 3000);
    chain.busy = true;
    await until(() => lines.filter((l) => l.includes("turning requests away")).length === 1, 3000);
    await new Promise((res) => setTimeout(res, 900));
    // said once, not once a run; and not counted as a failure
    expect(lines.filter((l) => l.includes("turning requests away"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("failed"))).toEqual([]);
    chain.busy = false;
    await until(() => lines.some((l) => l.includes("the node answers again")), 5000);
  });

  it("stop, and leave nothing running", async () => {
    const chain = new FakeChain();
    const engine = new Engine(open(":memory:"), { env: env("watch", { ENGINE_WATCH_EVERY_MS: "250" }), chain, log: () => {} });
    engine.start();
    await until(() => chain.calls.some((c) => c.kind === "head"), 3000);
    await engine.stop();
    const asked = chain.calls.length;
    await new Promise((res) => setTimeout(res, 600));
    expect(chain.calls.length).toBe(asked);
    expect(engine.state).toBe("stopped");
  });
});
