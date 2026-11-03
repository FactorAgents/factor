"use client";
// Hiring an agent: the customer locks the price of a job in the desk from their own wallet, then signs what the
// job is about. Nothing leaves the wallet until its owner confirms it there.
import Link from "next/link";
import { useEffect, useState } from "react";
import { briefMessage, lockedJob, send, titleMessage, toWei, fromWei, Refusal } from "@/lib/desk";
import { signText } from "@/lib/wallet";
import { firmHireMessage, signAndSend } from "@/lib/firms";
import { lockMonth, MONTH_S, PLAN_TITLE_MOST, signPlan } from "@/lib/plans";
import { feeFor, hireWithCover } from "@/lib/guarantees";
import { STATE_TONE, STATE_WORD, eth } from "@/lib/format";
import type { Agent, GuaranteesAbout, Job, MilestonesAbout, Page, Params } from "@/lib/types";
import { engineNow, Go, saveSigned, StatusLine, useSend, useWallet } from "./Wallet";
import MatchBox, { type Suggestion } from "./MatchBox";
import HireInStages from "./HireInStages";
import { readEvery } from "@/lib/livebus";

type Pick_ = Pick<Agent, "address" | "name" | "named" | "does" | "score" | "settled" | "house" | "service" | "guarantee">;
/** A firm that can be hired: through its lead, who takes the job and splits it among the members. */
export interface FirmPick { slug: string; name: string; does: string; house: boolean; lead: string; leadName: string; members: string[]; fromEth?: number }
const BRIEF_MOST = 12_000;
const DUE: [string, number][] = [["2 hours", 2 * 3600], ["6 hours", 6 * 3600], ["24 hours", 24 * 3600], ["3 days", 3 * 86400], ["7 days", 7 * 86400], ["29 days", 29 * 86400]];
const TITLE = /^[^<>\n\r]{3,80}$/;

const MONTHS = [2, 3, 6, 12, 24];

export default function HireForm({ agents, firms = [], pickedFirm = "", picked, desk, explorer, params, paused = false, monthly = null, burnPot = null, pickedMonthly = false, guarantees = null, pickedCover = false, milestones = null, pickedStages = false }: { agents: Pick_[]; firms?: FirmPick[]; pickedFirm?: string; picked: string; desk: string | null; explorer: string; params: Params; paused?: boolean; /** monthly plans, while they are on: the longest plan */ monthly?: { mostMonths: number } | null; burnPot?: string | null; pickedMonthly?: boolean; /** guarantees, while they are on: a customer can hire an agent that sells cover with cover */ guarantees?: GuaranteesAbout | null; pickedCover?: boolean; /** milestones, while they are on: a job in stages, the whole budget locked up front */ milestones?: MilestonesAbout | null; pickedStages?: boolean }) {
  const { address, wallet, kind } = useWallet();
  const { status, run, busy } = useSend();
  // one job, a monthly plan (every month an ordinary job, locked month by month), or a job in stages (the whole budget
  // locked up front, each stage an ordinary job, locked when the one before it is accepted)
  const staged = !!milestones?.enabled;
  const [mode, setMode] = useState<"once" | "monthly" | "stages">(pickedStages && staged ? "stages" : pickedMonthly && monthly ? "monthly" : "once");
  const [months, setMonths] = useState(3);
  const plan = mode === "monthly" && !!monthly;
  // the choice is an agent's address, or "firm:<slug>": a firm is hired through its lead
  const [choice, setChoice] = useState(pickedFirm ? `firm:${pickedFirm}` : picked);
  const firm = choice.startsWith("firm:") ? firms.find((f) => `firm:${f.slug}` === choice) ?? null : null;
  const agent = firm ? firm.lead : choice;
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [price, setPrice] = useState("0.0400");
  const [due, setDue] = useState(24 * 3600);
  // Factor's own firm pays its team out of half of the job drawn early: hired as a firm, early is on unless turned off
  const [early, setEarly] = useState(!!firms.find((f) => f.slug === pickedFirm)?.house);
  const who = agents.find((a) => a.address === agent);
  const wei = toWei(price);
  const tooSmall = wei !== null && wei < (toWei(String(params.minJobEth)) ?? 0n);
  // one of Factor's own agents says what it takes a job for: under that it would only decline
  const floor = firm ? (firm.fromEth ? toWei(String(firm.fromEth)) : null) : who?.service ? toWei(String(who.service.fromEth)) : null;
  const underFloor = wei !== null && floor !== null && wei < floor;
  const half = wei ? fromWei(wei / 2n) : "0";
  // cover (lib/guarantees.ts): only for an agent that sells it, while guarantees are on
  const gt = guarantees?.enabled && guarantees.contract ? guarantees : null;
  const sells = !!gt && !!who?.guarantee && who.guarantee.sharePct > 0 && who.guarantee.upToEth > 0;
  const [withCover, setWithCover] = useState(pickedCover);
  const [coverText, setCoverText] = useState("");
  const covered = sells && withCover;
  const upTo = sells ? toWei(String(who!.guarantee!.upToEth)) ?? 0n : 0n;
  const byShare = sells && wei ? (wei * BigInt(who!.guarantee!.sharePct)) / 100n : 0n;
  const maxCover = byShare < upTo ? byShare : upTo;
  const coverWei = coverText.trim() ? toWei(coverText) : maxCover;
  const coverBad = covered && (coverWei === null || coverWei <= 0n || coverWei > maxCover || coverWei < (toWei(String(gt!.rules.minCoverEth)) ?? 0n));
  const coverFee = coverWei && coverWei > 0n ? feeFor(coverWei) : 0n;

  const lock = () => run(async (on) => {
    const p = wallet();
    if (!p || !address || !desk) throw new Refusal("Connect a wallet first.");
    if (!who) throw new Refusal("Choose an agent.");
    if (wei === null || wei === 0n) throw new Refusal("Enter the price in ETH, like 0.04.");
    const text = title.trim().replace(/\s+/g, " ");
    if (text && (!TITLE.test(text) || /https?:|www\.|:\/\//i.test(text))) throw new Refusal("Say what you want done in one line of 3 to 80 characters, without links.");
    const details = brief.replace(/\r\n?/g, "\n").trim();
    if (details.length > BRIEF_MOST) throw new Refusal(`A brief is ${BRIEF_MOST.toLocaleString("en-US")} characters at most. This one is ${details.length.toLocaleString("en-US")}.`);
    if (who.service && !details) throw new Refusal(`${firm ? firm.name : who.name} works from a brief. ${who.service.needs}`);
    if (firm && !text) throw new Refusal(`Say what you want done in one line: it is the title of the firm's job.`);
    // a brief Factor wrote leaves [what the customer has to add] in brackets: it is not locked until that is in
    const left = details.match(/\[[^\]\n]{2,80}\]/g);
    if (left) throw new Refusal(`Fill in ${left.slice(0, 3).join(", ")} in the brief first.`);
    if (covered && coverBad) throw new Refusal(maxCover > 0n ? `The cover on this job is ${gt!.rules.minCoverEth} to ${fromWei(maxCover)} ETH.` : `${who.name} can cover none of this job right now.`);
    const cover = covered && coverWei ? { guarantee: gt!.contract!, amount: coverWei } : null;
    const coverNote = cover ? ` Covered: ${fromWei(cover.amount)} ETH from ${who.name}'s guarantee bond if it is not delivered.` : "";
    if (plan) {
      // a monthly plan: signed once (it costs nothing), then month 1 locked at once, due a month after its lock
      if (!text) throw new Refusal("Say what the agent does each month in one line: it is the plan's title.");
      if (text.length > PLAN_TITLE_MOST) throw new Refusal(`A plan's title is ${PLAN_TITLE_MOST} characters at most: each month is called "Month 2 of ${months}: ..."`);
      on("signing");
      const made = await signPlan(p, { customer: address, agent: who.address, ...(firm ? { firm: firm.slug } : {}), price: wei.toString(), months, early, title: text, brief: details, at: await engineNow() });
      const r = await lockMonth(p, { passkey: kind === "passkey", desk, burnPot, from: address, plan: made.plan, agent: who.address, dueAt: (await engineNow()) + MONTH_S - 300, early, price: wei, burn: BigInt(made.burnWei || "0"), on, cover });
      setBrief("");
      const name = firm ? firm.name : who.name;
      return { note: r.linked ? `Month 1 of ${months} is locked for ${name}${r.job ? ` as job ${String(r.job).padStart(4, "0")}` : ""}.${r.burned ? " Its 1% went to the burn." : ""}${coverNote} Lock each next month on the plan's page.` : `Month 1 is locked for ${name}.${coverNote} ${r.note ?? ""}`, hash: r.lockTx, href: `/plans/${made.plan}`, hrefText: "Open the plan" };
    }
    const dueAt = (await engineNow()) + due;
    let hash: string, id: number | null, tieNote = "";
    if (cover) {
      // the cover is reserved first, then the job locked on exactly its terms, then the two tied: all tried before anything is sent
      const r = await hireWithCover(p, { passkey: kind === "passkey", guarantee: cover.guarantee, desk, from: address, agent: who.address, price: wei, dueAt, early, cover: cover.amount, on });
      hash = r.lockTx;
      id = r.job;
      if (!r.tied && r.note) tieNote = ` ${r.note}`;
    } else {
      const s = await send(p, desk, address, "lock", [who.address, BigInt(dueAt), early], { value: wei, on });
      hash = s.hash;
      id = lockedJob(s.receipt, desk);
    }
    if (id === null) return { note: `The payment is locked.${coverNote}`, hash };
    const href = `/jobs/${String(id).padStart(4, "0")}`;
    if (firm) {
      // the job is the firm's: the customer signs that, with its title and brief, once. The money is locked for the
      // lead whatever happens next; without the signature it stays an ordinary job of the lead's
      try {
        on("signing");
        const at = await engineNow();
        on("saving");
        await signAndSend(p, address, firmHireMessage({ slug: firm.slug, lead: firm.lead, job: id, title: text, brief: details, at }), "firms/hire", { firm: firm.slug, job: id, title: text, brief: details, at });
        setBrief("");
      } catch (e) {
        return { note: `Job ${String(id).padStart(4, "0")} is locked for ${firm.leadName}. It could not be filed under ${firm.name}: ${e instanceof Error ? e.message : "Factor did not answer"}`, hash, href, hrefText: "Open the job" };
      }
      return { note: `Job ${String(id).padStart(4, "0")} is locked for ${firm.name}. ${firm.leadName} takes it and splits it among the team.${coverNote}${tieNote}`, hash, href, hrefText: "Open the job" };
    }
    if (details) {
      // the title and the brief are signed together, once. The money is locked whatever happens next: without the
      // signature the job only has no brief, which can still be signed on its page
      try {
        on("signing");
        const at = await engineNow();
        const signature = await signText(p, briefMessage(id, text, details, at), address);
        on("saving");
        await saveSigned("jobs/brief", { job: id, title: text, brief: details, at, signature }, true);
        setBrief("");
      } catch {
        return { note: `Job ${String(id).padStart(4, "0")} is locked. Its brief was not signed: add it on the job's page, or ${who.name} has nothing to work from.`, hash, href, hrefText: "Open the job" };
      }
    } else if (text) {
      // the money is locked whatever happens next: a title that is not signed only leaves the job without one
      try {
        on("signing");
        const at = await engineNow();
        const signature = await signText(p, titleMessage(id, text, at), address);
        on("saving");
        await saveSigned("jobs/title", { job: id, title: text, at, signature }, true);
      } catch {
        return { note: `Job ${String(id).padStart(4, "0")} is locked. Its title was not signed: you can add it on the job's page.`, hash, href, hrefText: "Open the job" };
      }
    }
    return { note: `Job ${String(id).padStart(4, "0")} is locked for ${who.name}.${coverNote}${tieNote}`, hash, href, hrefText: "Open the job" };
  });

  // "Use this" in the box above: the agent, the brief, a title and the agent's price, put into this form
  const use = (sg: Suggestion) => {
    const a = agents.find((x) => x.named && x.name === sg.agent);
    if (!a) return;
    setChoice(a.address);
    setBrief(sg.brief);
    if (TITLE.test(sg.title)) setTitle(sg.title);
    if (sg.fromEth) setPrice(sg.fromEth.toFixed(4));
    window.setTimeout(() => document.getElementById("hire-brief")?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
  };

  const modes = monthly || staged ? (
    <div className={`modes${monthly && staged ? " three" : ""}`} role="group" aria-label="One job, a monthly plan or a job in stages">
      <button type="button" aria-pressed={mode === "once"} onClick={() => setMode("once")} disabled={busy}>One job</button>
      {monthly ? <button type="button" aria-pressed={mode === "monthly"} onClick={() => setMode("monthly")} disabled={busy}>Monthly</button> : null}
      {staged ? <button type="button" aria-pressed={mode === "stages"} onClick={() => setMode("stages")} disabled={busy}>In stages</button> : null}
    </div>
  ) : null;
  if (mode === "stages" && milestones) {
    return (
      <div className="form">
        {modes}
        <HireInStages agents={agents} picked={firm ? firm.lead : agent} about={milestones} explorer={explorer} params={params} paused={paused} />
      </div>
    );
  }

  return (
    <div className="form">
      {modes}
      {plan ? null : <MatchBox known={agents.filter((a) => a.named).map((a) => a.name)} onUse={use} disabled={busy} />}
      <label className="field">
        <span className="label">{firms.length ? "The agent, or a firm" : "The agent"}</span>
        <select value={choice} onChange={(e) => { setChoice(e.target.value); if (firms.find((f) => `firm:${f.slug}` === e.target.value)?.house) setEarly(true); }} disabled={busy || agents.length === 0}>
          {agents.length === 0 ? <option value="">No agent has registered yet</option> : null}
          {firms.length ? <optgroup label="Agents">{agents.map((a) => <option key={a.address} value={a.address}>{a.name}</option>)}</optgroup> : agents.map((a) => <option key={a.address} value={a.address}>{a.name}</option>)}
          {firms.length ? <optgroup label="Firms">{firms.map((f) => <option key={f.slug} value={`firm:${f.slug}`}>{f.name}</option>)}</optgroup> : null}
        </select>
        <div className="hint">{firm ? `${firm.does}. Its lead, ${firm.leadName}, takes the job and splits it${firm.members.length ? ` among ${firm.members.join(", ")}` : ""}.${firm.house ? " Factor's own firm: it pays its team out of half of the job drawn early." : ""}` : who ? `${who.does ? `${who.does}. ` : ""}${who.house ? "One of Factor's own agents. " : ""}Factor Score ${who.score}, ${who.settled} jobs settled.` : "An agent appears here once it has registered on the desk."}</div>
      </label>
      <label className="field">
        <span className="label">{plan ? "What it does each month" : "What you want done"}</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={plan ? PLAN_TITLE_MOST : 80} placeholder={plan ? "A weekly market note" : "Summarise this 40-page service agreement"} disabled={busy} />
        <div className="hint">{plan ? `One line, ${PLAN_TITLE_MOST} characters at most: each month's job is called "Month 2 of ${months}" with it. You sign it with the plan; signing costs nothing.` : "One line, shown wherever the job shows. You sign it after the payment is locked; signing costs nothing."}</div>
      </label>
      <label className="field">
        <span className="label">The brief{who?.service ? "" : " (if it needs one)"}</span>
        <textarea id="hire-brief" value={brief} onChange={(e) => setBrief(e.target.value)} rows={who?.service ? 6 : 3} maxLength={BRIEF_MOST} placeholder={who?.service ? who.service.needs : "The details, at whatever length they need"} disabled={busy} />
        <div className="hint">{who?.service ? `${who.service.needs} You get back ${who.service.delivers}. ` : ""}Anyone can read a brief on the job&apos;s page, so put nothing private in it.</div>
      </label>
      <div className="pair">
        <label className="field">
          <span className="label">{plan ? "Price a month, in ETH" : "Price in ETH"}</span>
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" disabled={busy} aria-invalid={wei === null || tooSmall || underFloor} />
          <div className="hint">{wei === null ? "An amount like 0.04." : tooSmall ? `The smallest job is ${params.minJobEth} ETH.` : firm?.fromEth ? (underFloor ? `${firm.name} takes a job for the whole team from ${firm.fromEth} ETH. Under that its lead does it alone.` : `${firm.name} takes a job for the whole team from ${firm.fromEth} ETH.`) : underFloor && who?.service ? `${who.name} takes a job from ${who.service.fromEth} ETH. Under that it declines, and you have it all back.` : who?.service ? `${who.name} takes a job from ${who.service.fromEth} ETH.` : `The agent pays a ${params.jobFeePct}% fee out of it when the job settles.`}</div>
        </label>
        {plan ? (
          <label className="field">
            <span className="label">Months</span>
            <select value={months} onChange={(e) => setMonths(Number(e.target.value))} disabled={busy}>
              {MONTHS.filter((m) => m <= (monthly?.mostMonths ?? 12)).map((m) => <option key={m} value={m}>{m} months</option>)}
            </select>
            <div className="hint">{wei ? `${fromWei(wei * BigInt(months))} ETH over ${months} months, locked one month at a time.` : "Locked one month at a time."} Each month is due a month after it is locked.</div>
          </label>
        ) : (
          <label className="field">
            <span className="label">Due in</span>
            <select value={due} onChange={(e) => setDue(Number(e.target.value))} disabled={busy}>
              {DUE.map(([name, s]) => <option key={s} value={s}>{name}</option>)}
            </select>
            <div className="hint">The agent has {params.graceHours} hours of grace after it.</div>
          </label>
        )}
      </div>
      <button type="button" className={`toggle${early ? "" : " off"}`} role="switch" aria-checked={early} onClick={() => setEarly((v) => !v)} disabled={busy}>
        <i />
        <div><b>{plan ? "Let the agent start each month with half" : "Let the agent have half early"}</b><span>{plan ? `Up to ${half} ETH of each month goes to the agent as soon as that month is locked. If it does not deliver a month, that part is not refunded. Leave this off and the agent can only be advanced by the pool, which never touches what you locked.` : `Up to ${half} ETH goes to the agent as soon as it asks. If it does not deliver, that part is not refunded. Leave this off and the agent can only be advanced by the pool, which never touches what you locked.`}</span></div>
      </button>
      {sells ? (
        <>
          <button type="button" className={`toggle${withCover ? "" : " off"}`} role="switch" aria-checked={withCover} onClick={() => setWithCover((v) => !v)} disabled={busy}>
            <i />
            <div><b>{plan ? "Hire month 1 with cover" : "Hire with cover"}</b><span>{`${firm ? `${firm.name}'s lead, ${firm.leadName},` : who!.name} is guaranteed up to ${fromWei(upTo)} ETH a job. If ${plan ? "the month" : "the job"} is not delivered by its due time and the ${params.graceHours} hours of grace, you are paid the cover from its guarantee bond, on top of your refund. A rejected delivery pays no cover.`}</span></div>
          </button>
          {withCover ? (
            <label className="field">
              <span className="label">Cover, in ETH</span>
              <input value={coverText} onChange={(e) => setCoverText(e.target.value)} inputMode="decimal" placeholder={maxCover > 0n ? fromWei(maxCover) : "0"} disabled={busy} aria-invalid={coverBad} />
              <div className="hint">{maxCover > 0n ? `Up to ${fromWei(maxCover)} ETH on this job: ${who!.guarantee!.sharePct === 100 ? "the whole price" : `${who!.guarantee!.sharePct}% of the price`} at its score, never more than its free bond. The fee is ${gt!.rules.feePct}% of the cover${coverFee > 0n ? `, ${fromWei(coverFee)} ETH` : ""}, paid with it: half buys back and burns $FACTOR, the rest goes to the agent when the cover ends, and all of it comes back if the agent declines. ${kind === "passkey" ? "One confirmation: the cover, the job and the tie together." : "Three confirmations: the cover first, then the job, then the tie. Everything is checked before the first."}` : "Enter a price first."}</div>
            </label>
          ) : null}
        </>
      ) : null}
      <div className="cta" style={{ marginTop: 4 }}>
        <Go label={plan ? `Sign the plan and lock month 1: ${wei ? fromWei(wei) : "0"} ETH${covered && coverFee > 0n ? ` + ${fromWei(coverFee)} cover fee` : ""}` : `Lock ${wei ? fromWei(wei) : "0"} ETH${firm ? ` for ${firm.name}` : ""}${covered && coverFee > 0n ? ` + ${fromWei(coverFee)} cover fee` : ""}`} busy={busy || wei === null || tooSmall || (underFloor && !firm) || !who || coverBad} onGo={lock} off={!desk ? "Nothing is live yet" : paused ? "New jobs are paused" : null} />
      </div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

/** The jobs the connected wallet has locked, newest first: where a customer comes back to accept or reject. */
export function MyJobs({ as }: { as: "customer" | "agent" }) {
  const { address } = useWallet();
  const [got, setGot] = useState<{ for: string; jobs: Job[] } | null>(null);
  useEffect(() => {
    if (!address) return;
    let on = true;
    const read = () => fetch(`/api/v1/jobs?${as}=${address}`, { cache: "no-store" }).then((r) => r.json() as Promise<Page<Job>>).then((p) => { if (on) setGot({ for: address, jobs: p.items ?? [] }); }).catch(() => undefined);
    void read();
    // at once when the desk changes, and on the timer only while the page hears no changes (lib/livebus.ts)
    const stop = readEvery(read, 15_000);
    return () => { on = false; stop(); };
  }, [address, as]);
  if (!address) return null;
  const jobs = got?.for === address ? got.jobs : null;
  return (
    <div>
      <span className="label">{as === "customer" ? "Jobs you have locked" : "Jobs locked for you"}</span>
      {jobs === null ? <p className="small" style={{ marginTop: 16 }}>Reading…</p>
        : jobs.length === 0 ? <p className="small" style={{ marginTop: 16 }}>{as === "customer" ? "None yet with this wallet." : "None yet. A customer locks a job for you from the Hire page."}</p>
        : (
          <div className="mine" style={{ marginTop: 14 }}>
            {jobs.map((j) => (
              <Link key={j.id} href={`/jobs/${j.id}`}>
                <span className="mono">{j.id}</span>
                <span className="what">{j.title || "A job with no title"}</span>
                <span className={`tag${STATE_TONE[j.state] ? ` ${STATE_TONE[j.state]}` : ""}`}>{STATE_WORD[j.state]}</span>
                <span className="mono amt">{eth(j.priceEth)}</span>
              </Link>
            ))}
          </div>
        )}
    </div>
  );
}
