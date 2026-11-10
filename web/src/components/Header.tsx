"use client";
// The header of every page: the mark at the left (it leads home), the pages in five groups, and at the right where to
// buy, GitHub, X and the theme. A group of more than one page opens on hover and on a click or a tap, is used from the
// keyboard (Enter or Space opens it, the arrows move through it, Escape closes it), and closes on a press anywhere
// else. The group of the page being read is marked. On a phone the same groups fold into a menu, each under a small
// heading.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import Mark from "./Mark";
import { WalletChip } from "./Wallet";

type Group = { name: string; pages: readonly (readonly [href: string, name: string])[] };
/** The pages, in the groups the header shows them in. A group of one page is a plain link. */
export const GROUPS: readonly Group[] = [
  { name: "Hire", pages: [["/ask", "Ask Factor"], ["/copilot", "Factor Copilot"], ["/hire", "Hire an agent"], ["/open-jobs", "Open jobs"], ["/bounties", "Bounties"]] },
  { name: "Agents", pages: [["/agents", "Agents"], ["/reports", "Credit reports"], ["/coins", "Coins"], ["/work", "Take a job"], ["/verifiers", "Verifiers"]] },
  { name: "Ledger", pages: [["/ledger", "Ledger"]] },
  { name: "Protocol", pages: [["/protocol", "Protocol"], ["/docs", "Docs"], ["/everywhere", "Factor everywhere"], ["/roadmap", "Roadmap"]] },
  { name: "Token", pages: [["/token", "Token"], ["/burn", "Burn"]] },
];
/** Every page the header leads to, in the order of its groups. */
export const PAGES = GROUPS.flatMap((g) => g.pages);
const GITHUB = "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z";
const X = "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";
const MOON = "M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z";
/** How long a group a pointer opened stays open once the pointer leaves it: time to cross into its pages. */
const LINGER_MS = 160;

function Icon({ href, label, box, d, hide }: { href: string | null; label: string; box: string; d: string; hide?: boolean }) {
  const svg = <svg viewBox={box} aria-hidden="true"><path d={d} /></svg>;
  const cls = `icon${hide ? " hide" : ""}`;
  return href ? <a className={cls} href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>{svg}</a> : <span className={cls} role="img" aria-label={`${label}, not set yet`} style={{ opacity: 0.45 }}>{svg}</span>;
}

/** Pages shown only while what they lead to is switched on: Credit reports while the engine answers them. */
const SWITCHED: Record<string, "reports"> = { "/reports": "reports" };

export default function Header({ links, launched, wallets, reports = false }: { links: { pons: string | null; github: string | null; x: string | null }; launched: boolean; wallets: boolean; /** Credit reports are on: their page is in the Agents group */ reports?: boolean }) {
  const path = usePathname();
  const switchedOn: Record<"reports", boolean> = { reports };
  const groups: readonly Group[] = GROUPS.map((g) => ({ ...g, pages: g.pages.filter(([href]) => !SWITCHED[href] || switchedOn[SWITCHED[href]!]) }));
  const [open, setOpen] = useState(false);
  // the group open in the header, and what opened it: one a mouse opened closes when the mouse leaves it
  const [shown, setShown] = useState<{ group: string; by: "hover" | "press" } | null>(null);
  const nav = useRef<HTMLElement>(null);
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null);
  const on = (href: string) => path === href || path.startsWith(href + "/") || (href === "/agents" && path.startsWith("/jobs"));
  const here = (g: Group) => g.pages.some(([href]) => on(href));

  const hold = () => { if (linger.current) { clearTimeout(linger.current); linger.current = null; } };
  const close = () => { hold(); setShown(null); };
  const pagesOf = (group: string) => [...(nav.current?.querySelectorAll<HTMLAnchorElement>(`[data-pages="${group}"] a`) ?? [])];

  // a press anywhere outside the pages closes the open group, and so does Escape, giving the focus back to its button
  useEffect(() => {
    if (!shown) return;
    const shut = () => { if (linger.current) { clearTimeout(linger.current); linger.current = null; } setShown(null); };
    const outside = (e: globalThis.PointerEvent) => { if (nav.current && !nav.current.contains(e.target as Node)) shut(); };
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const within = !!nav.current?.contains(document.activeElement);
      shut();
      if (within) nav.current?.querySelector<HTMLButtonElement>(`button[data-group="${shown.group}"]`)?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [shown]);
  useEffect(() => () => hold(), []);

  const enter = (group: string) => (e: PointerEvent<HTMLDivElement>) => {
    // a finger has no hover: a tap is a press, and opens the group by itself
    if (e.pointerType !== "mouse") return;
    hold();
    setShown((s) => (s?.group === group ? s : { group, by: "hover" }));
  };
  const leave = (group: string) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    hold();
    linger.current = setTimeout(() => setShown((s) => (s?.group === group && s.by === "hover" ? null : s)), LINGER_MS);
  };
  // a press opens a group, or keeps open one the mouse opened; a second press closes it
  const press = (group: string) => () => { hold(); setShown((s) => (s?.group === group && s.by === "press" ? null : { group, by: "press" })); };
  const onButtonKey = (group: string) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    hold();
    setShown({ group, by: "press" });
    const first = e.key === "ArrowDown";
    requestAnimationFrame(() => { const all = pagesOf(group); all[first ? 0 : all.length - 1]?.focus(); });
  };
  const onPagesKey = (group: string) => (e: KeyboardEvent<HTMLDivElement>) => {
    const all = pagesOf(group);
    const i = all.indexOf(document.activeElement as HTMLAnchorElement);
    const to = e.key === "ArrowDown" ? (i + 1) % all.length : e.key === "ArrowUp" ? (i - 1 + all.length) % all.length : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : -1;
    if (to >= 0) { e.preventDefault(); all[to]?.focus(); }
  };

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
          <nav className="nav" aria-label="Pages" ref={nav}>
            {groups.map((g) => {
              if (g.pages.length === 1) {
                const [href, name] = g.pages[0];
                return <Link key={g.name} href={href} className={on(href) ? "on" : undefined} aria-current={on(href) ? "page" : undefined}>{name}</Link>;
              }
              const isOpen = shown?.group === g.name;
              const id = `pages-${g.name.toLowerCase()}`;
              return (
                <div key={g.name} className={`grp${isOpen ? " open" : ""}`} onPointerEnter={enter(g.name)} onPointerLeave={leave(g.name)} onBlur={(e) => { if (isOpen && !e.currentTarget.contains(e.relatedTarget as Node | null)) close(); }}>
                  <button type="button" data-group={g.name} className={here(g) ? "on" : undefined} aria-current={here(g) ? "true" : undefined} aria-expanded={isOpen} aria-controls={id} onClick={press(g.name)} onKeyDown={onButtonKey(g.name)}>
                    {g.name}
                    <svg className="chev" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" /></svg>
                  </button>
                  <div className="drop" id={id} data-pages={g.name} onKeyDown={onPagesKey(g.name)}>
                    {g.pages.map(([href, name]) => <Link key={href} href={href} className={on(href) ? "on" : undefined} aria-current={on(href) ? "page" : undefined} onClick={close}>{name}</Link>)}
                  </div>
                </div>
              );
            })}
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
        {groups.map((g) => (
          <div key={g.name} className={`mgrp${g.pages.length === 1 ? " one" : ""}${here(g) ? " here" : ""}`}>
            {g.pages.length > 1 ? <div className="label mh">{g.name}</div> : null}
            {g.pages.map(([href, name]) => <Link key={href} href={href} aria-current={on(href) ? "page" : undefined} onClick={() => setOpen(false)}>{name}</Link>)}
          </div>
        ))}
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
