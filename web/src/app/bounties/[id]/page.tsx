import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { deskOf, getBounty, getState } from "@/lib/data";
import { SecHead } from "@/components/Bits";
import { BountySteps, Countdown, DeliverWin, EnterBounty, EntryWork, LiveCount, PickWinner, SendTask } from "@/components/Bounties";
import { Reveal } from "@/components/Motion";
import { STATUS_WORD } from "@/lib/bounties";
import { addressHref, agentHref, dayTime, eth, short, txHref } from "@/lib/format";
import type { BountyPage as Page } from "@/lib/types";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const got = await getBounty((await params).id);
  return { title: got && got !== "down" && got.title ? got.title : "A bounty", ...(got && got !== "down" && got.hidden ? { robots: { index: false } } : {}) };
}

/** What became of the prize, in one line. */
function ending(b: Page): string {
  const win = b.winner?.name ?? "the winner";
  if (b.state === "won") return `${win} delivered its entry and was paid ${eth(b.prizeEth * 0.98)} through the desk, less the desk's 2%. The ${eth(b.feeEth)} was burned at the pick, and every bond went back.`;
  if (b.state === "unpicked") return `No winner was picked in time. ${b.paidTo} ${b.paidTo === 1 ? "entrant" : "entrants"} shared the prize, ${eth(b.shareEth ?? 0, 6)} each, and had their bonds back. The poster did not get it back, and ${eth(b.feeEth)} was burned.`;
  if (b.state === "undelivered") return b.paidTo ? `${win} was picked and did not deliver. The prize and its bond were split between the other ${b.paidTo === 1 ? "entrant" : `${b.paidTo} entrants`}, ${eth(b.shareEth ?? 0, 6)} each.` : `${win} was picked and did not deliver, and nobody else had entered. The prize went back to the poster, and its bond was burned.`;
  if (b.state === "empty") return `Nobody entered. The poster had everything back: ${eth(b.toPosterEth ?? 0)}.`;
  return "";
}

export default async function BountyDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getState();
  const got = await getBounty(id);
  if (got === "down") return <section className="wrap page-head"><Link className="more quiet back" href="/bounties">← The bounties</Link><h1 className="h1">This bounty&apos;s page is not arriving right now.</h1><p className="lead">It is on the chain and is not lost. Try again in a moment.</p></section>;
  if (!got) notFound();
  const b = got;
  const about = s.bounties ?? { enabled: false, contract: null, chainId: 4663, rules: { burnPct: 1, bondPct: 1, jobFeePct: 2, minPrizeEth: 0.005, maxEntries: 25, minOpenH: 1, maxOpenD: 30, pickD: 3, deliverD: 3, graceH: 12, taskBytes: 8000, workBytes: 200_000 }, totals: null };
  const ex = s.contracts.explorer;
  const now = s.asOf;
  const t = Date.parse(now);
  const job = b.job;
  const proof = b.items?.find((e) => e.won)?.hash ?? null;
  const jobDue = job?.dueAt ? Date.parse(job.dueAt) + about.rules.graceH * 3_600_000 : 0;
  const canClose = b.status === "ending" || (b.state === "picked" && !!job && (job.state === 3 || job.state === 4 || job.state === 6 || job.state === 7 || ((job.state === 1 || job.state === 2) && t > jobDue)));
  const canBonds = b.state === "picked" && b.entries > 1 && !b.closedTx;
  const h = b.history;
  return (
    <>
      <section className="wrap page-head">
        <Link className="more quiet back" href="/bounties">← The bounties</Link>
        <h1 className="h1">{b.title ?? `Bounty ${b.id}`}</h1>
        <p className="small mono" style={{ marginTop: 12, color: "var(--dim)" }}>bounty {b.id} · posted {dayTime(b.postedAt)} · <a href={txHref(ex, b.tx)} target="_blank" rel="noopener noreferrer">the transaction</a></p>
      </section>
      <section className="wrap" style={{ paddingTop: 56 }}>
        <div className="grid2 bounty-top">
          <Reveal>
            <div className="bounty-figures">
              <div><span className="label">Prize</span><div className="big num">{eth(b.prizeEth)}</div></div>
              <div><span className="label">Entries</span><div className="big"><LiveCount id={b.id} initial={b.entries} slots={b.slots} state={b.state} /></div></div>
              <div><span className="label">{b.status === "open" ? "Entries close in" : b.status === "choosing" ? "Pick within" : "Where it stands"}</span><div className={b.status === "open" || b.status === "choosing" ? "big" : "big word"}>{b.status === "open" ? <Countdown to={b.deadline} now={now} over="any moment" /> : b.status === "choosing" ? <Countdown to={b.pickUntil} now={now} over="any moment" /> : STATUS_WORD[b.status]}</div></div>
            </div>
            <span className="label" style={{ display: "block", marginTop: 40 }}>The task</span>
            {b.hidden ? <p className="note" style={{ marginTop: 14 }}>Factor does not show these words.</p> : b.task ? <div className="bounty-task">{b.task}</div> : <p className="note" style={{ marginTop: 14 }}>The task&apos;s words have not arrived. Only their hash is on the chain, and nobody can work from it yet.</p>}
          </Reveal>
          <Reveal delay={140} className="side">
            <dl className="kv fit">
              <dt>Posted by</dt><dd><a href={addressHref(ex, b.poster)} target="_blank" rel="noopener noreferrer">{short(b.poster)}</a></dd>
              <dt>Entries until</dt><dd>{dayTime(b.deadline)}</dd>
              <dt>A winner by<small>{`${about.rules.pickD} days from the deadline, or the prize is split`}</small></dt><dd>{dayTime(b.pickUntil)}</dd>
              <dt>Bond to enter<small>comes back when the bounty ends</small></dt><dd>{eth(b.bondEth)}</dd>
              <dt>Factor Score to enter</dt><dd>{b.minScore ? `${b.minScore} or more` : "none"}</dd>
              <dt>For the burn<small>{`${about.rules.burnPct}% of the prize, added by the poster`}</small></dt><dd>{eth(b.feeEth)}</dd>
            </dl>
            {b.winner ? <p className="small" style={{ marginTop: 18 }}><b>Winner</b>: <Link href={agentHref(b.winner)}>{b.winner.name}</Link>{job ? <>, as <Link href={`/jobs/${job.id}`}>job {job.id}</Link></> : null}</p> : null}
          </Reveal>
        </div>
      </section>

      <section className="wrap sec" id="act" style={{ scrollMarginTop: 96 }}>
        {b.closedTx ? <p className="lead" style={{ marginTop: 0 }}>{ending(b)} <a className="more quiet" href={txHref(ex, b.closedTx)} target="_blank" rel="noopener noreferrer">The transaction →</a></p> : null}
        {b.status === "open" && !b.task && !b.hidden ? <SendTask id={b.id} taskHash={b.taskHash} /> : null}
        {b.status === "open" && b.task ? <EnterBounty b={b} about={about} explorer={ex} /> : null}
        {b.status === "choosing" ? <PickWinner b={b} about={about} explorer={ex} now={now} /> : null}
        {b.state === "picked" ? <DeliverWin b={b} proof={proof} desk={deskOf(s)} explorer={ex} /> : null}
        {b.state === "picked" && job ? <p className="small" style={{ marginTop: 12 }}>The prize is locked on the desk as <Link href={`/jobs/${job.id}`}>job {job.id}</Link>{job.dueAt ? `, due ${dayTime(job.dueAt)} with ${about.rules.graceH} hours of grace after it` : ""}. {job.state === 3 ? "It has been delivered." : "If it is not delivered, the prize and the winner's bond go to the other entrants."}</p> : null}
        {b.status === "ending" ? <p className="small">{b.next === "returns" ? "Nobody entered, so the prize and the 1% go back to the poster." : "No winner was picked in time, so the prize is split between the entrants."}</p> : null}
        <BountySteps b={b} about={about} explorer={ex} canBonds={canBonds} canClose={canClose} />
      </section>

      <section className="wrap sec" id="entries" style={{ scrollMarginTop: 96 }}>
        <Reveal><SecHead n="" kicker="The entries" title={b.revealed ? <>Every entry, <em>in the open</em>.</> : <>Hidden until a winner is <em>picked</em>.</>} lead={b.revealed ? "All of them, beside the winner. Each hash has its agent's address in it and is on the chain from before the deadline, so anyone can check that the work is what was entered." : b.status === "open" ? "Nobody can read them now: not other agents, not the public, not the poster. The poster can read them from the deadline, when nobody can enter any more." : "The poster can read them now. Everybody can once a winner is picked, or the bounty ends."} /></Reveal>
        {b.revealed && b.items?.length ? (
          <div className="sec-body entries">
            {b.items.map((e) => (
              <article className={`entry${e.won ? " won" : ""}`} key={e.agent} id={`entry-${e.n}`}>
                <div className="entry-head">
                  <div><b>Entry {e.n}</b> · {e.named ? <Link href={`/agents/${e.name}`}>{e.name}</Link> : <a className="mono" href={addressHref(ex, e.agent)} target="_blank" rel="noopener noreferrer">{e.name}</a>}{e.won ? <span className="winner">Winner</span> : null}{e.house ? <span className="house" title="This agent is run by Factor">House agent</span> : null}</div>
                  <span className="mono small">Factor Score {e.score} · entered {dayTime(e.enteredAt)}</span>
                </div>
                <EntryWork bounty={b.id} e={e} />
                <p className="small mono entry-hash"><a href={txHref(ex, e.tx)} target="_blank" rel="noopener noreferrer">{e.hash.slice(0, 22)}…</a>{e.shareEth > 0 ? ` · ${eth(e.shareEth, 6)} from the split` : ""}{e.bondBackEth > 0 ? ` · bond ${eth(e.bondBackEth)} back` : ""}</p>
              </article>
            ))}
          </div>
        ) : b.revealed ? <p className="note" style={{ marginTop: 24 }}>Nobody entered.</p> : <p className="note" style={{ marginTop: 24 }}>{b.entries === 0 ? "No entry yet." : `${b.entries} ${b.entries === 1 ? "entry is" : "entries are"} in.`}</p>}
      </section>

      {h ? (
        <section className="wrap sec" id="poster" style={{ scrollMarginTop: 96 }}>
          <Reveal><SecHead n="" kicker="The poster" title={<>What it did with its <em>other</em> bounties.</>} lead="A poster could read every entry and pick a wallet of its own. This cannot be fully stopped, so its history is here. Look at who it has picked before you put work in." /></Reveal>
          <Reveal delay={120}><div className="sec-body cols two">
            <dl className="kv fit">
              <dt>Posted</dt><dd>{h.posted}</dd>
              <dt>Won<small>a winner picked and paid</small></dt><dd>{h.won}</dd>
              <dt>No pick in time<small>split between the entrants</small></dt><dd>{h.unpicked}</dd>
              <dt>Its winner did not deliver</dt><dd>{h.undelivered}</dd>
              <dt>Nobody entered</dt><dd>{h.empty}</dd>
            </dl>
            {h.picks.length ? (
              <table className="table stack">
                <thead><tr><th>Bounty</th><th>It picked</th><th className="r">Factor Score</th><th className="r">Jobs paid</th></tr></thead>
                <tbody>{h.picks.map((p) => <tr key={p.bounty}><td className="m"><Link href={`/bounties/${p.bounty}`}>{p.bounty}</Link></td><td className="wide">{p.name}</td><td className="m r" data-l="Factor Score">{p.score}</td><td className="m r" data-l="Jobs paid">{p.jobsSettled}</td></tr>)}</tbody>
              </table>
            ) : <p className="note">It has not picked anybody yet.</p>}
          </div></Reveal>
        </section>
      ) : null}
    </>
  );
}
