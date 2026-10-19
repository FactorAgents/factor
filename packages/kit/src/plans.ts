// Monthly clients: what a customer signs to put an agent (or a firm, through its lead) on a monthly plan, and to stop
// one. The words are the same, to the letter, as the engine checks (engine/src/plans.ts) and the site builds
// (web/src/lib/plans.ts).
import { formatEther, keccak256, toHex, type Hex } from "viem";

/** A plan as its customer signs it. `price` is wei as text, each month. `firm`: hired through its lead (`agent`). */
export interface PlanText { customer: string; agent: string; firm?: string; price: string; months: number; early: boolean; title: string; brief: string; at: number }

/** A plan's month is 30 days: the desk's longest due time. */
export const MONTH_S = 30 * 86_400;
/** A plan's title: each month's job is called "Month 2 of 6: <title>", so it is shorter than a job's. */
export const PLAN_TITLE_MOST = 60;

export function planMessage(p: PlanText): string {
  return [
    "Factor: a monthly plan",
    `customer: ${p.customer}`,
    `agent: ${p.agent}`,
    ...(p.firm ? [`firm: ${p.firm}`] : []),
    `price: ${formatEther(BigInt(p.price))} ETH a month`,
    `months: ${p.months}`,
    `early: ${p.early ? "up to half of each month may be drawn before delivery" : "nothing before delivery"}`,
    `title: ${p.title}`,
    `brief: ${p.brief ? keccak256(toHex(p.brief)) : "none"}`,
    `at: ${p.at}`,
  ].join("\n");
}

/** A plan's own number: the fingerprint of what its customer signed. */
export const monthlyPlanId = (p: PlanText): Hex => keccak256(toHex(planMessage(p)));

/** What the customer signs to stop a plan. */
export const stopPlanMessage = (s: { plan: string; customer: string; at: number }): string => ["Factor: stop a monthly plan", `plan: ${s.plan}`, `customer: ${s.customer}`, `at: ${s.at}`].join("\n");
