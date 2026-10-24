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
import { createServer } from "node:http";

const PORT = Number(process.env.SMOKE_PORT) || 3611, BASE = `http://127.0.0.1:${PORT}`, BARE = `http://127.0.0.1:${PORT + 1}`;
const PAGES = ["/", "/ledger", "/ledger?show=burned", "/agents", "/agents/lumen-07", "/jobs/0412", "/jobs/0406", "/jobs/0404", "/jobs/0403", "/hire", "/hire?agent=page-smith", "/work", "/protocol", "/token", "/burn", "/docs", "/log", "/security", "/pay", "/firms/night-desk", "/hire?firm=night-desk", "/plans/0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a", "/open-jobs", "/open-jobs/0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"];
const NAV = ["/ledger", "/agents", "/open-jobs", "/hire", "/work", "/protocol", "/token", "/burn", "/docs", "/roadmap"];
// Words the copy does not use: no long dash, no promise of gain. A list kept beside this file and out of the repo
// (forbidden.local.json, pairs of pattern and flags) adds to them on the machine it is on.
const LOCAL = new URL("./forbidden.local.json", import.meta.url);
const FORBIDDEN = [/—/, /\binvest/i, /\breturns?\b/i, /\bprofit/i, /\byield/i, /guarantee/i, ...(existsSync(LOCAL) ? JSON.parse(readFileSync(LOCAL, "utf8")).map(([p, f]) => new RegExp(p, f)) : [])];
let server, bare, pushed, unpushed;
// A stand-in for the engine's live stream (engine/src/live.ts): it says hello to each stream it is asked for, and
// sends what a test tells it to. Everything else it answers 404, so the pages on it show an engine with no figures.
const engine = { streams: new Set(), opened: 0 };
const fakeEngine = createServer((req, res) => {
  if (req.url !== "/v1/live") { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
  engine.opened++;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" });
  res.write(`event: hello\ndata: {"seq":0}\n\n`);
  engine.streams.add(res);
  res.on("close", () => engine.streams.delete(res));
});
const engineSays = (event, data) => { for (const r of engine.streams) r.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
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
  await new Promise((r) => fakeEngine.listen(0, "127.0.0.1", r));
  const ENGINE = `http://127.0.0.1:${fakeEngine.address().port}`;
  [server, bare, pushed, unpushed] = await Promise.all([start(PORT, { FACTOR_SAMPLE: "1" }), start(PORT + 1, {}), start(PORT + 2, { FACTOR_ENGINE_URL: ENGINE }), start(PORT + 3, { FACTOR_ENGINE_URL: ENGINE, LIVE_PUSH: "off" })]);
});
after(() => { stop(server); stop(bare); stop(pushed); stop(unpushed); for (const r of engine.streams) r.destroy(); fakeEngine.close(); });

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
    // "Guarantees", with its capital, is the name of a planned phase on the roadmap (a bond that pays the customer
    // back when an agent does not deliver); the word is allowed as that name and nowhere else
    const t = text((await get(path)).html).replace(/\bGuarantees\b/g, "");
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

test("the SDK installs from the site itself, before it is on npm", async () => {
  const r = await fetch(`${BASE}/factor-kit.tgz`);
  assert.equal(r.status, 200);
  assert.ok((await r.arrayBuffer()).byteLength > 10_000);
  assert.match(text((await get("/docs")).html), /npm install https:\/\/factoragents\.fun\/factor-kit\.tgz/);
});

test("the burn page: the pot's clock and figures, the pool, every burn; before the launch it says when they start", async () => {
  const t = text((await get("/burn")).html);
  assert.match(t, /Next burn/);
  assert.match(t, /The burn pot/);
  assert.match(t, /Came in from trading/);
  assert.match(t, /0\.0123 ETH/);
  assert.doesNotMatch(t, /\b(10|20|70) ?%/);
  const bare = text((await get("/burn", BARE)).html);
  assert.match(bare, /Burns start at the launch/);
  assert.match(bare, /No burn yet: they start at the launch/);
  assert.doesNotMatch(bare, /0\.0123/);
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

test("making an agent on the site says plainly who holds its key, and is shut until it is switched on", async () => {
  const t = text((await get("/work")).html);
  assert.match(t, /Make one here, in a minute\./);
  assert.match(t, /Factor holds the agent's key/);
  assert.match(t, /you are trusting Factor to run it/);
  assert.match(t, /less what the model cost/);
  assert.match(t, /This opens with the launch\./);
  assert.match((await get("/agents")).html, /href="\/work#make"[^>]*>Make an agent</);
});

test("before the launch the site makes nothing up: no sample figure, no example line, no burn and no fee that did not happen", async () => {
  for (const path of ["/", "/ledger", "/agents", "/hire", "/work", "/protocol", "/token", "/burn", "/docs", "/log", "/security"]) {
    const { status, html } = await get(path, BARE);
    assert.equal(status, 200, path);
    const t = text(html);
    // (page-smith is a real agent's name now, and the dev log says so: the sample's own names are the mark)
    assert.doesNotMatch(t, /lumen-07|quill-02|orbit-ops|4,120,553|0\.62 ETH/, `${path} shows a sample figure`);
    assert.match(html, /NOT LIVE YET/, path);
    assert.doesNotMatch(html, />CONNECT</, `${path} offers a wallet with nothing to send to`);
  }
  assert.match(text((await get("/", BARE)).html), /No agent has registered yet/);
  // with nothing live the home page says so, and prints no line of a kind that needs a desk or a token
  const home = text((await get("/", BARE)).html);
  assert.match(home, /Nothing has happened on the desk yet/);
  assert.doesNotMatch(home, /Every line, printed as it is written/);
  for (const path of ["/", "/ledger"]) assert.doesNotMatch(text((await get(path, BARE)).html), /example · |bought back and burned|trading fees arrived|locked the payment|drew an advance/, path);
  assert.match(text((await get("/hire", BARE)).html), /Nothing is live yet/);
  assert.match(text((await get("/protocol", BARE)).html), /not deployed yet/);
  assert.equal((await get("/agents/lumen-07", BARE)).status, 404);
  assert.equal((await get("/jobs/0412", BARE)).status, 404);
  assert.equal((await fetch(`${BARE}/api/v1/state`)).status, 503);
});

test("the docs show the kit as it is: the install, an agent, a customer, and the assistant's tools with its caps", async () => {
  const t = text((await get("/docs")).html);
  assert.match(t, /npm install https:\/\/factoragents\.fun\/factor-kit\.tgz/);
  assert.match(t, /for await \(const job of factor\.jobsForMe \(\)\)|for await \(const job of factor\. ?jobsForMe ?\(\)\)/);
  assert.match(t, /await factor\. ?hire ?\(\{/);
  assert.match(t, /FACTOR_MAX_JOB_ETH/);
  assert.match(t, /Two caps you set, which it cannot lift/);
  assert.match(t, /It never sees the key/);
  assert.match(t, /canDrawOn ?\(jobId\) view/);
});

test("the docs show compute credit: the model maker's library with the address changed, the models and their prices", async () => {
  const t = text((await get("/docs")).html);
  assert.match(t, /import OpenAI from &quot;openai&quot;|import OpenAI from "openai"/);
  assert.match(t, /const credit = await factor\. ?compute ?\(\)/);
  assert.match(t, /baseURL: credit\. ?openaiBaseURL/);
  assert.match(t, /claude-sonnet-5-5 ?\$2\.10 in · \$10\.50 out/);
  assert.match(t, /Never what was asked or answered/);
  // with nothing live the page says it is not switched on, and shows no price
  const bare = text((await get("/docs", BARE)).html);
  assert.match(bare, /Compute credit is not switched on yet/);
  assert.doesNotMatch(bare, /\$2\.10 in/);
});

test("Pay with Factor: the page signs agents up and gives a marketplace three steps, a link that is not one is refused politely, and the record, the badge and x402 are open to other sites", async () => {
  const page = text((await get("/pay")).html);
  assert.match(page, /Get paid for your agent's work, anywhere ?\./);
  assert.match(page, /Add Pay with Factor to your marketplace in three steps ?\./);
  assert.match(page, /signs it, so nobody can change it on the way/);
  const bad = await get("/pay/not-a-link.at-all");
  assert.equal(bad.status, 200);
  assert.match(text(bad.html), /This link cannot be paid\./);
  assert.match(text(bad.html), /Nothing was taken from anybody/);
  for (const re of FORBIDDEN) assert.doesNotMatch(text(bad.html), re);
  const pre = await fetch(`${BASE}/api/v1/record/lumen-07`, { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  const rec = await fetch(`${BARE}/api/v1/record/lumen-07`);
  assert.equal(rec.status, 503);
  assert.equal(rec.headers.get("access-control-allow-origin"), "*");
  const badge = await fetch(`${BARE}/api/v1/badge/0x0000000000000000000000000000000000000001`);
  assert.match(badge.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  assert.match(await badge.text(), /Paid with Factor/);
  const x = await fetch(`${BARE}/api/v1/x402/nope`);
  assert.equal(x.status, 404);
  assert.equal(x.headers.get("access-control-allow-origin"), "*");
  const button = await fetch(`${BASE}/pay/button.js`);
  assert.equal(button.status, 200);
  const js = await button.text();
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|sendBeacon|document\.cookie|localStorage/, "the button script calls nothing and keeps nothing");
  const docs = text((await get("/docs")).html);
  assert.match(docs, /createPayLink/);
  assert.match(docs, /payX402/);
  assert.match(docs, /factor-lock/);
});

test("the docs say how an agent hires agents for part of a job, what the chain holds and what Factor holds", async () => {
  const t = text((await get("/docs")).html);
  assert.match(t, /Agents that hire agents/);
  assert.match(t, /hireForJob/);
  assert.match(t, /On the chain, by the contract/);
  assert.match(t, /By Factor&#x27;s engine|By Factor's engine/);
  assert.match(t, /Due before the job itself/);
  assert.match(t, /factor_hire_for_job/);
});

test("the Factor Score: on an agent's page with its parts, the income behind it and what the desk lets it draw; on a firm's page; in the list, ordered by it; in the docs", async () => {
  const t = text((await get("/agents/lumen-07")).html);
  assert.match(t, /Factor Score All its paid work, in one number ?\./);
  assert.match(t, /624\s*of 1000 Most of it from jobs settled \(200\) and different customers \(250\)|624\s*of 1000 Most of it from different customers \(250\) and jobs settled \(200\)/);
  assert.match(t, /Jobs settled · 41 200 of 200 41 jobs delivered and paid in full\. 10 points each, up to 200\./);
  assert.match(t, /It is the desk.s own score: score\( ?0x/);
  // what it can draw is the desk's, and the score never moves it
  assert.match(t, /Limit with the pool the bond plus the fees, counted once 0\.0484 ETH/);
  assert.match(t, /nobody can change the rule\. The score does not move it\./);
  // where it comes from: each way, the firm's job among them, and the total adds up to the fees above
  assert.match(t, /Where it comes from/);
  assert.match(t, /Firm work jobs hired through a firm it leads.* 1 0 0\.0400 ETH 0\.0008 ETH/);
  assert.match(t, /All of it 41 0 1\.4200 ETH 0\.0284 ETH Each job counts once\. Monthly clients and sub-jobs count here too, the moment there are any\./);
  assert.match((await get("/agents/lumen-07")).html, /\/api\/v1\/badge\/0x[0-9a-f]{40}\?show=score/);
  // a firm's: the same formula over its jobs, drawn on through its lead
  const f = text((await get("/firms/night-desk")).html);
  assert.match(f, /Factor Score · the firm \d+\s*of 1000/);
  assert.match(f, /What can be drawn · through lumen-07/);
  assert.match(f, /A firm draws through its lead\./);
  assert.match(f, /Jobs hired through the firm/);
  // the list: every agent's Factor Score, and the order can change
  const list = text((await get("/agents")).html);
  assert.match(list, /Order by Factor Score Can draw Jobs settled Newest/);
  assert.match(list, /Factor Score 624/);
  assert.match(list, /Night Desk .* Factor Score \d+/);
  assert.ok(list.indexOf("lumen-07") < list.indexOf("An agent that has not signed a name yet"), "the highest score first");
  const newest = text((await get("/agents?sort=new")).html);
  assert.ok(newest.indexOf("An agent that has not signed a name yet") < newest.indexOf("lumen-07"), "the newest first");
  assert.match(newest, /Order by Factor Score Can draw Jobs settled Newest/);
  // the docs say how it is made
  const d = text((await get("/docs")).html);
  assert.match(d, /12 Factor Score/);
  assert.match(d, /What it can draw is not the score.s to say\./);
});

test("an address that does not exist says so", async () => {
  for (const path of ["/nope", "/agents/nobody", "/jobs/9999", "/firms/no-such-firm", "/firms/Not_A_Slug", `/plans/0x${"00".repeat(32)}`, "/plans/not-a-plan"]) assert.equal((await get(path)).status, 404, path);
});

test("agent firms: listed with the agents, a firm's page with its members and each one's part, its record and badge, and the docs", async () => {
  const list = text((await get("/agents")).html);
  assert.match(list, /Firms · 1/);
  assert.match(list, /Night Desk Contracts read overnight, every change watched Led by lumen-07/);
  const page = await get("/firms/night-desk");
  const t = text(page.html);
  assert.match(t, /Night Desk/);
  assert.match(t, /a firm · since .* · led by lumen-07/);
  assert.match(t, /Hire the firm/);
  assert.match(page.html, /href="\/hire\?firm=night-desk"/);
  // its members, each with its role and its part; the invited one says it has not signed to join
  assert.match(t, /lumen-07 Lead · since .* Firm jobs 1 Settled 1 Worth 0\.0400 ETH/);
  assert.match(t, /orbit-ops Member · since/);
  assert.match(t, /quill-02 Invited · has not signed to join yet/);
  // the shared record, the badge and the record for an app
  assert.match(t, /Jobs hired 1 Settled 1 Settled work 0\.0400 ETH Parts split out 0/);
  assert.match(page.html, /\/api\/v1\/firms\/night-desk\/badge/);
  assert.match(t, /GET https:\/\/factoragents\.fun\/api\/v1\/firms\/night-desk\/record/);
  // the list itself lives with the agents
  const r = await fetch(`${BASE}/firms`, { redirect: "manual" });
  assert.ok([307, 308].includes(r.status) && /\/agents#firms$/.test(r.headers.get("location") ?? ""), `/firms goes to the agents: ${r.status} ${r.headers.get("location")}`);
  // the hire form offers the firm, through its lead
  assert.match(text((await get("/hire?firm=night-desk")).html), /The agent, or a firm|The agent/);
  // the door passes the firms' reads, and their writes go to the engine only
  assert.equal((await fetch(`${BASE}/api/v1/firms`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/v1/firms/night-desk`)).status, 200);
  for (const w of ["firms/form", "firms/join", "firms/leave", "firms/hire"]) assert.equal((await fetch(`${BASE}/api/v1/${w}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 503, w);
  assert.equal((await fetch(`${BASE}/api/v1/firms/night-desk/record`)).status, 503, "the sample has no record to sign");
  const badge = await fetch(`${BASE}/api/v1/firms/night-desk/badge`);
  assert.equal(badge.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  // the docs say how firms work
  const d = text((await get("/docs")).html);
  assert.match(d, /10 Agent firms/);
  assert.match(d, /formFirm/);
  assert.match(d, /hireFirm/);
  assert.match(d, /A job is the firm.s only when it is locked for its lead/);
  assert.match(d, /factor_hire_firm/);
});

test("each page is small enough for a phone, and nothing loads from another site", async () => {
  for (const path of PAGES) {
    const { html, headers } = await get(path);
    assert.ok(html.length < 220_000, `${path} is ${html.length} bytes`);
    assert.doesNotMatch(html, /(src|href)="https?:\/\/(?!ponsfamily\.com|github\.com|x\.com|robinhoodchain\.blockscout\.com\/(tx|address)\/0x)/, `${path} loads from another site`);
    assert.match(headers.get("content-security-policy") ?? "", /default-src 'self'/, `${path} has no content policy`);
  }
});

test("monthly clients: a plan's page with its months, an agent's monthly income, the door, the docs and the words", async () => {
  const page = await get("/plans/0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a");
  const t = text(page.html);
  assert.match(t, /A monthly plan Release notes every month/);
  assert.match(t, /0\.0250 ETH a month · 3 months · Running/);
  // the months as a row: month 1 locked and started from the pool, the next two not locked yet
  assert.match(t, /Month 1 job 0415 0\.0250 ETH Advanced From the pool 0\.0125 ETH To the burn 0\.00025 ETH/);
  assert.match(t, /Months delivered 0 of 3 Paid up front nothing yet Next month early nothing yet Paid on delivery nothing yet/);
  assert.match(t, /Month 2 0\.0250 ETH Not locked yet Month 1 is not delivered yet\. Or from/);
  assert.match(t, /Month 3 0\.0250 ETH Not locked yet Locked when it comes\./);
  assert.match(t, /Months delivered 0 of 3/);
  assert.match(t, /What the customer signed/);
  assert.match(page.html, /href="\/jobs\/0415"/);
  // the agent's page: its monthly clients, only because it has a plan
  const a = text((await get("/agents/quill-02")).html);
  assert.match(a, /Monthly clients Recurring income, on the record ?\./);
  assert.match(a, /A month, from plans running now 0\.0250 ETH a month Plans running 1 Monthly clients 1 Months delivered 0 settled 0/);
  // an agent with no plan shows no monthly section (its Factor Score only names the way)
  assert.doesNotMatch(text((await get("/agents/lumen-07")).html), /Monthly clients (Recurring income|Monthly clients)|Plans running/);
  // the door passes the plans' reads, and their writes go to the engine only
  assert.equal((await fetch(`${BASE}/api/v1/plans/0x${"5a".repeat(32)}`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/v1/plans?agent=quill-02`)).status, 200);
  for (const w of ["plans/create", "plans/month", "plans/stop"]) assert.equal((await fetch(`${BASE}/api/v1/${w}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 503, w);
  // the docs say how plans work and why month by month
  const d = text((await get("/docs")).html);
  assert.match(d, /11 Monthly clients/);
  assert.match(d, /subscribe/);
  assert.match(d, /Why month by month\./);
  assert.match(d, /Next month early is the desk.s own pool advance/);
});

test("verified owners stay out of sight while the engine does not check owners: no mark, no filter, no switch on the form, no docs section", async () => {
  for (const path of ["/agents", "/open-jobs", "/open-jobs/0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", "/docs", "/work"]) {
    const t = text((await get(path)).html);
    assert.ok(!/Verified owner|verified owners only|Owner not verified|Verify the owner/i.test(t), `nothing of verified owners on ${path}`);
  }
  assert.ok(!/id="verified"/.test((await get("/docs")).html), "no docs section on verified owners");
});

test("offers stay out of sight while the engine has them off: the form names one price, the listings have no offers and the docs have no section on them", async () => {
  const board = text((await get("/open-jobs")).html);
  assert.match(board, /Price in ETH/);
  assert.ok(!/Open to offers|Fixed price|Budget/.test(board), "no price mode on the form");
  const listing = text((await get("/open-jobs/0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")).html);
  assert.ok(!/Sort the offers|Make an offer/.test(listing), "no offers on a listing");
  const docs = text((await get("/docs")).html);
  assert.ok(!/Agents that bid/.test(docs), "no docs section on offers");
});

test("the roadmap: on the home page, every phase in order, what is live checked off with its day, what is planned said as a plan", async () => {
  const { html } = await get("/");
  assert.match(html, /id="roadmap"/);
  const t = text(html);
  assert.match(t, /07 Roadmap The credit layer for AI agents \./);
  assert.match(t, /10 of 13 phases live/);
  const names = ["Launch", "Compute on credit", "Pay with Factor", "Agents hire agents", "Agent firms", "Monthly clients", "Agents find their own work", "Agents that bid", "Factor Score", "Credit lines", "Verified owners", "Guarantees", "Factor everywhere"];
  let at = t.indexOf("Stage 1");
  names.forEach((name, i) => { const k = t.indexOf(`Phase ${String(i + 1).padStart(2, "0")} ${name}`, at); assert.ok(k > at, `phase ${i + 1} ${name} in order`); at = k; });
  for (const day of ["14 Oct", "15 Oct", "16 Oct", "17 Oct", "18 Oct", "19 Oct", "20 Oct", "22 Oct", "23 Oct", "24 Oct"]) assert.match(t, new RegExp(`Live ${day}`));
  assert.match(t, /Live 20 Oct Phase 09 Factor Score/);
  assert.match(t, /Under way 1 of 2 phases live/);
  assert.match(t, /Next Phase 10 Credit lines/);
  assert.match(t, /Live 24 Oct Phase 11 Verified owners/);
  assert.equal((t.match(/Planned Phase/g) ?? []).length, 2);
  for (const w of ["October", "November", "December"]) assert.ok(!t.slice(t.indexOf("Stage 2")).includes(w), `no planned date: ${w}`);
  // the line runs on past the last phase into a stage still being planned, with no phase number and no date
  const more = t.slice(t.indexOf("Phase 13 Factor everywhere"));
  assert.match(more, /Stage 4 Coming What comes next/);
  assert.match(more, /The next stage is being planned\. New phases are added here as we get close to finishing the ones above/);
  assert.ok(!/Phase 14/.test(t), "no phase number for what comes next");
  assert.equal((t.match(/checked off the day it goes live/g) ?? []).length, 1);
  assert.equal((t.match(/Builds on/g) ?? []).length, 5);
  // the footer leads to it on every page, as the header does
  assert.match(html, /<footer[\s\S]*href="\/roadmap"/);
});

// Reads a stream until `want` is in what came, or `ms` passed. Returns what came.
async function readUntil(reader, want, ms = 8_000) {
  let got = "";
  const end = Date.now() + ms;
  while (!want.test(got) && Date.now() < end) {
    const r = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res({ timeout: true }), Math.max(1, end - Date.now())))]);
    if (r.timeout || r.done) break;
    got += r.value;
  }
  return got;
}

test("pages are told of changes as they happen: one stream to the engine per server, passed on to every open page", async () => {
  const PUSHED = `http://127.0.0.1:${PORT + 2}`;
  const opened = engine.opened;
  const open = async () => {
    const ac = new AbortController();
    const r = await fetch(`${PUSHED}/api/live`, { signal: ac.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.match(r.headers.get("cache-control") ?? "", /no-transform/);
    assert.equal(r.headers.get("x-accel-buffering"), "no");
    return { ac, reader: r.body.pipeThrough(new TextDecoderStream()).getReader() };
  };
  const a = await open(), b = await open();
  assert.match(await readUntil(a.reader, /event: up\n/), /event: hello\ndata: \{"up":(true|false),"since":"[0-9a-f]+:\d+"\}/);
  await readUntil(b.reader, /event: up\n|"up":true/);
  // two pages open, and the engine was asked for one stream
  assert.equal(engine.opened - opened, 1);
  engineSays("state", { seq: 1, kind: "state", at: new Date().toISOString() });
  const [ga, gb] = await Promise.all([readUntil(a.reader, /event: change/), readUntil(b.reader, /event: change/)]);
  assert.match(ga, /event: change\ndata: \{"since":"[0-9a-f]+:\d+"\}/);
  assert.match(gb, /event: change/);
  engineSays("pulse", { seq: 2, kind: "pulse", at: "2026-10-20T07:18:51.374Z", block: 93272637, gwei: 0.02 });
  assert.match(await readUntil(a.reader, /event: pulse/), /event: pulse\ndata: \{"block":93272637,"gwei":0.02,"at":"2026-10-20T07:18:51.374Z"\}/);
  a.ac.abort(); b.ac.abort();
  // a page on it says so in the footer only once its stream is open in the browser: nothing in the page as served
  const { status, html } = await get("/", PUSHED);
  assert.equal(status, 200);
  assert.doesNotMatch(html, /class="livemark"/);
});

test("LIVE_PUSH=off, or no engine, and there is no stream: pages read themselves on their timers as before", async () => {
  const opened = engine.opened;
  const off = await fetch(`http://127.0.0.1:${PORT + 3}/api/live`);
  assert.equal(off.status, 404);
  assert.equal((await fetch(`${BARE}/api/live`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/live`)).status, 404);
  assert.equal(engine.opened, opened, "the engine was not asked for a stream");
  assert.equal((await get("/", `http://127.0.0.1:${PORT + 3}`)).status, 200);
});

test("an agent with an ERC-8004 identity shows it by its name and in a section of its own, and the docs explain it", async () => {
  const page = text((await get("/agents/lumen-07")).html);
  assert.match(page, /ERC-8004 #211/);
  assert.match(page, /On ERC-8004/);
  assert.match(page, /getSummary\(211, \[FACTOR\]/);
  const other = text((await get("/agents/quill-02")).html);
  assert.doesNotMatch(other, /On ERC-8004/);
  const docs = await get("/docs");
  assert.match(docs.html, /id="erc8004"/);
  assert.match(text(docs.html), /linkErc8004/);
  // the file an entry points at is passed on word for word by the engine; the sample has none
  assert.equal((await get("/api/v1/erc8004/feedback/12")).status, 404);
});


test("auto-apply: an agent's rules and its log on its page, the applications made on their own marked, and the docs", async () => {
  const agent = text((await get("/agents/page-smith")).html);
  assert.match(agent, /Auto-apply/);
  assert.match(agent, /Takes Landing pages From 0\.003 ETH a job At a time Up to 3 jobs Hours Always on Half up front When the customer allows it/);
  assert.match(agent, /What it did on its own/);
  assert.match(agent, /Applied with one signature, ranked 1 of 1 by Factor Score/);
  // an agent with no rules and auto-apply off on the sample shows no section
  assert.doesNotMatch(text((await get("/agents/lumen-07")).html), /What it did on its own/);
  assert.match(text((await get("/open-jobs")).html), /Applied · 1 · 1 on its own/);
  assert.match(text((await get("/open-jobs/0x0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c")).html), /page-smith House agent Applied on its own/);
  const docs = await get("/docs");
  assert.match(docs.html, /id="auto-apply"/);
  assert.match(text(docs.html), /15 Auto-apply Agents that find their own work \./);
  assert.match(text(docs.html), /watchOpenJobs/);
  // the site's own door passes an agent's rules and log, and the rules an owner signs
  assert.equal((await fetch(`${BASE}/api/v1/autoapply/page-smith`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/v1/autoapply/page-smith/log`)).status, 404);
  // with no engine: nothing to show
  assert.doesNotMatch(text((await get("/agents/page-smith", BARE)).html), /What it did on its own/);
});

test("open jobs: the board, a listing with its applicants ranked by Factor Score, and nothing to send on the sample", async () => {
  const board = text((await get("/open-jobs")).html);
  assert.match(board, /Post the job\. The agents come to you ?\./);
  assert.match(board, /Check every figure in our quarterly note/);
  assert.match(board, /A one-page site for a bakery/);
  assert.match(board, /best Factor Score takes it/);
  assert.match(board, /Open jobs are off for now|Nothing is live yet/);
  assert.doesNotMatch((await get("/open-jobs")).html, />CONNECT</);
  const { html } = await get("/open-jobs/0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
  const t = text(html);
  assert.match(t, /Ranked by Factor Score/);
  // ranked by the score, highest first: lumen-07 (624) above orbit-ops and quill-02
  const order = ["lumen-07", "orbit-ops", "quill-02"].map((n) => t.indexOf(`${n}`, t.indexOf("Ranked by Factor Score")));
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], `ranked ${order}`);
  assert.match(t, /Forty-one jobs settled, all but one on time/);
  assert.match(t, /What the customer signed/);
  assert.equal((await get("/open-jobs/0x0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d")).status, 404);
  assert.equal((await get("/open-jobs/not-a-listing")).status, 404);
  // the site's own door passes the board and a listing, and only the writes a wallet signs
  assert.equal((await fetch(`${BASE}/api/v1/openjobs`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/v1/openjobs/0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/v1/openjobs/pick`, { method: "POST", body: "{}" })).status, 404);
  // with no engine: an empty board that says so, never a sample listing
  const bare = text((await get("/open-jobs", BARE)).html);
  assert.match(bare, /No open job right now/);
  assert.doesNotMatch(bare, /quarterly note/);
  assert.equal((await get("/open-jobs/0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", BARE)).status, 404);
});
