// Compute credit, through the site: the same door as ../[...path]/route.ts, for the engine's gateway.
//
// An agent's program calls here with the key it signed for, in the shape of Anthropic's API or of OpenAI's, so a library
// the agent already has works with only its address changed. A call to a model is passed to the engine and the answer is
// passed back as it arrives, a stream staying a stream. Nothing of a request is kept or logged here.
import type { NextRequest } from "next/server";
import { callerOf } from "@/lib/caller";
import { engineUrl, sampleMode } from "@/lib/data";
import { sampleState } from "@/lib/sample";
import { answerHeaders, sharedRead } from "@/lib/shared";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const READS = /^(models|v1\/models|balance|credit\/0x[0-9a-fA-F]{40})$/;
const WRITES = /^(key|v1\/messages|v1\/chat\/completions)$/;
const KEY_MOST = 4096;
// the engine has its own limit on a request's size (2 MB unless its owner says otherwise): this one stops the absurd
const BODY_MOST = 4_000_000;
const KEY = /^(?:Bearer\s+)?fck_[A-Za-z0-9_-]{20,64}$/i;

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
// a few of the models, for a look at the site with no engine behind it
const SAMPLE_MODELS = { object: "list", data: [
  ["anthropic/claude-sonnet-4.5", "Anthropic: Claude Sonnet 4.5", 3.15, 15.75], ["openai/gpt-5", "OpenAI: GPT-5", 1.3125, 10.5],
  ["google/gemini-2.5-pro", "Google: Gemini 2.5 Pro", 1.3125, 10.5], ["x-ai/grok-4", "xAI: Grok 4", 3.15, 15.75],
  ["deepseek/deepseek-chat", "DeepSeek: DeepSeek V3", 0.2625, 0.84], ["meta-llama/llama-4-maverick", "Meta: Llama 4 Maverick", 0.1575, 0.63],
  ["mistralai/mistral-medium-3", "Mistral: Mistral Medium 3", 0.42, 2.1],
].map(([id, name, inUsd, outUsd]) => ({ id, object: "model", owned_by: String(id).split("/")[0], name, pricing: { inUsd, outUsd } })) };
const said = (status: number, type: string, message: string) => Response.json({ type: "error", error: { type, message } }, { status, headers: HEADERS });
const notLive = () => said(503, "api_error", "Nothing is live yet.");

// what is passed on of a caller's headers: its key, and which version of the model maker's API it speaks
function passed(req: NextRequest): Record<string, string> {
  const h: Record<string, string> = {};
  // who is asking, as the host says it and never as the caller wrote it: the engine counts requests for a key by it
  const from = callerOf(req);
  if (from) h["x-forwarded-for"] = from;
  for (const name of ["x-api-key", "authorization", "anthropic-version", "content-type"]) {
    const v = req.headers.get(name);
    if (v && v.length <= 512) h[name] = v;
  }
  return h;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  if (!READS.test(path)) return said(404, "not_found_error", "There is nothing at this address.");
  if (sampleMode()) return path === "models" ? Response.json(sampleState().compute, { headers: HEADERS }) : path === "v1/models" ? Response.json(SAMPLE_MODELS, { headers: HEADERS }) : notLive();
  const engine = engineUrl();
  if (!engine) return notLive();
  try {
    // the model lists and what an agent has left are the same for everybody who asks: shared (lib/shared.ts)
    if (path !== "balance") {
      const a = await sharedRead(`compute/${path}`, async () => {
        const r = await fetch(`${engine}/v1/compute/${path}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
        return { status: r.status, body: await r.text() };
      });
      const { headers, notModified } = answerHeaders(a, req.headers.get("if-none-match"));
      return new Response(notModified ? null : a.body, { status: notModified ? 304 : a.status, headers });
    }
    const r = await fetch(`${engine}/v1/compute/${path}`, { cache: "no-store", signal: AbortSignal.timeout(12_000), headers: passed(req) });
    return new Response(await r.text(), { status: r.status, headers: { ...HEADERS, "content-type": "application/json; charset=utf-8" } });
  } catch {
    return said(502, "api_error", "The engine is not answering.");
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  if (!WRITES.test(path)) return said(404, "not_found_error", "There is nothing at this address.");
  const engine = engineUrl();
  if (!engine) return notLive();
  // a call to a model with nothing that could be one of Factor's keys is turned away before its body is read
  if (path !== "key" && !KEY.test(req.headers.get("x-api-key") ?? req.headers.get("authorization") ?? "")) return said(401, "authentication_error", "That key is not one of Factor's compute keys, or it has run out. Sign for a new one.");
  const most = path === "key" ? KEY_MOST : BODY_MOST;
  if (Number(req.headers.get("content-length") ?? 0) > most) return said(413, "request_too_large", "The request is too large.");
  const body = await req.arrayBuffer();
  if (body.byteLength > most) return said(413, "request_too_large", "The request is too large.");
  try {
    // a model may take minutes to answer: the wait is the engine's to end, not this door's
    const r = await fetch(`${engine}/v1/compute/${path}`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(path === "key" ? 12_000 : 600_000), headers: passed(req), body });
    const id = r.headers.get("request-id");
    return new Response(r.body, { status: r.status, headers: { ...HEADERS, "content-type": r.headers.get("content-type") ?? "application/json", ...(id ? { "request-id": id } : {}), "x-accel-buffering": "no" } });
  } catch {
    return said(502, "api_error", "The engine is not answering.");
  }
}
