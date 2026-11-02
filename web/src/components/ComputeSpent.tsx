// What an agent's or a job's compute credit went on through Raeto, and how the route works. Both appear only while
// raeto/auto is switched on: the engine sends nothing for them otherwise.
import { Fragment } from "react";
import { usd, usdFine } from "@/lib/format";
import type { Compute, RaetoSpend } from "@/lib/types";

/** Which models answered and what each cost off the credit. */
export function ComputeSpent({ spend, from }: { spend: RaetoSpend; from: string }) {
  return (
    <div id="compute-spent" style={{ scrollMarginTop: 96 }}>
      <span className="label">Compute it spent</span>
      <dl className="kv fit" style={{ marginTop: 18 }}>
        {spend.models.map((m) => (
          <Fragment key={`${m.model}:${m.tier}`}>
            <dt style={{ overflowWrap: "anywhere" }}>{m.model}<small>{m.tier ? `${m.tier} tier, ` : ""}{m.calls} call{m.calls === 1 ? "" : "s"}</small></dt>
            <dd>{usdFine(m.usd)}</dd>
          </Fragment>
        ))}
        <dt>In all<small>{spend.calls} call{spend.calls === 1 ? "" : "s"} through raeto/auto, from {from}</small></dt>
        <dd className="sum">{usdFine(spend.spentUsd)}</dd>
      </dl>
      <p className="small" style={{ marginTop: 12 }}>Raeto picks the model for each call. Each figure is what Raeto charged for it and Factor&apos;s margin, taken off the credit.</p>
    </div>
  );
}

/** How the route works, with the figures the engine runs on. */
export function RaetoRoute({ compute }: { compute: Compute }) {
  const r = compute.raeto;
  if (!r) return null;
  return (
    <div id="raeto" style={{ scrollMarginTop: 96 }}>
      <span className="label">raeto/auto</span>
      <p style={{ marginTop: 18 }}>Name <code>raeto/auto</code> as the model, with the compute key your agent already has. Raeto picks a model for each request, and asks a stronger one if the answer comes back broken. It is paid from the agent&apos;s compute credit, under the same caps, with the agent&apos;s address on every call.</p>
      <dl className="kv fit" style={{ marginTop: 18 }}>
        <dt>What a call costs<small>the header x-factor-cost-usd says, or the last chunk of a stream</small></dt><dd>Raeto&apos;s charge + {compute.markupPct}%</dd>
        <dt>What Raeto charges<small>x-raeto-model says which model answered; picking it costs at most {usdFine(r.routeFeeMostUsd)}</small></dt><dd>Model + {r.feePct}% + routing</dd>
        <dt>Held while it runs<small>per million tokens at most, let go when the call ends</small></dt><dd>{usd(r.holdInUsd)} in · {usd(r.holdOutUsd)} out</dd>
        {compute.limits ? <><dt>One call, one agent in a day</dt><dd>{usd(compute.limits.callUsd)} · {usd(compute.limits.agentDayUsd)}</dd></> : null}
        <dt>A call that fails<small>nothing is taken from the credit</small></dt><dd>$0.00</dd>
      </dl>
      <p className="small" style={{ marginTop: 12 }}>Also <code>{r.models.filter((m) => m !== "raeto/auto").map((m) => m.replace("raeto/auto", "")).join(" ")}</code> on the end of the name. The request goes to Raeto and the model it picks. Built on Raeto.</p>
    </div>
  );
}
