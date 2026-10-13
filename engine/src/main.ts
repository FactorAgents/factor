// The process: one SQLite file, the engine, and a small HTTP server.
//
//   FACTOR_DATA_DIR   where factor.db lives (a volume on the host); ./data when not set
//   PORT              the port to listen on; 8787 when not set
//
// Everything else is read by chain/config.ts. Started with nothing set, it reads no chain and answers /v1/state
// with the before-launch state.

import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { open } from "./chain/db.js";
import { Engine } from "./engine.js";

const dir = process.env.FACTOR_DATA_DIR?.trim() || "data";
mkdirSync(dir, { recursive: true });
const db = open(join(dir, "factor.db"));
const engine = new Engine(db);
engine.start();

// the most a signed write may carry: a name and a line, or a title
const BODY_MOST = 4096;

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_MOST) {
        reject(new Error("too large"));
        req.destroy();
      } else parts.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch {
        reject(new Error("not JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Who is asking, for the limit on signed writes: the address the host's proxy passes on, or the socket's.
function caller(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

const server = createServer((req, res) => {
  const [path, search = ""] = (req.url ?? "/").split("?");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  const failed = () => send(500, { error: "the engine could not answer" });
  // compute credit: the gateway answers these itself, because a model's answer may be a stream
  if (path.startsWith("/v1/compute/")) {
    if (!engine.compute(req, res, path)) send(503, { type: "error", error: { type: "api_error", message: "The engine is not reading the chain yet." } });
    return;
  }
  if (req.method === "POST") {
    const key = req.headers["x-admin-key"];
    readJson(req)
      .then((body) => engine.post(path, body, caller(req), typeof key === "string" ? key : undefined))
      .then((a) => (a ? send(a.status, a.body) : send(404, { error: "not found" })))
      .catch((e: Error) => (e.message === "too large" ? send(413, { error: "the body is too large" }) : e.message === "not JSON" ? send(400, { error: "the body is not JSON" }) : failed()));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: "GET or POST" });
  if (path === "/" || path === "/healthz") return send(200, { ok: true });
  engine.handle(path, new URLSearchParams(search)).then((a) => (a ? send(a.status, a.body) : send(404, { error: "not found" }))).catch(failed);
});
const port = Number(process.env.PORT) || 8787;
server.listen(port, () => console.log(`${new Date().toISOString().slice(11, 19)} [engine] listening on ${port}`));

// Stopping: the loops finish what they are in the middle of (a sent transaction is followed to its receipt).
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    engine.stop().finally(() => { db.close(); process.exit(0); });
  });
}
