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
import { backups } from "./backup.js";
import { open } from "./chain/db.js";
import { Engine } from "./engine.js";

const dir = process.env.FACTOR_DATA_DIR?.trim() || "data";
mkdirSync(dir, { recursive: true });
const db = open(join(dir, "factor.db"));
const engine = new Engine(db);
engine.start();
// a copy of the database a day, beside it (./backup.ts). ENGINE_BACKUPS=off for a run that should leave nothing behind
const stopBackups = (process.env.ENGINE_BACKUPS ?? "").trim().toLowerCase() === "off" ? () => undefined : backups(db, dir, (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`));

// the most a signed write may carry: a name and a line, or a title
const BODY_MOST = 4096;
// an order of an account carries its calls and a passkey's answer: more than a signed name, and still small
const ORDER_MOST = 32_768;
// a brief is up to 12,000 characters and the work up to 200,000: as bytes, with room for what carries them
const BRIEF_BYTES = 64_000;
const WORK_BYTES = 900_000;

function readJson(req: IncomingMessage, most = BODY_MOST): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > most) {
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
  // Pay with Factor over x402 (./pay.ts): a 402 with what to pay, or the job a payment locked. GET and POST alike:
  // the payment travels in the X-PAYMENT header, and nothing in a body is read
  if (path.startsWith("/v1/x402/")) {
    if (req.method !== "GET" && req.method !== "POST" && req.method !== "HEAD") return send(405, { error: "GET or POST" });
    const payment = req.headers["x-payment"];
    // the address the caller asked for, as the site passes it on: what the 402 names as the resource
    const resource = typeof req.headers["x-factor-resource"] === "string" && /^https:\/\/[^\s]{1,9500}$/.test(req.headers["x-factor-resource"]) ? req.headers["x-factor-resource"] : `${process.env.FACTOR_SITE_URL?.trim() || "https://factoragents.fun"}/api${path}`;
    engine.x402(path, typeof payment === "string" && payment.length <= 8192 ? payment : undefined, resource)
      .then((a) => {
        res.writeHead(a.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...a.headers });
        res.end(JSON.stringify(a.body));
      })
      .catch(failed);
    req.resume();
    return;
  }
  if (req.method === "POST") {
    const key = req.headers["x-admin-key"];
    readJson(req, path.startsWith("/v1/accounts") || path.startsWith("/v1/pay/") ? ORDER_MOST : path === "/v1/jobs/brief" || path === "/v1/agents/make" ? BRIEF_BYTES : path === "/v1/jobs/delivery" ? WORK_BYTES : BODY_MOST)
      .then((body) => engine.post(path, body, caller(req), typeof key === "string" ? key : undefined))
      .then((a) => (a ? send(a.status, a.body) : send(404, { error: "not found" })))
      .catch((e: Error) => (e.message === "too large" ? send(413, { error: "the body is too large" }) : e.message === "not JSON" ? send(400, { error: "the body is not JSON" }) : failed()));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: "GET or POST" });
  if (path === "/" || path === "/healthz") return send(200, { ok: true });
  engine.handle(path, new URLSearchParams(search), caller(req)).then((a) => (a ? send(a.status, a.body) : send(404, { error: "not found" }))).catch(failed);
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
    stopBackups();
    engine.stop().finally(() => { db.close(); process.exit(0); });
  });
}
