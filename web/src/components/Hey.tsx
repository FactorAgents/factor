"use client";
// HEY builder records on an agent's page (docs/HEY.md): the project its owner linked it to on HEY Research Lab, with
// HEY's own facts about that project's team and the link to them; and, for the wallet that runs the agent, one signature
// to link it, change it or unlink it. Every fact is HEY's, read by Factor's engine (engine/src/hey.ts). Nothing here is
// a score, nothing ranks an agent, and nothing negative is said: HEY's record is shown as HEY keeps it, or not at all.
import { useState } from "react";
import { Refusal } from "@/lib/desk";
import { heyDay, projectOf, signHeyLink } from "@/lib/hey";
import type { HeyAgent, HeyRecord } from "@/lib/types";
import { Reveal } from "./Motion";
import { SecHead } from "./Bits";
import { engineNow, Go, SignedInAs, StatusLine, useSend, useWallet } from "./Wallet";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The mark beside an agent's name when its owner linked it to a project HEY marks a Verified Builder. */
export function HeyMark({ href = "#builder" }: { href?: string }) {
  return <a className="house hey-mark" href={href} title="Its owner linked it to its maker's project on HEY Research Lab, which HEY marks a Verified Builder: this team ships">Builder record on HEY</a>;
}

/** HEY's facts about one project, as HEY gives them, with the source. */
function Facts({ r }: { r: Extract<HeyRecord, { found: true }> }) {
  const f = r.facts;
  const ship = f.latest_meaningful_ship;
  return (
    <>
      <dl className="kv hey-kv" style={{ marginTop: 16 }}>
        <dt>Project on HEY<small>{r.project.symbol ? `$${r.project.symbol}` : "as HEY names it"}</small></dt>
        <dd><a href={r.sourceUrl} target="_blank" rel="noopener noreferrer">{r.project.name}</a></dd>
        {f.verified_builder ? <><dt>Verified Builder<small>HEY&apos;s mark: this team ships</small></dt><dd className="hey-yes"><Tick />on HEY</dd></> : null}
        {f.hey_status_label || f.hey_status ? <><dt>HEY&apos;s status<small>{f.hey_status_help ?? "as HEY says it"}</small></dt><dd>{f.hey_status_label ?? f.hey_status}</dd></> : null}
        {f.meaningful_ships_30d !== null ? <><dt>Meaningful ships in 30 days<small>as HEY counts them</small></dt><dd className="num">{f.meaningful_ships_30d}</dd></> : null}
        {ship?.title ? <><dt>Latest ship HEY recorded<small>{heyDay(ship.timestamp)}</small></dt><dd className="hey-ship">{ship.evidence_link ? <a href={ship.evidence_link} target="_blank" rel="noopener noreferrer">{ship.title}</a> : ship.title}</dd></> : null}
        {f.repo_url ? <><dt>Its code<small>as HEY has it</small></dt><dd><a href={f.repo_url} target="_blank" rel="noopener noreferrer">{f.repo_url.replace(/^https:\/\/(www\.)?/, "")}</a></dd></> : null}
      </dl>
      <p className="small" style={{ marginTop: 16 }}>Read from HEY {heyDay(r.readAt)}{r.stale ? ", an earlier reading: HEY could not be reached just now" : ""}. {r.disclaimer ? `HEY: "${r.disclaimer}"` : "HEY's record says what a team shipped and how HEY knows it."} <a className="more quiet" href={r.sourceUrl} target="_blank" rel="noopener noreferrer">The record on HEY →</a></p>
    </>
  );
}

/**
 * The section on an agent's page. Shown when its owner linked it to a project on HEY, for everybody; and to the wallet
 * that runs it, the form to link one. Anybody else sees nothing while there is no link.
 */
export function HeyBuilder({ agent, name, st, explorer }: { agent: string; name: string; st: HeyAgent; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [typed, setTyped] = useState("");
  const isOwner = !!address && st.owners.includes(address);
  const link = st.link, r = st.record;

  const go = (project: string | null) => run(async (on) => {
    const w = wallet();
    if (!w || !address) throw new Refusal("Connect the owner's wallet first.");
    if (!st.owners.includes(address)) throw new Refusal("This wallet does not run this agent. Connect the agent's own wallet, or the wallet that made it here.");
    if (!project) throw new Refusal("Name the project by its page on heyresearch.xyz, its slug there, or a contract on Robinhood Chain that HEY ties to it.");
    on("signing");
    const at = await engineNow();
    on("saving");
    const a = await signHeyLink(w, { agent, by: address, project, at });
    return { note: a.link ? `Linked to ${a.link.name ?? a.link.slug} on HEY. It shows on ${name}'s page now.` : `Unlinked. ${name}'s page shows no builder record now.` };
  });

  if (!link && !isOwner) return null;
  const verified = !!(r && r.found && r.facts.verified_builder);
  return (
    <section className="wrap sec" id="builder" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Builder record on HEY" title={verified ? <>The team behind it <em>ships</em>.</> : link ? <>Its maker&apos;s project on <em>HEY</em>.</> : <>Link its maker&apos;s project on <em>HEY</em>.</>} lead="HEY Research Lab is the public record of building on Robinhood Chain: what each team shipped, with its source. These are HEY's own facts, shown as HEY keeps them. They are not a rating of this agent, and they never change its Factor Score." /></Reveal>
      <Reveal delay={120}><div className="sec-body cols two">
        <div>
          <span className="label gilt">HEY&apos;s record</span>
          {r && r.found ? <Facts r={r} />
            : r && !r.found ? <p className="note" style={{ marginTop: 14 }}>{r.away ? "HEY could not be reached just now. The record shows again by itself." : `HEY has no record of it now: ${r.why}.`}</p>
            : <p className="note" style={{ marginTop: 14 }}>No project is linked yet. Link the project its maker builds on HEY, and HEY&apos;s record of that team shows here for every visitor, with the link to it.</p>}
        </div>
        <div>
          <span className="label">The link</span>
          {link ? (
            <dl className="kv" style={{ marginTop: 16 }}>
              <dt>Linked by<small>the wallet that runs {name}</small></dt><dd className="mono"><a href={`${explorer}/address/${link.by}`} target="_blank" rel="noopener noreferrer">{short(link.by)}</a></dd>
              <dt>On<small>its owner&apos;s word that this is its maker&apos;s project</small></dt><dd>{heyDay(link.at)}</dd>
              {link.contract ? <><dt>Named by<small>a contract HEY ties to the project</small></dt><dd className="mono"><a href={`${explorer}/address/${link.contract}`} target="_blank" rel="noopener noreferrer">{short(link.contract)}</a></dd></> : null}
            </dl>
          ) : <p className="small" style={{ marginTop: 16 }}>You run {name}. Name its maker&apos;s project on HEY: its page on heyresearch.xyz, its slug there, or a contract on Robinhood Chain that HEY ties to it. One signature, which costs nothing.</p>}
          {isOwner ? (
            <>
              <label className="field" style={{ marginTop: 22 }}><span className="label">{link ? "Change the project" : "The project on HEY"}</span><input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="heyresearch.xyz/project/… or 0x…" disabled={busy} autoCapitalize="none" spellCheck={false} autoComplete="off" maxLength={120} /></label>
              <div className="cta" style={{ marginTop: 14 }}>
                <Go label={link ? "Link this instead" : "Link it"} busy={busy} onGo={() => void go(projectOf(typed))} />
                {link ? <Go label="Unlink" line busy={busy} onGo={() => void go("none")} /> : null}
              </div>
              <StatusLine status={status} explorer={explorer} />
              <SignedInAs busy={busy} />
            </>
          ) : null}
          <p className="small" style={{ marginTop: 16 }}>Only a project HEY has published can be linked. The link moves no money and changes nothing on the chain.</p>
        </div>
      </div></Reveal>
    </section>
  );
}

function Tick() {
  return <svg className="tick" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><circle cx="6" cy="6" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M3.6 6.2l1.6 1.6 3.2-3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
