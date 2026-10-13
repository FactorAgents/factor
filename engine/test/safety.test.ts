// What stands between a bad day and a worse one: the owner's switches, the shares the splitter could not deliver,
// the owner's key, and the daily copy of the database.

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { actState } from "../src/chain/act.js";
import { deskCall, KIND } from "../src/accounts.js";
import { backupOnce } from "../src/backup.js";
import { open } from "../src/chain/db.js";
import { allStopped, stopFromEnv, stopped, turn } from "../src/switches.js";
import { A, ETH, FakeChain, GOOD_SIGNATURE, K } from "./chain/fake.js";
import { rig, wallet, type Rig } from "./chain/harness.js";

const KEY = "an-admin-key-of-24-characters";
type Body = Record<string, any>;
const get = async (r: Rig, path: string, from?: string): Promise<Body> => { const a = (await r.engine.handle(path, undefined, from))!; return { status: a.status, ...(a.body as Body) }; };
const post = async (r: Rig, path: string, body: unknown, key?: string, from = "1.1.1.1"): Promise<Body> => { const a = (await r.engine.post(path, body, from, key))!; return { status: a.status, ...(a.body as Body) }; };
const flip = (r: Rig, what: string, on: boolean, note?: string) => post(r, "/v1/admin/switch", { what, on, ...(note ? { note } : {}) }, KEY);
const ON = { ENGINE_ADMIN_KEY: KEY, ACCOUNTS_MODE: "on", FACTOR_ACCOUNTS: A.accounts };
const X = `0x${"11".repeat(32)}`, Y = `0x${"22".repeat(32)}`;
const PERSON = FakeChain.accountOf({ kind: KIND.passkey, a: X, b: Y });

describe("the owner's switches", () => {
  it("are turned only with the owner's key, and say what is stopped", async () => {
    const r = await rig("live", { more: ON });
    await r.engine.watchOnce();
    expect((await post(r, "/v1/admin/switch", { what: "keeper", on: false })).status).toBe(401);
    expect((await post(r, "/v1/admin/switch", { what: "keeper", on: false }, "x".repeat(KEY.length))).status).toBe(401);
    expect((await post(r, "/v1/admin/switch", { what: "keeper", on: false }, KEY + "x")).status).toBe(401);
    expect((await post(r, "/v1/admin/switch", { what: "the contracts", on: false }, KEY)).status).toBe(400);
    expect((await post(r, "/v1/admin/switch", { what: "keeper", on: "no" }, KEY)).status).toBe(400);
    expect(Object.keys((await get(r, "/v1/health")).stopped)).toEqual([]);
    const off = await flip(r, "keeper", false, "looking at a sweep that went wrong");
    expect(off).toMatchObject({ status: 200, stopped: { keeper: { note: "looking at a sweep that went wrong" } } });
    expect((await get(r, "/v1/health")).stopped.keeper.note).toBe("looking at a sweep that went wrong");
    expect((await flip(r, "keeper", true)).stopped).toEqual({});
    // with no key set on the host nothing can be turned, by anybody
    const bare = await rig("live");
    expect((await post(bare, "/v1/admin/switch", { what: "keeper", on: false }, KEY)).status).toBe(401);
  });

  it("the owner's key is tried a few times a minute from one place, and no more", async () => {
    const r = await rig("live", { more: ON });
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await post(r, "/v1/admin/switch", { what: "keeper", on: false }, "a-wrong-key-of-the-same-size!", "6.6.6.6")).status;
    expect(last).toBe(429);
    // and the right key from that place waits its minute too: a guess that happened to be right is no faster
    expect((await post(r, "/v1/admin/switch", { what: "keeper", on: false }, KEY, "6.6.6.6")).status).toBe(429);
    expect((await post(r, "/v1/admin/switch", { what: "keeper", on: false }, KEY, "7.7.7.7")).status).toBe(200);
  });

  it("keeper: the gas wallet sends nothing, whatever is waiting, and goes on where it was when it is turned back", async () => {
    const chain = new FakeChain();
    chain.trade(ETH / 10n);
    chain.register(wallet(0xa1));
    chain.lock(wallet(0xc1), wallet(0xa1), ETH / 100n, 3600);
    chain.mine(1, 14 * 3600);
    const r = await rig("live", { chain, more: ON });
    await r.engine.watchOnce();
    await flip(r, "keeper", false);
    await r.turn();
    await r.turn();
    expect(chain.sends()).toHaveLength(0);
    await flip(r, "keeper", true);
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(1);
    expect(chain.sends("refund")).toHaveLength(1);
  });

  it("keeper: a transaction already on its way when it is stopped is still followed to its end", async () => {
    const chain = new FakeChain();
    chain.trade(ETH / 10n);
    chain.hold = true;
    const r = await rig("live", { chain, more: ON });
    await r.turn();
    expect(chain.sends("sweep")).toHaveLength(1);
    await flip(r, "keeper", false);
    chain.hold = false;
    chain.release();
    await r.turn();
    expect(r.db.lastAction("sweep")).toMatchObject({ status: "done" });
    expect(chain.sends()).toHaveLength(1);
  });

  it("accounts: nothing new is taken, the site is told, and what is in an account is untouched", async () => {
    const r = await rig("live", { more: ON });
    await r.engine.watchOnce();
    expect((await post(r, "/v1/accounts", { kind: "passkey", x: X, y: Y, credential: "0xc0ffee" })).status).toBe(200);
    await r.turn();
    r.chain.balances.set(PERSON, ETH);
    await flip(r, "accounts", false);
    expect((await get(r, "/v1/state")).accounts.enabled).toBe(false);
    const calls = [{ to: wallet(0x4040), value: "1", data: "0x" }];
    expect(await post(r, "/v1/accounts/check", { account: PERSON, calls })).toMatchObject({ status: 503, error: "accounts are paused for now. Nothing in an account is touched by that" });
    expect((await post(r, "/v1/accounts/relay", { account: PERSON, calls, deadline: r.chain.time + 300, signature: GOOD_SIGNATURE })).status).toBe(503);
    expect((await post(r, "/v1/accounts", { kind: "wallet", address: wallet(0x99) })).status).toBe(503);
    // it can still be read
    expect((await get(r, `/v1/accounts/${PERSON}`)).balanceWei).toBe(ETH.toString());
    await flip(r, "accounts", true);
    expect((await post(r, "/v1/accounts/check", { account: PERSON, calls })).status).toBe(200);
  });

  it("hiring: the site's feed carries a line saying why, and nothing else changes", async () => {
    const r = await rig("live", { more: ON });
    await r.engine.watchOnce();
    expect((await get(r, "/v1/state")).paused).toBeNull();
    await flip(r, "hiring", false);
    expect((await get(r, "/v1/state")).paused).toContain("New jobs are paused for now.");
    await flip(r, "hiring", true);
    await flip(r, "hiring", false, "We are looking into a report. <b>Jobs</b> already locked are not affected.");
    expect((await get(r, "/v1/state")).paused).toBe("We are looking into a report.  b Jobs /b  already locked are not affected.");
  });

  it("can be set from the start, are kept across a restart, and a name that is none of them is said", async () => {
    const sqlite = open(":memory:");
    const r = await rig("live", { sqlite, more: { ...ON, ENGINE_STOP: "house, compute,nonsense" } });
    expect(Object.keys(allStopped(r.db)).sort()).toEqual(["compute", "house"]);
    expect(r.lines.join("\n")).toContain('ENGINE_STOP holds "nonsense"');
    expect(r.lines.join("\n")).toContain("STOPPED by the owner: compute, house");
    await r.engine.stop();
    // started again without it: what was stopped stays stopped until the owner turns it back
    const again = await rig("live", { sqlite, chain: r.chain, more: ON });
    expect(stopped(again.db, "house")).not.toBeNull();
    turn(again.db, "house", true);
    expect(stopped(again.db, "house")).toBeNull();
    const problems: string[] = [];
    stopFromEnv(again.db, " ", problems);
    expect(problems).toEqual([]);
  });
});

describe("a share the splitter could not deliver", () => {
  it("is sent on by the engine, and one its destination keeps refusing is not tried over and over", async () => {
    const chain = new FakeChain();
    const r = await rig("live", { chain, more: ON });
    await r.turn();
    expect(actState(r.engine.ctx!, "retry_split").result).toBe("every share the splitter split was delivered");
    // a destination refused its share when the fees were split: it waits in the splitter
    chain.waiting = { admin: 7n * ETH / 100n, burn: 2n * ETH / 100n, pool: ETH / 100n };
    chain.mine();
    const pool = chain.pool;
    await r.turn();
    expect(chain.sends("retry")).toHaveLength(1);
    expect(chain.pool - pool).toBe(ETH / 100n);
    expect(chain.paid.get(A.admin)).toBe(7n * ETH / 100n);
    await r.turn();
    expect(chain.sends("retry")).toHaveLength(1);
    // a destination that still refuses: tried, then left for ten minutes
    chain.waiting = { admin: ETH / 100n, burn: 0n, pool: 0n };
    chain.stillRefused = true;
    chain.mine(1, 601);
    await r.turn();
    await r.turn();
    await r.turn();
    expect(chain.sends("retry")).toHaveLength(2);
    // the try delivered nothing: the next is hours away, not minutes
    chain.mine(1, 601);
    await r.turn();
    expect(chain.sends("retry")).toHaveLength(2);
    chain.mine(1, 6 * 3600);
    await r.turn();
    expect(chain.sends("retry")).toHaveLength(3);
    expect((await get(r, "/v1/health")).warnings.join(" ")).toContain("the splitter holds a share");
  });

  it("in dry mode it is shown, not sent", async () => {
    const chain = new FakeChain();
    chain.waiting = { admin: 0n, burn: ETH / 100n, pool: 0n };
    const r = await rig("dry", { chain, more: { ...ON, BOT_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" } });
    await r.turn();
    expect(actState(r.engine.ctx!, "retry_split").result).toBe("would deliver 0.01 ETH the splitter was holding");
    expect(chain.sends()).toHaveLength(0);
  });
});

describe("the gas wallet's surplus", () => {
  const OWNER = wallet(0x0e);
  it("goes on to the wallet the owner named, less its gas money and what still backs open credit", async () => {
    const chain = new FakeChain();
    chain.gatewayAddr = A.bot;
    chain.fund(ETH);
    chain.register(wallet(0xa1));
    chain.bond(wallet(0xa1), ETH / 10n);
    const job = chain.lock(wallet(0xc1), wallet(0xa1), ETH / 5n);
    chain.draw(job, ETH / 10n, K.compute); // 0.099 ETH reaches the gas wallet, and backs credit while the job is open
    chain.balances.set(A.bot, (chain.balances.get(A.bot) ?? 0n) + ETH / 5n);
    const r = await rig("live", { chain, more: { ...ON, ENGINE_SKIM_TO: OWNER } });
    const before = chain.balances.get(A.bot)!;
    await r.turn();
    await r.turn();
    // it keeps 0.02 for gas and the 0.099 that could still have to go back to the pool
    const sent = chain.balances.get(OWNER) ?? 0n;
    // (less the gas of whatever else it sent in those passes: a ten-thousandth of an ETH at the very most)
    const most = before - ETH / 50n - (ETH / 10n) * 99n / 100n;
    expect(sent).toBeLessThanOrEqual(most);
    expect(sent).toBeGreaterThan(most - ETH / 10_000n);
    expect(chain.balances.get(A.bot)).toBeGreaterThanOrEqual(ETH / 50n + (ETH / 10n) * 99n / 100n - ETH / 10_000n);
    expect(actState(r.engine.ctx!, "skim").result).toContain("sent ");
    expect(r.db.lastAction("skim")).toMatchObject({ status: "done" });
    // once an hour at most, and nothing when there is nothing over
    await r.turn();
    expect(chain.sends("pay")).toHaveLength(1);
    chain.mine(1, 3601);
    await r.turn();
    expect(chain.sends("pay")).toHaveLength(1);
    expect(actState(r.engine.ctx!, "skim").result).toContain("nothing worth sending on");
    // the job settles: what backed its credit is the owner's now, and goes on with the next look
    chain.deliver(job);
    chain.accept(job);
    await r.engine.watchOnce();
    chain.mine(1, 3601);
    await r.turn();
    expect(chain.balances.get(OWNER)! - sent).toBeGreaterThan((ETH / 10n) * 98n / 100n);
  });

  it("stays where it is with no wallet named, is only shown in dry mode, and a contract is not taken for a wallet", async () => {
    const chain = new FakeChain();
    chain.balances.set(A.bot, ETH);
    const none = await rig("live", { chain, more: ON });
    await none.turn();
    expect(actState(none.engine.ctx!, "skim").result).toContain("no wallet is named");
    expect(chain.sends("pay")).toHaveLength(0);
    const dry = await rig("dry", { chain: new FakeChain(), more: { ...ON, ENGINE_SKIM_TO: OWNER, BOT_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" } });
    dry.chain.balances.set(dry.engine.ctx!.facts.bot!, ETH);
    await dry.turn();
    expect(actState(dry.engine.ctx!, "skim").result).toContain("would send 0.98 ETH on to");
    expect(dry.chain.sends()).toHaveLength(0);
    const wrong = await rig("live", { chain: new FakeChain(), more: { ...ON, ENGINE_SKIM_TO: A.desk } });
    expect(wrong.engine.state).toBe("stopped");
    expect(wrong.engine.problems.join(" ")).toContain("ENGINE_SKIM_TO is one of the contracts");
  });

  it("is not sent while the keeper is stopped", async () => {
    const chain = new FakeChain();
    chain.balances.set(A.bot, ETH);
    const r = await rig("live", { chain, more: { ...ON, ENGINE_SKIM_TO: OWNER } });
    await r.engine.watchOnce();
    await flip(r, "keeper", false);
    await r.turn();
    expect(chain.sends()).toHaveLength(0);
  });
});

describe("reads that cost a question to the chain", () => {
  it("are held to a number a minute from one place", async () => {
    const r = await rig("live", { more: ON });
    await r.engine.watchOnce();
    await post(r, "/v1/accounts", { kind: "passkey", x: X, y: Y, credential: "0xc0ffee" });
    await r.turn();
    let last = 0;
    for (let i = 0; i < 301; i++) last = (await get(r, `/v1/accounts/${PERSON}`, "8.8.8.8")).status;
    expect(last).toBe(429);
    expect((await get(r, `/v1/accounts/${PERSON}`, "9.9.9.9")).status).toBe(200);
    // the site's own pages are not counted: they are answered from the engine's own database
    expect((await get(r, "/v1/state", "8.8.8.8")).status).toBe(200);
  });
});

describe("the daily copy of the database", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("is whole, is written once a day, and the last seven are kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factor-backup-"));
    dirs.push(dir);
    const db = open(join(dir, "factor.db"));
    db.exec("CREATE TABLE notes (t TEXT)");
    db.prepare("INSERT INTO notes VALUES (?)").run("a name somebody signed");
    const day = Date.UTC(2026, 9, 13, 12);
    const first = await backupOnce(db, dir, day);
    expect(first).toBe(join(dir, "backups", "factor-2026-10-13.db"));
    expect(await backupOnce(db, dir, day + 3600_000)).toBeNull();
    // the copy opens by itself and holds what the database held
    const copy = new Database(first!, { readonly: true });
    expect(copy.prepare("SELECT t FROM notes").all()).toEqual([{ t: "a name somebody signed" }]);
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    copy.close();
    for (let d = 1; d <= 9; d++) await backupOnce(db, dir, day + d * 86_400_000);
    // (opening the first copy to look inside it left SQLite's own two side files beside it: not copies)
    const kept = readdirSync(join(dir, "backups")).filter((f) => f.endsWith(".db")).sort();
    expect(kept).toHaveLength(7);
    expect(kept[0]).toBe("factor-2026-10-16.db");
    expect(kept[6]).toBe("factor-2026-10-22.db");
    // a stray file in the folder is not taken for a copy, and is left alone
    writeFileSync(join(dir, "backups", "notes.txt"), "mine");
    await backupOnce(db, dir, day + 10 * 86_400_000);
    expect(existsSync(join(dir, "backups", "notes.txt"))).toBe(true);
    db.close();
  });
});

describe("the gas wallet and an order of a stranger's", () => {
  it("with the keeper stopped, an order that was already queued waits and is sent when it is turned back", async () => {
    const r = await rig("live", { more: ON });
    await r.engine.watchOnce();
    await post(r, "/v1/accounts", { kind: "passkey", x: X, y: Y, credential: "0xc0ffee" });
    await r.turn();
    r.chain.balances.set(PERSON, ETH);
    r.chain.register(wallet(0xa1));
    const calls = [deskCall(A.desk, "lock", [wallet(0xa1), BigInt(r.chain.time + 86_400), false], ETH / 100n)].map((c) => ({ to: c.to, value: c.value.toString(), data: c.data }));
    const checked = await post(r, "/v1/accounts/check", { account: PERSON, calls });
    const queued = await post(r, "/v1/accounts/relay", { account: PERSON, calls, deadline: checked.deadline, signature: GOOD_SIGNATURE });
    await flip(r, "keeper", false);
    await r.turn();
    expect((await get(r, `/v1/accounts/relay/${queued.id}`)).status).toBe("queued");
    await flip(r, "keeper", true);
    await r.turn();
    expect((await get(r, `/v1/accounts/relay/${queued.id}`)).status).toBe("done");
    void K;
  });
});
