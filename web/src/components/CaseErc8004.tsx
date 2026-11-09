// Where a verified job's verdict stands on the ERC-8004 Validation Registry, on the job's page: the case file and its
// hash, the agent's identity, the validator the request names, the answer, and the two calls the right wallets may send
// (components/Erc8004Actions.tsx). Every figure is the engine's (GET /api/v1/verifiers/erc8004/<case>).
import { addressHref, dayTime, short } from "@/lib/format";
import { ERC8004_WORD } from "@/lib/verifiers";
import type { CaseErc8004 } from "@/lib/types";
import Erc8004Actions from "./Erc8004Actions";

function sentence(e: CaseErc8004): string {
  const id = e.agentId ? `agent identity #${e.agentId}` : "the agent's identity";
  switch (e.state) {
    case "no-identity": return `This verdict cannot be put there: ${e.why ? e.why.replace(/[.!?]$/, "") : "the agent has no ERC-8004 identity linked on Factor"}.`;
    case "no-verdict": return "Once the job has its outcome, Factor writes the case file, and the owner of the agent's ERC-8004 identity can ask for the verdict to be validated there.";
    case "prepared": return `The case file is written. The owner of ${id}, or a wallet it approved, can ask for validation on the registry, naming the validator below.`;
    case "requested": return `Requested ${e.requestedAt ? dayTime(e.requestedAt) : ""}. Only the validator the request names can answer, under the tag ${e.tag}.`;
    case "answered": return `Answered ${e.answeredAt ? dayTime(e.answeredAt) : ""} by the validator, under the tag ${e.tag}: ${e.response ?? "no figure"} of 100. Any app that reads the standard sees it beside ${id}.`;
    default: return "";
  }
}

export default function Erc8004Block({ e, explorer }: { e: CaseErc8004; explorer: string }) {
  return (
    <div className="vblock" id="erc8004" style={{ scrollMarginTop: 96 }}>
      <span className="label">On ERC-8004 · {ERC8004_WORD[e.state]}</span>
      <p className="small" style={{ marginTop: 12 }}>{sentence(e)}</p>
      <dl className="kv fit tight" style={{ marginTop: 16 }}>
        <dt>The registry<small>the ERC-8004 Validation Registry on Robinhood Chain</small></dt><dd><a href={addressHref(explorer, e.registry)} target="_blank" rel="noopener noreferrer">{short(e.registry)}</a></dd>
        <dt>The tag</dt><dd>{e.tag}</dd>
        {e.agentId ? <><dt>The agent&apos;s identity</dt><dd>#{e.agentId}</dd></> : null}
        {e.validator ? <><dt>The validator<small>the only wallet that may answer</small></dt><dd><a href={addressHref(explorer, e.validator)} target="_blank" rel="noopener noreferrer">{short(e.validator)}</a></dd></> : null}
        {e.response !== null ? <><dt>Its answer<small>on a scale of 0 to 100</small></dt><dd className="sum">{e.response}</dd></> : null}
        {e.file ? <><dt>The case file<small>the job, its words, the verdicts and the outcome</small></dt><dd><a href={e.file} target="_blank" rel="noopener noreferrer">The file</a></dd></> : null}
      </dl>
      {e.fileHash ? <p className="small mono vhash">keccak256 of the file, sent with the request: {e.fileHash}</p> : null}
      <Erc8004Actions e={e} explorer={explorer} />
    </div>
  );
}
