// The engine against the real contracts, end to end, on a LOCAL fork of Robinhood Chain. Nothing here can reach the
// real chain: every transaction goes to an anvil this script starts on 127.0.0.1.
//
//   npm run e2e            the whole run and every check, then everything is stopped (about three minutes)
//   npm run e2e -- --stay  the fork and the engine are left running so the site can read it (FACTOR_ENGINE_URL)
//   npm run e2e -- --stop  stops what --stay left running
//   npm run e2e -- --bare  only the fork, the contracts, the engine and a launched, traded token, left running:
//                          what the site's own run through a browser starts from (web/scripts/flows.mjs)
//
// What it does, in order:
//   1  starts anvil as a fork of the chain's head and takes anvil's own built-in test accounts as the admin, the
//      gas wallet, a trader, two agents and a customer;
//   2  deploys the three contracts with the repo's own script (contracts/script/Deploy.s.sol) and starts the engine
//      as its own process, the way the host does: environment only, ENGINE_MODE=live;
//   3  launches $FACTOR with the repo's own script, trades it, and waits for the engine to sweep the fees: a tenth
//      of them is the pool;
//   4  runs jobs through the desk: one advanced from the pool and as compute, delivered, and settled BY THE ENGINE
//      when the customer never comes back; one nobody takes up, refunded by the engine; one drawn on and left,
//      refunded by the engine with the bond paying the pool;
//   4a the compute advance is credit at the engine's gateway: the agent signs for a key and calls a model with it
//      (a stand-in for the model maker, scripts/stub-model.ts: no model is called and nothing is spent), and the
//      credit of a job that is refunded at a loss goes back to the pool as ETH, sent by the engine;
//   5  an agent signs its name and a customer signs a job's title, and both show;
//   6  compares the engine's copy of every job and every agent with the desk itself, the engine's score for each
//      agent with the desk's own score(), and the engine's figures with the desk's books;
//   7  kills the engine and starts it again, then has it read the whole chain again from the deploy block: the same
//      ledger both times, and the signed names still there.
//   8  accounts without a wallet: a person with a passkey (made of software here, see scripts/passkey.ts) and an
//      agent whose key holds no ETH do a whole job, with the engine paying the gas of every transaction.
//   9  Factor's own agents: the engine puts three up, and customers hire them. One reads Chainlink's feeds on the
//      copy of the chain, two ask the model (the stand-in here), one job is under its agent's price and is declined.
//
// It ends with the list of checks and exits 1 if one failed.
//
// Keys: the only keys in this file are anvil's built-in test keys, which anvil prints for anybody at startup. They
// are public and hold nothing on any real chain. On the real chain those very addresses carry code, so the fork's
// copy of each is cleared first with anvil_setCode, a call that exists only on a local test node.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, defineChain, encodeAbiParameters, encodeFunctionData, hashMessage, hashTypedData, http, keccak256, parseAbi, parseEther, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { factorAccountAbi } from "../src/abi/index.js";
import { deskCall, orderTypedData, type Call } from "../src/accounts.js";
import { softPasskey } from "./passkey.js";
import { factorBurnPotAbi, factorDeskAbi, factorSplitterAbi, factorTokenAbi } from "../src/abi/index.js";
import type { AgentJson, EventJson, FactorState, JobJson } from "../src/api.js";
import { costMicro, DEFAULT_MODELS, keyMessage, usdMicro } from "../src/compute.js";
import { ponsFactoryAbi } from "../src/chain/pons.js";
import { FEED_ABI, FEEDS } from "../src/house/feeds.js";
import { briefMessage, profileMessage, proofOf, titleMessage } from "../src/profiles.js";

const ENGINE = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONTRACTS = join(ENGINE, "..", "contracts");
const FOUNDRY = join(process.env.HOME ?? "", ".foundry", "bin");
const LIVE_RPC = process.env.E2E_FORK_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ANVIL_PORT = 8646;
const ENGINE_PORT = 8789;
const MODEL_PORT = 8791;
// what the stand-in for the model maker takes as the owner's key: made up here, a key to nothing
const MODEL_KEY = "sk-ant-e2e-stand-in-a-key-to-nothing";
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const API = `http://127.0.0.1:${ENGINE_PORT}`;
const WORK = join(tmpdir(), "factor-e2e");
const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";

const args = process.argv.slice(2);
const STAY = args.includes("--stay");
const BARE = args.includes("--bare");

// anvil's built-in test accounts: the same on every machine, printed by anvil itself.
const keys = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
] as const;
const [adminAcct, botAcct, traderAcct, agentAcct, customerAcct, agent2Acct] = keys.map((k) => privateKeyToAccount(k));
const ADMIN = adminAcct.address, BOT = botAcct.address, TRADER = traderAcct.address, AGENT = agentAcct.address, CUSTOMER = customerAcct.address, AGENT2 = agent2Acct.address;
const BOT_KEY = keys[1]; // the engine signs with this, as BOT_PRIVATE_KEY
const low = (a: string) => a.toLowerCase();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (title: string) => console.log(`\n== ${title}`);
const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
const eth = (wei: bigint) => (Number(wei / 10n ** 12n) / 1e6).toString();
const near = (a: number, wei: bigint) => Math.abs(a - Number(wei / 10n ** 12n) / 1e6) < 1e-9;

function pidsOn(port: number): number[] {
  const r = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).map(Number);
}
async function stopPort(port: number): Promise<void> {
  for (const pid of pidsOn(port)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone already */ } }
  for (let i = 0; i < 100 && pidsOn(port).length; i++) await sleep(100);
  for (const pid of pidsOn(port)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone already */ } }
}

const chain = defineChain({ id: 4663, name: "Robinhood Chain (local fork)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const client = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }) });
async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const read = <T>(address: string, abi: Abi, functionName: string, a: unknown[] = []) => client.readContract({ address: address as `0x${string}`, abi, functionName, args: a }) as Promise<T>;
const blockTime = async () => Number((await client.getBlock()).timestamp);
const balance = (a: string) => client.getBalance({ address: a as `0x${string}` });

// A transaction from one of anvil's own accounts, which the local node signs for: no key is used here.
async function send(from: string, to: string, abi: Abi, functionName: string, a: unknown[] = [], value = 0n, gas = 2_000_000): Promise<void> {
  const data = encodeFunctionData({ abi, functionName, args: a });
  const hash = await rpc<`0x${string}`>("eth_sendTransaction", [{ from, to, data, value: `0x${value.toString(16)}`, gas: `0x${gas.toString(16)}` }]);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 250 });
  if (receipt.status !== "success") throw new Error(`${functionName} from ${from} reverted`);
}
// Move the chain's clock on: the next block is mined that much later, and time runs on from it.
async function warpBy(seconds: number): Promise<void> {
  await rpc("evm_setNextBlockTimestamp", [(await blockTime()) + seconds]);
  await rpc("evm_mine", []);
}
async function waitFor<T>(what: string, fn: () => Promise<T | null | false | undefined>, ms = 90_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    let v: T | null | false | undefined = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(400);
  }
}

function forge(script: string, extraEnv: Record<string, string>, sig?: string): string {
  const r = spawnSync(
    join(FOUNDRY, "forge"),
    ["script", script, "--rpc-url", RPC, ...(sig ? ["--sig", sig] : ["--broadcast", "--unlocked", "--sender", ADMIN])],
    // forge's record of what it sent goes into the working folder, so contracts/broadcast holds only real deploys
    { cwd: CONTRACTS, encoding: "utf8", env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}`, FOUNDRY_BROADCAST: join(WORK, "broadcast"), ...extraEnv } },
  );
  if (r.status !== 0) throw new Error(`forge script ${script}${sig ? ` ${sig}` : ""} failed:\n${(r.stdout + r.stderr).split("\n").slice(-25).join("\n")}`);
  return r.stdout;
}

interface Health { state: string; mode: string; problems: string[]; warnings: string[]; lastError: unknown; gateway: string; actions: Record<string, { done: number; failed: number; result: string }>; desk: Record<string, string | number> | null; ledger: number }
const get = async <T>(path: string) => (await (await fetch(`${API}${path}`)).json()) as T;
const state = () => get<FactorState>("/v1/state");
const health = () => get<Health>("/v1/health");
const post = async (path: string, body: unknown) => { const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };

// The engine as its own process, the way the host runs it: environment only.
function startEngine(dataDir: string, envFile: string, more: Record<string, string> = {}): void {
  mkdirSync(dataDir, { recursive: true });
  const log = openSync(join(WORK, "engine.log"), "a");
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["src/main.ts"], {
    cwd: ENGINE, stdio: ["ignore", log, log], detached: true,
    env: {
      ...process.env, PORT: String(ENGINE_PORT), FACTOR_DATA_DIR: dataDir, ENGINE_MODE: "live", BOT_PRIVATE_KEY: BOT_KEY, FACTOR_ENV_FILE: envFile, FACTOR_RPC_URLS: RPC,
      FACTOR_REHEARSAL_CLOCK: "chain", FACTOR_HOUSE_AGENTS: AGENT2,
      ACCOUNTS_MODE: "on",
      COMPUTE_MODE: "on", ANTHROPIC_API_KEY: MODEL_KEY, COMPUTE_UPSTREAM_URL: `http://127.0.0.1:${MODEL_PORT}`,
      ENGINE_WATCH_EVERY_MS: "700", ENGINE_ACT_EVERY_MS: "900", ENGINE_CONFIRMATIONS: "1", ENGINE_API_CACHE_MS: "0", ENGINE_SWEEP_EVERY_S: "60", ...more,
    },
  }).unref();
}

// Factor's own agents, switched on: their model is the stand-in, and a brief may wait a minute and a half
const HOUSE = { HOUSE_MODE: "on", HOUSE_UPSTREAM_URL: `http://127.0.0.1:${MODEL_PORT}`, HOUSE_BRIEF_WAIT_S: "90" };

const CURVE = parseAbi(["function buy(uint256 amountIn, uint256 minOut, address to) payable returns (uint256)"]) as Abi;
const DESK = factorDeskAbi as Abi;
const KIND = { early: 0, pool: 1, compute: 2 };

async function main(): Promise<void> {
  if (args.includes("--stop")) {
    await stopPort(ENGINE_PORT);
    await stopPort(ANVIL_PORT);
    await stopPort(MODEL_PORT);
    console.log("stopped");
    return;
  }
  console.log(`The engine against the real contracts on a local fork. Working folder: ${WORK}`);
  await stopPort(ENGINE_PORT);
  await stopPort(ANVIL_PORT);
  await stopPort(MODEL_PORT);
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  // the stand-in for the model maker: the engine's compute gateway is pointed at it, so no model is ever called
  const modelLog = openSync(join(WORK, "model.log"), "a");
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["scripts/stub-model.ts", String(MODEL_PORT), MODEL_KEY], { cwd: ENGINE, stdio: ["ignore", modelLog, modelLog], detached: true }).unref();
  // forge writes a small record of each script run into contracts/cache; what this run puts there is taken away again
  const records = ["Deploy.s.sol", "Launch.s.sol"].map((f) => join(CONTRACTS, "cache", f));
  const hadRecords = records.map((f) => existsSync(f));

  step("1  anvil, as a fork of Robinhood Chain's head, on 127.0.0.1 only");
  const anvilLog = openSync(join(WORK, "anvil.log"), "a");
  spawn(join(FOUNDRY, "anvil"), ["--fork-url", LIVE_RPC, "--port", String(ANVIL_PORT), "--host", "127.0.0.1", "--block-time", "1"], { stdio: ["ignore", anvilLog, anvilLog], detached: true }).unref();
  await waitFor("anvil", async () => (await rpc("eth_chainId")) === "0x1237", 60_000);
  await rpc("anvil_mine", ["0x1"]); // the first block anvil builds itself: calls against the forked head block fail
  console.log(`  chain 4663, forked near block ${await client.getBlockNumber()}`);
  for (const a of [ADMIN, BOT, TRADER, AGENT, CUSTOMER, AGENT2]) {
    await rpc("anvil_setCode", [a, "0x"]);
    await rpc("anvil_setBalance", [a, `0x${parseEther(a === BOT ? "0.05" : "100").toString(16)}`]);
  }

  step("2  the three contracts, deployed by the repo's own script, and the engine as its own process");
  spawnSync(join(FOUNDRY, "forge"), ["build", "--silent"], { cwd: CONTRACTS, env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` } });
  const deployBlock = Number(await client.getBlockNumber());
  forge("script/Deploy.s.sol", { FACTOR_ADMIN: ADMIN, FACTOR_GATEWAY: BOT });
  const record = JSON.parse(readFileSync(join(WORK, "broadcast", "Deploy.s.sol", "4663", "run-latest.json"), "utf8")) as { transactions: { contractName: string; contractAddress: string }[] };
  const at = (name: string) => record.transactions.find((t) => t.contractName === name)!.contractAddress;
  const burnPot = at("FactorBurnPot"), splitter = at("FactorSplitter"), desk = at("FactorDesk"), accountsAt = at("FactorAccounts");
  const addresses = { FACTOR_ADMIN: ADMIN, FACTOR_GATEWAY: BOT, FACTOR_BURN_POT: burnPot, FACTOR_DESK: desk, FACTOR_SPLITTER: splitter, FACTOR_ACCOUNTS: accountsAt };
  const envFile = join(WORK, "factor.fork.env");
  writeFileSync(envFile, [...Object.entries(addresses).map(([k, v]) => `${k}=${v}`), `FACTOR_DEPLOY_BLOCK=${deployBlock}`, ""].join("\n"));
  check("the contracts are deployed and wired (the script's own check)", forge("script/Deploy.s.sol", addresses, "check()").includes("OK: the three contracts are wired"));
  console.log(`  desk ${desk}, splitter ${splitter}, burn pot ${burnPot}`);
  const dataDir = join(WORK, "data");
  startEngine(dataDir, envFile);
  await waitFor("the engine to run", async () => (await health()).state === "running", 60_000);
  const h0 = await health();
  check("the engine runs in live mode as the gas wallet, with nothing wrong", h0.mode === "live" && h0.problems.length === 0 && h0.warnings.length === 0, `warnings: ${h0.warnings.join("; ") || "none"}`);
  check("it knows the desk's compute gateway", low(h0.gateway) === low(BOT));
  const before = await waitFor("the first reading", async () => { const s = await state(); return s.contracts.desk ? s : null; });
  check("before the launch the site's feed shows the desk with nothing in it, and says not launched", !before.launched && before.contracts.token === null && low(before.contracts.desk!) === low(desk) && before.stats.poolEth === 0 && before.agents.length === 0);

  step("3  $FACTOR is launched, traded, and the engine sweeps the fees: a tenth of them is the pool");
  const launchJson = readFileSync(join(CONTRACTS, "launch.json"), "utf8");
  forge("script/Launch.s.sol", { ...addresses, FACTOR_OPENING_BUY_WEI: parseEther("0.01").toString(), FACTOR_LAUNCH_JSON: launchJson });
  const token = await read<string>(burnPot, factorBurnPotAbi as Abi, "token");
  const launched = await read<{ curve: string }>(FACTORY, ponsFactoryAbi as Abi, "getLaunchedToken", [token]);
  check("the token is launched through the burn pot", /^0x[0-9a-fA-F]{40}$/.test(token) && !/^0x0{40}$/.test(token), token);
  await warpBy(15); // past Pons' launch seconds
  await send(TRADER, launched.curve, CURVE, "buy", [parseEther("2"), 0n, TRADER], parseEther("2"));
  await waitFor("the engine's first sweep", async () => (await health()).actions.sweep.done >= 1);
  const pool0 = await read<bigint>(desk, DESK, "pool");
  const toPool = await read<bigint>(splitter, factorSplitterAbi as Abi, "totalToPool");
  const split = await read<bigint>(splitter, factorSplitterAbi as Abi, "totalSplit");
  check("the engine swept the fees, and the pool's share is a tenth of them, in the desk", pool0 > 0n && pool0 === toPool && toPool === (split * 1000n) / 10_000n, `${eth(split)} ETH split, ${eth(pool0)} ETH pool`);
  const s3 = await waitFor("the pool to show", async () => { const s = await state(); return s.launched && s.stats.poolEth > 0 ? s : null; });
  check("the site's feed says launched and shows the pool to the wei", near(s3.stats.poolEth, pool0) && low(s3.contracts.token!) === low(token), `${s3.stats.poolEth} ETH`);
  // the ledger is written from logs a block behind the head, so its line follows the figure by a moment
  const arrived = await waitFor("the ledger's line", async () => (await state()).events.find((e) => e.kind === "pool_in")).catch(() => null);
  check("the ledger says trading fees arrived in the pool", arrived?.text === "trading fees arrived in the pool", arrived?.amount);

  if (BARE) {
    const failedSoFar = checks.filter((c) => !c.ok);
    records.forEach((f, i) => { if (!hadRecords[i]) rmSync(f, { recursive: true, force: true }); });
    if (failedSoFar.length) throw new Error(`${failedSoFar.length} check(s) failed before the desk was ready`);
    // what the kit's and the site's runs start from has Factor's own agents on it too
    await stopPort(ENGINE_PORT);
    startEngine(dataDir, envFile, HOUSE);
    await waitFor("the house agents to be on the desk", async () => (await state()).agents.filter((a) => a.house && a.named).length === 3, 120_000);
    writeFileSync(join(WORK, "bare.json"), JSON.stringify({ rpc: RPC, api: API, desk, splitter, burnPot, token, accounts: accountsAt, keys, model: `http://127.0.0.1:${MODEL_PORT}` }, null, 2));
    console.log(`\nLeft running: the fork on ${RPC}, the engine on ${API}, the pool holding ${eth(pool0)} ETH. Written to ${join(WORK, "bare.json")}.`);
    console.log("Stop them with: npm run e2e -- --stop");
    return;
  }

  step("4  jobs: one advanced and settled by the engine, one nobody takes up, one drawn on and left");
  await send(AGENT, desk, DESK, "register");
  await send(AGENT2, desk, DESK, "register");
  await send(AGENT, desk, DESK, "addBond", [], parseEther("0.004"));
  const due = (await blockTime()) + 2 * 3600;
  // job 1: 0.01 ETH, the customer allows nothing early; the agent draws from the pool and has compute paid
  await send(CUSTOMER, desk, DESK, "lock", [AGENT, BigInt(due), false], parseEther("0.01"));
  const botBefore = await balance(BOT);
  await send(AGENT, desk, DESK, "draw", [1n, parseEther("0.002"), KIND.pool]);
  await send(AGENT, desk, DESK, "draw", [1n, parseEther("0.002"), KIND.compute]);
  // job 2: for the second agent, which never answers
  await send(CUSTOMER, desk, DESK, "lock", [AGENT2, BigInt(due), false], parseEther("0.02"));
  const job1 = await waitFor("job 1 to show as advanced", async () => { const r = await get<{ job?: JobJson }>("/v1/jobs/1"); return r.job?.state === "advanced" && r.job.advances.length === 2 ? r.job : null; });
  check("the engine shows the job with both draws", job1.priceEth === 0.01 && job1.advance?.eth === 0.004 && job1.advances.map((a) => a.kind).join() === "pool,compute" && low(job1.agentId) === low(AGENT));
  check("the compute advance went to the gateway, less its fee, and never to the agent", (await balance(BOT)) >= botBefore + parseEther("0.00198") - parseEther("0.0005"));

  step("4a the compute advance is credit: the agent signs for a key and calls a model with it");
  type Credit = { balanceUsd: number; enabled: boolean; lots: { job: number; usd: number | null; spentUsd: number; state: string }[] };
  const creditOf = (a: string) => get<Credit>(`/v1/compute/credit/${low(a)}`);
  const credit0 = await waitFor("the credit to be priced", async () => { const c = await creditOf(AGENT); return c.balanceUsd > 0 ? c : null; });
  const ethUsd8 = BigInt((await get<{ ethUsd8: string }>("/v1/health")).ethUsd8);
  const lotMicro = Math.round(credit0.lots[0]!.usd! * 1e6);
  // the price moves between the draw and now, so the lot is held to Chainlink's price within a percent
  check("0.00198 ETH of compute is dollars of credit at Chainlink's ETH price", credit0.enabled && credit0.lots.length === 1 && credit0.lots[0]!.job === 1 && Math.abs(lotMicro - usdMicro(parseEther("0.00198"), ethUsd8)) <= lotMicro / 100, `$${credit0.balanceUsd} at $${Number(ethUsd8) / 1e8} an ETH`);
  const now4 = await blockTime();
  const keyFor = async (signer: typeof agentAcct, address: string) => fetch(`${API}/v1/compute/key`, { method: "POST", body: JSON.stringify({ address: low(address), at: now4, signature: await signer.signMessage({ message: keyMessage(low(address), now4) }) }) });
  check("a key asked for with another wallet's signature is refused", (await keyFor(customerAcct, AGENT)).status === 401);
  check("a wallet that is no agent gets no key", (await keyFor(customerAcct, CUSTOMER)).status === 404);
  const computeKey = ((await (await keyFor(agentAcct, AGENT)).json()) as { key: string }).key;
  check("the agent's own signature gets a key", /^fck_[A-Za-z0-9_-]{32}$/.test(computeKey));
  const ask = (body: Record<string, unknown>, key = computeKey) => fetch(`${API}/v1/compute/v1/messages`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
  const question = { model: "claude-sonnet-5-5", max_tokens: 400, messages: [{ role: "user", content: "Summarise the service agreement in one line." }] };
  const priceOf = (body: Record<string, unknown>) => costMicro({ input: Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4), output: 120, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, DEFAULT_MODELS["claude-sonnet-5-5"]!, 500);
  const answer = await ask(question);
  const answered = (await answer.json()) as { content: { text: string }[]; usage: { input_tokens: number; output_tokens: number } };
  // the stand-in only answers the key the engine was given as its owner's: an answer means that key was sent
  check("the call is answered in the model maker's own shape, sent on with the owner's key", answer.status === 200 && answered.content[0]!.text.startsWith("Summary:") && answered.usage.output_tokens === 120);
  const credit1 = await creditOf(AGENT);
  check("it cost what its tokens cost, to the millionth of a dollar", Math.round((credit0.balanceUsd - credit1.balanceUsd) * 1e6) === priceOf(question), `$${(priceOf(question) / 1e6).toFixed(6)}`);
  const streamed = await ask({ ...question, stream: true });
  const text = await streamed.text();
  const credit2 = await creditOf(AGENT);
  check("a stream comes through as a stream, and is counted the same way", streamed.headers.get("content-type") === "text/event-stream" && text.includes("event: message_start") && text.trimEnd().endsWith('data: {"type":"message_stop"}') && Math.round((credit1.balanceUsd - credit2.balanceUsd) * 1e6) === priceOf({ ...question, stream: true }));
  check("a tool the model maker runs, another speed, a model not on the list and a key that is no key are refused", (await ask({ ...question, tools: [{ type: "web_search_20250305", name: "web_search" }] })).status === 400 && (await ask({ ...question, speed: "fast" })).status === 400 && (await ask({ ...question, model: "some-other-model" })).status === 400 && (await ask(question, `fck_${"a".repeat(32)}`)).status === 401);
  check("a request that could cost more than the credit is refused before it is sent", (await ask({ ...question, model: "claude-fable-5-1", max_tokens: 16_000, messages: [{ role: "user", content: "x".repeat(1_500_000) }] })).status === 402 && (await creditOf(AGENT)).balanceUsd === credit2.balanceUsd);
  const hc = (await get<{ compute: { calls: number; spentMicro: number; unpaidMicro: number } }>("/v1/health")).compute;
  check("the engine's count of it: two calls, nothing unpaid", hc.calls === 2 && hc.unpaidMicro === 0 && hc.spentMicro === priceOf(question) + priceOf({ ...question, stream: true }));
  const engineLog = readFileSync(join(WORK, "engine.log"), "utf8");
  check("the owner's key is not in the engine's log, nor what was asked", !engineLog.includes(MODEL_KEY) && !engineLog.includes("Summarise the service agreement"));

  step("5  an agent signs its name, a customer signs a job's title");
  const now5 = await blockTime();
  const profile = { address: low(AGENT), name: "lumen-07", does: "Summarises long documents and contracts", at: now5 };
  const sig = await agentAcct.signMessage({ message: profileMessage(profile.address, profile.name, profile.does, profile.at) });
  check("the agent's signed profile is taken", (await post("/v1/agents/profile", { ...profile, signature: sig })).status === 200);
  const forged = await customerAcct.signMessage({ message: profileMessage(profile.address, "stolen-name", profile.does, profile.at) });
  check("a profile signed by another wallet is refused", (await post("/v1/agents/profile", { ...profile, name: "stolen-name", signature: forged })).status === 401);
  const title = "Summarise a 40-page service agreement";
  const tsig = await customerAcct.signMessage({ message: titleMessage(1, title, now5) });
  check("the customer's signed title is taken", (await post("/v1/jobs/title", { job: 1, title, at: now5, signature: tsig })).status === 200);
  const named = await get<{ agent: AgentJson }>("/v1/agents/lumen-07");
  check("the agent is found by its name, and the job carries its title", low(named.agent.address) === low(AGENT) && named.agent.named && (await get<{ job: JobJson }>("/v1/jobs/1")).job.title === title);
  check("the house agent is marked as one", (await state()).agents.find((a) => low(a.id) === low(AGENT2))?.house === true);

  step("4b the agent delivers, the customer never comes back, and the engine settles the job after 24 hours");
  await send(AGENT, desk, DESK, "deliver", [1n, `0x${"ab".repeat(32)}`]);
  const agentBefore = await balance(AGENT);
  const poolBefore = await read<bigint>(desk, DESK, "pool");
  await warpBy(24 * 3600 + 5);
  await waitFor("the engine to settle job 1", async () => (await read<{ state: number }>(desk, DESK, "job", [1n])).state === 4, 120_000);
  check("the engine settled it: the agent has the rest, less the 2% job fee", (await balance(AGENT)) - agentBefore === parseEther("0.01") - parseEther("0.004") - parseEther("0.0002"));
  // (the pool itself also grows by trading fees in the meantime, so the two things are checked on their own)
  const settledAgent = await read<{ advancedNow: bigint; advancesRepaid: number; feesPaid: bigint }>(desk, DESK, "agent", [AGENT]);
  check("and the pool has its advances back and the job fee", settledAgent.advancedNow === 0n && settledAgent.advancesRepaid === 1 && settledAgent.feesPaid === parseEther("0.0002") && (await read<bigint>(desk, DESK, "totalJobFees")) === parseEther("0.0002") && (await read<bigint>(desk, DESK, "pool")) >= poolBefore + parseEther("0.0042"));
  // its record now has something in it: the engine's score must be the desk's own, while it is not nothing
  const kept1 = await waitFor("the credit to be the agent's own", async () => { const c = await creditOf(AGENT); return c.lots[0]?.state === "kept" ? c : null; });
  check("the job settled, so what is left of its compute credit stays with the agent and still buys", kept1.balanceUsd === credit2.balanceUsd && (await ask(question)).status === 200);
  const scored = await waitFor("the agent's record to show", async () => { const r = await get<{ agent?: AgentJson }>(`/v1/agents/${low(AGENT)}`); return r.agent?.settled === 1 ? r.agent : null; });
  const deskScore = Number(await read<bigint>(desk, DESK, "score", [AGENT]));
  check("the engine's score for the agent is the desk's own score(), and is not nothing", scored.score === deskScore && deskScore === 20, `${scored.score} against ${deskScore}`);
  // job 2 is long past its due time and grace by now
  await waitFor("the engine to refund job 2", async () => (await read<{ state: number }>(desk, DESK, "job", [2n])).state === 7, 120_000);
  const a2 = await read<{ unanswered: number; notDelivered: number; barred: boolean }>(desk, DESK, "agent", [AGENT2]);
  check("the engine refunded the job nobody took up, and the agent's record is not marked", a2.unanswered === 1 && a2.notDelivered === 0 && !a2.barred);

  step("4c a job the agent draws on and leaves: the engine refunds it, the bond pays the pool, and unspent compute goes back");
  const due3 = (await blockTime()) + 2 * 3600;
  await send(CUSTOMER, desk, DESK, "lock", [AGENT, BigInt(due3), true], parseEther("0.012"));
  await send(AGENT, desk, DESK, "draw", [3n, parseEther("0.004"), KIND.pool]);
  // its limit is its bond plus the fees its first job paid: 0.0002 more, drawn as compute and never spent
  await send(AGENT, desk, DESK, "draw", [3n, parseEther("0.0002"), KIND.compute]);
  await send(AGENT, desk, DESK, "draw", [3n, parseEther("0.001"), KIND.early]);
  const creditBefore3 = await waitFor("the second lot of credit", async () => { const c = await creditOf(AGENT); return c.lots.length === 2 && c.lots[1]!.usd ? c : null; });
  const customerBefore = await balance(CUSTOMER);
  await warpBy(14 * 3600 + 60);
  await waitFor("the engine to refund job 3", async () => (await read<{ state: number }>(desk, DESK, "job", [3n])).state === 7, 120_000);
  check("the customer has the price back, less the early advance it allowed", (await balance(CUSTOMER)) - customerBefore === parseEther("0.011"));
  const a1 = await read<{ barred: boolean; bond: bigint; advancesNotRepaid: number; earlyKept: number }>(desk, DESK, "agent", [AGENT]);
  check("the bond paid the pool as far as it went, and the agent is barred", a1.barred && a1.bond === 0n && a1.advancesNotRepaid === 1 && a1.earlyKept === 1 && (await read<bigint>(desk, DESK, "totalLost")) === parseEther("0.0002"));
  // the pool lost 0.0002 ETH; 0.000198 of it was sitting unspent at the gateway as compute credit, and goes home
  const back = await waitFor("the engine to send the unspent compute back", async () => { const h = await health(); return h.actions.return_compute.done === 1 ? h : null; }, 120_000);
  const credit3 = await waitFor("the lot to close", async () => { const c = await creditOf(AGENT); return c.lots[1]?.state === "closed" ? c : null; });
  check("the refunded job's unspent compute credit went back to the pool as ETH, and the agent's other credit is untouched", back.actions.return_compute.result.includes("0.000198 ETH") && credit3.lots[1]!.usd === 0 && credit3.lots[0]!.state === "kept" && Math.round((creditBefore3.balanceUsd - credit3.balanceUsd) * 1e6) === Math.round(creditBefore3.lots[1]!.usd! * 1e6));
  const homecoming = await waitFor("the ledger's line for it", async () => (await get<{ items: EventJson[] }>("/v1/ledger?show=pool&limit=50")).items.find((e) => e.text === "compute credit nobody spent went back to the pool")).catch(() => null);
  check("and the ledger says so", homecoming?.amount === "+0.000198 ETH" || homecoming?.amount === "+0.0002 ETH", homecoming?.amount);

  step("4d the burn: trading fees and advance fees, bought back and burned by the engine");
  await waitFor("a burn", async () => (await read<bigint>(burnPot, factorBurnPotAbi as Abi, "burnCount")) >= 1n, 120_000);
  const supply = await read<bigint>(token, factorTokenAbi as Abi, "totalSupply");
  const burned = await read<bigint>(burnPot, factorBurnPotAbi as Abi, "totalTokensBurned");
  check("the engine burned, and the supply fell by exactly what was burned", burned > 0n && supply === 10n ** 27n - burned, `${eth(burned)} $FACTOR`);
  check("every advance fee reached the burn pot", (await read<bigint>(desk, DESK, "owed", [burnPot])) === 0n && (await read<bigint>(desk, DESK, "totalAdvanceFees")) === parseEther("0.000092"));

  step("6  the engine's copy against the desk itself");
  // let the engine read the last blocks
  const final = await waitFor("the engine to catch up", async () => { const s = await state(); return s.jobs.length === 3 && s.jobs.every((j) => j.state !== "locked" && j.state !== "advanced" && j.state !== "delivered") && s.stats.burnedTokens > 0 && s.events.some((e) => e.kind === "not_repaid") ? s : null; }, 120_000);
  const names = ["none", "locked", "advanced", "delivered", "settled", "half", "declined", "refunded"];
  let jobsMatch = true;
  for (const j of final.jobs) {
    const onChain = await read<{ state: number; price: bigint; early: bigint; fromPool: bigint; customer: string; agent: string }>(desk, DESK, "job", [BigInt(j.n)]);
    const drawn = j.advances.reduce((n, a) => n + a.eth, 0);
    if (names[onChain.state] !== j.state || !near(j.priceEth, onChain.price) || !near(drawn, onChain.early + onChain.fromPool) || low(onChain.customer) !== low(j.customer) || low(onChain.agent) !== low(j.agentId)) jobsMatch = false;
  }
  check("every job is as the desk holds it: its state, its price, what was drawn, who is in it", jobsMatch, final.jobs.map((j) => `${j.id} ${j.state}`).join(", "));
  let agentsMatch = true;
  const scores: string[] = [];
  for (const a of final.agents) {
    const [score, limit, canDraw, rec] = await Promise.all([
      read<bigint>(desk, DESK, "score", [a.address]), read<bigint>(desk, DESK, "limit", [a.address]), read<bigint>(desk, DESK, "canDraw", [a.address]),
      read<{ settled: number; feesPaid: bigint; bond: bigint; unanswered: number; notDelivered: number; barred: boolean }>(desk, DESK, "agent", [a.address]),
    ]);
    scores.push(`${a.name} ${a.score}`);
    if (Number(score) !== a.score || !near(a.limitEth, limit) || !near(a.canDrawEth, canDraw) || rec.settled !== a.settled || !near(a.feesPaidEth, rec.feesPaid) || !near(a.bondEth, rec.bond) || rec.unanswered !== a.unanswered || rec.notDelivered !== a.notDelivered || rec.barred !== a.barred) agentsMatch = false;
  }
  check("every agent is as the desk holds it, and the engine's score is the desk's own score()", agentsMatch, scores.join(", "));
  const [pool, out, held, bonds, owedTotal, lost, deskBalance] = await Promise.all([...["pool", "out", "held", "bonds", "owedTotal", "totalLost"].map((fn) => read<bigint>(desk, DESK, fn)), balance(desk)]);
  check("the desk holds exactly what its books say", deskBalance === pool + held + bonds + owedTotal, `${eth(deskBalance)} ETH`);
  check("the engine's figures are the desk's books", near(final.stats.poolEth, pool + out) && near(final.stats.outEth, out) && near(final.stats.heldEth, held) && near(final.stats.lostEth, lost) && final.stats.settledJobs === 1 && final.stats.jobs === 3);
  const kinds = final.events.map((e: EventJson) => e.kind);
  check("the ledger has a line for everything that happened", ["pool_in", "bond", "locked", "advanced", "delivered", "settled", "refunded", "not_repaid", "burned"].every((k) => kinds.includes(k)), `${final.events.length} lines`);
  check("the ledger words the two refunds differently", final.events.some((e) => e.text === "the job was not taken up, the customer has it all back") && final.events.some((e) => e.text === "lumen-07 did not deliver in time, the customer was refunded") && final.events.some((e) => e.text === "lumen-07 did not deliver: its bond paid first, the pool the rest"));
  const h6 = await waitFor("the engine's own record of the two refunds", async () => { const h = await health(); return h.actions.refund_job.done === 2 ? h : null; });
  check("nothing the engine sent failed, and it warns of nothing", h6.problems.length === 0 && h6.warnings.length === 0 && Object.values(h6.actions).every((a) => a.failed === 0), `${Object.entries(h6.actions).map(([k, a]) => `${k} ${a.done}`).join(", ")}`);
  check("it settled one job and refunded two", h6.actions.settle_job.done === 1 && h6.actions.refund_job.done === 2);

  step("7  the engine is killed and started again, then reads the whole chain again from the deploy block");
  const ledgerBefore = (await get<{ items: EventJson[] }>("/v1/ledger?limit=200")).items.map((e) => `${e.kind}|${e.jobId ?? ""}|${e.amount}|${e.tx}`);
  const numbersBefore = (await get<{ items: EventJson[] }>("/v1/ledger?limit=200")).items.map((e) => e.n);
  await stopPort(ENGINE_PORT);
  startEngine(dataDir, envFile);
  await waitFor("the engine to run again", async () => (await health()).state === "running", 60_000);
  const again = await waitFor("its state", async () => { const s = await state(); return s.jobs.length === 3 ? s : null; });
  check("after a restart it shows the same jobs, agents and names", again.jobs.map((j) => j.state).join() === final.jobs.map((j) => j.state).join() && again.agents.find((a) => a.named)?.name === "lumen-07");
  await stopPort(ENGINE_PORT);
  startEngine(dataDir, envFile, { ENGINE_REINDEX: "once" });
  await waitFor("the engine to run a third time", async () => (await health()).state === "running", 60_000);
  const reread = await waitFor("the ledger to be read again", async () => { const l = (await get<{ items: EventJson[] }>("/v1/ledger?limit=200")).items; return l.length === ledgerBefore.length ? l : null; }, 120_000);
  check("read again from the deploy block, the ledger is the same, line for line", reread.map((e) => `${e.kind}|${e.jobId ?? ""}|${e.amount}|${e.tx}`).join("\n") === ledgerBefore.join("\n"), `${reread.length} lines`);
  check("and its lines carry the same numbers as before", reread.map((e) => e.n).join() === numbersBefore.join());
  const kept = await state();
  check("and the signed name and title were kept", kept.agents.find((a) => a.named)?.name === "lumen-07" && kept.jobs.find((j) => j.n === 1)?.title === title);
  check("the gas wallet sent only what it had to", (await client.getTransactionCount({ address: BOT })) === Object.values((await health()).actions).reduce((n, a) => n + a.done, 0), `${await client.getTransactionCount({ address: BOT })} transactions`);

  step("8  accounts without a wallet: a passkey and a key with no ETH do a whole job, and the engine pays the gas");
  type Order = { status: string; hash?: string; error?: string; refused?: { name: string; args: string[] }; logs?: { address: string; topics: Hex[]; data: Hex }[] };
  const wire = (calls: Call[]) => calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data }));
  const settledOrder = (id: string) => waitFor("the order to be mined", async () => { const s = await get<Order>(`/v1/accounts/relay/${id}`); return s.status === "done" || s.status === "failed" ? s : null; }, 60_000);
  // an order from the check to the receipt: what the site does for a passkey, and the kit for an agent's key
  const order = async (account: string, calls: Call[], sign: (typed: ReturnType<typeof orderTypedData>) => Promise<Hex> | Hex): Promise<{ status: number; body: Record<string, unknown>; order?: Order }> => {
    const checked = await post("/v1/accounts/check", { account, calls: wire(calls) });
    if (checked.status !== 200) return checked;
    const deadline = checked.body.deadline as number;
    const signature = await sign(orderTypedData(account, 4663, calls, checked.body.nonce as number, deadline));
    const sent = await post("/v1/accounts/relay", { account, calls: wire(calls), deadline, signature });
    return sent.status === 200 ? { ...sent, order: await settledOrder(sent.body.id as string) } : sent;
  };
  const h8 = await health() as Health & { accounts: { enabled: boolean; factory: string; orders: number; gasTodayWei: string } };
  check("the engine knows the maker of accounts and takes orders", h8.accounts?.enabled && low(h8.accounts.factory) === low(accountsAt) && (await state() as FactorState & { accounts: { enabled: boolean } }).accounts.enabled);

  // a person: a passkey and nothing else
  const passkey = softPasskey();
  const bySig = (typed: ReturnType<typeof orderTypedData>) => passkey.sign(hashTypedData(typed));
  const botTxs = await client.getTransactionCount({ address: BOT });
  const made = await post("/v1/accounts", { kind: "passkey", x: passkey.x, y: passkey.y, credential: passkey.credential });
  const person = made.body.address as string;
  const madeOrder = await settledOrder(made.body.relay as string);
  check("a passkey gets an account, made on the chain by the gas wallet", made.status === 200 && madeOrder.status === "done" && (await client.getCode({ address: person as Hex })) !== undefined && low(await read<string>(accountsAt, parseAbi(["function addressOf((uint8 kind, bytes32 a, bytes32 b)) view returns (address)"]) as Abi, "addressOf", [{ kind: 2, a: passkey.x, b: passkey.y }])) === low(person), person);
  check("asked for again, it is the same account, and a browser finds it by the passkey's own id", (await post("/v1/accounts", { kind: "passkey", x: passkey.x, y: passkey.y, credential: passkey.credential })).body.address === person && (await get<{ address: string }>(`/v1/accounts/by-credential/${passkey.credential}`)).address === person);
  // an agent: a program with a brand new key, and not a wei
  const agentKeyNew = generatePrivateKey();
  const gasless = privateKeyToAccount(agentKeyNew);
  const byKey = (typed: ReturnType<typeof orderTypedData>) => gasless.signTypedData(typed);
  const madeAgent = await post("/v1/accounts", { kind: "wallet", address: gasless.address });
  const worker = madeAgent.body.address as string;
  await settledOrder(madeAgent.body.relay as string);
  const registered = await order(worker, [deskCall(desk, "register")], byKey);
  check("an agent whose key holds no ETH registers on the desk", registered.order?.status === "done" && (await read<{ registered: boolean }>(desk, DESK, "agent", [worker])).registered && (await balance(gasless.address)) === 0n);

  // the person's ETH arrives from wherever they have it
  await rpc("eth_sendTransaction", [{ from: TRADER, to: person, value: `0x${parseEther("0.05").toString(16)}` }]);
  await waitFor("the ETH to arrive", async () => (await balance(person)) === parseEther("0.05"));
  const due8 = (await blockTime()) + 2 * 3600;
  const small = await post("/v1/accounts/check", { account: person, calls: wire([deskCall(desk, "lock", [worker, BigInt(due8), true], parseEther("0.0001"))]) });
  check("a job under the smallest is refused before anything is signed, with the desk's own reason", small.status === 400 && (small.body.refused as { name: string })?.name === "TooSmall");
  const tooMuch = await post("/v1/accounts/check", { account: person, calls: wire([deskCall(desk, "lock", [worker, BigInt(due8), true], parseEther("1"))]) });
  check("and one the account cannot pay for", tooMuch.status === 400, String(tooMuch.body.error).slice(0, 80));
  const jobsBefore = Number(await read<bigint>(desk, DESK, "jobCount"));
  const hired = await order(person, [deskCall(desk, "lock", [worker, BigInt(due8), true], parseEther("0.02"))], bySig);
  const job8 = jobsBefore + 1;
  const locked8 = await read<{ customer: string; agent: string; price: bigint; state: number }>(desk, DESK, "job", [BigInt(job8)]);
  check("the passkey hires the agent: the desk holds the job for the two accounts", hired.order?.status === "done" && low(locked8.customer) === low(person) && low(locked8.agent) === low(worker) && locked8.price === parseEther("0.02") && (await balance(person)) === parseEther("0.03"), `job ${job8}`);
  // the chain this is a copy of checks a passkey's signature itself (a precompile): asked directly, it takes this very one
  const native = await fetch(LIVE_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000100", data: `0x${[passkey.last!.hash, passkey.last!.r, passkey.last!.s, passkey.x, passkey.y].map((w) => w.slice(2)).join("")}` }, "latest"] }) }).then((r) => r.json() as Promise<{ result?: string }>).catch(() => ({ result: undefined }));
  check("the real chain's own passkey check accepts the signature the account just took", native.result === `0x${"0".repeat(63)}1`, native.result ?? "the node did not answer");

  // And the account's own code, run by the real chain (a read with the code put at an empty address for the length
  // of the call: nothing is deployed and nothing is sent). There the passkey is checked natively, which a local
  // copy of the chain may not do.
  const original = await read<string>(accountsAt, parseAbi(["function implementation() view returns (address)"]) as Abi, "implementation");
  const probe = "0x00000000000000000000000000000000fac70a11";
  const slot = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [passkey.id, 0n])));
  const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
  const overrides = { [probe]: { code: await client.getCode({ address: original as Hex }), stateDiff: { [word(slot)]: word(2n), [word(slot + 1n)]: passkey.x, [word(slot + 2n)]: passkey.y } } };
  const said = hashMessage("the real chain checks this");
  const realCall = async (method: string, hash: Hex, signature: Hex) => fetch(LIVE_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [{ to: probe, data: encodeFunctionData({ abi: factorAccountAbi, functionName: "isValidSignature", args: [hash, signature] }) }, "latest", overrides] }) }).then((r) => r.json() as Promise<{ result?: string; error?: { message: string } }>).catch((e: Error) => ({ result: undefined, error: { message: e.message } }));
  const realSig = passkey.sign(said);
  const [realYes, realNo, realGas] = [await realCall("eth_call", said, realSig), await realCall("eth_call", hashMessage("something else"), realSig), await realCall("eth_estimateGas", said, realSig)];
  check("the account's own code, run by the real chain, takes the passkey's signature and refuses it for another text", realYes.result?.startsWith("0x1626ba7e") && realNo.result?.startsWith("0xffffffff"), realYes.result ? `about ${Number(BigInt(realGas.result ?? "0x0"))} gas there for the whole check` : realYes.error?.message.slice(0, 120));

  const otherPasskey = softPasskey();
  const stolen = await order(person, [{ to: TRADER, value: parseEther("0.03"), data: "0x" }], (typed) => { const sig = otherPasskey.sign(hashTypedData(typed)); return `${passkey.id}${sig.slice(66)}` as Hex; });
  check("another passkey's signature moves nothing out of the account", stolen.status === 401 && (stolen.body.refused as { name: string })?.name === "BadSignature" && (await balance(person)) === parseEther("0.03"));
  const elsewhere = await post("/v1/accounts/check", { account: person, calls: wire([{ to: splitter, value: 0n, data: "0x35faa416" }]) });
  check("the gas wallet pays for the desk's calls and ETH going out, and not for calls to anything else", elsewhere.status === 400);

  const drew = await order(worker, [deskCall(desk, "draw", [BigInt(job8), parseEther("0.01"), KIND.early])], byKey);
  check("the agent draws early: the advance lands in its account, and the desk owes it nothing", drew.order?.status === "done" && (await balance(worker)) === parseEther("0.0099") && (await read<bigint>(desk, DESK, "owed", [worker])) === 0n);
  const delivered8 = await order(worker, [deskCall(desk, "deliver", [BigInt(job8), `0x${"cd".repeat(32)}`])], byKey);
  const accepted8 = await order(person, [deskCall(desk, "accept", [BigInt(job8)])], bySig);
  check("it delivers, the passkey accepts, and the agent's account is paid", delivered8.order?.status === "done" && accepted8.order?.status === "done" && (await read<{ state: number }>(desk, DESK, "job", [BigInt(job8)])).state === 4 && (await balance(worker)) === parseEther("0.0099") + parseEther("0.01") - parseEther("0.0004"));

  // names: an account signs through its own key, and the engine asks the account whether it did
  const now8 = await blockTime();
  const profile8 = { address: low(worker), name: "gasless-01", does: "Works without a wei of its own", at: now8 };
  const sig8 = await gasless.signMessage({ message: profileMessage(profile8.address, profile8.name, profile8.does, profile8.at) });
  const wrong8 = await agentAcct.signMessage({ message: profileMessage(profile8.address, profile8.name, profile8.does, profile8.at) });
  check("the agent's account signs its name with its key, and nobody else's key will do", (await post("/v1/agents/profile", { ...profile8, signature: wrong8 })).status === 401 && (await post("/v1/agents/profile", { ...profile8, signature: sig8 })).status === 200);
  const title8 = "Proofread a product page";
  await waitFor("the engine to have the job", async () => (await get<{ job?: JobJson }>(`/v1/jobs/${job8}`)).job);
  const titleSig = passkey.sign(hashMessage(titleMessage(job8, title8, now8)));
  check("the passkey signs what its job is about", (await post("/v1/jobs/title", { job: job8, title: title8, at: now8, signature: titleSig })).status === 200 && (await get<{ job: JobJson }>(`/v1/jobs/${job8}`)).job.title === title8);

  // out: the agent's owner takes what it earned to an address of its own
  const earned = await balance(worker);
  const out8 = await order(worker, [{ to: gasless.address, value: earned, data: "0x" }], byKey);
  check("the agent's earnings leave its account for its owner's own address", out8.order?.status === "done" && (await balance(gasless.address)) === earned && (await balance(worker)) === 0n, `${eth(earned)} ETH`);
  // a second key: the person adds a wallet, which can then act for the account with its own gas, engine or no engine
  const added = await order(person, [{ to: person, value: 0n, data: encodeFunctionData({ abi: factorAccountAbi, functionName: "addKey", args: [{ kind: 1, a: `0x${"0".repeat(24)}${CUSTOMER.slice(2)}`, b: `0x${"0".repeat(64)}` }, "0x"] }) }], bySig);
  await send(CUSTOMER, person, factorAccountAbi as Abi, "run", [[{ to: CUSTOMER, value: parseEther("0.01"), data: "0x" }]]);
  check("a wallet added as a second key moves the account's ETH by itself, with no help from the engine", added.order?.status === "done" && (await balance(person)) === parseEther("0.02") && (await get<{ keys: unknown[] }>(`/v1/accounts/${person}`)).keys.length === 2);
  const h8b = await health() as Health & { accounts: { orders: number; failed: number; gasTodayWei: string } };
  const sentFor = (await client.getTransactionCount({ address: BOT })) - botTxs;
  check("every one of those transactions was the gas wallet's, and it knows what they cost", sentFor === h8b.accounts.orders && h8b.accounts.orders === 9 && h8b.accounts.failed === 0 && BigInt(h8b.accounts.gasTodayWei) > 0n, `${sentFor} transactions, ${eth(BigInt(h8b.accounts.gasTodayWei))} ETH of gas in all`);

  step("9  Factor's own agents: put up by the engine, hired by a customer, and doing the work");
  await stopPort(ENGINE_PORT);
  startEngine(dataDir, envFile, HOUSE);
  await waitFor("the engine to run with its agents", async () => (await health()).state === "running", 60_000);
  type Own = AgentJson & { service?: { needs: string; delivers: string; fromEth: number } };
  const own = await waitFor("the three agents to be on the desk", async () => { const a = (await state()).agents.filter((x) => x.house && x.named && (x as Own).service) as Own[]; return a.length === 3 ? a : null; }, 120_000);
  const byName = (n: string) => own.find((a) => a.name === n)!;
  const [pageSmith, plainReader, priceDesk] = [byName("page-smith"), byName("plain-reader"), byName("price-desk")];
  check("the engine put three agents of its own on the desk: registered, named, and said to be Factor's", !!pageSmith && !!plainReader && !!priceDesk && (await read<{ registered: boolean }>(desk, DESK, "agent", [priceDesk.address])).registered && pageSmith.service!.fromEth === 0.003, own.map((a) => `${a.name} from ${a.service!.fromEth} ETH`).join(", "));
  // a customer hires one: the price is locked, then the brief is signed, as the site does it
  const hireOwn = async (agent: Own, price: string, title: string, brief: string | null): Promise<number> => {
    const n = Number(await read<bigint>(desk, DESK, "jobCount")) + 1;
    await send(CUSTOMER, desk, DESK, "lock", [agent.address, BigInt((await blockTime()) + 6 * 3600), false], parseEther(price));
    if (brief !== null) {
      await waitFor("the engine to have the job", async () => (await get<{ job?: JobJson }>(`/v1/jobs/${n}`)).job);
      const at = await blockTime();
      const signature = await customerAcct.signMessage({ message: briefMessage(n, title, brief, at) });
      const r = await post("/v1/jobs/brief", { job: n, title, brief, at, signature });
      if (r.status !== 200) throw new Error(`the brief of job ${n} was not taken: ${JSON.stringify(r.body)}`);
    }
    return n;
  };
  type Page = { job: JobJson; brief: string | null; work: { kind: string; text: string } | null; note?: string };
  const closed = (n: number, state: string) => waitFor(`job ${n} to be ${state}`, async () => { const p = await get<Page>(`/v1/jobs/${n}`); return p.job?.state === state && (state !== "delivered" || p.work) ? p : null; }, 120_000);

  const sheetJob = await hireOwn(priceDesk, "0.001", "Prices", "NVDA, ETH and LINK please");
  const sheet = await closed(sheetJob, "delivered");
  // the same feeds, asked directly on the same copy of the chain
  const feedOf = (sym: string) => FEEDS.find((f) => f.symbol === sym)!.address;
  const nvda = (await read<readonly bigint[]>(feedOf("NVDA"), FEED_ABI as unknown as Abi, "latestRoundData"))[1]!;
  const nvdaText = `$${(nvda / 10n ** 8n).toLocaleString("en-US")}.${(nvda % 10n ** 8n).toString().padStart(8, "0").slice(0, 2)}`;
  check("price-desk delivers a sheet read from Chainlink's own feeds, with no model asked", sheet.work?.kind === "text" && sheet.work.text.includes(nvdaText) && /ETH\s+\$[\d,]+\.\d\d/.test(sheet.work.text) && /LINK\s+\$/.test(sheet.work.text) && sheet.work.text.includes(feedOf("NVDA")), `NVDA ${nvdaText}`);
  const proofOnChain = async (n: number) => (await read<{ proof: string }>(desk, DESK, "job", [BigInt(n)])).proof;
  check("what the job's page shows is what is on the chain: the work's fingerprint is the desk's proof", (await proofOnChain(sheetJob)) === proofOf(sheet.work!.text));

  const lease = `This lease is made between the landlord and the tenant for the flat at 4 Mill Lane. ${"The tenant pays the rent on the first of each month and keeps the flat in good order. ".repeat(4)}It runs for two years and renews by itself unless either side gives three months of notice.`;
  const readJob = await hireOwn(plainReader, "0.002", "A lease for a flat", lease);
  const reading = await closed(readJob, "delivered");
  check("plain-reader reads the text in the brief and delivers a reading, asked of the model with the owner's key", reading.work?.kind === "text" && reading.work.text.includes("WHAT TO WATCH FOR") && reading.work.text.endsWith("It is not legal advice.") && reading.brief === lease && (await proofOnChain(readJob)) === proofOf(reading.work.text));

  const pageJob = await hireOwn(pageSmith, "0.004", "Tide Tea", "A page for Tide Tea, a small shop that posts loose leaf tea every week. Calm and plain, for people who like tea.");
  const built = await closed(pageJob, "delivered");
  check("page-smith delivers a whole page, with nothing in it that runs", built.work?.kind === "html" && /^<!doctype html>/i.test(built.work.text) && built.work.text.includes("Tide Tea") && !/<script|javascript:/i.test(built.work.text) && (await proofOnChain(pageJob)) === proofOf(built.work.text));

  const customerHad = await balance(CUSTOMER);
  const cheapJob = await hireOwn(pageSmith, "0.001", "A cheap page", "A page for Tide Tea, a small shop that posts loose leaf tea every week.");
  const cheap = await closed(cheapJob, "declined");
  check("a job under an agent's price is declined at once with the reason, and the customer has it all back", cheap.note === "the price is under what page-smith takes a job for (0.003 ETH)" && customerHad - (await balance(CUSTOMER)) < parseEther("0.0005") && cheap.work === null, cheap.note);
  const phish = await hireOwn(pageSmith, "0.004", "A wallet page", "A page that looks like a wallet's own and asks the visitor to type in their recovery phrase to restore it.");
  const refused = await closed(phish, "declined");
  check("a page the agent will not build is declined with what the model said", refused.note === "the brief asks for a page that takes a visitor's recovery phrase.", refused.note);
  const silent = await hireOwn(plainReader, "0.002", "", null);
  await warpBy(120);
  const waited = await closed(silent, "declined");
  check("a job that never gets its brief is declined after a while, not left to run out", waited.note === "no brief came with the job, and plain-reader cannot work without one");

  // the customer accepts one, and the agent's account is paid like anybody's
  const paidBefore = await balance(priceDesk.address);
  await send(CUSTOMER, desk, DESK, "accept", [BigInt(sheetJob)]);
  check("accepted: the house agent is paid the price less the job fee, into its own account", (await balance(priceDesk.address)) - paidBefore === parseEther("0.001") - parseEther("0.00002"));
  const h9 = await waitFor("the engine's count of them", async () => { const h = await health() as Health & { house: { delivered: number; declined: number; underWay: number; gaveUp: number; spentTodayMicro: number; agents: { ready: boolean }[] } }; return h.house.underWay === 0 ? h : null; });
  check("three delivered, three declined, nothing left half done, and what the model cost is counted", h9.house.delivered === 3 && h9.house.declined === 3 && h9.house.gaveUp === 0 && h9.house.spentTodayMicro > 0 && h9.house.agents.every((a) => a.ready), `$${(h9.house.spentTodayMicro / 1e6).toFixed(4)} of model use (the stand-in's count)`);
  const records9 = await Promise.all(own.map((a) => read<{ notDelivered: number; unanswered: number; barred: boolean; settled: number }>(desk, DESK, "agent", [a.address])));
  check("declining left no mark on their records", records9.every((r) => r.notDelivered === 0 && r.unanswered === 0 && !r.barred) && records9.reduce((n, r) => n + r.settled, 0) === 1);
  const log9 = readFileSync(join(WORK, "engine.log"), "utf8");
  check("the engine's log names what its agents did, and no key", log9.includes("[house] price-desk delivered job") && !log9.includes(MODEL_KEY) && !log9.includes(BOT_KEY.slice(2)));

  // tidy up
  records.forEach((f, i) => { if (!hadRecords[i]) rmSync(f, { recursive: true, force: true }); });
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed.`);
  if (failed.length) console.log(failed.map((f) => `  FAILED: ${f.name}`).join("\n"));
  if (STAY && !failed.length) {
    console.log(`\nLeft running: the fork on ${RPC}, the engine on ${API}. Stop them with: npm run e2e -- --stop`);
    return;
  }
  await stopPort(ENGINE_PORT);
  await stopPort(ANVIL_PORT);
  await stopPort(MODEL_PORT);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`\nSTOPPED: ${(e as Error).message}`);
  console.error(`The engine's log: ${join(WORK, "engine.log")}`);
  await stopPort(ENGINE_PORT);
  await stopPort(ANVIL_PORT);
  await stopPort(MODEL_PORT);
  process.exit(1);
});
