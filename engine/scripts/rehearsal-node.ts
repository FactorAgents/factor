// Two small go-betweens for the dress rehearsal (scripts/rehearsal.ts), each its own process so that it answers while
// the rehearsal itself is busy.
//
//   tsx scripts/rehearsal-node.ts source <port> <the real chain's node>
//
//     Where the copy of the chain reads the real chain from. The public node keeps the state of an old block for
//     some minutes only, and a copy made at one block goes on asking for that block for as long as it lives:
//     whatever it first touches after those minutes (a price feed nobody asked before, the pool Pons makes when the
//     token graduates) it could no longer read, and it stops. Through this, an answer the node no longer has for
//     the copy's block is asked again for the newest block. For everything the rehearsal touches late that is the
//     same answer or a fresher one (a feed's price). Each such read is counted: GET /stats says how many and of what.
//     What it did answer for the copy's block is kept and said again when asked again.
//     The public node also turns a caller away now and then (a page of HTML and not an answer): asked again, a
//     little later each time.
//
//   tsx scripts/rehearsal-node.ts engine <port> <the copy of the chain> <the real price of gas, in wei>
//
//     What the engine reads the copy through. A local copy makes up its own price for gas (a gwei, about 45 times
//     the real one), which would have the engine weigh every sweep against a cost it will never meet. Every answer
//     is the copy's own, except the tip the engine is told to offer, which is the real chain's price of gas. The
//     copy's own base fee is nothing, so what the gas wallet pays per unit of gas is what it pays on the real chain.

import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const [mode, portRaw, upstream, gasRaw] = process.argv.slice(2);
const port = Number(portRaw);
if ((mode !== "source" && mode !== "engine") || !port || !upstream || (mode === "engine" && !gasRaw)) throw new Error("usage: rehearsal-node.ts source <port> <node> | engine <port> <node> <gas price in wei>");

type Asked = { id: unknown; method: string; params?: unknown[] };
type Answer = { id: unknown; result?: unknown; error?: { message?: string } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stats = { lateReads: 0, of: new Set<string>(), turnedAway: 0 };

// The public node is asked by a few at a time and never in a burst: a burst is what gets a caller turned away.
let inFlight = 0;
const waiting: (() => void)[] = [];
async function turn<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= 4) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try { return await fn(); } finally { inFlight--; setTimeout(() => waiting.shift()?.(), 40); }
}

// The real chain's node is asked with curl. Its front door (Cloudflare) at times turns Node's own client away with a
// challenge page while it answers curl and anvil's client: found by this very rehearsal, and worth knowing for the
// engine on a host (docs/REHEARSAL.md). The copy of the chain itself is asked with fetch.
function curl(body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = execFile("curl", ["-s", "-m", "30", "-X", "POST", "-H", "content-type: application/json", "--data-binary", "@-", upstream!], { maxBuffer: 64 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out)));
    c.stdin!.end(body);
  });
}

async function ask(body: unknown, patient: boolean): Promise<unknown> {
  if (!patient) {
    const r = await fetch(upstream!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`the node answered ${r.status}`);
    return await r.json();
  }
  for (let wait = 500; ; wait = Math.min(wait * 2, 15_000)) {
    try {
      return JSON.parse(await turn(() => curl(JSON.stringify(body))));
    } catch (e) {
      if (stats.turnedAway < 5 || stats.turnedAway % 50 === 0) console.log(`no answer from the real chain's node: ${(e as Error).message.slice(0, 120)}`);
    }
    stats.turnedAway++;
    await sleep(wait);
  }
}

const STATE_READS = /^eth_(getStorageAt|getBalance|getTransactionCount|getCode|getProof|call)$/;
// What the real chain answered for the copy's own block is kept, and said again whenever it is asked again. The copy
// forgets what it read when it is put back to an earlier moment (the rehearsal's scout does that once), and by the
// time it asks a second time the node may have let that block go.
const kept = new Map<string, unknown>();
async function fromTheRealChain(asked: Asked): Promise<Answer> {
  const state = STATE_READS.test(asked.method) && Array.isArray(asked.params) && asked.params.length > 0;
  const key = state ? `${asked.method}:${JSON.stringify(asked.params)}` : "";
  if (state && kept.has(key)) return { jsonrpc: "2.0", id: asked.id, result: kept.get(key) } as Answer;
  const answer = (await ask(asked, true)) as Answer;
  if (state && answer.error === undefined && answer.result !== undefined) { kept.set(key, answer.result); return answer; }
  const gone = /not available|missing trie node|pruned/i.test(answer.error?.message ?? "");
  if (!gone || !state) return answer;
  stats.lateReads++;
  stats.of.add(String(asked.method === "eth_call" ? (asked.params![0] as { to?: string })?.to : asked.params![0]).toLowerCase());
  return (await ask({ ...asked, params: [...asked.params!.slice(0, -1), "latest"] }, true)) as Answer;
}

const tip = mode === "engine" ? `0x${BigInt(gasRaw!).toString(16)}` : "";
async function fromTheCopy(raw: string): Promise<unknown> {
  const asked = JSON.parse(raw) as Asked | Asked[];
  const answered = (await ask(asked, false)) as Answer | Answer[];
  const tips = new Set((Array.isArray(asked) ? asked : [asked]).filter((a) => a.method === "eth_maxPriorityFeePerGas").map((a) => a.id));
  for (const a of Array.isArray(answered) ? answered : [answered]) if (tips.has(a.id)) a.result = tip;
  return answered;
}

createServer((req: IncomingMessage, res: ServerResponse) => {
  const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "GET") return json(200, { lateReads: stats.lateReads, of: [...stats.of], turnedAway: stats.turnedAway, kept: kept.size });
  const parts: Buffer[] = [];
  req.on("data", (c: Buffer) => parts.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(parts).toString("utf8");
    try {
      if (mode === "engine") return json(200, await fromTheCopy(raw));
      const asked = JSON.parse(raw) as Asked | Asked[];
      json(200, Array.isArray(asked) ? await Promise.all(asked.map(fromTheRealChain)) : await fromTheRealChain(asked));
    } catch (e) {
      json(502, { jsonrpc: "2.0", id: null, error: { code: -32000, message: (e as Error).message } });
    }
  });
}).listen(port, "127.0.0.1");
