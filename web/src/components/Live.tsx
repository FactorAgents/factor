"use client";
// Keeps a page that is being looked at current, quietly. Nothing a visitor has typed is lost by it, and a tab that is
// not being looked at asks for nothing.
//
// With the live stream (app/api/live, lib/live.ts) the page is told the moment something on the desk changes, and reads
// itself again then, once, a quarter of a second later so a burst of changes is one read. It still reads itself every
// few minutes in case a change was missed. Without the stream (switched off, not supported, or broken until it comes
// back by itself) the page reads itself every `every` seconds, as it always did.
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { announceBeat, announceChange, setLiveHealthy } from "@/lib/livebus";

// while the stream is well, the page still reads itself this often, in case a change was missed
const SAFETY_MS = 5 * 60_000;
// the server says something at least every 15 s: nothing for this long and the stream is taken as broken
const QUIET_MS = 40_000;
const SETTLE_MS = 250;

export default function Live({ every = 20, push = false, since = "" }: { every?: number; push?: boolean; since?: string }) {
  const router = useRouter();
  // what the page was first drawn with: later reads of the page do not start the stream again
  const drawn = useRef(since);
  useEffect(() => {
    let lastRead = Date.now(), known = drawn.current;
    let es: EventSource | null = null, up = false, heard = 0, wait = 2_000, retry = 0, soon = 0;
    const read = () => { lastRead = Date.now(); router.refresh(); };
    const healthy = () => !!es && up && Date.now() - heard < QUIET_MS;
    const status = () => setLiveHealthy(healthy());
    // a change: the page reads itself, and so does every part of it that reads on its own
    const changed = () => { window.clearTimeout(soon); soon = window.setTimeout(() => { read(); announceChange(); }, SETTLE_MS); };
    const seen = (s: unknown) => { if (typeof s === "string" && s && s !== known) { known = s; changed(); } };
    const close = () => { window.clearTimeout(retry); es?.close(); es = null; up = false; status(); };
    const open = () => {
      if (!push || es || typeof EventSource === "undefined" || document.visibilityState !== "visible") return;
      const s = new EventSource("/api/live");
      es = s;
      const data = (e: Event): Record<string, unknown> => { try { return JSON.parse((e as MessageEvent<string>).data) as Record<string, unknown>; } catch { return {}; } };
      const on = (name: string, fn: (d: Record<string, unknown>) => void) => s.addEventListener(name, (e) => { heard = Date.now(); fn(data(e)); status(); });
      on("hello", (d) => { up = !!d.up; wait = 2_000; seen(d.since); });
      on("up", (d) => { up = true; seen(d.since); });
      on("down", () => { up = false; });
      on("change", (d) => seen(d.since));
      on("ping", () => undefined);
      on("pulse", (d) => { if (typeof d.block === "number" && typeof d.at === "string") announceBeat({ block: d.block, gwei: typeof d.gwei === "number" ? d.gwei : null, at: d.at }); });
      s.onerror = () => {
        up = false;
        status();
        // the browser tries again by itself, unless what came back was not a stream at all: then this page does, slower each time
        if (s.readyState === EventSource.CLOSED && es === s) {
          es = null;
          retry = window.setTimeout(open, wait);
          wait = Math.min(wait * 2, 60_000);
        }
      };
    };
    const tick = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      // a stream that has gone quiet is closed and opened again
      if (es && heard && Date.now() - heard > QUIET_MS) { close(); open(); }
      status();
      if (!healthy() || Date.now() - lastRead >= SAFETY_MS) read();
    }, every * 1000);
    // a tab that is not looked at holds no stream; when it is looked at again, the stream says whether it missed anything
    const shown = () => (document.visibilityState === "visible" ? open() : close());
    document.addEventListener("visibilitychange", shown);
    open();
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(soon);
      document.removeEventListener("visibilitychange", shown);
      close();
    };
  }, [router, every, push]);
  return null;
}
