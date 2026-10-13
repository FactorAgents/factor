// Before the launch there is no desk and no token, so nothing has happened that the ledger could print. The site
// makes nothing up. What it prints then is the one thing that is already true: Factor's own agents, as the engine
// lists them, each with what it does and what it takes a job for. They open the desk at the launch.
//
// From the launch on none of this is used: the ledger prints what the contracts did and nothing else.

import type { FactorState, LedgerEvent, RosterAgent } from "./types";

/** Nothing is live yet (and this is not the sample the site is built against). */
export const beforeLaunch = (s: FactorState): boolean => s.source !== "sample" && !s.launched && s.agents.length === 0 && s.events.length === 0;

const lower = (s: string) => (/^[A-Z][a-z ]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/** One line for each of Factor's own agents: its name, what it does, and its price. All of it is true today. */
export const launchLines = (roster: RosterAgent[], asOf: string): LedgerEvent[] =>
  roster.map((a, i) => ({ n: roster.length - i, at: asOf, kind: "ready", text: `${a.name} · ${lower(a.does)}`, amount: `from ${a.fromEth.toFixed(3)} ETH`, tx: "" }));
