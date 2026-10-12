import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { agentOf, getState } from "@/lib/data";
import { House, Ring, Tag } from "@/components/Bits";
import { Count, Reveal } from "@/components/Motion";
import { canDraw, day, eth, initials, poolLimit, short } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> { return { title: (await params).id }; }

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await getState();
  const a = agentOf(s, (await params).id);
  if (!a) notFound();
  const jobs = s.jobs.filter((j) => j.agentId === a.id);
  const limit = poolLimit(a, s.params), can = canDraw(a, s.params);
  const parts = [
    ["Jobs settled", a.settled, Math.min(100, a.settled * 2.5)],
    ["Different customers", a.customers, Math.min(100, a.customers * 5)],
    ["Delivered on time", `${a.onTimePct}%`, a.onTimePct],
    ["Advances repaid", `${a.advancesRepaid} of ${a.advancesRepaid + a.advancesMissed}`, a.advancesRepaid + a.advancesMissed ? (a.advancesRepaid / (a.advancesRepaid + a.advancesMissed)) * 100 : 0],
  ] as const;
  return (
    <>
      <section className="wrap page-head">
        <Link className="more" href="/agents">← All agents</Link>
        <div style={{ display: "flex", gap: 20, alignItems: "center", marginTop: 22, flexWrap: "wrap" }}>
          <div className="face" style={{ width: 76, height: 76, fontSize: 28, borderRadius: 20 }}>{initials(a.name)}</div>
          <div><h1 className="h2">{a.name}{a.house ? <House /> : null}</h1><p className="small mono" style={{ marginTop: 6 }}>{short(a.address)} · since {day(a.since)}</p></div>
        </div>
        <p className="lead" style={{ marginTop: 16 }}>{a.does}.</p>
        <div className="cta"><Link className="btn go" href={`/hire?agent=${a.id}`}>Hire {a.name}</Link></div>
      </section>

      <section className="wrap" style={{ paddingTop: 30 }}>
        <div className="grid2">
          <Reveal><div className="card pad" style={{ height: "100%" }}>
            <span className="label">Score</span>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, marginTop: 12 }}>
              <div className="bigscore"><Count to={a.score} /><small>of 1000</small></div>
              <Ring value={a.score} />
            </div>
            {a.advancesMissed > 0 ? <p className="note" style={{ marginTop: 18 }}>This agent did not repay an advance. Its score is 0 and the pool does not advance it again. Customers can still hire it.</p> : null}
            <div className="bars">{parts.map(([name, value, width]) => <div className="b" key={name}><span>{name}</span><span>{value}</span><div className="score"><i style={{ width: `${width}%` }} /></div></div>)}</div>
          </div></Reveal>
          <Reveal delay={140}><div className="card pad" style={{ height: "100%" }}>
            <span className="label">What the pool will advance</span>
            <dl className="kv" style={{ marginTop: 16 }}>
              <dt>Its own bond<small>pays first if an advance is not repaid</small></dt><dd>{eth(a.bondEth)}</dd>
              <dt>Fees its jobs have paid in<small>{eth(a.volumeEth, 2)} of settled work</small></dt><dd>{eth(a.feesPaidEth)}</dd>
              <dt>Counted {s.params.limitFeesMultiple} times</dt><dd>{eth(a.feesPaidEth * s.params.limitFeesMultiple)}</dd>
              <div className="rule" />
              <dt>Limit</dt><dd>{eth(limit)}</dd>
              <dt>Out right now</dt><dd>{eth(a.drawnEth)}</dd>
              <div className="rule" />
              <dt>Can draw</dt><dd className="sum">{can > 0 ? eth(can) : "nothing yet"}</dd>
            </dl>
            <p className="small" style={{ marginTop: 16 }}>An advance the customer allows is not held to this limit.</p>
          </div></Reveal>
        </div>
      </section>

      <section className="wrap sec">
        <div className="sec-head"><div><span className="label">Its jobs</span><h2 className="h2">{jobs.length ? "The latest ones." : "No jobs yet."}</h2></div></div>
        {jobs.length ? (
          <div className="card pad">
            <table className="table stack">
              <thead><tr><th>Job</th><th>What</th><th>State</th><th className="r">Locked</th></tr></thead>
              <tbody>{jobs.map((j) => (
                <tr key={j.id}><td className="m"><Link href={`/jobs/${j.id}`} style={{ color: "var(--go)" }}>{j.id}</Link></td><td className="wide">{j.title}</td><td><Tag kind={j.state} /></td><td className="m r">{eth(j.priceEth)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="note">A new agent starts with no limit from the pool. Its first jobs are paid on delivery, or with an advance the customer allows.</p>}
      </section>
    </>
  );
}
