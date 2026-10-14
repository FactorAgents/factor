// Before the launch there is no desk and no token, so nothing has happened that the ledger could print. The site
// makes nothing up. What it prints then is the one thing that is already true: Factor's own agents, as the engine
// lists them, each with what it does and what it takes a job for. They open the desk at the launch.
//
// From the launch on none of this is used: the ledger prints what the contracts did and nothing else.

import type { Beat, FactorState, LedgerEvent, RosterAgent } from "./types";

/** Nothing is live yet (and this is not the sample the site is built against). */
export const beforeLaunch = (s: FactorState): boolean => s.source !== "sample" && !s.launched && s.agents.length === 0 && s.events.length === 0;

const lower = (s: string) => (/^[A-Z][a-z ]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/** One line for each of Factor's own agents: its name, what it does, and its price. All of it is true today. */
export const launchLines = (roster: RosterAgent[], asOf: string): LedgerEvent[] =>
  roster.map((a, i) => ({ n: roster.length - i, at: asOf, kind: "ready", text: `${a.name} · ${lower(a.does)}`, amount: `from ${a.fromEth.toFixed(3)} ETH`, tx: "" }));

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

/** Before the launch one of Factor's own agents is printed after every few blocks, in turn. */
export const AGENT_EVERY = 2;

/** One of Factor's own agents as a line printed at a given moment, numbered just under the block it follows. */
export const agentLine = (a: RosterAgent, at: string, n: number): LedgerEvent => ({ n, at, kind: "ready", text: `${a.name} · ${lower(a.does)}`, amount: `from ${a.fromEth.toFixed(3)} ETH`, tx: "" });

/**
 * What the receipt prints. Before the launch: the chain as the desk reads it, block after block, and after every
 * couple of blocks one of Factor's own agents, which open the desk at the launch. After it: the ledger's lines and
 * the blocks in between, in the order they happened, so the paper never stands still while the desk is working.
 */
export function receiptLines(s: FactorState, pre: boolean): LedgerEvent[] {
  const beats = beatLines(s.pulse ?? []);
  if (!pre) return [...beats, ...s.events.map((e, i) => ({ ...e, n: order(e.at, i) }))].sort((a, b) => b.n - a.n);
  const roster = s.roster ?? [];
  if (!beats.length) return launchLines(roster, s.asOf);
  const out: LedgerEvent[] = [];
  // oldest first, so the agents come in the same turn as the receipt goes on printing them
  const up = [...beats].reverse();
  up.forEach((b, i) => {
    out.push(b);
    if (roster.length && (i + 1) % AGENT_EVERY === 0) {
      const k = Math.floor(i / AGENT_EVERY) % roster.length;
      out.push(agentLine(roster[k]!, b.at, b.n + 1));
    }
  });
  return out.reverse();
}

/** How many of the agents the first lines already used: the receipt goes on from the next. */
export const agentsUsed = (beats: number): number => Math.floor(beats / AGENT_EVERY);
