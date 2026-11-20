// Live balance sheets on an agent's page: what it holds and what it owes on Factor's contracts, each line with the
// contract and the view call it is read from, the net, and the hour's seal with its proof. Read only: nothing here sends.
import { Reveal } from "./Motion";
import { SecHead } from "./Bits";
import { addressHref, dayTime, eth, short } from "@/lib/format";
import type { AgentSheet, SheetLineView } from "@/lib/types";

function Lines({ lines, explorer, none }: { lines: SheetLineView[]; explorer: string; none: string }) {
  if (!lines.length) return <p className="small" style={{ marginTop: 14 }}>{none}</p>;
  return (
    <div className="lines">
      {lines.map((l) => (
        <div className="line" key={l.key}>
          <span>{l.label}</span><i className="dots" /><b>{eth(l.eth)}</b>
          <span className="why">
            {l.detail ? `${l.detail}. ` : ""}Read from {l.source.contract ? <a className="more quiet" href={addressHref(explorer, l.source.contract)} target="_blank" rel="noopener noreferrer">{short(l.source.contract)}</a> : "its contract"}: <code style={{ wordBreak: "break-all" }}>{l.source.call}</code>
          </span>
        </div>
      ))}
    </div>
  );
}

/** An agent's page: its balance sheet. Shown while live balance sheets are on and the agent has anything on one. */
export default function BalanceSheetCard({ x, name, explorer, keeper }: { x: AgentSheet | null; name: string; explorer: string; keeper: string | null }) {
  const s = x?.sheet;
  if (!s) return null;
  const p = x.sealed;
  const seal = x.seal;
  const cmd = p && x.contract && keeper ? `cast call ${x.contract} "proves(address,uint64,bytes32,bytes32[])(bool)" ${keeper} ${p.hour} ${p.leaf} "[${p.proof.join(",")}]"` : null;
  return (
    <section className="wrap sec" id="balance-sheet" style={{ scrollMarginTop: 96 }}>
      <Reveal><SecHead n="" kicker="Balance sheet" title={s.solvent ? <>Open books, <em>solvent</em>.</> : <>Open books, <em>owes more</em>.</>} lead={`Everything ${name} holds and owes on Factor's contracts, read live from the chain. Every line names the contract it comes from, so anyone can read the same number.`} more="How balance sheets work" href="/docs#balance-sheets" /></Reveal>
      <Reveal delay={120}><div className="sec-body cols two">
        <div className="bill">
          <div className="head"><span className="label">Holds</span><span className="label">{dayTime(s.at)}</span></div>
          <Lines lines={s.holds} explorer={explorer} none="Nothing held on Factor's contracts right now." />
          <div className="line sum"><span>Holds in all</span><i className="dots" /><b>{eth(s.holdsEth)}</b></div>
        </div>
        <div className="bill">
          <div className="head"><span className="label">Owes</span><span className={`tag ${s.solvent ? "go" : "bad"}`}>{s.solvent ? "Solvent" : "Owes more than it holds"}</span></div>
          <Lines lines={s.owes} explorer={explorer} none="Owes nothing on Factor's contracts." />
          <div className="line sum"><span>Owes in all</span><i className="dots" /><b>{eth(s.owesEth)}</b></div>
          <div className="line sum"><span>Net</span><i className="dots" /><b className={s.solvent ? "" : "bad"}>{eth(s.netEth)}</b>
            <span className="why">Holds less owes. It changes no point of the Factor Score.</span>
          </div>
          {p && seal ? (
            <div style={{ marginTop: 34 }}>
              <span className="label">Sealed</span>
              <p className="small" style={{ marginTop: 10 }}>
                One of {seal.sheets} sheets sealed for the hour from {dayTime(seal.from)}: each sheet hashed, all of them in one tree, the root signed by Factor
                {seal.tx ? <> and written on chain, where it can never be changed (<a className="more quiet" href={seal.txUrl ?? "#"} target="_blank" rel="noopener noreferrer">the transaction</a>)</> : <>; it is written on chain at the keeper&apos;s next pass</>}.
              </p>
              <dl className="kv fit" style={{ marginTop: 14 }}>
                <dt>Root</dt><dd title={p.root}>{short(p.root)}</dd>
                <dt>This sheet&apos;s leaf<small>keccak256 of the text below</small></dt><dd title={p.leaf}>{short(p.leaf)}</dd>
                <dt>Proof<small>sorted pairs, leaf to root</small></dt><dd>{p.proof.length} {p.proof.length === 1 ? "step" : "steps"}</dd>
              </dl>
              <details style={{ marginTop: 14 }}>
                <summary className="small">Check it yourself</summary>
                <p className="small" style={{ marginTop: 10 }}>The text that was hashed:</p>
                <pre className="code" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{p.text}</pre>
                {cmd ? <><p className="small" style={{ marginTop: 10 }}>Ask the seal contract, with Factor&apos;s keeper as the poster:</p><pre className="code" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{cmd}</pre></> : null}
              </details>
            </div>
          ) : null}
        </div>
      </div></Reveal>
    </section>
  );
}
