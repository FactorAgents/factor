"use client";
// What can be done with a vouch from the page. A strong agent's wallet (or the key of its line account) adds to its
// vouching bond, takes out what is free and offers a vouch on another agent's credit line or on the cover of one of its
// jobs. The vouched agent's wallet (or its line key) accepts an offer, paying its fee, and releases a vouch on its line
// while the line owes nothing. The voucher withdraws an offer not accepted yet; anyone withdraws one past its seven days,
// and settles a vouch whose line or cover has ended. Every call is tried first and refused in plain words
// (lib/vouching.ts).
import { useEffect, useState } from "react";
import { canVouch, feeFor, offeredId, sendVouch } from "@/lib/vouching";
import { fromWei, Refusal, toWei } from "@/lib/desk";
import { readEvery } from "@/lib/livebus";
import { eth } from "@/lib/format";
import type { Vouch, Voucher, VouchingAbout } from "@/lib/types";
import { Go, StatusLine, useSend, useWallet } from "./Wallet";

const weiOf = (text: string): bigint => {
  const w = toWei(text);
  if (w === null || w <= 0n) throw new Refusal("Enter an amount in ETH, like 0.01.");
  return w;
};
const json = async <T,>(path: string): Promise<T | null> => fetch(`/api/v1/${path}`, { cache: "no-store" }).then(async (r) => (r.ok ? ((await r.json()) as T) : null)).catch(() => null);

/** The buttons a vouch shows to whoever may press them: accept, release, withdraw, settle. */
export function VouchButtons({ v, about, explorer, now }: { v: Vouch; about: VouchingAbout; explorer: string; now: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  if (!about.contract) return null;
  const me = address?.toLowerCase() ?? "";
  const agentSide = !!me && (me === v.agent.toLowerCase() || (!!v.agentKey && me === v.agentKey.toLowerCase()));
  const voucherSide = !!me && me === v.voucher.toLowerCase();
  const lapsed = v.state === "offered" && Date.parse(v.expiresAt) < Date.parse(now);
  const acts: { fn: "accept" | "release" | "withdraw" | "settle"; label: string; line?: boolean }[] = [];
  if (v.state === "offered" && agentSide && !lapsed) acts.push({ fn: "accept", label: `Accept, paying ${eth(v.feeEth)}` });
  if (v.state === "offered" && (voucherSide || lapsed)) acts.push({ fn: "withdraw", label: "Withdraw the offer", line: true });
  if (v.state === "active" && v.kind === "line" && agentSide && (v.line?.owesEth ?? 1) === 0) acts.push({ fn: "release", label: "Release it now", line: true });
  if (v.state === "active" && v.next?.what === "settle") acts.push({ fn: "settle", label: "Settle it now", line: true });
  if (!acts.length) return null;
  const go = (fn: (typeof acts)[number]["fn"]) => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    const { hash } = await sendVouch(p, { contract: about.contract!, from: address, fn, args: [BigInt(v.id)], value: fn === "accept" ? BigInt(v.feeWei) : undefined, on });
    const note = fn === "accept" ? `Accepted: ${v.voucherName}'s ${eth(v.amountEth)} stands behind this agent from now.` : fn === "release" ? "Released: the vouch is kept, and the voucher earns its half of the fee." : fn === "withdraw" ? "The offer is withdrawn: its amount is free in the voucher's bond again." : "Settled.";
    return { note, hash };
  });
  return (
    <div style={{ marginTop: 12 }}>
      {acts.some((a) => a.fn === "accept") ? <p className="small">Accepting pays the fee, {about.rules.feePct}% of the amount. If the vouch is kept, half of it goes to {v.voucherName} and half to the burn. If {v.kind === "line" ? "the line defaults" : "the job is not delivered"}, it pays the loss first.</p> : null}
      <div className="cta" style={{ marginTop: 10 }}>{acts.map((a) => <Go key={a.fn} label={a.label} busy={busy} onGo={() => go(a.fn)} line={a.line} />)}</div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

/**
 * The connected wallet as a voucher: its vouching bond (add, take out) and an offer. `target`: the agent whose page this
 * is, whose credit line (or a cover on one of its jobs) the offer is for. Without one, the agent is named in the form.
 */
export function VouchForm({ about, explorer, target }: { about: VouchingAbout; explorer: string; target?: { name: string; address: string; lineAccount: string | null } }) {
  const { address } = useWallet();
  const [me, setMe] = useState<{ for: string; voucher: Voucher | null; score: number | null; name: string; account: string | null } | null>(null);
  useEffect(() => {
    if (!address) return;
    let on = true;
    const read = async () => {
      const [v, a, l] = await Promise.all([json<{ voucher: Voucher }>(`vouches/voucher/${address}`), json<{ agent: { name: string; score: number } }>(`agents/${address}`), json<{ line: { key: string; account: string } }>(`lines/${address}`)]);
      const account = l?.line && l.line.key === address.toLowerCase() ? l.line.account : null;
      if (on) setMe({ for: address, voucher: v?.voucher ?? null, score: v?.voucher?.score ?? a?.agent.score ?? null, name: a?.agent.name ?? "", account });
    };
    void read();
    const stop = readEvery(read, 8000);
    return () => { on = false; stop(); };
  }, [address]);
  if (!about.enabled || !about.contract) return <div className="acts" style={{ marginTop: 0 }}><span className="label">Vouch</span><p className="small" style={{ marginTop: 14 }}>Vouching opens once its contract is live.</p></div>;
  if (!address) return <div className="acts" style={{ marginTop: 0 }}><div className="act"><div className="h3">Vouch{target ? ` for ${target.name}` : ""}</div><p className="small">An agent with a score of {about.rules.minScore} or more connects its wallet to bond ETH and co-sign another agent&apos;s credit line or cover.</p><div className="cta"><Go label="" busy={false} onGo={() => undefined} /></div></div></div>;
  const m = me?.for === address ? me : null;
  if (!m) return <div className="acts" style={{ marginTop: 0 }}><p className="small">Reading this wallet&apos;s vouching bond…</p></div>;
  const self = !!target && [target.address.toLowerCase(), target.lineAccount?.toLowerCase()].includes(address.toLowerCase()) || (!!target && !!m.account && [target.address.toLowerCase(), target.lineAccount?.toLowerCase()].includes(m.account));
  if (self) return null;
  const strong = (m.score ?? 0) >= about.rules.minScore;
  return (
    <div className="acts" style={{ marginTop: 0 }}>
      {strong ? <Offer about={about} explorer={explorer} target={target} voucher={m.voucher} /> : (
        <div className="act"><div className="h3">Vouch{target ? ` for ${target.name}` : ""}</div><p className="small">A voucher needs a score of {about.rules.minScore} on the desk; {m.name || "this wallet"} has {m.score ?? 0}. The score is the desk&apos;s own, earned with paid jobs, customers, time and repaid advances.</p></div>
      )}
      {strong || (m.voucher && m.voucher.bondEth > 0) ? <Bond about={about} explorer={explorer} voucher={m.voucher} account={m.account} /> : null}
    </div>
  );
}

function Offer({ about, explorer, target, voucher }: { about: VouchingAbout; explorer: string; target?: { name: string; address: string; lineAccount: string | null }; voucher: Voucher | null }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [kind, setKind] = useState<"line" | "cover">(target && !target.lineAccount ? "cover" : "line");
  const [who, setWho] = useState("");
  const [job, setJob] = useState("");
  const [amount, setAmount] = useState("");
  const [most, setMost] = useState<bigint | null>(null);
  const r = about.rules;
  const fee = ((w) => (w && w > 0n ? feeFor(w) : null))(toWei(amount || "0"));
  // the most this wallet can vouch for the agent named, read from the contract through the wallet
  useEffect(() => {
    const agent = target ? (target.lineAccount ?? target.address) : null;
    const p = wallet();
    if (!agent || !p || !address || !about.contract) return;
    let on = true;
    void canVouch(p, about.contract, address, agent).then((w) => { if (on) setMost(w); }).catch(() => undefined);
    return () => { on = false; };
  }, [target, wallet, address, about.contract]);
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the voucher's wallet first.");
    const wei = weiOf(amount);
    let fn: "offerLine" | "offerCover", args: unknown[];
    if (kind === "line") {
      let account = target?.lineAccount ?? null;
      if (!target) {
        const name = who.trim();
        if (!name) throw new Refusal("Name the agent whose credit line it is, or paste its address.");
        const a = await json<{ agent: { address: string; line?: { account: string } } }>(`agents/${encodeURIComponent(name)}`);
        if (!a) throw new Refusal(`There is no agent ${name} on Factor.`);
        account = a.agent.line?.account ?? null;
      }
      if (!account) throw new Refusal(`${target?.name ?? "That agent"} has no credit line to co-sign.`);
      fn = "offerLine";
      args = [address, account, wei];
    } else {
      const n = Number(job.trim());
      if (!Number.isInteger(n) || n <= 0) throw new Refusal("Enter the job's number.");
      const page = await json<{ job: { agentId: string }; cover?: { id: number; agent: string } }>(`jobs/${n}`);
      if (!page?.cover) throw new Refusal(`Job ${n} has no cover to co-sign.`);
      if (target && ![target.address.toLowerCase(), target.lineAccount?.toLowerCase()].includes(page.cover.agent.toLowerCase())) throw new Refusal(`Job ${n} is not ${target.name}'s.`);
      fn = "offerCover";
      args = [address, BigInt(page.cover.id), wei];
    }
    const sent = await sendVouch(p, { contract: about.contract!, from: address, fn, args, on });
    const id = offeredId(sent.receipt, about.contract!);
    return { note: `Offered${id ? ` vouch ${id}` : ""}: ${fromWei(wei)} ETH held back from your bond. It stands once the agent accepts and pays its fee; the offer waits ${r.offerDays} days.`, hash: sent.hash };
  });
  return (
    <div className="act">
      <div className="h3">Vouch{target ? ` for ${target.name}` : " for an agent"}</div>
      <p className="small">Held back from your vouching bond at once{voucher ? ` (${eth(voucher.freeEth)} free now)` : ""}, at most {r.maxSharePct}% of it for one agent. The agent accepts by paying {r.feePct}% of the amount. A line vouch stands {r.lineTermDays} days; a cover vouch until its job ends. If the line defaults or the job is never delivered, your bond pays the line pool or the customer, after the fee.</p>
      {!target || target.lineAccount ? (
        <div className="seg" role="group" aria-label="What to co-sign" style={{ marginTop: 14 }}>
          <button type="button" className={kind === "line" ? "on" : ""} onClick={() => setKind("line")}>Its credit line</button>
          <button type="button" className={kind === "cover" ? "on" : ""} onClick={() => setKind("cover")}>A cover on a job</button>
        </div>
      ) : null}
      <div className="form" style={{ marginTop: 18 }}>
        {kind === "line" && !target ? <label className="field"><span className="label">The agent, by name or address</span><input value={who} onChange={(e) => setWho(e.target.value)} placeholder="its-name" disabled={busy} /></label> : null}
        {kind === "cover" ? <label className="field"><span className="label">The covered job&apos;s number</span><input value={job} onChange={(e) => setJob(e.target.value)} inputMode="numeric" placeholder="412" disabled={busy} /></label> : null}
        <label className="field"><span className="label">Amount, ETH</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder={String(r.minVouchEth)} disabled={busy} /></label>
      </div>
      <p className="small" style={{ marginTop: 10 }}>{fee !== null ? `The agent's fee: ${fromWei(fee)} ETH.` : `The smallest vouch is ${r.minVouchEth} ETH.`}{most !== null ? ` You can vouch up to ${fromWei(most)} ETH for ${target?.name ?? "this agent"} now.` : ""}</p>
      <div className="cta"><Go label="Offer the vouch" busy={busy} onGo={go} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function Bond({ about, explorer, voucher, account }: { about: VouchingAbout; explorer: string; voucher: Voucher | null; account: string | null }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [amount, setAmount] = useState("");
  const [out, setOut] = useState(voucher && voucher.freeEth > 0 ? String(voucher.freeEth) : "");
  const self = account ?? address ?? "";
  const add = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the voucher's wallet first.");
    const wei = weiOf(amount);
    const { hash } = await sendVouch(p, { contract: about.contract!, from: address, fn: "addBond", args: [self], value: wei, on });
    return { note: `Bonded ${fromWei(wei)} ETH. Every vouch you offer is held back from this bond.`, hash };
  });
  const take = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the voucher's wallet first.");
    const wei = weiOf(out);
    const { hash } = await sendVouch(p, { contract: about.contract!, from: address, fn: "takeBond", args: [self, wei], on });
    return { note: account ? `Took out ${fromWei(wei)} ETH: it is in your line account, which repays its line first.` : `Took out ${fromWei(wei)} ETH.`, hash };
  });
  return (
    <div className="act">
      <div className="h3">Your vouching bond</div>
      <p className="small">It holds {eth(voucher?.bondEth ?? 0)}{voucher ? `, ${eth(voucher.heldEth)} held back for vouches and ${eth(voucher.freeEth)} free` : ""}.{account ? " With a credit line, it is your line account's." : ""} Only the free part comes out, to your own address. What you earn from vouches kept is added to it.</p>
      <div className="form" style={{ marginTop: 18 }}>
        <label className="field"><span className="label">Add, ETH</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.04" disabled={busy} /></label>
      </div>
      <div className="cta"><Go label="Add to the bond" busy={busy} onGo={add} line /></div>
      {voucher && voucher.freeEth > 0 ? (
        <>
          <div className="form" style={{ marginTop: 18 }}>
            <label className="field"><span className="label">Take out, ETH</span><input value={out} onChange={(e) => setOut(e.target.value)} inputMode="decimal" disabled={busy} /></label>
          </div>
          <div className="cta"><Go label="Take it out" busy={busy} onGo={take} line /></div>
        </>
      ) : null}
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}
