"use client";
// What can be done to a job, by whoever is looking at it: its agent draws an advance, delivers or declines; its
// customer accepts or rejects, or says what the job is about; and once a job's time is up anyone may close it.
import { useEffect, useState } from "react";
import { canDrawOn, fromWei, KIND, proofOf, Refusal, send, titleMessage, toWei } from "@/lib/desk";
import { signText } from "@/lib/wallet";
import { dayTime, eth, fromNow } from "@/lib/format";
import type { Job, Params } from "@/lib/types";
import { engineNow, Go, saveSigned, StatusLine, useSend, useWallet, type Done } from "./Wallet";

type Kind = keyof typeof KIND;
const KIND_WORD: Record<Kind, string> = { pool: "From the pool", compute: "As compute", customer: "Early, from the job" };
const KIND_WHY: Record<Kind, string> = {
  pool: "The pool advances it, up to your limit. The job repays it when it settles.",
  compute: "The pool pays it to the compute gateway for this job, never to a wallet. The job repays it.",
  customer: "Out of the payment the customer locked. They allowed it for this job.",
};

export default function JobActions({ job, agentName, desk, explorer, params, now }: { job: Job; agentName: string; desk: string | null; explorer: string; params: Params; now: string }) {
  const { address } = useWallet();
  const open = job.state === "locked" || job.state === "advanced" || job.state === "delivered";
  const isAgent = address === job.agentId.toLowerCase();
  const isCustomer = address === job.customer.toLowerCase();
  const t = Date.parse(now);
  const refundFrom = Date.parse(job.dueAt) + params.graceHours * 3_600_000;
  const settleFrom = job.deliveredAt ? Date.parse(job.deliveredAt) + params.reviewHours * 3_600_000 : 0;
  const canRefund = (job.state === "locked" || job.state === "advanced") && t > refundFrom;
  const canSettle = job.state === "delivered" && t >= settleFrom;
  const working = (job.state === "locked" || job.state === "advanced") && !canRefund;

  // What was just done is said here, by the page: the form that did it may be gone the moment the job changes.
  const [last, setLast] = useState<Done | null>(null);
  if (!desk) return null;
  if (!open && !last && !(isCustomer && !job.title)) return null;
  const acceptBy = new Date(settleFrom).toISOString();
  const shared = { job, desk, explorer, onDone: setLast };
  return (
    <div className="acts">
      <span className="label">{open ? "What can be done" : "Done"}</span>
      {last ? <StatusLine status={{ at: "done", ...last }} explorer={explorer} /> : null}
      {!address && open ? (
        <div className="act">
          <p className="small">The agent of this job can draw on it and deliver it. Its customer can accept or reject the delivery. Connect the wallet that is one of them.</p>
          <div className="cta"><Go label="" busy={false} onGo={() => undefined} /></div>
        </div>
      ) : null}
      {address && open && !isAgent && !isCustomer && !canRefund && !canSettle ? <p className="small rest">The connected wallet is neither this job&apos;s agent nor its customer. There is nothing for it to do here.</p> : null}

      {isAgent && working ? <Draw {...shared} params={params} /> : null}
      {isAgent && working ? <Deliver {...shared} late={t > Date.parse(job.dueAt)} /> : null}
      {isAgent && job.state === "locked" && !canRefund ? <One {...shared} fn="decline" label="Decline the job" line title="Not for you?" text="Declining sends the whole payment back to the customer and leaves no mark on your record. It can only be done before you draw on the job." done="Declined. The customer has the payment back." /> : null}
      {isAgent && job.state === "delivered" && !canSettle ? <p className="small rest">You have delivered. Your customer can accept or reject until {dayTime(acceptBy)}, {fromNow(acceptBy, now)}. If they say nothing, the job settles by itself and you are paid.</p> : null}

      {isCustomer && working ? <p className="small rest">{agentName} has until {dayTime(job.dueAt)} to deliver, {fromNow(job.dueAt, now)}, and {params.graceHours} hours of grace after that. If it does not, the payment comes back to you by itself. There is nothing for you to do until it delivers.</p> : null}
      {isCustomer && job.state === "delivered" && !canSettle ? (
        <>
          <One {...shared} fn="accept" label="Accept the delivery" title={`${agentName} has delivered`} text={`Accepting pays the agent now. If you do nothing, the job settles by itself ${fromNow(acceptBy, now)}.`} done="Accepted. The agent is paid." />
          <One {...shared} fn="reject" label="Reject it" line title="Not what you asked for?" text={`Rejecting settles the job at half: ${eth(job.priceEth * params.rejectedPct / 100)} comes back to you and the other half is the agent's. There is no judge, and it cannot be undone. Your rejections are public, like the agent's.`} done="Rejected. The job settled at half." />
        </>
      ) : null}
      {isCustomer && !job.title ? <Title job={job} explorer={explorer} onDone={setLast} /> : null}

      {canSettle ? <One {...shared} fn="settle" label="Settle the job" title="The customer's day is over" text={`It was delivered ${dayTime(job.deliveredAt!)} and nobody rejected it. Anyone can settle it now: the pool is repaid and the agent is paid. The engine does this by itself within a minute or two.`} done="Settled. The agent is paid." /> : null}
      {canRefund ? <One {...shared} fn="refund" label="Refund the customer" title="It was not delivered in time" text={`The due time and the ${params.graceHours} hours of grace are past. Anyone can refund it now: the payment goes back to the customer. The engine does this by itself within a minute or two.`} done="Refunded to the customer." /> : null}
    </div>
  );
}

/** One call with nothing to fill in. */
function One({ job, desk, explorer, onDone, fn, label, title, text, done, line }: { job: Job; desk: string; explorer: string; onDone: (d: Done) => void; fn: string; label: string; title: string; text: string; done: string; line?: boolean }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend(onDone);
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    const { hash } = await send(p, desk, address, fn, [BigInt(job.n)], { on });
    return { note: done, hash };
  });
  return (
    <div className="act">
      <div className="h3">{title}</div>
      <p className="small">{text}</p>
      <div className="cta"><Go label={label} busy={busy} onGo={go} line={line} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function Draw({ job, desk, explorer, onDone, params }: { job: Job; desk: string; explorer: string; onDone: (d: Done) => void; params: Params }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend(onDone);
  const [kind, setKind] = useState<Kind>("pool");
  const [amount, setAmount] = useState("");
  const [room, setRoom] = useState<{ for: string; early: bigint; fromPool: bigint } | null>(null);
  // what the desk itself says can be drawn on this job right now, asked through the wallet
  const key = `${job.n}:${job.advances.length}:${busy}`;
  useEffect(() => {
    const p = wallet();
    if (!p) return;
    let on = true;
    void canDrawOn(p, desk, job.n).then((r) => { if (on) setRoom({ for: key, ...r }); }).catch(() => undefined);
    return () => { on = false; };
  }, [wallet, desk, job.n, key]);
  const max = room ? (kind === "customer" ? room.early : room.fromPool) : null;
  const kinds: Kind[] = job.allowEarly ? ["pool", "compute", "customer"] : ["pool", "compute"];
  const wei = toWei(amount);
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    if (wei === null || wei === 0n) throw new Refusal("Enter an amount in ETH, like 0.01.");
    const { hash } = await send(p, desk, address, "draw", [BigInt(job.n), wei, KIND[kind]], { on });
    const fee = (wei * BigInt(params.advanceFeePct)) / 100n;
    setAmount("");
    return { note: kind === "compute" ? `${fromWei(wei - fee)} ETH of compute is paid for this job.` : `${fromWei(wei - fee)} ETH is in your wallet. ${fromWei(fee)} ETH buys back and burns $FACTOR.`, hash };
  });
  return (
    <div className="act">
      <div className="h3">Draw an advance</div>
      <p className="small">Up to {params.advanceMaxPct}% of the job in all. A {params.advanceFeePct}% fee comes off what you draw.</p>
      <div className="seg" role="radiogroup" aria-label="Where it comes from">
        {kinds.map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "on" : undefined} onClick={() => setKind(k)} disabled={busy}>{KIND_WORD[k]}</button>)}
      </div>
      <p className="small">{KIND_WHY[kind]}</p>
      <label className="field" style={{ marginTop: 18 }}>
        <span className="label">Amount in ETH</span>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.0000" disabled={busy} />
        <div className="hint">
          {max === null ? "Asking the desk what can be drawn…" : max === 0n ? (kind === "customer" ? "Nothing more can be drawn early on this job." : "Nothing can be drawn from the pool on this job right now: your limit, the job's half or the pool itself is used up.") : <>Up to <button type="button" className="linkish" onClick={() => setAmount(fromWei(max))}>{fromWei(max)} ETH</button> right now.</>}
        </div>
      </label>
      <div className="cta"><Go label="Draw it" busy={busy || wei === null || wei === 0n} onGo={go} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function Deliver({ job, desk, explorer, onDone, late }: { job: Job; desk: string; explorer: string; onDone: (d: Done) => void; late: boolean }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend(onDone);
  const [work, setWork] = useState("");
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    if (work.trim().length < 3) throw new Refusal("Paste what you delivered, or the link to it.");
    const { hash } = await send(p, desk, address, "deliver", [BigInt(job.n), proofOf(work.trim())], { on });
    return { note: "Delivered. The customer has 24 hours to accept or reject; after that the job settles by itself.", hash };
  });
  return (
    <div className="act">
      <div className="h3">Deliver</div>
      <p className="small">Hand the work to your customer the way you agreed. Then paste it here, or the link to it: only its fingerprint goes on the chain, as the proof of what you delivered and when. The text itself is sent nowhere.{late ? " The due time has passed: a delivery now still counts, and is marked late." : ""}</p>
      <label className="field" style={{ marginTop: 18 }}>
        <span className="label">What you delivered</span>
        <textarea value={work} onChange={(e) => setWork(e.target.value)} rows={3} placeholder="The summary, or a link to it" disabled={busy} />
        <div className="hint">{work.trim().length >= 3 ? <>Fingerprint <span className="mono">{proofOf(work.trim()).slice(0, 18)}…</span></> : "Keep a copy exactly as you paste it: the same text gives the same fingerprint."}</div>
      </label>
      <div className="cta"><Go label="Deliver the job" busy={busy} onGo={go} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function Title({ job, explorer, onDone }: { job: Job; explorer: string; onDone: (d: Done) => void }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend(onDone);
  const [title, setTitle] = useState("");
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    const text = title.trim().replace(/\s+/g, " ");
    if (text.length < 3) throw new Refusal("Say what the job is about in a few words.");
    on("signing");
    const at = await engineNow();
    const signature = await signText(p, titleMessage(job.n, text, at), address);
    on("saving");
    await saveSigned("jobs/title", { job: job.n, title: text, at, signature }, true);
    return { note: "Saved. It shows on the job's page." };
  });
  return (
    <div className="act">
      <div className="h3">Say what this job is about</div>
      <p className="small">One line, shown on this page and in lists. You sign it with your wallet; it costs nothing and moves no money.</p>
      <label className="field" style={{ marginTop: 18 }}>
        <span className="label">The job</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Summarise a 40-page service agreement" disabled={busy} />
      </label>
      <div className="cta"><Go label="Sign and save" busy={busy} onGo={go} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}
