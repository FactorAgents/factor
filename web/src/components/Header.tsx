"use client";
// The header of every page: the mark at the left (it leads home), the pages, and at the right where to buy,
// GitHub, X and the theme. On a phone the pages fold into a menu.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import Mark from "./Mark";
import { WalletChip } from "./Wallet";

export const PAGES = [["/ledger", "Ledger"], ["/agents", "Agents"], ["/coins", "Coins"], ["/open-jobs", "Open jobs"], ["/hire", "Hire"], ["/work", "Take a job"], ["/protocol", "Protocol"], ["/token", "Token"], ["/burn", "Burn"], ["/docs", "Docs"], ["/roadmap", "Roadmap"]] as const;
const GITHUB = "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z";
const X = "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";
const MOON = "M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z";

function Icon({ href, label, box, d, hide }: { href: string | null; label: string; box: string; d: string; hide?: boolean }) {
  const svg = <svg viewBox={box} aria-hidden="true"><path d={d} /></svg>;
  const cls = `icon${hide ? " hide" : ""}`;
  return href ? <a className={cls} href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>{svg}</a> : <span className={cls} role="img" aria-label={`${label}, not set yet`} style={{ opacity: 0.45 }}>{svg}</span>;
}

export default function Header({ links, launched, wallets }: { links: { pons: string | null; github: string | null; x: string | null }; launched: boolean; wallets: boolean }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const on = (href: string) => path === href || path.startsWith(href + "/") || (href === "/agents" && path.startsWith("/jobs"));
  const flip = () => {
    const root = document.documentElement, next = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = next;
    try { localStorage.setItem("factor-theme", next); } catch { /* a browser that keeps nothing still switches */ }
  };
  const buy = launched && links.pons
    ? <a className="btn go pill" href={links.pons} target="_blank" rel="noopener noreferrer">BUY ON PONS</a>
    : <span className="btn off pill">NOT LIVE YET</span>;
  return (
    <>
      <header className="top">
        <div className="wrap">
          <Link className="logo" href="/" aria-label="Factor, home" onClick={() => setOpen(false)}><Mark />Factor</Link>
          <nav className="nav" aria-label="Pages">
            {PAGES.map(([href, name]) => <Link key={href} href={href} className={on(href) ? "on" : undefined} aria-current={on(href) ? "page" : undefined}>{name}</Link>)}
          </nav>
          <div className="right">
            {wallets ? <WalletChip className="hide" /> : null}
            {buy}
            <Icon href={links.github} label="GitHub" box="0 0 16 16" d={GITHUB} hide />
            <Icon href={links.x} label="X" box="0 0 24 24" d={X} hide />
            <button className="icon" id="theme" type="button" aria-label="Light or dark" onClick={flip}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={MOON} /></svg></button>
            <button className="icon burger" type="button" aria-label="Pages" aria-expanded={open} onClick={() => setOpen((v) => !v)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={open ? "M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z" : "M3 7h18v1.5H3zm0 4.25h18v1.5H3zm0 4.25h18V17H3z"} /></svg></button>
          </div>
        </div>
      </header>
      <nav className={`menu${open ? " open" : ""}`} aria-label="Pages">
        {PAGES.map(([href, name]) => <Link key={href} href={href} onClick={() => setOpen(false)}>{name}</Link>)}
        <Link href="/log" onClick={() => setOpen(false)}>Dev log</Link>
        <div className="rowx">
          {wallets ? <WalletChip /> : null}
          <Icon href={links.github} label="GitHub" box="0 0 16 16" d={GITHUB} />
          <Icon href={links.x} label="X" box="0 0 24 24" d={X} />
          <button className="icon" type="button" aria-label="Light or dark" onClick={flip}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={MOON} /></svg></button>
        </div>
      </nav>
    </>
  );
}
