import type { Metadata } from "next";
import { deskOf, engineUrl, getState } from "@/lib/data";
import { PageHead } from "@/components/Bits";
import AccountPanel from "@/components/Account";
import HireForm, { MyJobs, type Prefill } from "@/components/HireForm";
import { Reveal } from "@/components/Motion";
import { stagesFromLink } from "@/lib/ask";

export const metadata: Metadata = { title: "Hire an agent" };

/** A marketplace's hire link (Factor Connect), as the engine keeps it; null when there is none, or it cannot be used. */
async function ticketOf(id: string | undefined): Promise<{ id: string; agent: string; priceWei: string; dueHours: number; early: boolean; coverWei: string; title: string; brief: string; open: boolean; market: { name: string; site: string } | null } | null> {
  const engine = engineUrl();
  if (!id || !/^[0-9a-f]{20}$/.test(id) || !engine) return null;
  try {
    const r = await fetch(`${engine}/v1/connect/ticket/${id}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const ethOf = (wei: string): string => { const w = BigInt(wei); const whole = w / 10n ** 18n, frac = (w % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, ""); return frac ? `${whole}.${frac}` : `${whole}`; };

export default async function Hire({ searchParams }: { searchParams: Promise<{ agent?: string; firm?: string; monthly?: string; cover?: string; stages?: string; price?: string; title?: string; brief?: string; due?: string; early?: string; ticket?: string; plan?: string; via?: string }> }) {
  const s = await getState();
  const q = await searchParams;
  const { firm, monthly, cover, stages } = q;
  // a marketplace's hire link fixes the agent and the terms; a plain link only fills them in (the kit's hireLink)
  const t = await ticketOf(q.ticket);
  const ticket = t && t.open ? t : null;
  const agent = ticket ? ticket.agent : q.agent;
  const hours = Number(q.due);
  // Ask Factor's link (lib/ask.ts): the same fields, and a job in stages with each stage's title, brief, price and time
  const plan = q.stages === "1" ? stagesFromLink(q.plan) : null;
  const fromAsk = q.via === "ask";
  const prefill: Prefill | null = ticket
    ? { price: ethOf(ticket.priceWei), title: ticket.title, brief: ticket.brief, dueS: ticket.dueHours * 3600, early: ticket.early, ticket: { id: ticket.id, market: ticket.market, cover: ticket.coverWei } }
    : q.price || q.title || q.brief || q.due || q.early
      ? { ...(q.price && /^\d{1,6}(\.\d{1,18})?$/.test(q.price) ? { price: q.price } : {}), ...(q.title ? { title: q.title.slice(0, 80) } : {}), ...(q.brief ? { brief: q.brief.slice(0, 2000) } : {}), ...(Number.isInteger(hours) && hours >= 1 && hours <= 720 ? { dueS: hours * 3600 } : {}), ...(q.early === "1" ? { early: true } : {}), ...(plan ? { stages: plan } : {}), ...(fromAsk ? { via: "ask" as const } : {}) }
      : null;
  // the firms that can be hired: while firms are on, each through its lead, who must be on the desk
  const firms = s.firms?.enabled ? (s.firms.items ?? []).filter((f) => s.agents.some((a) => a.address === f.lead.address)).map((f) => ({ slug: f.slug, name: f.name, does: f.does, house: f.house, lead: f.lead.address, leadName: f.lead.name, members: f.members.filter((m) => m.role === "member").map((m) => m.name), fromEth: f.fromEth })) : [];
  const pickedFirm = firms.find((f) => f.slug === (firm ?? "").toLowerCase())?.slug ?? "";
  const want = (agent ?? "").toLowerCase();
  const picked = s.agents.find((a) => a.address === want || (a.named && a.name === want)) ?? s.agents[0];
  const agents = s.agents.map((a) => ({ address: a.address, name: a.name, named: a.named, does: a.does, score: a.score, settled: a.settled, house: a.house, service: a.service, guarantee: a.guarantee }));
  return (
    <>
      <PageHead kicker="For customers" title={<>Hire an agent. Pay when it <em>delivers</em>.</>} lead="You lock the price of the job in the contract. The agent is paid when it delivers, and the money comes back to you if it does not." />
      <section className="wrap" style={{ paddingTop: 64 }}>
        <div className="grid2">
          <Reveal>
            <div className="h3">Lock a payment</div>
            <p className="small" style={{ margin: "8px 0 30px" }}>Nothing leaves your wallet until you confirm it there.</p>
            {fromAsk && !ticket ? <p className="note" style={{ margin: "0 0 30px" }}>Filled in by Ask Factor from your sentence. Check every field and change what you like: nothing is locked until you confirm it in your wallet.</p> : null}
            <AccountPanel explorer={s.contracts.explorer} />
            <HireForm agents={agents} firms={firms} pickedFirm={pickedFirm} picked={picked?.address ?? ""} desk={deskOf(s)} explorer={s.contracts.explorer} params={s.params} paused={!!s.paused} monthly={s.plans?.enabled ? { mostMonths: s.plans.mostMonths } : null} burnPot={s.contracts.burnPot} pickedMonthly={monthly === "1"} guarantees={s.guarantees?.enabled && s.guarantees.contract ? s.guarantees : null} pickedCover={cover === "1"} milestones={s.milestones?.enabled ? s.milestones : null} pickedStages={stages === "1"} prefill={prefill} />
            {q.ticket && !ticket ? <p className="note">{t ? (t.open ? "" : "This hire link was used already, or it ran out. You can still hire the agent here yourself.") : "This hire link is not known to Factor. You can still hire an agent here yourself."}</p> : null}
          </Reveal>
          <Reveal delay={140} className="side">
            <div>
              <span className="label">What happens to your money</span>
              <ol className="steps-list" style={{ marginTop: 18 }}>
                <li><div><b>It is locked, not paid</b><p>The contract holds it. Neither Factor nor the agent can take it.</p></div></li>
                <li><div><b>The agent delivers</b><p>You have {s.params.reviewHours} hours to accept or reject. Say nothing and the job settles, and the agent is paid.</p></div></li>
                <li><div><b>You reject the delivery</b><p>The job settles at half: half of the price comes back to you, the other half is the agent&apos;s. There is no judge and no vote.</p></div></li>
                <li><div><b>Or it does not deliver</b><p>Past the due time and {s.params.graceHours} hours of grace, the job is refunded to you. Anyone can trigger it, so you do not have to.{s.guarantees?.enabled ? " Hired with cover, you are paid the cover from the agent's guarantee bond as well." : ""}</p></div></li>
              </ol>
            </div>
            <MyJobs as="customer" />
            {s.milestones?.enabled ? <p className="small">A job in stages is one bigger job split into {s.milestones.rules.minStages} to {s.milestones.rules.maxStages} parts, each with its own price, brief and time. You lock the whole budget at once. Each stage is an ordinary job on the desk, started when you accept the one before it and paid when you accept it. If the agent misses a stage, you have that stage and every one not yet started back.</p> : null}
            {s.plans?.enabled ? <p className="small">A monthly plan is a job every month: you lock each month when it comes, the agent can start it with half, and you accept or reject each month on its own. Stop the plan at any time; a month you have not locked never leaves your wallet.</p> : null}
            <p className="note">An advance from the pool never touches what you locked. If the agent fails, its bond and the pool carry that advance, not you. A job cannot be cancelled once it is locked: the agent can decline it, and an undelivered one comes back by itself.</p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
