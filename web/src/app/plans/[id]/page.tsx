import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { deskOf, getPlan, getState } from "@/lib/data";
import { Seal, SecHead, Tag } from "@/components/Bits";
import PlanActions from "@/components/PlanActions";
import { Count, Reveal } from "@/components/Motion";
import { addressHref, day, dayTime, eth, short } from "@/lib/format";
import type { Plan } from "@/lib/types";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const got = await getPlan((await params).id);
  return { title: got && got !== "down" ? `A monthly plan: ${got.plan.title}` : "A monthly plan" };
}

const STATUS: Record<Plan["status"], string> = { waiting: "Signed, month 1 not locked yet", active: "Running", stopped: "Stopped by the customer", ended: "Ended", lapsed: "Lapsed", done: "Every month done" };

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const [s, got] = await Promise.all([getState(), getPlan((await params).id)]);
  if (got === "down") return <section className="wrap page-head"><Link className="more quiet back" href="/hire">← Hire</Link><h1 className="h1">This plan&apos;s page is not arriving right now.</h1><p className="lead">Its months are on the chain and are not lost. Try again in a moment.</p></section>;
  if (!got) notFound();
  const { plan: p, burnWei } = got;
  const ex = s.contracts.explorer;
  const now = Date.parse(s.asOf);
  const who = p.firm ? p.firm.name : p.agent.name;
  const agentLink = `/agents/${p.agent.named ? p.agent.name : p.agent.address}`;
  const months = Array.from({ length: p.months }, (_, i) => p.items.find((m) => m.month === i + 1) ?? null);
  const upFront = p.items.reduce((n, m) => n + m.upFrontEth, 0), nextEarly = p.items.reduce((n, m) => n + (m.nextEarlyEth ?? 0), 0);
  const early = p.drawEarly;
  return (
    <>
      <section className="wrap page-head">
        <Link className="more quiet back" href={p.firm ? `/firms/${p.firm.slug}` : agentLink}>← {who}</Link>
        <div style={{ marginTop: 26 }}><span className="kicker"><i />A monthly plan</span></div>
        <h1 className="h1">{p.title}</h1>
        <p className="small mono" style={{ marginTop: 12, color: "var(--dim)" }}>{eth(p.priceEth)} a month · {p.months} months · {STATUS[p.status]}{p.startAt ? ` · since ${day(p.startAt)}` : ""}</p>
        <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", marginTop: 28 }}>
          <Seal name={p.firm ? p.firm.name : p.agent.named ? p.agent.name : p.agent.address.slice(2)} />
          <div>
            <div className="h3" style={{ fontSize: 22 }}>{p.firm ? <><Link href={`/firms/${p.firm.slug}`}>{p.firm.name}</Link><span className="small" style={{ marginLeft: 10 }}>led by <Link className="more quiet" href={agentLink}>{p.agent.name}</Link></span></> : <Link href={agentLink}>{p.agent.name}</Link>}</div>
            <p className="small">for <a href={addressHref(ex, p.customer)} target="_blank" rel="noopener noreferrer">{short(p.customer)}</a>, the customer who signed the plan</p>
          </div>
        </div>
        <p className="lead" style={{ marginTop: 26 }}>Every month&apos;s payment is locked on Robinhood Chain before its work starts. {p.early ? `${who} can start each month with up to half of it.` : `${who} is paid each month when the customer accepts it.`} Each month is accepted or rejected on its own.</p>
        {p.note ? <p className="note" style={{ marginTop: 20 }}>{p.note.charAt(0).toUpperCase() + p.note.slice(1)}.</p> : null}
      </section>

      <section className="wrap" style={{ paddingTop: 56 }}>
        <Reveal><div className="firm-figs">
          <div><span className="label">Months delivered</span><div className="big num"><Count to={p.delivered} /><span style={{ color: "var(--dim)", fontSize: "0.5em" }}> of {p.months}</span></div></div>
          <div><span className="label">Paid up front</span><div className={`big num${upFront ? "" : " none"}`}>{upFront ? eth(upFront) : "nothing yet"}</div></div>
          <div><span className="label">Next month early</span><div className={`big num${nextEarly ? "" : " none"}`}>{nextEarly ? eth(nextEarly) : "nothing yet"}</div></div>
          <div><span className="label">Paid on delivery</span><div className={`big num${p.paidEth ? "" : " none"}`}>{p.paidEth ? eth(p.paidEth) : "nothing yet"}</div></div>
        </div></Reveal>
      </section>

      <section className="wrap sec" id="months" style={{ paddingTop: 72 }}>
        <Reveal><SecHead n="" kicker="The months" title={<>Locked month by <em>month</em>.</>} lead="Each month is its own job on the desk: the customer locks it, the agent can start with half, delivers, and is paid when the customer accepts. The next month can be locked once this one is delivered." /></Reveal>
        <Reveal delay={120}><div className="sec-body">
          <div className="plan-months" style={{ ["--n" as string]: String(Math.min(p.months, 4)) }}>
            {months.map((m, i) => {
              const n = i + 1;
              if (!m) {
                const next = p.next?.month === n;
                return (
                  <div key={n} className="plan-month todo">
                    <div className="no"><span>Month {n}</span></div>
                    <div className="amt">{eth(p.priceEth)}</div>
                    <div className="st"><span className="tag">{next && p.next?.open ? "Ready to lock" : p.status === "active" || p.status === "waiting" ? "Not locked yet" : "Never locked"}</span></div>
                    <div className="when">{next && p.next ? (p.next.open ? `Can be locked now, due ${dayTime(p.next.dueAt!)}.` : `${p.next.why ? `${p.next.why.charAt(0).toUpperCase()}${p.next.why.slice(1)}.` : ""}${p.next.from ? ` Or from ${dayTime(p.next.from)}.` : ""}`) : p.status === "active" || p.status === "waiting" ? "Locked when it comes." : "It never left the customer's wallet."}</div>
                  </div>
                );
              }
              const begins = Date.parse(m.beginsAt);
              const ahead = now < begins && (m.state === "locked" || m.state === "advanced");
              const paid = m.state === "settled" || m.state === "half";
              const started = m.upFrontEth > 0 || m.fromPoolEth > 0;
              return (
                <div key={n} className={`plan-month${paid ? " paid" : started ? " open" : ""}${ahead ? " ahead" : ""}`}>
                  <div className="no"><span>Month {n}</span><Link href={`/jobs/${m.id}`}>job {m.id}</Link></div>
                  <div className="amt">{eth(p.priceEth)}</div>
                  <div className="st"><Tag kind={m.state} />{ahead ? <span className="in-firm">Next month</span> : null}</div>
                  <div className="rows">
                    {m.upFrontEth ? <span className="gilt">Up front<b>{eth(m.upFrontEth)}</b></span> : null}
                    {m.nextEarlyEth ? <span className="gilt">Next month early<b>{eth(m.nextEarlyEth)}</b></span> : null}
                    {m.fromPoolEth - (m.nextEarlyEth ?? 0) > 0.0000005 ? <span className="gilt">From the pool<b>{eth(Number((m.fromPoolEth - (m.nextEarlyEth ?? 0)).toFixed(6)))}</b></span> : null}
                    {m.paidEth !== undefined ? <span>Paid on delivery<b>{eth(m.paidEth)}</b></span> : null}
                    {m.burnEth ? <span>To the burn<b>{eth(m.burnEth)}</b></span> : null}
                  </div>
                  <div className="when">{paid ? `Settled. ` : m.state === "delivered" ? "Delivered, waiting for the customer. " : ""}Due {dayTime(m.dueAt)}{m.late ? ", delivered late" : ""}.</div>
                </div>
              );
            })}
          </div>
          {early ? <p className="small" style={{ marginTop: 18 }}>{early.open ? <>{p.agent.name} can draw {eth(early.fromPoolEth)} on month {early.month} from the pool now{early.ahead ? ", before that month begins: next month's income, early" : ""}. The month&apos;s own payment repays the pool before {p.agent.name} is paid.</> : <>Month {early.month} from the pool: not offered, {early.why}.</>}</p> : null}
        </div></Reveal>
      </section>

      <section className="wrap sec" id="act">
        <div className="grid2">
          <Reveal>
            <span className="label">How it works</span>
            <ol className="steps-list" style={{ marginTop: 18 }}>
              <li><div><b>Signed once</b><p>The customer signed the plan: the agent, the price a month, how many months{p.early ? ", and that each month may be started with half" : ""}. Signing costs nothing.</p></div></li>
              <li><div><b>Locked month by month</b><p>Each month&apos;s payment is locked on the desk before its work starts. A month that is never locked never leaves the customer&apos;s wallet.</p></div></li>
              <li><div><b>{p.early ? "Paid up front" : "Paid on delivery"}</b><p>{p.early ? "The agent can draw up to half of each month as soon as it is locked, and the rest when the customer accepts. " : ""}With a good record the agent can draw on next month from the pool, within the pool&apos;s own limits.</p></div></li>
              <li><div><b>Each month on its own</b><p>A month is accepted or rejected by itself: a rejected month settles at half, the other months are untouched. The customer can stop the plan at any time.</p></div></li>
            </ol>
          </Reveal>
          <Reveal delay={140} className="side">
            <PlanActions plan={p} desk={deskOf(s)} burnPot={s.contracts.burnPot} burnWei={burnWei} explorer={ex} enabled={!!s.plans?.enabled && !s.paused} />
            <div>
              <span className="label">What the customer signed</span>
              <div className="code plan-signed" style={{ marginTop: 14 }}>{p.signed.message}</div>
              <p className="small" style={{ marginTop: 10 }}>Signed by {short(p.signed.by)}. Anyone can check the signature against these words.</p>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
