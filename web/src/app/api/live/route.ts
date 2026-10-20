// A page's stream of changes (lib/live.ts): held open, a few bytes at a time, from the one stream this server keeps to
// the engine. Not there with LIVE_PUSH=off, or with no engine to listen to: the page then reads itself on its timers.
import { connection } from "next/server";
import { livePushOn, subscribe } from "@/lib/live";

const HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  // no-transform: nothing on the way packs or holds back the stream
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
};

export async function GET(req: Request) {
  await connection();
  if (!livePushOn()) return Response.json({ error: "not found" }, { status: 404, headers: { "cache-control": "no-store" } });
  const enc = new TextEncoder();
  let close = () => undefined as void;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const leave = subscribe((chunk) => c.enqueue(enc.encode(chunk)));
      if (!leave) {
        c.close();
        return;
      }
      let closed = false;
      close = () => {
        if (closed) return;
        closed = true;
        leave();
        try { c.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", close);
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, { headers: HEADERS });
}
