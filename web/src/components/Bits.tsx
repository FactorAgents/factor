// The small blocks the pages are made of: a word for a state, a line of the ledger, an agent in a list, a job's bill,
// the head of a section.
import Link from "next/link";
import type { ReactNode } from "react";
import type { Agent, Job, LedgerEvent, Params } from "@/lib/types";
import { ADVANCE_WORD, STATE_TONE, STATE_WORD, canDraw, clock, eth, initials, short } from "@/lib/format";

export function Tag({ kind }: { kind: string }) {
  const tone = STATE_TONE[kind] ?? "";
  return <span className={`tag${tone ? ` ${tone}` : ""}`}>{STATE_WORD[kind] ?? kind}</span>;
}

export function House() { return <span className="house" title="This agent is run by Factor">House agent</span>; }

export function Seal({ name, size = 44 }: { name: string; size?: number }) {
  return <div className="seal" style={size !== 44 ? { width: size, height: size, fontSize: size * 0.4 } : undefined}>{initials(name)}</div>;
}

export function LedgerRow({ e }: { e: LedgerEvent }) {
  const inner = (
    <>
      <span className="time">{clock(e.at)}</span>
      <span className="kind"><Tag kind={e.kind} /></span>
      <span className="what">{e.jobId ? <><b>job {e.jobId}</b> · </> : null}{e.text}</span>
      <span className="amt">{e.amount}</span>
    </>
  );
  return e.jobId ? <Link className="row" href={`/jobs/${e.jobId}`}>{inner}</Link> : <div className="row">{inner}</div>;
}

/** The ledger as a list: a head with the columns, the lines, a hairline to close it. */
export function Ledger({ events, empty = "Nothing of that kind yet." }: { events: LedgerEvent[]; empty?: string }) {
  return (
    <div className="rows">
      <div className="head"><span>Time</span><span>Entry</span><span>What happened</span><span>Amount</span></div>
      {events.length ? events.map((e) => <LedgerRow key={e.n} e={e} />) : <p className="small" style={{ padding: "22px 0", borderTop: "1px solid var(--line)" }}>{empty}</p>}
      <div className="end" />
    </div>
  );
}

export function AgentRow({ a }: { a: Agent }) {
  const can = canDraw(a);
  return (
    <Link className="agent" href={`/agents/${a.id}`}>
      <Seal name={a.name} />
      <div><div className="name">{a.name}{a.house ? <House /> : null}</div><div className="does">{a.does}</div></div>
      <div className="col"><span className="label">Settled</span><div className="v num">{a.settled} jobs</div></div>
      <div className="col"><span className="label">Can draw</span><div className={`v num${can > 0 ? "" : " none"}`}>{can > 0 ? eth(can, 3) : "nothing yet"}</div></div>
      <div><span className="label">Score {a.score}</span><div className="score"><i style={{ ["--w" as string]: `${a.score / 10}%` }} /></div></div>
    </Link>
  );
}

const ORDER = ["locked", "advanced", "delivered", "settled"] as const;
function BillLine({ k, why, v, bad }: { k: string; why?: string; v: string; bad?: boolean }) {
  return <div className="line"><span>{k}</span><i className="dots" /><b className={bad ? "bad" : undefined}>{v}</b>{why ? <small className="why">{why}</small> : null}</div>;
}
/** A job written out like the bill it is: what was locked, what was advanced, what the agent gets. */
export function JobBill({ j, agent, p }: { j: Job; agent?: Agent; p: Params }) {
  const adv = j.advance;
  const at = ORDER.indexOf(j.state as (typeof ORDER)[number]);
  const paid = j.state === "settled" || j.state === "half";
  const jobFee = j.feeEth ?? +(j.priceEth * p.jobFeePct / 100).toFixed(5);
  // the fee on an advance came off it when it was drawn, so only the advance and the job fee come off here
  const toAgent = j.paidEth ?? +(j.priceEth - (adv ? adv.eth : 0) - jobFee).toFixed(5);
  const unpaid = j.state === "refunded" && adv && adv.kind !== "customer";
  return (
    <div className="bill">
      <div className="head"><div className="h3">Job {j.id}</div><Tag kind={j.state} /></div>
      <div className="title">{j.title}</div>
      <div className="meta">agent {agent?.name ?? j.agentId} · customer {short(j.customer)}</div>
      <div className="lines">
        <BillLine k="Locked by the customer" why="held by the contract until delivery" v={eth(j.priceEth)} />
        {adv ? <BillLine k="Advanced to the agent" why={`${ADVANCE_WORD[adv.kind]}, to pay for what the job costs`} v={eth(adv.eth)} /> : null}
        {adv ? <BillLine k="Fee on the advance" why="taken out of the advance, buys back and burns $FACTOR" v={eth(adv.feeEth)} /> : null}
        {j.state === "half" ? <BillLine k="Returned to the customer" why="the customer rejected the delivery, so the job settled at half" v={eth(j.backEth ?? 0)} /> : null}
        {j.state === "declined" || j.state === "refunded" ? null : <BillLine k="Fee on the job" why={j.state === "half" ? "on the agent's half, goes to the pool" : "goes to the pool"} v={eth(jobFee)} />}
        <div className="line sum">
          {j.state === "declined" ? <><span>Declined by the agent, returned to the customer</span><i className="dots" /><b>{eth(j.backEth ?? j.priceEth)}</b></>
            : j.state === "refunded" ? <><span>{unpaid ? "Refunded to the customer, the advance was not repaid" : "Refunded to the customer"}</span><i className="dots" /><b className="bad">{eth(j.backEth ?? j.priceEth)}</b></>
            : <><span>{paid ? "Paid to the agent on delivery" : "To the agent on delivery"}</span><i className="dots" /><b>{eth(toAgent)}</b></>}
        </div>
      </div>
      {j.state === "declined" || j.state === "refunded" ? null : (
        <div className="steps">{ORDER.map((st, i) => <div key={st} className={paid || i < at ? "done" : i === at ? "now" : undefined}>{st === "settled" && j.state === "half" ? STATE_WORD.half : STATE_WORD[st]}</div>)}</div>
      )}
    </div>
  );
}

/** The flow across the page: the customer, Factor, the agent. Drawn with hairlines. */
export function Flow({ price = 0.04 }: { price?: number }) {
  return (
    <div className="flow">
      <div className="node"><span className="label">01 · The customer</span><b>Locks {price} ETH</b><p>The whole price of the job, held by the contract.</p></div>
      <div className="link"><em>half of it, early</em></div>
      <div className="node mid"><span className="label gilt">02 · Factor</span><b>Advances {price / 2} ETH</b><div className="half"><i /></div><div className="ends"><span>now</span><span>on delivery</span></div></div>
      <div className="link"><em>delivers</em></div>
      <div className="node"><span className="label">03 · The agent</span><b>Delivers, gets the rest</b><p>The pool is repaid first. The fee buys back and burns $FACTOR.</p></div>
    </div>
  );
}

export function PageHead({ kicker, title, lead, back }: { kicker: string; title: ReactNode; lead?: string; back?: [string, string] }) {
  return (
    <div className="page-head wrap">
      {back ? <Link className="more quiet back" href={back[0]}>← {back[1]}</Link> : null}
      {back ? null : <span className="kicker"><i />{kicker}</span>}
      <h1 className="h1" style={back ? { marginTop: 0 } : undefined}>{title}</h1>
      {lead ? <p className="lead">{lead}</p> : null}
    </div>
  );
}

/** The head of a section: a hairline, its number and name, a link to more, and the heading. */
export function SecHead({ n, kicker, title, lead, more, href }: { n: string; kicker: string; title: ReactNode; lead?: string; more?: string; href?: string }) {
  return (
    <div className="sec-head">
      <div className="line1"><span className="label">{n ? <span className="idx">{n}</span> : null}{kicker}</span>{more && href ? <Link className="more quiet" href={href}>{more} →</Link> : null}</div>
      <h2 className="h2">{title}</h2>
      {lead ? <p className="lead">{lead}</p> : null}
    </div>
  );
}

/** Lines of code, kept as lines. A word between two stars is the part to notice. */
export function Code({ lines }: { lines: string[] }) {
  return (
    <div className="code">
      {lines.map((line, i) => (
        <div key={i}>{line.split(/(\*[^*]+\*)/).map((part, k) => (part.startsWith("*") && part.endsWith("*") && part.length > 2 ? <b key={k}>{part.slice(1, -1)}</b> : part))}{line === "" ? " " : null}</div>
      ))}
    </div>
  );
}
