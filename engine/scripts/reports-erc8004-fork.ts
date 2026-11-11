// Credit scores on ERC-8004, on a fork of Robinhood Chain (docs/RELEASE-reports-erc8004.md): the engine's own writer
// (src/reportserc8004.ts) and its own attempt (src/chain/act.ts: simulate, estimate, the gas caps, send, receipt) write the
// reports of the best ranked agents on the live chain, as factoragents.fun scores them now, from Factor's real gas wallet
// (anvil lets the fork send from it without its key), and every entry is read back from the real reputation registry:
// readFeedback, getSummary, getLastIndex and the NewFeedback log's hash against the file. Then one agent's score moves and
// a week passes: the new entry is written and the one before revoked, and getSummary counts exactly one. Nothing here
// touches the real chain: anvil holds every transaction.
//
//   node_modules/.bin/tsx scripts/reports-erc8004-fork.ts            (ANVIL=~/.foundry/bin/anvil, AGENTS=6)
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, http, keccak256, toHex, type Abi, type Hex } from "viem";
import { erc8004ReputationAbi } from "../src/abi/index.js";
import { attempt } from "../src/chain/act.js";
import { viemChain, type Signer } from "../src/chain/chain.js";
import { DEFAULTS } from "../src/chain/config.js";
import type { Ctx } from "../src/chain/context.js";
import { EngineDb, open } from "../src/chain/db.js";
import { REPUTATION_REGISTRY } from "../src/erc8004.js";
import type { Reports } from "../src/reports.js";
import { readReportsErc8004, ReportsErc8004 } from "../src/reportserc8004.js";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const SITE = "https://factoragents.fun";
const GAS_WALLET = "0xe4314ba4dae5f31582ec23812d5f40287f1efde0";
const IDENTITY = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432";
const PORT = 8000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}`;
const N = Number(process.env.AGENTS ?? 6);
const say = (...x: unknown[]) => console.log(...x);

const anvil = spawn(process.env.ANVIL ?? `${homedir()}/.foundry/bin/anvil`, ["--fork-url", RPC, "--port", String(PORT), "--chain-id", "4663", "--auto-impersonate", "--hardfork", "shanghai", "--silent"], { stdio: "ignore" });
const stop = () => { try { anvil.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", stop);

async function main(): Promise<void> {
  const chainDef = defineChain({ id: 4663, name: "Robinhood Chain fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [URL_] } } });
  const pub = createPublicClient({ chain: chainDef, transport: http(URL_) });
  for (let i = 0; ; i++) {
    try { await pub.getBlockNumber(); break; } catch { if (i > 120) throw new Error("anvil did not start"); await new Promise((r) => setTimeout(r, 500)); }
  }
  const forkBlock = await pub.getBlockNumber();
  say(`fork of Robinhood Chain at block ${forkBlock}, anvil on ${URL_}`);

  // the best ranked agents, as factoragents.fun scores them now, each with its identity's owner and agentWallet
  const top = (await (await fetch(`${SITE}/api/v1/reports/top?limit=${N}`)).json()) as { items: { agentId: string; name: string; score: number; parts: Record<string, number> }[] };
  const rows: ReturnType<Reports["writable"]> = [];
  for (const t of top.items) {
    const rep = (await (await fetch(`${SITE}/api/v1/reports/agent/${t.agentId}`)).json()) as { agent: { owner: string | null; agentWallet: string | null; factorOwn: boolean } };
    rows.push({ agentId: t.agentId, score: t.score, parts: t.parts, factorOwn: rep.agent.factorOwn, owner: rep.agent.owner, wallet: rep.agent.agentWallet });
    say(`  #${t.agentId} ${t.name}: ${t.score}`);
  }

  // the reports, as the engine's Reports answers the writer: what is ranked, read to which block
  const reports = { cfg: { identity: IDENTITY, reputation: REPUTATION_REGISTRY, enabled: true }, on: () => true, caughtUp: () => true, readTo: () => Number(forkBlock), writable: () => rows } as unknown as Reports;
  let extra = 0;
  const now = () => Date.now() + extra;
  const db = new EngineDb(open(":memory:"), now);
  const lines: string[] = [];
  const log = (l: string) => { lines.push(l); say(`  ${l}`); };
  const w = new ReportsErc8004({ ...readReportsErc8004({ REPORTS_ERC8004: "on" }) }, { db, reports: () => reports, chain: viemChain([URL_], 4663), chainId: 4663, explorer: "https://robinhoodchain.blockscout.com", now, nowS: () => Math.floor(now() / 1000), writer: () => GAS_WALLET, log });

  // Factor's gas wallet on the fork: anvil sends as it, the engine's attempt does everything else as it does live
  const wallet = createWalletClient({ chain: chainDef, transport: http(URL_) });
  const signer: Signer = {
    address: GAS_WALLET,
    async send(tx, onSigned) {
      const hash = await wallet.sendTransaction({ account: GAS_WALLET as Hex, to: tx.call!.to as Hex, data: encodeFunctionData({ abi: tx.call!.abi, functionName: tx.call!.functionName, args: tx.call!.args ?? [] } as never), gas: tx.gas, nonce: tx.nonce, maxFeePerGas: tx.fees.maxFeePerGas, maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas, chain: chainDef });
      onSigned(hash.toLowerCase());
      return hash.toLowerCase();
    },
  };
  const ctx = { mode: "live", params: DEFAULTS, chainId: 4663, explorer: "", addr: {}, deployBlock: 0n, chain: viemChain([URL_], 4663), signer, db, facts: { token: null, factory: null, escrow: null, gateway: null, bot: GAS_WALLET, from: GAS_WALLET }, log, now, pollMs: 200, blockTimes: new Map(), stopping: () => false, reportsErc8004: w } as unknown as Ctx;
  const head = async () => { const b = await pub.getBlock(); return { number: b.number, timestamp: Number(b.timestamp), hash: b.hash }; };
  const pass = async (label: string) => { const said = await w.step(ctx, await head(), (kind, ref, call, detail, feeCap, pre) => attempt(ctx, kind, ref, call, detail, feeCap, pre)); say(`${label}: ${said}`); };

  const readOf = async (fn: string, args: unknown[]) => pub.readContract({ address: REPUTATION_REGISTRY as Hex, abi: erc8004ReputationAbi as Abi, functionName: fn, args } as never) as Promise<unknown>;
  const before = new Map<string, bigint>();
  for (const r of rows) before.set(r.agentId, (await readOf("getLastIndex", [BigInt(r.agentId), GAS_WALLET])) as bigint);

  // the first run: one pass writes up to ten
  await pass("first run");
  await pass("again, nothing changed");
  let gasAll = 0n, txs = 0;
  let ok = true;
  const check = (cond: boolean, what: string) => { if (!cond) { ok = false; say(`  FAILED: ${what}`); } };
  for (const r of rows) {
    const e = db.q("SELECT * FROM report_erc8004 WHERE agent_id = ? ORDER BY n DESC LIMIT 1").get(r.agentId) as { n: number; status: string; tx_hash: string; feedback_index: number; hash: string; body: string; score: number; error: string | null } | undefined;
    if (!e || e.status !== "done") { say(`  #${r.agentId}: ${e?.status ?? "not written"} ${e?.error ?? ""}`); continue; }
    const receipt = await pub.getTransactionReceipt({ hash: e.tx_hash as Hex });
    gasAll += receipt.gasUsed; txs++;
    const fb = (await readOf("readFeedback", [BigInt(r.agentId), GAS_WALLET, BigInt(e.feedback_index)])) as [bigint, number, string, string, boolean];
    const sum = (await readOf("getSummary", [BigInt(r.agentId), [GAS_WALLET], "factorReport", ""])) as [bigint, bigint, number];
    const last = (await readOf("getLastIndex", [BigInt(r.agentId), GAS_WALLET])) as bigint;
    let logHash: string | null = null, logUri: string | null = null;
    for (const l of receipt.logs) {
      try { const x = decodeEventLog({ abi: erc8004ReputationAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data }); if (x.eventName === "NewFeedback") { const a = x.args as { feedbackHash: string; feedbackURI: string }; logHash = a.feedbackHash; logUri = a.feedbackURI; } } catch { /* another */ }
    }
    say(`  #${r.agentId}: tx ${e.tx_hash}, gas ${receipt.gasUsed}, index ${e.feedback_index}; readFeedback (${fb[0]}, ${fb[1]}, ${fb[2]}, ${fb[3]}, revoked ${fb[4]}); getSummary (${sum[0]}, ${sum[1]}, ${sum[2]}); getLastIndex ${before.get(r.agentId)} -> ${last}; ${logUri}`);
    check(fb[0] === BigInt(r.score) && fb[1] === 0 && fb[2] === "factorReport" && fb[3] === "1.1.0" && !fb[4], `#${r.agentId} readFeedback`);
    check(sum[0] === 1n && sum[1] === BigInt(r.score), `#${r.agentId} getSummary`);
    check(last === before.get(r.agentId)! + 1n, `#${r.agentId} getLastIndex`);
    check(logHash === e.hash && keccak256(toHex(e.body)) === e.hash, `#${r.agentId} the file's hash`);
  }
  check(txs === rows.filter((r) => !r.factorOwn && r.score > 0).length, "every ranked agent written once");

  // a week later one agent's score has moved: the new entry, then the one before revoked
  const moved = rows[0]!;
  const was = moved.score;
  moved.score += 5;
  extra += 169 * 3_600_000;
  await pass("a week later, one score moved");
  await pass("and the entry before it");
  const all = (await readOf("readAllFeedback", [BigInt(moved.agentId), [GAS_WALLET], "factorReport", "", true])) as [string[], bigint[], bigint[], number[], string[], string[], boolean[]];
  const sum = (await readOf("getSummary", [BigInt(moved.agentId), [GAS_WALLET], "factorReport", ""])) as [bigint, bigint, number];
  say(`  #${moved.agentId}: readAllFeedback values ${all[2].join(", ")}, revoked ${all[6].join(", ")}; getSummary (${sum[0]}, ${sum[1]}, ${sum[2]})`);
  check(all[2].length === 2 && all[2][0] === BigInt(was) && all[2][1] === BigInt(moved.score) && all[6][0] === true && all[6][1] === false, "the change: written and the one before revoked");
  check(sum[0] === 1n && sum[1] === BigInt(moved.score), "exactly one stands");
  for (const h of (db.q("SELECT tx_hash FROM engine_actions WHERE kind = 'erc8004_report' AND status = 'done' AND tx_hash IS NOT NULL").all() as { tx_hash: string }[]).slice(txs)) {
    const rc = await pub.getTransactionReceipt({ hash: h.tx_hash as Hex });
    say(`  ${h.tx_hash}: gas ${rc.gasUsed}`);
  }
  const gasPrice = BigInt((await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }) })).json() as { result: string }).result);
  say(`${txs} first entries: ${gasAll} gas on the fork (${txs ? gasAll / BigInt(txs) : 0n} each, L2 execution only); the live node estimates about 198,000 with its L1 part; at today's ${Number(gasPrice) / 1e9} gwei, 405 entries of 200,000 gas come to ${Number(405n * 200_000n * gasPrice) / 1e18} ETH`);
  say(`the writer counted ${w.spentToday()} wei of the day's ${w.cfg.gasDayWei} (at the most each could cost)`);
  say(ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED");
  stop();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); stop(); process.exit(1); });
