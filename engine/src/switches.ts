// The owner's switches: the few things that can be stopped at once, without a restart, when something looks wrong.
//
// The contracts cannot be stopped by anybody. They have no owner and no pause, which is the point of them: nobody
// can freeze a customer's payment or change a rule. What CAN be stopped is everything Factor itself does around
// them, and each of these is a switch here:
//
//   keeper    everything the gas wallet sends: sweeps, burns, settling and refunding jobs whose time is up, and the
//             orders of accounts. (Anyone can still make those calls themselves: they are open to all.)
//   accounts  taking new accounts and orders from people without a wallet
//   compute   serving models for compute credit. The credit itself is kept.
//   house     Factor's own agents taking and doing jobs
//   hiring    the site and the kit offering to lock new jobs. A notice says why. The desk itself still takes a lock
//             from anyone who calls it directly: this only stops Factor from leading people to it.
//   erc8004   writing settled jobs to the agents' ERC-8004 reputation (../erc8004.ts). Jobs settled meanwhile are
//             written once it is turned back on.
//   autoapply agents applying to open jobs on their own (../autoapply.ts). Applications by hand go on; a job an agent
//             was already picked for is still done.
//   bids      offers on open jobs (../openjobs.ts): no job is posted open to offers and no offer is made or changed.
//             An agent can still withdraw an offer, and a lock already made at an offer is still linked. Offers are
//             also off unless BIDS=on, which is how they start: this switch only stops them.
//   verified  checking agents' owners (../verified.ts): no new check, and no outcome shown anywhere, as if it were
//             off. Off unless VERIFIED=on, which is how it starts: this switch only stops it. Turned back on, the
//             outcomes that have not run out show again.
//
// A switch is turned with POST /v1/admin/switch and the owner's key, or set at start with ENGINE_STOP (names with
// commas between them). It is kept in the database, so it holds across a restart until it is turned back.

import type { EngineDb } from "./chain/db.js";

export const SWITCHES = ["keeper", "accounts", "compute", "house", "hiring", "erc8004", "autoapply", "bids", "verified"] as const;
export type Switch = (typeof SWITCHES)[number];
const key = (name: Switch) => `switch:${name}`;

export interface Stopped { at: number; note: string }

export const isSwitch = (v: unknown): v is Switch => typeof v === "string" && (SWITCHES as readonly string[]).includes(v);

/** Whether something is stopped, and since when and why. */
export function stopped(db: EngineDb, name: Switch): Stopped | null {
  return db.getJson<Stopped>(key(name));
}

export function turn(db: EngineDb, name: Switch, on: boolean, note = ""): void {
  if (on) db.unset(key(name));
  else if (!stopped(db, name)) db.setJson(key(name), { at: db.now(), note: note.replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 200) });
}

/** Everything that is stopped right now. */
export function allStopped(db: EngineDb): Partial<Record<Switch, Stopped>> {
  const out: Partial<Record<Switch, Stopped>> = {};
  for (const name of SWITCHES) {
    const s = stopped(db, name);
    if (s) out[name] = s;
  }
  return out;
}

/** ENGINE_STOP at start: the names it holds are stopped. It never turns anything back on. */
export function stopFromEnv(db: EngineDb, raw: string | undefined, problems: string[] = []): void {
  for (const name of (raw ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (isSwitch(name)) turn(db, name, false, "stopped by ENGINE_STOP");
    else problems.push(`ENGINE_STOP holds "${name}", which is not one of ${SWITCHES.join(", ")}`);
  }
}
