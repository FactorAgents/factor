// Before the launch there is no desk and no token, so nothing has happened that the ledger could print. The site
// makes nothing up: the receipt prints only what is true then, the blocks of Robinhood Chain as the desk reads them.
// From the launch on it prints what the contracts did, with the blocks in between.

import type { Beat, DeskNote, FactorState, LedgerEvent } from "./types";

/** Nothing is live yet (and this is not the sample the site is built against). */
export const beforeLaunch = (s: FactorState): boolean => s.source !== "sample" && !s.launched && s.agents.length === 0 && s.events.length === 0;


// The receipt's own numbering: a line's time, so a block read and a line of the ledger print in the order they
// happened. Lines that only stand there (Factor's agents before the launch) keep small numbers and never print again.
const order = (at: string, i: number) => Date.parse(at) * 100 + (i % 100);

/** A reading of the chain as a line of the receipt: the block, how many came since the reading before, the gas price. */
export const beatLine = (b: Beat, before?: Beat): LedgerEvent => ({
  n: order(b.at, b.block), at: b.at, kind: "block",
  text: `Robinhood Chain · block ${b.block.toLocaleString("en-US")}${before && b.block > before.block ? ` · ${(b.block - before.block).toLocaleString("en-US")} new` : ""}`,
  amount: b.gwei === null ? "" : `${b.gwei} gwei`, tx: "",
});

/** The readings as lines, newest first (each counted against the one read before it). */
export const beatLines = (beats: Beat[]): LedgerEvent[] => beats.map((b, i) => beatLine(b, beats[i + 1]));

/**
 * What the receipt prints. Before the launch: only the chain as the desk reads it, block after block. Nothing else
 * has happened, so nothing else is printed. After it: the ledger's lines and the blocks in between, in the order
 * they happened, so the paper never stands still while the desk is working.
 */
export function receiptLines(s: FactorState, pre: boolean): LedgerEvent[] {
  const beats = beatLines(s.pulse ?? []);
  const desk = (s.desk?.latest ?? []).map(deskLine);
  const ledger = pre ? [] : s.events.map((e, i) => ({ ...e, n: order(e.at, i) }));
  return [...beats, ...desk, ...ledger].sort((a, b) => b.n - a.n);
}

const short = (s: string) => (/^0x[0-9a-f]{40}$/i.test(s) ? `${s.slice(0, 6)}...${s.slice(-4)}` : s);

/** What the Desk did, as a line of the receipt: it wrote something, at that moment. */
export function deskLine(d: DeskNote, i = 0): LedgerEvent {
  const text = d.kind === "opening" ? `opened a credit file on ${short(d.subject)}`
    : d.kind === "file" ? `updated the credit file of ${short(d.subject)}`
    : d.kind === "reason" ? "wrote down why an advance was allowed"
    : `wrote its letter on ${d.subject}`;
  return { n: order(d.at, 50 + i), at: d.at, kind: "desk", text, amount: "", tx: "" };
}
