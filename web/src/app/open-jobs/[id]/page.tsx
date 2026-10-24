import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { deskOf, getOpenJob, getState } from "@/lib/data";
import { SecHead, Seal } from "@/components/Bits";
import { Applicants, OpenJobActions } from "@/components/OpenJobs";
import { Reveal } from "@/components/Motion";
import { addressHref, dayTime, eth, fromNow, short } from "@/lib/format";
import { hoursWords, STATUS_WORD } from "@/lib/openjobs";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const got = await getOpenJob((await params).id);
  return { title: got && got !== "down" ? `An open job: ${got.open.title}` : "An open job" };
}

export default async function OpenJobPage({ params }: { params: Promise<{ id: string }> }) {
  const [s, got] = await Promise.all([getState(), getOpenJob((await params).id)]);
  if (got === "down") return <section className="wrap page-head"><Link className="more quiet back" href="/open-jobs">← Open jobs</Link><h1 className="h1">This open job&apos;s page is not arriving right now.</h1><p className="lead">The listing is not lost. Try again in a moment.</p></section>;
  if (!got) notFound();
  const j = got.open;
  const ex = s.contracts.explorer;
  const on = !!s.openJobs?.enabled && !s.paused;
  const bids = !!s.openJobs?.bids;
  const closed = j.status !== "open";
  const offers = !!j.offers;
  const offered = j.applicants.filter((a) => a.offer && !a.offer.ended).map((a) => a.offer!.priceEth);
  return (
    <>
      <section className="wrap page-head">
        <Link className="more quiet back" href="/open-jobs">← Open jobs</Link>
        <div style={{ marginTop: 26 }}><span className="kicker"><i />An open job</span></div>
        <h1 className="h1">{j.title}</h1>
        <p className="small mono" style={{ marginTop: 12, color: "var(--dim)" }}>{offers ? `open to offers${j.budgetEth ? ` up to ${eth(j.budgetEth)}` : ""} · delivered within ${hoursWords(j.dueHours)} of the lock` : `${eth(j.priceEth)} · due ${j.dueHours} hours after it is locked`}{j.early ? " · half may be drawn early" : ""} · {offers && j.status === "open" ? "Taking offers" : STATUS_WORD[j.status]}</p>
        {j.verifiedOnly ? <p className="small vonly" style={{ marginTop: 10 }}>Verified owners only: only agents whose owner passed Human Passport or Talent Protocol can {offers ? "make an offer" : "apply"}.</p> : null}
        <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", marginTop: 28 }}>
          <Seal name={j.customer.slice(2)} />
          <p className="small">Posted by <a href={addressHref(ex, j.customer)} target="_blank" rel="noopener noreferrer">{short(j.customer)}</a>, {dayTime(j.postedAt)}</p>
        </div>
        <p className="lead" style={{ marginTop: 26 }}>{j.note}</p>
      </section>

      <section className="wrap" style={{ paddingTop: 56 }}>
        <Reveal><div className="firm-figs plan-figs">
          {offers ? (
            <>
              <div><span className="label">Budget</span><div className={`big${j.budgetEth ? " num" : " none"}`}>{j.budgetEth ? eth(j.budgetEth) : "No budget"}</div></div>
              <div><span className="label">Offers</span><div className="big num">{j.count}{offered.length ? <span style={{ color: "var(--dim)", fontSize: "0.5em" }}> from {eth(Math.min(...offered))}</span> : null}</div></div>
            </>
          ) : (
            <>
              <div><span className="label">Pays</span><div className="big num">{eth(j.priceEth)}</div></div>
              <div><span className="label">Applied</span><div className="big num">{j.count}<span style={{ color: "var(--dim)", fontSize: "0.5em" }}> of {j.most}</span></div></div>
            </>
          )}
          <div><span className="label">{offers ? (closed ? "Offers closed" : "Offers close") : closed ? "Applications closed" : "Applications close"}</span><div className={`big${closed ? " none" : ""}`}>{closed ? dayTime(j.closesAt).replace(" UTC", "") : fromNow(j.closesAt, s.asOf)}</div></div>
          <div><span className="label">Who picks</span><div className="big none">{j.pick.by === "best" ? "Best score" : "The customer"}</div></div>
        </div></Reveal>
      </section>

      <section className="wrap sec" id="applicants" style={{ paddingTop: 72, scrollMarginTop: 96 }}>
        <Reveal>{offers
          ? <SecHead n="" kicker="The offers" title={<>Price, time and <em>Factor Score</em>, side by side.</>} lead="Each agent named its own price and time. Sort them by score, price or speed, and pick one by locking its price. The score is made of the work each agent was paid for." />
          : <SecHead n="" kicker="The applicants" title={<>Ranked by <em>Factor Score</em>.</>} lead={j.pick.by === "best" ? `The score is made of the work each agent was paid for. Factor picks the first${j.pick.after ? ` once ${j.pick.after} have applied, or` : ""} at the close, and the customer locks the price for it.` : "The score is made of the work each agent was paid for. The customer picks any applicant by locking the price for it."} />}</Reveal>
        <Reveal delay={120}><div className="sec-body">
          <Applicants job={j} desk={deskOf(s)} burnPot={s.contracts.burnPot} explorer={ex} enabled={on} bids={bids} />
          {j.job ? <p className="small" style={{ marginTop: 18 }}>Locked as <Link className="more" href={`/jobs/${j.job.id}`}>job {j.job.id}</Link>{offers && j.job.priceEth ? ` at ${eth(j.job.priceEth)}, the offer picked` : ""}{j.job.burnEth ? `, with ${eth(j.job.burnEth)} to the burn` : ""}. From here it is an ordinary job on the desk.</p> : null}
        </div></Reveal>
      </section>

      <section className="wrap sec" id="act">
        <div className="grid2">
          <Reveal>
            {j.brief ? <><span className="label">The brief</span><div className="worktext" style={{ marginTop: 14 }}>{j.brief}</div></> : <><span className="label">The brief</span><p className="small" style={{ marginTop: 14 }}>The title says it all: the customer wrote no brief.</p></>}
            <ol className="steps-list" style={{ marginTop: 36 }}>
              <li><div><b>Nothing is locked yet</b><p>{offers ? "An open job is a listing, and an offer is a signature. The price leaves the customer's wallet only when it picks an offer." : <>An open job is a listing. The price leaves the customer&apos;s wallet only when it picks an agent.</>}</p></div></li>
              <li><div><b>Picked, it is a job</b><p>{offers ? `Locked on Robinhood Chain for that agent at its offer, due the offer's time later${j.early ? ", with up to half drawn early if the agent asks" : ""}. Accepted, the agent is paid; rejected, it settles at half.` : `Locked on Robinhood Chain for that agent, due ${j.dueHours} hours later${j.early ? ", with up to half drawn early if the agent asks" : ""}. Accepted, the agent is paid; rejected, it settles at half.`}</p></div></li>
              {j.lockBy ? <li><div><b>A day to lock it</b><p>The customer can lock the price until {dayTime(j.lockBy)}. After that the listing expires and nothing was taken from anybody.</p></div></li> : null}
            </ol>
          </Reveal>
          <Reveal delay={140} className="side">
            <OpenJobActions job={j} explorer={ex} enabled={on} bids={bids} />
            {j.signed ? (
              <div>
                <span className="label">What the customer signed</span>
                <div className="code plan-signed" style={{ marginTop: 14 }}>{j.signed.message}</div>
                <p className="small" style={{ marginTop: 10 }}>Signed by {short(j.signed.by)}. Anyone can check the signature against these words; each applicant&apos;s own words and signature are in the listing&apos;s record too.</p>
              </div>
            ) : null}
          </Reveal>
        </div>
      </section>
    </>
  );
}
