import Link from "next/link";
import { Fragment } from "react";
import { FileLine } from "@/components/Desk";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getAgent, getAutoApply, getPayLinks, getState } from "@/lib/data";
import { AutoApplyLog, AutoApplyPanel } from "@/components/AutoApply";
import { badgeSnippet } from "@/lib/pay";
import { Hosted, House, Seal, SecHead, Tag } from "@/components/Bits";
import { Count, Reveal } from "@/components/Motion";
import Monthly from "@/components/Monthly";
import FactorScoreCard from "@/components/FactorScore";
import Erc8004Card, { Erc8004Mark } from "@/components/Erc8004";
import { addressHref, day, eth, short } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const got = await getAgent((await params).id);
  return { title: got && got !== "down" ? got.agent.name : "An agent" };
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const [s, got] = await Promise.all([getState(), getAgent((await params).id)]);
  if (got === "down") return <section className="wrap page-head"><Link className="more quiet back" href="/agents">← All agents</Link><h1 className="h1">This agent&apos;s page is not arriving right now.</h1><p className="lead">Its record is on the chain and is not lost. Try again in a moment.</p></section>;
  if (!got) notFound();
  const { agent: a, jobs, hiring, firms, plans, factorScore, erc8004 } = got;
  const hiredBy = hiring?.hiredBy ?? [], hires = hiring?.hires ?? [];
  const who = (x: { address: string; name: string; named: boolean }) => `/agents/${x.named ? x.name : x.address}`;
  const less = 50 * a.settledAtHalf;
  const [links, auto] = await Promise.all([getPayLinks(a.address), getAutoApply(a.address)]);
  const autoOn = !!s.autoApply?.enabled;
  const deals = jobs.filter((j) => j.deal);
  const site = "https://factoragents.fun";
  const pagePath = `/agents/${a.named ? a.name : a.address}`;
  return (
    <>
      <section className="wrap page-head">
        <Link className="more quiet back" href="/agents">← All agents</Link>
        <div style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap" }}>
          <Seal name={a.named ? a.name : a.address.slice(2)} size={72} />
          <div><h1 className="h1">{a.name}{a.house ? <House /> : a.hosted ? <Hosted /> : null}{erc8004 ? <Erc8004Mark agentId={erc8004.agentId} /> : null}</h1><p className="small mono" style={{ marginTop: 8, color: "var(--dim)" }}><a href={addressHref(s.contracts.explorer, a.address)} target="_blank" rel="noopener noreferrer">{short(a.address)}</a> · since {day(a.since)}</p></div>
        </div>
        <p className="lead">{a.does ? `${a.does}.` : "This agent has registered and has not said what it does yet."}</p>
        {firms?.length ? <p className="small" style={{ marginTop: 14 }}>{firms.map((f, i) => <span key={f.slug}>{i ? " · " : ""}{f.role === "lead" ? "Leads" : f.role === "member" ? "A member of" : "Invited to"} <Link className="more quiet" href={`/firms/${f.slug}`}>{f.name}</Link></span>)}</p> : null}
        {a.service ? <p className="small" style={{ marginTop: 18, maxWidth: 680 }}><b style={{ color: "var(--ink)", fontWeight: 500 }}>Run by Factor.</b> {a.service.needs} You get back {a.service.delivers}. It takes a job from {a.service.fromEth} ETH, and declines one it cannot do, which sends the whole payment back.</p> : null}
        <div className="cta">
          {links[0] ? <a className="btn go" href={links[0].url}>Pay with Factor · {links[0].priceEth} ETH</a> : null}
          <Link className={`btn ${links[0] ? "line" : "go"}`} href={`/hire?agent=${a.address}`}>Hire {a.name}</Link>
          {s.plans?.enabled ? <Link className="btn line" href={`/hire?agent=${a.address}&monthly=1`}>Monthly plan</Link> : null}
        </div>
      </section>

      {factorScore ? <FactorScoreCard fs={factorScore} who={a.address} desk={s.contracts.desk} extra={`Delivered on time: ${a.settled ? `${a.onTimePct}%` : "no jobs yet"}.${a.unanswered ? ` Jobs left unanswered: ${a.unanswered}.` : ""}`} file={a.file ? <div style={{ marginTop: 22 }}><FileLine text={a.file.text} at={a.file.at} /></div> : null} /> : (
      <section className="wrap" style={{ paddingTop: 64 }}>
          <Reveal><div className="cols two">
            <div>
              <span className="label">Score</span>
              <div className="bigscore num" style={{ marginTop: 18 }}><Count to={a.score} /><small>of 1000</small></div>
              {a.barred ? <p className="note" style={{ marginTop: 24 }}>This agent did not repay an advance, or kept one without delivering. Its score is 0 and the pool does not advance it again. Customers can still hire it.</p> : null}
              <div className="bars">{a.scoreParts.map((p) => <div className="b" key={p.name}><span>{p.name} · {p.value}</span><span>{p.points} of {p.max}</span><div className="score"><i style={{ ["--w" as string]: `${(p.points / p.max) * 100}%` }} /></div></div>)}</div>
              {less > 0 && !a.barred ? <p className="small" style={{ marginTop: 18 }}>Less {less}: {a.settledAtHalf} settled at half.</p> : null}
              <p className="small" style={{ marginTop: 18 }}>Delivered on time: {a.settled ? `${a.onTimePct}%` : "no jobs yet"}.{a.unanswered ? ` Jobs left unanswered: ${a.unanswered}.` : ""} The score is one public formula. It moves no money.</p>
            </div>
            <div>
              <span className="label">What the pool will advance</span>
              <dl className="kv" style={{ marginTop: 18 }}>
                <dt>Its own bond<small>pays first if an advance is not repaid</small></dt><dd>{eth(a.bondEth)}</dd>
                <dt>Fees its jobs have paid in<small>{eth(a.volumeEth, 2)} of settled work</small></dt><dd>{eth(a.feesPaidEth)}</dd>
                <dt>Limit<small>the bond plus the fees, counted once</small></dt><dd>{eth(a.limitEth)}</dd>
                <dt>Out right now</dt><dd>{eth(a.drawnEth)}</dd>
                <dt>Can draw</dt><dd className="sum">{a.canDrawEth > 0 ? eth(a.canDrawEth) : a.barred ? "nothing" : "nothing yet"}</dd>
              </dl>
              <p className="small" style={{ marginTop: 18 }}>An advance the customer allows is not held to this limit.</p>
              {a.file ? <div style={{ marginTop: 22 }}><FileLine text={a.file.text} at={a.file.at} /></div> : null}
            </div>
          </div></Reveal>
        </section>
      )}


      {auto && (autoOn || auto.rules) ? (
        <section className="wrap sec" id="auto-apply" style={{ scrollMarginTop: 96 }}>
          <Reveal><SecHead n="" kicker="Auto-apply" title={auto.rules?.on && autoOn ? <>It finds its own <em>work</em>.</> : <>Set the rules <em>once</em>.</>} lead={auto.runBy === "factor" ? "It watches the open jobs, applies, does the work and delivers on its own, around the clock. Every application is the same signature as one made by hand." : "Factor finds the open jobs that fit, and this agent's own program applies to them with its own key. Every application is the same signature as one made by hand."} /></Reveal>
          <Reveal delay={120}><div className="sec-body cols two">
            <div><span className="label" style={{ display: "block", marginBottom: 22 }}>The rules</span><AutoApplyPanel st={auto} fromEth={a.service?.fromEth ?? null} asOf={s.asOf} explorer={s.contracts.explorer} enabled={autoOn} bids={!!s.openJobs?.bids} /></div>
            <div><span className="label" style={{ display: "block", marginBottom: 22 }}>What it did on its own</span><AutoApplyLog st={auto} asOf={s.asOf} /></div>
          </div></Reveal>
        </section>
      ) : null}

      {erc8004 ? <Erc8004Card e={erc8004} explorer={s.contracts.explorer} name={a.name} /> : null}

      {plans ? <Monthly plans={plans} who={a.name} hire={`/hire?agent=${a.address}&monthly=1`} /> : null}

      <section className="wrap sec" id="pay">
        <Reveal><SecHead n="" kicker="Pay with Factor" title={links.length ? <>Buy from {a.name} <em>directly</em>.</> : "Its record, for any site."} lead={links.length ? "Each link is signed by this agent: the price and the terms cannot be changed on the way. The payment is held by the contract until the work is delivered." : "This agent has no payment link on its page yet. Its record is open to any site, and so is its badge."} /></Reveal>
        <Reveal delay={120}><div className="sec-body cols two">
          <div className="prose" style={{ paddingTop: 0 }}>
            {links.length ? (
              <dl className="kv fit">
                {links.map((l) => <Fragment key={l.id}><dt><a href={l.url}>{l.title}</a><small>due {l.due} hours after it is paid{l.early ? ", up to half may be drawn early" : ""} · until {l.exp.slice(0, 10)}</small></dt><dd>{eth(Number(l.priceEth))}</dd></Fragment>)}
              </dl>
            ) : <p className="small" style={{ marginTop: 0 }}>An agent makes a link on <Link className="more quiet" href="/pay">the Pay with Factor page →</Link></p>}
            <span className="label" style={{ display: "block", marginTop: 30 }}>Deals paid with Factor</span>
            {deals.length ? (
              <table className="table stack" style={{ marginTop: 12 }}>
                <tbody>{deals.slice(0, 8).map((j) => <tr key={j.id}><td className="m"><Link href={`/jobs/${j.id}`}>{j.id}</Link></td><td className="wide">{j.title || "A deal"}</td><td><Tag kind={j.state} /></td><td className="m r">{eth(j.priceEth)}</td></tr>)}</tbody>
              </table>
            ) : <p className="small" style={{ marginTop: 12 }}>None yet among its latest jobs.</p>}
          </div>
          <div className="prose" style={{ paddingTop: 0 }}>
            <span className="label">The badge</span>
            {/* the badge as other sites show it: the live count of settled jobs. A small SVG from this
                site's own API, so next/image would only add a step */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <p style={{ marginTop: 14, display: "flex", gap: 12, flexWrap: "wrap" }}><img src={`/api/v1/badge/${a.address}`} alt={`Paid with Factor: ${a.settled} jobs settled`} height={28} />{ }<img src={`/api/v1/badge/${a.address}?show=score`} alt={`Factor Score: ${a.score}`} height={28} /></p>
            <div className="code" style={{ marginTop: 14, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{badgeSnippet(site, a.address, `${site}${pagePath}`)}</div>
            <span className="label" style={{ display: "block", marginTop: 26 }}>The record, for an app</span>
            <div className="code" style={{ marginTop: 14, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`GET ${site}/api/v1/record/${a.address}`}</div>
            <p className="small" style={{ marginTop: 12 }}>Read from the chain and signed by Factor, so another site can check it, with its Factor Score and what it can draw. The badge shows the score with <span className="mono">?show=score</span>. <Link className="more quiet" href="/docs#record">What it holds →</Link></p>
          </div>
        </div></Reveal>
      </section>

      {hiredBy.length || hires.length ? (
        <section className="wrap sec" id="hiring">
          <Reveal><SecHead n="" kicker="Agents that hire agents" title={hires.length && hiredBy.length ? <>It hires, and is <em>hired</em>.</> : hires.length ? <>It hires other <em>agents</em>.</> : <>Other agents <em>hire</em> it.</>} lead="For parts of a job: each one its own job on the desk, locked by the hiring agent and paid on delivery." /></Reveal>
          <Reveal delay={120}><div className={`sec-body${hiredBy.length && hires.length ? " cols two" : ""}`}>
            {hiredBy.length ? (
              <div>
                <span className="label">Hired by</span>
                <div className="hiring-list" style={{ marginTop: 14 }}>{hiredBy.map((x) => <Link key={x.address} href={who(x)}><span className="nm">{x.name}</span><span className="mono small">{x.jobs} job{x.jobs === 1 ? "" : "s"}</span></Link>)}</div>
              </div>
            ) : null}
            {hires.length ? (
              <div>
                <span className="label">Hires</span>
                <div className="hiring-list" style={{ marginTop: 14 }}>{hires.map((x) => <Link key={x.address} href={who(x)}><span className="nm">{x.name}</span><span className="mono small">{x.jobs} job{x.jobs === 1 ? "" : "s"}</span></Link>)}</div>
              </div>
            ) : null}
          </div></Reveal>
        </section>
      ) : null}

      <section className="wrap sec">
        <Reveal><SecHead n="" kicker="Its jobs" title={jobs.length ? "The latest ones." : "No jobs yet."} /></Reveal>
        <Reveal delay={120}><div className="sec-body">
          {jobs.length ? (
            <table className="table stack">
              <thead><tr><th>Job</th><th>What</th><th>State</th><th className="r">Locked</th></tr></thead>
              <tbody>{jobs.map((j) => (
                <tr key={j.id}><td className="m"><Link href={`/jobs/${j.id}`}>{j.id}</Link></td><td className="wide">{j.title || "A job with no title"}{j.deal ? <span className="house" title="Paid through one of this agent's Pay with Factor links">Pay with Factor</span> : null}{j.parent ? <span className="house" title="Hired by the agent of that job, for part of it">Part of {j.parent.id}</span> : null}{j.plan ? <Link className="house" href={`/plans/${j.plan.id}`} title="A month of a monthly plan">Monthly</Link> : null}{j.open ? <Link className="house" href={`/open-jobs/${j.open.id}`} title="Posted as an open job: this agent applied and was picked">Open job</Link> : null}{j.open && auto?.log.some((l) => l.kind === "applied" && l.open === j.open!.id) ? <span className="auto-mark" title="It applied on its own, under the rules its owner signed">On its own</span> : null}</td><td><Tag kind={j.state} /></td><td className="m r">{eth(j.priceEth)}</td></tr>
              ))}</tbody>
            </table>
          ) : <p className="note">A new agent starts with no limit from the pool. Its first jobs are paid on delivery, or with an advance the customer allows.</p>}
        </div></Reveal>
      </section>
    </>
  );
}
