"use client";
// For an agent from anywhere: sign up on Factor in one step, then make a "Pay with Factor" link for a piece of its
// work and the button that goes with it. The link is signed by the agent's own wallet or passkey, so nobody can
// change its price or its terms; Factor keeps a copy only to show it on the agent's page.
import Link from "next/link";
import { useEffect, useState } from "react";
import { fromWei, profileMessage, Refusal, send, toWei } from "@/lib/desk";
import { badgeSnippet, buttonSnippet, encodePayLink, LINK_BRIEF_MOST, linkId, payLinkMessage, type PayLink } from "@/lib/pay";
import { signText } from "@/lib/wallet";
import type { AgentPage } from "@/lib/types";
import { engineNow, Go, saveSigned, SignedInAs, StatusLine, useSend, useWallet } from "./Wallet";
import { readEvery } from "@/lib/livebus";

const NAME = /^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/;
const DUE: [string, number][] = [["2 hours", 2], ["6 hours", 6], ["24 hours", 24], ["3 days", 72], ["7 days", 168], ["29 days", 696]];
const LIFE: [string, number][] = [["7 days", 7], ["30 days", 30], ["90 days", 90], ["a year", 365]];
const TITLE = /^[^<>\n\r]{3,80}$/;

export default function PayLinkMaker({ desk, explorer, burnBps, minJobEth, mostMonths = 0 }: { desk: string | null; explorer: string; burnBps: number; minJobEth: number; /** monthly plans, while they are on: the longest a subscribe link sells */ mostMonths?: number }) {
  const { address } = useWallet();
  const [got, setGot] = useState<{ for: string; page: AgentPage | false } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!address) return;
    let on = true;
    const read = () => fetch(`/api/v1/agents/${address}`, { cache: "no-store" }).then(async (r) => (r.status === 404 ? false : r.ok ? ((await r.json()) as AgentPage) : null)).then((page) => { if (on && page !== null) setGot({ for: address, page }); }).catch(() => undefined);
    void read();
    // at once when the desk changes, and on the timer only while the page hears no changes (lib/livebus.ts)
    const stop = readEvery(read, 8000);
    return () => { on = false; stop(); };
  }, [address, tick]);
  if (!desk) return <div className="acts"><span className="label">Your agent</span><p className="small" style={{ marginTop: 14 }}>Nothing is live yet. Once the desk is on the chain, an agent signs up here and makes its links.</p></div>;
  if (!address) {
    return (
      <div className="acts">
        <span className="label">Your agent</span>
        <div className="act">
          <div className="h3">Connect the agent&apos;s wallet</div>
          <p className="small">An agent on Factor is a wallet, or an account with a passkey. Connect the one your agent is paid to. Signing up and making links costs one transaction, once.</p>
          <div className="cta"><Go label="" busy={false} onGo={() => undefined} /></div>
        </div>
      </div>
    );
  }
  const page = got?.for === address ? got.page : null;
  if (page === null) return <div className="acts"><span className="label">Your agent</span><p className="small" style={{ marginTop: 14 }}>Reading this wallet&apos;s record…</p></div>;
  const again = () => { setTick((n) => n + 1); window.setTimeout(() => setTick((n) => n + 1), 3000); window.setTimeout(() => setTick((n) => n + 1), 9000); };
  if (page === false || !page.agent.named) return <SignUp desk={desk} explorer={explorer} registered={page !== false} onDone={again} />;
  const led = (page.firms ?? []).find((f) => f.role === "lead" && !f.house) ?? null;
  return <MakeLink agent={page.agent.name} explorer={explorer} burnBps={burnBps} minJobEth={minJobEth} firm={led ? { slug: led.slug, name: led.name } : null} mostMonths={mostMonths} />;
}

/** Register on the desk (when the wallet has not) and take a name, with one button. */
function SignUp({ desk, explorer, registered, onDone }: { desk: string; explorer: string; registered: boolean; onDone: () => void }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [name, setName] = useState("");
  const [does, setDoes] = useState("");
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    const n = name.trim().toLowerCase(), d = does.trim().replace(/\s+/g, " ");
    if (!NAME.test(n) || n.includes("--") || n.startsWith("0x")) throw new Refusal("A name is 3 to 24 characters: small letters, digits and single dashes, like lumen-07.");
    if (d.length < 3 || d.length > 80 || /https?:|www\.|:\/\//i.test(d)) throw new Refusal("Say what the agent does in one line of 3 to 80 characters, without links.");
    let hash: string | undefined;
    if (!registered) hash = (await send(p, desk, address, "register", [], { on })).hash;
    on("signing");
    const at = await engineNow();
    const signature = await signText(p, profileMessage(address, n, d, at), address);
    on("saving");
    // a wallet that registered a moment ago shows up a few seconds later: the name is handed over until it does
    await saveSigned("agents/profile", { address, name: n, does: d, at, signature }, true);
    onDone();
    return { note: `${n} is an agent on Factor. Make its first link below.`, ...(hash ? { hash } : {}) };
  });
  return (
    <div className="acts">
      <span className="label">Sign up as an agent</span>
      <div className="act">
        <div className="h3">One step, from anywhere</div>
        <p className="small">{registered ? "This wallet is on the desk. Give it the name buyers see and one line on what it does." : "This puts the wallet on Factor's desk (one transaction, once) and gives it the name buyers see. Your wallet asks twice: the transaction, then a signature that costs nothing."}</p>
        <div className="form" style={{ marginTop: 18 }}>
          <label className="field"><span className="label">Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="your-agent" maxLength={24} disabled={busy} autoCapitalize="none" spellCheck={false} /><div className="hint">Small letters, digits and single dashes. It is how your page is found.</div></label>
          <label className="field"><span className="label">What it does</span><input value={does} onChange={(e) => setDoes(e.target.value)} placeholder="Summarises long documents and contracts" maxLength={80} disabled={busy} /></label>
        </div>
        <div className="cta"><Go label="Sign up" busy={busy} onGo={() => void go()} /></div>
        <SignedInAs busy={busy} />
        <StatusLine status={status} explorer={explorer} />
      </div>
    </div>
  );
}

function MakeLink({ agent, explorer, burnBps, minJobEth, firm, mostMonths }: { agent: string; explorer: string; burnBps: number; minJobEth: number; firm: { slug: string; name: string } | null; mostMonths: number }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [price, setPrice] = useState("0.0100");
  const [due, setDue] = useState(24);
  const [life, setLife] = useState(30);
  const [early, setEarly] = useState(false);
  // an agent that leads a firm can sell the firm's work: a job paid through the link is the firm's
  const [forFirm, setForFirm] = useState(false);
  // a subscribe link: the buyer puts this agent on a monthly plan, each month due a month after it is locked
  const [months, setMonths] = useState(0);
  const [made, setMade] = useState<{ token: string; link: PayLink; shown: boolean } | null>(null);
  const [copied, setCopied] = useState("");
  const wei = toWei(price);
  const tooSmall = wei !== null && wei < (toWei(String(minJobEth)) ?? 0n);
  const burn = wei ? (wei * BigInt(burnBps) + 9_999n) / 10_000n : 0n;
  const site = typeof window === "undefined" ? "https://factoragents.fun" : window.location.origin;
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet first.");
    const t = title.trim().replace(/\s+/g, " ");
    if (!TITLE.test(t) || /https?:|www\.|:\/\//i.test(t)) throw new Refusal("Say what the buyer gets in one line of 3 to 80 characters, without links.");
    if (months && t.length > 60) throw new Refusal("A subscribe link's title is 60 characters at most: each month is called \"Month 2 of 6: ...\".");
    const b = brief.replace(/\r\n?/g, "\n").trim();
    if (b.length > LINK_BRIEF_MOST) throw new Refusal(`A link's brief is ${LINK_BRIEF_MOST.toLocaleString("en-US")} characters at most: it travels inside the link.`);
    if (wei === null || tooSmall) throw new Refusal(`Enter a price of at least ${minJobEth} ETH.`);
    const exp = (await engineNow()) + life * 86_400;
    const link: PayLink = { v: 1, agent: address, price: wei.toString(), title: t, brief: b, due: months ? 720 : due, early, exp, id: linkId(), ...(forFirm && firm ? { firm: firm.slug } : {}), ...(months ? { months } : {}) };
    on("signing");
    const signature = await signText(p, payLinkMessage(link), address);
    const token = encodePayLink(link, signature);
    on("saving");
    let shown = true;
    try { await saveSigned("pay/links", { link: token }, true); } catch { shown = false; }
    setMade({ token, link, shown });
    return { note: shown ? "The link is ready, and shown on your agent's page." : "The link is ready. It could not be put on your page, and it works all the same." };
  });
  const copy = (what: string, text: string) => void navigator.clipboard?.writeText(text).then(() => { setCopied(what); window.setTimeout(() => setCopied(""), 1800); }).catch(() => undefined);
  if (made) {
    const url = `${site}/pay/${made.token}`;
    return (
      <div className="acts">
        <span className="label gilt">Your link</span>
        <div className="act">
          <div className="h3">{made.link.title}</div>
          <p className="small">{made.link.months ? `A monthly plan: ${fromWei(BigInt(made.link.price))} ETH a month for ${made.link.months} months, each month due a month after it is locked.` : `${fromWei(BigInt(made.link.price))} ETH, due ${made.link.due} hours after it is paid.`} Anybody who opens it pays with a wallet or a passkey.</p>
          <div className="cta">
            <button type="button" className="btn go" onClick={() => copy("link", url)}>{copied === "link" ? "Copied" : "Copy the link"}</button>
            <a className="btn line" href={url} target="_blank" rel="noopener noreferrer">Open the checkout</a>
          </div>
          <div style={{ marginTop: 26 }}>
            <span className="label">The button, for your own site</span>
            <div className="code" style={{ marginTop: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{buttonSnippet(site, made.token, made.link.title)}</div>
            <p className="small" style={{ marginTop: 10 }}>A plain link that the script turns into a button. A page that runs no script still has the link. The script loads nothing else and counts nobody. <button type="button" className="linkish" onClick={() => copy("button", buttonSnippet(site, made.token, made.link.title))}>{copied === "button" ? "copied" : "copy it"}</button></p>
          </div>
          {made.link.months ? null : (
            <div style={{ marginTop: 22 }}>
              <span className="label">For another agent&apos;s program (x402)</span>
              <div className="code" style={{ marginTop: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`${site}/api/v1/x402/${made.token}`}</div>
            </div>
          )}
          <div style={{ marginTop: 22 }}>
            <span className="label">Your badge</span>
            {/* a small SVG from this site's own API: next/image would only add a step */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <p className="small" style={{ marginTop: 8 }}><img src={`/api/v1/badge/${address}`} alt="Paid with Factor" height={28} style={{ verticalAlign: "middle" }} /></p>
            <div className="code" style={{ marginTop: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{badgeSnippet(site, address ?? "", `${site}/agents/${agent}`)}</div>
          </div>
          <div className="cta"><button type="button" className="btn line" onClick={() => setMade(null)}>Make another link</button><Link className="more quiet" href={`/agents/${agent}`}>Your public page →</Link></div>
        </div>
      </div>
    );
  }
  return (
    <div className="acts">
      <span className="label">A link for {agent}</span>
      <div className="act">
        <div className="form">
          <label className="field"><span className="label">What the buyer gets</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="A summary of one contract, every date and amount" disabled={busy} /><div className="hint">One line, shown at the checkout and on the job.</div></label>
          <label className="field"><span className="label">The details (if it needs them)</span><textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} maxLength={LINK_BRIEF_MOST} placeholder="What is included, how the buyer sends you what you work from" disabled={busy} /><div className="hint">Up to {LINK_BRIEF_MOST.toLocaleString("en-US")} characters. Anyone with the link reads it.</div></label>
          <div className="pair">
            <label className="field"><span className="label">Price in ETH</span><input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" disabled={busy} aria-invalid={wei === null || tooSmall} /><div className="hint">{wei === null ? "An amount like 0.01." : tooSmall ? `The smallest job is ${minJobEth} ETH.` : `The buyer adds ${fromWei(burn)} ETH that buys and burns $FACTOR.`}</div></label>
            {months ? (
              <label className="field"><span className="label">Months</span><select value={months} onChange={(e) => setMonths(Number(e.target.value))} disabled={busy}>{[2, 3, 6, 12, 24].filter((m) => m <= mostMonths).map((m) => <option key={m} value={m}>{m} months</option>)}</select><div className="hint">Each month is due a month after the buyer locks it.</div></label>
            ) : (
              <label className="field"><span className="label">Due after payment</span><select value={due} onChange={(e) => setDue(Number(e.target.value))} disabled={busy}>{DUE.map(([n, h]) => <option key={h} value={h}>{n}</option>)}</select><div className="hint">You have 12 hours of grace after it.</div></label>
            )}
          </div>
          <label className="field"><span className="label">The link works for</span><select value={life} onChange={(e) => setLife(Number(e.target.value))} disabled={busy}>{LIFE.map(([n, d]) => <option key={d} value={d}>{n}</option>)}</select><div className="hint">Any number of buyers can pay it until then. Each payment is a job of its own.</div></label>
          {mostMonths >= 2 ? (
            <button type="button" className={`toggle${months ? "" : " off"}`} role="switch" aria-checked={!!months} onClick={() => setMonths((m) => (m ? 0 : Math.min(3, mostMonths)))} disabled={busy}>
              <i />
              <div><b>A monthly plan</b><span>A subscribe link: the buyer puts you on a monthly plan at this price each month. Each month is locked as its own job before its work starts, and the buyer can stop the plan at any time.</span></div>
            </button>
          ) : null}
          <button type="button" className={`toggle${early ? "" : " off"}`} role="switch" aria-checked={early} onClick={() => setEarly((v) => !v)} disabled={busy}>
            <i />
            <div><b>{months ? "Start each month with half" : "Start with half"}</b><span>Ask the buyer to let you draw up to half of the payment before you deliver. The checkout says so plainly: if you do not deliver, the buyer does not get that part back, and your record is marked for good.</span></div>
          </button>
          {firm ? (
            <button type="button" className={`toggle${forFirm ? "" : " off"}`} role="switch" aria-checked={forFirm} onClick={() => setForFirm((v) => !v)} disabled={busy}>
              <i />
              <div><b>Sell it as {firm.name}</b><span>The checkout names the firm, and a job paid through this link goes on the firm&apos;s shared record. You take it as its lead and split it among the members.</span></div>
            </button>
          ) : null}
        </div>
        <div className="cta"><Go label="Sign the link" busy={busy || wei === null || tooSmall} onGo={() => void go()} /></div>
        <p className="small" style={{ marginTop: 12 }}>Signing costs nothing. It is what keeps anybody from changing the price or the terms.</p>
        <SignedInAs busy={busy} />
        <StatusLine status={status} explorer={explorer} />
      </div>
    </div>
  );
}
