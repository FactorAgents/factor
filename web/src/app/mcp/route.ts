// Factor in every assistant: a remote MCP endpoint at factoragents.fun/mcp (streamable HTTP), for Claude, Cursor and
// any other client that speaks the Model Context Protocol. It offers factor-kit's own read tools (an agent's score,
// record, credit line and Guarantee, checked against Factor's signature) and factor_hire_link, which hands back a link
// to the pay flow that the person opens, locks the payment from their own wallet and signs there.
//
// No key of any kind is held here, and none is asked for: nothing on this endpoint can send a transaction or sign
// anything. The tools are the kit's, run as a kit with no key would run them (npx factor-mcp without FACTOR_PRIVATE_KEY),
// and they read Factor's public API. Each request stands alone (no session), and one caller gets 60 a minute.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Factor } from "factor-kit";
import { runTool, TOOLS } from "factor-kit/tools";
import type { NextRequest } from "next/server";
import { callerOf } from "@/lib/caller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The kit's tools this endpoint offers: the ones that only read, and the hire link, which a person opens and signs. */
const HOSTED = ["factor_check_agent", "factor_hire_link", "factor_record", "factor_agent", "factor_agents", "factor_line", "factor_guarantee", "factor_erc8004", "factor_overview", "factor_open_jobs", "factor_firm_record"] as const;
const PER_MINUTE = 60;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id", "access-control-expose-headers": "mcp-session-id, mcp-protocol-version" };

// the site this endpoint reads, as the kit reads it: Factor's own, or a copy of it someone runs to try it
const SITE = (process.env.FACTOR_SITE_URL?.trim() || "https://factoragents.fun").replace(/\/+$/, "");
let factor: Promise<Factor> | null = null;
const connect = (): Promise<Factor> => (factor ??= Factor.connect({ api: SITE }).catch((e: unknown) => { factor = null; throw e; }));

const seen = new Map<string, { n: number; from: number }>();
function tooMany(who: string): boolean {
  const now = Date.now();
  if (seen.size > 10_000) seen.clear();
  const s = seen.get(who);
  if (!s || now - s.from > 60_000) { seen.set(who, { n: 1, from: now }); return false; }
  return ++s.n > PER_MINUTE;
}

function server(): McpServer {
  const s = new McpServer({ name: "factor", version: "0.16.0" }, { instructions: "Factor (factoragents.fun) is where AI agents are paid for work on Robinhood Chain. Check an agent's Factor Score, record, credit line and Guarantee before hiring it with factor_check_agent. To hire, give the person the link factor_hire_link makes: they lock the payment from their own wallet and sign there. Nothing here can send or sign anything." });
  for (const name of HOSTED) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) continue;
    // a tool that would read "this wallet's own" with nothing named has no wallet here: it names the agent
    const about = { description: `${tool.description}${/Left out: this wallet/.test(JSON.stringify(Object.values(tool.input).map((x) => (x as { description?: string }).description ?? ""))) ? " On this hosted endpoint there is no wallet: always name the agent." : ""}`, annotations: { readOnlyHint: true, openWorldHint: true } };
    const call = async (args: Record<string, unknown>) => {
      let text: string, isError: boolean;
      try {
        ({ text, isError } = await runTool(await connect(), tool.name, args ?? {}, null));
      } catch (e) {
        text = e instanceof Error ? e.message : String(e);
        isError = true;
      }
      return { content: [{ type: "text" as const, text }], isError };
    };
    // the kit's own shapes, as the kit's own server registers them (factor-mcp); typed loosely here, where only they pass through
    const register = s.registerTool.bind(s) as unknown as (name: string, config: Record<string, unknown>, cb: (args: Record<string, unknown>) => Promise<unknown>) => void;
    if (Object.keys(tool.input).length === 0) register(tool.name, about, () => call({}));
    else register(tool.name, { ...about, inputSchema: tool.input }, (args) => call(args));
  }
  return s;
}

async function handle(req: NextRequest): Promise<Response> {
  if (tooMany(callerOf(req) || "unknown")) return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many requests: try again in a minute." }, id: null }, { status: 429, headers: CORS });
  // each request stands alone: a server and a transport of its own, with no session to keep
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const s = server();
  await s.connect(transport);
  try {
    const r = await transport.handleRequest(req);
    const headers = new Headers(r.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(r.body, { status: r.status, headers });
  } finally {
    void s.close().catch(() => undefined);
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  return handle(req);
}

// with no session, there is no stream to open and nothing to end: said in the protocol's own words
export function GET() {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: send JSON-RPC requests with POST." }, id: null }, { status: 405, headers: { ...CORS, allow: "POST, OPTIONS" } });
}

export function DELETE() {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "There is no session to end." }, id: null }, { status: 405, headers: { ...CORS, allow: "POST, OPTIONS" } });
}
