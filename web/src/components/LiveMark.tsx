"use client";
// A quiet word in the footer while the page is told of changes as they happen (components/Live.tsx). Nothing at all
// when it is not: the page then reads itself on its timer, which is no fault to show.
import { useSyncExternalStore } from "react";
import { liveHealthy, onLiveStatus } from "@/lib/livebus";

export default function LiveMark() {
  const on = useSyncExternalStore((changed) => onLiveStatus(changed), liveHealthy, () => false);
  if (!on) return null;
  return <span className="livemark" title="This page updates by itself the moment the desk changes"><i aria-hidden="true" />Live</span>;
}
