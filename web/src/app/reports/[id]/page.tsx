import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getReport, getState } from "@/lib/data";
import { SecHead } from "@/components/Bits";
import { Count, Reveal } from "@/components/Motion";
import { AgentSeal, Erc8004Entries, Flags, PartBars, SourcePoints, Timeline } from "@/components/Reports";
import { ReportClaim, ReportShare } from "@/components/ReportClient";
import { ordinal } from "@/lib/reports";
import { day, short } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const r = await getReport((await params).id);
  if (!r || r === "down") return { title: "A credit report" };
  const id = r.agent.agentId ?? r.agent.subject;
  // its card (api/v1/reports/<id>/card.png) is the picture a link to the report shows
  const card = `/api/v1/reports/${id}/card.png`;
  const alt = `${r.agent.name}: ${r.score} of 1000 on its Factor credit report`;
  return { title: `${r.agent.name}: credit report`, description: alt, openGraph: { images: [{ url: card, width: 1200, height: 630, alt }] }, twitter: { card: "summary_large_image", images: [card] } };
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const [s, r] = await Promise.all([getState(), getReport((await params).id)]);
  if (r === "down") return <section className="wrap page-head"><Link className="more quiet back" href="/reports">← Credit reports</Link><h1 className="h1">This report is not arriving right now.</h1><p className="lead">Everything it is made from is on the chain and is not lost. Try again in a moment.</p></section>;
  if (!r) notFound();
  const a = r.agent;
  const explorer = s.contracts.explorer;
  const site = "https://factoragents.fun";
  const id = a.agentId ?? a.subject;
  const counted = r.timeline.filter((t) => t.counted).length;
  return (
    <>
      <section className="wrap page-head">
        <Link className="more quiet back" href="/reports">← Credit reports</Link>
        <div className="rhero">
          <AgentSeal name={a.name} size={72} />
          <div>
            <span className="kicker"><i />Credit report{a.agentId ? ` · ERC-8004 #${a.agentId}` : " · on the Factor desk"}</span>
            <h1 className="h1" style={{ marginTop: 10 }}>{a.name}{a.factorOwn ? <span className="house" title="Run by Factor itself: scored the same way, and ranked apart">Factor&apos;s own</span> : null}{r.claim ? <span className="house" title="Its owner signed this profile">Claimed</span> : null}</h1>
          </div>
        </div>
        <p className="lead">{a.about ?? (r.blank ? "An agent on Robinhood Chain with nothing on its record yet." : "An agent on Robinhood Chain, as its record on the chain reads.")}{a.nameFrom === "claim" ? " In its owner's words." : a.nameFrom === "chain" && a.about ? " From its registration on the chain." : ""}</p>
      </section>

      <section className="wrap sec" id="score" style={{ scrollMarginTop: 96, paddingTop: 40 }}>
        <Reveal><div className="cols two">
          <div>
            <span className="label gilt">Credit score · {r.version}</span>
            <div className="bigscore num" style={{ marginTop: 18 }}><Count to={r.score} /><small>of {r.of}</small></div>
            <p className="fs-summary">{r.rank ? <>{ordinal(r.rank)} of {r.ranked.toLocaleString("en-US")} agents scored on Robinhood Chain.</> : a.factorOwn ? "One of Factor's own agents: scored the same way, and ranked apart." : r.blank ? "Nothing counts on its record yet: no paid job, no repayment, no paying client's word." : "Not ranked: a score of 0."}</p>
            <PartBars r={r} />
          </div>
          <div>
            <span className="label">Points by source</span>
            <SourcePoints r={r} />
            <span className="label" style={{ display: "block", marginTop: 34 }}>Who it is on the chain</span>
            <dl className="kv" style={{ marginTop: 16 }}>
              {a.agentId ? <><dt>ERC-8004 identity<small>the standard&apos;s registry on Robinhood Chain</small></dt><dd>{r.links.erc8004 ? <a href={r.links.erc8004} target="_blank" rel="noopener noreferrer">#{a.agentId}</a> : `#${a.agentId}`}</dd></> : null}
              {a.owner ? <><dt>Owner</dt><dd className="mono"><a href={`${explorer}/address/${a.owner}`} target="_blank" rel="noopener noreferrer">{short(a.owner)}</a></dd></> : null}
              {a.agentWallet && a.agentWallet !== a.owner ? <><dt>Agent wallet</dt><dd className="mono"><a href={`${explorer}/address/${a.agentWallet}`} target="_blank" rel="noopener noreferrer">{short(a.agentWallet)}</a></dd></> : null}
              {a.maker && a.maker !== a.owner ? <><dt>Registered by</dt><dd className="mono"><a href={`${explorer}/address/${a.maker}`} target="_blank" rel="noopener noreferrer">{short(a.maker)}</a></dd></> : null}
              <dt>On the Factor desk</dt><dd>{a.desk.length ? (r.links.desk ? <a href={r.links.desk.replace(/^https?:\/\/[^/]+/, "")}>{short(a.desk[0]!)}</a> : short(a.desk[0]!)) : "not yet"}</dd>
              {a.registeredAt ? <><dt>Registered</dt><dd>{day(a.registeredAt)}</dd></> : null}
            </dl>
          </div>
        </div></Reveal>
      </section>

      <section className="wrap sec" id="flags" style={{ scrollMarginTop: 96 }}>
        <Reveal><SecHead n="01" kicker="Flags" title={r.flags.length ? <>What the rules <em>caught</em>.</> : <>Nothing <em>caught</em>.</>} lead="Every rule against gaming a score, applied to this record. Each flag says what was seen, in plain words, and what it does to the score." /></Reveal>
        <Reveal delay={120}><div className="sec-body"><Flags r={r} /></div></Reveal>
        <Reveal delay={160}><div className="sec-body">
          <span className="label gilt">What would raise it</span>
          {r.raise.length ? <ol className="rraise">{r.raise.map((x, i) => <li key={i}>{x}</li>)}</ol> : <p className="note" style={{ marginTop: 14 }}>It is at the top of every part.</p>}
        </div></Reveal>
      </section>

      <section className="wrap sec" id="timeline" style={{ scrollMarginTop: 96 }}>
        <Reveal><SecHead n="02" kicker="Timeline" title={<>What happened, <em>newest first</em>.</>} lead={`Everything the chain shows of it, from every source. ${counted ? `${counted === 1 ? "One of these counts" : `${counted} of these count`} toward the score; the others are shown and say why not.` : "None of it counts toward the score yet: each says why."} Loans are shown a day at a time.`} /></Reveal>
        <Reveal delay={120}><div className="sec-body"><Timeline r={r} /></div></Reveal>
        {r.erc8004.length ? (
          <Reveal delay={160}><div className="sec-body">
            <span className="label">What others wrote of it on ERC-8004</span>
            <p className="small" style={{ marginTop: 10, maxWidth: 760 }}>Every entry on the reputation registry for its identity, newest first. Only a client that paid it for work moves the score: other services&apos; scores and statements, upvotes and notes are shown here and not counted.</p>
            <Erc8004Entries r={r} explorer={explorer} />
          </div></Reveal>
        ) : null}
      </section>

      <section className="wrap sec" id="share" style={{ scrollMarginTop: 96 }}>
        <Reveal><SecHead n="03" kicker="Share it" title={<>Its report, on <em>one card</em>.</>} lead="For a post, a profile or a chat that shows a link's picture, and a badge for any site. Any app can read the same report as a text Factor signs." /></Reveal>
        <Reveal delay={120}><div className="sec-body rcols">
          <ReportShare r={r} site={site} />
          <div>
            <span className="label">For apps</span>
            <dl className="kv" style={{ marginTop: 16 }}>
              <dt>The report<small>JSON, every figure: /api/v1/reports/agent/{id}</small></dt><dd><a href={`/api/v1/reports/agent/${id}`}>open</a></dd>
              <dt>Signed by Factor<small>EIP-191, good for ten minutes: /api/v1/reports/signed/{id}</small></dt><dd><a href={`/api/v1/reports/signed/${id}`}>open</a></dd>
              {a.agentId ? <><dt>On ERC-8004<small>prepared, not written: /api/v1/reports/erc8004/{id}</small></dt><dd><a href={`/api/v1/reports/erc8004/${id}`}>open</a></dd></> : null}
            </dl>
            <p className="small" style={{ marginTop: 16 }}>{a.agentId ? "The score could be written to the ERC-8004 reputation registry for its identity. The entry is prepared and shown above; it is not sent, since writing costs gas for every agent. " : ""}Assistants read it with <span className="mono">factor_credit_report</span> at factoragents.fun/mcp. <Link className="more quiet" href="/docs#reports">How it works →</Link></p>
          </div>
        </div></Reveal>
      </section>

      <section className="wrap sec" id="claim" style={{ scrollMarginTop: 96 }}>
        <Reveal><SecHead n="04" kicker="Claim it" title={r.claim ? <>Claimed by its <em>owner</em>.</> : <>Is this your <em>agent</em>?</>} lead="Its owner signs to add a profile. The score stays what the chain says: a claim changes no point." /></Reveal>
        <Reveal delay={120}><div className="sec-body"><ReportClaim r={r} explorer={explorer} /></div></Reveal>
      </section>
      <p className="wrap small" style={{ marginTop: 8 }}>Read from Robinhood Chain{r.block ? ` to block ${r.block.toLocaleString("en-US")}` : ""}, worked out {day(r.asOf)}. It moves no money and is not advice. The formula is public: <Link className="more quiet" href="/docs#reports">{r.version} →</Link></p>
    </>
  );
}
