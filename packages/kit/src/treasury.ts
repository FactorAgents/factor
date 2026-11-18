// Agent treasury (contracts/src/FactorTreasury.sol, docs/TREASURY.md): the treasury contract's refusals in plain words,
// the rules an agent sets as the kit takes them (ETH as text) and as the contract takes them (wei), and a treasury said
// in words.
import { BaseError, ContractFunctionRevertedError, formatEther, parseEther } from "viem";
import { explain, Refusal } from "./words.js";
import type { Treasury, TreasuryNext, TreasuryRules } from "./types.js";

const eth = (wei: unknown): string => formatEther(BigInt(String(wei)));

/** The treasury contract's own refusals. */
export const TREASURY_WORDS: Record<string, (a: readonly unknown[]) => string> = {
  ZeroAmount: () => "The amount is zero.",
  BadRules: () => "Those rules are out of range: a discount is at most 100%, a score at most 1000.",
  OverBalance: (a) => (BigInt(String(a[0])) === 0n ? "This treasury holds nothing." : `This treasury holds ${eth(a[0])} ETH: no more than that can come out.`),
  TooMany: () => "A run takes ten claims at most.",
  NothingToDo: () => "There is nothing for a run to do now: nothing above the floor, no use switched on, or every use has reached its amount.",
  PushFailed: () => "The address the ETH was sent to refused it. Name another address.",
};

/** What a failed treasury call was, in words. */
export function treasuryWordsOf(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (e instanceof BaseError) {
    const hit = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (hit instanceof ContractFunctionRevertedError && hit.data?.errorName && TREASURY_WORDS[hit.data.errorName]) return TREASURY_WORDS[hit.data.errorName]!((hit.data.args ?? []) as readonly unknown[]);
  }
  return explain(e);
}

/**
 * The rules an agent sets, as the kit takes them: ETH as text, a use left out is off. A run does them in this order and
 * never spends below the floor.
 */
export interface TreasuryRulesInput {
  /** ETH a run never spends below. "0" when left out */
  floorEth?: string;
  /** 1: repay this agent's own credit line, at most this much ETH a day. While it is on and the line owes, nothing below is done */
  repay?: { dailyEth: string };
  /** 2: prepay compute at the gateway, at most this much ETH a day */
  compute?: { dailyEth: string };
  /** 3: buy locked pay: at most `dailyEth` a day and `maxPriceEth` for one claim, at least `minDiscountPct` under its face, from a seller whose desk score is at least `minScore`, only delivered jobs when `deliveredOnly` */
  claims?: { dailyEth: string; maxPriceEth: string; minDiscountPct?: number; minScore?: number; deliveredOnly?: boolean };
  /** 4: top up this agent's guarantee bond to this level */
  guarantee?: { upToEth: string };
  /** 5: top up this agent's vouching bond to this level */
  vouch?: { upToEth: string };
}

/** The contract's Rules struct, in the order of its fields. */
export interface TreasuryRulesWei {
  floor: bigint; repay: boolean; repayDaily: bigint; compute: boolean; computeDaily: bigint; claims: boolean; claimsDaily: bigint; claimMaxPrice: bigint;
  claimMinDiscountBps: number; claimMinScore: number; claimDeliveredOnly: boolean; guarantee: boolean; guaranteeUpTo: bigint; vouch: boolean; vouchUpTo: bigint;
}

/** The kit's rules as the contract takes them. Refuses what the contract would refuse, before anything is sent. */
export function treasuryRulesWei(r: TreasuryRulesInput): TreasuryRulesWei {
  const wei = (v: string | undefined, what: string): bigint => {
    if (v === undefined) return 0n;
    if (!/^\d{1,9}(\.\d{1,18})?$/.test(v)) throw new Refusal(`${what} is ETH as text, like "0.05": it is "${v}".`, "bad_rules");
    return parseEther(v);
  };
  const pct = r.claims?.minDiscountPct ?? 0;
  const score = r.claims?.minScore ?? 0;
  if (!(pct >= 0 && pct <= 100)) throw new Refusal("The least discount is from 0 to 100 percent.", "bad_rules");
  if (!(Number.isInteger(score) && score >= 0 && score <= 1000)) throw new Refusal("The least seller score is a whole number from 0 to 1000.", "bad_rules");
  return {
    floor: wei(r.floorEth, "The floor"),
    repay: !!r.repay, repayDaily: wei(r.repay?.dailyEth, "The most a day on the line"),
    compute: !!r.compute, computeDaily: wei(r.compute?.dailyEth, "The most a day on compute"),
    claims: !!r.claims, claimsDaily: wei(r.claims?.dailyEth, "The most a day on locked pay"), claimMaxPrice: wei(r.claims?.maxPriceEth, "The most for one claim"),
    claimMinDiscountBps: Math.round(pct * 100), claimMinScore: score, claimDeliveredOnly: !!r.claims?.deliveredOnly,
    guarantee: !!r.guarantee, guaranteeUpTo: wei(r.guarantee?.upToEth, "The guarantee bond's level"),
    vouch: !!r.vouch, vouchUpTo: wei(r.vouch?.upToEth, "The vouching bond's level"),
  };
}

/** An agent's rules, in words, in the order a run does them. */
export function treasuryRulesText(r: TreasuryRules | null): string {
  if (!r) return "No rules set: a run does nothing.";
  const on: string[] = [];
  if (r.repay.on) on.push(`1 repay its credit line first, up to ${eth(r.repay.daily)} ETH a day`);
  if (r.compute.on) on.push(`2 prepay compute, up to ${eth(r.compute.daily)} ETH a day`);
  if (r.claims.on) on.push(`3 buy locked pay, up to ${eth(r.claims.daily)} ETH a day and ${eth(r.claims.maxPrice)} ETH a claim${r.claims.minDiscountBps ? `, at least ${r.claims.minDiscountBps / 100}% under its face` : ""}${r.claims.minScore ? `, from a seller scoring ${r.claims.minScore} or more` : ""}${r.claims.deliveredOnly ? ", delivered jobs only" : ""}`);
  if (r.guarantee.on) on.push(`4 keep its guarantee bond at ${eth(r.guarantee.upTo)} ETH`);
  if (r.vouch.on) on.push(`5 keep its vouching bond at ${eth(r.vouch.upTo)} ETH`);
  return `Floor ${eth(r.floor)} ETH, never spent by a run. ${on.length ? `In order: ${on.join("; ")}.` : "Every use is off: a run does nothing."}`;
}

/** What the next run would do, in words. */
export function treasuryNextText(n: TreasuryNext | null): string {
  if (!n) return "The next run has not been worked out yet.";
  if (BigInt(n.total) === 0n) return "A run would do nothing now.";
  const parts: string[] = [];
  if (BigInt(n.repay) > 0n) parts.push(`repay ${eth(n.repay)} ETH of the line`);
  if (BigInt(n.compute) > 0n) parts.push(`prepay ${eth(n.compute)} ETH of compute`);
  const buys = n.claims.filter((c) => BigInt(c.price) > 0n);
  if (buys.length) parts.push(`buy ${buys.map((c) => `claim ${c.id} for ${eth(c.price)} ETH`).join(" and ")}`);
  if (BigInt(n.guarantee) > 0n) parts.push(`add ${eth(n.guarantee)} ETH to the guarantee bond`);
  if (BigInt(n.vouch) > 0n) parts.push(`add ${eth(n.vouch)} ETH to the vouching bond`);
  return `The next run would ${parts.join(", then ")}: ${eth(n.total)} ETH in all${n.lineFirst ? ". The line would still owe, so nothing after the repayment is done" : ""}.`;
}

/** A treasury in words: what it holds, its rules, its latest runs and the next one. */
export function treasuryText(t: Treasury): string {
  const lines = [
    `${t.name}'s treasury holds ${eth(t.balance)} ETH, ${eth(t.spendable)} ETH above its floor. Only ${t.name} can take it out, at any time.`,
    treasuryRulesText(t.rules),
    treasuryNextText(t.next),
  ];
  for (const r of t.runs.slice(0, 5)) lines.push(`Run ${r.at.slice(0, 16).replace("T", " ")} UTC, ${eth(r.spent)} ETH: ${r.steps.map((s) => s.text).join("; ")}.`);
  if (!t.runs.length) lines.push("No run yet.");
  return lines.join("\n");
}
