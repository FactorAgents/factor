"use client";
// Hiring in stages (lib/milestones.ts): the customer splits a bigger job into 2 to 6 stages, each with its own title,
// brief, price and time, and locks the whole budget in the milestone contract in one go. The first stage is locked on
// the desk at once; each later one the moment the stage before it is accepted. Then the plan's words go to the engine,
// which takes them because they hash to what the plan holds, and each stage's desk job carries its title and brief.
import { useState } from "react";
import { fromWei, Refusal, toWei } from "@/lib/desk";
import { BRIEF_MOST, briefOf, bytesOf, titleOf, MAX_STAGES, MIN_STAGES, postedPlan, sendMilestones, sendTerms, STAGE_TIMES, TERMS_BYTES, termsHash, termsText, timeWord, TITLE_MOST } from "@/lib/milestones";
import type { Agent, MilestonesAbout, Params } from "@/lib/types";
import { Go, StatusLine, useSend, useWallet } from "./Wallet";

type Pick_ = Pick<Agent, "address" | "name" | "named" | "does" | "score" | "settled" | "house" | "service">;
interface Draft { title: string; brief: string; price: string; time: number }
const blank = (n: number): Draft => ({ title: "", brief: "", price: "0.0100", time: n === 0 ? 3 * 86_400 : 7 * 86_400 });

export default function HireInStages({ agents, picked, about, explorer, params, paused = false }: { agents: Pick_[]; picked: string; about: MilestonesAbout; explorer: string; params: Params; paused?: boolean }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [agent, setAgent] = useState(picked);
  const [title, setTitle] = useState("");
  const [stages, setStages] = useState<Draft[]>([blank(0), blank(1)]);
  const [early, setEarly] = useState(false);
  // a plan locked whose words did not reach the engine: sent again from here
  const [pending, setPending] = useState<{ id: number; text: string } | null>(null);
  const again = useSend();
  const who = agents.find((a) => a.address === agent);
  const min = toWei(String(about.rules.minStageEth)) ?? 0n;
  const prices = stages.map((s) => toWei(s.price));
  const total = prices.reduce<bigint>((n, p) => n + (p ?? 0n), 0n);
  const bad = prices.some((p) => p === null || p < min);
  const floor = who?.service ? toWei(String(who.service.fromEth)) : null;
  const under = floor !== null && prices.some((p) => p !== null && p < floor);
  const set = (i: number, patch: Partial<Draft>) => setStages((xs) => xs.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  // the date each stage would be due if every stage before it were accepted on its due date
  const dues = stages.map((_, i) => stages.slice(0, i + 1).reduce((n, s) => n + s.time, 0));

  const lock = () => run(async (on) => {
    const p = wallet();
    if (!p || !address || !about.contract) throw new Refusal("Connect a wallet first.");
    if (!who) throw new Refusal("Choose an agent.");
    const plan = titleOf(title);
    if (!plan) throw new Refusal(`Say what the whole job is in one line of 3 to ${TITLE_MOST} characters, without links or web addresses.`);
    const words = stages.map((s, i) => {
      const t = titleOf(s.title);
      if (!t) throw new Refusal(`Say what stage ${i + 1} delivers in one line of 3 to ${TITLE_MOST} characters, without links or web addresses.`);
      if (!s.brief.trim()) throw new Refusal(`Stage ${i + 1} needs a brief: it is what the agent works from.`);
      const b = briefOf(s.brief);
      if (!b) throw new Refusal(`Stage ${i + 1}'s brief is plain text of up to ${BRIEF_MOST.toLocaleString("en-US")} characters.`);
      return { title: t, brief: b };
    });
    if (bad) throw new Refusal(`Each stage is ${about.rules.minStageEth} ETH or more, the desk's smallest job.`);
    const text = termsText({ title: plan, stages: words });
    if (bytesOf(text) > TERMS_BYTES) throw new Refusal("The words of all the stages together are too long. Shorten the briefs.");
    const { hash, receipt } = await sendMilestones(p, { contract: about.contract, from: address, fn: "post", args: [who.address, prices.map((x) => x!), stages.map((s) => BigInt(s.time)), early, termsHash(text)], value: total, on });
    const made = postedPlan(receipt, about.contract);
    const href = made?.job ? `/jobs/${String(made.job).padStart(4, "0")}` : undefined;
    if (!made) return { note: "The budget is locked.", hash };
    try {
      on("saving");
      await sendTerms(made.id, text);
    } catch (e) {
      setPending({ id: made.id, text });
      return { note: `The budget is locked and stage 1 is on the desk. Its words did not arrive (${e instanceof Error ? e.message : "Factor did not answer"}), so ${who.name} has no brief yet. Send them again below.`, hash, ...(href ? { href, hrefText: "Open stage 1" } : {}) };
    }
    setPending(null);
    setStages([blank(0), blank(1)]);
    setTitle("");
    return { note: `${fromWei(total)} ETH is locked for ${stages.length} stages. Stage 1 is on the desk for ${who.name}${made.job ? ` as job ${String(made.job).padStart(4, "0")}` : ""}; each next stage starts when you accept the one before it.`, hash, ...(href ? { href, hrefText: "Open stage 1" } : {}) };
  });

  return (
    <>
      <label className="field">
        <span className="label">The agent</span>
        <select value={agent} onChange={(e) => setAgent(e.target.value)} disabled={busy || agents.length === 0}>
          {agents.length === 0 ? <option value="">No agent has registered yet</option> : agents.map((a) => <option key={a.address} value={a.address}>{a.name}</option>)}
        </select>
        <div className="hint">{who ? `${who.does ? `${who.does}. ` : ""}${who.house ? "One of Factor's own agents. " : ""}Factor Score ${who.score}, ${who.settled} jobs settled.` : "An agent appears here once it has registered on the desk."}</div>
      </label>
      <label className="field">
        <span className="label">The whole job</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TITLE_MOST} placeholder="A shop site in three parts" disabled={busy} />
        <div className="hint">One line, shown above every stage.</div>
      </label>
      <ol className="stages-form">
        {stages.map((s, i) => (
          <li key={i}>
            <div className="stage-head"><span className="label">Stage {i + 1}</span>{stages.length > MIN_STAGES ? <button type="button" className="more quiet" onClick={() => setStages((xs) => xs.filter((_, k) => k !== i))} disabled={busy}>Remove</button> : null}</div>
            <label className="field">
              <span className="label">What it delivers</span>
              <input value={s.title} onChange={(e) => set(i, { title: e.target.value })} maxLength={TITLE_MOST} placeholder={i === 0 ? "The words for every page" : i === 1 ? "The pages, built" : "The checkout"} disabled={busy} />
            </label>
            <label className="field">
              <span className="label">Its brief</span>
              <textarea value={s.brief} onChange={(e) => set(i, { brief: e.target.value })} rows={3} maxLength={BRIEF_MOST} placeholder={who?.service ? who.service.needs : "What the agent needs to do this stage"} disabled={busy} />
            </label>
            <div className="pair">
              <label className="field">
                <span className="label">Price in ETH</span>
                <input value={s.price} onChange={(e) => set(i, { price: e.target.value })} inputMode="decimal" disabled={busy} aria-invalid={prices[i] === null || (prices[i] ?? 0n) < min} />
              </label>
              <label className="field">
                <span className="label">Its time</span>
                <select value={s.time} onChange={(e) => set(i, { time: Number(e.target.value) })} disabled={busy}>
                  {STAGE_TIMES.map(([name, t]) => <option key={t} value={t}>{name}</option>)}
                </select>
              </label>
            </div>
            <div className="hint">{i === 0 ? `Locked on the desk at once, due ${timeWord(s.time)} later.` : `Starts when you accept stage ${i}, due ${timeWord(s.time)} after that: about ${timeWord(dues[i]!)} from now if every stage before it is accepted on its due date.`}</div>
          </li>
        ))}
      </ol>
      {stages.length < MAX_STAGES ? <button type="button" className="btn line" onClick={() => setStages((xs) => [...xs, blank(xs.length)])} disabled={busy}>Add a stage</button> : <p className="small">{MAX_STAGES} stages is the most one job can have.</p>}
      <button type="button" className={`toggle${early ? "" : " off"}`} role="switch" aria-checked={early} onClick={() => setEarly((v) => !v)} disabled={busy}>
        <i />
        <div><b>Let the agent start each stage with half</b><span>Up to half of a stage goes to the agent as soon as that stage is on the desk. If it does not deliver that stage, that part is not refunded. Leave this off and the agent can only be advanced by the pool, which never touches what you locked.</span></div>
      </button>
      <p className="small">{bad ? `Each stage is ${about.rules.minStageEth} ETH or more.` : under && who?.service ? `${who.name} takes a job from ${who.service.fromEth} ETH. A stage under that it declines, and the rest comes back to you.` : `${fromWei(total)} ETH for ${stages.length} stages, locked now. Each stage is paid when you accept it; the agent pays the desk's ${params.jobFeePct}% fee out of each. If a stage is not delivered in its time and ${params.graceHours} hours of grace, you have it back with every stage not yet started.`}</p>
      <div className="cta" style={{ marginTop: 4 }}>
        <Go label={`Lock ${fromWei(total)} ETH for ${stages.length} stages`} busy={busy || bad || !who} onGo={lock} off={!about.contract ? "Not open yet" : paused ? "New jobs are paused" : null} />
      </div>
      <StatusLine status={status} explorer={explorer} />
      {pending ? (
        <div className="cta" style={{ marginTop: 12 }}>
          <Go line label="Send the words again" busy={again.busy} onGo={() => again.run(async (on) => { on("saving"); await sendTerms(pending.id, pending.text); setPending(null); return { note: "The words arrived. Each stage carries its title and brief." }; })} />
          <StatusLine status={again.status} explorer={explorer} />
        </div>
      ) : null}
    </>
  );
}
