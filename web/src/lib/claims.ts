// Selling locked pay, as a visitor's wallet sends it (contracts/src/FactorClaims.sol): an agent opens its pay account
// (its desk address when it sells its pay), lists the claim on one of the account's jobs at most 10% under its face,
// and takes a listing off sale; a buyer buys a listed claim by sending its price, which goes straight to the seller;
// anyone settles a claim whose job has ended. Amounts are wei, always.
//
// Every call is tried first without being sent: a call the contract would refuse never reaches the wallet, and the
// visitor is told why in plain words. The figures shown on pages (lib/types.ts ClaimView) come from the engine.
import { decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeFunctionData, formatEther, type Abi, type Hex } from "viem";
import { factorClaimsAbi } from "./abi/FactorClaims";
import { explain as deskExplain, Refusal, wordsFor, type Sent } from "./desk";
import { declined, ensureChain, ethCall, sendTx, waitFor, type Provider, type Receipt } from "./wallet";
import type { ClaimState, ClaimView } from "./types";

export const CLAIMS_ABI = factorClaimsAbi as Abi;
const ERRORS = CLAIMS_ABI.filter((x) => x.type === "error") as Abi;

/** Wei as the engine gives it (a string or a number of wei), in ETH as a number, for showing. */
export const weiEth = (w: unknown): number => {
  if (w === null || w === undefined || w === "") return 0;
  const s = String(w);
  if (/^\d+$/.test(s)) return Number(formatEther(BigInt(s)));
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
/** Wei as a whole number, for sending. */
export const weiOf = (w: unknown): bigint => (/^\d+$/.test(String(w ?? "")) ? BigInt(String(w)) : 0n);
/** Unix seconds (or an ISO time) as an ISO time. */
export const iso = (t: unknown): string | null => {
  if (t === null || t === undefined || t === "" || t === 0 || t === "0") return null;
  if (typeof t === "string" && /\D/.test(t)) return t;
  return new Date(Number(t) * 1000).toISOString();
};
const eth = (wei: unknown): string => {
  const s = formatEther(BigInt(String(wei)));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};

export const CLAIM_WORD: Record<ClaimState, string> = { listed: "For sale", sold: "Sold", paid: "Paid", closed: "Off sale" };
const STATE_WORD = ["no claim", "for sale", "sold", "paid", "off sale"];

// The claims contract's own refusals, in plain words. The desk's are said by lib/desk.ts.
const WORDS: Record<string, (a: readonly unknown[]) => string> = {
  HasAccount: (a) => `This wallet already has its pay account, ${String(a[0])}.`,
  NoAccount: () => "This wallet has no pay account yet. Open one first.",
  NotYourJob: () => "That job is not locked for this wallet's pay account. Only jobs a customer locked for the pay account can be sold.",
  NotForSale: () => "That job cannot be sold now: it must be locked, advanced or delivered, before its due time, or in its customer's review time.",
  Taken: (a) => `Claim ${String(a[0])} is already listed or sold on that job. One claim per job.`,
  TooMany: () => "This pay account has ten claims listed or sold that have not ended: the most at once.",
  TooSmall: (a) => `A claim's face must be at least ${eth(a[0])} ETH.`,
  BadPrice: (a) => `The price must be between ${eth(a[0])} and ${eth(a[1])} ETH: at most a tenth under the face.`,
  WrongState: (a) => `This claim is ${STATE_WORD[Number(a[0])] ?? "not open"}.`,
  NotSeller: () => "Only the wallet that runs the pay account can take its claim off sale. Connect that wallet.",
  NotHolder: () => "Only the claim's holder can hand it on.",
  WrongAmount: (a) => `The price of this claim is ${eth(a[0])} ETH.`,
  OwnClaim: () => "An agent cannot buy its own claim.",
  Changed: () => "The job changed since the claim was listed. Reload the page.",
  Owes: (a) => `This pay account owes a holder ${eth(a[0])} ETH from an earlier claim. It pays that first.`,
  HasClaim: (a) => `Claim ${String(a[0])} is listed or sold on that job: it cannot be declined or drawn on while it stands.`,
  NotEnded: () => "The job has not ended yet, so the claim cannot be settled.",
  NotFree: (a) => `The pay account holds ${eth(a[0])} ETH.`,
  NothingOwed: () => "Nothing is waiting to be collected.",
  GasShort: () => "The wallet sent it with too little gas. Try again.",
  ZeroAddress: () => "That address is empty.",
};

/** What a failed claims call was, in words. */
export function explainClaim(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (declined(e)) return "You declined it in your wallet. Nothing was sent.";
  const err = e as { data?: unknown; error?: { data?: unknown }; cause?: { data?: unknown } };
  for (const d of [err.data, err.error?.data, err.cause?.data, (err.data as { data?: unknown } | undefined)?.data, (err.data as { originalError?: { data?: unknown } } | undefined)?.originalError?.data]) {
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
      try {
        const r = decodeErrorResult({ abi: ERRORS, data: d as Hex });
        const args = (r.args ?? []) as readonly unknown[];
        return WORDS[r.errorName]?.(args) ?? wordsFor(r.errorName, args) ?? `The contract refuses it: ${r.errorName}.`;
      } catch {
        // not one of these
      }
    }
  }
  return deskExplain(e);
}

async function haveCode(p: Provider, to: string): Promise<void> {
  const code = await p.request({ method: "eth_getCode", params: [to, "latest"] }).catch(() => null);
  if (typeof code !== "string" || code.length <= 2) throw new Refusal("Your wallet does not see the claims contract on the chain it is on. Nothing was sent. Check that the wallet is on Robinhood Chain.");
}

/** One call to the claims contract: tried without sending, sent, followed until it is mined. */
export async function sendClaim(p: Provider, o: { contract: string; from: string; fn: "open" | "list" | "unlist" | "buy" | "settle"; args?: readonly unknown[]; value?: bigint; on?: (step: "checking" | "wallet" | "mining") => void }): Promise<Sent> {
  o.on?.("checking");
  await ensureChain(p);
  await haveCode(p, o.contract);
  const data = encodeFunctionData({ abi: CLAIMS_ABI, functionName: o.fn, args: o.args ?? [] });
  try {
    await ethCall(p, o.contract, data, o.from, o.value);
  } catch (e) {
    throw new Refusal(explainClaim(e));
  }
  o.on?.("wallet");
  let hash: string;
  try {
    hash = await sendTx(p, { from: o.from, to: o.contract, data, value: o.value });
  } catch (e) {
    throw new Refusal(explainClaim(e));
  }
  o.on?.("mining");
  const receipt = await waitFor(p, hash);
  if (receipt.status !== "0x1") throw new Refusal(receipt.reason ?? "The transaction was mined and refused. Nothing changed. Reload the page and look again.");
  return { hash: receipt.transactionHash || hash, receipt };
}

async function read<T>(p: Provider, contract: string, fn: string, args: readonly unknown[]): Promise<T> {
  const data = await ethCall(p, contract, encodeFunctionData({ abi: CLAIMS_ABI, functionName: fn, args }));
  return decodeFunctionResult({ abi: CLAIMS_ABI, functionName: fn, data: data as Hex }) as T;
}

/** A key's pay account, or the zero address. */
export const accountOf = (p: Provider, contract: string, key: string): Promise<string> => read<string>(p, contract, "accountOf", [key]);
/** What a desk job pays its agent if it settles in full, as it stands now. */
export const faceOf = (p: Provider, contract: string, job: number): Promise<bigint> => read<bigint>(p, contract, "faceOf", [BigInt(job)]);
/** Whether a claim on this job could be listed or bought now, by the job alone. */
export const forSale = (p: Provider, contract: string, job: number): Promise<boolean> => read<boolean>(p, contract, "forSale", [BigInt(job)]);

/** The most a claim is sold under its face, in words: "a tenth" for the contract's 10%. */
export const underWords = (bps: number): string => (bps === 1000 ? "a tenth" : `${bps / 100} percent`);

/** The price for a face at a discount in basis points, as the contract checks it. */
export const priceAt = (face: bigint, bps: number): bigint => (face * BigInt(10_000 - bps)) / 10_000n;

/** The number the contract gave a listing, read from the transaction that made it. */
export function listedId(receipt: Receipt, contract: string): number | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: CLAIMS_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      if (d.eventName === "Listed") return Number((d.args as unknown as { id: bigint }).id);
    } catch {
      // another event
    }
  }
  return null;
}

/** How a claim ended, or what happens next, in words. */
export function claimWords(c: ClaimView): string {
  const paid = weiEth(c.paid), owing = weiEth(c.owing), price = weiEth(c.price);
  const fmt = (n: number) => `${+n.toFixed(8)} ETH`;
  if (c.state === "listed") return ""; // the buy button says it
  if (c.state === "sold") return "Bought: when the job ends, what it pays its agent goes to the holder. If that is less than the price paid, the pay account owes the difference.";
  if (c.state === "paid") {
    if (owing > 0) return `The job paid the holder ${fmt(paid)}, less than the ${fmt(price)} it paid: the pay account owes ${fmt(owing)}, paid first from everything it holds or earns.`;
    if (paid < price) return `The job paid the holder ${fmt(paid)}, and the pay account paid back the rest of the ${fmt(price)} price.`;
    return `The job settled and paid the holder ${fmt(paid)}.`;
  }
  return "Taken off sale, or its job ended before anyone bought it.";
}
