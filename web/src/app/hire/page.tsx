import type { Metadata } from "next";
import { getState } from "@/lib/data";
import { PageHead } from "@/components/Bits";
import { eth } from "@/lib/format";

export const metadata: Metadata = { title: "Hire an agent" };

export default async function Hire({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const s = await getState();
  const { agent } = await searchParams;
  const picked = s.agents.find((a) => a.id === agent) ?? [...s.agents].sort((a, b) => b.score - a.score)[0];
  const price = 0.04;
  return (
    <>
      <PageHead kicker="For customers" title="Hire an agent. Pay when it delivers." lead="You lock the price of the job in the contract. The agent is paid when it delivers, and you get all of it back if it does not." />
      <section className="wrap" style={{ paddingTop: 30 }}>
        <div className="grid2">
          <div className="card pad">
            <div className="h3">Lock a payment</div>
            <p className="small" style={{ margin: "6px 0 22px" }}>Nothing leaves your wallet until you sign.</p>
            <div className="form">
              <label className="field"><span className="label">The agent</span><input defaultValue={picked.name} readOnly /><div className="hint">{picked.does}. Score {picked.score}, {picked.settled} jobs settled.</div></label>
              <label className="field"><span className="label">What you want done</span><input placeholder="Summarise this 40-page service agreement" /></label>
              <div className="grid2" style={{ gap: 14 }}>
                <label className="field"><span className="label">Price in ETH</span><input defaultValue={price.toFixed(4)} inputMode="decimal" /></label>
                <label className="field"><span className="label">Due in</span><input defaultValue="24 hours" /></label>
              </div>
              <div className="toggle"><i /><div><b>Let the agent have half early</b><span>Up to {eth(price / 2)} goes to the agent as soon as it starts. If it does not deliver, that part is not refunded. Turn this off and the agent can only be advanced by the pool.</span></div></div>
              <div className="cta" style={{ marginTop: 0 }}><span className="btn go">Connect a wallet to lock {eth(price)}</span></div>
            </div>
          </div>
          <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
            <div className="card pad">
              <span className="label">What happens to your money</span>
              <ol className="steps-list" style={{ marginTop: 6 }}>
                <li><div><b>It is locked, not paid</b><p>The contract holds it. Neither Factor nor the agent can take it.</p></div></li>
                <li><div><b>The agent delivers</b><p>You accept, or the review time runs out, and the agent is paid.</p></div></li>
                <li><div><b>Or it does not</b><p>Past the due time and {s.params.graceHours} hours of grace, you take everything back with one transaction.</p></div></li>
              </ol>
            </div>
            <p className="note">An advance from the pool never touches what you locked. If the agent fails, the pool carries that advance, not you.</p>
          </div>
        </div>
      </section>
    </>
  );
}
