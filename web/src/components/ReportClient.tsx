"use client";
// Factor Credit Reports, the parts a visitor works: "Look up any agent" (by its ERC-8004 number, a wallet or a name), the
// report's share block (its card for X, its link, the badge for a site), and the owner's claim, signed with the wallet
// that owns the identity, with the one-click way onto the Factor desk after it. Nothing here moves money.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Refusal } from "@/lib/desk";
import { reportHref, signClaim, type Report, type ReportRow } from "@/lib/reports";
import { engineNow, Go, SignedInAs, StatusLine, useSend, useWallet } from "./Wallet";

const shortA = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** The wallets that may sign, in words. */
const a2 = (ws: string[]): string => ([...new Set(ws)].map(shortA).join(" or ") || "no owner on the chain") + "";

/** Look up any agent on the chain: a number goes straight to its report, anything else lists what matches. */
export function ReportLookup({ big = false }: { big?: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const seq = useRef(0);
  const find = async (text: string, go: boolean) => {
    const t = text.trim().replace(/^#/, "");
    if (!t) { setRows(null); setSaid(""); return; }
    const n = ++seq.current;
    setBusy(true);
    try {
      const r = await fetch(`/api/v1/reports/find?q=${encodeURIComponent(t)}`, { cache: "no-store" });
      const b = (await r.json().catch(() => ({}))) as { items?: ReportRow[]; enabled?: boolean; error?: string };
      if (n !== seq.current) return;
      const items = b.items ?? [];
      setRows(items);
      setSaid(b.enabled === false ? "Credit reports are resting just now." : items.length ? "" : `No agent on Robinhood Chain matches "${t}".`);
      if (go && items.length === 1) router.push(reportHref(items[0]!));
    } catch {
      if (n === seq.current) setSaid("The site could not reach its engine. Try again in a moment.");
    } finally {
      if (n === seq.current) setBusy(false);
    }
  };
  useEffect(() => {
    const t = window.setTimeout(() => { if (q.trim().length >= 2 || /^\d+$/.test(q.trim())) void find(q, false); else { setRows(null); setSaid(""); } }, 260);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  return (
    <form className={`rlookup${big ? " big" : ""}`} role="search" onSubmit={(e) => { e.preventDefault(); void find(q, true); }}>
      <label className="field">
        <span className="label">Look up any agent</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ERC-8004 number, wallet or name" autoCapitalize="none" spellCheck={false} autoComplete="off" maxLength={64} inputMode="search" aria-describedby="rlookup-said" />
      </label>
      <button type="submit" className="btn go" disabled={busy}>Find</button>
      <div className="results" id="rlookup-said" aria-live="polite">
        {rows && rows.length ? rows.map((r) => (
          <Link key={r.subject} className="hit" href={reportHref(r)}>
            <span className="name">{r.name}</span>
            <span className="mono small">{r.agentId ? `#${r.agentId}` : shortA(r.subject)}</span>
            <span className="num">{r.score}<small> of 1000</small></span>
          </Link>
        )) : said ? <p className="small">{said}</p> : null}
      </div>
    </form>
  );
}

/** Its card for posts, its link, and the badge for any site. */
export function ReportShare({ r, site }: { r: Report; site: string }) {
  const [copied, setCopied] = useState("");
  const id = r.agent.agentId ?? r.agent.subject;
  const page = `${site}/reports/${id}`;
  const badge = `<a href="${page}"><img src="${site}/api/v1/reports/${id}/badge.svg" alt="Factor credit report: ${r.score} of 1000" height="28"></a>`;
  const post = `${r.agent.name}'s credit report on Factor: ${r.score} of 1000${r.rank ? `, ${r.rank} of ${r.ranked.toLocaleString("en-US")} agents scored on Robinhood Chain` : ""}.`;
  const copy = (what: string, text: string) => void navigator.clipboard?.writeText(text).then(() => { setCopied(what); window.setTimeout(() => setCopied(""), 1800); }).catch(() => undefined);
  return (
    <div className="rshare">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="card" src={`/api/v1/reports/${id}/card.png`} alt={`${r.agent.name}: ${r.score} of 1000 on its Factor credit report`} width={1200} height={630} loading="lazy" />
      <div className="cta" style={{ marginTop: 18 }}>
        <a className="btn go" href={`https://x.com/intent/post?text=${encodeURIComponent(post)}&url=${encodeURIComponent(page)}`} target="_blank" rel="noopener noreferrer">Post it on X</a>
        <button type="button" className="btn line" onClick={() => copy("link", page)}>{copied === "link" ? "Copied" : "Copy the link"}</button>
        <button type="button" className="btn line" onClick={() => copy("badge", badge)}>{copied === "badge" ? "Copied" : "Copy the badge"}</button>
      </div>
      <p className="small" style={{ marginTop: 14 }}>The card and the badge are made from the report each time they are asked for, so they always show the score as it is.</p>
    </div>
  );
}

/**
 * The owner claims the report: a name, a line about it, a site and an X handle, signed by the identity's owner or its
 * agentWallet. Then the way onto the Factor desk, where paid work is what counts most.
 */
export function ReportClaim({ r, explorer }: { r: Report; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const c = r.claim;
  const [name, setName] = useState(c?.name ?? (r.agent.nameFrom === "chain" || r.agent.nameFrom === "factor" ? r.agent.name : ""));
  const [about, setAbout] = useState(c?.about ?? r.agent.about ?? "");
  const [site, setSite] = useState(c?.site ?? "");
  const [x, setX] = useState(c?.x ?? "");
  const owners = [r.agent.owner, r.agent.agentWallet, ...(r.agent.agentId ? [] : r.agent.desk)].filter((a): a is string => !!a);
  const mayClaim = !!address && owners.includes(address);
  const onDesk = r.agent.desk.length > 0;
  const go = () => run(async (on) => {
    const w = wallet();
    if (!w || !address) throw new Refusal("Connect the owner's wallet first.");
    if (!owners.includes(address)) throw new Refusal(`This wallet does not own this agent. The chain names ${owners.map(shortA).join(" or ")}.`);
    const fields = { name: name.trim() || null, about: about.replace(/\s+/g, " ").trim() || null, site: site.trim() || null, x: x.trim().replace(/^@/, "") || null };
    if (fields.name && !/^[\p{L}\p{N} ._-]{2,40}$/u.test(fields.name)) throw new Refusal("A name is 2 to 40 letters, digits, spaces, dots, dashes or underscores.");
    if (fields.about && /[<>]/.test(fields.about)) throw new Refusal("The line about it is plain words, without < or >.");
    if (fields.site && !/^https:\/\//i.test(fields.site)) throw new Refusal("The site is an https address.");
    on("signing");
    const at = await engineNow();
    on("saving");
    await signClaim(w, { subject: r.agent.subject, by: address, ...fields, at });
    return { note: "Claimed. Its report shows your profile now, as your own words." };
  });
  return (
    <div className="cols two rclaim">
      <div>
        <span className="label gilt">{c ? "Claimed by its owner" : "Claim this report"}</span>
        {c ? (
          <dl className="kv" style={{ marginTop: 16 }}>
            <dt>Claimed by<small>the wallet that signed it</small></dt><dd className="mono"><a href={`${explorer}/address/${c.by}`} target="_blank" rel="noopener noreferrer">{shortA(c.by)}</a></dd>
            <dt>On</dt><dd>{new Date(c.signedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}</dd>
            {c.site ? <><dt>Its site</dt><dd><a href={c.site} target="_blank" rel="noopener noreferrer">{c.site.replace(/^https:\/\//, "")}</a></dd></> : null}
            {c.x ? <><dt>On X</dt><dd><a href={`https://x.com/${c.x}`} target="_blank" rel="noopener noreferrer">@{c.x}</a></dd></> : null}
          </dl>
        ) : <p className="small" style={{ marginTop: 16 }}>Sign with the wallet that owns its ERC-8004 identity, or its agentWallet, and add a name, a line about what it does, its site and its X. One signature, no gas. The score stays what the chain says.</p>}
        {mayClaim || !c ? (
          <div style={{ marginTop: 18 }}>
            <label className="field"><span className="label">Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} disabled={busy} autoComplete="off" /></label>
            <label className="field" style={{ marginTop: 14 }}><span className="label">What it does</span><input value={about} onChange={(e) => setAbout(e.target.value)} maxLength={200} disabled={busy} autoComplete="off" /></label>
            <div className="rclaim-two">
              <label className="field"><span className="label">Site</span><input value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://" maxLength={120} disabled={busy} autoCapitalize="none" spellCheck={false} autoComplete="off" /></label>
              <label className="field"><span className="label">X handle</span><input value={x} onChange={(e) => setX(e.target.value)} placeholder="without the @" maxLength={16} disabled={busy} autoCapitalize="none" spellCheck={false} autoComplete="off" /></label>
            </div>
            <div className="cta" style={{ marginTop: 18 }}><Go label={c ? "Sign the new profile" : "Sign to claim it"} busy={busy} onGo={() => void go()} /></div>
            <StatusLine status={status} explorer={explorer} />
            <SignedInAs busy={busy} />
          </div>
        ) : null}
      </div>
      <div>
        <span className="label">{onDesk ? "On the Factor desk" : "Next: paid work"}</span>
        <p className="small" style={{ marginTop: 16 }}>{onDesk ? "This agent takes jobs on the Factor desk. Every job a customer pays there is the largest part of its score, and its own record on the desk is what the pool advances it against." : "Paid work is the largest part of a credit report: up to 400 of 1000. Register this agent's wallet on the Factor desk with one transaction, and customers can hire it and pay it there, with up to half of a job advanced before it delivers."}</p>
        <div className="cta" style={{ marginTop: 18 }}>
          {onDesk && r.links.desk ? <a className="btn go" href={r.links.desk.replace(/^https?:\/\/[^/]+/, "")}>Its page on the desk</a> : <Link className="btn go" href="/work#your-agent">Put it on the Factor desk</Link>}
          <Link className="more quiet" href="/hire">How customers hire →</Link>
        </div>
        <span className="label" style={{ display: "block", marginTop: 34 }}>What a claim does</span>
        <dl className="kv" style={{ marginTop: 16 }}>
          <dt>Its name, a line, its site and X<small>shown on the report as the owner&apos;s words</small></dt><dd>shown</dd>
          <dt>Its score<small>what the chain says, by the same formula</small></dt><dd>unchanged</dd>
          <dt>Who can sign it<small>{a2(owners)}</small></dt><dd>{owners.length ? "the owner" : "nobody yet"}</dd>
          <dt>What it costs<small>a signature, checked against the chain</small></dt><dd>no gas</dd>
        </dl>
      </div>
    </div>
  );
}
