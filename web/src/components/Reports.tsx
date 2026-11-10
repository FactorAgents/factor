// Factor Credit Reports, the blocks the two pages are made of: a row of the leaderboard, the spread of scores, a report's
// parts and points by source, its flags, its timeline and the entries others wrote of it on ERC-8004. Every figure and
// every word is the engine's (engine/src/reports.ts, engine/src/reportscore.ts): nothing is worked out here.
import Link from "next/link";
import { Fragment } from "react";
import type { Report, ReportRow, ReportsAbout } from "@/lib/reports";
import { reportHref, SOURCE_SHORT, type ReportSource } from "@/lib/reports";
import { day, int, short } from "@/lib/format";
import { Seal } from "./Bits";

/** An agent's seal: its initials, or a plain mark for an agent known only by its number or wallet. */
export function AgentSeal({ name, size }: { name: string; size?: number }) {
  if (/^(Agent #|0x)/.test(name)) return <div className="seal plain" style={size ? { width: size, height: size, fontSize: size * 0.4 } : undefined} aria-hidden="true">#</div>;
  return <Seal name={name} size={size} />;
}

/** A mark for how a flag weighs: said in words beside it, never by colour alone. */
const TONE: Record<"info" | "warn" | "bad", string> = { info: "Noted", warn: "Discounted", bad: "Pulls it down" };

/** One agent on the leaderboard: its place, its name and number, where its points came from, and its score. */
export function BoardRow({ r }: { r: ReportRow }) {
  return (
    <Link className="rrow" href={reportHref(r)}>
      <span className="rank num">{r.rank ?? "·"}</span>
      <AgentSeal name={r.name} />
      <div className="who">
        <div className="name">{r.name}{r.factorOwn ? <span className="house" title="Run by Factor itself: scored the same way, and ranked apart">Factor&apos;s own</span> : null}</div>
        <div className="does">{r.agentId ? <span className="mono">#{r.agentId}</span> : <span className="mono">{short(r.subject)}</span>}{r.sources.filter((s) => s !== "erc8004-identity").slice(0, 3).map((s) => <span className="rsrc" key={s}>{SOURCE_SHORT[s as ReportSource] ?? s}</span>)}</div>
      </div>
      <div className="col"><div className="v num">{r.parts.work ?? 0}</div></div>
      <div className="col"><div className="v num">{r.parts.repayment ?? 0}</div></div>
      <div className="sc"><b className="num">{r.score}</b><div className="score"><i style={{ ["--w" as string]: `${r.score / 10}%` }} /></div></div>
    </Link>
  );
}

/** How the scores fall: how many agents in each band, the agents with no record apart. */
export function Spread({ a }: { a: ReportsAbout }) {
  const bands = (a.spread ?? []).filter((b) => b.from > 0);
  const zero = a.spread?.find((b) => b.from === 0)?.n ?? 0;
  const most = Math.max(1, ...bands.map((b) => b.n));
  return (
    <div className="rspread">
      <div className="bars-v" role="img" aria-label={bands.map((b) => `${b.from} to ${b.to}: ${b.n} agents`).join(", ")}>
        {bands.map((b) => (
          <div className="col" key={b.from}>
            <span className="n num">{int(b.n)}</span>
            <div className="bar"><i style={{ height: `${b.n ? Math.max(3, (Math.sqrt(b.n) / Math.sqrt(most)) * 100) : 0}%` }} /></div>
            <span className="label">{b.from} to {b.to}</span>
          </div>
        ))}
      </div>
      <p className="small" style={{ marginTop: 16 }}>Agents by score, on a square-root scale so the few at the top still show. {int(zero)} more {zero === 1 ? "has" : "have"} nothing on the record yet and score 0: an identity alone is not a record.</p>
      <span className="label" style={{ display: "block", marginTop: 30 }}>Where the scores came from</span>
      <dl className="kv" style={{ marginTop: 14 }}>
        {(a.bySource ?? []).filter((x) => x.agents > 0 && x.source !== "erc8004-identity").map((x) => <Fragment key={x.source}><dt>{x.name}</dt><dd>{int(x.agents)} agent{x.agents === 1 ? "" : "s"}</dd></Fragment>)}
      </dl>
    </div>
  );
}

/** The five parts: points of the most each can give, and why. */
export function PartBars({ r }: { r: Report }) {
  return (
    <div className="bars fs-parts">
      {r.parts.map((p) => (
        <div className="b" key={p.key}>
          <span>{p.name}</span><span>{p.points} of {p.max}</span>
          <div className="score"><i style={{ ["--w" as string]: `${(p.points / p.max) * 100}%` }} /></div>
          <small className="why">{p.why}</small>
        </div>
      ))}
      {r.pulls.map((p) => (
        <div className="b pull" key={p.key}>
          <span>Taken off</span><span className="bad">{p.points}</span>
          <small className="why">{p.why}</small>
        </div>
      ))}
    </div>
  );
}

/** Where its points came from, source by source. */
export function SourcePoints({ r }: { r: Report }) {
  if (!r.sources.length) return <p className="note" style={{ marginTop: 16 }}>No source has brought it a point yet.</p>;
  const most = Math.max(1, ...r.sources.map((s) => s.points));
  return (
    <div className="bars" style={{ marginTop: 18 }}>
      {r.sources.map((s) => (
        <div className="b" key={s.source}>
          <span>{s.name}</span><span>{s.points}</span>
          <div className="score"><i style={{ ["--w" as string]: `${(s.points / most) * 100}%` }} /></div>
        </div>
      ))}
      {r.pulls.length ? <small className="why">Before the {-r.pulls.reduce((a, p) => a + p.points, 0)} points taken off.</small> : null}
    </div>
  );
}

/** Its flags, each in plain words with what it does to the score. */
export function Flags({ r }: { r: Report }) {
  if (!r.flags.length) return <p className="note">No rule of {r.version} raised a flag on this record.</p>;
  return (
    <div className="rflags">
      {r.flags.map((f) => (
        <div className={`rflag ${f.tone}`} key={f.key}>
          <div className="rft"><span className={`tag${f.tone === "bad" ? " bad" : f.tone === "warn" ? " warn" : ""}`}>{TONE[f.tone]}</span><b>{f.title}</b></div>
          <div><p className="small">{f.words}</p><p className="small effect"><b>Effect:</b> {f.effect}</p></div>
        </div>
      ))}
    </div>
  );
}

/** What happened, newest first, and whether each counts. */
export function Timeline({ r }: { r: Report }) {
  if (!r.timeline.length) return <p className="note">Nothing on the chain yet beyond its identity.</p>;
  return (
    <div className="rows rtime">
      <div className="head"><span>Day</span><span>Source</span><span>What happened</span><span>Counts</span></div>
      {r.timeline.map((t, i) => (
        <div className="row" key={i}>
          <span className="time">{day(t.at)}</span>
          <span className="kind">{SOURCE_SHORT[t.source] ?? t.source}</span>
          <span className="what">{t.text}{t.why ? <small className="why">{t.why}</small> : null}</span>
          <span className={`amt${t.counted ? "" : " dim"}`}>{t.counted ? "counted" : "not counted"}</span>
        </div>
      ))}
      <div className="end" />
    </div>
  );
}

/** What others wrote of it on ERC-8004, and why each counts or not. */
export function Erc8004Entries({ r, explorer }: { r: Report; explorer: string }) {
  if (!r.erc8004.length) return null;
  return (
    <table className="table stack" style={{ marginTop: 14 }}>
      <thead><tr><th>From</th><th>Tag</th><th className="r">Value</th><th>Counts</th></tr></thead>
      <tbody>
        {r.erc8004.map((e, i) => (
          <tr key={i}>
            <td className="m" data-l="From"><a className="mono" href={`${explorer}/address/${e.client}`} target="_blank" rel="noopener noreferrer">{short(e.client)}</a><small className="why">{day(e.at)}</small></td>
            <td className="m" data-l="Tag">{e.tag1 || "none"}{e.tag2 ? ` · ${e.tag2}` : ""}</td>
            <td className="m r" data-l="Value">{e.value}</td>
            <td className="wide" data-l="Counts">{e.counted ? <b>Counted</b> : "Not counted"}<small className="why">{e.why}</small></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
