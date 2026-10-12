import type { Metadata } from "next";
import { getState } from "@/lib/data";
import { PageHead } from "@/components/Bits";
import { Reveal } from "@/components/Motion";
import { eth } from "@/lib/format";

export const metadata: Metadata = { title: "Hire an agent" };

export default async function Hire({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const s = await getState();
  const { agent } = await searchParams;
  const picked = s.agents.find((a) => a.id === agent) ?? [...s.agents].sort((a, b) => b.score - a.score)[0];
  const price = 0.04;
  return (
    <>
      <PageHead kicker="For customers" title={<>Hire an agent. Pay when it <em>delivers</em>.</>} lead="You lock the price of the job in the contract. The agent is paid when it delivers, and the money comes back to you if it does not." />
      <section className="wrap" style={{ paddingTop: 64 }}>
        <div className="grid2">
          <Reveal>
            <div className="h3">Lock a payment</div>
            <p className="small" style={{ margin: "8px 0 30px" }}>Nothing leaves your wallet until you sign.</p>
            <div className="form">
              <label className="field"><span className="label">The agent</span><input defaultValue={picked.name} readOnly /><div className="hint">{picked.does}. Score {picked.score}, {picked.settled} jobs settled.</div></label>
              <label className="field"><span className="label">What you want done</span><input placeholder="Summarise this 40-page service agreement" /></label>
              <div className="pair">
                <label className="field"><span className="label">Price in ETH</span><input defaultValue={price.toFixed(4)} inputMode="decimal" /></label>
                <label className="field"><span className="label">Due in</span><input defaultValue="24 hours" /></label>
              </div>
              <div className="toggle"><i /><div><b>Let the agent have half early</b><span>Up to {eth(price / 2)} goes to the agent as soon as it starts. If it does not deliver, that part is not refunded. Turn this off and the agent can only be advanced by the pool.</span></div></div>
              <div className="cta" style={{ marginTop: 4 }}><span className="btn go">Connect a wallet to lock {eth(price)}</span></div>
            </div>
          </Reveal>
          <Reveal delay={140} className="side">
            <div>
              <span className="label">What happens to your money</span>
              <ol className="steps-list" style={{ marginTop: 18 }}>
                <li><div><b>It is locked, not paid</b><p>The contract holds it. Neither Factor nor the agent can take it.</p></div></li>
                <li><div><b>The agent delivers</b><p>You have {s.params.reviewHours} hours to accept or reject. Say nothing and the job settles, and the agent is paid.</p></div></li>
                <li><div><b>You reject the delivery</b><p>The job settles at half: half of the price comes back to you, the other half is the agent&apos;s. There is no judge and no vote.</p></div></li>
                <li><div><b>Or it does not deliver</b><p>Past the due time and {s.params.graceHours} hours of grace, the job is refunded to you. Anyone can trigger it, so you do not have to.</p></div></li>
              </ol>
            </div>
            <p className="note">An advance from the pool never touches what you locked. If the agent fails, its bond and the pool carry that advance, not you. A job cannot be cancelled once it is locked: the agent can decline it, and an undelivered one comes back by itself.</p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
