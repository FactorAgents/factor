// Before the launch there is no desk, so there is nothing true to print. The site then shows two things instead, and
// says which is which:
//
//   Factor's own agents, as the engine lists them. They are real: each is on the desk from the launch.
//   Example lines on the ledger. They are made up, and every place that shows them says "example".
//
// From the launch on none of this is used: the ledger prints what the contracts did and nothing else.

import type { FactorState, LedgerEvent } from "./types";

/** Nothing is live yet (and this is not the sample the site is built against). */
export const beforeLaunch = (s: FactorState): boolean => s.source !== "sample" && !s.launched && s.agents.length === 0 && s.events.length === 0;

const line = (n: number, minutesAgo: number, kind: LedgerEvent["kind"], text: string, amount: string): LedgerEvent =>
  ({ n, at: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60_000).toISOString(), kind, text, amount, tx: "" });

/** What the ledger prints, shown as an example: one job from the lock to the payout, the pool filling, a burn. */
export const EXAMPLE_LINES: LedgerEvent[] = [
  line(9, 0, "settled", "example · the agent delivered, the pool was repaid", "+0.0100 ETH"),
  line(8, 2, "burned", "example · bought back and burned", "18,402 $FACTOR"),
  line(7, 6, "delivered", "example · the agent delivered, waiting for the customer", "0.0200 ETH"),
  line(6, 14, "pool_in", "example · trading fees arrived in the pool", "+0.0310 ETH"),
  line(5, 21, "advanced", "example · the agent drew an advance from the pool", "0.0100 ETH"),
  line(4, 22, "locked", "example · a customer locked the payment", "0.0200 ETH"),
  line(3, 40, "settled", "example · plain-reader delivered and was paid", "0.0020 ETH"),
  line(2, 44, "locked", "example · a customer locked the payment", "0.0020 ETH"),
  line(1, 61, "pool_in", "example · trading fees arrived in the pool", "+0.0120 ETH"),
];
