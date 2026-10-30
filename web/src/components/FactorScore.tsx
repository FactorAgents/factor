// The Factor Score, as an agent's page and a firm's page show it: the number, its five parts each with why it stands
// where it does, what the desk lets it draw, and the income behind it by the way each job came. Every figure and word
// is the engine's (engine/src/factorscore.ts): nothing is worked out here.
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import type { FactorScore } from "@/lib/types";
import { day, eth } from "@/lib/format";
import { passedWords } from "@/lib/verified";
import { VerifiedMark } from "./Verified";
import { Count, Reveal } from "./Motion";
import { SecHead } from "./Bits";

// "Monthly clients, sub-jobs and firm work"
const listed = (xs: string[]): string => { const t = xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] ?? ""; return t.charAt(0).toUpperCase() + t.slice(1); };
const WAY: Record<string, string> = { jobs: "Jobs", monthly: "Monthly clients", subjobs: "Sub-jobs", firm: "Firm work" };

export default function FactorScoreCard({ fs, who, file, desk, extra }: { fs: FactorScore; who: string; file?: ReactNode; desk?: string | null; extra?: string }) {
  const firm = fs.kind === "firm";
  const d = fs.draw;
  const total = fs.income.reduce((n, l) => ({ settled: n.settled + l.settled, half: n.half + l.settledAtHalf, value: n.value + l.valueEth, fees: n.fees + l.feesEth }), { settled: 0, half: 0, value: 0, fees: 0 });
  // only the ways it has been paid by: a page never shows empty counts. The others are named under the table.
  const shown = fs.income.filter((l) => l.settled || l.settledAtHalf);
  const others = fs.income.filter((l) => !l.settled && !l.settledAtHalf).map((l) => (firm && l.source === "jobs" ? "jobs hired through the firm" : (WAY[l.source] ?? l.name).toLowerCase()));
  const wayName = (source: string, name: string) => (firm && source === "jobs" ? "Jobs hired through the firm" : WAY[source] ?? name);
  return (
    <section className="wrap sec fs" id="score" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Factor Score" title={firm ? <>The firm&apos;s work, in <em>one number</em>.</> : <>All its paid work, in <em>one number</em>.</>} lead={firm ? "Every job customers hired the firm for, by the same formula as an agent's score, read from the desk job by job. Beside it, what can be drawn on the firm's jobs, and why." : "Every job it was paid for, whichever way the work came: hired by a customer, a monthly client, a part of another agent's job, or a firm's. Beside it, what the desk lets it draw, and why."} /></Reveal>
      <Reveal delay={120}><div className="sec-body cols two">
        <div>
          <span className="label gilt">Factor Score{firm ? " · the firm" : ""}</span>
          <div className="bigscore num" style={{ marginTop: 18 }}><Count to={fs.score} /><small>of {fs.of}</small></div>
          <p className="fs-summary">{fs.summary}</p>
          <div className="bars fs-parts">
            {fs.parts.map((p) => (
              <div className="b" key={p.key}>
                <span>{p.name} · {p.value}</span><span>{p.points} of {p.max}</span>
                <div className="score"><i style={{ ["--w" as string]: `${(p.points / p.max) * 100}%` }} /></div>
                <small className="why">{p.why}</small>
              </div>
            ))}
          </div>
          {fs.verifiedOwner ? (
            <div className="fs-trust">
              <span className="label">Beside the score</span>
              <div className="b"><span><VerifiedMark sources={fs.verifiedOwner.sources} checkedAt={fs.verifiedOwner.checkedAt} href="#verified" /></span><span className="mono small">checked {day(fs.verifiedOwner.checkedAt)}</span></div>
              <small className="why">A trust factor, not a part: the owner&apos;s wallet passed {passedWords(fs.verifiedOwner.sources)}. It adds no point, sets no limit and changes nothing on the chain.</small>
            </div>
          ) : null}
          {fs.less.why ? <p className="small" style={{ marginTop: 18 }}>Less {fs.less.points}: {fs.less.why}</p> : null}
          {fs.line && !fs.line.defaulted ? <p className="small" style={{ marginTop: 18 }}>{fs.line.points ? `Less ${-fs.line.points}: ` : ""}{fs.line.why} <Link className="more quiet" href="#line">Its line →</Link></p> : null}
          {fs.zero ? <p className="note" style={{ marginTop: 22 }}>{fs.zero}</p> : null}
          <p className="small" style={{ marginTop: 18 }}>{extra ? `${extra} ` : ""}{fs.line ? <>Its record carries over: this address and its {fs.line.role === "key" ? "line account" : "own wallet"}, <span className="mono" style={{ overflowWrap: "anywhere" }}>{fs.line.other.slice(0, 6)}…{fs.line.other.slice(-4)}</span>, count as one agent, worked out by Factor from the desk&apos;s records of both and the line contract. It moves no money.</> : firm ? <>Worked out by Factor from the jobs hired through the firm, each one on the desk. A firm has no record of its own on the chain.</> : <>It is the desk&apos;s own score: <span className="mono" style={{ overflowWrap: "anywhere" }}>score({who})</span> on the contract{desk ? <>, <span className="mono">{desk.slice(0, 6)}…{desk.slice(-4)}</span></> : null}, which anybody can read. It moves no money.</>} <Link className="more quiet" href="/docs#score">How it is worked out →</Link></p>
        </div>
        <div>
          <span className="label">{firm ? `What can be drawn · through ${d.through?.name ?? "its lead"}` : "What it can draw"}</span>
          <dl className="kv" style={{ marginTop: 18 }}>
            <dt>{firm ? "The lead's bond" : "Its own bond"}<small>pays first if an advance is not repaid</small></dt><dd>{eth(d.bondEth)}</dd>
            <dt>Fees {firm ? "the lead's" : "its"} jobs have paid in<small>the same fees as the score&apos;s first part</small></dt><dd>{eth(d.feesPaidEth)}</dd>
            <dt>Limit with the pool<small>the bond plus the fees, counted once</small></dt><dd>{eth(d.limitEth)}</dd>
            <dt>Out right now</dt><dd>{eth(d.outEth)}</dd>
            <dt>Can draw</dt><dd className="sum">{d.canDrawEth > 0 ? eth(d.canDrawEth) : d.barred ? "nothing" : "nothing yet"}</dd>
          </dl>
          {d.members?.length ? (
            <dl className="kv fit fs-members" style={{ marginTop: 22 }}>
              {d.members.map((m) => <Fragment key={m.address}><dt>{m.name}<small>{m.role === "lead" ? "the lead: draws on the firm's jobs" : "a member: draws on the parts it takes"}</small></dt><dd>{m.canDrawEth > 0 ? eth(m.canDrawEth) : m.barred ? "nothing" : "nothing yet"}</dd></Fragment>)}
            </dl>
          ) : null}
          <div className="fs-why">{d.why.map((w, i) => <p className="small" key={i}>{w}</p>)}</div>
          {file}
        </div>
      </div></Reveal>
      <Reveal delay={180}><div className="sec-body fs-income">
        <span className="label">Where it comes from</span>
        {shown.length ? <table className="table stack" style={{ marginTop: 14 }}>
          <thead><tr><th>The way the work came</th><th className="r">Paid in full</th><th className="r">At half</th><th className="r">Worth</th><th className="r">Fees into the pool</th></tr></thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.source}>
                <td className="wide"><b>{wayName(l.source, l.name)}</b><small className="why">{firm && l.source === "jobs" ? "hired by a customer, on the site, by a link or by program" : l.line}</small></td>
                <td className="m r" data-l="Paid in full">{l.settled}</td><td className="m r" data-l="At half">{l.settledAtHalf}</td><td className="m r" data-l="Worth">{l.valueEth ? eth(l.valueEth) : "none yet"}</td><td className="m r" data-l="Fees into the pool">{l.feesEth ? eth(l.feesEth) : "none yet"}</td>
              </tr>
            ))}
            <tr className="sum"><td className="wide"><b>All of it</b></td><td className="m r" data-l="Paid in full">{total.settled}</td><td className="m r" data-l="At half">{total.half}</td><td className="m r" data-l="Worth">{eth(total.value)}</td><td className="m r gilt" data-l="Fees into the pool">{eth(total.fees)}</td></tr>
          </tbody>
        </table> : <p className="note" style={{ marginTop: 14 }}>No job paid yet. The score starts with the first one, whichever way it comes.</p>}
        <p className="small" style={{ marginTop: 14 }}>
          Each job counts once.{others.length && shown.length ? ` ${listed(others)} count here too, the moment there are any.` : ""}{" "}
          {firm
            ? fs.hired.parts ? `${fs.hired.parts} part${fs.hired.parts === 1 ? " was" : "s were"} split out of these jobs (${fs.hired.toMembers ?? 0} to members${fs.hired.toOthers ? `, ${fs.hired.toOthers} to agents outside the firm` : ""}), paid out of the same money, so they are not counted again here: each is on its own agent's score.` : "No part has been split out of the firm's jobs yet."
            : fs.hired.parts ? `It also hired other agents for ${fs.hired.parts} part${fs.hired.parts === 1 ? "" : "s"} of its own jobs (${eth(fs.hired.valueEth)}), paid out of those jobs: that work is on their scores, not on this one.` : "It has not hired other agents for parts of its jobs."}
        </p>
      </div></Reveal>
    </section>
  );
}
