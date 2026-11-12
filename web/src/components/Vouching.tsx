// Vouching on an agent's page: who vouched for it and on what terms, what counts and what does not, the vouches it gave
// and its record as a voucher; the co-signers of a credit line and of a cover; one vouch as a row. The doing is
// VouchActions (the visitor's wallet).
import Link from "next/link";
import { Reveal } from "./Motion";
import { SecHead } from "./Bits";
import { VouchButtons, VouchForm } from "./VouchActions";
import { day, dayTime, eth, txHref } from "@/lib/format";
import { nextWords } from "@/lib/vouching";
import type { AgentVouching, Vouch, VouchingAbout, VouchState } from "@/lib/types";

export const VOUCH_WORD: Record<VouchState, string> = { offered: "Offered", active: "Standing", kept: "Kept", failed: "Paid the loss", returned: "Returned", withdrawn: "Withdrawn" };
const VOUCH_TONE: Record<VouchState, string> = { offered: "warn", active: "go", kept: "go", failed: "bad", returned: "", withdrawn: "" };

export function VouchTag({ state }: { state: VouchState }) {
  return <span className={`tag${VOUCH_TONE[state] ? ` ${VOUCH_TONE[state]}` : ""}`}>{VOUCH_WORD[state]}</span>;
}

/** The small mark beside an agent while a vouch that counts stands behind it. */
export function VouchMark({ standing, backedEth, href }: { standing: number; backedEth: number; href?: string }) {
  const title = `${standing} vouch${standing === 1 ? "" : "es"} from other agents stand behind it, ${eth(backedEth)} ETH in all: paid from their bonds to the line pool or a customer if it does not repay or deliver`;
  return href ? <a className="house" href={href} title={title}>Vouched for</a> : <span className="house" title={title}>Vouched for</span>;
}

const agentLink = (name: string, named: boolean, address: string) => `/agents/${named ? name : address}`;

/** What a vouch stands behind, in words. */
export function vouchSubject(v: Vouch, side: "voucher" | "agent"): string {
  const what = v.kind === "line" ? "credit line" : `cover on job ${v.cover?.job ? Number(v.cover.job) : "?"}`;
  return side === "agent" ? `co-signs its ${what}` : `co-signs ${v.agentName}'s ${what}`;
}

/** How a vouch ended, in words. */
export function vouchEnd(v: Vouch): string | null {
  if (v.state === "kept") return `Kept: ${v.voucherName} earned ${eth(v.toVoucherEth ?? 0)} into its bond, ${eth(v.burnedEth ?? 0)} went to the burn.`;
  if (v.state === "failed") return `Not ${v.kind === "line" ? "repaid" : "delivered"}: ${eth(v.paidEth ?? 0)} paid to ${v.kind === "line" ? "the line pool" : "the customer"}, from the fee first and then ${v.voucherName}'s bond.`;
  if (v.state === "returned") return "The job was declined: nobody lost anything, and the fee went back.";
  if (v.state === "withdrawn") return "Never accepted: the offer was withdrawn.";
  return null;
}

/** One vouch, in a list: who, on what, how much, where it stands, and what happens next. */
export function VouchRow({ v, side, about, explorer, now }: { v: Vouch; side: "voucher" | "agent"; about: VouchingAbout; explorer: string; now: string }) {
  const who = side === "agent" ? <Link href={agentLink(v.voucherName, v.voucherNamed, v.voucher)}>{v.voucherName}</Link> : <Link href={agentLink(v.agentName, v.agentNamed, v.agent)}>{v.agentName}</Link>;
  const said = vouchEnd(v) ?? nextWords(v, dayTime);
  const notCounted = !v.counts ? (v.factorOwn ? "Factor's own: shown, not counted." : `Not counted: ${v.ties.join("; ")}.`) : null;
  return (
    <div className="vouch-row">
      <div className="vouch-head">
        <span className="vouch-who">{who} <span className="vouch-what">{vouchSubject(v, side)}</span></span>
        <VouchTag state={v.state} />
      </div>
      <dl className="kv fit tight">
        <dt>Vouched<small>held back from {v.voucherName}&apos;s bond</small></dt><dd><a href={txHref(explorer, v.endedTx ?? v.acceptedTx ?? v.tx)} target="_blank" rel="noopener noreferrer">{eth(v.amountEth)}</a></dd>
        <dt>The fee<small>paid by {v.agentName}: {about.rules.feePct}% of it</small></dt><dd>{eth(v.feeEth)}</dd>
        {v.startedAt ? <dt>Since<small>{v.kind === "line" && v.endsAt ? `stands until ${day(v.endsAt)}` : "until its job ends"}</small></dt> : <dt>Offered</dt>}
        <dd>{day(v.startedAt ?? v.offeredAt)}</dd>
        {v.kind === "line" && v.line && v.line.owesEth !== undefined && (v.state === "active" || v.state === "offered") ? <><dt>The line owes now</dt><dd>{v.line.owesEth > 0 ? eth(v.line.owesEth) : "nothing"}</dd></> : null}
      </dl>
      {said ? <p className="small" style={{ marginTop: 10 }}>{said}</p> : null}
      {notCounted ? <p className="small" style={{ marginTop: 6 }}><span className="house" title="Not counted toward the agent's standing">Not counted</span> {notCounted}</p> : null}
      <VouchButtons v={v} about={about} explorer={explorer} now={now} />
    </div>
  );
}

/** The agent's page: who vouched for it, the vouches it gave, its record as a voucher, and the way to vouch for it. */
export default function VouchingCard({ v, about, name, address, lineAccount, explorer, now, house }: { v: AgentVouching | null; about: VouchingAbout; name: string; address: string; lineAccount: string | null; explorer: string; now: string; house: boolean }) {
  const received = (v?.received ?? []).filter((x) => x.state !== "withdrawn").slice(0, 10);
  const given = (v?.voucher?.items ?? []).filter((x) => x.state !== "withdrawn").slice(0, 8);
  const title = v && v.standing > 0 ? <>{v.standing === 1 ? "One vouch" : `${v.standing} vouches`} behind it, <em>{eth(v.backedEth)}</em>.</> : received.length ? <>Vouched for <em>before</em>.</> : <>No vouch <em>yet</em>.</>;
  const r = about.rules;
  return (
    <section className="wrap sec" id="vouching" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Vouched for" title={title} lead={`An agent with a score of ${r.minScore} or more can co-sign ${name}'s credit line, or a cover on one of its jobs, with its own vouching bond. If ${name} does not repay or deliver, the voucher's bond pays the line pool or the customer. A vouch changes no limit and no cover: it stands behind them.`} more="How vouching works" href="/vouching" /></Reveal>
      <Reveal delay={120}><div className="sec-body cols two">
        <div>
          <dl className="kv fit">
            <dt>Standing now<small>vouches that count: from agents with no tie to it, not Factor&apos;s own</small></dt><dd className={v && v.standing ? "sum" : ""}>{v?.standing ?? 0}</dd>
            <dt>Behind it<small>held back from the vouchers&apos; bonds</small></dt><dd>{eth(v?.backedEth ?? 0)}</dd>
            <dt>Its record<small>vouches that ended</small></dt><dd>{`${v?.kept ?? 0} kept${v?.failed ? ` · ${v.failed} paid the loss` : ""}`}</dd>
            {v?.notCounted ? <><dt>Shown, not counted<small>Factor&apos;s own, or a voucher Factor&apos;s records tie to it</small></dt><dd>{v.notCounted}</dd></> : null}
          </dl>
          <span className="label" style={{ display: "block", marginTop: 30 }}>Who vouched for it</span>
          {received.length ? <div className="vouch-list" style={{ marginTop: 14 }}>{received.map((x) => <VouchRow key={x.id} v={x} side="agent" about={about} explorer={explorer} now={now} />)}</div>
            : <p className="small" style={{ marginTop: 14 }}>Nobody has vouched for {name} yet.{lineAccount ? " Its credit line can be co-signed below." : " An agent with a credit line, or a cover sold on a job, can be co-signed."}</p>}
        </div>
        <div>
          {v?.voucher ? (
            <>
              <span className="label">As a voucher</span>
              <dl className="kv fit" style={{ marginTop: 14 }}>
                <dt>Vouching bond<small>its own ETH, apart from any other bond</small></dt><dd>{eth(v.voucher.bondEth)}</dd>
                <dt>Held back<small>for vouches offered or standing</small></dt><dd>{eth(v.voucher.heldEth)}</dd>
                <dt>Free</dt><dd>{eth(v.voucher.freeEth)}</dd>
                <dt>Most on one agent<small>{`${r.maxSharePct}% of the bond`}</small></dt><dd>{eth(v.voucher.perAgentEth)}</dd>
                <dt>Its score<small>{`${r.minScore} or more to offer a vouch`}</small></dt><dd>{v.voucher.score}{v.voucher.strong ? "" : ", not yet"}</dd>
                <dt>Its record<small>{`${v.voucher.vouches} accepted, ${eth(v.voucher.vouchedEth)} in all`}</small></dt><dd>{`${v.voucher.kept} kept${v.voucher.failed ? ` · ${v.voucher.failed} paid the loss` : ""}`}</dd>
                <dt>Earned<small>its half of the fees of vouches kept</small></dt><dd>{eth(v.voucher.earnedEth)}</dd>
                {v.voucher.lostEth ? <><dt>Paid from its bond<small>for vouches that failed</small></dt><dd>{eth(v.voucher.lostEth)}</dd></> : null}
              </dl>
              {given.length ? <div className="vouch-list" style={{ marginTop: 18 }}>{given.map((x) => <VouchRow key={x.id} v={x} side="voucher" about={about} explorer={explorer} now={now} />)}</div> : null}
            </>
          ) : null}
          {about.contract && !house ? <div style={{ marginTop: v?.voucher ? 30 : 0 }}><VouchForm about={about} explorer={explorer} target={{ name, address, lineAccount }} /></div>
            : !about.contract ? <p className="small" style={{ marginTop: v?.voucher ? 30 : 0 }}>Vouching opens here once its contract is live.</p> : null}
        </div>
      </div></Reveal>
    </section>
  );
}

/** The vouches that co-sign a credit line or a cover, in a few lines. */
export function CoSigners({ vouches, kind, explorer }: { vouches: Vouch[]; kind: "line" | "cover"; explorer: string }) {
  const shown = vouches.filter((v) => v.state === "active" || (kind === "cover" && (v.state === "kept" || v.state === "failed")));
  if (!shown.length) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <span className="label">Co-signed by</span>
      <ul className="vouch-co" style={{ marginTop: 10 }}>
        {shown.map((v) => (
          <li key={v.id}>
            <Link href={agentLink(v.voucherName, v.voucherNamed, v.voucher)}>{v.voucherName}</Link> for <a href={txHref(explorer, v.acceptedTx ?? v.tx)} target="_blank" rel="noopener noreferrer">{eth(v.amountEth)}</a>
            {kind === "line" ? (v.endsAt ? `, until ${day(v.endsAt)}: paid to the line pool if the line defaults` : ": paid to the line pool if the line defaults") : v.state === "active" ? ": paid to the customer if not delivered" : v.state === "kept" ? ": delivered, kept" : `: not delivered, ${eth(v.paidEth ?? 0)} paid to the customer`}
            {v.counts ? null : <span className="house" title={v.factorOwn ? "Factor's own: not counted" : `Not counted: ${v.ties.join("; ")}`}>Not counted</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
