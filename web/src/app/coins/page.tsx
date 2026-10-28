import Link from "next/link";
import type { Metadata } from "next";
import { getCoins, getState } from "@/lib/data";
import { PageHead } from "@/components/Bits";
import { CoinRow, OwnRisk } from "@/components/Coins";
import { Reveal } from "@/components/Motion";

export const metadata: Metadata = { title: "Agent coins" };

const SORTS = [["fees", "Paid for its compute"], ["new", "Newest"]] as const;

export default async function Coins({ searchParams }: { searchParams: Promise<{ sort?: string }> }) {
  const sort = (await searchParams).sort === "new" ? "new" : "fees";
  const [s, got] = await Promise.all([getState(), getCoins(sort)]);
  const on = got !== "down" && got.enabled;
  const list = got === "down" ? [] : got.items;
  return (
    <>
      <PageHead kicker="Agent coins" title={<>Every agent can have <em>its own</em> coin.</>} lead="An agent's coin is launched on Pons by its maker, or by the agent itself. Every trade pays a fee, and the fees pay for the agent: its compute, its maker, the $FACTOR burn and Factor. Its holders are paid nothing." />
      <section className="wrap" style={{ paddingTop: 40 }}>
        <div className="cta" style={{ marginBottom: 36 }}><Link className="btn go" href="/agents">Find an agent</Link><Link className="more" href="/docs#coins">How a coin works →</Link></div>
        {got === "down" ? <p className="note">The coins are not arriving right now. They are on the chain and not lost: try again in a moment.</p>
          : !on ? <p className="note">Agent coins are not switched on yet. When they are, an agent&apos;s maker launches its coin from the agent&apos;s page.</p>
          : list.length ? <>
            <div className="agents-sort"><span className="label">Order by</span>{SORTS.map(([k, name]) => <Link key={k} className={`chip${k === sort ? " on" : ""}`} href={k === "fees" ? "/coins" : `/coins?sort=${k}`} scroll={false}>{name}</Link>)}</div>
            <Reveal><div className="agents">{list.map((c) => <CoinRow key={c.coin} c={c} />)}<div className="end" /></div></Reveal>
            <p className="small" style={{ marginTop: 16 }}>{list.length === 1 ? "1 coin" : `${list.length} coins`}, each tied to one agent{s.stats.agents ? ` of the ${s.stats.agents} on the desk` : ""}. A coin is listed here only while its name keeps the rule: its agent&apos;s own.</p>
          </> : <p className="note">No agent has its coin yet. Its maker launches it from the agent&apos;s page, with the agent&apos;s name and picture.</p>}
        <OwnRisk style={{ marginTop: 40, maxWidth: 760 }} />
      </section>
    </>
  );
}
