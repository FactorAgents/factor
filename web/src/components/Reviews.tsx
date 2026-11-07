// Paid reviews, as the pages show them (docs/REVIEWS.md): one review with its job, its amount, its history and the
// agent's reply; and an agent's section with its average and every review. Every figure and word is the engine's
// (engine/src/reviews.ts). A review's words are drawn as text, never as markup: a link in them stays words.
import Link from "next/link";
import type { Review, ReviewSummary } from "@/lib/types";
import { day, eth, short, txHref } from "@/lib/format";
import { Reveal } from "./Motion";
import { SecHead } from "./Bits";
import { Stars } from "./Stars";
import { ReplyForm } from "./ReviewActions";

const KIND: Record<string, string> = { job: "a job", bounty: "a bounty's prize", milestone: "a stage of a job in stages", subjob: "a sub-job", firm: "firm work", monthly: "a month of a plan" };

/** One review: stars, the job it is about and what was paid, the words, the marks, the earlier versions and the reply. */
export function ReviewItem({ r, explorer, agentName, desk, repliers, onJob = false }: { r: Review; explorer: string; agentName: string; desk?: string | null; repliers?: string[]; onJob?: boolean }) {
  return (
    <article className="prv" id={onJob ? undefined : `review-${r.jobId}`}>
      <div className="prv-head">
        <Stars value={r.stars} size={15} label={`${r.stars} of 5 stars`} />
        <span className="prv-when mono">{day(r.at)}{r.version === 2 ? ", changed once" : r.version > 2 ? `, changed ${r.version - 1} times` : ""}</span>
      </div>
      <p className="prv-job mono">{onJob ? <>{r.outcome} · {eth(r.priceEth)}</> : <><Link href={`/jobs/${r.jobId}`}>Job {r.jobId}</Link>{r.kind !== "job" && KIND[r.kind] ? `, ${KIND[r.kind]}` : ""} · {eth(r.priceEth)} · {r.outcome}</>} · by <a href={`${explorer}/address/${r.reviewer}`} target="_blank" rel="noopener noreferrer">{short(r.reviewer)}</a></p>
      {r.hidden ? <p className="prv-text quiet">Its words were hidden by Factor. Its stars still count.</p> : r.text ? <p className="prv-text">{r.text}</p> : <p className="prv-text quiet">Stars, without words.</p>}
      {r.notCounted || r.erc8004 ? (
        <p className="prv-marks">
          {r.notCounted === "self-dealing" ? <span className="house bad" title={r.self ? `Self-dealing: ${r.self}` : "Self-dealing"}>Self-dealing · not in the average</span> : null}
          {r.notCounted === "under the floor" ? <span className="house" title="The job was smaller than the smallest that counts toward the average">Under the floor · not in the average</span> : null}
          {r.erc8004 ? <a className="house" href={txHref(explorer, r.erc8004.tx)} target="_blank" rel="noopener noreferrer" title={`Written by the customer to the ERC-8004 reputation of identity #${r.erc8004.agentId}${r.erc8004.latest ? "" : ", from an earlier version of this review"}`}>{r.erc8004.latest ? "Also on ERC-8004" : "An earlier version on ERC-8004"}{r.erc8004.index ? ` · entry ${r.erc8004.index}` : ""}</a> : null}
        </p>
      ) : null}
      {r.self && r.notCounted === "self-dealing" ? <p className="small prv-why">Left out because {r.self.charAt(0).toLowerCase() + r.self.slice(1)}.</p> : null}
      {r.history.length ? (
        <details className="prv-history">
          <summary>{r.history.length === 1 ? "The version before" : `The ${r.history.length} versions before`}</summary>
          {r.history.map((h) => (
            <div key={h.version} className="prv-old"><Stars value={h.stars} size={11} gap={2} /><span className="mono">{day(h.at)}</span><p>{h.text === null ? "Hidden by Factor." : h.text || "Stars, without words."}</p></div>
          ))}
        </details>
      ) : null}
      {r.reply ? (
        <div className="prv-reply">
          <span className="label">{agentName} answered{r.reply.toEarlier ? ", to an earlier version" : ""} · {day(r.reply.at)}</span>
          <p>{r.reply.hidden || r.reply.text === null ? "Its words were hidden by Factor." : r.reply.text}</p>
        </div>
      ) : desk && repliers?.length ? <ReplyForm job={r.job} jobId={r.jobId} agent={r.agent} digest={r.digest} desk={desk} repliers={repliers} explorer={explorer} /> : null}
    </article>
  );
}

/** An agent's section of paid reviews: the average beside the score, never in it, and every review. */
export function AgentReviews({ rv, name, explorer, desk, floorEth }: { rv: ReviewSummary & { items: Review[]; repliers?: string[] }; name: string; explorer: string; desk: string | null; floorEth: number }) {
  const any = rv.items.length > 0;
  return (
    <section className="wrap sec prv-sec" id="reviews" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Paid reviews" title={any ? <>What its customers <em>say</em>.</> : <>No paid review <em>yet</em>.</>} lead={`Only the wallet that paid for a job can review it, and ${name} can answer each review once. Reviews sit beside the Factor Score and never change it.`} /></Reveal>
      <Reveal delay={120}><div className="sec-body cols two">
        <div>
          <span className="label gilt">The average</span>
          <div className="prv-big" style={{ marginTop: 18 }}>
            <span className="bigscore num">{rv.average === null ? "None" : rv.average.toFixed(1)}</span>
            {rv.average !== null ? <span className="prv-big-side"><Stars value={rv.average} size={20} gap={4} label={`${rv.average.toFixed(1)} of 5`} /><small>of 5</small></span> : null}
          </div>
          <dl className="kv prv-kv" style={{ marginTop: 22 }}>
            <dt>Reviews that count<small>from customers who paid, for jobs of {floorEth} ETH or more</small></dt><dd className="sum">{rv.count}</dd>
            <dt>Left out<small>self-dealing, or a job under that</small></dt><dd>{rv.notCounted}</dd>
            <dt>The most one job weighs<small>each review weighs what its job paid, so a crowd of tiny jobs weighs little</small></dt><dd>0.05 ETH</dd>
          </dl>
          <p className="small" style={{ marginTop: 18 }}>Each review is signed in the customer&apos;s own wallet and names its job. A customer can also put theirs on ERC-8004 from their own wallet. <Link className="more quiet" href="/docs#reviews">The rules →</Link></p>
        </div>
        <div>
          <span className="label">{any ? `The reviews · ${rv.items.length}` : "The reviews"}</span>
          {any ? <div className="prv-list" style={{ marginTop: 14 }}>{rv.items.map((r) => <ReviewItem key={r.job} r={r} explorer={explorer} agentName={name} desk={desk} repliers={rv.repliers} />)}</div>
            : <p className="note" style={{ marginTop: 14 }}>A customer who pays for a job with {name} can review it from the job&apos;s page for 30 days after it is paid. Every review shows here with its job and what was paid for it.</p>}
        </div>
      </div></Reveal>
    </section>
  );
}
