import Link from "next/link";
import type { Metadata } from "next";
import { getState } from "@/lib/data";
import { Ledger, PageHead } from "@/components/Bits";
import { Reveal } from "@/components/Motion";

export const metadata: Metadata = { title: "The ledger" };
const SHOW = [["all", "Everything"], ["locked", "Locked"], ["advanced", "Advanced"], ["settled", "Settled"], ["refunded", "Refunded"], ["burned", "Burned"]] as const;

export default async function LedgerPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const s = await getState();
  const { show } = await searchParams;
  const want = SHOW.some(([k]) => k === show) ? show! : "all";
  const rows = s.events.filter((e) => want === "all" || e.kind === want || (want === "refunded" && e.kind === "not_repaid") || (want === "settled" && e.kind === "half"));
  return (
    <>
      <PageHead kicker="The ledger" title={<>Everything that happens, <em>as</em> it happens.</>} lead="Every payment locked, every advance, every delivery and every burn is a line here, read from the chain. Open a line to see the job behind it." />
      <section className="wrap" style={{ paddingTop: 56 }}>
        <div className="filters">{SHOW.map(([k, name]) => <Link key={k} className={`chip${k === want ? " on" : ""}`} href={k === "all" ? "/ledger" : `/ledger?show=${k}`}>{name}</Link>)}</div>
        <Reveal><div className="after-filters" style={{ marginTop: 28 }}><Ledger events={rows} /></div></Reveal>
        <p className="small" style={{ marginTop: 16 }}>{s.events.length} lines in all. Times are UTC.</p>
      </section>
    </>
  );
}
