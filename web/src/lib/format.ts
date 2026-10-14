// Every number and time on the page goes through here, so they are written one way everywhere.
import type { Agent } from "./types";

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
export const int = (n: number): string => whole.format(Math.round(n));
/** 0.0200 ETH: four places, which is what a job's bill needs. */
// An amount that is something is never printed as nothing: a fee too small for the usual places gets the places it
// needs (a 1% fee on a small advance is 0.000042 ETH, not 0.0000 ETH).
export const eth = (n: number, places = 4): string => {
  let p = places;
  while (p < 8 && n !== 0 && Number(Math.abs(n).toFixed(p)) === 0) p++;
  if (p > places && p < 8) p++;
  return `${n.toFixed(p)} ETH`;
};
/** Dollars, for compute credit: cents, and the parts of a cent when it is under a dollar. */
export const usd = (n: number): string => `$${n.toFixed(n > 0 && n < 1 ? 4 : 2)}`;
/** 1.84 for the big figures, with the unit set beside it by the page. */
export const ethShort = (n: number): string => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
export const millions = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}` : int(n));
export const pct = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

const two = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 18:42:07, in UTC. */
export const clock = (iso: string): string => { const d = new Date(iso); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`; };
/** 12 Oct, 18:42 UTC */
export const dayTime = (iso: string): string => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`; };
export const day = (iso: string): string => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
/** 0x55ce…44dc */
export const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
/** two letters for an agent's tile: lumen-07 becomes L7 */
export const initials = (name: string): string => { const parts = name.split(/[-\s]+/).filter(Boolean); const a = parts[0]?.[0] ?? "?"; const last = parts.length > 1 ? parts[parts.length - 1] : parts[0].slice(1); const b = /\d/.test(last) ? last.replace(/\D/g, "").slice(-1) : last[0] ?? ""; return (a + b).toUpperCase(); };

/** Where an agent's page is: under its name when it has signed one, under its address otherwise. */
export const agentHref = (a: Pick<Agent, "name" | "named" | "address">): string => `/agents/${a.named ? a.name : a.address}`;
/** A transaction or an address on the chain's explorer. */
export const txHref = (explorer: string, tx: string): string => `${explorer}/tx/${tx}`;
export const addressHref = (explorer: string, address: string): string => `${explorer}/address/${address}`;
/** in 3 hours, 20 minutes ago: for a due time or a deadline, from a moment given (the page's own reading of now). */
export function fromNow(iso: string, nowIso: string): string {
  const s = Math.round((Date.parse(iso) - Date.parse(nowIso)) / 1000), a = Math.abs(s);
  const n = a < 90 ? [a, "second"] as const : a < 5400 ? [Math.round(a / 60), "minute"] as const : a < 129_600 ? [Math.round(a / 3600), "hour"] as const : [Math.round(a / 86_400), "day"] as const;
  const text = `${n[0]} ${n[1]}${n[0] === 1 ? "" : "s"}`;
  return s >= 0 ? `in ${text}` : `${text} ago`;
}

export const STATE_WORD: Record<string, string> = { block: "On chain", desk: "The Desk", ready: "At launch", locked: "Locked", advanced: "Advanced", delivered: "Delivered", settled: "Settled", half: "Settled at half", declined: "Declined", refunded: "Refunded", not_repaid: "Not repaid", burned: "Burned", bond: "Bond", pool_in: "Pool" };
export const STATE_TONE: Record<string, "" | "go" | "warn" | "bad"> = { block: "", desk: "go", ready: "go", locked: "", advanced: "go", delivered: "warn", settled: "go", half: "warn", declined: "", refunded: "bad", not_repaid: "bad", burned: "go", bond: "", pool_in: "" };
export const ADVANCE_WORD: Record<string, string> = { customer: "allowed by the customer", pool: "from the pool", compute: "paid as compute" };
