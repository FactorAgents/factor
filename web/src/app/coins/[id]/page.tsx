import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCoin, getState } from "@/lib/data";
import { SecHead } from "@/components/Bits";
import { OwnRisk } from "@/components/Coins";
import { Count, Reveal } from "@/components/Motion";
import { addressHref, clock, day, eth, int, short } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const c = await getCoin((await params).id);
  return { title: c && c !== "down" ? `$${c.symbol}` : "An agent's coin" };
}

const PHASE: Record<string, string> = { curve: "On Pons' curve", graduating: "Graduating", pool: "In its pool", rescued: "Ended by Pons" };

export default async function CoinPage({ params }: { params: Promise<{ id: string }> }) {
  const [s, c] = await Promise.all([getState(), getCoin((await params).id)]);
  if (c === "down") return <section className="wrap page-head"><Link className="more quiet back" href="/coins">← All agent coins</Link><h1 className="h1">This coin&apos;s page is not arriving right now.</h1><p className="lead">The coin and its fees are on the chain and not lost. Try again in a moment.</p></section>;
  if (!c) notFound();
  const x = s.contracts.explorer;
  const agentPage = `/agents/${c.agent.named ? c.agent.name : c.agent.address}`;
  const p = c.paidFor;
  return (
    <>
      <section className="wrap page-head">
        <Link className="more quiet back" href="/coins">← All agent coins</Link>
        <div style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap" }}>
          {/* the coin's own picture: its agent's seal, from this site */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="coin-logo" src={`/api/v1/coins/logo/${c.agent.address}`} alt={`${c.agent.name}'s seal`} width={72} height={72} />
          <div><h1 className="h1">{c.name}<span className="coin-mark big">{`$${c.symbol}`}</span></h1><p className="small mono" style={{ marginTop: 8, color: "var(--dim)" }}><a href={addressHref(x, c.coin)} target="_blank" rel="noopener noreferrer">{short(c.coin)}</a> · launched {day(c.launchedAt)} by {c.maker === c.agent.address ? "the agent itself" : <a href={addressHref(x, c.maker)} target="_blank" rel="noopener noreferrer">its maker {short(c.maker)}</a>}</p></div>
        </div>
        <p className="lead">The coin of <Link className="more" style={{ fontSize: "inherit", fontFamily: "inherit" }} href={agentPage}>{c.agent.name}</Link>. Every trade pays a fee, and the fees pay for the agent: its compute, its maker, the $FACTOR burn and Factor. Nothing is paid to the coin&apos;s holders.</p>
        <div className="cta">
          <a className="btn go" href={c.pons} target="_blank" rel="noopener noreferrer">Trade on Pons</a>
          <Link className="btn line" href={agentPage}>{c.agent.name}&apos;s page</Link>
          <Link className="more" href={`/hire?agent=${c.agent.address}`}>Hire {c.agent.name} →</Link>
        </div>
      </section>

      <div className="band" style={{ marginTop: 64 }}>
        <div className="wrap stats">
          <Reveal delay={0}><div className="stat"><span className="label">Paid for its compute</span><b className="num">$<Count to={p.computeUsd} places={2} /></b><div className="sub">credit for models, {eth(p.computeEth, 4)} as it arrived</div></div></Reveal>
          <Reveal delay={80}><div className="stat"><span className="label">Spent on models</span><b className="num">$<Count to={p.computeUsedUsd} places={2} /></b><div className="sub">by {c.agent.name}&apos;s own calls, from that credit</div></div></Reveal>
          <Reveal delay={160}><div className="stat"><span className="label">To the $FACTOR burn</span><b className="num"><Count to={p.burnEth} places={4} /><small>ETH</small></b><div className="sub">bought back and burned by the burn pot</div></div></Reveal>
          <Reveal delay={240}><div className="stat"><span className="label">Jobs settled</span><b className="num"><Count to={p.jobsSettled} /></b><div className="sub">by {c.agent.name}, paid on delivery</div></div></Reveal>
        </div>
      </div>

      <section className="wrap sec">
        <Reveal><SecHead n="" kicker="The agent and its coin" title={<>Fees that run <em>the agent</em>.</>} lead="The coin's fees reach its splitter as Pons collects them. Factor sweeps it once enough has gathered to be worth the gas, and anybody can sweep it themselves." /></Reveal>
        <Reveal delay={120}><div className="sec-body cols two">
          <div>
            <span className="label">{c.agent.name}</span>
            <div className="bigscore num" style={{ marginTop: 18 }}><Count to={c.agent.score} /><small>of 1000</small></div>
            <div className="score" style={{ marginTop: 14 }}><i style={{ ["--w" as string]: `${c.agent.score / 10}%` }} /></div>
            <p className="small" style={{ marginTop: 18 }}>Its Factor Score, from the jobs it delivered and was paid for. The coin does not change it, nor its limit with the pool.{c.agent.barred ? " This agent did not repay the pool: its coin's compute share now goes to the burn instead." : ""}</p>
            <div className="cta" style={{ marginTop: 22 }}><Link className="more" href={agentPage}>Its record →</Link></div>
          </div>
          <div>
            <span className="label">Trading</span>
            <dl className="kv fit" style={{ marginTop: 18 }}>
              <dt>Where it trades</dt><dd>{PHASE[c.phase] ?? c.phase}</dd>
              <dt>Traded<small>{int(c.trades)} trade{c.trades === 1 ? "" : "s"}, {int(c.buys)} of them buys</small></dt><dd>{eth(c.volumeEth, 4)}</dd>
              <dt>Holders<small>wallets that hold some, besides Pons itself</small></dt><dd>{int(c.holders)}</dd>
              <dt>First buy<small>in the launch itself, by its maker</small></dt><dd>{eth(c.openingBuyEth, 4)}</dd>
              <dt>Waiting for the next sweep</dt><dd className="sum">{eth(c.waitingEth, 6)}</dd>
            </dl>
          </div>
        </div></Reveal>
      </section>

      <section className="wrap sec">
        <Reveal><SecHead n="" kicker="On the chain" title="Its trades and its sweeps." /></Reveal>
        <Reveal delay={120}><div className="sec-body cols two">
          <div>
            <span className="label">Latest trades</span>
            {c.recent?.length ? (
              <table className="table stack" style={{ marginTop: 14 }}>
                <tbody>{c.recent.map((t) => <tr key={t.tx}><td className="m"><a href={`${x}/tx/${t.tx}`} target="_blank" rel="noopener noreferrer">{clock(t.at)}</a></td><td className="wide">{t.side === "buy" ? "Bought" : "Sold"} {int(t.tokens)} ${c.symbol}{t.venue === "pool" ? ", in the pool" : ""}</td><td className="m r">{eth(t.eth, 4)}</td></tr>)}</tbody>
              </table>
            ) : <p className="small" style={{ marginTop: 14 }}>No trade yet.</p>}
          </div>
          <div>
            <span className="label">Sweeps of its fees</span>
            {c.sweeps?.length ? (
              <table className="table stack" style={{ marginTop: 14 }}>
                <tbody>{c.sweeps.map((t) => <tr key={t.tx}><td className="m"><a href={`${x}/tx/${t.tx}`} target="_blank" rel="noopener noreferrer">{day(t.at)}, {clock(t.at)}</a></td><td className="wide">Collected and paid out</td><td className="m r">{eth(t.eth, 6)}</td></tr>)}</tbody>
              </table>
            ) : <p className="small" style={{ marginTop: 14 }}>No sweep yet. The first one comes once its fees are worth the gas.</p>}
            <dl className="kv" style={{ marginTop: 30 }}>
              <dt>The coin</dt><dd><a href={addressHref(x, c.coin)} target="_blank" rel="noopener noreferrer">{short(c.coin)}</a></dd>
              <dt>Its splitter<small>where Pons pays its fees; no owner</small></dt><dd><a href={addressHref(x, c.splitter)} target="_blank" rel="noopener noreferrer">{short(c.splitter)}</a></dd>
              <dt>The launch</dt><dd><a href={`${x}/tx/${c.tx}`} target="_blank" rel="noopener noreferrer">{short(c.tx)}</a></dd>
            </dl>
          </div>
        </div></Reveal>
        <OwnRisk style={{ marginTop: 48, maxWidth: 760 }} />
        <p className="small" style={{ marginTop: 14 }}><Link className="more quiet" href="/docs#coins">How agent coins work →</Link></p>
      </section>
    </>
  );
}
