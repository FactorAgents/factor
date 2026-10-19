// The roadmap: every phase on one line, stage by stage. What is live is checked off in gilt with its day; what is
// planned shows what it builds on, with no date. A last open stage says the line goes on. The words and the days are
// in lib/roadmap.ts.
import { Reveal } from "./Motion";
import { STAGES, type Phase } from "@/lib/roadmap";

const CHECK = "M3.5 8.4 6.6 11.4 12.6 4.8";
const two = (n: number) => String(n).padStart(2, "0");

export default function Roadmap() {
  const all = STAGES.flatMap((s) => s.phases);
  const live = all.filter((p) => p.live).length;
  const next = all.find((p) => !p.live);
  // every row on the line, in order, so each knows whether the line reaching it and leaving it is drawn in gilt
  type Row = { stage: number; phase?: Phase; n?: number };
  const rows: Row[] = [];
  let n = 0;
  STAGES.forEach((s, i) => { rows.push({ stage: i }); for (const p of s.phases) rows.push({ stage: i, phase: p, n: ++n }); });
  const done = (r: Row | undefined) => !!r && (r.phase ? !!r.phase.live : STAGES[r.stage].phases.every((p) => p.live));
  // the line never ends at the last phase: it runs on into the stage that is still being planned, and fades out there
  const line = (k: number) => `${k === 0 ? " first" : ""}${done(rows[k]) ? " up" : ""}${done(rows[k + 1]) ? " down" : ""}`;

  return (
    <div className="road">
      <div className="road-meter">
        <div className="road-count"><b className="num">{live}</b><span>of {all.length} phases live</span></div>
        <div className="road-ticks" aria-hidden="true">
          {STAGES.map((s, i) => <span key={i} style={{ flex: s.phases.length }}>{s.phases.map((p, j) => <i key={j} className={p.live ? "on" : p === next ? "next" : undefined} />)}</span>)}
        </div>
        {next ? <div className="road-next"><span className="label gilt">Next</span><span>{next.name}</span></div> : null}
      </div>

      {STAGES.map((s, i) => {
        const first = rows.findIndex((r) => r.stage === i);
        const days = s.phases.map((p) => p.live ?? "");
        const allLive = s.phases.every((p) => p.live);
        return (
          <Reveal key={s.name} delay={i ? 0 : 60}>
            <div className="road-stage" role="list" aria-label={`Stage ${i + 1}: ${s.name}`}>
              <div className={`road-row is-stage${line(first)}`} role="listitem">
                <div className="road-when"><span className="label gilt">Stage {i + 1}</span></div>
                <span className={`road-node stage${allLive ? " live" : ""}`} aria-hidden="true" />
                <div className="road-body">
                  <div><div className="road-stagename">{s.name}</div><p className="road-line">{s.line}</p></div>
                  <div className={`road-sum${allLive ? " live" : ""}`}>{allLive ? <><b>All live</b>{days[0]} to {days[days.length - 1]}</> : <><b>Planned</b>{s.phases.length} phases, each building on the last</>}</div>
                </div>
              </div>
              {s.phases.map((p, j) => {
                const k = first + 1 + j, num = rows[k].n!, isNext = p === next;
                const kind = p.live ? "live" : isNext ? "next" : "plan";
                return (
                  <div key={p.name} className={`road-row ${kind}${line(k)}`} style={{ ["--k" as string]: j }} role="listitem">
                    <div className="road-when">
                      <span className={`tag${p.live || isNext ? " go" : ""}`}>{p.live ? "Live" : isNext ? "Next" : "Planned"}</span>
                      {p.live ? <span className="road-day">{p.live}</span> : null}
                    </div>
                    <span className={`road-node ${kind}`} aria-hidden="true">{p.live ? <svg viewBox="0 0 16 16"><path d={CHECK} /></svg> : <i />}</span>
                    <div className="road-body">
                      <div className="road-name"><span className="idx">Phase {two(num)}</span><div className="h3">{p.name}</div></div>
                      <div className="road-text">
                        <p>{p.text}</p>
                        {p.builds ? <p className="road-builds"><b>Builds on</b><span>{p.builds}</span></p> : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Reveal>
        );
      })}
      <Reveal>
        <div className="road-stage" role="list" aria-label={`Stage ${STAGES.length + 1}: what comes next`}>
          <div className="road-row is-stage is-more" role="listitem">
            <div className="road-when"><span className="label gilt">Stage {STAGES.length + 1}</span><span className="tag">Coming</span></div>
            <span className="road-node open" aria-hidden="true"><svg viewBox="0 0 22 22"><path d="M11 2 20 11 11 20 2 11Z" pathLength={48} /></svg></span>
            <div className="road-body">
              <div><div className="road-stagename">What comes next</div><p className="road-line">The line keeps going.</p></div>
              <p className="road-more">The next stage is being planned. New phases are added here as we get close to finishing the ones above, and each one is checked off the day it goes live.</p>
            </div>
          </div>
        </div>
      </Reveal>
    </div>
  );
}
