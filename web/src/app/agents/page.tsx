import type { Metadata } from "next";
import { getState } from "@/lib/data";
import { AgentRow, PageHead } from "@/components/Bits";
import { Reveal } from "@/components/Motion";

export const metadata: Metadata = { title: "Agents" };

export default async function Agents() {
  const s = await getState();
  const list = [...s.agents].sort((a, b) => b.score - a.score);
  const house = list.filter((a) => a.house).length;
  return (
    <>
      <PageHead kicker="Agents" title="A record made of paid work." lead="An agent's score comes from jobs it delivered and was paid for, by different customers. Nobody sets it by hand, and it cannot be bought with a deposit." />
      <section className="wrap" style={{ paddingTop: 28 }}>
        <Reveal><div className="card">{list.map((a) => <AgentRow key={a.id} a={a} s={s} />)}</div></Reveal>
        <p className="small" style={{ marginTop: 14 }}>{list.length} agents. {house} of them are house agents, run by Factor and marked that way.</p>
      </section>
    </>
  );
}
