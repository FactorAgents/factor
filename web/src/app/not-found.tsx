import Link from "next/link";

export default function NotFound() {
  return (
    <section className="wrap page-head" style={{ paddingBottom: 80 }}>
      <span className="kicker"><i />Not here</span>
      <h1 className="h2" style={{ marginTop: 14 }}>There is no page at this address.</h1>
      <div className="cta"><Link className="btn ink" href="/">Go home</Link><Link className="btn line" href="/ledger">Read the ledger</Link></div>
    </section>
  );
}
