// The sample's agent treasuries, in exactly the engine's shape (engine/src/treasury.ts), so the pages can be built,
// looked at and tested with no chain behind them. Nothing here is real. Shown only when FACTOR_SAMPLE=1 (see data.ts).
//
// orbit-ops keeps 0.42 ETH in its treasury with a floor of 0.25: two runs so far, the first repaid its credit line and
// prepaid compute, the second bought the claim on job 0414's pay and topped up both bonds. lumen-07 put 0.05 ETH in
// and has set no rules yet.
import { sampleBits } from "./sample";
import type { TreasuryAbout, TreasuryReceipt, TreasuryRun, TreasuryView } from "./types";

const { A, TX, addressOf, at } = sampleBits;
const wei = (e: number) => String(BigInt(Math.round(e * 1e9)) * 10n ** 9n);
const CONTRACT = A(9200);
const KEEPER = A(9201);

const step = (kind: TreasuryReceipt["kind"], text: string, amountEth: number, min: number, tx: number, claim?: number): TreasuryReceipt => ({ kind, text, amount: wei(amountEth), amountEth, at: at(min), tx: TX(tx), ...(claim ? { claim } : {}) });
const run = (min: number, tx: number, steps: TreasuryReceipt[]): TreasuryRun => {
  const spent = +steps.reduce((n, s) => n + s.amountEth, 0).toFixed(9);
  return { tx: TX(tx), at: at(min), by: KEEPER, spent: wei(spent), spentEth: spent, steps, skipped: 0 };
};

const ORBIT_RUNS: TreasuryRun[] = [
  run(40, 1802, [
    step("claim", "Bought the locked pay of job 414 (claim 2) for 0.0188 ETH", 0.0188, 40, 1802, 2),
    step("guarantee", "Added 0.0100 ETH to its guarantee bond", 0.01, 40, 1802),
    step("vouch", "Added 0.0200 ETH to its vouching bond", 0.02, 40, 1802),
  ]),
  run(1500, 1801, [
    step("repay", "Repaid 0.0120 ETH of its credit line: the line owes nothing", 0.012, 1500, 1801),
    step("compute", "Prepaid 0.0050 ETH of compute at the gateway", 0.005, 1500, 1801),
  ]),
];

const treasuries: TreasuryView[] = [
  {
    agent: addressOf("orbit-ops"), name: "orbit-ops", named: true, balance: wei(0.42), balanceEth: 0.42, spendable: wei(0.17),
    rules: {
      floor: wei(0.25), repay: { on: true, daily: wei(0.05) }, compute: { on: true, daily: wei(0.005) },
      claims: { on: true, daily: wei(0.04), maxPrice: wei(0.02), minDiscountBps: 300, minScore: 200, deliveredOnly: true },
      guarantee: { on: true, upTo: wei(0.05) }, vouch: { on: true, upTo: wei(0.04) },
    },
    totals: { deposited: wei(0.4858), withdrawn: "0", repaid: wei(0.012), compute: wei(0.005), claims: wei(0.0188), guarantee: wei(0.01), vouch: wei(0.02), runs: 2, claimsBought: 1 },
    runs: ORBIT_RUNS,
    next: { claims: [{ id: 3, price: "0" }], repay: "0", compute: wei(0.005), buy: "0", guarantee: "0", vouch: "0", total: wei(0.005), lineFirst: false, readAt: at(1) },
    openedAt: at(2900), factorOwn: false,
  },
  {
    agent: addressOf("lumen-07"), name: "lumen-07", named: true, balance: wei(0.05), balanceEth: 0.05, spendable: wei(0.05),
    rules: null, totals: { deposited: wei(0.05), withdrawn: "0", repaid: "0", compute: "0", claims: "0", guarantee: "0", vouch: "0", runs: 0, claimsBought: 0 },
    runs: [], next: null, openedAt: at(300), factorOwn: false,
  },
];

export function sampleTreasuryAbout(): TreasuryAbout {
  const sum = (k: "repaid" | "compute" | "claims" | "guarantee" | "vouch") => wei(+treasuries.reduce((n, t) => n + Number(t.totals?.[k] ?? 0) / 1e18, 0).toFixed(9));
  return {
    enabled: true, contract: CONTRACT, fromBlock: "117200000", chainId: 4663,
    rules: { minStep: wei(0.0001), maxClaims: 10, day: 86_400, order: ["repay", "compute", "claims", "guarantee", "vouch"] },
    totals: { treasuries: treasuries.length, held: wei(0.47), runs: 2, repaid: sum("repaid"), compute: sum("compute"), claims: sum("claims"), guarantee: sum("guarantee"), vouch: sum("vouch"), factorOwn: 0 },
  };
}

/** One agent's treasury, by its address or name: an agent that never used it has an empty one, as on the engine. */
export function sampleTreasury(id: string): { treasury: TreasuryView } | null {
  const a = id.toLowerCase();
  const t = treasuries.find((x) => x.agent.toLowerCase() === a || x.name === a);
  if (t) return { treasury: t };
  const found = sampleBits.find(a);
  const address = /^0x[0-9a-f]{40}$/.test(a) ? a : found?.address;
  if (!address) return null;
  return { treasury: { agent: address, name: found?.name ?? address, named: !!found, balance: "0", balanceEth: 0, spendable: "0", rules: null, totals: null, runs: [], next: null, openedAt: null, factorOwn: false } };
}

export const sampleTreasuries = (): { treasuries: TreasuryView[] } => ({ treasuries });

export function withTreasuryState<T extends { treasury?: TreasuryAbout }>(s: T): T {
  return { ...s, treasury: sampleTreasuryAbout() };
}
