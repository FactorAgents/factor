// What the engine does on the chain. Four things, each with one trigger:
//
//   sweep        fees are waiting for the splitter (on the curve, or in Pons' escrow): collect and split them.
//                With it, claim_token: a credit in $FACTOR in the escrow is claimed and sent on to the burn pot.
//   burn         the burn pot says a burn is allowed: buy back and burn, with a minimum taken from a quote.
//   settle_job   a job was delivered and its customer's 24 hours are over: settle it, so the agent is paid and the
//                pool repaid. refund_job: a job is past its due time and the 12 hours of grace: refund it.
//   collect      the desk holds an advance fee the burn pot was not sent: deliver it.
//   return_compute  compute credit that was closed unspent (its job was refunded): the ETH goes back to the pool.
//   retry_split     a share the splitter could not deliver when it split, which in practice means the admin
//                   wallet refused its ETH (a wallet can carry code these days): its retry() tries again. A split
//                   cannot be made to fall short by starving it of gas; the fork run holds it to that.
//   skim            the gas wallet is also where compute advances are paid, so ETH gathers in it. What it holds
//                   over its gas money and over what still backs open compute credit is sent on to a wallet the
//                   owner named (ENGINE_SKIM_TO), so that the key this process holds never guards more than it must.
//   relay           what the owner of an account without a wallet signed (../accounts.ts): made, or carried out,
//                   with this wallet paying the gas. First in every pass: somebody is waiting for it.
//
// Every attempt goes the same way (attempt(), below): the lock, a last simulation of exactly the call that would
// be sent, the gas against its cap, the gas price against its cap, then in dry mode a record of what would have
// been sent, and in live mode the transaction: written down as it is signed, sent, and followed to its receipt.
// One transaction of the gas wallet's is on its way at a time; while one is, nothing else is sent.
//
// The engine has no call that names a destination of its own choosing: every one of them pays only to addresses
// fixed in the contracts or written in the job. Anyone may make these calls; the engine is simply the one that
// does, on time.

import type { Abi } from "viem";
import { factorBurnPotAbi, factorDeskAbi, factorSplitterAbi, factorTokenAbi } from "../abi/index.js";
import { DeskStore, rereadJob } from "../desk.js";
import { AccountStore, callOfRelay, landedRelay } from "../accounts.js";
import { stopped } from "../switches.js";
import { ComputeStore } from "../compute.js";
import { nodeBusy, nodeRejected, reason, revertOf, type CallSpec, type Fees, type Head, type Pay, type Receipt } from "./chain.js";
import { snapshotOf, type Ctx } from "./context.js";
import type { ActionKind, ActionRow } from "./db.js";
import { ponsEscrowAbi } from "./pons.js";

export type SendKind = Exclude<ActionKind, "unstick">;
export const KINDS: SendKind[] = ["relay", "sweep", "retry_split", "claim_token", "burn", "settle_job", "refund_job", "collect", "return_compute", "skim"];
// In dry mode nothing changes on the chain, so a trigger stays true: what would be sent is shown again this often.
export const DRY_REPEAT_S = 1800;
const BPS = 10_000n;

// How an action stands: when it last ran, how it went, and when it may be tried again.
export interface ActState {
  lastAt: number; // the chain's time (seconds) when it was last sent, or shown in dry mode
  ref: string;
  fails: number; // failures in a row
  nextAt: number; // the wall clock (ms) before which it is not retried
  result: string; // one line: what the last look decided
  resultAt: number; // ms
  tx: string | null; // the last transaction it sent
}

export function actState(ctx: Pick<Ctx, "db">, kind: SendKind): ActState {
  return ctx.db.getJson<ActState>(`act:${kind}`) ?? { lastAt: 0, ref: "", fails: 0, nextAt: 0, result: "has not run yet", resultAt: 0, tx: null };
}

function say(ctx: Ctx, kind: SendKind, result: string, patch: Partial<ActState> = {}): string {
  ctx.db.setJson(`act:${kind}`, { ...actState(ctx, kind), ...patch, result, resultAt: ctx.now() });
  return result;
}

// It went wrong: said once in the log, and tried again after a wait that doubles with every failure in a row.
function failed(ctx: Ctx, kind: SendKind, why: string, baseS: number, maxS: number): string {
  const st = actState(ctx, kind);
  const fails = st.fails + 1;
  const waitS = Math.min(baseS * 2 ** Math.min(fails - 1, 16), maxS);
  ctx.log(`[${kind}] ${why}. Trying again in ${waitS} s (failure ${fails} in a row)`);
  return say(ctx, kind, why, { fails, nextAt: ctx.now() + waitS * 1000 });
}

const eth = (wei: bigint): string => {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const gwei = (wei: bigint): string => {
  const whole = wei / 10n ** 9n;
  const frac = (wei % 10n ** 9n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const text = (detail: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

export interface Outcome {
  status: "dry" | "done" | "failed" | "sent" | "skipped";
  why: string;
  id?: number;
  hash?: string;
  receipt?: Receipt;
}

async function waitForReceipt(ctx: Ctx, hash: string): Promise<Receipt | null> {
  const until = Date.now() + ctx.params.receiptWaitMs;
  for (;;) {
    const r = await ctx.chain.receipt(hash).catch(() => null);
    if (r) return r;
    // shutting down: the hash is written down, and the next start looks the transaction up
    if (Date.now() >= until || ctx.stopping()) return null;
    await new Promise((res) => setTimeout(res, ctx.pollMs));
  }
}

function close(ctx: Ctx, id: number, r: Receipt): void {
  ctx.db.updateAction(id, { status: r.ok ? "done" : "failed", gasUsed: r.gasUsed, block: r.blockNumber, error: r.ok ? null : "the transaction reverted" });
}

// One attempt at one call. See the top of the file.
export async function attempt(ctx: Ctx, kind: SendKind, ref: string, call: CallSpec, detail: Record<string, unknown>, feeCap: bigint, pre?: { gas: bigint; fees: Fees }): Promise<Outcome> {
  const { chain, db, params } = ctx;
  // Held at the last door too: a burn never goes out without a minimum.
  if (kind === "burn" && !(typeof call.args?.[0] === "bigint" && call.args[0] > 0n)) throw new Error("a burn is never sent with a zero minimum");
  const from = ctx.facts.from;
  if (!from) return { status: "skipped", why: "the gas wallet's address is not known yet" };
  if (!db.lock(kind, params.lockMs)) return { status: "skipped", why: "another attempt holds the lock" };
  const mode = ctx.mode === "live" && ctx.signer ? "live" : "dry";
  try {
    try {
      await chain.simulate(call, from);
    } catch (e) {
      if (!revertOf(e)) throw e;
      const id = db.addAction({ kind, ref, mode, status: "failed", detail: text(detail), error: reason(e) });
      return { status: "failed", why: reason(e), id };
    }
    const estimate = pre?.gas ?? (await chain.estimateGas(call, from));
    const gas = (estimate * (BPS + BigInt(params.gasHeadroomBps))) / BPS;
    const cap = params.gasCaps[kind];
    if (gas > cap) {
      const why = `it would need ${gas} gas, over the cap of ${cap}`;
      const id = db.addAction({ kind, ref, mode, status: "failed", detail: text(detail), error: why });
      return { status: "failed", why, id };
    }
    const fees = pre?.fees ?? (await chain.fees());
    if (fees.maxFeePerGas > feeCap) return { status: "skipped", why: `gas is at ${gwei(fees.maxFeePerGas)} gwei, over the cap of ${gwei(feeCap)}: waiting for it to fall` };
    const full = text({ ...detail, gasEstimate: estimate, gasLimit: gas, maxFeePerGas: fees.maxFeePerGas, maxCostWei: gas * fees.maxFeePerGas });

    if (mode === "dry") {
      const id = db.addAction({ kind, ref, mode, status: "dry", detail: full, gasLimit: gas, maxFeeWei: fees.maxFeePerGas });
      ctx.log(`[dry] would send ${kind}${ref ? ` ${ref}` : ""}: ${call.functionName}(${(call.args ?? []).map(String).join(", ")}) to ${call.to}, up to ${gas} gas at ${gwei(fees.maxFeePerGas)} gwei`);
      return { status: "dry", why: "simulated, not sent", id };
    }

    return await dispatch(ctx, kind, ref, { call }, gas, fees, full);
  } finally {
    db.unlock(kind);
  }
}

// The sending itself: the gas wallet's balance and nonce looked at, the transaction written down as it is signed,
// sent, and followed to its receipt. `what` is a call, or a plain payment of ETH.
async function dispatch(ctx: Ctx, kind: SendKind, ref: string, what: { call?: CallSpec; pay?: Pay }, gas: bigint, fees: Fees, full: Record<string, unknown>): Promise<Outcome> {
  const { chain, db } = ctx;
  const signer = ctx.signer!;
  const mode = "live" as const;
  const value = what.pay?.value ?? 0n;
  const [balance, nonces] = await Promise.all([chain.balance(signer.address), chain.nonces(signer.address)]);
  if (nonces.pending > nonces.latest) return { status: "skipped", why: "a transaction from the gas wallet is still on its way" };
  if (balance < gas * fees.maxFeePerGas + value) {
    const why = `the gas wallet holds ${eth(balance)} ETH: not enough for ${value > 0n ? `the ${eth(value)} ETH and ` : ""}the gas (${eth(gas * fees.maxFeePerGas)} ETH at most)`;
    const id = db.addAction({ kind, ref, mode, status: "failed", detail: full, error: why });
    return { status: "failed", why, id };
  }
  const id = db.addAction({ kind, ref, mode, status: "signed", detail: full, nonce: nonces.latest, gasLimit: gas, maxFeeWei: fees.maxFeePerGas });
  let hash: string | null = null;
  try {
    await signer.send({ call: what.call ?? null, ...(what.pay ? { pay: what.pay } : {}), gas, nonce: nonces.latest, fees }, (h) => {
      hash = h;
      db.updateAction(id, { status: "sent", txHash: h });
    });
  } catch (e) {
    // Three ways a send can go wrong. The node refused it (no funds, a used nonce): it is not on its way, and
    // the action is tried again by its own trigger. The node says it has it already: it is on its way. Or the
    // request itself failed (no connection, a timeout), which says nothing about whether the node took it: it
    // stays written down as sent, and the next passes look for it before anything else goes out.
    const known = /already known|already imported|already exists/i.test((e as Error).message ?? "");
    if (!hash || (nodeRejected(e) && !known)) {
      db.updateAction(id, { status: "failed", error: reason(e) });
      return { status: "failed", why: `it could not be sent: ${reason(e)}`, id };
    }
    if (!known) {
      db.updateAction(id, { error: `the node did not confirm taking it: ${reason(e)}` });
      return { status: "sent", why: `sent, but the node did not confirm taking it (${reason(e)}): looking for it`, id, hash };
    }
  }
  const receipt = await waitForReceipt(ctx, hash!);
  if (!receipt) return { status: "sent", why: "sent, and not mined yet", id, hash: hash! };
  close(ctx, id, receipt);
  return receipt.ok ? { status: "done", why: "sent and mined", id, hash: hash!, receipt } : { status: "failed", why: "the transaction reverted on the chain", id, hash: hash!, receipt };
}

// What a finished transaction changes in the engine's own notes, whenever its receipt is seen.
function landed(ctx: Ctx, a: ActionRow, r: Receipt): void {
  if (a.kind === "unstick") return;
  if (a.kind === "relay" && a.tx_hash) {
    const store = new AccountStore(ctx.db);
    const row = store.relay(a.ref);
    if (row && row.status !== "done" && row.status !== "failed") landedRelay(store, row, r, a.tx_hash);
  }
  if (a.kind === "return_compute") {
    const pending = ctx.db.getJson<{ hash: string; lots: { tx_hash: string; log_index: number }[] }>("return_compute:pending");
    if (pending && pending.hash === a.tx_hash) {
      if (r.ok) new ComputeStore(ctx.db).sentBack(pending.lots, pending.hash);
      ctx.db.unset("return_compute:pending");
    }
  }
  if (r.ok) say(ctx, a.kind, `sent and mined (${a.tx_hash})`, { fails: 0, nextAt: 0, tx: a.tx_hash });
  else say(ctx, a.kind, `the transaction reverted on the chain (${a.tx_hash})`, { tx: a.tx_hash });
}

// A transaction that turned out never to have happened does not count as the action's last run: its trigger is
// free to try again at once.
function unsent(ctx: Ctx, a: ActionRow, why: string): void {
  if (a.kind === "unstick") return;
  if (a.kind === "relay") {
    // the order is as good as it was: it goes back in the queue, and its deadline decides whether it is sent again
    const store = new AccountStore(ctx.db);
    const row = store.relay(a.ref);
    if (row && row.status === "sent") store.mark(row.id, { status: "queued", tx_hash: null });
  }
  say(ctx, a.kind, why, { lastAt: 0 });
  ctx.log(`[${a.kind}] ${why} (${a.tx_hash}): it will be tried again`);
}

// Transactions that were signed or sent and never heard back from (a restart in between, or a slow block): look
// each one up and close it. Returns how many are still on their way.
export async function settle(ctx: Ctx): Promise<number> {
  const { chain, db, params } = ctx;
  let open = 0;
  for (const a of db.openActions()) {
    if (!a.tx_hash) {
      // written down, never signed: the process stopped in between. Nothing reached the chain.
      db.updateAction(a.id, { status: "failed", error: "it was never sent" });
      continue;
    }
    const r = await chain.receipt(a.tx_hash);
    if (r) {
      close(ctx, a.id, r);
      landed(ctx, a, r);
      ctx.log(`[${a.kind}] ${a.tx_hash} ${r.ok ? "is mined" : "reverted"} (found on a later look)`);
      continue;
    }
    if (!ctx.signer || ctx.mode !== "live") {
      open++;
      continue;
    }
    const n = await chain.nonces(ctx.signer.address);
    if (a.nonce !== null && n.latest > a.nonce) {
      db.updateAction(a.id, { status: "replaced", error: "another transaction took its place" });
      unsent(ctx, a, "the transaction was replaced before it was mined");
      continue;
    }
    if (ctx.now() - a.updated_at < params.stuckAfterMs) {
      open++;
      continue;
    }
    if (n.pending <= n.latest) {
      // the node holds nothing of the bot's: it never arrived, or was dropped. The action's own trigger tries again.
      db.updateAction(a.id, { status: "failed", error: "it never reached the chain" });
      unsent(ctx, a, "the transaction never reached the chain");
      continue;
    }
    // Stuck behind its price: an empty transfer to the bot itself at twice the going fee takes its place, which
    // frees the wallet. Whatever was stuck is tried again by its own trigger. One replacement at a time for a
    // nonce, each dearer than the last, so a chain that is simply not moving is not sent one a pass.
    open++;
    if (a.nonce === null) continue;
    const earlier = db.actions("unstick", 50).filter((u) => u.nonce === a.nonce);
    if (earlier.some((u) => ctx.now() - u.created_at < params.stuckAfterMs)) continue;
    if (!db.lock("unstick", params.lockMs)) continue;
    try {
      const fees = await chain.fees();
      const times = BigInt(2 * (earlier.length + 1));
      const bumped = { maxFeePerGas: fees.maxFeePerGas * times, maxPriorityFeePerGas: fees.maxPriorityFeePerGas * times + 1n };
      if (bumped.maxFeePerGas > params.unstickMaxGasWei) {
        ctx.log(`[bot] nonce ${a.nonce} is stuck, and replacing it would cost ${gwei(bumped.maxFeePerGas)} gwei a gas, over the cap of ${gwei(params.unstickMaxGasWei)}: waiting`);
        continue;
      }
      const gas = ((await chain.estimateGas(null, ctx.signer.address)) * (BPS + BigInt(params.gasHeadroomBps))) / BPS;
      const id = db.addAction({ kind: "unstick", ref: String(a.id), mode: "live", status: "signed", detail: { replaces: a.tx_hash, nonce: a.nonce }, nonce: a.nonce, gasLimit: gas, maxFeeWei: bumped.maxFeePerGas });
      await ctx.signer.send({ call: null, gas, nonce: a.nonce, fees: bumped }, (h) => db.updateAction(id, { status: "sent", txHash: h })).catch((e) => {
        db.updateAction(id, { status: "failed", error: reason(e) });
        throw e;
      });
      ctx.log(`[bot] nonce ${a.nonce} was stuck for ${Math.round((ctx.now() - a.updated_at) / 1000)} s: replaced`);
    } catch (e) {
      ctx.log(`[bot] a stuck transaction could not be replaced: ${reason(e)}`);
    } finally {
      db.unlock("unstick");
    }
  }
  return open;
}

// ---------- 1. collect and split ----------

async function sweep(ctx: Ctx, head: Head): Promise<string> {
  const p = ctx.params;
  const t = head.timestamp;
  const st = actState(ctx, "sweep");
  if (ctx.now() < st.nextAt) return st.result;
  const last = Math.max(st.lastAt, ctx.db.splits(1)[0]?.at ?? 0);
  if (t < last + p.sweepEveryS) return say(ctx, "sweep", `the last sweep was ${t - last} s ago: not before ${p.sweepEveryS} s`);
  const call: CallSpec = { to: ctx.addr.splitter, abi: factorSplitterAbi as Abi, functionName: "sweep" };
  // what a sweep would split right now: the curve's fees, what the escrow holds, and anything unsplit
  const waiting = await ctx.chain.simulate<bigint>(call, ctx.facts.from!);
  if (waiting === 0n) return say(ctx, "sweep", "nothing is waiting", { fails: 0, nextAt: 0 });
  const [gas, fees] = await Promise.all([ctx.chain.estimateGas(call, ctx.facts.from!), ctx.chain.fees()]);
  // a sweep must move at least this many times its own gas, and never less than the set minimum
  const worth = gas * fees.maxFeePerGas * BigInt(p.sweepGasMultiple);
  const floor = p.minSweepWei > worth ? p.minSweepWei : worth;
  if (waiting < floor) return say(ctx, "sweep", `${eth(waiting)} ETH is waiting: under the minimum of ${eth(floor)} ETH`, { fails: 0, nextAt: 0 });
  const r = await attempt(ctx, "sweep", "", call, { waiting, minimum: floor }, p.maxGasWei, { gas, fees });
  if (r.status === "failed") return failed(ctx, "sweep", r.why, 60, p.sweepEveryS || 60);
  if (r.status === "skipped") return say(ctx, "sweep", r.why);
  if (r.status === "done") ctx.log(`[sweep] ${eth(waiting)} ETH collected and split: ${r.hash}`);
  return say(ctx, "sweep", `${r.status === "dry" ? "would sweep" : r.status === "sent" ? "sweeping" : "swept"} ${eth(waiting)} ETH`, { lastAt: t, fails: 0, nextAt: 0, tx: r.hash ?? st.tx });
}

// A credit in $FACTOR in Pons' escrow, or $FACTOR sitting in the splitter: all of it goes to the burn pot. Pons
// pays in ETH, so this is not expected; the call is made when there is something to claim and never otherwise.
async function claimToken(ctx: Ctx, head: Head): Promise<string> {
  const p = ctx.params;
  const token = ctx.facts.token;
  if (!token || !ctx.facts.escrow) return say(ctx, "claim_token", "no token yet");
  const st = actState(ctx, "claim_token");
  if (ctx.now() < st.nextAt) return st.result;
  const [credit, held] = await Promise.all([
    ctx.chain.read<bigint>({ to: ctx.facts.escrow, abi: ponsEscrowAbi as Abi, functionName: "balanceOfToken", args: [ctx.addr.splitter, token] }),
    ctx.chain.read<bigint>({ to: token, abi: factorTokenAbi as Abi, functionName: "balanceOf", args: [ctx.addr.splitter] }),
  ]);
  if (credit + held === 0n) return say(ctx, "claim_token", "no $FACTOR is waiting", { fails: 0, nextAt: 0 });
  if (head.timestamp < st.lastAt + p.sweepEveryS) return say(ctx, "claim_token", `${eth(credit + held)} $FACTOR is waiting: the last claim was under ${p.sweepEveryS} s ago`);
  const call: CallSpec = { to: ctx.addr.splitter, abi: factorSplitterAbi as Abi, functionName: "claimToken" };
  const r = await attempt(ctx, "claim_token", "", call, { credit, held }, p.maxGasWei);
  if (r.status === "failed") return failed(ctx, "claim_token", r.why, 60, p.sweepEveryS || 60);
  if (r.status === "skipped") return say(ctx, "claim_token", r.why);
  if (r.status === "done") ctx.log(`[claim_token] ${eth(credit + held)} $FACTOR sent to the burn pot: ${r.hash}`);
  return say(ctx, "claim_token", `${r.status === "dry" ? "would send" : "sent"} ${eth(credit + held)} $FACTOR to the burn pot`, { lastAt: head.timestamp, fails: 0, nextAt: 0, tx: r.hash ?? st.tx });
}

// ---------- 2. buy back and burn ----------

// The least $FACTOR a burn must buy, from a quote. `planned` is the ETH the pot means to spend; the quote is what
// spending `ethIn` of it bought. The contract holds a part-filled burn to the same price (the minimum scaled by
// what was really spent), so the minimum is always written for the whole planned amount.
export function minimumOut(planned: bigint, ethIn: bigint, bought: bigint, toleranceBps: number): bigint {
  if (planned <= 0n || ethIn <= 0n || bought <= 0n) return 0n;
  const forAll = ethIn >= planned ? bought : (bought * planned) / ethIn;
  return (forAll * (BPS - BigInt(toleranceBps))) / BPS;
}

async function burn(ctx: Ctx, head: Head): Promise<string> {
  const p = ctx.params;
  const t = head.timestamp;
  const token = ctx.facts.token;
  if (!token) return say(ctx, "burn", "no token yet");
  const st = actState(ctx, "burn");
  if (ctx.now() < st.nextAt) return st.result;
  const pot = { to: ctx.addr.burnPot, abi: factorBurnPotAbi as Abi };
  const [preview, held, balance] = await Promise.all([
    ctx.chain.read<readonly [bigint, bigint, boolean]>({ ...pot, functionName: "preview" }),
    ctx.chain.read<bigint>({ to: token, abi: factorTokenAbi as Abi, functionName: "balanceOf", args: [ctx.addr.burnPot] }),
    ctx.chain.balance(ctx.addr.burnPot),
  ]);
  const [planned, nextAt, ready] = preview;
  if (!ready) {
    if (planned === 0n) return say(ctx, "burn", "the pot holds nothing to burn", { fails: 0, nextAt: 0 });
    return say(ctx, "burn", `${eth(planned)} ETH waits for the next burn, allowed from ${new Date(Number(nextAt) * 1000).toISOString()}`, { fails: 0, nextAt: 0 });
  }
  if (ctx.mode !== "live" && st.lastAt > 0 && t < st.lastAt + DRY_REPEAT_S) return st.result;
  // The quote: the burn itself, run against the chain as it stands and not sent. It answers with the ETH it
  // spent and everything it burned, which is what it bought plus what the pot already held.
  let quote: readonly [bigint, bigint];
  try {
    quote = await ctx.chain.simulate<readonly [bigint, bigint]>({ ...pot, functionName: "burn", args: [0n] }, ctx.facts.from!);
  } catch (e) {
    if (!revertOf(e)) throw e;
    return failed(ctx, "burn", `no quote: ${reason(e)}`, p.burnRetryS, 1800);
  }
  const [ethIn, burned] = quote;
  const bought = burned - held;
  const minOut = minimumOut(planned, ethIn, bought, p.burnToleranceBps);
  // Never zero. A quote that buys nothing is no quote, and the burn is not sent on it.
  if (minOut <= 0n) return failed(ctx, "burn", `the quote bought nothing (${eth(ethIn)} ETH for ${bought} $FACTOR): no burn is sent without a minimum`, p.burnRetryS, 1800);
  // The pot's own cap. What it holds above what the market's depth allows, or what the pool's price limit
  // stopped short of, is not forced through: it waits for the following intervals, as the contract intends.
  const capped = balance > planned;
  const partFilled = ethIn < planned;
  const call: CallSpec = { ...pot, functionName: "burn", args: [minOut] };
  const r = await attempt(ctx, "burn", "", call, { potBalance: balance, planned, quoteEthIn: ethIn, quoteBought: bought, alreadyHeld: held, minTokensOut: minOut, toleranceBps: p.burnToleranceBps, capped, partFilled }, p.maxGasWei);
  if (r.status === "failed") return failed(ctx, "burn", r.why, p.burnRetryS, 1800);
  if (r.status === "skipped") return say(ctx, "burn", r.why);
  const rest = capped ? `; ${eth(balance - planned)} ETH more waits for the following intervals (the pot's cap)` : partFilled ? "; the pool's price limit stopped it short, the rest waits" : "";
  if (r.status === "done") ctx.log(`[burn] ${eth(ethIn)} ETH buys and burns $FACTOR, at least ${eth(minOut)}${rest}: ${r.hash}`);
  return say(ctx, "burn", `${r.status === "dry" ? "would burn" : r.status === "sent" ? "burning" : "burned"} with ${eth(ethIn)} ETH, minimum ${eth(minOut)} $FACTOR${rest}`, { lastAt: t, fails: 0, nextAt: 0, tx: r.hash ?? st.tx });
}

// ---------- 3. close the jobs that are due ----------

// A job whose last attempt failed is left alone for a while, longer each time, so that one job that cannot be
// closed neither holds up the others nor spends the gas wallet.
const JOB_RETRY_S = 300;
const JOB_RETRY_MAX_S = 6 * 3600;

async function closeJobs(ctx: Ctx, head: Head, kind: "settle_job" | "refund_job"): Promise<string> {
  const p = ctx.params;
  const st = actState(ctx, kind);
  if (ctx.now() < st.nextAt) return st.result;
  const store = new DeskStore(ctx.db);
  const settling = kind === "settle_job";
  const due = settling ? store.dueToSettle(head.timestamp, 50) : store.dueToRefund(head.timestamp, 50);
  if (due.length === 0) return say(ctx, kind, settling ? "no delivered job is past its customer's day" : "no job is past its due time and its grace", { fails: 0, nextAt: 0 });
  let closed = 0;
  let shown = 0;
  let left = 0;
  let note = "";
  let tx = st.tx;
  for (const j of due) {
    if (closed + shown >= p.jobsPerPass || ctx.stopping()) {
      left++;
      continue;
    }
    const ref = String(j.id);
    const prev = ctx.db.lastAction(kind, ref);
    if (prev) {
      if (prev.status === "signed" || prev.status === "sent") {
        left++;
        continue;
      }
      if (prev.status === "done") {
        // sent and mined, and the engine's copy still says it is due: read the job again
        await rereadJob(ctx, j.id);
        continue;
      }
      const waitS = Math.min(JOB_RETRY_S * 2 ** Math.min(ctx.db.failsInARow(kind, ref) - 1, 12), JOB_RETRY_MAX_S);
      if ((prev.status === "failed" && ctx.now() - prev.updated_at < waitS * 1000) || (prev.status === "dry" && ctx.now() - prev.created_at < DRY_REPEAT_S * 1000)) {
        left++;
        continue;
      }
    }
    const call: CallSpec = { to: ctx.addr.desk, abi: factorDeskAbi as Abi, functionName: settling ? "settle" : "refund", args: [BigInt(j.id)] };
    const r = await attempt(ctx, kind, ref, call, { job: j.id, agent: j.agent, customer: j.customer, price: j.price, fromPool: j.from_pool, early: j.early }, p.maxGasWei);
    if (r.status === "done") {
      closed++;
      tx = r.hash ?? tx;
      ctx.log(`[${kind}] job ${j.id} ${settling ? "settled: the agent is paid" : "refunded to its customer"}: ${r.hash}`);
      await rereadJob(ctx, j.id);
    } else if (r.status === "dry") shown++;
    else if (r.status === "failed") {
      // most often somebody else closed it in the meantime: the job is read again, and if it is still due it is
      // tried again later
      ctx.log(`[${kind}] job ${j.id}: ${r.why}`);
      note = `job ${j.id}: ${r.why}`;
      await rereadJob(ctx, j.id);
    } else {
      // skipped (gas over its cap, the gas wallet busy) or on its way: nothing more goes out this pass
      note = r.why;
      left++;
      break;
    }
  }
  const did = ctx.mode === "live" ? `${closed} ${settling ? "settled" : "refunded"}` : `would ${settling ? "settle" : "refund"} ${shown}`;
  return say(ctx, kind, `${did}${left ? `, ${left} more waiting` : ""}${note ? ` (${note})` : ""}`, { lastAt: closed + shown > 0 ? head.timestamp : st.lastAt, fails: 0, nextAt: 0, tx });
}

const settleJobs = (ctx: Ctx, head: Head) => closeJobs(ctx, head, "settle_job");
const refundJobs = (ctx: Ctx, head: Head) => closeJobs(ctx, head, "refund_job");

// ---------- 4. an advance fee the burn pot was not sent ----------

// The desk pushes each advance fee to the burn pot as the advance is drawn. A push that did not go through waits
// in the desk under the burn pot's name; collect(burnPot) delivers it, and can only deliver it there.
async function collect(ctx: Ctx, head: Head): Promise<string> {
  const st = actState(ctx, "collect");
  if (ctx.now() < st.nextAt) return st.result;
  const desk = { to: ctx.addr.desk, abi: factorDeskAbi as Abi };
  const owed = await ctx.chain.read<bigint>({ ...desk, functionName: "owed", args: [ctx.addr.burnPot] });
  if (owed === 0n) return say(ctx, "collect", "nothing waits in the desk for the burn pot", { fails: 0, nextAt: 0 });
  if (ctx.mode !== "live" && st.lastAt > 0 && head.timestamp < st.lastAt + DRY_REPEAT_S) return st.result;
  const r = await attempt(ctx, "collect", "", { ...desk, functionName: "collect", args: [ctx.addr.burnPot] }, { owed }, ctx.params.maxGasWei);
  if (r.status === "failed") return failed(ctx, "collect", r.why, 300, 3600);
  if (r.status === "skipped") return say(ctx, "collect", r.why);
  if (r.status === "done") ctx.log(`[collect] ${eth(owed)} ETH of advance fees delivered to the burn pot: ${r.hash}`);
  return say(ctx, "collect", `${r.status === "dry" ? "would deliver" : "delivered"} ${eth(owed)} ETH to the burn pot`, { lastAt: head.timestamp, fails: 0, nextAt: 0, tx: r.hash ?? st.tx });
}

// ---------- 4b. a share the splitter could not deliver ----------

async function retrySplit(ctx: Ctx, head: Head): Promise<string> {
  const st = actState(ctx, "retry_split");
  if (ctx.now() < st.nextAt) return st.result;
  const s = snapshotOf(ctx.db)?.splitter;
  const waiting = s ? BigInt(s.adminPending) + BigInt(s.burnPending) + BigInt(s.poolPending ?? "0") : 0n;
  if (waiting === 0n) {
    if (ctx.db.get("retry_split:waiting") !== null) ctx.db.unset("retry_split:waiting");
    return say(ctx, "retry_split", "every share the splitter split was delivered", { fails: 0, nextAt: 0 });
  }
  if (ctx.mode !== "live" && st.lastAt > 0 && head.timestamp < st.lastAt + DRY_REPEAT_S) return st.result;
  // Tried at most every ten minutes, and only every six hours once a try delivered nothing: a share its
  // destination keeps refusing stays where it is, and costs next to no gas.
  const before = ctx.db.get("retry_split:waiting");
  const stuck = before !== null && waiting >= BigInt(before);
  if (st.lastAt > 0 && head.timestamp < st.lastAt + (stuck ? 6 * 3600 : 600)) return st.result;
  const r = await attempt(ctx, "retry_split", "", { to: ctx.addr.splitter, abi: factorSplitterAbi as Abi, functionName: "retry" }, { waiting }, ctx.params.maxGasWei);
  if (r.status === "failed") return failed(ctx, "retry_split", r.why, 600, 6 * 3600);
  if (r.status === "skipped") return say(ctx, "retry_split", r.why);
  if (r.status === "done") {
    ctx.db.set("retry_split:waiting", waiting.toString());
    ctx.log(`[retry_split] the splitter was asked again to deliver ${eth(waiting)} ETH it was holding: ${r.hash}`);
  }
  return say(ctx, "retry_split", `${r.status === "dry" ? "would deliver" : "sent on"} ${eth(waiting)} ETH the splitter was holding`, { lastAt: head.timestamp, fails: 0, nextAt: 0, tx: r.hash ?? st.tx });
}

// ---------- 5. compute credit nobody spent goes back to the pool ----------

// A compute advance on a job that was then refunded was never repaid by the job. Whatever of it was not spent on
// models is still ETH in the gateway's wallet, which is this wallet: it is sent to the desk, where ETH that arrives
// is the pool. Lots are sent together, and marked only once the transaction is mined.
async function returnCompute(ctx: Ctx, head: Head): Promise<string> {
  const p = ctx.params;
  const st = actState(ctx, "return_compute");
  if (ctx.now() < st.nextAt) return st.result;
  const store = new ComputeStore(ctx.db);
  // one that was sent on an earlier pass and not seen mined then: it is looked up before anything else is sent
  const pending = ctx.db.getJson<{ hash: string; lots: { tx_hash: string; log_index: number }[] }>("return_compute:pending");
  if (pending) {
    const r = await ctx.chain.receipt(pending.hash);
    if (r?.ok) store.sentBack(pending.lots, pending.hash);
    else if (!r && ctx.db.openActions().some((a) => a.tx_hash === pending.hash)) return say(ctx, "return_compute", "the ETH going back to the pool is on its way");
    ctx.db.unset("return_compute:pending");
  }
  const owed = store.owedToPool();
  if (owed.wei === 0n) return say(ctx, "return_compute", "no unspent compute credit is waiting to go back to the pool", { fails: 0, nextAt: 0 });
  // only the gateway's own wallet holds that ETH: with another wallet's key there is nothing to send it from
  if (ctx.facts.gateway && ctx.facts.bot && ctx.facts.gateway !== ctx.facts.bot) return say(ctx, "return_compute", `${eth(owed.wei)} ETH of unspent compute credit is owed to the pool, and the gas wallet is not the desk's gateway (${ctx.facts.gateway}): its owner sends it to the desk by hand`);
  if (ctx.mode !== "live" && st.lastAt > 0 && head.timestamp < st.lastAt + DRY_REPEAT_S) return st.result;
  const from = ctx.facts.from;
  if (!from) return say(ctx, "return_compute", "the gas wallet's address is not known yet");
  if (!ctx.db.lock("return_compute", p.lockMs)) return say(ctx, "return_compute", "another attempt holds the lock");
  try {
    const pay: Pay = { to: ctx.addr.desk, value: owed.wei };
    const [estimate, fees] = await Promise.all([ctx.chain.estimateGas(null, from, pay), ctx.chain.fees()]);
    const gas = (estimate * (BPS + BigInt(p.gasHeadroomBps))) / BPS;
    if (gas > p.gasCaps.return_compute) return failed(ctx, "return_compute", `it would need ${gas} gas, over the cap of ${p.gasCaps.return_compute}`, 600, 6 * 3600);
    if (fees.maxFeePerGas > p.maxGasWei) return say(ctx, "return_compute", `gas is at ${gwei(fees.maxFeePerGas)} gwei, over the cap of ${gwei(p.maxGasWei)}: waiting for it to fall`);
    const detail = text({ toPool: owed.wei, lots: owed.lots.length, gasLimit: gas, maxFeePerGas: fees.maxFeePerGas });
    if (ctx.mode !== "live" || !ctx.signer) {
      ctx.db.addAction({ kind: "return_compute", mode: "dry", status: "dry", detail, gasLimit: gas, maxFeeWei: fees.maxFeePerGas });
      ctx.log(`[dry] would send ${eth(owed.wei)} ETH of unspent compute credit back to the pool`);
      return say(ctx, "return_compute", `would send ${eth(owed.wei)} ETH back to the pool`, { lastAt: head.timestamp, fails: 0, nextAt: 0 });
    }
    const r = await dispatch(ctx, "return_compute", "", { pay }, gas, fees, detail);
    if (r.status === "failed") return failed(ctx, "return_compute", r.why, 600, 6 * 3600);
    if (r.status === "skipped") return say(ctx, "return_compute", r.why);
    if (r.status === "done") {
      store.sentBack(owed.lots, r.hash!);
      ctx.log(`[return_compute] ${eth(owed.wei)} ETH of unspent compute credit sent back to the pool: ${r.hash}`);
      return say(ctx, "return_compute", `sent ${eth(owed.wei)} ETH back to the pool`, { lastAt: head.timestamp, fails: 0, nextAt: 0, tx: r.hash ?? st.tx });
    }
    // on its way: the lots are marked when its receipt is seen (settle(), below, calls landed())
    ctx.db.setJson("return_compute:pending", { hash: r.hash, lots: owed.lots });
    return say(ctx, "return_compute", `sending ${eth(owed.wei)} ETH back to the pool`, { lastAt: head.timestamp, tx: r.hash ?? st.tx });
  } finally {
    ctx.db.unlock("return_compute");
  }
}

// ---------- one pass ----------

export interface ActResult {
  open: number; // transactions of the bot's still on their way
  said: Partial<Record<SendKind, string>>;
}

// ---------- 6. orders of accounts without a wallet ----------

// Each is one call the gas wallet makes: the maker of accounts making one, or an account carrying out what its
// owner signed. An order was tried whole when it was taken; it is tried again here, as the wallet that sends it,
// because the chain may have moved. A few a pass, oldest first, and none while another is on its way.
async function relay(ctx: Ctx, head: Head): Promise<string> {
  const cfg = ctx.accounts;
  const factory = ctx.addr.accounts;
  // with no maker of accounts there is nothing to send to. Strangers' orders are taken only while accounts are
  // switched on (../accounts.ts); the engine's own agents queue theirs either way.
  if (!cfg || !factory) return say(ctx, "relay", "there is no maker of accounts", { fails: 0, nextAt: 0 });
  const store = new AccountStore(ctx.db);
  const waiting = store.queued(cfg.perPass);
  if (waiting.length === 0) return say(ctx, "relay", "no order is waiting", { fails: 0, nextAt: 0 });
  if (ctx.mode !== "live" || !ctx.signer) {
    for (const r of waiting) store.mark(r.id, { status: "failed", error: "the engine is not sending transactions right now" });
    return say(ctx, "relay", `${waiting.length} order(s) turned away: the engine is not sending`);
  }
  let done = 0;
  let last = "";
  for (const r of waiting) {
    if (ctx.stopping()) break;
    if (r.kind === "execute" && r.deadline <= head.timestamp) {
      store.mark(r.id, { status: "failed", error: "the order's time ran out before it could be sent: sign it again" });
      continue;
    }
    if (store.gasToday() >= cfg.gasDayWei) {
      store.mark(r.id, { status: "failed", error: "Factor has paid all the gas it pays for accounts today" });
      continue;
    }
    const call = callOfRelay(r, factory);
    const o = await attempt(ctx, "relay", r.id, call, { account: r.account, what: r.kind }, ctx.params.maxGasWei);
    if (o.status === "done" && o.receipt && o.hash) {
      landedRelay(store, r, o.receipt, o.hash);
      done++;
      last = o.hash;
      continue;
    }
    if (o.status === "sent" && o.hash) {
      store.mark(r.id, { status: "sent", tx_hash: o.hash });
      return say(ctx, "relay", `${done} sent and mined, one on its way`, { lastAt: head.timestamp, tx: o.hash });
    }
    if (o.status === "failed") {
      if (o.receipt && o.hash) landedRelay(store, r, o.receipt, o.hash);
      else store.mark(r.id, { status: "failed", error: o.why });
      continue;
    }
    // skipped (the wallet is busy, or gas is over the cap): it stays in the queue for the next pass
    return say(ctx, "relay", `${done} sent and mined; waiting: ${o.why}`);
  }
  const left = store.queued(1).length;
  return say(ctx, "relay", `${done} sent and mined${left ? ", more waiting" : ""}`, { lastAt: head.timestamp, fails: 0, nextAt: 0, ...(last ? { tx: last } : {}) });
}

// ---------- 7. the gas wallet's surplus goes on to the owner ----------

async function skim(ctx: Ctx, head: Head): Promise<string> {
  const p = ctx.params;
  const st = actState(ctx, "skim");
  const to = ctx.addr.skimTo;
  if (!to) return say(ctx, "skim", "no wallet is named for the gas wallet's surplus (ENGINE_SKIM_TO): it stays where it is", { fails: 0, nextAt: 0 });
  if (ctx.now() < st.nextAt) return st.result;
  // looked at once an hour: this is housekeeping, not something anybody waits for
  if (st.lastAt > 0 && head.timestamp < st.lastAt + 3600) return st.result;
  const from = ctx.facts.bot;
  if (!from) return say(ctx, "skim", "the gas wallet's address is not known yet");
  if (to === from) return say(ctx, "skim", "ENGINE_SKIM_TO is the gas wallet itself: there is nowhere to send to");
  const store = new ComputeStore(ctx.db);
  // what it keeps: gas money, what still backs credit whose job could yet be refunded, and what is owed to the pool
  const keep = p.skimKeepWei + store.backingWei() + store.owedToPool().wei;
  const balance = await ctx.chain.balance(from);
  const surplus = balance > keep ? balance - keep : 0n;
  if (surplus < p.skimMinWei) return say(ctx, "skim", `the gas wallet holds ${eth(balance)} ETH and keeps ${eth(keep)}: nothing worth sending on`, { lastAt: head.timestamp, fails: 0, nextAt: 0 });
  if (!ctx.db.lock("skim", p.lockMs)) return say(ctx, "skim", "another attempt holds the lock");
  try {
    const pay: Pay = { to, value: surplus };
    const [estimate, fees] = await Promise.all([ctx.chain.estimateGas(null, from, pay), ctx.chain.fees()]);
    const gas = (estimate * (BPS + BigInt(p.gasHeadroomBps))) / BPS;
    if (gas > p.gasCaps.skim) return failed(ctx, "skim", `it would need ${gas} gas, over the cap of ${p.gasCaps.skim}: is ENGINE_SKIM_TO a plain wallet?`, 3600, 24 * 3600);
    if (fees.maxFeePerGas > p.maxGasWei) return say(ctx, "skim", `gas is at ${gwei(fees.maxFeePerGas)} gwei, over the cap of ${gwei(p.maxGasWei)}: waiting for it to fall`);
    const detail = text({ to, surplus, kept: keep, gasLimit: gas, maxFeePerGas: fees.maxFeePerGas });
    if (ctx.mode !== "live" || !ctx.signer) {
      ctx.db.addAction({ kind: "skim", mode: "dry", status: "dry", detail, gasLimit: gas, maxFeeWei: fees.maxFeePerGas });
      ctx.log(`[dry] would send ${eth(surplus)} ETH of the gas wallet's surplus on to ${to}`);
      return say(ctx, "skim", `would send ${eth(surplus)} ETH on to ${to}`, { lastAt: head.timestamp, fails: 0, nextAt: 0 });
    }
    const r = await dispatch(ctx, "skim", "", { pay }, gas, fees, detail);
    if (r.status === "failed") return failed(ctx, "skim", r.why, 3600, 24 * 3600);
    if (r.status === "skipped") return say(ctx, "skim", r.why);
    ctx.log(`[skim] ${eth(surplus)} ETH of the gas wallet's surplus sent on to ${to}: ${r.hash}`);
    return say(ctx, "skim", `sent ${eth(surplus)} ETH on to ${to}`, { lastAt: head.timestamp, fails: 0, nextAt: 0, tx: r.hash ?? st.tx });
  } finally {
    ctx.db.unlock("skim");
  }
}

const STEPS: [SendKind, (ctx: Ctx, head: Head) => Promise<string>][] = [
  ["relay", relay],
  ["sweep", sweep],
  ["retry_split", retrySplit],
  ["claim_token", claimToken],
  ["burn", burn],
  ["settle_job", settleJobs],
  ["refund_job", refundJobs],
  ["collect", collect],
  ["return_compute", returnCompute],
  ["skim", skim],
];

// One pass over the actions, one after the other: there is one gas wallet, and one transaction at a time.
// An action that goes wrong is said, backed off, and does not hold up the ones after it; the node turning the
// pass away (403, 429) ends it, and the loop waits longer before the next.
export async function actPass(ctx: Ctx): Promise<ActResult> {
  const out: ActResult = { open: 0, said: {} };
  if (ctx.mode !== "dry" && ctx.mode !== "live") return out;
  // the owner stopped everything the gas wallet sends (../switches.ts). What is already on its way is still
  // followed to its end, so nothing is left half written.
  if (stopped(ctx.db, "keeper")) {
    out.open = await settle(ctx);
    return out;
  }
  const head = await ctx.chain.head();
  out.open = await settle(ctx);
  if (!ctx.facts.from || !snapshotOf(ctx.db)) return out; // the first reading of the chain has not been made yet
  if (out.open > 0) return out;
  for (const [kind, step] of STEPS) {
    if (ctx.stopping()) break;
    try {
      out.said[kind] = await step(ctx, head);
    } catch (e) {
      if (nodeBusy(e)) throw e;
      out.said[kind] = failed(ctx, kind, reason(e), 30, 600);
    }
    // something of the bot's is on its way now: the rest waits for the next pass
    if (ctx.db.openActions().length > 0) {
      out.open = ctx.db.openActions().length;
      break;
    }
  }
  return out;
}
