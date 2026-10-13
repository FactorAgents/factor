"use client";
// The visitor's wallet, for every part of the site that sends something: who is connected, how to connect, and one
// way to run a call and say where it stands.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { explain, Refusal } from "@/lib/desk";
import { askAccount, ensureChain, goGetAWallet, provider, sharedAccount, type Provider } from "@/lib/wallet";
import { short } from "@/lib/format";

interface WalletState {
  /** the connected account, lowercase, or null */
  address: string | null;
  /** asks the wallet for an account; with no wallet in this browser it sends the visitor to get one */
  connect(): Promise<string | null>;
  disconnect(): void;
  /** the wallet itself, when one is connected */
  wallet(): Provider | null;
}

const Ctx = createContext<WalletState>({ address: null, connect: async () => null, disconnect: () => {}, wallet: () => null });
export const useWallet = (): WalletState => useContext(Ctx);
const KEY = "factor-wallet";

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  // A visitor who connected before is connected again when they come back, without being asked: the wallet already
  // shares the account with this site. One who disconnected here is not.
  useEffect(() => {
    const p = provider();
    if (!p) return;
    let on = true;
    let remembered = false;
    try { remembered = localStorage.getItem(KEY) === "1"; } catch { /* a browser that keeps nothing */ }
    if (remembered) void sharedAccount(p).then((a) => { if (on && a) setAddress(a); });
    const changed = (...a: unknown[]) => {
      const first = (a[0] as string[] | undefined)?.[0];
      setAddress((had) => (had === null ? null : typeof first === "string" ? first.toLowerCase() : null));
    };
    p.on?.("accountsChanged", changed);
    return () => { on = false; p.removeListener?.("accountsChanged", changed); };
  }, []);

  const connect = useCallback(async () => {
    const p = provider();
    if (!p) { goGetAWallet(); return null; }
    const a = await askAccount(p);
    if (!a) return null;
    setAddress(a);
    try { localStorage.setItem(KEY, "1"); } catch { /* still connected for this visit */ }
    // asked for now, so the first thing the visitor sends does not start with a second prompt
    void ensureChain(p).catch(() => undefined);
    return a;
  }, []);
  const disconnect = useCallback(() => {
    setAddress(null);
    try { localStorage.removeItem(KEY); } catch { /* nothing was kept */ }
  }, []);
  const value = useMemo<WalletState>(() => ({ address, connect, disconnect, wallet: () => (address ? provider() : null) }), [address, connect, disconnect]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The small control in the header: connect, or the connected account (press it to disconnect). */
export function WalletChip({ className = "" }: { className?: string }) {
  const { address, connect, disconnect } = useWallet();
  return address
    ? <button type="button" className={`btn line pill wallet ${className}`} onClick={disconnect} title="Disconnect this wallet from the site" aria-label={`Connected as ${address}. Disconnect`}><i />{short(address)}</button>
    : <button type="button" className={`btn line pill wallet ${className}`} onClick={() => void connect().catch(() => undefined)}>CONNECT</button>;
}

// ---- one way to run something a wallet does, and say where it stands ----

export type Step = "checking" | "wallet" | "mining" | "signing" | "saving";
export type Status = { at: "idle" } | { at: Step } | { at: "done"; note: string; hash?: string; href?: string; hrefText?: string } | { at: "error"; message: string };
export interface Done { note: string; hash?: string; href?: string; hrefText?: string }

const SAYS: Record<Step, string> = {
  checking: "Checking it against the desk…",
  wallet: "Confirm it in your wallet.",
  mining: "Sent. Waiting for the chain…",
  signing: "Sign the text in your wallet. It costs nothing.",
  saving: "Saving…",
};

/**
 * `onDone`: where the result is said when the form that sent it is about to leave the page (a job that closes takes
 * its buttons with it). The form then goes back to rest and the page's own line says what happened.
 */
export function useSend(onDone?: (done: Done) => void) {
  const [status, setStatus] = useState<Status>({ at: "idle" });
  const router = useRouter();
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const run = useCallback(async (fn: (on: (step: Step) => void) => Promise<Done>) => {
    setStatus({ at: "checking" });
    try {
      const done = await fn((step) => setStatus({ at: step }));
      if (onDone) {
        onDone(done);
        setStatus({ at: "idle" });
      } else setStatus({ at: "done", ...done });
      // the engine shows it a few seconds after the chain has it: the page is read again a few times
      router.refresh();
      timers.current = [3000, 7000, 13_000, 22_000].map((ms) => window.setTimeout(() => router.refresh(), ms));
      return true;
    } catch (e) {
      setStatus({ at: "error", message: explain(e) });
      return false;
    }
  }, [router, onDone]);
  const busy = status.at !== "idle" && status.at !== "done" && status.at !== "error";
  return { status, run, busy, reset: () => setStatus({ at: "idle" }) };
}

/** Where a send stands, under the button that started it. */
export function StatusLine({ status, explorer }: { status: Status; explorer: string }) {
  if (status.at === "idle") return null;
  if (status.at === "error") return <p className="status bad" role="alert">{status.message}</p>;
  if (status.at === "done") {
    return (
      <p className="status ok" role="status">
        {status.note}{" "}
        {status.href ? <a className="more" href={status.href}>{status.hrefText ?? "Open it"} →</a> : null}{" "}
        {status.hash ? <a className="more quiet" href={`${explorer}/tx/${status.hash}`} target="_blank" rel="noopener noreferrer">The transaction →</a> : null}
      </p>
    );
  }
  return <p className="status" role="status"><i className="dot" />{SAYS[status.at]}</p>;
}

/** The button every form ends with: it connects first when nobody is connected. */
export function Go({ label, busy, onGo, off, line }: { label: string; busy: boolean; onGo: () => void; off?: string | null; line?: boolean }) {
  const { address, connect } = useWallet();
  if (off) return <span className="btn off">{off}</span>;
  if (!address) return <button type="button" className="btn go" onClick={() => void connect().catch(() => undefined)}>Connect a wallet</button>;
  return <button type="button" className={`btn ${line ? "line" : "go"}`} disabled={busy} onClick={onGo}>{label}</button>;
}

// ---- the two things that are signed and kept by the engine ----

/** The engine's clock, in seconds: what a signature's time is measured against. */
export async function engineNow(): Promise<number> {
  const r = await fetch("/api/v1/state", { cache: "no-store" });
  const s = (await r.json()) as { asOf?: string };
  const t = s.asOf ? Math.floor(Date.parse(s.asOf) / 1000) : NaN;
  if (!Number.isFinite(t)) throw new Refusal("The site could not reach its engine. Try again in a moment.");
  return t;
}

/** Hand a signed name or title to the engine. `patient`: the engine may not have seen a brand new job yet. */
export async function saveSigned(path: "agents/profile" | "jobs/title", body: Record<string, unknown>, patient = false): Promise<void> {
  for (let tries = 0; ; tries++) {
    const r = await fetch(`/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return;
    const said = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "It could not be saved.";
    if (!(patient && r.status === 404 && tries < 15)) throw new Refusal(said.charAt(0).toUpperCase() + said.slice(1) + (said.endsWith(".") ? "" : "."));
    await new Promise((res) => setTimeout(res, 2000));
  }
}
