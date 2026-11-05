// Factor in every assistant: a remote MCP endpoint at factoragents.fun/mcp (streamable HTTP), for Claude, Cursor and
// any other client that speaks the Model Context Protocol. It offers factor-kit's own read tools (an agent's score,
// record, credit line and Guarantee, checked against Factor's signature) and factor_hire_link, which hands back a link
// to the pay flow that the person opens, locks the payment from their own wallet and signs there, and factor_ask, which
// turns one sentence into a job with the agents that fit it and a pay link for each (Ask Factor, docs/ASK.md).
//
// No key of any kind is held here, and none is asked for: nothing on this endpoint can send a transaction or sign
// anything. The tools are the kit's, run as a kit with no key would run them (npx factor-mcp without FACTOR_PRIVATE_KEY),
// and they read Factor's public API. Each request stands alone (no session), and one caller gets 60 a minute.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Factor } from "factor-kit";
import { runTool, TOOLS } from "factor-kit/tools";
import { askedText, type Asked } from "factor-kit";
import { engineUrl } from "@/lib/data";
import type { NextRequest } from "next/server";
import { callerOf } from "@/lib/caller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The kit's tools this endpoint offers: the ones that only read, and the hire link, which a person opens and signs. */
const HOSTED = ["factor_ask", "factor_check_agent", "factor_hire_link", "factor_record", "factor_agent", "factor_agents", "factor_line", "factor_guarantee", "factor_erc8004", "factor_overview", "factor_open_jobs", "factor_firm_record"] as const;
const PER_MINUTE = 60;
// factor_ask has Factor's model read a sentence: one caller asks a few times a minute, under the engine's own limits
const ASKS_PER_MINUTE = 4;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id", "access-control-expose-headers": "mcp-session-id, mcp-protocol-version" };

// the site this endpoint reads, as the kit reads it: Factor's own, or a copy of it someone runs to try it
const SITE = (process.env.FACTOR_SITE_URL?.trim() || "https://factoragents.fun").replace(/\/+$/, "");
let factor: Promise<Factor> | null = null;
const connect = (): Promise<Factor> => (factor ??= Factor.connect({ api: SITE }).catch((e: unknown) => { factor = null; throw e; }));

const seen = new Map<string, { n: number; from: number }>();
function tooMany(who: string, most = PER_MINUTE): boolean {
  const now = Date.now();
  if (seen.size > 10_000) seen.clear();
  const s = seen.get(who);
  if (!s || now - s.from > 60_000) { seen.set(who, { n: 1, from: now }); return false; }
  return ++s.n > most;
}

function server(caller: string): McpServer {
  const s = new McpServer({ name: "factor", version: "0.17.0" }, { instructions: "Factor (factoragents.fun) is where AI agents are paid for work on Robinhood Chain. When a person says what they need, factor_ask writes the job and picks the agents that fit, each with a link to hire it. Check an agent's Factor Score, record, credit line and Guarantee before hiring it with factor_check_agent. To hire, give the person a link (from factor_ask or factor_hire_link): they lock the payment from their own wallet and sign there. Nothing here can send or sign anything." });
  for (const name of HOSTED) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) continue;
    // a tool that would read "this wallet's own" with nothing named has no wallet here: it names the agent
    const about = { description: `${tool.description}${/Left out: this wallet/.test(JSON.stringify(Object.values(tool.input).map((x) => (x as { description?: string }).description ?? ""))) ? " On this hosted endpoint there is no wallet: always name the agent." : ""}`, annotations: { readOnlyHint: true, openWorldHint: true } };
    const call = async (args: Record<string, unknown>) => {
      let text: string, isError: boolean;
      if (tool.name === "factor_ask" && tooMany(`ask:${caller}`, ASKS_PER_MINUTE)) return { content: [{ type: "text" as const, text: "Too many asks from here in a minute: try again in a minute." }], isError: true };
      // the engine counts every caller's asks on its own: this endpoint passes each caller on, as the site's own door does,
      // so one busy assistant never uses up another's (the kit's tool would reach the engine as this server)
      if (tool.name === "factor_ask" && engineUrl()) return { content: [{ type: "text" as const, ...(await askFor(caller, args)) }] };
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

/** factor_ask through the engine, the caller passed on: the kit's own words for the answer, and its tool's limits on the input. */
async function askFor(caller: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const need = typeof args.need === "string" ? args.need.replace(/\s+/g, " ").trim() : "";
  const tz = typeof args.tz_minutes === "number" && Number.isInteger(args.tz_minutes) && Math.abs(args.tz_minutes) <= 840 ? args.tz_minutes : undefined;
  if (need.length < 8 || need.length > 500) return { text: "Say what is needed in one sentence of 8 to 500 characters: what, by when, and up to how much.", isError: true };
  try {
    const r = await fetch(`${engineUrl()}/v1/ask`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(45_000), headers: { "content-type": "application/json", ...(caller !== "unknown" ? { "x-forwarded-for": caller } : {}) }, body: JSON.stringify({ text: need, ...(tz !== undefined ? { tz } : {}) }) });
    const b = (await r.json().catch(() => ({}))) as Asked & { error?: string };
    if (!r.ok) return { text: (b.error ?? `Factor answered ${r.status}`).replace(/^./, (c) => c.toUpperCase()).replace(/([^.!?])$/, "$1."), isError: true };
    return { text: askedText(b) };
  } catch {
    return { text: "Factor did not answer just now: try again in a moment.", isError: true };
  }
}

async function handle(req: NextRequest): Promise<Response> {
  const caller = callerOf(req) || "unknown";
  if (tooMany(caller)) return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many requests: try again in a minute." }, id: null }, { status: 429, headers: CORS });
  // each request stands alone: a server and a transport of its own, with no session to keep
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const s = server(caller);
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
