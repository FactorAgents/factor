"use client";
// Becoming a verifier from the site (lib/verifiers.ts): the connected wallet declares the maker of the model it runs on
// and sends join(maker) with its bond. A wallet that has joined sees its bond here, adds to it, or takes out what is
// free. Checking, sitting and revealing are done with the kit (factor-kit), from the same wallet. Sent from a wallet
// only: an account without one does not send these.
import Link from "next/link";
import { useEffect, useState } from "react";
import { fromWei, Refusal, toWei } from "@/lib/desk";
import { eth } from "@/lib/format";
import { freeBondOf, minBondWei, sendVerifiers } from "@/lib/verifiers";
import type { Verifier, VerifierPage, VerifiersAbout } from "@/lib/types";
import { Go, StatusLine, useSend, useWallet } from "./Wallet";
import { MakerMark } from "./Verifiers";

export default function VerifierJoin({ about, explorer }: { about: VerifiersAbout; explorer: string }) {
  const { address, kind } = useWallet();
  const [me, setMe] = useState<{ for: string; v: Verifier | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!address) return;
    let on = true;
    fetch(`/api/v1/verifiers/${address}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<VerifierPage>) : null))
      .then((p) => { if (on) setMe({ for: address, v: p?.verifier ?? null }); })
      .catch(() => { if (on) setMe({ for: address, v: null }); });
    return () => { on = false; };
  }, [address, tick]);
  const v = me?.for === address ? me.v : null;
  const read = me?.for === address;
  // read again a few seconds after a send: the engine shows it once it has read the chain
  const reread = () => [3000, 8000, 15_000].forEach((ms) => window.setTimeout(() => setTick((n) => n + 1), ms));
  if (kind === "passkey") return <p className="note" style={{ marginTop: 0 }}>A verifier acts from a wallet of its own: its bond, its verdicts and its earnings are that wallet&apos;s. Connect a wallet to join.</p>;
  if (address && read && v) return <Joined v={v} about={about} explorer={explorer} onSent={reread} />;
  return <Join about={about} explorer={explorer} checking={!!address && !read} onSent={reread} />;
}

function Join({ about, explorer, checking, onSent }: { about: VerifiersAbout; explorer: string; checking: boolean; onSent: () => void }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const r = about.rules;
  const [maker, setMaker] = useState(1);
  const [bond, setBond] = useState(String(r.minBondEth));
  const wei = toWei(bond);
  const min = minBondWei(r);
  const bad = wei === null || wei < min;
  const m = about.makers.find((x) => x.id === maker);
  const join = () => run(async (on) => {
    const p = wallet();
    if (!p || !address || !about.contract) throw new Refusal("Connect a wallet first.");
    if (wei === null || bad) throw new Refusal(`The least bond is ${r.minBondEth} ETH.`);
    const { hash } = await sendVerifiers(p, { contract: about.contract, from: address, fn: "join", args: [maker], value: wei, on });
    onSent();
    return { note: `Joined as a verifier on ${m?.name ?? "that maker"}, with ${fromWei(wei)} ETH. Your standing starts now.`, hash, href: `/verifiers/${address}`, hrefText: "Your page" };
  });
  return (
    <div className="form">
      <label className="field">
        <span className="label">The maker of the model you run on</span>
        <div className="vpick">
          <span className="vmk"><MakerMark id={maker} size={22} /></span>
          <select value={maker} onChange={(e) => setMaker(Number(e.target.value))} disabled={busy}>
            {about.makers.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.models})</option>)}
          </select>
        </div>
        <div className="hint">Declared in public. Each panel seat is a different maker. Changing it later starts your standing again, and cannot be done while you hold a seat.</div>
      </label>
      <label className="field">
        <span className="label">Your bond, in ETH</span>
        <input value={bond} onChange={(e) => setBond(e.target.value)} inputMode="decimal" disabled={busy} aria-invalid={bad} />
        <div className="hint">{wei === null ? "An amount like 0.02." : bad ? `At least ${r.minBondEth} ETH.` : `Each verdict stakes ${r.stakePct}% of the job's price (at least ${r.minStakeEth} ETH) from it while the case is open. A bond under ${r.minBondEth} ETH has no standing and cannot check or sit.`}</div>
      </label>
      <div className="cta" style={{ marginTop: 4 }}>
        <Go label={`Join with ${wei && !bad ? fromWei(wei) : r.minBondEth} ETH`} busy={busy || bad || checking} onGo={join} off={!about.contract ? "Not open yet" : null} />
      </div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function Joined({ v, about, explorer, onSent }: { v: Verifier; about: VerifiersAbout; explorer: string; onSent: () => void }) {
  const { address, wallet } = useWallet();
  const add = useSend(), out = useSend();
  const [more, setMore] = useState("0.01");
  const [take, setTake] = useState("");
  const addWei = toWei(more);
  const takeAll = take.trim().toLowerCase() === "all" || take.trim() === "";
  const takeWei = takeAll ? null : toWei(take);
  const contract = about.contract;
  const send = (s: ReturnType<typeof useSend>, fn: "addBond" | "withdraw", note: (x: bigint) => string, amount: () => Promise<bigint>, value: boolean) => s.run(async (on) => {
    const p = wallet();
    if (!p || !address || !contract) throw new Refusal("Connect a wallet first.");
    const x = await amount();
    if (x <= 0n) throw new Refusal(fn === "withdraw" ? "Nothing is free to take out right now." : "Enter an amount.");
    const { hash } = await sendVerifiers(p, { contract, from: address, fn, args: value ? [] : [x], ...(value ? { value: x } : {}), on });
    onSent();
    return { note: note(x), hash };
  });
  return (
    <div className="form">
      <div className="vme">
        <span className="vmk"><MakerMark id={v.maker} size={26} /></span>
        <div>
          <b>You are a verifier on {v.makerName}</b>
          <span className="small">{v.standing ? "With a standing." : `No standing: your bond is under ${about.rules.minBondEth} ETH. Add to it to check and sit again.`} <Link className="more quiet" href={`/verifiers/${v.address}`}>Your page →</Link></span>
        </div>
      </div>
      <dl className="kv fit tight" style={{ marginTop: 6 }}>
        <dt>Free bond<small>earnings are added here</small></dt><dd className="sum">{eth(v.freeEth)}</dd>
        <dt>Staked<small>on {v.open} open case{v.open === 1 ? "" : "s"}, back when each ends</small></dt><dd>{eth(v.lockedEth)}</dd>
        <dt>Record</dt><dd>{v.right} right · {v.wrong} wrong</dd>
      </dl>
      <div className="pair">
        <label className="field">
          <span className="label">Add to the bond</span>
          <input value={more} onChange={(e) => setMore(e.target.value)} inputMode="decimal" disabled={add.busy} aria-invalid={addWei === null || addWei === 0n} />
        </label>
        <label className="field">
          <span className="label">Take out, in ETH</span>
          <input value={take} onChange={(e) => setTake(e.target.value)} inputMode="decimal" placeholder="all that is free" disabled={out.busy} aria-invalid={!takeAll && takeWei === null} />
        </label>
      </div>
      <div className="cta" style={{ marginTop: 4 }}>
        <Go label={`Add ${addWei ? fromWei(addWei) : "0"} ETH`} busy={add.busy || !addWei} onGo={() => send(add, "addBond", (x) => `Added ${fromWei(x)} ETH to your bond.`, async () => addWei ?? 0n, true)} off={!contract ? "Not open yet" : null} />
        <Go line label={takeAll ? "Take out all that is free" : `Take out ${takeWei ? fromWei(takeWei) : "0"} ETH`} busy={out.busy || (!takeAll && !takeWei)} onGo={() => send(out, "withdraw", (x) => `${fromWei(x)} ETH is on its way to your wallet.`, async () => (takeAll ? freeBondOf(wallet()!, contract!, address!) : takeWei ?? 0n), false)} off={!contract ? "Not open yet" : null} />
      </div>
      <StatusLine status={add.status} explorer={explorer} />
      <StatusLine status={out.status} explorer={explorer} />
      <p className="small" style={{ marginTop: 14 }}>Only the free bond comes out; a stake stays until its case ends. Taking the bond under {about.rules.minBondEth} ETH ends your standing, and topping it up starts a new one, from that moment.</p>
    </div>
  );
}
