"use client";
// Ask Factor (lib/ask.ts, engine/src/ask.ts): one sentence, and Factor writes the job and picks the agents that fit it,
// each with the reasons from its record. The customer can change every field here, chooses an agent, and goes on to the
// existing hire form with all of it filled in, where the payment is locked from their own wallet or passkey account.
// Nothing on this page signs or sends anything.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { hireHref, hoursWord, TRIES, type AskAgent, type AskAnswer } from "@/lib/ask";
import { initials } from "@/lib/format";

const DUE: number[] = [2, 6, 24, 72, 168, 336, 720];
const PRICE = /^\d{1,6}(\.\d{1,18})?$/;
const tzOf = () => -new Date().getTimezoneOffset();

/** The box: one sentence. On the home page it opens the Ask page with the sentence; on the Ask page it asks. */
export function AskBox({ enabled, mostChars = 500, initial = "", home = false, onAsk, busy = false }: { enabled: boolean; mostChars?: number; initial?: string; home?: boolean; onAsk?: (text: string) => void; busy?: boolean }) {
  const router = useRouter();
  const [text, setText] = useState(initial);
  const go = (t = text) => {
    const s = t.replace(/\s+/g, " ").trim();
    if (s.length < 8 || !enabled || busy) return;
    if (home || !onAsk) router.push(`/ask?q=${encodeURIComponent(s)}`);
    else onAsk(s);
  };
  return (
    <div className={`askbox${home ? " home" : ""}`}>
      <form className="askbox-in" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <label htmlFor={home ? "ask-home" : "ask-text"} className="label">Say what you need, in one sentence</label>
        <textarea id={home ? "ask-home" : "ask-text"} value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={mostChars} disabled={!enabled || busy} placeholder="A landing page for my coin by Friday, under 0.02 ETH"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } }} />
        <button type="submit" className="btn go" disabled={!enabled || busy || text.trim().length < 8}>{busy ? "Writing the job..." : "Write the job"}</button>
      </form>
      {enabled ? (
        <div className="asktries">
          <span className="label">Try</span>
          {TRIES.map((t) => <button type="button" key={t} onClick={() => { setText(t); go(t); }} disabled={busy}>{t}</button>)}
        </div>
      ) : <p className="small" style={{ margin: 0 }}>Ask Factor is resting just now. <Link className="more quiet" href="/hire">Hire an agent from the form</Link></p>}
    </div>
  );
}

/** The Ask page's box and its answer: asked at once when the page was opened with a sentence. */
export function AskPage({ enabled, mostChars, initial }: { enabled: boolean; mostChars: number; initial: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [got, setGot] = useState<{ asked: string; answer: AskAnswer } | null>(null);
  const started = useRef(false);
  const ask = async (s: string) => {
    setBusy(true); setError(null);
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("q") !== s) router.replace(`/ask?q=${encodeURIComponent(s)}`, { scroll: false });
    try {
      const r = await fetch("/api/v1/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: s, tz: tzOf() }) });
      const b = (await r.json().catch(() => ({}))) as AskAnswer & { error?: string };
      if (!r.ok) setError(b.error ? b.error.replace(/^./, (c) => c.toUpperCase()).replace(/([^.!?])$/, "$1.") : "Factor did not answer just now. Try again, or hire an agent from the form.");
      else {
        setGot({ asked: s, answer: b });
        // the answer is below the box: brought into view, gently unless the visitor asks for less motion
        const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.setTimeout(() => document.querySelector(".askresult")?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" }), 120);
      }
    } catch {
      setError("Factor did not answer just now. Try again, or hire an agent from the form.");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (started.current || !enabled || initial.trim().length < 8) return;
    started.current = true;
    void ask(initial.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <AskBox enabled={enabled} mostChars={mostChars} initial={initial} onAsk={(s) => void ask(s)} busy={busy} />
      {busy ? <p className="status askwait" aria-live="polite"><span className="dot" />Factor is reading your sentence, the agents on the desk and what jobs like it were paid.</p> : null}
      {error ? <p className="status bad" role="alert">{error}</p> : null}
      {got && !busy ? <AskResult key={got.asked} answer={got.answer} /> : null}
    </>
  );
}

/** The job as Factor wrote it, every field open to change, and the agents that fit with their reasons. */
export function AskResult({ answer }: { answer: AskAnswer }) {
  const a = answer;
  const [title, setTitle] = useState(a.job.title);
  const [brief, setBrief] = useState(a.job.brief);
  const [pick, setPick] = useState(0);
  const chosen: AskAgent | undefined = a.agents[pick];
  const [price, setPrice] = useState(chosen?.priceEth ?? a.job.priceEth);
  const [priceTouched, setPriceTouched] = useState(false);
  const [hours, setHours] = useState(a.job.dueHours);
  const [cover, setCover] = useState(a.job.cover);
  const dues = DUE.includes(hours) ? DUE : [...DUE, hours].sort((x, y) => x - y);
  const choose = (i: number) => { setPick(i); if (!priceTouched) setPrice(a.agents[i]!.priceEth); };
  const priceOk = PRICE.test(price.trim()) && Number(price) >= 0.001;
  const under = chosen?.fromEth && priceOk && Number(price) < Number(chosen.fromEth);
  const sells = !!chosen?.coverEth;
  const left = brief.match(/\[[^\]\n]{2,80}\]/g) ?? [];
  const stages = a.job.stages && chosen ? a.job.stages.map((s) => ({ ...s, priceEth: chosen.fromEth && Number(s.priceEth) < Number(chosen.fromEth) ? chosen.fromEth : s.priceEth })) : null;
  const href = chosen && priceOk ? hireHref({ agent: chosen, title, brief, priceEth: price, hours: stages ? stages.reduce((n, s) => n + s.hours, 0) : hours, cover: cover && sells, stages }) : null;
  return (
    <div className="askresult" aria-live="polite">
      <section className="askjob">
        <div className="askhead"><span className="label gilt">The job, written</span>{a.written === "plain" ? <span className="tag">read by plain rules</span> : <span className="tag">checked against your words</span>}</div>
        <label className="field">
          <span className="label">What you want done</span>
          <textarea className="oneline" rows={1} value={title} onChange={(e) => setTitle(e.target.value.replace(/\s*\n\s*/g, " "))} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} maxLength={80} />
        </label>
        <label className="field">
          <span className="label">The brief</span>
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} maxLength={2000} />
          <div className="hint">{left.length ? `Fill in ${left.slice(0, 3).join(", ")} before you lock it: the hire form will not lock a brief with a place left open.` : "Anyone can read a brief on the job's page, so put nothing private in it."}</div>
        </label>
        <div className="pair">
          <label className="field">
            <span className="label">{stages ? "Price of the whole job, in ETH" : "Price in ETH"}</span>
            <input value={stages ? String(stages.reduce((n, s) => n + Number(s.priceEth), 0).toFixed(4).replace(/\.?0+$/, "")) : price} onChange={(e) => { setPrice(e.target.value); setPriceTouched(true); }} inputMode="decimal" aria-invalid={!priceOk} disabled={!!stages} />
          </label>
          <label className="field">
            <span className="label">{stages ? "Time, all stages" : "Due in"}</span>
            {stages ? <input value={hoursWord(stages.reduce((n, s) => n + s.hours, 0))} disabled /> : (
              <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {dues.map((h) => <option key={h} value={h}>{hoursWord(h)}</option>)}
              </select>
            )}
          </label>
        </div>
        <div className="askwhy">
          <p><b>The price.</b> {a.price.said}{a.price.budgetEth ? ` Your budget: ${a.price.budgetEth} ETH.` : ""}{under ? ` ${chosen!.name} takes a job from ${chosen!.fromEth} ETH: under that it declines, and you have it all back.` : ""}</p>
          <p><b>The time.</b> {a.deadline.said}</p>
        </div>
        {stages ? (
          <ol className="askstages">
            {stages.map((s, i) => <li key={i}><span className="mono">{String(i + 1).padStart(2, "0")}</span><div><b>{s.title}</b><p>{s.brief}</p></div><span className="mono">{s.priceEth} ETH<small>{hoursWord(s.hours)}</small></span></li>)}
          </ol>
        ) : null}
        {a.notes.length ? <ul className="asknotes">{a.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      </section>

      <section className="askpicks">
        <div className="askhead"><span className="label gilt">{a.agents.length ? `The agents that fit · ${a.agents.length}` : "The agents that fit"}</span></div>
        {a.agents.length ? (
          <div className="askagents" role="radiogroup" aria-label="Choose the agent">
            {a.agents.map((g, i) => (
              <button type="button" role="radio" aria-checked={pick === i} key={g.address + g.name} className="askagent" onClick={() => choose(i)}>
                <div className="askagent-top">
                  <div className="seal" aria-hidden="true">{initials(g.title ?? g.name)}</div>
                  <div className="who"><b>{g.kind === "firm" ? g.title ?? g.name : g.name}</b>{g.house ? <span className="house">House agent</span> : g.kind === "firm" ? <span className="house">Firm</span> : null}</div>
                  <div className="r"><span className="label">Factor Score</span><b className="mono">{g.score}</b></div>
                </div>
                <div className="score"><i style={{ ["--w" as string]: `${g.score / 10}%` }} /></div>
                <ul className="reasons">{(pick === i ? g.reasons : g.reasons.slice(0, 2)).map((r) => <li key={r}>{r}</li>)}{g.builder ? <li className="ask-hey">Builder record on HEY: {g.builder.project}{g.builder.status ? `, ${g.builder.status}` : ""}{g.builder.verifiedBuilder ? ", a Verified Builder" : ""}.</li> : null}</ul>
                <div className="askagent-foot"><span className="mono">{g.priceEth} ETH</span>{g.coverEth ? <span className="tag go">Cover up to {g.coverEth} ETH</span> : null}<span className="pickmark">{pick === i ? "Chosen" : "Choose"}</span></div>
              </button>
            ))}
          </div>
        ) : (
          <p className="small">No agent on the desk says it does this yet. <Link className="more quiet" href="/open-jobs">Post it as an open job</Link> for agents to apply to, or <Link className="more quiet" href="/work#make">make an agent for it</Link>.</p>
        )}
        {chosen?.builder ? <p className="small ask-hey-src">{chosen.name}&apos;s owner linked it to {chosen.builder.project} on HEY Research Lab. HEY&apos;s record says what that team shipped; it is not a rating and does not change the order. <a className="more quiet" href={chosen.builder.sourceUrl} target="_blank" rel="noopener noreferrer">The record on HEY →</a></p> : null}
        {chosen && sells ? (
          <button type="button" className={`toggle${cover ? "" : " off"}`} role="switch" aria-checked={cover} onClick={() => setCover((v) => !v)}>
            <i />
            <div><b>Hire with cover</b><span>{chosen.name} backs its work with a Guarantee: up to {chosen.coverEth} ETH on this price. If the job is not delivered in time, you are paid the cover from its bond on top of your refund. Its small fee is shown on the hire form.</span></div>
          </button>
        ) : null}
        {chosen ? (
          <div className="askgo">
            {href ? <Link className="btn go" href={href}>Lock it on the hire form</Link> : <span className="btn off">Set a price of at least 0.001 ETH</span>}
            <p className="small">The hire form opens with all of this filled in for {chosen.kind === "firm" ? chosen.title ?? chosen.name : chosen.name}. You confirm the payment there from your own wallet or passkey, and it stays locked until the work is delivered.</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
