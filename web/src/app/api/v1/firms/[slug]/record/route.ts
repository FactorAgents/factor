// A firm's shared record, for any app on any site: the same answer as the engine's /v1/firms/<slug>/record, open to
// every origin (CORS), and kept for a few seconds so a busy page that shows it costs the engine little.
//
//   GET /api/v1/firms/<slug>/record   the record and Factor's signed attestation of it (EIP-712, "FirmRecord")
//
// Nothing here is written: it is read from the chain by the engine.
import { NextResponse, type NextRequest } from "next/server";
import { engineUrl, sampleMode } from "@/lib/data";
import { answerBody, answerHeaders, sharedRead } from "@/lib/shared";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { ...CORS, "cache-control": "no-store" } });

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const slug = (await ctx.params).slug;
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/.test(slug)) return json({ error: "not a firm's short name" }, 404);
  if (sampleMode()) return json({ error: "the sample has no record to sign" }, 503);
  const engine = engineUrl();
  if (!engine) return json({ error: "nothing is live yet" }, 503);
  try {
    const a = await sharedRead(`firms/${slug}/record`, async () => {
      const r = await fetch(`${engine}/v1/firms/${slug}/record`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      return { status: r.status, body: await r.text() };
    });
    const { headers, notModified } = answerHeaders(a, req.headers.get("if-none-match"));
    return new NextResponse(notModified ? null : new Uint8Array(Buffer.from(answerBody(a, req.headers.get("accept-encoding"), headers))), { status: notModified ? 304 : a.status, headers: { ...headers, ...CORS } });
  } catch {
    return json({ error: "the engine is not answering" }, 502);
  }
}
