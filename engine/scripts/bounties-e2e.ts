// Bounties, end to end, on a LOCAL fork of Robinhood Chain: the fork (read through the rehearsal's own go-between,
// scripts/rehearsal-node.ts), Factor's contracts deployed there by the engine's own script, the line contract and then the
// bounty contract deployed by their one-command scripts (contracts/deploy-bounties.sh is the one the owner or the demo
// wallet runs), the engine with BOUNTIES=on and BOUNTIES_HOUSE=on, a stand-in for the model maker (scripts/stub-model.ts),
// and the site in front of it, all on 127.0.0.1. Nothing here reaches the real chain, and no model is called.
//
//   npm run bounties-e2e            every check, then everything is stopped
//   npm run bounties-e2e -- --stay  everything is left running (the site on 3870) for pictures
//   npm run bounties-e2e -- --stop  stops what --stay left running
//
// What it does, through the site's own doors for everything that is not a transaction:
//   1  bounties are on at the contract the one command deployed, wired to the desk, the line contract and the burn pot
//   2  a poster locks a prize; its words arrive; agents enter with hidden work and a bond; Factor's own agent enters by
//      itself with real work from its service (a stub model); the page shows a count, and no door shows the work
//   3  from the deadline the poster reads by signature; nobody else can; no entry can be added; the poster picks
//   4  a win through the desk: the keeper sends the bonds back, the winner delivers its entry's hash, the keeper accepts on
//      the desk, the winner is paid to the wei, and it is on the record, in the score's income and on the winner page
//   5  no pick in 3 days: the keeper splits the prize, to the wei, and the 1% burns
//   6  a winner who never delivers: past the due time and the grace the keeper refunds the desk job and pays the others
//   7  a winner who declines: the same at once
//   8  a house agent that wins delivers its entry by itself, with no second question to the model
//   9  nobody entered: the keeper sends everything back to the poster
//  10  what nobody can do, and the owner's switch
//
// Keys: anvil's built-in test keys (inside the engine's script) and keys made up here for this run, funded on the fork.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, formatEther, http, keccak256, parseEther, toHex, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { factorBountyAbi, factorDeskAbi } from "../src/abi/index.js";

const ENGINE = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const WEB = join(ENGINE, "..", "web");
const PORTS = { site: 3870, anvil: 3871, engine: 3872, model: 3873, source: 3874 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-bounties-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ADMIN_API_KEY = "e2e-owner-key-of-this-local-run"; // the engine script's own, for this local run only
const args = process.argv.slice(2);
mkdirSync(WORK, { recursive: true });
const E2E_ENV = { E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK, E2E_FORK_URL: `http://127.0.0.1:${PORTS.source}`, E2E_LINES: "on", E2E_BOUNTIES: "on" };

const step = (title: string) => console.log(`\n== ${title}`);
const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T | null> => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } if (Date.now() - t0 > ms) { console.log(`  gave up waiting for ${what}`); return null; } await sleep(700); } };
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
const textHash = (t: string): Hex => keccak256(toHex(t));

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
  const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8")) as { rpc: string; api: string; desk: Hex; burnPot: Hex; token: Hex; keys: Hex[]; line: Hex; bounty: Hex; dataDir: string; adminKey?: string };
  const deployLog = readFileSync(join(WORK, "deploy-bounties.log"), "utf8");
  console.log(deployLog.split("\n").filter((l) => /gas, |about \$|it would be at|bounty  |OK:/.test(l)).map((l) => `     ${l.trim()}`).join("\n"));
  const rpc = async (method: string, params: unknown[]) => (await (await fetch(bare.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result?: unknown };
  for (const a of ["0x0000F90827F1C53a10cb7A02335B175320002935", "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02"]) await rpc("anvil_setCode", [a, "0x"]);
  const siteLog = openSync(join(WORK, "site.log"), "a");
  spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORTS.site)], { cwd: WEB, stdio: ["ignore", siteLog, siteLog], detached: true, env: { ...process.env, FACTOR_ENGINE_URL: bare.api, FACTOR_SAMPLE: "", PORT: String(PORTS.site) } }).unref();
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${SITE}/api/v1/state`)).ok) break; } catch { /* starting */ } await sleep(500); }
  const chainDef = defineChain({ id: 4663, name: "Robinhood Chain (local fork)", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [bare.rpc] } } });
  const chain = createPublicClient({ chain: chainDef, transport: http(bare.rpc) });
  const fund = async (address: string, e: string) => { await rpc("anvil_setBalance", [address, `0x${parseEther(e).toString(16)}`]); };
  const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: chainDef, transport: http(bare.rpc) });
  const sendFrom = async (k: Hex, to: Hex, abi: Abi, functionName: string, a: unknown[], value = 0n) => {
    const hash = await wallet(k).writeContract({ address: to, abi, functionName, args: a, value } as never);
    const r = await chain.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 250 });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return { hash, gas: r.gasUsed * r.effectiveGasPrice };
  };
  const refusedWith = async (k: Hex, functionName: string, a: unknown[], value = 0n): Promise<string> => { try { await chain.simulateContract({ address: bare.bounty, abi: B, functionName, args: a, account: privateKeyToAccount(k), value } as never); return "went through"; } catch (e) { return String((e as { shortMessage?: string; message?: string }).message ?? e); } };
  const get = async (path: string) => { const r = await fetch(`${SITE}${path}`); return { status: r.status, text: (await r.text()).replace(/<!-- -->/g, "") }; };
  const api = async <T = Record<string, unknown>>(path: string) => JSON.parse((await get(`/api/v1/${path}`)).text) as T;
  const post = async (path: string, body: unknown) => { const r = await fetch(`${SITE}/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
  const words = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
  const warp = async (s: number) => { await rpc("evm_increaseTime", [s]); await rpc("evm_mine", []); };
  const blockTime = async () => Number((await chain.getBlock()).timestamp);
  const balance = (a: Hex) => chain.getBalance({ address: a });
  const K = { poster: generatePrivateKey(), a1: generatePrivateKey(), a2: generatePrivateKey(), a3: generatePrivateKey(), stranger: generatePrivateKey() };
  writeFileSync(join(WORK, "bounties-keys.json"), JSON.stringify(K, null, 2), { mode: 0o600 });
  for (const k of Object.values(K)) await fund(privateKeyToAccount(k).address, "10");
  const POSTER = privateKeyToAccount(K.poster).address.toLowerCase() as Hex;
  const A1 = privateKeyToAccount(K.a1).address.toLowerCase() as Hex;
  const A2 = privateKeyToAccount(K.a2).address.toLowerCase() as Hex;
  const A3 = privateKeyToAccount(K.a3).address.toLowerCase() as Hex;
  const bt = bare.bounty;
  const read = <T>(fn: string, a: unknown[] = []) => chain.readContract({ address: bt, abi: B, functionName: fn, args: a }) as Promise<T>;
  type Row = { state: number; job: bigint; winner: string; prize: bigint; bond: bigint; deadline: number };
  const bountyOf = (id: number) => read<Row>("bounty", [BigInt(id)]);
  const deskJob = (id: number | bigint) => chain.readContract({ address: bare.desk, abi: D, functionName: "job", args: [BigInt(id)] }) as Promise<{ state: number; proof: string; customer: string; price: bigint; agent: string; dueAt: number }>;
  const entryHash = (id: number, agent: string, work: string): Hex => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }], [bt, BigInt(id), agent as Hex, textHash(work)]));
  const PRIZE = parseEther("0.01"), FEE = parseEther("0.0001"), BOND = parseEther("0.0001");
  const postBounty = async (task: string, openS = 2 * HOUR, prize = PRIZE) => {
    const deadline = (await blockTime()) + openS;
    const fee = prize / 100n;
    await sendFrom(K.poster, bt, B, "post", [prize, BigInt(deadline), 0n, textHash(task)], prize + fee);
    const id = Number(await read<bigint>("bountyCount"));
    const t = await until("the task to be taken", async () => (await post("bounties/task", { id, task })).status === 200);
    check(`bounty ${id}: its words are taken because they hash to what it holds`, !!t);
    return id;
  };
  const enter = async (k: Hex, agent: Hex, id: number, work: string, bond = BOND) => {
    const hash = entryHash(id, agent, work);
    const out = await sendFrom(k, bt, B, "enter", [BigInt(id), agent, hash], bond);
    const r = await until("the work to be taken", async () => (await post("bounties/entry", { id, agent, work })).status === 200, 30_000);
    return { hash, gas: out.gas, taken: !!r };
  };
  const stateIs = (id: number, state: number) => until(`bounty ${id} to reach state ${state}`, async () => (await bountyOf(id)).state === state, 240_000);
  const PAGE_SMITH = (await until("page-smith on the site", async () => { const x = await api<{ agent?: { address: string } }>("agents/page-smith"); return x.agent?.address ?? null; }, 120_000)) as Hex | null;
  if (!PAGE_SMITH) throw new Error("page-smith is not on the desk");
  await fund(PAGE_SMITH, "1");

  step("1  bounties are on at the contract the one command deployed");
  const about = await until("bounties on at the site", async () => { const a = await api<{ enabled: boolean; contract: string }>("bounties/about"); return a.enabled ? a : null; }, 90_000);
  check("the site and the engine say bounties are on, at the deployed contract", about?.contract?.toLowerCase() === bt.toLowerCase());
  const wire = await Promise.all(["desk", "line", "burnPot"].map((f) => read<string>(f)));
  check("the bounty contract reads the desk and its burn pot, and is given the line contract", wire[0]!.toLowerCase() === bare.desk.toLowerCase() && wire[1]!.toLowerCase() === bare.line.toLowerCase() && wire[2]!.toLowerCase() === bare.burnPot.toLowerCase());
  check("the state says it too, and the board page stands", words((await get("/bounties")).text).includes("Lock a prize"));
  for (const k of [K.a1, K.a2, K.a3]) await sendFrom(k, bare.desk, D, "register", []);
  await until("the agents to be read", async () => (await api<{ agent?: unknown }>(`agents/${A1}`)).agent, 60_000);

  step("2  a prize, hidden entries, and Factor's own agent entering by itself");
  const TASK1 = "A landing page for our tea shop\n\nWe sell loose leaf tea, posted weekly. Say what it is, who it is for, and end with a link to the shop.";
  // what reaches the burn pot is read from the contract's own count: the keeper's burns spend the pot's balance at any moment
  const burned = () => read<bigint>("totalBurned");
  const potOwed = () => read<bigint>("owed", [bare.burnPot]);
  const burnedAtPost = await burned();
  const b1 = await postBounty(TASK1);
  check("the poster sent the prize and 1%; nothing is burned yet", (await read<bigint>("held")) === PRIZE + FEE && (await burned()) === burnedAtPost);
  const SECRET1 = "THE-FIRST-AGENTS-SECRET-WORK: three paragraphs on loose leaf tea, finished.";
  const SECRET2 = "THE-SECOND-AGENTS-SECRET-WORK: a shorter and better one.";
  const e1 = await enter(K.a1, A1, b1, SECRET1);
  check("an agent enters: the hash on the chain has its address in it, and its work is taken", e1.taken && (await read<{ hash: string }>("entryOf", [BigInt(b1), A1])).hash === e1.hash);
  const e2 = await enter(K.a2, A2, b1, SECRET2);
  check("a second enters", e2.taken);
  check("work that does not hash to what the agent committed is refused", (await post("bounties/entry", { id: b1, agent: A1, work: "something else" })).status === 409);
  check("another agent's work, under an address that has not entered, is refused", (await post("bounties/entry", { id: b1, agent: A3, work: SECRET1 })).status === 404);
  const house = await until("page-smith's entry", async () => (await api<{ entered: boolean; workShown: boolean }>(`bounties/${b1}/mine/${PAGE_SMITH}`)).workShown, 180_000);
  check("Factor's own page-smith entered by itself, with work from its own service", !!house);
  check("its bond came from its own account", (await balance(PAGE_SMITH)) === parseEther("1") - BOND);
  const shown = await until("three entries on the page", async () => (await api<{ entries: number }>(`bounties/${b1}`)).entries === 3 ? true : null, 60_000);
  check("the page shows a count of 3, and no door shows any work", !!shown);
  const doors = [`/bounties/${b1}`, "/bounties", `/api/v1/bounties/${b1}`, "/api/v1/bounties", `/api/v1/bounties/poster/${POSTER}`, `/api/v1/bounties/agent/${A1}`, `/api/v1/bounties/${b1}/mine/${A1}`, "/api/v1/state", `/agents/${A1}`];
  let leaked = "";
  for (const d of doors) { const t = (await get(d)).text; if (t.includes("SECRET-WORK")) leaked = d; }
  check("not one of the site's doors shows a hidden work", !leaked, leaked);
  check("the whole of an entry cannot be asked for", (await get(`/api/v1/bounties/${b1}/entries/${A1}`)).status === 404);
  const pageOpen = words((await get(`/bounties/${b1}`)).text);
  check("the page says they are hidden, and shows the countdown and the count", pageOpen.includes("Hidden until a winner is picked") && pageOpen.includes("Entries close in") && pageOpen.includes("3 of 25"));
  const signAt = await blockTime();
  const message = (id: number, poster: string, at: number) => ["Factor: read the entries of a bounty", `bounty: ${id}`, `poster: ${poster}`, `at: ${at}`].join("\n");
  const sigEarly = await privateKeyToAccount(K.poster).signMessage({ message: message(b1, POSTER, signAt) });
  const early = await post("bounties/read", { id: b1, poster: POSTER, at: signAt, signature: sigEarly });
  check("before the deadline not even the poster can read: its second wallet could still enter", early.status === 409);

  step("3  from the deadline the poster reads, and nobody else; nobody can enter; the poster picks");
  await warp(2 * HOUR + 1);
  // the engine's clock follows the fork's within a pass or two of the warp, and a signature holds ten minutes either way
  const readBy = async (k: Hex, want: number) => until(`a read that answers ${want}`, async () => { const at = await blockTime(); const signature = await privateKeyToAccount(k).signMessage({ message: message(b1, POSTER, at) }); const a = await post("bounties/read", { id: b1, poster: POSTER, at, signature }); return a.status === want ? a : null; }, 60_000);
  check("nobody can enter once the poster can read", /TooLate/.test(await refusedWith(K.a3, "enter", [BigInt(b1), A3, keccak256("0x01")], BOND)));
  check("a stranger's signature in the poster's name reads nothing", !!(await readBy(K.stranger, 401)));
  const read1 = (await readBy(K.poster, 200))!;
  const items = read1.body.items as { agent: string; work?: string; shown: boolean; house: boolean }[];
  check("the poster reads all three, by its signature, with the work whole", read1.status === 200 && items.length === 3 && items[0]?.work === SECRET1 && items[1]?.work === SECRET2);
  check("page-smith's work is a whole page from its service, marked as Factor's own", !!items.find((x) => x.agent === PAGE_SMITH && x.house && /<!doctype html/i.test(x.work ?? "")));
  check("still hidden from everybody else", !(await get(`/bounties/${b1}`)).text.includes("SECRET-WORK"));
  check("a stranger cannot pick", /NotPoster/.test(await refusedWith(K.stranger, "pick", [BigInt(b1), A1])));
  check("the poster cannot pick an address that did not enter", /NotAnEntrant/.test(await refusedWith(K.poster, "pick", [BigInt(b1), A3])));

  step("4  a win through the desk");
  const burnedBefore = await burned();
  const a2Before = await balance(A2);
  const houseBefore = await balance(PAGE_SMITH);
  await sendFrom(K.poster, bt, B, "pick", [BigInt(b1), A1]);
  const job1 = (await bountyOf(b1)).job;
  const j1 = await deskJob(job1);
  check("the prize is a job on the desk: the bounty contract its customer, the winner its agent, the whole prize its price", j1.customer.toLowerCase() === bt.toLowerCase() && j1.agent.toLowerCase() === A1 && j1.price === PRIZE && j1.state === 1, `job ${job1}`);
  check("the 1% reached the burn pot at the pick", (await burned()) - burnedBefore === FEE && (await potOwed()) === 0n);
  const bonds = await until("the keeper to send the bonds back", async () => (await balance(A2)) - a2Before === BOND && (await balance(PAGE_SMITH)) - houseBefore === BOND, 120_000);
  check("the keeper sent the others' bonds back by itself, without waiting for the winner", !!bonds);
  const open1 = await until("every entry public", async () => { const t = words((await get(`/bounties/${b1}`)).text); return t.includes("Every entry, in the open") && t.includes("THE-SECOND-AGENTS-SECRET-WORK") ? t : null; }, 60_000);
  check("from the pick every entry is public beside the winner", !!open1 && open1.includes("Winner"));
  const a1Before = await balance(A1);
  const pool = (await chain.readContract({ address: bare.desk, abi: D, functionName: "pool" })) as bigint;
  const d1 = await sendFrom(K.a1, bare.desk, D, "deliver", [job1, e1.hash]);
  const won = await stateIs(b1, 3);
  check("the winner delivered its entry's hash, and the keeper accepted on the desk by itself", !!won && (await deskJob(job1)).state === 4);
  check("the winner is paid to the wei: 98% of the prize and its bond", (await balance(A1)) - a1Before + d1.gas === parseEther("0.0098") + BOND, formatEther((await balance(A1)) - a1Before + d1.gas));
  check("the desk's 2% reached the pool", ((await chain.readContract({ address: bare.desk, abi: D, functionName: "pool" })) as bigint) - pool >= parseEther("0.0002"));
  check("nothing is left in the contract for it", (await read<bigint>("bonds")) === 0n && (await read<bigint>("atDesk")) === 0n && (await balance(bt)) === 0n);
  const page1 = await until("the win on the agent's page", async () => { const x = await api<{ bounties?: { won: number; wonEth: number; entered: number }; factorScore?: { income: { source: string; settled: number; valueEth: number }[] } }>(`agents/${A1}`); return x.bounties?.won === 1 ? x : null; }, 90_000);
  check("the win is on its page, and in the Factor Score's income as a source of its own", page1?.bounties?.wonEth === 0.01 && page1.factorScore?.income.find((l) => l.source === "bounties")?.settled === 1);
  const rec = await until("the record", async () => { const r = await api<{ bounties?: { won: number }; jobs: { settled: number } }>(`record/${A1}`).catch(() => null); return r?.bounties?.won === 1 ? r : null; }, 30_000);
  check("the record says it, and the desk counts the job", (rec?.jobs.settled ?? 0) === 1 || (await chain.readContract({ address: bare.desk, abi: D, functionName: "score", args: [A1] })) as bigint >= 10n);
  const jobPage = words((await get(`/jobs/${String(job1).padStart(4, "0")}`)).text);
  check("the job's page names the bounty, and shows the work", jobPage.includes(`bounty ${b1}`) && jobPage.includes("SECRET-WORK"));
  check("the winner page says what became of the prize", words((await get(`/bounties/${b1}`)).text).includes("delivered its entry and was paid"));
  check("the poster's history is public", (await api<{ posted: number; won: number; picks: { winner: string }[] }>(`bounties/poster/${POSTER}`)).picks[0]?.winner === A1);

  step("5  no pick in 3 days: the prize is split between the entrants");
  const b2 = await postBounty("Plant a tree in my garden\n\nA real tree, by a real person, this week.");
  await enter(K.a1, A1, b2, "I would plant an oak.");
  await enter(K.a2, A2, b2, "I would plant a birch.");
  await enter(K.a3, A3, b2, "I would plant an apple tree.");
  const [s1, s2, s3, pot2, pos2] = await Promise.all([balance(A1), balance(A2), balance(A3), burned(), balance(POSTER)]);
  await warp(2 * HOUR + 1 + 3 * DAY - 120);
  await sleep(2500);
  check("the keeper does not split before the 3 days are over", (await bountyOf(b2)).state === 1);
  await warp(180);
  const splitDone = await stateIs(b2, 4);
  const share = PRIZE / 3n, dust = PRIZE - share * 3n;
  check("past the 3 days the keeper split it by itself, to the wei", !!splitDone && (await balance(A1)) - s1 === share + BOND && (await balance(A2)) - s2 === share + BOND && (await balance(A3)) - s3 === share + BOND);
  check("the 1% and the dust were burned, and the poster has nothing back", (await burned()) - pot2 === FEE + dust && (await potOwed()) === 0n && (await balance(POSTER)) === pos2);
  check("no house agent entered a task none of them can do", !(await api<{ entered: boolean }>(`bounties/${b2}/mine/${PAGE_SMITH}`)).entered);
  check("the split is on the agent's page, apart from the wins", !!(await until("the split on its page", async () => ((await api<{ bounties?: { splitEth: number } }>(`agents/${A1}`)).bounties?.splitEth ?? 0) > 0, 60_000)));

  step("6  a winner who never delivers");
  const b3 = await postBounty("Plant a second tree\n\nAnother one, next to the first.");
  await enter(K.a1, A1, b3, "An oak again.");
  await enter(K.a2, A2, b3, "A birch again.");
  await warp(2 * HOUR + 1);
  await sendFrom(K.poster, bt, B, "pick", [BigInt(b3), A1]);
  const job3 = (await bountyOf(b3)).job;
  await until("the bonds back", async () => (await read<bigint>("bonds")) === BOND, 60_000);
  const [w3, o3, pot3] = await Promise.all([balance(A1), balance(A2), burned()]);
  await warp(3 * DAY + 12 * HOUR + 60);
  const und = await stateIs(b3, 5);
  check("past the due time and the grace the keeper refunded the desk job and closed the bounty", !!und && (await deskJob(job3)).state === 7);
  check("the prize and the winner's bond went to the other entrant", (await balance(A2)) - o3 === PRIZE + BOND && (await balance(A1)) === w3 && (await burned()) === pot3);
  check("the desk's push reached the contract within its gas: nothing waits for it", ((await chain.readContract({ address: bare.desk, abi: D, functionName: "owed", args: [bt] })) as bigint) === 0n && (await balance(bt)) === 0n);
  check("the winner has no mark but unanswered, as with any job it never touched", (await chain.readContract({ address: bare.desk, abi: D, functionName: "agent", args: [A1] }) as { unanswered: number; barred: boolean }).barred === false);

  step("7  a winner who declines, with nobody else in");
  const b4 = await postBounty("Plant a third tree\n\nA last one.");
  await enter(K.a3, A3, b4, "An apple tree again.");
  await warp(2 * HOUR + 1);
  await sendFrom(K.poster, bt, B, "pick", [BigInt(b4), A3]);
  const job4 = (await bountyOf(b4)).job;
  const [pos4, pot4] = await Promise.all([balance(POSTER), burned()]);
  await sendFrom(K.a3, bare.desk, D, "decline", [job4]);
  const dec = await stateIs(b4, 5);
  check("the keeper closed it at once: the prize back to the poster, the winner's bond to the burn pot", !!dec && (await balance(POSTER)) - pos4 === PRIZE && (await burned()) - pot4 === BOND && (await potOwed()) === 0n);

  step("8  a house agent that wins delivers by itself, with no second question to the model");
  const TASK5 = "A landing page for our bike shop\n\nWe mend bicycles while you wait. Say what it is, who it is for, and end with a link to the shop.";
  const b5 = await postBounty(TASK5);
  await until("page-smith's entry", async () => (await api<{ workShown: boolean }>(`bounties/${b5}/mine/${PAGE_SMITH}`)).workShown, 180_000);
  const db = new Database(join(bare.dataDir, "factor.db"), { readonly: true });
  const costOf = () => (db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cost_micro), 0) AS c FROM bounty_house WHERE cost_micro > 0").get() as { n: number; c: number });
  const asked = costOf();
  check("each of its entries asked the model once, and what it cost is kept against its own cap", asked.n === 2 && asked.c > 0, `${asked.n} questions, $${(asked.c / 1e6).toFixed(4)}`);
  await warp(2 * HOUR + 1);
  await sendFrom(K.poster, bt, B, "pick", [BigInt(b5), PAGE_SMITH]);
  const job5 = (await bountyOf(b5)).job;
  const before5 = await balance(PAGE_SMITH);
  const won5 = await stateIs(b5, 3);
  check("page-smith delivered its entry by itself, with its entry's hash, and the keeper closed it", !!won5 && (await deskJob(job5)).proof === (await read<{ hash: string }>("entryOf", [BigInt(b5), PAGE_SMITH])).hash);
  check("it is paid in its own account: 98% and its bond", (await balance(PAGE_SMITH)) - before5 === parseEther("0.0098") + BOND);
  check("no second question to the model, and the desk's job flow did not ask either", costOf().n === 2 && (db.prepare("SELECT cost_micro FROM house_jobs WHERE job_id = ?").get(Number(job5)) as { cost_micro: number } | undefined)?.cost_micro === 0);
  db.close();

  step("9  nobody entered: everything back");
  const b6 = await postBounty("Plant a fourth tree\n\nNobody will.", HOUR + 10);
  const pos6 = await balance(POSTER);
  await warp(HOUR + 11);
  const emp = await stateIs(b6, 6);
  check("from the deadline the keeper sent the prize and the 1% back to the poster", !!emp && (await balance(POSTER)) - pos6 === PRIZE + FEE);
  check("the page says nobody entered", words((await get(`/bounties/${b6}`)).text).includes("Nobody entered"));

  step("10  what nobody can do, and the owner's switch");
  const b7 = await postBounty("Plant a fifth tree\n\nFor the checks.");
  await enter(K.a1, A1, b7, "An oak once more.");
  check("the poster cannot enter its own bounty", /OwnBounty|NotRegistered/.test(await refusedWith(K.poster, "enter", [BigInt(b7), POSTER, keccak256("0x02")], BOND)));
  check("nobody enters twice", /AlreadyIn/.test(await refusedWith(K.a1, "enter", [BigInt(b7), A1, keccak256("0x03")], BOND)));
  check("nobody enters for another agent", /NotAgent/.test(await refusedWith(K.stranger, "enter", [BigInt(b7), A2, keccak256("0x04")], BOND)));
  check("a wrong bond is refused", /WrongValue/.test(await refusedWith(K.a2, "enter", [BigInt(b7), A2, keccak256("0x05")], BOND - 1n)));
  check("plain ETH is refused", await wallet(K.stranger).sendTransaction({ to: bt, value: 1n }).then(() => false).catch(() => true));
  const adminKey = bare.adminKey ?? ADMIN_API_KEY;
  const sw = await fetch(`${bare.api}/v1/admin/switch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": adminKey, authorization: `Bearer ${adminKey}` }, body: JSON.stringify({ what: "bounties", on: false, note: "a check" }) });
  check("the owner's switch stops it", sw.ok, String(sw.status));
  const off = await until("the board empty", async () => { const a = await api<{ enabled: boolean; items: unknown[] }>("bounties"); return !a.enabled && a.items.length === 0; }, 30_000);
  check("switched off, the site says bounties are off and shows none, and nothing on the chain has changed", !!off && (await bountyOf(b7)).state === 1);
  const swOn = await fetch(`${bare.api}/v1/admin/switch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": adminKey, authorization: `Bearer ${adminKey}` }, body: JSON.stringify({ what: "bounties", on: true }) });
  check("turned back, they return", swOn.ok && !!(await until("the board back", async () => (await api<{ enabled: boolean }>("bounties")).enabled, 30_000)));
  await warp(2 * HOUR + 1 + 3 * DAY + 10);
  await stateIs(b7, 4);

  step("the end: the contract's books");
  const [held, bonds2, owedT, atDesk, totalPrizes, tWon, tSplit, tBack, bal] = await Promise.all([read<bigint>("held"), read<bigint>("bonds"), read<bigint>("owedTotal"), read<bigint>("atDesk"), read<bigint>("totalPrizes"), read<bigint>("totalWon"), read<bigint>("totalSplit"), read<bigint>("totalReturned"), balance(bt)]);
  check("nothing held, no bond out, nothing at the desk, not a wei in the contract", held === 0n && bonds2 === 0n && owedT === 0n && atDesk === 0n && bal === 0n, `${formatEther(bal)} ETH`);
  check("every prize ended once: won, split or back", totalPrizes === tWon + tSplit + tBack);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  if (args.includes("--stay")) { console.log(`Left running: the site on ${SITE}. Stop it with: npm run bounties-e2e -- --stop`); process.exit(failed.length ? 1 : 0); }
  await stopAll();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  if (!args.includes("--stay")) await stopAll();
  process.exit(1);
});
