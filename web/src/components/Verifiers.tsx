// The small blocks verifiers are drawn with: a maker's mark, the clock of a verified job, a verifier and a case as
// rows of a board, a verdict's word, and a verifier's reasons with the tests it ran. Every mark is drawn: no maker's
// logo and no character stands in for one.
import Link from "next/link";
import type { ReactNode } from "react";
import { dayTime, eth } from "@/lib/format";
import { CASE_TONE, CASE_WORD, NEXT_WORD, readReason } from "@/lib/verifiers";
import type { VerdictModel, Verifier, VerifierCase, VerifierMaker, VerifierRules, VerifierShort } from "@/lib/types";
import { Countdown } from "./Bounties";

type Paint = { fill: string; stroke: string };
// five shapes, each drawn three ways: one mark of its own for each of the fifteen makers the site names
const SHAPES: ((p: Paint) => ReactNode)[] = [
  (p) => <circle cx="12" cy="12" r="8.6" {...p} />,
  (p) => <rect x="4" y="4" width="16" height="16" rx="1.5" {...p} />,
  (p) => <path d="M12 3.4 20.6 19H3.4z" {...p} />,
  (p) => <path d="M12 2.6 21.4 12 12 21.4 2.6 12z" {...p} />,
  (p) => <path d="M12 3 19.8 7.5v9L12 21l-7.8-4.5v-9z" {...p} />,
];
/** A model maker's mark, by its number: a shape and a way of drawing it. A number the site does not name is a dashed ring. */
export function MakerMark({ id, size = 22, title }: { id: number; size?: number; title?: string }) {
  const known = id >= 1 && id <= 15;
  const shape = (id - 1) % 5, way = Math.floor((id - 1) / 5);
  return (
    <svg className={`mk${way === 1 ? " solid" : ""}`} width={size} height={size} viewBox="0 0 24 24" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {known ? SHAPES[shape]!(way === 1 ? { fill: "currentColor", stroke: "currentColor" } : { fill: "none", stroke: "currentColor" }) : <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeDasharray="2.4 2.2" />}
      {known && way === 2 ? <circle cx="12" cy={shape === 2 ? 14 : 12} r="2.6" fill="currentColor" stroke="none" /> : null}
    </svg>
  );
}

/** A verifier by its name, or its address shortened, with Factor's own marked. */
export function VerifierName({ v, link = true }: { v: VerifierShort; link?: boolean }) {
  const name = v.name ?? `${v.address.slice(0, 6)}…${v.address.slice(-4)}`;
  return (
    <span className="vname">
      {link ? <Link href={`/verifiers/${v.address}`}>{name}</Link> : <b>{name}</b>}
      {v.house ? <span className="house" title="One of Factor's own verifiers: an ordinary verifier with a bond of its own">Factor&apos;s own</span> : null}
    </span>
  );
}

/** A verdict in one word, toned: accept, reject, sealed or never revealed. */
export function Verdict({ v }: { v: "accept" | "reject" | "sealed" | "hidden" }) {
  return <span className={`tag${v === "accept" ? " go" : v === "reject" || v === "hidden" ? " bad" : ""}`}>{v === "accept" ? "Accept" : v === "reject" ? "Reject" : v === "sealed" ? "Sealed" : "Never revealed"}</span>;
}

const PASS = "M5 12.5l4.2 4.2L19 7";
const FAIL = "M6.5 6.5l11 11M17.5 6.5l-11 11";
/** A verifier's reasons: the tests it ran, each passed or failed, its words, and the model, when it wrote them that way. */
export function Reason({ text }: { text: string }) {
  const r = readReason(text);
  return (
    <div className="vreason">
      {r.tests.length ? (
        <ul className="vtests">
          {r.tests.map((t, i) => <li key={i} className={t.pass ? "pass" : "fail"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={t.pass ? PASS : FAIL} /></svg><span><b>{t.pass ? "Passed" : "Failed"}</b> {t.text}</span></li>)}
        </ul>
      ) : null}
      {r.text ? <p className="vwords">{r.text}</p> : null}
      {r.model ? <p className="vmodel mono">{r.model}</p> : null}
    </div>
  );
}

/**
 * The clock of every verified job, counted from the delivery: each window as a bar on the desk's 24 hours. Drawn from
 * the rules the engine reads from the contract.
 */
export function ClockChart({ r }: { r: VerifierRules }) {
  const H = r.reviewH;
  const rows: { name: string; when: string; from: number; to: number; soft?: boolean }[] = [
    { name: "The first check", when: `one verifier, by ${r.checkH} h`, from: 0, to: r.checkH },
    { name: "A dispute", when: `within ${r.disputeH} h of the verdict`, from: 0, to: r.checkH + r.disputeH, soft: true },
    { name: "Panel seats and strikes", when: `from the dispute until ${r.seatH} h`, from: 0, to: r.seatH, soft: true },
    { name: "Reveals", when: `${r.seatH} h to ${r.revealH} h`, from: r.seatH, to: r.revealH },
    { name: "The customer's own choice", when: `if nobody checked or revealed, until ${H} h`, from: r.checkH, to: H, soft: true },
  ];
  const ticks = [0, r.checkH, r.seatH, r.revealH, H];
  return (
    <div className="vclock" role="img" aria-label={`The clock of a verified job, from the delivery: the first check by ${r.checkH} hours, a dispute within ${r.disputeH} hours of the verdict, panel seats until ${r.seatH} hours, reveals until ${r.revealH} hours, and the desk's own end at ${H} hours.`}>
      {rows.map((x) => (
        <div className="vclock-row" key={x.name}>
          <div className="vclock-name"><b>{x.name}</b><small>{x.when}</small></div>
          <div className="vclock-track">
            <svg viewBox={`0 0 ${H * 10} 12`} preserveAspectRatio="none" aria-hidden="true">
              {ticks.map((t) => <line key={t} x1={t * 10} x2={t * 10} y1="0" y2="12" className="tick" vectorEffect="non-scaling-stroke" />)}
              <rect x={x.from * 10} y="2" width={(x.to - x.from) * 10} height="8" className={x.soft ? "bar soft" : "bar"} vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        </div>
      ))}
      <div className="vclock-row axis">
        <div className="vclock-name"><small>Hours from the delivery</small></div>
        <div className="vclock-track">{ticks.map((t) => <span key={t} style={{ left: `${(t / H) * 100}%` }}>{t === 0 ? "0 h" : t === H ? <>{t} h<em>, the desk&apos;s end</em></> : `${t} h`}</span>)}</div>
      </div>
    </div>
  );
}

/** One verifier on the board: its maker and standing, its record, what it earned and lost, its free bond. */
export function VerifierRow({ v }: { v: Verifier }) {
  return (
    <Link className="open-row vrow" href={`/verifiers/${v.address}`}>
      <div className="what">
        <div className="title"><span className="vmk"><MakerMark id={v.maker} size={20} /></span>{v.name ?? `${v.address.slice(0, 6)}…${v.address.slice(-4)}`}{v.house ? <span className="house">Factor&apos;s own</span> : null}</div>
        <div className="meta mono">{v.makerName} · {v.standing && v.since ? `standing since ${dayTime(v.since).replace(/, .*/, "")}` : "no standing: bond under the least"}</div>
        {v.receipts ? <div className={`meta mono vrc${v.receipts.checked ? " checked" : ""}`}>model receipts: {v.receipts.checked} checked · {v.receipts.declared} declared</div> : null}
      </div>
      <div className="col"><span className="label">Record</span><div className="v num">{v.right}<span className="of"> right</span></div><div className="meta mono">{v.wrong} wrong · {v.hidden} never revealed</div></div>
      <div className="col"><span className="label">Earned · lost</span><div className={`v num${v.earnedEth ? "" : " none"}`}>{v.earnedEth ? eth(v.earnedEth) : "nothing yet"}</div><div className={`meta mono${v.lostEth ? " lost" : ""}`}>{v.lostEth ? `${eth(v.lostEth)} lost` : "nothing lost"}</div></div>
      <div className="col who"><span className="label">Free bond</span><div className="v num">{eth(v.freeEth)}</div><div className="meta mono">{v.lockedEth ? `${eth(v.lockedEth)} staked on ${v.open} open` : "nothing staked now"}</div></div>
    </Link>
  );
}

/** Where a case stands, in a few words. */
export function caseNow(c: VerifierCase): string {
  if (c.ended) return CASE_WORD[c.ended.state];
  if (c.next) return NEXT_WORD[c.next];
  return c.deliveredAt ? CASE_WORD[c.state] : "The agent is working";
}

/** One verified job on the board: what it is, where it stands and until when, and its verdicts so far. */
export function CaseRow({ c, now }: { c: VerifierCase; now: string }) {
  const seated = c.seats?.length ?? 0;
  const tone = c.ended ? CASE_TONE[c.ended.state] : c.next === "step" ? "warn" : "";
  return (
    <Link className="open-row vcase-row" href={`/jobs/${c.job.id}#verifiers`}>
      <div className="what">
        <div className="title">{c.title ?? `Job ${c.job.id}`}</div>
        <div className="meta mono">job {c.job.id} · {c.agent.name} · {eth(c.priceEth)}, fee {eth(c.feeEth).replace(" ETH", "")}</div>
      </div>
      <div className="col"><span className="label">Where it stands</span><div className={`v small-v${tone ? ` ${tone}` : ""}`}>{caseNow(c)}</div></div>
      <div className="col"><span className="label">{c.ended ? "Ended" : "Until"}</span><div className="v small-v">{c.ended ? dayTime(c.ended.at).replace(" UTC", "") : c.nextAt ? <Countdown to={c.nextAt} now={now} /> : "delivery"}</div></div>
      <div className="col who"><span className="label">{c.dispute ? "The panel" : "First check"}</span><div className="v small-v">{c.dispute ? `${seated} of 3 seated` : c.first ? (c.first.accept ? "Accept" : "Reject") : "none yet"}</div><div className="meta mono">{c.decided?.verdict ? `${c.decided.verdict}, ${c.decided.votesAccept} to ${c.decided.votesReject}` : c.dispute && c.first ? `against a first ${c.first.accept ? "accept" : "reject"}` : c.first ? `by ${c.first.verifier.name ?? c.first.verifier.address.slice(0, 8)}` : `stake ${eth(c.stakeEth)}`}</div></div>
    </Link>
  );
}

/**
 * A verdict's model: "Model receipt checked" when Factor looked the call up at the provider and the model was of the
 * declared maker, "Model declared" otherwise; the receipt's facts beside it, and the way to its page.
 */
export function ModelMark({ m, caseId, verifier, bare = false }: { m: VerdictModel; caseId: number; verifier: string; /** the mark alone, without the receipt's facts */ bare?: boolean }) {
  const r = m.receipt;
  const checked = m.mark === "checked";
  return (
    <div className={`vmodelmark${checked ? " checked" : ""}`}>
      <span className="vmm-head">
        <svg viewBox="0 0 16 16" aria-hidden="true">{checked ? <><circle cx="8" cy="8" r="6.6" /><path d="M5 8.3l2 2 4-4.4" /></> : <circle cx="8" cy="8" r="6.6" strokeDasharray="2.2 2" />}</svg>
        <b>{checked ? "Model receipt checked" : "Model declared"}</b>
        <span className="mono">{m.makerName}</span>
      </span>
      {bare ? null : r ? (
        <span className="vmm-facts mono">
          {r.modelReported || r.modelAsked}{r.provider ? ` at ${r.provider}` : ""} · call {r.generationId.length > 18 ? `${r.generationId.slice(0, 16)}…` : r.generationId}{r.tokensIn !== null && r.tokensOut !== null ? ` · ${r.tokensIn} in, ${r.tokensOut} out` : ""}
          {checked ? null : <> · {r.by === "verifier" ? "its own receipt, as given: not checked" : r.why ?? "not checked"}</>}
          {" "}<Link className="vmm-link" href={`/verifiers/receipt/${caseId}/${verifier}`}>The receipt →</Link>
        </span>
      ) : <span className="vmm-facts">No receipt: only the maker it declared.</span>}
    </div>
  );
}

/** The makers, each with its mark and how many verifiers declare it. */
export function MakerRow({ makers, counts }: { makers: VerifierMaker[]; counts: Record<number, number> }) {
  return (
    <ul className="vmakers">
      {makers.map((m) => (
        <li key={m.id} className={counts[m.id] ? "on" : undefined}>
          <MakerMark id={m.id} size={30} />
          <b>{m.name}</b>
          <small>{m.models}</small>
          <span className="mono">{counts[m.id] ? `${counts[m.id]} verifier${counts[m.id] === 1 ? "" : "s"}` : "none yet"}</span>
        </li>
      ))}
    </ul>
  );
}
