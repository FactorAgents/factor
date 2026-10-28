// Agent coins, end to end, on a LOCAL fork of Robinhood Chain: the fork (read through the rehearsal's own go-between,
// engine/scripts/rehearsal-node.ts), Factor's contracts deployed there by the engine's own script, the coin launcher
// deployed by contracts/deploy-coins.sh (the one command the owner will run), the engine with AGENT_COINS=on and
// Factor's own agents on the stand-in model, the real Pons, and the site in front of it, all on 127.0.0.1. Nothing here
// reaches the real chain, and no model is called: the paid model call goes to the stand-in, so it costs nothing.
//
//   npm run coins-e2e            every check, then everything is stopped
//   npm run coins-e2e -- --stay  everything is left running (the site on 3830) for pictures and the film
//   npm run coins-e2e -- --stop  stops what --stay left running
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  a maker makes an agent on the site, tide-scribe, and Factor puts it on the desk and runs it
//   2  the maker launches tide-scribe's coin: Factor signs the agent's permission when the maker asks with its own
//      signature, and the maker's wallet sends the launch with a first buy; read back from Pons and from the engine
//   3  Factor's admin, the maker of Factor's own agents, launches page-smith's coin the same way
//   4  a stranger cannot launch a coin for somebody else's agent, a copied permission is no use to anybody else, and a
//      second coin for the same agent is refused
//   5  other wallets buy and sell the coin
//   6  a stranger sweeps it: every share arrives to the wei (the agent's compute at the gateway, the maker, the burn
//      pot, the owner)
//   7  the keeper sweeps it by itself once its fees are worth the gas
//   8  the burn pot buys $FACTOR with what it holds and burns it: the supply falls by exactly what was burned
//   9  tide-scribe's compute credit rose by what its coin paid, shown as paid by its coin, and it runs a paid model call
//      with it (the stand-in: nothing is spent), which comes off that credit
//  10  an agent with a wallet of its own signs a permission for its maker, who launches its coin with it
//  11  the owner's coins switch hides every coin at once, and turned back, they return
//  12  the assistant's tools say it in words
//
// Keys: anvil's built-in test keys (inside the engine's script; the first is the admin wallet, the second the gas
// wallet) and keys made up here for this run, funded on the fork only. No wallet of Factor's.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, http, keccak256, parseAbi, parseEther, toHex, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentCoinLauncherAbi } from "../src/abi/AgentCoinLauncher.js";
import { agentCoinSplitterAbi } from "../../../engine/src/abi/AgentCoinSplitter.js";
import { houseSigner, takeHouseSeed } from "../../../engine/src/house/house.js";
import { hostedMessage } from "../../../engine/src/house/hosted.js";
import { keyMessage } from "../../../engine/src/compute.js";
import { permissionTypedData } from "../../../engine/src/coins.js";
import { Factor, Refusal } from "../src/index.js";
import { runTool } from "../src/tools.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WEB = join(KIT, "..", "..", "web");
const PORTS = { site: 3830, anvil: 3831, engine: 3832, model: 3833, source: 3834 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-coins-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ADMIN_API_KEY = "e2e-owner-key-of-this-local-run"; // the engine script's own, for this local run only
const MODEL_KEY = "sk-ant-e2e-stand-in-a-key-to-nothing"; // the engine script's stand-in takes this, and nothing real
const args = process.argv.slice(2);
mkdirSync(WORK, { recursive: true });
const keysFile = join(WORK, "coins-keys.json");
const fresh = !args.includes("--stop");
type Keys = { maker: Hex; stranger: Hex; b1: Hex; b2: Hex; b3: Hex; self: Hex; maker2: Hex };
const KEYS: Keys = fresh ? { maker: generatePrivateKey(), stranger: generatePrivateKey(), b1: generatePrivateKey(), b2: generatePrivateKey(), b3: generatePrivateKey(), self: generatePrivateKey(), maker2: generatePrivateKey() } : ((() => { try { return JSON.parse(readFileSync(keysFile, "utf8")) as Keys; } catch { return {} as Keys; } })());
// written once the engine's script has made the working folder afresh (it clears it), so the keys outlive the run
const keepKeys = () => writeFileSync(keysFile, JSON.stringify(KEYS, null, 2), { mode: 0o600 });
const E2E_ENV = { E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK, E2E_FORK_URL: `http://127.0.0.1:${PORTS.source}`, E2E_COINS: "on", COMPUTE_DIRECT: "on", ENGINE_PULSE: "off", DESK_MIND: "off", ACTIVITY: "off", MATCH: "off" };

const step = (title: string) => console.log(`\n== ${title}`);
const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
const refused = async (p: Promise<unknown>): Promise<string> => { try { await p; return ""; } catch (e) { return e instanceof Refusal ? e.message : `NOT A REFUSAL: ${(e as Error).message}`; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T | null> => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } if (Date.now() - t0 > ms) { console.log(`  (gave up waiting for ${what})`); return null; } await sleep(1000); } };
const pidsOn = (port: number): number[] => spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.split("\n").map((s) => s.trim()).filter(Boolean).map(Number);
async function stopPort(port: number): Promise<void> {
  for (const pid of pidsOn(port)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  for (let i = 0; i < 60 && pidsOn(port).length; i++) await sleep(100);
  for (const pid of pidsOn(port)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}
const stopAll = async () => {
  await stopPort(PORTS.site);
  spawnSync("npm", ["run", "e2e", "--", "--stop"], { cwd: ENGINE, encoding: "utf8", env: { ...process.env, ...E2E_ENV } });
  await stopPort(PORTS.source);
};
const eth = (wei: bigint) => (Number(wei / 10n ** 12n) / 1e6).toString();

const CURVE = parseAbi(["function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)", "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)"]);
const TOKEN = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address, uint256) returns (bool)", "function totalSupply() view returns (uint256)"]);
const PONS = parseAbi(["function getLaunchedToken(address) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))"]);
const POT = parseAbi(["event Burned(uint256 indexed n, address indexed caller, uint256 ethIn, uint256 tokensBurned, bool viaCurve)", "function token() view returns (address)"]);
const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const S = agentCoinSplitterAbi as Abi;
const L = agentCoinLauncherAbi as Abi;

async function main(): Promise<void> {
  if (args.includes("--stop")) { await stopAll(); console.log("stopped"); return; }
  step("0  the copy's source, the fork, Factor, the coin launcher by its one command, the engine with AGENT_COINS=on, the site");
  await stopPort(PORTS.site);
  await stopPort(PORTS.source);
  const nodeLog = openSync(join(WORK, "source.log"), "a");
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["scripts/rehearsal-node.ts", "source", String(PORTS.source), LIVE_RPC], { cwd: ENGINE, stdio: ["ignore", nodeLog, nodeLog], detached: true }).unref();
  for (let i = 0; i < 60 && !pidsOn(PORTS.source).length; i++) await sleep(250);
  const bareRun = spawnSync("npm", ["run", "e2e", "--", "--bare"], { cwd: ENGINE, encoding: "utf8", timeout: 1_500_000, env: { ...process.env, ...E2E_ENV } });
  writeFileSync(join(WORK, "bare-run.log"), bareRun.stdout + bareRun.stderr);
  keepKeys();
  if (bareRun.status !== 0) throw new Error(`the engine's script failed:\n${(bareRun.stdout + bareRun.stderr).split("\n").slice(-30).join("\n")}`);
  for (const line of bareRun.stdout.split("\n").filter((l) => /coin launcher|ok |FAIL/.test(l))) console.log(line);
  const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8")) as { rpc: string; api: string; desk: Hex; burnPot: Hex; splitter: Hex; token: Hex; keys: Hex[]; launcher: Hex };
  const deployLog = readFileSync(join(WORK, "deploy-coins.log"), "utf8");
  console.log(deployLog.split("\n").filter((l) => /gas, |about \$|deployed at|launcher  |OK:/.test(l)).map((l) => `     ${l.trim()}`).join("\n"));
  const rpc = async (method: string, params: unknown[]) => (await (await fetch(bare.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: unknown };
  for (const a of ["0x0000F90827F1C53a10cb7A02335B175320002935", "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02"]) await rpc("anvil_setCode", [a, "0x"]);
  const siteLog = openSync(join(WORK, "site.log"), "a");
  spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORTS.site)], { cwd: WEB, stdio: ["ignore", siteLog, siteLog], detached: true, env: { ...process.env, FACTOR_ENGINE_URL: bare.api, FACTOR_SAMPLE: "", FACTOR_STATE_SHARE_MS: "0" } }).unref();
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${SITE}/api/v1/state`)).ok) break; } catch { /* starting */ } await sleep(500); }
  const where = { api: `${SITE}/api/v1`, rpcUrl: bare.rpc };
  const chainDef = defineChain({ id: 4663, name: "Robinhood Chain (local fork)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [bare.rpc] } } });
  const chain = createPublicClient({ chain: chainDef, transport: http(bare.rpc) });
  const fund = async (address: string, e: string) => { await rpc("anvil_setBalance", [address, `0x${parseEther(e).toString(16)}`]); };
  const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: chainDef, transport: http(bare.rpc) });
  const sendFrom = async (k: Hex, to: Hex, abi: Abi, functionName: string, a: unknown[], value = 0n) => {
    const hash = await wallet(k).writeContract({ address: to, abi, functionName, args: a, value } as never);
    const r = await chain.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 250 });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return r;
  };
  const get = async (path: string) => { const r = await fetch(`${SITE}${path}`); return { status: r.status, text: (await r.text()).replace(/<!-- -->/g, "") }; };
  const words = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").replace(/ ([,.])/g, "$1");
  const ADMIN = privateKeyToAccount(bare.keys[0]!).address.toLowerCase();
  const BOT = privateKeyToAccount(bare.keys[1]!).address.toLowerCase();
  const about = JSON.parse((await get("/api/v1/coins/about")).text) as { enabled: boolean; launcher: string; launchFeeWei: string };
  check("the site and the engine say coins are on, at the launcher the one command deployed", about.enabled && about.launcher?.toLowerCase() === bare.launcher.toLowerCase(), about.launcher);
  const wiring = await Promise.all(["burnPot", "gateway", "owner", "desk"].map((f) => chain.readContract({ address: bare.launcher, abi: L, functionName: f }) as Promise<string>));
  check("the launcher reads Factor from the chain: the burn pot, the gas wallet as the gateway, the admin as the owner, the desk", wiring[0].toLowerCase() === bare.burnPot.toLowerCase() && wiring[1].toLowerCase() === BOT && wiring[2].toLowerCase() === ADMIN && wiring[3].toLowerCase() === bare.desk.toLowerCase());
  for (const k of Object.values(KEYS)) await fund(privateKeyToAccount(k).address, "5");
  const MAKER = privateKeyToAccount(KEYS.maker).address.toLowerCase();

  step("1  a maker makes an agent on the site, and Factor puts it on the desk");
  const instructions = "Read the tide times in the brief and write the week's high and low tides as a short plain table, then one line on the best time to walk the beach.";
  const at = Math.floor(Date.parse(JSON.parse((await get("/api/v1/state")).text).asOf) / 1000);
  const made = { owner: MAKER, name: "tide-scribe", does: "Writes the week's tides as a short plain table", priceEth: "0.003", payout: MAKER, instructions, at };
  const signature = await privateKeyToAccount(KEYS.maker).signMessage({ message: hostedMessage(MAKER, made.name, made.does, made.priceEth, MAKER, keccak256(toHex(instructions)), at) });
  const m = await fetch(`${SITE}/api/v1/agents/make`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...made, signature }) });
  check("the maker's signed agent is taken", m.ok, await m.text());
  const maker = await Factor.connect({ ...where, privateKey: KEYS.maker });
  const tidePage = await until("tide-scribe on the desk", async () => (await maker.agent("tide-scribe")) ?? null, 400_000);
  const TIDE = tidePage?.agent.address ?? "";
  check("tide-scribe is on the desk, made on the site and run by Factor", !!tidePage && (tidePage.agent as { hosted?: boolean }).hosted === true, TIDE);

  step("2  the maker launches tide-scribe's coin, with Factor's permission for the agent and a first buy");
  const launched = await maker.launchCoin({ agent: "tide-scribe", symbol: "TIDE", firstBuy: "0.02" });
  const coin = (launched.coin ?? "") as Hex;
  check("launched in one transaction from the maker's wallet", /^0x[0-9a-f]{40}$/.test(coin), launched.explorer);
  const info = await chain.readContract({ address: FACTORY, abi: PONS, functionName: "getLaunchedToken", args: [coin] });
  const splitter = (await chain.readContract({ address: bare.launcher, abi: L, functionName: "splitterOf", args: [TIDE] })) as Hex;
  check("Pons has it as the launcher forced it: launched by the launcher, fees to its own splitter, 3% tax, no buyback, paired with ETH", info.exists && info.deployer.toLowerCase() === bare.launcher.toLowerCase() && info.creatorFeeRecipient.toLowerCase() === splitter.toLowerCase() && info.creatorTaxBps === 300 && !info.buybackEnabled && /^0x0{40}$/.test(info.pairToken));
  const [sMaker, sAgent, sOwner, sGateway] = await Promise.all(["maker", "agent", "owner", "gateway"].map((f) => chain.readContract({ address: splitter, abi: S, functionName: f }) as Promise<string>));
  check("the splitter pays tide-scribe's compute at the gateway, its maker, and the owner", sMaker.toLowerCase() === MAKER && sAgent.toLowerCase() === TIDE && sOwner.toLowerCase() === ADMIN && sGateway.toLowerCase() === BOT);
  const firstBuy = (await chain.readContract({ address: coin, abi: TOKEN, functionName: "balanceOf", args: [MAKER as Hex] })) as bigint;
  check("the first buy is the maker's, and the launcher keeps nothing", firstBuy > 0n && (await chain.getBalance({ address: bare.launcher })) === 0n, `${eth(firstBuy)} tokens`);
  const listed = await until("the coin on the site", async () => { const c = JSON.parse((await get("/api/v1/coins/tide-scribe")).text) as { symbol?: string; name?: string; maker?: string }; return c.symbol === "TIDE" ? c : null; }, 60_000);
  check("the engine reads it and the site shows it: Tide Scribe, $TIDE, by its maker", listed?.name === "Tide Scribe" && listed?.maker === MAKER);
  const coinPage = words((await get("/coins/tide-scribe")).text);
  check("the coin's page names the agent, what the fees pay for and the own-risk line, and no share", coinPage.includes("The coin of tide-scribe") && coinPage.includes("its compute, its maker, the $FACTOR burn and Factor") && coinPage.includes("at your own risk") && !/\b(40|20)\s?%/.test(coinPage));
  check("the agent's page and the lists carry its ticker", words((await get("/agents/tide-scribe")).text).includes("$TIDE") && words((await get("/agents")).text).includes("$TIDE") && words((await get("/coins")).text).includes("Tide Scribe"));

  step("3  Factor's admin, the maker of Factor's own agents, launches page-smith's coin");
  const owner = await Factor.connect({ ...where, privateKey: bare.keys[0]! });
  const smith = await owner.launchCoin({ agent: "page-smith", symbol: "SMITH" });
  check("page-smith, a house agent, has its coin, launched by its maker with Factor's permission", !!smith.coin && !!(await until("SMITH on the site", async () => (JSON.parse((await get("/api/v1/coins/page-smith")).text) as { symbol?: string }).symbol === "SMITH", 60_000)));

  step("4  a stranger, a copied permission, and a second coin");
  const stranger = await Factor.connect({ ...where, privateKey: KEYS.stranger });
  check("a stranger cannot ask for the permission of an agent it did not make", /only the agent's maker/i.test(await refused(stranger.launchCoin({ agent: "plain-reader" }))));
  const plain = (await stranger.agent("plain-reader"))!.agent.address as Hex;
  const params = { name: "Plain Reader", symbol: "PLAIN", logo: "x", description: "y", socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" }, creatorFeeRecipient: privateKeyToAccount(KEYS.stranger).address, creatorTaxBps: 0, buybackEnabled: false, expectedEconomics: `0x${"0".repeat(64)}` as Hex, salt: `0x${"1".repeat(64)}` as Hex };
  const direct = await chain.simulateContract({ address: bare.launcher, abi: L, functionName: "launch", args: [plain, privateKeyToAccount(KEYS.stranger).address, params, 0n, 99999999999n, "0x"], account: privateKeyToAccount(KEYS.stranger), value: BigInt(about.launchFeeWei) }).then(() => "went through", (e: Error) => e.message);
  check("nor launch one at the launcher itself, without the agent's permission", /BadSignature|NotAllowed/.test(direct), direct.split("\n")[0]);
  // the permission Factor signs is for the maker who asked: sent by anybody else it is refused on the chain
  const forMaker = await fetch(`${SITE}/api/v1/coins/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: plain }) });
  check("Factor signs nothing without the maker's own signature", !forMaker.ok);
  check("a second coin for tide-scribe is refused", /has its coin already/.test(await refused(maker.launchCoin({ agent: "tide-scribe", symbol: "TIDE" }))));
  // even with a fresh permission the agent's own key signed (Factor holds it, made from the gas wallet's key, which is
  // anvil's public second test key on this fork), the launcher itself refuses a second coin
  const tideKey = houseSigner(takeHouseSeed({ BOT_PRIVATE_KEY: bare.keys[1]! })!, "hosted 1");
  const nonce = (await chain.readContract({ address: bare.launcher, abi: L, functionName: "nonces", args: [TIDE] })) as bigint;
  const second = { ...params, name: "Tide Scribe", symbol: "TIDE2", logo: "x", description: "y" };
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 365 * 86_400);
  const fresh2 = await tideKey.signTyped!(permissionTypedData({ chainId: 4663, launcher: bare.launcher, agent: TIDE, maker: MAKER, name: second.name, symbol: second.symbol, logo: second.logo, description: second.description, nonce, deadline }));
  const again = await chain.simulateContract({ address: bare.launcher, abi: L, functionName: "launch", args: [TIDE, MAKER, second, 0n, deadline, fresh2], account: privateKeyToAccount(KEYS.maker), value: BigInt(about.launchFeeWei) }).then(() => "went through", (e: Error) => e.message);
  check("and the launcher itself refuses it, even with a fresh permission from the agent's own key", /AlreadyLaunched/.test(again), again.split("\n").find((l) => /AlreadyLaunched|revert/i.test(l)) ?? again.split("\n")[0]);

  step("5  other wallets buy and sell $TIDE");
  await rpc("evm_increaseTime", [30]);
  await rpc("evm_mine", []);
  for (const [k, e] of [[KEYS.b1, "0.4"], [KEYS.b2, "0.6"], [KEYS.b3, "0.25"]] as const) await sendFrom(k, info.curve, CURVE as Abi, "buy", [parseEther(e), 0n, privateKeyToAccount(k).address], parseEther(e));
  const held = (await chain.readContract({ address: coin, abi: TOKEN, functionName: "balanceOf", args: [privateKeyToAccount(KEYS.b2).address] })) as bigint;
  await sendFrom(KEYS.b2, coin, TOKEN as Abi, "approve", [info.curve, held]);
  await sendFrom(KEYS.b2, info.curve, CURVE as Abi, "sell", [held / 2n, 0n, privateKeyToAccount(KEYS.b2).address]);
  const traded = await until("the trades on the coin's page", async () => { const c = JSON.parse((await get("/api/v1/coins/tide-scribe")).text) as { trades: number; holders: number; volumeEth: number }; return c.trades >= 5 ? c : null; }, 60_000);
  check("the engine reads the buys and the sell, and who holds it", (traded?.holders ?? 0) >= 4, traded ? `${traded.trades} trades, ${traded.volumeEth} ETH, ${traded.holders} holders` : "");

  step("6  a stranger sweeps it: every share arrives to the wei");
  // the keeper waits a few seconds between looks: the stranger goes first
  const r = await sendFrom(KEYS.stranger, splitter, S, "sweep", []);
  const split = r.logs.map((l) => { try { return decodeEventLog({ abi: S, data: l.data, topics: l.topics as [Hex, ...Hex[]] }); } catch { return null; } }).find((d) => d?.eventName === "Split")?.args as unknown as { amount: bigint; toCompute: bigint; toMaker: bigint; toBurn: bigint; toOwner: bigint } | undefined;
  const at6 = r.blockNumber;
  const delta = async (a: string) => (await chain.getBalance({ address: a as Hex, blockNumber: at6 })) - (await chain.getBalance({ address: a as Hex, blockNumber: at6 - 1n }));
  // what the gas wallet itself paid in that block, if it sent anything there, is not the share's fault
  const block = await chain.getBlock({ blockNumber: at6, includeTransactions: true });
  let botGas = 0n;
  for (const tx of block.transactions) if (typeof tx !== "string" && tx.from.toLowerCase() === BOT) { const rc = await chain.getTransactionReceipt({ hash: tx.hash }); botGas += rc.gasUsed * rc.effectiveGasPrice; }
  const [dGate, dMaker, dPot, dOwner] = await Promise.all([delta(BOT), delta(MAKER), delta(bare.burnPot), delta(ADMIN)]);
  const amount = split?.amount ?? 0n;
  check("the sweep collected the coin's fees from the curve", amount > 0n, `${eth(amount)} ETH`);
  check("the agent's compute share reached the gateway, to the wei", !!split && dGate + botGas === split.toCompute && split.toCompute === (amount * 4000n) / 10_000n, split ? `${split.toCompute} wei` : "");
  check("the maker's share reached the maker, to the wei", !!split && dMaker === split.toMaker && split.toMaker === (amount * 2000n) / 10_000n);
  check("the owner's share reached the owner, to the wei", !!split && dOwner === split.toOwner && split.toOwner === (amount * 2000n) / 10_000n);
  check("the burn share, with the rounding dust, reached $FACTOR's burn pot, to the wei", !!split && dPot === split.toBurn && split.toCompute + split.toMaker + split.toBurn + split.toOwner === amount);
  check("nothing stayed in the splitter", (await chain.getBalance({ address: splitter, blockNumber: at6 })) === 0n);

  step("7  the keeper sweeps by itself once the fees are worth the gas");
  const before7 = (await (await fetch(`${bare.api}/v1/health`)).json()) as { actions: { coin_sweep: { done: number } } };
  await sendFrom(KEYS.b3, info.curve, CURVE as Abi, "buy", [parseEther("0.5"), 0n, privateKeyToAccount(KEYS.b3).address], parseEther("0.5"));
  const swept = await until("the keeper's sweep", async () => { const h = (await (await fetch(`${bare.api}/v1/health`)).json()) as { actions: { coin_sweep: { done: number; last: { tx: string } | null } } }; return h.actions.coin_sweep.done > before7.actions.coin_sweep.done ? h.actions.coin_sweep.last : null; }, 120_000);
  const keeperTx = swept?.tx ? await chain.getTransaction({ hash: swept.tx as Hex }) : null;
  check("the gas wallet swept $TIDE's splitter", keeperTx?.from.toLowerCase() === BOT && keeperTx?.to?.toLowerCase() === splitter.toLowerCase(), swept?.tx);
  const sweeps = await until("two sweeps on the coin's page", async () => { const c = JSON.parse((await get("/api/v1/coins/tide-scribe")).text) as { sweeps?: unknown[] }; return (c.sweeps?.length ?? 0) >= 2 ? c : null; }, 60_000);
  check("the coin's page lists both sweeps", !!sweeps);

  step("8  the burn pot buys $FACTOR and burns it: the supply falls by exactly what was burned");
  await rpc("evm_increaseTime", [31 * 60]);
  await rpc("evm_mine", []);
  const burnsBefore = ((await (await fetch(`${bare.api}/v1/health`)).json()) as { actions: { burn: { done: number } } }).actions.burn.done;
  const burnAction = await until("the engine's burn", async () => { const h = (await (await fetch(`${bare.api}/v1/health`)).json()) as { actions: { burn: { done: number; last: { tx: string } | null } } }; return h.actions.burn.done > burnsBefore ? h.actions.burn.last : null; }, 180_000);
  const burnRc = burnAction?.tx ? await chain.getTransactionReceipt({ hash: burnAction.tx as Hex }) : null;
  const burned = burnRc?.logs.map((l) => { try { return decodeEventLog({ abi: POT, data: l.data, topics: l.topics as [Hex, ...Hex[]] }); } catch { return null; } }).find((d) => d?.eventName === "Burned")?.args as unknown as { ethIn: bigint; tokensBurned: bigint } | undefined;
  if (burnRc && burned) {
    const factor = (await chain.readContract({ address: bare.burnPot, abi: POT, functionName: "token" })) as Hex;
    const s0 = (await chain.readContract({ address: factor, abi: TOKEN, functionName: "totalSupply", blockNumber: burnRc.blockNumber - 1n })) as bigint;
    const s1 = (await chain.readContract({ address: factor, abi: TOKEN, functionName: "totalSupply", blockNumber: burnRc.blockNumber })) as bigint;
    check("$FACTOR's supply fell by exactly the tokens burned", s0 - s1 === burned.tokensBurned && burned.tokensBurned > 0n, `${eth(burned.ethIn)} ETH bought ${eth(burned.tokensBurned)} $FACTOR`);
  } else check("$FACTOR's supply fell by exactly the tokens burned", false, "no burn was found");

  step("9  tide-scribe's compute credit rose by what its coin paid, and it runs a paid model call with it");
  const credit = (await (await fetch(`${bare.api}/v1/compute/credit/${TIDE}`)).json()) as { balanceUsd: number; lots: { paidBy?: string; usd: number | null; state: string }[] };
  const coinLots = credit.lots.filter((l) => l.paidBy === "coin");
  check("its credit holds lots paid by its coin, its own from the start", coinLots.length >= 2 && coinLots.every((l) => l.state === "kept") && credit.balanceUsd > 0, `$${credit.balanceUsd.toFixed(2)} in ${coinLots.length} lots`);
  const kAt = Math.floor(Date.parse(JSON.parse((await get("/api/v1/state")).text).asOf) / 1000);
  const kSig = await tideKey.signMessage!(keyMessage(TIDE, kAt));
  const minted = (await (await fetch(`${bare.api}/v1/compute/key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: TIDE, at: kAt, signature: kSig }) })).json()) as { key?: string; error?: unknown };
  check("its account signs for a compute key", typeof minted.key === "string", JSON.stringify(minted.error ?? ""));
  const call = await fetch(`${bare.api}/v1/compute/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": minted.key ?? "", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 60, messages: [{ role: "user", content: "High tide 06:12 and 18:40, low tide 12:25. One line." }] }) });
  const answer = (await call.json()) as { content?: { text: string }[] };
  const after = (await (await fetch(`${bare.api}/v1/compute/credit/${TIDE}`)).json()) as { balanceUsd: number };
  check("the call is answered, and its cost came off the credit its coin paid", call.status === 200 && !!answer.content?.[0]?.text && after.balanceUsd < credit.balanceUsd, `$${credit.balanceUsd.toFixed(6)} to $${after.balanceUsd.toFixed(6)}`);
  const page9 = JSON.parse((await get("/api/v1/coins/tide-scribe")).text) as { paidFor: { computeUsd: number; computeUsedUsd: number } };
  check("the coin's page says what its fees paid into compute, and what the agent spent of it", page9.paidFor.computeUsd > 0 && page9.paidFor.computeUsedUsd > 0, `$${page9.paidFor.computeUsd.toFixed(2)} paid, $${page9.paidFor.computeUsedUsd.toFixed(6)} spent`);

  step("10  an agent with a wallet of its own signs a permission for its maker, who launches with it");
  const self = await Factor.connect({ ...where, privateKey: KEYS.self });
  await self.signUp({ name: "quay-reader", does: "Reads harbour notices and says what changed this week" });
  await until("quay-reader on the desk", async () => (await self.agent("quay-reader"))?.agent.named, 60_000);
  const MAKER2 = privateKeyToAccount(KEYS.maker2).address.toLowerCase();
  const permission = await self.signCoinPermission({ maker: MAKER2, symbol: "QUAY" });
  check("its own wallet signed it: a signature, no gas", permission.maker === MAKER2 && permission.symbol === "QUAY");
  check("a stranger cannot use it", /permission is for another agent or another maker/.test(await refused(stranger.launchCoin({ agent: "quay-reader", permission }))));
  const maker2 = await Factor.connect({ ...where, privateKey: KEYS.maker2 });
  const quay = await maker2.launchCoin({ agent: "quay-reader", permission, firstBuy: "0.005" });
  check("its maker launches $QUAY with it", !!quay.coin);
  check("used once: the same permission does nothing again", /has its coin already|permission is not for this launch/.test(await refused(maker2.launchCoin({ agent: "quay-reader", permission }))));

  step("11  the owner's coins switch");
  const flip = (on: boolean) => fetch(`${bare.api}/v1/admin/switch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": ADMIN_API_KEY }, body: JSON.stringify({ what: "coins", on, ...(on ? {} : { note: "a look at the coins" }) }) });
  check("switched off, every coin is hidden at once", (await flip(false)).ok && (JSON.parse((await get("/api/v1/coins")).text) as { items: unknown[] }).items.length === 0 && !words((await get("/agents")).text).includes("$TIDE"));
  check("and Factor signs no permission meanwhile", /not switched on/.test(await refused(owner.launchCoin({ agent: "plain-reader" }))));
  check("turned back on, they return", (await flip(true)).ok && (JSON.parse((await get("/api/v1/coins")).text) as { items: unknown[] }).items.length === 3);

  step("12  the assistant's tools say it in words");
  const said = (await runTool(stranger, "factor_coin", { id: "tide-scribe" }, null)).text;
  check("factor_coin says what the coin's fees paid for, and its own risk", said.includes("$TIDE (Tide Scribe): the coin of tide-scribe") && said.includes("into the agent's compute credit") && said.includes("at your own risk"), said.split("\n")[1]);
  const list = (await runTool(stranger, "factor_coins", {}, null)).text;
  check("factor_coins lists all three", ["$TIDE", "$SMITH", "$QUAY"].every((t) => list.includes(t)));
  void encodeFunctionData;

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  writeFileSync(join(WORK, "coins-result.json"), JSON.stringify({ site: SITE, api: bare.api, rpc: bare.rpc, launcher: bare.launcher, tide: { agent: TIDE, coin, splitter, curve: info.curve }, checks }, null, 2));
  if (args.includes("--stay")) {
    console.log(`Left running: the site on ${SITE}, the engine on ${bare.api}, the fork on ${bare.rpc}. Keys in ${keysFile}.`);
  } else await stopAll();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  if (!args.includes("--stay")) await stopAll();
  process.exit(1);
});
