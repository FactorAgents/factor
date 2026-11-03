// Bounties through the kit, end to end, on a LOCAL fork of Robinhood Chain: the fork (read through the rehearsal's own
// go-between, engine/scripts/rehearsal-node.ts), Factor's contracts deployed there by the engine's own script, the line
// contract and then the bounty contract deployed by their one-command scripts (contracts/deploy-bounties.sh is the one
// the owner or the demo wallet runs), the engine with BOUNTIES=on, and the site in front of it, all on 127.0.0.1. Nothing
// here reaches the real chain, and no model is called.
//
//   npm run bounties-e2e            every check, then everything is stopped
//   npm run bounties-e2e -- --stay  everything is left running (the site on 3880) for pictures
//   npm run bounties-e2e -- --stop  stops what --stay left running
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  bounties are on at the contract the one command deployed, and the kit reads it from the site
//   2  a poster posts a bounty with the kit: the prize and its 1% locked, the task's words taken by Factor
//   3  agents enter with the kit: the hash the contract works out, the bond, the work taken and hidden; what the kit
//      refuses before anything is sent, and the contract's refusals in words
//   4  from the deadline the poster reads every entry with one signature, and nobody else can; it picks with the kit
//   5  the winner delivers with the kit, the keeper accepts on the desk, and the winner is paid to the wei
//   6  an agent with a credit line enters as its line account, is picked by its name, and delivers through it
//   7  no pick in 3 days: closed with the kit (or by the keeper first), the prize split to the wei
//   8  nobody entered: closed with the kit (or by the keeper first), everything back to the poster
//   9  the assistant's tools: the board, one bounty, a post and an entry behind the owner's caps
//  10  the owner's bounties switch: the kit says they are off, and refuses before anything is sent
//
// Keys: anvil's built-in test keys (inside the engine's script) and keys made up here for this run, funded on the fork.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, defineChain, formatEther, http, parseEther, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { factorBountyAbi } from "../src/abi/FactorBounty.js";
import { factorDeskAbi } from "../src/abi/FactorDesk.js";
import { Factor, Refusal } from "../src/index.js";
import { limitsFrom, runTool, Spending } from "../src/tools.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WEB = join(KIT, "..", "..", "web");
const PORTS = { site: 3880, anvil: 3881, engine: 3882, model: 3883, source: 3884 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-kit-bounties-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ADMIN_API_KEY = "e2e-owner-key-of-this-local-run"; // the engine script's own, for this local run only
const args = process.argv.slice(2);
mkdirSync(WORK, { recursive: true });
const E2E_ENV = { E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK, E2E_FORK_URL: `http://127.0.0.1:${PORTS.source}`, E2E_LINES: "on", E2E_BOUNTIES: "on", COMPUTE_DIRECT: "on", ENGINE_PULSE: "off", DESK_MIND: "off", ACTIVITY: "off", MATCH: "off" };

const step = (title: string) => console.log(`\n== ${title}`);
const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
const refused = async (p: Promise<unknown>): Promise<string> => { try { await p; return ""; } catch (e) { return e instanceof Refusal ? e.message : `NOT A REFUSAL: ${(e as Error).message}`; } };
const refusedCode = async (p: Promise<unknown>): Promise<string> => { try { await p; return ""; } catch (e) { return e instanceof Refusal ? e.code : `NOT A REFUSAL: ${(e as Error).message}`; } };
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
const B = factorBountyAbi as Abi;
const D = factorDeskAbi as Abi;
const HOUR = 3600, DAY = 86_400;

async function main(): Promise<void> {
  if (args.includes("--stop")) { await stopAll(); console.log("stopped"); return; }
  step("0  the copy's source, the fork, Factor, the line and bounty contracts by their one commands, the engine with BOUNTIES=on, the site");
  await stopPort(PORTS.site);
  await stopPort(PORTS.source);
  const nodeLog = openSync(join(WORK, "source.log"), "a");
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["scripts/rehearsal-node.ts", "source", String(PORTS.source), LIVE_RPC], { cwd: ENGINE, stdio: ["ignore", nodeLog, nodeLog], detached: true }).unref();
  for (let i = 0; i < 60 && !pidsOn(PORTS.source).length; i++) await sleep(250);
  const bareRun = spawnSync("npm", ["run", "e2e", "--", "--bare"], { cwd: ENGINE, encoding: "utf8", timeout: 1_800_000, env: { ...process.env, ...E2E_ENV } });
  writeFileSync(join(WORK, "bare-run.log"), bareRun.stdout + bareRun.stderr);
  if (bareRun.status !== 0) throw new Error(`the engine's script failed:\n${(bareRun.stdout + bareRun.stderr).split("\n").slice(-30).join("\n")}`);
  for (const line of bareRun.stdout.split("\n").filter((l) => /bounty contract|line contract|FAIL/.test(l))) console.log(line);
  const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8")) as { rpc: string; api: string; desk: Hex; burnPot: Hex; line: Hex; bounty: Hex; adminKey?: string };
  const rpc = async (method: string, params: unknown[]) => (await (await fetch(bare.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: unknown };
  for (const a of ["0x0000F90827F1C53a10cb7A02335B175320002935", "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02"]) await rpc("anvil_setCode", [a, "0x"]);
  const siteLog = openSync(join(WORK, "site.log"), "a");
  spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORTS.site)], { cwd: WEB, stdio: ["ignore", siteLog, siteLog], detached: true, env: { ...process.env, FACTOR_ENGINE_URL: bare.api, FACTOR_SAMPLE: "", FACTOR_STATE_SHARE_MS: "0", PORT: String(PORTS.site) } }).unref();
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${SITE}/api/v1/state`)).ok) break; } catch { /* starting */ } await sleep(500); }
  const where = { api: `${SITE}/api/v1`, rpcUrl: bare.rpc };
  const chainDef = defineChain({ id: 4663, name: "Robinhood Chain (local fork)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [bare.rpc] } } });
  const chain = createPublicClient({ chain: chainDef, transport: http(bare.rpc) });
  const fund = async (address: string, e: string) => { await rpc("anvil_setBalance", [address, `0x${parseEther(e).toString(16)}`]); };
  const warp = async (s: number) => { await rpc("evm_increaseTime", [s]); await rpc("evm_mine", []); };
  const balance = (a: Hex) => chain.getBalance({ address: a });
  const gasOf = async (hash: Hex) => { const r = await chain.getTransactionReceipt({ hash }); return r.gasUsed * r.effectiveGasPrice; };
  const bt = bare.bounty;
  const read = <T>(fn: string, a: unknown[] = []) => chain.readContract({ address: bt, abi: B, functionName: fn, args: a }) as Promise<T>;
  const bountyOf = (id: number) => read<{ state: number; job: bigint; winner: string; prize: bigint; bond: bigint }>("bounty", [BigInt(id)]);
  const deskJob = (id: number | bigint) => chain.readContract({ address: bare.desk, abi: D, functionName: "job", args: [BigInt(id)] }) as Promise<{ state: number; proof: string; customer: string; price: bigint; agent: string }>;
  const stateIs = (id: number, state: number) => until(`bounty ${id} to reach state ${state}`, async () => (await bountyOf(id)).state === state, 240_000);

  const K = { poster: generatePrivateKey(), a1: generatePrivateKey(), a2: generatePrivateKey(), liner: generatePrivateKey(), stranger: generatePrivateKey() };
  writeFileSync(join(WORK, "kit-bounties-keys.json"), JSON.stringify(K, null, 2), { mode: 0o600 });
  for (const k of Object.values(K)) await fund(privateKeyToAccount(k).address, "10");
  const POSTER = privateKeyToAccount(K.poster).address.toLowerCase() as Hex;
  const A1 = privateKeyToAccount(K.a1).address.toLowerCase() as Hex;
  const A2 = privateKeyToAccount(K.a2).address.toLowerCase() as Hex;
  const PRIZE = parseEther("0.01"), FEE = parseEther("0.0001"), BOND = parseEther("0.0001");

  step("1  bounties are on at the contract the one command deployed");
  const reader = await Factor.connect(where);
  const about = await until("bounties on at the site", async () => { const a = await reader.bounties(); return a.enabled ? a : null; }, 90_000);
  check("the kit reads from the site that bounties are on, at the deployed contract, with the contract's rules", about?.contract?.toLowerCase() === bt.toLowerCase() && about.rules.minPrizeEth === 0.005 && about.rules.maxEntries === 25);

  const poster = await Factor.connect({ ...where, privateKey: K.poster });
  const a1 = await Factor.connect({ ...where, privateKey: K.a1 });
  const a2 = await Factor.connect({ ...where, privateKey: K.a2 });
  const liner = await Factor.connect({ ...where, privateKey: K.liner });
  const stranger = await Factor.connect({ ...where, privateKey: K.stranger });
  await a1.signUp({ name: "haiku-one", does: "Writes short poems" });
  await a2.signUp({ name: "haiku-two", does: "Writes shorter poems" });
  await liner.signUp({ name: "haiku-line", does: "Writes poems on credit" });
  await until("the agents on the site", async () => (await a1.agent("haiku-one"))?.agent.named && (await a2.agent("haiku-two"))?.agent.named && (await liner.agent("haiku-line"))?.agent.named);

  step("2  a poster posts a bounty with the kit");
  const TASK = "A haiku about loose leaf tea\n\nFive, seven, five. About our shop, which posts tea weekly.";
  const heldBefore = await read<bigint>("held");
  const p1 = await poster.postBounty({ prize: "0.01", task: TASK, deadlineInHours: 2, maxEth: "0.0101" });
  check("posted: the prize and its 1% locked in the contract, the task's words taken by Factor", (await read<bigint>("held")) - heldBefore === PRIZE + FEE && p1.taskSaved && p1.feeWei === FEE && p1.bondWei === BOND, `bounty ${p1.id}`);
  const page1 = await until("the bounty on the site", async () => { const b = await reader.bounty(p1.id); return b?.title ? b : null; }, 60_000);
  check("the site shows its title and its task, taking entries", page1?.title === "A haiku about loose leaf tea" && page1.task === TASK && page1.status === "open" && page1.bondWei === BOND.toString());
  check("a prize under 0.005 is refused before anything is sent", (await refused(poster.postBounty({ prize: "0.004", task: TASK }))) === "The smallest prize is 0.005 ETH.");

  step("3  agents enter with the kit; the work is taken and hidden");
  const W1 = "Steam on the window\nleaves unfurl in the warm cup\nour shop smells of rain\n\n(haiku-one, for this bounty only)";
  const W2 = "Kettle sings at dawn\na week of green leaves arrives\nthe cup fills slowly\n\n(haiku-two)";
  const e1 = await a1.enterBounty(p1.id, W1);
  const onChain1 = await read<{ hash: string }>("entryOf", [BigInt(p1.id), A1]);
  check("entered: the hash on the chain is the kit's, with the agent's address in it, the bond paid and the work taken", onChain1.hash.toLowerCase() === e1.entryHash && e1.bondWei === BOND && e1.workSaved && e1.agent === A1);
  const e2 = await a2.enterBounty(p1.id, W2);
  check("a second enters", e2.workSaved);
  check("nobody enters twice: the contract's refusal in words", /entered this bounty already/.test(await refused(a1.enterBounty(p1.id, "another try"))));
  check("the poster cannot enter (it is not even an agent): in words", /has not registered as an agent/.test(await refused(poster.enterBounty(p1.id, "my own"))));
  check("the kit says an agent's entry and its work arrived", (await a1.bountyEntryStatus(p1.id)).workShown === true);
  const hidden = await until("two entries counted", async () => { const b = await reader.bounty(p1.id); return b?.entries === 2 ? b : null; }, 60_000);
  check("the site counts two entries and shows none of the work", !!hidden && !hidden.items && !JSON.stringify(hidden).includes("Steam on the window") && (await reader.bountyEntry(p1.id, A1)) === null);
  check("before the deadline not even the poster reads them", (await refusedCode(poster.bountyEntries(p1.id))) === "too_soon");

  step("4  from the deadline the poster reads with one signature, and picks with the kit");
  await warp(2 * HOUR + 400);
  check("past the deadline the kit refuses an entry before anything is sent", (await refusedCode(a2.enterBounty(p1.id, "too late"))) === "too_late");
  check("an agent cannot read them", (await refusedCode(a1.bountyEntries(p1.id))) === "not_poster");
  const entries = await until("the poster's read", async () => { const x = await poster.bountyEntries(p1.id); return x.length === 2 ? x : null; }, 90_000);
  check("the poster reads both, whole", entries?.find((x) => x.agent === A1)?.work === W1 && entries.find((x) => x.agent === A2)?.work === W2);
  check("an agent cannot pick", (await refusedCode(a1.pickWinner(p1.id, "haiku-one"))) === "not_poster");
  check("the poster cannot pick an agent that did not enter", (await refusedCode(poster.pickWinner(p1.id, "haiku-line"))) === "not_an_entrant");
  const pick1 = await poster.pickWinner(p1.id, "haiku-one");
  const job1 = await deskJob(pick1.jobId);
  check("picked by name: the prize is a desk job for the winner, the bounty contract its customer", pick1.winner === A1 && job1.agent.toLowerCase() === A1 && job1.customer.toLowerCase() === bt.toLowerCase() && job1.price === PRIZE, `job ${pick1.jobId}`);
  check("only the winner delivers", (await refusedCode(a2.deliverBounty(p1.id))) === "not_winner");
  const open1 = await until("every entry public", async () => { const e = await reader.bountyEntry(p1.id, "haiku-two"); return e?.work === W2 ? e : null; }, 60_000);
  check("from the pick every entry is public, through the kit", !!open1);

  step("5  the winner delivers with the kit; the keeper accepts and the desk pays");
  const before1 = await balance(A1);
  const d1 = await a1.deliverBounty(p1.id);
  check("delivered with its entry's hash as the proof", d1.proof.toLowerCase() === e1.entryHash && (await deskJob(pick1.jobId)).proof.toLowerCase() === e1.entryHash);
  const won = await stateIs(p1.id, 3);
  check("the keeper accepted on the desk by itself: won", !!won && (await deskJob(pick1.jobId)).state === 4);
  check("the winner is paid to the wei: 98% of the prize and its bond", (await balance(A1)) - before1 + (await gasOf(d1.hash)) === parseEther("0.0098") + BOND, formatEther((await balance(A1)) - before1 + (await gasOf(d1.hash))));
  const mine = await until("the win on the agent's record", async () => { const x = await a1.agentBounties(); return x?.won === 1 ? x : null; }, 90_000);
  check("the kit reads the win on the agent's record", mine?.wonEth === 0.01 && mine.entered === 1);
  check("the kit reads the poster's history and its pick", (await reader.bountyPoster(POSTER)).picks[0]?.winner === A1);

  step("6  an agent with a credit line enters as its line account, and delivers through it");
  const opened = await liner.openLine();
  const ACCOUNT = opened.account.toLowerCase() as Hex;
  const p2 = await poster.postBounty({ prize: "0.01", task: "A haiku about the first frost\n\nFive, seven, five.", deadlineInHours: 1 });
  const e3 = await liner.enterBounty(p2.id, "White on the bare field\nthe kettle hums for the shop\nfrost writes on the glass\n\n(haiku-line)");
  check("its key entered for its line account by default", e3.agent === ACCOUNT && (await read<{ at: number }>("entryOf", [BigInt(p2.id), ACCOUNT])).at > 0);
  await a2.enterBounty(p2.id, "Frost on the fence post\nthe tin of leaves is still warm\nmorning comes slowly\n\n(haiku-two)");
  await warp(HOUR + 400);
  const pick2 = await poster.pickWinner(p2.id, "haiku-line");
  check("the poster picks it by the agent's name: the kit finds its line account entered", pick2.winner === ACCOUNT && (await deskJob(pick2.jobId)).agent.toLowerCase() === ACCOUNT);
  const acct2 = await balance(ACCOUNT);
  const d2 = await liner.deliverBounty(p2.id);
  check("its key delivers through the line account", d2.jobId === pick2.jobId);
  const won2 = await stateIs(p2.id, 3);
  check("won: the prize and the bond reached the line account", !!won2 && (await balance(ACCOUNT)) - acct2 === parseEther("0.0098") + BOND);

  step("7  no pick in 3 days: closed, the prize split to the wei");
  const p3 = await poster.postBounty({ prize: "0.01", task: "A haiku about a teapot\n\nFive, seven, five.", deadlineInHours: 1 });
  await a1.enterBounty(p3.id, "Round belly of clay\nit holds the whole afternoon\npoured out in one cup\n\n(haiku-one)");
  await a2.enterBounty(p3.id, "Spout of the teapot\na small grey cloud for the shop\nthe lid taps softly\n\n(haiku-two)");
  const [s1, s2] = await Promise.all([balance(A1), balance(A2)]);
  await warp(HOUR + 400 + 3 * DAY);
  const c3 = await stranger.closeBounty(p3.id).then((r) => r.state, (e: Error) => e.message);
  const split = await stateIs(p3.id, 4);
  check("anyone closes it with the kit, or the keeper did first", !!split && (c3 === "unpicked" || /split between its entrants/.test(String(c3))), String(c3));
  check("split to the wei: half the prize and its bond to each", (await balance(A1)) - s1 === PRIZE / 2n + BOND && (await balance(A2)) - s2 === PRIZE / 2n + BOND);

  step("8  nobody entered: everything back to the poster");
  const p4 = await poster.postBounty({ prize: "0.005", task: "A haiku nobody will write\n\nFive, seven, five.", deadlineInHours: 1 });
  const pos4 = await balance(POSTER);
  await warp(HOUR + 400);
  const r4 = await poster.closeBounty(p4.id).then((r) => ({ state: r.state, gas: 0n, hash: r.hash }), (e: Error) => ({ state: e.message, gas: 0n, hash: null as Hex | null }));
  const empty = await stateIs(p4.id, 6);
  const gas4 = r4.hash ? await gasOf(r4.hash) : 0n;
  check("closed with nobody in: the prize and the 1% back to the poster", !!empty && (await balance(POSTER)) - pos4 + gas4 === parseEther("0.00505"), String(r4.state));

  step("9  the assistant's tools");
  const board = (await runTool(reader, "factor_bounties", { show: "all" }, null)).text;
  check("factor_bounties says the board in words", board.includes(`Bounty ${p1.id} "A haiku about loose leaf tea": a prize of 0.01 ETH`) && board.includes("won by haiku-one"), board.split("\n")[0]);
  const one = (await runTool(reader, "factor_bounty", { id: p1.id }, null)).text;
  check("factor_bounty says the task, the poster's history and every entry once public", one.includes("Five, seven, five.") && one.includes("Its poster") && one.includes("haiku-one") && one.includes("WON"));
  const dir = mkdtempSync(join(tmpdir(), "factor-kit-"));
  const spending = new Spending(limitsFrom({ FACTOR_MAX_JOB_ETH: "0.02", FACTOR_MAX_DAY_ETH: "0.05", FACTOR_KIT_DIR: dir }), poster.address!);
  const posted = await runTool(poster, "factor_post_bounty", { prize: "0.005", task: "A haiku about a tea tin\n\nFive, seven, five.", deadline_in_hours: 1 }, spending);
  check("factor_post_bounty posts behind the owner's caps and counts what it spent", !posted.isError && spending.today() === parseEther("0.00505"), posted.text.split(".")[0]);
  const p5 = Number(/Bounty (\d+) is posted/.exec(posted.text)?.[1] ?? 0);
  await until("the new bounty on the site", async () => (await reader.bounty(p5))?.title, 60_000);
  const entered = await runTool(a2, "factor_enter_bounty", { id: p5, work: "A tin of green leaves\nthe lid squeaks open at dawn\nthe whole shop wakes up\n\n(haiku-two)" }, new Spending(limitsFrom({ FACTOR_KIT_DIR: dir }), a2.address!));
  check("factor_enter_bounty enters with the bond", !entered.isError && /Entered bounty \d+ as/.test(entered.text), entered.text.split(".")[0]);
  const over = await runTool(poster, "factor_post_bounty", { prize: "0.05", task: "A haiku that costs too much" }, spending);
  check("a prize over the owner's cap is refused before anything is sent", over.isError && /over this assistant's cap/.test(over.text));
  rmSync(dir, { recursive: true, force: true });

  step("10  the owner's bounties switch");
  const adminKey = bare.adminKey ?? ADMIN_API_KEY;
  const sw = (on: boolean) => fetch(`${bare.api}/v1/admin/switch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": adminKey, authorization: `Bearer ${adminKey}` }, body: JSON.stringify({ what: "bounties", on }) });
  check("the switch is turned with the owner's key", (await sw(false)).ok);
  const off = await until("bounties off", async () => !(await reader.bounties()).enabled);
  check("the kit says bounties are off, and refuses to enter before anything is sent", !!off && (await refusedCode(a1.enterBounty(p5, "anything"))) === "bounties_off");
  await sw(true);
  check("and back", !!(await until("bounties back", async () => (await reader.bounties()).enabled)));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? `. FAILED: ${failed.map((f) => f.name).join("; ")}` : ""}`);
  if (args.includes("--stay")) { console.log(`Left running: the site on ${SITE}. Stop with: npm run bounties-e2e -- --stop`); return; }
  await stopAll();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => { console.error(e); if (!args.includes("--stay")) await stopAll(); process.exit(1); });
