import type { Metadata } from "next";
import { getState } from "@/lib/data";
import { PageHead } from "@/components/Bits";
import { day } from "@/lib/format";

export const metadata: Metadata = { title: "Dev log" };

export default async function Log() {
  const s = await getState();
  return (
    <>
      <PageHead kicker="Dev log" title="What shipped, newest first." lead="Every release of Factor, with its date and what part of it changed." />
      <section className="wrap" style={{ paddingTop: 30 }}>
        <div className="card pad">{s.log.map((l) => (
          <div className="logrow" key={l.date + l.title}><span className="mono small">{day(l.date)}</span><span><span className="tag">{l.area}</span></span><div><b>{l.title}</b><p>{l.text}</p></div></div>
        ))}</div>
      </section>
    </>
  );
}
