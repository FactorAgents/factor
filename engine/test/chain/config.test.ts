// The engine's configuration: off unless told otherwise, the names contracts/deploy.sh writes, plain lines for
// whatever is missing or wrong, and the gas wallet's key never anywhere but the signer.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configured, DEFAULTS, PUBLIC_RPC, readConfig, readParams, takeBotKey } from "../../src/chain/config.js";
import { A } from "./fake.js";
import { env, TEST_KEY } from "./harness.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the engine's configuration", () => {
  it("is off when nothing is set, and asks for nothing", () => {
    const c = readConfig({});
    expect(c.mode).toBe("off");
    expect(c.problems).toEqual([]);
    expect(configured(c)).toBe(false);
    // off with half the addresses set is still off, without a complaint
    expect(readConfig({ ENGINE_MODE: "off", FACTOR_SPLITTER: "nonsense" }).problems).toEqual([]);
  });

  it("refuses a mode it does not know, and runs nothing", () => {
    const c = readConfig({ ENGINE_MODE: "on" });
    expect(c.mode).toBe("off");
    expect(c.problems.join(" ")).toContain("ENGINE_MODE must be off, watch, dry or live");
    expect(readConfig({ ...env("live"), ENGINE_MODE: " LIVE " }).mode).toBe("live");
  });

  it("says plainly which address is missing", () => {
    const c = readConfig({ ENGINE_MODE: "watch", FACTOR_SPLITTER: A.splitter });
    expect(c.problems).toEqual(["FACTOR_BURN_POT is not set", "FACTOR_DESK is not set", "FACTOR_DEPLOY_BLOCK is not set (contracts/deploy.sh writes it: the block to read logs from)"]);
    expect(configured(c)).toBe(false);
  });

  it("refuses what is not an address, the zero address, and two contracts at one address", () => {
    expect(readConfig(env("watch", { FACTOR_BURN_POT: "0x1234" })).problems).toEqual(['FACTOR_BURN_POT is not an address: "0x1234"']);
    expect(readConfig(env("watch", { FACTOR_BURN_POT: `0x${"0".repeat(40)}` })).problems).toEqual(["FACTOR_BURN_POT is the zero address"]);
    expect(readConfig(env("watch", { FACTOR_BURN_POT: A.splitter })).problems).toEqual(["FACTOR_SPLITTER and FACTOR_BURN_POT are the same address"]);
    expect(readConfig(env("watch", { FACTOR_DEPLOY_BLOCK: "soon" })).problems.join(" ")).toContain("FACTOR_DEPLOY_BLOCK must be a block number");
  });

  it("takes addresses in any case and keeps them lowercase", () => {
    const mixed = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    const c = readConfig(env("watch", { FACTOR_BURN_POT: mixed, FACTOR_TOKEN: ` ${mixed.toUpperCase().replace("0X", "0x")} ` }));
    expect(c.problems).toEqual([]);
    expect(c.burnPot).toBe(mixed.toLowerCase());
    expect(c.token).toBe(mixed.toLowerCase());
  });

  it("is configured with the two addresses and the deploy block, the token optional, the public node by default", () => {
    const c = readConfig({ ...env("watch"), FACTOR_RPC_URLS: undefined });
    expect(c.problems).toEqual([]);
    expect(configured(c)).toBe(true);
    expect(c.token).toBeNull();
    expect(c.deployBlock).toBe(5000n);
    expect(c.rpcUrls).toEqual([PUBLIC_RPC]);
    expect(PUBLIC_RPC).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(c.chainId).toBe(4663);
    expect(readConfig(env("watch", { FACTOR_RPC_URLS: " https://a.example/key , https://b.example " })).rpcUrls).toEqual(["https://a.example/key", "https://b.example"]);
    expect(readConfig(env("watch", { FACTOR_RPC_URLS: "ftp://a" })).problems.length).toBe(1);
  });

  it("needs the gas wallet's key for live and nothing else, and never keeps the key", () => {
    const without = readConfig(env("live", { BOT_PRIVATE_KEY: "" }));
    expect(without.problems.join(" ")).toContain("ENGINE_MODE is live and BOT_PRIVATE_KEY is not set");
    expect(readConfig(env("dry")).problems).toEqual([]);
    const withKey = readConfig(env("live", { BOT_PRIVATE_KEY: TEST_KEY }));
    expect(withKey.problems).toEqual([]);
    expect(withKey.hasBotKey).toBe(true);
    expect(JSON.stringify(withKey, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(TEST_KEY.slice(2));
    expect(readConfig(env("live", { BOT_PRIVATE_KEY: "not a key" })).problems.join(" ")).toContain("BOT_PRIVATE_KEY must be 32 bytes of hex");
    // with or without the 0x in front
    expect(takeBotKey({ BOT_PRIVATE_KEY: TEST_KEY.slice(2) })).toBe(TEST_KEY);
    expect(takeBotKey({ BOT_PRIVATE_KEY: ` ${TEST_KEY} ` })).toBe(TEST_KEY);
    expect(takeBotKey({ BOT_PRIVATE_KEY: "0x12" })).toBeNull();
    expect(takeBotKey({})).toBeNull();
  });

  it("lets its clock follow the chain's only for a rehearsal on a local fork, never on a real node", () => {
    expect(readConfig(env("live")).rehearsalClock).toBe(false);
    const real = readConfig(env("live", { FACTOR_REHEARSAL_CLOCK: "chain", FACTOR_RPC_URLS: "https://rpc.mainnet.chain.robinhood.com" }));
    expect(real.problems.join(" ")).toContain("FACTOR_REHEARSAL_CLOCK is for a rehearsal on a local fork");
    expect(configured(real)).toBe(false);
    // one real node among local ones is still a real node, and a look-alike host is not local
    expect(readConfig(env("live", { FACTOR_REHEARSAL_CLOCK: "chain", FACTOR_RPC_URLS: "http://127.0.0.1:8645,https://rpc.mainnet.chain.robinhood.com" })).problems.length).toBe(1);
    expect(readConfig(env("live", { FACTOR_REHEARSAL_CLOCK: "chain", FACTOR_RPC_URLS: "http://127.0.0.1.example.com" })).problems.length).toBe(1);
    const fork = readConfig(env("live", { FACTOR_REHEARSAL_CLOCK: "chain", FACTOR_RPC_URLS: "http://127.0.0.1:8645" }));
    expect(fork.problems).toEqual([]);
    expect(fork.rehearsalClock).toBe(true);
  });

  it("reads the file contracts/deploy.sh writes, and lets the environment win over it", () => {
    const dir = mkdtempSync(join(tmpdir(), "factor-env-"));
    dirs.push(dir);
    const file = join(dir, "factor.env");
    writeFileSync(file, [`FACTOR_ADMIN=${A.admin}`, `FACTOR_BURN_POT=${A.burnPot}`, `FACTOR_DESK=${A.desk}`, `FACTOR_SPLITTER=${A.splitter}`, "FACTOR_DEPLOY_BLOCK=84000000", `FACTOR_TOKEN=${A.token}`, "# a comment", ""].join("\n"));
    const c = readConfig({ ENGINE_MODE: "watch", FACTOR_ENV_FILE: file, FACTOR_DEPLOY_BLOCK: "84000123" });
    expect(c.problems).toEqual([]);
    expect([c.splitter, c.burnPot, c.desk, c.token, c.admin]).toEqual([A.splitter, A.burnPot, A.desk, A.token, A.admin]);
    expect(c.deployBlock).toBe(84000123n);
    expect(readConfig({ ENGINE_MODE: "watch", FACTOR_ENV_FILE: join(dir, "missing.env") }).problems.join(" ")).toContain("FACTOR_ENV_FILE names a file that cannot be read");
  });

  it("has a parameter for every interval, minimum, tolerance and cap, each settable", () => {
    expect(readParams({})).toEqual({ ...DEFAULTS, lockMs: DEFAULTS.lockMs });
    // the burn pot allows a burn every 30 minutes; the engine sweeps every ten, and closes a few due jobs a pass
    expect(DEFAULTS).toMatchObject({ sweepEveryS: 600, jobsPerPass: 5, burnToleranceBps: 100 });
    const problems: string[] = [];
    const p = readParams({ ENGINE_SWEEP_EVERY_S: "900", ENGINE_MIN_SWEEP_WEI: "1000000000000000", ENGINE_BURN_TOLERANCE_BPS: "50", ENGINE_CONFIRMATIONS: "40", ENGINE_MAX_GAS_GWEI: "0.5", ENGINE_UNSTICK_MAX_GAS_GWEI: "30", ENGINE_JOBS_PER_PASS: "2" }, problems);
    expect(problems).toEqual([]);
    expect(p.sweepEveryS).toBe(900);
    expect(p.minSweepWei).toBe(10n ** 15n);
    expect(p.burnToleranceBps).toBe(50);
    expect(p.confirmations).toBe(40);
    expect(p.maxGasWei).toBe(500_000_000n);
    expect(p.unstickMaxGasWei).toBe(30_000_000_000n);
    expect(p.jobsPerPass).toBe(2);
  });

  it("refuses a parameter that is not a number, and a burn tolerance loose enough to mean nothing", () => {
    const problems: string[] = [];
    const p = readParams({ ENGINE_SWEEP_EVERY_S: "ten minutes", ENGINE_MIN_SWEEP_WEI: "0.0003", ENGINE_MAX_GAS_GWEI: "2e9", ENGINE_BURN_TOLERANCE_BPS: "10000" }, problems);
    expect(problems.length).toBe(4);
    expect(problems.join(" ")).toContain("ENGINE_BURN_TOLERANCE_BPS must be under 1000");
    expect(p.sweepEveryS).toBe(DEFAULTS.sweepEveryS);
    expect(p.minSweepWei).toBe(DEFAULTS.minSweepWei);
    expect(p.burnToleranceBps).toBe(DEFAULTS.burnToleranceBps);
    // and such a configuration does not start
    expect(configured(readConfig(env("watch", { ENGINE_SWEEP_EVERY_S: "ten minutes" })))).toBe(false);
  });
});
