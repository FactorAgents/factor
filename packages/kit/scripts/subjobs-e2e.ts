// Agents that hire agents, end to end, on a LOCAL fork of Robinhood Chain: the fork (read through the rehearsal's own
// go-between, scripts/rehearsal-node.ts, so the copy keeps reading after the public node lets go of its block), the
// contracts deployed there by the engine's own script, the engine with SUBJOBS=on, and the site in front of it, all
// on 127.0.0.1. Nothing here reaches the real chain, and no model is called (the engine's stand-in answers).
//
//   npm run subjobs-e2e            every check, then everything is stopped
//   npm run subjobs-e2e -- --stay  everything is left running (the site on 3750) for a look or for pictures
//   npm run subjobs-e2e -- --stop  stops what --stay left running
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  three agents from outside sign up; the main one makes a signed link, and a customer pays it (the first deal)
//   2  the main agent draws half early and hires two agents for parts of the job: one by buying its link over x402,
//      one with hireForJob. Both locked from the main agent's own wallet, both linked under the job
//   3  the rules, live: over what is left of the job, due after it, itself, and a job that is not its own
//   4  both deliver and the main agent accepts; the main agent delivers and the customer accepts. Every wei where it
//      should be
//   5  the chain of work, checked on the desk; the records' "hired by" and "hires"; the pages
//   6  the burn pot received the 1% of every deal, from each buyer, beside every lock
//   7  a rejection: a second customer job with two sub-jobs, one accepted at once; the customer rejects the main
//      job, and the main agent passes it down to the sub-job still within its 24 hours. Half back, to the wei
//
// Keys: anvil's built-in test keys (inside the engine's script) and keys made up here for this run, funded on the fork
// only. No wallet of Factor's, and not the demonstration customer's.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Factor, Refusal, type AgentRecord, type JobTree } from "../src/index.js";
import { runTool } from "../src/tools.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WEB = join(KIT, "..", "..", "web");
// ports of this run's own: not the site's 3600, not the other runs', not anything else on this machine
const PORTS = { site: 3750, anvil: 3751, engine: 3752, model: 3753, source: 3754 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-subjobs-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const E2E_ENV = { E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK, E2E_FORK_URL: `http://127.0.0.1:${PORTS.source}`, SUBJOBS: "on", ENGINE_PULSE: "off", DESK_MIND: "off", ACTIVITY: "off" };
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
  step("0  the copy's source, the fork, the contracts, the engine with SUBJOBS=on and a traded token, and the site");
  await stopPort(PORTS.site);
  await stopPort(PORTS.source);
  // where the fork reads the real chain from: the rehearsal's go-between, which keeps the copy reading for as long as it lives
  const nodeLog = openSync(join(WORK, "source.log"), "a");
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["scripts/rehearsal-node.ts", "source", String(PORTS.source), LIVE_RPC], { cwd: ENGINE, stdio: ["ignore", nodeLog, nodeLog], detached: true }).unref();
  for (let i = 0; i < 60 && !pidsOn(PORTS.source).length; i++) await sleep(250);
  const bareRun = spawnSync("npm", ["run", "e2e", "--", "--bare"], { cwd: ENGINE, encoding: "utf8", timeout: 1_200_000, env: { ...process.env, ...E2E_ENV } });
  if (bareRun.status !== 0) throw new Error(`the engine's script failed:\n${(bareRun.stdout + bareRun.stderr).split("\n").slice(-30).join("\n")}`);
  const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8")) as { rpc: string; api: string; desk: Hex; burnPot: Hex; keys: Hex[] };
  const rpc = async (method: string, params: unknown[]) => (await (await fetch(bare.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: unknown };
  // two of the chain's own contracts are written to by every block and read the forked block's state each time: on
  // a copy that lives a while they are emptied, as the dress rehearsal does
  for (const a of ["0x0000F90827F1C53a10cb7A02335B175320002935", "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02"]) await rpc("anvil_setCode", [a, "0x"]);
  const siteLog = openSync(join(WORK, "site.log"), "a");
  spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORTS.site)], { cwd: WEB, stdio: ["ignore", siteLog, siteLog], detached: true, env: { ...process.env, FACTOR_ENGINE_URL: bare.api, FACTOR_SAMPLE: "", FACTOR_STATE_SHARE_MS: "0" } }).unref();
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${SITE}/api/v1/state`)).ok) break; } catch { /* starting */ } await sleep(500); }
  const where = { api: `${SITE}/api/v1`, rpcUrl: bare.rpc };
  const chain = createPublicClient({ transport: http(bare.rpc) });
  const fund = async (address: string, eth: string) => { await rpc("anvil_setBalance", [address, `0x${parseEther(eth).toString(16)}`]); };
  const balance = (a: string) => chain.getBalance({ address: a as Hex });
  const gasOf = async (hash: Hex) => { const r = await chain.getTransactionReceipt({ hash }); return r.gasUsed * r.effectiveGasPrice; };
  const DESK = parseAbi(["function job(uint256) view returns ((address customer, uint40 dueAt, uint40 deliveredAt, uint8 state, bool allowEarly, bool late, address agent, uint256 price, uint256 early, uint256 fromPool, bytes32 proof))"]);
  const job = (n: number) => chain.readContract({ address: bare.desk, abi: DESK, functionName: "job", args: [BigInt(n)] }) as Promise<{ customer: string; state: number; price: bigint; early: bigint; agent: string; dueAt: number }>;
  const POT = parseAbi(["function burnCount() view returns (uint256)"]);
  const burns = () => chain.readContract({ address: bare.burnPot, abi: POT, functionName: "burnCount" }) as Promise<bigint>;
  // the page's text as a reader sees it: React's marks between a word and a figure are not part of it
  const get = async (path: string) => { const r = await fetch(`${SITE}${path}`); return { status: r.status, text: (await r.text()).replace(/<!-- -->/g, "") }; };
  const tree = async (n: number) => JSON.parse((await get(`/api/v1/jobs/${n}/tree`)).text) as JobTree;
  const s0 = JSON.parse((await get("/api/v1/state")).text) as { subjobs?: { enabled: boolean; maxDepth: number; perParent: number } };
  check("the site answers in front of the engine, and says agents can hire agents", s0.subjobs?.enabled === true && s0.subjobs.maxDepth === 2 && s0.subjobs.perParent === 5, JSON.stringify(s0.subjobs));

  // every deal's burn, as the buyer sent it beside the lock: checked one by one at the end
  const dealBurns: { what: string; tx: Hex | null; from: string; price: bigint }[] = [];
  let advanceFees = 0n;
  const potBefore = await balance(bare.burnPot), burnsBefore = await burns();

  step("1  three agents sign up; the main one makes a link and a customer pays it");
  const keyOf = async (eth: string) => { const k = generatePrivateKey(); await fund(privateKeyToAccount(k).address, eth); return k; };
  const lead = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  const dates = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  const sums = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  await lead.signUp({ name: "chain-lead", does: "Reads contracts and hands back what matters in them" });
  await dates.signUp({ name: "chain-dates", does: "Finds every date and deadline in a contract" });
  await sums.signUp({ name: "chain-sums", does: "Checks every amount in a contract against its totals" });
  check("three agents are on the desk with their names", (await lead.me())?.agent.name === "chain-lead" && (await dates.me())?.agent.name === "chain-dates" && (await sums.me())?.agent.name === "chain-sums");
  const leadLink = await lead.createPayLink({ price: "0.04", title: "Read a contract and say what matters", brief: "Send the contract after paying. You get the dates, the amounts and what to watch for.", dueInHours: 48, allowEarly: true });
  const datesLink = await dates.createPayLink({ price: "0.01", title: "Every date in a contract", brief: "One date per line, with the clause it is in.", dueInHours: 24, allowEarly: true });
  const customer = await Factor.connect({ ...where, privateKey: await keyOf("2") });
  const deal = await customer.payLink(leadLink.url, { maxEth: "0.05" });
  dealBurns.push({ what: "the customer's deal", tx: deal.burnTx, from: customer.address!, price: parseEther("0.04") });
  const P = deal.jobId;
  const locked = await job(P);
  check("the customer's job is locked for the main agent at 0.04 ETH, early allowed", locked.customer.toLowerCase() === customer.address && locked.agent.toLowerCase() === lead.address && locked.price === parseEther("0.04") && locked.state === 1);
  check("and its 1% went to the burn, counted by Factor", deal.burned && !!deal.burnTx);

  step("2  the main agent draws half early, and hires two agents for parts of the job");
  const can = await lead.canDraw(P);
  const leadBefore = await balance(lead.address!);
  const drew = await lead.draw(P, can.early, "early");
  advanceFees += parseEther(can.early) / 100n;
  check("half of the job, less the 1% fee, is in the main agent's wallet", can.early === "0.02" && (await balance(lead.address!)) - leadBefore + (await gasOf(drew.hash)) === parseEther("0.0198"));
  // one by buying the other agent's link over x402, as part of the job
  const viaX = await lead.payX402(datesLink.x402, { maxEth: "0.0101", forJob: P });
  dealBurns.push({ what: "the x402 sub-job's deal", tx: viaX.burnTx, from: lead.address!, price: parseEther("0.01") });
  const A = viaX.jobId;
  check("chain-dates is hired over x402, locked from the main agent's wallet and put under the job", (await job(A)).customer.toLowerCase() === lead.address && viaX.subjob?.parent === P && viaX.burned, viaX.subjobNote ?? "");
  // one with hireForJob
  const hired = await lead.hireForJob(P, "chain-sums", "0.01", "Check every amount in clauses 4 to 9 against the totals in the schedule.", { title: "Check the amounts", dueInHours: 24, allowEarly: true, maxEth: "0.0101" });
  dealBurns.push({ what: "the direct sub-job", tx: hired.burnTx, from: lead.address!, price: parseEther("0.01") });
  const B = hired.jobId;
  check("chain-sums is hired with hireForJob, linked one level under the job, its 1% to the burn", hired.linked && hired.depth === 1 && hired.burned && (await job(B)).customer.toLowerCase() === lead.address, hired.note ?? "");
  const page = await lead.job(P);
  check("what is left of the job's price to hire with is 0.02 ETH, 2 of 5 sub-jobs used", page?.hiring?.freeEth === 0.02 && page.hiring.used === 2, JSON.stringify(page?.hiring));
  const subA = await job(A);
  check("each sub-job is due before the customer's job", subA.dueAt < locked.dueAt && (await job(B)).dueAt < locked.dueAt);

  step("3  the rules, live, refused before anything is locked");
  const before3 = await balance(lead.address!);
  check("over what is left of the job's price", (await refused(lead.hireForJob(P, "chain-dates", "0.03", "More dates."))).includes("Only 0.02 ETH is left"));
  check("due after the job itself", (await refused(lead.hireForJob(P, "chain-dates", "0.005", "More dates.", { dueInHours: 60 }))).includes("before job"));
  check("itself", (await refused(lead.hireForJob(P, "chain-lead", "0.005", "Myself."))).includes("cannot hire itself"));
  check("for a job that is not its own", (await refused(dates.hireForJob(P, "chain-sums", "0.005", "Not mine."))).includes(`Only the agent of job ${P}`));
  check("and the engine itself refuses a hire signed by another wallet", (await (await fetch(`${SITE}/api/v1/subjobs/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parent: P, agent: sums.address, price: "5000000000000000", dueAt: subA.dueAt, early: false, title: "Forged", brief: "", at: Math.floor(Date.now() / 1000), signature: `0x${"11".repeat(65)}` }) })).json() as { error?: string }).error?.includes("not the agent's") === true);
  check("nothing left the main agent's wallet for any of them", (await balance(lead.address!)) === before3);

  step("4  they deliver and are accepted; the main agent delivers and is accepted");
  const datesCan = await dates.canDraw(A);
  const dd = await dates.draw(A, datesCan.early, "early");
  advanceFees += parseEther(datesCan.early) / 100n;
  const datesBefore = await balance(dates.address!);
  await dates.deliver(A, "1 March: start. 30 June: first payment. 31 December: end.", { show: true });
  const sumsBefore = await balance(sums.address!);
  await sums.deliver(B, "Clauses 4 to 9 add up to the schedule's 16,500.", { show: true });
  const datesAfterDeliver = await balance(dates.address!), sumsAfterDeliver = await balance(sums.address!);
  await lead.accept(A);
  await lead.accept(B);
  check("chain-dates drew half early and is paid the rest on acceptance, less the job fee, to the wei", (await balance(dates.address!)) - datesAfterDeliver === parseEther("0.0048") && datesCan.early === "0.005" && datesBefore > 0n && !!dd.hash);
  check("chain-sums is paid in full on acceptance, less the job fee, to the wei", (await balance(sums.address!)) - sumsAfterDeliver === parseEther("0.0098") && sumsAfterDeliver <= sumsBefore);
  await lead.deliver(P, "The dates, the amounts and the three clauses to watch.", { show: true });
  const leadAfterDeliver = await balance(lead.address!);
  await customer.accept(P);
  check("the main agent is paid the rest of the customer's job, less the job fee, to the wei", (await balance(lead.address!)) - leadAfterDeliver === parseEther("0.0192"));
  check("the desk says all three settled", (await job(P)).state === 4 && (await job(A)).state === 4 && (await job(B)).state === 4);

  step("5  the chain of work, the records and the pages");
  await lead.waitFor(P, ["settled"]);
  await lead.waitFor(A, ["settled"]);
  await lead.waitFor(B, ["settled"]);
  const t = await tree(P);
  check("the tree: the customer's job, and the two jobs under it, each checked on the chain", t.root === P && t.nodes.length === 3 && t.nodes.filter((n) => n.parent === P).map((n) => n.job).sort().join() === [A, B].sort().join() && t.nodes.every((n) => n.verified === true && n.state === "settled"), JSON.stringify(t.nodes.map((n) => [n.job, n.parent, n.state, n.verified])));
  check("each link carries the main agent's own signature, naming the job above", t.nodes.filter((n) => n.depth === 1).every((n) => n.hire?.by === lead.address && n.hire.message.includes(`parent job: ${P}`)));
  check("the same tree from a sub-job's page", (await tree(B)).root === P);
  const recDates = JSON.parse((await get("/api/v1/record/chain-dates")).text) as AgentRecord;
  const recLead = JSON.parse((await get("/api/v1/record/chain-lead")).text) as AgentRecord;
  check("chain-dates' record: hired by chain-lead, once", recDates.hiring?.hiredBy.length === 1 && recDates.hiring.hiredBy[0]!.name === "chain-lead" && recDates.hiring.hiredBy[0]!.jobs === 1 && recDates.hiring.hires.length === 0);
  check("chain-lead's record: hires chain-dates and chain-sums, and its own record counts the settled job", recLead.hiring?.hires.map((x) => x.name).sort().join() === "chain-dates,chain-sums" && recLead.jobs.settled === 1, JSON.stringify(recLead.hiring));
  const jobPage = await get(`/jobs/${String(P).padStart(4, "0")}`);
  check("the job's page shows the chain: the customer, chain-lead, and the two it hired, with receipts", jobPage.text.includes("The chain of work") && jobPage.text.includes("chain-dates") && jobPage.text.includes("chain-sums") && jobPage.text.includes("Hired by") && jobPage.text.includes("Receipt"));
  check("and the burn of the whole chain", jobPage.text.includes("3 deals in this chain") && jobPage.text.includes("0.0006"));
  const subPage = await get(`/jobs/${String(B).padStart(4, "0")}`);
  check("a sub-job's page says what it is part of", subPage.text.includes(`Part of job ${String(P).padStart(4, "0")}`));
  check("the agents' pages say who hired whom", (await get("/agents/chain-lead")).text.includes("Hires") && (await get("/agents/chain-dates")).text.includes("Hired by"));
  check("an agent that hired nobody and was hired by nobody shows neither", !(await get("/agents/" + (await customer.agents()).find((a) => a.house)?.name)).text.includes("Hired by"));
  const toolTree = await runTool(lead, "factor_job_tree", { job: P }, null);
  check("the assistant's tool reads the chain", !toolTree.isError && toolTree.text.includes("3 deals in it added 0.0006 ETH to the burn."), toolTree.text.split("\n").at(-1));

  step("6  the burn pot received the 1% of every deal");
  for (const d of dealBurns) {
    const tx = d.tx ? await chain.getTransaction({ hash: d.tx }) : null;
    check(`${d.what}: ${d.price / 100n} wei from the buyer to the burn pot`, !!tx && tx.to?.toLowerCase() === bare.burnPot.toLowerCase() && tx.from.toLowerCase() === d.from && tx.value === d.price / 100n);
  }
  const burnedSince = (await burns()) - burnsBefore;
  const potGrew = (await balance(bare.burnPot)) - potBefore;
  const expected = dealBurns.reduce((n, d) => n + d.price / 100n, 0n) + advanceFees;
  check("the pot holds exactly the three deals' burns and the two advance fees", burnedSince > 0n || potGrew === expected, burnedSince > 0n ? `the pot burned ${burnedSince} time(s) meanwhile, so it was checked transfer by transfer` : `${potGrew} wei`);

  step("7  a rejection, passed down by the main agent's choice");
  const deal2 = await customer.payLink(leadLink.url, { maxEth: "0.05" });
  const P2 = deal2.jobId;
  const a2 = await lead.payLink(datesLink.url, { maxEth: "0.0101", forJob: P2 });
  const b2 = await lead.hireForJob(P2, "chain-sums", "0.01", "Check the amounts again.", { dueInHours: 24, maxEth: "0.0101" });
  check("two sub-jobs under the second job", a2.subjob?.parent === P2 && b2.linked, a2.subjobNote ?? b2.note ?? "");
  await dates.deliver(a2.jobId, "The dates.");
  await lead.accept(a2.jobId); // accepted at once: paid in full whatever happens above
  await sums.deliver(b2.jobId, "Not the amounts that were asked for.");
  await lead.deliver(P2, "A reading that missed the point.");
  const custBefore = await balance(customer.address!);
  const rej = await customer.reject(P2);
  check("the customer rejects the main job: half back, to the wei", (await balance(customer.address!)) - custBefore + (await gasOf(rej.hash)) === parseEther("0.02"));
  await lead.waitFor(P2, ["half"]);
  const t2 = await tree(P2);
  check("the tree says which delivery the main agent may still reject", t2.nodes.find((n) => n.job === b2.jobId)?.canReject === true && !t2.nodes.find((n) => n.job === a2.jobId)?.canReject);
  const page2 = await get(`/jobs/${String(P2).padStart(4, "0")}`);
  check("the page says it plainly", page2.text.includes("rejected the delivery, so it settled at half") && page2.text.includes("One delivery is still within its 24 hours"));
  const leadBeforePass = await balance(lead.address!);
  const passed = await lead.rejectSubJobs(P2);
  const passGas = passed.rejected.length ? await gasOf(passed.rejected[0]!.hash) : 0n;
  check("the main agent passes it down: the open delivery is rejected, half of it back, to the wei", passed.rejected.length === 1 && passed.rejected[0]!.jobId === b2.jobId && (await balance(lead.address!)) - leadBeforePass + passGas === parseEther("0.005"));
  check("the one it accepted stays paid in full", passed.left.length === 1 && passed.left[0]!.jobId === a2.jobId && (await job(a2.jobId)).state === 4);
  await lead.waitFor(b2.jobId, ["half"]);
  check("the tree after: settled at half, settled, settled at half", (await tree(P2)).nodes.map((n) => n.state).join() === "half,settled,half");

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  if (args.includes("--stay")) {
    console.log(`Left running: the site on ${SITE}, the engine on ${bare.api}, the fork on ${bare.rpc}.`);
    console.log(JSON.stringify({ site: SITE, rpc: bare.rpc, P, A, B, P2, A2: a2.jobId, B2: b2.jobId, lead: lead.address, leadName: "chain-lead" }));
  } else await stopAll();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  if (!args.includes("--stay")) await stopAll();
  process.exit(1);
});
