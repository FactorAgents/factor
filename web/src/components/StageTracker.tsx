// A job in stages, on the page of each of its stages: every stage in order with its price, its due date and where it
// stands, the one this page is about marked, and what the customer (or anyone, once its time has come) can do now. The
// stages are ordinary desk jobs; the milestone contract is their customer, so a stage is accepted or rejected through it.
import Link from "next/link";
import { dayTime, eth, short, txHref } from "@/lib/format";
import { PLAN_WORD, STAGE_TONE, STAGE_WORD, timeWord } from "@/lib/milestones";
import type { MilestonePlan, MilestonesAbout } from "@/lib/types";
import StageActions from "./StageActions";

export default function StageTracker({ plan, job, about, explorer, now }: { plan: MilestonePlan; job: number; about: MilestonesAbout; explorer: string; now: string }) {
  const here = plan.stages.find((s) => s.job?.n === job);
  const cur = plan.stages[plan.current - 1];
  return (
    <div className="stage-tracker">
      <span className="label">A job in {plan.count} stages</span>
      <p className="small" style={{ marginTop: 8 }}>
        {plan.title ? <b>{plan.title}. </b> : null}
        {eth(plan.totalEth)} locked up front by <a href={`${explorer}/address/${plan.customer}`} target="_blank" rel="noopener noreferrer">{short(plan.customer)}</a> for {plan.agent.named ? <Link href={`/agents/${plan.agent.name}`}>{plan.agent.name}</Link> : short(plan.agent.address)}. {PLAN_WORD[plan.state]}.
        {plan.state === "running" ? ` Stage ${plan.current} is on the desk; each next stage starts when the one before it is accepted.` : plan.returnedEth ? ` ${eth(plan.returnedEth)} went back to the customer.` : ""}
      </p>
      <ol className="stages">
        {plan.stages.map((s) => (
          <li key={s.n} className={`${s.job?.n === job ? "here " : ""}${s.status}`}>
            <span className="n mono">{String(s.n).padStart(2, "0")}</span>
            <div className="what">
              {s.job && s.job.n !== job ? <Link href={`/jobs/${s.job.id}`}>{s.title ?? `Stage ${s.n}`}</Link> : <b>{s.title ?? `Stage ${s.n}`}</b>}
              <span className="meta mono">
                {eth(s.priceEth)} · {s.dueAt ? `due ${dayTime(s.dueAt)}` : s.expectedDueAt ? `about ${dayTime(s.expectedDueAt)}, ${timeWord(s.timeS)} after the one before` : `${timeWord(s.timeS)}`}
                {s.paidTx ? <> · <a href={txHref(explorer, s.paidTx)} target="_blank" rel="noopener noreferrer">paid {dayTime(s.paidAt!)}</a></> : null}
              </span>
            </div>
            <span className={`tag${STAGE_TONE[s.status] ? ` ${STAGE_TONE[s.status]}` : ""}`}>{STAGE_WORD[s.status]}</span>
          </li>
        ))}
      </ol>
      {here && cur ? <StageActions plan={{ id: plan.id, customer: plan.customer, state: plan.state, current: plan.current, next: plan.next ?? null, delivered: cur.status === "delivered", deliveredAt: cur.deliveredAt ?? null }} onThisPage={cur.job?.n === job} contract={about.contract} explorer={explorer} reviewH={about.rules.reviewH} now={now} /> : null}
    </div>
  );
}
