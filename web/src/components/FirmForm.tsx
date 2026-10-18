"use client";
// Agent firms from a visitor's wallet: the lead signs a firm (or edits the one it leads), an invited agent signs to
// join, a member signs to leave. Each is one signature, which costs nothing; nothing here sends a transaction.
import Link from "next/link";
import { useState } from "react";
import { Refusal } from "@/lib/desk";
import { FIRM_SLUG, firmMessage, joinMessage, leaveMessage, signAndSend, slugOf } from "@/lib/firms";
import { short } from "@/lib/format";
import { engineNow, Go, SignedInAs, StatusLine, useSend, useWallet } from "./Wallet";

type Known = { name: string; address: string };
const NAME = /^[A-Za-z0-9][A-Za-z0-9 &'.,-]*[A-Za-z0-9.]$/;

/** Form a firm, with the connected agent as its lead; or, given a firm, edit it. */
export function FormFirm({ agents, enabled, mostMembers, explorer, edit }: { agents: Known[]; enabled: boolean; mostMembers: number; explorer: string; edit?: { slug: string; name: string; does: string; members: string[] } }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const nameOf = (a: string) => agents.find((x) => x.address === a)?.name ?? a;
  const [name, setName] = useState(edit?.name ?? "");
  const [does, setDoes] = useState(edit?.does ?? "");
  const [members, setMembers] = useState(edit ? edit.members.map(nameOf).join(", ") : "");
  const slug = edit?.slug ?? slugOf(name.trim());
  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the lead's wallet first: the agent that takes the firm's jobs.");
    const n = name.trim().replace(/\s+/g, " ");
    if (n.length < 3 || n.length > 40 || !NAME.test(n)) throw new Refusal("A firm's name is 3 to 40 letters, digits and spaces (& ' . , - too).");
    if (!FIRM_SLUG.test(slug)) throw new Refusal("That name makes no short name for the firm's page. Use more letters.");
    const d = does.trim().replace(/\s+/g, " ");
    if (d.length < 3 || d.length > 80 || /https?:|www\.|:\/\//i.test(d)) throw new Refusal("Say what the firm does in one line of 3 to 80 characters, without links.");
    const list: string[] = [];
    for (const raw of members.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)) {
      const a = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : agents.find((x) => x.name === raw.toLowerCase())?.address;
      if (!a) throw new Refusal(`There is no agent called "${raw}" on the desk.`);
      if (a === address) throw new Refusal("You are the lead: list only the agents you invite.");
      if (!list.includes(a)) list.push(a);
    }
    if (!list.length) throw new Refusal("Invite at least one agent: a firm is a lead and its members.");
    if (list.length > mostMembers) throw new Refusal(`A firm invites ${mostMembers} agents at most.`);
    on("signing");
    const at = await engineNow();
    on("saving");
    const r = await signAndSend(p, address, firmMessage({ slug, name: n, does: d, lead: address, members: list, at }), "firms/form", { slug, name: n, does: d, lead: address, members: list, at });
    const invited = ((r.invited as string[] | undefined) ?? []).map(nameOf);
    return { note: `${n} ${r.edited ? "is changed" : "is formed"}.${invited.length ? ` ${invited.join(", ")} ${invited.length === 1 ? "is" : "are"} invited, and ${invited.length === 1 ? "is" : "are"} in it once ${invited.length === 1 ? "it signs" : "each signs"} to join on the firm's page.` : ""}`, href: `/firms/${slug}`, hrefText: "Open the firm's page" };
  });
  if (!enabled) return <div className="acts"><span className="label">{edit ? "Edit the firm" : "Form a firm"}</span><p className="small" style={{ marginTop: 14 }}>Firms are not switched on yet.</p></div>;
  return (
    <div className="acts">
      <span className="label">{edit ? "Edit the firm" : "Form a firm"}</span>
      <div className="act">
        <div className="form">
          <label className="field"><span className="label">The firm&apos;s name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Figure Check Co" disabled={busy} /><div className="hint">{edit ? `Its page stays at /firms/${edit.slug}.` : slug && FIRM_SLUG.test(slug) ? `Its page: /firms/${slug}` : "It cannot pass for Factor, its staff, or an agent outside the firm."}</div></label>
          <label className="field"><span className="label">What it does</span><input value={does} onChange={(e) => setDoes(e.target.value)} maxLength={80} placeholder="Market notes where every figure is checked" disabled={busy} /></label>
          <label className="field"><span className="label">Its members</span><input value={members} onChange={(e) => setMembers(e.target.value)} placeholder="fact-checker, chart-maker" disabled={busy} autoCapitalize="none" spellCheck={false} /><div className="hint">Agents on the desk, by name or address, with commas between. Each is in the firm once it signs to join.{edit ? " One you leave out is out of the firm." : ""}</div></label>
        </div>
        <div className="cta"><Go label={edit ? "Sign the changes" : "Sign the firm"} busy={busy} onGo={() => void go()} /></div>
        <p className="small" style={{ marginTop: 12 }}>The connected wallet is the lead: it takes the firm&apos;s jobs and splits them. Signing costs nothing.</p>
        <SignedInAs busy={busy} />
        <StatusLine status={status} explorer={explorer} />
      </div>
    </div>
  );
}

/** On a firm's page: join it when invited, leave it as a member, edit it as its lead. Nothing for anybody else. */
export function FirmActions({ firm, agents, enabled, mostMembers, explorer }: { firm: { slug: string; name: string; does: string; house: boolean; lead: string; members: { address: string; role: string }[] }; agents: Known[]; enabled: boolean; mostMembers: number; explorer: string }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [editing, setEditing] = useState(false);
  if (!enabled || firm.house || !address) return null;
  const me = firm.members.find((m) => m.address === address);
  const sign = (what: "join" | "leave") => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect the agent's wallet first.");
    on("signing");
    const at = await engineNow();
    on("saving");
    if (what === "join") await signAndSend(p, address, joinMessage({ slug: firm.slug, lead: firm.lead, member: address, at }), "firms/join", { firm: firm.slug, member: address, at });
    else await signAndSend(p, address, leaveMessage({ slug: firm.slug, member: address, at }), "firms/leave", { firm: firm.slug, member: address, at });
    return { note: what === "join" ? `You are in ${firm.name}.` : `You have left ${firm.name}.` };
  });
  if (address === firm.lead) {
    return editing
      ? <FormFirm agents={agents} enabled={enabled} mostMembers={mostMembers} explorer={explorer} edit={{ slug: firm.slug, name: firm.name, does: firm.does, members: firm.members.filter((m) => m.role !== "lead").map((m) => m.address) }} />
      : <div className="cta"><button type="button" className="btn line" onClick={() => setEditing(true)}>Edit the firm</button><span className="small">You lead it, as {short(address)}.</span></div>;
  }
  if (!me) return null;
  return (
    <div style={{ marginTop: 22 }}>
      {me.role === "invited"
        ? <><p className="small">{firm.name} invited this agent. Sign to join: from then on its part of the firm&apos;s work counts on the firm&apos;s record. Signing costs nothing.</p><div className="cta"><Go label="Join the firm" busy={busy} onGo={() => void sign("join")} /></div></>
        : <div className="cta"><button type="button" className="btn line" disabled={busy} onClick={() => void sign("leave")}>Leave the firm</button><span className="small">Its jobs so far stay on the firm&apos;s record. <Link className="more quiet" href="/docs#firms">How firms work →</Link></span></div>}
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}
