// Open jobs, end to end, on a LOCAL fork of Robinhood Chain: the fork (read through the rehearsal's own go-between,
// engine/scripts/rehearsal-node.ts), the contracts deployed there by the engine's own script, the engine with
// OPENJOBS=on, and the site in front of it, all on 127.0.0.1. Nothing here reaches the real chain, and no model is called.
//
//   npm run openjobs-e2e            every check, then everything is stopped
//   npm run openjobs-e2e -- --stay  everything is left running (the site on 3780) for a look or for pictures
//   npm run openjobs-e2e -- --stop  stops what --stay left running
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  three agents sign up, one with a record of paid work, one acting through a Factor account (gasless)
//   2  a customer posts an open job: signed, nothing locked, on the board
//   3  the agents apply, each with its own signature, and are ranked by Factor Score; the rules refuse the rest
//   4  the customer picks one by locking the price for it: an ordinary job, linked both ways, its 1% to the burn
//   5  the job is delivered and accepted; it counts on the agent's record like any job
//   6  best score takes it: Factor picks once two have applied, and the customer locks for that agent
//   7  a listing taken down; the assistant's tools say it all in words
//
// Keys: anvil's built-in test keys (inside the engine's script) and keys made up here for this run, funded on the fork
// only. No wallet of Factor's.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Factor, Refusal } from "../src/index.js";
import { runTool } from "../src/tools.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WEB = join(KIT, "..", "..", "web");
const PORTS = { site: 3780, anvil: 3781, engine: 3782, model: 3783, source: 3784 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-openjobs-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const E2E_ENV = { E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK, E2E_FORK_URL: `http://127.0.0.1:${PORTS.source}`, OPENJOBS: "on", SUBJOBS: "on", FIRMS: "on", PLANS: "on", ENGINE_PULSE: "off", DESK_MIND: "off", ACTIVITY: "off", MATCH: "off" };
const args = process.argv.slice(2);

const step = (title: string) => console.log(`\n== ${title}`);
const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
const refused = async (p: Promise<unknown>): Promise<string> => { try { await p; return ""; } catch (e) { return e instanceof Refusal ? e.message : `NOT A REFUSAL: ${(e as Error).message}`; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

async function main(): Promise<void> {
  if (args.includes("--stop")) { await stopAll(); console.log("stopped"); return; }
  mkdirSync(WORK, { recursive: true });
  step("0  the copy's source, the fork, the contracts, the engine with OPENJOBS=on, and the site");
  await stopPort(PORTS.site);
  await stopPort(PORTS.source);
  const nodeLog = openSync(join(WORK, "source.log"), "a");
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["scripts/rehearsal-node.ts", "source", String(PORTS.source), LIVE_RPC], { cwd: ENGINE, stdio: ["ignore", nodeLog, nodeLog], detached: true }).unref();
  for (let i = 0; i < 60 && !pidsOn(PORTS.source).length; i++) await sleep(250);
  const bareRun = spawnSync("npm", ["run", "e2e", "--", "--bare"], { cwd: ENGINE, encoding: "utf8", timeout: 1_200_000, env: { ...process.env, ...E2E_ENV } });
  if (bareRun.status !== 0) throw new Error(`the engine's script failed:\n${(bareRun.stdout + bareRun.stderr).split("\n").slice(-30).join("\n")}`);
  const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8")) as { rpc: string; api: string; desk: Hex; burnPot: Hex };
  const rpc = async (method: string, params: unknown[]) => (await (await fetch(bare.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: unknown };
  for (const a of ["0x0000F90827F1C53a10cb7A02335B175320002935", "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02"]) await rpc("anvil_setCode", [a, "0x"]);
  const siteLog = openSync(join(WORK, "site.log"), "a");
  spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORTS.site)], { cwd: WEB, stdio: ["ignore", siteLog, siteLog], detached: true, env: { ...process.env, FACTOR_ENGINE_URL: bare.api, FACTOR_SAMPLE: "", FACTOR_STATE_SHARE_MS: "0" } }).unref();
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${SITE}/api/v1/state`)).ok) break; } catch { /* starting */ } await sleep(500); }
  const where = { api: `${SITE}/api/v1`, rpcUrl: bare.rpc };
  const chain = createPublicClient({ transport: http(bare.rpc) });
  const fund = async (address: string, eth: string) => { await rpc("anvil_setBalance", [address, `0x${parseEther(eth).toString(16)}`]); };
  const balance = (a: string) => chain.getBalance({ address: a as Hex });
  const DESK = parseAbi(["function job(uint256) view returns ((address customer, uint40 dueAt, uint40 deliveredAt, uint8 state, bool allowEarly, bool late, address agent, uint256 price, uint256 early, uint256 fromPool, bytes32 proof))"]);
  const job = (n: number) => chain.readContract({ address: bare.desk, abi: DESK, functionName: "job", args: [BigInt(n)] }) as Promise<{ customer: string; state: number; price: bigint; agent: string; dueAt: number; allowEarly: boolean }>;
  const blockTime = async () => Number((await chain.getBlock()).timestamp);
  const get = async (path: string) => { const r = await fetch(`${SITE}${path}`); return { status: r.status, text: (await r.text()).replace(/<!-- -->/g, "") }; };
  const words = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").replace(/ ([,.])/g, "$1");
  const s0 = JSON.parse((await get("/api/v1/state")).text) as { openJobs?: { enabled: boolean; maxApplicants: number } };
  check("the site answers in front of the engine, and says open jobs are on", s0.openJobs?.enabled === true && s0.openJobs.maxApplicants === 20, JSON.stringify(s0.openJobs));

  step("1  three agents sign up, one with a record of paid work, one acting through a Factor account");
  const keyOf = async (eth: string) => { const k = generatePrivateKey(); await fund(privateKeyToAccount(k).address, eth); return k; };
  const checker = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  await checker.signUp({ name: "fig-checker", does: "Checks every figure in a text against its source" });
  const reader = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  await reader.signUp({ name: "new-reader", does: "Reads a long text and says what is in it" });
  const viaAccount = await Factor.connect({ ...where, privateKey: generatePrivateKey(), gasless: true });
  await viaAccount.signUp({ name: "acct-agent", does: "An agent acting through a Factor account" });
  const other = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  for (let i = 0; i < 2; i++) {
    const { jobId } = await other.hire({ agent: "fig-checker", price: "0.05", title: `Check a note, number ${i + 1}`, dueInHours: 24 });
    await checker.deliver(jobId, `Note ${i + 1}: every figure checked.`);
    await other.accept(jobId);
  }
  for (let i = 0; i < 30; i++) { const a = await checker.agent("fig-checker"); if (a?.agent.settled === 2 && a.agent.score > 0) break; await sleep(1000); }
  const scoreOf = async (name: string) => (await checker.agent(name))!.agent.score;
  const sc = await scoreOf("fig-checker"), sr = await scoreOf("new-reader");
  check("fig-checker has a Factor Score from two paid jobs; new-reader has none yet", sc > 0 && sr === 0, `${sc} and ${sr}`);

  step("2  a customer posts an open job: signed, nothing locked, on the board");
  const customer = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  const cb0 = await balance(customer.address!);
  const posted = await customer.postJob({ title: "Check every figure in our quarterly note", price: "0.004", brief: "About forty figures. Check each against the source named beside it; list the ones that do not match.", dueInHours: 48, allowEarly: true, closesInHours: 6 });
  check("posted: a listing with a number and a page, and nothing left the wallet", posted.created && /^0x[0-9a-f]{64}$/.test(posted.id) && (await balance(customer.address!)) === cb0, posted.url);
  const board = await customer.openJobs();
  check("it is on the board, taking applications", board.length === 1 && board[0]!.id === posted.id && board[0]!.status === "open" && board[0]!.applying);
  check("the board page shows it", words((await get("/open-jobs")).text).includes("Check every figure in our quarterly note"));

  step("3  the agents apply, each with its own signature, and are ranked by Factor Score; the rules refuse the rest");
  const r1 = await reader.applyToJob(posted.id);
  check("new-reader applies first: ranked 1 of 1", r1.rank === 1 && r1.of === 1 && r1.listing === "open", JSON.stringify(r1));
  const r2 = await checker.applyToJob(posted.id, { pitch: "Two jobs checked and paid, every figure against its source" });
  check("fig-checker applies second and ranks first, by its Factor Score", r2.rank === 1 && r2.of === 2, JSON.stringify(r2));
  const r3 = await viaAccount.applyToJob(posted.id, { pitch: "Signed through my Factor account" });
  check("an agent acting through a Factor account applies with its key's signature", r3.of === 3, JSON.stringify(r3));
  check("the customer cannot apply for its own job", (await refused(customer.applyToJob(posted.id))).includes("cannot apply for its own job"));
  const stranger = await Factor.connect({ ...where, privateKey: await keyOf("0.01") });
  check("a wallet that is not an agent on the desk cannot apply", (await refused(stranger.applyToJob(posted.id))).includes("not registered"));
  check("one application per agent", (await refused(checker.applyToJob(posted.id, { pitch: "Again" }))).includes("one application per agent"));
  const page = (await customer.openJob(posted.id))!.open;
  check("the listing ranks them by Factor Score: fig-checker first", page.applicants[0]?.name === "fig-checker" && page.applicants[0]!.score === sc && page.applicants.length === 3, page.applicants.map((a) => `${a.name} ${a.score}`).join(", "));
  const listing = words((await get(`/open-jobs/${posted.id}`)).text);
  check("the listing page shows them in that order, with fig-checker's line", listing.indexOf("fig-checker") > 0 && listing.indexOf("fig-checker") < listing.indexOf("new-reader") && listing.includes("Two jobs checked and paid"), listing.slice(listing.indexOf("Ranked"), listing.indexOf("Ranked") + 200));

  step("4  the customer picks one by locking the price for it: an ordinary job, linked both ways, its 1% to the burn");
  check("only the customer who posted it picks", (await refused(other.pickAgent(posted.id))).includes("Only the customer who posted"));
  const hired = await customer.pickAgent(posted.id, { agent: "new-reader" });
  const j = await job(hired.jobId);
  const t = await blockTime();
  check("the price is locked on the desk for new-reader, early allowed, due 48 hours after the lock", hired.linked && j.agent.toLowerCase() === reader.address && j.price === parseEther("0.004") && j.allowEarly && Math.abs(Number(j.dueAt) - (t + 48 * 3600)) < 900, hired.note ?? "");
  check("its 1% went to the burn, checked on the chain", hired.burned && !!hired.burnTx);
  const after = (await customer.openJob(posted.id))!.open;
  check("the listing says hired, with the job, picked by the customer", after.status === "hired" && after.job?.n === hired.jobId && after.picked?.by === "customer" && after.picked.address === reader.address);
  await customer.waitFor(hired.jobId, ["locked"]);
  const jp = (await customer.job(hired.jobId))!;
  check("the job carries the listing's title and brief, and says where it came from", jp.job.title === "Check every figure in our quarterly note" && jp.job.open?.id === posted.id && jp.job.open.applicants === 3 && (jp.brief ?? "").startsWith("About forty figures"));
  check("the job's page says it came from an open job", words((await get(`/jobs/${String(hired.jobId).padStart(4, "0")}`)).text).includes("From an open job"));
  const late = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  await late.signUp({ name: "late-comer", does: "Applies a little too late, on purpose" });
  check("applications are closed once it is hired", (await refused(late.applyToJob(posted.id))).length > 0);
  check("a second pick is refused before anything is locked", (await refused(customer.pickAgent(posted.id))).includes("locked already"));

  step("5  the job is delivered and accepted; it counts on the agent's record like any job");
  await reader.deliver(hired.jobId, "Forty figures checked; three do not match their sources, listed one per line.", { show: true });
  await customer.waitFor(hired.jobId, ["delivered"]);
  await customer.accept(hired.jobId);
  await customer.waitFor(hired.jobId, ["settled"]);
  for (let i = 0; i < 20; i++) { if ((await checker.agent("new-reader"))?.agent.settled === 1) break; await sleep(1000); }
  check("new-reader's record counts the job, and it has a Factor Score now", (await checker.agent("new-reader"))?.agent.settled === 1 && (await scoreOf("new-reader")) > 0);

  step("6  best score takes it: Factor picks once two have applied, and the customer locks for that agent");
  const best = await customer.postJob({ title: "Summarise our new supplier contract", price: "0.003", dueInHours: 24, closesInHours: 12, pick: "best", pickAfter: 2 });
  await late.applyToJob(best.id);
  check("one applied: still taking applications", (await customer.openJob(best.id))!.open.status === "open");
  const second = await checker.applyToJob(best.id);
  check("the second application makes Factor pick, at once", second.listing === "picked" && second.picked === checker.address, JSON.stringify(second));
  check("applications are closed once Factor has picked", (await refused(viaAccount.applyToJob(best.id))).length > 0);
  check("the customer cannot lock for another applicant", (await refused(customer.pickAgent(best.id, { agent: "late-comer" }))).includes("Factor picked"));
  const auto = await customer.pickAgent(best.id);
  check("the customer locks for Factor's pick, and it is linked as Factor's pick", auto.linked && auto.agent === checker.address && (await customer.openJob(best.id))!.open.picked?.by === "factor", auto.note ?? "");

  step("7  a listing taken down; the assistant's tools say it all in words");
  const down = await customer.postJob({ title: "A job taken down before anybody is hired", price: "0.002", closesInHours: 3 });
  await reader.applyToJob(down.id);
  check("only its customer takes it down", (await refused(other.closeJob(down.id))).length > 0);
  await customer.closeJob(down.id);
  check("taken down: closed, and nobody can apply", (await customer.openJob(down.id))!.open.status === "closed" && /took (this job|it) down/.test(await refused(late.applyToJob(down.id))));
  const toolBoard = (await runTool(customer, "factor_open_jobs", { show: "all" }, null)).text;
  check("factor_open_jobs lists them in words", toolBoard.includes("Check every figure in our quarterly note") && toolBoard.includes("hired"), toolBoard.split("\n")[0]);
  const toolOne = (await runTool(customer, "factor_open_job", { open: posted.id }, null)).text;
  check("factor_open_job ranks the applicants and names the job it became", /1\. fig-checker/.test(toolOne) && toolOne.includes(`Locked as job ${hired.jobId}`), toolOne.split("\n").slice(2, 5).join(" | "));
  const st = JSON.parse((await get("/api/v1/state")).text) as { openJobs?: { open: number; hired: number } };
  check("the first page counts the listings hired", st.openJobs?.hired === 2 && st.openJobs.open === 0, JSON.stringify(st.openJobs));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  if (args.includes("--stay")) {
    console.log(`Left running: the site on ${SITE}, the engine on ${bare.api}, the fork on ${bare.rpc}.`);
    console.log(JSON.stringify({ site: SITE, rpc: bare.rpc, open: posted.id, best: best.id, job: hired.jobId }));
  } else await stopAll();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  if (!args.includes("--stay")) await stopAll();
  process.exit(1);
});
