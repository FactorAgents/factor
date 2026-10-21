// Open jobs, from a visitor's wallet: what a customer signs to post a job for agents to apply to and to take it down,
// what an agent signs to apply, and the price locked for the agent picked, with its share for the burn. The words are
// the same, to the letter, as the engine checks (engine/src/openjobs.ts) and the kit signs (packages/kit/src/openjobs.ts).
import { formatEther, keccak256, toHex } from "viem";
import { lockAndBurn, lockedJob, Refusal } from "./desk";
import { signText, type Provider } from "./wallet";

export type PickRule = { by: "customer" } | { by: "best"; after?: number };
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

export const applyMessage = (a: { open: string; agent: string; pitch: string; at: number }): string => ["Factor: apply for an open job", `open job: ${a.open}`, `agent: ${a.agent}`, `pitch: ${a.pitch || "none"}`, `at: ${a.at}`].join("\n");
export const closeJobMessage = (c: { open: string; customer: string; at: number }): string => ["Factor: close an open job", `open job: ${c.open}`, `customer: ${c.customer}`, `at: ${c.at}`].join("\n");

const said = (e: string | undefined, fallback: string): string => { const t = e ?? fallback; return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : "."); };

/** A post to the engine through the site, asked again while the engine has not read a brand new lock yet. */
export async function askOpen<T>(path: "openjobs/post" | "openjobs/apply" | "openjobs/hire" | "openjobs/close", body: Record<string, unknown>): Promise<T> {
  for (let tries = 0; ; tries++) {
    const r = await fetch(`/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const b = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (r.ok) return b;
    if (r.status === 404 && path === "openjobs/hire" && tries < 20) { await new Promise((res) => setTimeout(res, 1500)); continue; }
    throw new Refusal(said(b.error, "Factor did not take it"));
  }
}

/** The customer signs the listing: nothing is locked. Answers the open job's number. */
export async function signPost(p: Provider, job: OpenJobText): Promise<{ open: string; created: boolean }> {
  const signature = await signText(p, postJobMessage(job), job.customer);
  return askOpen<{ open: string; created: boolean }>("openjobs/post", { customer: job.customer, price: job.price, dueHours: job.dueHours, early: job.early, title: job.title, brief: job.brief, closesAt: job.closesAt, pick: job.pick.by, ...(job.pick.by === "best" && job.pick.after ? { pickAfter: job.pick.after } : {}), at: job.at, signature });
}

/** An agent signs that it applies. Answers where it stands among the applicants. */
export async function signApply(p: Provider, a: { open: string; agent: string; pitch: string; at: number }): Promise<{ rank: number; of: number; listing: string }> {
  const signature = await signText(p, applyMessage(a), a.agent);
  return askOpen<{ rank: number; of: number; listing: string }>("openjobs/apply", { ...a, signature });
}

/** The customer signs to take the listing down. */
export async function signClose(p: Provider, c: { open: string; customer: string; at: number }): Promise<void> {
  const signature = await signText(p, closeJobMessage(c), c.customer);
  await askOpen("openjobs/close", { open: c.open, at: c.at, signature });
}

/**
 * The price locked on the desk for the agent picked, with its share sent to the burn pot beside it, then linked to the
 * listing. The money is locked for the agent whatever happens to the link: a lock Factor did not link is an ordinary job.
 */
export async function lockForOpen(p: Provider, o: { passkey: boolean; desk: string; burnPot: string | null; from: string; open: string; agent: string; dueAt: number; early: boolean; price: bigint; burn: bigint; on: (step: "checking" | "wallet" | "mining" | "signing" | "saving") => void }): Promise<{ job: number | null; lockTx: string; linked: boolean; note?: string; burned: boolean }> {
  const burn = o.burnPot ? o.burn : 0n;
  const { lockTx, burnTx, receipt } = await lockAndBurn(p, { passkey: o.passkey, desk: o.desk, from: o.from, agent: o.agent, dueAt: o.dueAt, early: o.early, price: o.price, burnPot: o.burnPot ?? "", burn, on: o.on });
  const job = lockedJob(receipt, o.desk);
  if (job === null) return { job: null, lockTx, linked: false, burned: false, note: "The price is locked; the job's number could not be read from the transaction." };
  o.on("saving");
  try {
    const r = await askOpen<{ burned?: boolean }>("openjobs/hire", { open: o.open, job, lockTx, burnTx });
    return { job, lockTx, linked: true, burned: r.burned === true };
  } catch (e) {
    return { job, lockTx, linked: false, burned: false, note: e instanceof Error ? e.message : "Factor did not answer." };
  }
}

/** How a listing's status is said on a page. */
export const STATUS_WORD: Record<string, string> = { open: "Taking applications", choosing: "Customer choosing", picked: "Agent picked", hired: "Hired", closed: "Taken down", expired: "Expired" };
