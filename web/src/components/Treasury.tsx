// The agent treasury on an agent's page: what the treasury holds, the floor and the five uses in the order a run does
// them, the latest runs with every step as a receipt, and what the next run would do. The doing is TreasuryActions (the
// visitor's wallet). The receipts also show on the agent's credit report (TreasuryReceipts).
import { Reveal } from "./Motion";
import { SecHead } from "./Bits";
import { TreasuryActions } from "./TreasuryActions";
import { dayTime, eth, short, txHref } from "@/lib/format";
import { ethOf, nextWords, usesOf } from "@/lib/treasury";
import { weiEth } from "@/lib/claims";
import type { TreasuryAbout, TreasuryReceipt, TreasuryRun, TreasuryView } from "@/lib/types";

const KIND: Record<TreasuryReceipt["kind"], string> = { repay: "Line", compute: "Compute", claim: "Locked pay", guarantee: "Guarantee", vouch: "Vouching" };

/** The uses, in the order a run does them. */
function Uses({ t }: { t: TreasuryView }) {
  return (
    <ol className="tr-uses">
      {usesOf(t.rules).map((u) => (
        <li key={u.n} className={u.on ? "on" : ""}>
          <span className="tr-n">{u.n}</span>
          <span className="tr-name">{u.name}</span>
          <span className="tr-how">{u.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** One run: when, how much, and each step it took. */
function Run({ r, explorer }: { r: TreasuryRun; explorer: string }) {
  return (
    <div className="vouch-row">
      <div className="vouch-head">
        <span className="vouch-who">{dayTime(r.at)} <span className="vouch-what">{r.steps.length === 1 ? "one step" : `${r.steps.length} steps`}</span></span>
        <a className="tag go" href={txHref(explorer, r.tx)} target="_blank" rel="noopener noreferrer">{eth(r.spentEth)}</a>
      </div>
      <ul className="tr-steps">
        {r.steps.map((s, i) => <li key={i}><span className="tag">{KIND[s.kind]}</span><span>{s.text}</span></li>)}
      </ul>
      {r.skipped ? <p className="small" style={{ marginTop: 8 }}>{r.skipped === 1 ? "One step was refused at its door and skipped: its ETH stayed in the treasury." : `${r.skipped} steps were refused at their doors and skipped: their ETH stayed in the treasury.`}</p> : null}
    </div>
  );
}

/** An agent's page: its treasury. `mayOpen`: an agent that never used it is shown the way in (not for agents whose keys Factor holds). */
export default function AgentTreasuryCard({ t, about, name, address, explorer, mayOpen }: { t: TreasuryView | null; about: TreasuryAbout; name: string; address: string; explorer: string; mayOpen: boolean }) {
  const used = !!t && (weiEth(t.balance) > 0 || !!t.rules || t.runs.length > 0 || !!t.totals?.runs);
  if (!used && !mayOpen) return null;
  if (!t || !used) {
    return (
      <section className="wrap sec" id="treasury" style={{ scrollMarginTop: 96 }}>
        <Reveal><SecHead n="" kicker="Treasury" title={<>No treasury <em>yet</em>.</>} lead={`With a treasury, ETH ${name} is not using would work by itself, inside rules ${name} sets once.`} more="How the treasury works" href="/docs#treasury" /></Reveal>
        <Reveal delay={120}><div className="sec-body cols two">
          <div className="prose" style={{ paddingTop: 0 }}>
            <ul className="coin-fixed">
              <li>The agent puts ETH in and sets a floor. A run never spends below it.</li>
              <li>For each of five uses it says whether it is on and how far it goes. A run does them in one fixed order: its own credit line first, then compute, locked pay, its guarantee bond and its vouching bond.</li>
              <li>Anyone can run a treasury, and a run does only what the rules allow. Every step is a receipt on the chain.</li>
              <li>Only the agent can take ETH out, at any time. Nobody else holds it.</li>
            </ul>
          </div>
          <div><TreasuryActions agent={address} name={name} t={null} about={about} explorer={explorer} /></div>
        </div></Reveal>
      </section>
    );
  }
  const floor = t.rules ? weiEth(t.rules.floor) : 0;
  const next = nextWords(t.next);
  const anyOn = !!t.rules && usesOf(t.rules).some((u) => u.on);
  return (
    <section className="wrap sec" id="treasury" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Treasury" title={t.runs.length ? <>Idle earnings, <em>at work</em>.</> : <>A treasury, <em>ready</em>.</>} lead={`ETH ${name} keeps in its treasury works by itself, inside rules ${name} set. Only ${name} can take it out, at any time.`} more="How the treasury works" href="/docs#treasury" /></Reveal>
      <Reveal delay={120}><div className="sec-body cols two">
        <div>
          <dl className="kv fit">
            <dt>Holds</dt><dd className="sum">{eth(t.balanceEth)}</dd>
            <dt>Floor<small>a run never spends below it</small></dt><dd>{floor > 0 ? eth(floor) : "none"}</dd>
            <dt>Above the floor<small>what a run may spend</small></dt><dd>{eth(weiEth(t.spendable))}</dd>
            {t.totals?.runs ? <><dt>Runs so far</dt><dd>{t.totals.runs}</dd></> : null}
          </dl>
          <span className="label" style={{ display: "block", marginTop: 30 }}>Its rules, in the order of a run</span>
          <Uses t={t} />
          {!t.rules ? <p className="small" style={{ marginTop: 14 }}>No rules set yet: a run does nothing until {name} sets them.</p> : !anyOn ? <p className="small" style={{ marginTop: 14 }}>Every use is off: the ETH waits here.</p> : null}
        </div>
        <div>
          <span className="label">Next run</span>
          <p className="small" style={{ marginTop: 14 }}>{next ? <>A run now would {next}: {ethOf(t.next!.total)} ETH in all.</> : "A run now would do nothing: nothing is due, or nothing is above the floor."}</p>
          <span className="label" style={{ display: "block", marginTop: 30 }}>Recent runs</span>
          {t.runs.length ? <div className="vouch-list" style={{ marginTop: 14 }}>{t.runs.slice(0, 4).map((r) => <Run key={r.tx} r={r} explorer={explorer} />)}</div>
            : <p className="small" style={{ marginTop: 14 }}>No run yet. The first comes once a use is on and there is ETH above the floor.</p>}
          <TreasuryActions agent={address} name={name} t={t} about={about} explorer={explorer} />
        </div>
      </div></Reveal>
    </section>
  );
}

/** A credit report's part: what the agent's treasury did, each step a receipt. It changes no point of the score. */
export function TreasuryReceipts({ x, explorer }: { x: { agent: string; balance: string; runs: number; receipts: TreasuryReceipt[] }; explorer: string }) {
  if (!x.receipts.length) return null;
  return (
    <div id="treasury-receipts" style={{ scrollMarginTop: 96 }}>
      <span className="label">Treasury receipts</span>
      <p className="small" style={{ marginTop: 10 }}>What the treasury of {short(x.agent)} did by its own rules, {x.runs === 1 ? "in one run" : `in ${x.runs} runs`}. Shown as it happened; it changes no point of the score.</p>
      <ul className="tr-steps" style={{ marginTop: 14 }}>
        {x.receipts.slice(0, 10).map((s, i) => (
          <li key={i}><span className="tag">{KIND[s.kind]}</span><span>{s.text} <a className="more quiet" href={txHref(explorer, s.tx)} target="_blank" rel="noopener noreferrer">{dayTime(s.at)}</a></span></li>
        ))}
      </ul>
    </div>
  );
}
