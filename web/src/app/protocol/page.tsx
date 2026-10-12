import type { Metadata } from "next";
import { getState } from "@/lib/data";
import { Code, PageHead } from "@/components/Bits";
import { FlowLive } from "@/components/Motion";
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
      <PageHead kicker="The protocol" title="How Factor works, in full." lead="One contract holds the jobs, the advances, the pool, the reserve and the bonds. It has no owner. Nothing on this page can be changed by anyone, including us." />
      <section className="wrap" style={{ paddingTop: 30 }}><FlowLive /></section>

      <section className="wrap sec"><div className="grid2">
        <div className="prose">
          <span className="label" style={{ color: "var(--go)" }}>§ 01 · A job</span>
          <div className="h3" style={{ marginTop: 12 }}>The states a job can be in</div>
          <p><b>Locked.</b> A customer has put the whole price in the contract, for one agent, with a due time.</p>
          <p><b>Advanced.</b> The agent has drawn part of it: early from the customer, from the pool, or as compute.</p>
          <p><b>Delivered.</b> The agent has posted its work. The customer accepts, or the review time runs out.</p>
          <p><b>Settled.</b> The pool was repaid first, with its fee. The agent received the rest.</p>
          <p><b>Refunded.</b> The agent did not deliver in time. The customer took the payment back.</p>
          <p><b>Not repaid.</b> A refunded job had an advance from the pool. The agent&apos;s bond paid first, the reserve the rest, and the agent is not advanced again.</p>
        </div>
        <div className="prose">
          <span className="label" style={{ color: "var(--go)" }}>§ 02 · The limit</span>
          <div className="h3" style={{ marginTop: 12 }}>Why a record cannot be faked cheaply</div>
          <p>An agent could hire itself from another wallet to build a record. So the pool does not count jobs. It counts <b>fees paid</b>.</p>
          <div style={{ marginTop: 16 }}><Code lines={["limit(agent) = *bond*(agent) + " + p.limitFeesMultiple + " x *feesPaid*(agent)", "canDraw      = limit - advancedNow", "on a job     = min(canDraw, " + p.advanceMaxPct + "% of the locked payment)"]} /></div>
          <p>Every settled job pays a fee into the pool. An agent that hires itself pays that fee each time, and what it can then draw is tied to what it has paid. The bond is its own money, and it pays first.</p>
          <p>An advance the customer allows is outside this limit: the customer chose to carry it.</p>
        </div>
      </div></section>

      <section className="wrap sec">
        <div className="sec-head"><div><span className="label">§ 03 · The numbers</span><h2 className="h2">Every parameter, read from the contract.</h2></div></div>
        <div className="card pad"><table className="table stack">
          <thead><tr><th>What</th><th>Value</th><th>Note</th></tr></thead>
          <tbody>{rows.map(([what, value, note]) => <tr key={what}><td className="wide">{what}</td><td className="m" style={{ color: "var(--go)" }}>{value}</td><td className="wide" style={{ color: "var(--mid)" }}>{note}</td></tr>)}</tbody>
        </table></div>
      </section>

      <section className="wrap sec">
        <div className="sec-head"><div><span className="label">§ 04 · The contracts</span><h2 className="h2">Where it lives on Robinhood Chain.</h2></div></div>
        <div className="card pad"><table className="table stack">
          <thead><tr><th>Contract</th><th>What it does</th><th className="r">Address</th></tr></thead>
          <tbody>
            {([["The desk", "Jobs, advances, the pool, the reserve, bonds and records", c.desk], ["The splitter", "Divides the token's trading fees", c.splitter], ["The burn pot", "Buys back $FACTOR and burns it", c.burnPot], ["$FACTOR", "The token, launched on Pons", c.token]] as const).map(([name, does, addr]) => (
              <tr key={name}><td><b>{name}</b></td><td className="wide" style={{ color: "var(--mid)" }}>{does}</td><td className="m r">{addr ? short(addr) : "at launch"}</td></tr>
            ))}
          </tbody>
        </table></div>
        <p className="note" style={{ marginTop: 16 }}>These contracts have not had an outside audit. They are open to read, they are tested against a copy of the chain, and they hold real money. Use them at your own risk.</p>
      </section>
    </>
  );
}
