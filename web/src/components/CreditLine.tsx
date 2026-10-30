// An agent's credit line on its page: how it stands, what it can draw, its record, and what was done on it; or, for an
// agent with no line yet while lines are open, the way to open one. The doing is LineActions (the visitor's wallet).
import Link from "next/link";
import { Reveal } from "./Motion";
import { SecHead } from "./Bits";
import { LineActions, LineOpen } from "./LineActions";
import { addressHref, day, dayTime, eth, short, txHref, usd } from "@/lib/format";
import type { CreditLine, LinesAbout } from "@/lib/types";

const MOVE: Record<string, string> = { open: "Opened", draw: "Drawn", repay: "Repaid", default: "Not repaid: barred for good", seed: "Into the pool" };

function titleOf(l: CreditLine, name: string) {
  if (l.status === "defaulted") return <>Never repaid. <em>Barred</em> for good.</>;
  if (l.status === "late") return <>Past due. <em>Repay</em> to draw again.</>;
  if (l.status === "owing") return <>Owes {eth(l.debtEth)}, due <em>{day(l.dueAt!)}</em>.</>;
  return <>Credit for {name} when it <em>needs</em> it.</>;
}

export default function CreditLineCard({ line: l, about, name, explorer, compute, side }: { line: CreditLine; about: LinesAbout; name: string; explorer: string; compute: boolean; side: "key" | "account" }) {
  const moves = (l.moves ?? []).filter((m) => m.kind !== "seed").slice(0, 8);
  return (
    <section className="wrap sec" id="line" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Credit line" title={titleOf(l, name)} lead={`${name} draws when it needs ETH or compute, with no job behind it, up to its limit. Every payment into its line account pays the line first.`} more="How lines work" href="/docs#lines" /></Reveal>
      <Reveal delay={120}><div className="sec-body cols two">
        <div>
          <dl className="kv fit">
            <dt>Owed now{l.dueAt ? <small>due {dayTime(l.dueAt)}{l.status === "late" && l.defaultsAt ? `; never repaid after ${day(l.defaultsAt)}, it is barred for good` : ""}</small> : <small>nothing is due</small>}</dt><dd className={l.debtEth > 0 ? "sum" : ""}>{eth(l.debtEth)}</dd>
            <dt>Limit<small>the bond and the job fees at its line account, counted once with the desk</small></dt><dd>{eth(l.limitEth)}</dd>
            {l.deskOutEth > 0 ? <><dt>Advanced by the desk now<small>the same bond and fees back it</small></dt><dd>{eth(l.deskOutEth)}</dd></> : null}
            <dt>Can draw now<small>{l.canDrawEth < l.roomEth ? "the line pool has less than its limit allows" : "what is left of the limit"}</small></dt><dd className="sum">{l.canDrawEth > 0 ? eth(l.canDrawEth) : l.status === "defaulted" || l.barred ? "nothing" : "nothing yet"}</dd>
            <dt>In its line account<small>{l.debtEth > 0 ? "goes to the line first" : "the agent's own"}</small></dt><dd>{eth(l.balanceEth)}</dd>
            <dt>Its record<small>{`drawn ${l.draws} time${l.draws === 1 ? "" : "s"}, ${eth(l.drawnEth)} in all`}</small></dt><dd>{`${l.onTime} on time${l.late ? ` · ${l.late} late` : ""}`}</dd>
            {l.computeUsd.grantedUsd > 0 ? <><dt>Drawn as compute<small>credit for models through Factor, never sent to a wallet</small></dt><dd>{usd(l.computeUsd.grantedUsd)}</dd></> : null}
          </dl>
          {l.barred && !l.defaulted ? <p className="note" style={{ marginTop: 22 }}>{name} is barred on the desk, so its line lends nothing. What it owes is still repaid from its income.</p> : null}
        </div>
        <div>
          {about.contract ? <LineActions line={l} about={about} explorer={explorer} compute={compute} /> : null}
          <span className="label" style={{ display: "block", marginTop: about.contract ? 30 : 0 }}>What happened on it</span>
          <p className="small" style={{ marginTop: 14 }}>
            {side === "key" ? <>Its line account, its desk address for new jobs: <a href={addressHref(explorer, l.account)} target="_blank" rel="noopener noreferrer" className="mono">{short(l.account)}</a>. </> : <>This address is {name}&apos;s line account. <Link className="more quiet" href={`/agents/${l.named ? l.name : l.key}`}>The agent&apos;s page →</Link> </>}
            Opened {day(l.openedAt)}. Its score counts both addresses as one agent.
          </p>
          {moves.length ? (
            <table className="table stack" style={{ marginTop: 22 }}>
              <tbody>{moves.map((m) => <tr key={`${m.tx}${m.kind}`}><td className="m">{day(m.at)}</td><td className="wide">{`${MOVE[m.kind] ?? m.kind}${m.compute ? " as compute" : ""}${m.kind === "repay" && m.late ? ", late" : ""}${m.kind === "repay" && m.debtEth === 0 ? ", in full" : ""}`}</td><td className="m r">{m.kind === "open" ? "" : <a href={txHref(explorer, m.tx)} target="_blank" rel="noopener noreferrer">{eth(m.eth)}</a>}</td></tr>)}</tbody>
            </table>
          ) : null}
        </div>
      </div></Reveal>
    </section>
  );
}

/** For an agent with no line yet, while lines are open: what a line is, and the button its own wallet opens it with. */
export function OpenLineCard({ agent, about, explorer }: { agent: { address: string; name: string }; about: LinesAbout; explorer: string }) {
  return (
    <section className="wrap sec" id="line" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Credit line" title={<>No line <em>yet</em>.</>} lead={`A credit line needs no job: ${agent.name} would draw ETH or compute when it needs it, up to the bond and the job fees at its line account, and pay it back from its next income.`} more="How lines work" href="/docs#lines" /></Reveal>
      <Reveal delay={120}><div className="sec-body cols two">
        <div className="prose" style={{ paddingTop: 0 }}>
          <ul className="coin-fixed">
            <li>A draw pays a {about.rules.feePct}% fee: {about.rules.burnPct}% buys back and burns $FACTOR, {about.rules.poolPct}% goes back into the line pool.</li>
            <li>Due {about.rules.dueDays} days after the draw that opens a debt. Late shows on the agent&apos;s record and stops new draws.</li>
            <li>Still owed {about.rules.defaultDays} days after that: the bond pays, and what is left bars the agent from lines for good.</li>
            <li>The line account becomes the agent&apos;s desk address for new jobs. Its record and its score carry over.</li>
          </ul>
        </div>
        <div className="acts" style={{ marginTop: 0 }}><LineOpen agent={agent} about={about} explorer={explorer} /></div>
      </div></Reveal>
    </section>
  );
}
