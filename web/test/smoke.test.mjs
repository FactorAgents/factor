// Builds nothing: it expects `next build` to have run, serves the site and reads the real HTML of every page. What
// it holds the site to: each page is there with one main heading and the same header, the copy keeps to the rules,
// an address that does not exist says so, and each document is small enough for a phone.
//
// Two servers: one on the sample (FACTOR_SAMPLE=1, every page with something in it), and one with nothing set, which
// must show an empty desk and never a sample figure. The site on a real engine is tested by scripts/flows.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const PORT = 3611, BASE = `http://127.0.0.1:${PORT}`, BARE = `http://127.0.0.1:${PORT + 1}`;
const PAGES = ["/", "/ledger", "/ledger?show=burned", "/agents", "/agents/lumen-07", "/jobs/0412", "/jobs/0406", "/jobs/0404", "/jobs/0403", "/hire", "/hire?agent=page-smith", "/work", "/protocol", "/token", "/docs", "/log", "/security"];
const NAV = ["/ledger", "/agents", "/hire", "/work", "/protocol", "/token", "/docs"];
// Words the copy does not use: no long dash, no promise of gain. A list kept beside this file and out of the repo
// (forbidden.local.json, pairs of pattern and flags) adds to them on the machine it is on.
const LOCAL = new URL("./forbidden.local.json", import.meta.url);
const FORBIDDEN = [/—/, /\binvest/i, /\breturns?\b/i, /\bprofit/i, /\byield/i, /guarantee/i, ...(existsSync(LOCAL) ? JSON.parse(readFileSync(LOCAL, "utf8")).map(([p, f]) => new RegExp(p, f)) : [])];
let server, bare;
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const get = async (path, base = BASE) => { const r = await fetch(base + path); return { status: r.status, html: await r.text(), headers: r.headers }; };
// next itself, in a process group of its own, so that stopping it leaves nothing running
const start = (port, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, FACTOR_ENGINE_URL: "", FACTOR_SAMPLE: "", ...env } });
  const t = setTimeout(() => reject(new Error("the site did not start")), 30_000);
  child.stdout.on("data", (d) => { if (/Ready|Local:/i.test(String(d))) { clearTimeout(t); resolve(child); } });
});
const stop = (child) => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } child.stdout.destroy(); child.stderr.destroy(); };

before(async () => {
  [server, bare] = await Promise.all([start(PORT, { FACTOR_SAMPLE: "1" }), start(PORT + 1, {})]);
});
after(() => { stop(server); stop(bare); });

test("every page answers, with one main heading and the header that leads to the others", async () => {
  for (const path of PAGES) {
    const { status, html } = await get(path);
    assert.equal(status, 200, path);
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, `${path} has one main heading`);
    for (const to of NAV) assert.match(html, new RegExp(`href="${to}"`), `${path} does not lead to ${to}`);
    assert.match(html, /BUY ON PONS|NOT LIVE YET/, `${path} has no buy button`);
    assert.match(html, /aria-label="GitHub/, `${path} has no GitHub icon`);
    assert.match(html, /at your own risk/, `${path} has no own-risk line`);
  }
});

test("the copy keeps to the rules on every page", async () => {
  for (const path of PAGES) {
    const t = text((await get(path)).html);
    for (const re of FORBIDDEN) assert.doesNotMatch(t, re, `${path} says ${re}`);
  }
});

test("a house agent is marked as one wherever it shows, and an agent that did not repay cannot draw", async () => {
  assert.match(text((await get("/agents/page-smith")).html), /House agent/);
  assert.match(text((await get("/agents")).html), /house agents, run by Factor/);
  const bad = text((await get("/agents/tally-bot")).html);
  assert.match(bad, /did not repay an advance/);
  // a barred agent draws nothing, and is not told "yet"
  assert.match(bad, /Can draw nothing (?!yet)/);
});

test("a job's bill adds up", async () => {
  const t = text((await get("/jobs/0412")).html);
  // the rulebook's own example: 0.04 locked, 0.02 advanced with 0.0002 taken off it at the draw, a 2% job fee
  assert.match(t, /Locked by the customer.*0\.0400 ETH/);
  assert.match(t, /Fee on the job.*0\.0008 ETH/);
  assert.match(t, /Paid to the agent on delivery 0\.0192 ETH/);
  // rejected: 0.03 locked, 0.009 of compute, half back, 2% of the agent's half, the rest to the agent
  const half = text((await get("/jobs/0404")).html);
  assert.match(half, /Settled at half/);
  assert.match(half, /Returned to the customer.*0\.0150 ETH/);
  assert.match(half, /Paid to the agent on delivery 0\.0057 ETH/);
  assert.match(text((await get("/jobs/0403")).html), /Declined by the agent, returned to the customer 0\.0180 ETH/);
  assert.match(text((await get("/jobs/0406")).html), /the advance was not repaid/);
});

test("the pool's limit is the bond plus the fees, counted once, and the score follows the formula", async () => {
  const t = text((await get("/agents/lumen-07")).html);
  // 1.42 ETH of settled work at 2% is 0.0284 in fees; with a bond of 0.02 the limit is 0.0484
  assert.match(t, /Limit.*0\.0484 ETH/);
  assert.doesNotMatch(t, /times the fees|Counted \d/);
  // 56 for fees, 250 for customers, 200 for jobs, 18 for nine days, 100 for advances repaid
  assert.match(t, /624\s*of 1000/);
  assert.match(text((await get("/protocol")).html), /limit\(agent\) = bond ?\(agent\) \+ feesPaid ?\(agent\)/);
  assert.match(text((await get("/work")).html), /Your own ETH, held by the contract/);
});

test("an agent that has not signed a name shows under its address, and is found by it", async () => {
  const agents = (await (await fetch(BASE + "/api/v1/agents")).json()).items;
  const unnamed = agents.find((a) => !a.named);
  assert.ok(unnamed, "the sample has one");
  const { status, html } = await get(`/agents/${unnamed.address}`);
  assert.equal(status, 200);
  assert.match(text(html), /has registered and has not said what it does yet/);
  assert.match(text((await get("/agents")).html), /An agent that has not signed a name yet/);
  // a named agent is linked by its name, and found by its address too
  assert.match((await get("/agents")).html, /href="\/agents\/lumen-07"/);
  const named = agents.find((a) => a.name === "lumen-07");
  assert.equal((await get(`/agents/${named.address}`)).status, 200);
});

test("the sample offers no wallet anything to send: its addresses are made up", async () => {
  const hire = text((await get("/hire")).html);
  assert.match(hire, /Nothing leaves your wallet until you confirm it there/);
  assert.match(hire, /Let the agent have half early/);
  assert.match(hire, /Nothing is live yet/);
  assert.doesNotMatch(hire, /Connect a wallet/);
  assert.match(text((await get("/work")).html), /Nothing is live yet/);
  assert.doesNotMatch(text((await get("/jobs/0414")).html), /What can be done/);
  for (const path of ["/", "/hire", "/work", "/jobs/0414"]) assert.doesNotMatch((await get(path)).html, />CONNECT</, path);
});

test("the browser's one door to the engine passes the public reads and nothing else", async () => {
  for (const path of ["state", "agents", "agents/lumen-07", "jobs", "jobs/412", "ledger", "burns"]) assert.equal((await fetch(`${BASE}/api/v1/${path}`)).status, 200, path);
  for (const path of ["health", "metrics", "admin/hide", "agents/profile", "jobs/title", "state/../health", "nothing"]) assert.equal((await fetch(`${BASE}/api/v1/${path}`)).status, 404, path);
  const post = (path, body) => fetch(`${BASE}/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("admin/hide", { what: "agent", key: "x" })).status, 404, "the owner's key is not usable through the site");
  assert.equal((await post("state", {})).status, 404);
  // with no engine behind the site a signed write has nowhere to go, and says so
  assert.equal((await post("agents/profile", {})).status, 503);
  assert.equal((await post("jobs/title", { title: "x".repeat(5000) })).status, 503);
  const jobs = await (await fetch(`${BASE}/api/v1/jobs?agent=${"0x" + "0".repeat(40)}&nonsense=1`)).json();
  assert.deepEqual(jobs.items, []);
});

test("the door to compute credit passes the gateway's own addresses and nothing else", async () => {
  const models = await (await fetch(`${BASE}/api/v1/compute/models`)).json();
  assert.equal(models.enabled, true);
  assert.ok(models.models.some((m) => m.id === "claude-sonnet-5-5" && m.inUsd === 2.1 && m.outUsd === 10.5));
  for (const path of ["health", "usage", "keys", "v1/messages", "credit/nobody", "models/../../health"]) assert.equal((await fetch(`${BASE}/api/v1/compute/${path}`)).status, 404, path);
  const post = (base, path, body) => fetch(`${base}/api/v1/compute/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "fck_" + "a".repeat(32) }, body });
  for (const path of ["models", "balance", "v1/complete", "v1/messages/batches", "admin"]) assert.equal((await post(BASE, path, "{}")).status, 404, path);
  // with no engine behind the site there is no gateway: said in the model maker's own shape, so its library reads it
  for (const base of [BASE, BARE]) {
    const r = await post(base, "v1/messages", JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 10, messages: [] }));
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { type: "error", error: { type: "api_error", message: "Nothing is live yet." } });
    assert.equal((await post(base, "key", "{}")).status, 503);
  }
  assert.equal((await post(BARE, "key", "x".repeat(5000))).status, 503);
  assert.equal((await fetch(`${BARE}/api/v1/compute/models`)).status, 503);
});

test("the door to accounts passes what an account asks of the engine and nothing else", async () => {
  const account = "0x" + "ab".repeat(20), order = "0x" + "cd".repeat(32);
  // the sample has no engine behind it: nothing of an account is made up
  for (const path of [`accounts/${account}`, `accounts/relay/${order}`, "accounts/by-credential/0xc0ffee"]) assert.equal((await fetch(`${BASE}/api/v1/${path}`)).status, 404, path);
  for (const path of ["accounts", "accounts/nobody", "accounts/relay/1", `accounts/${account}/keys`, "accounts/by-credential/zz"]) assert.equal((await fetch(`${BASE}/api/v1/${path}`)).status, 404, path);
  const post = (base, path, body) => fetch(`${base}/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const base of [BASE, BARE]) {
    for (const path of ["accounts", "accounts/check", "accounts/call", "accounts/relay"]) assert.equal((await post(base, path, {})).status, 503, path);
    for (const path of ["accounts/keys", "accounts/relay/x", "accounts/admin", `accounts/${account}`]) assert.equal((await post(base, path, {})).status, 404, path);
  }
  const state = await (await fetch(`${BASE}/api/v1/state`)).json();
  assert.deepEqual(state.accounts, { enabled: false, factory: null, ordersPerDay: 40 });
});

test("the site offers a passkey only where an engine can pay for it, and the docs say what an account is", async () => {
  for (const path of ["/hire", "/work", "/"]) {
    const { html } = await get(path);
    assert.doesNotMatch(html, /use a passkey/i, `${path} offers a passkey with nothing behind it`);
  }
  const t = text((await get("/docs")).html);
  assert.match(t, /gasless ?: true/);
  assert.match(t, /await factor\. ?withdraw ?\(/);
  assert.match(t, /Factor never holds a key/);
  assert.match(t, /Accounts are not switched on yet/);
  assert.match(t, /Nobody can bring an account back/);
});

test("a job's page carries its brief and the work, and a delivered page is served to run nothing", async () => {
  const reading = text((await get("/jobs/0411")).html);
  assert.match(reading, /THE BRIEF/i);
  assert.match(reading, /This lease is made between the landlord and the tenant/);
  assert.match(reading, /WHAT TO WATCH FOR/);
  assert.match(reading, /Its fingerprint is the proof the contract holds for this job/);
  assert.match(text((await get("/jobs/0410")).html), /NVDA\s+\$224\.15/);
  // a job with no words shows no such part
  assert.doesNotMatch(text((await get("/jobs/0412")).html), /THE WORK/i);
  // a page: in a frame on the job's page that can run nothing...
  const built = (await get("/jobs/0408")).html;
  assert.match(built, /<iframe[^>]*src="\/jobs\/0408\/work\?frame"[^>]*sandbox=""/);
  // ...and by itself under a policy of its own: no script, no form, no request, no origin
  const page = await fetch(`${BASE}/jobs/0408/work`);
  assert.equal(page.status, 200);
  const policy = page.headers.get("content-security-policy") ?? "";
  for (const part of ["sandbox", "default-src 'none'", "form-action 'none'", "frame-ancestors 'self'"]) assert.ok(policy.split("; ").includes(part), `the delivered page's policy lacks ${part}: ${policy}`);
  assert.doesNotMatch(policy, /script-src|allow-scripts|allow-same-origin|allow-forms/);
  assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(page.headers.get("x-robots-tag") ?? "", /noindex/);
  const body = await page.text();
  assert.match(body, /A page delivered by page-smith for job 0408 on Factor\. It is not a page of Factor's/);
  assert.match(body, /Charts from the sheet you already have/);
  // saved, it is the file as it was delivered, with nothing added
  const saved = await fetch(`${BASE}/jobs/0408/work?save`);
  assert.match(saved.headers.get("content-disposition") ?? "", /attachment; filename="factor-job-0408\.html"/);
  assert.doesNotMatch(await saved.text(), /A page delivered by/);
  // every other page keeps the site's own policy, and may be framed by nobody
  const job = await fetch(`${BASE}/jobs/0408`);
  assert.match(job.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(job.headers.get("x-frame-options"), "DENY");
  for (const path of ["/jobs/0411/work", "/jobs/0412/work", "/jobs/9999/work", "/jobs/x/work"]) assert.equal((await fetch(`${BASE}${path}`)).status, 404, path);
});

test("Factor's own agents say what they take a job for, on their page and where they are hired", async () => {
  const t = text((await get("/agents/page-smith")).html);
  assert.match(t, /House agent/);
  assert.match(t, /Run by Factor\. Say what the page is for/);
  assert.match(t, /It takes a job from 0\.003 ETH/);
  assert.doesNotMatch(text((await get("/agents/lumen-07")).html), /Run by Factor/);
  const hire = text((await get("/hire?agent=plain-reader")).html);
  assert.match(hire, /THE BRIEF/i);
  assert.match(hire, /Paste the text itself into the brief/);
  assert.match(hire, /Anyone can read a brief on the job.s page/);
  const post = (base, path, body) => fetch(`${base}/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const path of ["jobs/brief", "jobs/delivery"]) assert.equal((await post(BARE, path, {})).status, 503, path);
});

test("the security page says where a report goes, what counts, and what cannot be stopped", async () => {
  const t = text((await get("/security")).html);
  assert.match(t, /Tell us first/);
  assert.match(t, /The contracts cannot be stopped/);
  assert.match(t, /No outside firm has audited these contracts/);
  assert.match(t, /decided case by case/);
  assert.match(t, /By direct message on X/);
  assert.match((await get("/")).html, /href="\/security"/);
  // the file researchers look for first, once there is somewhere to write to
  const file = await fetch(`${BASE}/.well-known/security.txt`);
  assert.equal(file.status, 200);
  const body = await file.text();
  assert.match(body, /^Contact: https:\/\/x\.com$/m);
  assert.match(body, new RegExp(`^Policy: ${BASE}/security$`, "m"));
  assert.match(body, /^Expires: \d{4}-\d{2}-\d{2}T/m);
  // with nothing live there is nowhere to write to yet, and the page says so
  assert.equal((await fetch(`${BARE}/.well-known/security.txt`)).status, 404);
  const bare = text((await get("/security", BARE)).html);
  assert.match(bare, /The address to write to will be here when Factor is live/);
  assert.match(bare, /not deployed yet/);
});

test("with no engine the site shows an empty desk, and never a sample figure", async () => {
  for (const path of ["/", "/ledger", "/agents", "/hire", "/work", "/protocol", "/token", "/docs", "/log", "/security"]) {
    const { status, html } = await get(path, BARE);
    assert.equal(status, 200, path);
    const t = text(html);
    // (page-smith is a real agent's name now, and the dev log says so: the sample's own names are the mark)
    assert.doesNotMatch(t, /lumen-07|quill-02|orbit-ops|4,120,553|0\.62 ETH/, `${path} shows a sample figure`);
    assert.match(html, /NOT LIVE YET/, path);
    assert.doesNotMatch(html, />CONNECT</, `${path} offers a wallet with nothing to send to`);
  }
  assert.match(text((await get("/", BARE)).html), /No agent has registered yet/);
  assert.match(text((await get("/", BARE)).html), /Nothing has happened on the desk yet/);
  assert.match(text((await get("/hire", BARE)).html), /Nothing is live yet/);
  assert.match(text((await get("/protocol", BARE)).html), /not deployed yet/);
  assert.equal((await get("/agents/lumen-07", BARE)).status, 404);
  assert.equal((await get("/jobs/0412", BARE)).status, 404);
  assert.equal((await fetch(`${BARE}/api/v1/state`)).status, 503);
});

test("the docs show the kit as it is: the install, an agent, a customer, and the assistant's tools with its caps", async () => {
  const t = text((await get("/docs")).html);
  assert.match(t, /npm install factor-kit/);
  assert.match(t, /for await \(const job of factor\.jobsForMe \(\)\)|for await \(const job of factor\. ?jobsForMe ?\(\)\)/);
  assert.match(t, /await factor\. ?hire ?\(\{/);
  assert.match(t, /FACTOR_MAX_JOB_ETH/);
  assert.match(t, /Two caps you set, which it cannot lift/);
  assert.match(t, /It never sees the key/);
  assert.match(t, /canDrawOn ?\(jobId\) view/);
});

test("the docs show compute credit: the model maker's library with the address changed, the models and their prices", async () => {
  const t = text((await get("/docs")).html);
  assert.match(t, /npm install factor-kit ?@anthropic-ai\/sdk/);
  assert.match(t, /const credit = await factor\. ?compute ?\(\)/);
  assert.match(t, /baseURL: credit\. ?baseURL/);
  assert.match(t, /claude-sonnet-5-5 ?\$2\.10 in · \$10\.50 out/);
  assert.match(t, /Never what was asked or answered/);
  // with nothing live the page says it is not switched on, and shows no price
  const bare = text((await get("/docs", BARE)).html);
  assert.match(bare, /Compute credit is not switched on yet/);
  assert.doesNotMatch(bare, /\$2\.10 in/);
});

test("an address that does not exist says so", async () => {
  for (const path of ["/nope", "/agents/nobody", "/jobs/9999"]) assert.equal((await get(path)).status, 404, path);
});

test("each page is small enough for a phone, and nothing loads from another site", async () => {
  for (const path of PAGES) {
    const { html, headers } = await get(path);
    assert.ok(html.length < 220_000, `${path} is ${html.length} bytes`);
    assert.doesNotMatch(html, /(src|href)="https?:\/\/(?!ponsfamily\.com|github\.com|x\.com|robinhoodchain\.blockscout\.com\/(tx|address)\/0x)/, `${path} loads from another site`);
    assert.match(headers.get("content-security-policy") ?? "", /default-src 'self'/, `${path} has no content policy`);
  }
});
