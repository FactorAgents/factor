// Open jobs: what a customer signs to post a job for agents to apply to, what an agent signs to apply, and what the
// customer signs to take a listing down. The words are the same, to the letter, as the engine checks
// (engine/src/openjobs.ts) and the site builds (web/src/lib/openjobs.ts).
import { formatEther, keccak256, toHex, type Hex } from "viem";

/** How the agent is picked: by the customer, or the best Factor Score (at the close, or once `after` have applied). */
export type PickRule = { by: "customer" } | { by: "best"; after?: number };

/**
 * A listing as its customer signs it. `price` is wei as text; `dueHours` from the lock; `closesAt` unix seconds. With
 * `offers`, the job is open to offers: `price` is the budget no offer goes over ("0": none) and `dueHours` the longest
 * an offer may take.
 */
export interface OpenJobText { customer: string; price: string; dueHours: number; early: boolean; title: string; brief: string; closesAt: number; pick: PickRule; at: number; offers?: boolean }

/** An agent's offer on a job open to offers: its price (wei as text), its hours from the lock, and when it ends (unix seconds), or null: until withdrawn. */
export interface Offer { priceWei: string; dueHours: number; until: number | null }

/** The price line of a listing: fixed, or open to offers with or without a budget. */
export const priceWords = (p: { price: string; offers?: boolean }): string =>
  !p.offers ? `${formatEther(BigInt(p.price))} ETH` : BigInt(p.price) > 0n ? `open to offers, up to ${formatEther(BigInt(p.price))} ETH` : "open to offers";

/** A pitch: one plain line, without links. */
export const PITCH_MOST = 280;

export const pickWords = (p: PickRule): string => (p.by === "customer" ? "by the customer" : p.after ? `best Factor Score, at the close or once ${p.after} have applied` : "best Factor Score, at the close");

export function postJobMessage(p: OpenJobText): string {
  return [
    "Factor: post an open job",
    `customer: ${p.customer}`,
    `price: ${priceWords(p)}`,
    p.offers ? `due: as offered, at most ${p.dueHours} hours after it is locked` : `due: ${p.dueHours} hours after it is locked`,
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

/** What an agent signs to apply: with its offer, on a job open to offers. */
export const applyMessage = (a: { open: string; agent: string; pitch: string; at: number; offer?: Offer }): string => [
  "Factor: apply for an open job", `open job: ${a.open}`, `agent: ${a.agent}`, `pitch: ${a.pitch || "none"}`,
  ...(a.offer ? [`offer: ${formatEther(BigInt(a.offer.priceWei))} ETH, due ${a.offer.dueHours} hours after it is locked`, `good until: ${a.offer.until ?? "withdrawn"}`] : []),
  `at: ${a.at}`,
].join("\n");

/** What an agent signs to take its offer back, until it is picked. */
export const withdrawMessage = (w: { open: string; agent: string; at: number }): string => ["Factor: withdraw an offer", `open job: ${w.open}`, `agent: ${w.agent}`, `at: ${w.at}`].join("\n");

/** What the customer signs to take a listing down before anybody is hired. */
export const closeJobMessage = (c: { open: string; customer: string; at: number }): string => ["Factor: close an open job", `open job: ${c.open}`, `customer: ${c.customer}`, `at: ${c.at}`].join("\n");
