// Every number and time on the page goes through here, so they are written one way everywhere.
import type { Agent } from "./types";

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
export const int = (n: number): string => whole.format(Math.round(n));
/** 0.0200 ETH: four places, which is what a job's bill needs. */
export const eth = (n: number, places = 4): string => `${n.toFixed(places)} ETH`;
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

/** How far the pool will go for an agent: its own bond, plus the fees its settled jobs have paid in. Counted once:
 *  an agent can then never take more out of the pool than it has put in. */
export const poolLimit = (a: Pick<Agent, "bondEth" | "feesPaidEth">): number => a.bondEth + a.feesPaidEth;
/** What it can still draw from the pool right now. */
export const canDraw = (a: Pick<Agent, "bondEth" | "feesPaidEth" | "drawnEth" | "advancesMissed">): number => (a.advancesMissed > 0 ? 0 : Math.max(0, poolLimit(a) - a.drawnEth));

/** The score, part by part, by the one public formula. Nobody sets it by hand, and it moves no money. */
export type ScorePart = { name: string; value: string; points: number; max: number };
type Scored = Pick<Agent, "feesPaidEth" | "customers" | "settled" | "since" | "advancesRepaid" | "advancesMissed" | "settledAtHalf" | "notDelivered">;
export function scoreParts(a: Scored, asOf: string): ScorePart[] {
  const days = a.settled ? Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(a.since)) / 86_400_000)) : 0;
  const part = (name: string, value: string, raw: number, max: number): ScorePart => ({ name, value, points: Math.min(max, Math.floor(raw + 1e-9)), max });
  return [
    part("Fees paid into the pool", eth(a.feesPaidEth), a.feesPaidEth / 0.0005, 350),
    part("Different customers", String(a.customers), a.customers * 25, 250),
    part("Jobs settled", String(a.settled), a.settled * 10, 200),
    part("Days since its first job", String(days), days * 2, 100),
    part("Advances repaid", `${a.advancesRepaid} of ${a.advancesRepaid + a.advancesMissed}`, a.advancesRepaid * 10, 100),
  ];
}
export const scoreOf = (a: Scored, asOf: string): number => (a.advancesMissed > 0 ? 0 : Math.max(0, scoreParts(a, asOf).reduce((n, p) => n + p.points, 0) - 50 * a.settledAtHalf - 100 * a.notDelivered));

export const STATE_WORD: Record<string, string> = { locked: "Locked", advanced: "Advanced", delivered: "Delivered", settled: "Settled", half: "Settled at half", declined: "Declined", refunded: "Refunded", not_repaid: "Not repaid", burned: "Burned", bond: "Bond", pool_in: "Pool" };
export const STATE_TONE: Record<string, "" | "go" | "warn" | "bad"> = { locked: "", advanced: "go", delivered: "warn", settled: "go", half: "warn", declined: "", refunded: "bad", not_repaid: "bad", burned: "go", bond: "", pool_in: "" };
export const ADVANCE_WORD: Record<string, string> = { customer: "allowed by the customer", pool: "from the pool", compute: "paid as compute" };
