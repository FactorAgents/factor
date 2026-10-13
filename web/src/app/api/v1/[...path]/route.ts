// The one door between a visitor's browser and the engine. The page's own scripts ask here, never the engine and
// never a node, which is what lets the site's content policy say "this site only".
//
// Only what a page needs passes: the public reads, and the two writes a wallet signs. The owner's health answer,
// the hiding of names and anything else the engine has do not: they are not reachable through the site at all.
import { NextResponse, type NextRequest } from "next/server";
import { callerOf } from "@/lib/caller";
import { engineUrl, sampleMode } from "@/lib/data";
import { sampleAgent, sampleJob, sampleJobs, sampleLedger, sampleState } from "@/lib/sample";

const READS = /^(state|agents|agents\/made\/0x[0-9a-fA-F]{40}|agents\/[0-9a-zA-Z-]{3,42}|jobs|jobs\/\d{1,9}|ledger|burns|accounts\/0x[0-9a-fA-F]{40}|accounts\/relay\/0x[0-9a-f]{64}|accounts\/by-credential\/0x[0-9a-f]{2,2046})$/;
// two things a wallet signs, and what an account without a wallet asks of the engine (lib/passkey.ts)
const WRITES = /^(agents\/profile|agents\/make|agents\/pause|jobs\/title|jobs\/brief|jobs\/delivery|accounts|accounts\/check|accounts\/call|accounts\/relay)$/;
const QUERY = ["limit", "before", "show", "agent", "customer"];
const BODY_MOST = 4096;
// an order of an account carries its calls and a passkey's answer
const ORDER_MOST = 32_768;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

// With the sample on there is no engine: the same reads are answered from the sample, so every page works alone.
function fromSample(path: string, q: URLSearchParams): unknown {
  if (path === "state") return sampleState();
  if (path === "agents") return { items: sampleState().agents };
  if (path === "jobs") return sampleJobs({ agent: q.get("agent") ?? undefined, customer: q.get("customer") ?? undefined });
  if (path === "ledger") return sampleLedger(Number(q.get("limit")) || 50, Number(q.get("before")) || undefined);
  if (path === "burns") return { total: sampleState().burns.length, more: false, items: sampleState().burns };
  if (path.startsWith("agents/")) return sampleAgent(path.slice(7));
  if (path.startsWith("jobs/")) return sampleJob(Number(path.slice(5)));
  return null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  if (!READS.test(path)) return json({ error: "not found" }, 404);
  const q = new URLSearchParams();
  for (const k of QUERY) {
    const v = req.nextUrl.searchParams.get(k);
    if (v !== null && v.length <= 64) q.set(k, v);
  }
  if (sampleMode()) {
    const body = fromSample(path, q);
    return body ? json(body) : json({ error: "not found" }, 404);
  }
  const engine = engineUrl();
  if (!engine) return json({ error: "nothing is live yet" }, 503);
  try {
    // who is asking is passed on for the reads that cost the engine a question to the chain (an account's balance)
    const from = path.startsWith("accounts/") ? callerOf(req) : "";
    const r = await fetch(`${engine}/v1/${path}${q.size ? `?${q}` : ""}`, { cache: "no-store", signal: AbortSignal.timeout(12_000), headers: from ? { "x-forwarded-for": from } : {} });
    return json(await r.json(), r.status);
  } catch {
    return json({ error: "the engine is not answering" }, 502);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  if (!WRITES.test(path)) return json({ error: "not found" }, 404);
  const engine = engineUrl();
  if (!engine) return json({ error: "nothing is live yet" }, 503);
  const text = await req.text();
  // a brief is up to 12,000 characters and a piece of work up to 200,000
  const most = path.startsWith("accounts") ? ORDER_MOST : path === "jobs/brief" || path === "agents/make" ? 64_000 : path === "jobs/delivery" ? 900_000 : BODY_MOST;
  if (text.length > most) return json({ error: "the body is too large" }, 413);
  // who is asking is passed on, so the engine's limit on signed writes counts visitors and not this site
  const from = callerOf(req);
  try {
    const r = await fetch(`${engine}/v1/${path}`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(12_000), headers: { "content-type": "application/json", ...(from ? { "x-forwarded-for": from } : {}) }, body: text });
    return json(await r.json(), r.status);
  } catch {
    return json({ error: "the engine is not answering" }, 502);
  }
}
