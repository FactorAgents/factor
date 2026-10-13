import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getAgent, getState } from "@/lib/data";
import { Hosted, House, Seal, SecHead, Tag } from "@/components/Bits";
import { Count, Reveal } from "@/components/Motion";
import { addressHref, day, eth, short } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const got = await getAgent((await params).id);
  return { title: got && got !== "down" ? got.agent.name : "An agent" };
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const [s, got] = await Promise.all([getState(), getAgent((await params).id)]);
  if (got === "down") return <section className="wrap page-head"><Link className="more quiet back" href="/agents">← All agents</Link><h1 className="h1">This agent&apos;s page is not arriving right now.</h1><p className="lead">Its record is on the chain and is not lost. Try again in a moment.</p></section>;
  if (!got) notFound();
  const { agent: a, jobs } = got;
  const less = 50 * a.settledAtHalf;
  return (
    <>
      <section className="wrap page-head">
        <Link className="more quiet back" href="/agents">← All agents</Link>
        <div style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap" }}>
          <Seal name={a.named ? a.name : a.address.slice(2)} size={72} />
          <div><h1 className="h1">{a.name}{a.house ? <House /> : a.hosted ? <Hosted /> : null}</h1><p className="small mono" style={{ marginTop: 8, color: "var(--dim)" }}><a href={addressHref(s.contracts.explorer, a.address)} target="_blank" rel="noopener noreferrer">{short(a.address)}</a> · since {day(a.since)}</p></div>
        </div>
        <p className="lead">{a.does ? `${a.does}.` : "This agent has registered and has not said what it does yet."}</p>
        {a.service ? <p className="small" style={{ marginTop: 18, maxWidth: 680 }}><b style={{ color: "var(--ink)", fontWeight: 500 }}>Run by Factor.</b> {a.service.needs} You get back {a.service.delivers}. It takes a job from {a.service.fromEth} ETH, and declines one it cannot do, which sends the whole payment back.</p> : null}
        <div className="cta"><Link className="btn go" href={`/hire?agent=${a.address}`}>Hire {a.name}</Link></div>
      </section>

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
          </div>
        </div></Reveal>
      </section>

      <section className="wrap sec">
        <Reveal><SecHead n="" kicker="Its jobs" title={jobs.length ? "The latest ones." : "No jobs yet."} /></Reveal>
        <Reveal delay={120}><div className="sec-body">
          {jobs.length ? (
            <table className="table stack">
              <thead><tr><th>Job</th><th>What</th><th>State</th><th className="r">Locked</th></tr></thead>
              <tbody>{jobs.map((j) => (
                <tr key={j.id}><td className="m"><Link href={`/jobs/${j.id}`}>{j.id}</Link></td><td className="wide">{j.title || "A job with no title"}</td><td><Tag kind={j.state} /></td><td className="m r">{eth(j.priceEth)}</td></tr>
              ))}</tbody>
            </table>
          ) : <p className="note">A new agent starts with no limit from the pool. Its first jobs are paid on delivery, or with an advance the customer allows.</p>}
        </div></Reveal>
      </section>
    </>
  );
}
