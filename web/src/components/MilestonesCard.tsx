// An agent's jobs in stages: the plans it was hired for, how far each went, and the stages it was paid for. Each paid
// stage is a job on the desk and already in its record and score.
import Link from "next/link";
import { eth } from "@/lib/format";
import { PLAN_WORD } from "@/lib/milestones";
import type { AgentMilestones } from "@/lib/types";
import { Reveal } from "./Motion";
import { SecHead } from "./Bits";

export default function MilestonesCard({ m, who }: { m: AgentMilestones; who: string }) {
  return (
    <section className="wrap sec" id="milestones" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Jobs in stages" title={<>Paid stage by <em>stage</em>.</>} lead={`${who} was hired for ${m.plans === 1 ? "one job" : `${m.plans} jobs`} in stages, with the whole budget locked up front. Each stage is paid through the desk when its customer accepts it, and counts on its record and score like any job.`} more="How jobs in stages work" href="/docs#milestones" /></Reveal>
      <Reveal delay={120}><div className="sec-body">
        <dl className="kv fit" style={{ maxWidth: 520 }}>
          <dt>Jobs in stages</dt><dd>{m.plans}{m.running ? ` · ${m.running} running` : ""}</dd>
          <dt>Stages paid<small>through the desk, less its job fee</small></dt><dd>{m.stagesPaid}{m.stagesPaid ? ` · ${eth(m.paidEth)}` : ""}</dd>
          <dt>Every stage paid</dt><dd>{m.done}</dd>
          {m.missed + m.declined + m.rejected ? <><dt>Stopped early<small>a stage missed, declined or rejected</small></dt><dd>{m.missed + m.declined + m.rejected}</dd></> : null}
        </dl>
        <table className="table stack" style={{ marginTop: 30 }}>
          <thead><tr><th>Job</th><th>The stages</th><th className="r">Budget</th><th className="r">Where it stands</th></tr></thead>
          <tbody>{m.items.map((x) => {
            const cur = x.stages[x.current - 1];
            return (
              <tr key={x.id}>
                <td className="wide">{cur?.job ? <Link href={`/jobs/${cur.job.id}`}>{x.title ?? `Job in stages ${x.id}`}</Link> : x.title ?? `Job in stages ${x.id}`}</td>
                <td className="m" data-l="The stages">{x.stages.filter((s) => s.status === "paid").length} of {x.count} paid</td>
                <td className="m r" data-l="Budget">{eth(x.totalEth)}</td>
                <td className="r" data-l="Where it stands">{x.state === "running" ? `Stage ${x.current} of ${x.count}` : PLAN_WORD[x.state]}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div></Reveal>
    </section>
  );
}
