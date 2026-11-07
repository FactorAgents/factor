"use client";
// Factor Copilot (lib/copilot.ts, engine/src/copilot.ts): a chat on every page that runs the desk from plain sentences.
// It asks for what is missing, answers from the desk, and hands back a card for each action: what it does, how much, to
// whom and which contract. The card is checked again in this browser, then signed by the visitor's own wallet or passkey
// account with the site's existing calls. After that the chat follows the job, step by step, as the desk moves it.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { check, sign, STEP_WORD, TRIES, type Answer, type Known, type Prepared, type Reply } from "@/lib/copilot";
import { explain } from "@/lib/desk";
import { readEvery } from "@/lib/livebus";
import { CHAIN } from "@/lib/chain";
import type { Job } from "@/lib/types";
import { engineNow, Go, saveSigned, useWallet, type Step } from "./Wallet";

interface Turn { who: "you" | "copilot" | "desk"; text: string; reply?: Reply; at: number }
interface Kept { conversation: string | null; turns: Turn[]; follow: number | null; seen: string | null; done: Record<string, { note: string; hash: string; href?: string }> }
const KEY = "factor-copilot";
const EMPTY: Kept = { conversation: null, turns: [], follow: null, seen: null, done: {} };
const tzOf = () => -new Date().getTimezoneOffset();
const SAYS: Partial<Record<Step, string>> = {
  checking: "Checking it against the contract…", wallet: "Confirm it in your wallet.", mining: "Sent. Waiting for the chain…", signing: "Sign the brief in your wallet. It costs nothing.", saving: "Saving…",
  reserving: "Step 1 of 3: confirm the cover in your wallet.", locking: "Step 2 of 3: confirm the job in your wallet.", tying: "Step 3 of 3: confirm tying the cover to it.",
};

/** The chat's memory for this tab: the conversation and what was said, so a page change keeps it. Nothing leaves the tab. */
function useKept(): [Kept, (f: (k: Kept) => Kept) => void] {
  const [k, setK] = useState<Kept>(EMPTY);
  useEffect(() => {
    void Promise.resolve().then(() => { try { const raw = sessionStorage.getItem(KEY); if (raw) setK({ ...EMPTY, ...(JSON.parse(raw) as Kept) }); } catch { /* a browser that keeps nothing */ } });
  }, []);
  const update = useCallback((f: (k: Kept) => Kept) => {
    setK((old) => {
      const next = f(old);
      try { sessionStorage.setItem(KEY, JSON.stringify({ ...next, turns: next.turns.slice(-40) })); } catch { /* kept for this page only */ }
      return next;
    });
  }, []);
  return [k, update];
}

/** The chat itself: on the Copilot page, and in the panel every other page opens. */
export function CopilotChat({ known, enabled, mostChars = 500, compact = false, initial = "", open = "" }: { known: Known; enabled: boolean; mostChars?: number; compact?: boolean; initial?: string; /** a conversation begun elsewhere (an assistant, the kit), opened here to sign its card */ open?: string }) {
  const { address } = useWallet();
  const [k, update] = useKept();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const ask = useCallback(async (said: string) => {
    const s = said.replace(/\s+/g, " ").trim();
    if (!s || busy) return;
    setBusy(true); setError(null); setText("");
    update((x) => ({ ...x, turns: [...x.turns, { who: "you", text: s, at: Date.now() }] }));
    try {
      const r = await fetch("/api/v1/copilot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: s, conversation: k.conversation ?? undefined, tz: tzOf(), ...(address ? { address } : {}) }) });
      const b = (await r.json().catch(() => ({}))) as Answer & { error?: string };
      if (!r.ok) setError(b.error ? b.error.replace(/^./, (c) => c.toUpperCase()).replace(/([^.!?])$/, "$1.") : "Copilot did not answer just now. Try again in a moment.");
      else update((x) => ({ ...x, conversation: b.conversation, follow: b.reply.follow ?? x.follow, turns: [...x.turns, { who: "copilot", text: b.reply.text, reply: b.reply, at: Date.now() }] }));
    } catch {
      setError("Copilot did not answer just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }, [address, busy, k.conversation, update]);

  useEffect(() => {
    if (started.current || !enabled) return;
    if (/^[0-9a-f]{32}$/.test(open)) {
      started.current = true;
      void fetch(`/api/v1/copilot/c/${open}`, { cache: "no-store" }).then((r) => (r.ok ? (r.json() as Promise<{ turns: { who: string; text: string }[]; action: Prepared | null }>) : null)).then((b) => {
        if (!b) { setError("That conversation has ended: chats last 30 minutes after their last message. Say it again here."); return; }
        const last = b.turns.map((t) => t.who).lastIndexOf("copilot");
        update(() => ({ ...EMPTY, conversation: open, turns: b.turns.map((t, i) => (t.who === "you" ? { who: "you" as const, text: t.text, at: Date.now() } : { who: "copilot" as const, text: t.text, at: Date.now(), ...(i === last && b.action ? { reply: { text: t.text, kind: "action" as const, facts: [], agents: [], action: b.action, follow: null, choices: [] } } : {}) })) }));
      }).catch(() => setError("Copilot did not answer just now. Try again in a moment."));
      return;
    }
    if (initial.trim().length < 2) return;
    started.current = true;
    void Promise.resolve().then(() => ask(initial.trim()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the newest turn in view
  useEffect(() => { const el = list.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }, [k.turns.length, busy, error]);

  // the job the chat follows: each step it reaches is said once, as the desk moves it
  const follow = k.follow;
  useEffect(() => {
    if (follow === null) return;
    let on = true;
    const read = () => fetch(`/api/v1/jobs/${follow}`, { cache: "no-store" }).then((r) => (r.ok ? (r.json() as Promise<{ job?: Job }>) : null)).then((b) => {
      const j = b?.job;
      if (!on || !j) return;
      const mark = `${follow}:${j.state}`;
      update((x) => (x.seen === mark || x.follow !== follow ? x : { ...x, seen: mark, turns: [...x.turns, { who: "desk", text: `Job ${j.id}. ${STEP_WORD[j.state] ?? j.state}`, at: Date.now() }], follow: j.state === "locked" || j.state === "advanced" || j.state === "delivered" ? follow : null }));
    }).catch(() => undefined);
    void read();
    const stop = readEvery(read, 6000, 60_000);
    return () => { on = false; stop(); };
  }, [follow, update]);

  const signed = (p: Prepared, r: { note: string; hash: string; job: number | null; href?: string }) => update((x) => ({ ...x, done: { ...x.done, [p.id]: { note: r.note, hash: r.hash, ...(r.href ? { href: r.href } : {}) } }, follow: r.job ?? x.follow, seen: r.job !== null && r.job !== x.follow ? null : x.seen }));
  const fresh = () => update(() => ({ ...EMPTY }));

  return (
    <div className={`cp${compact ? " compact" : ""}`}>
      <div className="cp-list" ref={list} aria-live="polite">
        {k.turns.length === 0 ? (
          <div className="cp-hello">
            <span className="label gilt">Factor Copilot</span>
            <p>Say what you need in plain words. I ask for what is missing, answer from the desk, and prepare each step for your wallet to sign. I never sign or send anything.</p>
            {enabled ? <div className="cp-tries">{TRIES.map((t) => <button type="button" key={t} onClick={() => void ask(t)} disabled={busy}>{t}</button>)}</div> : null}
          </div>
        ) : null}
        {k.turns.map((t, i) => <TurnView key={i} t={t} last={i === k.turns.length - 1} known={known} done={t.reply?.action ? k.done[t.reply.action.id] ?? null : null} onSigned={signed} onChoose={(c) => void ask(c)} busy={busy} />)}
        {busy ? <p className="status cp-wait"><i className="dot" />Copilot is reading the desk…</p> : null}
        {error ? <p className="status bad" role="alert">{error}</p> : null}
      </div>
      <form className="cp-in" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <label htmlFor={compact ? "cp-text-panel" : "cp-text"} className="sr">Message Copilot</label>
        <textarea id={compact ? "cp-text-panel" : "cp-text"} rows={1} value={text} maxLength={mostChars} disabled={!enabled || busy} placeholder={enabled ? "I need a landing page by Friday, 0.02 ETH at most" : "Copilot is resting just now"}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(text); } }} />
        <button type="submit" className="btn go" disabled={!enabled || busy || !text.trim()}>Send</button>
      </form>
      <p className="cp-fine">{enabled ? <>Copilot prepares; your wallet signs every step. {k.turns.length ? <button type="button" className="linkish" onClick={fresh}>Start over</button> : <Link className="linkish" href="/docs#copilot">How it works</Link>}</> : <>Copilot is resting. Every form on the site works as always.</>}</p>
    </div>
  );
}

function TurnView({ t, last, known, done, onSigned, onChoose, busy }: { t: Turn; last: boolean; known: Known; done: { note: string; hash: string; href?: string } | null; onSigned: (p: Prepared, r: { note: string; hash: string; job: number | null; href?: string }) => void; onChoose: (c: string) => void; busy: boolean }) {
  if (t.who === "you") return <div className="cp-you"><p>{t.text}</p></div>;
  if (t.who === "desk") return <div className="cp-desk"><span className="label gilt">On the desk</span><p>{t.text}</p></div>;
  const r = t.reply;
  return (
    <div className={`cp-me${r?.kind === "refusal" ? " no" : ""}`}>
      <p>{t.text}</p>
      {r?.facts.length ? <ul className="cp-facts">{r.facts.map((f, i) => <li key={i}>{f}</li>)}</ul> : null}
      {r?.agents.length ? (
        <ol className="cp-agents">
          {r.agents.map((a) => <li key={a.name}><div className="cp-agent-head"><b>{a.name}</b><span className="mono">{a.priceEth} ETH</span><span className="tag">Score {a.score}</span></div><p>{a.reasons.slice(1, 4).join(" ")}</p></li>)}
        </ol>
      ) : null}
      {r?.action ? <Card p={r.action} known={known} done={done} onSigned={onSigned} /> : null}
      {last && r?.choices.length ? <div className="cp-choices">{r.choices.map((c) => <button type="button" key={c} onClick={() => onChoose(c)} disabled={busy}>{c}</button>)}</div> : null}
    </div>
  );
}

/** A prepared action: what it does in words, checked again here, and the one button that signs it in the wallet. */
function Card({ p, known, done, onSigned }: { p: Prepared; known: Known; done: { note: string; hash: string; href?: string } | null; onSigned: (p: Prepared, r: { note: string; hash: string; job: number | null; href?: string }) => void }) {
  const { address, wallet, kind } = useWallet();
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => { const tick = () => setNow(Date.now()); tick(); const t = window.setInterval(tick, 15_000); return () => window.clearInterval(t); }, []);
  let said = "", bad = "";
  try { said = check(p, known, now || Date.parse(p.expiresAt) - 1).said; } catch (e) { bad = explain(e); }
  const go = async () => {
    const w = wallet();
    if (!w || !address) return;
    setError(null); setStep("checking");
    try {
      const r = await sign(p, known, { provider: w, address, passkey: kind === "passkey", engineNow, save: saveSigned }, setStep);
      onSigned(p, r);
    } catch (e) {
      setError(explain(e));
    } finally {
      setStep(null);
    }
  };
  return (
    <div className="cp-card">
      <div className="cp-card-head"><span className="label gilt">Ready to sign</span><span className="label">{p.calls.length === 1 ? "1 transaction" : `${p.calls.length} transactions`}</span></div>
      <div className="h3">{p.title}</div>
      <dl>{p.lines.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <details className="cp-checked"><summary>What was checked</summary><ul>{p.checked.map((c, i) => <li key={i}>{c}</li>)}{said ? <li>{said}</li> : null}</ul></details>
      {done ? (
        <p className="status ok" role="status">{done.note} {done.href ? <a className="more" href={done.href}>Open it →</a> : null} {done.hash ? <a className="more quiet" href={`${CHAIN.explorer}/tx/${done.hash}`} target="_blank" rel="noopener noreferrer">The transaction →</a> : null}</p>
      ) : bad ? <p className="status bad" role="alert">{bad}</p> : (
        <>
          <div className="cta"><Go label="Sign in wallet" busy={step !== null} onGo={() => void go()} off={!known.desk ? "Nothing is live yet" : null} /></div>
          {step ? <p className="status" role="status"><i className="dot" />{(kind === "passkey" && (step === "wallet" || step === "signing") ? "Confirm with your fingerprint, face or PIN." : SAYS[step]) ?? "Working…"}</p> : null}
          {error ? <p className="status bad" role="alert">{error}</p> : null}
        </>
      )}
    </div>
  );
}

/** The Copilot button on every page, and the panel it opens. The Copilot page has the chat itself, so no button there. */
export function CopilotDock({ known, enabled, mostChars }: { known: Known; enabled: boolean; mostChars: number }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    // a phone's page does not scroll behind the panel
    const phone = window.matchMedia("(max-width: 720px)").matches;
    if (phone) document.documentElement.classList.add("cp-lock");
    return () => { window.removeEventListener("keydown", esc); document.documentElement.classList.remove("cp-lock"); };
  }, [open]);
  if (!enabled || path === "/copilot") return null;
  return (
    <>
      <button type="button" className={`cp-dock${open ? " on" : ""}`} aria-expanded={open} aria-controls="cp-panel" onClick={() => setOpen((v) => !v)}>
        <i aria-hidden="true" /><span>Copilot</span>
      </button>
      {open ? (
        <aside className="cp-panel" id="cp-panel" role="dialog" aria-modal="false" aria-label="Factor Copilot">
          <div className="cp-panel-head">
            <div><span className="label gilt">Factor Copilot</span><div className="cp-panel-title">Runs the desk from a sentence</div></div>
            <div className="cp-panel-acts"><Link className="icon" href="/copilot" title="Open the Copilot page" aria-label="Open the Copilot page" onClick={() => setOpen(false)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h11v11h-2V8.41l-10.3 10.3-1.41-1.42L15.59 7H8z" /></svg></Link><button type="button" className="icon" onClick={() => setOpen(false)} aria-label="Close Copilot">×</button></div>
          </div>
          <CopilotChat known={known} enabled={enabled} mostChars={mostChars} compact />
        </aside>
      ) : null}
    </>
  );
}
