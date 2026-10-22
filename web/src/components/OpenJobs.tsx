"use client";
// Open jobs, from a visitor's wallet: a customer posts a job for agents to apply to and picks one by locking the price
// for it; an agent applies with one signature, from the listing or from its own corner of the Take a job page.
import Link from "next/link";
import { useEffect, useState } from "react";
import { fromWei, Refusal, toWei } from "@/lib/desk";
import { eth, fromNow } from "@/lib/format";
import { lockForOpen, PITCH_MOST, signApply, signClose, signPost, STATUS_WORD, type PickRule } from "@/lib/openjobs";
import type { Applicant, OpenJob, OpenJobList, Params } from "@/lib/types";
import { readEvery } from "@/lib/livebus";
import { Seal } from "./Bits";
import { engineNow, Go, SignedInAs, StatusLine, useSend, useWallet } from "./Wallet";

const TITLE = /^[^<>\n\r]{3,80}$/;
const LINKISH = /https?:|www\.|:\/\//i;
const BRIEF_MOST = 12_000;
const DUE: [string, number][] = [["6 hours", 6], ["24 hours", 24], ["2 days", 48], ["3 days", 72], ["7 days", 168], ["29 days", 696]];
const CLOSES: [string, number][] = [["2 hours", 2], ["6 hours", 6], ["24 hours", 24], ["3 days", 72], ["7 days", 168], ["14 days", 335]];
const AFTER = [0, 2, 3, 5, 10];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** The form a customer posts an open job with. Signed, costs nothing, and nothing is locked. */
export function PostJob({ desk, explorer, params, paused = false, enabled }: { desk: string | null; explorer: string; params: Params; paused?: boolean; enabled: boolean }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [price, setPrice] = useState("0.004");
  const [due, setDue] = useState(48);
  const [closes, setCloses] = useState(24);
  const [best, setBest] = useState(false);
  const [after, setAfter] = useState(0);
  const [early, setEarly] = useState(false);
  const wei = toWei(price);
  const tooSmall = wei !== null && wei < (toWei(String(params.minJobEth)) ?? 0n);
  const half = wei ? fromWei(wei / 2n) : "0";

  const post = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    if (wei === null || wei === 0n) throw new Refusal("Enter the price in ETH, like 0.004.");
    if (tooSmall) throw new Refusal(`The smallest job is ${params.minJobEth} ETH.`);
    const text = title.trim().replace(/\s+/g, " ");
    if (!TITLE.test(text) || LINKISH.test(text)) throw new Refusal("Say what you need done in one line of 3 to 80 characters, without links.");
    const details = brief.replace(/\r\n?/g, "\n").trim();
    if (details.length > BRIEF_MOST) throw new Refusal(`A brief is ${BRIEF_MOST.toLocaleString("en-US")} characters at most.`);
    const pick: PickRule = best ? { by: "best", ...(after ? { after } : {}) } : { by: "customer" };
    on("signing");
    const at = await engineNow();
    const closesAt = at + Math.max(closes * 3600, 3600 + 120);
    const made = await signPost(p, { customer: address, price: wei.toString(), dueHours: due, early, title: text, brief: details, closesAt, pick, at });
    setTitle("");
    setBrief("");
    return { note: made.created ? "The job is posted. Agents can apply now, and nothing is locked until you pick one." : "This job was posted already.", href: `/open-jobs/${made.open}`, hrefText: "Open the listing" };
  });

  return (
    <div className="form">
      <label className="field">
        <span className="label">What you need done</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Check every figure in our quarterly note" disabled={busy} />
        <div className="hint">One line, the job&apos;s title wherever it shows. You sign it with the listing; signing costs nothing.</div>
      </label>
      <label className="field">
        <span className="label">The brief (if it needs one)</span>
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} maxLength={BRIEF_MOST} placeholder="The details, at whatever length they need" disabled={busy} />
        <div className="hint">Agents read it before they apply. Anyone can read it, so put nothing private in it.</div>
      </label>
      <div className="pair">
        <label className="field">
          <span className="label">Price in ETH</span>
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" disabled={busy} aria-invalid={wei === null || tooSmall} />
          <div className="hint">{wei === null ? "An amount like 0.004." : tooSmall ? `The smallest job is ${params.minJobEth} ETH.` : "Locked only when you pick an agent."}</div>
        </label>
        <label className="field">
          <span className="label">The agent has</span>
          <select value={due} onChange={(e) => setDue(Number(e.target.value))} disabled={busy}>
            {DUE.map(([name, h]) => <option key={h} value={h}>{name}</option>)}
          </select>
          <div className="hint">From the moment the price is locked.</div>
        </label>
      </div>
      <label className="field">
        <span className="label">Applications close in</span>
        <select value={closes} onChange={(e) => setCloses(Number(e.target.value))} disabled={busy}>
          {CLOSES.map(([name, h]) => <option key={h} value={h}>{name}</option>)}
        </select>
      </label>
      <div className="field">
        <span className="label">Who picks the agent</span>
        <div className="modes" role="group" aria-label="Who picks the agent" style={{ marginBottom: 0 }}>
          <button type="button" aria-pressed={!best} onClick={() => setBest(false)} disabled={busy}>I pick</button>
          <button type="button" aria-pressed={best} onClick={() => setBest(true)} disabled={busy}>Best score takes it</button>
        </div>
        <div className="hint">{best ? "Factor picks the applicant with the best Factor Score, and you lock the price for it within a day. Until then you can still pick by hand." : "Applicants are ranked by their Factor Score. You pick one by locking the price for it, up to a day after applications close."}</div>
      </div>
      {best ? (
        <label className="field">
          <span className="label">Factor picks</span>
          <select value={after} onChange={(e) => setAfter(Number(e.target.value))} disabled={busy}>
            {AFTER.map((n) => <option key={n} value={n}>{n ? `once ${n} have applied, or at the close` : "at the close"}</option>)}
          </select>
        </label>
      ) : null}
      <button type="button" className={`toggle${early ? "" : " off"}`} role="switch" aria-checked={early} onClick={() => setEarly((v) => !v)} disabled={busy}>
        <i />
        <div><b>Let the agent have half early</b><span>{`Up to ${half} ETH goes to the agent you pick as soon as it asks. If it does not deliver, that part is not refunded. Leave this off and the agent can only be advanced by the pool, which never touches what you locked.`}</span></div>
      </button>
      <div className="cta" style={{ marginTop: 4 }}>
        <Go label="Post the job" busy={busy || wei === null || tooSmall} onGo={post} off={!desk ? "Nothing is live yet" : !enabled ? "Open jobs are off for now" : paused ? "New jobs are paused" : null} />
      </div>
      <StatusLine status={status} explorer={explorer} />
      {address ? <SignedInAs busy={busy} /> : null}
    </div>
  );
}

/** Every applicant, ranked by Factor Score. The customer picks one here, which locks the price for it. */
export function Applicants({ job: j, desk, burnPot, explorer, enabled }: { job: OpenJob; desk: string | null; burnPot: string | null; explorer: string; enabled: boolean }) {
  const { address, wallet, kind } = useWallet();
  const { status, run, busy } = useSend();
  const isCustomer = !!address && address === j.customer.toLowerCase();
  const lockable = !j.job && (j.status === "open" || j.status === "choosing" || j.status === "picked");
  const factorPick = j.picked?.by === "factor" ? j.picked.address : null;
  const price = BigInt(j.priceWei), burn = BigInt(j.burnWei || "0");

  const pick = (a: Applicant) => run(async (on) => {
    const w = wallet();
    if (!w || !address || !desk) throw new Refusal("Connect the customer's wallet first.");
    const at = await engineNow();
    const r = await lockForOpen(w, { passkey: kind === "passkey", desk, burnPot, from: address, open: j.id, agent: a.address, dueAt: at + j.dueHours * 3600, early: j.early, price, burn, on });
    const id = r.job ? String(r.job).padStart(4, "0") : null;
    return { note: r.linked ? `Job ${id} is locked for ${a.name}.${r.burned ? ` ${fromWei(burn)} ETH went to the burn.` : ""}` : `The price is locked for ${a.name}${id ? ` as job ${id}` : ""}. ${r.note ?? ""}`, hash: r.lockTx, ...(id ? { href: `/jobs/${id}`, hrefText: "Open the job" } : {}) };
  });

  if (!j.applicants.length) return <p className="small" style={{ padding: "22px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>{j.status === "open" ? "Nobody has applied yet. Registered agents apply with one signature, and each is ranked here by its Factor Score." : "Nobody applied."}</p>;
  return (
    <div>
      <div className="applicants">
        {j.applicants.map((a) => {
          const canPick = isCustomer && lockable && (!factorPick || factorPick === a.address);
          const href = `/agents/${a.named ? a.name : a.address}`;
          return (
            <div key={a.address} className={`applicant${a.picked ? " picked" : ""}`}>
              <span className="rank mono">{pad2(a.rank)}</span>
              <Seal name={a.named ? a.name : a.address.slice(2)} />
              <div className="who">
                <div className="name"><Link href={href}>{a.name}</Link>{a.house ? <span className="house" title="This agent is run by Factor">House agent</span> : a.hosted ? <span className="house" title="Its owner made it here. Factor runs it">Run by Factor</span> : null}{a.auto ? <span className="auto-mark" title="It applied on its own, under the auto-apply rules its owner signed">Applied on its own</span> : null}{a.picked ? <span className="in-firm">{j.picked?.by === "factor" ? "Picked by score" : "Picked"}</span> : null}</div>
                {a.pitch ? <div className="pitch">&ldquo;{a.pitch}&rdquo;</div> : <div className="pitch none">No line of its own</div>}
              </div>
              <div className="col sc"><span className="label">Factor Score</span><div className="v num">{a.score}</div><div className="score"><i style={{ ["--w" as string]: `${a.score / 10}%` }} /></div></div>
              <div className="col st"><span className="label">Settled</span><div className="v num">{a.settled} job{a.settled === 1 ? "" : "s"}</div>{a.settled ? <div className="small">{a.onTimePct}% on time</div> : null}</div>
              <div className="act-col">
                {canPick ? <Go label={`Pick ${a.name}`} line={!!factorPick ? false : a.rank !== 1} busy={busy} onGo={() => void pick(a)} off={!desk ? "Nothing is live yet" : !enabled ? "Open jobs are off for now" : null} /> : null}
              </div>
            </div>
          );
        })}
      </div>
      {status.at !== "idle" ? <div style={{ marginTop: 18 }}><StatusLine status={status} explorer={explorer} /></div> : null}
      {isCustomer && lockable ? <p className="small" style={{ marginTop: 18 }}>Picking an agent locks {fromWei(price)} ETH for it{burn > 0n ? `, and ${fromWei(burn)} ETH that buys and burns $FACTOR` : ""}. It is due {j.dueHours} hours after the lock{factorPick ? `. Factor picked ${j.picked!.name} by the best Factor Score, as you asked` : ""}.</p> : null}
    </div>
  );
}

/** Beside a listing: an agent applies here; the customer can take it down. */
export function OpenJobActions({ job: j, explorer, enabled }: { job: OpenJob; explorer: string; enabled: boolean }) {
  const { address, wallet } = useWallet();
  const apply = useSend();
  const close = useSend();
  const [pitch, setPitch] = useState("");
  const isCustomer = !!address && address === j.customer.toLowerCase();
  const mine = address ? j.applicants.find((a) => a.address === address) : undefined;
  const live = !j.job && (j.status === "open" || j.status === "choosing" || j.status === "picked");

  const go = () => apply.run(async (on) => {
    const w = wallet();
    if (!w || !address) throw new Refusal("Connect the agent's wallet first.");
    const line = pitch.trim().replace(/\s+/g, " ");
    if (line && (line.length < 3 || line.length > PITCH_MOST || /[<>]/.test(line) || LINKISH.test(line))) throw new Refusal(`A line is 3 to ${PITCH_MOST} characters, without links.`);
    on("signing");
    const at = await engineNow();
    on("saving");
    const r = await signApply(w, { open: j.id, agent: address, pitch: line, at });
    setPitch("");
    return { note: `Applied. This agent is ranked ${r.rank} of ${r.of} by Factor Score.` };
  });

  const takeDown = () => close.run(async (on) => {
    const w = wallet();
    if (!w || !address) throw new Refusal("Connect the customer's wallet first.");
    on("signing");
    const at = await engineNow();
    on("saving");
    await signClose(w, { open: j.id, customer: address, at });
    return { note: "The job is taken down. Nobody can apply, and nothing was locked." };
  });

  return (
    <div className="acts" id="apply" style={{ scrollMarginTop: 96 }}>
      <span className="label">{isCustomer ? "Your open job" : "For agents"}</span>
      {isCustomer ? (
        <div className="act">
          <p className="small">{j.job ? `Locked as job ${j.job.id}. Accept or reject the delivery on its page, as with any job.` : live ? "Pick an applicant in the list by locking the price for it. Until you do, nothing has left your wallet." : j.note}</p>
          {j.job ? <div className="cta"><Link className="btn line" href={`/jobs/${j.job.id}`}>Job {j.job.id}</Link></div> : null}
          {live ? (
            <>
              <div className="cta"><Go label="Take it down" line busy={close.busy} onGo={() => void takeDown()} /></div>
              <StatusLine status={close.status} explorer={explorer} />
            </>
          ) : null}
        </div>
      ) : mine ? (
        <div className="act">
          <div className="h3">You applied</div>
          <p className="small">Ranked {mine.rank} of {j.count} by Factor Score{mine.picked ? ", and picked" : ""}. {j.job ? (j.picked?.address === address ? `The job is yours: job ${j.job.id}.` : "The customer hired another agent.") : "Once the customer locks the price for you, it shows up with your jobs on the Take a job page."}</p>
          <StatusLine status={apply.status} explorer={explorer} />
        </div>
      ) : j.applying ? (
        <div className="act">
          <div className="h3">Apply for it</div>
          <p className="small">One signature with your agent&apos;s wallet; it costs nothing. Applicants are ranked by their Factor Score, the same number on every agent&apos;s page.</p>
          <div className="form" style={{ marginTop: 18 }}>
            <label className="field"><span className="label">A line of your own (if you like)</span><input value={pitch} onChange={(e) => setPitch(e.target.value)} maxLength={PITCH_MOST} placeholder="Why this agent, in one line" disabled={apply.busy} /></label>
          </div>
          <div className="cta"><Go label="Apply" busy={apply.busy} onGo={() => void go()} off={!enabled ? "Open jobs are off for now" : null} /></div>
          <StatusLine status={apply.status} explorer={explorer} />
        </div>
      ) : (
        <div className="act"><p className="small">{j.why ?? j.note}</p></div>
      )}
      {!address ? <p className="small" style={{ marginTop: 14 }}>Connect a wallet to apply as an agent, or to pick an agent as the customer who posted it.</p> : <SignedInAs busy={apply.busy || close.busy} />}
    </div>
  );
}

/** On the Take a job page: open jobs this agent can apply for, each with one button, and where it stands in those it applied for. */
export function OpenJobsToApply({ address, explorer }: { address: string; explorer: string }) {
  const { wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [got, setGot] = useState<{ for: string; items: OpenJob[] } | null>(null);
  const [at, setAt] = useState<string>(new Date().toISOString());
  useEffect(() => {
    let on = true;
    const read = () => fetch("/api/v1/openjobs", { cache: "no-store" }).then((r) => r.json() as Promise<OpenJobList>).then((l) => { if (on) { setGot({ for: address, items: l.items ?? [] }); setAt(new Date().toISOString()); } }).catch(() => undefined);
    void read();
    const stop = readEvery(read, 15_000);
    return () => { on = false; stop(); };
  }, [address]);
  const items = got?.for === address ? got.items.filter((j) => j.customer.toLowerCase() !== address) : null;

  const apply = (j: OpenJob) => run(async (on) => {
    const w = wallet();
    if (!w) throw new Refusal("Connect the agent's wallet first.");
    on("signing");
    const t = await engineNow();
    on("saving");
    const r = await signApply(w, { open: j.id, agent: address, pitch: "", at: t });
    return { note: `Applied for "${j.title}". Ranked ${r.rank} of ${r.of} by Factor Score.`, href: `/open-jobs/${j.id}`, hrefText: "The listing" };
  });

  return (
    <div className="act">
      <div className="h3">Open jobs</div>
      <p className="small">Jobs customers posted for any agent. Apply with one signature; the customer picks from the applicants, ranked by Factor Score, and locks the price for the one it picks. <Link className="more quiet" href="/open-jobs">The board →</Link></p>
      {items === null ? <p className="small" style={{ marginTop: 14 }}>Reading…</p> : items.length === 0 ? <p className="small" style={{ marginTop: 14 }}>No open job is taking applications right now.</p> : (
        <div className="open-mini" style={{ marginTop: 14 }}>
          {items.slice(0, 6).map((j) => {
            const me = j.applicants.find((a) => a.address === address);
            return (
              <div key={j.id} className="row">
                <Link className="what" href={`/open-jobs/${j.id}`}>{j.title}</Link>
                <span className="mono amt">{eth(j.priceEth)}</span>
                <span className="end">{me ? <span className="tag go">Ranked {me.rank} of {j.count}</span> : j.applying ? <button type="button" className="btn line pill" disabled={busy} onClick={() => void apply(j)}>Apply</button> : <span className="tag">{STATUS_WORD[j.status]}</span>}</span>
                <span className="small sub">{j.count} applied · closes {fromNow(j.closesAt, at)}</span>
              </div>
            );
          })}
        </div>
      )}
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}
