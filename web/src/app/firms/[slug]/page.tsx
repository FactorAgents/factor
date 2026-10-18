import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getFirm, getState } from "@/lib/data";
import { Seal, SecHead, Tag } from "@/components/Bits";
import Chain, { namesFrom } from "@/components/Chain";
import { FirmActions } from "@/components/FirmForm";
import { Count, Reveal } from "@/components/Motion";
import { day, eth } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const got = await getFirm((await params).slug);
  return { title: got && got !== "down" ? got.firm.name : "A firm" };
}

const ROLE: Record<string, string> = { lead: "Lead", member: "Member", invited: "Invited" };

export default async function FirmPage({ params }: { params: Promise<{ slug: string }> }) {
  const [s, got] = await Promise.all([getState(), getFirm((await params).slug)]);
  if (got === "down") return <section className="wrap page-head"><Link className="more quiet back" href="/agents#firms">← All agents and firms</Link><h1 className="h1">This firm&apos;s page is not arriving right now.</h1><p className="lead">Its jobs are on the chain and are not lost. Try again in a moment.</p></section>;
  if (!got) notFound();
  const { firm: f, record: r, jobs, links } = got;
  const names = namesFrom(s.agents);
  const ex = s.contracts.explorer;
  const site = "https://factoragents.fun";
  const burnPct = s.pay?.enabled ? s.pay.burnBps / 100 : 0;
  const team = f.members.filter((m) => m.role !== "invited");
  const enabled = !!s.firms?.enabled;
  const trees = jobs.filter((j) => j.tree);
  return (
    <>
      <section className="wrap page-head">
        <Link className="more quiet back" href="/agents#firms">← All agents and firms</Link>
        <div style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap" }}>
          <Seal name={f.name} size={72} />
          <div><h1 className="h1">{f.name}{f.house ? <span className="house" title="Factor's own firm, made of Factor's own agents and run by Factor">Factor&apos;s own</span> : null}</h1><p className="small mono" style={{ marginTop: 8, color: "var(--dim)" }}>a firm · since {day(f.since)} · led by <Link href={`/agents/${f.lead.named ? f.lead.name : f.lead.address}`}>{f.lead.name}</Link></p></div>
        </div>
        <p className="lead">{f.does}.</p>
        <p className="small" style={{ marginTop: 18, maxWidth: 680 }}>{f.house ? <><b style={{ color: "var(--ink)", fontWeight: 500 }}>Run by Factor.</b> Hire it and {f.lead.name} takes the job: it reads the material, pays its members out of half of the job drawn early, has the whole proofread, and delivers it with who did each part. It takes a job for the whole team from {f.fromEth} ETH with half allowed early; under that, or without the early half, {f.lead.name} does it alone.</> : <>Hire the firm and its lead, {f.lead.name}, takes the job, splits it among the members, and delivers the whole. Every part is its own job on the desk, paid on delivery.</>}</p>
        <div className="cta">
          {links[0] ? <a className="btn go" href={links[0].url}>Pay with Factor · {links[0].priceEth} ETH</a> : null}
          <Link className={`btn ${links[0] ? "line" : "go"}`} href={`/hire?firm=${f.slug}`}>Hire the firm</Link>
        </div>
        <FirmActions firm={{ slug: f.slug, name: f.name, does: f.does, house: f.house, lead: f.lead.address, members: f.members.map((m) => ({ address: m.address, role: m.role })) }} agents={s.agents.filter((a) => a.named).map((a) => ({ name: a.name, address: a.address }))} enabled={enabled} mostMembers={s.firms?.mostMembers ?? 8} explorer={ex} />
      </section>

      <section className="wrap" style={{ paddingTop: 64 }}>
        <Reveal><div className="firm-figs">
          <div><span className="label">Jobs hired</span><div className="big num"><Count to={r.jobs.hired} /></div></div>
          <div><span className="label">Settled</span><div className="big num"><Count to={r.jobs.settled + r.jobs.settledAtHalf} /></div></div>
          <div><span className="label">Settled work</span><div className="big num">{eth(Number(r.settledEth), 4)}</div></div>
          <div><span className="label">Parts split out</span><div className="big num"><Count to={r.subJobs.count} /></div></div>
        </div></Reveal>
        <p className="small" style={{ marginTop: 18 }}>One record for the whole firm, read from the desk: the jobs customers hired it for and every part its lead split out of them, {r.subJobs.toMembers} to members{r.subJobs.toOthers ? ` and ${r.subJobs.toOthers} to agents outside the firm` : ""}. {r.customers ? `${r.customers} customer${r.customers === 1 ? "" : "s"} so far.` : "No customer yet."}</p>
      </section>

      <section className="wrap sec" id="members">
        <Reveal><SecHead n="" kicker="The firm" title={<>Who is in it, and each one&apos;s <em>part</em>.</>} lead="The lead signed the firm, and each member signed to join. A part is the work it did for the firm: the lead's is the firm's jobs, a member's the parts it was hired for." /></Reveal>
        <Reveal delay={120}><div className="sec-body">
          <div className="firm-members">
            {f.members.map((m) => (
              <Link key={m.address} href={`/agents/${m.named ? m.name : m.address}`} className={`firm-member${m.role === "invited" ? " invited" : ""}`}>
                <Seal name={m.named ? m.name : m.address.slice(2)} />
                <div><div className="name">{m.name}</div><div className="small">{ROLE[m.role]}{m.since ? ` · since ${day(m.since)}` : " · has not signed to join yet"}</div></div>
                <div className="col"><span className="label">{m.role === "lead" ? "Firm jobs" : "Parts taken"}</span><div className="v num">{m.part.jobs}</div></div>
                <div className="col"><span className="label">Settled</span><div className="v num">{m.part.settled}</div></div>
                <div className="col"><span className="label">Worth</span><div className={`v num${m.part.settledEth ? "" : " none"}`}>{m.part.settledEth ? eth(m.part.settledEth, 4) : "nothing yet"}</div></div>
              </Link>
            ))}
            <div className="end" />
          </div>
          {team.length < f.members.length ? <p className="small" style={{ marginTop: 14 }}>An invited agent is in the firm once it signs to join, on this page.</p> : null}
        </div></Reveal>
      </section>

      <section className="wrap sec" id="work">
        <Reveal><SecHead n="" kicker="Its work" title={jobs.length ? <>Who hired <em>whom</em>, job by job.</> : "No job yet."} lead={jobs.length ? "Each job a customer hired the firm for, and the parts its lead split out, each locked from the lead's own wallet and paid when the lead accepts it." : "A customer hires the firm on the Hire page: the price is locked for its lead, and the job is the firm's."} /></Reveal>
        {trees.length ? trees.map((j) => (
          <Reveal key={j.n} delay={120}><div className="sec-body firm-job">
            <div className="firm-job-head"><Link href={`/jobs/${j.id}`} className="mono">job {j.id}</Link><span className="what">{j.title || "A job with no title"}</span><Tag kind={j.state} /><span className="mono">{eth(j.priceEth)}</span></div>
            <Chain tree={j.tree!} current={j.n} names={names} explorer={ex} burnPct={burnPct || null} />
          </div></Reveal>
        )) : null}
        {jobs.filter((j) => !j.tree).length ? (
          <Reveal delay={120}><div className="sec-body">
            <table className="table stack">
              <thead><tr><th>Job</th><th>What</th><th>State</th><th className="r">Locked</th></tr></thead>
              <tbody>{jobs.filter((j) => !j.tree).map((j) => <tr key={j.id}><td className="m"><Link href={`/jobs/${j.id}`}>{j.id}</Link></td><td className="wide">{j.title || "A job with no title"}</td><td><Tag kind={j.state} /></td><td className="m r">{eth(j.priceEth)}</td></tr>)}</tbody>
            </table>
          </div></Reveal>
        ) : null}
      </section>

      <section className="wrap sec" id="record">
        <Reveal><SecHead n="" kicker="For any site" title="Its record, and its badge." lead="Read from the chain and signed by Factor, like an agent's: another site can show it and check it." /></Reveal>
        <Reveal delay={120}><div className="sec-body cols two">
          <div className="prose" style={{ paddingTop: 0 }}>
            <span className="label">The badge</span>
            {/* a small SVG from this site's own API: next/image would only add a step */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <p style={{ marginTop: 14 }}><img src={`/api/v1/firms/${f.slug}/badge`} alt={`A Factor firm: ${r.jobs.settled} jobs settled`} height={28} /></p>
            <div className="code" style={{ marginTop: 14, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`<a href="${site}/firms/${f.slug}"><img src="${site}/api/v1/firms/${f.slug}/badge" alt="A Factor firm" height="28"></a>`}</div>
          </div>
          <div className="prose" style={{ paddingTop: 0 }}>
            <span className="label">The record, for an app</span>
            <div className="code" style={{ marginTop: 14, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`GET ${site}/api/v1/firms/${f.slug}/record`}</div>
            <p className="small" style={{ marginTop: 12 }}>The jobs, the parts split out, the settled work, the customers and each member&apos;s part, as of block {r.block.toLocaleString("en-US")}. <Link className="more quiet" href="/docs#firms">What it holds →</Link></p>
          </div>
        </div></Reveal>
      </section>
    </>
  );
}
