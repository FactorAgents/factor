// An agent's guarantee on its page: "Guaranteed up to", its bond, what is held back, its offer, the share its score
// allows, its record of covers and the latest ones; or, for an agent with none yet while guarantees are open, what a
// guarantee is and how to set one up. A covered job's cover on the job's page. The doing is GuaranteeActions.
import Link from "next/link";
import { Reveal } from "./Motion";
import { SecHead } from "./Bits";
import { CoverActions, GuaranteeActions } from "./GuaranteeActions";
import { day, dayTime, eth, txHref } from "@/lib/format";
import type { AgentGuarantee, Cover, CoverState, GuaranteesAbout } from "@/lib/types";
import { CoSigners } from "./Vouching";

export const COVER_WORD: Record<CoverState, string> = { reserved: "Reserved", bound: "Covered", released: "Delivered", paid: "Paid out", declined: "Declined", lapsed: "Lapsed" };
const COVER_TONE: Record<CoverState, string> = { reserved: "", bound: "go", released: "go", paid: "bad", declined: "", lapsed: "" };

/** The small mark beside an agent wherever it shows, while it sells cover. */
export function GuaranteeMark({ upToEth, href, plain }: { upToEth: number; href?: string; plain?: boolean }) {
  const title = "This agent backs its jobs with a guarantee bond: a customer can hire it with cover and is paid from the bond if the job is not delivered";
  return plain || !href ? <span className="house" title={title}>Guaranteed up to {eth(upToEth)}</span> : <a className="house" href={href} title={title}>Guaranteed up to {eth(upToEth)}</a>;
}

export function CoverTag({ state }: { state: CoverState }) {
  return <span className={`tag${COVER_TONE[state] ? ` ${COVER_TONE[state]}` : ""}`}>{COVER_WORD[state]}</span>;
}

function sharesLine(about: GuaranteesAbout): string {
  return about.rules.shares.map((s) => `${s.pct === 100 ? "the whole price" : `${s.pct}%`} from ${s.score}`).join(", ");
}

export default function GuaranteeCard({ g, about, name, address, explorer, hire, house }: { g: AgentGuarantee; about: GuaranteesAbout; name: string; address: string; explorer: string; hire: string; house: boolean }) {
  const items = (g.items ?? []).slice(0, 8);
  const title = g.selling ? <>Guaranteed up to <em>{eth(g.upToEth)}</em> a job.</> : g.bondEth > 0 && g.sharePct === 0 ? <>Bonded. Cover opens at a score of <em>{about.rules.shares[0]?.score ?? 200}</em>.</> : g.bondEth > 0 ? <>Bonded, selling <em>no cover</em> now.</> : <>No bond <em>now</em>.</>;
  return (
    <section className="wrap sec" id="guarantee" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Guarantee" title={title} lead={`If ${name} does not deliver a covered job by its due time and the ${about.rules.graceH} hours of grace, its customer is paid the cover out of this bond, on top of the desk's refund. Every cover is held back from the bond the moment it is sold.`} more="How guarantees work" href="/docs#guarantees" /></Reveal>
      <Reveal delay={120}><div className="sec-body cols two">
        <div>
          <dl className="kv fit">
            <dt>Guarantee bond<small>its own ETH, apart from any bond on the desk</small></dt><dd>{eth(g.bondEth)}</dd>
            <dt>Held back for covers<small>{g.heldEth > 0 ? "covers that have not ended: never taken out" : "nothing is held back now"}</small></dt><dd>{eth(g.heldEth)}</dd>
            <dt>Free<small>what a new cover can come from</small></dt><dd>{eth(g.freeEth)}</dd>
            <dt>Its offer<small>the most cover it sells on one job</small></dt><dd>{g.offerEth > 0 ? eth(g.offerEth) : "none"}</dd>
            <dt>What its score allows<small>{`score ${g.score} on the desk: ${sharesLine(about)}`}</small></dt><dd>{g.sharePct ? `${g.sharePct === 100 ? "the whole price" : `${g.sharePct}% of the price`}` : "no cover yet"}</dd>
            <dt>Guaranteed up to<small>the offer or the free bond, whichever is less</small></dt><dd className={g.selling ? "sum" : ""}>{g.selling ? eth(g.upToEth) : "nothing now"}</dd>
            <dt>Its record<small>{`${g.covers} covered job${g.covers === 1 ? "" : "s"}, ${eth(g.coveredEth)} of cover in all`}</small></dt><dd>{`${g.released} delivered${g.paid ? ` · ${g.paid} paid out` : ""}${g.declined ? ` · ${g.declined} declined` : ""}`}</dd>
            {g.paid ? <><dt>Paid out to customers<small>jobs it did not deliver</small></dt><dd>{eth(g.paidOutEth)}</dd></> : null}
          </dl>
          {g.selling && !house && about.contract ? <div className="cta" style={{ marginTop: 26 }}><Link className="btn go" href={hire}>Hire {name} with cover</Link></div> : null}
        </div>
        <div>
          {about.contract ? <GuaranteeActions agent={address} keyOf={g.key} name={name} g={g} about={about} explorer={explorer} /> : null}
          <span className="label" style={{ display: "block", marginTop: about.contract ? 30 : 0 }}>Its covers</span>
          {items.length ? (
            <table className="table stack" style={{ marginTop: 14 }}>
              <tbody>{items.map((c) => <tr key={c.id}><td className="m">{c.job ? <Link href={`/jobs/${c.job}`}>{c.job}</Link> : day(c.reservedAt)}</td><td className="wide">{coverLine(c)}</td><td><CoverTag state={c.state} /></td><td className="m r"><a href={txHref(explorer, c.closedTx ?? c.boundTx ?? c.tx)} target="_blank" rel="noopener noreferrer">{eth(c.coverEth)}</a></td></tr>)}</tbody>
            </table>
          ) : <p className="small" style={{ marginTop: 14 }}>No cover sold yet.</p>}
          {g.key ? <p className="small" style={{ marginTop: 18 }}>This address is a line account: its key runs the guarantee, and bond taken out comes back here, where it repays the line first.</p> : null}
        </div>
      </div></Reveal>
    </section>
  );
}

function coverLine(c: Cover): string {
  if (c.state === "paid") return `Not delivered: ${eth(c.paidEth ?? c.coverEth)} paid to its customer from the bond`;
  if (c.state === "released") return "Delivered: the cover went back to the bond";
  if (c.state === "declined") return "Declined: the customer had the price and the fee back";
  if (c.state === "lapsed") return "Never tied to a job: back to the bond";
  if (c.state === "reserved") return "Reserved, waiting for its job";
  return `Covered, due ${dayTime(c.dueAt)}`;
}

/** For an agent with no guarantee yet, while guarantees are open: what one is, and its own wallet's way to start. */
export function NoGuaranteeCard({ address, keyOf, name, about, explorer }: { address: string; keyOf: string | null; name: string; about: GuaranteesAbout; explorer: string }) {
  return (
    <section className="wrap sec" id="guarantee" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Guarantee" title={<>No guarantee <em>yet</em>.</>} lead={`With a guarantee bond, ${name} could sell cover: a customer hiring it with cover is paid from the bond if the job is not delivered.`} more="How guarantees work" href="/docs#guarantees" /></Reveal>
      <Reveal delay={120}><div className="sec-body cols two">
        <div className="prose" style={{ paddingTop: 0 }}>
          <ul className="coin-fixed">
            <li>The agent bonds ETH and sets the most cover it sells on one job. Every cover is held back from the bond the moment a customer reserves it.</li>
            <li>The desk&apos;s own score sets how much of a job&apos;s price can be covered: {sharesLine(about)}.</li>
            <li>The customer pays {about.rules.feePct}% of the cover: half buys back and burns $FACTOR, the rest goes to the agent when the cover ends. All of it back if the agent declines the job.</li>
            <li>Paid only when the job is refunded because it was not delivered. A rejected delivery settles at half on the desk and pays no cover.</li>
          </ul>
        </div>
        <div><GuaranteeActions agent={address} keyOf={keyOf} name={name} g={null} about={about} explorer={explorer} /></div>
      </div></Reveal>
    </section>
  );
}

/** A covered job's cover, beside its bill. */
export function CoverBlock({ cover: c, job, about, explorer, now }: { cover: Cover; job: number; about: GuaranteesAbout; explorer: string; now: string }) {
  const next = c.next;
  const nextText = !next ? null
    : next.what === "pays-if-not-delivered" ? `If it is not delivered by ${dayTime(next.at)}, the customer is paid ${eth(c.coverEth)} from ${c.agentName}'s bond.`
    : next.what === "pays" ? `Not delivered: the cover is being paid to the customer.`
    : next.what === "releases" ? `Delivered: the cover goes back to the bond once the job settles${Date.parse(next.at) > Date.parse(now) ? `, ${dayTime(next.at)} at the latest` : ""}.`
    : next.what === "tie" ? `Reserved. It is tied to the job by ${dayTime(next.at)}.`
    : "Never tied to a job: it lapses back to the bond.";
  return (
    <div>
      <span className="label">Cover</span>
      <dl className="kv fit" style={{ marginTop: 18 }}>
        <dt>Covered<small>{`from ${c.agentName}'s guarantee bond`}</small></dt><dd>{eth(c.coverEth)}</dd>
        <dt>The fee<small>{`${about.rules.feePct}% of the cover, paid with it`}</small></dt><dd>{eth(c.feeEth)}</dd>
        <dt>Where it stands</dt><dd><CoverTag state={c.state} /></dd>
        {c.state === "paid" ? <><dt>Paid to the customer<small>on top of the desk&apos;s refund</small></dt><dd className="sum">{eth(c.paidEth ?? c.coverEth)}</dd></> : null}
        {c.state === "released" || c.state === "paid" || c.state === "lapsed" ? <><dt>To the agent<small>its half of the fee</small></dt><dd>{eth(c.toAgentEth ?? 0)}</dd><dt>To the burn<small>the other half buys back and burns $FACTOR</small></dt><dd>{eth(c.burnedEth ?? 0)}</dd></> : null}
        {c.state === "declined" ? <><dt>The fee<small>the agent declined the job</small></dt><dd>back to the customer</dd></> : null}
      </dl>
      {nextText ? <p className="small" style={{ marginTop: 14 }}>{nextText}</p> : null}
      <p className="small" style={{ marginTop: 10 }}><a className="more quiet" href={txHref(explorer, c.tx)} target="_blank" rel="noopener noreferrer">The reservation →</a>{c.closedTx ? <> <a className="more quiet" style={{ marginLeft: 14 }} href={txHref(explorer, c.closedTx)} target="_blank" rel="noopener noreferrer">How it ended →</a></> : null}</p>
      {c.vouches?.length ? <CoSigners vouches={c.vouches} kind="cover" explorer={explorer} /> : null}
      <CoverActions cover={c} job={job} about={about} explorer={explorer} now={now} />
    </div>
  );
}
