"use client";
// The checkout of a Pay with Factor link: the buyer locks the price for the link's agent and adds the deal's share
// to the burn, from a wallet or an account with a passkey. Nothing leaves until its owner confirms it.
import { useState } from "react";
import { claimDeal, fromWei, lockAndBurn, lockedJob, Refusal } from "@/lib/desk";
import { planHire } from "@/lib/subjobs";
import { lockMonth, MONTH_S, signPlan } from "@/lib/plans";
import type { PayInfo } from "@/lib/pay";
import AccountPanel from "./Account";
import { engineNow, Go, SignedInAs, StatusLine, useSend, useWallet } from "./Wallet";

export default function PayCheckout({ token, info, explorer, agentName, forJob = null }: { token: string; info: PayInfo; explorer: string; agentName: string; /** bought as part of this job, by its agent */ forJob?: number | null }) {
  const { address, wallet, kind } = useWallet();
  const { status, run, busy } = useSend();
  const [done, setDone] = useState(false);
  const price = BigInt(info.priceWei), burn = BigInt(info.burnWei);
  const months = info.link.months ?? 0;
  const pay = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first, or use a passkey.");
    if (address === info.link.agent) throw new Refusal("This is the agent's own wallet. Pay from the buyer's.");
    if (months) {
      // a subscribe link: the buyer signs the plan the link describes, then month 1 is locked at once
      const l = info.link;
      on("signing");
      const made = await signPlan(p, { customer: address, agent: l.agent, ...(l.firm ? { firm: l.firm } : {}), price: l.price, months, early: l.early, title: l.title, brief: l.brief, at: await engineNow() }, token);
      const r = await lockMonth(p, { passkey: kind === "passkey", desk: info.desk, burnPot: info.burnPot, from: address, plan: made.plan, agent: l.agent, dueAt: (await engineNow()) + MONTH_S - 300, early: l.early, price, burn, on });
      setDone(true);
      return { note: r.linked ? `Subscribed. Month 1 of ${months} is locked for ${agentName}${r.job ? ` as job ${String(r.job).padStart(4, "0")}` : ""}.${r.burned ? ` ${fromWei(burn)} ETH went to the burn.` : ""} Lock each next month on the plan's page.` : `Month 1 is locked for ${agentName}. ${r.note ?? ""}`, hash: r.lockTx, href: `/plans/${made.plan}`, hrefText: "Open the plan" };
    }
    // measured on the engine's clock, which follows the chain's: what the link's due time is checked against
    const at = await engineNow();
    const dueAt = at + info.link.due * 3600;
    // bought for a job of the buyer's own: the hire is signed and checked first, and holds its room while it is paid
    let plan: string | null = null;
    if (forJob) {
      on("signing");
      plan = (await planHire(p, address, { parent: forJob, agent: info.link.agent, price: info.priceWei, dueAt, early: info.link.early, title: info.link.title, brief: info.link.brief, at })).plan;
    }
    const { lockTx, burnTx, receipt } = await lockAndBurn(p, { passkey: kind === "passkey", desk: info.desk, from: address, agent: info.link.agent, dueAt, early: info.link.early, price, burnPot: info.burnPot, burn, on });
    const id = lockedJob(receipt, info.desk);
    if (id === null) return { note: "The payment is locked.", hash: lockTx };
    const href = `/jobs/${String(id).padStart(4, "0")}`;
    on("saving");
    let said = "";
    try {
      const r = await claimDeal({ link: token, job: id, lockTx, burnTx, ...(plan ? { plan } : {}) });
      said = r.burned ? ` ${fromWei(burn)} ETH went to the burn.` : burnTx ? "" : " The burn was not sent; the job is locked all the same.";
      if (forJob) said += r.subjob ? ` It is under job ${String(forJob).padStart(4, "0")}.` : r.subjobNote ? ` It could not be put under job ${String(forJob).padStart(4, "0")}: ${r.subjobNote}.` : "";
    } catch {
      said = "";
    }
    setDone(true);
    return { note: `Paid. Job ${String(id).padStart(4, "0")} is locked for ${agentName}.${said} Come back to its page to accept or reject the delivery.`, hash: lockTx, href, hrefText: "Open the job" };
  });
  const off = !info.registered ? "This agent has not signed up yet" : info.paused ? "New jobs are paused" : null;
  return (
    <div className="form">
      <AccountPanel explorer={explorer} />
      <div className="cta" style={{ marginTop: 0 }}>
        {done ? null : <Go label={months ? `Subscribe: ${fromWei(price + burn)} ETH for month 1` : `Pay ${fromWei(price + burn)} ETH`} busy={busy} onGo={() => void pay()} off={off} />}
      </div>
      {kind === "wallet" && !done ? <p className="small">{months ? "Your wallet asks three times: a signature for the plan (it costs nothing), then the lock of month 1, then the burn." : "Your wallet asks twice: once to lock the price, once for the burn. The job is locked by the first."}</p> : null}
      {kind === "passkey" && !done ? <p className="small">One confirmation: the lock and the burn go together, and Factor pays the gas.</p> : null}
      <SignedInAs busy={busy} />
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}
