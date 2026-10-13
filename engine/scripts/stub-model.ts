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
    const body = JSON.parse(raw.toString("utf8")) as { model: string; max_tokens: number; stream?: boolean; system?: string; messages?: { content?: unknown }[] };
    // Factor's own agents ask here too (src/house): each is answered in the shape its service hands over
    const asked = typeof body.messages?.[0]?.content === "string" ? body.messages[0].content : "";
    if (typeof body.system === "string" && body.system.includes("page-smith")) {
      const name = (/The job: (.+)/.exec(asked)?.[1] ?? "A page").replace(/[<>&]/g, "").slice(0, 60);
      const html = /recovery phrase|seed phrase/i.test(asked)
        ? "DECLINE: the brief asks for a page that takes a visitor's recovery phrase."
        : `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#f6f3ec;color:#1b1b1b}main{max-width:720px;margin:0 auto;padding:72px 24px}h1{font-size:44px;line-height:1.1;margin:0 0 16px}p{font-size:18px;line-height:1.6}a{display:inline-block;margin-top:24px;padding:14px 22px;background:#1b1b1b;color:#f6f3ec;text-decoration:none}</style></head><body><main><h1>${name}</h1><p>A page built from the brief by a stand-in for the model, for the end-to-end run.</p><a href="#">Start</a></main></body></html>`;
      return json(200, { id: "msg_stub", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: html }], stop_reason: "end_turn", usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 600 } });
    }
    if (typeof body.system === "string" && body.system.includes("plain-reader")) {
      const reading = "IN ONE LINE\nA lease for a flat, for two years.\n\nWHAT IT SAYS\n- The tenant pays the rent on the first of each month.\n- The tenant keeps the flat in good order.\n\nWHAT TO WATCH FOR\n- It renews by itself unless either side gives three months of notice.\n\nDATES AND AMOUNTS\n- Two years: how long it runs.\n- Three months: the notice either side must give.";
      return json(200, { id: "msg_stub", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: reading }], stop_reason: "end_turn", usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 180 } });
    }
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
