// Funding a desk job from another chain through NEAR Intents.
//
// The customer asks 1Click for an EXACT_OUTPUT quote: exactly the job's price in a token the desk takes, delivered
// to the desk, with the desk's lock message as `customRecipientMsg`. 1Click answers with a deposit address on the
// customer's own chain (USDC on Base, ETH on Arbitrum, ...). When the deposit is swapped, NEAR Intents delivers the
// tokens with ft_transfer_call(desk, amount, msg) and the desk locks the job in that same transfer. Refunds of a
// failed swap go back to the customer's address on its own chain; refunds of the job go to the NEAR account named
// as customer in the message.
//
// Everything in this file is pure, so it is tested against recorded and schema-written 1Click answers.

import { randomBytes } from "node:crypto";
import type { QuoteRequest, StatusResponse } from "./oneclick.ts";

/** 1Click asset ids (mainnet), from GET /v0/tokens. */
export const ASSETS: Record<string, string> = {
  "near-usdc": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "base-usdc": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "arb-usdc": "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  "eth-usdc": "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  "base-eth": "nep141:base.omft.near",
  "eth-eth": "nep141:eth.omft.near",
  wnear: "nep141:wrap.near",
};

export interface LockParams {
  customer: string;
  agent: string | null;
  dueMs: number;
  allowAdvance: boolean;
  brief: string;
  ref: string;
}

/** A reference that ties a quote to the job it will lock: it travels in the lock message's note. */
export const newRef = (): string => randomBytes(8).toString("hex");
export const noteOf = (ref: string): string => `intents:${ref}`;

/** The desk's LockMsg, as ft_on_transfer reads it. */
export function lockMsg(p: LockParams): string {
  return JSON.stringify({ customer: p.customer, agent: p.agent, due_ms: String(p.dueMs), allow_advance: p.allowAdvance, brief: p.brief, note: noteOf(p.ref) });
}

export interface DeskRules {
  min_duration_ms: string;
  tokens: { token: string; min_amount: string }[];
}

const MAX_DURATION_MS = 90 * 24 * 3600 * 1000;
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * The desk would refuse a bad lock message, and the tokens would go back to NEAR Intents rather than lock a job.
 * So the message is checked against the desk's own rules before any quote is asked for. Returns what is wrong.
 */
export function checkLock(msg: string, amount: bigint, token: string, rules: DeskRules, nowMs: number, swapMinutes: number): string[] {
  const m = JSON.parse(msg);
  const wrong: string[] = [];
  const rule = rules.tokens.find((t) => t.token === token);
  if (!rule) wrong.push(`the desk does not take ${token}`);
  else if (amount < BigInt(rule.min_amount)) wrong.push(`below the smallest job in ${token}`);
  // the job is locked when the swap lands, so the due time must still be far enough then
  const landsBy = nowMs + swapMinutes * 60_000;
  if (Number(m.due_ms) < landsBy + Number(rules.min_duration_ms)) wrong.push("due time too soon for the swap to land first");
  if (Number(m.due_ms) > nowMs + MAX_DURATION_MS) wrong.push("due time too far");
  if (!/^[0-9a-f]{64}$/i.test(m.brief)) wrong.push("brief is not a sha256");
  if (!ACCOUNT.test(m.customer ?? "") || m.customer.length < 2 || m.customer.length > 64) wrong.push("customer is not a NEAR account");
  if (m.agent !== null && m.agent !== undefined && !ACCOUNT.test(m.agent)) wrong.push("agent is not a NEAR account");
  if (m.agent && m.agent === m.customer) wrong.push("a customer cannot hire itself");
  return wrong;
}

/** The quote that funds a job: exactly `amount` of `destinationAsset` delivered to the desk with the lock message. */
export function fundingQuote(o: {
  from: string;
  refundTo: string;
  desk: string;
  destinationAsset: string;
  amount: bigint;
  msg: string;
  dry: boolean;
  nowMs: number;
  minutes?: number;
}): QuoteRequest {
  return {
    dry: o.dry,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: ASSETS[o.from] ?? o.from,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: o.destinationAsset,
    amount: o.amount.toString(),
    refundTo: o.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: o.desk,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(o.nowMs + (o.minutes ?? 30) * 60_000).toISOString(),
    customRecipientMsg: o.msg,
  };
}

export type Phase = "unknown" | "waiting-for-deposit" | "swapping" | "landed" | "short-deposit" | "refunded" | "failed";

/** What a 1Click status means for the job. */
export function phaseOf(s: StatusResponse | null): { phase: Phase; done: boolean; words: string } {
  if (!s) return { phase: "unknown", done: false, words: "1Click does not know this deposit address" };
  switch (s.status) {
    case "PENDING_DEPOSIT":
      return { phase: "waiting-for-deposit", done: false, words: "waiting for the deposit on the customer's chain" };
    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
      return { phase: "swapping", done: false, words: "deposit seen; the swap is being filled through NEAR Intents" };
    case "SUCCESS":
      return { phase: "landed", done: true, words: `delivered on NEAR: ${s.swapDetails?.amountOutFormatted ?? "the amount"} to the desk with the lock message` };
    case "INCOMPLETE_DEPOSIT":
      return { phase: "short-deposit", done: false, words: "the deposit is below the quote: send the rest or wait for the refund" };
    case "REFUNDED":
      return { phase: "refunded", done: true, words: `the swap did not go through; ${s.swapDetails?.refundedAmount ?? "the deposit"} went back to the refund address (${s.swapDetails?.refundReason ?? "no reason given"})` };
    case "FAILED":
      return { phase: "failed", done: true, words: "1Click reports the swap failed" };
  }
}

/** The job the delivery locked: the one whose note carries the quote's reference, for the delivered amount. */
export function creditedJob<J extends { note?: string | null; price: string; token?: string | null }>(jobs: J[], ref: string, amount: bigint, token: string): J | undefined {
  return jobs.find((j) => j.note === noteOf(ref) && BigInt(j.price) === amount && j.token === token);
}
