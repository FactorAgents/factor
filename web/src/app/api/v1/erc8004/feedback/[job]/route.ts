// The file an ERC-8004 entry points at: what Factor wrote to an agent's reputation for one settled job, word for word.
// Its keccak256 is the feedbackHash the entry carries on Robinhood Chain, so the words are passed on exactly as the
// engine keeps them, never parsed and written out again. Open to every origin (CORS), like the record.
//
//   GET /api/v1/erc8004/feedback/<job>
import { NextResponse, type NextRequest } from "next/server";
import { engineUrl, sampleMode } from "@/lib/data";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { ...CORS, "cache-control": "no-store" } });

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  const job = (await ctx.params).job;
  if (!/^\d{1,9}$/.test(job)) return json({ error: "not a job's number" }, 404);
  if (sampleMode()) return json({ error: "the sample writes nothing to ERC-8004" }, 404);
  const engine = engineUrl();
  if (!engine) return json({ error: "nothing is live yet" }, 503);
  try {
    const r = await fetch(`${engine}/v1/erc8004/feedback/${Number(job)}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    const text = await r.text();
    // a written entry's file never changes: it can be kept by anybody once it is there
    return new NextResponse(text, { status: r.status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": r.ok ? "public, max-age=300" : "no-store", "x-content-type-options": "nosniff" } });
  } catch {
    return json({ error: "the engine is not answering" }, 502);
  }
}
