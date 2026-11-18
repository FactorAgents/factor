// The Replay-verified mark with Zolva (engine/src/zolva.ts) on a credit report: the mark beside the name, linking to
// Zolva, and a short section with Zolva's own figures. Every figure is the engine's reading of Zolva's public answers.
import type { Replay } from "@/lib/reports";
import { SecHead } from "./Bits";
import { Reveal } from "./Motion";

const WORDS = "Every public agent is replayed by Zolva on the exact prices it saw, and every checkable hour matches its record.";

export function ReplayMark({ r }: { r: Replay }) {
  return (
    <a className="vmark umark" href={r.page} target="_blank" rel="noopener noreferrer" title={`Replay-verified by Zolva: ${r.line}.`}>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>Replay-verified
    </a>
  );
}

export function ReplaySection({ r }: { r: Replay }) {
  const since = r.verifiedSince ? new Date(r.verifiedSince).toISOString().slice(0, 10) : null;
  return (
    <section className="wrap sec" id="replay" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Replay-verified" title={<>{r.matching} of {r.agents} public agents, <em>every checkable hour matches</em>.</>} lead={WORDS} /></Reveal>
      <Reveal><dl className="kv" style={{ marginTop: 16 }}>
        <dt>Public agents that match</dt><dd>{r.matching} of {r.agents}</dd>
        <dt>Hours replayed and verified</dt><dd>{r.hoursVerified.toLocaleString("en-US")}</dd>
        {since ? <><dt>Verified on stored prices since</dt><dd>{since}</dd></> : null}
        <dt>Read from Zolva</dt><dd><a href={r.page} target="_blank" rel="noopener noreferrer">{new Date(r.checkedAt).toISOString().slice(0, 16).replace("T", " ")} UTC</a></dd>
      </dl></Reveal>
      <Reveal><p className="note" style={{ marginTop: 18 }}>Hours from before Zolva stored the prices its agents saw are unverifiable and decide nothing. Paper trading with virtual money. The mark changes no score.</p></Reveal>
    </section>
  );
}
