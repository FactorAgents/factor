// In the browser: what the page's live stream (components/Live.tsx) tells the parts of the page that read on their own.
//
// While the stream is open and well, a part that used to read every few seconds reads at once when something changed,
// and on its old timer only now and then, in case a change was missed. While it is not (no stream, a break, LIVE_PUSH
// off), every part reads on its old timer exactly as before.
import type { Beat } from "./types";

const STATUS = "factor:live";
const CHANGE = "factor:change";
const PULSE = "factor:pulse";

let healthy = false;

/** The stream is open and has been heard from lately. */
export const liveHealthy = (): boolean => healthy;

export function setLiveHealthy(v: boolean): void {
  if (healthy === v) return;
  healthy = v;
  window.dispatchEvent(new CustomEvent(STATUS, { detail: v }));
}

/** Something the desk shows changed: every part that reads on its own reads now. */
export const announceChange = (): void => void window.dispatchEvent(new Event(CHANGE));
/** A new block the engine read. */
export const announceBeat = (b: Beat): void => void window.dispatchEvent(new CustomEvent<Beat>(PULSE, { detail: b }));

/** Calls `fn` with each new block read, while the stream brings them. */
export function onBeat(fn: (b: Beat) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<Beat>).detail);
  window.addEventListener(PULSE, h);
  return () => window.removeEventListener(PULSE, h);
}

/** Calls `fn` whenever the stream starts or stops being well. */
export function onLiveStatus(fn: (healthy: boolean) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<boolean>).detail);
  window.addEventListener(STATUS, h);
  return () => window.removeEventListener(STATUS, h);
}

/**
 * `read` every `ms`, as the part always did; while the stream is well only every `slowMs`, and at once when something
 * changed. Returns how to stop. The caller still reads once itself when it starts.
 */
export function readEvery(read: () => void, ms: number, slowMs = Math.max(ms * 15, 120_000)): () => void {
  let last = Date.now();
  const now = () => { last = Date.now(); read(); };
  const t = window.setInterval(() => { if (!healthy || Date.now() - last >= slowMs) now(); }, ms);
  window.addEventListener(CHANGE, now);
  return () => { window.clearInterval(t); window.removeEventListener(CHANGE, now); };
}
