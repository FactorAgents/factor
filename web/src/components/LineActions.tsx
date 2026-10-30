"use client";
// What can be done with a credit line from the page: the agent's own wallet opens it, draws as cash or as compute,
// repays, adds a bond at its line account and takes out what is free there; anyone may repay a line or sweep the
// income waiting in its account into it. Every call is tried first and refused in plain words (lib/lines.ts).
import Link from "next/link";
import { useEffect, useState } from "react";
import { drawParts, LINE_ABI, LINE_ACCOUNT_ABI, sendLine } from "@/lib/lines";
import { fromWei, Refusal, toWei } from "@/lib/desk";
import { readEvery } from "@/lib/livebus";
import { eth } from "@/lib/format";
import type { CreditLine, LinesAbout } from "@/lib/types";
import { Go, StatusLine, useSend, useWallet } from "./Wallet";

const weiOf = (text: string): bigint => {
  const w = toWei(text);
  if (w === null || w <= 0n) throw new Refusal("Enter an amount in ETH, like 0.001.");
  return w;
};

/** Open a line, from the agent's own wallet. */
export function LineOpen({ agent, about, explorer, onDone }: { agent: { address: string; name: string }; about: LinesAbout; explorer: string; onDone?: () => void }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend(onDone ? () => onDone() : undefined);
  if (!about.contract) return null;
  const mine = !!address && address.toLowerCase() === agent.address.toLowerCase();
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet first.");
    if (!mine) throw new Refusal(`Only ${agent.name}'s own wallet can open its line. Connect that wallet.`);
    const { hash } = await sendLine(p, { to: about.contract!, abi: LINE_ABI, from: address, fn: "open", on });
    return { note: "The line is open. Its line account is now the agent's desk address for new jobs.", hash };
  });
  return (
    <div className="act">
      <div className="h3">Open {agent.name}&apos;s line</div>
      <p className="small">One transaction, once, from the agent&apos;s own wallet. It makes the agent a line account, its desk address for new jobs from now on. The line lends up to the bond and the job fees at that account.</p>
      <div className="cta">{address && !mine ? <p className="small" style={{ margin: 0 }}>The wallet connected is not {agent.name}&apos;s.</p> : <Go label="Open the line" busy={busy} onGo={go} />}</div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

/** Draw, repay, bond and take out: the agent's own wallet does all of it; anyone else may repay or sweep. */
export function LineActions({ line, about, explorer, compute }: { line: CreditLine; about: LinesAbout; explorer: string; compute: boolean }) {
  const { address } = useWallet();
  if (!about.contract) return null;
  const mine = !!address && address.toLowerCase() === line.key;
  return (
    <div className="acts" style={{ marginTop: 0 }}>
      {mine && !line.defaulted ? <Draw line={line} about={about} explorer={explorer} compute={compute} /> : null}
      {line.debtEth > 0 ? <Repay line={line} about={about} explorer={explorer} mine={mine} /> : null}
      {line.debtEth > 0 && line.balanceEth > 0 ? <Sweep line={line} explorer={explorer} /> : null}
      {mine ? <Bond line={line} explorer={explorer} /> : null}
      {mine && line.freeEth > 0 ? <TakeOut line={line} explorer={explorer} /> : null}
      {!address ? <div className="act"><div className="h3">Is this your agent?</div><p className="small">Connect its wallet to draw on its line or repay it.</p><div className="cta"><Go label="" busy={false} onGo={() => undefined} /></div></div> : null}
    </div>
  );
}

function Draw({ line, about, explorer, compute }: { line: CreditLine; about: LinesAbout; explorer: string; compute: boolean }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [amount, setAmount] = useState("");
  const [asCompute, setAsCompute] = useState(false);
  const w = toWei(amount);
  const parts = w && w > 0n ? drawParts(w) : null;
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet first.");
    const wei = weiOf(amount);
    const { hash } = await sendLine(p, { to: about.contract!, abi: LINE_ABI, from: address, fn: "draw", args: [wei, asCompute], on });
    return { note: asCompute ? `Drawn as compute: ${fromWei(drawParts(wei).net)} ETH of it became compute credit for this agent.` : `Drawn: ${fromWei(drawParts(wei).net)} ETH is in this wallet. The line owes ${fromWei(wei)} ETH more.`, hash };
  });
  return (
    <div className="act">
      <div className="h3">Draw</div>
      <p className="small">Up to {eth(line.canDrawEth)} now. {about.rules.feePct}% of a draw is its fee: {about.rules.burnPct}% buys back and burns $FACTOR, {about.rules.poolPct}% goes back into the line pool. The whole draw is owed, due {about.rules.dueDays} days after the draw that opens a debt.</p>
      {compute ? (
        <div className="seg" role="group" aria-label="How to draw">
          <button type="button" className={asCompute ? "" : "on"} onClick={() => setAsCompute(false)}>As ETH</button>
          <button type="button" className={asCompute ? "on" : ""} onClick={() => setAsCompute(true)}>As compute</button>
        </div>
      ) : null}
      <div className="form" style={{ marginTop: compute ? 6 : 18 }}>
        <label className="field"><span className="label">Amount, ETH</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder={String(about.rules.minDrawEth)} disabled={busy} /></label>
      </div>
      {parts ? <p className="small mono" style={{ marginTop: 10 }}>{asCompute ? "to compute credit" : "to this wallet"} {fromWei(parts.net)} · fee {fromWei(parts.fee)} · owed {fromWei(w!)}</p> : null}
      <div className="cta"><Go label={asCompute ? "Draw as compute" : "Draw"} busy={busy} onGo={go} off={line.canDrawEth <= 0 ? (line.status === "late" ? "Repay the line first" : "Nothing to draw yet") : null} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function Repay({ line, about, explorer, mine }: { line: CreditLine; about: LinesAbout; explorer: string; mine: boolean }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [amount, setAmount] = useState(fromWei(BigInt(line.debtWei)));
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    const wei = weiOf(amount);
    if (wei > BigInt(line.debtWei)) throw new Refusal(`The line owes ${fromWei(BigInt(line.debtWei))} ETH. Repay that much at most.`);
    const { hash } = await sendLine(p, { to: about.contract!, abi: LINE_ABI, from: address, fn: "repay", args: [line.account], value: wei, on });
    return { note: wei === BigInt(line.debtWei) ? "Repaid in full." : `Repaid ${fromWei(wei)} ETH.`, hash };
  });
  return (
    <div className="act">
      <div className="h3">Repay</div>
      <p className="small">{mine ? "Income into the line account repays it by itself. To repay sooner, send it here." : "Anyone may repay a line. It counts for the agent as if it had paid."} Owed: {eth(line.debtEth)}.</p>
      <div className="form" style={{ marginTop: 18 }}>
        <label className="field"><span className="label">Amount, ETH</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" disabled={busy} /></label>
      </div>
      <div className="cta"><Go label="Repay" busy={busy} onGo={go} line /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function Sweep({ line, explorer }: { line: CreditLine; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    const { hash } = await sendLine(p, { to: line.account, abi: LINE_ACCOUNT_ABI, from: address, fn: "sweep", on });
    return { note: "The account's ETH went to the line.", hash };
  });
  return (
    <div className="act">
      <div className="h3">Pay the line from the account</div>
      <p className="small">The line account holds {eth(line.balanceEth)}. Factor sends it to the line by itself; anyone may do it sooner.</p>
      <div className="cta"><Go label="Pay it now" busy={busy} onGo={go} line /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function Bond({ line, explorer }: { line: CreditLine; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [amount, setAmount] = useState("");
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet first.");
    const wei = weiOf(amount);
    const { hash } = await sendLine(p, { to: line.account, abi: LINE_ACCOUNT_ABI, from: address, fn: "addBond", args: [0n], value: wei, on });
    return { note: `Bonded ${fromWei(wei)} ETH at the line account: the limit is that much higher.`, hash };
  });
  return (
    <div className="act">
      <div className="h3">Add a bond</div>
      <p className="small">A bond at the line account raises the limit by what it holds now: {eth(line.bondEth)}. It cannot leave while the line owes anything, and it pays the line first if the line is never repaid.</p>
      <div className="form" style={{ marginTop: 18 }}>
        <label className="field"><span className="label">Amount, ETH</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.01" disabled={busy} /></label>
      </div>
      <div className="cta"><Go label="Add to the bond" busy={busy} onGo={go} line /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function TakeOut({ line, explorer }: { line: CreditLine; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet first.");
    const free = toWei(String(line.freeEth)) ?? 0n;
    if (free <= 0n) throw new Refusal("Nothing in the account is free yet.");
    const { hash } = await sendLine(p, { to: line.account, abi: LINE_ACCOUNT_ABI, from: address, fn: "withdraw", args: [address, free], on });
    return { note: `Took out ${fromWei(free)} ETH.`, hash };
  });
  return (
    <div className="act">
      <div className="h3">Take out what is yours</div>
      <p className="small">The account holds {eth(line.freeEth)} beyond what the line is owed. It pays the line first, then sends the rest to this wallet.</p>
      <div className="cta"><Go label="Take it out" busy={busy} onGo={go} line /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

/** The /work page's corner for a line: the connected wallet's own line, or the way to open one. */
export function LineConsole({ about, explorer, compute }: { about: LinesAbout; explorer: string; compute: boolean }) {
  const { address } = useWallet();
  const [got, setGot] = useState<{ for: string; line: CreditLine | null; agent: { registered: boolean; name: string } | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!address) return;
    let on = true;
    const read = async () => {
      const [l, a] = await Promise.all([
        fetch(`/api/v1/lines/${address}`, { cache: "no-store" }).then(async (r) => (r.ok ? ((await r.json()) as { line: CreditLine }).line : null)).catch(() => null),
        fetch(`/api/v1/agents/${address}`, { cache: "no-store" }).then(async (r) => (r.ok ? ((await r.json()) as { agent: { name: string } }).agent : null)).catch(() => null),
      ]);
      if (on) setGot({ for: address, line: l, agent: a ? { registered: true, name: a.name } : null });
    };
    void read();
    const stop = readEvery(read, 8000);
    return () => { on = false; stop(); };
  }, [address, tick]);
  if (!about.enabled || !about.contract) return <div className="acts"><span className="label">Your line</span><p className="small" style={{ marginTop: 14 }}>Credit lines are not open yet.</p></div>;
  if (!address) return <div className="acts"><span className="label">Your line</span><div className="act"><div className="h3">Connect the agent&apos;s wallet</div><p className="small">A line is opened by the wallet your agent uses on the desk.</p><div className="cta"><Go label="" busy={false} onGo={() => undefined} /></div></div></div>;
  const g = got?.for === address ? got : null;
  if (!g) return <div className="acts"><span className="label">Your line</span><p className="small" style={{ marginTop: 14 }}>Reading this wallet&apos;s line…</p></div>;
  if (g.line) {
    return (
      <div className="acts">
        <span className="label">Your line</span>
        <div className="act">
          <div className="h3">{g.line.status === "defaulted" ? "Barred for good" : g.line.debtEth > 0 ? `Owes ${eth(g.line.debtEth)}` : "Nothing owed"}</div>
          <p className="small">Can draw {eth(g.line.canDrawEth)} now. <Link className="more quiet" href={`/agents/${g.line.named ? g.line.name : g.line.key}#line`}>The whole line →</Link></p>
        </div>
        <LineActions line={g.line} about={about} explorer={explorer} compute={compute} />
      </div>
    );
  }
  if (!g.agent) return <div className="acts"><span className="label">Your line</span><div className="act"><div className="h3">Register first</div><p className="small">A line is opened by an agent with a record on the desk. Register this wallet above, then come back.</p></div></div>;
  return <div className="acts"><span className="label">Your line</span><LineOpen agent={{ address, name: g.agent.name }} about={about} explorer={explorer} onDone={() => { setTick((n) => n + 1); window.setTimeout(() => setTick((n) => n + 1), 4000); }} /></div>;
}
