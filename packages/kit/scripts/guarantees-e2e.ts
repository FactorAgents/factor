// Guarantees, end to end, on a LOCAL fork of Robinhood Chain: the fork (read through the rehearsal's own go-between,
// engine/scripts/rehearsal-node.ts), Factor's contracts deployed there by the engine's own script, the line contract and
// then the guarantee contract deployed by their one-command scripts (contracts/deploy-guarantees.sh is the one the owner
// or the demo wallet runs), the engine with GUARANTEES=on, and the site in front of it, all on 127.0.0.1. Nothing here
// reaches the real chain, and no model is called.
//
//   npm run guarantees-e2e            every check, then everything is stopped
//   npm run guarantees-e2e -- --stay  everything is left running (the site on 3850) for pictures
//   npm run guarantees-e2e -- --stop  stops what --stay left running
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  guarantees are on at the contract the one command deployed, wired to the desk, the line contract and the burn pot
//   2  an agent earns a desk score of 200 with twenty small jobs; before that it sells no cover, whatever it bonds
//   3  it bonds and sets its offer: Guaranteed up to, on its page and in the lists
//   4  a customer hires it with cover (reserved, locked, tied, all tried first); the agent delivers and the customer
//      accepts: the keeper closes the cover by itself, back to the bond, the fee split between the agent and the burn
//   5  a covered job the agent never delivers: past its due time and the grace, the keeper refunds it on the desk and
//      pays the cover to the customer in the same transaction
//   6  a reservation whose customer locked the job and did not tie it: the keeper ties it; one with no job: it lapses
//   7  a covered job the agent declines: the cover goes back and the fee goes back to the customer
//   8  an agent with a credit line sells cover from its line account, run by its key
//   9  a stranger can neither take an agent's bond nor set its offer; nobody can take bond held back for a cover
//  10  the owner's guarantees switch hides them at once, and turned back, they return
//  11  the assistant's tools say it in words
//
// Keys: anvil's built-in test keys (inside the engine's script) and keys made up here for this run, funded on the fork.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { factorGuaranteeAbi } from "../src/abi/FactorGuarantee.js";
import { factorDeskAbi } from "../src/abi/FactorDesk.js";
import { Factor, Refusal } from "../src/index.js";
import { runTool } from "../src/tools.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WEB = join(KIT, "..", "..", "web");
const PORTS = { site: 3850, anvil: 3851, engine: 3852, model: 3853, source: 3854 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-guarantees-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ADMIN_API_KEY = "e2e-owner-key-of-this-local-run"; // the engine script's own, for this local run only
const args = process.argv.slice(2);
mkdirSync(WORK, { recursive: true });
const keysFile = join(WORK, "guarantees-keys.json");
const fresh = !args.includes("--stop");
type Keys = { agent: Hex; customer: Hex; stranger: Hex; liner: Hex };
const KEYS: Keys = fresh ? { agent: generatePrivateKey(), customer: generatePrivateKey(), stranger: generatePrivateKey(), liner: generatePrivateKey() } : ((() => { try { return JSON.parse(readFileSync(keysFile, "utf8")) as Keys; } catch { return {} as Keys; } })());
const keepKeys = () => writeFileSync(keysFile, JSON.stringify(KEYS, null, 2), { mode: 0o600 });
const E2E_ENV = { E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK, E2E_FORK_URL: `http://127.0.0.1:${PORTS.source}`, E2E_LINES: "on", E2E_GUARANTEES: "on", COMPUTE_DIRECT: "on", ENGINE_PULSE: "off", DESK_MIND: "off", ACTIVITY: "off", MATCH: "off" };

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
const G = factorGuaranteeAbi as Abi;
const D = factorDeskAbi as Abi;
const HOUR = 3600;

async function main(): Promise<void> {
  if (args.includes("--stop")) { await stopAll(); console.log("stopped"); return; }
  step("0  the copy's source, the fork, Factor, the line and guarantee contracts by their one commands, the engine with GUARANTEES=on, the site");
  await stopPort(PORTS.site);
  await stopPort(PORTS.source);
  const nodeLog = openSync(join(WORK, "source.log"), "a");
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["scripts/rehearsal-node.ts", "source", String(PORTS.source), LIVE_RPC], { cwd: ENGINE, stdio: ["ignore", nodeLog, nodeLog], detached: true }).unref();
  for (let i = 0; i < 60 && !pidsOn(PORTS.source).length; i++) await sleep(250);
  const bareRun = spawnSync("npm", ["run", "e2e", "--", "--bare"], { cwd: ENGINE, encoding: "utf8", timeout: 1_800_000, env: { ...process.env, ...E2E_ENV } });
  writeFileSync(join(WORK, "bare-run.log"), bareRun.stdout + bareRun.stderr);
  keepKeys();
  if (bareRun.status !== 0) throw new Error(`the engine's script failed:\n${(bareRun.stdout + bareRun.stderr).split("\n").slice(-30).join("\n")}`);
  for (const line of bareRun.stdout.split("\n").filter((l) => /guarantee contract|line contract|ok |FAIL/.test(l))) console.log(line);
  const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8")) as { rpc: string; api: string; desk: Hex; burnPot: Hex; token: Hex; keys: Hex[]; line: Hex; guarantee: Hex };
  const deployLog = readFileSync(join(WORK, "deploy-guarantees.log"), "utf8");
  console.log(deployLog.split("\n").filter((l) => /gas, |about \$|it would be at|guarantee  |OK:/.test(l)).map((l) => `     ${l.trim()}`).join("\n"));
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
  for (const k of Object.values(KEYS)) await fund(privateKeyToAccount(k).address, "10");
  const AGENT = privateKeyToAccount(KEYS.agent).address.toLowerCase() as Hex;
  const CUSTOMER = privateKeyToAccount(KEYS.customer).address.toLowerCase() as Hex;
  const g = bare.guarantee;
  const balance = (a: Hex) => chain.getBalance({ address: a });
  const gasOf = async (hash: Hex) => { const r = await chain.getTransactionReceipt({ hash }); return r.gasUsed * r.effectiveGasPrice; };
  const coverOf = async (job: number) => (await chain.readContract({ address: g, abi: G, functionName: "cover", args: [await chain.readContract({ address: g, abi: G, functionName: "coverOf", args: [BigInt(job)] })] })) as { state: number; amount: bigint; fee: bigint };

  step("1  guarantees are on at the contract the one command deployed");
  const about = await until("guarantees on at the site", async () => { const a = JSON.parse((await get("/api/v1/guarantees/about")).text) as { enabled: boolean; contract: string }; return a.enabled ? a : null; }, 90_000);
  check("the site and the engine say guarantees are on, at the deployed contract", about?.contract?.toLowerCase() === g.toLowerCase());
  const wire = await Promise.all(["desk", "line", "burnPot"].map((f) => chain.readContract({ address: g, abi: G, functionName: f }) as Promise<string>));
  check("the guarantee contract reads the desk and its burn pot, and is given the line contract", wire[0].toLowerCase() === bare.desk.toLowerCase() && wire[1].toLowerCase() === bare.line.toLowerCase() && wire[2].toLowerCase() === bare.burnPot.toLowerCase());

  step("2  an agent earns a score of 200 on the desk with twenty small jobs");
  const agent = await Factor.connect({ ...where, privateKey: KEYS.agent });
  const customer = await Factor.connect({ ...where, privateKey: KEYS.customer });
  await agent.register();
  await agent.profile({ name: "cover-runner", does: "Runs errands, guaranteed" });
  await until("cover-runner's page", async () => (await agent.agent("cover-runner"))?.agent.named);
  await agent.bondGuarantee("0.05");
  await agent.setCoverOffer("0.02");
  check("with no score it sells no cover, whatever it bonded", /sells no cover on this job/.test(await refused(customer.hireWithCover("cover-runner", "0.04"))));
  check("its page says it has a bond and that cover opens at 200", !!(await until("its bond on its page", async () => words((await get("/agents/cover-runner")).text).includes("Cover opens at a score of 200"), 90_000)));
  for (let i = 0; i < 20; i++) {
    const h = await customer.hire({ agent: AGENT, price: "0.001" });
    await agent.deliver(h.jobId, `errand ${i + 1}`);
    await customer.accept(h.jobId);
  }
  const score = (await chain.readContract({ address: bare.desk, abi: D, functionName: "score", args: [AGENT] })) as bigint;
  check("twenty settled jobs: a score of 200 on the desk", score >= 200n, String(score));

  step("3  it sells cover: Guaranteed up to, on its page and in the lists");
  const g3 = await until("its guarantee on the site", async () => { const x = await agent.guarantee(AGENT); return x?.selling ? x : null; }, 180_000);
  check("the site says it is guaranteed up to 0.02 a job, a quarter of a price at its score", g3?.upToEth === 0.02 && g3.sharePct === 25 && g3.bondEth === 0.05, `${g3?.upToEth} ETH, ${g3?.sharePct}%`);
  check("Guaranteed up to on its page and in the list", words((await get("/agents/cover-runner")).text).includes("Guaranteed up to 0.0200 ETH a job") && /cover-runner[^·]{0,60}Guaranteed up to 0\.0200 ETH/.test(words((await get("/agents")).text)));

  step("4  a customer hires it with cover; delivered and accepted, the keeper releases the cover by itself");
  const potBefore = await balance(bare.burnPot);
  const agentBefore = await balance(AGENT);
  const h4 = await customer.hireWithCover("cover-runner", "0.04", { title: "An errand with cover" });
  check("hired with cover: a quarter of 0.04, the fee 1% of it, tied to the job", h4.coverEth === "0.01" && h4.feeEth === "0.0001" && h4.tied, `job ${h4.jobId}, cover ${h4.cover}`);
  const c4 = await coverOf(h4.jobId);
  check("on the chain: the cover is tied to the job, held back from the bond", c4.state === 2 && c4.amount === parseEther("0.01") && ((await chain.readContract({ address: g, abi: G, functionName: "freeOf", args: [AGENT] })) as bigint) === parseEther("0.04"));
  const page4 = await until("the job's cover on its page", async () => { const t = words((await get(`/jobs/${String(h4.jobId).padStart(4, "0")}`)).text); return t.includes("Covered 0.01 ETH") ? t : null; }, 90_000);
  check("the job's page shows its cover and what happens if it is not delivered", !!page4 && page4.includes("If it is not delivered by"));
  const d4 = await agent.deliver(h4.jobId, "the errand, done");
  await customer.accept(h4.jobId);
  const released = await until("the keeper's close", async () => (await coverOf(h4.jobId)).state === 3, 180_000);
  check("the keeper closed the cover by itself: released to the bond", released);
  check("the fee split to the wei: 0.00005 to the burn pot, 0.00005 to the agent", (await balance(bare.burnPot)) - potBefore === parseEther("0.00005") && (await balance(AGENT)) - agentBefore + (await gasOf(d4.hash)) === parseEther("0.03920") + parseEther("0.00005"));
  check("the whole bond is free again", ((await chain.readContract({ address: g, abi: G, functionName: "freeOf", args: [AGENT] })) as bigint) === parseEther("0.05"));

  step("5  a covered job never delivered: the keeper refunds it and pays the cover, in one transaction");
  const h5 = await customer.hireWithCover("cover-runner", "0.04", { dueInHours: 1, title: "An errand that will not come" });
  // from here the customer sends nothing: what arrives is the desk's refund and the cover, to the wei
  const custBefore = await balance(CUSTOMER);
  await warp(HOUR + 300 + 12 * HOUR + 60);
  const paid = await until("the keeper's payout", async () => (await coverOf(h5.jobId)).state === 4, 240_000);
  check("past the due time and the grace, the keeper paid the cover", paid);
  const job5 = (await chain.readContract({ address: bare.desk, abi: D, functionName: "job", args: [BigInt(h5.jobId)] })) as { state: number };
  check("the desk job is refunded", job5.state === 7);
  const back5 = (await balance(CUSTOMER)) - custBefore;
  check("the customer got the price back and the cover on top: 0.05 for the 0.04 it locked", back5 === parseEther("0.05"), `${Number(back5) / 1e18} ETH back`);
  const page5 = await until("paid out on the job's page", async () => { const t = words((await get(`/jobs/${String(h5.jobId).padStart(4, "0")}`)).text); return t.includes("Paid out") ? t : null; }, 90_000);
  check("the job's page says the cover was paid out to the customer", !!page5 && page5.includes("Paid to the customer"));
  const g5 = await until("the paid cover on the agent's record", async () => { const x = await agent.guarantee(AGENT); return x && x.paid === 1 ? x : null; }, 90_000);
  check("the agent's guarantee record shows it: one paid out, 0.01 to the customer, the bond 0.04", g5?.paidOutEth === 0.01 && g5.bondEth === 0.04);

  step("6  the keeper ties a reservation to its job, and lets one with no job lapse");
  const now6 = Number((await chain.getBlock()).timestamp);
  const due6 = BigInt(now6 + 3 * HOUR);
  await sendFrom(KEYS.customer, g, G, "reserve", [AGENT, parseEther("0.02"), due6, false, parseEther("0.005")], parseEther("0.00005"));
  const r6 = await sendFrom(KEYS.customer, bare.desk, D, "lock", [AGENT, due6, false], parseEther("0.02"));
  const job6 = Number(BigInt(r6.logs.find((l) => l.address.toLowerCase() === bare.desk.toLowerCase())!.topics[1]!));
  const tied = await until("the keeper's tie", async () => (await coverOf(job6)).state === 2, 180_000);
  check("a reservation whose job was locked and not tied: the keeper tied it", tied, `job ${job6}`);
  await sendFrom(KEYS.customer, g, G, "reserve", [AGENT, parseEther("0.02"), due6, false, parseEther("0.004")], parseEther("0.00004"));
  const lapsedId = (await chain.readContract({ address: g, abi: G, functionName: "coverCount" })) as bigint;
  await warp(HOUR + 120);
  const lapsed = await until("the keeper's lapse", async () => ((await chain.readContract({ address: g, abi: G, functionName: "cover", args: [lapsedId] })) as { state: number }).state === 6, 180_000);
  check("a reservation with no job tied in the hour: the keeper let it lapse, back to the bond", lapsed);

  step("7  a covered job the agent declines: the cover goes back, and so does the fee");
  const h7 = await customer.hireWithCover("cover-runner", "0.008", { cover: "0.002" });
  const before7 = await balance(CUSTOMER);
  await agent.decline(h7.jobId);
  const declined = await until("the keeper's close of a declined job", async () => (await coverOf(h7.jobId)).state === 5, 180_000);
  check("declined: the cover went back to the bond", declined);
  check("the customer had the price and the fee back", (await balance(CUSTOMER)) - before7 === parseEther("0.008") + parseEther("0.00002"));

  step("8  an agent with a credit line sells cover from its line account, run by its key");
  const liner = await Factor.connect({ ...where, privateKey: KEYS.liner });
  await liner.register();
  await liner.profile({ name: "line-guard", does: "Works from a credit line, guaranteed" });
  for (let i = 0; i < 20; i++) {
    const h = await customer.hire({ agent: privateKeyToAccount(KEYS.liner).address, price: "0.001" });
    await liner.deliver(h.jobId, `small ${i + 1}`);
    await customer.accept(h.jobId);
  }
  const opened = await liner.openLine();
  const ACCOUNT = opened.account.toLowerCase() as Hex;
  const b8 = await liner.bondGuarantee("0.02");
  await liner.setCoverOffer("0.01");
  check("its key bonds and sets the offer for its line account by itself", b8.agent.toLowerCase() === ACCOUNT && b8.bondEth === "0.02");
  check("the line account counts its key's score", ((await chain.readContract({ address: g, abi: G, functionName: "scoreOf", args: [ACCOUNT] })) as bigint) >= 200n);
  const h8 = await customer.hireWithCover(ACCOUNT, "0.04");
  await liner.deliver(h8.jobId, "delivered through the line account");
  await customer.accept(h8.jobId);
  const acctBefore = await balance(ACCOUNT);
  const released8 = await until("the line account's cover released", async () => (await coverOf(h8.jobId)).state === 3, 180_000);
  check("covered, delivered through the line account, released", released8);
  check("the fee's half for the agent reached its line account", (await balance(ACCOUNT)) - acctBefore === parseEther("0.00005"));

  step("9  what nobody can do");
  const stranger = privateKeyToAccount(KEYS.stranger).address;
  check("a stranger cannot take an agent's bond", /NotAgent/.test(await tryFrom(KEYS.stranger, g, G, "takeBond", [AGENT, 1n])));
  check("nor set its offer", /NotAgent/.test(await tryFrom(KEYS.stranger, g, G, "setOffer", [AGENT, 0n])));
  check("bond held back for a cover cannot be taken out, even by the agent", /OverFree/.test(await tryFrom(KEYS.agent, g, G, "takeBond", [AGENT, parseEther("0.04")])), `free ${(await chain.readContract({ address: g, abi: G, functionName: "freeOf", args: [AGENT] })) as bigint}`);
  check("an agent cannot buy cover on its own job", /SelfCover/.test(await tryFrom(KEYS.agent, g, G, "reserve", [AGENT, parseEther("0.04"), BigInt(Number((await chain.getBlock()).timestamp) + 2 * HOUR), false, parseEther("0.001")], parseEther("0.00001"))));
  void stranger;

  step("10  the owner's guarantees switch");
  const sw = (on: boolean) => fetch(`${bare.api}/v1/admin/switch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": ADMIN_API_KEY }, body: JSON.stringify({ what: "guarantees", on }) });
  check("the switch is turned with the owner's key", (await sw(false)).ok);
  const hidden = await until("guarantees hidden", async () => (await agent.guarantee(AGENT)) === null);
  check("every guarantee is hidden at once", hidden && !words((await get("/agents/cover-runner")).text).includes("Guaranteed up to"));
  await sw(true);
  check("and back", !!(await until("guarantees back", async () => await agent.guarantee(AGENT))));

  step("11  the assistant's tools");
  const said = (await runTool(agent, "factor_guarantee", { agent: "cover-runner" }, null)).text;
  check("factor_guarantee says what it covers and its record", /guaranteed up to/.test(said) && /1 paid out/.test(said), said.split("\n")[0]);
  const coverSaid = (await runTool(customer, "factor_cover", { job: h5.jobId }, null)).text;
  check("factor_cover says the cover was paid", /Not delivered: 0\.01 ETH was paid to the customer/.test(coverSaid), coverSaid);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? `. FAILED: ${failed.map((f) => f.name).join("; ")}` : ""}`);
  if (args.includes("--stay")) { console.log(`Left running: the site on ${SITE}. Stop with: npm run guarantees-e2e -- --stop`); return; }
  await stopAll();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => { console.error(e); if (!args.includes("--stay")) await stopAll(); process.exit(1); });
