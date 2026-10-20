// ERC-8004, end to end, on a LOCAL fork of Robinhood Chain with the REAL registries: the standard's identity and
// reputation registries as they are deployed there (version 2.0.0, at 0x8004A169… and 0x8004BAa1…), read through the
// rehearsal's own go-between (engine/scripts/rehearsal-node.ts), Factor's contracts deployed on the fork by the engine's
// own script, the engine with ERC8004=on (and the backfill), and the site in front of it, all on 127.0.0.1. Nothing here
// reaches the real chain: every transaction is the fork's own, and no model is called.
//
//   npm run erc8004-e2e            every check, then everything is stopped
//   npm run erc8004-e2e -- --stay  everything is left running (the site on 3840) for a look or for pictures
//   npm run erc8004-e2e -- --stop  stops what --stay left running
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  an agent signs up, and a job of its is settled before it has an identity
//   2  it registers an ERC-8004 identity in the real registry; the engine finds it there by its agentWallet and links it
//   3  a job settles: one entry is written to the agent's reputation, then the job from before the link (the backfill)
//   4  a job rejected and settled at half: an entry of 50
//   5  the entries read back from the real registry: values, tags, Factor's address, getSummary; the file each points at
//      is on the site word for word, and its keccak256 is the hash the entry carries
//   6  what the registry itself holds to: the identity's owner cannot write to its own reputation
//   7  each job once: more passes write nothing more
//   8  an agent with two identities: none is picked, and it signs which one is its own
//   9  the agent's page, its record, the docs, and the assistant's tool
//
// Keys: anvil's built-in test keys (inside the engine's script) and keys made up here for this run, funded on the fork
// only. No wallet of Factor's.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeEventLog, http, keccak256, parseAbi, parseEther, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Factor, IDENTITY_REGISTRY, REPUTATION_REGISTRY, Refusal } from "../src/index.js";
import { runTool } from "../src/tools.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WEB = join(KIT, "..", "..", "web");
const PORTS = { site: 3840, anvil: 3841, engine: 3842, model: 3843, source: 3844 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-erc8004-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const args = process.argv.slice(2);
// the identity registry's own count, at its ERC-7201 place: identities are numbered from 0 and never taken away
const IDENTITY_COUNT_SLOT = "0xa040f782729de4970518741823ec1276cbcd41a0c7493f62d173341566a04e00";

const step = (title: string) => console.log(`\n== ${title}`);
const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidsOn = (port: number): number[] => spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.split("\n").map((s) => s.trim()).filter(Boolean).map(Number);
async function stopPort(port: number): Promise<void> {
  for (const pid of pidsOn(port)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  for (let i = 0; i < 60 && pidsOn(port).length; i++) await sleep(100);
  for (const pid of pidsOn(port)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

const REPUTATION = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  "function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);
const IDENTITY = parseAbi(["function ownerOf(uint256) view returns (address)", "function getAgentWallet(uint256) view returns (address)", "function getVersion() pure returns (string)"]);

async function main(): Promise<void> {
  const E2E_ENV: Record<string, string> = {
    E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK, E2E_FORK_URL: `http://127.0.0.1:${PORTS.source}`,
    ERC8004: "on", ERC8004_BACKFILL: "on", ERC8004_SCAN_EVERY_S: "5", ERC8004_SCAN_BATCH: "8",
    ENGINE_PULSE: "off", DESK_MIND: "off", ACTIVITY: "off", MATCH: "off",
  };
  const stopAll = async () => {
    await stopPort(PORTS.site);
    spawnSync("npm", ["run", "e2e", "--", "--stop"], { cwd: ENGINE, encoding: "utf8", env: { ...process.env, ...E2E_ENV } });
    await stopPort(PORTS.source);
  };
  if (args.includes("--stop")) { await stopAll(); console.log("stopped"); return; }
  // where the identity registry ends on the real chain: the engine reads the fork's registry from there on, so that the
  // nine thousand identities before it are not each fetched from the real node through the fork
  const live = (await (await fetch(LIVE_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getStorageAt", params: [IDENTITY_REGISTRY, IDENTITY_COUNT_SLOT, "latest"] }) })).json()) as { result: Hex };
  const scanFrom = Number(BigInt(live.result));
  E2E_ENV.ERC8004_SCAN_FROM = String(scanFrom);
  mkdirSync(WORK, { recursive: true });
  try {
    await run(E2E_ENV, scanFrom);
  } catch (e) {
    console.error(e instanceof Error ? e.stack ?? e.message : e);
    if (!args.includes("--stay")) await stopAll();
    process.exit(1);
  }
  if (!args.includes("--stay")) await stopAll();
  if (checks.some((c) => !c.ok)) process.exit(1);
}

async function run(E2E_ENV: Record<string, string>, scanFrom: number): Promise<void> {
  step("0  the copy's source, the fork with the real registries, the contracts, the engine with ERC8004=on, and the site");
  await stopPort(PORTS.site);
  await stopPort(PORTS.source);
  const nodeLog = openSync(join(WORK, "source.log"), "a");
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["scripts/rehearsal-node.ts", "source", String(PORTS.source), LIVE_RPC], { cwd: ENGINE, stdio: ["ignore", nodeLog, nodeLog], detached: true }).unref();
  for (let i = 0; i < 60 && !pidsOn(PORTS.source).length; i++) await sleep(250);
  const bareRun = spawnSync("npm", ["run", "e2e", "--", "--bare"], { cwd: ENGINE, encoding: "utf8", timeout: 1_200_000, env: { ...process.env, ...E2E_ENV } });
  if (bareRun.status !== 0) throw new Error(`the engine's script failed:\n${(bareRun.stdout + bareRun.stderr).split("\n").slice(-30).join("\n")}`);
  const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8")) as { rpc: string; api: string; desk: Hex; keys: Hex[] };
  const rpc = async (method: string, params: unknown[]) => (await (await fetch(bare.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: unknown };
  for (const a of ["0x0000F90827F1C53a10cb7A02335B175320002935", "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02"]) await rpc("anvil_setCode", [a, "0x"]);
  const siteLog = openSync(join(WORK, "site.log"), "a");
  spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORTS.site)], { cwd: WEB, stdio: ["ignore", siteLog, siteLog], detached: true, env: { ...process.env, FACTOR_ENGINE_URL: bare.api, FACTOR_SAMPLE: "", FACTOR_STATE_SHARE_MS: "0" } }).unref();
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${SITE}/api/v1/state`)).ok) break; } catch { /* starting */ } await sleep(500); }
  const where = { api: `${SITE}/api/v1`, rpcUrl: bare.rpc };
  const chain = createPublicClient({ transport: http(bare.rpc) });
  const fund = async (address: string, eth: string) => { await rpc("anvil_setBalance", [address, `0x${parseEther(eth).toString(16)}`]); };
  const get = async (path: string) => { const r = await fetch(`${SITE}${path}`); return { status: r.status, text: (await r.text()).replace(/<!-- -->/g, ""), type: r.headers.get("content-type") ?? "" }; };
  const words = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  const health = async () => (await (await fetch(`${bare.api}/v1/health`)).json()) as { gasWallet: { address: string } | null; erc8004: { enabled: boolean; reviewer: string | null; scan: unknown } | null };
  const h0 = await health();
  const bot = (h0.gasWallet?.address ?? "").toLowerCase() as Hex;
  check("the fork holds the real registries: version 2.0.0, and the engine has ERC-8004 on, writing from its gas wallet", (await chain.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY, functionName: "getVersion" })) === "2.0.0" && h0.erc8004?.enabled === true && h0.erc8004.reviewer?.toLowerCase() === bot, `${scanFrom} identities on the real chain; gas wallet ${bot}`);
  const s0 = JSON.parse((await get("/api/v1/state")).text) as { erc8004?: { enabled: boolean; registry: string } };
  check("the site says ERC-8004 is on, with the standard's identity registry", s0.erc8004?.enabled === true && s0.erc8004.registry === `eip155:4663:${IDENTITY_REGISTRY}`, JSON.stringify(s0.erc8004));

  step("1  an agent signs up, and a job of its is settled before it has an identity");
  const keyOf = async (eth: string) => { const k = generatePrivateKey(); await fund(privateKeyToAccount(k).address, eth); return k; };
  const agent = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  await agent.signUp({ name: "ledger-scribe", does: "Reads a ledger and writes up what moved, every figure checked" });
  const customer = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  const job = async (o: { reject?: boolean; title: string }) => {
    const { jobId } = await customer.hire({ agent: "ledger-scribe", price: "0.002", title: o.title, dueInHours: 24 });
    await agent.deliver(jobId, `${o.title}: every figure checked.`);
    if (o.reject) await customer.reject(jobId); else await customer.accept(jobId);
    await customer.waitFor(jobId, [o.reject ? "half" : "settled"]);
    return jobId;
  };
  const past = await job({ title: "Last week's ledger, read" });
  check("job settled with no identity linked: nothing is written for it yet", (await agent.erc8004())?.erc8004 === null);

  step("2  it registers an ERC-8004 identity in the real registry; the engine finds it there and links it");
  const reg = await agent.registerErc8004("https://factoragents.fun/agents/ledger-scribe");
  const id = reg.agentId;
  const [owner, aw] = await Promise.all([chain.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY, functionName: "ownerOf", args: [BigInt(id)] }), chain.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY, functionName: "getAgentWallet", args: [BigInt(id)] })]);
  check("the registry gave it the next number, owned by its wallet, which is its agentWallet too", BigInt(id) === BigInt(scanFrom) && owner.toLowerCase() === agent.address && aw.toLowerCase() === agent.address, `#${id}`);
  let st = await agent.erc8004();
  for (let i = 0; i < 60 && !st?.erc8004; i++) { await sleep(1000); st = await agent.erc8004(); }
  check("the engine read the registry and linked it by its agentWallet", st?.erc8004?.agentId === id && st.erc8004.linked === "found" && st.erc8004.via === "wallet", JSON.stringify(st?.erc8004 ?? st?.found));

  step("3  a job settles: one entry, then the job from before the link (the backfill)");
  const paid = await job({ title: "This week's ledger, read" });
  const waitEntries = async (n: number) => { for (let i = 0; i < 90; i++) { const x = (await agent.erc8004())?.erc8004; if (x && x.entries >= n && !x.waiting) return x; await sleep(1000); } return (await agent.erc8004())?.erc8004 ?? null; };
  let e = await waitEntries(2);
  const byJob = (n: number) => e?.items.find((x) => x.job === n);
  check("two entries written and mined, once each: the new job, and the one from before the link (the backfill), marked as such", e?.entries === 2 && !byJob(paid)?.past && byJob(past)?.past && new Set(e.items.map((x) => x.index)).size === 2 && e.items.every((x) => x.mined && x.value === 100), JSON.stringify(e?.items));

  step("4  a job rejected and settled at half: an entry of 50");
  const half = await job({ title: "A ledger, read in a hurry", reject: true });
  e = await waitEntries(3);
  check("its entry says 50, and the average of the three is 83.3", e?.entries === 3 && e.items[0]?.job === half && e.items[0].value === 50 && e.average === 83.3, JSON.stringify(e?.items[0]));

  step("5  read back from the real registry, and the file each entry points at");
  const read = await customer.erc8004Entries("ledger-scribe");
  check("the kit reads three entries from Factor's address in the registry itself: 100, 100, 50, tagged factor and job", read.count === 3 && read.reviewer === bot && read.entries.map((x) => x.value).join(",") === "100,100,50" && read.entries.every((x) => x.tag1 === "factor" && x.tag2 === "job" && !x.revoked && x.valueDecimals === 0), JSON.stringify(read.entries));
  const [count, value, places] = await chain.readContract({ address: REPUTATION_REGISTRY, abi: REPUTATION, functionName: "getSummary", args: [BigInt(id), [bot], "factor", ""] });
  check("getSummary(agentId, [Factor], \"factor\", \"\") is what any app reads: 3 entries, 83 on average", count === 3n && value === 83n && places === 0, `${count} ${value} ${places}`);
  const tx = e!.items.find((x) => x.job === paid)!.tx as Hex;
  const receipt = await chain.getTransactionReceipt({ hash: tx });
  const log = receipt.logs.map((l) => { try { return decodeEventLog({ abi: REPUTATION, topics: l.topics as [Hex, ...Hex[]], data: l.data }); } catch { return null; } }).find((d) => d?.eventName === "NewFeedback");
  const args_ = log?.args as { agentId: bigint; clientAddress: string; feedbackURI: string; feedbackHash: Hex; value: bigint } | undefined;
  check("the entry came from Factor's gas wallet, for the agent's identity, pointing at the job's file on factoragents.fun", receipt.from.toLowerCase() === bot && args_?.agentId === BigInt(id) && args_.clientAddress.toLowerCase() === bot && args_.feedbackURI === `https://factoragents.fun/api/v1/erc8004/feedback/${paid}`, args_?.feedbackURI);
  const file = await get(`/api/v1/erc8004/feedback/${paid}`);
  check("the file is on the site word for word: its keccak256 is the hash the entry carries", file.status === 200 && keccak256(toHex(file.text)) === args_?.feedbackHash && /application\/json/.test(file.type), `${keccak256(toHex(file.text))} vs ${args_?.feedbackHash}`);
  const f = JSON.parse(file.text) as { agentRegistry: string; agentId: number; clientAddress: string; value: number; tag1: string; proofOfPayment?: { fromAddress: string; txHash: string }; factor: { job: number; outcome: string; customer: string } };
  check("it is laid out as ERC-8004 says, with the payment's proof and Factor's part", f.agentRegistry === `eip155:4663:${IDENTITY_REGISTRY}` && String(f.agentId) === id && f.clientAddress.toLowerCase() === `eip155:4663:${bot}` && f.value === 100 && f.tag1 === "factor" && f.proofOfPayment?.fromAddress.toLowerCase() === customer.address && f.factor.job === paid && f.factor.outcome === "paid in full", file.text.slice(0, 160));
  const gases = await Promise.all(e!.items.map(async (x) => (await chain.getTransactionReceipt({ hash: x.tx as Hex })).gasUsed));
  console.log(`  gas used by each entry, newest first: ${gases.join(", ")}`);

  step("6  what the registry itself holds to");
  let selfRefused = "";
  try {
    await chain.simulateContract({ address: REPUTATION_REGISTRY, abi: REPUTATION, functionName: "giveFeedback", args: [BigInt(id), 100n, 0, "factor", "job", "", "", `0x${"0".repeat(64)}`], account: agent.address as Hex });
  } catch (err) { selfRefused = (err as Error).message; }
  check("the identity's owner cannot write to its own reputation", /Self-feedback not allowed/.test(selfRefused), selfRefused.split("\n")[0]);

  step("7  each job once");
  await sleep(8000);
  const last = await chain.readContract({ address: REPUTATION_REGISTRY, abi: REPUTATION, functionName: "getLastIndex", args: [BigInt(id), bot] });
  check("more passes later, the registry still holds three entries from Factor for it", last === 3n, String(last));

  step("8  an agent with two identities: none is picked, and it signs which one is its own");
  // its two identities are made before it joins the desk: Factor reads the whole registry soon after an agent joins
  const second = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  const a1 = (await second.registerErc8004()).agentId;
  const a2 = (await second.registerErc8004()).agentId;
  await sleep(6000);
  await second.signUp({ name: "chart-hand", does: "Draws the charts for a weekly note" });
  let s2 = await second.erc8004();
  for (let i = 0; i < 60 && (s2?.found.length ?? 0) < 2; i++) { await sleep(1000); s2 = await second.erc8004().catch(() => null); }
  check("both are found, and neither is linked by itself", s2?.erc8004 === null && s2.found.map((x) => x.agentId).join(",") === `${a1},${a2}`, JSON.stringify(s2?.found));
  let refusedOther = "";
  try { await second.linkErc8004(id); } catch (err) { refusedOther = err instanceof Refusal ? err.message : String(err); }
  check("it cannot link another agent's identity", /is not this agent's/.test(refusedOther), refusedOther);
  const linked = await second.linkErc8004(a2);
  s2 = await second.erc8004();
  check("it signs which one: linked, by its signature", linked.agentId === a2 && s2?.erc8004?.agentId === a2 && s2.erc8004.linked === "signed");
  const { jobId: j2 } = await customer.hire({ agent: "chart-hand", price: "0.002", title: "Three charts for the note", dueInHours: 24 });
  await second.deliver(j2, "Three charts.");
  await customer.accept(j2);
  let e2 = (await second.erc8004())?.erc8004;
  for (let i = 0; i < 60 && !e2?.entries; i++) { await sleep(1000); e2 = (await second.erc8004())?.erc8004; }
  check("its settled job is written to the identity it signed", e2?.entries === 1 && e2.items[0]?.job === j2 && (await chain.readContract({ address: REPUTATION_REGISTRY, abi: REPUTATION, functionName: "getLastIndex", args: [BigInt(a2), bot] })) === 1n && (await chain.readContract({ address: REPUTATION_REGISTRY, abi: REPUTATION, functionName: "getLastIndex", args: [BigInt(a1), bot] })) === 0n);

  step("9  the agent's page, its record, the docs, and the assistant's tool");
  const page = words((await get("/agents/ledger-scribe")).text);
  check("its page shows ERC-8004 by its name and the section with the three entries", page.includes(`ERC-8004 #${id}`) && page.includes("On ERC-8004") && page.includes("83.3 of 100") && page.includes(`getSummary(${id}`), page.slice(page.indexOf("On ERC-8004"), page.indexOf("On ERC-8004") + 200));
  const rec = JSON.parse((await get("/api/v1/record/ledger-scribe")).text) as { erc8004?: { agentId: string; entries: number } | null };
  check("its record carries erc8004", rec.erc8004?.agentId === id && rec.erc8004.entries === 3);
  check("the docs explain it", words((await get("/docs")).text).includes("Every settled job, on the open standard"));
  const text = (await runTool(customer, "factor_erc8004", { agent: "ledger-scribe" }, null)).text;
  check("the tool says it in words, read from the chain", text.includes(`ERC-8004 identity #${id}`) && text.includes("3 entries, average 83 of 100"), text.split("\n")[1]);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  if (args.includes("--stay")) {
    console.log(`Left running: the site on ${SITE}, the engine on ${bare.api}, the fork on ${bare.rpc}.`);
    console.log(JSON.stringify({ site: SITE, rpc: bare.rpc, agentId: id, jobs: { past, paid, half }, second: { a1, a2, job: j2 } }));
  }
}

void main();
