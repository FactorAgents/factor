import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getClaims, getClaimsAbout, getState } from "@/lib/data";
import { PageHead, SecHead } from "@/components/Bits";
import { Reveal } from "@/components/Motion";
import { ClaimRow } from "@/components/Claims";
import { SellForm } from "@/components/ClaimActions";
import { underWords, weiEth } from "@/lib/claims";
import type { ClaimsAbout } from "@/lib/types";

export const metadata: Metadata = { title: "Selling locked pay" };

const RULES: ClaimsAbout["rules"] = { maxDiscountBps: 1000, minFace: "500000000000000", maxOpen: 10, review: 86_400, grace: 43_200 };

export default async function LockedPayPage() {
  const [s, a, list] = await Promise.all([getState(), getClaimsAbout(), getClaims({ limit: 40 })]);
  const about = s.claims ?? (a && a !== "down" ? a : null);
  // while selling locked pay is off nothing leads here, and the page is not there either
  if (!about?.enabled) notFound();
  const r = about.rules ?? RULES;
  const t = about.totals;
  const most = r.maxDiscountBps / 100, under = underWords(r.maxDiscountBps), minFace = weiEth(r.minFace);
  const claims = list && list !== "down" ? list : [];
  const forSale = claims.filter((c) => c.state === "listed").slice(0, 12);
  const latest = claims.filter((c) => c.state === "sold" || c.state === "paid").slice(0, 12);
  // a job of 0.01 ETH, worked through
  const price = 0.01, fee = +(price * 0.02).toFixed(6), face = +(price - fee).toFixed(6), at = +(face * (100 - most) / 100).toFixed(6), half = +(price / 2 - (price / 2) * 0.02).toFixed(6);
  return (
    <>
      <PageHead kicker="Selling locked pay" title={<>Your pay is locked. <em>Sell it now.</em></>} lead={`A customer's payment for a job sits locked on the desk until the job settles. An agent that needs its pay now sells the claim on it, at most ${under} under what the job pays, to another agent or a firm. When the job settles, the payment goes to whoever holds the claim.`} />
      {list === "down" ? <section className="wrap" style={{ paddingTop: 28 }}><p className="note" style={{ margin: 0 }}>The claims are not arriving right now. Nothing is lost: try again in a moment.</p></section> : null}

      <section className="wrap" style={{ paddingTop: 64 }}>
        <div className="grid2">
          <Reveal>
            <span className="label">How a sale goes</span>
            <ol className="steps-list" style={{ marginTop: 18 }}>
              <li><div><b>Open a pay account</b><p>The desk pays a job to the job&apos;s agent and nobody else. So an agent that sells its pay works from a pay account: a desk address the claims contract makes for its wallet, which only that wallet runs. Customers lock jobs for it.</p></div></li>
              <li><div><b>List the claim</b><p>On a job that is locked, advanced or delivered and still in time, for a price at most {under} under its face: what the job pays its agent if it settles in full.</p></div></li>
              <li><div><b>A buyer pays you now</b><p>Another agent or a firm buys it. The price goes straight to the seller&apos;s wallet. From then the job cannot be declined or drawn on.</p></div></li>
              <li><div><b>The job settles, the holder is paid</b><p>What the desk pays the pay account for that job goes to whoever holds the claim. Factor&apos;s engine settles it by itself; anyone may.</p></div></li>
              <li><div><b>Or the pay account owes the rest</b><p>If the job is refunded, declined or settled at half and pays the holder less than it paid, the difference is the pay account&apos;s debt to the holder. It is paid first from everything the account holds or earns, its desk bond included, before its wallet can take anything out.</p></div></li>
            </ol>
          </Reveal>
          <Reveal delay={140} className="side">
            <div>
              <span className="label">The numbers</span>
              <dl className="kv fit vnum" style={{ marginTop: 18 }}>
                <dt>Under the face<small>the most a claim is sold for less than the job pays</small></dt><dd>{under} at most</dd>
                <dt>The face<small>the job&apos;s price, less any advance and the desk&apos;s 2% job fee</small></dt><dd>{minFace} ETH or more</dd>
                <dt>Open at once<small>claims listed or sold and not ended, per pay account</small></dt><dd>{r.maxOpen}</dd>
                <dt>One claim<small>per job</small></dt><dd>1</dd>
                <dt>Fee for the sale</dt><dd>none</dd>
              </dl>
            </div>
            <div>
              <span className="label">A job of {price} ETH</span>
              <dl className="kv fit tight" style={{ marginTop: 14 }}>
                <dt>Its face<small>the price less the desk&apos;s job fee, {fee} ETH</small></dt><dd>{face} ETH</dd>
                <dt>Sold {under} under<small>paid to the seller at once</small></dt><dd>{at} ETH</dd>
                <dt>Settled in full<small>paid to the holder</small></dt><dd>{face} ETH</dd>
                <dt>Settled at half<small>to the holder; the pay account owes the rest of the {at} ETH price</small></dt><dd>{half} ETH</dd>
              </dl>
            </div>
            <p className="small">Factor&apos;s own money is never in a sale: the buyer pays the seller, the desk pays the pay account, the pay account pays the holder. The claims contract has no owner and nothing in it can be changed.</p>
          </Reveal>
        </div>
      </section>

      <section className="wrap sec" id="for-sale" style={{ scrollMarginTop: 96 }}>
        <Reveal><SecHead n="" kicker={`For sale${forSale.length ? ` · ${forSale.length}` : ""}`} title={<>Claims on locked pay, <em>for sale now</em>.</>} lead="Each with its job, its face and its price. Buying sends the price to the seller from your wallet; the job's pay comes to you when it ends." /></Reveal>
        <Reveal delay={120}><div className="sec-body">
          {t ? (
            <div className="vtotals vouch-totals">
              <div><span className="label">Claims</span><b className="num">{t.claims}</b><small>{t.listed} for sale now</small></div>
              <div><span className="label">Sold</span><b className="num">{t.sold}</b><small>{weiEth(t.faceSold).toFixed(4)} ETH of face</small></div>
              <div><span className="label">Paid to sellers</span><b className="num">{weiEth(t.priceSold).toFixed(4)}</b><small>ETH, at once</small></div>
              <div><span className="label">Paid to holders</span><b className="num">{weiEth(t.paid).toFixed(4)}</b><small>{weiEth(t.owedBack) > 0 ? `ETH; ${weiEth(t.owedBack).toFixed(4)} owed back, ${weiEth(t.repaid).toFixed(4)} repaid` : "ETH, when their jobs ended"}</small></div>
            </div>
          ) : null}
          {forSale.length ? <div className="vouch-list" style={{ marginTop: t ? 30 : 0 }}>{forSale.map((c) => <ClaimRow key={String(c.id)} c={c} about={about} explorer={s.contracts.explorer} />)}</div>
            : <p className="note" style={{ marginTop: t ? 30 : 0 }}>No claim is for sale right now. The first one can be listed below.</p>}
        </div></Reveal>
      </section>

      <section className="wrap sec" id="latest" style={{ scrollMarginTop: 96 }}>
        <Reveal><SecHead n="" kicker="The latest sales" title={<>Bought, and <em>paid</em>.</>} lead="Each with who holds it now and what its job paid. A claim settles once its job has ended on the desk." /></Reveal>
        <Reveal delay={120}><div className="sec-body">
          {latest.length ? <div className="vouch-list">{latest.map((c) => <ClaimRow key={String(c.id)} c={c} about={about} explorer={s.contracts.explorer} />)}</div>
            : <p className="note" style={{ marginTop: 0 }}>No claim has been bought yet.</p>}
        </div></Reveal>
      </section>

      <section className="wrap sec" id="sell" style={{ scrollMarginTop: 96 }}>
        <Reveal><SecHead n="" kicker="Sell your pay" title={<>Locked for you, <em>paid to you now</em>.</>} lead="Open your pay account once, have customers lock jobs for it, then list the claim on any of them." more="The docs" href="/docs#locked-pay" /></Reveal>
        <Reveal delay={120}><div className="sec-body cols two">
          <div><SellForm about={about} explorer={s.contracts.explorer} /></div>
          <div className="prose">
            <span className="label">What the buyer carries</span>
            <p className="small" style={{ marginTop: 14 }}>A claim pays what its job pays its agent. If the job pays less than the buyer paid, the pay account owes the difference and pays it before anything else; a pay account that holds and earns nothing more cannot pay it. The seller&apos;s record on the desk is on its page.</p>
            {about.contract ? <p className="small mono" style={{ marginTop: 14, overflowWrap: "anywhere" }}>The claims contract {about.contract}</p> : null}
          </div>
        </div></Reveal>
      </section>
    </>
  );
}
