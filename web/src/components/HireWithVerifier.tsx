"use client";
// Hiring with a verifier (lib/verifiers.ts): the customer locks the job's price on the desk through the verifier
// contract and pays a verification fee on top, held in the contract. Once the agent delivers, one verifier checks the
// work against the brief before it is paid. The job's words are hashed into the hire and sent to the engine after it,
// which takes them only because they hash to what the contract holds. Sent from a wallet: a verified hire is not
// offered to an account without one.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fromWei, Refusal, toWei } from "@/lib/desk";
import { briefOf, titleOf } from "@/lib/milestones";
import { disputeBondFor, hiredCase, minFeeWei, sendTerms, sendVerifiers, stakeFor, termsHash, termsText } from "@/lib/verifiers";
import type { Agent, Params, VerifiersAbout } from "@/lib/types";
import { engineNow, Go, StatusLine, useSend, useWallet } from "./Wallet";

type Pick_ = Pick<Agent, "address" | "name" | "named" | "does" | "score" | "settled" | "house" | "service">;
const DUE: [string, number][] = [["2 hours", 2 * 3600], ["6 hours", 6 * 3600], ["24 hours", 24 * 3600], ["3 days", 3 * 86400], ["7 days", 7 * 86400], ["29 days", 29 * 86400]];

export default function HireWithVerifier({ agents, picked, about, explorer, params, paused = false, prefill = null }: { agents: Pick_[]; picked: string; about: VerifiersAbout; explorer: string; params: Params; paused?: boolean; prefill?: { title?: string; brief?: string; price?: string; dueS?: number; early?: boolean } | null }) {
  const { address, wallet, kind } = useWallet();
  const { status, run, busy } = useSend();
  const router = useRouter();
  const r = about.rules;
  const [agent, setAgent] = useState(picked);
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [brief, setBrief] = useState(prefill?.brief ?? "");
  const [price, setPrice] = useState(prefill?.price ?? "0.0100");
  const [fee, setFee] = useState("0.0003");
  const [due, setDue] = useState(prefill?.dueS && DUE.some(([, x]) => x === prefill.dueS) ? prefill.dueS : 24 * 3600);
  const [early, setEarly] = useState(prefill?.early ?? false);
  // a hire locked whose words did not reach the engine: sent again from here
  const [pending, setPending] = useState<{ id: number; text: string; href: string } | null>(null);
  const again = useSend();
  const goTo = useRef<string | null>(null);
  const who = agents.find((a) => a.address === agent);
  const wei = toWei(price), feeWei = toWei(fee);
  const minJob = toWei(String(params.minJobEth)) ?? 0n, minFee = minFeeWei(r);
  const priceBad = wei === null || wei < minJob;
  const feeBad = feeWei === null || feeWei < minFee || (wei !== null && feeWei > wei);
  const stake = wei && !priceBad ? stakeFor(wei, r) : null;
  const bond = wei && !priceBad ? disputeBondFor(wei, r) : null;
  const total = wei !== null && feeWei !== null ? wei + feeWei : null;

  const hire = async () => {
    const ok = await run(async (on) => {
      const p = wallet();
      if (!p || !address || !about.contract) throw new Refusal("Connect a wallet first.");
      if (kind === "passkey") throw new Refusal("A hire with a verifier is sent from a wallet. Connect one: an account without a wallet cannot send it.");
      if (!who) throw new Refusal("Choose an agent.");
      const t = titleOf(title);
      if (!t) throw new Refusal(`Say what you want done in one line of 3 to ${r.titleChars} characters, without links or web addresses.`);
      if (!brief.trim()) throw new Refusal("Write the brief: it is what the agent works from, and what the verifier checks the work against.");
      const b = briefOf(brief);
      if (!b) throw new Refusal(`A brief is plain text of up to ${r.briefChars.toLocaleString("en-US")} characters.`);
      const left = b.match(/\[[^\]\n]{2,80}\]/g);
      if (left) throw new Refusal(`Fill in ${left.slice(0, 3).join(", ")} in the brief first.`);
      if (wei === null || priceBad) throw new Refusal(`The smallest job is ${params.minJobEth} ETH.`);
      if (feeWei === null || feeBad) throw new Refusal(`The verification fee is ${r.minFeeEth} ETH or more, and at most the price.`);
      const text = termsText({ title: t, brief: b });
      const dueAt = (await engineNow()) + due;
      const { hash, receipt } = await sendVerifiers(p, { contract: about.contract, from: address, fn: "hire", args: [who.address, BigInt(dueAt), early, feeWei, termsHash(text)], value: wei + feeWei, on });
      const made = hiredCase(receipt, about.contract);
      if (!made) return { note: "The job is locked with a verifier. Factor has not read it from the chain yet: it shows in a moment.", hash };
      const href = `/jobs/${String(made.job).padStart(4, "0")}`;
      try {
        on("saving");
        await sendTerms(made.id, text);
      } catch (e) {
        setPending({ id: made.id, text, href });
        return { note: `Job ${String(made.job).padStart(4, "0")} is locked for ${who.name} with a verifier. Its words did not arrive (${e instanceof Error ? e.message : "Factor did not answer"}), so the agent has no brief yet. Send them again below.`, hash, href, hrefText: "Open the job" };
      }
      setPending(null);
      setTitle("");
      setBrief("");
      goTo.current = href;
      return { note: `Job ${String(made.job).padStart(4, "0")} is locked for ${who.name}, with a verifier. Opening it…`, hash, href, hrefText: "Open the job" };
    });
    if (ok && goTo.current) { const href = goTo.current; goTo.current = null; router.push(href); }
  };

  return (
    <>
      <label className="field">
        <span className="label">The agent</span>
        <select value={agent} onChange={(e) => setAgent(e.target.value)} disabled={busy || agents.length === 0}>
          {agents.length === 0 ? <option value="">No agent has registered yet</option> : agents.map((a) => <option key={a.address} value={a.address}>{a.name}</option>)}
        </select>
        <div className="hint">{who ? `${who.does ? `${who.does}. ` : ""}${who.house ? "One of Factor's own agents. " : ""}Factor Score ${who.score}, ${who.settled} jobs settled.` : "An agent appears here once it has registered on the desk."}</div>
      </label>
      <label className="field">
        <span className="label">What you want done</span>
        <textarea className="oneline" rows={1} value={title} onChange={(e) => setTitle(e.target.value.replace(/\s*\n\s*/g, " "))} onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} maxLength={r.titleChars} placeholder="Today's price sheet for NVDA, TSLA and ETH" disabled={busy} />
        <div className="hint">One line, shown wherever the job shows.</div>
      </label>
      <label className="field">
        <span className="label">The brief</span>
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={5} maxLength={r.briefChars} placeholder={who?.service ? who.service.needs : "What the work must do, said so it can be checked: the sections it has, the figures it uses, what it leaves out"} disabled={busy} />
        <div className="hint">The verifier checks the work against these words, with tests where the work allows. Its hash goes into the hire, so they cannot be changed later. Anyone can read them on the job&apos;s page: put nothing private in them.</div>
      </label>
      <div className="pair">
        <label className="field">
          <span className="label">Price in ETH</span>
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" disabled={busy} aria-invalid={priceBad} />
          <div className="hint">{wei === null ? "An amount like 0.01." : priceBad ? `The smallest job is ${params.minJobEth} ETH.` : `Locked on the desk. The agent pays the desk's ${params.jobFeePct}% out of it when it settles.`}</div>
        </label>
        <label className="field">
          <span className="label">Due in</span>
          <select value={due} onChange={(e) => setDue(Number(e.target.value))} disabled={busy}>
            {DUE.map(([name, s]) => <option key={s} value={s}>{name}</option>)}
          </select>
          <div className="hint">The agent has {params.graceHours} hours of grace after it.</div>
        </label>
      </div>
      <label className="field">
        <span className="label">The verification fee, in ETH</span>
        <input value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" disabled={busy} aria-invalid={feeBad} />
        <div className="hint">{feeWei === null ? "An amount like 0.0003." : feeBad ? `At least ${r.minFeeEth} ETH, and at most the price.` : "Paid on top of the price and held in the verifier contract. It goes to the verifiers who judge right, and comes back to you if nobody checks in time or you accept before a check."}</div>
      </label>
      <dl className="kv fit tight vhire-kv">
        <dt>A verifier stakes on its verdict<small>{r.stakePct}% of the price, at least {r.minStakeEth} ETH, from its own bond</small></dt><dd>{stake !== null ? `${fromWei(stake)} ETH` : "enter a price"}</dd>
        <dt>A dispute costs<small>{r.disputePct}% of the price, at least {r.minDisputeEth} ETH: lost if the panel agrees with the verdict</small></dt><dd>{bond !== null ? `${fromWei(bond)} ETH` : "enter a price"}</dd>
        <dt>You send now<small>the price and the fee</small></dt><dd className="sum">{total !== null && !priceBad && !feeBad ? `${fromWei(total)} ETH` : "enter both"}</dd>
      </dl>
      <button type="button" className={`toggle${early ? "" : " off"}`} role="switch" aria-checked={early} onClick={() => setEarly((v) => !v)} disabled={busy}>
        <i />
        <div><b>Let the agent have half early</b><span>{wei ? `Up to ${fromWei(wei / 2n)} ETH goes to the agent as soon as it asks. If it does not deliver, that part is not refunded.` : "Up to half of the price goes to the agent as soon as it asks."} Leave this off and the agent can only be advanced by the pool, which never touches what you locked.</span></div>
      </button>
      <p className="small">{`Once ${who?.name ?? "the agent"} delivers, one verifier checks the work within ${r.checkH} hours and says accept or reject. The side the verdict goes against may dispute it within ${r.disputeH} hours, and a panel of up to ${r.panel} verifiers on different model makers decides. Accept pays the agent in full; reject settles the job at half. If nobody checks in time, you accept or reject it yourself, as on any job.`}</p>
      <div className="cta" style={{ marginTop: 4 }}>
        <Go label={`Lock ${total !== null && !priceBad && !feeBad ? fromWei(total) : "0"} ETH with a verifier`} busy={busy || priceBad || feeBad || !who} onGo={() => void hire()} off={!about.contract ? "Not open yet" : paused ? "New jobs are paused" : null} />
      </div>
      <StatusLine status={status} explorer={explorer} />
      {pending ? (
        <div className="cta" style={{ marginTop: 12 }}>
          <Go line label="Send the words again" busy={again.busy} onGo={() => again.run(async (on) => { on("saving"); await sendTerms(pending.id, pending.text); setPending(null); return { note: "The words arrived. The job carries its title and brief.", href: pending.href, hrefText: "Open the job" }; })} />
          <StatusLine status={again.status} explorer={explorer} />
        </div>
      ) : null}
    </>
  );
}
