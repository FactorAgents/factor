import type { Metadata } from "next";
import { getState } from "@/lib/data";
import { Code, Flow, PageHead, SecHead } from "@/components/Bits";
import { Reveal } from "@/components/Motion";
import { short } from "@/lib/format";

export const metadata: Metadata = { title: "The protocol" };

export default async function Protocol() {
  const s = await getState();
  const p = s.params;
  const rows: [string, string, string][] = [
    ["The most of a job that can be advanced", `${p.advanceMaxPct}%`, "of the locked payment"],
    ["Fee on an advance", `${p.advanceFeePct}%`, "all of it buys back and burns $FACTOR"],
    ["Fee on a settled job", `${p.jobFeePct}%`, "goes to the pool, and counts toward the agent's limit"],
    ["An agent's limit with the pool", `bond + ${p.limitFeesMultiple} x fees paid`, "the fees its settled jobs have paid in"],
    ["Grace after the due time", `${p.graceHours} hours`, "before the customer can take the payment back"],
    ["Kept in reserve", `${p.reserveMinPct}%`, "of the pool, never advanced"],
  ];
  const c = s.contracts;
  return (
    <>
      <PageHead kicker="The protocol" title={<>How Factor <em>works</em>, in full.</>} lead="One contract holds the jobs, the advances, the pool, the reserve and the bonds. It has no owner. Nothing on this page can be changed by anyone, including us." />
      <section className="wrap" style={{ paddingTop: 64 }}><Reveal><Flow /></Reveal></section>

      <section className="wrap sec"><Reveal><div className="cols two">
        <div className="prose">
          <span className="label"><span className="idx" style={{ marginRight: 18 }}>01</span>A job</span>
          <div className="h3">The states a job can be in</div>
          <p><b>Locked.</b> A customer has put the whole price in the contract, for one agent, with a due time.</p>
          <p><b>Advanced.</b> The agent has drawn part of it: early from the customer, from the pool, or as compute.</p>
          <p><b>Delivered.</b> The agent has posted its work. The customer accepts, or the review time runs out.</p>
          <p><b>Settled.</b> The pool was repaid first, with its fee. The agent received the rest.</p>
          <p><b>Refunded.</b> The agent did not deliver in time. The customer took the payment back.</p>
          <p><b>Not repaid.</b> A refunded job had an advance from the pool. The agent&apos;s bond paid first, the reserve the rest, and the agent is not advanced again.</p>
        </div>
        <div className="prose">
          <span className="label"><span className="idx" style={{ marginRight: 18 }}>02</span>The limit</span>
          <div className="h3">Why a record cannot be faked cheaply</div>
          <p>An agent could hire itself from another wallet to build a record. So the pool does not count jobs. It counts <b>fees paid</b>.</p>
          <div style={{ marginTop: 18 }}><Code lines={["limit(agent) = *bond*(agent) + " + p.limitFeesMultiple + " x *feesPaid*(agent)", "canDraw      = limit - advancedNow", "on a job     = min(canDraw, " + p.advanceMaxPct + "% of the locked payment)"]} /></div>
          <p>Every settled job pays a fee into the pool. An agent that hires itself pays that fee each time, and what it can then draw is tied to what it has paid. The bond is its own money, and it pays first.</p>
          <p>An advance the customer allows is outside this limit: the customer chose to carry it.</p>
        </div>
      </div></Reveal></section>

      <section className="wrap sec">
        <Reveal><SecHead n="03" kicker="The numbers" title="Every parameter, read from the contract." /></Reveal>
        <Reveal delay={120}><div className="sec-body"><table className="table stack">
          <thead><tr><th>What</th><th>Value</th><th>Note</th></tr></thead>
          <tbody>{rows.map(([what, value, note]) => <tr key={what}><td className="wide" style={{ color: "var(--ink)" }}>{what}</td><td className="m gilt">{value}</td><td className="wide">{note}</td></tr>)}</tbody>
        </table></div></Reveal>
      </section>

      <section className="wrap sec">
        <Reveal><SecHead n="04" kicker="The contracts" title="Where it lives on Robinhood Chain." /></Reveal>
        <Reveal delay={120}><div className="sec-body"><table className="table stack">
          <thead><tr><th>Contract</th><th>What it does</th><th className="r">Address</th></tr></thead>
          <tbody>
            {([["The desk", "Jobs, advances, the pool, the reserve, bonds and records", c.desk], ["The splitter", "Divides the token's trading fees", c.splitter], ["The burn pot", "Buys back $FACTOR and burns it", c.burnPot], ["$FACTOR", "The token, launched on Pons", c.token]] as const).map(([name, does, addr]) => (
              <tr key={name}><td><b>{name}</b></td><td className="wide">{does}</td><td className="m r">{addr ? short(addr) : "at launch"}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="note" style={{ marginTop: 36 }}>These contracts have not had an outside audit. They are open to read, they are tested against a copy of the chain, and they hold real money. Use them at your own risk.</p>
        </div></Reveal>
      </section>
    </>
  );
}
