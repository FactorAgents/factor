// How the engine reaches Robinhood Chain: one small interface, so that everything above it (the watchers, the
// actions) can be run against a chain made up in a test, and the one real implementation of it, on viem.
//
// What the public node allows, measured in earlier projects and kept to here:
// - eth_getLogs refuses (it never truncates) a query that matches over 10,000 logs or runs past about two
//   seconds: 100,000 blocks a query is what answers reliably, and a refused stretch is halved and read again;
// - it answers 403 or 429 when asked too fast, and mishandles eth_getLogs inside a JSON-RPC batch: log queries
//   are spaced out and never batched;
// - state older than a few thousand blocks is gone: every read is at the head, never at a past block.
// Several nodes can be given; one that errors is passed over for the next until it answers again.

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  decodeErrorResult,
  defineChain,
  encodeFunctionData,
  fallback,
  http,
  keccak256,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface ChainLog {
  address: string; // lowercase
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  timestamp?: number; // the block's, when the node sends it with the log
}

export interface Head {
  number: bigint;
  timestamp: number; // unix seconds
  hash: string;
}

export interface CallSpec {
  to: string;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export interface Receipt {
  ok: boolean;
  blockNumber: bigint;
  gasUsed: bigint;
  gasPrice?: bigint; // what a unit of gas really cost in it, when the node says
  logs: ChainLog[];
}

// A call by its raw data, as some address would make it.
export interface RawCall {
  from: string;
  to: string;
  data: Hex;
  value?: bigint;
}

export interface LogFilter {
  address: string | string[];
  topics?: (Hex | Hex[] | null)[];
}

export interface RpcHealth {
  nodes: { host: string; ok: number; failed: number; lastOkAt: number | null; lastErrorAt: number | null; lastError: string | null }[];
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  failuresInARow: number;
}

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface Chain {
  chainId(): Promise<number>;
  head(): Promise<Head>;
  block(number: bigint): Promise<{ hash: string; timestamp: number } | null>;
  code(address: string): Promise<string>;
  balance(address: string): Promise<bigint>;
  // Every log in the stretch that matches, oldest first. A stretch the node finds too big is the caller's to halve
  // (readLogs below does).
  logs(from: bigint, to: bigint, filter: LogFilter): Promise<ChainLog[]>;
  read<T = unknown>(call: CallSpec): Promise<T>;
  // Run a call as `from` without sending it. Throws when it would revert (see revertOf).
  simulate<T = unknown>(call: CallSpec, from: string): Promise<T>;
  // The same for a call that is only known as data (an order an account's owner signed): what it would return.
  // `errors` names the reverts worth knowing by name. Throws Reverted when it would revert.
  call(raw: RawCall, errors?: Abi): Promise<Hex>;
  // The gas a call would use; with no call, the gas of an empty transfer from the wallet to itself, or of `pay`.
  estimateGas(call: CallSpec | null, from: string, pay?: Pay): Promise<bigint>;
  fees(): Promise<Fees>;
  nonces(address: string): Promise<{ latest: number; pending: number }>;
  receipt(hash: string): Promise<Receipt | null>;
  // A mined transaction as it was sent: who sent it, to where, with how much ETH and what data. null: not found.
  transaction(hash: string): Promise<SentTx | null>;
  health(): RpcHealth;
}

export interface SentTx {
  from: string; // lowercase
  to: string | null; // lowercase; null for a contract's creation
  value: bigint;
  input: Hex;
}

// ETH sent to an address with no call: how the gateway gives unspent compute credit back to the pool.
export interface Pay {
  to: string;
  value: bigint;
}

export interface TxRequest {
  call: CallSpec | null; // null: an empty transfer to the signer itself (the replacement for a stuck transaction), or `pay`
  pay?: Pay;
  gas: bigint;
  nonce: number;
  fees: Fees;
}

// The bot's wallet. `onSigned` is called with the transaction's hash after it is signed and BEFORE it is
// broadcast, so the hash is written down first: whatever happens to the process after that, what was sent can be
// looked up.
export interface Signer {
  readonly address: string; // lowercase
  send(tx: TxRequest, onSigned: (hash: string) => void): Promise<string>;
}

// A call the chain would refuse, with the contract's own name for why (TooSoon, OverBudget, ...).
export class Reverted extends Error {
  constructor(
    readonly errorName: string,
    readonly errorArgs: readonly unknown[] = [],
  ) {
    super(`reverted: ${errorName}`);
    this.name = "Reverted";
  }
}

// Node addresses with their paths and keys cut off, so a provider's key never reaches a log or an API answer.
export const hostsOnly = (m: string): string => m.replace(/\b(https?|wss?):\/\/([^/\s"'?#]+)[^\s"']*/g, "$1://$2");

// One line that says what went wrong, safe to log and to store.
export function reason(err: unknown): string {
  const r = revertOf(err);
  if (r) return `the contract refuses it: ${r.name}${r.args.length ? `(${r.args.map(String).join(", ")})` : ""}`;
  const e = err as { shortMessage?: string; details?: string; message?: string };
  let text = err instanceof Error ? (e.shortMessage ?? e.message ?? "") : String(err);
  text = text.split("\n")[0];
  // the node's own words, when it gave any (and they are words, not a page)
  const said = typeof e.details === "string" ? e.details.split("\n")[0].trim() : "";
  if (said && said.length < 200 && !/[<>]/.test(said) && !text.includes(said)) text = `${text.replace(/[.:]$/, "")}: ${said}`;
  return hostsOnly(text).slice(0, 300);
}

// The contract's own error, when the failure is the chain answering "no" and not the node failing to answer.
export function revertOf(err: unknown): { name: string; args: readonly unknown[] } | null {
  if (err instanceof Reverted) return { name: err.errorName, args: err.errorArgs };
  if (err instanceof BaseError) {
    const hit = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (hit instanceof ContractFunctionRevertedError) {
      return { name: hit.data?.errorName ?? hit.reason ?? "reverted", args: (hit.data?.args as readonly unknown[] | undefined) ?? [] };
    }
    if (/execution reverted/i.test(`${err.shortMessage} ${err.message}`)) return { name: "reverted", args: [] };
  }
  return null;
}

// The node turning requests away: HTTP 403 or 429, a rate limit, a Cloudflare page. An answer, not a fault: the
// job that got it waits longer and comes back. Looks down the chain of causes.
export function nodeBusy(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth++) {
    const o = e as { status?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
    if (o.status === 403 || o.status === 429) return true;
    const text = [o.message, o.shortMessage, o.details].filter((v) => typeof v === "string").join(" ") || (typeof e === "string" ? e : "");
    if (/\bStatus: (403|429)\b|\bHTTP (403|429)\b|\b(403|429) (Forbidden|Too Many Requests)\b|rate.?limit|too many requests|cloudflare|just a moment/i.test(text)) return true;
    e = o.cause;
  }
  return false;
}

// The node answered a request, and the answer was no (a JSON-RPC error: insufficient funds, nonce too low, ...).
// Anything else that goes wrong with a request (no connection, a timeout, an HTTP error) leaves it unknown whether
// the node took it.
export function nodeRejected(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth++) {
    const o = e as { code?: unknown; status?: unknown; cause?: unknown };
    if (typeof o.code === "number" && o.status === undefined) return true;
    e = o.cause;
  }
  return false;
}

// The node saying "ask for less": over 10,000 logs matched, or the query ran too long.
export const tooMany = (msg: string): boolean => /exceeds limit|response size|timed out|query timeout|block range|too many results|more than \d+ results/i.test(msg);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Every log in a range, read `span` blocks at a time, a refused stretch halved and read again until it fits.
// `onSpan` is called after each stretch with what it held, so the caller can write it down and move its cursor
// before the next one is asked for (a long catch-up is then resumable from wherever it stopped).
export async function readLogs(
  chain: Pick<Chain, "logs">,
  from: bigint,
  to: bigint,
  filter: LogFilter,
  span: bigint,
  onSpan: (logs: ChainLog[], upTo: bigint) => void | Promise<void>,
  maxSpans = Infinity,
): Promise<bigint | null> {
  let done: bigint | null = null;
  let spans = 0;
  const read = async (a: bigint, b: bigint): Promise<ChainLog[]> => {
    try {
      return await chain.logs(a, b, filter);
    } catch (e) {
      // one block that alone is over the cap cannot be narrowed further: say so instead of returning a slice
      if (!tooMany((e as Error).message ?? "") || a >= b) throw e;
      const mid = a + (b - a) / 2n;
      return [...(await read(a, mid)), ...(await read(mid + 1n, b))];
    }
  };
  for (let a = from; a <= to && spans < maxSpans; a += span, spans++) {
    const b = a + span - 1n > to ? to : a + span - 1n;
    const logs = await read(a, b);
    logs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
    await onSpan(logs, b);
    done = b;
  }
  return done;
}

// ---------- the real chain ----------

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const LOG_GAP_MS = 120;

interface RawLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  blockTimestamp?: Hex;
  removed?: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "node";
  }
}

// The chain over one node or several. `now` is only for the health record's times.
export function viemChain(urls: string[], chainId: number, now: () => number = Date.now, retryDelayMs = 1200): Chain & { stop(): void } {
  const chain = defineChain({
    id: chainId,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [urls[0]] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  const nodes = urls.map((u) => ({ host: hostOf(u), ok: 0, failed: 0, lastOkAt: null as number | null, lastErrorAt: null as number | null, lastError: null as string | null }));
  let failuresInARow = 0;
  // One retry and no more: a node that is turning requests away is asked less, not four times as much.
  const transport = (batch: boolean) =>
    fallback(
      urls.map((u) => http(u, { batch: batch ? { batchSize: 25, wait: 10 } : false, retryCount: 1, retryDelay: retryDelayMs, timeout: 30_000 })),
      { retryCount: 1, rank: false },
    );
  const track = (client: { transport: unknown }) => {
    const t = client.transport as { onResponse?: (fn: (r: { status: "success" | "error"; error?: Error; transport: { value?: { url?: string } } }) => void) => void };
    t.onResponse?.((r) => {
      const node = nodes[Math.max(0, urls.indexOf(r.transport.value?.url ?? ""))];
      // a call the chain refuses, or a log query it finds too big, is the node answering
      const answered = r.status === "success" || revertOf(r.error) !== null || tooMany(r.error?.message ?? "") || /revert/i.test(r.error?.message ?? "");
      if (answered) {
        node.ok++;
        node.lastOkAt = now();
        failuresInARow = 0;
      } else {
        node.failed++;
        node.lastErrorAt = now();
        node.lastError = reason(r.error);
        failuresInARow++;
      }
    });
  };
  // Contract reads made in the same moment fold into one Multicall3 call.
  const reads = createPublicClient({ chain, transport: transport(true), batch: { multicall: { wait: 10, batchSize: 16_384 } } });
  // Sends, simulations and log scans go one request at a time.
  const plain = createPublicClient({ chain, transport: transport(false) });
  track(reads);
  track(plain);

  let lastScan = 0;
  async function paced<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = LOG_GAP_MS - (Date.now() - lastScan);
      if (wait > 0) await sleep(wait);
      lastScan = Date.now();
      try {
        return await fn();
      } catch (e) {
        const msg = (e as Error).message ?? "";
        // "too big" goes straight back to be halved; "too fast" goes back to the job, which waits longer
        if (tooMany(msg) || nodeBusy(e) || attempt >= 2) throw e;
        await sleep(retryDelayMs * (attempt + 1));
      }
    }
  }

  const contract = (c: CallSpec) => ({ address: c.to as Hex, abi: c.abi, functionName: c.functionName, args: c.args ?? [] }) as never;
  const toLog = (l: RawLog): ChainLog => ({
    address: l.address.toLowerCase(),
    topics: l.topics,
    data: l.data,
    blockNumber: BigInt(l.blockNumber),
    transactionHash: l.transactionHash.toLowerCase(),
    logIndex: Number(BigInt(l.logIndex)),
    // The live node sends blockTimestamp with every log and fills it with zero (read on 2026-10-09); a local
    // fork fills it in. Zero is "not told": the block is asked for its time instead.
    timestamp: l.blockTimestamp && BigInt(l.blockTimestamp) > 0n ? Number(BigInt(l.blockTimestamp)) : undefined,
  });

  return {
    stop() {
      // nothing is polling: the clients hold no timers of their own
    },
    chainId: () => plain.getChainId(),
    async head() {
      const b = await reads.getBlock({ blockTag: "latest" });
      return { number: b.number, timestamp: Number(b.timestamp), hash: b.hash.toLowerCase() };
    },
    async block(number) {
      try {
        const b = await reads.getBlock({ blockNumber: number });
        return { hash: b.hash.toLowerCase(), timestamp: Number(b.timestamp) };
      } catch (e) {
        if (/could not be found|not found/i.test((e as Error).message ?? "")) return null;
        throw e;
      }
    },
    async code(address) {
      return (await reads.getCode({ address: address as Hex })) ?? "0x";
    },
    balance: (address) => reads.getBalance({ address: address as Hex }),
    async logs(from, to, filter) {
      const params = [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address: filter.address, ...(filter.topics ? { topics: filter.topics } : {}) }];
      const raw = await paced(() => (plain.request as unknown as (a: unknown) => Promise<RawLog[]>)({ method: "eth_getLogs", params }));
      return raw.filter((l) => !l.removed).map(toLog);
    },
    read: <T>(c: CallSpec) => reads.readContract(contract(c)) as Promise<T>,
    async simulate<T>(c: CallSpec, from: string) {
      const r = await plain.simulateContract({ ...(contract(c) as object), account: from as Hex } as never);
      return (r as { result: T }).result;
    },
    async call(raw, errors) {
      try {
        const r = await plain.call({ account: raw.from as Hex, to: raw.to as Hex, data: raw.data, value: raw.value ?? 0n });
        return r.data ?? "0x";
      } catch (e) {
        // the revert's own data, wherever in the chain of causes the node's answer put it
        let data: unknown;
        if (e instanceof BaseError) {
          const deepest = e.walk() as { data?: unknown };
          data = typeof deepest?.data === "object" && deepest.data !== null ? (deepest.data as { data?: unknown }).data : deepest?.data;
        }
        if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)) {
          try {
            const d = decodeErrorResult({ abi: errors ?? [], data: data as Hex });
            throw new Reverted(d.errorName, (d.args as readonly unknown[] | undefined) ?? []);
          } catch (x) {
            if (x instanceof Reverted) throw x;
            throw new Reverted("reverted");
          }
        }
        if (e instanceof BaseError && /execution reverted/i.test(`${e.shortMessage} ${e.message}`)) throw new Reverted("reverted");
        throw e;
      }
    },
    estimateGas: (c, from, pay) =>
      c ? plain.estimateContractGas({ ...(contract(c) as object), account: from as Hex } as never) : plain.estimateGas({ account: from as Hex, to: (pay?.to ?? from) as Hex, value: pay?.value ?? 0n }),
    async fees() {
      const f = await plain.estimateFeesPerGas();
      return { maxFeePerGas: f.maxFeePerGas ?? 0n, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 0n };
    },
    async nonces(address) {
      const [latest, pending] = await Promise.all([
        plain.getTransactionCount({ address: address as Hex, blockTag: "latest" }),
        plain.getTransactionCount({ address: address as Hex, blockTag: "pending" }),
      ]);
      return { latest, pending };
    },
    async transaction(hash) {
      try {
        const t = await plain.getTransaction({ hash: hash as Hex });
        return { from: t.from.toLowerCase(), to: t.to ? t.to.toLowerCase() : null, value: t.value, input: t.input };
      } catch (e) {
        if (/could not be found|not found/i.test((e as Error).message ?? "")) return null;
        throw e;
      }
    },
    async receipt(hash) {
      try {
        const r = await plain.getTransactionReceipt({ hash: hash as Hex });
        return {
          ok: r.status === "success",
          blockNumber: r.blockNumber,
          gasUsed: r.gasUsed,
          gasPrice: r.effectiveGasPrice,
          logs: r.logs.map((l) => ({
            address: l.address.toLowerCase(),
            topics: l.topics as Hex[],
            data: l.data,
            blockNumber: l.blockNumber,
            transactionHash: l.transactionHash.toLowerCase(),
            logIndex: l.logIndex,
          })),
        };
      } catch (e) {
        if (/could not be found|not found/i.test((e as Error).message ?? "")) return null;
        throw e;
      }
    },
    health() {
      const lastOkAt = nodes.reduce<number | null>((m, n) => (n.lastOkAt !== null && (m === null || n.lastOkAt > m) ? n.lastOkAt : m), null);
      const last = nodes.filter((n) => n.lastErrorAt !== null).sort((a, b) => b.lastErrorAt! - a.lastErrorAt!)[0];
      return { nodes: nodes.map((n) => ({ ...n })), lastOkAt, lastErrorAt: last?.lastErrorAt ?? null, lastError: last?.lastError ?? null, failuresInARow };
    },
  };
}

// The bot's wallet over the same nodes. The key is held inside this closure and nowhere else; nothing here
// prints it, and no error it can raise carries it.
export function viemSigner(key: `0x${string}`, urls: string[], chainId: number, retryDelayMs = 1200): Signer {
  const account = privateKeyToAccount(key);
  const chain = defineChain({ id: chainId, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [urls[0]] } } });
  const client = createPublicClient({
    chain,
    transport: fallback(urls.map((u) => http(u, { batch: false, retryCount: 1, retryDelay: retryDelayMs, timeout: 30_000 })), { retryCount: 1, rank: false }),
  });
  const address = account.address.toLowerCase();
  return {
    address,
    async send(tx, onSigned) {
      const serialized = await account.signTransaction({
        chainId,
        type: "eip1559",
        to: (tx.call ? tx.call.to : (tx.pay?.to ?? address)) as Hex,
        data: tx.call ? encodeFunctionData({ abi: tx.call.abi, functionName: tx.call.functionName, args: tx.call.args ?? [] } as never) : undefined,
        value: tx.call ? 0n : (tx.pay?.value ?? 0n),
        gas: tx.gas,
        nonce: tx.nonce,
        maxFeePerGas: tx.fees.maxFeePerGas,
        maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas,
      });
      const hash = keccak256(serialized).toLowerCase();
      onSigned(hash);
      await client.sendRawTransaction({ serializedTransaction: serialized });
      return hash;
    },
  };
}

// The address a key signs as, without making a signer.
export function addressOfKey(key: `0x${string}`): string {
  return privateKeyToAccount(key).address.toLowerCase();
}
