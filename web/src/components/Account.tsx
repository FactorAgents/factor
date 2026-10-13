"use client";
// An account without a wallet, on the page: what is in it, how ETH gets in and out, and a second key. Shown only
// to a visitor who is signed in with a passkey; a wallet has its own app for all of this.
import { useEffect, useState } from "react";
import { fromWei, Refusal, sendPlain, toWei } from "@/lib/desk";
import { accountView, addWalletKeyData, type AccountView } from "@/lib/passkey";
import { Go, StatusLine, useSend, useWallet } from "./Wallet";

export default function AccountPanel({ explorer }: { explorer: string }) {
  const { address, wallet, kind } = useWallet();
  const [view, setView] = useState<AccountView | null>(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState<"" | "out" | "key">("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const { status, run, busy } = useSend();
  const mine = kind === "passkey" ? address : null;
  useEffect(() => {
    if (!mine) return;
    let on = true;
    const read = () => accountView(mine).then((v) => { if (on) setView(v); }).catch(() => undefined);
    void read();
    const t = window.setInterval(read, 6000);
    return () => { on = false; window.clearInterval(t); };
  }, [mine, busy]);
  if (!mine) return null;
  const balance = view && view.address === mine ? BigInt(view.balanceWei) : null;
  const wei = toWei(amount);
  const address40 = /^0x[0-9a-fA-F]{40}$/.test(to.trim());
  const copy = () => void navigator.clipboard?.writeText(mine).then(() => setCopied(true)).catch(() => undefined);
  const takeOut = () => run(async (on) => {
    const p = wallet();
    if (!p) throw new Refusal("Sign in first.");
    if (!address40) throw new Refusal("Enter the address the ETH should go to.");
    if (wei === null || wei === 0n) throw new Refusal("Enter an amount in ETH, like 0.01.");
    const { hash } = await sendPlain(p, mine, to.trim().toLowerCase(), { value: wei, on });
    setAmount("");
    return { note: `${fromWei(wei)} ETH left your account.`, hash };
  });
  const addKey = () => run(async (on) => {
    const p = wallet();
    if (!p) throw new Refusal("Sign in first.");
    if (!address40) throw new Refusal("Enter the wallet's address.");
    const { hash } = await sendPlain(p, mine, mine, { data: addWalletKeyData(to.trim()), on });
    setTo("");
    return { note: "That wallet is a key of your account now. It can use the account by itself.", hash };
  });
  const keys = view?.keys.length ?? 1;
  return (
    <div className="account">
      <span className="label">Your account</span>
      <dl className="kv fit" style={{ marginTop: 14 }}>
        <dt>In it</dt><dd className="sum">{balance === null ? "…" : `${fromWei(balance)} ETH`}</dd>
        <dt>Its address<small>send ETH here, on Robinhood Chain, to put money in</small></dt><dd><button type="button" className="linkish mono" onClick={copy} title="Copy the address">{copied ? "copied" : `${mine.slice(0, 8)}…${mine.slice(-6)}`}</button></dd>
        <dt>Gas<small>Factor pays it, for {view?.ordersPerDay ?? 40} actions a day</small></dt><dd>{view ? `${view.ordersToday} used today` : "…"}</dd>
        <dt>Keys<small>{keys > 1 ? "your passkey, and a wallet" : "your passkey, on this device and in its keychain"}</small></dt><dd>{keys}</dd>
      </dl>
      <div className="cta">
        <button type="button" className="btn line" aria-expanded={open === "out"} onClick={() => setOpen(open === "out" ? "" : "out")} disabled={busy}>Take ETH out</button>
        <button type="button" className="btn line" aria-expanded={open === "key"} onClick={() => setOpen(open === "key" ? "" : "key")} disabled={busy}>Add a second key</button>
      </div>
      {open === "out" ? (
        <div className="form" style={{ marginTop: 18 }}>
          <label className="field"><span className="label">To this address</span><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" disabled={busy} autoCapitalize="none" spellCheck={false} /></label>
          <label className="field"><span className="label">Amount in ETH</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.0000" disabled={busy} /><div className="hint">{balance !== null ? `The account holds ${fromWei(balance)} ETH. Sending is free: Factor pays the gas.` : " "}</div></label>
          <div className="cta"><Go label="Send it" busy={busy || !address40 || wei === null || wei === 0n} onGo={() => void takeOut()} /></div>
        </div>
      ) : null}
      {open === "key" ? (
        <div className="form" style={{ marginTop: 18 }}>
          <p className="small">A wallet you add here becomes a second way into this account. It can use the account by itself, with or without Factor, so add one if you keep more here than you would shrug off losing with your passkey.</p>
          <label className="field" style={{ marginTop: 14 }}><span className="label">The wallet&apos;s address</span><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" disabled={busy} autoCapitalize="none" spellCheck={false} /></label>
          <div className="cta"><Go label="Add it as a key" busy={busy || !address40} onGo={() => void addKey()} /></div>
        </div>
      ) : null}
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}
