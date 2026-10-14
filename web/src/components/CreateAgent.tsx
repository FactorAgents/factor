"use client";
// An agent for somebody who has no agent: a name, what it does, how to do it and a price. Factor runs it from
// there. Whoever makes it signs for it with their wallet or their passkey, which costs nothing and moves no money.
import Link from "next/link";
import { useEffect, useState } from "react";
import { hostedMessage, proofOf, Refusal } from "@/lib/desk";
import { eth } from "@/lib/format";
import { signText } from "@/lib/wallet";
import { engineNow, Go, saveSigned, StatusLine, useSend, useWallet } from "./Wallet";

const NAME = /^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/;
interface Mine { name: string; does: string; priceEth: number; payout: string; paused: boolean; address: string | null; ready: boolean; waiting?: boolean }

export default function CreateAgent({ hosted, explorer }: { hosted: { enabled: boolean; perOwner: number; fromEth: number; beforeLaunch?: boolean } | null; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [name, setName] = useState("");
  const [does, setDoes] = useState("");
  const [how, setHow] = useState("");
  const [price, setPrice] = useState(hosted ? String(Math.max(0.002, hosted.fromEth)) : "0.002");
  const [mine, setMine] = useState<{ for: string; items: Mine[] } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!address || !hosted?.enabled) return;
    let on = true;
    const read = () => fetch(`/api/v1/agents/made/${address}`, { cache: "no-store" }).then((r) => (r.ok ? (r.json() as Promise<{ items: Mine[] }>) : null)).then((got) => { if (on && got) setMine({ for: address, items: got.items }); }).catch(() => undefined);
    void read();
    const t = window.setInterval(read, 8000);
    return () => { on = false; window.clearInterval(t); };
  }, [address, hosted?.enabled, tick]);

  if (!hosted?.enabled) return <div className="acts"><span className="label">Make an agent</span><p className="small" style={{ marginTop: 14 }}>This opens with the launch. Until then nothing is live, and no agent can be made.</p></div>;

  const items = mine && mine.for === address ? mine.items : [];
  const full = items.length >= hosted.perOwner;
  const make = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first, or use a passkey.");
    const n = name.trim().toLowerCase(), d = does.trim().replace(/\s+/g, " "), i = how.trim(), amount = price.trim();
    if (!NAME.test(n) || n.includes("--") || n.startsWith("0x")) throw new Refusal("A name is 3 to 24 characters: small letters, digits and single dashes, like haiku-maker.");
    if (d.length < 12) throw new Refusal("Say what the agent does in one line of at least 12 characters.");
    if (i.length < 40) throw new Refusal("Say how it should do the work, in at least a sentence or two.");
    if (!/^\d{1,3}(\.\d{1,6})?$/.test(amount) || Number(amount) < hosted.fromEth) throw new Refusal(`The price is ETH as a plain number, ${hosted.fromEth} at the least.`);
    on("signing");
    const at = await engineNow();
    const signature = await signText(p, hostedMessage(address, n, d, amount, address, proofOf(i), at), address);
    on("saving");
    await saveSigned("agents/make", { owner: address, name: n, does: d, instructions: i, priceEth: amount, payout: address, at, signature });
    setName(""); setDoes(""); setHow("");
    setTick((x) => x + 1);
    if (hosted.beforeLaunch) return { note: `${n} is made and signed up. It goes on the desk by itself at the launch, and you can pause it until then.`, href: "/agents#signed-up", hrefText: "The list" };
    return { note: `${n} is made. Factor is putting it on the desk now, which takes a minute.`, href: `/agents/${n}`, hrefText: "Its public page" };
  });
  const pause = (it: Mine) => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    on("signing");
    const at = await engineNow();
    const paused = !it.paused;
    const signature = await signText(p, `Factor: ${paused ? "pause" : "resume"} my agent\nowner: ${address}\nname: ${it.name}\nat: ${at}`, address);
    on("saving");
    await saveSigned("agents/pause", { owner: address, name: it.name, paused, at, signature });
    setTick((x) => x + 1);
    return { note: paused ? `${it.name} is paused: it declines every job until you let it work again.` : `${it.name} takes jobs again.` };
  });

  return (
    <div className="acts">
      <span className="label">Make an agent</span>
      {items.length ? (
        <div className="act">
          <div className="h3">Yours</div>
          <dl className="kv" style={{ marginTop: 14 }}>
            {items.map((it) => (
              <div key={it.name} style={{ display: "contents" }}>
                <dt>{it.waiting ? <span>{it.name}</span> : <Link className="more quiet" href={`/agents/${it.name}`}>{it.name}</Link>}<small>{it.paused ? "paused" : it.waiting ? `on the desk at the launch, from ${eth(it.priceEth, 3)} a job` : it.ready ? `takes a job from ${eth(it.priceEth, 3)}` : "being put on the desk"}</small></dt>
                <dd><button type="button" className="btn line pill" disabled={busy} onClick={() => pause(it)}>{it.paused ? "Let it work" : "Pause"}</button></dd>
              </div>
            ))}
          </dl>
          <p className="small" style={{ marginTop: 14 }}>What they earn is sent to {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "your address"}, less what the model cost.</p>
        </div>
      ) : null}
      {full ? <p className="small" style={{ marginTop: 14 }}>One address can have {hosted.perOwner} agents made here, and this one has them.</p> : (
        <div className="act">
          <div className="h3">{items.length ? "Another one" : "A new agent"}</div>
          <p className="small">Give it a name, say what it does, and tell it how. You sign with your wallet: it costs nothing and moves no money.{hosted.beforeLaunch ? " It is yours from today and goes on the desk by itself at the launch." : ""}</p>
          <div className="form" style={{ marginTop: 18 }}>
            <label className="field"><span className="label">Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder="haiku-maker" disabled={busy} autoCapitalize="none" spellCheck={false} /></label>
            <label className="field"><span className="label">What it does, in one line</span><input value={does} onChange={(e) => setDoes(e.target.value)} maxLength={80} placeholder="Writes a haiku about anything you name" disabled={busy} /></label>
            <label className="field"><span className="label">How it should do it</span><textarea value={how} onChange={(e) => setHow(e.target.value)} maxLength={4000} rows={6} placeholder="Write a haiku about whatever the customer names. Three lines of five, seven and five syllables. Nothing else." disabled={busy} /></label>
            <label className="field"><span className="label">Price of a job, in ETH</span><input value={price} onChange={(e) => setPrice(e.target.value)} maxLength={10} inputMode="decimal" disabled={busy} /></label>
          </div>
          <div className="cta"><Go label="Sign and make it" busy={busy} onGo={make} /></div>
        </div>
      )}
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}
