// The agent treasury, as a visitor's wallet sends it (contracts/src/FactorTreasury.sol): an agent puts ETH into its
// treasury, sets its rules once (a floor a run never spends below, and for each of five uses whether it is on and how far
// it goes) and takes ETH out whenever it likes; anyone runs a treasury, which does only what its rules allow, in the
// contract's fixed order. Amounts are wei, always.
//
// Every call is tried first without being sent: a call the contract would refuse never reaches the wallet, and the
// visitor is told why in plain words. The figures shown on pages (lib/types.ts TreasuryView) come from the engine.
import { decodeErrorResult, encodeFunctionData, formatEther, parseEther, type Abi, type Hex } from "viem";
import { factorTreasuryAbi } from "./abi/FactorTreasury";
import { explain as deskExplain, Refusal, wordsFor, type Sent } from "./desk";
import { declined, ensureChain, ethCall, sendTx, waitFor, type Provider } from "./wallet";
import type { TreasuryNext, TreasuryRules } from "./types";

export const TREASURY_ABI = factorTreasuryAbi as Abi;
const ERRORS = TREASURY_ABI.filter((x) => x.type === "error") as Abi;

/** Wei in text as ETH in text, with no trailing zeros. */
export const ethOf = (wei: unknown): string => {
  const s = formatEther(/^\d+$/.test(String(wei ?? "")) ? BigInt(String(wei)) : 0n);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};
const positive = (wei: unknown): boolean => /^\d+$/.test(String(wei ?? "")) && BigInt(String(wei)) > 0n;

// The treasury contract's own refusals, in plain words.
const WORDS: Record<string, (a: readonly unknown[]) => string> = {
  ZeroAmount: () => "The amount is zero.",
  ZeroAddress: () => "That address is empty.",
  BadRules: () => "Those rules are out of range: a discount is at most 100%, a score at most 1000.",
  OverBalance: (a) => (BigInt(String(a[0])) === 0n ? "This treasury holds nothing." : `This treasury holds ${ethOf(a[0])} ETH: no more than that can come out.`),
  TooMany: () => "A run takes ten claims at most.",
  NothingToDo: () => "There is nothing for a run to do now: nothing above the floor, no use switched on, or every use has reached its amount.",
  PushFailed: () => "The address the ETH was sent to refused it. Name another address.",
};

/** What a failed treasury call was, in words. */
export function explainTreasury(e: unknown): string {
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

/** One call to the treasury contract: tried without sending, sent, followed until it is mined. */
export async function sendTreasury(p: Provider, o: { contract: string; from: string; fn: "deposit" | "withdraw" | "setRules" | "run"; args?: readonly unknown[]; value?: bigint; on?: (step: "checking" | "wallet" | "mining") => void }): Promise<Sent> {
  o.on?.("checking");
  await ensureChain(p);
  const code = await p.request({ method: "eth_getCode", params: [o.contract, "latest"] }).catch(() => null);
  if (typeof code !== "string" || code.length <= 2) throw new Refusal("Your wallet does not see the treasury contract on the chain it is on. Nothing was sent. Check that the wallet is on Robinhood Chain.");
  const data = encodeFunctionData({ abi: TREASURY_ABI, functionName: o.fn, args: o.args ?? [] });
  try {
    await ethCall(p, o.contract, data, o.from, o.value);
  } catch (e) {
    throw new Refusal(explainTreasury(e));
  }
  o.on?.("wallet");
  let hash: string;
  try {
    hash = await sendTx(p, { from: o.from, to: o.contract, data, value: o.value });
  } catch (e) {
    throw new Refusal(explainTreasury(e));
  }
  o.on?.("mining");
  const receipt = await waitFor(p, hash);
  if (receipt.status !== "0x1") throw new Refusal(receipt.reason ?? "The transaction was mined and refused. Nothing changed. Reload the page and look again.");
  return { hash: receipt.transactionHash || hash, receipt };
}

/** ETH typed into a form, as wei. Empty is zero; anything that is not an amount is refused in words. */
export function typedWei(text: string, what: string): bigint {
  const t = text.trim();
  if (!t) return 0n;
  if (!/^\d{1,9}(\.\d{1,18})?$/.test(t)) throw new Refusal(`${what}: write an amount of ETH, like 0.05.`);
  return parseEther(t);
}

/** What the rules form holds: ETH as typed, an empty field meaning that use is off. */
export interface RulesForm { floor: string; repay: string; compute: string; claims: string; claimMax: string; claimDiscount: string; claimScore: string; deliveredOnly: boolean; guarantee: string; vouch: string }

export const EMPTY_FORM: RulesForm = { floor: "", repay: "", compute: "", claims: "", claimMax: "", claimDiscount: "", claimScore: "", deliveredOnly: false, guarantee: "", vouch: "" };

/** The rules an agent has, as the form shows them. */
export function formOf(r: TreasuryRules | null): RulesForm {
  if (!r) return { ...EMPTY_FORM };
  const on = (is: boolean, wei: string) => (is && positive(wei) ? ethOf(wei) : "");
  return {
    floor: positive(r.floor) ? ethOf(r.floor) : "", repay: on(r.repay.on, r.repay.daily), compute: on(r.compute.on, r.compute.daily),
    claims: on(r.claims.on, r.claims.daily), claimMax: on(r.claims.on, r.claims.maxPrice), claimDiscount: r.claims.on && r.claims.minDiscountBps ? String(r.claims.minDiscountBps / 100) : "", claimScore: r.claims.on && r.claims.minScore ? String(r.claims.minScore) : "", deliveredOnly: r.claims.on && r.claims.deliveredOnly,
    guarantee: on(r.guarantee.on, r.guarantee.upTo), vouch: on(r.vouch.on, r.vouch.upTo),
  };
}

/** The form as the contract's Rules struct, in the order of its fields. A use with no amount is off. */
export function rulesStruct(f: RulesForm): Record<string, unknown> {
  const repay = typedWei(f.repay, "Repay the line, a day"), compute = typedWei(f.compute, "Compute, a day"), claims = typedWei(f.claims, "Locked pay, a day");
  const claimMax = typedWei(f.claimMax, "The most for one claim"), guarantee = typedWei(f.guarantee, "Guarantee bond"), vouch = typedWei(f.vouch, "Vouching bond");
  if (claims > 0n && claimMax === 0n) throw new Refusal("To buy locked pay, say the most for one claim too.");
  const pct = f.claimDiscount.trim() ? Number(f.claimDiscount) : 0;
  if (!(pct >= 0 && pct <= 100)) throw new Refusal("The least discount is from 0 to 100 percent.");
  const score = f.claimScore.trim() ? Number(f.claimScore) : 0;
  if (!(Number.isInteger(score) && score >= 0 && score <= 1000)) throw new Refusal("The least seller score is a whole number from 0 to 1000.");
  return {
    floor: typedWei(f.floor, "The floor"),
    repay: repay > 0n, repayDaily: repay, compute: compute > 0n, computeDaily: compute,
    claims: claims > 0n, claimsDaily: claims, claimMaxPrice: claimMax, claimMinDiscountBps: Math.round(pct * 100), claimMinScore: score, claimDeliveredOnly: claims > 0n && f.deliveredOnly,
    guarantee: guarantee > 0n, guaranteeUpTo: guarantee, vouch: vouch > 0n, vouchUpTo: vouch,
  };
}

/** The five uses in the order a run does them, each with whether it is on and how far it goes, for showing. */
export function usesOf(r: TreasuryRules | null): { n: number; name: string; on: boolean; text: string }[] {
  const off = "Off";
  return [
    { n: 1, name: "Repay its credit line", on: !!r?.repay.on, text: r?.repay.on ? `up to ${ethOf(r.repay.daily)} ETH a day, before anything else` : off },
    { n: 2, name: "Prepay compute", on: !!r?.compute.on, text: r?.compute.on ? `up to ${ethOf(r.compute.daily)} ETH a day` : off },
    { n: 3, name: "Buy locked pay", on: !!r?.claims.on, text: r?.claims.on ? `up to ${ethOf(r.claims.daily)} ETH a day, ${ethOf(r.claims.maxPrice)} ETH a claim${r.claims.minDiscountBps ? `, ${r.claims.minDiscountBps / 100}% or more under its face` : ""}${r.claims.minScore ? `, seller score ${r.claims.minScore} or more` : ""}${r.claims.deliveredOnly ? ", delivered jobs only" : ""}` : off },
    { n: 4, name: "Back its guarantee", on: !!r?.guarantee.on, text: r?.guarantee.on ? `its guarantee bond kept at ${ethOf(r.guarantee.upTo)} ETH` : off },
    { n: 5, name: "Back newer agents", on: !!r?.vouch.on, text: r?.vouch.on ? `its vouching bond kept at ${ethOf(r.vouch.upTo)} ETH` : off },
  ];
}

/** What the next run would do, in words; null when it would do nothing. */
export function nextWords(n: TreasuryNext | null): string | null {
  if (!n || !positive(n.total)) return null;
  const parts: string[] = [];
  if (positive(n.repay)) parts.push(`repay ${ethOf(n.repay)} ETH of the line`);
  if (positive(n.compute)) parts.push(`prepay ${ethOf(n.compute)} ETH of compute`);
  const buys = n.claims.filter((c) => positive(c.price));
  if (buys.length) parts.push(`buy ${buys.map((c) => `claim ${c.id} for ${ethOf(c.price)} ETH`).join(" and ")}`);
  if (positive(n.guarantee)) parts.push(`add ${ethOf(n.guarantee)} ETH to the guarantee bond`);
  if (positive(n.vouch)) parts.push(`add ${ethOf(n.vouch)} ETH to the vouching bond`);
  return `${parts.join(", then ")}${n.lineFirst ? ". The line would still owe, so nothing after the repayment is done" : ""}`;
}
