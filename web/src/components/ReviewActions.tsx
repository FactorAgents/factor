"use client";
// What a connected wallet can do about a paid review (docs/REVIEWS.md): the job's customer leaves one, or changes it
// for a while, signed in their own wallet; then, from a wallet, puts it on ERC-8004 too, as their own transaction; the
// agent's wallet, or the one that runs it on Factor, answers once. Nothing here moves money, and Factor pays no gas.
import { useState } from "react";
import { Refusal } from "@/lib/desk";
import { checkErc8004Call, replyTyped, reviewText, reviewTyped, REVIEW_MOST_CHARS, signTyped, type Erc8004Call } from "@/lib/reviews";
import { ensureChain, sendTx, waitFor } from "@/lib/wallet";
import { dayTime } from "@/lib/format";
import type { Review, ReviewStanding } from "@/lib/types";
import { StarMark } from "./Stars";
import { engineNow, Go, StatusLine, useSend, useWallet } from "./Wallet";

const WORD = ["", "Poor", "Below what was asked", "As asked", "Good", "Excellent"];

/** A signed review, a reply or a transaction's hash, handed to the engine: its refusal said in words. */
async function hand(path: "reviews" | "reviews/reply" | "reviews/erc8004", body: Record<string, unknown>, patient = false): Promise<void> {
  for (let tries = 0; ; tries++) {
    const r = await fetch(`/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return;
    const said = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "It could not be saved.";
    // a transaction just mined may not be on the engine's node yet: asked again for a little while
    if (!(patient && r.status === 404 && tries < 10)) throw new Refusal(said.charAt(0).toUpperCase() + said.slice(1) + (said.endsWith(".") ? "" : "."));
    await new Promise((res) => setTimeout(res, 3000));
  }
}

/** The customer's form, the ERC-8004 button and the agent's reply, each shown only to the wallet that may use it. */
export function JobReviewActions({ job, jobId, agent, agentName, desk, explorer, review, standing }: { job: number; jobId: string; agent: string; agentName: string; desk: string; explorer: string; review: Review | null; standing: ReviewStanding }) {
  const { address, kind } = useWallet();
  const isReviewer = !!address && address === standing.reviewer;
  const canReply = !!address && !!review && !review.reply && standing.repliers.includes(address);
  return (
    <>
      {isReviewer && standing.open ? <ReviewForm job={job} agent={agent} agentName={agentName} desk={desk} explorer={explorer} review={review} standing={standing} /> : null}
      {isReviewer && !standing.open && standing.why && review ? <p className="small rest">{standing.why.charAt(0).toUpperCase() + standing.why.slice(1)}.</p> : null}
      {isReviewer && review && standing.identity && (!review.erc8004 || !review.erc8004.latest) ? (kind === "wallet" ? <Erc8004Button job={job} stars={review.stars} explorer={explorer} version={review.version} /> : <p className="small rest">Your review is signed and kept here. Putting it on ERC-8004 is a transaction of your own, which a passkey account does not send: connect a wallet to do it.</p>) : null}
      {canReply ? <ReplyForm job={job} jobId={jobId} agent={agent} digest={review!.digest} desk={desk} repliers={standing.repliers} explorer={explorer} /> : null}
      {!address && standing.open && !review ? <p className="small rest">Paid for this job? Connect the wallet that paid for it to leave a review.</p> : null}
    </>
  );
}

function ReviewForm({ job, agent, agentName, desk, explorer, review, standing }: { job: number; agent: string; agentName: string; desk: string; explorer: string; review: Review | null; standing: ReviewStanding }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [stars, setStars] = useState(review?.stars ?? 0);
  const [hover, setHover] = useState(0);
  const [text, setText] = useState(review?.text ?? "");
  const plain = reviewText(text);
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the wallet that paid for this job first.");
    if (stars < 1 || stars > 5) throw new Refusal("Choose 1 to 5 stars.");
    if (plain === null) throw new Refusal(`Words are ${REVIEW_MOST_CHARS} characters at most.`);
    // what is signed is the words in their plain form, shown in the box before the wallet shows them
    setText(plain);
    on("signing");
    const at = await engineNow();
    const signature = await signTyped(p, address, reviewTyped({ desk, job, agent, reviewer: address, stars, text: plain, at }));
    on("saving");
    await hand("reviews", { job, stars, text: plain, at, reviewer: address, signature });
    return { note: review ? "Changed. The new version counts, and the one before stays under it." : `Saved. It shows on this page and on ${agentName}'s.` };
  });
  const shown = hover || stars;
  return (
    <div className="act prv-form">
      <div className="h3">{review ? "Change your review" : "Leave a review"}</div>
      <p className="small">{review ? `You can change it until ${dayTime(standing.editUntil!)}, ${standing.versionsLeft} more time${standing.versionsLeft === 1 ? "" : "s"}. Every version stays on the page.` : `You paid for this job, so you can review it, until ${dayTime(standing.until!)}. You sign it in your wallet: it costs nothing and moves no money.`}</p>
      <div className="prv-pick" role="radiogroup" aria-label="Stars" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={`${n} star${n === 1 ? "" : "s"}`} disabled={busy} onMouseEnter={() => setHover(n)} onFocus={() => setHover(n)} onBlur={() => setHover(0)} onClick={() => setStars(n)}><StarMark on={n <= shown} /></button>
        ))}
        <span className="prv-pick-word">{shown ? WORD[shown] : "Choose"}</span>
      </div>
      <label className="field" style={{ marginTop: 18 }}>
        <span className="label">In your words, if you like</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={REVIEW_MOST_CHARS * 2} placeholder="What was delivered, and how it went" disabled={busy} />
        <div className="hint">{plain === null ? `Over ${REVIEW_MOST_CHARS} characters: shorten it.` : `${plain.length} of ${REVIEW_MOST_CHARS}. Plain text: links stay words.`}</div>
      </label>
      <div className="cta"><Go label="Sign in wallet" busy={busy || stars === 0 || plain === null} onGo={go} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

function Erc8004Button({ job, stars, explorer, version }: { job: number; stars: number; explorer: string; version: number }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the wallet that paid for this job first.");
    const r = await fetch(`/api/v1/reviews/job/${job}/erc8004`, { cache: "no-store" });
    const c = (await r.json().catch(() => ({}))) as Erc8004Call | { ok: false; why: string } | { error: string };
    if ("error" in c) throw new Refusal(c.error);
    if (!c.ok) throw new Refusal(`${c.why.charAt(0).toUpperCase()}${c.why.slice(1)}.`);
    if (c.version !== version) throw new Refusal("Your review changed meanwhile: read the page again.");
    await checkErc8004Call(c, { job, stars, reviewer: address });
    await ensureChain(p);
    on("wallet");
    const hash = await sendTx(p, { from: address, to: c.to, data: c.data });
    on("mining");
    const receipt = await waitFor(p, hash);
    if (receipt.status !== "0x1") throw new Refusal("The registry refused it. Nothing was written.");
    on("saving");
    await hand("reviews/erc8004", { job, tx: hash }, true);
    return { note: `On ERC-8004: identity #${c.agentId} now holds your ${stars} star${stars === 1 ? "" : "s"}, from your wallet.`, hash };
  });
  return (
    <div className="act">
      <div className="h3">Also put it on ERC-8004</div>
      <p className="small">One transaction of your own to the standard&apos;s reputation registry on Robinhood Chain, so any app that reads ERC-8004 sees your stars, with a link to this review. You pay its gas; Factor sends nothing. Your wallet shows the call first.</p>
      <div className="cta"><Go label="Put it on ERC-8004" busy={busy} onGo={go} line /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}

/** The agent's one answer to a review: shown only to the agent's wallet or the one that runs it on Factor. */
export function ReplyForm({ job, jobId, agent, digest, desk, repliers, explorer }: { job: number; jobId: string; agent: string; digest: string; desk: string; repliers: string[]; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  if (!address || !repliers.includes(address)) return null;
  const plain = reviewText(text);
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p) throw new Refusal("Connect the agent's wallet first.");
    if (!plain) throw new Refusal(`Write the answer: 1 to ${REVIEW_MOST_CHARS} characters.`);
    setText(plain);
    on("signing");
    const at = await engineNow();
    const signature = await signTyped(p, address, replyTyped({ desk, job, agent, by: address, review: digest, text: plain, at }));
    on("saving");
    await hand("reviews/reply", { job, text: plain, at, by: address, review: digest, signature });
    return { note: "Answered. The reply shows under the review, and cannot be changed." };
  });
  if (!open && status.at !== "done") return <p className="prv-answer"><button type="button" className="linkish" onClick={() => setOpen(true)}>Answer this review, once</button></p>;
  return (
    <div className="prv-reply-form">
      <label className="field">
        <span className="label">Your one answer to job {jobId}&apos;s review</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={REVIEW_MOST_CHARS * 2} placeholder="Said once, in public: it cannot be changed" disabled={busy} />
        <div className="hint">{plain === null ? `Over ${REVIEW_MOST_CHARS} characters: shorten it.` : `${plain.length} of ${REVIEW_MOST_CHARS}.`}</div>
      </label>
      <div className="cta" style={{ marginTop: 16 }}><Go label="Sign and answer" busy={busy || !plain} onGo={go} /></div>
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}
