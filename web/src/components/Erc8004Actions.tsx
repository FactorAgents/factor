"use client";
// The two calls a verdict's way onto ERC-8004 needs, each offered only when it is due: the request, which the registry
// takes only from the agent identity's owner or a wallet it approved, and the answer, which it takes only from the
// validator the request names. Each is the engine's prepared call to the registry, tried first and sent from the
// person's own wallet; a refusal is said in words before the wallet is asked.
import { Refusal } from "@/lib/desk";
import { short } from "@/lib/format";
import { sendRegistryCall } from "@/lib/verifiers";
import type { CaseErc8004 } from "@/lib/types";
import { Go, StatusLine, useSend, useWallet } from "./Wallet";

export default function Erc8004Actions({ e, explorer }: { e: CaseErc8004; explorer: string }) {
  const { address, wallet, kind } = useWallet();
  const ask = useSend(), answer = useSend();
  const owner = e.agentId ? `only the owner of agent identity #${e.agentId}, or a wallet it approved, can ask` : "only the owner of the agent's identity, or a wallet it approved, can ask";
  const send = (s: ReturnType<typeof useSend>, call: { to: string; data: string }, who: string, note: string) => s.run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    if (kind === "passkey") throw new Refusal("This goes from the wallet that holds the identity. Connect that wallet.");
    const { hash } = await sendRegistryCall(p, { call, registry: e.registry, from: address, who, on });
    return { note, hash };
  });
  const isValidator = !!address && !!e.validator && address === e.validator.toLowerCase();
  if (e.state === "prepared" && e.requestCall) {
    return (
      <div className="act">
        <p className="small">The registry takes the request from one wallet only: {owner}. It names the validator {e.validator ? short(e.validator) : "Factor gives"} and the hash of the case file.</p>
        <div className="cta"><Go line label="Put this verdict on ERC-8004" busy={ask.busy} onGo={() => send(ask, e.requestCall!, owner, "Requested. The validator answers on the registry.")} /></div>
        <StatusLine status={ask.status} explorer={explorer} />
      </div>
    );
  }
  if (e.state === "requested" && e.responseCall && isValidator) {
    return (
      <div className="act">
        <p className="small">This wallet is the validator the request names, the only one the registry takes the answer from.</p>
        <div className="cta"><Go line label="Answer as the validator" busy={answer.busy} onGo={() => send(answer, e.responseCall!, "only the validator the request names can answer", "Answered on the registry.")} /></div>
        <StatusLine status={answer.status} explorer={explorer} />
      </div>
    );
  }
  return null;
}
