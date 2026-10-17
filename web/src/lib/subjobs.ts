// Agents that hire agents, from a visitor's wallet: the job's agent signs a hire for part of it, Factor checks it and
// holds its room, the wallet locks exactly what was signed, and Factor links the lock under the job. The words signed
// are the same, to the letter, as the engine checks (engine/src/subjobs.ts) and the kit signs (packages/kit).
import { formatEther, keccak256, toHex } from "viem";
import { Refusal } from "./desk";
import { signText, type Provider } from "./wallet";

/** A hire for part of a job. `price` is wei as text; `dueAt` unix seconds; `at` the moment it is signed. */
export interface HirePlan { parent: number; agent: string; price: string; dueAt: number; early: boolean; title: string; brief: string; at: number }

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

const said = (e: string | undefined, fallback: string): string => { const t = e ?? fallback; return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : "."); };

/** The hire, signed by the job's agent and handed to Factor. Nothing is locked here; the room is held for 15 minutes. */
export async function planHire(p: Provider, from: string, plan: HirePlan): Promise<{ plan: string; burnWei: bigint; depth: number }> {
  const signature = await signText(p, hireMessage(plan), from);
  for (let tries = 0; ; tries++) {
    const r = await fetch("/api/v1/subjobs/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...plan, signature }) });
    const b = (await r.json().catch(() => ({}))) as { plan?: string; burnWei?: string; depth?: number; error?: string };
    if (r.ok && b.plan) return { plan: b.plan, burnWei: BigInt(b.burnWei ?? "0"), depth: b.depth ?? 1 };
    if (r.status === 404 && tries < 10) { await new Promise((res) => setTimeout(res, 1500)); continue; }
    throw new Refusal(said(b.error, "Factor did not take the hire"));
  }
}

/** The lock on the chain, linked under the job by the plan it carries out. Asked again while the engine catches up. */
export async function linkHire(body: { plan: string; job: number; lockTx: string; burnTx: string | null }): Promise<{ burned: boolean }> {
  for (let tries = 0; ; tries++) {
    const r = await fetch("/api/v1/subjobs/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const b = (await r.json().catch(() => ({}))) as { burned?: boolean; error?: string };
    if (r.ok) return { burned: b.burned === true };
    if (r.status === 404 && /not yet|not mined/.test(b.error ?? "") && tries < 20) { await new Promise((res) => setTimeout(res, 1500)); continue; }
    throw new Refusal(said(b.error, "Factor could not link it under the job"));
  }
}
