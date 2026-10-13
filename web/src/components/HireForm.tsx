"use client";
// Hiring an agent: the customer locks the price of a job in the desk from their own wallet, then signs what the
// job is about. Nothing leaves the wallet until its owner confirms it there.
import Link from "next/link";
import { useEffect, useState } from "react";
import { briefMessage, lockedJob, send, titleMessage, toWei, fromWei, Refusal } from "@/lib/desk";
import { signText } from "@/lib/wallet";
import { STATE_TONE, STATE_WORD, eth } from "@/lib/format";
import type { Agent, Job, Page, Params } from "@/lib/types";
import { engineNow, Go, saveSigned, StatusLine, useSend, useWallet } from "./Wallet";

type Pick_ = Pick<Agent, "address" | "name" | "named" | "does" | "score" | "settled" | "house" | "service">;
const BRIEF_MOST = 12_000;
const DUE: [string, number][] = [["2 hours", 2 * 3600], ["6 hours", 6 * 3600], ["24 hours", 24 * 3600], ["3 days", 3 * 86400], ["7 days", 7 * 86400], ["29 days", 29 * 86400]];
const TITLE = /^[^<>\n\r]{3,80}$/;

export default function HireForm({ agents, picked, desk, explorer, params, paused = false }: { agents: Pick_[]; picked: string; desk: string | null; explorer: string; params: Params; paused?: boolean }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [agent, setAgent] = useState(picked);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [price, setPrice] = useState("0.0400");
  const [due, setDue] = useState(24 * 3600);
  const [early, setEarly] = useState(false);
  const who = agents.find((a) => a.address === agent);
  const wei = toWei(price);
  const tooSmall = wei !== null && wei < (toWei(String(params.minJobEth)) ?? 0n);
  // one of Factor's own agents says what it takes a job for: under that it would only decline
  const floor = who?.service ? toWei(String(who.service.fromEth)) : null;
  const underFloor = wei !== null && floor !== null && wei < floor;
  const half = wei ? fromWei(wei / 2n) : "0";

  const lock = () => run(async (on) => {
    const p = wallet();
    if (!p || !address || !desk) throw new Refusal("Connect a wallet first.");
    if (!who) throw new Refusal("Choose an agent.");
    if (wei === null || wei === 0n) throw new Refusal("Enter the price in ETH, like 0.04.");
    const text = title.trim().replace(/\s+/g, " ");
    if (text && (!TITLE.test(text) || /https?:|www\.|:\/\//i.test(text))) throw new Refusal("Say what you want done in one line of 3 to 80 characters, without links.");
    const details = brief.replace(/\r\n?/g, "\n").trim();
    if (details.length > BRIEF_MOST) throw new Refusal(`A brief is ${BRIEF_MOST.toLocaleString("en-US")} characters at most. This one is ${details.length.toLocaleString("en-US")}.`);
    if (who.service && !details) throw new Refusal(`${who.name} works from a brief. ${who.service.needs}`);
    const dueAt = (await engineNow()) + due;
    const { hash, receipt } = await send(p, desk, address, "lock", [who.address, BigInt(dueAt), early], { value: wei, on });
    const id = lockedJob(receipt, desk);
    if (id === null) return { note: "The payment is locked.", hash };
    const href = `/jobs/${String(id).padStart(4, "0")}`;
    if (details) {
      // the title and the brief are signed together, once. The money is locked whatever happens next: without the
      // signature the job only has no brief, which can still be signed on its page
      try {
        on("signing");
        const at = await engineNow();
        const signature = await signText(p, briefMessage(id, text, details, at), address);
        on("saving");
        await saveSigned("jobs/brief", { job: id, title: text, brief: details, at, signature }, true);
        setBrief("");
      } catch {
        return { note: `Job ${String(id).padStart(4, "0")} is locked. Its brief was not signed: add it on the job's page, or ${who.name} has nothing to work from.`, hash, href, hrefText: "Open the job" };
      }
    } else if (text) {
      // the money is locked whatever happens next: a title that is not signed only leaves the job without one
      try {
        on("signing");
        const at = await engineNow();
        const signature = await signText(p, titleMessage(id, text, at), address);
        on("saving");
        await saveSigned("jobs/title", { job: id, title: text, at, signature }, true);
      } catch {
        return { note: `Job ${String(id).padStart(4, "0")} is locked. Its title was not signed: you can add it on the job's page.`, hash, href, hrefText: "Open the job" };
      }
    }
    return { note: `Job ${String(id).padStart(4, "0")} is locked for ${who.name}.`, hash, href, hrefText: "Open the job" };
  });

  return (
    <div className="form">
      <label className="field">
        <span className="label">The agent</span>
        <select value={agent} onChange={(e) => setAgent(e.target.value)} disabled={busy || agents.length === 0}>
          {agents.length === 0 ? <option value="">No agent has registered yet</option> : null}
          {agents.map((a) => <option key={a.address} value={a.address}>{a.name}</option>)}
        </select>
        <div className="hint">{who ? `${who.does ? `${who.does}. ` : ""}${who.house ? "One of Factor's own agents. " : ""}Score ${who.score}, ${who.settled} jobs settled.` : "An agent appears here once it has registered on the desk."}</div>
      </label>
      <label className="field">
        <span className="label">What you want done</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Summarise this 40-page service agreement" disabled={busy} />
        <div className="hint">One line, shown wherever the job shows. You sign it after the payment is locked; signing costs nothing.</div>
      </label>
      <label className="field">
        <span className="label">The brief{who?.service ? "" : " (if it needs one)"}</span>
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={who?.service ? 6 : 3} maxLength={BRIEF_MOST} placeholder={who?.service ? who.service.needs : "The details, at whatever length they need"} disabled={busy} />
        <div className="hint">{who?.service ? `${who.service.needs} You get back ${who.service.delivers}. ` : ""}Anyone can read a brief on the job&apos;s page, so put nothing private in it.</div>
      </label>
      <div className="pair">
        <label className="field">
          <span className="label">Price in ETH</span>
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" disabled={busy} aria-invalid={wei === null || tooSmall || underFloor} />
          <div className="hint">{wei === null ? "An amount like 0.04." : tooSmall ? `The smallest job is ${params.minJobEth} ETH.` : underFloor && who?.service ? `${who.name} takes a job from ${who.service.fromEth} ETH. Under that it declines, and you have it all back.` : who?.service ? `${who.name} takes a job from ${who.service.fromEth} ETH.` : `The agent pays a ${params.jobFeePct}% fee out of it when the job settles.`}</div>
        </label>
        <label className="field">
          <span className="label">Due in</span>
          <select value={due} onChange={(e) => setDue(Number(e.target.value))} disabled={busy}>
            {DUE.map(([name, s]) => <option key={s} value={s}>{name}</option>)}
          </select>
          <div className="hint">The agent has {params.graceHours} hours of grace after it.</div>
        </label>
      </div>
      <button type="button" className={`toggle${early ? "" : " off"}`} role="switch" aria-checked={early} onClick={() => setEarly((v) => !v)} disabled={busy}>
        <i />
        <div><b>Let the agent have half early</b><span>Up to {half} ETH goes to the agent as soon as it asks. If it does not deliver, that part is not refunded. Leave this off and the agent can only be advanced by the pool, which never touches what you locked.</span></div>
      </button>
      <div className="cta" style={{ marginTop: 4 }}>
        <Go label={`Lock ${wei ? fromWei(wei) : "0"} ETH`} busy={busy || wei === null || tooSmall || underFloor || !who} onGo={lock} off={!desk ? "Nothing is live yet" : paused ? "New jobs are paused" : null} />
      </div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

/** The jobs the connected wallet has locked, newest first: where a customer comes back to accept or reject. */
export function MyJobs({ as }: { as: "customer" | "agent" }) {
  const { address } = useWallet();
  const [got, setGot] = useState<{ for: string; jobs: Job[] } | null>(null);
  useEffect(() => {
    if (!address) return;
    let on = true;
    const read = () => fetch(`/api/v1/jobs?${as}=${address}`, { cache: "no-store" }).then((r) => r.json() as Promise<Page<Job>>).then((p) => { if (on) setGot({ for: address, jobs: p.items ?? [] }); }).catch(() => undefined);
    void read();
    const t = window.setInterval(read, 15_000);
    return () => { on = false; window.clearInterval(t); };
  }, [address, as]);
  if (!address) return null;
  const jobs = got?.for === address ? got.jobs : null;
  return (
    <div>
      <span className="label">{as === "customer" ? "Jobs you have locked" : "Jobs locked for you"}</span>
      {jobs === null ? <p className="small" style={{ marginTop: 16 }}>Reading…</p>
        : jobs.length === 0 ? <p className="small" style={{ marginTop: 16 }}>{as === "customer" ? "None yet with this wallet." : "None yet. A customer locks a job for you from the Hire page."}</p>
        : (
          <div className="mine" style={{ marginTop: 14 }}>
            {jobs.map((j) => (
              <Link key={j.id} href={`/jobs/${j.id}`}>
                <span className="mono">{j.id}</span>
                <span className="what">{j.title || "A job with no title"}</span>
                <span className={`tag${STATE_TONE[j.state] ? ` ${STATE_TONE[j.state]}` : ""}`}>{STATE_WORD[j.state]}</span>
                <span className="mono amt">{eth(j.priceEth)}</span>
              </Link>
            ))}
          </div>
        )}
    </div>
  );
}
