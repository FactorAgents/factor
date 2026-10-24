"use client";
// Verified owners on the site: the mark beside an agent (with how it is checked, on hover or a tap), the neutral word
// where a customer compares offers, and the owner's own panel to verify. Every outcome is the engine's
// (engine/src/verified.ts): nothing is worked out here. An agent whose owner is not verified shows nothing, except the
// plain "not verified" where offers are compared.
import { Fragment, useState } from "react";
import { Refusal } from "@/lib/desk";
import { day } from "@/lib/format";
import { CHECK_WORD, passedWords, signVerify } from "@/lib/verified";
import type { VerifiedOwner } from "@/lib/types";
import { engineNow, Go, SignedInAs, StatusLine, useSend, useWallet } from "./Wallet";

/** How it is checked, in two or three lines: the same everywhere the mark shows. */
export function howChecked(sources: string[], checkedAt: string): string {
  return `The wallet that runs this agent signed, and Factor checked it: ${passedWords(sources) || "it passed"}. Checked ${day(checkedAt)}. Only the outcome is kept: no score, stamp or name.`;
}

/**
 * The mark: "Verified owner", with how it is checked on hover, on focus and on a tap. `plain`: inside a link (a row of a
 * list), where it can hold nothing that is pressed, so it says it in the title alone.
 */
export function VerifiedMark({ sources, checkedAt, plain = false, href }: { sources: string[]; checkedAt: string; plain?: boolean; href?: string }) {
  const [open, setOpen] = useState(false);
  const text = howChecked(sources, checkedAt);
  if (plain) return <span className="vmark" title={text}><Tick />Verified owner</span>;
  return (
    <span className={`vmark has-pop${open ? " open" : ""}`} tabIndex={0} role="button" aria-expanded={open} aria-label={`Verified owner. ${text}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } if (e.key === "Escape") setOpen(false); }} onBlur={() => setOpen(false)}>
      <Tick />Verified owner
      <span className="vpop" role="tooltip">
        <b>How this is checked</b>
        <span>{text}</span>
        {href ? <a className="more quiet" href={href} onMouseDown={(e) => e.preventDefault()}>More on its page →</a> : null}
      </span>
    </span>
  );
}

/** The neutral word where a customer compares offers: said plainly, never as a warning. */
export function NotVerified() {
  return <span className="vmark none" title="Its owner has not verified with Human Passport or Talent Protocol. That says nothing against the agent: many owners have not.">Owner not verified</span>;
}

function Tick() {
  return <svg className="tick" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M3.6 6.2l1.6 1.6 3.2-3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/**
 * On an agent's page: the outcome when its owner is verified, for everybody; and for the owner (the wallet that runs
 * it), one signature to verify, or to check again. Anybody else sees nothing while it is not verified.
 */
export function VerifyPanel({ agent, name, owners, v, checks, validDays, explorer }: { agent: string; name: string; owners: string[]; v: VerifiedOwner | null; checks: { name: string; what: string; passesAt: string }[]; validDays: number; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const isOwner = !!address && owners.includes(address);

  const go = () => run(async (on) => {
    const w = wallet();
    if (!w || !address) throw new Refusal("Connect the owner's wallet first.");
    if (!owners.includes(address)) throw new Refusal("This wallet does not run this agent. Connect the agent's own wallet, or the wallet that made it here.");
    on("signing");
    const at = await engineNow();
    on("saving");
    const a = await signVerify(w, { agent, owner: address, at });
    const passed = a.checks.filter((c) => c.outcome === "pass").map((c) => c.name);
    return { note: a.verified ? `Verified. ${passedWords(passed)}. ${name} shows "Verified owner" from now on.` : `Checked: neither check passed for this wallet${a.checks.some((c) => c.outcome === "error") ? ", and one did not answer" : ""}. Nothing is shown on ${name}'s page. You can try again once your Passport or builder record is set up.` };
  });

  // nothing negative is said of an agent: while it is not verified, only its owner sees this, and anybody else one
  // plain line on how an owner starts
  if (!v && !isOwner) return address ? null : <p className="small verify-hint" id="verified">Do you run {name}? Connect its wallet to verify the owner.</p>;
  return (
    <div className="verify" id="verified">
      <span className="label gilt">Owner</span>
      {v ? (
        <>
          <div className="verify-head"><VerifiedMark sources={v.sources} checkedAt={v.checkedAt} /></div>
          <dl className="kv" style={{ marginTop: 16 }}>
            {v.sources.map((s) => <Fragment key={s}><dt>{s}<small>{CHECK_WORD[s] ?? "passed"}</small></dt><dd>passed{v.bands[s] ? <small className="band">score {v.bands[s]}</small> : null}</dd></Fragment>)}
            <dt>Checked<small>{`again by Factor before it runs out`}</small></dt><dd>{day(v.checkedAt)}</dd>
            <dt>Runs out</dt><dd>{day(v.expiresAt)}</dd>
            <dt>The wallet checked<small>the one that runs this agent</small></dt><dd className="mono"><a href={`${explorer}/address/${v.owner}`} target="_blank" rel="noopener noreferrer">{v.owner.slice(0, 6)}…{v.owner.slice(-4)}</a></dd>
          </dl>
        </>
      ) : (
        <p className="small" style={{ marginTop: 12 }}>You run {name}. Verify its owner with one signature, which costs nothing: Factor asks {checks.map((c) => `${c.name} (${c.what}, ${c.passesAt})`).join(" and ")} about this wallet. One passing is enough. Customers then see &quot;Verified owner&quot; beside {name} everywhere, and it can take jobs posted for verified owners only.</p>
      )}
      {isOwner ? (
        <>
          <div className="cta" style={{ marginTop: 18 }}><Go label={v ? "Check again" : "Verify the owner"} line={!!v} busy={busy} onGo={() => void go()} /></div>
          <StatusLine status={status} explorer={explorer} />
          <SignedInAs busy={busy} />
        </>
      ) : null}
      <p className="small" style={{ marginTop: 16 }}>Only the outcome is kept: verified or not, which check passed, a band of the score and the date. It stands for {validDays} days and moves no money: the score, the limit and the contract are the same either way.</p>
    </div>
  );
}
