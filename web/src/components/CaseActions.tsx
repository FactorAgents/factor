"use client";
// What the customer, the agent or anyone can do about a job hired with a verifier, from the job's page, each shown only
// to the wallet that may: the customer accepts or rejects when the case says the customer decides or a verdict of reject
// is past its dispute time, and disputes a verdict of accept; the agent disputes a verdict of reject or concedes it; each
// side strikes one panelist while seating is open; anyone takes a step whose time has come. Every call goes to the
// verifier contract, never to the desk, and is tried first: a refusal is said in words before the wallet is asked.
// Checking, sitting and revealing are a verifier's, and its kit's (factor-kit).
import { Refusal } from "@/lib/desk";
import { dayTime, eth, fromNow } from "@/lib/format";
import { sendVerifiers } from "@/lib/verifiers";
import type { CaseState, CaseNext } from "@/lib/types";
import { Go, StatusLine, useSend, useWallet } from "./Wallet";

export interface CaseForActions {
  id: number; state: CaseState; customer: string; agent: { address: string; name: string };
  priceEth: number; disputeBondWei: string; disputeBondEth: number;
  firstAccept: boolean | null; delivered: boolean;
  disputeBy: string | null; seatBy: string | null; reviewBy: string | null;
  seats: { address: string; name: string }[];
  struckBy: ("customer" | "agent")[];
  next: CaseNext | null; nextAt: string | null;
}

const STEP_WORD: Partial<Record<CaseState, string>> = {
  working: "Its time has come: a step carries it on, by the contract's own rules.",
  checked: "The time to dispute the verdict is over: a step carries the verdict out on the desk and pays its verifier.",
  disputed: "The panel's time is over: a step counts the revealed votes, carries the outcome out on the desk and pays the verifiers who judged right.",
  customer: "The desk's 24 hours are over: a step settles the job as accepted.",
};

export default function CaseActions({ c, contract, explorer, now }: { c: CaseForActions; contract: string | null; explorer: string; now: string }) {
  const { address, wallet, kind } = useWallet();
  const accept = useSend(), reject = useSend(), dispute = useSend(), concede = useSend(), strike = useSend(), step = useSend();
  if (!contract) return null;
  const over = c.state === "accepted" || c.state === "rejected" || c.state === "returned";
  if (over) return null;
  const t = Date.parse(now);
  const isCustomer = !!address && address === c.customer.toLowerCase();
  const isAgent = !!address && address === c.agent.address.toLowerCase();
  const inDispute = !!c.disputeBy && t < Date.parse(c.disputeBy);
  const inSeating = !!c.seatBy && t < Date.parse(c.seatBy);
  const inDay = !!c.reviewBy && t < Date.parse(c.reviewBy);
  // the customer decides: by the desk's rule, or to carry out a verdict of reject once its dispute time is over
  const customerDecides = c.delivered && inDay && (c.state === "customer" || (c.state === "checked" && c.firstAccept === false && !inDispute));
  const canDispute = c.state === "checked" && inDispute && (c.firstAccept ? isCustomer : isAgent);
  const canConcede = isAgent && c.state === "checked" && c.firstAccept === false;
  const side: "customer" | "agent" | null = isCustomer ? "customer" : isAgent ? "agent" : null;
  const canStrike = !!side && c.state === "disputed" && inSeating && !c.struckBy.includes(side) && c.seats.length > 0;
  const call = (s: ReturnType<typeof useSend>, fn: string, note: string, o: { args?: readonly unknown[]; value?: bigint } = {}) => s.run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    if (kind === "passkey") throw new Refusal("A job hired with a verifier is answered from a wallet. Connect the wallet that is its customer or its agent.");
    const { hash } = await sendVerifiers(p, { contract, from: address, fn, args: o.args ?? [BigInt(c.id)], value: o.value, on });
    return { note, hash };
  });
  const any = (customerDecides && isCustomer) || canDispute || canConcede || canStrike || c.next === "step";
  return (
    <div className="acts vacts">
      <span className="label">What can be done</span>
      {!address && !any ? (
        <div className="act">
          <p className="small">The customer and the agent act on this job here: the customer may dispute a verdict of accept, the agent a verdict of reject, and each may strike one panelist. Connect the wallet that is one of them.</p>
          <div className="cta"><Go label="" busy={false} onGo={() => undefined} /></div>
        </div>
      ) : null}
      {address && !side && !any ? <p className="small rest">The connected wallet is neither this job&apos;s customer nor its agent. A verifier checks and sits with its kit, not from this page.</p> : null}
      {side && !any ? <p className="small rest">{c.next && c.nextAt ? `Nothing for you to do right now. Next: ${c.next === "check" ? "a verifier's check" : c.next === "seats" ? "the panel is seated" : c.next === "reveals" ? "the panel reveals" : c.next === "dispute" ? "the time to dispute" : "the next step"}, until ${dayTime(c.nextAt)}.` : "Nothing for you to do right now."}</p> : null}

      {isCustomer && customerDecides ? (
        <div className="act">
          <div className="h3">{c.state === "customer" ? "It is yours to decide" : "Carry out the verdict"}</div>
          <p className="small">{c.state === "customer" ? `By the desk's own rule, until ${dayTime(c.reviewBy!)}. Accept and ${c.agent.name} is paid in full. Reject and the job settles at half: ${eth(c.priceEth / 2)} comes back to you. Say nothing and after that it settles as accepted.` : `The verifier's verdict was reject, and ${c.agent.name} did not dispute it in time. Reject carries it out: the job settles at half, and ${eth(c.priceEth / 2)} comes back to you. You may accept it instead.`}</p>
          <div className="cta">
            {c.state === "customer" ? <Go label="Accept the work" busy={accept.busy || reject.busy} onGo={() => call(accept, "accept", `Accepted. ${c.agent.name} is paid.`)} /> : null}
            <Go line={c.state === "customer"} label={c.state === "customer" ? "Reject it" : "Reject: settle at half"} busy={accept.busy || reject.busy} onGo={() => call(reject, "reject", "Rejected. The job settled at half, and your half is on its way back.")} />
            {c.state !== "customer" ? <Go line label="Accept it instead" busy={accept.busy || reject.busy} onGo={() => call(accept, "accept", `Accepted. ${c.agent.name} is paid.`)} /> : null}
          </div>
          <StatusLine status={accept.status} explorer={explorer} />
          <StatusLine status={reject.status} explorer={explorer} />
        </div>
      ) : null}

      {canDispute ? (
        <div className="act">
          <div className="h3">{isCustomer ? "Dispute the verdict of accept" : "Dispute the verdict of reject"}</div>
          <p className="small">Until {dayTime(c.disputeBy!)}, {fromNow(c.disputeBy!, now)}. It takes a bond of exactly {eth(c.disputeBondEth)}. A panel of up to three verifiers on different model makers then decides. If the panel agrees with the first verdict, the bond is lost; if not, it comes back. With no panel at all, the bond goes to the first verifier and the customer decides by the desk&apos;s rule.</p>
          <div className="cta"><Go label={`Dispute it: ${eth(c.disputeBondEth)}`} busy={dispute.busy} onGo={() => call(dispute, "dispute", "Disputed. A panel is being seated.", { value: BigInt(c.disputeBondWei) })} /></div>
          <StatusLine status={dispute.status} explorer={explorer} />
        </div>
      ) : null}

      {canConcede ? (
        <div className="act">
          <div className="h3">Concede the verdict</div>
          <p className="small">Take the verdict of reject without a dispute: the job settles at half now, and half of the price is yours, less the desk&apos;s fee.</p>
          <div className="cta"><Go line label="Concede: settle at half" busy={concede.busy} onGo={() => call(concede, "concede", "Conceded. The job settled at half.")} /></div>
          <StatusLine status={concede.status} explorer={explorer} />
        </div>
      ) : null}

      {canStrike ? (
        <div className="act">
          <div className="h3">Strike one panelist</div>
          <p className="small">One strike for your side, without a reason, until {dayTime(c.seatBy!)}. The verifier struck has its stake back and cannot sit on this job again; its seat is open to the next.</p>
          <div className="cta">{c.seats.map((s) => <Go key={s.address} line label={`Strike ${s.name}`} busy={strike.busy} onGo={() => call(strike, "strike", `Struck. ${s.name} is off this panel.`, { args: [BigInt(c.id), s.address] })} />)}</div>
          <StatusLine status={strike.status} explorer={explorer} />
        </div>
      ) : null}

      {c.next === "step" ? (
        <div className="act">
          <p className="small">{STEP_WORD[c.state] ?? "Its time has come: a step carries it on."} Factor takes this step by itself; anyone may.</p>
          <div className="cta"><Go line label="Take the step" busy={step.busy} onGo={() => call(step, "step", "Done.")} /></div>
          <StatusLine status={step.status} explorer={explorer} />
        </div>
      ) : null}
    </div>
  );
}
