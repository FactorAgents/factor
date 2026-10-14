"use client";
// The burn clock: how long until the burn pot may burn again, ticking. Every figure is the pot's own, as the chain
// has it (the engine reads FactorBurnPot's preview); the clock only counts down to the time the contract gave.
import { useEffect, useState } from "react";
import type { BurnPot } from "@/lib/types";

const two = (n: number) => String(n).padStart(2, "0");
const left = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
};
const ethText = (n: number) => `${n.toFixed(n >= 1 ? 3 : 4)} ETH`;

export function BurnClock({ burn, asOf }: { burn: BurnPot | null; asOf: string }) {
  // the server's clock, not the visitor's: the page says when it was read, and the clock runs on from there. The
  // first drawing is at exactly that moment, so the page the server drew and the one the browser takes over agree.
  const read = Date.parse(asOf) || 0;
  const [now, setNow] = useState(read);
  useEffect(() => {
    const skew = (read || Date.now()) - Date.now();
    const tick = () => setNow(Date.now() + skew);
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [read]);

  const every = (burn?.everyMin ?? 30) * 60_000;
  const at = burn?.nextAt ? Date.parse(burn.nextAt) : null;
  const due = !!burn && (burn.ready || (at !== null && at <= now && burn.open));
  // how far the fuse has burned: the time since the last burn (or the launch) out of the half hour
  const fuse = !burn ? 0 : due ? 1 : at === null ? 1 : Math.min(1, Math.max(0, 1 - (at - now) / every));

  let big: string, line: string;
  if (!burn) {
    big = "30:00";
    line = "Burns start at the launch. From then on, at most every 30 minutes, the pot buys $FACTOR with what it holds and burns it.";
  } else if (due) {
    big = "00:00";
    line = `A burn is due now, of ${ethText(burn.nextEth)}. Anybody can send it, and Factor's engine does within a minute or two.`;
  } else if (at === null) {
    big = "--:--";
    line = `The pot is empty. The next burn goes ${burn.everyMin} minutes after the last one, as soon as fees have come in.`;
  } else if (burn.potEth < burn.smallestEth) {
    big = left(at - now);
    line = `The pot holds ${ethText(burn.potEth)}, under the ${burn.smallestEth} ETH a burn needs, so it waits for more fees, or a day at most.`;
  } else {
    big = left(at - now);
    line = `until the next burn may go. It will spend ${ethText(burn.nextEth)} on $FACTOR and burn every token it buys.`;
  }

  return (
    <div className={`burnclock${due ? " due" : ""}${burn ? "" : " before"}`}>
      <div className="desk-state"><span className={`lamp${burn && burn.open ? " on" : ""}`} aria-hidden="true" /><span>{!burn ? "Not launched yet" : due ? "Burn due" : "Next burn"}</span></div>
      <b className="clock mono" aria-live="off">{big}</b>
      <div className="fuse" aria-hidden="true"><i style={{ transform: `scaleX(${fuse})` }} /></div>
      <p className="small">{line}</p>
    </div>
  );
}
