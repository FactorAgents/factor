// A stand-in for the model maker, for the end-to-end runs: it answers /v1/messages in the model maker's shape and
// calls no model, so a run costs nothing. It takes only the key the run gave the engine, which is how a run knows
// the engine sent its owner's key and not an agent's.
//
//   tsx scripts/stub-model.ts <port> <the key it takes>
//
// The count it reports is worked out from the request, so a run can say beforehand what a call must cost:
// one token of input for every four bytes of the body, and 120 tokens of output (or max_tokens, when that is less).

import { createServer } from "node:http";

const port = Number(process.argv[2]);
const takes = process.argv[3] ?? "";
if (!port || !takes) throw new Error("usage: stub-model.ts <port> <key>");

const said = "Summary: the agreement runs for two years and renews by itself.";

createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on("data", (c: Buffer) => parts.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(parts);
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "request-id": `req_stub_${status}` }); res.end(JSON.stringify(body)); };
    if (req.method !== "POST" || req.url !== "/v1/messages") return json(404, { type: "error", error: { type: "not_found_error", message: "not found" } });
    if (req.headers["x-api-key"] !== takes) return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const body = JSON.parse(raw.toString("utf8")) as { model: string; max_tokens: number; stream?: boolean };
    const usage = { input_tokens: Math.ceil(raw.length / 4), output_tokens: Math.min(120, body.max_tokens) };
    if (!body.stream) return json(200, { id: "msg_stub", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: said }], stop_reason: "end_turn", usage });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": "req_stub_stream" });
    const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    event("message_start", { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model: body.model, content: [], usage: { ...usage, output_tokens: 1 } } });
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    for (const word of said.split(" ")) {
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${word} ` } });
      await new Promise((r) => setTimeout(r, 15));
    }
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens } });
    event("message_stop", { type: "message_stop" });
    res.end();
  });
}).listen(port, "127.0.0.1");
