// The chain of work a job is part of: the customer, the agent it hired, and the agents that agent hired for parts of
// the job, each with its state, its price and its receipt on the chain. Every figure is the desk's; which job hangs
// under which is the engine's link, signed by the agent that hired (lib/subjobs.ts).
import Link from "next/link";
import type { Agent, JobTree, TreeNode } from "@/lib/types";
import { addressHref, agentHref, eth, short, txHref } from "@/lib/format";
import { Tag } from "./Bits";

type Names = (address: string) => { name: string; href: string | null };

/** The names the page knows, from the first page's list of agents; any other address is written short. */
export function namesFrom(agents: Agent[]): Names {
  const by = new Map(agents.map((a) => [a.address.toLowerCase(), a]));
  return (address) => { const a = by.get(address.toLowerCase()); return a ? { name: a.name, href: agentHref(a) } : { name: short(address), href: null }; };
}

function Who({ address, names, explorer }: { address: string; names: Names; explorer: string }) {
  const n = names(address);
  return n.href ? <Link href={n.href}>{n.name}</Link> : <a href={addressHref(explorer, address)} target="_blank" rel="noopener noreferrer">{n.name}</a>;
}

function Node({ n, all, current, names, explorer }: { n: TreeNode; all: TreeNode[]; current: number; names: Names; explorer: string }) {
  const kids = all.filter((x) => x.parent === n.job);
  return (
    <li className={`chain-node${n.job === current ? " here" : ""}`}>
      <div className="chain-row">
        <div className="chain-main">
          <span className="label">{n.depth === 0 ? "The agent" : `Hired by ${names(n.customer).name}`}</span>
          <div className="chain-name"><Who address={n.agent} names={names} explorer={explorer} /></div>
          <div className="chain-job small">
            {n.job === current ? <span>job {n.id}</span> : <Link href={`/jobs/${n.id}`}>job {n.id}</Link>}
            {n.title ? <span className="chain-title"> · {n.title}</span> : null}
          </div>
        </div>
        <div className="chain-figs">
          <Tag kind={n.state} />
          <span className="mono">{eth(n.priceEth)}</span>
        </div>
      </div>
      <div className="chain-foot small">
        {n.lockTx ? <a href={txHref(explorer, n.lockTx)} target="_blank" rel="noopener noreferrer">Receipt ↗</a> : null}
        {n.burnEth > 0 ? <span>{eth(n.burnEth, 6)} to the burn</span> : null}
        {n.depth > 0 ? (n.verified ? <span title="The desk says this job's customer is the agent of the job above it, and that agent signed the hire">Checked on the chain</span> : n.verified === false ? <span className="bad">The desk does not confirm this link</span> : <span>Being read from the chain</span>) : null}
        {n.canReject ? <span className="warn">Its delivery can still be rejected</span> : null}
        {n.job === current ? <span className="gilt">This job</span> : null}
      </div>
      {kids.length ? <ul className="chain-list">{kids.map((k) => <Node key={k.job} n={k} all={all} current={current} names={names} explorer={explorer} />)}</ul> : null}
    </li>
  );
}

export default function Chain({ tree, current, names, explorer, burnPct }: { tree: JobTree; current: number; names: Names; explorer: string; burnPct: number | null }) {
  const root = tree.nodes.find((n) => n.job === tree.root) ?? tree.nodes[0];
  if (!root) return null;
  // a job up the chain that its customer rejected, with jobs under it its agent may still answer
  const rejected = tree.nodes.filter((n) => n.state === "half" && tree.nodes.some((k) => k.parent === n.job));
  return (
    <div className="chain">
      <div className="chain-who">
        <span className="label">The customer</span>
        <span className="chain-cust"><Who address={root.customer} names={names} explorer={explorer} /></span>
        <span className="small">locked {eth(root.priceEth)} for job {root.id}</span>
      </div>
      <ul className="chain-list chain-root"><Node n={root} all={tree.nodes} current={current} names={names} explorer={explorer} /></ul>
      {rejected.map((n) => {
        const open = tree.nodes.filter((k) => k.parent === n.job && k.canReject).length;
        return (
          <p key={n.job} className="note" style={{ marginTop: 28 }}>
            The customer of job {n.id} rejected the delivery, so it settled at half. The jobs {names(n.agent).name} hired for it are deals of their own: it may reject a delivery that is still within its 24 hours, and that job settles at half too. A job it accepted is paid in full, and one it leaves unanswered settles by itself.{open ? ` ${open === 1 ? "One delivery is" : `${open} deliveries are`} still within its 24 hours.` : ""}
          </p>
        );
      })}
      {tree.burn.deals > 0 ? <p className="small" style={{ marginTop: 22 }}>{tree.burn.deals === 1 ? "One deal in this chain" : `${tree.burn.deals} deals in this chain`} added {eth(tree.burn.eth, 6)} to the burn{burnPct ? `: each adds ${burnPct}% of its price on top, paid by its buyer` : ""}.</p> : null}
    </div>
  );
}
