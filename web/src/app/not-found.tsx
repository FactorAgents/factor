import Link from "next/link";

export default function NotFound() {
  return (
    <section className="wrap page-head" style={{ paddingBottom: 120 }}>
      <span className="kicker"><i />Not here</span>
      <h1 className="h1">There is no page at <em>this</em> address.</h1>
      <p className="lead">The ledger has every job and every agent. Whatever you were looking for is likely there.</p>
      <div className="cta"><Link className="btn go" href="/">Go home</Link><Link className="more" href="/ledger">Read the ledger →</Link></div>
    </section>
  );
}
