// The real check of raeto/auto, for when there is a key: a few short, real, paid calls through the gateway's own code,
// on a database in memory with made-up credit for a made-up agent. Nothing here touches the chain or the engine's data.
//
//   scripts/raeto-real-check     (from the top of the repo)
//
// It checks what can only be checked against the real thing: that an answer comes back, that Raeto says what it cost on a
// whole answer and on a stream, that the credit is charged exactly that and the margin, that the tag and the job went
// along, and that the balance at Raeto dropped by what the calls said. It prints what the calls really cost, stops past
// RAETO_CHECK_MOST_USD (5 cents), and refuses to run without a key. The key is never printed.

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { EngineDb, open } from "../src/chain/db.js";
import { ComputeStore, Gateway, readCompute } from "../src/compute.js";

const file = join(homedir(), ".factor-raeto-key");
const key = process.env.RAETO_API_KEY?.trim() || (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
if (!key) {
  console.error(`No key: nothing was sent and nothing was spent. Put the key in RAETO_API_KEY or in ${file}.`);
  process.exit(2);
}
const URL_ = (process.env.RAETO_URL?.trim() || "https://api.raeto.cc/v1").replace(/\/+$/, "");
const MOST = Number(process.env.RAETO_CHECK_MOST_USD) || 0.05;
const scrub = (s: unknown) => String(s).split(key).join("[the key]");
const MARKUP = Number(process.env.COMPUTE_MARKUP_BPS) || 500;
const AGENT = "0xfac7000000000000000000000000000000000001";

const problems: string[] = [];
const cfg = readCompute({ COMPUTE_MODE: "on", RAETO: "on", RAETO_API_KEY: key, RAETO_URL: URL_, COMPUTE_MARKUP_BPS: String(MARKUP), RAETO_FLOAT_FLOOR_USD: "0", RAETO_FLOAT_CHECK_S: "0" }, problems);
if (problems.length) throw new Error(problems.join("; "));
const db = new EngineDb(open(":memory:"), Date.now);
const store = new ComputeStore(db);
// a dollar of made-up credit: 0.0004 ETH at $2,500
store.addCoinLot({ tx_hash: "0xc4ec", log_index: 0, block: 1, at: Math.floor(Date.now() / 1000) }, AGENT, 400_000_000_000_000n, "250000000000");
const logged: string[] = [];
const gateway = new Gateway(cfg, store, db, { anthropic: null, router: null, raeto: key }, (l) => logged.push(scrub(l)));
const server = createServer((req, res) => void gateway.http(req, res, (req.url ?? "/").split("?")[0]!));
const base = await new Promise<string>((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
const agentKey = store.addKey(AGENT, 3600).key;

// what the gateway really sends and is really told, seen on the way through
interface Wire { agent: string | null; task: string | null; budget: string | null; taskSaid: string | null; status: number; cost: string | null; model: string | null; tier: string | null; route: string | null }
const wires: Wire[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await realFetch(input, init);
  if (String(input) === `${URL_}/chat/completions`) {
    const h = new Headers(init?.headers);
    wires.push({ agent: h.get("x-raeto-agent"), task: h.get("x-raeto-task"), budget: h.get("x-raeto-task-budget"), taskSaid: res.headers.get("x-raeto-task"), status: res.status, cost: res.headers.get("x-raeto-cost"), model: res.headers.get("x-raeto-model"), tier: res.headers.get("x-raeto-tier"), route: res.headers.get("x-raeto-route") });
  }
  return res;
};

const me = async () => (await (await realFetch(`${URL_}/me`, { headers: { authorization: `Bearer ${key}` } })).json()) as { available_usd: number; fee_pct: number; key?: { spent_usd: number; limit_usd: number | null; models: unknown } };
const usage = () => db.q("SELECT model, input, output, cost_micro, unpaid_micro, status FROM compute_usage ORDER BY id").all() as { model: string; input: number; output: number; cost_micro: number; unpaid_micro: number; status: number }[];
const spend = () => db.q("SELECT asked, model, tier, cost_micro, upstream_micro, cost_from FROM compute_raeto_spend ORDER BY id").all() as { asked: string; model: string; tier: string; cost_micro: number; upstream_micro: number; cost_from: string }[];

let failed = 0;
const check = (name: string, ok: unknown, detail = "") => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${scrub(detail)})` : ""}`); };

const before = await me();
console.log(`At Raeto before: $${before.available_usd} the key can spend, fee ${before.fee_pct}%, cap ${before.key?.limit_usd ?? "none"}, allowed models ${JSON.stringify(before.key?.models ?? null)}.\n`);
check("the key answers", typeof before.available_usd === "number");

const ask = (body: Record<string, unknown>) => realFetch(`${base}/v1/compute/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${agentKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const stamp = Date.now().toString(36); // the same request again and again would trip Raeto's loop breaker

const list = (await (await realFetch(`${base}/v1/compute/v1/models`)).json()) as { data: { id: string }[] };
const real = (await (await realFetch(`${URL_}/models`)).json()) as { data: { id: string }[] };
for (const id of list.data.map((m) => m.id)) check(`Raeto lists ${id}`, real.data.some((m) => m.id === id));

const CALLS: { label: string; body: Record<string, unknown> }[] = [
  { label: "raeto/auto:cheap, a whole answer", body: { model: "raeto/auto:cheap", max_tokens: 16, messages: [{ role: "user", content: `In three words, what is a ledger? (${stamp})` }] } },
  { label: "raeto/auto, a whole answer", body: { model: "raeto/auto", max_tokens: 16, messages: [{ role: "user", content: `In three words, what is an invoice? (${stamp})` }] } },
  { label: "raeto/auto:cheap, a stream", body: { model: "raeto/auto:cheap", max_tokens: 16, stream: true, messages: [{ role: "user", content: `In three words, what is a receipt? (${stamp})` }] } },
];
const saidIn = (text: string, stream: boolean): string => {
  const parts = stream ? text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)) as { choices?: { delta?: { content?: string } }[] }).map((d) => d.choices?.[0]?.delta?.content ?? "") : [(JSON.parse(text) as { choices: { message: { content: string } }[] }).choices[0]!.message.content];
  return parts.join("").trim().replace(/\s+/g, " ").slice(0, 120);
};
let spentHere = 0;
for (const c of CALLS) {
  console.log(`\n${c.label}`);
  const n = spend().length;
  const r = await ask(c.body);
  const text = await r.text();
  const wire = wires.at(-1)!;
  check("it answered", r.status === 200, `status ${r.status}`);
  check("the agent's tag went along", wire.agent === AGENT, String(wire.agent));
  check("the credit it is paid from went along", wire.task === `factor-coin-${AGENT}`, String(wire.task));
  check("Raeto counts the job's credit as its budget", !!wire.budget && (wire.taskSaid ?? "").includes(`budget=${wire.budget}`), `${wire.taskSaid}`);
  check("the owner's key is not in the answer", !text.includes(key));
  const row = spend()[n];
  check("the call is in the books", !!row);
  if (!row) continue;
  const stream = c.body.stream === true;
  check(`Raeto said what it cost, ${stream ? "in the last chunk" : "in the header"}`, row.cost_from === (stream ? "chunk" : "header"), row.cost_from);
  check("the credit paid that and the margin, rounded up", row.cost_micro === Math.ceil(row.upstream_micro * (10_000 + MARKUP) / 10_000 - 1e-9), `$${(row.upstream_micro / 1e6).toFixed(6)} at Raeto, $${(row.cost_micro / 1e6).toFixed(6)} off the credit`);
  check("a model was named", !!row.model, `${row.model}, tier ${row.tier || "not said"}`);
  if (!stream) check("the agent can read what it paid", r.headers.get("x-factor-cost-usd") === (row.cost_micro / 1e6).toFixed(6));
  else check("the last chunk says what the agent paid", text.includes(`"cost_usd":${row.cost_micro / 1e6}`));
  spentHere += row.upstream_micro / 1e6;
  console.log(`  said: ${scrub(saidIn(text, stream))}`);
  if (spentHere > MOST) { console.error(`Past the ceiling of $${MOST}: stopped.`); break; }
}

const noMoney = usage().length;
const bad = await ask({ model: "raeto/auto", max_tokens: 0, messages: [{ role: "user", content: "x" }] });
console.log("\nWhat must cost nothing");
check("a request the gateway refuses never leaves", bad.status === 400 && usage().length === noMoney);

await new Promise((r) => setTimeout(r, 1500));
const after = await me();
const dropped = before.available_usd - after.available_usd;
console.log("\nThe account");
check("the balance at Raeto dropped by what the calls said", Math.abs(dropped - spentHere) < 0.00001, `dropped $${dropped.toFixed(6)}, the calls said $${spentHere.toFixed(6)}`);
const owed = usage().reduce((n, u) => n + u.unpaid_micro, 0);
check("nothing went unpaid", owed === 0);
const left = (gateway.balanceOf(AGENT) as { balanceUsd: number }).balanceUsd;
check("the credit went down by what was charged", Math.abs(1 - left - spend().reduce((n, s) => n + s.cost_micro, 0) / 1e6) < 0.000001, `$${left} left of $1 of made-up credit`);

console.log(`\nThese ${CALLS.length} calls really cost $${spentHere.toFixed(6)} from the balance at Raeto.`);
for (const l of logged) console.log(`  log: ${l}`);
console.log(failed ? `\n${failed} check(s) FAILED.` : "\nEvery check passed.");
server.closeAllConnections();
server.close();
process.exit(failed ? 1 : 0);
