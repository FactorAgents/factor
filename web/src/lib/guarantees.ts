// Guarantees, as a visitor's wallet sends them (contracts/src/FactorGuarantee.sol): a customer hires with cover
// (reserve the cover, lock the job, tie the two), an agent adds to its guarantee bond, sets its offer and takes out what
// is free, and anyone ties a reservation or closes a covered job. Amounts are wei, always.
//
// Every call is tried first without being sent: a call the contract would refuse never reaches the wallet, and the
// visitor is told why in plain words. A hire with cover is tried whole (the reservation and the lock) before anything
// is sent, so a customer never locks a job whose cover would then fail.
import { decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeFunctionData, formatEther, type Abi, type Hex } from "viem";
import { factorDeskAbi } from "./abi/FactorDesk";
import { factorGuaranteeAbi } from "./abi/FactorGuarantee";
import { explain as deskExplain, lockedJob, Refusal, wordsFor, type Sent } from "./desk";
import { declined, ensureChain, ethCall, sendTx, waitFor, type Provider, type Receipt } from "./wallet";

export const GUARANTEE_ABI = factorGuaranteeAbi as Abi;
const DESK = factorDeskAbi as Abi;
const ALL = [...GUARANTEE_ABI, ...DESK].filter((x) => x.type === "error") as Abi;

const eth = (wei: unknown): string => {
  const s = formatEther(BigInt(String(wei)));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};
const when = (s: unknown): string => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const STATE_WORD = ["no cover", "reserved", "tied to its job", "released", "paid", "declined", "lapsed"];

// The guarantee contract's own refusals, in plain words. The desk's are said by lib/desk.ts.
const WORDS: Record<string, (a: readonly unknown[]) => string> = {
  NotRegistered: () => "That agent has not registered on the desk.",
  NotAgent: () => "Only the agent's own wallet (or the key of its line account) runs its guarantee. Connect that wallet.",
  SelfCover: () => "An agent cannot buy cover on its own job.",
  TooSmall: (a) => `The smallest cover is ${eth(a[0])} ETH.`,
  JobTooSmall: (a) => `The smallest job is ${eth(a[0])} ETH.`,
  BadDueTime: () => "The due time must be between 1 hour and 30 days from now.",
  OverLimit: (a) => (BigInt(String(a[0])) === 0n ? "This agent sells no cover on this job right now: its score, its offer or its free bond allows none." : `This agent can cover up to ${eth(a[0])} ETH of this job right now.`),
  WrongFee: (a) => `The fee for this cover is ${eth(a[0])} ETH.`,
  OverFree: (a) => (BigInt(String(a[0])) === 0n ? "Nothing in the bond is free: all of it backs covers that have not ended." : `${eth(a[0])} ETH of the bond is free. The rest backs covers that have not ended.`),
  WrongState: (a) => `This cover is ${STATE_WORD[Number(a[0])] ?? "not open"}.`,
  Expired: (a) => `The hour to tie this cover ended ${when(a[0])}. It lapses, and its cover goes back to the agent's bond.`,
  TooSoon: (a) => `Not before ${when(a[0])}.`,
  NotTheJob: () => "That job is not the one this cover was reserved for: same customer, agent, price, due time and early switch, locked after the reservation.",
  JobCovered: () => "That job has its cover already.",
  NoCover: () => "That job has no cover.",
  NotFinished: () => "The job is not finished on the desk yet. The cover ends when it is.",
  NothingOwed: () => "Nothing is waiting to be collected.",
  ZeroAmount: () => "Enter an amount.",
  GasShort: () => "The wallet sent it with too little gas. Try again.",
};

/** What a failed guarantee call was, in words. */
export function explainGuarantee(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (declined(e)) return "You declined it in your wallet. Nothing was sent.";
  const err = e as { data?: unknown; error?: { data?: unknown }; cause?: { data?: unknown } };
  for (const d of [err.data, err.error?.data, err.cause?.data, (err.data as { data?: unknown } | undefined)?.data, (err.data as { originalError?: { data?: unknown } } | undefined)?.originalError?.data]) {
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
      try {
        const r = decodeErrorResult({ abi: ALL, data: d as Hex });
        const args = (r.args ?? []) as readonly unknown[];
        return WORDS[r.errorName]?.(args) ?? wordsFor(r.errorName, args) ?? `The contract refuses it: ${r.errorName}.`;
      } catch {
        // not one of these
      }
    }
  }
  return deskExplain(e);
}

/** The fee on a cover, as the contract takes it: 1% of it. Half buys back and burns $FACTOR, the rest goes to the agent. */
export const feeFor = (cover: bigint): bigint => (cover * 100n) / 10_000n;

async function haveCode(p: Provider, to: string, what: string): Promise<void> {
  const code = await p.request({ method: "eth_getCode", params: [to, "latest"] }).catch(() => null);
  if (typeof code !== "string" || code.length <= 2) throw new Refusal(`Your wallet does not see ${what} on the chain it is on. Nothing was sent. Check that the wallet is on Robinhood Chain.`);
}

/** One call to the guarantee contract: tried without sending, sent, followed until it is mined. */
export async function sendGuarantee(p: Provider, o: { guarantee: string; from: string; fn: string; args?: readonly unknown[]; value?: bigint; on?: (step: "checking" | "wallet" | "mining") => void }): Promise<Sent> {
  o.on?.("checking");
  await ensureChain(p);
  await haveCode(p, o.guarantee, "the guarantee contract");
  const data = encodeFunctionData({ abi: GUARANTEE_ABI, functionName: o.fn, args: o.args ?? [] });
  try {
    await ethCall(p, o.guarantee, data, o.from, o.value);
  } catch (e) {
    throw new Refusal(explainGuarantee(e));
  }
  o.on?.("wallet");
  let hash: string;
  try {
    hash = await sendTx(p, { from: o.from, to: o.guarantee, data, value: o.value });
  } catch (e) {
    throw new Refusal(explainGuarantee(e));
  }
  o.on?.("mining");
  const receipt = await waitFor(p, hash);
  if (receipt.status !== "0x1") throw new Refusal(receipt.reason ?? "The transaction was mined and refused. Nothing changed. Reload the page and look again.");
  return { hash: receipt.transactionHash || hash, receipt };
}

/** The most cover a job of `price` can have with `agent` right now, read from the contract. */
export async function coverLimit(p: Provider, guarantee: string, agent: string, price: bigint): Promise<bigint> {
  const data = await ethCall(p, guarantee, encodeFunctionData({ abi: GUARANTEE_ABI, functionName: "coverLimit", args: [agent, price] }));
  return decodeFunctionResult({ abi: GUARANTEE_ABI, functionName: "coverLimit", data: data as Hex }) as bigint;
}

/** The number the contract gave a reservation, read from the transaction that made it. */
function reservedCover(receipt: Receipt, guarantee: string): number | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== guarantee.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: GUARANTEE_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      if (d.eventName === "Reserved") return Number((d.args as unknown as { id: bigint }).id);
    } catch {
      // another event
    }
  }
  return null;
}

export type HireStep = "checking" | "wallet" | "mining" | "reserving" | "locking" | "tying";

/**
 * Hire with cover: reserve the cover, lock the job on exactly those terms, and tie the two. Everything is tried first:
 * the reservation and the lock, so nothing is sent unless both would go through. An account without a wallet sends
 * all three in one order (all of it or none). A wallet sends three transactions, the reservation first: nothing can be
 * taken away from a cover once it is reserved, and the tie is made by Factor too if it is not sent.
 */
export async function hireWithCover(p: Provider, o: { passkey: boolean; guarantee: string; desk: string; from: string; agent: string; price: bigint; dueAt: number; early: boolean; cover: bigint; on: (step: HireStep) => void; /** plain ETH sent beside it (a month's share to the burn pot): in the same order, or after the tie */ extra?: { to: string; value: bigint }[] }): Promise<{ job: number | null; coverId: number | null; lockTx: string; tied: boolean; note?: string; extraTx: string | null }> {
  o.on("checking");
  await ensureChain(p);
  await haveCode(p, o.guarantee, "the guarantee contract");
  await haveCode(p, o.desk, "the desk");
  const limit = await coverLimit(p, o.guarantee, o.agent, o.price);
  if (o.cover > limit) throw new Refusal(limit === 0n ? "This agent sells no cover on this job right now: its score, its offer or its free bond allows none." : `This agent can cover up to ${eth(limit)} ETH of this job right now.`);
  const fee = feeFor(o.cover);
  const reserveData = encodeFunctionData({ abi: GUARANTEE_ABI, functionName: "reserve", args: [o.agent, o.price, BigInt(o.dueAt), o.early, o.cover] });
  const lockData = encodeFunctionData({ abi: DESK, functionName: "lock", args: [o.agent, BigInt(o.dueAt), o.early] });
  const tieData = encodeFunctionData({ abi: GUARANTEE_ABI, functionName: "bindLatest", args: [] });
  try {
    await ethCall(p, o.guarantee, reserveData, o.from, fee);
  } catch (e) {
    throw new Refusal(explainGuarantee(e));
  }
  try {
    await ethCall(p, o.desk, lockData, o.from, o.price);
  } catch (e) {
    throw new Refusal(deskExplain(e));
  }
  if (o.passkey) {
    o.on("wallet");
    const extra = (o.extra ?? []).filter((x) => x.value > 0n).map((x) => ({ to: x.to, value: x.value.toString(), data: "0x" }));
    const id = (await p.request({ method: "factor_sendCalls", params: [{ to: o.guarantee, value: fee.toString(), data: reserveData }, { to: o.desk, value: o.price.toString(), data: lockData }, { to: o.guarantee, value: "0", data: tieData }, ...extra] })) as string;
    o.on("mining");
    const receipt = await waitFor(p, id);
    if (receipt.status !== "0x1") throw new Refusal(receipt.reason ?? "The order was mined and refused. Nothing changed: no cover was reserved and no job was locked.");
    return { job: lockedJob(receipt, o.desk), coverId: reservedCover(receipt, o.guarantee), lockTx: receipt.transactionHash, tied: true, extraTx: extra.length ? receipt.transactionHash : null };
  }
  // a wallet: the reservation, then the lock, then the tie
  o.on("reserving");
  let hash: string;
  try {
    hash = await sendTx(p, { from: o.from, to: o.guarantee, data: reserveData, value: fee });
  } catch (e) {
    throw new Refusal(explainGuarantee(e));
  }
  const r1 = await waitFor(p, hash);
  if (r1.status !== "0x1") throw new Refusal(r1.reason ?? "The reservation was mined and refused. Nothing changed, and no job was locked.");
  const coverId = reservedCover(r1, o.guarantee);
  o.on("locking");
  let lockHash: string;
  try {
    lockHash = await sendTx(p, { from: o.from, to: o.desk, data: lockData, value: o.price });
  } catch (e) {
    throw new Refusal(`The cover is reserved for an hour, and nothing is locked yet. ${explainGuarantee(e)} Lock the job within the hour on the same terms to use the cover; past it, the reservation lapses and its fee is not returned.`);
  }
  const r2 = await waitFor(p, lockHash);
  if (r2.status !== "0x1") throw new Refusal(r2.reason ?? "The lock was mined and refused. The cover is reserved for an hour; nothing else changed.");
  const job = lockedJob(r2, o.desk);
  o.on("tying");
  let tied = false;
  try {
    const tie = encodeFunctionData({ abi: GUARANTEE_ABI, functionName: "bind", args: [BigInt(coverId ?? 0), BigInt(job ?? 0)] });
    await ethCall(p, o.guarantee, tie, o.from);
    tied = (await waitFor(p, await sendTx(p, { from: o.from, to: o.guarantee, data: tie }))).status === "0x1";
  } catch {
    // Factor ties it within the hour
  }
  // what goes beside it (a month's share to the burn pot): after the job is locked, so it never stands in the job's way
  let extraTx: string | null = null;
  for (const x of (o.extra ?? []).filter((e) => e.value > 0n)) {
    try {
      o.on("wallet");
      const h = await sendTx(p, { from: o.from, to: x.to, data: "0x", value: x.value });
      o.on("mining");
      if ((await waitFor(p, h)).status === "0x1") extraTx = h;
    } catch {
      // the job and its cover stand without it
    }
  }
  return { job, coverId, lockTx: r2.transactionHash || lockHash, tied, extraTx, ...(tied ? {} : { note: "The cover is not tied to the job yet: Factor ties it within the hour, or tie it on the job's page." }) };
}
