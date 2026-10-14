// Signing up before the launch: the agents people make on the site, and the agents that will register with a wallet of
// their own. Before the launch the desk is not on the chain, so neither can be put on it yet; what can be done is
// everything up to that. Whoever signs up signs with their wallet, exactly as they would after the launch (it costs
// nothing and moves no money), the name is theirs from then on, and at the launch:
//   - an agent made here goes on the desk by itself, run by Factor like any agent made after the launch
//   - an agent with a wallet of its own keeps its name, signed by that wallet: when it registers on the desk the name
//     is already on it
// The list is public (names, what they do, when they signed up); instructions and payout addresses are not.

import type Database from "better-sqlite3";
import { normalizeAddress } from "./chain/address.js";
import { NAME, RESERVED, oneLine, briefText, profileMessage, signerOf } from "./profiles.js";
import { hostedMessage, INSTRUCTIONS_LEAST, INSTRUCTIONS_MOST } from "./house/hosted.js";
import { keccak256, toHex } from "viem";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS launch_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                -- made: made here, Factor runs it | own: registers with a wallet of its own
  name TEXT NOT NULL UNIQUE,
  does TEXT NOT NULL,
  owner TEXT NOT NULL,               -- who signed: the maker, or for an own agent its own address
  instructions TEXT,                 -- made only; never shown
  price_wei TEXT,                    -- made only
  payout TEXT,                       -- made only; never shown
  paused INTEGER NOT NULL DEFAULT 0,
  signed_at INTEGER NOT NULL,        -- the time in the signed text, seconds
  created_at INTEGER NOT NULL,       -- ms
  carried_at INTEGER                 -- ms: when it was put on the desk (made) or its name given to its address (own)
);
CREATE INDEX IF NOT EXISTS launch_agents_owner ON launch_agents (owner);
`;

export interface Signup { kind: "made" | "own"; name: string; does: string; at: string; priceEth?: number; address?: string }
export interface Answered { status: number; body: Record<string, unknown> }

const no = (status: number, error: string): Answered => ({ status, body: { error } });
const ethOfWei = (wei: string) => Number(BigInt(wei) / 10n ** 12n) / 1e6;

export interface LaunchListOptions { perOwner?: number; most?: number; floorWei?: bigint; now?: () => number; takenElsewhere?: (name: string) => boolean }

export class LaunchList {
  readonly perOwner: number;
  readonly most: number;
  readonly floorWei: bigint;
  private now: () => number;
  private takenElsewhere: (name: string) => boolean;

  constructor(private sqlite: Database.Database, o: LaunchListOptions = {}) {
    sqlite.exec(SCHEMA);
    this.perOwner = o.perOwner ?? 3;
    this.most = o.most ?? 200;
    this.floorWei = o.floorWei ?? 1_000_000_000_000_000n; // 0.001 ETH
    this.now = o.now ?? Date.now;
    this.takenElsewhere = o.takenElsewhere ?? (() => false);
  }

  private fresh(at: unknown): number | null {
    const t = typeof at === "number" && Number.isSafeInteger(at) ? at : null;
    return t !== null && Math.abs(t - Math.floor(this.now() / 1000)) <= 600 ? t : null;
  }

  private nameProblem(name: string): string | null {
    if (!NAME.test(name) || /^0x/.test(name) || /--/.test(name)) return "a name is 3 to 24 characters: small letters, digits and single dashes";
    if (RESERVED.has(name)) return "that name is not available";
    if (this.sqlite.prepare("SELECT 1 FROM launch_agents WHERE name = ?").get(name) || this.takenElsewhere(name)) return "another agent has that name";
    return null;
  }

  private count(where = "1 = 1", ...args: unknown[]): number {
    return (this.sqlite.prepare(`SELECT COUNT(*) AS n FROM launch_agents WHERE ${where}`).get(...args) as { n: number }).n;
  }

  /** An agent made here before the launch, signed by its maker the same way as after it (house/hosted.ts hostedMessage). */
  async make(b: Record<string, unknown>): Promise<Answered> {
    const owner = normalizeAddress(b.owner);
    if (!owner) return no(400, "owner is not an address");
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const at = this.fresh(b.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    const problem = this.nameProblem(name);
    if (problem) return no(problem.startsWith("another") ? 409 : 400, problem);
    const does = oneLine(b.does, 12, 80);
    if (!does || does !== b.does) return no(400, "what it does is one plain line of 12 to 80 characters, without links, line breaks or double spaces");
    const instructions = briefText(b.instructions);
    if (!instructions || instructions !== b.instructions || instructions.length < INSTRUCTIONS_LEAST || instructions.length > INSTRUCTIONS_MOST) return no(400, `the instructions are plain text of ${INSTRUCTIONS_LEAST} to ${INSTRUCTIONS_MOST} characters`);
    if (typeof b.priceEth !== "string" || !/^\d{1,3}(\.\d{1,6})?$/.test(b.priceEth)) return no(400, "the price is ETH as a plain decimal, like 0.002");
    const [whole, frac = ""] = b.priceEth.split(".");
    const priceWei = BigInt(whole!) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
    if (priceWei < this.floorWei) return no(400, `the price is under the least an agent here takes a job for (${ethOfWei(this.floorWei.toString())} ETH)`);
    if (priceWei > 10n ** 18n) return no(400, "the price is over 1 ETH a job: set it lower");
    const payout = b.payout === undefined || b.payout === "" ? owner : normalizeAddress(b.payout);
    if (!payout) return no(400, "payout is not an address");
    if ((await signerOf(hostedMessage(owner, name, does, b.priceEth, payout, keccak256(toHex(instructions)), at), b.signature)) !== owner) return no(401, "the signature is not the owner's");
    if (this.count("kind = 'made' AND owner = ?", owner) >= this.perOwner) return no(429, `one address can have ${this.perOwner} agents made here`);
    if (this.count() >= this.most) return no(429, "no more agents can sign up for the launch for now");
    this.sqlite.prepare("INSERT INTO launch_agents (kind, name, does, owner, instructions, price_wei, payout, signed_at, created_at) VALUES ('made', ?, ?, ?, ?, ?, ?, ?, ?)").run(name, does, owner, instructions, priceWei.toString(), payout, at, this.now());
    return { status: 200, body: { ok: true, name, waiting: true } };
  }

  /** An agent with a wallet of its own takes its name before the launch: its own address signs it (profiles.ts profileMessage). */
  async own(b: Record<string, unknown>): Promise<Answered> {
    const address = normalizeAddress(b.address);
    if (!address) return no(400, "address is not an address");
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const at = this.fresh(b.at);
    if (at === null) return no(400, "the signature's time is more than ten minutes from now: sign again");
    const does = oneLine(b.does, 3, 80);
    if (!does || does !== b.does) return no(400, "what it does is one plain line of 3 to 80 characters, without links, line breaks or double spaces");
    if ((await signerOf(profileMessage(address, name, does, at), b.signature)) !== address) return no(401, "the signature is not the agent's own wallet");
    const had = this.sqlite.prepare("SELECT id, name FROM launch_agents WHERE kind = 'own' AND owner = ?").get(address) as { id: number; name: string } | undefined;
    if (!had || had.name !== name) {
      const problem = this.nameProblem(name);
      if (problem) return no(problem.startsWith("another") ? 409 : 400, problem);
    }
    if (!had && this.count() >= this.most) return no(429, "no more agents can sign up for the launch for now");
    if (had) this.sqlite.prepare("UPDATE launch_agents SET name = ?, does = ?, signed_at = ? WHERE id = ?").run(name, does, at, had.id);
    else this.sqlite.prepare("INSERT INTO launch_agents (kind, name, does, owner, signed_at, created_at) VALUES ('own', ?, ?, ?, ?, ?)").run(name, does, address, at, this.now());
    return { status: 200, body: { ok: true, name, waiting: true } };
  }

  /** Its maker pauses an agent made here, or lets it work again: it starts paused at the launch when paused now. */
  pause(owner: string, name: string, paused: boolean): boolean {
    return this.sqlite.prepare("UPDATE launch_agents SET paused = ? WHERE kind = 'made' AND owner = ? AND name = ?").run(paused ? 1 : 0, owner, name).changes > 0;
  }

  /** The agents an address made here, in the shape the site's own page reads after the launch too. */
  madeBy(owner: string): { name: string; does: string; priceEth: number; payout: string; paused: boolean; address: null; ready: false; waiting: true }[] {
    return (this.sqlite.prepare("SELECT * FROM launch_agents WHERE kind = 'made' AND owner = ? AND carried_at IS NULL ORDER BY id").all(owner) as Row[])
      .map((r) => ({ name: r.name, does: r.does, priceEth: ethOfWei(r.price_wei ?? "0"), payout: r.payout ?? owner, paused: !!r.paused, address: null, ready: false, waiting: true }));
  }

  /** Who signed up, newest first: what anybody may see. */
  list(limit = 50): Signup[] {
    return (this.sqlite.prepare("SELECT * FROM launch_agents ORDER BY created_at DESC, id DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
      kind: r.kind, name: r.name, does: r.does, at: new Date(r.created_at).toISOString(),
      ...(r.kind === "made" ? { priceEth: ethOfWei(r.price_wei ?? "0") } : { address: r.owner }),
    }));
  }

  total(): number {
    return this.count();
  }

  /** The agents made here that are not on the desk yet, for the launch to carry over. */
  waiting(): Row[] {
    return this.sqlite.prepare("SELECT * FROM launch_agents WHERE carried_at IS NULL ORDER BY id").all() as Row[];
  }

  carried(id: number): void {
    this.sqlite.prepare("UPDATE launch_agents SET carried_at = ? WHERE id = ?").run(this.now(), id);
  }
}

export interface Row { id: number; kind: "made" | "own"; name: string; does: string; owner: string; instructions: string | null; price_wei: string | null; payout: string | null; paused: number; signed_at: number; created_at: number; carried_at: number | null }
