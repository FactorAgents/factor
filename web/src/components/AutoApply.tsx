"use client";
// Auto-apply on an agent's page: its rules, set once with its owner's signature, and what it did on its own. The owner
// (the agent's own wallet, or whoever runs it on Factor) sees the rules as a form; everybody else reads them.
import Link from "next/link";
import { useState } from "react";
import { fromWei, Refusal, toWei } from "@/lib/desk";
import { fromNow, short } from "@/lib/format";
import { hoursWords, LOG_WORD, signRules } from "@/lib/autoapply";
import type { AutoApplyRules, AutoApplyStatus } from "@/lib/types";
import { engineNow, Go, SignedInAs, StatusLine, useSend, useWallet } from "./Wallet";

const LINKISH = /https?:|www\.|:\/\//i;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const two = (n: number) => String(n).padStart(2, "0");
/** The time an agent's offers take, from the lock. */
const OFFER_TIMES: [string, number][] = [["1 hour", 1], ["6 hours", 6], ["12 hours", 12], ["24 hours", 24], ["2 days", 48], ["3 days", 72], ["7 days", 168]];
const timeWords = (h: number) => OFFER_TIMES.find(([, n]) => n === h)?.[0] ?? `${h} hours`;

/** The rules in words, the way the teaser card says them. */
function RulesRead({ r }: { r: AutoApplyRules }) {
  return (
    <dl className="kv auto-rules">
      <dt>Takes</dt><dd>{[...r.takes, ...r.words.map((w) => `"${w}"`)].join(", ") || "nothing yet"}</dd>
      <dt>From</dt><dd>{`${fromWei(BigInt(r.floorWei))} ETH a job`}</dd>
      <dt>At a time</dt><dd>{`Up to ${r.atOnce} job${r.atOnce === 1 ? "" : "s"}`}</dd>
      <dt>Hours</dt><dd>{r.hours ? hoursWords(r.hours) : "Always on"}</dd>
      <dt>Half up front</dt><dd>{r.early ? "When the customer allows it" : "Never"}</dd>
      {r.bid ? <><dt>Its offers</dt><dd>{`${fromWei(BigInt(r.bid.normalWei))} ETH, ${fromWei(BigInt(r.bid.freeWei))} ETH when free, in ${timeWords(r.bid.hours)}`}</dd></> : null}
      {r.pitch ? <><dt>Its line</dt><dd className="line">&ldquo;{r.pitch}&rdquo;</dd></> : null}
    </dl>
  );
}

export function AutoApplyPanel({ st, fromEth, asOf, explorer, enabled, bids = false }: { st: AutoApplyStatus; fromEth: number | null; asOf: string; explorer: string; enabled: boolean; bids?: boolean }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const r = st.rules;
  const owner = !!address && (address === st.agent || st.setters.includes(address));
  const [on, setOn] = useState(r?.on ?? false);
  const [takes, setTakes] = useState<string[]>(r?.takes ?? []);
  const [words, setWords] = useState((r?.words ?? []).join(", "));
  const [from, setFrom] = useState(r ? fromWei(BigInt(r.floorWei)) : String(fromEth ?? 0.001));
  const [atOnce, setAtOnce] = useState(r?.atOnce ?? 1);
  const [always, setAlways] = useState(!r?.hours);
  const [hFrom, setHFrom] = useState(r?.hours?.from ?? 9);
  const [hTo, setHTo] = useState(r?.hours?.to ?? 17);
  const [early, setEarly] = useState(r?.early ?? false);
  const [pitch, setPitch] = useState(r?.pitch ?? "");
  const [offers, setOffers] = useState(!!r?.bid);
  const [normal, setNormal] = useState(r?.bid ? fromWei(BigInt(r.bid.normalWei)) : "");
  const [free, setFree] = useState(r?.bid ? fromWei(BigInt(r.bid.freeWei)) : "");
  const [offerHours, setOfferHours] = useState(r?.bid?.hours ?? 24);
  const wei = toWei(from);
  const normalWei = toWei(normal || from), freeWei = toWei(free || normal || from);
  const flip = (k: string) => setTakes((had) => (had.includes(k) ? had.filter((x) => x !== k) : [...had, k]));

  const save = () => run(async (step) => {
    const w = wallet();
    if (!w || !address) throw new Refusal("Connect the owner's wallet first.");
    if (wei === null || wei < 10n ** 15n) throw new Refusal("The lowest price is 0.001 ETH or more.");
    const own = words.split(",").map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean);
    if (own.length > 12 || own.some((x) => x.length < 2 || x.length > 40 || /[<>]/.test(x) || LINKISH.test(x))) throw new Refusal("Words of its own are up to 12, each 2 to 40 characters, with commas between them and no links.");
    if (on && !takes.length && !own.length) throw new Refusal("Say what work it takes: pick a kind, or give a word of its own.");
    const line = pitch.trim().replace(/\s+/g, " ");
    if (line && (line.length < 3 || line.length > 280 || /[<>]/.test(line) || LINKISH.test(line))) throw new Refusal("Its line is 3 to 280 characters, without links.");
    if (!always && hFrom === hTo) throw new Refusal("The hours start and end at different times.");
    const pricing = bids && offers;
    if (pricing && (normalWei === null || normalWei < wei)) throw new Refusal("Its normal offer is its lowest price or more.");
    if (pricing && (freeWei === null || freeWei < wei || freeWei > normalWei!)) throw new Refusal("The offer with nothing on its hands is from its lowest price up to its normal offer.");
    step("signing");
    const at = await engineNow();
    step("saving");
    const saved = await signRules(w, { agent: st.agent, by: address, at, on, takes: st.kinds.filter((k) => takes.includes(k)), words: own, floorWei: wei.toString(), atOnce, hours: always ? null : { from: hFrom, to: hTo }, early, pitch: line, ...(pricing ? { bid: { normalWei: normalWei!.toString(), freeWei: freeWei!.toString(), hours: offerHours } } : {}) });
    return { note: saved.on ? `Saved. ${st.name} applies on its own from now on.` : `Saved. ${st.name} no longer applies on its own.` };
  });

  if (!owner) {
    return (
      <div className="auto-side">
        <div className={`auto-state${r?.on && enabled ? " on" : ""}`}><i />{!enabled ? "Auto-apply is off on Factor for now" : r?.on ? "Auto-apply is on" : "Auto-apply is off"}</div>
        {r ? <RulesRead r={r} /> : <p className="small" style={{ marginTop: 18 }}>No rules are set for {st.name} yet.</p>}
        {st.signed ? <p className="small" style={{ marginTop: 16 }}>Signed by {st.signed.by === st.agent ? "the agent itself" : short(st.signed.by)}, {fromNow(st.signed.at, asOf)}. Only {st.runBy === "factor" && st.setters.length ? "its owner" : "the agent itself"} can change them.</p> : null}
        {!address ? <p className="small" style={{ marginTop: 10 }}>Connect {st.runBy === "factor" && st.setters.length ? "its owner's" : "the agent's"} wallet to set them.</p> : null}
      </div>
    );
  }
  return (
    <div className="auto-side">
      <div className="form">
        <button type="button" className={`toggle${on ? "" : " off"}`} role="switch" aria-checked={on} onClick={() => setOn((v) => !v)} disabled={busy}>
          <i />
          <div><b>{on ? "Auto-apply is on" : "Auto-apply is off"}</b><span>{st.runBy === "factor" ? `${st.name} watches the open jobs, applies, does the work and delivers on its own, under these rules.` : `Factor finds the open jobs that fit, and ${st.name}'s own program applies with its own key.`}</span></div>
        </button>
        <div className="field">
          <span className="label">Takes</span>
          <div className="chips" role="group" aria-label="The work it takes">
            {st.kinds.map((k) => <button key={k} type="button" aria-pressed={takes.includes(k)} onClick={() => flip(k)} disabled={busy}>{k}</button>)}
          </div>
          <input value={words} onChange={(e) => setWords(e.target.value)} placeholder="Words of its own, like bakery, menu" disabled={busy} style={{ marginTop: 12 }} />
          <div className="hint">Found in a listing&apos;s title and brief.</div>
        </div>
        <div className="pair">
          <label className="field">
            <span className="label">From, in ETH a job</span>
            <input value={from} onChange={(e) => setFrom(e.target.value)} inputMode="decimal" disabled={busy} aria-invalid={wei === null} />
          </label>
          <label className="field">
            <span className="label">At a time</span>
            <select value={atOnce} onChange={(e) => setAtOnce(Number(e.target.value))} disabled={busy}>
              {Array.from({ length: st.limits.atOnceMost }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{`Up to ${n} job${n === 1 ? "" : "s"}`}</option>)}
            </select>
          </label>
        </div>
        <div className="field">
          <span className="label">Hours</span>
          <div className="modes" role="group" aria-label="Hours" style={{ marginBottom: 0 }}>
            <button type="button" aria-pressed={always} onClick={() => setAlways(true)} disabled={busy}>Always on</button>
            <button type="button" aria-pressed={!always} onClick={() => setAlways(false)} disabled={busy}>Set hours</button>
          </div>
          {!always ? (
            <div className="pair" style={{ marginTop: 14 }}>
              <select value={hFrom} onChange={(e) => setHFrom(Number(e.target.value))} disabled={busy} aria-label="From">{HOURS.map((h) => <option key={h} value={h}>From {two(h)}:00 UTC</option>)}</select>
              <select value={hTo} onChange={(e) => setHTo(Number(e.target.value))} disabled={busy} aria-label="Until">{HOURS.map((h) => <option key={h} value={h}>Until {two(h)}:00 UTC</option>)}</select>
            </div>
          ) : null}
        </div>
        <button type="button" className={`toggle${early ? "" : " off"}`} role="switch" aria-checked={early} onClick={() => setEarly((v) => !v)} disabled={busy}>
          <i />
          <div><b>Take half up front</b><span>When the customer allows it, half is drawn as the work is handed over. Off, it is paid in full once the customer accepts.</span></div>
        </button>
        {bids ? (
          <>
            <button type="button" className={`toggle${offers ? "" : " off"}`} role="switch" aria-checked={offers} onClick={() => setOffers((v) => !v)} disabled={busy}>
              <i />
              <div><b>Make offers on jobs open to offers</b><span>{`It names its own price and time, never over the customer's budget and never under its lowest price. Off, it passes over jobs open to offers.`}</span></div>
            </button>
            {offers ? (
              <>
                <div className="pair">
                  <label className="field">
                    <span className="label">Its offer, in ETH</span>
                    <input value={normal} onChange={(e) => setNormal(e.target.value)} inputMode="decimal" placeholder={from} disabled={busy} aria-invalid={normalWei === null} />
                  </label>
                  <label className="field">
                    <span className="label">With nothing on its hands</span>
                    <input value={free} onChange={(e) => setFree(e.target.value)} inputMode="decimal" placeholder={normal || from} disabled={busy} aria-invalid={freeWei === null} />
                  </label>
                </div>
                <label className="field">
                  <span className="label">Delivered within</span>
                  <select value={offerHours} onChange={(e) => setOfferHours(Number(e.target.value))} disabled={busy}>
                    {OFFER_TIMES.map(([name, h]) => <option key={h} value={h}>{`${name} of the lock`}</option>)}
                  </select>
                  <div className="hint">A job that gives less time than this is passed over.</div>
                </label>
              </>
            ) : null}
          </>
        ) : null}
        <label className="field">
          <span className="label">The line it applies with</span>
          <input value={pitch} onChange={(e) => setPitch(e.target.value)} maxLength={280} placeholder="One page from your brief, delivered on its own" disabled={busy} />
        </label>
        <div className="cta" style={{ marginTop: 4 }}><Go label="Save the rules" busy={busy || wei === null} onGo={() => void save()} off={!enabled ? "Auto-apply is off for now" : null} /></div>
      </div>
      <StatusLine status={status} explorer={explorer} />
      <SignedInAs busy={busy} />
    </div>
  );
}

/** What it did on its own, newest first. */
export function AutoApplyLog({ st, asOf }: { st: AutoApplyStatus; asOf: string }) {
  if (!st.log.length) return <p className="small" style={{ paddingTop: 4 }}>Nothing yet. When a job that fits is posted, what {st.name} does with it shows here.</p>;
  return (
    <ol className="auto-log">
      {st.log.map((l, i) => (
        <li key={`${l.kind}-${l.open}-${i}`} className={l.kind}>
          <span className="kind mono">{LOG_WORD[l.kind]}</span>
          <div className="what">
            <div className="say">{l.note}</div>
            <div className="small"><Link href={`/open-jobs/${l.open}`}>{l.title}</Link>{l.job ? <> · <Link href={`/jobs/${l.job.id}`}>job {l.job.id}</Link></> : null}</div>
          </div>
          <span className="when mono">{fromNow(l.at, asOf)}</span>
        </li>
      ))}
    </ol>
  );
}
