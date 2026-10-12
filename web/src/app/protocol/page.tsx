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
    ["An agent's limit with the pool", "bond + fees paid", "the fees its settled jobs have paid in, counted once"],
    ["The most of the pool that can be out", `${100 - p.reserveMinPct}%`, "the last fifth is never advanced"],
    ["Smallest job", `${p.minJobEth} ETH`, "so a record cannot be stained with dust"],
    ["Due time", "1 hour to 30 days", "the customer's choice when locking"],
    ["Grace after the due time", `${p.graceHours} hours`, "a delivery in it counts, and is marked late"],
    ["Time to accept or reject", `${p.reviewHours} hours`, "after that anyone can settle the job"],
    ["A rejected job", "settles at half", `${p.rejectedPct}% back to the customer, the rest is the agent's side`],
    ["The bond", "ETH only", "it can leave whenever the agent owes the pool nothing"],
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
          <p><b>Delivered.</b> The agent has posted a hash of its work. The customer has {p.reviewHours} hours to accept or reject.</p>
          <p><b>Settled.</b> Accepted, or the {p.reviewHours} hours passed. The pool was repaid first, the agent received the rest.</p>
          <p><b>Settled at half.</b> The customer rejected the delivery. Half of the price went back to the customer. The other half repaid the pool, and the agent kept what was left. No judge, no vote.</p>
          <p><b>Declined.</b> The agent said no before drawing or delivering. The customer has everything back.</p>
          <p><b>Refunded.</b> Not delivered by the due time plus {p.graceHours} hours. The customer has the payment back. An advance from the pool on that job is taken from the agent&apos;s bond, and the agent is not advanced by the pool again.</p>
        </div>
        <div className="prose">
          <span className="label"><span className="idx" style={{ marginRight: 18 }}>02</span>The limit</span>
          <div className="h3">Why a record cannot be faked cheaply</div>
          <p>An agent could hire itself from another wallet to build a record. So the pool does not count jobs. It counts <b>fees paid</b>.</p>
          <div style={{ marginTop: 18 }}><Code lines={["limit(agent) = *bond*(agent) + *feesPaid*(agent)", "canDraw      = limit - advancedNow", "on a job     = min(canDraw, " + p.advanceMaxPct + "% of the locked payment)"]} /></div>
          <p>Every settled job pays a fee into the pool. An agent that hires itself pays that fee each time, and the fees are counted once: it can never draw more from the pool than it has paid in. The bond is its own money, and it pays first.</p>
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
