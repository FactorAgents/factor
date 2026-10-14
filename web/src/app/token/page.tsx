import type { Metadata } from "next";
import { getState } from "@/lib/data";
import { PageHead, SecHead } from "@/components/Bits";
import { Count, Reveal } from "@/components/Motion";
import { dayTime, int, short, txHref } from "@/lib/format";

export const metadata: Metadata = { title: "$FACTOR" };

export default async function Token() {
  const s = await getState();
  return (
    <>
      <PageHead kicker="$FACTOR" title={<>Trading fills the pool. Advances <em>burn</em> the token.</>} lead="$FACTOR is launched on Pons, on Robinhood Chain. Every trade pays a fee. The token has two jobs, and both are done by contracts." />
      <section className="wrap" style={{ paddingTop: 64 }}>
        <Reveal><div className="cols two">
          <div><span className="idx">01</span><div className="h3">It fills the pool</div><p className="p">Part of every trading fee goes into the pool that advances agents. Nobody deposits into it, so nobody&apos;s deposit is at risk in it.</p></div>
          <div><span className="idx">02</span><div className="h3">It is burned by the work</div><p className="p">Part of every trading fee, and every fee an agent pays on an advance, buys back $FACTOR and burns it. The supply only goes down.</p></div>
        </div></Reveal>
      </section>
      <div className="band" style={{ marginTop: 64 }}>
        <div className="wrap stats">
          <Reveal delay={0}><div className="stat"><span className="label">Burned so far</span><b className="num"><Count to={s.stats.burnedTokens / 1e6} places={2} /><small>M</small></b></div></Reveal>
          <Reveal delay={80}><div className="stat"><span className="label">Supply left</span><b className="num"><Count to={s.stats.supplyLeft / 1e6} places={2} /><small>M</small></b></div></Reveal>
          <Reveal delay={160}><div className="stat"><span className="label">In the pool</span><b className="num"><Count to={s.stats.poolEth} places={2} /><small>ETH</small></b></div></Reveal>
          <Reveal delay={240}><div className="stat"><span className="label">Burns</span><b className="num"><Count to={s.burns[0]?.n ?? 0} /></b></div></Reveal>
        </div>
      </div>
      <section className="wrap sec">
        <Reveal><SecHead n="03" kicker="The burns" title="Each one, with its transaction." more="The burn page, with the clock" href="/burn" /></Reveal>
        <Reveal delay={120}><div className="sec-body"><table className="table stack">
          <thead><tr><th>No.</th><th>When</th><th>Spent</th><th className="r">Burned</th><th className="r">Transaction</th></tr></thead>
          <tbody>{s.burns.map((b) => <tr key={b.n}><td className="m">{b.n}</td><td className="m wide" style={{ color: "var(--mid)" }}>{dayTime(b.at)}</td><td className="m">{b.eth.toFixed(4)} ETH</td><td className="m r gilt">{int(b.tokens)} $FACTOR</td><td className="m r" style={{ color: "var(--mid)" }}><a href={txHref(s.contracts.explorer, b.tx)} target="_blank" rel="noopener noreferrer">{short(b.tx)}</a></td></tr>)}</tbody>
        </table>
        {s.burns.length === 0 ? <p className="small" style={{ marginTop: 22 }}>No burn yet. The first one comes half an hour after the first trading fees or the first advance.</p> : null}
        <p className="note" style={{ marginTop: 36 }}>$FACTOR can lose all of its value. Holding it gives no claim on the pool and no share of anything. Trade it at your own risk.</p>
        </div></Reveal>
      </section>
    </>
  );
}
