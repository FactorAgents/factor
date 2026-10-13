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
import { createPublicClient, defineChain, encodeFunctionData, http, parseAbi, parseEther, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { factorBurnPotAbi, factorDeskAbi, factorSplitterAbi, factorTokenAbi } from "../src/abi/index.js";
import type { AgentJson, EventJson, FactorState, JobJson } from "../src/api.js";
import { costMicro, DEFAULT_MODELS, keyMessage, usdMicro } from "../src/compute.js";
import { ponsFactoryAbi } from "../src/chain/pons.js";
import { profileMessage, titleMessage } from "../src/profiles.js";

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
      COMPUTE_MODE: "on", ANTHROPIC_API_KEY: MODEL_KEY, COMPUTE_UPSTREAM_URL: `http://127.0.0.1:${MODEL_PORT}`,
      ENGINE_WATCH_EVERY_MS: "700", ENGINE_ACT_EVERY_MS: "900", ENGINE_CONFIRMATIONS: "1", ENGINE_API_CACHE_MS: "0", ENGINE_SWEEP_EVERY_S: "60", ...more,
    },
  }).unref();
}

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
  const burnPot = at("FactorBurnPot"), splitter = at("FactorSplitter"), desk = at("FactorDesk");
  const addresses = { FACTOR_ADMIN: ADMIN, FACTOR_GATEWAY: BOT, FACTOR_BURN_POT: burnPot, FACTOR_DESK: desk, FACTOR_SPLITTER: splitter };
  const envFile = join(WORK, "factor.fork.env");
  writeFileSync(envFile, [...Object.entries(addresses).map(([k, v]) => `${k}=${v}`), `FACTOR_DEPLOY_BLOCK=${deployBlock}`, ""].join("\n"));
  check("the three contracts are deployed and wired (the script's own check)", forge("script/Deploy.s.sol", addresses, "check()").includes("OK: the three contracts are wired"));
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
    writeFileSync(join(WORK, "bare.json"), JSON.stringify({ rpc: RPC, api: API, desk, splitter, burnPot, token, keys, model: `http://127.0.0.1:${MODEL_PORT}` }, null, 2));
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
