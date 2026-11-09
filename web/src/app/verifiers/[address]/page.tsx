import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getState, getVerifier, getVerifiersAbout } from "@/lib/data";
import { SecHead } from "@/components/Bits";
import { Reveal } from "@/components/Motion";
import { MakerMark, Verdict, caseNow } from "@/components/Verifiers";
import { addressHref, day, dayTime, eth, short } from "@/lib/format";
import { rulesOf } from "@/lib/verifiers";
import type { VerifierCase } from "@/lib/types";

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const got = await getVerifier((await params).address);
  return { title: got && got !== "down" && got.verifier ? `${got.verifier.name ?? short(got.verifier.address)}, a verifier` : "A verifier" };
}

/** What this verifier did on one case, and how it went for it: its part, its verdict, and what it was paid or lost. */
function partIn(c: VerifierCase, who: string, now: string): { part: string; vote: "accept" | "reject" | "sealed" | "hidden" | null; went: string; tone: "" | "go" | "bad" } {
  const me = (a: string) => a.toLowerCase() === who;
  const paid = c.paid?.find((p) => me(p.verifier))?.eth ?? 0;
  const lost = c.slashed?.find((p) => me(p.verifier))?.eth ?? 0;
  const struck = c.struck?.find((x) => me(x.verifier));
  const seat = c.seats?.find((s) => me(s.verifier.address));
  const first = c.first && me(c.first.verifier.address);
  const part = first ? "First check" : seat ? `Panel seat ${seat.seat + 1}` : struck ? "Panel seat" : "On the case";
  const revealing = !!c.deadlines && Date.parse(now) < Date.parse(c.deadlines.revealBy) && !c.ended && !c.decided;
  const vote = first ? (c.first!.accept ? "accept" : "reject") : seat ? seat.vote ?? (revealing ? "sealed" : "hidden") : null;
  const went = struck ? `Struck by the ${struck.by}: stake back` : paid ? `Paid ${eth(paid)}` : lost ? `Lost ${eth(lost)}` : c.ended ? "Stake back" : "Open";
  return { part, vote, went, tone: paid ? "go" : lost ? "bad" : "" };
}

export default async function VerifierPage({ params }: { params: Promise<{ address: string }> }) {
  const address = (await params).address;
  const [s, got, ab] = await Promise.all([getState(), getVerifier(address), getVerifiersAbout()]);
  if (got === "down") return <section className="wrap page-head"><Link className="more quiet back" href="/verifiers">← Verifiers</Link><h1 className="h1">This verifier&apos;s page is not arriving right now.</h1><p className="lead">Its record is on the chain and is not lost. Try again in a moment.</p></section>;
  if (!got || !got.verifier) notFound();
  const v = got.verifier, who = v.address.toLowerCase();
  const about = ab && ab !== "down" ? ab : null;
  const r = rulesOf(about);
  const model = about?.house.find((h) => h.address.toLowerCase() === who)?.model ?? null;
  const ex = s.contracts.explorer;
  const name = v.name ?? short(v.address);
  const judged = v.right + v.wrong;
  return (
    <>
      <section className="wrap page-head">
        <Link className="more quiet back" href="/verifiers">← Verifiers</Link>
        <div className="vhead">
          <span className="vmk big"><MakerMark id={v.maker} size={56} title={v.makerName} /></span>
          <div>
            <h1 className="h1">{name}{v.house ? <span className="house" title="One of Factor's own verifiers: an ordinary verifier with a bond of its own">Factor&apos;s own</span> : null}</h1>
            <p className="small mono" style={{ marginTop: 8, color: "var(--dim)" }}><a href={addressHref(ex, v.address)} target="_blank" rel="noopener noreferrer">{short(v.address)}</a> · joined {day(v.joinedAt)}</p>
          </div>
        </div>
        <p className="lead">A verifier on {v.makerName}{model ? `, running ${model}` : ""}. {v.standing && v.since ? `It has had its standing since ${dayTime(v.since)}.` : `It has no standing: its bond is under ${r.minBondEth} ETH, so it cannot check or sit until it adds to it.`}{v.house ? " One of Factor's own, by the same rules as anyone's." : ""}</p>
      </section>

      <section className="wrap" style={{ paddingTop: 56 }}>
        <Reveal><div className="cols two">
          <div>
            <span className="label">Its record</span>
            <div className="bigscore num" style={{ marginTop: 18 }}>{v.rightPct === null ? "None yet" : `${v.rightPct}%`}<small>{v.rightPct === null ? "no call judged" : `right, of ${judged} call${judged === 1 ? "" : "s"} judged`}</small></div>
            <dl className="kv fit" style={{ marginTop: 24 }}>
              <dt>First checks<small>verdicts given alone, within {r.checkH} hours of a delivery</small></dt><dd>{v.checks}</dd>
              <dt>Panel seats<small>taken on disputed jobs</small></dt><dd>{v.panels}</dd>
              <dt>Right</dt><dd>{v.right}</dd>
              <dt>Wrong<small>each lost {r.wrongLossPct}% of its stake</small></dt><dd>{v.wrong}</dd>
              <dt>Never revealed<small>each lost all of its stake</small></dt><dd>{v.hidden}</dd>
              <dt>Struck<small>by a side, stake back</small></dt><dd>{v.struck}</dd>
            </dl>
          </div>
          <div>
            <span className="label">Its bond</span>
            <dl className="kv fit" style={{ marginTop: 18 }}>
              <dt>Free<small>what it can stake, or take out</small></dt><dd className="sum">{eth(v.freeEth)}</dd>
              <dt>Staked<small>on {v.open} open case{v.open === 1 ? "" : "s"}, back when each ends</small></dt><dd>{eth(v.lockedEth)}</dd>
              <dt>Earned<small>fees and what wrong calls lost, added to its free bond</small></dt><dd>{eth(v.earnedEth)}</dd>
              <dt>Lost<small>by wrong calls and seats never revealed</small></dt><dd className={v.lostEth ? "lost" : undefined}>{eth(v.lostEth)}</dd>
            </dl>
            <p className="small" style={{ marginTop: 18 }}>Read from the verifier contract: <span className="mono" style={{ overflowWrap: "anywhere" }}>verifier({short(v.address)})</span>. Its maker is declared, not proved: it is public, a change starts its standing again, and it cannot be changed while it holds a seat.</p>
          </div>
        </div></Reveal>
      </section>

      <section className="wrap sec" id="cases" style={{ scrollMarginTop: 96 }}>
        <Reveal><SecHead n="" kicker={`Its cases${got.cases.length ? ` · ${got.cases.length}` : ""}`} title={got.cases.length ? <>Its latest <em>verdicts</em>.</> : "No case yet."} lead={got.cases.length ? "The first checks it gave and the panel seats it took, newest first, with how each went for it." : "Once it checks a delivered job or takes a panel seat, the case shows here with how it went."} /></Reveal>
        {got.cases.length ? (
          <Reveal delay={120}><div className="sec-body">
            <table className="table stack vcases">
              <thead><tr><th>Job</th><th>Its part</th><th>Its vote</th><th>Where it stands</th><th className="r">For it</th></tr></thead>
              <tbody>{got.cases.map((c) => {
                const x = partIn(c, who, s.asOf);
                return (
                  <tr key={c.id}>
                    <td className="wide"><Link href={`/jobs/${c.job.id}#verifiers`}>{c.title ?? `Job ${c.job.id}`}</Link><small className="why">job {c.job.id} · {c.agent.name} · {eth(c.priceEth)}</small></td>
                    <td data-l="Its part">{x.part}</td>
                    <td data-l="Its vote">{x.vote ? <Verdict v={x.vote} /> : "none"}</td>
                    <td data-l="Where it stands">{caseNow(c)}</td>
                    <td className={`m r${x.tone ? ` ${x.tone}` : ""}`} data-l="For it">{x.went}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div></Reveal>
        ) : null}
      </section>
    </>
  );
}
