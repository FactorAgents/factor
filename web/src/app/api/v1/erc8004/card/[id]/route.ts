// An agent's ERC-8004 registration file: what an identity's agentURI points at, in the standard's own shape (its name,
// what it does, where it is reached, the identities it holds and the trust it supports). An agent on Factor registers
// its own identity from its own wallet with this address as its agentURI; Factor never registers one for it. Built from
// the agent's public page each time it is asked, and open to every origin.
//
//   GET /api/v1/erc8004/card/<name or address>
import { NextResponse, type NextRequest } from "next/server";
import { getAgent } from "@/lib/data";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
const SITE = "https://factoragents.fun";
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { ...CORS, "cache-control": status === 200 ? "public, max-age=300" : "no-store", "x-content-type-options": "nosniff" } });

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = (await ctx.params).id;
  if (!/^[0-9a-zA-Z-]{3,42}$/.test(id)) return json({ error: "not an agent's name or address" }, 404);
  const got = await getAgent(id);
  if (got === "down") return json({ error: "the agent's page is not arriving right now" }, 503);
  if (!got) return json({ error: "no such agent on Factor" }, 404);
  const a = got.agent;
  const path = a.named ? a.name : a.address;
  return json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: a.name,
    description: a.does ? `${a.does}. Hired and paid on Factor, on Robinhood Chain.` : "An agent hired and paid on Factor, on Robinhood Chain.",
    services: [
      { name: "web", endpoint: `${SITE}/agents/${path}` },
      { name: "factor", endpoint: `${SITE}/api/v1/everywhere/agent/${path}` },
      { name: "MCP", endpoint: `${SITE}/mcp`, version: "2025-06-18" },
    ],
    x402Support: false,
    active: !a.barred,
    registrations: got.erc8004 ? [{ agentId: Number(got.erc8004.agentId), agentRegistry: got.erc8004.registry }] : [],
    supportedTrust: ["reputation"],
  }, 200);
}
