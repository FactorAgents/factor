// Factor Connect for a marketplace (engine/src/everywhere.ts). Its key travels in Authorization and is passed to the
// engine untouched; nothing of it is kept here. Who asks is passed on for the engine's limits.
//
//   POST /api/v1/connect/register { name, site, hook? }    the key, shown once
//   POST /api/v1/connect/rotate | hook | hire | me | ping   with the key
//   GET  /api/v1/connect/ticket/<id>                        what the hire page shows for a hire link
//   POST /api/v1/connect/claim { ticket, job }              the hire page, once the customer locked the job
import { NextResponse, type NextRequest } from "next/server";
import { callerOf } from "@/lib/caller";
import { engineUrl } from "@/lib/data";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization", "access-control-max-age": "86400" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { ...CORS, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
const WRITES = /^(register|rotate|hook|hire|me|ping|claim)$/;
const MOST = 16_384;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

async function ask(req: NextRequest, url: string, init: RequestInit): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  const from = callerOf(req);
  try {
    const r = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/json", ...(from ? { "x-forwarded-for": from } : {}), ...(auth && auth.length <= 200 ? { authorization: auth } : {}) } });
    return json(await r.json(), r.status);
  } catch {
    return json({ error: "the engine is not answering" }, 502);
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  const m = /^ticket\/([0-9a-f]{20})$/.exec(path);
  if (!m) return json({ error: "not found" }, 404);
  const engine = engineUrl();
  if (!engine) return json({ error: "nothing is live yet" }, 503);
  return ask(req, `${engine}/v1/connect/ticket/${m[1]}`, { method: "GET" });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  if (!WRITES.test(path)) return json({ error: "not found" }, 404);
  const engine = engineUrl();
  if (!engine) return json({ error: "nothing is live yet" }, 503);
  const text = await req.text();
  if (text.length > MOST) return json({ error: "the body is too large" }, 413);
  return ask(req, `${engine}/v1/connect/${path}`, { method: "POST", body: text || "{}" });
}
