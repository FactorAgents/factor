// The kit against the real contracts, end to end, on a LOCAL fork of Robinhood Chain: the library as an agent and
// as a customer, and the assistant's tools through a real client. Nothing here can reach the real chain.
//
//   npm run e2e    the whole run and every check, then everything is stopped (about four minutes)
//
// It starts from what the engine's own script leaves running (engine/scripts/e2e.ts --bare): the fork, the three
// contracts, the engine, and a launched and traded token, so there is a pool.
//
// Keys: only anvil's built-in test keys, which anvil prints for anybody. They hold nothing on any real chain.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPublicClient, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Factor, proofOf, Refusal, type Job } from "../src/index.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WORK = join(tmpdir(), "factor-e2e");

const step = (title: string) => console.log(`\n== ${title}`);
const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
const refused = async (p: Promise<unknown>): Promise<string> => { try { await p; return ""; } catch (e) { return e instanceof Refusal ? e.message : `NOT A REFUSAL: ${(e as Error).message}`; } };
const stopAll = () => spawnSync("npm", ["run", "e2e", "--", "--stop"], { cwd: ENGINE, encoding: "utf8" });

async function main(): Promise<void> {
  step("1  the fork, the contracts, the engine and a traded token (the engine's own script), and the kit built");
  const bareRun = spawnSync("npm", ["run", "e2e", "--", "--bare"], { cwd: ENGINE, encoding: "utf8", timeout: 600_000 });
  if (bareRun.status !== 0) throw new Error(`the engine's script failed:\n${bareRun.stdout.split("\n").slice(-20).join("\n")}`);
  const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8")) as { rpc: string; api: string; desk: `0x${string}`; keys: `0x${string}`[] };
  const built = spawnSync("npm", ["run", "build"], { cwd: KIT, encoding: "utf8" });
  check("the kit builds", built.status === 0, built.status === 0 ? "" : built.stdout.slice(-300));
  const [agentKey, customerKey, assistantKey] = [bare.keys[3], bare.keys[4], bare.keys[5]];
  const where = { api: `${bare.api}/v1`, rpcUrl: bare.rpc };
  const chain = createPublicClient({ transport: http(bare.rpc) });
  const DESK = parseAbi([
    "function job(uint256) view returns ((address customer, uint40 dueAt, uint40 deliveredAt, uint8 state, bool allowEarly, bool late, address agent, uint256 price, uint256 early, uint256 fromPool, bytes32 proof))",
    "function agent(address) view returns ((bool registered, bool barred, uint40 firstSettledAt, uint32 settled, uint32 settledAtHalf, uint32 notDelivered, uint32 unanswered, uint32 customers, uint32 onTime, uint32 late, uint32 advancesRepaid, uint32 advancesNotRepaid, uint32 earlyKept, uint256 bond, uint256 feesPaid, uint256 advancedNow, uint256 volume))",
    "function jobCount() view returns (uint256)", "function held() view returns (uint256)",
  ]);
  const desk = <T>(functionName: "job" | "agent" | "jobCount" | "held", args: unknown[] = []) => chain.readContract({ address: bare.desk, abi: DESK, functionName, args } as never) as Promise<T>;
  const balance = (a: string) => chain.getBalance({ address: a as `0x${string}` });

  step("2  the library, as an agent and as a customer");
  const reader = await Factor.connect(where);
  const agent = await Factor.connect({ ...where, privateKey: agentKey });
  const customer = await Factor.connect({ ...where, privateKey: customerKey });
  check("it connects: the desk from the site, checked on the chain", agent.desk === bare.desk.toLowerCase() && reader.address === null && agent.address === privateKeyToAccount(agentKey).address.toLowerCase());
  check("hiring a wallet that is not an agent is refused in words, and nothing is sent", (await refused(customer.hire({ agent: agent.address!, price: "0.01" }))) === "That wallet has not registered as an agent." && (await desk<bigint>("jobCount")) === 0n);
  await agent.register();
  check("the agent registers", (await desk<{ registered: boolean }>("agent", [agent.address])).registered);
  check("registering twice is refused in words", (await refused(agent.register())) === "This wallet is already registered as an agent.");
  await agent.profile({ name: "lumen-07", does: "Summarises long documents and contracts" });
  const page = await agent.me();
  check("its signed name shows on the site", page?.agent.name === "lumen-07" && page.agent.named && page.agent.does === "Summarises long documents and contracts");
  await agent.addBond("0.004");
  check("its bond is in the desk", (await desk<{ bond: bigint }>("agent", [agent.address])).bond === parseEther("0.004"));
  check("the smallest job is said in words", (await refused(customer.hire({ agent: "lumen-07", price: "0.0001" }))) === "The smallest job is 0.001 ETH.");

  // the agent waits for work, the customer hires it by name
  const stop = new AbortController();
  const waiting = (async (): Promise<Job | null> => { for await (const j of agent.jobsForMe({ pollMs: 700, signal: stop.signal })) return j; return null; })();
  const customerBefore = await balance(customer.address!);
  const hired = await customer.hire({ agent: "lumen-07", price: "0.01", title: "Summarise a 40-page service agreement", allowEarly: true });
  check("the customer hires the agent by name: the job has its number and its signed title", hired.jobId === 1 && hired.titled && /^0x[0-9a-f]{64}$/.test(hired.hash));
  const spent = customerBefore - (await balance(customer.address!));
  check("the price left the customer's wallet and the desk holds it", spent >= parseEther("0.01") && (await desk<bigint>("held")) === parseEther("0.01"));
  const seen = await waiting;
  stop.abort();
  check("the agent's loop is handed the new job", seen?.n === 1 && seen.priceEth === 0.01 && seen.allowEarly === true, seen ? `job ${seen.n}, ${seen.state}` : "nothing");

  const can = await agent.canDraw(1);
  check("the desk says what can be drawn: 0.004 from the pool (the bond), 0.005 early (half the job)", can.fromPool === "0.004" && can.early === "0.005");
  check("only the job's agent can draw on it", (await refused(customer.draw(1, "0.001"))) === "Only the job's agent can do this.");
  await agent.draw(1, can.fromPool, "pool");
  await agent.draw(1, "0.001", "early");
  check("a draw past half of the job is refused in words", (await refused(agent.draw(1, "0.001", "early"))) === "Half of this job is already advanced. Nothing more can be drawn on it.");
  const drawn = await desk<{ early: bigint; fromPool: bigint; state: number }>("job", [1n]);
  check("the desk has both draws", drawn.fromPool === parseEther("0.004") && drawn.early === parseEther("0.001") && drawn.state === 2);
  check("the bond cannot leave while the pool is owed", (await refused(agent.takeBond("0.004"))) === "A bond can leave only while nothing is owed to the pool. 0.004 ETH is out right now.");
  const work = "The summary: 12 points, 3 risks. https://example.org/summary-0001";
  const delivered = await agent.deliver(1, work);
  check("the delivery's fingerprint on the chain is the fingerprint of the work", (await desk<{ proof: string; state: number }>("job", [1n])).proof === proofOf(work) && delivered.proof === proofOf(work));
  check("a customer cannot accept somebody else's job", (await refused(agent.accept(1))) === "Only the customer who locked this job can do this.");
  const agentBefore = await balance(agent.address!);
  await customer.accept(1);
  check("accepted: the agent is paid the rest, less the 2% job fee, to the wei", (await balance(agent.address!)) - agentBefore === parseEther("0.01") - parseEther("0.005") - parseEther("0.0002"));
  const settled = await customer.waitFor(1, ["settled"]);
  check("the site shows the job settled with what it paid", settled.paidEth === 0.0048 && settled.feeEth === 0.0002 && settled.title === "Summarise a 40-page service agreement");

  const second = await customer.hire({ agent: "lumen-07", price: "0.01", title: "Translate a product page into German" });
  await agent.deliver(second.jobId, "Etwas ganz anderes");
  await customer.reject(second.jobId);
  const third = await customer.hire({ agent: agent.address!, price: "0.01" });
  await agent.decline(third.jobId);
  const states = await Promise.all([1n, 2n, 3n].map(async (n) => (await desk<{ state: number }>("job", [n])).state));
  check("a rejected job settles at half and a declined one goes back: the desk has all three as they should be", states.join() === "4,5,6");
  await agent.takeBond("0.004");
  check("with nothing owed, the bond comes back", (await desk<{ bond: bigint }>("agent", [agent.address])).bond === 0n);
  await customer.waitFor(third.jobId, ["declined"]);
  // the site shows the bond gone a moment after the chain has it
  let record = (await reader.agent("lumen-07"))!.agent;
  for (let i = 0; i < 30 && record.bondEth !== 0; i++) { await new Promise((r) => setTimeout(r, 700)); record = (await reader.agent("lumen-07"))!.agent; }
  check("a reader with no key sees the agent's record", record.settled === 1 && record.settledAtHalf === 1 && record.bondEth === 0 && (await reader.agents()).some((a) => a.name === "lumen-07"));
  check("and the ledger in words", (await reader.ledger({ limit: 30 })).some((l) => l.text === "lumen-07 declined the job, the customer has it all back"));
  check("a job that is closed cannot be acted on, and the kit says so", (await refused(customer.accept(1))) === "The job is not in a state where that can be done. Read the job again.");

  step("3  the assistant's tools, through a real client");
  const dir = mkdtempSync(join(tmpdir(), "factor-kit-e2e-"));
  const serve = async (env: Record<string, string>) => {
    const client = new Client({ name: "factor-kit-e2e", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(KIT, "dist", "mcp.js")], env: { PATH: process.env.PATH ?? "", FACTOR_API: where.api, FACTOR_RPC_URL: where.rpcUrl, FACTOR_KIT_DIR: dir, ...env }, stderr: "ignore" }));
    const call = async (name: string, args: Record<string, unknown> = {}) => { const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }; return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true }; };
    return { client, call };
  };
  const assistant = await serve({ FACTOR_PRIVATE_KEY: assistantKey, FACTOR_MAX_JOB_ETH: "0.02", FACTOR_MAX_DAY_ETH: "0.025" });
  const me = privateKeyToAccount(assistantKey).address.toLowerCase();
  const said: string[] = [];
  const ask = async (name: string, args: Record<string, unknown> = {}) => { const r = await assistant.call(name, args); said.push(r.text); return r; };
  const tools = (await assistant.client.listTools()).tools;
  check("the assistant is offered seventeen tools, each described", tools.length === 17 && tools.every((t) => (t.description ?? "").length > 40), tools.map((t) => t.name).slice(0, 4).join(", ") + ", …");
  const overview = await ask("factor_overview");
  check("it can read Factor, and is told which wallet it acts as", !overview.isError && overview.text.includes("a rejected job settles at half") && overview.text.includes(`acts as the wallet ${me}`));
  check("it finds the agent", (await ask("factor_agents")).text.includes("lumen-07: Summarises long documents and contracts."));
  const jobsBefore = await desk<bigint>("jobCount");
  const over = await ask("factor_hire", { agent: "lumen-07", price: "0.03", title: "Summarise three contracts" });
  check("a hire over its owner's cap is refused before anything is sent", over.isError && over.text.includes("0.03 ETH is over this assistant's cap of 0.02 ETH for one job") && (await desk<bigint>("jobCount")) === jobsBefore);
  const hire = await ask("factor_hire", { agent: "lumen-07", price: "0.015", title: "Summarise a lease", due_in_hours: 6 });
  const jobN = Number(await desk<bigint>("jobCount"));
  const onChain = await desk<{ customer: string; price: bigint; allowEarly: boolean }>("job", [BigInt(jobN)]);
  check("a hire inside the cap goes through: the desk holds the job for the assistant's wallet", !hire.isError && hire.text.includes(`Job ${jobN} is locked: 0.015 ETH for lumen-07, titled "Summarise a lease"`) && onChain.customer.toLowerCase() === me && onChain.price === parseEther("0.015") && !onChain.allowEarly, hire.text.slice(0, 90));
  const second15 = await ask("factor_hire", { agent: "lumen-07", price: "0.015", title: "Summarise another lease" });
  check("and the next one is stopped by the cap for the day", second15.isError && second15.text.includes("over this assistant's cap of 0.025 ETH a day (0.015 ETH spent so far)") && Number(await desk<bigint>("jobCount")) === jobN);
  await agent.deliver(jobN, "The lease, summarised.");
  await customer.waitFor(jobN, ["delivered"]);
  const mine = await ask("factor_my_jobs", { as: "customer" });
  check("it sees its own job delivered", mine.text.includes(`Job ${jobN} "Summarise a lease": delivered, 0.015 ETH`));
  const notTheirs = await ask("factor_accept", { job: 1 });
  check("it cannot accept a job that is not its wallet's, and is told why", notTheirs.isError && notTheirs.text === "Only the customer who locked this job can do this.", notTheirs.text);
  const accepted = await ask("factor_accept", { job: jobN });
  check("it accepts its own, and the agent is paid", !accepted.isError && (await desk<{ state: number }>("job", [BigInt(jobN)])).state === 4);
  const junk = await ask("factor_draw", { job: jobN, amount: "0.01", from: "bank" });
  // (the protocol's own library checks the input first, so the words are its own here)
  check("what a tool does not take is refused, and nothing is sent", junk.isError && /factor_draw|invalid/i.test(junk.text) && (await desk<{ fromPool: bigint }>("job", [BigInt(jobN)])).fromPool === 0n, junk.text.replace(/\s+/g, " ").slice(0, 110));
  check("nothing the assistant was told carries the key", !said.join("\n").includes(assistantKey.slice(2)) && !said.join("\n").toLowerCase().includes("private key"));
  await assistant.client.close();

  const readOnly = await serve({});
  const noKey = await readOnly.call("factor_hire", { agent: "lumen-07", price: "0.01", title: "Summarise a lease" });
  check("with no key the tools read, and a hire says there is no key", noKey.isError && noKey.text.startsWith("No wallet key is set (FACTOR_PRIVATE_KEY)") && !(await readOnly.call("factor_ledger", { limit: 3 })).isError);
  await readOnly.client.close();
  rmSync(dir, { recursive: true, force: true });
}

main().then(
  () => {
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed.`);
    if (failed.length) console.log(failed.map((f) => `  FAILED: ${f.name}`).join("\n"));
    stopAll();
    process.exit(failed.length ? 1 : 0);
  },
  (e) => {
    console.error(`\nSTOPPED: ${(e as Error).message}`);
    stopAll();
    process.exit(1);
  },
);
