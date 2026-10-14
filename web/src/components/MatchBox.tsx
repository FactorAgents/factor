"use client";
// "Just say what you need": the job in the customer's own words, matched to an agent on the desk, with its price and
// a brief written for it (engine/src/match.ts). Nothing is hired here. "Use this" fills in the form below it, and the
// customer locks the job from there, the same way as always.
import { useState } from "react";

export interface Suggestion { agent: string; brief: string; title: string; fromEth: number | null }
interface Match { agent: string | null; fromEth: number | null; brief: string; why: string; missing: string[] }

// a title for the job from what the customer wrote: its first line, without links, at most 80 characters
const titleOf = (text: string) => {
  const line = text.split(/\n/)[0]!.replace(/https?:\/\/\S+|www\.\S+/gi, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return line.length <= 80 ? line : `${line.slice(0, 77).replace(/\s+\S*$/, "")}...`;
};

// the brief with what is still missing shown as what it is: [a place for the customer's own words]
function Brief({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]\n]{2,80}\])/g);
  return <p className="match-brief">{parts.map((p, i) => (/^\[[^\]]+\]$/.test(p) ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}</p>;
}

export default function MatchBox({ known, onUse, disabled = false }: { known: string[]; onUse: (s: Suggestion) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [got, setGot] = useState<{ asked: string; match: Match } | null>(null);
  const [used, setUsed] = useState(false);

  const find = async () => {
    const asked = text.trim();
    if (asked.length < 8) { setError("Say a little more: what the job is and what you want back."); return; }
    setBusy(true); setError(null); setGot(null); setUsed(false);
    try {
      const r = await fetch("/api/v1/match", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: asked }) });
      const b = (await r.json().catch(() => ({}))) as Match & { error?: string };
      if (!r.ok) setError(b.error ?? "Matching did not answer just now. Pick an agent from the list below.");
      else setGot({ asked, match: b });
    } catch {
      setError("Matching did not answer just now. Pick an agent from the list below.");
    } finally {
      setBusy(false);
    }
  };

  const m = got?.match ?? null;
  const onDesk = !!m?.agent && known.includes(m.agent);
  return (
    <div className="matchbox">
      <span className="label">Just say what you need</span>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={4000} placeholder="A landing page for my bakery in Bergen, with the opening hours" disabled={busy || disabled}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void find(); }} />
      <div className="matchbox-row">
        <button type="button" className="btn line" onClick={() => void find()} disabled={busy || disabled || text.trim().length < 8}>{busy ? "Finding the agent..." : "Find the agent"}</button>
        <span className="hint">Factor reads every agent on the desk and picks the one that fits. Nothing is locked yet.</span>
      </div>
      {error ? <p className="status bad" role="alert">{error}</p> : null}
      {m ? (
        <div className="match-card" aria-live="polite">
          {m.agent && onDesk ? (
            <>
              <div className="match-head">
                <div><span className="label">Factor found</span><b>{m.agent}</b></div>
                <div className="r"><span className="label">Price</span><b className="mono">{m.fromEth ? `from ${m.fromEth} ETH` : "you set it"}</b></div>
              </div>
              {m.why ? <p className="small">{m.why}</p> : null}
              <span className="label" style={{ display: "block", marginTop: 16 }}>The brief, written for it</span>
              <Brief text={m.brief} />
              {m.missing.length ? <p className="small">Fill in what is in brackets: {m.missing.join(", ")}.</p> : null}
              <div className="matchbox-row">
                <button type="button" className="btn go" disabled={disabled} onClick={() => { onUse({ agent: m.agent!, brief: m.brief, title: titleOf(got!.asked), fromEth: m.fromEth }); setUsed(true); }}>Use this</button>
                {used ? <span className="hint">The form below is filled in. Check it, then lock the job.</span> : null}
              </div>
            </>
          ) : (
            <p className="small">{m.why || "No agent on the desk fits this job yet."} Pick an agent from the list below, or make one for it on <a className="more quiet" href="/work#make">Take a job</a>.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
