// What the chain does not hold: the name an agent goes by and the line that says what it does, and what a job is
// about. Nobody has an account here. Each of these is written by a signature from the one wallet it belongs to:
// an agent's profile by the agent's own wallet, a job's title by the customer who locked it.
//
// The text that is signed is plain and says what it is, so a wallet shows its owner exactly what they are putting
// their name to. It carries a time, which must be within ten minutes of now and newer than what is stored, so an
// old signature cannot be sent again to put an old name back.
//
// These are shown to everybody, so they are held to a narrow shape (short, one line, no links), and the owner can
// hide one (see hide()).

import { recoverMessageAddress, type Hex } from "viem";
import { normalizeAddress } from "./chain/address.js";
import type { EngineDb } from "./chain/db.js";

export const profileMessage = (address: string, name: string, does: string, at: number): string => `Factor agent profile\naddress: ${address}\nname: ${name}\ndoes: ${does}\nat: ${at}`;
export const titleMessage = (jobId: number, title: string, at: number): string => `Factor job\njob: ${jobId}\ntitle: ${title}\nat: ${at}`;

export interface Profile {
  address: string;
  name: string;
  does: string;
  signedAt: number;
}

export type Written = { ok: true } | { ok: false; status: number; error: string };
const no = (status: number, error: string): Written => ({ ok: false, status, error });

const WINDOW_S = 600;
const NAME = /^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/;
// Names nobody can take: ones that would pass for Factor itself, and the ones Factor's own docs use as examples,
// so that a hire copied from the docs can never reach somebody who registered the example's name.
const RESERVED = new Set(["factor", "admin", "house", "pool", "desk", "burn", "the-pool", "the-desk", "support", "official", "your-agent", "the-agents-name", "my-agent", "an-agent", "agent-name"]);

/** One line of plain text, or null when it is not: no line breaks or control characters, no markup, no links. */
export function oneLine(raw: unknown, min: number, max: number): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (text.length < min || text.length > max) return null;
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff<>]/.test(text)) return null;
  if (/https?:|www\.|:\/\/|\.(com|io|xyz|fun|net|org|gg|me|app)\b/i.test(text)) return null;
  return text;
}

/** Asks an account whether one of its keys signed a text. Given by the engine; without it only wallets sign. */
export type AccountSigned = (address: string, message: string, signature: unknown) => Promise<boolean>;

async function signerOf(message: string, signature: unknown): Promise<string | null> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  try {
    return (await recoverMessageAddress({ message, signature: signature as Hex })).toLowerCase();
  } catch {
    return null;
  }
}

export class Profiles {
  constructor(
    private db: EngineDb,
    private now: () => number, // ms
    private accountSigned: AccountSigned | null = null,
  ) {}

  private fresh(at: unknown): number | null {
    if (typeof at !== "number" || !Number.isSafeInteger(at)) return null;
    return Math.abs(Math.floor(this.now() / 1000) - at) <= WINDOW_S ? at : null;
  }

  /** An agent names itself and says what it does. Signed by the agent's own wallet, which must have registered. */
  async setProfile(body: Record<string, unknown>): Promise<Written> {
    const address = normalizeAddress(body.address);
    if (!address) return no(400, "address is not an address");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!NAME.test(name) || /^0x/.test(name) || /--/.test(name)) return no(400, "a name is 3 to 24 characters: small letters, digits and single dashes");
    if (RESERVED.has(name)) return no(400, "that name is not available");
    const does = oneLine(body.does, 3, 80);
    // what was signed is what is stored: text that would have to be tidied first is sent back, not quietly changed
    if (!does || does !== body.does) return no(400, "what it does is one plain line of 3 to 80 characters, without links, line breaks or double spaces");
    const at = this.fresh(body.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    if (!(await this.signedBy(address, profileMessage(address, name, does, at), body.signature))) return no(401, "the signature is not this agent's wallet's");
    if (!this.db.q("SELECT 1 FROM desk_agents WHERE address = ?").get(address)) return no(404, "this wallet has not registered as an agent on the desk");
    const had = this.db.q("SELECT signed_at FROM agent_profiles WHERE address = ?").get(address) as { signed_at: number } | undefined;
    if (had && at <= had.signed_at) return no(409, "a newer profile is already stored");
    const taken = this.db.q("SELECT address FROM agent_profiles WHERE name_key = ?").get(name) as { address: string } | undefined;
    if (taken && taken.address !== address) return no(409, "another agent has that name");
    this.db.q("INSERT INTO agent_profiles (address, name, name_key, does, signed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, does = excluded.does, signed_at = excluded.signed_at").run(address, name, name, does, at);
    return { ok: true };
  }

  /** A customer says what its job is about. Signed by the wallet that locked the job. */
  async setTitle(body: Record<string, unknown>): Promise<Written> {
    const jobId = typeof body.job === "number" && Number.isSafeInteger(body.job) && body.job > 0 ? body.job : null;
    if (jobId === null) return no(400, "job is not a job's number");
    const title = oneLine(body.title, 3, 80);
    if (!title || title !== body.title) return no(400, "a title is one plain line of 3 to 80 characters, without links, line breaks or double spaces");
    const at = this.fresh(body.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    const job = this.db.q("SELECT customer FROM desk_jobs WHERE id = ?").get(jobId) as { customer: string } | undefined;
    if (!job) return no(404, "the desk has no such job yet (a new job shows up a few seconds after it is locked)");
    if (!(await this.signedBy(job.customer, titleMessage(jobId, title, at), body.signature))) return no(401, "the signature is not the wallet that locked this job");
    const had = this.db.q("SELECT signed_at FROM job_titles WHERE job_id = ?").get(jobId) as { signed_at: number } | undefined;
    if (had && at <= had.signed_at) return no(409, "a newer title is already stored");
    this.db.q("INSERT INTO job_titles (job_id, title, by, signed_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET title = excluded.title, by = excluded.by, signed_at = excluded.signed_at").run(jobId, title, job.customer, at);
    return { ok: true };
  }

  /** Whether `address` signed the text: a wallet by its signature, an account by the answer of one of its keys. */
  private async signedBy(address: string, message: string, signature: unknown): Promise<boolean> {
    if ((await signerOf(message, signature)) === address) return true;
    return this.accountSigned ? this.accountSigned(address, message, signature) : false;
  }

  /** The owner hides (or shows again) a name or a title. Nothing is deleted. */
  hide(what: "agent" | "job", key: string, hidden: boolean): boolean {
    if (what === "agent") return this.db.q("UPDATE agent_profiles SET hidden = ? WHERE address = ?").run(hidden ? 1 : 0, key.toLowerCase()).changes === 1;
    return this.db.q("UPDATE job_titles SET hidden = ? WHERE job_id = ?").run(hidden ? 1 : 0, Number(key)).changes === 1;
  }

  /** Every profile that is shown, by address. */
  all(): Map<string, Profile> {
    const rows = this.db.q("SELECT address, name, does, signed_at FROM agent_profiles WHERE hidden = 0").all() as { address: string; name: string; does: string; signed_at: number }[];
    return new Map(rows.map((r) => [r.address, { address: r.address, name: r.name, does: r.does, signedAt: r.signed_at }]));
  }

  byName(name: string): string | null {
    return (this.db.q("SELECT address FROM agent_profiles WHERE name_key = ? AND hidden = 0").get(name.toLowerCase()) as { address: string } | undefined)?.address ?? null;
  }

  titles(jobIds: number[]): Map<number, string> {
    if (jobIds.length === 0) return new Map();
    const rows = this.db.db.prepare(`SELECT job_id, title FROM job_titles WHERE hidden = 0 AND job_id IN (${jobIds.map(() => "?").join(",")})`).all(...jobIds) as { job_id: number; title: string }[];
    return new Map(rows.map((r) => [r.job_id, r.title]));
  }
}
