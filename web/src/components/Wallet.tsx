"use client";
// The visitor's wallet, for every part of the site that sends something: who is connected, how to connect, and one
// way to run a call and say where it stands. A visitor with no wallet connects an account instead (lib/passkey.ts):
// it answers the same requests, so nothing below this file knows the difference.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { explain, Refusal } from "@/lib/desk";
import { askAccount, ensureChain, goGetAWallet, provider, sharedAccount, type Provider } from "@/lib/wallet";
import { createAccount, passkeyProvider, passkeysHere, remember, remembered, signIn, type Session } from "@/lib/passkey";
import { short } from "@/lib/format";

interface WalletState {
  /** the connected account, lowercase, or null */
  address: string | null;
  /** asks the wallet for an account; with no wallet in this browser it sends the visitor to get one */
  connect(): Promise<string | null>;
  disconnect(): void;
  /** the wallet itself, when one is connected: a real one, or an account answering as one */
  wallet(): Provider | null;
  /** what is connected: a wallet, or an account without one (a passkey) */
  kind: "wallet" | "passkey" | null;
  /** whether an account without a wallet can be made and used on this site right now */
  accounts: boolean;
}

const Ctx = createContext<WalletState>({ address: null, connect: async () => null, disconnect: () => {}, wallet: () => null, kind: null, accounts: false });
export const useWallet = (): WalletState => useContext(Ctx);
const KEY = "factor-wallet";

export function WalletProvider({ children, accounts = false }: { children: ReactNode; accounts?: boolean }) {
  const [address, setAddress] = useState<string | null>(null);
  // an account without a wallet, when that is what is connected
  const [session, setSession] = useState<Session | null>(null);
  const [asking, setAsking] = useState(false);
  // whoever signed in with a passkey before is signed in again: what the browser kept is public (an address, a
  // public key), and nothing can be done with it without the passkey itself
  useEffect(() => {
    if (!accounts) return;
    let on = true;
    // read after the page is drawn, like the wallet below: what the server drew had nobody signed in
    void Promise.resolve().then(() => { const s = remembered(); if (on && s) setSession(s); });
    return () => { on = false; };
  }, [accounts]);
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
    if (!p) {
      // no wallet in this browser: an account with a passkey, where the site has them; otherwise where a wallet is got
      if (accounts && passkeysHere()) setAsking(true);
      else goGetAWallet();
      return null;
    }
    const a = await askAccount(p);
    if (!a) return null;
    setAddress(a);
    try { localStorage.setItem(KEY, "1"); } catch { /* still connected for this visit */ }
    // asked for now, so the first thing the visitor sends does not start with a second prompt
    void ensureChain(p).catch(() => undefined);
    return a;
  }, [accounts]);
  const disconnect = useCallback(() => {
    setAddress(null);
    setSession(null);
    remember(null);
    try { localStorage.removeItem(KEY); } catch { /* nothing was kept */ }
  }, []);
  // one adapter for the life of a session, so a form that holds on to it keeps talking to the same account
  const adapter = useMemo(() => (session ? passkeyProvider(session) : null), [session]);
  const value = useMemo<WalletState>(() => {
    // a real wallet that is connected comes first; an account is what is connected when there is none
    if (address) return { address, connect, disconnect, wallet: () => provider(), kind: "wallet", accounts };
    if (session && adapter) return { address: session.address, connect, disconnect, wallet: () => adapter, kind: "passkey", accounts };
    return { address: null, connect, disconnect, wallet: () => null, kind: null, accounts };
  }, [address, session, adapter, connect, disconnect, accounts]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {asking ? <PasskeyDialog onDone={(s) => { if (s) setSession(s); setAsking(false); }} /> : null}
    </Ctx.Provider>
  );
}

/** For a visitor with no wallet: make an account with a passkey, or come back to one. */
function PasskeyDialog({ onDone }: { onDone: (s: Session | null) => void }) {
  const [at, setAt] = useState<"idle" | "passkey" | "making" | "finding">("idle");
  const [error, setError] = useState("");
  const busy = at !== "idle";
  const run = (fn: () => Promise<Session>) => {
    setError("");
    fn().then(onDone, (e) => { setAt("idle"); setError(explain(e)); });
  };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onDone(null); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [busy, onDone]);
  return (
    <div className="veil" role="presentation" onClick={(e) => { if (e.target === e.currentTarget && !busy) onDone(null); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="passkey-title">
        <span className="label gilt">No wallet needed</span>
        <div className="h3" id="passkey-title">An account with a passkey</div>
        <p className="small">Your fingerprint, your face or this device&apos;s PIN is the key. Nothing to install and no words to write down, and Factor pays the gas of what you do here.</p>
        <div className="cta">
          <button type="button" className="btn go" disabled={busy} onClick={() => run(() => createAccount(setAt))}>Create an account</button>
          <button type="button" className="btn line" disabled={busy} onClick={() => { setAt("finding"); run(signIn); }}>I have one already</button>
        </div>
        {at === "passkey" ? <p className="status" role="status"><i className="dot" />Your device is asking for your fingerprint, face or PIN.</p> : null}
        {at === "making" ? <p className="status" role="status"><i className="dot" />Making the account on the chain. A few seconds…</p> : null}
        {at === "finding" ? <p className="status" role="status"><i className="dot" />Choose the passkey on your device.</p> : null}
        {error ? <p className="status bad" role="alert">{error}</p> : null}
        <p className="fine">The passkey lives in your device&apos;s own keychain, which Apple and Google keep in step across your devices. Factor never holds it and cannot open or bring back an account for anybody. <button type="button" className="linkish" disabled={busy} onClick={() => { onDone(null); goGetAWallet(); }}>Use a wallet instead</button></p>
      </div>
    </div>
  );
}

/** The small control in the header: connect, or the connected account (press it to disconnect). */
export function WalletChip({ className = "" }: { className?: string }) {
  const { address, connect, disconnect, kind } = useWallet();
  return address
    ? <button type="button" className={`btn line pill wallet ${className}`} onClick={disconnect} title={kind === "passkey" ? "Sign out of this account on this device. Your passkey signs you in again." : "Disconnect this wallet from the site"} aria-label={`Connected as ${address}. ${kind === "passkey" ? "Sign out" : "Disconnect"}`}><i />{short(address)}</button>
    : <button type="button" className={`btn line pill wallet ${className}`} onClick={() => void connect().catch(() => undefined)}>CONNECT</button>;
}

/** Inside a form: which account is signing, and the way out of it. */
export function SignedInAs({ busy = false }: { busy?: boolean }) {
  const { address, disconnect } = useWallet();
  if (!address) return null;
  return <p className="small" style={{ marginTop: 14 }}>Signed in as <span className="mono">{short(address)}</span> · <button type="button" className="linkish" disabled={busy} onClick={disconnect}>Sign out</button></p>;
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
// the same moments for an account without a wallet: the device asks, and Factor sends
const SAYS_PASSKEY: Partial<Record<Step, string>> = {
  wallet: "Confirm with your fingerprint, face or PIN.",
  signing: "Confirm with your fingerprint, face or PIN. It costs nothing.",
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
  const { kind } = useWallet();
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
  return <p className="status" role="status"><i className="dot" />{(kind === "passkey" && SAYS_PASSKEY[status.at]) || SAYS[status.at]}</p>;
}

/** The button every form ends with: it connects first when nobody is connected. */
export function Go({ label, busy, onGo, off, line }: { label: string; busy: boolean; onGo: () => void; off?: string | null; line?: boolean }) {
  const { address, connect, accounts } = useWallet();
  if (off) return <span className="btn off">{off}</span>;
  if (!address) return <button type="button" className="btn go" onClick={() => void connect().catch(() => undefined)}>{accounts ? "Connect, or use a passkey" : "Connect a wallet"}</button>;
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
export async function saveSigned(path: "agents/profile" | "agents/make" | "agents/pause" | "jobs/title" | "jobs/brief" | "jobs/delivery" | "pay/links", body: Record<string, unknown>, patient = false): Promise<void> {
  for (let tries = 0; ; tries++) {
    const r = await fetch(`/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return;
    const said = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "It could not be saved.";
    // a brand new job, or a delivery the engine has not read yet, shows up a few seconds later: asked again
    if (!(patient && (r.status === 404 || (r.status === 409 && path === "jobs/delivery")) && tries < 15)) throw new Refusal(said.charAt(0).toUpperCase() + said.slice(1) + (said.endsWith(".") ? "" : "."));
    await new Promise((res) => setTimeout(res, 2000));
  }
}
