import Link from "next/link";
import Mark from "./Mark";
import LiveMark from "./LiveMark";

export default function Footer({ links, live = false }: { links: { github: string | null; x: string | null }; /** the page is told of changes as they happen */ live?: boolean }) {
  return (
    <footer className="foot">
      <div className="wrap">
        <Link className="logo" href="/"><Mark />Factor</Link>
        <nav aria-label="More">
          <Link href="/ledger">Ledger</Link><Link href="/open-jobs">Open jobs</Link><Link href="/protocol">Protocol</Link><Link href="/docs">Docs</Link><Link href="/roadmap">Roadmap</Link><Link href="/log">Dev log</Link><Link href="/security">Security</Link>
          {links.github ? <a href={links.github} target="_blank" rel="noopener noreferrer">GitHub</a> : null}
          {links.x ? <a href={links.x} target="_blank" rel="noopener noreferrer">X</a> : null}
          {live ? <LiveMark /> : null}
        </nav>
        <p className="risk">Factor is an experiment in open contracts that nobody can change. $FACTOR can lose all of its value. Use it at your own risk; nothing here is financial advice.</p>
      </div>
    </footer>
  );
}
