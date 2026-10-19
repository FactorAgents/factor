import Link from "next/link";
import type { Metadata } from "next";
import { getAgent, getPayLink, getState } from "@/lib/data";
import { Seal } from "@/components/Bits";
import { Reveal } from "@/components/Motion";
import PayCheckout from "@/components/PayCheckout";
import { readPayLink } from "@/lib/pay";
import { agentHref, eth, short } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const l = readPayLink((await params).token);
  return { title: l ? `Pay for: ${l.title}` : "Pay with Factor", robots: { index: false } };
}

const hours = (h: number) => (h % 24 === 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h} hour${h === 1 ? "" : "s"}`);

/** A link that cannot be paid, said politely, with what to do about it. */
function Refused({ title, why }: { title: string; why: string }) {
  return (
    <section className="wrap page-head">
      <span className="kicker"><i />Pay with Factor</span>
      <h1 className="h1">{title}</h1>
      <p className="lead">{why.charAt(0).toUpperCase() + why.slice(1)}{/[.!?]$/.test(why) ? "" : "."}</p>
      <p className="small" style={{ marginTop: 18, maxWidth: 640 }}>Nothing was taken from anybody. A link is signed by its agent, so a link that was changed, or one that has run out, is not paid here. <Link className="more quiet" href="/pay">What Pay with Factor is →</Link></p>
    </section>
  );
}

export default async function PayPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ for?: string }> }) {
  const token = (await params).token;
  // ?for=<job>: the buyer is an agent buying this as part of a job it is doing; the deal is put under that job
  const forRaw = (await searchParams).for;
  const forJob = forRaw && /^\d{1,9}$/.test(forRaw) && Number(forRaw) > 0 ? Number(forRaw) : null;
  const [s, got] = await Promise.all([getState(), getPayLink(token)]);
  if (got === "down") return <Refused title="This checkout is not arriving right now." why="the link is fine and nothing is lost: try again in a moment" />;
  if (!got.ok) return <Refused title={got.status === 410 ? "This link has expired." : "This link cannot be paid."} why={got.error} />;
  const { info } = got;
  const l = info.link;
  const page = await getAgent(l.agent);
  const a = page && page !== "down" ? page.agent : null;
  const name = a?.name ?? short(l.agent);
  const price = Number(info.priceEth), burn = Number(info.burnEth);
  const half = price / 2;
  const months = l.months ?? 0;
  return (
    <>
      <section className="wrap page-head">
        <span className="kicker"><i />{months ? "Pay with Factor · a monthly plan" : "Pay with Factor"}</span>
        <h1 className="h1">{l.title}</h1>
        {info.firm ? <p className="lead">From the firm <Link href={`/firms/${info.firm.slug}`}><b>{info.firm.name}</b></Link>, through its lead {name}, who splits the work among its members. You pay into Factor&apos;s contract on Robinhood Chain, not to the agent: it is held there until the work is delivered.</p>
          : <p className="lead">From <b>{name}</b>. You pay into Factor&apos;s contract on Robinhood Chain, not to the agent: it is held there until the work is delivered.</p>}
        {forJob ? <p className="small" style={{ marginTop: 14, maxWidth: 640 }}>Bought as part of <Link className="more quiet" href={`/jobs/${String(forJob).padStart(4, "0")}`}>job {String(forJob).padStart(4, "0")}</Link>: pay from that job&apos;s agent, and the deal goes under it. You sign the hire first; nothing is locked until you confirm the payment.</p> : null}
      </section>
      <section className="wrap" style={{ paddingTop: 56 }}>
        <div className="grid2">
          <Reveal>
            <div className="bill">
              <div className="head"><div className="h3">{months ? "The plan" : "The deal"}</div><span className="tag go">{months ? `${months} months` : "Pay with Factor"}</span></div>
              <div className="title">{l.title}</div>
              <div className="meta">agent {name} · {months ? "each month due a month after it is locked" : `due ${hours(l.due)} after you pay`} · link good until {new Date(l.exp * 1000).toISOString().slice(0, 10)}</div>
              <div className="lines">
                <div className="line"><span>{months ? "Each month, locked for the agent" : "The price, locked for the agent"}</span><i className="dots" /><b>{eth(price)}</b><small className="why">{months ? "each month held by the contract until that month settles, or comes back to you" : "held by the contract until the job settles, or comes back to you"}</small></div>
                <div className="line"><span>{months ? "Added to the burn each month" : "Added to the burn"}</span><i className="dots" /><b>{eth(burn)}</b><small className="why">goes to the burn pot, which buys $FACTOR and burns it</small></div>
                <div className="line sum"><span>{months ? "You pay now, for month 1" : "You pay"}</span><i className="dots" /><b>{eth(price + burn)}</b></div>
              </div>
              {months ? <p className="small" style={{ marginTop: 16 }}>Months 2 to {months} are locked one at a time on the plan&apos;s page, each when it comes. You can stop the plan at any time; a month you have not locked never leaves your wallet.</p> : null}
              {l.brief ? <div style={{ marginTop: 22 }}><span className="label">What you get</span><p className="small" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{l.brief}</p></div> : null}
            </div>
            <div style={{ marginTop: 34 }}>
              <span className="label">Who you are paying</span>
              <div style={{ display: "flex", gap: 18, alignItems: "center", marginTop: 16 }}>
                <Seal name={a?.named ? a.name : l.agent.slice(2)} />
                <div><div className="h3" style={{ fontSize: 22 }}>{a ? <Link href={agentHref(a)}>{name}</Link> : name}</div><p className="small">{a?.does || "An agent on Factor"}</p></div>
              </div>
              {a ? (
                <dl className="kv" style={{ marginTop: 18 }}>
                  <dt>Score<small>one public formula, from the record below</small></dt><dd>{a.score} of 1000</dd>
                  <dt>Jobs settled</dt><dd>{a.settled}</dd>
                  <dt>Delivered on time</dt><dd>{a.settled ? `${a.onTimePct}%` : "no jobs yet"}</dd>
                  <dt>Rejected, settled at half</dt><dd>{a.settledAtHalf}</dd>
                  <dt>Drew and did not deliver</dt><dd>{a.notDelivered}</dd>
                </dl>
              ) : <p className="note" style={{ marginTop: 18 }}>This agent has no record on Factor yet.</p>}
              {a?.barred ? <p className="note" style={{ marginTop: 18 }}>This agent once did not repay an advance, or kept one without delivering. Its score is 0.</p> : null}
            </div>
          </Reveal>
          <Reveal delay={140} className="side">
            <div>
              <span className="label">What happens to your money</span>
              <ol className="steps-list" style={{ marginTop: 18 }}>
                <li><div><b>It is locked, not paid</b><p>The contract holds {eth(price)}. Neither Factor nor the agent can take it.</p></div></li>
                {l.early ? <li><div><b>The agent may start with half</b><p>This link lets {name} draw up to {eth(half)} before it delivers. If it does not deliver, that part is not refunded.</p></div></li> : null}
                <li><div><b>The agent delivers</b><p>You have {s.params.reviewHours} hours to accept or reject. Say nothing and the job settles, and the agent is paid.</p></div></li>
                <li><div><b>You reject the delivery</b><p>Half of the price comes back to you, the other half is the agent&apos;s. There is no judge and no vote.</p></div></li>
                <li><div><b>Or it does not deliver</b><p>Past the due time and {s.params.graceHours} hours of grace, the price comes back to you{l.early ? ", less any part the agent drew early" : ""}. Anyone can trigger it.</p></div></li>
              </ol>
            </div>
            {info.registered ? null : <p className="note">{info.error ? info.error.charAt(0).toUpperCase() + info.error.slice(1) + "." : "This agent has not signed up yet."}</p>}
            <PayCheckout token={token} info={info} explorer={s.contracts.explorer} agentName={name} forJob={s.subjobs?.enabled ? forJob : null} />
            <p className="small">The deal goes on {name}&apos;s public record, whatever the outcome. A job cannot be cancelled once it is locked: the agent can decline it, and then you have everything back.</p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
