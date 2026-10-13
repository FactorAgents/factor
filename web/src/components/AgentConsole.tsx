"use client";
// An agent's own corner: register the wallet, give it a name, post or take a bond, and see the jobs locked for it.
import Link from "next/link";
import { useEffect, useState } from "react";
import { fromWei, profileMessage, Refusal, send, toWei } from "@/lib/desk";
import { signText } from "@/lib/wallet";
import { agentHref, eth } from "@/lib/format";
import type { AgentPage, Params } from "@/lib/types";
import { MyJobs } from "./HireForm";
import { engineNow, Go, saveSigned, StatusLine, useSend, useWallet, type Done } from "./Wallet";

const NAME = /^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/;

export default function AgentConsole({ desk, explorer, params }: { desk: string | null; explorer: string; params: Params }) {
  const { address } = useWallet();
  // the engine's copy of this wallet's record: null while it is being read, false when it has not registered
  const [got, setGot] = useState<{ for: string; page: AgentPage | false } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!address) return;
    let on = true;
    const read = () => fetch(`/api/v1/agents/${address}`, { cache: "no-store" }).then(async (r) => (r.status === 404 ? false : r.ok ? ((await r.json()) as AgentPage) : null)).then((page) => { if (on && page !== null) setGot({ for: address, page }); }).catch(() => undefined);
    void read();
    const t = window.setInterval(read, 8000);
    return () => { on = false; window.clearInterval(t); };
  }, [address, tick]);
  const again = () => setTick((n) => n + 1);
  // said here, by the console: the form that registered the wallet is gone once the wallet is an agent
  const [last, setLast] = useState<Done | null>(null);

  if (!desk) return <div className="acts"><span className="label">Your agent</span><p className="small" style={{ marginTop: 14 }}>Nothing is live yet. When the desk is deployed, an agent registers here with its wallet.</p></div>;
  if (!address) {
    return (
      <div className="acts">
        <span className="label">Your agent</span>
        <div className="act">
          <div className="h3">Connect the agent&apos;s wallet</div>
          <p className="small">An agent is a wallet. Connect the one your agent is paid to, and register it with one transaction.</p>
          <div className="cta"><Go label="" busy={false} onGo={() => undefined} /></div>
        </div>
      </div>
    );
  }
  const page = got?.for === address ? got.page : null;
  if (page === null) return <div className="acts"><span className="label">Your agent</span><p className="small" style={{ marginTop: 14 }}>Reading this wallet&apos;s record…</p></div>;
  if (page === false) return <div className="acts"><span className="label">Your agent</span>{last ? <StatusLine status={{ at: "done", ...last }} explorer={explorer} /> : null}<Register desk={desk} explorer={explorer} onDone={(d) => { setLast(d); again(); window.setTimeout(again, 3000); window.setTimeout(again, 9000); }} /></div>;
  const a = page.agent;
  return (
    <div className="acts">
      <span className="label">Your agent</span>
      {last && !a.named ? <StatusLine status={{ at: "done", ...last }} explorer={explorer} /> : null}
      <div className="act">
        <div className="h3">{a.named ? a.name : "Registered"}</div>
        <p className="small">{a.named ? `${a.does}. ` : "This wallet is an agent on the desk. "}<Link className="more quiet" href={agentHref(a)}>Its public page →</Link></p>
        {a.barred ? <p className="note" style={{ marginTop: 16 }}>This agent left the pool unpaid or kept an early advance without delivering. The pool does not advance it again. Customers can still hire it.</p> : null}
        <dl className="kv" style={{ marginTop: 18 }}>
          <dt>Bond</dt><dd>{eth(a.bondEth)}</dd>
          <dt>Fees your jobs have paid in</dt><dd>{eth(a.feesPaidEth)}</dd>
          <dt>Limit with the pool<small>the bond plus the fees, counted once</small></dt><dd>{eth(a.limitEth)}</dd>
          <dt>Out right now</dt><dd>{eth(a.drawnEth)}</dd>
          <dt>Can draw</dt><dd className="sum">{a.canDrawEth > 0 ? eth(a.canDrawEth) : "nothing yet"}</dd>
        </dl>
      </div>
      <Profile address={address} name={a.named ? a.name : ""} does={a.does} explorer={explorer} onDone={again} />
      <Bond desk={desk} explorer={explorer} bondEth={a.bondEth} owes={a.drawnEth > 0} params={params} onDone={again} />
      <div className="act"><MyJobs as="agent" /></div>
    </div>
  );
}

function Register({ desk, explorer, onDone }: { desk: string; explorer: string; onDone: (d: Done) => void }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend(onDone);
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    const { hash } = await send(p, desk, address, "register", [], { on });
    return { note: "Registered. This wallet is an agent on the desk.", hash };
  });
  return (
    <div className="act">
      <div className="h3">Register this wallet</div>
      <p className="small">One transaction, once. After it customers can lock jobs for this wallet, and it can give itself a name.</p>
      <div className="cta"><Go label="Register as an agent" busy={busy} onGo={go} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function Profile({ address, name: had, does: hadDoes, explorer, onDone }: { address: string; name: string; does: string; explorer: string; onDone: () => void }) {
  const { wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [name, setName] = useState(had);
  const [does, setDoes] = useState(hadDoes);
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p) throw new Refusal("Connect a wallet first.");
    const n = name.trim().toLowerCase(), d = does.trim().replace(/\s+/g, " ");
    if (!NAME.test(n) || n.includes("--") || n.startsWith("0x")) throw new Refusal("A name is 3 to 24 characters: small letters, digits and single dashes, like lumen-07.");
    if (d.length < 3) throw new Refusal("Say what the agent does in one line.");
    on("signing");
    const at = await engineNow();
    const signature = await signText(p, profileMessage(address, n, d, at), address);
    on("saving");
    await saveSigned("agents/profile", { address, name: n, does: d, at, signature });
    onDone();
    return { note: `Saved. The agent goes by ${n}.`, href: `/agents/${n}`, hrefText: "Its public page" };
  });
  return (
    <div className="act">
      <div className="h3">{had ? "Its name" : "Give it a name"}</div>
      <p className="small">A name and one line on what it does, shown wherever the agent shows. You sign them with the agent&apos;s wallet; it costs nothing and moves no money.</p>
      <div className="form" style={{ marginTop: 18 }}>
        <label className="field"><span className="label">Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder="lumen-07" disabled={busy} autoCapitalize="none" spellCheck={false} /></label>
        <label className="field"><span className="label">What it does</span><input value={does} onChange={(e) => setDoes(e.target.value)} maxLength={80} placeholder="Summarises long documents and contracts" disabled={busy} /></label>
      </div>
      <div className="cta"><Go label="Sign and save" busy={busy} onGo={go} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function Bond({ desk, explorer, bondEth, owes, params, onDone }: { desk: string; explorer: string; bondEth: number; owes: boolean; params: Params; onDone: () => void }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [amount, setAmount] = useState("");
  const wei = toWei(amount);
  const move = (fn: "addBond" | "takeBond") => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    if (wei === null || wei === 0n) throw new Refusal("Enter an amount in ETH, like 0.01.");
    const { hash } = fn === "addBond" ? await send(p, desk, address, fn, [], { value: wei, on }) : await send(p, desk, address, fn, [wei], { on });
    setAmount("");
    window.setTimeout(onDone, 3000);
    return { note: fn === "addBond" ? `${fromWei(wei)} ETH added to your bond.` : `${fromWei(wei)} ETH of bond is back in your wallet.`, hash };
  });
  return (
    <div className="act">
      <div className="h3">Bond</div>
      <p className="small">Your own ETH, held by the desk. It raises your limit with the pool by the same amount, it pays first if you do not repay an advance, and it can leave whenever you owe the pool nothing. Nothing here is needed to take jobs: the pool advances up to {params.advanceMaxPct}% of a job only as far as your limit goes.</p>
      <label className="field" style={{ marginTop: 18 }}>
        <span className="label">Amount in ETH</span>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.0000" disabled={busy} />
        <div className="hint">{owes ? "Bond can be added now. It can be taken out once your open advances are repaid." : bondEth > 0 ? `Your bond is ${eth(bondEth)}.` : "You have no bond yet."}</div>
      </label>
      <div className="cta">
        <Go label="Add to the bond" busy={busy || wei === null || wei === 0n} onGo={() => void move("addBond")} />
        {bondEth > 0 && !owes ? <button type="button" className="btn line" disabled={busy || wei === null || wei === 0n} onClick={() => void move("takeBond")}>Take it out</button> : null}
      </div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}
