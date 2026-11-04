// The file a Factor Score entry on ERC-8004 points at (engine/src/erc8004score.ts), word for word: its keccak256 is the
// feedbackHash the entry carries on Robinhood Chain, so the words are passed on exactly as the engine keeps them.
// Open to every origin (CORS), like the job entries' files.
//
//   GET /api/v1/erc8004/score/<n>
import { NextResponse, type NextRequest } from "next/server";
import { engineUrl, sampleMode } from "@/lib/data";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { ...CORS, "cache-control": "no-store" } });

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ n: string }> }) {
  const n = (await ctx.params).n;
  if (!/^\d{1,9}$/.test(n)) return json({ error: "not an entry's number" }, 404);
  if (sampleMode()) return json({ error: "the sample writes nothing to ERC-8004" }, 404);
  const engine = engineUrl();
  if (!engine) return json({ error: "nothing is live yet" }, 503);
  try {
    const r = await fetch(`${engine}/v1/erc8004/score/${Number(n)}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    const text = await r.text();
    return new NextResponse(text, { status: r.status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": r.ok ? "public, max-age=300" : "no-store", "x-content-type-options": "nosniff" } });
  } catch {
    return json({ error: "the engine is not answering" }, 502);
  }
}
