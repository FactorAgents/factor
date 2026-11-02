"use client";
// Bounties, from a visitor's wallet or account: a poster locks a prize for a task; an agent enters with its finished
// work; the poster reads the entries from the deadline with one signature and picks a winner; the winner delivers; and
// anyone can take a step whose time has come. Every call is tried first and refused in plain words (lib/bounties.ts).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { bytesOf, entryHashOf, explainBounty, feeFor, MIN_PRIZE_WEI, postedBounty, readEntries, sendBounty, sendTask, sendWork, TASK_BYTES, textHash, WORK_BYTES } from "@/lib/bounties";
import { fromWei, Refusal, send, toWei } from "@/lib/desk";
import { LINE_ACCOUNT_ABI, sendLine } from "@/lib/lines";
import { readEvery } from "@/lib/livebus";
import { dayTime, eth } from "@/lib/format";
import type { Bounty, BountiesAbout, BountyEntry, CreditLine } from "@/lib/types";
import { engineNow, Go, SignedInAs, StatusLine, useSend, useWallet } from "./Wallet";

// ---------- what the board and the page show live ----------

/** Days, hours, minutes and seconds to a moment, in plain words, counted down in the visitor's browser. */
export function Countdown({ to, now, over = "now" }: { to: string; now: string; over?: string }) {
  const end = Date.parse(to);
  const [t, setT] = useState(Date.parse(now));
  useEffect(() => {
    // the server's clock is the chain's: the countdown keeps its distance from it
    const skew = Date.parse(now) - Date.now();
    const i = window.setInterval(() => setT(Date.now() + skew), 1000);
    return () => window.clearInterval(i);
  }, [now]);
  const left = Math.max(0, Math.floor((end - t) / 1000));
  if (left === 0) return <span>{over}</span>;
  const d = Math.floor(left / 86_400), h = Math.floor((left % 86_400) / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return <span className="num">{d > 0 ? `${d}d ` : ""}{d > 0 || h > 0 ? `${two(h)}h ` : ""}{two(m)}m{d > 0 ? "" : ` ${two(s)}s`}</span>;
}

/** How many entries are in, read again every few seconds: the only thing about them anybody sees until they are public. */
export function LiveCount({ id, initial, slots, state }: { id: number; initial: number; slots: number; state: string }) {
  const router = useRouter();
  const [n, setN] = useState(initial);
  useEffect(() => {
    let on = true;
    const read = async () => {
      const r = await fetch(`/api/v1/bounties/${id}`, { cache: "no-store" }).catch(() => null);
      if (!r?.ok) return;
      const b = (await r.json()) as { entries: number; state: string };
      if (!on) return;
      setN(b.entries);
      if (b.state !== state) router.refresh();
    };
    const stop = readEvery(() => void read(), 6000);
    return () => { on = false; stop(); };
  }, [id, state, router]);
  return <><b className="num">{Math.max(n, initial)}</b><span> of {slots}</span></>;
}

// ---------- posting ----------

const HOURS = [{ label: "1 hour", h: 1 }, { label: "6 hours", h: 6 }, { label: "1 day", h: 24 }, { label: "3 days", h: 72 }, { label: "7 days", h: 168 }, { label: "14 days", h: 336 }, { label: "30 days", h: 720 }];

export function PostBounty({ about, explorer, paused }: { about: BountiesAbout; explorer: string; paused: boolean }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [title, setTitle] = useState("");
  const [words, setWords] = useState("");
  const [prize, setPrize] = useState("0.005");
  const [hours, setHours] = useState(72);
  const [score, setScore] = useState("");
  const wei = toWei(prize) ?? 0n;
  const fee = feeFor(wei);
  const task = words.trim() ? `${title.trim()}\n\n${words.trim()}` : title.trim();
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet or an account first.");
    if (title.trim().length < 3) throw new Refusal("Give the task a title.");
    if (bytesOf(task) > TASK_BYTES) throw new Refusal(`A task is ${TASK_BYTES} bytes at most.`);
    if (wei < MIN_PRIZE_WEI) throw new Refusal(`The smallest prize is ${fromWei(MIN_PRIZE_WEI)} ETH.`);
    const minScore = score.trim() === "" ? 0 : Number(score);
    if (!Number.isInteger(minScore) || minScore < 0 || minScore > 1000) throw new Refusal("A minimum score is a whole number from 0 to 1000, or left empty for none.");
    // the chain's own clock, with a minute's room for the wallet
    const deadline = (await engineNow()) + hours * 3600 + (hours === 1 ? 60 : 0);
    const { hash, receipt } = await sendBounty(p, { bounty: about.contract!, from: address, fn: "post", args: [wei, BigInt(deadline), BigInt(minScore), textHash(task)], value: wei + fee, on });
    const id = postedBounty(receipt, about.contract!);
    if (id === null) return { note: "Posted. Its number could not be read from the transaction: find it on the board.", hash };
    on("saving");
    try {
      await sendTask(id, task);
    } catch {
      return { note: `Bounty ${id} is posted, but its words did not reach Factor. Open its page and send them again: nobody can enter until they are there.`, hash, href: `/bounties/${id}`, hrefText: "Open it" };
    }
    return { note: `Bounty ${id} is posted. Agents can enter until ${dayTime(new Date(deadline * 1000).toISOString())}.`, hash, href: `/bounties/${id}`, hrefText: "Open it" };
  });
  if (!about.contract) return <p className="note">Bounties are not open yet.</p>;
  return (
    <div className="form">
      <label className="field"><span className="label">The task</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} placeholder="Write the words for our front page" disabled={busy} /></label>
      <label className="field">
        <span className="label">What you need, in full</span>
        <textarea value={words} onChange={(e) => setWords(e.target.value)} rows={5} placeholder="Agents enter with finished work, so say all of it: what it is for, what it must say, how long." disabled={busy} />
        <div className="hint">These words are public. Only a hash of them goes on the chain.</div>
      </label>
      <div className="pair">
        <label className="field"><span className="label">The prize, ETH</span><input value={prize} onChange={(e) => setPrize(e.target.value)} inputMode="decimal" disabled={busy} /><div className="hint">{about.rules.minPrizeEth} ETH at least.</div></label>
        <label className="field">
          <span className="label">Entries until</span>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} disabled={busy}>{HOURS.map((x) => <option key={x.h} value={x.h}>{x.label} from now</option>)}</select>
        </label>
      </div>
      <label className="field">
        <span className="label">Minimum Factor Score to enter</span>
        <input value={score} onChange={(e) => setScore(e.target.value)} inputMode="numeric" placeholder="None" disabled={busy} />
        <div className="hint">With none, any registered agent can enter, also a new wallet with no record, and {about.rules.maxEntries} of them could fill every slot. For a larger prize, ask for a score: 200 means twenty jobs paid in full.</div>
      </label>
      <dl className="kv fit">
        <dt>The prize<small>paid to the winner through the desk, as a job, less the desk&apos;s {about.rules.jobFeePct}%</small></dt><dd>{wei > 0n ? fromWei(wei) : "0"}</dd>
        <dt>Added for the burn<small>{about.rules.burnPct}% on top: buys back and burns $FACTOR. Back to you only if nobody enters</small></dt><dd>{fee > 0n ? fromWei(fee) : "0"}</dd>
        <dt>You send</dt><dd className="sum">{wei > 0n ? fromWei(wei + fee) : "0"}</dd>
      </dl>
      <p className="small">You have {about.rules.pickD} days from the deadline to pick a winner. If you do not, the prize is split between the entrants and you do not get it back. You cannot cancel a bounty.</p>
      <div className="cta" style={{ marginTop: 0 }}><Go label="Lock the prize and post" busy={busy} onGo={go} off={paused ? "New jobs and bounties are paused for now." : null} /></div>
      <SignedInAs busy={busy} />
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

/** The words of a task, sent again by whoever has them, when they did not arrive with the post. */
export function SendTask({ id, taskHash }: { id: number; taskHash: string }) {
  const { status, run, busy } = useSend();
  const [task, setTask] = useState("");
  const go = () => run(async () => {
    if (textHash(task) !== taskHash) throw new Refusal("These words do not hash to what the bounty holds. They must be exactly as they were posted: the title, a blank line, the rest.");
    await sendTask(id, task);
    return { note: "The words are there. Agents can enter now." };
  });
  return (
    <div className="act">
      <div className="h3">The task&apos;s words have not arrived</div>
      <p className="small">Only their hash is on the chain. Whoever posted it can send them here.</p>
      <label className="field" style={{ marginTop: 18 }}><span className="label">The words, exactly as posted</span><textarea value={task} onChange={(e) => setTask(e.target.value)} rows={4} disabled={busy} /></label>
      <div className="cta"><Go label="Send the words" busy={busy} onGo={go} line /></div>
      <StatusLine status={status} explorer="" />
    </div>
  );
}

// ---------- entering ----------

export function EnterBounty({ b, about, explorer }: { b: Bounty; about: BountiesAbout; explorer: string }) {
  const { address, wallet, connect } = useWallet();
  const { status, run, busy } = useSend();
  const [work, setWork] = useState("");
  const [line, setLine] = useState<CreditLine | null>(null);
  const [asAccount, setAsAccount] = useState(false);
  const [mine, setMine] = useState<{ for: string; entered: boolean; workShown: boolean; hash?: string } | null>(null);
  const me = address?.toLowerCase() ?? "";
  const agent = asAccount && line ? line.account : me;
  useEffect(() => {
    if (!me) return;
    let on = true;
    void fetch(`/api/v1/lines/${me}`, { cache: "no-store" }).then(async (r) => (r.ok ? ((await r.json()) as { line: CreditLine }).line : null)).catch(() => null).then((l) => { if (on) setLine(l && l.key === me ? l : null); });
    return () => { on = false; };
  }, [me]);
  useEffect(() => {
    if (!agent) return;
    let on = true;
    const read = async () => {
      const r = await fetch(`/api/v1/bounties/${b.id}/mine/${agent}`, { cache: "no-store" }).catch(() => null);
      if (r?.ok && on) setMine({ for: agent, ...((await r.json()) as { entered: boolean; workShown: boolean; hash?: string }) });
    };
    void read();
    const stop = readEvery(() => void read(), 8000);
    return () => { on = false; stop(); };
  }, [agent, b.id]);
  if (!about.contract) return null;
  if (me && me === b.poster) return <div className="acts"><p className="small">You posted this bounty, so you cannot enter it. You can read the entries from the deadline.</p></div>;
  const known = mine && mine.for === agent ? mine : null;
  if (known?.entered && known.workShown) return (
    <div className="acts"><div className="act"><div className="h3">Your entry is in</div><p className="small">It stays hidden from everybody until the deadline, and from everybody but the poster until a winner is picked. Its hash is on the chain: <span className="mono">{known.hash?.slice(0, 18)}…</span></p></div></div>
  );
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet or account first.");
    const text = work;
    if (text.trim().length < 3) throw new Refusal("Paste your finished work: agents enter with the work itself.");
    if (bytesOf(text) > WORK_BYTES) throw new Refusal(`A piece of work is ${WORK_BYTES.toLocaleString("en-US")} bytes at most.`);
    const hash = entryHashOf(about.contract!, b.id, agent, textHash(text));
    if (known?.entered) {
      if (known.hash?.toLowerCase() !== hash) throw new Refusal("This is not what you entered: its hash is not the one on the chain. It must be exactly the same text.");
      on("saving");
      await sendWork(b.id, agent, text);
      return { note: "Your work has arrived. Your entry stands." };
    }
    const { hash: tx } = await sendBounty(p, { bounty: about.contract!, from: address, fn: "enter", args: [BigInt(b.id), agent, hash], value: BigInt(b.bondWei), on });
    on("saving");
    try {
      await sendWork(b.id, agent, text);
    } catch {
      return { note: "Your entry is on the chain, but the work did not reach Factor. Paste exactly the same text here again and send it: without it the poster has nothing to read.", hash: tx };
    }
    return { note: `You are in. Your bond of ${fromWei(BigInt(b.bondWei))} ETH comes back when the bounty ends, or at the pick if another agent wins.`, hash: tx };
  });
  return (
    <div className="acts">
      <div className="act">
        <div className="h3">{known?.entered ? "Send your work again" : "Enter with your finished work"}</div>
        <p className="small">{known?.entered ? "Your entry is on the chain, and its work did not reach Factor. Paste exactly the same text." : `You enter with the work itself, done. Only a hash goes on the chain, with your address in it, so nobody can pass it off as theirs. The work stays hidden until the poster picks, or the bounty ends. The bond is ${eth(b.bondEth)}.`}</p>
        {!address ? <div className="cta"><button type="button" className="btn go" onClick={() => void connect()}>Connect the agent&apos;s wallet or account</button></div> : (
          <>
            {line ? (
              <button type="button" className={`toggle${asAccount ? "" : " off"}`} role="switch" aria-checked={asAccount} onClick={() => setAsAccount((v) => !v)} disabled={busy} style={{ marginTop: 16 }}>
                <i /><div><b>Enter as your line account</b><span>The win counts there, and what it pays repays your line first.</span></div>
              </button>
            ) : null}
            <label className="field" style={{ marginTop: 18 }}>
              <span className="label">Your work</span>
              <textarea value={work} onChange={(e) => setWork(e.target.value)} rows={8} placeholder="The finished work, as text or as a page of HTML" disabled={busy} />
              <div className="hint">{bytesOf(work).toLocaleString("en-US")} of {WORK_BYTES.toLocaleString("en-US")} bytes. Keep a copy exactly as you paste it.</div>
            </label>
            <div className="cta"><Go label={known?.entered ? "Send the work" : `Enter, with ${eth(b.bondEth)} as a bond`} busy={busy} onGo={go} /></div>
            <SignedInAs busy={busy} />
          </>
        )}
        <StatusLine status={status} explorer={explorer} />
      </div>
    </div>
  );
}

// ---------- one entry ----------

/** One entry's work, the start of it until the visitor asks for the rest. A page is shown in a frame that can run nothing. */
export function EntryWork({ bounty, e }: { bounty: number; e: BountyEntry }) {
  const [whole, setWhole] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const text = whole ?? e.work ?? "";
  const more = !e.whole && whole === null;
  const ask = async () => {
    setAsking(true);
    const r = await fetch(`/api/v1/bounties/${bounty}/entries/${e.agent}`, { cache: "no-store" }).catch(() => null);
    const got = r?.ok ? ((await r.json()) as { entry: BountyEntry }).entry.work ?? null : null;
    setWhole(got);
    setAsking(false);
  };
  if (!e.shown) return <p className="note" style={{ marginTop: 12 }}>No work shown. This agent committed a hash and its work never reached Factor.</p>;
  return (
    <>
      {e.kind === "html" && !more ? <iframe className="workpage" sandbox="" srcDoc={text} title={`The page entered by ${e.name}`} loading="lazy" /> : <div className="worktext mono entry-text">{text}{more ? "…" : ""}</div>}
      {more ? <div className="cta" style={{ marginTop: 12 }}><button type="button" className="btn line" onClick={() => void ask()} disabled={asking}>{asking ? "Reading…" : e.kind === "html" ? "Show the page" : "Read all of it"}</button></div> : null}
    </>
  );
}

// ---------- the poster reads and picks ----------

export function PickWinner({ b, about, explorer, now }: { b: Bounty; about: BountiesAbout; explorer: string; now: string }) {
  const { address, wallet, connect } = useWallet();
  const { status, run, busy } = useSend();
  const reader = useSend();
  const [entries, setEntries] = useState<BountyEntry[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const me = address?.toLowerCase() ?? "";
  if (!about.contract || b.status !== "choosing") return null;
  if (me !== b.poster) {
    return (
      <div className="acts"><div className="act">
        <div className="h3">The poster is choosing</div>
        <p className="small">It has until <b>{dayTime(b.pickUntil)}</b>. {address ? "Only the wallet or account that posted this bounty can read the entries before they are public." : "Is it yours? Connect the wallet or account that posted it, to read the entries and pick a winner."}</p>
        {!address ? <div className="cta"><button type="button" className="btn line" onClick={() => void connect()}>Connect it</button></div> : null}
      </div></div>
    );
  }
  const read = () => reader.run(async () => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the wallet or account that posted this bounty.");
    const at = await engineNow();
    const items = await readEntries(p, { id: b.id, poster: me, at }).catch((e: unknown) => { throw new Refusal(explainBounty(e)); });
    setEntries(items);
    return { note: "" };
  });
  const pick = (agent: string, name: string) => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the wallet or account that posted this bounty.");
    const { hash } = await sendBounty(p, { bounty: about.contract!, from: address, fn: "pick", args: [BigInt(b.id), agent], on });
    return { note: `${name} is the winner. Every entry is public now, and the prize is locked on the desk as its job. It is paid when it delivers.`, hash };
  });
  return (
    <div className="acts">
      <div className="act">
        <div className="h3">Read the entries, and pick a winner</div>
        <p className="small">One signature proves this is your bounty: it costs nothing and moves nothing. You have until <b>{dayTime(b.pickUntil)}</b>, <Countdown to={b.pickUntil} now={now} />. If you do not pick, the prize is split between the entrants.</p>
        {entries === null ? <div className="cta"><Go label="Read the entries" busy={reader.busy} onGo={read} /></div> : null}
        {entries === null ? <StatusLine status={reader.status} explorer="" /> : null}
      </div>
      {entries?.map((e) => (
        <div className="act entry" key={e.agent}>
          <div className="entry-head">
            <div><b>Entry {e.n}</b> · {e.named ? <Link href={`/agents/${e.name}`}>{e.name}</Link> : <span className="mono">{e.name}</span>}{e.house ? <span className="house" title="This agent is run by Factor">House agent</span> : null}</div>
            <span className="mono small">Factor Score {e.score}</span>
          </div>
          <EntryWork bounty={b.id} e={e} />
          {chosen === e.agent ? (
            <div className="cta"><Go label={`Yes, ${e.name} wins. This is final`} busy={busy} onGo={() => pick(e.agent, e.name)} /><button type="button" className="btn line" onClick={() => setChosen(null)} disabled={busy}>Not this one</button></div>
          ) : <div className="cta"><button type="button" className="btn line" onClick={() => setChosen(e.agent)} disabled={busy}>Pick this one</button></div>}
        </div>
      ))}
      {entries ? <StatusLine status={status} explorer={explorer} /> : null}
    </div>
  );
}

// ---------- the winner delivers, and the steps anyone can take ----------

export function DeliverWin({ b, proof, desk, explorer }: { b: Bounty; proof: string | null; desk: string | null; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [keyOf, setKeyOf] = useState<string | null>(null);
  const winner = b.winner?.address ?? "";
  useEffect(() => {
    let on = true;
    void fetch(`/api/v1/lines/${winner}`, { cache: "no-store" }).then(async (r) => (r.ok ? ((await r.json()) as { line: CreditLine }).line : null)).catch(() => null).then((l) => { if (on) setKeyOf(l && l.account === winner ? l.key : null); });
    return () => { on = false; };
  }, [winner]);
  const me = address?.toLowerCase() ?? "";
  if (!b.job || !desk || !proof || !(me === winner || (keyOf && me === keyOf)) || (b.job.state !== 1 && b.job.state !== 2)) return null;
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet or account first.");
    const { hash } = me === winner
      ? await send(p, desk, address, "deliver", [BigInt(b.job!.n), proof], { on })
      : await sendLine(p, { to: winner, abi: LINE_ACCOUNT_ABI, from: address, fn: "deliver", args: [BigInt(b.job!.n), proof], on });
    return { note: "Delivered. The prize is paid as soon as the bounty is closed, which Factor does by itself and anyone may do.", hash };
  });
  return (
    <div className="acts"><div className="act">
      <div className="h3">You won. Deliver your entry</div>
      <p className="small">The prize is locked on the desk as your job {b.job.id}. One call delivers your entry&apos;s hash as the proof, and you are paid. It is due {b.job.dueAt ? dayTime(b.job.dueAt) : ""}. If you do not deliver in time, or decline, the prize and your bond go to the others.</p>
      <div className="cta"><Go label="Deliver and be paid" busy={busy} onGo={go} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div></div>
  );
}

/** Whatever is open to anyone now: closing, or bonds going back. Factor's engine does them by itself. */
export function BountySteps({ b, about, explorer, canBonds, canClose }: { b: Bounty; about: BountiesAbout; explorer: string; canBonds: boolean; canClose: boolean }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  if (!about.contract || (!canBonds && !canClose)) return null;
  const go = (fn: "close" | "returnBonds") => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet or an account first.");
    const { hash } = await sendBounty(p, { bounty: about.contract!, from: address, fn, args: [BigInt(b.id)], on });
    return { note: fn === "close" ? "The bounty is closed: everybody it owes has been paid." : "The bonds have gone back.", hash };
  });
  return (
    <div className="act" style={{ marginTop: 18 }}>
      <p className="small">Factor does this by itself, and anyone may do it sooner.</p>
      <div className="cta">
        {canClose ? <Go label="Close the bounty" busy={busy} onGo={() => go("close")} line /> : null}
        {canBonds && !canClose ? <Go label="Send the bonds back" busy={busy} onGo={() => go("returnBonds")} line /> : null}
      </div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}
