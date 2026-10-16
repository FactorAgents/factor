// Pay with Factor over x402: an agent's work, bought by another agent's program over HTTP.
//
//   GET or POST /api/v1/x402/<link>              402 Payment Required, with what to pay: lock the price for the agent
//                                                on Factor's desk, and add the deal's share to the burn
//   the same, with X-PAYMENT: base64 of { x402Version: 1, scheme: "factor-lock", network: "robinhood-chain",
//                                         payload: { job, lockTx, burnTx } }
//                                                200 and the job's number, once the lock is checked on the chain,
//                                                with X-PAYMENT-RESPONSE
//
// The engine answers (engine/src/pay.ts). Nothing here is kept, and the payment itself never passes through: the
// paying program sends it to the desk on the chain.
import { NextResponse, type NextRequest } from "next/server";
import { callerOf } from "@/lib/caller";
import { engineUrl, sampleMode } from "@/lib/data";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, x-payment", "access-control-expose-headers": "x-payment-response", "access-control-max-age": "86400" };
const TOKEN = /^[A-Za-z0-9_-]{20,6000}\.[A-Za-z0-9_-]{80,3000}$/;

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

async function answer(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const token = (await ctx.params).token;
  const no = (status: number, error: string) => NextResponse.json({ x402Version: 1, error }, { status, headers: { ...CORS, "cache-control": "no-store" } });
  if (!TOKEN.test(token)) return no(404, "that is not a Pay with Factor link");
  const engine = engineUrl();
  if (!engine || sampleMode()) return no(503, "nothing is live yet");
  const payment = req.headers.get("x-payment");
  if (payment && payment.length > 8192) return no(400, "the X-PAYMENT header is too long");
  // what the 402 names as the resource: this very address, as the caller asked for it
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "factoragents.fun";
  const resource = `https://${host}/api/v1/x402/${token}`;
  try {
    const from = callerOf(req);
    const r = await fetch(`${engine}/v1/x402/${token}`, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(20_000), headers: { "x-factor-resource": resource, ...(payment ? { "x-payment": payment } : {}), ...(from ? { "x-forwarded-for": from } : {}) } });
    const body = await r.text();
    const settled = r.headers.get("x-payment-response");
    return new NextResponse(body, { status: r.status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(settled ? { "x-payment-response": settled } : {}) } });
  } catch {
    return no(502, "the engine is not answering");
  }
}

export const GET = answer;
export const POST = answer;
