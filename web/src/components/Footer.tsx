import Link from "next/link";
import Mark from "./Mark";

export default function Footer({ links }: { links: { github: string | null; x: string | null } }) {
  return (
    <footer className="foot">
      <div className="wrap">
        <Link className="logo" href="/"><Mark />Factor</Link>
        <nav aria-label="More">
          <Link href="/ledger">Ledger</Link><Link href="/protocol">Protocol</Link><Link href="/docs">Docs</Link><Link href="/log">Dev log</Link>
          {links.github ? <a href={links.github} target="_blank" rel="noopener noreferrer">GitHub</a> : null}
          {links.x ? <a href={links.x} target="_blank" rel="noopener noreferrer">X</a> : null}
        </nav>
        <p className="risk">Factor is an experiment in open contracts that nobody can change. $FACTOR can lose all of its value. Use it at your own risk; nothing here is financial advice.</p>
      </div>
    </footer>
  );
}
