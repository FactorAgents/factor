"use client";
// What can be done with a treasury from the page. The agent's own wallet puts ETH in, sets the rules (the floor, and
// for each use how far it goes: an empty field keeps that use off) and takes ETH out, which no rule stands in the way
// of. Anyone runs a treasury that has something to do. Every call is tried first and refused in plain words
// (lib/treasury.ts).
import { useState } from "react";
import { Refusal } from "@/lib/desk";
import { EMPTY_FORM, ethOf, formOf, rulesStruct, sendTreasury, typedWei, type RulesForm } from "@/lib/treasury";
import type { TreasuryAbout, TreasuryView } from "@/lib/types";
import { Go, StatusLine, useSend, useWallet } from "./Wallet";

const positive = (wei: unknown): boolean => /^\d+$/.test(String(wei ?? "")) && BigInt(String(wei)) > 0n;

export function TreasuryActions({ agent, name, t, about, explorer }: { agent: string; name: string; t: TreasuryView | null; about: TreasuryAbout; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [open, setOpen] = useState<"" | "in" | "rules" | "out">("");
  const [amount, setAmount] = useState("");
  const [form, setForm] = useState<RulesForm>(() => (t ? formOf(t.rules) : { ...EMPTY_FORM }));
  const contract = about.contract;
  if (!about.enabled || !contract) return null;
  const mine = !!address && address.toLowerCase() === agent.toLowerCase();
  const due = !!t && positive(t.next?.total);
  const set = (k: keyof RulesForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value.replace(/[^\d.]/g, "") }));

  const send = (fn: "deposit" | "withdraw" | "setRules" | "run", args: () => readonly unknown[], value: () => bigint | undefined, note: string) => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    const { hash } = await sendTreasury(p, { contract, from: address, fn, args: args(), value: value(), on });
    setAmount("");
    return { note, hash };
  });
  const putIn = () => send("deposit", () => [agent], () => { const v = typedWei(amount, "The amount"); if (v === 0n) throw new Refusal("Write how much ETH to put in."); return v; }, `Put in. Only ${name} can take it out again.`);
  const takeOut = () => send("withdraw", () => { const v = amount.trim() ? typedWei(amount, "The amount") : BigInt(t?.balance ?? "0"); if (v === 0n) throw new Refusal("This treasury holds nothing."); return [address, v]; }, () => undefined, "Taken out, to this wallet.");
  const setRules = () => send("setRules", () => [rulesStruct(form)], () => undefined, "The rules are set. They hold from the next run.");
  const runNow = () => send("run", () => [agent, (t?.next?.claims ?? []).filter((c) => positive(c.price)).map((c) => BigInt(c.id))], () => undefined, "The treasury ran. Each step is a receipt above once the page has read it.");

  if (!mine) {
    return (
      <div className={`acts tr-acts${t ? "" : " bare"}`} style={{ marginTop: t ? 6 : 0 }}>
        <div className="act">
          <div className="h3">{t ? "Run it now" : "Set up the treasury"}</div>
          <p className="small">{t ? `Anyone can run ${name}'s treasury. A run does only what its rules allow, in their order, and costs the caller only gas. Factor runs it by itself when something is due.` : `${name} connects its own wallet here to put ETH in and set its rules.`}</p>
          <div className="cta">{t ? <Go label="Run it" busy={busy} onGo={runNow} off={due ? null : "Nothing is due"} /> : <Go label="" busy={false} onGo={() => undefined} off={address ? `Connect ${name}'s wallet` : null} />}</div>
          <StatusLine status={status} explorer={explorer} />
        </div>
      </div>
    );
  }
  return (
    <div className={`acts tr-acts${t ? "" : " bare"}`} style={{ marginTop: t ? 6 : 0 }}>
      <div className="act">
        <div className="h3">Your treasury</div>
        <p className="small">This wallet owns it. Put ETH in, set the rules once, take ETH out whenever you like: no rule or floor stands in the way of that.</p>
        <div className="seg" role="tablist" style={{ marginTop: 14 }}>
          <button type="button" className={open === "in" ? "on" : ""} onClick={() => setOpen(open === "in" ? "" : "in")}>Put in</button>
          <button type="button" className={open === "rules" ? "on" : ""} onClick={() => setOpen(open === "rules" ? "" : "rules")}>Rules</button>
          <button type="button" className={open === "out" ? "on" : ""} onClick={() => setOpen(open === "out" ? "" : "out")}>Take out</button>
        </div>
        {open === "in" ? (
          <>
            <label className="field" style={{ marginTop: 18 }}><span className="label">ETH to put in</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.1" disabled={busy} /></label>
            <div className="cta"><Go label="Put it in" busy={busy} onGo={putIn} /></div>
          </>
        ) : null}
        {open === "out" ? (
          <>
            <label className="field" style={{ marginTop: 18 }}><span className="label">ETH to take out{t ? `: it holds ${ethOf(t.balance)}` : ""}</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} placeholder="all of it" disabled={busy} /></label>
            <div className="cta"><Go label={amount.trim() ? "Take it out" : "Take all of it out"} busy={busy} onGo={takeOut} /></div>
          </>
        ) : null}
        {open === "rules" ? (
          <>
            <p className="small" style={{ marginTop: 18 }}>Amounts in ETH. An empty field keeps that use off. Setting the rules replaces the ones before.</p>
            <div className="tr-form">
              <label className="field"><span className="label">Floor, never spent by a run</span><input inputMode="decimal" value={form.floor} onChange={set("floor")} placeholder="0" disabled={busy} /></label>
              <label className="field"><span className="label">1 Repay my line, a day</span><input inputMode="decimal" value={form.repay} onChange={set("repay")} placeholder="off" disabled={busy} /></label>
              <label className="field"><span className="label">2 Prepay compute, a day</span><input inputMode="decimal" value={form.compute} onChange={set("compute")} placeholder="off" disabled={busy} /></label>
              <label className="field"><span className="label">3 Buy locked pay, a day</span><input inputMode="decimal" value={form.claims} onChange={set("claims")} placeholder="off" disabled={busy} /></label>
              <label className="field"><span className="label">3 The most for one claim</span><input inputMode="decimal" value={form.claimMax} onChange={set("claimMax")} placeholder="0.02" disabled={busy} /></label>
              <label className="field"><span className="label">3 Least percent under face</span><input inputMode="decimal" value={form.claimDiscount} onChange={set("claimDiscount")} placeholder="0" disabled={busy} /></label>
              <label className="field"><span className="label">3 Least seller score</span><input inputMode="numeric" value={form.claimScore} onChange={set("claimScore")} placeholder="0" disabled={busy} /></label>
              <label className="field"><span className="label">4 Guarantee bond, kept at</span><input inputMode="decimal" value={form.guarantee} onChange={set("guarantee")} placeholder="off" disabled={busy} /></label>
              <label className="field"><span className="label">5 Vouching bond, kept at</span><input inputMode="decimal" value={form.vouch} onChange={set("vouch")} placeholder="off" disabled={busy} /></label>
            </div>
            <label className="small" style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}><input type="checkbox" style={{ accentColor: "var(--gilt)" }} checked={form.deliveredOnly} onChange={(e) => setForm((f) => ({ ...f, deliveredOnly: e.target.checked }))} disabled={busy} /> 3 Only buy pay whose job is already delivered</label>
            <div className="cta"><Go label="Set the rules" busy={busy} onGo={setRules} /></div>
          </>
        ) : null}
        {t && open === "" ? <div className="cta"><Go label="Run it now" busy={busy} onGo={runNow} off={due ? null : "Nothing is due"} line /></div> : null}
        <StatusLine status={status} explorer={explorer} />
      </div>
    </div>
  );
}
