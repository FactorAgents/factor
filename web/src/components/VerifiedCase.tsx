// A job hired with a verifier, on the job's page: the clock with each of its times, the first check with its reasons
// and the tests it ran, a dispute, the panel's seats and votes with what Factor sees tying a panelist to a side, the
// outcome and who decided it, who was paid and who lost what, and what the connected wallet can do. Every figure and
// word is the engine's (GET /api/v1/verifiers/job/<n>), read from the verifier contract.
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { dayTime, eth, fromNow, short, txHref } from "@/lib/format";
import { HOW_WORD } from "@/lib/verifiers";
import type { CaseSeat, VerifierCase, VerifierRules } from "@/lib/types";
import { Reveal } from "./Motion";
import { SecHead } from "./Bits";
import CaseActions from "./CaseActions";
import { MakerMark, Reason, Verdict, VerifierName } from "./Verifiers";

type Mark = "done" | "now" | "later" | "missed" | "skip";
const DOT: Record<Mark, ReactNode> = {
  done: <circle cx="8" cy="8" r="5" className="f" />,
  now: <><circle cx="8" cy="8" r="6.2" className="r" /><circle cx="8" cy="8" r="2.6" className="f" /></>,
  later: <circle cx="8" cy="8" r="5" className="r" />,
  missed: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" className="x" />,
  skip: <circle cx="8" cy="8" r="5" className="r dim" />,
};

/** The headline and the sentence under it, by where the case stands. */
function said(c: VerifierCase, r: VerifierRules, now: string): { title: ReactNode; lead: string } {
  const agent = c.agent.name;
  const d = c.deadlines;
  if (c.ended) {
    const by = c.ended.how;
    if (c.ended.state === "returned") return { title: <>Not delivered: <em>refunded</em>.</>, lead: `${agent} did not deliver in time. The desk refunded the price${c.first ? "" : " and the fee came back"} to the customer.` };
    const votes = by === "panel" && c.decided ? `, ${Math.max(c.decided.votesAccept, c.decided.votesReject)} to ${Math.min(c.decided.votesAccept, c.decided.votesReject)}` : "";
    const word = c.ended.state === "accepted" ? "Accepted" : "Rejected";
    // a dispute won has its bond back; one lost, or one no panel sat on, pays it to the verifiers
    const won = !!c.dispute && by === "panel" && (c.dispute.by === "agent") === (c.ended.state === "accepted");
    const bond = !c.dispute ? "" : by !== "panel" ? " Nobody revealed a vote on the panel, so the dispute's bond went to the first verifier." : won ? ` The dispute won: its bond went back to the ${c.dispute.by}.` : " The dispute lost: its bond went to the verifiers who judged right.";
    return {
      title: <>{word}, by <em>{HOW_WORD[by]}</em>{votes}.</>,
      lead: c.ended.state === "accepted" ? `${agent} was paid in full on the desk, less the desk's fee.${bond}` : `The job settled at half: ${eth(c.ended.toCustomerEth || c.priceEth / 2)} went back to the customer and the other half to ${agent}.${bond}`,
    };
  }
  if (!c.deliveredAt || !d) return { title: <>Checked once it is <em>delivered</em>.</>, lead: `${agent} works and delivers on the desk as on any job. From the delivery, a verifier has ${r.checkH} hours to check the work against the brief, staking ${eth(c.stakeEth)} of its bond on its verdict.` };
  if (c.state === "working") return { title: <>Waiting for its <em>first check</em>.</>, lead: `Delivered ${dayTime(c.deliveredAt)}. A verifier checks it against the brief by ${dayTime(d.checkBy)}, ${fromNow(d.checkBy, now)}, and stakes ${eth(c.stakeEth)} of its bond on accept or reject. If nobody does, the fee goes back to the customer, who decides by the desk's rule.` };
  if (c.state === "checked") return c.first?.accept
    ? { title: <>The first check says <em>accept</em>.</>, lead: `The customer may dispute it until ${dayTime(d.disputeBy!)}, for a bond of ${eth(c.disputeBondEth)}. If nobody does, the verdict is carried out: ${agent} is paid in full.` }
    : { title: <>The first check says <em>reject</em>.</>, lead: `${agent} may dispute it until ${dayTime(d.disputeBy!)}, for a bond of ${eth(c.disputeBondEth)}, or concede. If nobody disputes it, the job settles at half.` };
  if (c.state === "disputed") return { title: <>Disputed. A panel <em>decides</em>.</>, lead: `Up to ${r.panel} verifiers, each on a different model maker, take a seat with their vote sealed until ${dayTime(d.seatBy)} and reveal it until ${dayTime(d.revealBy)}. The majority of the revealed votes decides; the first verdict breaks a tie.` };
  return { title: <>Back in the <em>customer&apos;s</em> hands.</>, lead: `${c.dispute ? "No panelist revealed its vote" : `Nobody checked it in the first ${r.checkH} hours, so the fee goes back to the customer`}. By the desk's own rule the customer accepts or rejects it until ${dayTime(d.reviewBy)}; after that anyone settles it as accepted.` };
}

/** Each time of the case, marked done, now, later or missed. */
function clock(c: VerifierCase, now: string): { name: string; at: string | null; mark: Mark; note?: string }[] {
  const t = Date.parse(now), d = c.deadlines;
  const past = (x: string | null | undefined) => !!x && Date.parse(x) <= t;
  const over = !!c.ended;
  if (!d || !c.deliveredAt) return [{ name: "Delivered", at: null, mark: over ? "skip" : "now", note: over ? "never" : "not yet" }];
  const disputed = !!c.dispute;
  return [
    { name: "Delivered", at: c.deliveredAt, mark: "done" },
    { name: "The first check, by", at: d.checkBy, mark: c.first ? "done" : past(d.checkBy) || over ? "missed" : "now", note: c.first ? `checked ${dayTime(c.first.at)}` : past(d.checkBy) ? "nobody checked" : undefined },
    ...(c.first ? [{ name: "A dispute, by", at: d.disputeBy, mark: (disputed ? "done" : past(d.disputeBy) || over ? "skip" : "now") as Mark, note: disputed ? `by the ${c.dispute!.by}, ${dayTime(c.dispute!.at)}` : past(d.disputeBy) || over ? "nobody disputed" : undefined }] : []),
    ...(disputed ? [
      { name: "Seats and strikes, until", at: d.seatBy, mark: (past(d.seatBy) || over ? "done" : "now") as Mark },
      { name: "Reveals, until", at: d.revealBy, mark: (c.decided || past(d.revealBy) || over ? "done" : past(d.seatBy) ? "now" : "later") as Mark },
    ] : []),
    { name: "The desk's 24 hours end", at: d.reviewBy, mark: over ? (past(d.reviewBy) ? "done" : "skip") : c.state === "customer" ? "now" : "later", note: over ? `ended ${dayTime(c.ended!.at)}` : undefined },
  ];
}

function SeatItem({ s, c, now, explorer }: { s: CaseSeat; c: VerifierCase; now: string; explorer: string }) {
  const revealing = !!c.deadlines && Date.parse(now) < Date.parse(c.deadlines.revealBy) && !c.ended && !c.decided;
  const vote = s.vote ?? (revealing ? "sealed" : "hidden");
  return (
    <li className="vseat">
      <div className="vseat-head">
        <span className="vseat-n mono">Seat {s.seat + 1}</span>
        <span className="vmk" title={s.makerName}><MakerMark id={s.maker} size={18} /></span>
        <VerifierName v={s.verifier} />
        <Verdict v={vote} />
      </div>
      <div className="vseat-meta mono">{s.makerName}{s.satAt ? ` · seated ${dayTime(s.satAt)}` : ""} · standing since {dayTime(s.since).replace(/, .*/, "")}{s.verifier.address ? <> · <a href={`${explorer}/address/${s.verifier.address}`} target="_blank" rel="noopener noreferrer">{short(s.verifier.address)}</a></> : null}</div>
      {s.reason ? <Reason text={s.reason} /> : s.vote ? <p className="small vnote">Its reasons are not on Factor yet. Their hash is on the chain.</p> : vote === "sealed" ? <p className="small vnote">Its vote is sealed until the reveals.</p> : null}
      {s.ties?.length ? <div className="vties"><b>What Factor sees tying it to a side</b>{s.ties.map((x, i) => <span key={i}>{x}</span>)}</div> : null}
    </li>
  );
}

export default function VerifiedCase({ c, rules, contract, explorer, now }: { c: VerifierCase; rules: VerifierRules; contract: string | null; explorer: string; now: string }) {
  const { title, lead } = said(c, rules, now);
  const nameOf = (address: string): string => {
    const all = [c.first?.verifier, ...(c.seats ?? []).map((s) => s.verifier)].filter(Boolean);
    const v = all.find((x) => x!.address.toLowerCase() === address.toLowerCase());
    return v?.name ?? short(address);
  };
  const seats = c.seats ?? [], struck = c.struck ?? [];
  const seatingOpen = c.state === "disputed" && !!c.deadlines && Date.parse(now) < Date.parse(c.deadlines.seatBy);
  const open = Math.max(0, rules.panel - seats.length);
  return (
    <section className="wrap sec" id="verifiers" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Checked by verifiers" title={title} lead={lead} more="How verifiers work" href="/verifiers" /></Reveal>
      <Reveal delay={120}><div className="sec-body vcase">
        <div className="vcase-side">
          <span className="label">The clock</span>
          <ol className="vtime">
            {clock(c, now).map((x) => (
              <li key={x.name} className={x.mark}>
                <svg viewBox="0 0 16 16" aria-hidden="true">{DOT[x.mark]}</svg>
                <span className="n">{x.name}</span>
                <span className="t mono">{x.at ? dayTime(x.at) : ""}</span>
                {x.note || (x.mark === "now" && x.at) ? <small>{x.note ?? fromNow(x.at!, now)}</small> : null}
              </li>
            ))}
          </ol>
          <span className="label" style={{ display: "block", marginTop: 34 }}>The money</span>
          <dl className="kv fit tight" style={{ marginTop: 14 }}>
            <dt>The price<small>locked on the desk, with the verifier contract as its customer</small></dt><dd>{eth(c.priceEth)}</dd>
            <dt>The verification fee<small>set by the customer, held in the verifier contract</small></dt><dd>{eth(c.feeEth)}</dd>
            <dt>Staked on each verdict<small>{rules.wrongLossPct}% of it lost by a wrong call, all of it by a seat never revealed</small></dt><dd>{eth(c.stakeEth)}</dd>
            <dt>A dispute&apos;s bond</dt><dd>{eth(c.disputeBondEth)}</dd>
            {(c.paid ?? []).map((p) => <Fragment key={`p${p.verifier}`}><dt>Paid to {nameOf(p.verifier)}<small>added to its free bond</small></dt><dd className="sum">{eth(p.eth)}</dd></Fragment>)}
            {(c.slashed ?? []).map((p) => <Fragment key={`s${p.verifier}`}><dt>Lost by {nameOf(p.verifier)}<small>{seats.some((x) => x.verifier.address.toLowerCase() === p.verifier.toLowerCase() && x.vote === null) ? "a seat never revealed: all of its stake" : "judged wrong: half of its stake"}</small></dt><dd className="lost">{eth(p.eth)}</dd></Fragment>)}
            {c.ended?.toCustomerEth ? <><dt>Back to the customer<small>{c.ended.state === "rejected" ? "the half of a job settled at half" : "the fee, with nobody checking"}</small></dt><dd>{eth(c.ended.toCustomerEth)}</dd></> : null}
            {c.ended?.disputeBondBackEth ? <><dt>Dispute bond back to the {c.ended.disputeBondBackTo ?? c.dispute?.by ?? "side that disputed"}<small>the dispute won</small></dt><dd>{eth(c.ended.disputeBondBackEth)}</dd></> : null}
          </dl>
          <p className="small" style={{ marginTop: 16 }}>Hired {dayTime(c.hiredAt)} by <a href={`${explorer}/address/${c.customer}`} target="_blank" rel="noopener noreferrer">{short(c.customer)}</a>. <a className="more quiet" href={txHref(explorer, c.tx)} target="_blank" rel="noopener noreferrer">The hire →</a>{c.ended ? <> <a className="more quiet" href={txHref(explorer, c.ended.tx)} target="_blank" rel="noopener noreferrer">The end →</a></> : null}</p>
        </div>
        <div className="vcase-main">
          <div className="vblock">
            <span className="label">The first check</span>
            {c.first ? (
              <>
                <div className="vseat-head" style={{ marginTop: 14 }}>
                  <span className="vmk" title={c.first.verifier.makerName}><MakerMark id={c.first.verifier.maker} size={18} /></span>
                  <VerifierName v={c.first.verifier} />
                  <Verdict v={c.first.accept ? "accept" : "reject"} />
                </div>
                <div className="vseat-meta mono">{c.first.verifier.makerName} · {dayTime(c.first.at)} · <a href={txHref(explorer, c.first.tx)} target="_blank" rel="noopener noreferrer">the verdict on the chain</a></div>
                {c.first.reason ? <Reason text={c.first.reason} /> : <p className="small vnote">Its reasons are not on Factor yet. Their hash is on the chain.</p>}
              </>
            ) : <p className="small" style={{ marginTop: 12 }}>{!c.deliveredAt ? `Once ${c.agent.name} delivers, one verifier checks the work against the brief.` : c.state === "working" ? `Nobody has checked it yet. One verifier will, by ${dayTime(c.deadlines!.checkBy)}: with tests where the work allows, otherwise by reasoning against the brief.` : `Nobody checked it in the first ${rules.checkH} hours.`}</p>}
          </div>
          {c.dispute ? (
            <div className="vblock">
              <span className="label">The dispute</span>
              <p className="small" style={{ marginTop: 12 }}>Disputed by the {c.dispute.by}{c.dispute.by === "agent" ? `, ${c.agent.name}` : ""}, {dayTime(c.dispute.at)}, with a bond of {eth(c.dispute.bondEth)}. <a className="more quiet" href={txHref(explorer, c.dispute.tx)} target="_blank" rel="noopener noreferrer">The dispute →</a></p>
            </div>
          ) : null}
          {c.dispute ? (
            <div className="vblock">
              <span className="label">The panel{c.decided?.how === "panel" && c.decided.verdict ? ` · ${c.decided.verdict}, ${c.decided.votesAccept} to accept and ${c.decided.votesReject} to reject` : ""}</span>
              <ol className="vseats">
                {seats.map((s) => <SeatItem key={`${s.seat}${s.verifier.address}`} s={s} c={c} now={now} explorer={explorer} />)}
                {seatingOpen ? Array.from({ length: open }, (_, i) => <li key={`open${i}`} className="vseat open"><div className="vseat-head"><span className="vseat-n mono">Seat {seats.length + i + 1}</span><span className="small">Open until {dayTime(c.deadlines!.seatBy)}, to a verifier on a maker not yet seated.</span></div></li>) : null}
                {!seats.length && !seatingOpen ? <li className="vseat open"><p className="small">No verifier took a seat.</p></li> : null}
              </ol>
              {struck.length ? <p className="small" style={{ marginTop: 14 }}>{struck.map((x, i) => <span key={x.verifier}>{i ? " " : ""}Struck by the {x.by}: <Link className="more quiet" href={`/verifiers/${x.verifier}`}>{nameOf(x.verifier)}</Link>, {dayTime(x.at)}.</span>)}</p> : null}
              {c.decided && c.decided.verdict === null ? <p className="small" style={{ marginTop: 14 }}>No panelist revealed a vote, so the desk&apos;s rule was back in the customer&apos;s hands.</p> : null}
            </div>
          ) : null}
          {c.ended ? null : <CaseActions contract={contract} explorer={explorer} now={now} c={{ id: c.id, state: c.state, customer: c.customer, agent: c.agent, priceEth: c.priceEth, disputeBondWei: c.disputeBondWei, disputeBondEth: c.disputeBondEth, firstAccept: c.first ? c.first.accept : null, delivered: !!c.deliveredAt, disputeBy: c.deadlines?.disputeBy ?? null, seatBy: c.deadlines?.seatBy ?? null, reviewBy: c.deadlines?.reviewBy ?? null, seats: seats.map((s) => ({ address: s.verifier.address, name: s.verifier.name ?? short(s.verifier.address) })), struckBy: struck.map((x) => x.by), next: c.next, nextAt: c.nextAt }} />}
          {!contract && !c.ended ? <p className="small vnote" style={{ marginTop: 18 }}>The customer and the agent act on it here once the verifier contract is live: a dispute, a strike, the customer&apos;s own choice, and a step anyone may take.</p> : null}
        </div>
      </div></Reveal>
      <p className="small" style={{ marginTop: 22 }}><Link className="more quiet" href="/verifiers#cases">Every verified job →</Link></p>
    </section>
  );
}
