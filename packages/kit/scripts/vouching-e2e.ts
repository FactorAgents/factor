// Vouching, end to end, on a LOCAL fork of Robinhood Chain: the fork (read through the rehearsal's own go-between,
// engine/scripts/rehearsal-node.ts) with the LIVE desk, line contract and guarantee contract as they are on the real
// chain, the vouching contract deployed there by its one-command script (contracts/deploy-vouch.sh, the one the owner or
// the demo wallet runs), the branch engine with VOUCHING=on sending its keeper's calls to the fork only, and the branch
// site in front of it, all on 127.0.0.1. Nothing here reaches the real chain, and no model is called.
//
//   npm run vouching-e2e            every check, then everything is stopped
//   npm run vouching-e2e -- --stay  everything is left running (the site on 3870) for pictures
//   npm run vouching-e2e -- --stop  stops what --stay left running
//
// E2E_ENGINE_DATA: an engine database to start from (a copy is made), so the engine does not read the desk from its
// first block; without it the engine reads everything, which takes some minutes.
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  vouching is on at the contract the one command deployed, wired to the live guarantee contract, line and desk
//   2  a voucher without a strong score is refused in words; it earns 300 with real jobs on the live desk
//   3  what nobody can do: vouch for itself, more than a quarter of its bond on one agent, accept for another agent
//   4  a vouch on a newer agent's credit line: offered, accepted with its fee, shown on its page and the Vouching page;
//      the agent draws and repays; after the 30 days the keeper settles it by itself: kept, the voucher paid its half
//   5  a vouch on another newer agent's line, which draws and never repays: 60 days on, the keeper recovers the line on
//      the live line contract and the vouch pays the rest, before the line pool loses anything
//   6  a vouch on a cover report-lead sold on the live guarantee contract, on a job never delivered: the keeper closes the
//      cover and settles the vouch, and the customer is paid the vouched amount on top of the refund and the cover
//   7  more refusals: settling twice, a stranger withdrawing an offer early; an offer nobody accepts is withdrawn by the
//      keeper after its seven days
//   8  the owner's vouching switch hides it at once, and turned back, it returns
//   9  the assistant's tools say it in words
//
// Keys: made up here for this run and funded on the fork only; the engine's gas wallet and the deployer are anvil's
// public test accounts; report-lead is impersonated on the fork, its key is never used.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { factorDeskAbi } from "../src/abi/FactorDesk.js";
import { factorGuaranteeAbi } from "../src/abi/FactorGuarantee.js";
import { factorLineAbi } from "../src/abi/FactorLine.js";
import { factorLineAccountAbi } from "../src/abi/FactorLineAccount.js";
import { factorVouchAbi } from "../src/abi/FactorVouch.js";
import { Factor, Refusal } from "../src/index.js";
import { runTool } from "../src/tools.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WEB = join(KIT, "..", "..", "web");
const CONTRACTS = join(KIT, "..", "..", "contracts");
const PORTS = { site: 3870, anvil: 3871, engine: 3872, source: 3874 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-vouching-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const RPC = `http://127.0.0.1:${PORTS.anvil}`;
const API = `http://127.0.0.1:${PORTS.engine}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ADMIN_API_KEY = "e2e-owner-key-of-this-local-vouching-run";
// anvil's own public test accounts: worth nothing anywhere, unlocked on the fork
const ANVIL_DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ANVIL_GAS_KEY = "0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d";
const LIVE = {
  desk: "0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F" as Hex, burnPot: "0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79" as Hex, splitter: "0x92AC9caF6B4Cf8e126aFe16e11AF78B5CB2b9dD0",
  token: "0x47C5eA4d85C4c1A81F26124580A80B0b7A581CC0", admin: "0xafA96B2F796968dA543B77E9d1a04f80321acD04", accounts: "0x3417A303DcB62A84965a641f894ff5803502F8FA",
  line: "0xc9405ca62eD1e9a4a058F404e5c1C893F7ae67c4" as Hex, guarantee: "0x577A00Ad9B0a719C4465A3a887F969B0E377daEF" as Hex,
  reportLead: "0x74325c9644973d9c7a293bdfc970a573a38419e1" as Hex,
};
// Factor's own agents on the live desk, as the live engine names them
const HOUSE = "0x8c6f5f3e7e29c1cf794e9283cf7739efb15adb02,0xbdb841d1226010e13851b5d47e701c58b6c9c8b4,0x45befda551f3ad294ab70817c8c46b0498de8b69,0x5b1bbe8202d195fa978efca9b357f926c7a738a9,0x4ad8f433129830a7b35b555141484ebcaa914e85,0x4bd6f2a74bac8a2f24627e4ac9595d80aa855791,0x18539a60ed3cdef7268402befff16620cad99f60,0x98c9e47569668ac467e0285e4a1bc90872ef2514,0xfaa7746c34461c7b06e05dfb4ef42ca6831b939a,0x54394632d38efdfd25d36aaa0a75c0a9167af2ca,0x02f8a4ef90b25e596c237aef2ddc310bb55e625f,0x92a5959aba668b3cd7c9a948c33fe0bb20c21325,0xac06c75f6e071f3091864a144ace9666d479df22,0x39f337fd4a3625ebb1ff40a7008585315211ac00,0x2e6f53387bcd3f2cbb623e55adf8bd6cfb7f6ecf";
const args = process.argv.slice(2);
mkdirSync(WORK, { recursive: true });
const keysFile = join(WORK, "vouching-keys.json");
type Keys = { voucher: Hex; customer: Hex; newer: Hex; second: Hex; stranger: Hex };
const fresh = !args.includes("--stop");
const KEYS: Keys = fresh ? { voucher: generatePrivateKey(), customer: generatePrivateKey(), newer: generatePrivateKey(), second: generatePrivateKey(), stranger: generatePrivateKey() } : ({} as Keys);

const step = (title: string) => console.log(`\n== ${title}`);
const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
const refused = async (p: Promise<unknown>): Promise<string> => { try { await p; return ""; } catch (e) { return e instanceof Refusal ? e.message : `NOT A REFUSAL: ${(e as Error).message}`; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 180_000): Promise<T | null> => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } if (Date.now() - t0 > ms) { console.log(`  (gave up waiting for ${what})`); return null; } await sleep(1000); } };
const pidsOn = (port: number): number[] => spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.split("\n").map((s) => s.trim()).filter(Boolean).map(Number);
async function stopPort(port: number): Promise<void> {
  for (const pid of pidsOn(port)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  for (let i = 0; i < 60 && pidsOn(port).length; i++) await sleep(100);
  for (const pid of pidsOn(port)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}
const stopAll = async () => { for (const p of [PORTS.site, PORTS.engine, PORTS.anvil, PORTS.source]) await stopPort(p); };
const V = factorVouchAbi as Abi, D = factorDeskAbi as Abi, L = factorLineAbi as Abi, LA = factorLineAccountAbi as Abi, G = factorGuaranteeAbi as Abi;
const DAY = 86_400;

async function main(): Promise<void> {
  if (args.includes("--stop")) { await stopAll(); console.log("stopped"); return; }
  writeFileSync(keysFile, JSON.stringify(KEYS, null, 2), { mode: 0o600 });
  step("0  the copy's source, the fork of the live chain, the vouching contract by its one command, the engine with VOUCHING=on, the site");
  await stopAll();
  const log = (name: string) => openSync(join(WORK, name), "a");
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["scripts/rehearsal-node.ts", "source", String(PORTS.source), LIVE_RPC], { cwd: ENGINE, stdio: ["ignore", log("source.log"), log("source.log")], detached: true }).unref();
  for (let i = 0; i < 60 && !pidsOn(PORTS.source).length; i++) await sleep(250);
  const anvil = join(process.env.HOME ?? "", ".foundry", "bin", "anvil");
  spawn("nice", ["-n", "10", anvil, "--fork-url", `http://127.0.0.1:${PORTS.source}`, "--port", String(PORTS.anvil), "--chain-id", "4663", "--block-base-fee-per-gas", "0", "--timeout", "30000", "--retries", "12", "--silent"], { stdio: ["ignore", log("anvil.log"), log("anvil.log")], detached: true }).unref();
  const chainDef = defineChain({ id: 4663, name: "Robinhood Chain (local fork)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const chain = createPublicClient({ chain: chainDef, transport: http(RPC, { timeout: 120_000 }) });
  await until("the fork", async () => (await chain.getChainId()) === 4663, 60_000);
  const rpc = async (method: string, params: unknown[]) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: unknown; error?: { message: string } };
  const fund = async (address: string, e: string) => { await rpc("anvil_setBalance", [address, `0x${parseEther(e).toString(16)}`]); };
  const warp = async (s: number) => { await rpc("evm_increaseTime", [s]); await rpc("evm_mine", []); };
  // the engine's clock is the fork's: while waiting on the keeper, the fork's time is moved on half a minute a second
  // the engine reads a block once 20 more are on top of it: while waiting on what it read, the fork mines a block a second
  const mined = <T>(what: string, fn: () => Promise<T | null | undefined | false>) => until(what, async () => { await rpc("anvil_mine", ["0x1"]); return fn(); });
  const keeper = <T>(what: string, fn: () => Promise<T | null | undefined | false>) => until(what, async () => { await warp(30); return fn(); });
  // a fork answers calls only once it has mined a block of its own (the copied head carries no blob gas)
  await rpc("anvil_mine", ["0x1"]);
  await fund(ANVIL_DEPLOYER, "10");
  await fund(privateKeyToAccount(ANVIL_GAS_KEY).address, "10");

  // the deploy, by the repo's one command, against the fork: its own unlocked wallet sends it
  mkdirSync(join(CONTRACTS, "broadcast"), { recursive: true });
  const forkEnv = join(CONTRACTS, "broadcast", "factor.fork.env");
  writeFileSync(forkEnv, `FACTOR_ADMIN=${LIVE.admin}\nFACTOR_GATEWAY=0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0\nFACTOR_BURN_POT=${LIVE.burnPot}\nFACTOR_DESK=${LIVE.desk}\nFACTOR_SPLITTER=${LIVE.splitter}\nFACTOR_ACCOUNTS=${LIVE.accounts}\nFACTOR_GUARANTEE=${LIVE.guarantee}\n`);
  const dep = spawnSync("zsh", [join(CONTRACTS, "deploy-vouch.sh"), ANVIL_DEPLOYER], { cwd: CONTRACTS, encoding: "utf8", timeout: 900_000, env: { ...process.env, FACTOR_RPC: RPC, PATH: `${join(process.env.HOME ?? "", ".foundry", "bin")}:${process.env.PATH}` } });
  writeFileSync(join(WORK, "deploy-vouch.log"), dep.stdout + dep.stderr);
  const written = readFileSync(forkEnv, "utf8");
  const vc = (/FACTOR_VOUCH=(0x[0-9a-fA-F]{40})/.exec(written)?.[1] ?? "") as Hex;
  const from = /FACTOR_VOUCH_BLOCK=(\d+)/.exec(written)?.[1] ?? "";
  check("the vouching contract is deployed by contracts/deploy-vouch.sh, which says what each call costs and reads it back wired", dep.status === 0 && !!vc && dep.stdout.includes("OK: the vouching contract is wired") && dep.stdout.includes("an offer on a credit line"), vc || (dep.stdout + dep.stderr).split("\n").slice(-8).join(" | "));
  if (!vc) throw new Error("the vouching contract was not deployed");
  console.log(dep.stdout.split("\n").filter((l) => /gas, |about \$|vouching  |OK:/.test(l)).map((l) => `     ${l.trim()}`).join("\n"));

  // the branch engine, live on the fork only, its gas wallet anvil's test account; and the branch site
  const dataDir = join(WORK, "engine-data");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  if (process.env.E2E_ENGINE_DATA && existsSync(join(process.env.E2E_ENGINE_DATA, "factor.db"))) cpSync(join(process.env.E2E_ENGINE_DATA, "factor.db"), join(dataDir, "factor.db"));
  const engineEnv = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ENGINE_MODE: "live", BOT_PRIVATE_KEY: ANVIL_GAS_KEY, PORT: String(PORTS.engine), FACTOR_DATA_DIR: dataDir, ENGINE_BACKUPS: "off", FACTOR_REHEARSAL_CLOCK: "chain",
    FACTOR_RPC_URLS: RPC, FACTOR_DESK: LIVE.desk, FACTOR_BURN_POT: LIVE.burnPot, FACTOR_SPLITTER: LIVE.splitter, FACTOR_TOKEN: LIVE.token, FACTOR_ADMIN: LIVE.admin, FACTOR_DEPLOY_BLOCK: "88409629", FACTOR_ACCOUNTS: LIVE.accounts,
    LINES: "on", FACTOR_LINE: LIVE.line, FACTOR_LINE_BLOCK: "100000000", GUARANTEES: "on", FACTOR_GUARANTEE: LIVE.guarantee, FACTOR_GUARANTEE_BLOCK: "103418591",
    VOUCHING: "on", FACTOR_VOUCH: vc, FACTOR_VOUCH_BLOCK: from, ENGINE_ADMIN_KEY: ADMIN_API_KEY, FACTOR_HOUSE_AGENTS: HOUSE,
    ACTIVITY: "off", DESK_MIND: "off", MATCH: "off", ENGINE_PULSE: "off", HOUSE_MODE: "off", DEMO_MODE: "off", HOSTED_MODE: "off", ACCOUNTS_MODE: "off", COMPUTE_MODE: "off", FACTOR_SITE_URL: SITE,
  };
  spawn("nice", ["-n", "10", join(ENGINE, "node_modules", ".bin", "tsx"), "src/main.ts"], { cwd: ENGINE, stdio: ["ignore", log("engine.log"), log("engine.log")], detached: true, env: engineEnv }).unref();
  const ready = await until("the engine to read the chain", async () => { const r = await fetch(`${API}/v1/vouches/about`); return r.ok && ((await r.json()) as { enabled: boolean }).enabled; }, 1_500_000);
  check("the engine reads the fork with VOUCHING=on", ready);
  spawn("nice", ["-n", "10", process.execPath, "node_modules/next/dist/bin/next", "start", "-p", String(PORTS.site)], { cwd: WEB, stdio: ["ignore", log("site.log"), log("site.log")], detached: true, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FACTOR_ENGINE_URL: API, FACTOR_SITE_URL: SITE, FACTOR_SAMPLE: "", FACTOR_STATE_SHARE_MS: "0" } }).unref();
  await until("the site", async () => (await fetch(`${SITE}/api/v1/state`)).ok, 120_000);

  const where = { api: `${SITE}/api/v1`, rpcUrl: RPC };
  const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: chainDef, transport: http(RPC, { timeout: 120_000 }) });
  const sendFrom = async (k: Hex | Hex[], to: Hex, abi: Abi, functionName: string, a: unknown[], value = 0n) => {
    const w = Array.isArray(k) ? createWalletClient({ account: k[0]!, chain: chainDef, transport: http(RPC) }) : wallet(k);
    const hash = await w.writeContract({ address: to, abi, functionName, args: a, value, chain: chainDef } as never);
    const r = await chain.waitForTransactionReceipt({ hash, timeout: 300_000, pollingInterval: 250 });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return r;
  };
  const read = <T>(to: Hex, abi: Abi, functionName: string, a: unknown[] = []) => chain.readContract({ address: to, abi, functionName, args: a } as never) as Promise<T>;
  const get = async (path: string) => { const r = await fetch(`${SITE}${path}`); return { status: r.status, text: (await r.text()).replace(/<!-- -->/g, "") }; };
  const words = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
  for (const k of Object.values(KEYS)) await fund(privateKeyToAccount(k).address, "20");
  const me = (k: Hex) => privateKeyToAccount(k).address.toLowerCase() as Hex;
  const VOUCHER = me(KEYS.voucher), CUSTOMER = me(KEYS.customer), NEWER = me(KEYS.newer), SECOND = me(KEYS.second);
  const voucher = await Factor.connect({ ...where, privateKey: KEYS.voucher });
  const newer = await Factor.connect({ ...where, privateKey: KEYS.newer });
  const second = await Factor.connect({ ...where, privateKey: KEYS.second });
  const stranger = await Factor.connect({ ...where, privateKey: KEYS.stranger });
  const anybody = await Factor.connect(where);

  step("1  vouching is on, wired to the live contracts");
  const about = await anybody.vouching();
  check("the site says vouching is on at the deployed contract, with the contract's rules", about.enabled && about.contract?.toLowerCase() === vc.toLowerCase() && about.rules.minScore === 300 && about.rules.maxSharePct === 25 && about.rules.feePct === 2);
  check("it reads the live guarantee contract, and through it the live line contract and desk", (await read<string>(vc, V, "guarantee")).toLowerCase() === LIVE.guarantee.toLowerCase() && (await read<string>(vc, V, "line")).toLowerCase() === LIVE.line.toLowerCase() && (await read<string>(vc, V, "desk")).toLowerCase() === LIVE.desk.toLowerCase());

  step("2  a voucher earns its score on the live desk");
  for (const k of [KEYS.voucher, KEYS.newer, KEYS.second]) await sendFrom(k, LIVE.desk, D, "register", []);
  await sendFrom(KEYS.newer, LIVE.line, L, "open", []);
  await sendFrom(KEYS.second, LIVE.line, L, "open", []);
  const NEWER_LINE = (await read<string>(LIVE.line, L, "accountOf", [NEWER])).toLowerCase() as Hex;
  const SECOND_LINE = (await read<string>(LIVE.line, L, "accountOf", [SECOND])).toLowerCase() as Hex;
  // the live line pool is small: seeded on the fork, as anyone can seed it
  await chain.waitForTransactionReceipt({ hash: await wallet(KEYS.customer).sendTransaction({ to: LIVE.line, value: parseEther("1"), chain: chainDef }), timeout: 300_000, pollingInterval: 250 });
  const bonded = await voucher.addVouchBond("0.04");
  check("the voucher bonds 0.04 ETH from the kit", bonded.bondEth === "0.04", `${bonded.bondEth} ETH`);
  const weak = await refused(voucher.vouchForLine(NEWER, "0.01"));
  check("without a strong score its offer is refused in words", /A voucher needs a score of 300 or more; this one has 0\./.test(weak), weak);
  const job = async (agent: Hex, deliverer: Hex, price: string, viaAccount = false) => {
    const now = Number((await chain.getBlock()).timestamp);
    const r = await sendFrom(KEYS.customer, LIVE.desk, D, "lock", [agent, BigInt(now + DAY), false], parseEther(price));
    const id = BigInt(r.logs.find((l) => l.address.toLowerCase() === LIVE.desk.toLowerCase())!.topics[1]!);
    if (viaAccount) await sendFrom(deliverer, agent, LA, "deliver", [id, `0x${"ab".repeat(32)}`]);
    else await sendFrom(deliverer, LIVE.desk, D, "deliver", [id, `0x${"ab".repeat(32)}`]);
    await sendFrom(KEYS.customer, LIVE.desk, D, "accept", [id]);
    return id;
  };
  for (let i = 0; i < 21; i++) await job(VOUCHER, KEYS.voucher, i === 20 ? "0.05" : "0.001");
  await warp(50 * DAY);
  const score = Number(await read<bigint>(vc, V, "scoreOf", [VOUCHER]));
  check("twenty-one jobs and fifty days give it a score of 300 or more, read through the live guarantee contract", score >= 300, `score ${score}`);

  step("3  what nobody can do");
  await newer.addVouchBond("0.01");
  check("an agent cannot vouch for its own credit line (its key and its line account are one)", /cannot vouch for itself/.test(await refused(newer.vouchForLine(NEWER, "0.001"))));
  const over = await refused(voucher.vouchForLine(NEWER, "0.0101"));
  check("a voucher cannot hold more than a quarter of its bond for one agent", /can hold back 0\.01 ETH more for that agent/.test(over), over);
  const offer1 = await voucher.vouchForLine(NEWER, "0.01");
  check("an offer of 0.01 ETH on the newer agent's line, held back from the bond", offer1.state === "offered" && offer1.freeEth === "0.03", `vouch ${offer1.vouch}, ${offer1.freeEth} ETH free`);
  check("nobody but the agent accepts it", /Only the vouched agent's own wallet/.test(await refused(stranger.acceptVouch(offer1.vouch!))));
  check("a stranger cannot withdraw it before its seven days", /^Not before /.test(await refused(stranger.withdrawVouchOffer(offer1.vouch!))));

  step("4  a line vouch kept: the voucher earns");
  const acc = await newer.acceptVouch(offer1.vouch!);
  check("the newer agent accepts it from the kit, paying 0.0002 ETH", acc.state === "active");
  const page1 = await mined("the agent's page to show the vouch", async () => { const p = words((await get(`/agents/${NEWER_LINE}`)).text); return /One vouch behind it/.test(p) && p; });
  check("its page says who vouched and for how much: one vouch behind it, 0.01 ETH", !!page1 && /One vouch behind it, 0\.01/.test(page1) && /0\.0100 ETH/.test(page1));
  check("the Vouching page lists the voucher", /Who stands behind whom/.test(words((await get("/vouching")).text)));
  await job(NEWER_LINE, KEYS.newer, "0.05", true);
  await sendFrom(KEYS.newer, LIVE.line, L, "draw", [parseEther("0.001"), false]);
  await sendFrom(KEYS.newer, LIVE.line, L, "repay", [NEWER_LINE], parseEther("0.001"));
  const before1 = (await read<{ bond: bigint }>(vc, V, "voucherOf", [VOUCHER])).bond;
  await warp(30 * DAY + 120);
  const kept = await keeper("the keeper to settle the line vouch", async () => { const v = await anybody.vouchOf(offer1.vouch!); return v?.state === "kept" && v; });
  check("after its 30 days the keeper settles it by itself: kept", !!kept);
  const after1 = (await read<{ bond: bigint }>(vc, V, "voucherOf", [VOUCHER])).bond;
  check("the voucher's bond grew by its half of the fee, 0.0001 ETH", after1 - before1 === parseEther("0.0001"), `${after1 - before1} wei`);
  check("the other half went to the live burn pot, which buys back and burns $FACTOR with it", kept && kept.burnedEth === 0.0001 && kept.toVoucherEth === 0.0001);

  step("5  a line vouch failed: the voucher's bond pays before the pool loses anything");
  const offer2 = await voucher.vouchForLine(SECOND, "0.01");
  await second.acceptVouch(offer2.vouch!);
  await job(SECOND_LINE, KEYS.second, "0.3", true);
  const payout = await chain.getBalance({ address: SECOND_LINE });
  await sendFrom(KEYS.second, SECOND_LINE, LA, "withdraw", [SECOND, payout]);
  await sendFrom(KEYS.second, LIVE.line, L, "draw", [parseEther("0.006"), false]);
  const lostBefore = await read<bigint>(LIVE.line, L, "lost");
  const voucherBefore = await read<{ bond: bigint; lostTotal: bigint }>(vc, V, "voucherOf", [VOUCHER]);
  await warp(60 * DAY + 120);
  const failed = await keeper("the keeper to settle the failed vouch", async () => { const v = await anybody.vouchOf(offer2.vouch!); return v?.state === "failed" && v; });
  const line2 = await read<{ defaulted: boolean; debt: bigint }>(LIVE.line, L, "line", [SECOND_LINE]);
  check("60 days on, the line is recovered on the live line contract and defaults", line2.defaulted);
  check("the vouch pays the 0.006 ETH left: 0.0002 from the fee, 0.0058 from the voucher's bond", !!failed && failed.paidEth === 0.006 && (await read<{ lostTotal: bigint }>(vc, V, "voucherOf", [VOUCHER])).lostTotal - voucherBefore.lostTotal === parseEther("0.0058"));
  check("the line owes nothing and the live pool lost nothing in the end", line2.debt === 0n && (await read<bigint>(LIVE.line, L, "lost")) === lostBefore);

  step("6  a cover vouch on report-lead's live cover, never delivered: the customer is paid");
  await rpc("anvil_impersonateAccount", [LIVE.reportLead]);
  await fund(LIVE.reportLead, "1");
  const price = parseEther("0.002");
  const amount = await read<bigint>(LIVE.guarantee, G, "coverLimit", [LIVE.reportLead, price]);
  const now = Number((await chain.getBlock()).timestamp);
  const dueAt = BigInt(now + 2 * 3600);
  const fee = await read<bigint>(LIVE.guarantee, G, "feeFor", [amount]);
  const rr = await sendFrom(KEYS.customer, LIVE.guarantee, G, "reserve", [LIVE.reportLead, price, dueAt, false, amount], fee);
  const coverId = BigInt(rr.logs.find((l) => l.address.toLowerCase() === LIVE.guarantee.toLowerCase())!.topics[1]!);
  const lr = await sendFrom(KEYS.customer, LIVE.desk, D, "lock", [LIVE.reportLead, dueAt, false], price);
  const coveredJob = BigInt(lr.logs.find((l) => l.address.toLowerCase() === LIVE.desk.toLowerCase())!.topics[1]!);
  await sendFrom(KEYS.customer, LIVE.guarantee, G, "bind", [coverId, coveredJob]);
  const offer3 = await voucher.vouchForCover(Number(coveredJob), "0.0005");
  check("the voucher co-signs the cover on job " + coveredJob, offer3.state === "offered");
  await sendFrom([LIVE.reportLead], vc, V, "accept", [BigInt(offer3.vouch!)], parseEther("0.00001"));
  const custBefore = await chain.getBalance({ address: CUSTOMER });
  await warp(2 * 3600 + 12 * 3600 + 120);
  const coverFailed = await keeper("the keeper to settle the cover vouch", async () => { const v = await anybody.vouchOf(offer3.vouch!); return v?.state === "failed" && v; });
  const gained = (await chain.getBalance({ address: CUSTOMER })) - custBefore;
  check("the job is refunded on the live desk and the cover paid by the live guarantee contract", Number((await read<{ state: number }>(LIVE.desk, D, "job", [coveredJob])).state) === 7 && Number((await read<{ state: number }>(LIVE.guarantee, G, "cover", [coverId])).state) === 4);
  check("the customer is paid the vouched 0.0005 ETH on top of the refund and the cover", !!coverFailed && coverFailed.paidTo?.toLowerCase() === CUSTOMER && gained === price + amount + parseEther("0.0005"), `${gained} wei`);
  const jobPage = words((await get(`/jobs/${String(coveredJob).padStart(4, "0")}`)).text);
  check("the job's page shows who co-signed its cover", /Co-signed by/i.test(jobPage));

  step("7  more refusals, and an offer nobody accepts");
  check("a vouch settles once", /This vouch is kept\./.test(await refused(stranger.settleVouch(offer1.vouch!))));
  const offer4 = await voucher.vouchForLine(NEWER, "0.002");
  await warp(7 * DAY + 120);
  const lapsed = await keeper("the keeper to withdraw the lapsed offer", async () => { const v = await anybody.vouchOf(offer4.vouch!); return v?.state === "withdrawn" && v; });
  check("an offer nobody accepts is withdrawn by the keeper after its seven days, its amount free again", !!lapsed);

  step("8  the owner's vouching switch");
  const sw = (on: boolean) => fetch(`${API}/v1/admin/switch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": ADMIN_API_KEY }, body: JSON.stringify({ what: "vouching", on }) });
  check("the switch is turned with the owner's key", (await sw(false)).ok);
  const hidden = await until("vouching hidden", async () => !(await anybody.vouching()).enabled);
  check("every vouch is hidden at once", hidden && (await get("/vouching")).status === 404);
  await sw(true);
  check("and back", !!(await until("vouching back", async () => (await anybody.vouching()).enabled)));

  step("9  the assistant's tools");
  const said = (await runTool(anybody, "factor_vouches", { agent: NEWER_LINE }, null)).text;
  check("factor_vouches says who vouched for the agent and how it ended", /kept/.test(said), said.split("\n")[0]);

  if (args.includes("--stay")) {
    step("10  for the pictures: a vouch standing on the newer agent's line, and an offer from one of Factor's own waiting");
    const standing = await voucher.vouchForLine(NEWER, "0.005");
    await newer.acceptVouch(standing.vouch!);
    await sendFrom([LIVE.reportLead], vc, V, "addBond", [LIVE.reportLead], parseEther("0.004"));
    await sendFrom([LIVE.reportLead], vc, V, "offerLine", [LIVE.reportLead, NEWER_LINE, parseEther("0.001")]);
    const shown = await mined("both on the agent's page", async () => { const v = await anybody.vouchesOf(NEWER_LINE); return v && v.received.some((x) => x.state === "active") && v.received.some((x) => x.factorOwn) && v; });
    check("the newer agent's page has a standing vouch that counts and an offer of Factor's own, not counted", !!shown && shown.standing === 1 && shown.notCounted >= 1);
  }

  const failedChecks = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failedChecks.length} of ${checks.length} checks passed${failedChecks.length ? `. FAILED: ${failedChecks.map((f) => f.name).join("; ")}` : ""}`);
  writeFileSync(join(WORK, "run.json"), JSON.stringify({ vc, from, voucher: VOUCHER, newer: NEWER, newerLine: NEWER_LINE, second: SECOND, secondLine: SECOND_LINE, customer: CUSTOMER, coveredJob: String(coveredJob), vouches: [offer1.vouch, offer2.vouch, offer3.vouch, offer4.vouch] }, null, 2));
  if (args.includes("--stay")) { console.log(`Left running: the site on ${SITE}. Stop with: npm run vouching-e2e -- --stop`); return; }
  await stopAll();
  if (failedChecks.length) process.exit(1);
}

main().catch(async (e) => { console.error(e); if (!args.includes("--stay")) await stopAll(); process.exit(1); });
