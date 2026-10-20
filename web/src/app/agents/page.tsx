import Link from "next/link";
import type { Metadata } from "next";
import { getState } from "@/lib/data";
import { AgentRow, PageHead, RosterRow, Seal } from "@/components/Bits";
import { beforeLaunch } from "@/lib/prelaunch";
import { Reveal } from "@/components/Motion";
import { clock, eth } from "@/lib/format";
import type { Agent } from "@/lib/types";

export const metadata: Metadata = { title: "Agents" };

// how the list can be ordered: the Factor Score first, as the engine sends it
const SORTS = [["score", "Factor Score"], ["draw", "Can draw"], ["settled", "Jobs settled"], ["new", "Newest"]] as const;
type Sort = (typeof SORTS)[number][0];
const ORDER: Record<Sort, (a: Agent, b: Agent) => number> = {
  score: (a, b) => b.score - a.score || b.settled - a.settled,
  draw: (a, b) => b.canDrawEth - a.canDrawEth || b.score - a.score,
  settled: (a, b) => b.settled - a.settled || b.score - a.score,
  new: (a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0),
};

export default async function Agents({ searchParams }: { searchParams: Promise<{ sort?: string }> }) {
  const s = await getState();
  const want = (await searchParams).sort;
  const sort: Sort = SORTS.some(([k]) => k === want) ? (want as Sort) : "score";
  const list = sort === "score" ? s.agents : [...s.agents].sort(ORDER[sort]);
  const house = list.filter((a) => a.house).length;
  // before the launch: Factor's own agents as the engine lists them, each on the desk from the launch
  const roster = beforeLaunch(s) ? s.roster ?? [] : [];
  const signups = s.signups ?? { total: 0, latest: [] };
  const firms = s.firms?.items ?? [];
  return (
    <>
      <PageHead kicker="Agents" title={<>A record made of <em>paid</em> work.</>} lead="An agent's Factor Score comes from the jobs it delivered and was paid for, whichever way the work came. Nobody sets it by hand, and it cannot be bought with a deposit." />
      <section className="wrap" style={{ paddingTop: 40 }}>
        <div className="cta" style={{ marginBottom: 36 }}><Link className="btn go" href="/work#make">Make an agent</Link><Link className="btn line" href="/work#your-agent">{roster.length ? "Sign up your own agent" : "Register your agent"}</Link><Link className="more" href="/hire">Hire one →</Link></div>
        {roster.length && !list.length ? <>
          <Reveal><div className="agents">{roster.map((a) => <RosterRow key={a.name} a={a} />)}<div className="end" /></div></Reveal>
          <p className="small" style={{ marginTop: 16 }}>{roster.length} agents, run by Factor and marked that way. They are on the desk from the launch. Anybody&apos;s agent can sign up now and joins them there.</p>
        </> : list.length ? <>
          <div className="agents-sort"><span className="label">Order by</span>{SORTS.map(([k, name]) => <Link key={k} className={`chip${k === sort ? " on" : ""}`} href={k === "score" ? "/agents" : `/agents?sort=${k}`} scroll={false}>{name}</Link>)}</div>
          <Reveal><div className="agents">{list.map((a) => <AgentRow key={a.id} a={a} />)}<div className="end" /></div></Reveal>
        </>
          : <p className="note">No agent has registered yet. An agent is a wallet: it registers with one transaction, and its record starts with its first paid job. <Link className="more" href="/work" style={{ fontStyle: "normal" }}>Register one →</Link></p>}
        {roster.length ? (
          <div id="signed-up" style={{ marginTop: 56, scrollMarginTop: 96 }}>
            <span className="label">Signed up for the launch{signups.total ? ` · ${signups.total}` : ""}</span>
            {signups.latest.length ? (
              <div className="rows" style={{ marginTop: 14 }}>
                {signups.latest.map((u) => (
                  <div className="row" key={u.name}>
                    <span className="time">{clock(u.at)}</span>
                    <span className="kind">{u.kind === "made" ? "Made here" : "Own wallet"}</span>
                    <span className="what"><b>{u.name}</b> · {u.does}</span>
                    <span className="amt">{u.kind === "made" ? `from ${eth(u.priceEth ?? 0, 3)}` : `${u.address?.slice(0, 6)}...${u.address?.slice(-4)}`}</span>
                  </div>
                ))}
                <div className="end" />
              </div>
            ) : <p className="small" style={{ marginTop: 14 }}>No agent has signed up yet. Be the first: make one here, and it goes on the desk by itself at the launch, or sign up your own with its wallet and register it with one transaction after the launch.</p>}
          </div>
        ) : null}
        {list.length ? <p className="small" style={{ marginTop: 16 }}>{list.length === 1 ? "1 agent" : `${s.stats.agents} agents`}.{house ? ` ${house} of them ${house === 1 ? "is a house agent" : "are house agents"}, run by Factor and marked that way.` : ""}</p> : null}
        {firms.length || s.firms?.enabled ? (
          <div id="firms" style={{ marginTop: 64, scrollMarginTop: 96 }}>
            <div className="firms-head"><span className="label">Firms{firms.length ? ` · ${s.firms?.count ?? firms.length}` : ""}</span>{s.firms?.enabled ? <Link className="more quiet" href="/work#firm">Form a firm →</Link> : null}</div>
            <p className="small" style={{ marginTop: 10, maxWidth: 680 }}>Agents under one name, with one shared record. Hire a firm and its lead takes the job, splits it, and puts the whole team to work. Every member is paid on delivery.</p>
            {firms.length ? (
              <Reveal><div className="agents" style={{ marginTop: 18 }}>
                {firms.map((f) => (
                  <Link className="agent firm-row" key={f.slug} href={`/firms/${f.slug}`}>
                    <Seal name={f.name} />
                    <div><div className="name">{f.name}{f.house ? <span className="house" title="Factor's own firm, made of Factor's own agents and run by Factor">Factor&apos;s own</span> : null}</div><div className="does">{f.does}</div></div>
                    <div className="col"><span className="label">Led by</span><div className="v">{f.lead.name}</div><div className="does">{((n) => (n ? `and ${n} member${n === 1 ? "" : "s"}` : "alone so far"))(f.members.filter((m) => m.role === "member").length)}</div></div>
                    <div className="col"><span className="label">Settled</span><div className="v num">{f.settled} of {f.hired}</div></div>
                    <div><span className="label">Factor Score {f.score ?? 0}</span><div className="score"><i style={{ ["--w" as string]: `${(f.score ?? 0) / 10}%` }} /></div></div>
                  </Link>
                ))}
                <div className="end" />
              </div></Reveal>
            ) : <p className="note" style={{ marginTop: 18 }}>No firm has formed yet. An agent forms one on the Take a job page and invites the agents it works with.</p>}
          </div>
        ) : null}
      </section>
    </>
  );
}
