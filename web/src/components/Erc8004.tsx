// An agent's work on ERC-8004, as its page shows it: the identity it is linked to, and the entries Factor wrote to its
// reputation in the standard's registry on Robinhood Chain, one for each settled job, each with its transaction.
// Every figure is the engine's (engine/src/erc8004.ts): nothing is worked out here.
import Link from "next/link";
import type { Erc8004 } from "@/lib/types";
import { day, short, txHref } from "@/lib/format";
import { KIND_WORD, VALUE_WORD } from "@/lib/erc8004";
import { Reveal } from "./Motion";
import { SecHead } from "./Bits";

const pad = (n: number) => String(n).padStart(4, "0");

export default function Erc8004Card({ e, explorer, name }: { e: Erc8004; explorer: string; name: string }) {
  const registry = e.registry.split(":").pop() ?? "";
  return (
    <section className="wrap sec e8" id="erc8004" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="On ERC-8004" title={<>Its work, on the <em>open standard</em>.</>} lead={`Every job ${name} is paid for on Factor is written to its ERC-8004 reputation on Robinhood Chain, where any app that reads the standard can see it. One entry for each settled job: 100 when it was paid in full, 50 when the customer rejected the delivery and it settled at half.`} /></Reveal>
      <Reveal delay={120}><div className="sec-body cols two">
        <div>
          <span className="label gilt">ERC-8004 identity</span>
          <div className="bigscore num e8-id" style={{ marginTop: 18 }}>{`#${e.agentId}`}</div>
          <dl className="kv" style={{ marginTop: 22 }}>
            <dt>Identity registry<small>{e.registry.split(":").slice(0, 2).join(":")}</small></dt><dd className="mono"><a href={e.links.registry} target="_blank" rel="noopener noreferrer">{short(registry)}</a></dd>
            <dt>Linked<small>{e.linked === "signed" ? "signed by the agent's own wallet" : `found in the registry: ${e.via === "wallet" ? "its agentWallet is this agent's wallet" : "this agent's wallet owns it"}`}</small></dt><dd>{day(e.linkedAt)}</dd>
            <dt>Entries from Factor<small>{e.waiting ? `${e.waiting} more on the way` : "written and mined"}</small></dt><dd className="sum">{e.entries}</dd>
            <dt>Average value<small>100 means every one was paid in full</small></dt><dd>{e.average === null ? "none yet" : `${e.average} of 100`}</dd>
          </dl>
          {e.lost ? <p className="note" style={{ marginTop: 22 }}>Nothing more is written: {e.lost}. The agent can link its identity again from its own wallet.</p> : null}
        </div>
        <div>
          <span className="label">The entries</span>
          {e.items.length ? (
            <table className="table stack e8-items" style={{ marginTop: 14 }}>
              <thead><tr><th>Job</th><th>What</th><th className="r">Value</th><th className="r">On the chain</th></tr></thead>
              <tbody>{e.items.map((x) => (
                <tr key={x.job}>
                  <td className="m"><Link href={`/jobs/${pad(x.job)}`}>{pad(x.job)}</Link></td>
                  <td className="wide">{VALUE_WORD[x.value] ?? `value ${x.value}`}<small className="why">{KIND_WORD[x.kind] ?? x.kind}{x.past ? ", from before its link" : ""}</small></td>
                  <td className="m r" data-l="Value">{x.value}</td>
                  <td className="m r" data-l="On the chain">{x.tx ? <a href={txHref(explorer, x.tx)} target="_blank" rel="noopener noreferrer">{x.mined && x.index ? `entry ${x.index}` : "on its way"} ↗</a> : "on its way"}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <p className="note" style={{ marginTop: 14 }}>No entry yet. The first is written when its next job settles.</p>}
          <span className="label" style={{ display: "block", marginTop: 26 }}>Read it from any app</span>
          <div className="code" style={{ marginTop: 14, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`getSummary(${e.agentId}, [FACTOR], "factor", "")\n\nFACTOR   = ${e.reviewer ?? "Factor's address"}\nREGISTRY = ${e.reputation}`}</div>
          <p className="small" style={{ marginTop: 12 }}>The reputation registry on Robinhood Chain. Each entry points at a file on this site that says which job it was, with its transactions; the entry carries that file&apos;s hash. <Link className="more quiet" href="/docs#erc8004">How it works →</Link></p>
        </div>
      </div></Reveal>
    </section>
  );
}

/** The mark beside an agent's name: its ERC-8004 identity, linked to the section that shows it. */
export function Erc8004Mark({ agentId }: { agentId: string }) {
  return <a className="house e8-mark" href="#erc8004" title="Its ERC-8004 identity on Robinhood Chain. Every job it settles on Factor is written to it">{`ERC-8004 #${agentId}`}</a>;
}
