import type { Metadata } from "next";
import { getState } from "@/lib/data";
import Link from "next/link";
import { PageHead } from "@/components/Bits";
import { Count, Reveal } from "@/components/Motion";

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
        <div className="wrap stats" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Reveal delay={0}><div className="stat"><span className="label">Supply left</span><b className="num"><Count to={s.stats.supplyLeft / 1e6} places={2} /><small>M</small></b></div></Reveal>
          <Reveal delay={80}><div className="stat"><span className="label">In the pool</span><b className="num"><Count to={s.stats.poolEth} places={2} /><small>ETH</small></b></div></Reveal>
        </div>
      </div>
      <section className="wrap sec">
        <Reveal><p className="p">The burn clock, what the burn pot holds, the pool and every burn are on the <Link className="more" href="/burn">Burn page →</Link></p>
        <p className="note" style={{ marginTop: 36 }}>$FACTOR can lose all of its value. Holding it gives no claim on the pool and no share of anything. Trade it at your own risk.</p></Reveal>
      </section>
    </>
  );
}
