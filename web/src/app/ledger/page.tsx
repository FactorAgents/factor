import Link from "next/link";
import type { Metadata } from "next";
import { getLedger } from "@/lib/data";
import { Ledger, PageHead } from "@/components/Bits";
import { Reveal } from "@/components/Motion";

export const metadata: Metadata = { title: "The ledger" };
const SHOWN = [["all", "Everything"], ["locked", "Locked"], ["advanced", "Advanced"], ["settled", "Settled"], ["refunded", "Refunded"], ["burned", "Burned"]] as const;
const PAGE = 50;

export default async function LedgerPage({ searchParams }: { searchParams: Promise<{ show?: string; before?: string }> }) {
  const { show, before } = await searchParams;
  const want = SHOWN.some(([k]) => k === show) ? show! : "all";
  const from = before && /^\d{1,9}$/.test(before) ? Number(before) : undefined;
  const page = await getLedger({ show: want === "all" ? undefined : want, before: from, limit: PAGE });
  const last = page.items[page.items.length - 1];
  const q = (o: { before?: number }) => { const s = new URLSearchParams({ ...(want === "all" ? {} : { show: want }), ...(o.before ? { before: String(o.before) } : {}) }).toString(); return s ? `/ledger?${s}` : "/ledger"; };
  return (
    <>
      <PageHead kicker="The ledger" title={<>Everything that happens, <em>as</em> it happens.</>} lead="Every payment locked, every advance, every delivery and every burn is a line here, read from the chain. Open a line to see the job behind it." />
      <section className="wrap" style={{ paddingTop: 56 }}>
        <div className="filters">{SHOWN.map(([k, name]) => <Link key={k} className={`chip${k === want ? " on" : ""}`} href={k === "all" ? "/ledger" : `/ledger?show=${k}`}>{name}</Link>)}</div>
        <Reveal><div className="after-filters" style={{ marginTop: 28 }}><Ledger events={page.items} empty={page.total === 0 && want === "all" ? "Nothing has happened on the desk yet." : "Nothing of that kind yet."} /></div></Reveal>
        <p className="small" style={{ marginTop: 16 }}>
          {page.total === 1 ? "1 line" : `${page.total} lines`}{want === "all" ? " in all" : " of this kind"}. Times are UTC.
          {from ? <>{" "}<Link className="more quiet" href={q({})}>Back to the newest</Link></> : null}
          {page.more && last ? <>{" "}<Link className="more quiet" href={q({ before: last.n })}>Older lines →</Link></> : null}
        </p>
      </section>
    </>
  );
}
