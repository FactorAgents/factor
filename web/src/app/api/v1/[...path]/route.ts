// The one door between a visitor's browser and the engine. The page's own scripts ask here, never the engine and
// never a node, which is what lets the site's content policy say "this site only".
//
// Only what a page needs passes: the public reads, and the two writes a wallet signs. The owner's health answer,
// the hiding of names and anything else the engine has do not: they are not reachable through the site at all.
import { NextResponse, type NextRequest } from "next/server";
import { engineUrl, sampleMode } from "@/lib/data";
import { sampleAgent, sampleJob, sampleJobs, sampleLedger, sampleState } from "@/lib/sample";

const READS = /^(state|agents|agents\/[0-9a-zA-Z-]{3,42}|jobs|jobs\/\d{1,9}|ledger|burns)$/;
const WRITES = /^(agents\/profile|jobs\/title)$/;
const QUERY = ["limit", "before", "show", "agent", "customer"];
const BODY_MOST = 4096;

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
    const r = await fetch(`${engine}/v1/${path}${q.size ? `?${q}` : ""}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
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
  if (text.length > BODY_MOST) return json({ error: "the body is too large" }, 413);
  // who is asking is passed on, so the engine's limit on signed writes counts visitors and not this site
  const from = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  try {
    const r = await fetch(`${engine}/v1/${path}`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(12_000), headers: { "content-type": "application/json", ...(from ? { "x-forwarded-for": from } : {}) }, body: text });
    return json(await r.json(), r.status);
  } catch {
    return json({ error: "the engine is not answering" }, 502);
  }
}
