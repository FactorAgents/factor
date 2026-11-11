// The few things every script here needs from NEAR: public RPC reads, a signing account from the local key file,
// calls that return their transaction hash and the desk's events, and the units.
//
// Keys are never in this repository. A script signs as an account with the key near-cli saved in
// ~/.near-credentials/<network>/<account>.json, or with NEAR_KEY_<ACCOUNT> (dots and dashes as underscores).

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider } from "near-api-js";

export const NETWORK = (process.env.NEAR_NETWORK || "testnet") as "testnet" | "mainnet";

const RPCS: Record<string, string[]> = {
  testnet: ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"],
  mainnet: ["https://rpc.mainnet.near.org", "https://free.rpc.fastnear.com"],
};
export const RPC_URLS = process.env.NEAR_RPC ? [process.env.NEAR_RPC] : RPCS[NETWORK];
// NEAR Rocks (by FastNear) opens for people and for scripts alike; NearBlocks shows the same transactions.
export const EXPLORER = NETWORK === "testnet" ? "https://testnet.near.rocks" : "https://near.rocks";
export const txLink = (hash: string): string => `${EXPLORER}/tx/${hash}`;
export const accountLink = (id: string): string => `${EXPLORER}/account/${id}`;

/** The deployed desk on this network; DESK overrides it. */
export const DESK = process.env.DESK || (NETWORK === "testnet" ? "factor-desk.testnet" : "");
export const TEST_DOLLAR = process.env.TEST_DOLLAR || "tusd.factor-desk.testnet";

export const YOCTO = 10n ** 24n;
export const TGAS = 10n ** 12n;

/** "1.25" NEAR to yoctoNEAR, exactly (no floating point). */
export function near(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > 24) throw new Error(`too many decimals: ${amount}`);
  return BigInt(whole || "0") * YOCTO + BigInt((frac + "0".repeat(24)).slice(0, 24));
}

/** yoctoNEAR to a short decimal string: 1260000000000000000000000 -> "1.26". */
export function fmtNear(yocto: bigint | string, digits = 4): string {
  return fmtUnits(BigInt(yocto), 24, digits);
}

export function fmtUnits(v: bigint, decimals: number, digits = 4): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  let frac = (a % base).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

// ── reading ─────────────────────────────────────────────────────────────────────────────────────────────

export async function rpc<T = any>(method: string, params: unknown): Promise<T> {
  let last: unknown;
  for (const url of RPC_URLS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "factor", method, params }),
          signal: AbortSignal.timeout(20_000),
        });
        if (r.status === 429 || r.status >= 500) throw new Error(`${url} answered ${r.status}`);
        const j: any = await r.json();
        if (j.error) {
          const cause = j.error?.cause?.name || j.error?.name;
          const e = new Error(`${method}: ${cause || "error"}: ${JSON.stringify(j.error.data ?? j.error.cause?.info ?? "")}`);
          (e as any).cause = cause;
          if (cause === "UNKNOWN_ACCOUNT" || cause === "UNKNOWN_ACCESS_KEY" || cause === "CONTRACT_EXECUTION_ERROR") throw Object.assign(e, { final: true });
          throw e;
        }
        return j.result as T;
      } catch (e: any) {
        if (e?.final) throw e;
        last = e;
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      }
    }
  }
  throw last;
}

/** Call a view method and parse its JSON result. */
export async function view<T = any>(contract: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result?: number[]; error?: string }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (!r.result) throw new Error(`${contract}.${method}: ${r.error ?? "no result"}`);
  return JSON.parse(Buffer.from(r.result).toString());
}

export async function accessKeys(account: string): Promise<string[]> {
  try {
    const r = await rpc<{ keys: { public_key: string }[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: account });
    return r.keys.map((k) => k.public_key);
  } catch (e: any) {
    if (e?.cause === "UNKNOWN_ACCOUNT") return [];
    throw e;
  }
}

export async function balance(account: string): Promise<bigint> {
  const r = await rpc<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: account });
  return BigInt(r.amount);
}

// ── signing ─────────────────────────────────────────────────────────────────────────────────────────────

export function loadKey(account: string): string {
  const env = process.env[`NEAR_KEY_${account.replace(/[.-]/g, "_").toUpperCase()}`];
  if (env) return env;
  const file = join(homedir(), ".near-credentials", NETWORK, `${account}.json`);
  if (!existsSync(file)) throw new Error(`no key for ${account}: create it with near-cli (see near/README.md) or set NEAR_KEY_…`);
  return JSON.parse(readFileSync(file, "utf8")).private_key;
}

const provider = new JsonRpcProvider({ url: RPC_URLS[0] });

export function signer(account: string): Account {
  return new Account(account, provider, loadKey(account) as any);
}

export interface DeskEvent {
  event: string;
  data: any;
}

export interface Sent {
  hash: string;
  link: string;
  value: any;
  events: DeskEvent[];
  logs: string[];
}

/** Sign and send one function call; wait until every receipt ran. Returns the hash, the value and the events. */
export async function call(
  from: Account,
  contract: string,
  method: string,
  args: object,
  opts: { deposit?: bigint; tgas?: number } = {},
): Promise<Sent> {
  const res: any = await from.callFunctionRaw({
    contractId: contract,
    methodName: method,
    args,
    deposit: opts.deposit ?? 0n,
    gas: BigInt(opts.tgas ?? 100) * TGAS,
    waitUntil: "EXECUTED_OPTIMISTIC",
  });
  return readOutcome(res);
}

export async function transfer(from: Account, to: string, amount: bigint): Promise<Sent> {
  const res: any = await from.transfer({ receiverId: to, amount });
  return readOutcome(res);
}

function readOutcome(res: any): Sent {
  const hash: string = res.transaction?.hash ?? res.transaction_outcome?.id;
  const logs: string[] = [...(res.transaction_outcome?.outcome?.logs ?? []), ...(res.receipts_outcome ?? []).flatMap((r: any) => r.outcome.logs)];
  const events = logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)))
    .map((e) => ({ event: e.event, data: e.data?.[0] }));
  const failed = (res.receipts_outcome ?? []).find((r: any) => r.outcome.status?.Failure);
  let value: any = undefined;
  const ok = res.status?.SuccessValue;
  if (typeof ok === "string" && ok.length) {
    try {
      value = JSON.parse(Buffer.from(ok, "base64").toString());
    } catch {
      value = Buffer.from(ok, "base64").toString();
    }
  }
  return { hash, link: txLink(hash), value, events, logs: failed ? [...logs, `a receipt failed: ${JSON.stringify(failed.outcome.status.Failure)}`] : logs };
}
