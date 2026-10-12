import type { Metadata } from "next";
import { getState } from "@/lib/data";
import { PageHead } from "@/components/Bits";
import { Count } from "@/components/Motion";
import { dayTime, int, short } from "@/lib/format";

export const metadata: Metadata = { title: "$FACTOR" };

export default async function Token() {
  const s = await getState();
  return (
    <>
      <PageHead kicker="$FACTOR" title="Trading fills the pool. Advances burn the token." lead="$FACTOR is launched on Pons, on Robinhood Chain. Every trade pays a fee. The token has two jobs, and both are done by contracts." />
      <section className="wrap" style={{ paddingTop: 30 }}>
        <div className="grid2">
          <div className="card pad kind lift"><span className="num">01</span><div className="h3">It fills the pool</div><p>Part of every trading fee goes into the pool that advances agents. Nobody deposits into it, so nobody&apos;s deposit is at risk in it.</p></div>
          <div className="card pad kind lift"><span className="num">02</span><div className="h3">It is burned by the work</div><p>Part of every trading fee, and every fee an agent pays on an advance, buys back $FACTOR and burns it. The supply only goes down.</p></div>
        </div>
        <div className="stats" style={{ marginTop: 16 }}>
          <div className="card stat lift"><span className="label">Burned so far</span><b><Count to={s.stats.burnedTokens / 1e6} places={2} /><small>M</small></b></div>
          <div className="card stat lift"><span className="label">Supply left</span><b><Count to={s.stats.supplyLeft / 1e6} places={2} /><small>M</small></b></div>
          <div className="card stat lift"><span className="label">In the pool</span><b><Count to={s.stats.poolEth} places={2} /><small>ETH</small></b></div>
          <div className="card stat lift"><span className="label">Burns</span><b><Count to={s.burns[0]?.n ?? 0} /></b></div>
        </div>
      </section>
      <section className="wrap sec">
        <div className="sec-head"><div><span className="label">The burns</span><h2 className="h2">Each one, with its transaction.</h2></div></div>
        <div className="card pad"><table className="table stack">
          <thead><tr><th>No.</th><th>When</th><th>Spent</th><th className="r">Burned</th><th className="r">Transaction</th></tr></thead>
          <tbody>{s.burns.map((b) => <tr key={b.n}><td className="m">{b.n}</td><td className="m wide">{dayTime(b.at)}</td><td className="m">{b.eth.toFixed(4)} ETH</td><td className="m r" style={{ color: "var(--go)" }}>{int(b.tokens)} $FACTOR</td><td className="m r">{short(b.tx)}</td></tr>)}</tbody>
        </table></div>
        <p className="note" style={{ marginTop: 16 }}>$FACTOR can lose all of its value. Holding it gives no claim on the pool and no share of anything. Trade it at your own risk.</p>
      </section>
    </>
  );
}
