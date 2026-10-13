// The dress rehearsal: a whole day of Factor, from the launch to the next morning, on a LOCAL copy of Robinhood Chain.
// Nothing here can reach the real chain: every transaction goes to an anvil this script starts on 127.0.0.1.
//
//   npm run rehearsal              the whole day and every check (about 50 minutes), then everything is stopped
//   npm run rehearsal -- --stay    the copy of the chain, the engine and the site are left running to look at
//   npm run rehearsal -- --stop    stops what --stay left running
//   npm run rehearsal -- --hours 3 only the first hours, to try the script itself
//
// What is different from the end-to-end run (scripts/e2e.ts), which checks each part quickly:
//
//   the engine runs AS THE HOST WILL RUN IT. Every pace and every limit is the default: it looks at the chain every
//   10 seconds and stays 20 blocks behind, acts every 30 seconds, sweeps no more often than every 10 minutes, keeps
//   its daily copies, sends the gas wallet's surplus on to the owner. Nothing is sped up but the chain's own clock,
//   which is moved on half an hour at a time;
//
//   it is a day and not a list of cases. Trading goes on all day, on the curve in the morning and in the pool after
//   the token graduates in the afternoon. Agents and customers come and go through it: jobs that go well, a
//   delivery that is rejected, briefs an agent will not work from, an agent nobody hears from, and an agent that
//   draws an advance and never delivers, which the pool pays for. The owner stops the engine's sending for an hour,
//   the engine is killed in the middle of the afternoon, new jobs are paused and opened again;
//
//   at the end every wei is accounted for: what trading paid against what the owner, the burn and the pool each
//   got, the supply against what was burned, the desk's books against what it holds, the engine's copy of every
//   job and agent against the desk, and what the gas wallet spent doing it.
//
// The model is the stand-in (scripts/stub-model.ts): no model is called and nothing is spent.
//
// A copy of this chain does not live an hour by itself: the public node lets go of the block it was made at within
// minutes. Three things here are for that and nothing else: the scout (the road through Pons, walked once at the
// start and taken back), the copy's source and the engine's node (scripts/rehearsal-node.ts), and two system
// contracts emptied on the copy. Each says why where it stands. What the last run did and found: docs/REHEARSAL.md.
//
// Keys: the admin and the gas wallet are anvil's first two built-in test accounts, which anvil prints for anybody
// at startup. Everybody else in the day is a key made here for this run and thrown away with it. None of them is
// a wallet of Factor's: those do not exist yet, and are made at deployment.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createPublicClient, defineChain, encodeAbiParameters, encodeFunctionData, hashMessage, hashTypedData, http, keccak256, parseAbi, parseEther, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { factorBurnPotAbi, factorDeskAbi, factorSplitterAbi, factorTokenAbi } from "../src/abi/index.js";
import { deskCall, orderTypedData, type Call } from "../src/accounts.js";
import type { AgentJson, EventJson, FactorState, JobJson } from "../src/api.js";
import { keyMessage } from "../src/compute.js";
import { ponsEscrowAbi, ponsFactoryAbi } from "../src/chain/pons.js";
import { FEEDS } from "../src/house/feeds.js";
import { briefMessage, profileMessage, proofOf, titleMessage } from "../src/profiles.js";
import { softPasskey } from "./passkey.js";

const ENGINE = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONTRACTS = join(ENGINE, "..", "contracts");
const WEB = join(ENGINE, "..", "web");
const FOUNDRY = join(process.env.HOME ?? "", ".foundry", "bin");
const LIVE_RPC = process.env.E2E_FORK_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ANVIL_PORT = 8656, NODE_PORT = 8657, SOURCE_PORT = 8658, ENGINE_PORT = 8799, MODEL_PORT = 8801, SITE_PORT = 3630;
// the engine's node: the copy of the chain, quoting the real chain's price of gas (see `nodeForTheEngine`)
const ENGINE_RPC = `http://127.0.0.1:${NODE_PORT}`;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`, API = `http://127.0.0.1:${ENGINE_PORT}`, SITE = `http://localhost:${SITE_PORT}`;
const WORK = join(tmpdir(), "factor-rehearsal");
// made up here: the stand-in's key is a key to nothing, and the owner's key is good for this local engine only
const MODEL_KEY = "sk-ant-rehearsal-stand-in-a-key-to-nothing";
const ADMIN_KEY = "rehearsal-owner-key-of-this-local-run";
// Pons' own contracts on the chain (contracts/test/fork/ForkBase.sol says where each was read from)
const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e", ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e", HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044", POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const PONS_OPERATOR = "0xa1018c1D9655292A2dE0F7dEa9a0F848EaA8cA83", PONS_KEEPER = "0x49BbF2b70955Fb3a106e084D4BFDa92d334573d2";
const ETH_USD_FEED = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const STAY = args.includes("--stay");
const HOURS = Number(flag("--hours") ?? 26);
const STEP_S = 1800;

// anvil's first two built-in test accounts: the same on every machine, printed by anvil itself
const ADMIN = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80").address;
const BOT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d";
const BOT = privateKeyToAccount(BOT_KEY).address;
// everybody else: a key for this run only. The local node sends for any address, so these sign texts and nothing more.
const fresh = (): PrivateKeyAccount => privateKeyToAccount(generatePrivateKey());
const who = { trader1: fresh(), trader2: fresh(), trader3: fresh(), whale: fresh(), poolMaker: fresh(), anna: fresh(), ben: fresh(), lumen: fresh(), drift: fresh(), idle: fresh(), gaslessKey: fresh(), stranger: fresh(), owner: fresh(), payout: fresh() };
const low = (a: string) => a.toLowerCase();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
const eth = (wei: bigint) => (Number(wei / 10n ** 12n) / 1e6).toString();
const near = (a: number, wei: bigint) => Math.abs(a - Number(wei / 10n ** 12n) / 1e6) < 1e-9;
const tokens = (wei: bigint) => Math.round(Number(wei / 10n ** 18n)).toLocaleString("en-US");

// what happened, by the hour: the day as the report tells it
let hourNow = 0;
const day: { hour: number; text: string }[] = [];
function note(text: string): void {
  day.push({ hour: hourNow, text });
  console.log(`  T+${hourNow.toFixed(1).padStart(4)}h  ${text}`);
}

function pidsOn(port: number): number[] {
  const r = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).map(Number);
}
async function stopPort(port: number, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  for (const pid of pidsOn(port)) { try { process.kill(pid, signal); } catch { /* gone already */ } }
  for (let i = 0; i < 100 && pidsOn(port).length; i++) await sleep(100);
  for (const pid of pidsOn(port)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone already */ } }
}
const stopAll = async () => { for (const p of [SITE_PORT, ENGINE_PORT, ANVIL_PORT, MODEL_PORT, NODE_PORT, SOURCE_PORT]) await stopPort(p); };

// The two go-betweens (scripts/rehearsal-node.ts), each its own process: where the copy of the chain reads the real
// chain from, and what the engine reads the copy through.
function goBetween(...what: string[]): void {
  const log = openSync(join(WORK, "node.log"), "a");
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["scripts/rehearsal-node.ts", ...what], { cwd: ENGINE, stdio: ["ignore", log, log], detached: true }).unref();
}

const chain = defineChain({ id: 4663, name: "Robinhood Chain (local fork)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const client = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }) });
async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const read = <T>(address: string, abi: Abi, functionName: string, a: unknown[] = []) => client.readContract({ address: address as Hex, abi, functionName, args: a }) as Promise<T>;
const blockTime = async () => Number((await client.getBlock()).timestamp);
const balance = (a: string) => client.getBalance({ address: a as Hex });
const hex = (n: bigint) => `0x${n.toString(16)}`;

// A transaction from anybody in the day. The local node sends it for them: no key is used.
async function sendRaw(from: string, to: string, data: Hex, value = 0n, gas = 2_500_000): Promise<void> {
  const hash = await rpc<Hex>("eth_sendTransaction", [{ from, to, data, value: hex(value), gas: hex(BigInt(gas)) }]);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 250 });
  if (receipt.status !== "success") throw new Error(`a transaction from ${from} to ${to} reverted (${data.slice(0, 10)})`);
}
const send = (from: string, to: string, abi: Abi, functionName: string, a: unknown[] = [], value = 0n) => sendRaw(from, to, encodeFunctionData({ abi, functionName, args: a }), value);
const pay = (from: string, to: string, value: bigint) => sendRaw(from, to, "0x", value, 100_000);
// The chain's clock, moved to a moment: the next block is mined then, and time runs on from it.
async function warpTo(t: number): Promise<void> {
  if ((await blockTime()) >= t) return;
  await rpc("evm_setNextBlockTimestamp", [t]);
  await rpc("evm_mine", []);
}
// Twenty-two blocks at once, a second apart: what the engine waits for before it believes what it read.
const seen = () => rpc("anvil_mine", ["0x16", "0x1"]);
async function waitFor<T>(what: string, fn: () => Promise<T | null | false | undefined>, ms = 120_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    let v: T | null | false | undefined = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

function forge(script: string, extraEnv: Record<string, string>, sig?: string): string {
  const r = spawnSync(
    join(FOUNDRY, "forge"),
    ["script", script, "--rpc-url", RPC, ...(sig ? ["--sig", sig] : ["--broadcast", "--unlocked", "--sender", ADMIN])],
    { cwd: CONTRACTS, encoding: "utf8", env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}`, FOUNDRY_BROADCAST: join(WORK, "broadcast"), ...extraEnv } },
  );
  if (r.status !== 0) throw new Error(`forge script ${script}${sig ? ` ${sig}` : ""} failed:\n${(r.stdout + r.stderr).split("\n").slice(-25).join("\n")}`);
  return r.stdout;
}

interface Health {
  state: string; mode: string; problems: string[]; warnings: string[]; lastError: { at: number; where: string; message: string } | null; phase: string | null;
  watchers: { watcher: string; cursor: number }[]; loops: Record<string, { runs: number; failures: number; lastRunAt: number | null; lastOkAt: number | null }>;
  actions: Record<string, { done: number; failed: number; result: string }>; onTheirWay: unknown[]; stopped: Record<string, unknown>;
  gasWallet: { wei: string; low: boolean } | null; desk: { waitingToBeRead: number; dueToSettle: number; dueToRefund: number } | null;
  house: { delivered: number; declined: number; gaveUp: number; underWay: number; spentTodayMicro: number } | null;
  accounts: { enabled: boolean; orders: number; failed: number; gasTodayWei: string } | null;
  compute: { calls: number; spentMicro: number; unpaidMicro: number } | null; ledger: number; ethUsd8: string | null;
}
type State = FactorState & { paused: string | null };
type Own = AgentJson & { service?: { needs: string; delivers: string; fromEth: number } };
type Page = { job: JobJson; brief: string | null; work: { kind: string; text: string } | null; note?: string };
const get = async <T>(path: string) => (await (await fetch(`${API}${path}`)).json()) as T;
const state = () => get<State>("/v1/state");
const health = () => get<Health>("/v1/health");
const post = async (path: string, body: unknown) => { const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
const flip = (what: string, on: boolean) => fetch(`${API}/v1/admin/switch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY }, body: JSON.stringify({ what, on }) });

// The engine as its own process, the way the host runs it: environment only, and every pace and limit its default.
// Only what a host must be told is set: the mode, the key of the gas wallet, where the contracts are, the node, and
// what is switched on. FACTOR_REHEARSAL_CLOCK lets its clock follow this copy of the chain, which is moved on by hand.
function startEngine(dataDir: string, envFile: string, more: Record<string, string> = {}): void {
  mkdirSync(dataDir, { recursive: true });
  const log = openSync(join(WORK, "engine.log"), "a");
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ENGINE_|FACTOR_|HOUSE_|COMPUTE_|ACCOUNTS_|ANTHROPIC_)/.test(k)));
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["src/main.ts"], {
    cwd: ENGINE, stdio: ["ignore", log, log], detached: true,
    env: {
      ...clean, PORT: String(ENGINE_PORT), FACTOR_DATA_DIR: dataDir, ENGINE_MODE: "live", BOT_PRIVATE_KEY: BOT_KEY, FACTOR_ENV_FILE: envFile, FACTOR_RPC_URLS: ENGINE_RPC, FACTOR_REHEARSAL_CLOCK: "chain",
      ENGINE_ADMIN_KEY: ADMIN_KEY, ENGINE_SKIM_TO: who.owner.address,
      ACCOUNTS_MODE: "on",
      COMPUTE_MODE: "on", ANTHROPIC_API_KEY: MODEL_KEY, COMPUTE_UPSTREAM_URL: `http://127.0.0.1:${MODEL_PORT}`,
      HOUSE_MODE: "on", HOUSE_UPSTREAM_URL: `http://127.0.0.1:${MODEL_PORT}`, HOUSE_PAYOUT: who.payout.address,
      ...more,
    },
  }).unref();
}

const CURVE = parseAbi(["function buy(uint256 amountIn, uint256 minOut, address to) payable returns (uint256)", "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)", "function readyToGraduate() view returns (bool)"]) as Abi;
const ERC20 = parseAbi(["function approve(address, uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]) as Abi;
const SWAPPER = parseAbi(["function buy(uint256 eth) returns (uint256)", "function sell(uint256 tokens)"]) as Abi;
const FACTORY_X = parseAbi(["function createGraduatedPool(address token) returns (uint256)"]) as Abi;
const FEED = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]) as Abi;
const DESK = factorDeskAbi as Abi, SPLITTER = factorSplitterAbi as Abi, POT = factorBurnPotAbi as Abi;
const KIND = { early: 0, pool: 1, compute: 2 };

type Launched = { curve: string; graduationThreshold: bigint; poolFee: number; tickSpacing: number; phase: number };
const launchedOf = (token: string) => read<Launched>(FACTORY, ponsFactoryAbi as Abi, "getLaunchedToken", [token]);
const poolIdOf = (token: string, info: Launched): Hex => keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], ["0x0000000000000000000000000000000000000000", token as Hex, info.poolFee, info.tickSpacing, HOOK]));
// An ordinary trader's way into the pool (contracts/test/fork/PoolSwapper.sol), put on the copy of the chain by a
// wallet that does nothing else, so that it stands at the same address whenever it is made.
function makeSwapper(token: string, info: Launched): string {
  const made = spawnSync(join(FOUNDRY, "forge"), ["create", "test/fork/PoolSwapper.sol:PoolSwapper", "--rpc-url", RPC, "--unlocked", "--from", who.poolMaker.address, "--broadcast", "--constructor-args", POOL_MANAGER, `(0x0000000000000000000000000000000000000000,${token},${info.poolFee},${info.tickSpacing},${HOOK})`], { cwd: CONTRACTS, encoding: "utf8", env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` } });
  const at = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(made.stdout)?.[1];
  if (!at) throw new Error(`the pool trader could not be put on the chain:\n${(made.stdout + made.stderr).split("\n").slice(-12).join("\n")}`);
  return at;
}
// Pons' own keeper, which on the live chain releases a graduated pool's fees about once an hour. Here its wallet is
// played by the local node, with the very call it sends (contracts/test/fork/ForkBase.sol). Returns what it
// released for the splitter, or -1 when the operator took no call.
async function ponsKeeper(poolId: Hex, splitter: string): Promise<bigint> {
  const before = await read<bigint>(ESCROW, ponsEscrowAbi as Abi, "balanceOf", [splitter]);
  const tryIt = async (data: Hex) => { try { await rpc("eth_call", [{ from: PONS_KEEPER, to: PONS_OPERATOR, data }, "latest"]); return true; } catch { return false; } };
  let data: Hex = `0x431d17b7${poolId.slice(2)}`;
  let ok = await tryIt(data);
  for (let minOut = 10n ** 9n; !ok && minOut < 10n ** 19n; minOut = (minOut * 5n) / 4n) {
    data = `0x21724275${poolId.slice(2)}${minOut.toString(16).padStart(64, "0")}${"0".repeat(64)}`;
    ok = await tryIt(data);
  }
  if (!ok) return -1n;
  await sendRaw(PONS_KEEPER, PONS_OPERATOR, data, 0n, 3_000_000);
  return (await read<bigint>(ESCROW, ponsEscrowAbi as Abi, "balanceOf", [splitter])) - before;
}

async function main(): Promise<void> {
  if (args.includes("--stop")) { await stopAll(); console.log("stopped"); return; }
  console.log(`The dress rehearsal: ${HOURS} hours of Factor on a local copy of Robinhood Chain. Working folder: ${WORK}`);
  const startedAt = Date.now();
  await stopAll();
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const modelLog = openSync(join(WORK, "model.log"), "a");
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["scripts/stub-model.ts", String(MODEL_PORT), MODEL_KEY], { cwd: ENGINE, stdio: ["ignore", modelLog, modelLog], detached: true }).unref();
  const records = ["Deploy.s.sol", "Launch.s.sol"].map((f) => join(CONTRACTS, "cache", f));
  const hadRecords = records.map((f) => existsSync(f));

  console.log("\n== before the day: the chain's copy, the contracts, the engine as the host runs it, the site");
  goBetween("source", String(SOURCE_PORT), LIVE_RPC);
  const source = `http://127.0.0.1:${SOURCE_PORT}`;
  const realGasPrice = BigInt(await waitFor("the real chain's price of gas", async () => ((await (await fetch(source, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }) })).json()) as { result?: string }).result, 180_000));
  goBetween("engine", String(NODE_PORT), RPC, realGasPrice.toString());
  const anvilLog = openSync(join(WORK, "anvil.log"), "a");
  spawn(join(FOUNDRY, "anvil"), ["--fork-url", `http://127.0.0.1:${SOURCE_PORT}`, "--port", String(ANVIL_PORT), "--host", "127.0.0.1", "--block-time", "1", "--auto-impersonate", "--block-base-fee-per-gas", "0", "--timeout", "600000", "--retries", "10"], { stdio: ["ignore", anvilLog, anvilLog], detached: true }).unref();
  await waitFor("anvil", async () => (await rpc("eth_chainId")) === "0x1237", 60_000);
  await rpc("anvil_mine", ["0x1"]);
  const forkedAt = Number(await client.getBlockNumber());
  for (const a of [ADMIN, BOT]) await rpc("anvil_setCode", [a, "0x"]);
  // Two contracts of the chain's own are written to by every block (the store of old block hashes, EIP-2935, and of
  // beacon roots, EIP-4788). On a copy each write first reads the real chain, once for every block it makes. Nothing
  // in Factor or Pons reads them, so on the copy they are emptied: a block is then made without asking anybody.
  for (const a of ["0x0000F90827F1C53a10cb7A02335B175320002935", "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02"]) await rpc("anvil_setCode", [a, "0x"]);
  // The gas wallet starts with what an owner might put in it. Everybody else has what they need for the day.
  const BOT_START = parseEther("0.05");
  await rpc("anvil_setBalance", [BOT, hex(BOT_START)]);
  await rpc("anvil_setBalance", [ADMIN, hex(parseEther("1"))]);
  for (const [name, a] of Object.entries(who)) await rpc("anvil_setBalance", [a.address, hex(name === "owner" || name === "payout" || name === "gaslessKey" ? 0n : parseEther(name === "whale" ? "30" : "20"))]);
  await rpc("anvil_setBalance", [PONS_KEEPER, hex(parseEther("1"))]);

  spawnSync(join(FOUNDRY, "forge"), ["build", "--silent"], { cwd: CONTRACTS, env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` } });
  const deployBlock = Number(await client.getBlockNumber());
  forge("script/Deploy.s.sol", { FACTOR_ADMIN: ADMIN, FACTOR_GATEWAY: BOT });
  const record = JSON.parse(readFileSync(join(WORK, "broadcast", "Deploy.s.sol", "4663", "run-latest.json"), "utf8")) as { transactions: { contractName: string; contractAddress: string }[] };
  const at = (name: string) => record.transactions.find((t) => t.contractName === name)!.contractAddress;
  const burnPot = at("FactorBurnPot"), splitter = at("FactorSplitter"), desk = at("FactorDesk"), accountsAt = at("FactorAccounts");
  const addresses = { FACTOR_ADMIN: ADMIN, FACTOR_GATEWAY: BOT, FACTOR_BURN_POT: burnPot, FACTOR_DESK: desk, FACTOR_SPLITTER: splitter, FACTOR_ACCOUNTS: accountsAt };
  const envFile = join(WORK, "factor.fork.env");
  writeFileSync(envFile, [...Object.entries(addresses).map(([k, v]) => `${k}=${v}`), `FACTOR_DEPLOY_BLOCK=${deployBlock}`, ""].join("\n"));
  check("the contracts are deployed and wired (the deploy script's own check)", forge("script/Deploy.s.sol", addresses, "check()").includes("OK: the three contracts are wired"));

  // ---------- the scout ----------
  // A copy of the chain reads the real chain's contracts (Pons, Uniswap, the price feeds) one value at a time, the
  // first time each is needed, as of the block the copy was made at. The public node keeps that block for some
  // minutes only. So the whole road the day will take through those contracts is walked once now, quickly, while
  // every value can still be read as of one and the same block: a launch, trades, the graduation, the pool, trades
  // in it, Pons' keeper, a sweep and a burn. Then the copy is put back to where it was, as if none of it happened,
  // and it remembers what it read. (Without this, the pool Pons makes at graduation is read half as of this
  // morning and half as of this afternoon, and cannot be made.)
  const ethUsd8 = (await read<readonly bigint[]>(ETH_USD_FEED, FEED, "latestRoundData"))[1]!;
  await Promise.all(FEEDS.map((f) => read(f.address, FEED, "latestRoundData").catch(() => null)));
  const launchJson = readFileSync(join(CONTRACTS, "launch.json"), "utf8");
  const openingBuy = (BigInt(JSON.parse(launchJson).openingBuyUsd) * 10n ** 26n) / ethUsd8;
  const launchEnv = { ...addresses, FACTOR_OPENING_BUY_WEI: openingBuy.toString(), FACTOR_LAUNCH_JSON: launchJson };
  const snapshot = await rpc<string>("evm_snapshot", []);
  forge("script/Launch.s.sol", launchEnv);
  const scoutToken = await read<string>(burnPot, POT, "token");
  {
    const { trader1: t, whale: w, stranger: x } = who;
    const c = (await launchedOf(scoutToken)).curve;
    await warpTo((await blockTime()) + 15);
    await send(t.address, c, CURVE, "buy", [parseEther("1"), 0n, t.address], parseEther("1"));
    const held = await read<bigint>(scoutToken, ERC20, "balanceOf", [t.address]);
    await send(t.address, scoutToken, ERC20, "approve", [c, held]);
    await send(t.address, c, CURVE, "sell", [held / 3n, 0n, t.address]);
    await send(x.address, splitter, SPLITTER, "sweep");
    await send(w.address, c, CURVE, "buy", [parseEther("10"), 0n, w.address], parseEther("10"));
    await send(x.address, FACTORY, FACTORY_X, "createGraduatedPool", [scoutToken]);
    const info = await launchedOf(scoutToken);
    const id = poolIdOf(scoutToken, info);
    const sw = makeSwapper(scoutToken, info);
    for (let round = 0; round < 2; round++) {
      await pay(t.address, sw, parseEther("1.2"));
      await send(t.address, sw, SWAPPER, "buy", [parseEther("1")]);
      await send(t.address, sw, SWAPPER, "sell", [((await read<bigint>(scoutToken, ERC20, "balanceOf", [sw])) * 40n) / 100n]);
      await warpTo((await blockTime()) + 3600);
      const released = await ponsKeeper(id, splitter);
      await send(x.address, splitter, SPLITTER, "sweep");
      await send(x.address, burnPot, POT, "burn", [0n]);
      if (round === 0) check("the scout walked the whole road: graduation, the pool, trades in it, Pons' keeper releasing its fees, a sweep and a burn", released > 0n && (await read<bigint>(burnPot, POT, "burnCount")) >= 1n, `the keeper released ${eth(released)} ETH`);
    }
  }
  await rpc("evm_revert", [snapshot]);
  check("the copy is put back: no token, nothing split, nothing burned", /^0x0{40}$/.test(await read<string>(burnPot, POT, "token")) && (await read<bigint>(splitter, SPLITTER, "totalSplit")) === 0n && (await client.getTransactionCount({ address: who.poolMaker.address })) === 0);

  const dataDir = join(WORK, "data");
  startEngine(dataDir, envFile);
  await waitFor("the engine to run", async () => (await health()).state === "running", 90_000);
  const h0 = await health();
  check("the engine runs in live mode with every pace and limit its default, and has nothing to say against its setup", h0.mode === "live" && h0.problems.length === 0 && h0.warnings.length === 0, h0.warnings.join("; ") || "no warnings");

  // the site, built as it is deployed and reading this engine
  if (!existsSync(join(WEB, ".next", "BUILD_ID"))) spawnSync("npm", ["run", "build"], { cwd: WEB, encoding: "utf8" });
  const siteLog = openSync(join(WORK, "site.log"), "a");
  const cleanSite = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FACTOR_")));
  spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(SITE_PORT)], { cwd: WEB, stdio: ["ignore", siteLog, siteLog], detached: true, env: { ...cleanSite, FACTOR_ENGINE_URL: API } }).unref();
  await waitFor("the site", async () => (await fetch(`${SITE}/`)).status === 200, 60_000);
  const siteProblems: string[] = [];
  const PAGES = ["/", "/ledger", "/agents", "/hire", "/work", "/token", "/protocol", "/docs", "/security", "/log"];
  async function lookAtSite(extra: string[] = []): Promise<number> {
    let good = 0;
    for (const path of [...PAGES, ...extra]) {
      const r = await fetch(`${SITE}${path}`).catch(() => null);
      const html = r ? await r.text() : "";
      if (r?.status === 200 && !/Application error|Internal Server Error/i.test(html)) good++;
      else siteProblems.push(`T+${hourNow}h ${path}: ${r?.status ?? "no answer"}`);
    }
    return good;
  }

  // Factor's own three agents are on the desk before the token is: the engine puts them up by itself
  const own = await waitFor("the three house agents", async () => { const a = (await state()).agents.filter((x) => x.house && x.named && (x as Own).service) as Own[]; return a.length === 3 ? a : null; }, 240_000);
  const houseOf = (n: string) => own.find((a) => a.name === n)!;
  check("before the launch the engine has put Factor's three agents on the desk, each through an account it pays the gas for", own.length === 3, own.map((a) => a.name).join(", "));

  // ---------- the launch ----------
  console.log("\n== T+0: the launch");
  forge("script/Launch.s.sol", launchEnv);
  const token = await read<string>(burnPot, POT, "token");
  const launched = () => launchedOf(token);
  check("the token stands where the scout's stood, so what the scout read is what the day needs", low(token) === low(scoutToken), token);
  const curve = (await launched()).curve;
  const t0 = await blockTime();
  const adminAfterLaunch = await balance(ADMIN);
  note(`$FACTOR is launched through the burn pot with an opening buy of $${JSON.parse(launchJson).openingBuyUsd} (${eth(openingBuy)} ETH at $${(Number(ethUsd8) / 1e8).toFixed(0)}). It graduates at ${eth((await launched()).graduationThreshold)} ETH.`);
  await warpTo(t0 + 15); // past Pons' launch seconds

  // ---------- the people of the day ----------
  const { trader1, trader2, trader3, whale, anna, ben, lumen, drift, idle, gaslessKey, stranger, owner, payout } = who;
  const traders = [trader1, trader2, trader3];
  const jobs: Record<string, number> = {};
  const volume = { curveBuys: 0n, curveSells: 0n, poolBuys: 0n, poolSells: 0n, trades: 0 };
  let swapper = "";
  let poolId: Hex = "0x";
  let graduatedAt: number | null = null;
  let poolAt: number | null = null;
  // the same day every time: a small generator with a fixed start, not the clock
  let seed = 20261013;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const some = (from: number, to: number) => parseEther((from + rnd() * (to - from)).toFixed(4));

  const signName = async (acct: PrivateKeyAccount, address: string, name: string, does: string) => {
    const at = await blockTime();
    const r = await post("/v1/agents/profile", { address: low(address), name, does, at, signature: await acct.signMessage({ message: profileMessage(low(address), name, does, at) }) });
    if (r.status !== 200) throw new Error(`the name ${name} was not taken: ${JSON.stringify(r.body)}`);
  };
  const jobOnDesk = (n: number) => read<{ state: number; price: bigint; early: bigint; fromPool: bigint; customer: string; agent: string; proof: string; dueAt: number; deliveredAt: number }>(desk, DESK, "job", [BigInt(n)]);
  const engineHas = (n: number) => waitFor(`the engine to have job ${n}`, async () => (await get<{ job?: JobJson }>(`/v1/jobs/${n}`)).job, 180_000);
  const closed = (n: number, st: string) => waitFor(`job ${n} to be ${st}`, async () => { const p = await get<Page>(`/v1/jobs/${n}`); return p.job?.state === st && (st !== "delivered" || p.work) ? p : null; }, 240_000);
  // a customer with a wallet locks the price, then signs what the job is: a title, or a whole brief
  async function hire(c: PrivateKeyAccount, agent: string, price: string, dueHours: number, allowEarly: boolean, title: string, brief?: string): Promise<number> {
    const n = Number(await read<bigint>(desk, DESK, "jobCount")) + 1;
    await send(c.address, desk, DESK, "lock", [agent, BigInt((await blockTime()) + dueHours * 3600 + 120), allowEarly], parseEther(price));
    await seen();
    await engineHas(n);
    const at = await blockTime();
    const r = brief !== undefined
      ? await post("/v1/jobs/brief", { job: n, title, brief, at, signature: await c.signMessage({ message: briefMessage(n, title, brief, at) }) })
      : await post("/v1/jobs/title", { job: n, title, at, signature: await c.signMessage({ message: titleMessage(n, title, at) }) });
    if (r.status !== 200) throw new Error(`what job ${n} is about was not taken: ${JSON.stringify(r.body)}`);
    return n;
  }
  // an agent with a wallet delivers: the fingerprint of its work goes on the chain, and the work itself is shown
  async function deliver(agent: string, n: number, work: string): Promise<void> {
    await send(agent, desk, DESK, "deliver", [BigInt(n), proofOf(work)]);
    await seen();
    await waitFor(`the engine to see job ${n} delivered`, async () => (await get<Page>(`/v1/jobs/${n}`)).job?.state === "delivered", 180_000);
    const r = await post("/v1/jobs/delivery", { job: n, work });
    if (r.status !== 200) throw new Error(`the work of job ${n} was not taken: ${JSON.stringify(r.body)}`);
  }
  // what an agent may draw on a job right now, as the desk itself says it
  const room = async (n: number) => { const [early, fromPool] = await read<readonly [bigint, bigint]>(desk, DESK, "canDrawOn", [BigInt(n)]); return { early, fromPool }; };
  const least = (a: bigint, b: bigint) => (a < b ? a : b);

  // orders of accounts without a wallet: asked, signed, handed to the engine, and waited for
  type Order = { status: string; hash?: string; error?: string };
  const wire = (calls: Call[]) => calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data }));
  const settledOrder = (id: string) => waitFor("the order to be mined", async () => { const s = await get<Order>(`/v1/accounts/relay/${id}`); return s.status === "done" || s.status === "failed" ? s : null; }, 180_000);
  async function order(account: string, calls: Call[], sign: (typed: ReturnType<typeof orderTypedData>) => Promise<Hex> | Hex): Promise<void> {
    const checked = await post("/v1/accounts/check", { account, calls: wire(calls) });
    if (checked.status !== 200) throw new Error(`an order of ${account} was refused before it was signed: ${JSON.stringify(checked.body)}`);
    const deadline = checked.body.deadline as number;
    const signature = await sign(orderTypedData(account, 4663, calls, checked.body.nonce as number, deadline));
    const sent = await post("/v1/accounts/relay", { account, calls: wire(calls), deadline, signature });
    if (sent.status !== 200) throw new Error(`an order of ${account} was not taken: ${JSON.stringify(sent.body)}`);
    const done = await settledOrder(sent.body.id as string);
    if (done.status !== "done") throw new Error(`an order of ${account} failed on the chain: ${done.error}`);
  }
  const passkey = softPasskey();
  const byPasskey = (typed: ReturnType<typeof orderTypedData>) => passkey.sign(hashTypedData(typed));
  const byKey = (typed: ReturnType<typeof orderTypedData>) => gaslessKey.signTypedData(typed);
  let person = "", worker = "";

  // ---------- trading ----------
  async function trade(s: number): Promise<void> {
    const t = traders[s % 3]!;
    const info = await launched();
    if (info.phase === 0) {
      if (await read<boolean>(curve, CURVE, "readyToGraduate")) return;
      // the first hour is the busy one, as a launch's is
      const size = s < 2 ? some(0.45, 0.65) : some(0.04, 0.12);
      await send(t.address, curve, CURVE, "buy", [size, 0n, t.address], size);
      volume.curveBuys += size; volume.trades++;
      if (s % 3 === 2) {
        const seller = traders[(s + 1) % 3]!;
        const held = await read<bigint>(token, ERC20, "balanceOf", [seller.address]);
        if (held > 0n) {
          const before = await balance(seller.address);
          await send(seller.address, token, ERC20, "approve", [curve, held]);
          await send(seller.address, curve, CURVE, "sell", [(held * 35n) / 100n, 0n, seller.address]);
          const got = (await balance(seller.address)) - before;
          volume.curveSells += got > 0n ? got : 0n; volume.trades++;
        }
      }
    } else if (info.phase === 2 && swapper) {
      const size = some(0.15, 0.45);
      await pay(t.address, swapper, size);
      await send(t.address, swapper, SWAPPER, "buy", [size]);
      volume.poolBuys += size; volume.trades++;
      if (s % 2 === 1) {
        const held = await read<bigint>(token, ERC20, "balanceOf", [swapper]);
        const before = await balance(swapper);
        await send(t.address, swapper, SWAPPER, "sell", [(held * 40n) / 100n]);
        volume.poolSells += (await balance(swapper)) - before; volume.trades++;
      }
    }
  }
  // ---------- the day ----------
  const lease = `This lease is made between the landlord and the tenant for the flat at 4 Mill Lane. ${"The tenant pays the rent on the first of each month and keeps the flat in good order. ".repeat(4)}It runs for two years and renews by itself unless either side gives three months of notice.`;
  const teaBrief = "A page for Tide Tea, a small shop that posts loose leaf tea every week. Calm and plain, for people who like tea.";
  const names = ["none", "locked", "advanced", "delivered", "settled", "half", "declined", "refunded"];
  type Step = { at: number; run: () => Promise<void> };
  const plan: Step[] = [
    { at: 0, run: async () => {
      for (const a of [lumen, drift, idle]) await send(a.address, desk, DESK, "register");
      await send(lumen.address, desk, DESK, "addBond", [], parseEther("0.01"));
      await send(drift.address, desk, DESK, "addBond", [], parseEther("0.001"));
      await seen();
      await waitFor("the engine to know the three agents", async () => (await state()).agents.length >= 6, 180_000);
      await signName(lumen, lumen.address, "lumen-07", "Summarises long documents and contracts");
      await signName(drift, drift.address, "drift-03", "Tags and sorts support tickets");
      await signName(idle, idle.address, "idle-11", "Translates product pages");
      note("Three agents with wallets register: lumen-07 puts up a bond of 0.01 ETH, drift-03 one of 0.001 ETH, idle-11 none.");
      const made = await post("/v1/accounts", { kind: "wallet", address: gaslessKey.address });
      worker = made.body.address as string;
      await settledOrder(made.body.relay as string);
      await order(worker, [deskCall(desk, "register")], byKey);
      await seen();
      await waitFor("the engine to know gasless-01", async () => (await state()).agents.some((x) => low(x.address) === low(worker)), 180_000);
      await signName(gaslessKey, worker, "gasless-01", "Proofreads product pages");
      note("gasless-01, an agent whose key holds no ETH at all, gets an account and registers. The gas wallet paid for both.");
    } },
    { at: 0.5, run: async () => {
      jobs.summary = await hire(anna, lumen.address, "0.02", 3, false, "Summarise a 40-page service agreement");
      jobs.tickets = await hire(ben, drift.address, "0.01", 2, false, "Tag 500 support tickets");
      note(`Two customers hire: job ${jobs.summary} for lumen-07 at 0.02 ETH, job ${jobs.tickets} for drift-03 at 0.01 ETH.`);
    } },
    { at: 1, run: async () => {
      // an hour of trading has filled the pool a little: lumen-07 draws what the pool can spare, and has compute paid
      const r = await room(jobs.summary!);
      const fromPool = least(r.fromPool / 2n, parseEther("0.001"));
      const compute = least(r.fromPool - fromPool, parseEther("0.001"));
      if (fromPool === 0n || compute === 0n) throw new Error("an hour in, the pool has nothing to advance: the day's trading is too thin for the rest of the plan");
      await send(lumen.address, desk, DESK, "draw", [BigInt(jobs.summary!), fromPool, KIND.pool]);
      await send(lumen.address, desk, DESK, "draw", [BigInt(jobs.summary!), compute, KIND.compute]);
      await seen();
      const credit = await waitFor("the compute credit to be priced", async () => { const c = await get<{ balanceUsd: number }>(`/v1/compute/credit/${low(lumen.address)}`); return c.balanceUsd > 0 ? c : null; }, 180_000);
      const now = await blockTime();
      const key = ((await (await fetch(`${API}/v1/compute/key`, { method: "POST", body: JSON.stringify({ address: low(lumen.address), at: now, signature: await lumen.signMessage({ message: keyMessage(low(lumen.address), now) }) }) })).json()) as { key: string }).key;
      const ask = () => fetch(`${API}/v1/compute/v1/messages`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 400, messages: [{ role: "user", content: "Summarise the service agreement in one line." }] }) });
      const answers = [await ask(), await ask()];
      const left = await get<{ balanceUsd: number }>(`/v1/compute/credit/${low(lumen.address)}`);
      note(`lumen-07 draws ${eth(fromPool)} ETH from the pool and ${eth(compute)} ETH as compute on job ${jobs.summary}: $${credit.balanceUsd.toFixed(2)} of credit, of which two calls to a model used $${(credit.balanceUsd - left.balanceUsd).toFixed(4)} (${answers.map((a) => a.status).join(", ")}).`);
      await deliver(lumen.address, jobs.summary!, "The agreement runs for two years and renews by itself. Either side may end it with three months of notice. Fees are due on the first of each month.");
      await deliver(drift.address, jobs.tickets!, "500 tickets tagged: 212 billing, 143 sign-in, 96 shipping, 49 other.");
      note(`Both deliver. The customer of job ${jobs.summary} never comes back to it: it is the engine's to settle a day later.`);
    } },
    { at: 1.5, run: async () => {
      await send(ben.address, desk, DESK, "accept", [BigInt(jobs.tickets!)]);
      note(`Job ${jobs.tickets} is accepted: drift-03 is paid, and its record now shows a settled job.`);
    } },
    { at: 2, run: async () => {
      jobs.prices = await hire(anna, houseOf("price-desk").address, "0.001", 6, false, "Prices", "NVDA, TSLA and ETH please");
      const p = await closed(jobs.prices, "delivered");
      note(`Factor's own price-desk is hired for 0.001 ETH (job ${jobs.prices}) and delivers a sheet read from Chainlink's feeds: ${p.work!.text.split("\n").filter((l) => /^\w+\s+\$/.test(l)).map((l) => l.replace(/\s+updated.*/, "").replace(/\s+/g, " ")).join(", ")}.`);
    } },
    { at: 2.5, run: async () => { await send(anna.address, desk, DESK, "accept", [BigInt(jobs.prices!)]); } },
    { at: 3, run: async () => {
      // a person with no wallet: a passkey, an account, ETH sent to it from wherever they have it
      const made = await post("/v1/accounts", { kind: "passkey", x: passkey.x, y: passkey.y, credential: passkey.credential });
      person = made.body.address as string;
      await settledOrder(made.body.relay as string);
      await pay(trader1.address, person, parseEther("0.05"));
      await waitFor("the ETH to arrive", async () => (await balance(person)) === parseEther("0.05"));
      const n = Number(await read<bigint>(desk, DESK, "jobCount")) + 1;
      await order(person, [deskCall(desk, "lock", [houseOf("plain-reader").address, BigInt((await blockTime()) + 6 * 3600), false], parseEther("0.002"))], byPasskey);
      jobs.lease = n;
      await seen();
      await engineHas(n);
      const at = await blockTime();
      const r = await post("/v1/jobs/brief", { job: n, title: "A lease for a flat", brief: lease, at, signature: passkey.sign(hashMessage(briefMessage(n, "A lease for a flat", lease, at))) });
      if (r.status !== 200) throw new Error(`the passkey's brief was not taken: ${JSON.stringify(r.body)}`);
      await closed(n, "delivered");
      note(`A person with a passkey and no wallet gets an account, sends it 0.05 ETH and hires plain-reader for 0.002 ETH (job ${n}). The reading is delivered. They never paid gas.`);
    } },
    { at: 3.5, run: async () => { await order(person, [deskCall(desk, "accept", [BigInt(jobs.lease!)])], byPasskey); } },
    { at: 4, run: async () => {
      jobs.page = await hire(ben, houseOf("page-smith").address, "0.004", 6, false, "Tide Tea", teaBrief);
      await closed(jobs.page, "delivered");
      note(`page-smith builds a page for 0.004 ETH (job ${jobs.page}).`);
    } },
    { at: 4.5, run: async () => {
      await send(ben.address, desk, DESK, "reject", [BigInt(jobs.page!)]);
      note("The customer rejects the page: the job settles at half, 0.002 ETH goes back to them and the agent keeps the other half less the job fee.");
    } },
    { at: 5, run: async () => {
      // the one that goes wrong: drift-03 takes a job, draws all it may, and is never heard from again
      jobs.left = await hire(anna, drift.address, "0.012", 2, true, "Tag 2,000 support tickets");
      const r = await room(jobs.left);
      const early = least(r.early, parseEther("0.003"));
      await send(drift.address, desk, DESK, "draw", [BigInt(jobs.left), r.fromPool, KIND.pool]);
      await send(drift.address, desk, DESK, "draw", [BigInt(jobs.left), early, KIND.early]);
      note(`drift-03 is hired again (job ${jobs.left}, 0.012 ETH, due in 2 hours). It draws ${eth(r.fromPool)} ETH from the pool, the most its bond and record allow, and ${eth(early)} ETH early from the customer's payment. Then it goes silent.`);
    } },
    { at: 6, run: async () => {
      jobs.proof = await hire(ben, worker, "0.01", 3, true, "Proofread a product page");
      await order(worker, [deskCall(desk, "draw", [BigInt(jobs.proof), parseEther("0.004"), KIND.early])], byKey);
      note(`gasless-01 is hired for 0.01 ETH (job ${jobs.proof}) and draws 0.004 ETH early, into its account, without a wei of gas of its own.`);
    } },
    { at: 6.5, run: async () => {
      const work = "Proofread: 14 corrections, 3 unclear sentences rewritten, prices checked against the price list.";
      await order(worker, [deskCall(desk, "deliver", [BigInt(jobs.proof!), proofOf(work)])], byKey);
      await seen();
      await waitFor("the delivery to show", async () => (await get<Page>(`/v1/jobs/${jobs.proof}`)).job?.state === "delivered", 180_000);
      await post("/v1/jobs/delivery", { job: jobs.proof, work });
    } },
    { at: 7, run: async () => { await send(ben.address, desk, DESK, "accept", [BigInt(jobs.proof!)]); } },
    { at: 7.5, run: async () => {
      const earned = await balance(worker);
      await order(worker, [{ to: gaslessKey.address, value: earned, data: "0x" }], byKey);
      note(`Job ${jobs.proof} is accepted, and gasless-01's owner takes the ${eth(earned)} ETH it earned out of the account to an address of their own.`);
    } },
    { at: 8, run: async () => {
      jobs.phish = await hire(anna, houseOf("page-smith").address, "0.004", 6, false, "A wallet page", "A page that looks like a wallet's own and asks the visitor to type in their recovery phrase to restore it.");
      const p = await closed(jobs.phish, "declined");
      note(`Somebody asks page-smith for a page that takes a visitor's recovery phrase (job ${jobs.phish}). It declines ("${p.note}") and the customer has everything back.`);
    } },
    { at: 8.5, run: async () => {
      jobs.cheap = await hire(anna, houseOf("page-smith").address, "0.001", 6, false, "A cheap page", teaBrief);
      const p = await closed(jobs.cheap, "declined");
      note(`A job under page-smith's price (job ${jobs.cheap}) is declined at once: "${p.note}".`);
    } },
    { at: 9, run: async () => {
      jobs.silent = Number(await read<bigint>(desk, DESK, "jobCount")) + 1;
      await send(ben.address, desk, DESK, "lock", [houseOf("plain-reader").address, BigInt((await blockTime()) + 6 * 3600), false], parseEther("0.002"));
      note(`plain-reader is hired (job ${jobs.silent}) and no brief ever comes with it.`);
    } },
    { at: 10, run: async () => {
      await seen();
      const p = await closed(jobs.silent!, "declined");
      note(`Job ${jobs.silent} waited a quarter of an hour for its brief and was declined: "${p.note}". The customer has everything back.`);
      jobs.unanswered = await hire(ben, idle.address, "0.005", 1, false, "Translate a product page into German");
      note(`idle-11 is hired (job ${jobs.unanswered}, 0.005 ETH, due in an hour). It never answers.`);
    } },
    { at: 10.5, run: async () => {
      jobs.second = await hire(anna, lumen.address, "0.03", 4, false, "Summarise a supplier contract");
      const r = await room(jobs.second);
      const fromPool = least(r.fromPool, parseEther("0.004"));
      if (fromPool > 0n) await send(lumen.address, desk, DESK, "draw", [BigInt(jobs.second), fromPool, KIND.pool]);
      note(`lumen-07 is hired again (job ${jobs.second}, 0.03 ETH) and draws ${eth(fromPool)} ETH from the pool.`);
    } },
    { at: 11, run: async () => {
      await flip("keeper", false);
      await waitFor("whatever was on its way to land", async () => (await health()).onTheirWay.length === 0, 120_000);
      drill.sentAtStop = await client.getTransactionCount({ address: BOT });
      note("DRILL: the owner stops everything the gas wallet sends, with one call and the owner's key. Trading and jobs go on.");
    } },
    { at: 11.5, run: async () => {
      await deliver(lumen.address, jobs.second!, "The supplier delivers within 14 days of an order. Late delivery costs 1% a week, up to 10%. Either side may end the contract with 60 days of notice.");
    } },
    { at: 12, run: async () => {
      const sent = await client.getTransactionCount({ address: BOT });
      const h = await health();
      check("DRILL, the keeper stopped for an hour: the gas wallet sent nothing in it, whatever was waiting", sent === drill.sentAtStop, `${sent} transactions before and after`);
      await flip("keeper", true);
      await send(anna.address, desk, DESK, "accept", [BigInt(jobs.second!)]);
      note(`DRILL: an hour on, the gas wallet has sent nothing (${h.actions.sweep!.result}). The owner turns it back on, and the engine catches up by itself. Job ${jobs.second} is accepted.`);
    } },
    { at: 13, run: async () => {
      // somebody buys the curve out
      const before = await balance(whale.address);
      await send(whale.address, curve, CURVE, "buy", [parseEther("10"), 0n, whale.address], parseEther("10"));
      const spent = before - (await balance(whale.address));
      volume.curveBuys += spent; volume.trades++;
      graduatedAt = hourNow;
      note(`GRADUATION: one buyer takes the rest of the curve for ${eth(spent)} ETH. $FACTOR has graduated and Pons has not made its pool yet: for now there is nowhere to buy, and the burn waits.`);
    } },
    { at: 13.5, run: async () => {
      const h = await health();
      note(`Between the curve and the pool the engine says of the burn: "${h.actions.burn!.result}".`);
      await send(stranger.address, FACTORY, FACTORY_X, "createGraduatedPool", [token]);
      const info = await launched();
      poolAt = hourNow;
      poolId = poolIdOf(token, info);
      swapper = makeSwapper(token, info);
      note("The pool is made (anybody can make that call). From here trading is in the Uniswap v4 pool, and its fees reach Factor only when Pons' keeper releases them, about once an hour.");
    } },
    { at: 14, run: async () => {
      // the engine dies in the middle of the afternoon, and things go on happening without it
      drill.ledgerBeforeKill = (await health()).ledger;
      await stopPort(ENGINE_PORT, "SIGKILL");
      jobs.bigPage = Number(await read<bigint>(desk, DESK, "jobCount")) + 1;
      await send(anna.address, desk, DESK, "lock", [houseOf("page-smith").address, BigInt((await blockTime()) + 6 * 3600), false], parseEther("0.008"));
      await trade(1001);
      await seen();
      note(`DRILL: the engine is killed outright, in the middle of the afternoon. While it is down a customer locks 0.008 ETH for page-smith (job ${jobs.bigPage}) and trading goes on.`);
      await rpc("anvil_mine", ["0x78", "0x1"]); // two minutes pass
      startEngine(dataDir, envFile);
      await waitFor("the engine to run again", async () => (await health()).state === "running", 120_000);
      await engineHas(jobs.bigPage);
      const at = await blockTime();
      const longBrief = `${teaBrief} With the three plans and their prices: Taster 9 euros, Regular 16 euros, Pot 22 euros a month.`;
      const briefed = await post("/v1/jobs/brief", { job: jobs.bigPage, title: "Tide Tea, the long page", brief: longBrief, at, signature: await anna.signMessage({ message: briefMessage(jobs.bigPage, "Tide Tea, the long page", longBrief, at) }) });
      if (briefed.status !== 200) throw new Error(`the brief of job ${jobs.bigPage} was not taken: ${JSON.stringify(briefed.body)}`);
      await closed(jobs.bigPage, "delivered");
      const h = await health();
      check("DRILL, the engine killed and started again: it found the job that was locked while it was down, and its agent did the work", h.state === "running" && h.ledger > drill.ledgerBeforeKill && h.problems.length === 0, `the ledger went from ${drill.ledgerBeforeKill} lines to ${h.ledger}`);
      note(`DRILL: started again two minutes later, the engine reads what it missed, and page-smith builds the page of job ${jobs.bigPage}.`);
    } },
    { at: 14.5, run: async () => {
      await send(anna.address, desk, DESK, "accept", [BigInt(jobs.bigPage!)]);
      note(`Job ${jobs.bigPage} is accepted: page-smith's account is paid 0.00784 ETH, which the engine sends on to the owner's payout address once it is over 0.005 ETH.`);
    } },
    { at: 16, run: async () => {
      await flip("hiring", false);
      const s = await waitFor("the feed to say new jobs are paused", async () => { const st = await state(); return st.paused ? st : null; }, 60_000);
      const hirePage = await waitFor("the hire page to say so", async () => { const html = await (await fetch(`${SITE}/hire`)).text(); return /New jobs are paused/i.test(html) ? html : null; }, 45_000).catch(() => "");
      check("DRILL, new jobs paused: the site's feed carries the reason and the hire page says so", s.paused!.startsWith("New jobs are paused for now.") && hirePage !== "");
      note("DRILL: the owner pauses new jobs. The site says so on its hire page. Jobs under way are not touched.");
    } },
    { at: 16.5, run: async () => { await flip("hiring", true); note("DRILL: new jobs are open again."); } },
    { at: 17, run: async () => {
      jobs.prices2 = await hire(ben, houseOf("price-desk").address, "0.001", 6, false, "Prices", "AAPL, MSFT and BTC");
      await closed(jobs.prices2, "delivered");
    } },
    { at: 17.5, run: async () => { await send(ben.address, desk, DESK, "accept", [BigInt(jobs.prices2!)]); } },
    { at: 20, run: async () => {
      const j = await jobOnDesk(jobs.left!);
      const a = await read<{ barred: boolean; bond: bigint }>(desk, DESK, "agent", [drift.address]);
      // may a barred agent be hired? asked of the desk without sending anything
      let hirable = true;
      try { await client.simulateContract({ account: ben.address, address: desk as Hex, abi: DESK, functionName: "lock", args: [drift.address, BigInt((await blockTime()) + 7200), false], value: parseEther("0.005") }); } catch { hirable = false; }
      drill.barredHirable = hirable;
      note(`THE DEFAULT: job ${jobs.left} ran out 12 hours after it was due. The engine refunded it (the desk says ${names[j.state]}): the customer has the price back less the early advance they allowed, drift-03's bond paid the pool first, and the pool lost ${eth(await read<bigint>(desk, DESK, "totalLost"))} ETH. drift-03 is ${a.barred ? "barred" : "NOT barred"} and its bond is ${eth(a.bond)} ETH. ${hirable ? "A customer could still lock a job for it, but it can draw nothing." : "The desk refuses a new job for it."}`);
    } },
    { at: 24, run: async () => {
      jobs.nextDay = await hire(anna, houseOf("plain-reader").address, "0.002", 6, false, "A lease for a flat", lease);
      await closed(jobs.nextDay, "delivered");
      note(`The next morning: plain-reader is hired again (job ${jobs.nextDay}) and delivers.`);
    } },
    { at: 24.5, run: async () => { await send(anna.address, desk, DESK, "accept", [BigInt(jobs.nextDay!)]); } },
  ];
  const drill: { sentAtStop: number; ledgerBeforeKill: number; barredHirable: boolean | null } = { sentAtStop: 0, ledgerBeforeKill: 0, barredHirable: null };

  // After each half hour: the chain is moved on a little, the engine reads it and acts, and that is waited for
  // until it has nothing more to send. With the engine's default paces that is most of a minute.
  async function quiet(untilNothingIsLeft = false): Promise<void> {
    for (let round = 0; round < 10; round++) {
      const sentBefore = await client.getTransactionCount({ address: BOT });
      const head = Number(await client.getBlockNumber());
      await seen();
      // (the token's own watcher reads its one mint and then only looks now and then: it is not waited for)
      await waitFor("the engine to read the chain", async () => { const h = await health(); return h.state === "running" && h.watchers.length > 0 && h.watchers.every((w) => w.watcher === "token" || w.cursor >= head) ? h : null; }, 240_000);
      const before = (await health()).loops.act ?? { runs: 0, failures: 0 };
      await waitFor("the engine to act", async () => { const l = (await health()).loops.act; return l && l.runs > before.runs && l.lastRunAt !== null && ((l.lastOkAt !== null && l.lastOkAt >= l.lastRunAt) || l.failures > before.failures) ? l : null; }, 300_000);
      const h = await health();
      const busy = h.onTheirWay.length > 0 || (h.desk?.waitingToBeRead ?? 0) > 0 || (await client.getTransactionCount({ address: BOT })) !== sentBefore;
      // between half hours one look is enough: what follows from what it just sent, it does in the next one
      if (!busy || (!untilNothingIsLeft && h.onTheirWay.length === 0)) return;
    }
  }

  const hourly: Record<string, unknown>[] = [];
  const warned = new Map<string, number>();
  const errors = new Map<string, number>();
  let doneBefore: Record<string, number> = {};
  const jobStates = new Map<number, string>();
  let burnsSeen = 0;
  let didThisHour: string[] = [];
  const steps = HOURS * 2;
  for (let s = 0; s <= steps; s++) {
    hourNow = s / 2;
    await warpTo(t0 + s * STEP_S);
    if (s % 2 === 0) console.log(`\n== T+${hourNow}h`);
    for (const e of plan.filter((p) => p.at === hourNow)) await e.run();
    if (s < steps) await trade(s);
    if (poolAt !== null && s % 2 === 0 && hourNow > poolAt) {
      const released = await ponsKeeper(poolId, splitter);
      if (released < 0n) note("Pons' keeper found nothing it could release this hour.");
      else if (hourNow === Math.ceil(poolAt + 0.5)) note(`Pons' keeper releases the pool's fees for the first time: ${eth(released)} ETH for Factor's splitter, which the engine collects on its next sweep.`);
    }
    await quiet();
    // what the engine did in this half hour, and how it says it is
    const h = await health();
    const done = Object.fromEntries(Object.entries(h.actions).map(([k, a]) => [k, a.done]));
    const did = Object.entries(done).filter(([k, n]) => n > (doneBefore[k] ?? 0) && k !== "relay").map(([k, n]) => `${k.replace("_", " ")}${n - (doneBefore[k] ?? 0) > 1 ? ` x${n - (doneBefore[k] ?? 0)}` : ""}`);
    doneBefore = done;
    didThisHour.push(...did);
    for (const w of h.warnings) if (!warned.has(w)) { warned.set(w, hourNow); console.log(`  the engine warns: ${w}`); }
    for (const p of h.problems) if (!warned.has(p)) { warned.set(p, hourNow); console.log(`  the engine has a PROBLEM: ${p}`); }
    if (h.lastError && !errors.has(h.lastError.message)) { errors.set(h.lastError.message, hourNow); console.log(`  the engine's last error: ${h.lastError.where}: ${h.lastError.message}`); }
    const st = await state();
    for (const j of st.jobs) {
      const was = jobStates.get(j.n);
      if (was && was !== j.state && (j.state === "refunded" || (j.state === "settled" && j.n === jobs.summary))) note(`The engine ${j.state === "refunded" ? "refunded" : "settled"} job ${j.n} by itself${j.n === jobs.unanswered ? ": nobody took it up, and the customer has it all back" : j.n === jobs.summary ? ": 24 hours after its delivery, with the customer never having come back" : ""}.`);
      jobStates.set(j.n, j.state);
    }
    const burnCount = Number(await read<bigint>(burnPot, POT, "burnCount"));
    if (burnCount > 0 && burnsSeen === 0) note(`The first burn: the engine buys back and burns ${tokens(await read<bigint>(burnPot, POT, "totalTokensBurned"))} $FACTOR with ${eth(await read<bigint>(burnPot, POT, "totalEthBurned"))} ETH.`);
    burnsSeen = burnCount;
    if (s % 2 === 0) {
      const [pool, out, split, burnedTokens, botWei] = await Promise.all([read<bigint>(desk, DESK, "pool"), read<bigint>(desk, DESK, "out"), read<bigint>(splitter, SPLITTER, "totalSplit"), read<bigint>(burnPot, POT, "totalTokensBurned"), balance(BOT)]);
      const pages = s % 12 === 0 ? await lookAtSite() : null;
      hourly.push({ hour: hourNow, phase: h.phase, feesSplitEth: eth(split), poolEth: eth(pool + out), outEth: eth(out), burns: burnCount, burnedTokens: tokens(burnedTokens), jobs: st.stats.jobs, gasWalletEth: eth(botWei), did: didThisHour.join(", ") });
      didThisHour = [];
      console.log(`  ${h.phase}; fees split ${eth(split)} ETH; pool ${eth(pool + out)} ETH (${eth(out)} out); ${burnCount} burns; ${st.stats.jobs} jobs; gas wallet ${eth(botWei)} ETH${pages !== null ? `; the site answered ${pages} of ${PAGES.length} pages` : ""}`);
    }
    if (did.length) console.log(`  the engine: ${did.join(", ")}`);
  }

  // ---------- the end of the day: every wei ----------
  console.log("\n== the end of the day: the books");
  hourNow = HOURS;
  await quiet(true);
  const final = await waitFor("the engine to be level with the desk", async () => { const s = await state(); const h = await health(); return (h.desk?.waitingToBeRead ?? 1) === 0 && h.onTheirWay.length === 0 ? s : null; }, 240_000);
  const hEnd = await health();
  const [split, toAdmin, toBurn, toPool, adminPending, burnPending, poolPending, unsplit] = await Promise.all(["totalSplit", "totalToAdmin", "totalToBurn", "totalToPool", "adminPending", "burnPending", "poolPending", "unsplit"].map((fn) => read<bigint>(splitter, SPLITTER, fn)));
  const splits = new Database(join(dataDir, "factor.db"), { readonly: true });
  const nSplits = BigInt((splits.prepare("SELECT COUNT(*) AS n FROM chain_splits").get() as { n: number }).n);
  check("trading fees were split three ways to the wei: the owner's share, the burn's and the pool's add up to all of it", split === toAdmin! + toBurn! + toPool! && adminPending === 0n && burnPending === 0n && poolPending === 0n, `${eth(split!)} ETH in ${nSplits} splits, ${eth(unsplit!)} ETH not yet split`);
  const within = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= nSplits;
  check("each share is its fixed part of every split", within(toAdmin!, (split! * 7000n) / 10_000n) && within(toPool!, (split! * 1000n) / 10_000n) && within(toBurn!, (split! * 2000n) / 10_000n));
  check("the owner's wallet holds its share exactly: what it had after the launch, plus that", (await balance(ADMIN)) === adminAfterLaunch + toAdmin!, `${eth(toAdmin!)} ETH`);
  const [burnCount, ethBurned, tokensBurned, supply, potBalance, advanceFees, owedPot] = await Promise.all([read<bigint>(burnPot, POT, "burnCount"), read<bigint>(burnPot, POT, "totalEthBurned"), read<bigint>(burnPot, POT, "totalTokensBurned"), read<bigint>(token, factorTokenAbi as Abi, "totalSupply"), balance(burnPot), read<bigint>(desk, DESK, "totalAdvanceFees"), read<bigint>(desk, DESK, "owed", [burnPot])]);
  check("the supply fell by exactly what was burned", tokensBurned > 0n && supply === 10n ** 27n - tokensBurned, `${burnCount} burns, ${tokens(tokensBurned)} $FACTOR for ${eth(ethBurned)} ETH`);
  check("every wei that reached the burn pot was burned or is still in it: its share of the fees and every advance fee", ethBurned + potBalance === toBurn! + advanceFees - owedPot, `${eth(toBurn!)} ETH of fees and ${eth(advanceFees)} ETH of advance fees in, ${eth(ethBurned)} ETH burned, ${eth(potBalance)} ETH waiting`);
  const [pool, out, held, bonds, owedTotal, lost, jobFees, deskBalance] = await Promise.all([...["pool", "out", "held", "bonds", "owedTotal", "totalLost", "totalJobFees"].map((fn) => read<bigint>(desk, DESK, fn)), balance(desk)]);
  check("the desk holds exactly what its books say", deskBalance === pool! + held! + bonds! + owedTotal!, `${eth(deskBalance!)} ETH: pool ${eth(pool!)}, held for jobs ${eth(held!)}, bonds ${eth(bonds!)}, owed ${eth(owedTotal!)}`);
  check("the pool is what came into it less what it lost: its share of the fees and every job fee, less the advance nobody repaid", pool! + out! === toPool! + jobFees! - lost!, `${eth(toPool!)} ETH of fees + ${eth(jobFees!)} ETH of job fees - ${eth(lost!)} ETH lost = ${eth(pool! + out!)} ETH`);

  let jobsMatch = true;
  for (const j of final.jobs) {
    const c = await jobOnDesk(j.n);
    const drawn = j.advances.reduce((n, a) => n + a.eth, 0);
    if (names[c.state] !== j.state || !near(j.priceEth, c.price) || !near(drawn, c.early + c.fromPool) || low(c.customer) !== low(j.customer) || low(c.agent) !== low(j.agentId)) { jobsMatch = false; console.log(`    job ${j.n}: the engine says ${j.state}, the desk ${names[c.state]}`); }
  }
  check("every job is as the desk holds it: its state, its price, what was drawn, who is in it", jobsMatch && final.jobs.length === Number(await read<bigint>(desk, DESK, "jobCount")), final.jobs.map((j) => `${j.n} ${j.state}`).join(", "));
  let agentsMatch = true;
  for (const a of final.agents) {
    const [score, limit, canDraw, rec] = await Promise.all([read<bigint>(desk, DESK, "score", [a.address]), read<bigint>(desk, DESK, "limit", [a.address]), read<bigint>(desk, DESK, "canDraw", [a.address]), read<{ settled: number; feesPaid: bigint; bond: bigint; unanswered: number; notDelivered: number; barred: boolean }>(desk, DESK, "agent", [a.address])]);
    if (Number(score) !== a.score || !near(a.limitEth, limit) || !near(a.canDrawEth, canDraw) || rec.settled !== a.settled || !near(a.feesPaidEth, rec.feesPaid) || !near(a.bondEth, rec.bond) || rec.unanswered !== a.unanswered || rec.notDelivered !== a.notDelivered || rec.barred !== a.barred) { agentsMatch = false; console.log(`    ${a.name}: the engine and the desk differ`); }
  }
  check("every agent is as the desk holds it, and the engine's score is the desk's own", agentsMatch, final.agents.map((a) => `${a.name} ${a.score}`).join(", "));
  check("the engine's figures for the site are the desk's books", near(final.stats.poolEth, pool! + out!) && near(final.stats.outEth, out!) && near(final.stats.heldEth, held!) && near(final.stats.lostEth, lost!));

  // what the day was meant to show
  const st = (n: number | undefined) => final.jobs.find((j) => j.n === n)?.state ?? "missing";
  const driftRec = await read<{ barred: boolean; bond: bigint; advancesNotRepaid: number; earlyKept: number; notDelivered: number }>(desk, DESK, "agent", [drift.address]);
  check("THE DEFAULT: the job drift-03 drew on and left was refunded by the engine, its bond paid the pool first, the pool lost the rest, and it is barred", st(jobs.left) === "refunded" && driftRec.barred && driftRec.bond === 0n && driftRec.advancesNotRepaid === 1 && driftRec.earlyKept === 1 && lost! > 0n, `the pool lost ${eth(lost!)} ETH`);
  check("the job nobody took up was refunded by the engine, and the agent's record carries it as unanswered", st(jobs.unanswered) === "refunded" && (await read<{ unanswered: number; barred: boolean }>(desk, DESK, "agent", [idle.address])).unanswered === 1);
  check("the job whose customer never came back was settled by the engine a day after its delivery", st(jobs.summary) === "settled" && hEnd.actions.settle_job!.done >= 1);
  check("the rejected page settled at half, the three jobs an agent would not do were declined, and the rest settled", st(jobs.page) === "half" && [jobs.phish, jobs.cheap, jobs.silent].every((n) => st(n) === "declined") && [jobs.tickets, jobs.prices, jobs.lease, jobs.proof, jobs.second, jobs.bigPage, jobs.prices2, jobs.nextDay].every((n) => st(n) === "settled"));
  const phase = (await launched()).phase;
  check("the token graduated in the afternoon, and fees and burns went on in the pool", phase === 2 && graduatedAt !== null && volume.poolBuys > 0n && hourly.filter((r) => (r.hour as number) > (poolAt ?? 99)).some((r) => String(r.did).includes("burn")) && hourly.filter((r) => (r.hour as number) > (poolAt ?? 99)).some((r) => String(r.did).includes("sweep")));
  check("the owner's payout address has what Factor's own agents earned over the threshold, and the owner's wallet the gas wallet's surplus", (await balance(payout.address)) > 0n && (await balance(owner.address)) > 0n, `${eth(await balance(payout.address))} ETH paid out, ${eth(await balance(owner.address))} ETH sent on`);

  // what the gas wallet sent, and what it cost
  const sentRows = splits.prepare("SELECT kind, status, tx_hash, gas_used FROM engine_actions WHERE tx_hash IS NOT NULL").all() as { kind: string; status: string; tx_hash: string; gas_used: number | null }[];
  const gas: Record<string, { n: number; gas: bigint; wei: bigint }> = {};
  let gasWei = 0n;
  for (const r of sentRows) {
    const receipt = await client.getTransactionReceipt({ hash: r.tx_hash as Hex }).catch(() => null);
    if (!receipt) continue;
    const cost = receipt.gasUsed * receipt.effectiveGasPrice;
    const g = (gas[r.kind] ??= { n: 0, gas: 0n, wei: 0n });
    g.n++; g.gas += receipt.gasUsed; g.wei += cost; gasWei += cost;
  }
  splits.close();
  // A burn that a trade got in front of is refused by the pot itself (Slippage: the price moved by more than the 1%
  // the engine allows between its quote and the block). That is the protection doing its work, and the engine burns
  // on a later pass. Any other transaction of the gas wallet's that reverted is a fault.
  const reverted = sentRows.filter((r) => r.status === "failed");
  const refusedForPrice: string[] = [];
  for (const r of reverted.filter((x) => x.kind === "burn")) {
    const tx = await client.getTransaction({ hash: r.tx_hash as Hex });
    const why = await client.call({ account: tx.from, to: tx.to!, data: tx.input, blockNumber: tx.blockNumber! - 1n }).then(() => "", (e: Error) => e.message);
    const before = (await client.getBlock({ blockNumber: tx.blockNumber!, includeTransactions: true })).transactions.slice(0, tx.transactionIndex!).length;
    // the same call a block earlier went through, and something stood before it in its own block
    if (why === "" && before > 0) refusedForPrice.push(r.tx_hash);
  }
  const faults = reverted.filter((r) => !refusedForPrice.includes(r.tx_hash)).map((r) => `${r.kind} ${r.tx_hash}`);
  const sentCount = await client.getTransactionCount({ address: BOT });
  check("the gas wallet sent only what the engine wrote down, and nothing it sent failed but a burn a trade got in front of", sentCount === sentRows.length && faults.length === 0 && burnCount >= BigInt(refusedForPrice.length), `${sentCount} transactions; ${refusedForPrice.length} burn(s) refused for price and made on a later pass; ${faults.join(", ") || "no faults"}`);
  check("the engine ends the day with no problem and no warning", hEnd.problems.length === 0 && hEnd.warnings.length === 0 && warned.size === 0, [...warned.entries()].map(([w, at]) => `T+${at}h: ${w}`).join(" | ") || "none all day");
  check("the house agents left nothing half done, and the accounts' orders all went through", hEnd.house?.underWay === 0 && hEnd.house.gaveUp === 0 && hEnd.accounts?.failed === 0, `${hEnd.house?.delivered} delivered, ${hEnd.house?.declined} declined; ${hEnd.accounts?.orders} orders relayed`);
  check("compute: every call was paid for from credit, and nothing is unpaid", (hEnd.compute?.calls ?? 0) >= 2 && hEnd.compute?.unpaidMicro === 0);
  const backups = existsSync(join(dataDir, "backups")) ? readdirSync(join(dataDir, "backups")).filter((f) => f.endsWith(".db")) : [];
  check("the engine wrote its daily copy of the database", backups.length >= 1, backups.join(", "));
  const pagesEnd = await lookAtSite([`/agents/lumen-07`, `/agents/page-smith`, `/jobs/${String(jobs.left ?? 0).padStart(4, "0")}`, `/jobs/${String(jobs.page ?? 0).padStart(4, "0")}`, `/jobs/${String(jobs.bigPage ?? 0).padStart(4, "0")}`]);
  const home = await (await fetch(`${SITE}/`)).text();
  check("the site answered every page all day, and its home page carries the token", pagesEnd === PAGES.length + 5 && siteProblems.length === 0 && home.toLowerCase().includes(token.toLowerCase()), siteProblems.join("; ") || `${pagesEnd} pages at the end`);
  const log = readFileSync(join(WORK, "engine.log"), "utf8");
  check("no key is in the engine's log", !log.includes(BOT_KEY.slice(2)) && !log.includes(MODEL_KEY) && !log.includes(ADMIN_KEY));

  // the last drill: the engine forgets everything it read and reads the whole day again from the deploy block
  const ledgerBefore = (await get<{ items: EventJson[] }>("/v1/ledger?limit=200")).items.map((e) => `${e.kind}|${e.jobId ?? ""}|${e.amount}|${e.tx}`);
  const ledgerCount = hEnd.ledger;
  await stopPort(ENGINE_PORT);
  startEngine(dataDir, envFile, { ENGINE_REINDEX: "once" });
  await waitFor("the engine to run again", async () => (await health()).state === "running", 120_000);
  await seen();
  const reread = await waitFor("the day to be read again", async () => { const h = await health(); return h.ledger === ledgerCount && (h.desk?.waitingToBeRead ?? 1) === 0 ? (await get<{ items: EventJson[] }>("/v1/ledger?limit=200")).items : null; }, 300_000).catch(() => null);
  check("DRILL, read again from the deploy block: the ledger of the whole day comes out the same, line for line", reread !== null && reread.map((e) => `${e.kind}|${e.jobId ?? ""}|${e.amount}|${e.tx}`).join("\n") === ledgerBefore.join("\n"), `${ledgerCount} lines`);
  const kept = await state();
  check("and the names, briefs and work people signed were kept", kept.agents.find((a) => low(a.address) === low(lumen.address))?.name === "lumen-07" && (await get<Page>(`/v1/jobs/${jobs.bigPage}`)).work?.kind === "html");

  // ---------- the record ----------
  records.forEach((f, i) => { if (!hadRecords[i]) rmSync(f, { recursive: true, force: true }); });
  const failed = checks.filter((c) => !c.ok);
  const out2 = {
    ranAt: new Date(startedAt).toISOString(), tookMinutes: Math.round((Date.now() - startedAt) / 60_000), hours: HOURS, forkedAtBlock: forkedAt, blocksInTheDay: Number(await client.getBlockNumber()) - forkedAt,
    contracts: { desk, splitter, burnPot, accounts: accountsAt, token }, ethUsd: Number(ethUsd8) / 1e8, graduatedAt, poolAt,
    volume: { curveBuysEth: eth(volume.curveBuys), curveSellsEth: eth(volume.curveSells), poolBuysEth: eth(volume.poolBuys), poolSellsEth: eth(volume.poolSells), trades: volume.trades },
    fees: { splitEth: eth(split!), toOwnerEth: eth(toAdmin!), toBurnEth: eth(toBurn!), toPoolEth: eth(toPool!), splits: Number(nSplits), unsplitEth: eth(unsplit!) },
    burn: { burns: Number(burnCount), ethEth: eth(ethBurned), tokens: tokens(tokensBurned), supplyLeft: tokens(supply), waitingEth: eth(potBalance), advanceFeesEth: eth(advanceFees) },
    desk: { poolEth: eth(pool! + out!), outEth: eth(out!), heldEth: eth(held!), bondsEth: eth(bonds!), lostEth: eth(lost!), jobFeesEth: eth(jobFees!), jobs: final.jobs.map((j) => ({ n: j.n, title: j.title, state: j.state, priceEth: j.priceEth })) },
    agents: final.agents.map((a) => ({ name: a.name, house: a.house, score: a.score, settled: a.settled, barred: a.barred })),
    gasWallet: { burnsRefusedForPrice: refusedForPrice.length, startEth: eth(BOT_START), endEth: eth(await balance(BOT)), gasWei: gasWei.toString(), transactions: sentCount, gasEth: eth(gasWei), gasUnits: Number(Object.values(gas).reduce((n, g) => n + g.gas, 0n)), paidPerGasGwei: Number(realGasPrice / 10n ** 3n) / 1e6, byKind: Object.fromEntries(Object.entries(gas).map(([k, g]) => [k, { sent: g.n, gas: Number(g.gas), wei: g.wei.toString() }])), sentOnToOwnerEth: eth(await balance(owner.address)), housePaidOutEth: eth(await balance(payout.address)) },
    engine: { actions: Object.fromEntries(Object.entries(hEnd.actions).map(([k, a]) => [k, a.done])), warnings: [...warned.entries()].map(([w, at]) => ({ at, w })), errors: [...errors.entries()].map(([e, at]) => ({ at, e })), ledgerLines: ledgerCount, house: hEnd.house, accounts: hEnd.accounts, compute: hEnd.compute },
    lateReads: await (await fetch(`http://127.0.0.1:${SOURCE_PORT}/`)).json(), barredAgentStillHirable: drill.barredHirable, hourly, day, checks, jobs,
  };
  writeFileSync(join(WORK, "rehearsal.json"), JSON.stringify(out2, null, 2));
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed. The record: ${join(WORK, "rehearsal.json")}`);
  if (failed.length) console.log(failed.map((f) => `  FAILED: ${f.name}${f.detail ? `  (${f.detail})` : ""}`).join("\n"));
  if (STAY) {
    console.log(`\nLeft running: the site on ${SITE}, the engine on ${API}, the copy of the chain on ${RPC}. Stop them with: npm run rehearsal -- --stop`);
    console.log(failed.length ? "ended with failures" : "ended well");
    process.exit(failed.length ? 1 : 0);
  }
  await stopAll();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`\nSTOPPED at T+${hourNow}h: ${(e as Error).message}`);
  console.error(`The engine's log: ${join(WORK, "engine.log")}`);
  if (!STAY) await stopAll();
  process.exit(1);
});
