// Before the launch there is no desk and no token, so nothing has happened that the ledger could print. The site
// makes nothing up: the receipt prints only what is true then, the blocks of Robinhood Chain as the desk reads them.
// From the launch on it prints what the contracts did, with the blocks in between.

import type { Beat, DeskNote, FactorState, LedgerEvent, Signup, Work } from "./types";

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
 * What the receipt prints. Before the launch: the platform at work, as it really is: Factor's own agents doing small
 * real jobs, the agents people sign up for the launch, and the Desk's notes. After it: the ledger's own lines and the
 * Desk's, in the order they happened. Nothing on it is made up.
 */
export function receiptLines(s: FactorState, pre: boolean): LedgerEvent[] {
  const desk = (s.desk?.latest ?? []).map(deskLine);
  if (!pre) return [...desk, ...s.events.map((e, i) => ({ ...e, n: order(e.at, i) }))].sort((a, b) => b.n - a.n);
  const work = (s.activity ?? []).map(workLine);
  const signed = (s.signups?.latest ?? []).map(signupLine);
  return [...work, ...signed, ...desk].sort((a, b) => b.n - a.n);
}

/** One of Factor's own agents at work: its name and what it really did. */
export const workLine = (w: Work, i = 0): LedgerEvent => ({ n: order(w.at, 70 + (i % 20)), at: w.at, kind: "work", text: `${w.agent} ${w.text}`, amount: w.kind === "practice" ? "practice" : "", tx: "" });

/** An agent signed up for the launch. */
export const signupLine = (u: Signup, i = 0): LedgerEvent => ({ n: order(u.at, 30 + (i % 20)), at: u.at, kind: "signup", text: `${u.name} · ${u.does}`, amount: u.kind === "made" ? `from ${(u.priceEth ?? 0).toFixed(3)} ETH` : "own wallet", tx: "" });

const short = (s: string) => (/^0x[0-9a-f]{40}$/i.test(s) ? `${s.slice(0, 6)}...${s.slice(-4)}` : s);

/** What the Desk did, as a line of the receipt: it wrote something, at that moment. */
export function deskLine(d: DeskNote, i = 0): LedgerEvent {
  const text = d.kind === "opening" ? `opened a credit file on ${short(d.subject)}`
    : d.kind === "file" ? `updated the credit file of ${short(d.subject)}`
    : d.kind === "reason" ? "wrote down why an advance was allowed"
    : `wrote its letter on ${d.subject}`;
  return { n: order(d.at, 50 + i), at: d.at, kind: "desk", text, amount: "", tx: "" };
}
