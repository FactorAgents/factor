// Factor everywhere for any app on any site (engine/src/everywhere.ts): an agent's Factor Score, record, credit line
// headroom and Guarantee in one answer Factor signs. Open to every origin (CORS). Who asks is passed on, so the
// engine's limit counts each caller and not this site; a marketplace's Connect key travels in Authorization and buys it
// a higher limit. Never shared or kept here: an answer holds ten minutes, and the engine keeps each one a few seconds.
//
//   GET /api/v1/everywhere                    whether it is on, the address that signs, and how to check an answer
//   GET /api/v1/everywhere/agent/<id>         its address, its name, or its ERC-8004 identity (8004:<number>)
//   GET /api/v1/everywhere/agents?ids=a,b     up to 25 at once
import { NextResponse, type NextRequest } from "next/server";
import { callerOf } from "@/lib/caller";
import { engineUrl, sampleMode } from "@/lib/data";
import { SAMPLE_EVERYWHERE, sampleSealed } from "@/lib/everywhere";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type, authorization", "access-control-max-age": "86400" };
const json = (body: unknown, status: number, cache = "no-store") => NextResponse.json(body, { status, headers: { ...CORS, "cache-control": cache, "x-content-type-options": "nosniff" } });
const PATHS = /^(agent\/[^/]{3,120}|agents)?$/;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const path = ((await ctx.params).path ?? []).map(encodeURIComponent).join("/");
  if (!PATHS.test(path)) return json({ error: "not found" }, 404);
  const ids = req.nextUrl.searchParams.get("ids");
  if (path === "agents" && (!ids || ids.length > 2000)) return json({ error: "ids is 1 to 25 agents, with commas between them" }, 400);
  if (sampleMode()) {
    if (!path) return json(SAMPLE_EVERYWHERE, 200);
    const a = await sampleSealed(path);
    return json(a.body, a.status);
  }
  const engine = engineUrl();
  if (!engine) return json({ error: "nothing is live yet" }, 503);
  const auth = req.headers.get("authorization");
  const from = callerOf(req);
  try {
    const r = await fetch(`${engine}/v1/everywhere${path ? `/${path}` : ""}${path === "agents" ? `?ids=${encodeURIComponent(ids!)}` : ""}`, {
      cache: "no-store", signal: AbortSignal.timeout(12_000),
      headers: { ...(from ? { "x-forwarded-for": from } : {}), ...(auth && auth.length <= 200 ? { authorization: auth } : {}) },
    });
    // a signed answer may be kept by the caller for a few seconds; it says itself when it stops holding
    return json(await r.json(), r.status, r.ok && path ? "private, max-age=10" : "no-store");
  } catch {
    return json({ error: "the engine is not answering" }, 502);
  }
}
