"use client";
// Everything on the site that moves. Each piece draws its finished state on the server, so a browser with no
// script, or one that asks for less motion, still shows the whole page.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Beat, LedgerEvent } from "@/lib/types";
import { beatLines } from "@/lib/prelaunch";
import { STATE_TONE, STATE_WORD, clock } from "@/lib/format";
import { liveHealthy, onBeat } from "@/lib/livebus";

const calm = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Comes up gently the first time it is scrolled into view. `delay` staggers a row of them. */
export function Reveal({ children, delay = 0, className = "", style }: { children: ReactNode; delay?: number; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (calm() || !("IntersectionObserver" in window)) { el.classList.add("in"); return; }
    const io = new IntersectionObserver((seen) => { for (const s of seen) if (s.isIntersecting) { el.classList.add("in"); io.disconnect(); } }, { threshold: 0, rootMargin: "0px 0px -5% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className={`rv ${className}`} style={{ ...style, ["--d" as string]: `${delay}ms` }}>{children}</div>;
}

/** A figure that settles on its value when it is first seen. */
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
      const t0 = performance.now(), dur = 1400;
      const step = (now: number) => { const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 5); el.textContent = write(to * e); if (p < 1) raf = requestAnimationFrame(step); };
      el.textContent = write(0);
      raf = requestAnimationFrame(step);
    }, { threshold: 0.4 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, places, group]);
  return <span ref={ref} className="count">{write(to)}</span>;
}

/* ── The receipt ──────────────────────────────────────────────────────────────
   Factor's one moving picture: the ledger as a bill coming out of a printer. Every line that is written on the
   chain is printed at the top, and the paper feeds down. A settled job gets the double rule a sum gets.
   The paper, the slot and every line are drawn here by hand, in SVG. */
const W = 400, H = 520, SLOT = 18, LEFT = 44, RIGHT = 356, TOP = 46, LINE = 15, GAP = 14, CHARS = 46, KEEP = 10;
type Block = { id: number; e: LedgerEvent; time: string; lines: string[]; h: number };

function wrap(text: string, max: number): string[] {
  const out: string[] = []; let cur = "";
  for (const w of text.split(" ")) { const t = (cur + " " + w).trim(); if (t.length > max && cur) { out.push(cur); cur = w; } else cur = t; }
  if (cur) out.push(cur);
  return out;
}
const block = (e: LedgerEvent, id: number, time: string): Block => {
  const lines = wrap((e.jobId ? `job ${e.jobId} · ` : "") + (e.demo ? "demo · " : "") + e.text, CHARS);
  return { id, e, time, lines, h: LINE * (1 + lines.length) + GAP };
};
const chars = (b: Block) => b.time.length + (STATE_WORD[b.e.kind] ?? b.e.kind).length + b.e.amount.length + b.lines.reduce((n, l) => n + l.length, 0);

// how often the receipt asks for new blocks between two reads of the page, while the page is looked at
const PULSE_MS = 6_000;

export function Receipt({ events, pulse = false }: { events: LedgerEvent[]; pulse?: boolean }) {
  const [blocks, setBlocks] = useState<Block[]>(() => events.slice(0, KEEP).map((e) => block(e, e.n, clock(e.at))));
  const [typed, setTyped] = useState(Infinity);   // how many characters of the newest line have been printed
  const [live, setLive] = useState(false);
  const seen = useRef<number | null>(null);        // the newest line that has been printed
  const queue = useRef<LedgerEvent[]>([]);
  const kick = useRef<() => void>(() => undefined);   // starts the printer when it rests and the queue has lines
  // Only what it is handed is ever printed, with the time it has there: the ledger's own lines, or before the launch
  // Factor's own agents, one line each (lib/prelaunch.ts). Nothing is made up for it. When the page is first looked at, the
  // paper shows the lines as they stand, newest on top; after that a line is printed only when the ledger has a new
  // one, and the paper rests in between.
  useEffect(() => {
    if (calm()) return;
    let raf = 0, timer = 0;
    const print = () => {
      const e = queue.current.shift();
      if (!e) { timer = 0; return; }
      const fresh = block(e, e.n, clock(e.at));
      setBlocks((had) => [fresh, ...had.filter((b) => b.id !== fresh.id)].slice(0, KEEP));
      setLive(true);
      const total = chars(fresh), t0 = performance.now(), dur = 560;
      const step = (now: number) => { const p = Math.min(1, (now - t0) / dur); setTyped(p < 1 ? Math.floor(p * total) : Infinity); if (p < 1) raf = requestAnimationFrame(step); };
      setTyped(0);
      raf = requestAnimationFrame(step);
      timer = window.setTimeout(print, 2600);
    };
    kick.current = () => { if (!timer && queue.current.length) timer = window.setTimeout(print, 300); };
    if (seen.current === null) {
      // the first look: the paper already shows everything up to the newest line, and nothing is printed again
      seen.current = events[0]?.n ?? 0;
    } else {
      const fresh = events.filter((e) => e.n > seen.current!).reverse();
      if (fresh.length) {
        // never back: the blocks read in between may already be newer than the page's own newest line
        seen.current = Math.max(seen.current!, events[0].n);
        queue.current.push(...fresh);
      }
      // also when the page was read again in the middle of a printout: what was waiting goes on being printed
      if (queue.current.length) timer = window.setTimeout(print, 400);
    }
    return () => { window.clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [events]);

  // Between two reads of the page, the blocks the desk reads come in on their own, so the paper keeps moving while it
  // works. Only blocks newer than the last line printed; nothing when motion is turned down or the tab is not looked at.
  // While the page's live stream is well each block arrives on it the moment it is read (lib/livebus.ts), and nothing
  // is asked for; otherwise they are asked for every few seconds.
  useEffect(() => {
    if (!pulse || calm()) return;
    let on = true, last: Beat | null = null;
    const take = (items: Beat[]) => {
      if (!on || !items.length || seen.current === null) return;
      last = items[0];
      const fresh = beatLines(items).filter((e) => e.n > seen.current! && !queue.current.some((q) => q.n === e.n)).reverse();
      if (!fresh.length) return;
      seen.current = Math.max(seen.current, ...fresh.map((e) => e.n));
      queue.current.push(...fresh);
      kick.current();
    };
    const read = () => {
      if (document.visibilityState !== "visible" || liveHealthy()) return;
      fetch("/api/v1/pulse", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ items?: Beat[] }>) : null))
        .then((got) => take(got?.items ?? []))
        .catch(() => undefined);
    };
    const t = window.setInterval(read, PULSE_MS);
    const stop = onBeat((b) => { if (document.visibilityState === "visible" && (!last || b.block > last.block)) take(last ? [b, last] : [b]); });
    return () => { on = false; window.clearInterval(t); stop(); };
  }, [pulse]);

  // where each block sits on the paper, and, for the newest one, how many characters come before each of its texts
  const laid: { b: Block; top: number; offs: number[] }[] = [];
  for (let i = 0, top = TOP; i < blocks.length; i++) {
    const b = blocks[i], parts = [b.time, STATE_WORD[b.e.kind] ?? b.e.kind, b.e.amount, ...b.lines], offs: number[] = [];
    for (let k = 0, n = 0; k < parts.length; k++) { offs.push(n); n += parts[k].length; }
    laid.push({ b, top, offs });
    top += b.h;
  }
  const cut = (s: string, first: boolean, from: number) => (!first || typed === Infinity ? s : s.slice(0, Math.max(0, typed - from)));
  return (
    <svg className="receipt" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="The latest lines of the ledger, printed as a receipt">
      <defs>
        <clipPath id="rc-clip"><rect x="0" y={SLOT / 2} width={W} height={H - SLOT / 2} /></clipPath>
        <linearGradient id="rc-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.72" stopColor="#fff" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
        <mask id="rc-mask"><rect x="0" y="0" width={W} height={H} fill="url(#rc-fade)" /></mask>
        <linearGradient id="rc-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#000" stopOpacity="0.32" /><stop offset="1" stopColor="#000" stopOpacity="0" /></linearGradient>
      </defs>
      <g clipPath="url(#rc-clip)" mask="url(#rc-mask)">
        <g className="feed" style={{ transformBox: "fill-box" }}>
          <rect className="paper" x="24" y="0" width={W - 48} height={H + 40} />
          <line className="edge" x1="24.5" y1="0" x2="24.5" y2={H + 40} />
          <line className="edge" x1={W - 24.5} y1="0" x2={W - 24.5} y2={H + 40} />
          {laid.map(({ b, top, offs }, i) => {
            const first = i === 0, tone = STATE_TONE[b.e.kind] ?? "", settled = b.e.kind === "settled";
            return (
              <g key={b.id} className={`block${first && live ? " new" : ""}`} style={{ transform: `translateY(${top}px)`, ["--h" as string]: b.h }}>
                <text className="t" x={LEFT} y="11">{cut(b.time, first, offs[0])}</text>
                <text className={`k${tone ? ` ${tone}` : ""}`} x={LEFT + 66} y="11">{cut((STATE_WORD[b.e.kind] ?? b.e.kind).toUpperCase(), first, offs[1])}</text>
                <text className="a" x={RIGHT} y="11">{cut(b.e.amount, first, offs[2])}</text>
                {b.lines.map((l, k) => <text key={k} x={LEFT} y={11 + LINE * (k + 1)}>{cut(l, first, offs[3 + k])}</text>)}
                {settled ? <><line className="dbl" x1={RIGHT - 72} x2={RIGHT} y1="14" y2="14" /><line className="dbl" x1={RIGHT - 72} x2={RIGHT} y1="16.5" y2="16.5" /></> : null}
                <line className="sep" x1={LEFT} x2={RIGHT} y1={b.h - 6.5} y2={b.h - 6.5} />
              </g>
            );
          })}
        </g>
        <rect x="24" y={SLOT} width={W - 48} height="30" fill="url(#rc-shade)" />
      </g>
      <rect className="slot" x="14.5" y="0.5" width={W - 29} height={SLOT} rx="1.5" />
      {live ? <rect key={blocks[0]?.id} className="head" x={LEFT} y={SLOT + 1} width={RIGHT - LEFT} height="1.5" /> : null}
    </svg>
  );
}
