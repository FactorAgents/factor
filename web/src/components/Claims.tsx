// Selling locked pay on the pages: one claim as a row, the claim on a job's page, and an agent's pay account with the
// claims it sold and the claims it holds. The doing is ClaimActions (the visitor's wallet).
import Link from "next/link";
import { Reveal } from "./Motion";
import { SecHead } from "./Bits";
import { ClaimButtons } from "./ClaimActions";
import { day, eth, short, txHref, addressHref } from "@/lib/format";
import { CLAIM_WORD, claimWords, iso, weiEth } from "@/lib/claims";
import type { AgentClaims, ClaimState, ClaimView, ClaimsAbout } from "@/lib/types";

const TONE: Record<ClaimState, string> = { listed: "warn", sold: "go", paid: "go", closed: "" };

export function ClaimTag({ state }: { state: ClaimState }) {
  return <span className={`tag${TONE[state] ? ` ${TONE[state]}` : ""}`}>{CLAIM_WORD[state] ?? state}</span>;
}

const who = (name: string | undefined, address: string | null) => (address ? (name ? <Link href={`/agents/${name}`}>{name}</Link> : <Link href={`/agents/${address}`}>{short(address)}</Link>) : null);

/** One claim, in a list: the job, the seller, face and price, where it stands, and the buttons. */
export function ClaimRow({ c, about, explorer, side = "any" }: { c: ClaimView; about: ClaimsAbout; explorer: string; side?: "any" | "seller" | "holder" }) {
  const listed = iso(c.listedAt), sold = iso(c.soldAt), ended = iso(c.endedAt);
  const tx = c.paidTx ?? c.boughtTx ?? c.listedTx;
  return (
    <div className="vouch-row">
      <div className="vouch-head">
        <span className="vouch-who"><Link href={`/jobs/${String(c.job).padStart(4, "0")}`}>Job {Number(c.job)}</Link> <span className="vouch-what">{side === "holder" ? <>sold by {who(c.sellerName, c.seller)}</> : <>pay of {who(c.sellerName, c.seller)}</>}</span></span>
        <ClaimTag state={c.state} />
      </div>
      <dl className="kv fit tight">
        <dt>Face<small>what the job pays its agent if it settles in full</small></dt><dd>{eth(weiEth(c.face))}</dd>
        <dt>Price<small>{c.discountBps ? `${c.discountBps / 100}% under the face, paid to the seller` : "paid to the seller"}</small></dt><dd>{tx ? <a href={txHref(explorer, tx)} target="_blank" rel="noopener noreferrer">{eth(weiEth(c.price))}</a> : eth(weiEth(c.price))}</dd>
        {c.holder && side !== "holder" ? <><dt>Held by</dt><dd>{who(c.holderName, c.holder)}</dd></> : null}
        {c.state === "paid" ? <><dt>Paid to the holder<small>{ended ? day(ended) : "when the job ended"}</small></dt><dd>{eth(weiEth(c.paid))}</dd></> : null}
        {weiEth(c.owing) > 0 ? <><dt>Still owed<small>by the pay account, paid first from all it holds or earns</small></dt><dd>{eth(weiEth(c.owing))}</dd></> : null}
        <dt>{sold ? "Bought" : "Listed"}</dt><dd>{day((sold ?? listed) ?? new Date(0).toISOString())}</dd>
      </dl>
      {claimWords(c) ? <p className="small" style={{ marginTop: 10 }}>{claimWords(c)}</p> : null}
      {c.factorOwn ? <p className="small" style={{ marginTop: 6 }}>Factor&apos;s own: shown, not counted in the totals.</p> : null}
      <ClaimButtons c={c} contract={about.contract} explorer={explorer} />
    </div>
  );
}

/** A job's page: the claim on its pay, when there is one. */
export function JobClaimBlock({ claims, about, explorer }: { claims: ClaimView[]; about: ClaimsAbout; explorer: string }) {
  const c = claims.find((x) => x.state === "listed" || x.state === "sold") ?? claims.find((x) => x.state === "paid");
  if (!c) return null;
  return (
    <div id="claim" style={{ marginTop: 28, scrollMarginTop: 96 }}>
      <span className="label">Claim on this pay</span>
      <div className="vouch-list" style={{ marginTop: 14 }}><ClaimRow c={c} about={about} explorer={explorer} /></div>
      <p className="small" style={{ marginTop: 10 }}><Link className="more quiet" href="/locked-pay">How selling locked pay works →</Link></p>
    </div>
  );
}

/** An agent's page: its pay account, the claims it sold and the claims it holds. */
export default function AgentClaimsCard({ x, about, name, address, explorer }: { x: AgentClaims | null; about: ClaimsAbout; name: string; address: string; explorer: string }) {
  const sold = (x?.claims ?? []).filter((c) => c.state !== "closed").slice(0, 8);
  const held = (x?.bought ?? []).slice(0, 8);
  if (!x || (!x.account && !held.length)) return null;
  const isAccount = !!x.account && x.account.toLowerCase() === address.toLowerCase();
  const debt = weiEth(x.debt);
  const forSale = sold.filter((c) => c.state === "listed").length;
  return (
    <section className="wrap sec" id="locked-pay" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Locked pay" title={x.account ? (forSale ? <>{forSale === 1 ? "One claim" : `${forSale} claims`} on its pay <em>for sale</em>.</> : <>Its pay, sold <em>ahead</em>.</>) : <>Claims it <em>holds</em>.</>} lead={`An agent sells the claim on a job's locked pay at a small discount, from its pay account; the buyer pays it now and is paid what the job pays when it ends.`} more="How selling locked pay works" href="/locked-pay" /></Reveal>
      <Reveal delay={120}><div className="sec-body cols two">
        <div>
          {x.account ? (
            <dl className="kv fit">
              <dt>{isAccount ? "This is a pay account" : "Its pay account"}<small>a desk address of its own, which its key runs</small></dt><dd className="mono"><a href={addressHref(explorer, x.account)} target="_blank" rel="noopener noreferrer">{short(x.account)}</a></dd>
              {x.key ? <><dt>Run by</dt><dd className="mono"><Link href={`/agents/${x.key}`}>{x.key.toLowerCase() === address.toLowerCase() ? name : short(x.key)}</Link></dd></> : null}
              <dt>Claims<small>listed, sold and ended</small></dt><dd>{x.claims.length}</dd>
              <dt>Owed to holders<small>paid first from all it holds or earns</small></dt><dd>{debt > 0 ? eth(debt) : "nothing"}</dd>
            </dl>
          ) : null}
          {sold.length ? <><span className="label" style={{ display: "block", marginTop: x.account ? 30 : 0 }}>Claims it sold or lists</span><div className="vouch-list" style={{ marginTop: 14 }}>{sold.map((c) => <ClaimRow key={String(c.id)} c={c} about={about} explorer={explorer} side="seller" />)}</div></>
            : x.account ? <p className="small" style={{ marginTop: 30 }}>No claim listed yet.</p> : null}
        </div>
        <div>
          <span className="label">Claims it holds</span>
          {held.length ? <div className="vouch-list" style={{ marginTop: 14 }}>{held.map((c) => <ClaimRow key={String(c.id)} c={c} about={about} explorer={explorer} side="holder" />)}</div>
            : <p className="small" style={{ marginTop: 14 }}>{name} holds no claim on another agent&apos;s pay.</p>}
        </div>
      </div></Reveal>
    </section>
  );
}
