"use client";
// What can be done with a claim on locked pay from the page. A buyer's wallet buys a listed claim, sending its price,
// which goes straight to the seller; the seller's wallet takes a listing off sale; anyone settles a sold claim whose job
// has ended. The agent's wallet opens its pay account and lists the claim on one of its jobs at most 10% under its face.
// Every call is tried first and refused in plain words (lib/claims.ts).
import { useEffect, useState } from "react";
import { accountOf, faceOf, listedId, priceAt, sendClaim, underWords, weiEth, weiOf } from "@/lib/claims";
import { Refusal } from "@/lib/desk";
import { readEvery } from "@/lib/livebus";
import { eth } from "@/lib/format";
import type { AgentClaims, ClaimView, ClaimsAbout } from "@/lib/types";
import { Go, StatusLine, useSend, useWallet } from "./Wallet";

const ZERO = "0x0000000000000000000000000000000000000000";
const ENDED = /settled|half|declined|refunded/i;
const json = async <T,>(path: string): Promise<T | null> => fetch(`/api/v1/${path}`, { cache: "no-store" }).then(async (r) => (r.ok ? ((await r.json()) as T) : null)).catch(() => null);

/** The buttons a claim shows to whoever may press them: buy, take off sale, settle. */
export function ClaimButtons({ c, contract, explorer }: { c: ClaimView; contract: string | null; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  if (!contract) return null;
  const me = address?.toLowerCase() ?? "";
  const seller = !!me && (me === c.seller.toLowerCase() || me === c.account.toLowerCase());
  const acts: { fn: "buy" | "unlist" | "settle"; label: string; line?: boolean }[] = [];
  if (c.state === "listed" && !seller) acts.push({ fn: "buy", label: `Buy it for ${eth(weiEth(c.price))}` });
  if (c.state === "listed" && seller) acts.push({ fn: "unlist", label: "Take it off sale", line: true });
  if (c.state === "sold" && c.jobState && ENDED.test(c.jobState)) acts.push({ fn: "settle", label: "Settle it now", line: true });
  if (!acts.length) return null;
  const go = (fn: (typeof acts)[number]["fn"]) => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    const { hash } = await sendClaim(p, { contract, from: address, fn, args: [BigInt(c.id)], value: fn === "buy" ? weiOf(c.price) : undefined, on });
    const note = fn === "buy" ? `Bought: the ${eth(weiEth(c.price))} went to the seller, and what job ${Number(c.job)} pays its agent comes to this wallet when it ends.` : fn === "unlist" ? "Taken off sale." : "Settled: the holder is paid.";
    return { note, hash };
  });
  return (
    <div style={{ marginTop: 12 }}>
      {acts.some((a) => a.fn === "buy") ? <p className="small">You pay the price now, straight to the seller. When the job ends you are paid what it pays its agent, {eth(weiEth(c.face))} if it settles in full. If it pays less, the pay account owes you the rest of your price, paid first from everything it holds or earns.</p> : null}
      <div className="cta" style={{ marginTop: 10 }}>{acts.map((a) => <Go key={a.fn} label={a.label} busy={busy} onGo={() => go(a.fn)} line={a.line} />)}</div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

/** The connected wallet as a seller: its pay account (open one), and the claim on one of its jobs listed for sale. */
export function SellForm({ about, explorer }: { about: ClaimsAbout; explorer: string }) {
  const { address, wallet } = useWallet();
  const [me, setMe] = useState<{ for: string; account: string | null; mine: AgentClaims | null } | null>(null);
  useEffect(() => {
    if (!address) return;
    let on = true;
    const read = async () => {
      const mine = await json<AgentClaims>(`claims/agent/${address}`);
      let account = mine?.key && mine.key.toLowerCase() === address.toLowerCase() ? mine.account : null;
      // the engine may not have seen a pay account opened a moment ago: the contract says
      const p = wallet();
      if (!account && p && about.contract) account = await accountOf(p, about.contract, address).then((a) => (a && a !== ZERO ? a : null)).catch(() => null);
      if (on) setMe({ for: address, account, mine });
    };
    void read();
    const stop = readEvery(read, 8000);
    return () => { on = false; stop(); };
  }, [address, wallet, about.contract]);
  if (!about.enabled || !about.contract) return <div className="acts" style={{ marginTop: 0 }}><span className="label">Sell your pay</span><p className="small" style={{ marginTop: 14 }}>Selling locked pay opens once its contract is live.</p></div>;
  if (!address) return <div className="acts" style={{ marginTop: 0 }}><div className="act"><div className="h3">Sell your locked pay</div><p className="small">An agent connects its wallet to open its pay account and list the claim on a job locked for it.</p><div className="cta"><Go label="" busy={false} onGo={() => undefined} /></div></div></div>;
  const m = me?.for === address ? me : null;
  if (!m) return <div className="acts" style={{ marginTop: 0 }}><p className="small">Reading this wallet&apos;s pay account…</p></div>;
  return (
    <div className="acts" style={{ marginTop: 0 }}>
      {m.account ? <List about={about} explorer={explorer} account={m.account} /> : <Open about={about} explorer={explorer} />}
      {m.account ? <Mine claims={(m.mine?.claims ?? []).filter((c) => c.state === "listed")} contract={about.contract} explorer={explorer} /> : null}
    </div>
  );
}

function Open({ about, explorer }: { about: ClaimsAbout; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet first.");
    const { hash } = await sendClaim(p, { contract: about.contract!, from: address, fn: "open", on });
    const account = await accountOf(p, about.contract!, address).catch(() => null);
    return { note: `Your pay account is open${account ? ` at ${account}` : ""}. Customers lock jobs for that address, and this wallet runs it.`, hash };
  });
  return (
    <div className="act">
      <div className="h3">Open your pay account</div>
      <p className="small">The desk pays a job&apos;s pay to the job&apos;s agent. To sell yours, you work from a pay account: a desk address of its own that this wallet runs. Customers lock jobs for it, and what the desk pays it goes to whoever holds each job&apos;s claim. It starts with a record of its own.</p>
      <div className="cta"><Go label="Open it" busy={busy} onGo={go} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function List({ about, explorer, account }: { about: ClaimsAbout; explorer: string; account: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const most = about.rules.maxDiscountBps;
  const [job, setJob] = useState("");
  const [bps, setBps] = useState(Math.min(300, most));
  const [face, setFace] = useState<{ job: number; wei: bigint } | null>(null);
  const n = Number(job.trim());
  const ok = Number.isInteger(n) && n > 0;
  useEffect(() => {
    const p = wallet();
    if (!ok || !p || !about.contract) return;
    let on = true;
    void faceOf(p, about.contract, n).then((w) => { if (on) setFace({ job: n, wei: w }); }).catch(() => undefined);
    return () => { on = false; };
  }, [ok, n, wallet, about.contract]);
  const f = face && face.job === n ? face.wei : null;
  const price = f !== null ? priceAt(f, bps) : null;
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet first.");
    if (!ok) throw new Refusal("Enter the job's number.");
    const fw = await faceOf(p, about.contract!, n);
    const { hash, receipt } = await sendClaim(p, { contract: about.contract!, from: address, fn: "list", args: [BigInt(n), priceAt(fw, bps)], on });
    const id = listedId(receipt, about.contract!);
    return { note: `Listed${id ? `: claim ${id}` : ""}, for ${eth(weiEth(String(priceAt(fw, bps))))}. Whoever buys it pays this wallet at once.`, hash };
  });
  return (
    <div className="act">
      <div className="h3">List the claim on a job</div>
      <p className="small mono" style={{ overflowWrap: "anywhere" }}>Pay account {account}<br />run by {address}</p>
      <p className="small">A job locked for the pay account, still locked, advanced or delivered and in time. Its face is what it pays the agent if it settles in full: the price less any advance and the desk&apos;s 2% job fee. Sell it at most {underWords(most)} under.</p>
      <label className="field"><span className="label">The job&apos;s number</span><input inputMode="numeric" value={job} onChange={(e) => setJob(e.target.value.replace(/[^\d]/g, ""))} placeholder="412" disabled={busy} /></label>
      <label className="field"><span className="label">Under the face: {bps / 100}%</span><input type="range" min={0} max={most} step={25} value={bps} onChange={(e) => setBps(Number(e.target.value))} disabled={busy} /></label>
      {f !== null && price !== null ? <p className="small">Face {eth(weiEth(String(f)))} · price {eth(weiEth(String(price)))}</p> : null}
      <div className="cta"><Go label="List it" busy={busy} onGo={go} off={ok ? null : "Enter the job's number"} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function Mine({ claims, contract, explorer }: { claims: ClaimView[]; contract: string | null; explorer: string }) {
  if (!claims.length) return null;
  return (
    <div className="act">
      <div className="h3">Your claims for sale</div>
      {claims.map((c) => (
        <div key={String(c.id)} style={{ marginTop: 10 }}>
          <p className="small">Claim {Number(c.id)} on job {Number(c.job)}: {eth(weiEth(c.price))} for a face of {eth(weiEth(c.face))}</p>
          <ClaimButtons c={c} contract={contract} explorer={explorer} />
        </div>
      ))}
    </div>
  );
}
