// Factor's own firm at work: The Research Desk (../firms.ts, HOUSE_FIRM). Hired through the firm, its lead,
// plain-reader, takes the job, splits it, and puts the team to work through sub-jobs (../subjobs.ts), paid out of
// half of the job drawn early. Every part is an ordinary job on the desk: locked by the lead's own account, done by
// the member like any job it is hired for, and paid when the lead accepts it.
//
// The split is the same every time, and the job's page says how it went:
//   1. plain-reader reads the material itself (the reading it does for any job)
//   2. data-shaper puts its figures into one table, when the material has figures (three lines with numbers or more)
//   3. faq-smith turns it into questions and answers, when it is long enough to (600 characters or more)
//   4. once those are back and accepted, red-pen proofreads the whole of it before it goes to the customer
// Each member is paid what it takes a job for, more when the job is larger (up to twice that), out of what the lead
// drew early. What is left of the advance, and the rest of the job's price on delivery, is the lead's.
//
// The firm needs an early advance to pay its team, a price that covers it, and time for the parts to be due before
// the job. Without them plain-reader does the job alone, as it does any job of its own, and the page says why.
// A member that declines, or does not deliver in time, is left out, and its job comes back to the lead by the desk's
// own clock. Whatever happens, the customer gets the work by the job's due time: the lead never waits past it.

import { decodeEventLog, formatEther, type Abi, type Hex } from "viem";
import { factorDeskAbi } from "../abi/index.js";
import type { Call } from "../accounts.js";
import { deskCall } from "../accounts.js";
import type { EngineDb } from "../chain/db.js";
import type { Accounts } from "../accounts.js";
import type { Chain } from "../chain/chain.js";
import { HOUSE_FIRM, type Firms } from "../firms.js";
import { readLock } from "../pay.js";
import type { Profiles } from "../profiles.js";
import { hireMessage, type HirePlan, type Subjobs } from "../subjobs.js";
import type { Asked, Done, Service } from "./shared.js";

type State = "start" | "drawing" | "hiring" | "waiting" | "accepting" | "composing" | "done" | "alone";
type PartState = "planned" | "locking" | "locked" | "delivered" | "accepting" | "accepted" | "skipped";
interface Part { member: string; address: string; stage: 1 | 2; title: string; brief: string; price: string; burn: string; dueAt: number; plan: string | null; job: number | null; state: PartState; relay: string | null; note?: string }
interface Row { job_id: number; state: State; stage: number; parts: string; reading: string | null; relay: string | null; note: string; tries: number; next_at: number; since: number; cost_micro: number; input: number; output: number }

const SCHEMA = `
-- Factor's own firm at work (./house/firm.ts): how far its lead is with each job hired through the firm, and its parts.
CREATE TABLE IF NOT EXISTS house_firm_jobs (
  job_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  stage INTEGER NOT NULL DEFAULT 1,
  parts TEXT NOT NULL DEFAULT '[]',  -- JSON: each member's part, its sub-job and how it went
  reading TEXT,                      -- the lead's own part, kept the moment it is done
  relay TEXT,
  note TEXT NOT NULL DEFAULT '',     -- said on the job's page
  tries INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  since INTEGER NOT NULL DEFAULT 0,  -- ms: when the parts of the current stage were all locked
  cost_micro INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** A member's part waits this long for its delivery before the lead goes on without it. */
const PART_WAIT_MS = 40 * 60_000;
/** The parts are due this long after they are locked at most, and always before the job itself. */
const PART_DUE_S = 6 * 3600;
const FIGURE_LINES = 3;
const FAQ_LEAST = 600;
const PROOF_MOST = 11_000;
const MOST_TRIES = 3;

export interface Member { name: string; address: string | null; ready: boolean; service: Service }
export interface FirmLead {
  name: string;
  address: string;
  service: Service;
  /** the lead's key: signs the words of each hire it makes, as any agent signs a hire */
  signMessage?: (message: string) => Promise<Hex>;
}
export interface JobFacts { id: number; customer: string; agent: string; price: string; due_at: number; locked_at: number; state: number; allow_early: number }

export interface FirmRunnerDeps {
  db: EngineDb;
  chain: Chain;
  desk: string;
  burnPot: string;
  accounts: Accounts;
  profiles: Profiles;
  firms: () => Firms | null;
  subjobs: () => Subjobs | null;
  /** a deal's burn for a price (../pay.ts): what each hire adds to the burn beside its lock */
  burnFor: (priceWei: bigint) => bigint;
  members: () => Member[];
  /** an order of the lead's account (../accounts.ts); null when it cannot be sent now */
  order: (calls: Call[]) => Promise<string | null>;
  /** asks the model as the house agents do, with what it cost */
  ask: (a: Asked) => Promise<{ text: string; input: number; output: number; costMicro: number }>;
  /** whether the house agents may still spend on models today */
  canSpend: () => boolean;
  /** the lead declines the job, with the reason on its page (./house.ts) */
  decline: (job: JobFacts, note: string) => Promise<void>;
  /** hands the finished work to the lead's usual delivery (./house.ts) */
  worked: (job: JobFacts, work: string, cost: { micro: number; input: number; output: number }) => void;
  now: () => number; // ms
  nowS: () => number; // the chain's clock
  log: (line: string) => void;
}

export class FirmRunner {
  constructor(private d: FirmRunnerDeps) {
    d.db.db.exec(SCHEMA);
  }

  private row(job: number): Row | null {
    return (this.d.db.q("SELECT * FROM house_firm_jobs WHERE job_id = ?").get(job) as Row | undefined) ?? null;
  }

  private save(job: number, patch: Partial<Omit<Row, "job_id" | "parts">> & { parts?: Part[] }): void {
    const now = this.d.now();
    this.d.db.q("INSERT OR IGNORE INTO house_firm_jobs (job_id, state, created_at, updated_at) VALUES (?, 'start', ?, ?)").run(job, now, now);
    const p: Record<string, unknown> = { ...patch };
    if (patch.parts) p.parts = JSON.stringify(patch.parts);
    const keys = Object.keys(p);
    if (keys.length) this.d.db.q(`UPDATE house_firm_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE job_id = ?`).run(...Object.values(p), now, job);
  }

  /** What the job's page says of how the firm went about it. */
  note(job: number): string | null {
    const r = this.row(job);
    return r?.note || null;
  }

  /** Whether a job is the house firm's, locked for this lead. */
  isFirmJob(job: JobFacts): boolean {
    const f = this.d.firms()?.firmOfJob(job.id);
    return !!f && !!f.firm.house && !f.part && f.firm.lead === job.agent;
  }

  /**
   * One step of the lead on a job hired through the firm. True: the firm took the step (or waits). False: the job is
   * the lead's usual work from here (done alone, or the finished work is to be delivered), and its usual step runs.
   */
  async step(lead: FirmLead, job: JobFacts): Promise<boolean> {
    const now = this.d.now();
    let r = this.row(job.id);
    if (r && (r.state === "done" || r.state === "alone")) return false;
    if (r && r.next_at > now) return true;
    if (!r) {
      if (job.state !== 1) return false;
      const brief = this.d.profiles.brief(job.id);
      if (!brief) return false; // the lead's usual step waits for the brief, and declines without one
      if (lead.service.refuses(brief)) return false; // and declines what it cannot work from
      const alone = this.aloneWhy(job);
      if (alone) {
        this.save(job.id, { state: "alone", note: alone });
        this.d.log(`[firm] ${HOUSE_FIRM.name}, job ${job.id}: ${lead.name} does it alone (${alone})`);
        return false;
      }
      const parts = this.split(job, brief);
      if (!parts.length) {
        this.save(job.id, { state: "alone", note: `no part of this job was one for the team, so ${lead.name} did it alone` });
        return false;
      }
      this.save(job.id, { state: "start", stage: 1, parts, note: `${HOUSE_FIRM.name} took this job: ${lead.name} reads it, and hires ${[...new Set(parts.map((p) => p.member))].join(", ")} for their parts.` });
      this.d.log(`[firm] ${HOUSE_FIRM.name}, job ${job.id}: the team is ${parts.map((p) => p.member).join(", ")}`);
      r = this.row(job.id)!;
    }
    const parts = JSON.parse(r.parts) as Part[];
    try {
      switch (r.state) {
        case "start": return await this.start(lead, job, r);
        case "drawing": return await this.drawing(job, r);
        case "hiring": return await this.hiring(lead, job, r, parts);
        case "waiting": return await this.waiting(job, r, parts);
        case "accepting": return await this.accepting(lead, job, r, parts);
        case "composing": return this.composing(lead, job, r, parts);
      }
    } catch (e) {
      const tries = r.tries + 1;
      this.d.log(`[firm] job ${job.id}, ${r.state}: ${(e as Error).message ?? String(e)} (try ${tries})`);
      if (tries >= MOST_TRIES * 2) return this.finish(lead, job, r, parts, "a step of the team's could not be taken, so the work went out as it stood");
      this.save(job.id, { tries, next_at: now + 20_000 * 2 ** Math.min(tries, 5) });
    }
    return true;
  }

  /** Why the lead does a job alone, or null when the firm can take it. */
  private aloneWhy(job: JobFacts): string | null {
    const s = this.d.subjobs(), f = this.d.firms();
    if (!s?.cfg.enabled || !f?.cfg.enabled) return "the team's hires are switched off for now, so plain-reader did it alone";
    if (!job.allow_early) return "the customer allowed no early advance, which is what pays the team, so plain-reader did it alone";
    if (BigInt(job.price) < HOUSE_FIRM.fromWei) return `the price is under what the whole team takes a job for (${formatEther(HOUSE_FIRM.fromWei)} ETH), so plain-reader did it alone`;
    if (job.due_at - this.d.nowS() < 3 * 3600) return "the job is due too soon for parts to be due before it, so plain-reader did it alone";
    return null;
  }

  /** The parts of a job: who is hired for what, at what price. */
  private split(job: JobFacts, brief: string): Part[] {
    const byName = new Map(this.d.members().filter((m) => m.ready && m.address).map((m) => [m.name, m]));
    const want: { name: string; stage: 1 | 2; title: string; brief: string }[] = [];
    const figures = brief.split("\n").filter((l) => /\d/.test(l)).length >= FIGURE_LINES;
    if (figures && byName.has("data-shaper")) want.push({ name: "data-shaper", stage: 1, title: "Every figure in the material, as one table", brief: `Columns: one for each kind of figure in it, and one naming what each row is about.\n\n${brief}` });
    if (brief.length >= FAQ_LEAST && byName.has("faq-smith")) want.push({ name: "faq-smith", stage: 1, title: "Questions a reader would ask, answered", brief });
    if (byName.has("red-pen")) want.push({ name: "red-pen", stage: 2, title: "Proofread the research before it goes out", brief: "" });
    // the team is paid out of the half drawn early, less its 1% fee; each part, and the burn each hire adds beside it
    const half = BigInt(job.price) / 2n;
    const budget = half - half / 100n;
    const cost = (list: typeof want) => list.reduce((n, w) => { const f = byName.get(w.name)!.service.floorWei; return n + f + this.d.burnFor(f); }, 0n);
    // too little for all of them: the last part of the first stage is left out first, then the proofreading
    const lastFirst = () => { for (let i = want.length - 1; i >= 0; i--) if (want[i]!.stage === 1) return i; return want.length - 1; };
    while (want.length && cost(want) > budget) want.splice(lastFirst(), 1);
    if (!want.length) return [];
    // a larger job pays each member more, up to twice what it takes a job for
    const scale = (budget * 1000n) / cost(want);
    const k = scale > 2000n ? 2000n : scale < 1000n ? 1000n : scale;
    return want.map((w) => {
      const m = byName.get(w.name)!;
      const price = ((m.service.floorWei * k) / 1000n / 10n ** 12n) * 10n ** 12n;
      return { member: w.name, address: m.address!, stage: w.stage, title: w.title, brief: w.brief, price: price.toString(), burn: this.d.burnFor(price).toString(), dueAt: 0, plan: null, job: null, state: "planned" as const, relay: null };
    });
  }

  /** The lead's own reading first, kept the moment it is done; then half of the job drawn early. */
  private async start(lead: FirmLead, job: JobFacts, r: Row): Promise<boolean> {
    if (r.reading === null) {
      const brief = this.d.profiles.brief(job.id) ?? "";
      const title = this.d.profiles.titles([job.id]).get(job.id) ?? "";
      if (!this.d.canSpend()) { await this.d.decline(job, `${lead.name} has taken all the jobs it takes in a day: hire the firm again tomorrow`); this.save(job.id, { state: "done", note: "" }); return true; }
      const answer = await this.d.ask(lead.service.ask!(title, brief));
      const done: Done = lead.service.finish!(answer.text);
      if ("decline" in done) {
        this.save(job.id, { state: "done", note: "", cost_micro: answer.costMicro, input: answer.input, output: answer.output });
        await this.d.decline(job, done.decline);
        return true;
      }
      this.save(job.id, { reading: done.work, cost_micro: answer.costMicro, input: answer.input, output: answer.output });
    }
    if (job.state !== 1) { this.save(job.id, { state: "hiring" }); return true; }
    const relay = await this.d.order([deskCall(this.d.desk, "draw", [BigInt(job.id), BigInt(job.price) / 2n, 0])]);
    if (relay) this.save(job.id, { state: "drawing", relay, tries: 0 });
    return true;
  }

  private relayOf(id: string | null): { status: string; hash: string | null } | null {
    if (!id) return null;
    const s = this.d.accounts.store.relay(id);
    return s ? { status: s.status, hash: s.tx_hash } : null;
  }

  private async drawing(job: JobFacts, r: Row): Promise<boolean> {
    const s = this.relayOf(r.relay);
    if (s && (s.status === "queued" || s.status === "sent")) return true;
    if (s?.status === "done" || job.state === 2) { this.save(job.id, { state: "hiring", relay: null, tries: 0 }); return true; }
    // the advance was not drawn: tried again, then the lead does the job alone
    if (r.tries + 1 >= MOST_TRIES) { this.save(job.id, { state: "alone", relay: null, note: "the early advance that pays the team could not be drawn, so plain-reader did it alone" }); return false; }
    this.save(job.id, { state: "start", relay: null, tries: r.tries + 1, next_at: this.d.now() + 20_000 });
    return true;
  }

  /** One part of the current stage at a time: its hire signed and checked, then locked with its burn in one order. */
  private async hiring(lead: FirmLead, job: JobFacts, r: Row, parts: Part[]): Promise<boolean> {
    const stage = parts.filter((p) => p.stage === r.stage);
    const locking = stage.find((p) => p.state === "locking");
    if (locking) {
      const s = this.relayOf(locking.relay);
      if (s && (s.status === "queued" || s.status === "sent")) return true;
      if (s?.status === "done" && s.hash) {
        const id = await this.lockedIn(s.hash, locking);
        if (id !== null) {
          const sub = this.d.subjobs()!;
          const locked = await readLock(this.d.chain, this.d.desk, id, s.hash);
          if (typeof locked !== "string") {
            const a = sub.attach(locking.plan!, id, locked, s.hash, "house");
            if (a.status === 200) sub.ownBurn(id, BigInt(locking.burn), s.hash);
            else locking.note = String(a.body.error);
          }
          Object.assign(locking, { job: id, state: "locked", relay: null });
          this.d.log(`[firm] job ${job.id}: ${locking.member} hired for its part, job ${id}`);
        } else Object.assign(locking, { state: "skipped", relay: null, note: "its lock could not be read" });
      } else Object.assign(locking, { state: "skipped", relay: null, note: "its lock was not sent" });
      this.save(job.id, { parts });
      return true;
    }
    const next = stage.find((p) => p.state === "planned");
    if (!next) {
      // every part of this stage is locked (or left out): the members are at work
      this.save(job.id, { state: "waiting", since: this.d.now(), parts });
      return true;
    }
    const t = this.d.nowS();
    const dueAt = Math.min(t + PART_DUE_S, job.due_at - 1800);
    if (dueAt < t + 3600 + 120) {
      Object.assign(next, { state: "skipped", note: "too little time was left for it to be due before the job" });
      this.save(job.id, { parts });
      return true;
    }
    const plan: HirePlan = { parent: job.id, agent: next.address, price: next.price, dueAt, early: false, title: next.title, brief: next.brief, at: t };
    const signature = lead.signMessage ? await lead.signMessage(hireMessage(plan)) : "0x";
    const planned = this.d.subjobs()?.ownPlan(plan, lead.address, signature);
    if (!planned || planned.status !== 200) {
      Object.assign(next, { state: "skipped", note: String(planned?.body.error ?? "hiring is off") });
      this.save(job.id, { parts });
      return true;
    }
    const calls: Call[] = [deskCall(this.d.desk, "lock", [next.address, BigInt(dueAt), false], BigInt(next.price))];
    if (BigInt(next.burn) > 0n) calls.push({ to: this.d.burnPot, value: BigInt(next.burn), data: "0x" });
    const relay = await this.d.order(calls);
    if (!relay) return true; // the account has an order on its way: the next pass
    Object.assign(next, { state: "locking", relay, plan: String(planned.body.plan), dueAt });
    this.save(job.id, { parts });
    return true;
  }

  /** The job a part's own order locked, read from the order's receipt. */
  private async lockedIn(hash: string, p: Part): Promise<number | null> {
    const receipt = await this.d.chain.receipt(hash);
    if (!receipt?.ok) return null;
    const ids = new Set<number>();
    for (const log of receipt.logs) {
      if (log.address !== this.d.desk) continue;
      try {
        const e = decodeEventLog({ abi: factorDeskAbi as Abi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex }) as unknown as { eventName: string; args: { id: bigint } };
        if (e.eventName === "Locked") ids.add(Number(e.args.id));
      } catch {
        // another of the desk's logs
      }
    }
    for (const id of ids) {
      const l = await readLock(this.d.chain, this.d.desk, id, hash);
      if (typeof l !== "string" && l.agent === p.address && l.price === BigInt(p.price)) return id;
    }
    return null;
  }

  /** The members at work: their deliveries are taken as they come, until all are in or the wait is over. */
  private async waiting(job: JobFacts, r: Row, parts: Part[]): Promise<boolean> {
    const stage = parts.filter((p) => p.stage === r.stage && (p.state === "locked" || p.state === "delivered"));
    for (const p of stage) {
      if (p.state !== "locked" || p.job === null) continue;
      const desk = this.d.db.q("SELECT state FROM desk_jobs WHERE id = ?").get(p.job) as { state: number } | undefined;
      if (!desk) continue;
      if (desk.state === 3 || desk.state === 4 || desk.state === 5) {
        const w = this.d.profiles.work(p.job);
        if (w) Object.assign(p, { state: desk.state === 3 ? "delivered" : "accepted" });
      } else if (desk.state === 6 || desk.state === 7) Object.assign(p, { state: "skipped", note: desk.state === 6 ? "it declined its part" : "its part was refunded" });
    }
    const open = parts.filter((p) => p.stage === r.stage && p.state === "locked");
    const late = this.d.now() - r.since > PART_WAIT_MS || job.due_at - this.d.nowS() < 1800;
    if (open.length && !late) { this.save(job.id, { parts }); return true; }
    for (const p of open) Object.assign(p, { state: "skipped", note: "it had not delivered in time; its part comes back to the lead by the desk's own clock" });
    this.save(job.id, { state: "accepting", parts });
    return true;
  }

  /** The lead accepts every delivery of the stage in one order: each member is paid now. */
  private async accepting(lead: FirmLead, job: JobFacts, r: Row, parts: Part[]): Promise<boolean> {
    const waiting = parts.filter((p) => p.stage === r.stage && p.state === "accepting");
    if (waiting.length) {
      const s = this.relayOf(r.relay);
      if (s && (s.status === "queued" || s.status === "sent")) return true;
      for (const p of waiting) Object.assign(p, { state: s?.status === "done" ? "accepted" : "delivered" });
      // a refused order leaves the deliveries to settle by themselves after their 24 hours: the members are paid all the same
      if (s?.status !== "done") for (const p of waiting) p.note = "accepted by the desk's own clock after its 24 hours";
      this.save(job.id, { state: "composing", relay: null, parts });
      return true;
    }
    const delivered = parts.filter((p) => p.stage === r.stage && p.state === "delivered" && p.job !== null);
    if (!delivered.length) { this.save(job.id, { state: "composing", parts }); return true; }
    const relay = await this.d.order(delivered.map((p) => deskCall(this.d.desk, "accept", [BigInt(p.job!)])));
    if (!relay) return true;
    for (const p of delivered) p.state = "accepting";
    this.save(job.id, { relay, parts });
    return true;
  }

  /** The members' work put together with the lead's; then the proofreading stage, or the finished work. */
  private composing(lead: FirmLead, job: JobFacts, r: Row, parts: Part[]): boolean {
    const draft = this.draft(r.reading ?? "", parts);
    const proof = parts.find((p) => p.stage === 2 && p.state === "planned");
    if (r.stage === 1 && proof && draft.length <= PROOF_MOST && job.due_at - this.d.nowS() > 3 * 3600) {
      proof.brief = draft;
      this.save(job.id, { state: "hiring", stage: 2, parts });
      return true;
    }
    if (r.stage === 1 && proof) Object.assign(proof, { state: "skipped", note: draft.length > PROOF_MOST ? "the research came out too long to proofread in one part" : "too little time was left before the job was due" });
    return this.finish(lead, job, r, parts, null);
  }

  private work(p: Part): string {
    if (p.job === null) return "";
    const w = this.d.profiles.work(p.job)?.body ?? "";
    // a member's own closing line says who made it: the firm's credits say it once, at the end
    return w.replace(/\n\n(Shaped by data-shaper|Made by faq-smith|Proofread by red-pen)[^\n]*\s*$/, "").trim();
  }

  private draft(reading: string, parts: Part[]): string {
    const got = (name: string) => parts.find((p) => p.member === name && p.stage === 1 && (p.state === "accepted" || p.state === "delivered"));
    const fig = got("data-shaper"), faq = got("faq-smith");
    return [reading.replace(/\n\n[^\n]*plain-reader[^\n]*\s*$/, "").trim(), fig ? `THE FIGURES\n${this.work(fig)}` : "", faq ? `QUESTIONS AND ANSWERS\n${this.work(faq)}` : ""].filter(Boolean).join("\n\n");
  }

  /** The finished work, with who did each part, handed to the lead's usual delivery. */
  private finish(lead: FirmLead, job: JobFacts, r: Row, parts: Part[], why: string | null): false {
    let body = this.draft(r.reading ?? "", parts);
    const proof = parts.find((p) => p.stage === 2 && (p.state === "accepted" || p.state === "delivered"));
    if (proof) {
      const corrected = /CORRECTED\s*\n([\s\S]*?)\n\s*CHANGES\b/.exec(this.work(proof));
      if (corrected && corrected[1]!.trim().length > body.length / 2) body = corrected[1]!.trim();
    }
    const pad = (n: number | null) => (n === null ? "" : ` (job ${String(n).padStart(4, "0")})`);
    const did = (p: Part) => `${p.member === "data-shaper" ? "figures by" : p.member === "faq-smith" ? "questions by" : "proofread by"} ${p.member}${pad(p.job)}`;
    const done = parts.filter((p) => p.state === "accepted" || p.state === "delivered");
    const credits = `${HOUSE_FIRM.name}, Factor's own firm: read by ${lead.name}${done.length ? `, ${done.map(did).join(", ")}` : ""}. Each part was its own job on the desk, paid on delivery.`;
    const left = parts.filter((p) => p.state === "skipped");
    const note = `${HOUSE_FIRM.name} took this job: ${lead.name} read it${done.length ? ` and hired ${done.map((p) => p.member).join(", ")}` : ""}.${left.length ? ` Left out: ${left.map((p) => `${p.member} (${p.note ?? "not hired"})`).join("; ")}.` : ""}${why ? ` ${why[0]!.toUpperCase()}${why.slice(1)}.` : ""}`;
    this.d.worked(job, `${body}\n\n${credits}`, { micro: r.cost_micro, input: r.input, output: r.output });
    this.save(job.id, { state: "done", parts, note });
    this.d.log(`[firm] job ${job.id}: the team's work is done and goes to the customer`);
    return false;
  }
}

