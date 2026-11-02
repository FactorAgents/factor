// A stand-in for Raeto, for the tests and for runs that must spend nothing. Its answers have the shape the real API gave
// on 2 Nov 2026: the same fields, the same headers, the same last chunk of a stream, and the account's user_id on an
// error, which the gateway must not pass on.
//
//   tsx scripts/stub-raeto.ts <port> <the key it takes>
//
// What it does is chosen by a mark anywhere in the last message: [stub:429], [stub:500], [stub:timeout], [stub:retry],
// [stub:nocost], [stub:nousage], [stub:break], [stub:errorchunk], [stub:empty], [stub:402], [stub:401], [stub:400],
// [stub:409], [stub:budget], [stub:dear], [stub:thinking]. No mark: a plain answer. It costs what the real one costs for a short request to a cheap
// model: the provider's price for the tokens, 8%, and a routing fee, and a run can read what it charged in `charged`.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

export interface RaetoStub {
  url: string;
  seen: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[];
  charged: number[];
  /** what /v1/me says the key can still spend */
  available: number;
  meCalls: number;
  close(): Promise<void>;
  server: Server;
  /** a call held open until this settles, to look at what is held meanwhile */
  gate: Promise<void> | null;
  /** what it answers with, for a service that wants its answer in a certain shape */
  say: string | null;
  /** every call fails with a 500 */
  down: boolean;
}

const CHEAP = { model: "mistralai/mistral-small-3.2-24b-instruct", provider: "Venice", in: 0.075, out: 0.2, tier: "fast" };
const TOP = { model: "anthropic/claude-sonnet-5.5", provider: "Anthropic", in: 2, out: 10, tier: "top" };
const ROUTE_FEE = 0.000029;
const USER_ID = "user_stub0000000000000000000000";

const refuse = (status: number, type: string, message: string, extra: Record<string, unknown> = {}) => ({ status, body: { error: { message, type, code: status }, ...extra } });
const REFUSALS: Record<string, ReturnType<typeof refuse>> = {
  "429": refuse(429, "rate_limit_error", "Too many requests."),
  "500": refuse(500, "server_error", "Something went wrong."),
  "502": refuse(502, "upstream_error", "The model provider did not answer."),
  "402": refuse(402, "insufficient_balance", "Out of credits."),
  "401": refuse(401, "authentication_error", "Invalid API key."),
  "400": refuse(400, "", "nope/none is not a valid model ID", { user_id: USER_ID }),
  "409": refuse(409, "loop_detected", "This agent kept sending the same request."),
  budget: refuse(402, "task_budget_reached", "Task factor-job-1 has spent $0.0000 of its $0.0000 budget, so Raeto stopped it here."),
};

export function raetoStub(key: string, port = 0): Promise<RaetoStub> {
  const stub: RaetoStub = { url: "", seen: [], charged: [], available: 5, meCalls: 0, gate: null, say: null, down: false, server: null as unknown as Server, close: async () => { stub.server.closeAllConnections(); await new Promise<void>((done) => stub.server.close(() => done())); } };
  stub.server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(parts);
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== `Bearer ${key}`) return json(401, { error: { code: 401, message: "Invalid API key.", type: "authentication_error" } });
      if (req.method === "GET" && req.url === "/v1/me") {
        stub.meCalls++;
        return json(200, { object: "account", address: "0x00000000000000000000000000000000000000aa", balance_usd: stub.available, fee_pct: 8, key: { name: "stub", kind: "dev", spent_usd: 0, limit_usd: 5, models: null }, available_usd: stub.available });
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") return json(404, { error: "not found" });
      const body = JSON.parse(raw.toString("utf8")) as { model: string; max_tokens?: number; max_completion_tokens?: number; stream?: boolean; messages: { content?: unknown }[] };
      stub.seen.push({ path: req.url, headers: req.headers, body });
      if (stub.gate) await stub.gate;
      const last = String(body.messages.at(-1)?.content ?? "");
      const mark = /\[stub:([a-z0-9]+)\]/.exec(last)?.[1] ?? "";
      if (mark === "timeout") return; // never answers: the gateway's clock has to end it
      const no = stub.down ? REFUSALS["500"] : REFUSALS[mark];
      if (no) return json(no.status, no.body, mark === "429" ? { "retry-after": "7" } : {});

      const m = mark === "retry" || mark === "dear" ? TOP : CHEAP;
      const input = Math.ceil(raw.length / 8);
      const output = Math.min(40, body.max_completion_tokens ?? body.max_tokens ?? 40);
      const provider = (input * m.in + output * m.out) / 1e6;
      const cost = mark === "dear" ? 50 : Math.round(((provider * 1.08 + (m === TOP ? 0 : ROUTE_FEE)) * 1e6)) / 1e6;
      const id = `gen-stub-${stub.seen.length}`;
      const said = stub.say ?? "A plain answer from the stand-in.";
      const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, cost: provider, is_byok: false, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0, video_tokens: 0 }, cost_details: { upstream_inference_cost: provider }, completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0, audio_tokens: 0 } };
      const route = `model=${m.model}; mode=${body.model.split(":")[1] ?? "auto"}; tier=${m.tier}; why=simple request; est_saved_pct=98${mark === "retry" ? "; escalated_from=deepseek/deepseek-v4-pro; escalated_why=empty answer" : ""}`;
      const headers: Record<string, string> = { "x-raeto-model": m.model, "x-raeto-tier": m.tier, "x-raeto-route": route, ...(req.headers["x-raeto-task"] ? { "x-raeto-task": `id=${String(req.headers["x-raeto-task"])}; calls=1; spent=${cost.toFixed(6)}${req.headers["x-raeto-task-budget"] ? `; budget=${String(req.headers["x-raeto-task-budget"])}` : ""}` } : {}) };
      const quiet = mark === "nocost" || mark === "nousage";
      if (!quiet && mark !== "break" && mark !== "errorchunk" && mark !== "empty") stub.charged.push(cost);

      if (!body.stream) {
        if (mark === "empty") return json(200, { id, object: "chat.completion", model: m.model, choices: [] }, { "x-raeto-cost": "0.00000000", ...headers });
        return json(200, { id, object: "chat.completion", created: 1793617549, model: m.model, provider: m.provider, system_fingerprint: null, service_tier: "default", choices: [{ index: 0, logprobs: null, finish_reason: "stop", native_finish_reason: "stop", message: mark === "thinking" ? { role: "assistant", content: null, refusal: null, reasoning: "Let me think about this." } : { role: "assistant", content: said, refusal: null, reasoning: null } }], ...(mark === "nousage" ? {} : { usage }) }, { ...(quiet ? {} : { "x-raeto-cost": cost.toFixed(8), "x-raeto-saved": "0.00006800", "x-raeto-saved-pct": "68", "x-raeto-route-fee": ROUTE_FEE.toFixed(8) }), ...headers });
      }
      res.writeHead(200, { "content-type": "text/event-stream", ...headers });
      res.write(": OPENROUTER PROCESSING\n\n");
      const chunk = (delta: unknown, finish: string | null, more: Record<string, unknown> = {}) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1793617551, model: m.model, provider: m.provider, choices: [{ index: 0, delta, finish_reason: finish, native_finish_reason: finish }], ...more })}\n\n`);
      for (const word of said.split(" ")) {
        chunk({ content: `${word} `, role: "assistant" }, null);
        await new Promise((r) => setTimeout(r, 3));
        if (mark === "break") return void req.socket.destroy();
      }
      if (mark === "errorchunk") { res.write(`data: ${JSON.stringify({ id, error: { code: 502, message: "Provider disconnected" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] })}\n\n`); return void res.end("data: [DONE]\n\n"); }
      chunk({ content: "" }, "stop");
      chunk({ content: "" }, "stop", { service_tier: "default", ...(mark === "nousage" ? {} : { usage }), ...(quiet ? {} : { raeto: { model: m.model, cost_usd: cost, saved_usd: 0.000052, saved_pct: 66 } }) });
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((done) => stub.server.listen(port, "127.0.0.1", () => { stub.url = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}/v1`; done(stub); }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]);
  const takes = process.argv[3] ?? "";
  if (!port || !takes) throw new Error("usage: stub-raeto.ts <port> <key>");
  void raetoStub(takes, port);
}
