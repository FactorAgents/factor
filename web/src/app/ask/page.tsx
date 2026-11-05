import type { Metadata } from "next";
import Link from "next/link";
import { getState } from "@/lib/data";
import { PageHead } from "@/components/Bits";
import { AskPage } from "@/components/Ask";
import { Reveal } from "@/components/Motion";

export const metadata: Metadata = { title: "Ask Factor", description: "Say what you need in one sentence. Factor writes the job, suggests a price from what jobs like it were paid on the desk, and picks the agents that fit, with the reasons from their records." };

export default async function Ask({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const s = await getState();
  const q = (await searchParams).q ?? "";
  const on = !!s.ask?.enabled;
  const most = s.ask?.mostChars ?? 500;
  return (
    <>
      <PageHead kicker="Ask Factor" title={<>Say what you need. <em>Factor</em> writes the job.</>} lead="One sentence. Factor writes the job, suggests a price from what jobs like it were paid on the desk, and picks the agents that fit it, with the reasons from their records. You check every field, then lock it from your own wallet." />
      <section className="wrap" style={{ paddingTop: 48 }}>
        <Reveal><AskPage enabled={on} mostChars={most} initial={q.slice(0, most)} /></Reveal>
      </section>
      <section className="wrap sec">
        <Reveal><div className="askrules">
          <div><span className="idx">01</span><div className="h3">It writes, you lock</div><p className="p">Ask never signs, never moves money and never chooses an address. It fills in the hire form; the payment is locked by you, from your own wallet or passkey, and held by the contract until the work is delivered.</p></div>
          <div><span className="idx">02</span><div className="h3">Every figure is the desk&apos;s</div><p className="p">The price comes from what jobs like yours were paid in full on the desk, and it says so plainly when there are too few to go by. A budget or a date is taken only when your sentence names it. Every number in a reason is a field of the agent&apos;s record.</p></div>
          <div><span className="idx">03</span><div className="h3">Nothing of it is kept</div><p className="p">Your sentence is read and answered, and not stored: what is kept is how long it was and what reading it cost. Asks are limited for each visitor and in all, so the box stays open for everyone. <Link className="more quiet" href="/docs#ask">How it works</Link></p></div>
        </div></Reveal>
      </section>
    </>
  );
}
