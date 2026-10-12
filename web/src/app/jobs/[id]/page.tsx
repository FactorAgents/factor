import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { agentOf, getState, jobOf } from "@/lib/data";
import { JobBill, Tag } from "@/components/Bits";
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
        <Link className="more" href="/ledger">← The ledger</Link>
        <h1 className="h2" style={{ marginTop: 22 }}>{j.title}</h1>
        <p className="small mono" style={{ marginTop: 8 }}>job {j.id} · locked {dayTime(j.lockedAt)} · due {dayTime(j.dueAt)}</p>
      </section>
      <section className="wrap" style={{ paddingTop: 28 }}>
        <div className="grid2">
          <JobBill j={j} agent={a} />
          <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
            <div className="card pad">
              <span className="label">Who is in it</span>
              <dl className="kv" style={{ marginTop: 16 }}>
                <dt>The agent</dt><dd><Link href={`/agents/${j.agentId}`} style={{ color: "var(--go)" }}>{a?.name ?? j.agentId}</Link></dd>
                <dt>The customer</dt><dd>{short(j.customer)}</dd>
                <dt>The advance</dt><dd>{j.advance ? { customer: "allowed by the customer", pool: "from the pool", compute: "paid as compute" }[j.advance.kind] : "none"}</dd>
              </dl>
            </div>
            <div className="card pad">
              <span className="label">What happened</span>
              <div style={{ marginTop: 10 }}>
                {lines.length ? lines.map((e) => (
                  <div key={e.n} style={{ display: "grid", gridTemplateColumns: "84px auto 1fr", gap: 12, padding: "12px 0", borderTop: "1px solid var(--line)", alignItems: "center" }}>
                    <span className="mono small">{clock(e.at)}</span><Tag kind={e.kind} /><span className="mono small" style={{ textAlign: "right", color: "var(--ink)" }}>{e.amount}</span>
                  </div>
                )) : <p className="small" style={{ paddingTop: 8 }}>Its lines are further back in the ledger.</p>}
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
