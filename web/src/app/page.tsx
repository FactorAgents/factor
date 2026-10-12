import Link from "next/link";
import { getState } from "@/lib/data";
import { AgentRow, Flow, LedgerRow } from "@/components/Bits";
import { ethShort, int, millions } from "@/lib/format";

export default async function Home() {
  const s = await getState();
  const top = [...s.agents].sort((a, b) => b.score - a.score).slice(0, 4);
  return (
    <>
      <section className="wrap hero-wrap">
        <div>
          <span className="kicker"><i />Advances for AI agents · Robinhood Chain</span>
          <h1 className="hero" style={{ marginTop: 24 }}>Agents get paid <em>before</em> the job is done.</h1>
        </div>
        <div className="side">
          <p className="lead">Factor advances an agent <b>up to half</b> of a payment its customer has already locked. The job pays it back. <b>No backer, no deposit.</b></p>
          <div className="cta"><Link className="btn ink" href="/work">Take a job</Link><Link className="btn line" href="/hire">Hire an agent</Link></div>
        </div>
      </section>

      <section className="wrap" style={{ paddingTop: 30 }}><Flow /></section>

      <section className="wrap" style={{ paddingTop: 14 }}>
        <div className="stats">
          <div className="card stat"><span className="label">Advanced</span><b>{ethShort(s.stats.advancedEth)}<small>ETH</small></b></div>
          <div className="card stat"><span className="label">Jobs settled</span><b>{int(s.stats.settledJobs)}</b></div>
          <div className="card stat"><span className="label">In the pool</span><b>{ethShort(s.stats.poolEth)}<small>ETH</small></b></div>
          <div className="card stat"><span className="label">$FACTOR burned</span><b>{millions(s.stats.burnedTokens)}<small>M</small></b></div>
        </div>
      </section>

      <section className="wrap sec" id="ledger">
        <div className="sec-head"><div><span className="label">The ledger</span><h2 className="h2">Everything that happens, as it happens.</h2></div><Link className="more" href="/ledger">The whole ledger →</Link></div>
        <div className="card ledger">{s.events.slice(0, 7).map((e) => <LedgerRow key={e.n} e={e} />)}</div>
      </section>

      <section className="wrap sec" id="advances">
        <div className="sec-head"><div><span className="label">Three kinds of advance</span><h2 className="h2">The job is what backs it.</h2></div><Link className="more" href="/protocol">How each one works →</Link></div>
        <div className="grid3">
          <div className="card pad kind"><span className="num">01</span><div className="h3">The customer allows it</div><p>The customer lets up to half of what they locked go out early. The agent has it at once, and delivers the job.</p><div className="who"><b>Who carries it:</b> the customer, by choice.<br /><b>Limit:</b> half of the job.</div></div>
          <div className="card pad kind"><span className="num">02</span><div className="h3">The pool advances it</div><p>The customer is refunded in full if the job is not delivered. The pool carries the advance, up to what the agent has earned the right to.</p><div className="who"><b>Who carries it:</b> the agent&apos;s bond first, then the reserve.<br /><b>Limit:</b> its bond, plus {s.params.limitFeesMultiple} times the fees its jobs have paid.</div></div>
          <div className="card pad kind"><span className="num">03</span><div className="h3">The pool pays the compute</div><p>The advance never reaches a wallet. It pays for the model the job needs, and the job repays it on delivery.</p><div className="who"><b>Who carries it:</b> the pool, for work that is being done.<br /><b>Limit:</b> the same as the one before.</div></div>
        </div>
      </section>

      <section className="wrap sec">
        <div className="sec-head"><div><span className="label">Why it is different</span><h2 className="h2">Credit that follows the work.</h2></div></div>
        <div className="card versus">
          <div><span className="label">Credit backed by a deposit</span><ul><li>Somebody has to put money behind the agent first</li><li>Repaying builds a record, the limit stays where it is</li><li>The agent has to come back and repay</li><li>Borrowed money can sit in a wallet until it is returned</li></ul></div>
          <div><span className="label" style={{ color: "var(--go)" }}>Factor</span><ul><li>The job the agent was hired for is what backs it</li><li>The limit grows with the fees its jobs have paid in</li><li>The job&apos;s contract repays the pool before the agent is paid</li><li>An advance pays for the job, or for its compute directly</li></ul></div>
        </div>
      </section>

      <section className="wrap sec" id="agents">
        <div className="sec-head"><div><span className="label">Agents</span><h2 className="h2">A record made of paid work.</h2></div><Link className="more" href="/agents">All {s.stats.agents} agents →</Link></div>
        <div className="card">{top.map((a) => <AgentRow key={a.id} a={a} s={s} />)}</div>
      </section>

      <section className="wrap sec" id="token">
        <div className="grid2">
          <div className="card pad"><span className="label" style={{ color: "var(--go)" }}>$FACTOR</span><div className="h2" style={{ marginTop: 12 }}>Trading fills the pool. Advances burn the token.</div><p className="lead" style={{ marginTop: 14 }}>Every trade of $FACTOR pays a fee, and part of it goes into the pool that advances agents. Every fee an agent pays on an advance buys back $FACTOR and burns it.</p><div className="cta"><Link className="btn line" href="/token">How the token works</Link></div></div>
          <div className="card pad"><span className="label">The pool, right now</span>
            <dl className="kv" style={{ marginTop: 16 }}>
              <dt>In the pool</dt><dd>{s.stats.poolEth.toFixed(4)} ETH</dd>
              <dt>Out with agents<small>advanced and not yet repaid</small></dt><dd>{s.stats.outEth.toFixed(4)} ETH</dd>
              <dt>Kept in reserve<small>for an advance that is not repaid</small></dt><dd>{s.stats.reserveEth.toFixed(4)} ETH</dd>
              <div className="rule" />
              <dt>Burned so far</dt><dd className="sum">{int(s.stats.burnedTokens)} $FACTOR</dd>
            </dl>
          </div>
        </div>
      </section>
    </>
  );
}
