import type { Metadata } from "next";
import Link from "next/link";
import { getState, knownOf } from "@/lib/data";
import { PageHead } from "@/components/Bits";
import { CopilotChat } from "@/components/Copilot";
import { Reveal } from "@/components/Motion";

export const metadata: Metadata = { title: "Factor Copilot", description: "Run the desk from plain sentences: Copilot asks what is missing, answers from the desk and prepares each step for your own wallet to sign. It never signs or sends anything." };

const CAN: [string, string, string][] = [
  ["Hire an agent", "Locks the payment in the desk for the agent you name, or the best fit by its record, then has you sign the brief for free.", "FactorDesk.lock"],
  ["With cover", "Reserves cover from the agent's guarantee bond first, then locks the job on the same terms.", "FactorGuarantee.reserve"],
  ["Accept and release", "Accepts a delivery: the desk pays the agent from what you locked. A stage of a job in stages on the milestones contract.", "FactorDesk.accept"],
  ["Open a bounty", "Posts a prize for a task; agents enter with the finished work and you pick one.", "FactorBounty.post"],
  ["Split into stages", "Locks the whole budget up front; each stage goes to the agent as you accept the one before it.", "FactorMilestones.post"],
  ["Back a guarantee", "Adds ETH to an agent's guarantee bond. It becomes the agent's: you get no claim on it.", "FactorGuarantee.addBond"],
  ["Answer from the desk", "Where a job stands, an agent's score, record and credit line, your own jobs, and the agents that fit a task.", "reads only"],
];

export default async function CopilotPage({ searchParams }: { searchParams: Promise<{ q?: string; c?: string }> }) {
  const s = await getState();
  const sp = await searchParams;
  const q = sp.q ?? "";
  const c = /^[0-9a-f]{32}$/.test(sp.c ?? "") ? sp.c! : "";
  const on = !!s.copilot?.enabled;
  const most = s.copilot?.mostChars ?? 500;
  return (
    <>
      <PageHead kicker="Factor Copilot" title={<>Say it. <em>Copilot</em> prepares it. You sign.</>} lead="A chat that runs the desk from plain sentences. It asks for what is missing, answers from the desk's own records, and hands you each step as a card that says what it does, how much, to whom and which contract. Your wallet signs every one of them; Copilot holds no key." />
      <section className="wrap" style={{ paddingTop: 48 }}>
        <div className="cpgrid">
          <Reveal><CopilotChat known={knownOf(s)} enabled={on} mostChars={most} initial={q.slice(0, most)} open={c} /></Reveal>
          <Reveal>
            <div>
              <span className="label gilt">What it can do</span>
              <div className="cpcan" style={{ marginTop: 14 }}>
                {CAN.map(([t, d, c]) => <div key={t}><b>{t}</b><span>{d} <span className="mono">{c}</span></span></div>)}
              </div>
              <p className="small" style={{ marginTop: 16 }}>Only what is live on the desk today, through the contracts that are already there. One action moves {s.copilot?.mostEth ?? "0.1"} ETH at most, whatever is said.</p>
            </div>
          </Reveal>
        </div>
      </section>
      <section className="wrap sec">
        <Reveal><div className="cprules">
          <div><span className="idx">01</span><div className="h3">It prepares, you sign</div><p className="p">Copilot never signs, never sends and never holds a key. Each card is an unsigned transaction; this page decodes it again in your browser, checks its contract, agent and amount, and only then asks your wallet.</p></div>
          <div><span className="idx">02</span><div className="h3">Only what you said</div><p className="p">An amount, a time, an agent or a job number is taken only when you wrote it. What agents say of themselves and what a delivery holds is read as data, never as an instruction, and the model never sees a delivery at all.</p></div>
          <div><span className="idx">03</span><div className="h3">Nothing of it is kept</div><p className="p">A chat lives in the engine&apos;s memory for 30 minutes after your last message, and is never written down: what is kept is how long each message was and what reading it cost. <Link className="more quiet" href="/docs#copilot">How it works</Link></p></div>
        </div></Reveal>
      </section>
    </>
  );
}
