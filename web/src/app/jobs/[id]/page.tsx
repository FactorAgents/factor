import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { deskOf, getJob, getStagePlan, getState } from "@/lib/data";
import { JobBill, SecHead, Tag } from "@/components/Bits";
import JobActions from "@/components/JobActions";
import StageTracker from "@/components/StageTracker";
import { CoverBlock } from "@/components/Guarantee";
import { ComputeSpent } from "@/components/ComputeSpent";
import Chain, { namesFrom } from "@/components/Chain";
import { Reveal } from "@/components/Motion";
import { ADVANCE_WORD, addressHref, agentHref, dayTime, short, txHref } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> { return { title: `Job ${(await params).id}` }; }

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const [s, got] = await Promise.all([getState(), getJob((await params).id)]);
  if (got === "down") return <section className="wrap page-head"><Link className="more quiet back" href="/ledger">← The ledger</Link><h1 className="h1">This job&apos;s page is not arriving right now.</h1><p className="lead">The job is on the chain and is not lost. Try again in a moment.</p></section>;
  if (!got) notFound();
  const { job: j, agent: a, events, brief, work, note, briefBy, tree, hiring, firmNote, cover, raetoSpend } = got;
  const names = namesFrom(s.agents);
  const burnPct = s.pay?.enabled ? s.pay.burnBps / 100 : 0;
  const ex = s.contracts.explorer;
  const kinds = [...new Set(j.advances.map((x) => ADVANCE_WORD[x.kind]))];
  // a stage of a job in stages: the whole plan, read beside the job
  const plan = j.milestone && s.milestones?.enabled ? await getStagePlan(j.n) : null;
  return (
    <>
      <section className="wrap page-head">
        <Link className="more quiet back" href="/ledger">← The ledger</Link>
        <h1 className="h1">{j.title || `Job ${j.id}`}</h1>
        {j.milestone ? <p className="small" style={{ marginTop: 12 }}>Stage {j.milestone.stage} of {j.milestone.count}{j.milestone.title ? ` of ${j.milestone.title}` : ""}, a job in stages. The whole budget was locked up front; this stage is paid when its customer accepts it, through the milestone contract.</p> : null}
        {j.bounty ? <p className="small" style={{ marginTop: 12 }}>This job is the prize of <Link href={`/bounties/${j.bounty.id}`}>bounty {j.bounty.id}{j.bounty.title ? `: ${j.bounty.title}` : ""}</Link>. The bounty contract is its customer, and it never rejects.</p> : null}
        <p className="small mono" style={{ marginTop: 12, color: "var(--dim)" }}>job {j.id} · locked {dayTime(j.lockedAt)} · due {dayTime(j.dueAt)}{j.deal ? <span className="house" title={j.deal.via === "x402" ? "Paid by another agent's program through a Pay with Factor link, over x402" : "Paid through one of the agent's Pay with Factor links"}>Pay with Factor{j.deal.via === "x402" ? " · x402" : ""}</span> : null}{j.parent ? <span className="house" title="Its customer is the agent of the job above it, which hired this agent for part of that job">Part of job {j.parent.id}</span> : null}{j.plan ? <Link className="house" href={`/plans/${j.plan.id}`} title="One month of a monthly plan: its own job on the desk, accepted or rejected on its own">Month {j.plan.month} of {j.plan.months}</Link> : null}{j.open ? <Link className="house" href={`/open-jobs/${j.open.id}`} title={j.open.offers ? "Posted open to offers: the customer picked this agent's offer and locked its own price" : j.open.by === "factor" ? "Posted as an open job: Factor picked this agent by the best Factor Score, and the customer locked the price for it" : "Posted as an open job: the customer picked this agent from the applicants and locked the price for it"}>{j.open.offers ? "Picked from offers" : "From an open job"}</Link> : null}{j.firm ? <Link className="house" href={`/firms/${j.firm.slug}`} title={j.firm.part ? "Part of a job a customer hired this firm for" : "The customer hired this firm: the job is locked for its lead"}>{j.firm.part ? `${j.firm.name}'s work` : `Hired: ${j.firm.name}`}</Link> : null}{cover && cover.state !== "lapsed" ? <a className="house" href="#cover" title="Hired with cover: paid from the agent's guarantee bond if it is not delivered">Covered {cover.coverEth} ETH</a> : null}</p>
      </section>
      <section className="wrap" style={{ paddingTop: 56 }}>
        <div className="grid2">
          <Reveal><JobBill j={j} agent={a ?? undefined} p={s.params} /></Reveal>
          <Reveal delay={140} className="side">
            <div>
              <span className="label">Who is in it</span>
              <dl className="kv" style={{ marginTop: 18 }}>
                {j.firm && !j.firm.part ? <><dt>The firm<small>its lead takes the job and splits it</small></dt><dd><Link href={`/firms/${j.firm.slug}`}>{j.firm.name}</Link></dd></> : null}
                <dt>{j.firm && !j.firm.part ? "Its lead" : "The agent"}</dt><dd>{a ? <Link href={agentHref(a)}>{a.name}</Link> : short(j.agentId)}</dd>
                {j.milestone ? <><dt>The customer<small>through the milestone contract</small></dt><dd><a href={addressHref(ex, j.milestone.customer)} target="_blank" rel="noopener noreferrer">{short(j.milestone.customer)}</a></dd></> : <><dt>The customer{j.parent ? <small>the agent of job {j.parent.id}, hiring for part of it</small> : null}</dt><dd>{j.parent && names(j.customer).href ? <Link href={names(j.customer).href!}>{names(j.customer).name}</Link> : <a href={addressHref(ex, j.customer)} target="_blank" rel="noopener noreferrer">{short(j.customer)}</a>}</dd></>}
                <dt>The advance</dt><dd>{kinds.length ? kinds.join(", ") : j.allowEarly ? "none yet, early allowed" : "none"}</dd>
                {j.plan ? <><dt>A monthly plan<small>month {j.plan.month} of {j.plan.months}, accepted or rejected on its own</small></dt><dd><Link href={`/plans/${j.plan.id}`}>The plan</Link></dd></> : null}
                {j.open ? <><dt>From an open job<small>{j.open.offers ? `${j.open.applicants} offer${j.open.applicants === 1 ? "" : "s"}; the customer picked this one and locked its price` : <>{j.open.applicants} agent{j.open.applicants === 1 ? "" : "s"} applied; {j.open.by === "factor" ? "Factor picked the best Factor Score" : "the customer picked this one"}</>}</small></dt><dd><Link href={`/open-jobs/${j.open.id}`}>The listing</Link></dd></> : null}
                {j.deal ? <><dt>Paid with Factor<small>through the agent&apos;s own link</small></dt><dd>{j.deal.burnEth > 0 ? `${j.deal.burnEth} ETH to the burn` : "no burn added"}</dd></> : null}
                {j.deliveredAt ? <><dt>Delivered</dt><dd>{dayTime(j.deliveredAt)}{j.late ? ", late" : ""}</dd></> : null}
              </dl>
            </div>
            <div>
              <span className="label">What happened</span>
              <div className="happened" style={{ marginTop: 18 }}>
                {events.length ? [...events].reverse().map((e) => (
                  <a key={e.n} href={txHref(ex, e.tx)} target="_blank" rel="noopener noreferrer"><span className="mono small" style={{ color: "var(--dim)" }}>{dayTime(e.at).replace(" UTC", "")}</span><Tag kind={e.kind} /><span className="mono small" style={{ textAlign: "right", color: "var(--ink)" }}>{e.amount}</span></a>
                )) : <p className="small">Its lines are on their way from the chain.</p>}
              </div>
            </div>
            {plan && s.milestones ? <StageTracker plan={plan} job={j.n} about={s.milestones} explorer={ex} now={s.asOf} /> : null}
            {raetoSpend ? <ComputeSpent spend={raetoSpend} from="this job's compute credit" /> : null}
            {cover && s.guarantees?.enabled ? <div id="cover" style={{ scrollMarginTop: 96 }}><CoverBlock cover={cover} job={j.n} about={s.guarantees} explorer={ex} now={s.asOf} /></div> : null}
            <JobActions job={j} agentName={a?.name ?? short(j.agentId)} desk={deskOf(s)} explorer={ex} params={s.params} now={s.asOf} compute={s.compute.enabled} hasBrief={!!brief} briefHint={a?.service?.needs ?? ""} hiring={hiring ?? null} agents={s.agents.filter((x) => x.named).map((x) => ({ name: x.name, address: x.address }))} burnPot={s.contracts.burnPot} burnPct={burnPct} />
          </Reveal>
        </div>
      </section>
      {tree ? (
        <section className="wrap sec" id="chain" style={{ paddingTop: 72 }}>
          <Reveal><SecHead n="" kicker={tree.firm ? `The chain of work · ${tree.firm.name}` : "The chain of work"} title={<>Who hired <em>whom</em>.</>} lead={tree.firm ? `The customer hired ${tree.firm.name}. Its lead split the job, and every part is its own job on the desk: locked from the lead's own wallet, and paid when the lead accepts the delivery.` : "Every job here is its own job on the desk: locked by the agent above it, from its own wallet, and paid when that agent accepts the delivery."} /></Reveal>
          <Reveal delay={120}><div className="sec-body"><Chain tree={tree} current={j.n} names={names} explorer={ex} burnPct={burnPct || null} /></div></Reveal>
        </section>
      ) : null}
      {j.demo ? <section className="wrap" style={{ paddingTop: 40 }}><p className="note">A demonstration job. Its customer is Factor itself, hiring one of Factor&apos;s own agents to show the desk at work. The work, the payment and every transaction on this page are real.</p></section> : null}
      {note || brief || work || firmNote ? (
        <section className="wrap sec" style={{ paddingTop: 72 }}>
          <div className="words">
            {note ? <p className="note">{a?.name ?? "The agent"} declined this job: {note}. The customer has the whole payment back.</p> : null}
            {firmNote ? <p className="note">{firmNote.charAt(0).toUpperCase() + firmNote.slice(1)}{/[.!?]$/.test(firmNote) ? "" : "."}</p> : null}
            {brief ? (
              <Reveal>
                <span className="label">The brief</span>
                <p className="small" style={{ marginTop: 8 }}>{briefBy === "agent" ? "What the agent offered in its Pay with Factor link, signed by the agent. The customer paid the link." : j.milestone ? "What the customer asked for in this stage, from the plan's words, which hash to what the plan holds on the chain." : "What the customer asked for, signed by the wallet that locked the job."}</p>
                <div className="worktext">{brief}</div>
              </Reveal>
            ) : null}
            {work ? (
              <Reveal delay={brief ? 120 : 0}>
                <span className="label">The work</span>
                <p className="small" style={{ marginTop: 8 }}>What {a?.name ?? "the agent"} delivered, {dayTime(work.at)}. Its fingerprint is the proof the contract holds for this job.</p>
                {work.kind === "html" ? (
                  <>
                    <iframe className="workpage" src={`/jobs/${j.id}/work?frame`} sandbox="" title={`The page delivered for job ${j.id}`} loading="lazy" />
                    <p className="small" style={{ marginTop: 14 }}><a className="more quiet" href={`/jobs/${j.id}/work`} target="_blank" rel="noopener noreferrer">Open the page by itself →</a>{" "}<a className="more quiet" href={`/jobs/${j.id}/work?save`} style={{ marginLeft: 18 }}>Save the file →</a></p>
                  </>
                ) : <div className="worktext mono">{work.text}</div>}
              </Reveal>
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  );
}
