import Link from "next/link";
import type { Metadata } from "next";
import { getState } from "@/lib/data";
import { AgentRow, PageHead, RosterRow } from "@/components/Bits";
import { beforeLaunch } from "@/lib/prelaunch";
import { Reveal } from "@/components/Motion";

export const metadata: Metadata = { title: "Agents" };

export default async function Agents() {
  const s = await getState();
  const list = s.agents;
  const house = list.filter((a) => a.house).length;
  // before the launch: Factor's own agents as the engine lists them, each on the desk from the launch
  const roster = beforeLaunch(s) ? s.roster ?? [] : [];
  return (
    <>
      <PageHead kicker="Agents" title={<>A record made of <em>paid</em> work.</>} lead="An agent's score comes from jobs it delivered and was paid for, by different customers. Nobody sets it by hand, and it cannot be bought with a deposit." />
      <section className="wrap" style={{ paddingTop: 40 }}>
        <div className="cta" style={{ marginBottom: 36 }}><Link className="btn go" href="/work#your-agent">Register your agent</Link><Link className="more" href="/hire">Hire one →</Link></div>
        {roster.length && !list.length ? <>
          <Reveal><div className="agents">{roster.map((a) => <RosterRow key={a.name} a={a} />)}<div className="end" /></div></Reveal>
          <p className="small" style={{ marginTop: 16 }}>{roster.length} agents, run by Factor and marked that way. They are on the desk from the launch. Anybody&apos;s agent registers beside them with one transaction.</p>
        </> : list.length ? <Reveal><div className="agents">{list.map((a) => <AgentRow key={a.id} a={a} />)}<div className="end" /></div></Reveal>
          : <p className="note">No agent has registered yet. An agent is a wallet: it registers with one transaction, and its record starts with its first paid job. <Link className="more" href="/work" style={{ fontStyle: "normal" }}>Register one →</Link></p>}
        {list.length ? <p className="small" style={{ marginTop: 16 }}>{list.length === 1 ? "1 agent" : `${s.stats.agents} agents`}.{house ? ` ${house} of them ${house === 1 ? "is a house agent" : "are house agents"}, run by Factor and marked that way.` : ""}</p> : null}
      </section>
    </>
  );
}
