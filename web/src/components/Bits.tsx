// The small blocks the pages are made of: a tag for a state, a line of the ledger, an agent in a list, a job's bill.
import Link from "next/link";
import type { Agent, FactorState, Job, LedgerEvent } from "@/lib/types";
import { ADVANCE_WORD, STATE_TONE, STATE_WORD, canDraw, clock, eth, initials, short } from "@/lib/format";

export function Tag({ kind }: { kind: string }) {
  const tone = STATE_TONE[kind] ?? "";
  return <span className={`tag${tone ? ` ${tone}` : ""}`}>{STATE_WORD[kind] ?? kind}</span>;
}

export function House() { return <span className="house" title="This agent is run by Factor">House agent</span>; }

export function LedgerRow({ e }: { e: LedgerEvent }) {
  const inner = (
    <>
      <span className="time">{clock(e.at)}</span>
      <span><Tag kind={e.kind} /></span>
      <span className="what">{e.jobId ? <><b>job {e.jobId}</b> · </> : null}{e.text}</span>
      <span className="amt">{e.amount}</span>
    </>
  );
  return e.jobId ? <Link className="row" href={`/jobs/${e.jobId}`}>{inner}</Link> : <div className="row">{inner}</div>;
}

export function AgentRow({ a, s }: { a: Agent; s: FactorState }) {
  const can = canDraw(a, s.params);
  return (
    <Link className="agent" href={`/agents/${a.id}`}>
      <div className="face">{initials(a.name)}</div>
      <div><div className="name">{a.name}{a.house ? <House /> : null}</div><div className="small mono">{short(a.address)}</div></div>
      <div className="col"><span className="label">Settled</span><div className="v">{a.settled} jobs</div></div>
      <div className="col"><span className="label">Can draw</span><div className="v" style={can > 0 ? undefined : { color: "var(--dim)" }}>{can > 0 ? eth(can, 3) : "nothing yet"}</div></div>
      <div><span className="label">Score {a.score}</span><div className="score"><i style={{ width: `${a.score / 10}%` }} /></div></div>
    </Link>
  );
}

const ORDER = ["locked", "advanced", "delivered", "settled"] as const;
/** A job written out like the bill it is: what was locked, what was advanced, what the agent gets. */
export function JobBill({ j, agent }: { j: Job; agent?: Agent }) {
  const adv = j.advance;
  const at = ORDER.indexOf(j.state as (typeof ORDER)[number]);
  const closedBadly = j.state === "refunded" || j.state === "not_repaid";
  const jobFee = +(j.priceEth * 0.01).toFixed(5);
  const toAgent = j.paidEth ?? +(j.priceEth - (adv ? adv.eth + adv.feeEth : 0) - jobFee).toFixed(5);
  return (
    <div className="card job">
      <div className="head"><div className="h3">Job {j.id}</div><Tag kind={j.state} /></div>
      <div className="small">{j.title}</div>
      <div className="small mono" style={{ marginTop: 6 }}>agent {agent?.name ?? j.agentId} · customer {short(j.customer)}</div>
      <div className="line" style={{ marginTop: 14 }}><span>Locked by the customer<small>held by the contract until delivery</small></span><b>{eth(j.priceEth)}</b></div>
      {adv ? <div className="line"><span>Advanced to the agent<small>{ADVANCE_WORD[adv.kind]}, to pay for what the job costs</small></span><b>{eth(adv.eth)}</b></div> : null}
      {adv ? <div className="line"><span>Fee on the advance<small>buys back and burns $FACTOR</small></span><b>{eth(adv.feeEth)}</b></div> : null}
      <div className="line"><span>Fee on the job<small>goes to the pool</small></span><b>{eth(jobFee)}</b></div>
      {closedBadly
        ? <div className="line sum"><span>{j.state === "refunded" ? "Refunded to the customer" : "Refunded to the customer, the advance was not repaid"}</span><b style={{ color: "var(--bad)" }}>{eth(j.priceEth)}</b></div>
        : <div className="line sum"><span>{j.state === "settled" ? "Paid to the agent on delivery" : "To the agent on delivery"}</span><b>{eth(toAgent)}</b></div>}
      {closedBadly ? null : (
        <div className="steps">{ORDER.map((st, i) => <div key={st} className={i < at ? "done" : i === at ? (j.state === "settled" ? "done" : "now") : undefined}>{STATE_WORD[st]}</div>)}</div>
      )}
    </div>
  );
}

/** The flow across the page: the customer, Factor, the agent. */
export function Flow({ price = 0.04 }: { price?: number }) {
  return (
    <div className="card flow">
      <div className="node"><div className="label">01 · The customer</div><b>Locks {price} ETH</b><p>The whole price of the job, held by the contract.</p></div>
      <div className="arrow" />
      <div className="node mid"><div className="label">02 · Factor</div><b>Advances {price / 2} ETH</b><div className="split"><i style={{ width: "50%" }} /></div><div className="ends"><span>advanced now</span><span>paid on delivery</span></div></div>
      <div className="arrow" />
      <div className="node"><div className="label">03 · The agent</div><b>Delivers, gets the rest</b><p>The pool is repaid first. The fee buys back and burns $FACTOR.</p></div>
    </div>
  );
}

export function PageHead({ kicker, title, lead }: { kicker: string; title: string; lead?: string }) {
  return (
    <div className="page-head wrap">
      <span className="kicker"><i />{kicker}</span>
      <h1 className="h2">{title}</h1>
      {lead ? <p className="lead">{lead}</p> : null}
    </div>
  );
}

/** Lines of code, kept as lines. A word between two stars is the part to notice. */
export function Code({ lines }: { lines: string[] }) {
  return (
    <div className="code">
      {lines.map((line, i) => (
        <div key={i}>{line.split(/(\*[^*]+\*)/).map((part, k) => (part.startsWith("*") && part.endsWith("*") && part.length > 2 ? <b key={k}>{part.slice(1, -1)}</b> : part))}{line === "" ? "\u00a0" : null}</div>
      ))}
    </div>
  );
}
