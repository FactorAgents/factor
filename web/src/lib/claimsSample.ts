// The sample's claims on locked pay, in exactly the engine's shape (engine/src/claims.ts), so the pages can be built,
// looked at and tested with no chain behind them. Nothing here is real. Shown only when FACTOR_SAMPLE=1 (see data.ts).
//
// tally-bot lists the claim on job 0413 (locked) at 5% under its face; orbit-ops sold the claim on job 0414
// (delivered) to price-desk at 4% under; lumen-07 sold the claim on job 0412, which settled and paid the holder.
import { sampleBits } from "./sample";
import type { AgentClaims, ClaimView, ClaimsAbout } from "./types";

const { A, TX, addressOf } = sampleBits;
const NOW = Math.floor(Date.parse(new Date(sampleBits.at(0)).toISOString()) / 1000);
const mins = (m: number) => NOW - m * 60;
const wei = (e: number) => String(BigInt(Math.round(e * 1e9)) * 10n ** 9n);
// the pay account of each agent that sells its pay: a desk address of its own, which its key runs
const ACCOUNT: Record<string, string> = { "tally-bot": A(9101), "orbit-ops": A(9102), "lumen-07": A(9103) };
const CONTRACT = A(9100);
const face = (price: number, early = 0) => +(price - early - price * 0.02).toFixed(9);

const claim = (id: number, job: number, agent: string, priceEth: number, advanced: number, discountBps: number, listedMin: number): ClaimView => {
  const f = face(priceEth, advanced);
  return {
    id, job, account: ACCOUNT[agent]!, seller: addressOf(agent), sellerName: agent, state: "listed",
    face: wei(f), price: wei(+(f * (10_000 - discountBps) / 10_000).toFixed(9)), discountBps,
    holder: null, buyer: null, paid: null, owing: null, listedAt: mins(listedMin), soldAt: null, endedAt: null,
    listedTx: TX(1500 + id), boughtTx: null, paidTx: null, factorOwn: false,
  };
};

const claims: ClaimView[] = [
  { ...claim(3, 413, "tally-bot", 0.012, 0, 500, 30), jobState: "locked", dueAt: mins(-1440) },
  { ...claim(2, 414, "orbit-ops", 0.02, 0, 400, 90), state: "sold", holder: addressOf("price-desk"), holderName: "price-desk", buyer: addressOf("price-desk"), soldAt: mins(80), boughtTx: TX(1602), jobState: "delivered", dueAt: mins(-600) },
  { ...claim(1, 412, "lumen-07", 0.04, 0.02, 300, 200), state: "paid", holder: A(77), buyer: A(77), soldAt: mins(190), endedAt: mins(5), boughtTx: TX(1601), paidTx: TX(1701), paid: wei(face(0.04, 0.02)), owing: "0", jobState: "settled" },
];

export function sampleClaimsAbout(): ClaimsAbout {
  const sold = claims.filter((c) => c.state === "sold" || c.state === "paid");
  const sum = (xs: ClaimView[], k: "face" | "price" | "paid") => wei(+xs.reduce((n, c) => n + Number(c[k] ?? 0) / 1e18, 0).toFixed(9));
  return {
    enabled: true, contract: CONTRACT, fromBlock: 112800000,
    rules: { maxDiscountBps: 1000, minFace: wei(0.0005), maxOpen: 10, review: 86_400, grace: 43_200 },
    totals: { claims: claims.length, listed: claims.filter((c) => c.state === "listed").length, sold: sold.length, faceSold: sum(sold, "face"), priceSold: sum(sold, "price"), paid: sum(claims.filter((c) => c.state === "paid"), "paid"), owedBack: "0", repaid: "0" },
  };
}

export function sampleClaims(o: { state?: string } = {}): { claims: ClaimView[] } {
  return { claims: o.state ? claims.filter((c) => c.state === o.state) : claims };
}
export const sampleClaim = (id: number): ClaimView | null => claims.find((c) => Number(c.id) === id) ?? null;
export const sampleClaimsOfJob = (job: number): ClaimView[] => claims.filter((c) => Number(c.job) === job);

/** An agent's claims, by its own address or its pay account's. */
export function sampleAgentClaims(address: string): AgentClaims {
  const a = address.toLowerCase();
  const name = Object.keys(ACCOUNT).find((n) => addressOf(n).toLowerCase() === a || ACCOUNT[n]!.toLowerCase() === a);
  const account = name ? ACCOUNT[name]! : null;
  return { account, key: name ? addressOf(name) : null, debt: "0", claims: account ? claims.filter((c) => c.account === account) : [], bought: claims.filter((c) => c.holder?.toLowerCase() === a) };
}

export function withClaimsState<T extends { claims?: ClaimsAbout }>(s: T): T {
  return { ...s, claims: sampleClaimsAbout() };
}
