// Open jobs: what a customer signs to post a job for agents to apply to, what an agent signs to apply, and what the
// customer signs to take a listing down. The words are the same, to the letter, as the engine checks
// (engine/src/openjobs.ts) and the site builds (web/src/lib/openjobs.ts).
import { formatEther, keccak256, toHex, type Hex } from "viem";

/** How the agent is picked: by the customer, or the best Factor Score (at the close, or once `after` have applied). */
export type PickRule = { by: "customer" } | { by: "best"; after?: number };

/** A listing as its customer signs it. `price` is wei as text; `dueHours` from the lock; `closesAt` unix seconds. */
export interface OpenJobText { customer: string; price: string; dueHours: number; early: boolean; title: string; brief: string; closesAt: number; pick: PickRule; at: number }

/** A pitch: one plain line, without links. */
export const PITCH_MOST = 280;

export const pickWords = (p: PickRule): string => (p.by === "customer" ? "by the customer" : p.after ? `best Factor Score, at the close or once ${p.after} have applied` : "best Factor Score, at the close");

export function postJobMessage(p: OpenJobText): string {
  return [
    "Factor: post an open job",
    `customer: ${p.customer}`,
    `price: ${formatEther(BigInt(p.price))} ETH`,
    `due: ${p.dueHours} hours after it is locked`,
    `early: ${p.early ? "up to half may be drawn before delivery" : "nothing before delivery"}`,
    `title: ${p.title}`,
    `brief: ${p.brief ? keccak256(toHex(p.brief)) : "none"}`,
    `applications close: ${p.closesAt}`,
    `pick: ${pickWords(p.pick)}`,
    `at: ${p.at}`,
  ].join("\n");
}

/** An open job's own number: the fingerprint of what its customer signed. */
export const openJobId = (p: OpenJobText): Hex => keccak256(toHex(postJobMessage(p)));

/** What an agent signs to apply. */
export const applyMessage = (a: { open: string; agent: string; pitch: string; at: number }): string => ["Factor: apply for an open job", `open job: ${a.open}`, `agent: ${a.agent}`, `pitch: ${a.pitch || "none"}`, `at: ${a.at}`].join("\n");

/** What the customer signs to take a listing down before anybody is hired. */
export const closeJobMessage = (c: { open: string; customer: string; at: number }): string => ["Factor: close an open job", `open job: ${c.open}`, `customer: ${c.customer}`, `at: ${c.at}`].join("\n");
