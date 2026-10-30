// Credit lines, end to end, on a LOCAL fork of Robinhood Chain: the fork (read through the rehearsal's own go-between,
// engine/scripts/rehearsal-node.ts), Factor's contracts deployed there by the engine's own script, the line contract
// deployed by contracts/deploy-lines.sh (the one command the owner will run), the engine with LINES=on, and the site in
// front of it, all on 127.0.0.1. Nothing here reaches the real chain, and no model is called.
//
//   npm run lines-e2e            every check, then everything is stopped
//   npm run lines-e2e -- --stay  everything is left running (the site on 3840) for pictures
//   npm run lines-e2e -- --stop  stops what --stay left running
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  the owner seeds the line pool with plain ETH; the site and the engine say lines are on, at the deployed contract
//   2  an agent with a record opens its line: its line account registers on the desk, and the agent's page shows it
//   3  it bonds at its line account and draws as ETH and as compute: every wei where the rulebook says, the compute
//      credit is the agent's at the gateway, and the desk's pool advance to the account is held to what the line leaves
//   4  a customer hires the line account; the agent delivers through it with the kit as usual; the payout lands in the
//      account and the keeper sweeps it into the line by itself: repaid on time, and the rest is the agent's to take out
//   5  a stranger cannot run the account, open a line for somebody else, or take anything out of it
//   6  a line left owing: late after 30 days (it cannot draw), and the keeper recovers it 30 days after that from the
//      account's bond: repaid late, not defaulted; the score counts it
//   7  a line that is never repaid defaults: barred for good, its unspent compute credit sent back to the line pool, and
//      the agent's Factor Score is 0
//   8  the owner's lines switch hides every line at once, and turned back, they return
//   9  the assistant's tools say it in words
//
// Keys: anvil's built-in test keys (inside the engine's script) and keys made up here for this run, funded on the fork.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { factorLineAbi } from "../src/abi/FactorLine.js";
import { factorLineAccountAbi } from "../src/abi/FactorLineAccount.js";
import { factorDeskAbi } from "../src/abi/FactorDesk.js";
import { Factor, Refusal } from "../src/index.js";
import { runTool } from "../src/tools.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WEB = join(KIT, "..", "..", "web");
const PORTS = { site: 3840, anvil: 3841, engine: 3842, model: 3843, source: 3844 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-lines-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ADMIN_API_KEY = "e2e-owner-key-of-this-local-run"; // the engine script's own, for this local run only
const args = process.argv.slice(2);
mkdirSync(WORK, { recursive: true });
const keysFile = join(WORK, "lines-keys.json");
const fresh = !args.includes("--stop");
type Keys = { agent: Hex; customer: Hex; stranger: Hex; late: Hex; gone: Hex };
const KEYS: Keys = fresh ? { agent: generatePrivateKey(), customer: generatePrivateKey(), stranger: generatePrivateKey(), late: generatePrivateKey(), gone: generatePrivateKey() } : ((() => { try { return JSON.parse(readFileSync(keysFile, "utf8")) as Keys; } catch { return {} as Keys; } })());
const keepKeys = () => writeFileSync(keysFile, JSON.stringify(KEYS, null, 2), { mode: 0o600 });
const E2E_ENV = { E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK, E2E_FORK_URL: `http://127.0.0.1:${PORTS.source}`, E2E_LINES: "on", COMPUTE_DIRECT: "on", ENGINE_PULSE: "off", DESK_MIND: "off", ACTIVITY: "off", MATCH: "off" };

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
const L = factorLineAbi as Abi;
const A = factorLineAccountAbi as Abi;
const D = factorDeskAbi as Abi;
const DAY = 86_400;

async function main(): Promise<void> {
  if (args.includes("--stop")) { await stopAll(); console.log("stopped"); return; }
  step("0  the copy's source, the fork, Factor, the line contract by its one command, the engine with LINES=on, the site");
  await stopPort(PORTS.site);
  await stopPort(PORTS.source);
  const nodeLog = openSync(join(WORK, "source.log"), "a");
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["scripts/rehearsal-node.ts", "source", String(PORTS.source), LIVE_RPC], { cwd: ENGINE, stdio: ["ignore", nodeLog, nodeLog], detached: true }).unref();
  for (let i = 0; i < 60 && !pidsOn(PORTS.source).length; i++) await sleep(250);
  const bareRun = spawnSync("npm", ["run", "e2e", "--", "--bare"], { cwd: ENGINE, encoding: "utf8", timeout: 1_500_000, env: { ...process.env, ...E2E_ENV } });
  writeFileSync(join(WORK, "bare-run.log"), bareRun.stdout + bareRun.stderr);
  keepKeys();
  if (bareRun.status !== 0) throw new Error(`the engine's script failed:\n${(bareRun.stdout + bareRun.stderr).split("\n").slice(-30).join("\n")}`);
  for (const line of bareRun.stdout.split("\n").filter((l) => /line contract|ok |FAIL/.test(l))) console.log(line);
  const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8")) as { rpc: string; api: string; desk: Hex; burnPot: Hex; token: Hex; keys: Hex[]; line: Hex };
  const deployLog = readFileSync(join(WORK, "deploy-lines.log"), "utf8");
  console.log(deployLog.split("\n").filter((l) => /gas, |about \$|it would be at|line   |OK:/.test(l)).map((l) => `     ${l.trim()}`).join("\n"));
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
  const tryFrom = (k: Hex, to: Hex, abi: Abi, functionName: string, a: unknown[], value = 0n) => chain.simulateContract({ address: to, abi, functionName, args: a, account: privateKeyToAccount(k), value } as never).then(() => "went through", (e: Error) => e.message);
  const get = async (path: string) => { const r = await fetch(`${SITE}${path}`); return { status: r.status, text: (await r.text()).replace(/<!-- -->/g, "") }; };
  const words = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").replace(/ ([,.])/g, "$1");
  const warp = async (s: number) => { await rpc("evm_increaseTime", [s]); await rpc("evm_mine", []); };
  const BOT = privateKeyToAccount(bare.keys[1]!).address.toLowerCase();
  for (const k of Object.values(KEYS)) await fund(privateKeyToAccount(k).address, "5");
  const AGENT = privateKeyToAccount(KEYS.agent).address.toLowerCase() as Hex;
  const line = bare.line;

  step("1  the owner seeds the line pool; lines are on at the contract the one command deployed");
  await wallet(bare.keys[0]!).sendTransaction({ to: line, value: parseEther("1") }).then((h) => chain.waitForTransactionReceipt({ hash: h }));
  check("plain ETH sent to the line contract is its pool", (await chain.readContract({ address: line, abi: L, functionName: "pool" })) === parseEther("1"));
  const about = await until("lines on at the site", async () => { const a = JSON.parse((await get("/api/v1/lines/about")).text) as { enabled: boolean; contract: string; pool: { poolEth: number } | null }; return a.enabled && a.pool?.poolEth === 1 ? a : null; }, 90_000);
  check("the site and the engine say lines are on, at the deployed contract, with the pool as seeded", about?.contract?.toLowerCase() === line.toLowerCase());
  const wire = await Promise.all(["desk", "burnPot", "gateway"].map((f) => chain.readContract({ address: line, abi: L, functionName: f }) as Promise<string>));
  check("the line contract reads its desk, burn pot and gateway from the desk", wire[0].toLowerCase() === bare.desk.toLowerCase() && wire[1].toLowerCase() === bare.burnPot.toLowerCase() && wire[2].toLowerCase() === BOT);

  step("2  an agent with a record opens its line");
  const agent = await Factor.connect({ ...where, privateKey: KEYS.agent });
  await agent.register();
  await agent.profile({ name: "line-runner", does: "Runs errands on credit for tests" });
  await until("line-runner's page", async () => (await agent.agent("line-runner"))?.agent.named);
  check("before a line, its page offers one", words((await get("/agents/line-runner")).text).includes("No line yet"));
  const opened = await agent.openLine();
  const ACCOUNT = opened.account.toLowerCase() as Hex;
  check("opened: its line account is where the line contract said it would be, registered on the desk", ACCOUNT === ((await chain.readContract({ address: line, abi: L, functionName: "accountAddress", args: [AGENT] })) as string).toLowerCase() && ((await chain.readContract({ address: bare.desk, abi: D, functionName: "agent", args: [ACCOUNT] })) as { registered: boolean }).registered, ACCOUNT);
  check("a second line for the same agent is refused", /has its line already/.test(await refused(agent.openLine())));
  const shown = await until("the line on the site", async () => (await agent.line("line-runner"))?.account === ACCOUNT);
  check("the site shows the line on the agent's page, and the line account under the agent's name", !!shown && words((await get("/agents/line-runner")).text).includes("Credit line") && words((await get(`/agents/${ACCOUNT}`)).text).includes("line-runner"));

  step("3  it bonds, and draws as ETH and as compute");
  check("with nothing at its line account, it can draw nothing", /Nothing is left of the line's limit/.test(await refused(agent.drawLine("0.001"))));
  await agent.bondLine("0.02");
  const potBefore = await chain.getBalance({ address: bare.burnPot });
  const gwBefore = await chain.getBalance({ address: BOT as Hex });
  const walletBefore = await chain.getBalance({ address: AGENT });
  const cash = await agent.drawLine("0.01");
  const cashReceipt = await chain.getTransactionReceipt({ hash: cash.hash });
  const gas = cashReceipt.gasUsed * cashReceipt.effectiveGasPrice;
  check("a cash draw: 0.0098 ETH to the agent, 0.0001 to the burn pot, all 0.01 owed", (await chain.getBalance({ address: AGENT })) - walletBefore + gas === parseEther("0.0098") && (await chain.getBalance({ address: bare.burnPot })) - potBefore === parseEther("0.0001") && cash.debtEth === "0.01");
  await agent.drawLine("0.005", { as: "compute" });
  check("a compute draw: 0.0049 ETH to the gateway, never the agent", (await chain.getBalance({ address: BOT as Hex })) - gwBefore >= parseEther("0.0049") - parseEther("0.0005"));
  const credit = await until("the line's compute credit", async () => { const c = await agent.computeCredit(); return c.lots.some((l) => (l as { paidBy?: string }).paidBy === "line") ? c : null; });
  check("the compute draw is the agent's compute credit at the gateway, paid by its line", !!credit && credit.balanceUsd > 0, `$${credit?.balanceUsd}`);
  const l3 = await until("the line's draws on the site", async () => { const l = await agent.line(); return l && l.draws === 2 ? l : null; });
  check("the site shows what it owes, its limit and what is left: 0.015 of 0.02", l3?.debtEth === 0.015 && l3.limitEth === 0.02 && l3.status === "owing" && Math.abs(l3.roomEth - 0.005) < 1e-9);
  // counted once: a pool advance from the desk to the account is held to what the line leaves
  const customer = await Factor.connect({ ...where, privateKey: KEYS.customer });
  const big = await customer.hire({ agent: ACCOUNT, price: "0.1" });
  const over = await refused(agent.draw(big.jobId, "0.006", "pool"));
  check("the desk's pool advance to the line account is held to what the line leaves (0.005)", /can advance 0.005 ETH more/.test(over), over);

  step("4  a customer hires the line account; the agent delivers through it; the keeper sweeps the payout into the line");
  const job = await customer.hire({ agent: ACCOUNT, price: "0.05" });
  await agent.deliver(job.jobId, "the errand, done");
  await customer.accept(job.jobId);
  check("the payout landed in the line account: 0.049 ETH", (await chain.getBalance({ address: ACCOUNT })) === parseEther("0.049") || ((await chain.readContract({ address: line, abi: L, functionName: "debtOf", args: [ACCOUNT] })) as bigint) < parseEther("0.015"));
  const swept = await until("the keeper's sweep", async () => ((await chain.readContract({ address: line, abi: L, functionName: "debtOf", args: [ACCOUNT] })) as bigint) === 0n, 120_000);
  check("the keeper swept it into the line by itself: nothing owed", swept);
  const l4 = await until("the line repaid on the site", async () => { const l = await agent.line(); return l && l.debtEth === 0 && l.onTime === 1 ? l : null; });
  check("repaid on time, counted on its record, the rest of the payout free in the account", !!l4 && Math.abs(l4.freeEth - 0.034) < 1e-9, `${l4?.freeEth} ETH free`);
  const before4 = await chain.getBalance({ address: AGENT });
  const took = await agent.withdrawFromLine();
  const tr = await chain.getTransactionReceipt({ hash: took.hash });
  check("the agent takes out what is free", (await chain.getBalance({ address: AGENT })) - before4 + tr.gasUsed * tr.effectiveGasPrice === parseEther("0.034") && took.tookEth === "0.034");
  const fs4 = (await agent.agent("line-runner"))! as unknown as { factorScore?: { line?: { onTime: number }; parts: { key: string; value: string }[] } };
  check("its Factor Score counts the line repaid on time as an advance repaid", fs4.factorScore?.line?.onTime === 1 && fs4.factorScore.parts.find((p) => p.key === "repaid")?.value === "1");

  step("5  a stranger");
  const stranger = await Factor.connect({ ...where, privateKey: KEYS.stranger });
  check("cannot run the agent's line account", /NotKey|Only the agent's own wallet/.test(await tryFrom(KEYS.stranger, ACCOUNT, A, "withdraw", [privateKeyToAccount(KEYS.stranger).address, 1n])));
  check("cannot open a line without a record", /Register this wallet/.test(await refused(stranger.openLine())));
  check("may repay or sweep anybody's line, which only pays the line", /owes nothing/.test(await refused(stranger.repayLine(undefined, { line: "line-runner" }))));

  step("6  a line left owing: late, then recovered from the bond 30 days after its due time");
  const late = await Factor.connect({ ...where, privateKey: KEYS.late });
  await late.register();
  await late.openLine();
  await late.bondLine("0.01");
  await late.drawLine("0.004");
  await warp(31 * DAY);
  check("late: it cannot draw until it is repaid", /Repay it before drawing again/.test(await refused(late.drawLine("0.001"))));
  const lateLine = await until("late on the site", async () => { const l = await late.line(); return l?.status === "late" ? l : null; });
  check("the site says the line is late", !!lateLine);
  await warp(30 * DAY);
  const recovered = await until("the keeper's recovery", async () => { const l = (await chain.readContract({ address: line, abi: L, functionName: "line", args: [lateLine!.account] })) as { debt: bigint; late: number; defaulted: boolean }; return l.debt === 0n ? l : null; }, 120_000);
  check("the keeper recovered it from the account's bond: repaid late, not defaulted", !!recovered && recovered.late === 1 && !recovered.defaulted);

  step("7  a line never repaid defaults");
  const gone = await Factor.connect({ ...where, privateKey: KEYS.gone });
  await gone.register();
  const goneLine = await gone.openLine();
  // fees at its line account from a job, the payout taken out, then a draw as compute on the fees alone
  const gj = await customer.hire({ agent: goneLine.account, price: "0.5" });
  await gone.deliver(gj.jobId, "work");
  await customer.accept(gj.jobId);
  await gone.withdrawFromLine();
  await gone.drawLine("0.009", { as: "compute" });
  await warp(61 * DAY);
  const defaulted = await until("the default", async () => ((await chain.readContract({ address: line, abi: L, functionName: "line", args: [goneLine.account] })) as { defaulted: boolean }).defaulted, 120_000);
  check("still owed 60 days after the draw with no bond: defaulted, barred for good", defaulted);
  const back = await until("the unspent credit back in the line pool", async () => { const p = JSON.parse((await get("/api/v1/lines/about")).text) as { pool: { seededEth: number } }; return p.pool.seededEth > 1 ? p : null; }, 120_000);
  check("its compute credit, unspent, went back to the line pool as ETH from the gateway", !!back, `${back?.pool.seededEth} ETH put in`);
  const goneScore = await until("the score of a default", async () => { const g = (await gone.agent(goneLine.account)) as unknown as { factorScore?: { score: number; zero: string | null } }; return g.factorScore?.zero ? g.factorScore : null; });
  check("its Factor Score is 0, and says why", goneScore?.score === 0 && /did not repay its credit line/.test(goneScore.zero ?? ""));
  check("it can never draw again", /barred for good/.test(await refused(gone.drawLine("0.0001"))));

  step("8  the owner's lines switch");
  const sw = (on: boolean) => fetch(`${bare.api}/v1/admin/switch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": ADMIN_API_KEY }, body: JSON.stringify({ what: "lines", on }) });
  check("the switch is turned with the owner's key", (await sw(false)).ok);
  const hidden = await until("lines hidden", async () => (await agent.line("line-runner")) === null);
  check("every line is hidden at once", hidden && !words((await get("/agents/line-runner")).text).includes("Credit line"));
  await sw(true);
  check("and back", !!(await until("lines back", async () => await agent.line("line-runner"))));

  step("9  the assistant's tools");
  const said = (await runTool(agent, "factor_line", {}, null)).text;
  check("factor_line says how the line stands", /owes nothing/.test(said) && /repaid in full 1 time\(s\) on time/.test(said), said.split("\n")[0]);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? `. FAILED: ${failed.map((f) => f.name).join("; ")}` : ""}`);
  if (args.includes("--stay")) { console.log(`Left running: the site on ${SITE}. Stop with: npm run lines-e2e -- --stop`); return; }
  await stopAll();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => { console.error(e); if (!args.includes("--stay")) await stopAll(); process.exit(1); });
