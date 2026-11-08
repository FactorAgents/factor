import Link from "next/link";
import Mark from "./Mark";
import LiveMark from "./LiveMark";

import { HEY_FACTOR } from "@/lib/hey";

export default function Footer({ links, live = false, hey = false }: { links: { github: string | null; x: string | null }; /** the page is told of changes as they happen */ live?: boolean; /** HEY builder records are on: HEY's badge for Factor shows */ hey?: boolean }) {
  return (
    <footer className="foot">
      <div className="wrap">
        <Link className="logo" href="/"><Mark />Factor</Link>
        <nav aria-label="More">
          <Link href="/ledger">Ledger</Link><Link href="/open-jobs">Open jobs</Link><Link href="/bounties">Bounties</Link><Link href="/protocol">Protocol</Link><Link href="/docs">Docs</Link><Link href="/roadmap">Roadmap</Link><Link href="/log">Dev log</Link><Link href="/security">Security</Link>
          {links.github ? <a href={links.github} target="_blank" rel="noopener noreferrer">GitHub</a> : null}
          {links.x ? <a href={links.x} target="_blank" rel="noopener noreferrer">X</a> : null}
          {live ? <LiveMark /> : null}
        </nav>
        <p className="risk">Factor is an experiment in open contracts that nobody can change. $FACTOR can lose all of its value. Use it at your own risk; nothing here is financial advice.</p>
        {hey ? (
          <div className="foot-hey">
            {/* HEY Research Lab's own badge for Factor, as its badge page gives it: an image HEY draws and serves, linked to
                Factor's page there. It says what the team shipped, never a rating */}
            <a className="hey-badge" href={HEY_FACTOR.link} target="_blank" rel="noopener noreferrer" aria-label="Factor on HEY Research Lab: this team ships">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="for-dark" src={`${HEY_FACTOR.badge}?theme=dark`} alt="Factor on HEY Research Lab" width={440} height={144} loading="lazy" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="for-light" src={HEY_FACTOR.badge} alt="" width={440} height={144} loading="lazy" />
            </a>
            <p><b>This team ships.</b> HEY Research Lab, the public record of building on Robinhood Chain, keeps Factor&apos;s builder record: every ship with its source. <a className="more quiet" href={HEY_FACTOR.page} target="_blank" rel="noopener noreferrer">Factor on HEY →</a></p>
          </div>
        ) : null}
      </div>
    </footer>
  );
}
