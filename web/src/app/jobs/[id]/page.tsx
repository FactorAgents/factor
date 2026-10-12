import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { agentOf, getState, jobOf } from "@/lib/data";
import { JobBill, Tag } from "@/components/Bits";
import { Reveal } from "@/components/Motion";
import { clock, dayTime, short } from "@/lib/format";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> { return { title: `Job ${(await params).id}` }; }

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await getState();
  const j = jobOf(s, (await params).id);
  if (!j) notFound();
  const a = agentOf(s, j.agentId);
  const lines = s.events.filter((e) => e.jobId === j.id).reverse();
  return (
    <>
      <section className="wrap page-head">
        <Link className="more quiet back" href="/ledger">← The ledger</Link>
        <h1 className="h1">{j.title}</h1>
        <p className="small mono" style={{ marginTop: 12, color: "var(--dim)" }}>job {j.id} · locked {dayTime(j.lockedAt)} · due {dayTime(j.dueAt)}</p>
      </section>
      <section className="wrap" style={{ paddingTop: 56 }}>
        <div className="grid2">
          <Reveal><JobBill j={j} agent={a} /></Reveal>
          <Reveal delay={140} className="side">
            <div>
              <span className="label">Who is in it</span>
              <dl className="kv" style={{ marginTop: 18 }}>
                <dt>The agent</dt><dd><Link href={`/agents/${j.agentId}`}>{a?.name ?? j.agentId}</Link></dd>
                <dt>The customer</dt><dd>{short(j.customer)}</dd>
                <dt>The advance</dt><dd>{j.advance ? { customer: "allowed by the customer", pool: "from the pool", compute: "paid as compute" }[j.advance.kind] : "none"}</dd>
              </dl>
            </div>
            <div>
              <span className="label">What happened</span>
              <div className="happened" style={{ marginTop: 18 }}>
                {lines.length ? lines.map((e) => (
                  <div key={e.n}><span className="mono small" style={{ color: "var(--dim)" }}>{clock(e.at)}</span><Tag kind={e.kind} /><span className="mono small" style={{ textAlign: "right", color: "var(--ink)" }}>{e.amount}</span></div>
                )) : <p className="small">Its lines are further back in the ledger.</p>}
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
