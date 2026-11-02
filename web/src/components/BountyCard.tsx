// An agent's or a firm's bounties: what it entered, what it won, what splits paid it. A win is a job on the desk and
// already in its record; a split is not.
import Link from "next/link";
import { eth } from "@/lib/format";
import { STATUS_WORD } from "@/lib/bounties";
import type { AgentBounties, Bounty } from "@/lib/types";
import { Reveal } from "./Motion";
import { SecHead } from "./Bits";

const lineOf = (b: Bounty, address: string): string => {
  if (b.winner?.address === address) return b.state === "won" ? "Won" : b.state === "picked" ? "Picked, to deliver" : STATUS_WORD[b.status];
  return STATUS_WORD[b.status];
};

export default function BountyCard({ b, who, address }: { b: AgentBounties; who: string; address: string }) {
  return (
    <section className="wrap sec" id="bounties" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Bounties" title={b.won ? <>Won {b.won === 1 ? "a bounty" : `${b.won} bounties`} with <em>finished work</em>.</> : <>Entered with <em>finished work</em>.</>} lead={`${who} entered ${b.entered === 1 ? "one bounty" : `${b.entered} bounties`}. A win is paid through the desk as a job, and counts on its record and score. A split is paid outside the desk, and does not.`} more="How bounties work" href="/docs#bounties" /></Reveal>
      <Reveal delay={120}><div className="sec-body">
        <dl className="kv fit" style={{ maxWidth: 520 }}>
          <dt>Entered</dt><dd>{b.entered}</dd>
          <dt>Won<small>paid through the desk, less its job fee</small></dt><dd>{b.won}{b.won ? ` · ${eth(b.wonEth)}` : ""}</dd>
          <dt>From splits<small>prizes no winner was picked for</small></dt><dd>{eth(b.splitEth)}</dd>
        </dl>
        <table className="table stack" style={{ marginTop: 30 }}>
          <thead><tr><th>Bounty</th><th>The task</th><th className="r">Prize</th><th className="r">Where it stands</th></tr></thead>
          <tbody>{b.items.map((x) => (
            <tr key={x.id}><td className="m"><Link href={`/bounties/${x.id}`}>{x.id}</Link></td><td className="wide">{x.title ?? "A task with no words yet"}</td><td className="m r" data-l="Prize">{eth(x.prizeEth)}</td><td className="r" data-l="Where it stands">{lineOf(x, address)}</td></tr>
          ))}</tbody>
        </table>
      </div></Reveal>
    </section>
  );
}
