"use client";
// The Recoverable mark with Upoch on the site (engine/src/recoverable.ts, docs/RELEASE-recoverable.md): the mark beside an
// agent's name, with its short line on hover, on focus and on a tap, and the Recovery section of its credit report with
// the evidence. Every figure is the engine's, read from Upoch's Epoch contract; nothing is worked out here. An agent with
// no Upoch workflow linked to it shows nothing at all.
import { useState } from "react";
import { dayTime, short } from "@/lib/format";
import { agoWords, linkWords, RECOVERABLE_WORDS, type Recovery, type RecoveryWorkflow } from "@/lib/recoverable";
import { SecHead } from "./Bits";
import { Reveal } from "./Motion";

/** A workflow's evidence in one line: the workflow, its last checkpoint, its guardians. `now` is the answer's own time. */
const evidence = (w: RecoveryWorkflow, now: number): string =>
  `${w.name}: last checkpoint ${agoWords(w.lastCheckpointAt, now)}, ${w.guardians} guardian${w.guardians === 1 ? "" : "s"}.`;

/** The mark: "Recoverable", with its line and the evidence on hover, focus and a tap. Only for an agent that is Recoverable. */
export function RecoverableMark({ mark, now, href }: { mark: Recovery; now: number; href?: string }) {
  const [open, setOpen] = useState(false);
  if (!mark.recoverable) return null;
  const text = `${RECOVERABLE_WORDS} ${evidence(mark.workflow, now)}`;
  return (
    <span className={`vmark rmark has-pop${open ? " open" : ""}`} tabIndex={0} role="button" aria-expanded={open} aria-label={`Recoverable. ${text}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } if (e.key === "Escape") setOpen(false); }} onBlur={() => setOpen(false)}>
      <RestoreIcon />Recoverable
      <span className="vpop" role="tooltip">
        <b>Recoverable</b>
        <span>{RECOVERABLE_WORDS}</span>
        <span className="rmark-ev">{evidence(mark.workflow, now)}</span>
        {href ? <a className="more quiet" href={href} onMouseDown={(e) => e.preventDefault()}>The evidence →</a> : null}
      </span>
    </span>
  );
}

/** The four conditions of the rule, each as the workflow shown meets it or not. */
function Conditions({ w, days }: { w: RecoveryWorkflow; days: number }) {
  const rows: [boolean, string][] = [
    [w.link.length > 0, "Linked: its owner or agentWallet runs the workflow"],
    [w.active, "Active, not paused"],
    [w.recent, `A checkpoint in the last ${days} days`],
    [w.guardian, "At least one guardian who can restore it"],
  ];
  return (
    <ul className="rconds">
      {rows.map(([ok, words]) => <li key={words} className={ok ? "ok" : "no"}>{ok ? <Yes /> : <No />}<span>{words}</span></li>)}
    </ul>
  );
}

/** The Recovery section of a credit report: the mark's line, the evidence, the rule, and any other workflow linked to it. */
export function RecoverySection({ r, now, explorer }: { r: Recovery; now: number; explorer: string }) {
  const w = r.workflow;
  const others = r.workflows.filter((x) => x.id !== w.id);
  return (
    <section className="wrap sec" id="recovery" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Recovery" title={r.recoverable ? <>Recoverable, checkpoints and recovery on <em>Upoch</em>.</> : <>Linked to <em>Upoch</em>, not Recoverable now.</>} lead="Upoch keeps checkpoints of an agent's workflow on the chain, and its guardians can restore the agent from them. An agent is Recoverable when one Upoch workflow linked to it is active, has a checkpoint in the last 7 days, and has a guardian. Checkpoints alone, or a timelock alone, do not count." /></Reveal>
      <Reveal delay={120}><div className="sec-body cols two">
        <div>
          <span className="label gilt">{r.recoverable ? <><RestoreIcon /> {w.name}</> : w.name}</span>
          <dl className="kv" style={{ marginTop: 16 }}>
            <dt>Linked by<small>{linkWords(w)}</small></dt><dd className="mono">{w.link[0] ? <a href={`${explorer}/address/${w.link[0].wallet}`} target="_blank" rel="noopener noreferrer">{short(w.link[0].wallet)}</a> : "not linked"}</dd>
            <dt>Status</dt><dd>{w.status === "active" ? "Active" : w.status === "paused" ? "Paused" : "Not active"}</dd>
            <dt>Last checkpoint<small>{w.lastCheckpointAt ? dayTime(w.lastCheckpointAt) : "none yet"}</small></dt><dd>{agoWords(w.lastCheckpointAt, now)}</dd>
            <dt>Checkpoints</dt><dd className="num">{w.checkpoints.toLocaleString("en-US")}</dd>
            <dt>Guardians<small>how many must agree to restore it</small></dt><dd>{w.guardians}, threshold {w.guardianThreshold}</dd>
            {w.timelockSeconds > 0 ? <><dt>Timelock<small>a delay on the owner&apos;s own rollback</small></dt><dd>{timeWords(w.timelockSeconds)}</dd></> : null}
          </dl>
        </div>
        <div>
          <span className="label">The rule</span>
          <Conditions w={w} days={r.rule.recentDays} />
          {!r.recoverable && w.why.length ? <p className="small" style={{ marginTop: 14 }}>Not Recoverable now: {w.why.join(", ")}.</p> : null}
          {others.length ? (
            <>
              <span className="label" style={{ display: "block", marginTop: 26 }}>Also linked</span>
              <ul className="rothers">
                {others.slice(0, 6).map((x) => <li key={x.id}><span>{x.name}</span><small>{x.recoverable ? "Recoverable" : x.why.join(", ")}</small></li>)}
              </ul>
            </>
          ) : null}
          <p className="small" style={{ marginTop: 18 }}>Read from Upoch&apos;s contract {r.contractUrl ? <a className="mono" href={r.contractUrl} target="_blank" rel="noopener noreferrer">{short(r.contract)}</a> : <span className="mono">{short(r.contract)}</span>} on Robinhood Chain, {agoWords(r.readAt, now)}.</p>
        </div>
      </div></Reveal>
    </section>
  );
}

const timeWords = (s: number): string => (s % 86_400 === 0 ? `${s / 86_400} day${s === 86_400 ? "" : "s"}` : s % 3600 === 0 ? `${s / 3600} hour${s === 3600 ? "" : "s"}` : `${Math.round(s / 60)} minutes`);

/** A circle turning back on itself: restored. */
export function RestoreIcon() {
  return <svg className="tick" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2.4 6a3.6 3.6 0 1 0 1.1-2.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><path d="M3.3 1.6v2.1h2.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /><circle cx="6" cy="6" r="1" fill="currentColor" /></svg>;
}

function Yes() {
  return <svg viewBox="0 0 12 12" width="12" height="12" aria-label="met"><circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M3.6 6.2l1.6 1.6 3.2-3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function No() {
  return <svg viewBox="0 0 12 12" width="12" height="12" aria-label="not met"><circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M4.2 4.2l3.6 3.6M7.8 4.2l-3.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>;
}
