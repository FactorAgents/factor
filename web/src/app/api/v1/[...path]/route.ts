// The one door between a visitor's browser and the engine. The page's own scripts ask here, never the engine and
// never a node, which is what lets the site's content policy say "this site only".
//
// Only what a page needs passes: the public reads, and the two writes a wallet signs. The owner's health answer,
// the hiding of names and anything else the engine has do not: they are not reachable through the site at all.
import { NextResponse, type NextRequest } from "next/server";
import { callerOf } from "@/lib/caller";
import { engineUrl, sampleMode } from "@/lib/data";
import { sampleAgent, sampleAutoApply, sampleCoin, sampleCoins, sampleLine, sampleLines, sampleFirm, sampleJob, sampleJobs, sampleLedger, sampleOpenJob, sampleOpenJobs, samplePlan, sampleState } from "@/lib/sample";
import { answerBody, answerHeaders, sharedRead } from "@/lib/shared";

const READS = /^(state|pulse|desk|agents|agents\/made\/0x[0-9a-fA-F]{40}|agents\/[0-9a-zA-Z-]{3,42}|jobs|jobs\/\d{1,9}|jobs\/\d{1,9}\/tree|ledger|burns|accounts\/0x[0-9a-fA-F]{40}|accounts\/relay\/0x[0-9a-f]{64}|accounts\/by-credential\/0x[0-9a-f]{2,2046}|pay\/link\/[A-Za-z0-9_-]{20,6000}\.[A-Za-z0-9_-]{80,3000}|pay\/links\/0x[0-9a-fA-F]{40}|firms|firms\/[a-z0-9-]{3,32}|plans|plans\/0x[0-9a-f]{64}|erc8004|erc8004\/[0-9a-zA-Z-]{3,42}|openjobs|openjobs\/0x[0-9a-f]{64}|autoapply\/[0-9a-zA-Z-]{3,42}|verified|verified\/[0-9a-zA-Z-]{3,42}|coins|coins\/about|coins\/[0-9a-zA-Z-]{3,42}|lines|lines\/about|lines\/[0-9a-zA-Z-]{3,42})$/;
// two things a wallet signs, what an account without a wallet asks of the engine (lib/passkey.ts), a job paid
// through a Pay with Factor link (lib/pay.ts), an agent hiring another for part of its job (lib/subjobs.ts), and a
// firm formed, joined, left or hired (lib/firms.ts), and a monthly plan signed, a month of it linked, or a plan stopped
// (lib/plans.ts), and an agent linking its ERC-8004 identity (lib/erc8004.ts), and an open job posted, applied to,
// linked to the lock that hired its agent, or taken down (lib/openjobs.ts), and an agent's auto-apply rules (lib/autoapply.ts),
// and an owner verifying the wallet that runs its agent (lib/verified.ts), and the maker of an agent Factor runs asking
// for the agent's permission to launch its coin (lib/coins.ts)
const WRITES = /^(match|agents\/profile|agents\/make|agents\/pause|jobs\/title|jobs\/brief|jobs\/delivery|accounts|accounts\/check|accounts\/call|accounts\/relay|pay\/deal|pay\/links|subjobs\/plan|subjobs\/link|firms\/form|firms\/join|firms\/leave|firms\/hire|plans\/create|plans\/month|plans\/stop|erc8004\/link|openjobs\/post|openjobs\/apply|openjobs\/hire|openjobs\/close|openjobs\/withdraw|autoapply\/rules|verified\/check|coins\/permission)$/;
const QUERY = ["limit", "before", "show", "agent", "customer", "firm", "verified", "sort"];
const BODY_MOST = 4096;
// an order of an account carries its calls and a passkey's answer
const ORDER_MOST = 32_768;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

// With the sample on there is no engine: the same reads are answered from the sample, so every page works alone.
function fromSample(path: string, q: URLSearchParams): unknown {
  if (path === "state") return sampleState();
  if (path === "pulse") return { items: [] };
  if (path === "desk") return { on: false, writing: false, letter: null, latest: [], items: [] };
  if (path === "agents") return { items: sampleState().agents };
  if (path === "jobs") return sampleJobs({ agent: q.get("agent") ?? undefined, customer: q.get("customer") ?? undefined });
  if (path === "ledger") return sampleLedger(Number(q.get("limit")) || 50, Number(q.get("before")) || undefined);
  if (path === "burns") return { total: sampleState().burns.length, more: false, items: sampleState().burns };
  if (path.startsWith("agents/")) return sampleAgent(path.slice(7));
  if (path.startsWith("jobs/")) return sampleJob(Number(path.slice(5)));
  if (path === "firms") return { enabled: true, items: sampleState().firms?.items ?? [] };
  if (path.startsWith("firms/")) return sampleFirm(path.slice(6));
  if (path === "plans") return { enabled: false, items: [] };
  if (path.startsWith("plans/")) return samplePlan(path.slice(6));
  if (path === "erc8004") return { enabled: false };
  if (path === "openjobs") return sampleOpenJobs();
  if (path.startsWith("openjobs/")) return sampleOpenJob(path.slice(9));
  if (path.startsWith("autoapply/")) return sampleAutoApply(path.slice(10));
  if (path === "verified" || path.startsWith("verified/")) return { enabled: false };
  if (path === "coins") return sampleCoins(q.get("sort") === "new" ? "new" : "fees");
  if (path.startsWith("coins/") && path !== "coins/about") return sampleCoin(path.slice(6));
  if (path === "coins/about") return { enabled: false, launcher: null };
  if (path === "lines" || path === "lines/about") return { ...sampleState().lines, items: path === "lines" ? sampleLines() : undefined };
  if (path.startsWith("lines/")) return ((l) => (l ? { line: l } : null))(sampleLine(path.slice(6)));
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
  const url = `${engine}/v1/${path}${q.size ? `?${q}` : ""}`;
  // an account's reads are its own, and cost the engine a question to the chain: asked for each caller, with who it is
  if (path.startsWith("accounts/")) {
    try {
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000), headers: { "x-forwarded-for": callerOf(req) } });
      return json(await r.json(), r.status);
    } catch {
      return json({ error: "the engine is not answering" }, 502);
    }
  }
  // every other read is the same for everybody: one answer from the engine, shared (lib/shared.ts)
  try {
    const a = await sharedRead(`${path}?${q}`, async () => {
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      return { status: r.status, body: await r.text() };
    });
    const { headers, notModified } = answerHeaders(a, req.headers.get("if-none-match"));
    return new NextResponse(notModified ? null : new Uint8Array(Buffer.from(answerBody(a, req.headers.get("accept-encoding"), headers))), { status: notModified ? 304 : a.status, headers });
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
  const most = path.startsWith("accounts") || path.startsWith("pay/") ? ORDER_MOST : path === "jobs/brief" || path === "agents/make" || path === "match" || path === "subjobs/plan" || path === "firms/hire" || path === "plans/create" || path === "openjobs/post" ? 64_000 : path === "jobs/delivery" ? 900_000 : BODY_MOST;
  if (text.length > most) return json({ error: "the body is too large" }, 413);
  // who is asking is passed on, so the engine's limit on signed writes counts visitors and not this site
  const from = callerOf(req);
  try {
    // matching asks a model, which takes a few seconds more than a signed write
    const r = await fetch(`${engine}/v1/${path}`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(path === "match" ? 30_000 : 12_000), headers: { "content-type": "application/json", ...(from ? { "x-forwarded-for": from } : {}) }, body: text });
    return json(await r.json(), r.status);
  } catch {
    return json({ error: "the engine is not answering" }, 502);
  }
}
