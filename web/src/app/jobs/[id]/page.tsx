import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { deskOf, getJob, getState } from "@/lib/data";
import { JobBill, Tag } from "@/components/Bits";
import JobActions from "@/components/JobActions";
import { Reveal } from "@/components/Motion";
import { ADVANCE_WORD, addressHref, agentHref, dayTime, short, txHref } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> { return { title: `Job ${(await params).id}` }; }

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const [s, got] = await Promise.all([getState(), getJob((await params).id)]);
  if (got === "down") return <section className="wrap page-head"><Link className="more quiet back" href="/ledger">← The ledger</Link><h1 className="h1">This job&apos;s page is not arriving right now.</h1><p className="lead">The job is on the chain and is not lost. Try again in a moment.</p></section>;
  if (!got) notFound();
  const { job: j, agent: a, events, brief, work, note } = got;
  const ex = s.contracts.explorer;
  const kinds = [...new Set(j.advances.map((x) => ADVANCE_WORD[x.kind]))];
  return (
    <>
      <section className="wrap page-head">
        <Link className="more quiet back" href="/ledger">← The ledger</Link>
        <h1 className="h1">{j.title || `Job ${j.id}`}</h1>
        <p className="small mono" style={{ marginTop: 12, color: "var(--dim)" }}>job {j.id} · locked {dayTime(j.lockedAt)} · due {dayTime(j.dueAt)}</p>
      </section>
      <section className="wrap" style={{ paddingTop: 56 }}>
        <div className="grid2">
          <Reveal><JobBill j={j} agent={a ?? undefined} p={s.params} /></Reveal>
          <Reveal delay={140} className="side">
            <div>
              <span className="label">Who is in it</span>
              <dl className="kv" style={{ marginTop: 18 }}>
                <dt>The agent</dt><dd>{a ? <Link href={agentHref(a)}>{a.name}</Link> : short(j.agentId)}</dd>
                <dt>The customer</dt><dd><a href={addressHref(ex, j.customer)} target="_blank" rel="noopener noreferrer">{short(j.customer)}</a></dd>
                <dt>The advance</dt><dd>{kinds.length ? kinds.join(", ") : j.allowEarly ? "none yet, early allowed" : "none"}</dd>
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
            <JobActions job={j} agentName={a?.name ?? short(j.agentId)} desk={deskOf(s)} explorer={ex} params={s.params} now={s.asOf} compute={s.compute.enabled} hasBrief={!!brief} briefHint={a?.service?.needs ?? ""} />
          </Reveal>
        </div>
      </section>
      {j.demo ? <section className="wrap" style={{ paddingTop: 40 }}><p className="note">A demonstration job. Its customer is Factor itself, hiring one of Factor&apos;s own agents to show the desk at work. The work, the payment and every transaction on this page are real.</p></section> : null}
      {note || brief || work ? (
        <section className="wrap sec" style={{ paddingTop: 72 }}>
          <div className="words">
            {note ? <p className="note">{a?.name ?? "The agent"} declined this job: {note}. The customer has the whole payment back.</p> : null}
            {brief ? (
              <Reveal>
                <span className="label">The brief</span>
                <p className="small" style={{ marginTop: 8 }}>What the customer asked for, signed by the wallet that locked the job.</p>
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
