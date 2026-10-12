"use client";
// Everything on the site that moves. Each piece draws its finished state on the server, so a browser with no
// script, or one that asks for less motion, still shows the whole page.
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { LedgerEvent } from "@/lib/types";
import { STATE_TONE, STATE_WORD } from "@/lib/format";

const calm = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Comes up out of a blur the first time it is scrolled into view. `delay` staggers a row of them. */
export function Reveal({ children, delay = 0, className = "", style }: { children: ReactNode; delay?: number; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (calm() || !("IntersectionObserver" in window)) { el.classList.add("in"); return; }
    const io = new IntersectionObserver((seen) => { for (const s of seen) if (s.isIntersecting) { el.classList.add("in"); io.disconnect(); } }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className={`rv ${className}`} style={{ ...style, ["--d" as string]: `${delay}ms` }}>{children}</div>;
}

/** A figure that counts up to its value when it is first seen. */
export function Count({ to, places = 0, group = false }: { to: number; places?: number; group?: boolean }) {
  const write = (v: number) => (group ? v.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places }) : v.toFixed(places));
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || calm() || !("IntersectionObserver" in window)) return;
    let raf = 0;
    const io = new IntersectionObserver((seen) => {
      if (!seen.some((s) => s.isIntersecting)) return;
      io.disconnect();
      const t0 = performance.now(), dur = 1300;
      const step = (now: number) => { const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 4); el.textContent = write(to * e); if (p < 1) raf = requestAnimationFrame(step); };
      el.textContent = write(0);
      raf = requestAnimationFrame(step);
    }, { threshold: 0.4 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, places, group]);
  return <span ref={ref} className="count">{write(to)}</span>;
}

/** The block the figures are from, ticking on. */
export function LiveBlock({ from }: { from: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let n = from;
    const id = window.setInterval(() => { n += 3 + Math.floor(Math.random() * 4); if (ref.current) ref.current.textContent = n.toLocaleString("en-US"); }, 420);
    return () => window.clearInterval(id);
  }, [from]);
  return <span className="liveblock"><i />live · block <span ref={ref}>{from.toLocaleString("en-US")}</span></span>;
}

const LOOP = [
  { say: "A customer locks 0.04 ETH for the job", bar: 0 },
  { say: "Factor advances 0.02 ETH to the agent", bar: 50 },
  { say: "The agent delivers the work", bar: 50 },
  { say: "The pool is repaid first, the agent gets the rest", bar: 100 },
];
/** The flow, played over and over: a job being locked, advanced, delivered and settled. */
export function FlowLive() {
  const [step, setStep] = useState(1);
  useEffect(() => {
    if (calm()) return;
    const id = window.setInterval(() => setStep((s) => (s + 1) % LOOP.length), 2400);
    return () => window.clearInterval(id);
  }, []);
  const s = LOOP[step];
  return (
    <div className={`card flow live at${step}`}>
      <div className={`node n1${step === 0 ? " hot" : ""}`}><div className="label">01 · The customer</div><b>Locks 0.04 ETH</b><p>The whole price of the job, held by the contract.</p></div>
      <div className={`arrow${step === 0 || step === 1 ? " run" : ""}`}><i /></div>
      <div className={`node mid${step === 1 || step === 3 ? " hot" : ""}`}>
        <div className="label">02 · Factor</div><b>Advances 0.02 ETH</b>
        <div className="split"><i style={{ width: `${s.bar}%` }} /></div>
        <div className="ends"><span>advanced now</span><span>paid on delivery</span></div>
      </div>
      <div className={`arrow${step === 1 || step === 2 ? " run" : ""}`}><i /></div>
      <div className={`node n3${step === 2 || step === 3 ? " hot" : ""}`}><div className="label">03 · The agent</div><b>Delivers, gets the rest</b><p>The pool is repaid first. The fee buys back and burns $FACTOR.</p></div>
      <div className="flow-say" key={step}><i />{s.say}<span>{step + 1} / {LOOP.length}</span></div>
    </div>
  );
}

const two = (n: number) => String(n).padStart(2, "0");
const nowClock = () => { const d = new Date(); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`; };
/** The ledger with new lines coming in at the top. On sample figures the lines repeat; on the chain they are real. */
export function LiveLedger({ events, keep = 7 }: { events: LedgerEvent[]; keep?: number }) {
  const [rows, setRows] = useState(() => events.slice(0, keep).map((e) => ({ ...e, clock: "", fresh: false })));
  const next = useRef(keep);
  useEffect(() => {
    if (calm()) return;
    const id = window.setInterval(() => {
      const e = events[next.current % events.length];
      next.current += 1;
      setRows((had) => [{ ...e, n: 1000 + next.current, clock: nowClock(), fresh: true }, ...had.map((r) => ({ ...r, fresh: false }))].slice(0, keep));
    }, 3600);
    return () => window.clearInterval(id);
  }, [events, keep]);
  return (
    <div className="card ledger">
      {rows.map((e) => {
        const tone = STATE_TONE[e.kind] ?? "";
        const inner = (<>
          <span className="time">{e.clock || new Date(e.at).toISOString().slice(11, 19)}</span>
          <span><span className={`tag${tone ? ` ${tone}` : ""}`}>{STATE_WORD[e.kind] ?? e.kind}</span></span>
          <span className="what">{e.jobId ? <><b>job {e.jobId}</b> · </> : null}{e.text}</span>
          <span className="amt">{e.amount}</span>
        </>);
        const cls = `row${e.fresh ? " fresh" : ""}`;
        return e.jobId ? <Link key={e.n} className={cls} href={`/jobs/${e.jobId}`}>{inner}</Link> : <div key={e.n} className={cls}>{inner}</div>;
      })}
    </div>
  );
}

/** A soft light that follows the pointer across the top of the page. */
export function Spotlight({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || calm()) return;
    const move = (ev: PointerEvent) => { const r = el.getBoundingClientRect(); el.style.setProperty("--mx", `${ev.clientX - r.left}px`); el.style.setProperty("--my", `${ev.clientY - r.top}px`); };
    el.addEventListener("pointermove", move);
    return () => el.removeEventListener("pointermove", move);
  }, []);
  return <section ref={ref} className={`spot ${className}`}>{children}</section>;
}
