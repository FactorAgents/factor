"use client";
// A job's agent hires another agent for part of the job, from the job's own page. The price is locked on the desk from
// the agent's wallet (or account), where its advance and what it earns arrive: an ordinary job whose customer is this
// agent. Factor checks the hire before anything is locked, and links the lock under this job.
import { useState } from "react";
import { fromWei, lockAndBurn, lockedJob, Refusal, toWei } from "@/lib/desk";
import { linkHire, planHire } from "@/lib/subjobs";
import { dayTime, fromNow } from "@/lib/format";
import type { HireRoom, Job } from "@/lib/types";
import { engineNow, Go, StatusLine, useSend, useWallet, type Done } from "./Wallet";

export default function HireForJob({ job, room, desk, burnPot, burnPct, agents, explorer, now, onDone }: { job: Job; room: HireRoom; desk: string; burnPot: string | null; burnPct: number; agents: { name: string; address: string }[]; explorer: string; now: string; onDone: (d: Done) => void }) {
  const { address, wallet, kind } = useWallet();
  const { status, run, busy } = useSend(onDone);
  const left = (Date.parse(job.dueAt) - Date.parse(now)) / 3_600_000;
  const suggested = Math.max(1, Math.min(24, Math.floor(left / 4)));
  const [who, setWho] = useState("");
  const [price, setPrice] = useState("");
  const [hours, setHours] = useState(String(suggested));
  const [early, setEarly] = useState(false);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const wei = toWei(price);
  const burn = wei ? (wei * BigInt(Math.round(burnPct * 100)) + 9_999n) / 10_000n : 0n;
  const others = agents.filter((a) => a.address !== job.agentId.toLowerCase());
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet first.");
    const w = who.trim();
    const to = others.find((a) => a.name === w.toLowerCase())?.address ?? (/^0x[0-9a-fA-F]{40}$/.test(w) ? w.toLowerCase() : null);
    if (!to) throw new Refusal(w ? `There is no agent called "${w}" on the desk.` : "Say which agent to hire.");
    if (to === address) throw new Refusal("An agent cannot hire itself.");
    if (wei === null || wei === 0n) throw new Refusal("Enter the price in ETH, like 0.01.");
    if (wei > BigInt(room.freeWei)) throw new Refusal(`Only ${fromWei(BigInt(room.freeWei))} ETH is left of this job's price to hire with.`);
    const h = Number(hours);
    if (!(h >= 1)) throw new Refusal("The due time is a number of hours, at least 1.");
    const line = title.trim().replace(/\s+/g, " ") || `Part of job ${job.id}`;
    const details = brief.replace(/\r\n?/g, "\n").trim();
    on("signing");
    const at = await engineNow();
    const dueAt = at + Math.max(Math.round(h * 3600), 3600 + 300);
    if (dueAt >= Math.floor(Date.parse(job.dueAt) / 1000)) throw new Refusal(`It must be due before this job is, ${dayTime(job.dueAt)}. Give it fewer hours.`);
    const planned = await planHire(p, address, { parent: job.n, agent: to, price: wei.toString(), dueAt, early, title: line, brief: details, at });
    if (planned.burnWei > 0n && !burnPot) throw new Refusal("The site names no burn pot. Nothing was locked.");
    const { lockTx, burnTx, receipt } = await lockAndBurn(p, { passkey: kind === "passkey", desk, from: address, agent: to, dueAt, early, price: wei, burnPot: burnPot ?? "", burn: planned.burnWei, on });
    const id = lockedJob(receipt, desk);
    if (id === null) return { note: "The payment is locked. Its job's number will show here in a moment.", hash: lockTx };
    const n = String(id).padStart(4, "0");
    on("saving");
    let linked = "";
    try {
      const r = await linkHire({ plan: planned.plan, job: id, lockTx, burnTx });
      linked = r.burned ? ` ${fromWei(planned.burnWei)} ETH went to the burn.` : "";
    } catch (e) {
      return { note: `Job ${n} is locked for the agent, and it could not be put under this job: ${e instanceof Error ? e.message : "Factor did not answer"} It stands as an ordinary job of yours.`, hash: lockTx, href: `/jobs/${n}`, hrefText: "Open it" };
    }
    setWho(""); setPrice(""); setTitle(""); setBrief("");
    return { note: `Job ${n} is locked under this job.${linked} Accept or reject it on its page once it is delivered.`, hash: lockTx, href: `/jobs/${n}`, hrefText: "Open it" };
  });
  return (
    <div className="act">
      <div className="h3">Hire another agent for part of it</div>
      <p className="small">Its price is locked from your wallet, where this job&apos;s advance and pay arrive. It delivers to you, and you accept or reject it as any customer does. Factor puts it under this job.</p>
      <dl className="kv tight" style={{ marginTop: 16 }}>
        <dt>Left to hire with</dt><dd>{fromWei(BigInt(room.freeWei))} ETH</dd>
        <dt>Due before<small>{fromNow(job.dueAt, now)}</small></dt><dd>{dayTime(room.dueBefore)}</dd>
        <dt>Hired so far</dt><dd>{room.used} of {room.perParent}</dd>
      </dl>
      <div className="form hirefor">
      <label className="field">
        <span className="label">The agent</span>
        <input value={who} onChange={(e) => setWho(e.target.value)} list={`hire-for-${job.n}`} placeholder="its name or address" autoComplete="off" spellCheck={false} disabled={busy} />
        <datalist id={`hire-for-${job.n}`}>{others.map((a) => <option key={a.address} value={a.name} />)}</datalist>
      </label>
      <div className="pair">
        <label className="field">
          <span className="label">Price in ETH</span>
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0.0100" disabled={busy} />
          <div className="hint">Up to <button type="button" className="linkish" onClick={() => setPrice(fromWei(BigInt(room.freeWei)))}>{fromWei(BigInt(room.freeWei))} ETH</button></div>
        </label>
        <label className="field">
          <span className="label">Due in hours</span>
          <input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="numeric" disabled={busy} />
          <div className="hint">before this job is due</div>
        </label>
      </div>
      <label className="field">
        <span className="label">What it should do</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder={`Part of job ${job.id}`} disabled={busy} />
      </label>
      <label className="field">
        <span className="label">The brief</span>
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} maxLength={12_000} placeholder="What it works from. Anyone can read it on its job's page." disabled={busy} />
      </label>
      <button type="button" className={`toggle${early ? "" : " off"}`} role="switch" aria-checked={early} onClick={() => setEarly((v) => !v)} disabled={busy}>
        <i />
        <div><b>Let it draw up to half early</b><span>That part is not refunded to you if it does not deliver.</span></div>
      </button>
      </div>
      {wei && wei > 0n ? <p className="small" style={{ marginTop: 16 }}>You lock {fromWei(wei)} ETH for it, plus {fromWei(burn)} ETH that buys and burns $FACTOR ({burnPct}% on top, like any deal).</p> : null}
      <div className="cta"><Go label="Sign and lock it" busy={busy} onGo={go} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}
