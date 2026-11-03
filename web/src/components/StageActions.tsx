"use client";
// What can be done with a job in stages from a stage's page: the customer accepts or rejects the stage on the desk, through
// the milestone contract (the desk's customer); anyone takes a step whose time has come. Every call is tried first, and
// a refusal is said in words before the wallet is asked.
import { Refusal } from "@/lib/desk";
import { dayTime } from "@/lib/format";
import { sendMilestones } from "@/lib/milestones";
import { Go, StatusLine, useSend, useWallet } from "./Wallet";

const NEXT_WORD = { opens: "The stage was paid on the desk. A step opens the next one.", returns: "The stage came back from the desk. A step sends the rest to the customer.", settles: "The customer's day is over: a step settles the stage, which pays the agent, and opens the next.", refunds: "The stage is past its due time and the grace: a step refunds it and sends the rest back to the customer." } as const;

export default function StageActions({ plan, onThisPage, contract, explorer, reviewH, now }: { plan: { id: number; customer: string; state: string; current: number; next: "opens" | "returns" | "settles" | "refunds" | null; delivered: boolean; deliveredAt: string | null }; onThisPage: boolean; contract: string | null; explorer: string; reviewH: number; now: string }) {
  const { address, wallet } = useWallet();
  const accept = useSend();
  const reject = useSend();
  const step = useSend();
  if (!contract || plan.state !== "running") return null;
  const isCustomer = !!address && address.toLowerCase() === plan.customer.toLowerCase();
  const until = plan.deliveredAt ? new Date(Date.parse(plan.deliveredAt) + reviewH * 3600_000).toISOString() : null;
  const inDay = !!until && Date.parse(now) < Date.parse(until);
  const call = (s: ReturnType<typeof useSend>, fn: "accept" | "reject" | "step", note: string) => s.run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    const { hash } = await sendMilestones(p, { contract, from: address, fn, args: [BigInt(plan.id)], on });
    return { note, hash };
  });
  return (
    <div className="stage-acts">
      {isCustomer && plan.delivered && inDay ? (
        <div className="act">
          <div className="h3">Stage {plan.current} is delivered</div>
          <p className="small">{onThisPage ? "Read the work below." : "Read the work on its page."} Accept it and the agent is paid, and the next stage starts at once. Reject it by {dayTime(until!)} and half of this stage comes back to you with every stage not yet started; the agent keeps the other half, and the job ends here.</p>
          <div className="cta">
            <Go label="Accept and start the next stage" busy={accept.busy || reject.busy} onGo={() => call(accept, "accept", "Accepted. The agent is paid, and the next stage is on the desk.")} />
            <Go line label="Reject this stage" busy={accept.busy || reject.busy} onGo={() => call(reject, "reject", "Rejected. Half of the stage and every stage not yet started are on their way back to you.")} />
          </div>
          <StatusLine status={accept.status} explorer={explorer} />
          <StatusLine status={reject.status} explorer={explorer} />
        </div>
      ) : null}
      {plan.next ? (
        <div className="act">
          <p className="small">{NEXT_WORD[plan.next]} Factor takes this step by itself; anyone may.</p>
          <div className="cta"><Go line label="Take the step" busy={step.busy} onGo={() => call(step, "step", "Done.")} /></div>
          <StatusLine status={step.status} explorer={explorer} />
        </div>
      ) : null}
    </div>
  );
}
