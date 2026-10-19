"use client";
// What can be done on a monthly plan, by whoever is connected: the customer locks the next month or stops the plan;
// the plan's agent draws on next month from the pool when its record allows it. Everything else (starting a month
// with half, delivering, accepting) happens on that month's own job page, as with any job.
import Link from "next/link";
import { useState } from "react";
import { canDrawOn, fromWei, KIND, Refusal, send } from "@/lib/desk";
import { lockMonth, MONTH_S, stopPlan } from "@/lib/plans";
import type { Plan } from "@/lib/types";
import { dayTime } from "@/lib/format";
import { engineNow, Go, SignedInAs, StatusLine, useSend, useWallet } from "./Wallet";

export default function PlanActions({ plan: p, desk, burnPot, burnWei, explorer, enabled }: { plan: Plan; desk: string | null; burnPot: string | null; burnWei: string; explorer: string; enabled: boolean }) {
  const { address, wallet, kind } = useWallet();
  const lock = useSend();
  const stop = useSend();
  const draw = useSend();
  const price = BigInt(p.priceWei), burn = BigInt(burnWei || "0");
  const isCustomer = !!address && address === p.customer.toLowerCase();
  const isAgent = !!address && address === p.agent.address.toLowerCase();
  const next = p.next, early = p.drawEarly;
  const open = p.items.find((m) => m.state === "locked" || m.state === "advanced");
  // the month being locked: its box stays with the answer once the page moves on to the month after it
  const [locking, setLocking] = useState<number | null>(null);

  const lockNext = () => lock.run(async (on) => {
    const w = wallet();
    if (!w || !address || !desk) throw new Refusal("Connect the customer's wallet first.");
    if (!next?.open) throw new Refusal("The next month cannot be locked yet.");
    setLocking(next.month);
    // due at the end of its month, or 30 days after the lock when that is sooner: the desk's longest due time
    const at = await engineNow();
    const ends = Math.floor(Date.parse(p.startAt!) / 1000) + next.month * MONTH_S;
    const r = await lockMonth(w, { passkey: kind === "passkey", desk, burnPot, from: address, plan: p.id, agent: p.agent.address, dueAt: Math.min(ends, at + MONTH_S - 300), early: p.early, price, burn, on });
    const id = r.job ? String(r.job).padStart(4, "0") : null;
    return { note: r.linked ? `Month ${r.month} of ${p.months} is locked${id ? ` as job ${id}` : ""}.${r.burned ? ` ${fromWei(burn)} ETH went to the burn.` : ""}` : `The month is locked${id ? ` as job ${id}` : ""}. ${r.note ?? ""}`, hash: r.lockTx, ...(id ? { href: `/jobs/${id}`, hrefText: "Open the month's job" } : {}) };
  });

  const stopIt = () => stop.run(async (on) => {
    const w = wallet();
    if (!w || !address) throw new Refusal("Connect the customer's wallet first.");
    on("signing");
    const at = await engineNow();
    on("saving");
    const r = await stopPlan(w, p.id, address, at);
    return { note: r.notStarted.length ? `The plan is stopped. Month${r.notStarted.length === 1 ? "" : "s"} locked and not started (job ${r.notStarted.map((n) => String(n).padStart(4, "0")).join(", ")}) can be declined by the agent, which gives it all back, or come back by themselves after the due time.` : "The plan is stopped. No month is locked after this." };
  });

  const drawNext = () => draw.run(async (on) => {
    const w = wallet();
    if (!w || !address || !desk) throw new Refusal("Connect the agent's wallet first.");
    if (!early?.open) throw new Refusal("Next month early is not offered right now.");
    // what the desk itself allows right now, which can only be less than the page said
    const { fromPool } = await canDrawOn(w, desk, early.job);
    const want = BigInt(early.fromPoolWei) < fromPool ? BigInt(early.fromPoolWei) : fromPool;
    if (want === 0n) throw new Refusal("The pool has nothing to advance on this month right now.");
    const { hash } = await send(w, desk, address, "draw", [BigInt(early.job), want, KIND.pool], { on });
    return { note: `Drew ${fromWei(want)} ETH on month ${early.month} from the pool. The 1% fee went to the burn; the month's own payment repays the pool before you are paid.`, hash };
  });

  return (
    <div className="acts">
      <span className="label">{isCustomer ? "Your plan" : isAgent ? "Your monthly client" : "The plan"}</span>
      {isCustomer && !next && locking !== null && lock.status.at !== "idle" ? (
        <div className="act">
          <div className="h3">Month {locking} of {p.months}</div>
          <StatusLine status={lock.status} explorer={explorer} />
        </div>
      ) : null}
      {isCustomer && next ? (
        <div className="act">
          <div className="h3">Month {next.month} of {p.months}</div>
          <p className="small">{next.open ? `Lock ${fromWei(price)} ETH for ${p.firm ? p.firm.name : p.agent.name}${burn > 0n ? `, and ${fromWei(burn)} ETH that buys and burns $FACTOR` : ""}. Due ${next.dueAt ? dayTime(next.dueAt) : "a month after it is locked"}.` : `It can be locked once ${next.why?.replace(/ is not delivered yet$/, " is delivered") ?? "it opens"}${next.from ? `, or from ${dayTime(next.from)}` : ""}.`} Without it, the plan lapses on {dayTime(next.lapsesAt)}.</p>
          <div className="cta"><Go label={`Lock month ${next.month}`} busy={lock.busy || !next.open} onGo={() => void lockNext()} off={!desk ? "Nothing is live yet" : !enabled ? "Monthly plans are off for now" : null} /></div>
          <StatusLine status={lock.status} explorer={explorer} />
        </div>
      ) : null}
      {isAgent && early ? (
        <div className="act">
          <div className="h3">{early.ahead ? "Next month, early" : `Month ${early.month}, from the pool`}</div>
          <p className="small">{early.open ? `The pool can advance ${early.fromPoolEth} ETH on month ${early.month}${early.ahead ? " before it begins" : ""}. The 1% fee comes out of it, and the month's own payment repays the pool before you are paid.` : `Not offered right now: ${early.why}.`}{early.upFrontEth ? ` Up to ${early.upFrontEth} ETH can also be drawn up front, out of the month's own payment, on its job page.` : ""}</p>
          <div className="cta">
            {early.open ? <Go label={`Draw ${early.fromPoolEth} ETH`} busy={draw.busy} onGo={() => void drawNext()} off={!desk ? "Nothing is live yet" : null} /> : null}
            <Link className="more quiet" href={`/jobs/${String(early.job).padStart(4, "0")}`}>Month {early.month}&apos;s job →</Link>
          </div>
          <StatusLine status={draw.status} explorer={explorer} />
        </div>
      ) : isAgent && open ? (
        <div className="act">
          <div className="h3">Month {p.items.find((m) => m.job === open.job)?.month}</div>
          <p className="small">Start it with half, deliver it and see it settle on its job page, as any job.</p>
          <div className="cta"><Link className="btn line" href={`/jobs/${open.id}`}>Month&apos;s job {open.id}</Link></div>
        </div>
      ) : null}
      {isCustomer && p.status === "active" ? (
        <div className="act">
          <p className="small">Stop the plan at any time with a signature. No month is locked after it; the months already locked run as any job.</p>
          <div className="cta"><Go label="Stop the plan" line busy={stop.busy} onGo={() => void stopIt()} /></div>
          <StatusLine status={stop.status} explorer={explorer} />
        </div>
      ) : null}
      {!isCustomer && !isAgent ? <p className="small" style={{ marginTop: 14 }}>The customer locks each month here, and can stop the plan. The agent draws, delivers and is paid on each month&apos;s job page.{address ? "" : " Connect a wallet to act on it."}</p> : null}
      {isCustomer || isAgent ? <SignedInAs busy={lock.busy || stop.busy || draw.busy} /> : null}
    </div>
  );
}
