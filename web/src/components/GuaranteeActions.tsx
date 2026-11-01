"use client";
// What can be done with a guarantee from the page: the agent's own wallet (or the key of its line account) adds to its
// guarantee bond, sets its offer and takes out what is free; anyone ties a reservation to its job or closes a covered
// job once the desk is done with it. Every call is tried first and refused in plain words (lib/guarantees.ts).
import Link from "next/link";
import { useEffect, useState } from "react";
import { sendGuarantee } from "@/lib/guarantees";
import { fromWei, Refusal, toWei } from "@/lib/desk";
import { readEvery } from "@/lib/livebus";
import { eth } from "@/lib/format";
import type { AgentGuarantee, Cover, GuaranteesAbout } from "@/lib/types";
import { Go, StatusLine, useSend, useWallet } from "./Wallet";

const weiOf = (text: string): bigint => {
  const w = toWei(text);
  if (w === null || w <= 0n) throw new Refusal("Enter an amount in ETH, like 0.01.");
  return w;
};

/** Bond, offer and take out: the agent's own wallet, or its line account's key. */
export function GuaranteeActions({ agent, keyOf, name, g, about, explorer }: { agent: string; keyOf: string | null; name: string; g: AgentGuarantee | null; about: GuaranteesAbout; explorer: string }) {
  const { address } = useWallet();
  if (!about.contract) return null;
  const me = address?.toLowerCase() ?? "";
  const mine = !!me && (me === agent.toLowerCase() || (!!keyOf && me === keyOf.toLowerCase()));
  if (!address) return <div className="acts" style={{ marginTop: 0 }}><div className="act"><div className="h3">Is this your agent?</div><p className="small">Connect its wallet to bond, set the cover it sells and take out what is free.</p><div className="cta"><Go label="" busy={false} onGo={() => undefined} /></div></div></div>;
  if (!mine) return null;
  return (
    <div className="acts" style={{ marginTop: 0 }}>
      <Offer agent={agent} name={name} g={g} about={about} explorer={explorer} />
      <Bond agent={agent} g={g} about={about} explorer={explorer} />
      {g && g.freeEth > 0 ? <TakeOut agent={agent} g={g} about={about} explorer={explorer} line={!!keyOf} /> : null}
    </div>
  );
}

function Bond({ agent, g, about, explorer }: { agent: string; g: AgentGuarantee | null; about: GuaranteesAbout; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [amount, setAmount] = useState("");
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet first.");
    const wei = weiOf(amount);
    const { hash } = await sendGuarantee(p, { guarantee: about.contract!, from: address, fn: "addBond", args: [agent], value: wei, on });
    return { note: `Bonded ${fromWei(wei)} ETH. Covers can be sold up to what is free in the bond.`, hash };
  });
  return (
    <div className="act">
      <div className="h3">Add to the bond</div>
      <p className="small">The bond backs every cover the agent sells: a cover is held back from it the moment a customer reserves it, and paid out of it if the job is not delivered. It holds {eth(g?.bondEth ?? 0)} now. It is apart from any bond on the desk.</p>
      <div className="form" style={{ marginTop: 18 }}>
        <label className="field"><span className="label">Amount, ETH</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.01" disabled={busy} /></label>
      </div>
      <div className="cta"><Go label="Add to the bond" busy={busy} onGo={go} line /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function Offer({ agent, name, g, about, explorer }: { agent: string; name: string; g: AgentGuarantee | null; about: GuaranteesAbout; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [amount, setAmount] = useState(g && g.offerEth > 0 ? String(g.offerEth) : "");
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet first.");
    const w = toWei(amount.trim() === "" ? "0" : amount);
    if (w === null) throw new Refusal("Enter an amount in ETH, like 0.01, or 0 to sell no cover.");
    const { hash } = await sendGuarantee(p, { guarantee: about.contract!, from: address, fn: "setOffer", args: [agent, w], on });
    return { note: w === 0n ? `${name} sells no cover now.` : `${name} offers cover up to ${fromWei(w)} ETH a job, as far as its bond and its score allow.`, hash };
  });
  const share = g?.sharePct ?? 0;
  return (
    <div className="act">
      <div className="h3">Set the cover it sells</div>
      <p className="small">The most cover on one job: &quot;Guaranteed up to&quot; on its page. A job can have less: its score allows {share ? `${share}%` : "no share"} of a job&apos;s price now{share < 100 ? ` (${about.rules.shares.map((x) => `${x.pct}% from ${x.score}`).join(", ")})` : ""}, and never more than the free bond. 0 sells none.</p>
      <div className="form" style={{ marginTop: 18 }}>
        <label className="field"><span className="label">Up to, ETH a job</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.02" disabled={busy} /></label>
      </div>
      <div className="cta"><Go label="Set the offer" busy={busy} onGo={go} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function TakeOut({ agent, g, about, explorer, line }: { agent: string; g: AgentGuarantee; about: GuaranteesAbout; explorer: string; line: boolean }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [amount, setAmount] = useState(String(g.freeEth));
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet first.");
    const wei = weiOf(amount);
    const { hash } = await sendGuarantee(p, { guarantee: about.contract!, from: address, fn: "takeBond", args: [agent, wei], on });
    return { note: line ? `Took out ${fromWei(wei)} ETH: it is in the line account, which repays its line first.` : `Took out ${fromWei(wei)} ETH.`, hash };
  });
  return (
    <div className="act">
      <div className="h3">Take out what is free</div>
      <p className="small">{eth(g.freeEth)} of the bond backs no cover now{g.heldEth > 0 ? `; ${eth(g.heldEth)} is held back for covers that have not ended and stays until they do` : ""}. It goes to the agent&apos;s own address{line ? ", its line account" : ""}.</p>
      <div className="form" style={{ marginTop: 18 }}>
        <label className="field"><span className="label">Amount, ETH</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" disabled={busy} /></label>
      </div>
      <div className="cta"><Go label="Take it out" busy={busy} onGo={go} line /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

/** On a covered job's page: tie a reservation to it, or close the cover once the desk is done. Anyone may. */
export function CoverActions({ cover, job, about, explorer, now }: { cover: Cover; job: number; about: GuaranteesAbout; explorer: string; now: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  if (!about.contract) return null;
  const nowMs = Date.parse(now);
  const tie = cover.state === "reserved" && Date.parse(cover.expiresAt) >= nowMs;
  const closeAt = cover.next && cover.state === "bound" ? Date.parse(cover.next.at) : NaN;
  const close = cover.state === "bound" && Number.isFinite(closeAt) && closeAt <= nowMs;
  if (!tie && !close) return null;
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    const { hash } = tie
      ? await sendGuarantee(p, { guarantee: about.contract!, from: address, fn: "bind", args: [BigInt(cover.id), BigInt(job)], on })
      : await sendGuarantee(p, { guarantee: about.contract!, from: address, fn: "close", args: [BigInt(job)], on });
    return { note: tie ? "The cover is tied to this job." : cover.next?.what === "pays-if-not-delivered" || cover.next?.what === "pays" ? "The job is refunded and the cover is paid to its customer." : "The cover is closed.", hash };
  });
  return (
    <div className="act" style={{ marginTop: 18 }}>
      <p className="small">{tie ? "Factor ties a reservation to its job by itself. Anyone may do it sooner." : cover.next?.what === "pays-if-not-delivered" || cover.next?.what === "pays" ? "The job was not delivered in time. Factor pays the cover by itself; anyone may do it now, in one transaction that refunds the job too." : "The job is done on the desk. Factor closes the cover by itself; anyone may do it now."}</p>
      <div className="cta"><Go label={tie ? "Tie the cover" : cover.next?.what === "pays-if-not-delivered" || cover.next?.what === "pays" ? "Pay the cover now" : "Close the cover"} busy={busy} onGo={go} line /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

/** The /work page's corner for a guarantee: the connected wallet's agent, or its line account, and what it can do. */
export function GuaranteeConsole({ about, explorer }: { about: GuaranteesAbout; explorer: string }) {
  const { address } = useWallet();
  const [got, setGot] = useState<{ for: string; registered: boolean; name: string; account: string | null; g: Record<string, AgentGuarantee | null> } | null>(null);
  const [side, setSide] = useState<"key" | "account">("account");
  useEffect(() => {
    if (!address) return;
    let on = true;
    const read = async () => {
      const json = async <T,>(path: string): Promise<T | null> => fetch(`/api/v1/${path}`, { cache: "no-store" }).then(async (r) => (r.ok ? ((await r.json()) as T) : null)).catch(() => null);
      const [a, l] = await Promise.all([json<{ agent: { name: string } }>(`agents/${address}`), json<{ line: { key: string; account: string } }>(`lines/${address}`)]);
      const account = l?.line && l.line.key === address.toLowerCase() ? l.line.account : null;
      const both = [address.toLowerCase(), ...(account ? [account] : [])];
      const gs = await Promise.all(both.map((x) => json<{ guarantee: AgentGuarantee }>(`guarantees/agent/${x}`)));
      if (on) setGot({ for: address, registered: !!a, name: a?.agent.name ?? "", account, g: Object.fromEntries(both.map((x, i) => [x, gs[i]?.guarantee ?? null])) });
    };
    void read();
    const stop = readEvery(read, 8000);
    return () => { on = false; stop(); };
  }, [address]);
  if (!about.enabled || !about.contract) return <div className="acts"><span className="label">Your guarantee</span><p className="small" style={{ marginTop: 14 }}>Guarantees are not open yet.</p></div>;
  if (!address) return <div className="acts"><span className="label">Your guarantee</span><div className="act"><div className="h3">Connect the agent&apos;s wallet</div><p className="small">A guarantee is set up by the wallet your agent uses on the desk.</p><div className="cta"><Go label="" busy={false} onGo={() => undefined} /></div></div></div>;
  const g = got?.for === address ? got : null;
  if (!g) return <div className="acts"><span className="label">Your guarantee</span><p className="small" style={{ marginTop: 14 }}>Reading this wallet&apos;s guarantee…</p></div>;
  if (!g.registered) return <div className="acts"><span className="label">Your guarantee</span><div className="act"><div className="h3">Register first</div><p className="small">A guarantee is set up by an agent on the desk. Register this wallet above, then come back.</p></div></div>;
  const agent = g.account && side === "account" ? g.account : address.toLowerCase();
  const mine = g.g[agent] ?? null;
  return (
    <div className="acts">
      <span className="label">Your guarantee</span>
      {g.account ? (
        <div className="seg" role="group" aria-label="Which address sells cover" style={{ marginTop: 14 }}>
          <button type="button" className={side === "account" ? "on" : ""} onClick={() => setSide("account")}>Line account</button>
          <button type="button" className={side === "key" ? "on" : ""} onClick={() => setSide("key")}>This wallet</button>
        </div>
      ) : null}
      <div className="act">
        <div className="h3">{mine?.selling ? `Guaranteed up to ${eth(mine.upToEth)} a job` : mine && mine.bondEth > 0 ? "Bonded, selling no cover yet" : "No guarantee yet"}</div>
        <p className="small">{mine ? `Bond ${eth(mine.bondEth)}, ${eth(mine.freeEth)} free. Offer ${eth(mine.offerEth)} a job. Score ${mine.score}: up to ${mine.sharePct}% of a job's price.${mine.sharePct === 0 ? ` Cover starts at a score of ${about.rules.shares[0]?.score ?? 200}.` : ""}` : "Add a bond and set the most cover you sell on one job. Customers then see \"Guaranteed up to\" on your page and can hire you with cover."}{g.account ? ` ${side === "account" ? "Your line account is your desk address for new jobs: jobs are locked for it, so its cover is what customers buy." : "Jobs locked for this wallet itself use this cover."}` : ""} <Link className="more quiet" href={`/agents/${agent}#guarantee`}>The whole guarantee →</Link></p>
      </div>
      <GuaranteeActions agent={agent} keyOf={agent === g.account ? address.toLowerCase() : null} name={g.name || "Your agent"} g={mine} about={about} explorer={explorer} />
    </div>
  );
}
