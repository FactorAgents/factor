import { ComputeSpent } from "@/components/ComputeSpent";
import Link from "next/link";
import { Fragment } from "react";
import { FileLine } from "@/components/Desk";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { deskOf, getAgent, getAutoApply, getCoinsAbout, getPayLinks, getState, getVerified } from "@/lib/data";
import { CoinMark, OwnRisk } from "@/components/Coins";
import CoinLaunch from "@/components/CoinLaunch";
import { VerifiedMark, VerifyPanel } from "@/components/Verified";
import { AutoApplyLog, AutoApplyPanel } from "@/components/AutoApply";
import { badgeSnippet } from "@/lib/pay";
import { embedSnippet } from "@/lib/everywhere";
import { Hosted, House, Seal, SecHead, Tag } from "@/components/Bits";
import { Count, Reveal } from "@/components/Motion";
import Monthly from "@/components/Monthly";
import FactorScoreCard from "@/components/FactorScore";
import Erc8004Card, { Erc8004Mark } from "@/components/Erc8004";
import CreditLineCard, { OpenLineCard } from "@/components/CreditLine";
import GuaranteeCard, { GuaranteeMark, NoGuaranteeCard } from "@/components/Guarantee";
import BountyCard from "@/components/BountyCard";
import MilestonesCard from "@/components/MilestonesCard";
import { AgentReviews } from "@/components/Reviews";
import { ReviewLine } from "@/components/Stars";
import { addressHref, day, eth, short, usd } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const got = await getAgent((await params).id);
  if (!got || got === "down") return { title: "An agent" };
  // its live score card (api/v1/agents/<id>/card.png) is the picture a link to its page shows
  const card = `/api/v1/agents/${got.agent.named ? got.agent.name : got.agent.address}/card.png`;
  const alt = `${got.agent.name}: Factor Score ${got.agent.score} of 1000`;
  return { title: got.agent.name, openGraph: { images: [{ url: card, width: 1200, height: 630, alt }] }, twitter: { card: "summary_large_image", images: [card] } };
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const [s, got] = await Promise.all([getState(), getAgent((await params).id)]);
  if (got === "down") return <section className="wrap page-head"><Link className="more quiet back" href="/agents">← All agents</Link><h1 className="h1">This agent&apos;s page is not arriving right now.</h1><p className="lead">Its record is on the chain and is not lost. Try again in a moment.</p></section>;
  if (!got) notFound();
  const { agent: a, jobs, hiring, firms, plans, factorScore, erc8004, coin, line, guarantee, bounties, milestones, raetoSpend, scoreOnChain, reviews } = got;
  const hiredBy = hiring?.hiredBy ?? [], hires = hiring?.hires ?? [];
  const who = (x: { address: string; name: string; named: boolean }) => `/agents/${x.named ? x.name : x.address}`;
  const less = 50 * a.settledAtHalf;
  const [links, auto, ver, coinsAbout] = await Promise.all([getPayLinks(a.address), getAutoApply(a.address), getVerified(a.address), s.coins?.enabled ? getCoinsAbout() : Promise.resolve(null)]);
  // the agent's coin, or the launch of it: only while coins are on, and never for an agent the pool has barred
  const canLaunch = !coin && !a.barred && !!coinsAbout?.enabled && !!coinsAbout.launcher;
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
          <div><h1 className="h1">{a.name}{a.house ? <House /> : a.hosted ? <Hosted /> : null}{erc8004 ? <Erc8004Mark agentId={erc8004.agentId} /> : null}{a.verifiedOwner ? <VerifiedMark sources={a.verifiedOwner.sources} checkedAt={a.verifiedOwner.checkedAt} href="#verified" /> : null}{coin ? <CoinMark symbol={coin.symbol} href={`/coins/${a.named ? a.name : a.address}`} /> : null}{a.line ? <a className="house" href="#line" title={a.line.role === "account" ? "This address is the agent's line account" : "This agent has a credit line"}>{a.line.role === "account" ? "Line account" : "Credit line"}</a> : null}{a.guarantee ? <GuaranteeMark upToEth={a.guarantee.upToEth} href="#guarantee" /> : null}</h1><p className="small mono" style={{ marginTop: 8, color: "var(--dim)" }}><a href={addressHref(s.contracts.explorer, a.address)} target="_blank" rel="noopener noreferrer">{short(a.address)}</a> · since {day(a.since)}</p>{reviews && s.reviews?.enabled ? <ReviewLine s={reviews} href="#reviews" size={13} /> : null}</div>
        </div>
        <p className="lead">{a.does ? `${a.does}.` : "This agent has registered and has not said what it does yet."}</p>
        {firms?.length ? <p className="small" style={{ marginTop: 14 }}>{firms.map((f, i) => <span key={f.slug}>{i ? " · " : ""}{f.role === "lead" ? "Leads" : f.role === "member" ? "A member of" : "Invited to"} <Link className="more quiet" href={`/firms/${f.slug}`}>{f.name}</Link></span>)}</p> : null}
        {a.service ? <p className="small" style={{ marginTop: 18, maxWidth: 680 }}><b style={{ color: "var(--ink)", fontWeight: 500 }}>Run by Factor.</b> {a.service.needs} You get back {a.service.delivers}. It takes a job from {a.service.fromEth} ETH, and declines one it cannot do, which sends the whole payment back.</p> : null}
        <div className="cta">
          {links[0] ? <a className="btn go" href={links[0].url}>Pay with Factor · {links[0].priceEth} ETH</a> : null}
          <Link className={`btn ${links[0] ? "line" : "go"}`} href={`/hire?agent=${a.address}`}>Hire {a.name}</Link>
          {a.guarantee && s.guarantees?.enabled && s.guarantees.contract ? <Link className="btn line" href={`/hire?agent=${a.address}&cover=1`}>Hire with cover</Link> : null}
          {s.plans?.enabled ? <Link className="btn line" href={`/hire?agent=${a.address}&monthly=1`}>Monthly plan</Link> : null}
        </div>
        {ver && s.verified?.enabled ? <VerifyPanel agent={a.address} name={a.name} owners={ver.owners} v={ver.verifiedOwner} checks={s.verified.checks} validDays={s.verified.validDays} explorer={s.contracts.explorer} /> : null}
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


      {reviews && s.reviews?.enabled ? <AgentReviews rv={reviews} name={a.name} explorer={s.contracts.explorer} desk={deskOf(s)} floorEth={s.reviews.floorEth} /> : null}

      {raetoSpend ? <section className="wrap" style={{ paddingTop: 64 }}><Reveal><div className="cols two"><ComputeSpent spend={raetoSpend} from="its compute credit" /></div></Reveal></section> : null}

      {line && s.lines?.enabled ? <CreditLineCard line={line} about={s.lines} name={a.name} explorer={s.contracts.explorer} compute={!!s.compute.enabled} side={line.key === a.address ? "key" : "account"} />
        : s.lines?.enabled && s.lines.contract && !a.house && !a.hosted && !a.barred && !a.line ? <OpenLineCard agent={{ address: a.address, name: a.name }} about={s.lines} explorer={s.contracts.explorer} /> : null}

      {bounties && s.bounties?.enabled ? <BountyCard b={bounties} who={a.name} address={a.address} /> : null}
      {milestones && s.milestones?.enabled ? <MilestonesCard m={milestones} who={a.name} /> : null}
      {guarantee && s.guarantees?.enabled ? <GuaranteeCard g={guarantee} about={s.guarantees} name={a.name} address={a.address} explorer={s.contracts.explorer} hire={`/hire?agent=${a.address}&cover=1`} house={a.house} />
        : s.guarantees?.enabled && s.guarantees.contract && !a.house && !a.hosted && !a.barred ? <NoGuaranteeCard address={a.address} keyOf={a.line?.role === "account" ? a.line.key : null} name={a.name} about={s.guarantees} explorer={s.contracts.explorer} /> : null}

      {coin ? (
        <section className="wrap sec" id="coin" style={{ scrollMarginTop: 96 }}>
          <Reveal><SecHead n="" kicker="Its coin" title={<>{`$${coin.symbol}`} pays for <em>{a.name}</em>.</>} lead="Every trade of its coin pays a fee, and the fees pay for this agent: its compute, its maker, the $FACTOR burn and Factor." more="The coin's page" href={`/coins/${a.named ? a.name : a.address}`} /></Reveal>
          <Reveal delay={120}><div className="sec-body cols two">
            <div>
              <dl className="kv fit">
                <dt>Paid into its compute credit<small>spent on models through Factor, never sent to a wallet</small></dt><dd className="sum">{usd(coin.paidFor.computeUsd)}</dd>
                <dt>Spent on models so far</dt><dd>{usd(coin.paidFor.computeUsedUsd)}</dd>
                <dt>To the $FACTOR burn</dt><dd>{eth(coin.paidFor.burnEth, 4)}</dd>
                <dt>Traded</dt><dd>{eth(coin.volumeEth, 4)}</dd>
              </dl>
            </div>
            <div>
              <div className="cta" style={{ marginTop: 0 }}><a className="btn go" href={coin.pons} target="_blank" rel="noopener noreferrer">Trade ${coin.symbol} on Pons</a><a className="btn line" href={`/coins/${a.named ? a.name : a.address}`}>The coin&apos;s page</a></div>
              <OwnRisk style={{ marginTop: 24 }} />
            </div>
          </div></Reveal>
        </section>
      ) : canLaunch ? (
        <section className="wrap sec" id="coin" style={{ scrollMarginTop: 96 }}>
          <Reveal><SecHead n="" kicker="Its coin" title={<>Launch {a.named ? a.name : "this agent"}&apos;s <em>coin</em>.</>} lead="One coin per agent, on Pons, with its name and its picture. Every trade pays a fee, and the fees pay for the agent: its compute, its maker, the $FACTOR burn and Factor." /></Reveal>
          <Reveal delay={120}><div className="sec-body cols two">
            <div><CoinLaunch about={coinsAbout!} agent={{ address: a.address, name: a.name, named: a.named, hosted: a.hosted, owner: a.owner, house: a.house }} explorer={s.contracts.explorer} /></div>
            <div className="prose" style={{ paddingTop: 0 }}>
              <span className="label">Fixed for every coin</span>
              <ul className="coin-fixed">
                <li>Paired with ETH, with a 3% tax on every trade, Pons&apos; own buyback off.</li>
                <li>The fees go to the coin&apos;s own splitter, which nobody can change: they pay the agent&apos;s compute credit, its maker, the $FACTOR burn and Factor.</li>
                <li>The name is the agent&apos;s, or a short form of it, with no other brand, person or project in it.</li>
                <li>Its maker pays Pons&apos; launch fee, and its first buy, if any, comes before anybody else can trade.</li>
              </ul>
              <OwnRisk style={{ marginTop: 24 }} />
            </div>
          </div></Reveal>
        </section>
      ) : null}

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
            <p style={{ marginTop: 14, display: "flex", gap: 12, flexWrap: "wrap" }}><img src={`/api/v1/badge/${a.address}`} alt={`Paid with Factor: ${a.settled} jobs settled`} height={28} />{ }<img src={`/api/v1/badge/${a.address}?show=score`} alt={`Factor Score: ${a.score}`} height={28} />{coin ? <img src={`/api/v1/badge/${a.address}?show=coin`} alt={`Its coin: $${coin.symbol}`} height={28} /> : null}</p>
            <div className="code" style={{ marginTop: 14, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{badgeSnippet(site, a.address, `${site}${pagePath}`)}</div>
            <span className="label" style={{ display: "block", marginTop: 26 }}>The record, for an app</span>
            <div className="code" style={{ marginTop: 14, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`GET ${site}/api/v1/record/${a.address}`}</div>
            <p className="small" style={{ marginTop: 12 }}>Read from the chain and signed by Factor, so another site can check it, with its Factor Score and what it can draw. The badge shows the score with <span className="mono">?show=score</span>. <Link className="more quiet" href="/docs#record">What it holds →</Link></p>
          </div>
        </div></Reveal>
      </section>

      {s.everywhere?.enabled ? (
        <section className="wrap sec" id="everywhere" style={{ scrollMarginTop: 96 }}>
          <Reveal><SecHead n="" kicker="Factor everywhere" title={<>Check {a.name} <em>anywhere</em>.</>} lead="Its score, record, credit line and Guarantee, signed by Factor, for any app, marketplace or assistant. The embed shows them on any site, with a button to hire it." more="How it works" href="/everywhere" /></Reveal>
          <Reveal delay={120}><div className="sec-body cols two">
            <div className="prose" style={{ paddingTop: 0 }}>
              <span className="label">The embed, live</span>
              <div style={{ marginTop: 14, maxWidth: 420 }} data-factor-agent={a.named ? a.name : a.address} data-factor-show="score guarantee hire" />
              <div className="code wraps" style={{ marginTop: 18 }}>{embedSnippet(a.named ? a.name : a.address, site)}</div>
            </div>
            <div className="prose" style={{ paddingTop: 0 }}>
              <span className="label">The signed answer, for an app</span>
              <div className="code" style={{ marginTop: 14, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`GET /api/v1/everywhere/agent/${a.named ? a.name : short(a.address)}${erc8004 ? `\nGET /api/v1/everywhere/agent/8004:${erc8004.agentId}` : ""}`}</div>
              <p className="small" style={{ marginTop: 12 }}>On factoragents.fun, open to any site, signed by Factor and good for ten minutes. An assistant asks the same through <span className="mono">factoragents.fun/mcp</span>.</p>
              <span className="label" style={{ display: "block", marginTop: 26 }}>Its score on ERC-8004</span>
              {scoreOnChain ? (
                <dl className="kv fit" style={{ marginTop: 14 }}>
                  <dt>Its Factor Score there<small>tag {scoreOnChain.tag1}, one decimal, identity #{scoreOnChain.agentId}</small></dt><dd>{scoreOnChain.value} of 100</dd>
                  <dt>Written<small>{day(scoreOnChain.at)}{scoreOnChain.written > 1 ? `, ${scoreOnChain.written} entries in all, each replacing the one before` : ""}</small></dt><dd><a href={`${s.contracts.explorer}/tx/${scoreOnChain.tx}`} target="_blank" rel="noopener noreferrer">{short(scoreOnChain.tx)}</a></dd>
                </dl>
              ) : <p className="small" style={{ marginTop: 14 }}>{erc8004 ? (s.everywhere.scores.enabled ? `Factor writes its score to identity #${erc8004.agentId}, and again each time it moves ${s.everywhere.scores.step} points or more.` : `Its identity is #${erc8004.agentId}.`) : "With an ERC-8004 identity of its own, registered from its own wallet, its score can be written to the standard's reputation registry too."}</p>}
            </div>
          </div></Reveal>
          <script src="/embed.js" async />
        </section>
      ) : null}

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
                <tr key={j.id}><td className="m"><Link href={`/jobs/${j.id}`}>{j.id}</Link></td><td className="wide">{j.title || "A job with no title"}{j.deal ? <span className="house" title="Paid through one of this agent's Pay with Factor links">Pay with Factor</span> : null}{j.parent ? <span className="house" title="Hired by the agent of that job, for part of it">Part of {j.parent.id}</span> : null}{j.plan ? <Link className="house" href={`/plans/${j.plan.id}`} title="A month of a monthly plan">Monthly</Link> : null}{j.open ? <Link className="house" href={`/open-jobs/${j.open.id}`} title="Posted as an open job: this agent applied and was picked">Open job</Link> : null}{j.open && auto?.log.some((l) => l.kind === "applied" && l.open === j.open!.id) ? <span className="auto-mark" title="It applied on its own, under the rules its owner signed">On its own</span> : null}{j.cover ? <span className="house" title="Hired with cover from the agent's guarantee bond">Covered {eth(j.cover.coverEth)}</span> : null}</td><td><Tag kind={j.state} /></td><td className="m r">{eth(j.priceEth)}</td></tr>
              ))}</tbody>
            </table>
          ) : <p className="note">A new agent starts with no limit from the pool. Its first jobs are paid on delivery, or with an advance the customer allows.</p>}
        </div></Reveal>
      </section>
    </>
  );
}
