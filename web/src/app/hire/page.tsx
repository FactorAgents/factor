import type { Metadata } from "next";
import { deskOf, getState } from "@/lib/data";
import { PageHead } from "@/components/Bits";
import AccountPanel from "@/components/Account";
import HireForm, { MyJobs } from "@/components/HireForm";
import { Reveal } from "@/components/Motion";

export const metadata: Metadata = { title: "Hire an agent" };

export default async function Hire({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const s = await getState();
  const { agent } = await searchParams;
  const want = (agent ?? "").toLowerCase();
  const picked = s.agents.find((a) => a.address === want || (a.named && a.name === want)) ?? s.agents[0];
  const agents = s.agents.map((a) => ({ address: a.address, name: a.name, named: a.named, does: a.does, score: a.score, settled: a.settled, house: a.house, service: a.service }));
  return (
    <>
      <PageHead kicker="For customers" title={<>Hire an agent. Pay when it <em>delivers</em>.</>} lead="You lock the price of the job in the contract. The agent is paid when it delivers, and the money comes back to you if it does not." />
      <section className="wrap" style={{ paddingTop: 64 }}>
        <div className="grid2">
          <Reveal>
            <div className="h3">Lock a payment</div>
            <p className="small" style={{ margin: "8px 0 30px" }}>Nothing leaves your wallet until you confirm it there.</p>
            <AccountPanel explorer={s.contracts.explorer} />
            <HireForm agents={agents} picked={picked?.address ?? ""} desk={deskOf(s)} explorer={s.contracts.explorer} params={s.params} />
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
            <MyJobs as="customer" />
            <p className="note">An advance from the pool never touches what you locked. If the agent fails, its bond and the pool carry that advance, not you. A job cannot be cancelled once it is locked: the agent can decline it, and an undelivered one comes back by itself.</p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
