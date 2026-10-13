// The kit against the real contracts, end to end, on a LOCAL fork of Robinhood Chain: the library as an agent and
// as a customer, and the assistant's tools through a real client. Nothing here can reach the real chain.
//
//   npm run e2e    the whole run and every check, then everything is stopped (about four minutes)
//
// It starts from what the engine's own script leaves running (engine/scripts/e2e.ts --bare): the fork, the three
// contracts, the engine, and a launched and traded token, so there is a pool.
//
// Compute credit is spent here with the model maker's own library (@anthropic-ai/sdk), pointed at the engine. Behind
// the engine is a stand-in (engine/scripts/stub-model.ts): no model is called and the run costs nothing.
//
// Keys: only anvil's built-in test keys, which anvil prints for anybody. They hold nothing on any real chain.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPublicClient, http, parseAbi, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
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

  step("2b compute credit, spent with the model maker's own library");
  const fourth = await customer.hire({ agent: "lumen-07", price: "0.01", title: "Summarise a lease in one line" });
  const room = await agent.canDraw(fourth.jobId);
  check("with no bond, the pool goes as far as the fees the agent's jobs have paid in", room.fromPoolWei > 0n && room.fromPoolWei < parseEther("0.001"), `${room.fromPool} ETH`);
  const gatewayBefore = await balance(privateKeyToAccount(bare.keys[1]).address);
  const agentEth = await balance(agent.address!);
  const drew = await agent.draw(fourth.jobId, room.fromPoolWei, "compute");
  const drewReceipt = await chain.getTransactionReceipt({ hash: drew.hash });
  const gasPaid = drewReceipt.gasUsed * drewReceipt.effectiveGasPrice;
  check("drawn as compute, the ETH goes to the gateway and none of it to the agent", (await balance(agent.address!)) === agentEth - gasPaid && (await balance(privateKeyToAccount(bare.keys[1]).address)) - gatewayBefore >= (room.fromPoolWei * 99n) / 100n - parseEther("0.0001"));
  let left = await agent.computeCredit();
  for (let i = 0; i < 40 && left.balanceUsd === 0; i++) { await new Promise((r) => setTimeout(r, 700)); left = await agent.computeCredit(); }
  check("it is credit in dollars, which anybody can read", left.balanceUsd > 0 && left.lots.length === 1 && left.lots[0].job === fourth.jobId && (await reader.computeCredit("lumen-07")).balanceUsd === left.balanceUsd, `$${left.balanceUsd}`);
  const credit = await agent.compute();
  check("the agent signs for its key", /^fck_/.test(credit.apiKey) && credit.baseURL === `${where.api}/compute` && credit.balanceUsd === left.balanceUsd && credit.models.some((m) => m.id === "claude-sonnet-5-5"));
  check("a wallet that is no agent gets no key, in words", (await refused(customer.compute())) === "This wallet has not registered as an agent on the desk.");
  const claude = new Anthropic({ baseURL: credit.baseURL, apiKey: credit.apiKey, maxRetries: 0 });
  const answer = await claude.messages.create({ model: "claude-sonnet-5-5", max_tokens: 400, messages: [{ role: "user", content: "Summarise the lease in one line." }] });
  const after1 = await agent.computeCredit();
  check("the model maker's own library, with only its address changed, gets its answer", answer.content[0]?.type === "text" && answer.content[0].text.startsWith("Summary:") && answer.usage.output_tokens === 120);
  check("and the call came off the credit", after1.balanceUsd < left.balanceUsd && after1.lots[0].spentUsd > 0, `$${(left.balanceUsd - after1.balanceUsd).toFixed(6)}`);
  const stream = claude.messages.stream({ model: "claude-sonnet-5-5", max_tokens: 400, messages: [{ role: "user", content: "And again, as it comes." }] });
  let pieces = 0;
  stream.on("text", () => { pieces++; });
  const whole = await stream.finalMessage();
  const after2 = await agent.computeCredit();
  check("a stream arrives piece by piece through the same library, and is counted", pieces > 3 && whole.content[0]?.type === "text" && whole.content[0].text.trim().endsWith("renews by itself.") && after2.balanceUsd < after1.balanceUsd, `${pieces} pieces`);
  const tooMuch = await claude.messages.create({ model: "claude-fable-5-1", max_tokens: 16_000, messages: [{ role: "user", content: "x".repeat(400_000) }] }).then(() => "", (e: { status?: number; message?: string }) => `${e.status} ${e.message}`);
  check("a request the credit cannot cover is refused in the library's own way, and costs nothing", tooMuch.startsWith("402") && tooMuch.includes("compute credit") && (await agent.computeCredit()).balanceUsd === after2.balanceUsd, tooMuch.slice(0, 90));
  await agent.deliver(fourth.jobId, "The lease runs for two years and renews by itself.");
  await customer.accept(fourth.jobId);
  let keptCredit = await agent.computeCredit();
  for (let i = 0; i < 40 && keptCredit.lots[0].state !== "kept"; i++) { await new Promise((r) => setTimeout(r, 700)); keptCredit = await agent.computeCredit(); }
  check("the job settled and repaid the pool: what is left of the credit is the agent's", keptCredit.lots[0].state === "kept" && keptCredit.balanceUsd === after2.balanceUsd && (await desk<{ advancedNow: bigint }>("agent", [agent.address])).advancedNow === 0n);

  step("2c gasless: an agent whose key has never held a wei");
  const freshKey = generatePrivateKey();
  const fresh = privateKeyToAccount(freshKey).address;
  const g = await Factor.connect({ ...where, privateKey: freshKey, gasless: true });
  const madeCode = await chain.getCode({ address: g.address as `0x${string}` });
  check("it connects through a Factor account of its own, made for its key", g.gasless && g.signer === fresh.toLowerCase() && g.address !== g.signer && !!madeCode && madeCode !== "0x", g.address ?? "");
  await g.register();
  await g.profile({ name: "gasless-01", does: "Works without a wei of its own" });
  check("it registers and names itself, and the desk and the site know it by its account", (await desk<{ registered: boolean }>("agent", [g.address])).registered && (await reader.agent("gasless-01"))?.agent.address === g.address);
  check("with nothing in the account, hiring is refused in words before anything is signed", (await refused(g.hire({ agent: "lumen-07", price: "0.01" }))).startsWith("The account holds 0 ETH: not enough for the 0.01 ETH this needs."));
  const fifth = await customer.hire({ agent: g.address!, price: "0.01", title: "Proofread a product page", allowEarly: true });
  await g.draw(fifth.jobId, "0.005", "early");
  check("it draws early, and the advance lands in its account", (await balance(g.address!)) === parseEther("0.00495"));
  check("a draw past the job's half is refused with the desk's own words, through the account too", (await refused(g.draw(fifth.jobId, "0.001", "early"))) === "Half of this job is already advanced. Nothing more can be drawn on it.");
  await g.deliver(fifth.jobId, "The page, proofread.");
  await customer.accept(fifth.jobId);
  const info = await g.accountInfo();
  check("it is paid into its account, and the kit says what is there", info.balanceWei === parseEther("0.00495") + parseEther("0.005") - parseEther("0.0002") && info.ordersToday === 3 && info.keys.length === 1 && info.keys[0].kind === "wallet", `${info.balanceEth} ETH, ${info.ordersToday} of ${info.ordersPerDay} paid actions today`);
  check("more than it holds cannot be taken out", (await refused(g.withdraw(fresh, "1"))).startsWith("The account holds 0.00975 ETH"));
  const homeOf = privateKeyToAccount(generatePrivateKey()).address;
  await g.withdraw(homeOf, "0.009");
  check("its owner takes the earnings out to an address of their own", (await balance(homeOf)) === parseEther("0.009") && (await balance(g.address!)) === parseEther("0.00075"));
  const gKey = await g.compute();
  check("it signs for a compute key with the same key, as the account", /^fck_/.test(gKey.apiKey) && gKey.balanceUsd === 0);
  check("and through all of it the key itself never held a wei", (await balance(fresh)) === 0n && (await chain.getTransactionCount({ address: fresh })) === 0);

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
  check("the assistant is offered nineteen tools, each described", tools.length === 19 && tools.every((t) => (t.description ?? "").length > 40), tools.map((t) => t.name).slice(0, 4).join(", ") + ", …");
  const overview = await ask("factor_overview");
  const noAccount = await ask("factor_account");
  check("it says it has no Factor account when it acts as a wallet", !noAccount.isError && noAccount.text.includes("pays its own gas"));
  const viaAccount = await serve({ FACTOR_PRIVATE_KEY: freshKey, FACTOR_GASLESS: "1" });
  const itsAccount = await viaAccount.call("factor_account");
  check("with FACTOR_GASLESS it acts through the key's Factor account, and says what is in it", !itsAccount.isError && itsAccount.text.startsWith(`Factor account ${g.address} holds 0.00075 ETH.`), itsAccount.text.slice(0, 90));
  await viaAccount.client.close();
  const creditSaid = await ask("factor_compute_credit", { agent: "lumen-07" });
  check("it can say what compute credit an agent has left, and what the models cost", !creditSaid.isError && /^\$\d+\.\d+ of compute credit left\. From job 4: /.test(creditSaid.text) && creditSaid.text.includes("claude-sonnet-5-5 $2.10 in / $10.50 out"), creditSaid.text.slice(0, 70));
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
