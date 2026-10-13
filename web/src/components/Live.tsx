"use client";
// Keeps a page that is being looked at current: every so often it is read again from the engine, quietly. Nothing
// a visitor has typed is lost by it, and a tab that is not being looked at asks for nothing.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Live({ every = 20 }: { every?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, every * 1000);
    return () => window.clearInterval(t);
  }, [router, every]);
  return null;
}
