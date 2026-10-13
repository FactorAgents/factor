// Reading the chain into the database.
//
// Four watchers: the splitter, the burn pot, the desk, and the token's mint. Each reads its contract's logs from where it
// stopped last time up to a few blocks behind the head, a stretch at a time, and writes what it finds and its new
// cursor in one transaction: stopped anywhere, it goes on from the last stretch it finished. (The three contracts
// share one query a pass while their cursors stand together; the mint is looked for every few minutes once
// found.) A log is keyed by its transaction and its place in it, so a stretch read twice writes nothing twice.
// The hash of the block each pass ended on is kept; when the chain no longer has that hash there, the watchers go
// back to the newest block that still matches, take back what they wrote above it, and read on from there.
//
// What a contract HOLDS (balances, the supply, the next burn, the pool) is not worked out from logs: it is asked
// of the chain at the head every pass and kept as one snapshot. Logs are for history. The same goes for each job
// and each agent of the desk: a log marks it as changed, and it is then read from the desk itself (../desk.ts).

import { decodeEventLog, encodeEventTopics, pad, parseAbi, type Abi, type Hex } from "viem";
import { factorBurnPotAbi, factorDeskAbi, factorSplitterAbi, factorTokenAbi } from "../abi/index.js";
import { applyCompute, ComputeStore } from "../compute.js";
import { applyBurn, applyDesk, refreshDesk } from "../desk.js";
import { normalizeAddress } from "./address.js";
import { readLogs, type ChainLog, type Head, type LogFilter } from "./chain.js";
import { SNAPSHOT_KEY, snapshotOf, type Ctx, type Snapshot } from "./context.js";
import type { EngineDb, EventRow } from "./db.js";
import { phaseName, ponsEscrowAbi, ponsFactoryAbi } from "./pons.js";

// Chainlink's ETH / USD feed on Robinhood Chain (8 decimals), for saying what a burn cost in dollars.
export const ETH_USD_FEED = "0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9";
const FEED_ABI = parseAbi(["function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"]) as Abi;
// how many blocks the mint watcher lets itself fall behind once the mint is on record
const MINT_EVERY_BLOCKS = 3000n;

const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER = encodeEventTopics({ abi: factorTokenAbi, eventName: "Transfer" })[0] as Hex;
const FROM_NOBODY = pad(ZERO as Hex, { size: 32 });

interface Watcher {
  name: "splitter" | "burnPot" | "desk" | "token";
  abi: Abi;
  filter(ctx: Ctx): LogFilter | null; // null: nothing to read yet
  apply(db: EngineDb, e: EventRow, ctx: Ctx): string | null; // a line for the log, if it is worth one
}

const eth = (wei: unknown): string => {
  const w = BigInt(String(wei));
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

export const WATCHERS: Watcher[] = [
  {
    name: "splitter",
    abi: factorSplitterAbi as Abi,
    filter: (ctx) => ({ address: ctx.addr.splitter }),
    apply(db, e) {
      if (e.event !== "Split") return null;
      db.addSplit(e);
      return `a split of ${eth(e.args.amount)} ETH: ${eth(e.args.toAdmin)} to the admin, ${eth(e.args.toBurn)} to the burn pot, ${eth(e.args.toPool)} to the pool`;
    },
  },
  {
    name: "burnPot",
    abi: factorBurnPotAbi as Abi,
    filter: (ctx) => ({ address: ctx.addr.burnPot }),
    apply(db, e) {
      if (e.event !== "Burned") return null;
      // priced at the ETH price of the last reading, which is seconds old when the engine is following the chain
      db.addBurn(e, snapshotOf(db)?.ethUsd8 ?? null);
      applyBurn(db, e);
      return `burn ${e.args.n}: ${eth(e.args.ethIn)} ETH bought and burned ${eth(e.args.tokensBurned)} $FACTOR`;
    },
  },
  {
    name: "desk",
    abi: factorDeskAbi as Abi,
    filter: (ctx) => ({ address: ctx.addr.desk }),
    apply(db, e, ctx) {
      // a compute advance is also credit at the gateway, priced at the ETH price of the last reading
      applyCompute(new ComputeStore(db), e, snapshotOf(db)?.ethUsd8 ?? null);
      return applyDesk(db, e, { splitter: ctx.addr.splitter, gateway: ctx.facts.gateway });
    },
  },
  {
    // The token's mint: what "burned so far" is measured from. Only transfers from nobody are asked for, so the
    // token's every trade is not read.
    name: "token",
    abi: factorTokenAbi as Abi,
    filter: (ctx) => (ctx.facts.token ? { address: ctx.facts.token, topics: [TRANSFER, FROM_NOBODY] } : null),
    apply: () => null,
  },
];

function addressOf(w: Watcher, ctx: Ctx): string | null {
  const f = w.filter(ctx);
  return f ? (Array.isArray(f.address) ? f.address[0] : f.address) : null;
}

// A log's arguments as they are stored: numbers as text, addresses lowercase.
function plain(args: unknown): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (!args || typeof args !== "object") return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "bigint" || typeof v === "number") out[k] = v.toString();
    else if (typeof v === "string") out[k] = normalizeAddress(v) ?? v;
    else out[k] = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  }
  return out;
}

export function decode(w: Pick<Watcher, "name" | "abi">, log: ChainLog, at: number): EventRow | null {
  try {
    const d = decodeEventLog({ abi: w.abi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true }) as { eventName: string; args: unknown };
    return { tx_hash: log.transactionHash.toLowerCase(), log_index: log.logIndex, block: Number(log.blockNumber), at, contract: w.name, event: d.eventName, args: plain(d.args) };
  } catch {
    return null; // not one of this contract's events
  }
}

export interface WatchResult {
  head: Head;
  safe: bigint;
  fresh: number; // logs written for the first time
  rewoundTo: bigint | null;
  lines: string[];
}

// The reorg check: is the block the last pass ended on still the chain's? If not, back to the newest kept block
// that is, or to before the deploy when none is.
async function checkReorg(ctx: Ctx): Promise<bigint | null> {
  const kept = ctx.db.checkpoints();
  if (kept.length === 0) return null;
  const newest = await ctx.chain.block(kept[0].number);
  if (newest && newest.hash === kept[0].hash) return null;
  let back = ctx.deployBlock - 1n;
  for (const c of kept.slice(1)) {
    const b = await ctx.chain.block(c.number);
    if (b && b.hash === c.hash) {
      back = c.number;
      break;
    }
  }
  const gone = ctx.db.rewind(back);
  ctx.log(`[watch] the chain changed under block ${kept[0].number}: back to block ${back}, ${gone} row(s) taken back and read again`);
  return back;
}

export async function watchPass(ctx: Ctx): Promise<WatchResult> {
  const { chain, db, params } = ctx;
  const head = await chain.head();
  const safe = head.number - BigInt(params.confirmations);
  const out: WatchResult = { head, safe, fresh: 0, rewoundTo: null, lines: [] };
  if (safe < ctx.deployBlock) {
    await refresh(ctx, head);
    return out;
  }
  out.rewoundTo = await checkReorg(ctx);

  // the token, as soon as there is one: the mint watcher needs its address
  if (!ctx.facts.token) await learnToken(ctx);

  // One stretch of logs, written with the cursors of the watchers it was read for, in one transaction.
  const take = (group: Watcher[]) => async (logs: ChainLog[], upTo: bigint) => {
    // a log's time is its block's: sent with the log by nodes that do, asked for otherwise (and remembered, so a
    // stretch read again after the node turned the pass away does not ask again)
    const missing = [...new Set(logs.filter((l) => l.timestamp === undefined && !ctx.blockTimes.has(l.blockNumber)).map((l) => l.blockNumber))];
    for (let i = 0; i < missing.length; i += 10) {
      const blocks = await Promise.all(missing.slice(i, i + 10).map((n) => chain.block(n)));
      blocks.forEach((b, k) => ctx.blockTimes.set(missing[i + k], b?.timestamp ?? 0));
    }
    if (ctx.blockTimes.size > 20_000) ctx.blockTimes.clear();
    db.tx(() => {
      for (const log of logs) {
        const w = group.length === 1 ? group[0] : group.find((g) => addressOf(g, ctx) === log.address);
        if (!w) continue;
        const e = decode(w, log, log.timestamp ?? ctx.blockTimes.get(log.blockNumber) ?? 0);
        if (!e || !db.addEvent(e)) continue;
        out.fresh++;
        const line = w.apply(db, e, ctx);
        if (line) out.lines.push(line);
      }
      for (const w of group) db.setCursor(w.name, upTo);
    });
  };

  // The three contracts are read with one query when their cursors stand at the same block, which is how they
  // stand except in the middle of a catch-up: one request a pass, not two.
  let reached = false;
  const groups = new Map<bigint, Watcher[]>();
  for (const w of WATCHERS) {
    if (w.name === "token") continue;
    const from = (db.cursor(w.name) ?? ctx.deployBlock - 1n) + 1n;
    groups.set(from, [...(groups.get(from) ?? []), w]);
  }
  for (const [from, group] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (from > safe) {
      reached = true;
      continue;
    }
    const done = await readLogs(chain, from, safe, { address: group.map((w) => addressOf(w, ctx)!) }, BigInt(params.logSpan), take(group), params.spansPerPass);
    if (done === safe) reached = true;
  }
  // The mint. A Pons token cannot be minted again, so once its mint is on record this watcher only looks every
  // few minutes; until then, and after a rewind or a reindex, it reads like the others.
  const mint = WATCHERS.find((w) => w.name === "token")!;
  const filter = mint.filter(ctx);
  if (filter) {
    const from = (db.cursor("token") ?? ctx.deployBlock - 1n) + 1n;
    const found = db.events("token", "Transfer").length > 0;
    if (from <= safe && (!found || safe - from + 1n >= MINT_EVERY_BLOCKS)) await readLogs(chain, from, safe, filter, BigInt(params.logSpan), take([mint]), params.spansPerPass);
  }
  if (reached) {
    const b = await chain.block(safe);
    if (b) db.checkpoint(safe, b.hash, params.checkpoints);
  }
  // every job and agent a log touched (or a rewind marked) is read from the desk itself
  await refreshDesk(ctx);
  await refresh(ctx, head);
  for (const line of out.lines) ctx.log(`[watch] ${line}`);
  return out;
}

async function learnToken(ctx: Ctx): Promise<void> {
  const token = normalizeAddress(await ctx.chain.read<string>({ to: ctx.addr.burnPot, abi: factorBurnPotAbi as Abi, functionName: "token" }));
  if (token && token !== ZERO) {
    ctx.facts.token = token;
    ctx.log(`[watch] $FACTOR is launched: ${token}`);
  }
}

// What the chain holds right now. One snapshot, asked at the head in one go (the reads fold into one multicall on
// the real chain).
export async function refresh(ctx: Ctx, head: Head): Promise<Snapshot> {
  const snapshot = await readSnapshot(ctx, head);
  ctx.db.setJson(SNAPSHOT_KEY, snapshot);
  // compute credit drawn before any ETH price was known is priced now
  new ComputeStore(ctx.db).priceWaiting(snapshot.ethUsd8);
  return snapshot;
}

export async function readSnapshot(ctx: Ctx, head: Head): Promise<Snapshot> {
  const { chain, addr, facts } = ctx;
  const S = factorSplitterAbi as Abi;
  const B = factorBurnPotAbi as Abi;
  const T = factorTokenAbi as Abi;
  const D = factorDeskAbi as Abi;
  const read = <X>(to: string, abi: Abi, functionName: string, args: readonly unknown[] = []) => chain.read<X>({ to, abi, functionName, args });
  if (!facts.token) await learnToken(ctx);
  if (!facts.factory) facts.factory = normalizeAddress(await read<string>(addr.burnPot, B, "factory"));
  if (!facts.escrow) facts.escrow = normalizeAddress(await read<string>(addr.splitter, S, "escrow"));
  if (!facts.gateway) facts.gateway = normalizeAddress(await read<string>(addr.desk, D, "gateway"));
  const token = facts.token;
  const none = Promise.resolve(0n);
  const botAddress = facts.bot;

  const [
    unsplit, adminPending, burnPending, totalSplit, totalToAdmin, totalToBurn, escrowEth, escrowFactor, splitterFactor,
    potBalance, potFactor, startedAt, lastBurnAt, burnCount, totalEthBurned, totalTokensBurned, market, preview,
    supply, launched, botBalance, ethUsd, poolPending, totalToPool, desk,
  ] = await Promise.all([
    read<bigint>(addr.splitter, S, "unsplit"),
    read<bigint>(addr.splitter, S, "adminPending"),
    read<bigint>(addr.splitter, S, "burnPending"),
    read<bigint>(addr.splitter, S, "totalSplit"),
    read<bigint>(addr.splitter, S, "totalToAdmin"),
    read<bigint>(addr.splitter, S, "totalToBurn"),
    facts.escrow ? read<bigint>(facts.escrow, ponsEscrowAbi as Abi, "balanceOf", [addr.splitter]) : none,
    facts.escrow && token ? read<bigint>(facts.escrow, ponsEscrowAbi as Abi, "balanceOfToken", [addr.splitter, token]) : none,
    token ? read<bigint>(token, T, "balanceOf", [addr.splitter]) : none,
    chain.balance(addr.burnPot),
    token ? read<bigint>(token, T, "balanceOf", [addr.burnPot]) : none,
    read<bigint>(addr.burnPot, B, "startedAt"),
    read<bigint>(addr.burnPot, B, "lastBurnAt"),
    read<bigint>(addr.burnPot, B, "burnCount"),
    read<bigint>(addr.burnPot, B, "totalEthBurned"),
    read<bigint>(addr.burnPot, B, "totalTokensBurned"),
    read<readonly [boolean, boolean, bigint]>(addr.burnPot, B, "market"),
    read<readonly [bigint, bigint, boolean]>(addr.burnPot, B, "preview"),
    token ? read<bigint>(token, T, "totalSupply") : none,
    token && facts.factory ? read<{ phase: number }>(facts.factory, ponsFactoryAbi as Abi, "getLaunchedToken", [token]) : Promise.resolve(null),
    botAddress ? chain.balance(botAddress) : none,
    // the dollar figure is a convenience: a feed that does not answer leaves it out and stops nothing
    read<readonly [bigint, bigint, bigint, bigint, bigint]>(ETH_USD_FEED, FEED_ABI, "latestRoundData").then((r) => (r[1] > 0n ? r[1] : null)).catch(() => null),
    read<bigint>(addr.splitter, S, "poolPending"),
    read<bigint>(addr.splitter, S, "totalToPool"),
    Promise.all([
      chain.balance(addr.desk),
      ...["pool", "out", "held", "bonds", "owedTotal", "jobCount", "totalAdvanced", "totalAdvanceFees", "totalJobFees", "totalSettled", "totalPoolIn", "totalLost"].map((fn) => read<bigint>(addr.desk, D, fn)),
      read<bigint>(addr.desk, D, "owed", [addr.burnPot]),
    ]),
  ]);
  const [deskBalance, pool, out, held, bonds, owedTotal, jobCount, totalAdvanced, totalAdvanceFees, totalJobFees, totalSettled, totalPoolIn, totalLost, owedBurnPot] = desk;
  return {
    at: ctx.now(),
    block: Number(head.number),
    blockTime: head.timestamp,
    token: token ? { address: token, totalSupply: supply.toString() } : null,
    phase: launched ? phaseName(Number(launched.phase)) : null,
    ethUsd8: ethUsd === null ? (snapshotOf(ctx.db)?.ethUsd8 ?? null) : ethUsd.toString(),
    splitter: {
      unsplit: unsplit.toString(),
      adminPending: adminPending.toString(),
      burnPending: burnPending.toString(),
      totalSplit: totalSplit.toString(),
      totalToAdmin: totalToAdmin.toString(),
      totalToBurn: totalToBurn.toString(),
      poolPending: poolPending.toString(),
      totalToPool: totalToPool.toString(),
      escrowEth: escrowEth.toString(),
      escrowFactor: escrowFactor.toString(),
      factorHeld: splitterFactor.toString(),
    },
    burnPot: {
      balance: potBalance.toString(),
      factorHeld: potFactor.toString(),
      startedAt: Number(startedAt),
      lastBurnAt: Number(lastBurnAt),
      burnCount: Number(burnCount),
      totalEthBurned: totalEthBurned.toString(),
      totalTokensBurned: totalTokensBurned.toString(),
      open: market[0],
      viaCurve: market[1],
      depthCap: market[2].toString(),
      nextAmount: preview[0].toString(),
      nextAt: Number(preview[1]),
      ready: preview[2],
    },
    desk: {
      balance: deskBalance.toString(),
      pool: pool.toString(),
      out: out.toString(),
      held: held.toString(),
      bonds: bonds.toString(),
      owedTotal: owedTotal.toString(),
      owedBurnPot: owedBurnPot.toString(),
      jobCount: Number(jobCount),
      totalAdvanced: totalAdvanced.toString(),
      totalAdvanceFees: totalAdvanceFees.toString(),
      totalJobFees: totalJobFees.toString(),
      totalSettled: totalSettled.toString(),
      totalPoolIn: totalPoolIn.toString(),
      totalLost: totalLost.toString(),
    },
    bot: botAddress ? { address: botAddress, balance: botBalance.toString() } : null,
  };
}
