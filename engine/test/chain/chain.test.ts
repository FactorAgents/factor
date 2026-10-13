// The real chain client (viem), against JSON-RPC servers started by the test on 127.0.0.1: several nodes with one
// passed over when it fails, a log query the node refuses as too big halved until it fits, a contract's own
// "no" read by name, the node turning requests away told apart from a fault, and the bot's wallet: the hash
// written down before the transaction is broadcast, and the key in nothing it says.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { encodeErrorResult, encodeFunctionResult, keccak256, parseTransaction, recoverTransactionAddress, type Abi, type Hex } from "viem";
import { factorBurnPotAbi } from "../../src/abi/index.js";
import { addressOfKey, hostsOnly, nodeBusy, readLogs, reason, revertOf, tooMany, viemChain, viemSigner, type ChainLog } from "../../src/chain/chain.js";
import { A } from "./fake.js";
import { TEST_KEY } from "./harness.js";

type Handler = (method: string, params: unknown[]) => unknown;
class RpcError {
  constructor(
    readonly code: number,
    readonly message: string,
    readonly data?: string,
  ) {}
}
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

// A node: answers each JSON-RPC request (single or batched) with what the handler gives, or the HTTP status given.
async function node(handler: Handler, status = 200): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (status !== 200) {
        res.writeHead(status, { "content-type": "text/html" }).end(status === 403 ? "<!DOCTYPE html><title>Just a moment...</title>" : "<html>it did not work</html>");
        return;
      }
      const parsed = JSON.parse(body);
      const one = (r: { id: number; method: string; params: unknown[] }) => {
        seen.push(r.method);
        try {
          return { jsonrpc: "2.0", id: r.id, result: handler(r.method, r.params) };
        } catch (e) {
          if (e instanceof RpcError) return { jsonrpc: "2.0", id: r.id, error: { code: e.code, message: e.message, data: e.data } };
          throw e;
        }
      };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/a-secret-provider-key`, seen };
}

const block = (n: number) => ({ number: `0x${n.toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, timestamp: `0x${(1791540000 + n).toString(16)}`, transactions: [], baseFeePerGas: "0x1312d00" });
const basics: Handler = (method, params) => {
  if (method === "eth_chainId") return "0x1237";
  if (method === "eth_getBlockByNumber") return block(params[0] === "latest" ? 500 : Number(BigInt(params[0] as string)));
  if (method === "eth_getTransactionCount") return params[1] === "pending" ? "0x8" : "0x7";
  if (method === "eth_maxPriorityFeePerGas") return "0x0";
  if (method === "eth_getBalance") return "0xde0b6b3a7640000";
  if (method === "eth_getCode") return "0x";
  throw new RpcError(-32601, `no ${method} here`);
};

describe("several nodes", () => {
  it("passes over a node that fails for the next one, and keeps count of each", async () => {
    const dead = await node(basics, 503);
    const good = await node(basics);
    const chain = viemChain([dead.url, good.url], 4663, () => 1000, 5);
    expect(await chain.chainId()).toBe(4663);
    expect(await chain.head()).toEqual({ number: 500n, timestamp: 1791540500, hash: `0x${(500).toString(16).padStart(64, "0")}` });
    expect(await chain.nonces(A.bot)).toEqual({ latest: 7, pending: 8 });
    expect(await chain.code(A.bot)).toBe("0x");
    const h = chain.health();
    expect(h.nodes.map((n) => n.host)).toEqual([new URL(dead.url).host, new URL(good.url).host]);
    expect(h.nodes[0].failed).toBeGreaterThan(0);
    expect(h.nodes[0].ok).toBe(0);
    expect(h.nodes[1].ok).toBeGreaterThan(0);
    expect(h.lastOkAt).toBe(1000);
    // a node's address in the health record is its host: never the path a provider's key sits in
    expect(JSON.stringify(h)).not.toContain("a-secret-provider-key");
  });

  it("says so when every node fails, without the key in what it says", async () => {
    const a = await node(basics, 500);
    const b = await node(basics, 502);
    const chain = viemChain([a.url, b.url], 4663, Date.now, 5);
    const err = await chain.head().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(reason(err)).not.toContain("a-secret-provider-key");
    expect(chain.health().failuresInARow).toBeGreaterThan(0);
    expect(chain.health().lastError).not.toContain("a-secret-provider-key");
  });

  it("knows the node turning requests away (403, 429) from a node that is down", async () => {
    const chain = viemChain([(await node(basics, 403)).url], 4663, Date.now, 5);
    const turnedAway = await chain.head().catch((e) => e);
    expect(nodeBusy(turnedAway)).toBe(true);
    const limited = await viemChain([(await node(basics, 429)).url], 4663, Date.now, 5).head().catch((e) => e);
    expect(nodeBusy(limited)).toBe(true);
    const down = await viemChain([(await node(basics, 500)).url], 4663, Date.now, 5).head().catch((e) => e);
    expect(nodeBusy(down)).toBe(false);
    expect(nodeBusy(new Error("socket hang up"))).toBe(false);
  });
});

describe("log queries", () => {
  // `time`: the block's time sent with the log, zero sent in its place (what the live node does), or nothing
  const log = (n: number, time: boolean | "zero") => ({
    address: A.splitter.toUpperCase().replace("0X", "0x"),
    topics: [`0x${"11".repeat(32)}`],
    data: "0x",
    blockNumber: `0x${n.toString(16)}`,
    transactionHash: `0x${n.toString(16).padStart(64, "A")}`,
    logIndex: "0x2",
    ...(time === "zero" ? { blockTimestamp: "0x0" } : time ? { blockTimestamp: `0x${(1791540000 + n).toString(16)}` } : {}),
    removed: false,
  });

  it("halves a stretch the node refuses as too big, and returns every log in order", async () => {
    const ranges: string[] = [];
    const n = await node((method, params) => {
      if (method !== "eth_getLogs") return basics(method, params);
      const f = params[0] as { fromBlock: string; toBlock: string; address: string };
      const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
      ranges.push(`${from}-${to}`);
      // the node's own words, as measured on the live chain
      if (to - from + 1 > 25) throw new RpcError(-32005, "logs matched by query exceeds limit of 10000");
      return [10, 37, 38, 99].filter((b) => b >= from && b <= to).map((b) => log(b, b === 38 ? false : b === 99 ? "zero" : true));
    });
    const chain = viemChain([n.url], 4663, Date.now, 5);
    const got: ChainLog[] = [];
    const spans: bigint[] = [];
    const done = await readLogs(chain, 1n, 100n, { address: A.splitter }, 100n, (logs, upTo) => {
      got.push(...logs);
      spans.push(upTo);
    });
    expect(done).toBe(100n);
    expect(spans).toEqual([100n]); // one stretch to the caller, however it was cut up underneath
    expect(got.map((l) => Number(l.blockNumber))).toEqual([10, 37, 38, 99]);
    expect(ranges[0]).toBe("1-100");
    expect(ranges.length).toBeGreaterThan(4);
    // lowercase address and hash, the log's own time when the node sends it, and none when it does not
    expect(got[0]).toMatchObject({ address: A.splitter, logIndex: 2, timestamp: 1791540010 });
    expect(got[0].transactionHash).toBe(got[0].transactionHash.toLowerCase());
    expect(got[2].timestamp).toBeUndefined();
    // the live node sends a zero where the time should be: that is no time at all, and the block is asked instead
    expect(got[3].timestamp).toBeUndefined();
    // the node finding a query too big is the node answering: it is not counted against it
    expect(chain.health().nodes[0].failed).toBe(0);
  });

  it("tells 'too big' from everything else", () => {
    expect(tooMany("logs matched by query exceeds limit of 10000")).toBe(true);
    expect(tooMany("log query timed out")).toBe(true);
    expect(tooMany("fetch failed")).toBe(false);
    expect(tooMany("execution reverted")).toBe(false);
  });
});

describe("a call the contract refuses", () => {
  it("is read by the contract's own name for it, and is not the node's fault", async () => {
    const abi = factorBurnPotAbi as Abi;
    const n = await node((method, params) => {
      if (method === "eth_call") throw new RpcError(3, "execution reverted", encodeErrorResult({ abi, errorName: "TooSoon", args: [1791541800n] }));
      return basics(method, params);
    });
    const chain = viemChain([n.url], 4663, Date.now, 5);
    const err = await chain.simulate({ to: A.burnPot, abi, functionName: "burn", args: [1n] }, A.bot).catch((e) => e);
    expect(revertOf(err)).toEqual({ name: "TooSoon", args: [1791541800n] });
    expect(reason(err)).toBe("the contract refuses it: TooSoon(1791541800)");
    expect(nodeBusy(err)).toBe(false);
    expect(chain.health().nodes[0].failed).toBe(0);
    expect(revertOf(new Error("fetch failed"))).toBeNull();
  });

  it("gives back what a simulated call returns", async () => {
    const abi = factorBurnPotAbi as Abi;
    const n = await node((method, params) => {
      if (method === "eth_call") return encodeFunctionResult({ abi, functionName: "burn", result: [5n * 10n ** 15n, 1_000_000n * 10n ** 18n] });
      if (method === "eth_estimateGas") return "0x61a80";
      return basics(method, params);
    });
    const chain = viemChain([n.url], 4663, Date.now, 5);
    expect(await chain.simulate({ to: A.burnPot, abi, functionName: "burn", args: [0n] }, A.bot)).toEqual([5n * 10n ** 15n, 1_000_000n * 10n ** 18n]);
    expect(await chain.estimateGas({ to: A.burnPot, abi, functionName: "burn", args: [1n] }, A.bot)).toBe(400_000n);
    expect(await chain.estimateGas(null, A.bot)).toBe(400_000n);
    expect(await chain.fees()).toEqual({ maxFeePerGas: 24_000_000n, maxPriorityFeePerGas: 0n });
  });
});

describe("the bot's wallet", () => {
  it("signs for the chain it is on, hands over the hash before it broadcasts, and the node gets exactly that transaction", async () => {
    const raws: Hex[] = [];
    const n = await node((method, params) => {
      if (method === "eth_sendRawTransaction") {
        raws.push(params[0] as Hex);
        return keccak256(params[0] as Hex);
      }
      return basics(method, params);
    });
    const signer = viemSigner(TEST_KEY as Hex, [n.url], 4663, 5);
    expect(signer.address).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    expect(addressOfKey(TEST_KEY as Hex)).toBe(signer.address);
    const order: string[] = [];
    let written = "";
    const hash = await signer.send({ call: { to: A.burnPot, abi: factorBurnPotAbi as Abi, functionName: "burn", args: [123n] }, gas: 500_000n, nonce: 7, fees: { maxFeePerGas: 24_000_000n, maxPriorityFeePerGas: 0n } }, (h) => {
      written = h;
      order.push(`written, with ${raws.length} broadcast`);
    });
    expect(order).toEqual(["written, with 0 broadcast"]);
    expect(raws).toHaveLength(1);
    expect(hash).toBe(written);
    expect(hash).toBe(keccak256(raws[0]));
    const tx = parseTransaction(raws[0]);
    expect(tx).toMatchObject({ chainId: 4663, type: "eip1559", nonce: 7, gas: 500_000n, maxFeePerGas: 24_000_000n, to: expect.stringMatching(new RegExp(A.burnPot.slice(2), "i")) });
    expect(tx.value ?? 0n).toBe(0n);
    expect((await recoverTransactionAddress({ serializedTransaction: raws[0] as never })).toLowerCase()).toBe(signer.address);
    // the empty transfer that takes a stuck transaction's place goes to the wallet itself, with nothing in it
    await signer.send({ call: null, gas: 30_000n, nonce: 7, fees: { maxFeePerGas: 48_000_000n, maxPriorityFeePerGas: 1n } }, () => {});
    const empty = parseTransaction(raws[1]);
    expect(empty.to?.toLowerCase()).toBe(signer.address);
    expect(empty.data ?? "0x").toBe("0x");
    expect(empty.value ?? 0n).toBe(0n);
  });

  it("says why a send failed without the key, and with the hash already written down", async () => {
    const n = await node((method, params) => {
      if (method === "eth_sendRawTransaction") throw new RpcError(-32000, "insufficient funds for gas * price + value");
      return basics(method, params);
    });
    const signer = viemSigner(TEST_KEY as Hex, [n.url], 4663, 5);
    let written = "";
    const err = await signer.send({ call: null, gas: 30_000n, nonce: 1, fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 0n } }, (h) => (written = h)).catch((e) => e);
    expect(written).toMatch(/^0x[0-9a-f]{64}$/);
    expect(reason(err)).toContain("insufficient funds");
    const everything = `${err.message} ${err.stack} ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`;
    expect(everything).not.toContain(TEST_KEY.slice(2));
    expect(reason(err)).not.toContain("a-secret-provider-key");
  });
});

describe("what is logged", () => {
  it("cuts every node address down to its host", () => {
    expect(hostsOnly("HTTP request failed. URL: https://robinhood-mainnet.g.alchemy.com/v2/abc123SECRET?x=1 body")).toBe("HTTP request failed. URL: https://robinhood-mainnet.g.alchemy.com body");
    expect(hostsOnly("two: http://a.example/k1 and wss://b.example/k2")).toBe("two: http://a.example and wss://b.example");
    expect(reason(new Error("first line https://node.example/key\nsecond line"))).toBe("first line https://node.example");
  });
});
