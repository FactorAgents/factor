// An agent's (or a firm's) monthly clients: the plans running, what they bring in a month, the months delivered, and
// each plan. Shown only when there is a plan: a page never shows empty counts.
import Link from "next/link";
import { Count, Reveal } from "./Motion";
import { SecHead } from "./Bits";
import { eth, short } from "@/lib/format";
import type { PlansSummary } from "@/lib/types";

const STATUS: Record<string, string> = { waiting: "signed", active: "running", stopped: "stopped", ended: "ended", lapsed: "lapsed", done: "done" };

export default function Monthly({ plans: p, who, hire }: { plans: PlansSummary; who: string; hire: string }) {
  return (
    <section className="wrap sec" id="monthly">
      <Reveal><SecHead n="" kicker="Monthly clients" title={p.active || p.paidEth ? <>Recurring income, on the <em>record</em>.</> : <>Monthly <em>clients</em>.</>} lead={`Customers who put ${who} on a monthly plan. Every month is a job on the desk, locked before its work starts and paid on delivery, so anyone can check it.`} /></Reveal>
      <Reveal delay={120}><div className="sec-body monthly">
        <div>
          {p.monthlyEth || !p.paidEth ? (
            <>
              <span className="label">A month, from plans running now</span>
              <div className={`income num${p.monthlyEth ? "" : " none"}`}>{p.monthlyEth ? eth(p.monthlyEth) : "none running"}{p.monthlyEth ? <small>a month</small> : null}</div>
            </>
          ) : (
            <>
              <span className="label">Paid by its monthly clients</span>
              <div className="income num">{eth(p.paidEth)}<small>{p.monthsSettled} month{p.monthsSettled === 1 ? "" : "s"}</small></div>
            </>
          )}
          <dl className="kv tight" style={{ marginTop: 26 }}>
            <dt>Plans running</dt><dd><Count to={p.active} /></dd>
            <dt>Monthly clients</dt><dd><Count to={p.clients} /></dd>
            <dt>Months delivered<small>{p.monthsSettled} settled</small></dt><dd><Count to={p.monthsDelivered} /></dd>
            {p.paidEth && p.monthlyEth ? <><dt>Paid so far<small>by its monthly clients, months settled</small></dt><dd>{eth(p.paidEth)}</dd></> : null}
          </dl>
          <p className="small" style={{ marginTop: 18 }}><Link className="more quiet" href={hire}>Put {who} on a monthly plan →</Link></p>
        </div>
        <div className="plan-list">
          {p.items.slice(0, 8).map((x) => (
            <Link key={x.id} href={`/plans/${x.id}`}>
              <span className="what">{x.title}<span className="small mono" style={{ display: "block", color: "var(--dim)", marginTop: 4 }}>for {short(x.customer)} · {STATUS[x.status] ?? x.status}</span></span>
              <span className="of">month {Math.max(x.locked, 1)} of {x.months}</span>
              <span className="of">{eth(x.priceEth)} a month</span>
            </Link>
          ))}
        </div>
      </div></Reveal>
    </section>
  );
}
