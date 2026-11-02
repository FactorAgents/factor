// raeto/auto end to end on a local fork of the chain: a test agent registers on the real contracts' copy, a test customer
// locks a job, the agent draws part of it as compute, signs for its key, and calls raeto/auto through the site, the way
// any client does. Then the engine's books, the job's page and the agent's page must agree with what the calls said. All
// the ETH is the fork's, so no payment here is real.
//
//   start a run first: RAETO=on RAETO_API_KEY=... RAETO_URL=... npm run e2e -- --bare, and a site against its engine
//   RAETO_DEMO_SITE=http://127.0.0.1:3642 tsx scripts/raeto-demo.ts            against the stand-in: spends nothing
//   RAETO_DEMO_SITE=http://127.0.0.1:3642 tsx scripts/raeto-demo.ts --real     against Raeto: real calls, real cost
//
// With --real it stops past RAETO_DEMO_MOST_USD (3 cents) and asks the short questions below with small answers.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { factorDeskAbi } from "../src/abi/index.js";
import { keyMessage } from "../src/compute.js";
import { profileMessage, proofOf, titleMessage } from "../src/profiles.js";

const REAL = process.argv.includes("--real");
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-e2e");
const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8")) as { rpc: string; api: string; desk: `0x${string}`; keys: Hex[] };
const SITE = (process.env.RAETO_DEMO_SITE?.trim() || bare.api).replace(/\/+$/, "");
const COMPUTE = SITE === bare.api ? `${SITE}/v1/compute` : `${SITE}/api/v1/compute`;
const MOST = Number(process.env.RAETO_DEMO_MOST_USD) || 0.03;
const DESK = factorDeskAbi as Abi;
const agent = privateKeyToAccount(bare.keys[3]!);
const customer = privateKeyToAccount(bare.keys[4]!);
const AGENT = agent.address.toLowerCase();
const chain = createPublicClient({ transport: http(bare.rpc) });

let failed = 0;
const check = (name: string, ok: unknown, detail = "") => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`); };
const send = async (who: typeof agent, functionName: string, args: unknown[] = [], value = 0n) => {
  const w = createWalletClient({ account: who, transport: http(bare.rpc) });
  const hash = await w.writeContract({ address: bare.desk, abi: DESK, functionName, args, value, chain: null, gas: 2_000_000n });
  const r = await chain.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 250 });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
};
const post = async (path: string, body: unknown) => { const r = await fetch(`${bare.api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return r.status; };
const get = async <T>(path: string) => (await (await fetch(`${bare.api}${path}`)).json()) as T;
const waitFor = async <T>(what: string, fn: () => Promise<T | null | undefined | false>) => {
  for (let i = 0; i < 200; i++) { const v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 300)); }
  throw new Error(`waited too long for ${what}`);
};
const now = async () => Number((await chain.getBlock()).timestamp);

console.log(`== the desk on the fork: a test agent and a test customer (${REAL ? "Raeto itself: real calls" : "the stand-in: nothing is spent"})`);
const already = await get<{ agent?: unknown }>(`/v1/agents/${AGENT}`);
if (already.agent) {
  console.error("This fork has had its run: start a fresh one, so that every figure on its pages comes from these calls.");
  process.exit(2);
}
await send(agent, "register");
await send(agent, "addBond", [], parseEther("0.004"));
const due = (await now()) + 3 * 86_400;
await send(customer, "lock", [agent.address, BigInt(due), false], parseEther("0.01"));
const job = await waitFor("the job to show", async () => {
  const r = await get<{ items: { n: number; agentId: string }[] }>(`/v1/jobs?limit=5&agent=${AGENT}`);
  return r.items?.[0]?.n ?? null;
});
check("the job is on the desk", job > 0, `job ${job}`);
const at = await now();
const name = "raeto-test-agent";
const does = "A test agent on a local copy of the chain. Its ETH is not real.";
check("the agent has a name", (await post("/v1/agents/profile", { address: AGENT, name, does, at, signature: await agent.signMessage({ message: profileMessage(AGENT, name, does, at) }) })) === 200);
const title = "Test job on a local copy of the chain: five short questions";
check("the job has a title", (await post("/v1/jobs/title", { job, title, at, signature: await customer.signMessage({ message: titleMessage(job, title, at) }) })) === 200);
await send(agent, "draw", [BigInt(job), parseEther("0.002"), 2]);
const credit = await waitFor("the credit", async () => { const c = await (await fetch(`${COMPUTE}/credit/${AGENT}`)).json() as { balanceUsd: number; lots: { job: number; usd: number | null }[] }; return c.lots.some((l) => l.job === job && l.usd) ? c : null; });
const startUsd = credit.balanceUsd;
console.log(`  credit: $${startUsd} from 0.00198 ETH of the fork's`);

const kAt = await now();
const k = (await (await fetch(`${COMPUTE}/key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: AGENT, at: kAt, signature: await agent.signMessage({ message: keyMessage(AGENT, kAt) }) }) })).json()) as { key: string };
check("the agent signed for its key", /^fck_/.test(k.key));

const ask = (body: Record<string, unknown>) => fetch(`${COMPUTE}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${k.key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const stamp = Date.now().toString(36);
const QUESTIONS: { model: string; say: string; tokens: number; stream?: boolean }[] = [
  { model: "raeto/auto:cheap", say: "In one short sentence, what does an advance against a job mean?", tokens: 40 },
  { model: "raeto/auto", say: "In one short sentence, why would a lender look at a borrower's record?", tokens: 40 },
  { model: "raeto/auto:fast", say: "In five words, what is a ledger?", tokens: 20, stream: true },
  { model: "raeto/auto:code", say: "Write a one-line TypeScript function that adds a 5% margin to a number.", tokens: 60 },
  { model: "raeto/auto:reason", say: "In one sentence: if a job pays 0.01 ETH and 0.002 was advanced at a 1% fee, what reaches the agent as compute?", tokens: 60 },
];
console.log("\n== the calls, through the site, with the agent's key");
let charged = 0;
const answers: string[] = [];
for (const q of QUESTIONS) {
  if (REAL && charged > MOST) { console.log(`Past $${MOST}: stopped.`); break; }
  const r = await ask({ model: q.model, max_tokens: q.tokens, stream: q.stream === true, messages: [{ role: "user", content: `${q.say} (${stamp})` }] });
  const text = await r.text();
  check(`${q.model}${q.stream ? ", a stream" : ""} answered`, r.status === 200, `status ${r.status}`);
  let said = "";
  let paid = 0;
  if (q.stream) {
    for (const l of text.split("\n")) {
      if (!l.startsWith("data: {")) continue;
      const d = JSON.parse(l.slice(6)) as { choices?: { delta?: { content?: string } }[]; raeto?: { cost_usd: number } };
      said += d.choices?.[0]?.delta?.content ?? "";
      if (d.raeto) paid = d.raeto.cost_usd;
    }
  } else if (r.status === 200) {
    said = (JSON.parse(text) as { choices: { message: { content: string } }[] }).choices[0]!.message.content;
    paid = Number(r.headers.get("x-factor-cost-usd"));
  }
  charged += paid;
  check("it says which model answered and what the credit paid", paid > 0 && !!r.headers.get("x-raeto-model"), `${r.headers.get("x-raeto-model")}, tier ${r.headers.get("x-raeto-tier")}, $${paid.toFixed(6)}`);
  console.log(`        ${said.trim().replace(/\s+/g, " ").slice(0, 110)}`);
  answers.push(`${q.say}\n${said.trim()}\n(${q.model}, answered by ${r.headers.get("x-raeto-model")}, $${paid.toFixed(6)} off the credit)`);
}

console.log("\n== what must cost nothing");
const noModel = await ask({ model: "raeto/auto:free", max_tokens: 5, messages: [{ role: "user", content: "x" }] });
check("a model that does not exist is refused", noModel.status === 400);
const tooDear = await ask({ model: "raeto/auto", max_tokens: 500_000, messages: [{ role: "user", content: "x" }] });
check("more than the gateway allows is refused", tooDear.status === 400);
if (!REAL) {
  for (const [mark, status] of [["429", 429], ["500", 502], ["402", 503], ["409", 409]] as const) {
    const r = await ask({ model: "raeto/auto", max_tokens: 5, messages: [{ role: "user", content: `[stub:${mark}] x` }] });
    check(`Raeto saying ${mark} comes back as ${status}`, r.status === status);
  }
}

console.log("\n== the agent delivers what it was told, on the job's page");
const work = `The five questions and what came back. A test on a local copy of the chain: the calls were real, and the ETH was not.\n\n${answers.join("\n\n")}`;
const proof = proofOf(work);
await send(agent, "deliver", [BigInt(job), proof]);
await waitFor("the delivery to show", async () => (await get<{ job?: { state: string } }>(`/v1/jobs/${job}`)).job?.state === "delivered");
check("the work is on the job's page", (await post("/v1/jobs/delivery", { job, work })) === 200);

console.log("\n== the books agree");
const after = await waitFor("the credit to settle", async () => { const c = await (await fetch(`${COMPUTE}/credit/${AGENT}`)).json() as { balanceUsd: number; raeto?: { spentUsd: number; calls: number } }; return c.raeto ? c : null; });
const paidUsd = Math.round(charged * 1e6) / 1e6;
check("the credit went down by what the answers said", Math.abs(startUsd - after.balanceUsd - paidUsd) < 0.000002, `$${(startUsd - after.balanceUsd).toFixed(6)} and $${paidUsd.toFixed(6)}`);
check("the credit's own figure agrees", Math.abs((after.raeto?.spentUsd ?? 0) - paidUsd) < 0.000002 && after.raeto?.calls === QUESTIONS.length, `${after.raeto?.calls} calls`);
const jobPage = await get<{ raetoSpend?: { spentUsd: number; calls: number; models: { model: string; tier: string; calls: number; usd: number }[] } }>(`/v1/jobs/${job}`);
check("the job's page has the same, by model", Math.abs((jobPage.raetoSpend?.spentUsd ?? 0) - paidUsd) < 0.000002 && (jobPage.raetoSpend?.models.length ?? 0) > 0);
for (const m of jobPage.raetoSpend?.models ?? []) console.log(`        ${m.model} (${m.tier || "no tier"}): ${m.calls} call(s), $${m.usd.toFixed(6)}`);
const agentPage = await get<{ raetoSpend?: { calls: number } }>(`/v1/agents/${AGENT}`);
check("the agent's page has them too", (agentPage.raetoSpend?.calls ?? 0) >= QUESTIONS.length);
console.log(`\nJob ${job}, agent ${name}. The credit paid $${paidUsd.toFixed(6)}.`);
console.log(failed ? `${failed} check(s) FAILED.` : "Every check passed.");
process.exit(failed ? 1 : 0);
