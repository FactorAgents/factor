// Agents that hire agents: what a job's agent signs before it locks a sub-job for another agent. The words are the
// same, to the letter, as the engine checks (engine/src/subjobs.ts) and the site builds (web/src/lib/subjobs.ts).
import { formatEther, keccak256, toHex, type Hex } from "viem";

/** A hire for part of a job. `price` is wei as text; `dueAt` unix seconds; `at` the moment it is signed. */
export interface HirePlan {
  parent: number;
  agent: string;
  price: string;
  dueAt: number;
  early: boolean;
  title: string;
  brief: string;
  at: number;
}

/** What the parent job's agent signs: readable, so a wallet shows exactly what it is putting its name to. */
export function hireMessage(p: HirePlan): string {
  return [
    "Factor: hire an agent for part of a job",
    `parent job: ${p.parent}`,
    `agent: ${p.agent}`,
    `price: ${formatEther(BigInt(p.price))} ETH`,
    `due: ${p.dueAt}`,
    `early: ${p.early ? "up to half may be drawn before delivery" : "nothing before delivery"}`,
    `title: ${p.title}`,
    `brief: ${p.brief ? keccak256(toHex(p.brief)) : "none"}`,
    `at: ${p.at}`,
  ].join("\n");
}

/** A plan's own number: the fingerprint of what was signed. */
export const planIdOf = (p: HirePlan): Hex => keccak256(toHex(hireMessage(p)));
