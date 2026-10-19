// Monthly clients, from a visitor's wallet: what a customer signs to put an agent (or a firm, through its lead) on a
// monthly plan, and to stop one; and each month locked on the desk with its share for the burn. The words signed are
// the same, to the letter, as the engine checks (engine/src/plans.ts) and the kit signs (packages/kit/src/plans.ts).
import { formatEther, keccak256, toHex } from "viem";
import { lockAndBurn, lockedJob, Refusal } from "./desk";
import { signText, type Provider } from "./wallet";

export interface PlanText { customer: string; agent: string; firm?: string; price: string; months: number; early: boolean; title: string; brief: string; at: number }

/** A plan's month is 30 days: the desk's longest due time. */
export const MONTH_S = 30 * 86_400;
/** A plan's title: each month's job is called "Month 2 of 6: <title>". */
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

export const stopPlanMessage = (s: { plan: string; customer: string; at: number }): string => ["Factor: stop a monthly plan", `plan: ${s.plan}`, `customer: ${s.customer}`, `at: ${s.at}`].join("\n");

const said = (e: string | undefined, fallback: string): string => { const t = e ?? fallback; return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : "."); };

/** A post to the engine through the site, asked again while the engine has not read a brand new lock yet. */
export async function askPlans<T>(path: "plans/create" | "plans/month" | "plans/stop", body: Record<string, unknown>): Promise<T> {
  for (let tries = 0; ; tries++) {
    const r = await fetch(`/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const b = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (r.ok) return b;
    if (r.status === 404 && tries < 20) { await new Promise((res) => setTimeout(res, 1500)); continue; }
    throw new Refusal(said(b.error, "Factor did not take it"));
  }
}

/** The customer signs the plan: nothing is locked yet. Answers the plan's number and what a month adds to the burn. */
export async function signPlan(p: Provider, plan: PlanText, link?: string): Promise<{ plan: string; burnWei: string }> {
  const signature = await signText(p, planMessage(plan), plan.customer);
  return askPlans<{ plan: string; burnWei: string }>("plans/create", { ...plan, signature, ...(link ? { link } : {}) });
}

/**
 * One month locked on the desk for the plan's agent, with its share sent to the burn pot beside it, then linked to the
 * plan. The money is locked for the agent whatever happens to the link: a month Factor did not link is an ordinary job.
 */
export async function lockMonth(p: Provider, o: { passkey: boolean; desk: string; burnPot: string | null; from: string; plan: string; agent: string; dueAt: number; early: boolean; price: bigint; burn: bigint; on: (step: "checking" | "wallet" | "mining" | "signing" | "saving") => void }): Promise<{ job: number | null; lockTx: string; month: number | null; linked: boolean; note?: string; burned: boolean }> {
  const burn = o.burnPot ? o.burn : 0n;
  const { lockTx, burnTx, receipt } = await lockAndBurn(p, { passkey: o.passkey, desk: o.desk, from: o.from, agent: o.agent, dueAt: o.dueAt, early: o.early, price: o.price, burnPot: o.burnPot ?? "", burn, on: o.on });
  const job = lockedJob(receipt, o.desk);
  if (job === null) return { job: null, lockTx, month: null, linked: false, burned: false, note: "The month is locked; its job number could not be read from the transaction." };
  o.on("saving");
  try {
    const r = await askPlans<{ month: number; burned?: boolean }>("plans/month", { plan: o.plan, job, lockTx, burnTx });
    return { job, lockTx, month: r.month, linked: true, burned: r.burned === true };
  } catch (e) {
    return { job, lockTx, month: null, linked: false, burned: false, note: e instanceof Error ? e.message : "Factor did not answer." };
  }
}

/** The customer signs to stop the plan. */
export async function stopPlan(p: Provider, plan: string, customer: string, at: number): Promise<{ notStarted: number[] }> {
  const signature = await signText(p, stopPlanMessage({ plan, customer, at }), customer);
  return askPlans<{ notStarted: number[] }>("plans/stop", { plan, at, signature });
}
