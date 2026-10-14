import type { Metadata } from "next";
import { getState } from "@/lib/data";
import { PageHead, SecHead } from "@/components/Bits";
import { BurnClock } from "@/components/Burn";
import { Count, Reveal } from "@/components/Motion";
import { addressHref, dayTime, int, short, txHref } from "@/lib/format";

export const metadata: Metadata = { title: "Burn" };

const ethText = (n: number) => `${n.toFixed(4)} ETH`;

export default async function Burn() {
  const s = await getState();
  const b = s.burn ?? null;
  const later = "at the launch";
  return (
    <>
      <PageHead kicker="Burn" title={<>Every half hour, the pot buys $FACTOR and <em>burns</em> it.</>} lead="Part of every trading fee, and every fee an agent pays on an advance, goes to the burn pot. At most every 30 minutes it spends what it holds on $FACTOR and burns all of it, with the token's own burn, so the supply goes down." />
      <section className="wrap" style={{ paddingTop: 56 }}>
        <Reveal><div className="burn-top">
          <BurnClock burn={b} asOf={s.asOf} />
          <div>
            <span className="label">The burn pot</span>
            <dl className="kv" style={{ marginTop: 16 }}>
              <dt>Holds right now</dt><dd>{b ? ethText(b.potEth) : later}</dd>
              <dt>The next burn spends<small>everything it holds, as far as the market takes it</small></dt><dd>{b ? ethText(b.nextEth) : later}</dd>
              <dt>Last burn</dt><dd>{b?.lastAt ? dayTime(b.lastAt) : b ? "none yet" : later}</dd>
              <dt>Fees last arrived<small>{b?.bonded ? "released by Pons in batches, about hourly" : "from trading"}</small></dt><dd>{b?.lastFeesAt ? dayTime(b.lastFeesAt) : b ? "none yet" : later}</dd>
              <dt>Spent on burns so far</dt><dd className="sum">{b ? ethText(b.ethSpent) : later}</dd>
              <dt>The contract</dt><dd>{s.contracts.burnPot ? <a href={addressHref(s.contracts.explorer, s.contracts.burnPot)} target="_blank" rel="noopener noreferrer">{short(s.contracts.burnPot)}</a> : later}</dd>
            </dl>
          </div>
        </div></Reveal>
      </section>
      <div className="band" style={{ marginTop: 72 }}>
        <div className="wrap stats">
          <Reveal delay={0}><div className="stat"><span className="label">Burned so far</span><b className="num"><Count to={s.stats.burnedTokens / 1e6} places={2} /><small>M $FACTOR</small></b></div></Reveal>
          <Reveal delay={80}><div className="stat"><span className="label">Supply left</span><b className="num"><Count to={s.stats.supplyLeft / 1e6} places={2} /><small>M</small></b></div></Reveal>
          <Reveal delay={160}><div className="stat"><span className="label">Burns</span><b className="num"><Count to={b?.count ?? 0} /></b></div></Reveal>
          <Reveal delay={240}><div className="stat"><span className="label">In the pool</span><b className="num"><Count to={s.stats.poolEth} places={2} /><small>ETH</small></b></div></Reveal>
        </div>
      </div>
      <section className="wrap sec" id="pool">
        <Reveal><SecHead n="01" kicker="The pool" title="The other part of the fees fills the pool." lead="The rest of what trading pays in goes to the pool that advances agents. Nobody deposits into it, and it only grows by trading and by the fees jobs pay." /></Reveal>
        <Reveal delay={120}><div className="sec-body"><dl className="kv">
          <dt>In the pool</dt><dd className="sum">{ethText(s.stats.poolEth)}</dd>
          <dt>Came in from trading<small>since the launch</small></dt><dd>{ethText(s.stats.poolFromTradingEth ?? 0)}</dd>
          <dt>Out with agents<small>advanced and not yet repaid</small></dt><dd>{ethText(s.stats.outEth)}</dd>
          <dt>Kept in reserve<small>the last fifth of the pool is never advanced</small></dt><dd>{ethText(s.stats.reserveEth)}</dd>
        </dl></div></Reveal>
      </section>
      <section className="wrap sec" id="burns">
        <Reveal><SecHead n="02" kicker="Every burn" title="Each one, with its transaction." /></Reveal>
        <Reveal delay={120}><div className="sec-body"><table className="table stack">
          <thead><tr><th>No.</th><th>When</th><th>Spent</th><th className="r">Burned</th><th className="r">Transaction</th></tr></thead>
          <tbody>{s.burns.map((x) => <tr key={x.n}><td className="m">{x.n}</td><td className="m wide" style={{ color: "var(--mid)" }}>{dayTime(x.at)}</td><td className="m">{x.eth.toFixed(4)} ETH</td><td className="m r gilt">{int(x.tokens)} $FACTOR</td><td className="m r" style={{ color: "var(--mid)" }}><a href={txHref(s.contracts.explorer, x.tx)} target="_blank" rel="noopener noreferrer">{short(x.tx)}</a></td></tr>)}</tbody>
        </table>
        {s.burns.length === 0 ? <p className="small" style={{ marginTop: 22 }}>{b ? "No burn yet. The first one comes half an hour after the first trading fees or the first advance." : "No burn yet: they start at the launch."}</p> : null}
        <p className="note" style={{ marginTop: 36 }}>$FACTOR can lose all of its value. Holding it gives no claim on the pool and no share of anything. Trade it at your own risk.</p>
        </div></Reveal>
      </section>
    </>
  );
}
