// Accounts for people without a wallet, through the engine, on the made-up chain: making one, what the gas wallet
// pays for and what it does not, an order from the check to the receipt, and the limits on all of it. The made-up
// accounts take one fixed signature as their owner's (see fake.ts); the real contract's own checks of a passkey and
// a key are in contracts/test/Account.t.sol and in the end-to-end runs.

import { describe, expect, it } from "vitest";
import { actState } from "../src/chain/act.js";
import { AccountStore, deskCall, KIND, readAccounts } from "../src/accounts.js";
import { keyMessage } from "../src/compute.js";
import { profileMessage } from "../src/profiles.js";
import { A, ETH, FakeChain, GOOD_SIGNATURE } from "./chain/fake.js";
import { rig, wallet, type Rig } from "./chain/harness.js";

const ON = { ACCOUNTS_MODE: "on", FACTOR_ACCOUNTS: A.accounts };
const X = `0x${"11".repeat(32)}`, Y = `0x${"22".repeat(32)}`;
const PASSKEY = { kind: "passkey", x: X, y: Y, credential: "0xc0ffee01" };
const PERSON = FakeChain.accountOf({ kind: KIND.passkey, a: X, b: Y });
const BOT_OF_AGENT = wallet(0xb07a);
const AGENT = FakeChain.accountOf({ kind: KIND.wallet, a: `0x${"0".repeat(24)}${BOT_OF_AGENT.slice(2)}`, b: `0x${"0".repeat(64)}` });
const BAD_SIGNATURE = `0x${"00".repeat(65)}`;

type Body = Record<string, any>;
const post = async (r: Rig, path: string, body: unknown, from = "1.1.1.1"): Promise<Body> => { const a = (await r.engine.post(path, body, from))!; return { status: a.status, ...(a.body as Body) }; };
const get = async (r: Rig, path: string): Promise<Body> => { const a = (await r.engine.handle(path))!; return { status: a.status, ...(a.body as Body) }; };
const store = (r: Rig) => new AccountStore(r.db);
const world = (mode: "watch" | "dry" | "live" = "live", more: Record<string, string> = {}, chain = new FakeChain()) => rig(mode, { chain, more: { ...ON, ...more } });

/** A person's account and an agent's, both made, the agent registered on the desk, the person holding 0.05 ETH. */
async function two(more: Record<string, string> = {}): Promise<Rig> {
  const r = await world("live", more);
  await r.engine.watchOnce();
  expect((await post(r, "/v1/accounts", PASSKEY)).address).toBe(PERSON);
  expect((await post(r, "/v1/accounts", { kind: "wallet", address: BOT_OF_AGENT })).address).toBe(AGENT);
  await r.turn();
  r.chain.balances.set(PERSON, ETH / 20n);
  await order(r, AGENT, [deskCall(A.desk, "register")]);
  return r;
}

/** An order from the check to the receipt, as the site and the kit send one. */
async function order(r: Rig, account: string, calls: { to: string; value: bigint; data: string }[], signature: string = GOOD_SIGNATURE): Promise<Body> {
  const wire = calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data }));
  const checked = await post(r, "/v1/accounts/check", { account, calls: wire });
  if (checked.status !== 200) return checked;
  const sent = await post(r, "/v1/accounts/relay", { account, calls: wire, deadline: checked.deadline, signature });
  if (sent.status !== 200) return sent;
  await r.turn();
  return get(r, `/v1/accounts/relay/${sent.id}`);
}

describe("the settings", () => {
  it("are off until they are switched on and there is something to make accounts with", () => {
    expect(readAccounts({})).toMatchObject({ enabled: false, factory: null, note: null, newPerCallerDay: 3, ordersPerAccountDay: 40, gasDayWei: 10n ** 16n });
    expect(readAccounts({ FACTOR_ACCOUNTS: A.accounts })).toMatchObject({ enabled: false, factory: A.accounts });
    const half = readAccounts({ ACCOUNTS_MODE: "on" });
    expect(half.enabled).toBe(false);
    expect(half.note).toContain("FACTOR_ACCOUNTS is not set");
    expect(readAccounts({ ...ON, ACCOUNTS_GAS_DAY_ETH: "0.5", ACCOUNTS_ORDERS_DAY: "5" })).toMatchObject({ enabled: true, gasDayWei: 5n * 10n ** 17n, ordersPerAccountDay: 5 });
    const problems: string[] = [];
    readAccounts({ ...ON, FACTOR_ACCOUNTS: "nowhere", ACCOUNTS_GAS_DAY_ETH: "lots", ACCOUNTS_NEW_DAY: "0" }, problems);
    expect(problems).toHaveLength(3);
  });

  it("say on the site's feed whether an account can be made right now", async () => {
    const live = await world("live");
    expect(((await get(live, "/v1/state")).accounts)).toEqual({ enabled: true, factory: A.accounts, ordersPerDay: 40 });
    // reading only: there is no gas wallet to send an order from
    const watching = await world("watch");
    expect((await get(watching, "/v1/state")).accounts.enabled).toBe(false);
    expect(await post(watching, "/v1/accounts", PASSKEY)).toMatchObject({ status: 503, error: "the engine is not sending transactions right now" });
    const off = await rig("live");
    expect((await get(off, "/v1/state")).accounts).toEqual({ enabled: false, factory: null, ordersPerDay: 40 });
    expect(await post(off, "/v1/accounts", PASSKEY)).toMatchObject({ status: 503, error: "accounts are not switched on yet" });
  });

  it("refuse to start with a maker of accounts that is not one", async () => {
    const r = await world("live", { FACTOR_ACCOUNTS: wallet(0x99) });
    expect(r.engine.state).toBe("stopped");
    expect(r.engine.problems[0]).toContain("FACTOR_ACCOUNTS");
  });
});

describe("making an account", () => {
  it("is one transaction of the gas wallet's, and the same key is always the same account", async () => {
    const r = await world();
    await r.engine.watchOnce();
    const made = await post(r, "/v1/accounts", PASSKEY);
    expect(made).toMatchObject({ status: 200, address: PERSON, deployed: false });
    expect(await get(r, `/v1/accounts/relay/${made.relay}`)).toMatchObject({ kind: "create", status: "queued", hash: null });
    // asked again before it exists: the same account, the same order, nothing made twice
    expect(await post(r, "/v1/accounts", PASSKEY)).toMatchObject({ address: PERSON, deployed: false, relay: made.relay });
    await r.turn();
    expect(r.chain.sends("create")).toHaveLength(1);
    expect(r.chain.made.has(PERSON)).toBe(true);
    const done = await get(r, `/v1/accounts/relay/${made.relay}`);
    expect(done).toMatchObject({ status: "done", hash: r.chain.sends("create")[0]!.hash });
    expect(await post(r, "/v1/accounts", PASSKEY)).toMatchObject({ address: PERSON, deployed: true, relay: null });
    expect(await get(r, `/v1/accounts/${PERSON}`)).toMatchObject({ address: PERSON, deployed: true, balanceWei: "0", nonce: 0, ordersToday: 0, busy: null, keys: [{ kind: "passkey", x: X, y: Y, credential: "0xc0ffee01" }] });
    // a browser that has only its passkey finds the account by the passkey's own id
    expect(await get(r, "/v1/accounts/by-credential/0xc0ffee01")).toMatchObject({ status: 200, address: PERSON });
    expect((await get(r, "/v1/accounts/by-credential/0xdead")).status).toBe(404);
    expect((await get(r, `/v1/accounts/${wallet(0x77)}`)).status).toBe(404);
    expect(r.db.lastAction("relay")).toMatchObject({ status: "done", ref: made.relay });
  });

  it("takes a key or says why it is not one", async () => {
    const r = await world();
    await r.engine.watchOnce();
    expect((await post(r, "/v1/accounts", { kind: "passkey", x: X, y: "0x12", credential: "0x01" })).status).toBe(400);
    expect((await post(r, "/v1/accounts", { kind: "passkey", x: X, y: Y })).status).toBe(400);
    expect((await post(r, "/v1/accounts", { kind: "wallet", address: "nobody" })).status).toBe(400);
    expect((await post(r, "/v1/accounts", { kind: "wallet", address: `0x${"0".repeat(40)}` })).status).toBe(400);
    expect((await post(r, "/v1/accounts", { kind: "seed phrase" })).status).toBe(400);
    expect((await post(r, "/v1/accounts", [1])).status).toBe(400);
    expect(store(r).totals().accounts).toBe(0);
  });

  it("knows an account somebody else made, from the chain", async () => {
    const chain = new FakeChain();
    const r = await world("live", {}, chain);
    await r.engine.watchOnce();
    // the maker of accounts is open to anyone: here a stranger's own transaction made one
    const stranger = chain.signer(wallet(0x5a));
    chain.balances.set(wallet(0x5a), ETH);
    await stranger.send({ call: { to: A.accounts, abi: [], functionName: "create", args: [{ kind: KIND.passkey, a: X, b: Y }, "0xc0ffee01"] }, gas: 300_000n, nonce: chain.nonce, fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } }, () => undefined);
    await r.engine.watchOnce();
    expect(await get(r, `/v1/accounts/${PERSON}`)).toMatchObject({ deployed: true, keys: [{ kind: "passkey", credential: "0xc0ffee01" }] });
    expect(await post(r, "/v1/accounts", PASSKEY)).toMatchObject({ address: PERSON, deployed: true, relay: null });
    expect(chain.sends("create")).toHaveLength(1);
    // and a database that was lost finds it again
    r.db.forgetChain();
    r.sqlite.prepare("DELETE FROM accounts").run();
    r.sqlite.prepare("DELETE FROM account_keys").run();
    await r.engine.watchOnce();
    expect(await get(r, "/v1/accounts/by-credential/0xc0ffee01")).toMatchObject({ address: PERSON });
  });

  it("is held to a few a day from one place, and to a number a day in all", async () => {
    const r = await world("live", { ACCOUNTS_NEW_PER_CALLER_DAY: "2", ACCOUNTS_NEW_DAY: "3" });
    await r.engine.watchOnce();
    const key = (n: number) => ({ kind: "wallet", address: wallet(0x1000 + n) });
    expect((await post(r, "/v1/accounts", key(1), "9.9.9.9")).status).toBe(200);
    expect((await post(r, "/v1/accounts", key(2), "9.9.9.9")).status).toBe(200);
    expect(await post(r, "/v1/accounts", key(3), "9.9.9.9")).toMatchObject({ status: 429, error: "2 new accounts a day can be made from one place. Try again tomorrow." });
    // the one it already has is still found
    expect((await post(r, "/v1/accounts", key(1), "9.9.9.9")).status).toBe(200);
    expect((await post(r, "/v1/accounts", key(4), "8.8.8.8")).status).toBe(200);
    expect(await post(r, "/v1/accounts", key(5), "7.7.7.7")).toMatchObject({ status: 429, error: "No more new accounts today. Try again tomorrow, or use a wallet." });
    r.chain.mine(1, 86_400);
    expect((await post(r, "/v1/accounts", key(5), "7.7.7.7")).status).toBe(200);
    // where a caller was is not kept: a mark made from it and the day, which says nothing by itself
    const kept = JSON.stringify([r.sqlite.prepare("SELECT * FROM accounts").all(), r.sqlite.prepare("SELECT * FROM relays").all()]);
    for (const ip of ["9.9.9.9", "8.8.8.8", "7.7.7.7"]) expect(kept).not.toContain(ip);
  });
});

describe("an order", () => {
  it("goes from the check to the chain with the gas wallet paying, and the job is the account's", async () => {
    const r = await two();
    const botBefore = r.chain.balances.get(A.bot)!;
    const due = BigInt(r.chain.time + 86_400);
    const done = await order(r, PERSON, [deskCall(A.desk, "lock", [AGENT, due, false], ETH / 25n)]);
    expect(done).toMatchObject({ status: "done", kind: "execute", account: PERSON });
    expect(done.hash).toBe(r.chain.sends("execute").at(-1)!.hash);
    // the logs of the transaction come back with it, so whoever sent it reads the job's number as from a receipt
    expect((done.logs as { address: string }[]).some((l) => l.address === A.desk)).toBe(true);
    const job = [...r.chain.jobs.values()].at(-1)!;
    expect(job).toMatchObject({ customer: PERSON, agent: AGENT, price: ETH / 25n });
    expect(r.chain.balances.get(PERSON)).toBe(ETH / 20n - ETH / 25n);
    expect(r.chain.balances.get(A.bot)!).toBeLessThan(botBefore);
    expect(await get(r, `/v1/accounts/${PERSON}`)).toMatchObject({ nonce: 1, ordersToday: 1, busy: null });
    expect(store(r).gasToday()).toBeGreaterThan(0n);
    // the engine's own record of what the gas wallet sent has it, under the order's id
    expect(r.db.lastAction("relay", done.id)).toMatchObject({ status: "done", tx_hash: done.hash });
    await r.engine.watchOnce();
    expect((await get(r, "/v1/jobs")).items[0]).toMatchObject({ customer: PERSON, agentId: AGENT, priceEth: 0.04 });
  });

  it("is refused before anybody signs anything when the desk would refuse it, with the desk's own reason", async () => {
    const r = await two();
    const due = BigInt(r.chain.time + 86_400);
    const wire = (c: { to: string; value: bigint; data: string }) => ({ to: c.to, value: c.value.toString(), data: c.data });
    const small = await post(r, "/v1/accounts/check", { account: PERSON, calls: [wire(deskCall(A.desk, "lock", [AGENT, due, false], ETH / 10_000n))] });
    expect(small).toMatchObject({ status: 400, refused: { name: "TooSmall", args: [(ETH / 1000n).toString()] } });
    const nobody = await post(r, "/v1/accounts/check", { account: PERSON, calls: [wire(deskCall(A.desk, "lock", [wallet(0x404), due, false], ETH / 25n))] });
    expect(nobody).toMatchObject({ status: 400, refused: { name: "NotRegistered" } });
    const short = await post(r, "/v1/accounts/check", { account: PERSON, calls: [wire(deskCall(A.desk, "lock", [AGENT, due, false], ETH))] });
    expect(short).toMatchObject({ status: 400, refused: { name: "AccountShort", args: [(ETH / 20n).toString(), ETH.toString()] } });
    expect((await post(r, "/v1/accounts/check", { account: wallet(0x77), calls: [wire(deskCall(A.desk, "register"))] })).status).toBe(404);
    expect(r.chain.sends("execute")).toHaveLength(1); // the agent's registration, and nothing since
  });

  it("is paid for when it is the desk's, the account's own keys or ETH going out, and for nothing else", async () => {
    const r = await two();
    const check = (calls: unknown[]) => post(r, "/v1/accounts/check", { account: PERSON, calls });
    // closing a job whose time is up is the engine's own to do, and anybody's with their own gas
    expect(await check([{ to: A.desk, data: deskCall(A.desk, "settle", [1n]).data }])).toMatchObject({ status: 400, error: "Factor pays the gas for hiring, taking and closing jobs on the desk. That call is not one of them." });
    expect((await check([{ to: A.desk, data: deskCall(A.desk, "refund", [1n]).data }])).status).toBe(400);
    expect((await check([{ to: A.desk, data: deskCall(A.desk, "collect", [PERSON]).data }])).status).toBe(400);
    // some other contract
    expect((await check([{ to: A.splitter, data: "0x35faa416" }])).error).toContain("Other calls can be sent from a wallet added to the account as a key");
    expect((await check([{ to: A.token, data: "0xa9059cbb" + "00".repeat(64) }])).status).toBe(400);
    expect((await check([{ to: wallet(0x55), value: "0" }])).error).toBe("A payment of nothing is not sent.");
    expect((await check([{ to: PERSON, value: "1", data: "0x12345678" }])).status).toBe(400);
    expect((await check([])).status).toBe(400);
    expect((await check(Array(5).fill({ to: wallet(0x55), value: "1" }))).error).toBe("an order holds 4 calls at most");
    expect((await check([{ to: "nowhere" }])).status).toBe(400);
    expect((await check([{ to: wallet(0x55), value: "-1" }])).status).toBe(400);
    expect((await check([{ to: wallet(0x55), value: "1", data: "zz" }])).status).toBe(400);
    // taking ETH out, to anywhere
    const home = wallet(0x4040);
    const out = await order(r, PERSON, [{ to: home, value: ETH / 100n, data: "0x" }]);
    expect(out.status).toBe("done");
    expect(r.chain.balances.get(home)).toBe(ETH / 100n);
    // the same rules at the door that takes the signed order
    const relay = await post(r, "/v1/accounts/relay", { account: PERSON, calls: [{ to: A.splitter, value: "0", data: "0x35faa416" }], deadline: r.chain.time + 300, signature: GOOD_SIGNATURE });
    expect(relay.status).toBe(400);
  });

  it("with a signature that is not the account's key's is turned away at the door, and costs nothing", async () => {
    const r = await two();
    const sent = r.chain.sends().length;
    const refused = await order(r, PERSON, [{ to: wallet(0x4040), value: 1n, data: "0x" }], BAD_SIGNATURE);
    expect(refused).toMatchObject({ status: 401, refused: { name: "BadSignature" } });
    expect(r.chain.sends()).toHaveLength(sent);
    expect((await get(r, `/v1/accounts/${PERSON}`)).ordersToday).toBe(0);
    const calls = [{ to: wallet(0x4040), value: "1", data: "0x" }];
    const now = r.chain.time;
    expect((await post(r, "/v1/accounts/relay", { account: PERSON, calls, deadline: now, signature: GOOD_SIGNATURE })).error).toContain("deadline");
    expect((await post(r, "/v1/accounts/relay", { account: PERSON, calls, deadline: now + 3601, signature: GOOD_SIGNATURE })).status).toBe(400);
    expect((await post(r, "/v1/accounts/relay", { account: PERSON, calls, deadline: now + 300, signature: "0x12" })).status).toBe(400);
    expect((await post(r, "/v1/accounts/relay", { account: wallet(0x77), calls, deadline: now + 300, signature: GOOD_SIGNATURE })).status).toBe(404);
  });

  it("waits its turn: one at a time for an account, and never before the account exists", async () => {
    const r = await world();
    await r.engine.watchOnce();
    await post(r, "/v1/accounts", PASSKEY);
    const calls = [{ to: wallet(0x4040), value: "1", data: "0x" }];
    expect(await post(r, "/v1/accounts/check", { account: PERSON, calls })).toMatchObject({ status: 409, error: "the account is still being made: a few seconds more" });
    await r.turn();
    r.chain.balances.set(PERSON, ETH);
    const checked = await post(r, "/v1/accounts/check", { account: PERSON, calls });
    expect(checked).toMatchObject({ status: 200, ok: true, nonce: 0, chainId: 4663, deadline: r.chain.time + 600 });
    const first = await post(r, "/v1/accounts/relay", { account: PERSON, calls, deadline: checked.deadline, signature: GOOD_SIGNATURE });
    expect(first.status).toBe(200);
    expect((await get(r, `/v1/accounts/${PERSON}`)).busy).toBe(first.id);
    expect(await post(r, "/v1/accounts/check", { account: PERSON, calls })).toMatchObject({ status: 409, error: "your last action is still on its way: a few seconds more" });
    expect((await post(r, "/v1/accounts/relay", { account: PERSON, calls, deadline: checked.deadline, signature: GOOD_SIGNATURE })).status).toBe(409);
    await r.turn();
    expect((await post(r, "/v1/accounts/check", { account: PERSON, calls })).nonce).toBe(1);
  });

  it("whose time runs out while it waits is not sent", async () => {
    const r = await two();
    const calls = [{ to: wallet(0x4040), value: "1", data: "0x" }];
    const checked = await post(r, "/v1/accounts/check", { account: PERSON, calls });
    const queued = await post(r, "/v1/accounts/relay", { account: PERSON, calls, deadline: checked.deadline, signature: GOOD_SIGNATURE });
    const sent = r.chain.sends().length;
    r.chain.mine(1, 700);
    await r.turn();
    expect(await get(r, `/v1/accounts/relay/${queued.id}`)).toMatchObject({ status: "failed", error: "the order's time ran out before it could be sent: sign it again" });
    expect(r.chain.sends()).toHaveLength(sent);
    // and it does not count against the account's day
    expect((await get(r, `/v1/accounts/${PERSON}`)).ordersToday).toBe(0);
  });

  it("that the chain is slow to mine is followed to its end, and is never sent twice", async () => {
    const r = await two();
    const calls = [{ to: wallet(0x4040), value: "1", data: "0x" }];
    const checked = await post(r, "/v1/accounts/check", { account: PERSON, calls });
    const queued = await post(r, "/v1/accounts/relay", { account: PERSON, calls, deadline: checked.deadline, signature: GOOD_SIGNATURE });
    r.chain.hold = true;
    const before = r.chain.sends("execute").length;
    await r.turn();
    expect(await get(r, `/v1/accounts/relay/${queued.id}`)).toMatchObject({ status: "sent" });
    await r.turn();
    await r.turn();
    expect(r.chain.sends("execute")).toHaveLength(before + 1);
    r.chain.hold = false;
    r.chain.release();
    await r.turn();
    expect(await get(r, `/v1/accounts/relay/${queued.id}`)).toMatchObject({ status: "done" });
    expect(r.chain.balances.get(wallet(0x4040))).toBe(1n);
    expect(r.chain.sends("execute")).toHaveLength(before + 1);
  });

  it("that the chain refuses once it is sent is said, and nothing changed", async () => {
    const r = await two();
    const due = BigInt(r.chain.time + 86_400);
    const calls = [deskCall(A.desk, "lock", [AGENT, due, false], ETH / 25n)].map((c) => ({ to: c.to, value: c.value.toString(), data: c.data }));
    const checked = await post(r, "/v1/accounts/check", { account: PERSON, calls });
    const queued = await post(r, "/v1/accounts/relay", { account: PERSON, calls, deadline: checked.deadline, signature: GOOD_SIGNATURE });
    // between the door and the sending the account's ETH went somewhere else
    r.chain.balances.set(PERSON, 0n);
    await r.turn();
    const end = await get(r, `/v1/accounts/relay/${queued.id}`);
    expect(end.status).toBe("failed");
    expect(r.chain.jobs.size).toBe(0);
    expect(r.chain.sends("execute")).toHaveLength(1); // the gas wallet tried it first and did not send it
  });
});

describe("what the gas wallet pays in a day", () => {
  it("is a number of orders for one account", async () => {
    const r = await two({ ACCOUNTS_ORDERS_DAY: "2" });
    const out = () => order(r, PERSON, [{ to: wallet(0x4040), value: 1n, data: "0x" }]);
    expect((await out()).status).toBe("done");
    expect((await out()).status).toBe("done");
    expect(await out()).toMatchObject({ status: 429, error: "Factor pays the gas for 2 actions a day on one account. More can be sent from a wallet added to it as a key." });
    r.chain.mine(1, 86_400);
    expect((await out()).status).toBe("done");
  });

  it("is a sum of ETH for all of them, and what is already waiting is not sent past it", async () => {
    // on the made-up chain an order costs the gas wallet 0.0000022 ETH
    const r = await two({ ACCOUNTS_GAS_DAY_ETH: "0.000007" });
    // two accounts made and one registration: three orders so far
    expect(store(r).gasToday()).toBe(3n * 2_200_000_000_000n);
    const out = () => order(r, PERSON, [{ to: wallet(0x4040), value: 1n, data: "0x" }]);
    expect((await out()).status).toBe("done");
    const refused = await out();
    expect(refused).toMatchObject({ status: 429 });
    expect(refused.error).toContain("Factor has paid all the gas it pays for accounts today");
    expect(await post(r, "/v1/accounts", { kind: "wallet", address: wallet(0x2222) })).toMatchObject({ status: 429 });
    expect(((await get(r, "/v1/health")).accounts)).toMatchObject({ enabled: true, accounts: 2, deployed: 2, orders: 4, failed: 0, waiting: 0, gasTodayWei: "8800000000000", gasDayWei: "7000000000000" });
    r.chain.mine(1, 86_400);
    expect((await out()).status).toBe("done");
  });

  it("does not hold up what the engine does for everybody: fees are still swept in the same pass", async () => {
    const r = await two();
    r.chain.trade(ETH / 100n);
    const calls = [{ to: wallet(0x4040), value: "1", data: "0x" }];
    const checked = await post(r, "/v1/accounts/check", { account: PERSON, calls });
    await post(r, "/v1/accounts/relay", { account: PERSON, calls, deadline: checked.deadline, signature: GOOD_SIGNATURE });
    await r.turn();
    // the order first, because somebody is waiting for it; then the rest of the pass as on any other day
    expect(r.chain.sends().slice(-3).map((s) => s.tx.call?.functionName)).toEqual(["execute", "sweep", "burn"]);
    expect(actState(r.engine.ctx!, "relay").result).toBe("1 sent and mined");
  });

  it("in dry mode nothing is taken: an order would only wait for a wallet that never sends", async () => {
    const r = await world("dry");
    await r.engine.watchOnce();
    expect((await post(r, "/v1/accounts", PASSKEY)).status).toBe(503);
    expect(actState(r.engine.ctx!, "relay").result).toBe("has not run yet");
  });
});

describe("what an account signs", () => {
  it("its name as an agent, by the answer of its own key", async () => {
    const r = await two();
    await r.engine.watchOnce();
    const at = r.chain.time;
    const body = { address: AGENT, name: "gasless-01", does: "Summarises long documents", at };
    expect(profileMessage(AGENT, body.name, body.does, at)).toContain(AGENT);
    expect(await post(r, "/v1/agents/profile", { ...body, signature: BAD_SIGNATURE })).toMatchObject({ status: 401 });
    expect(await post(r, "/v1/agents/profile", { ...body, signature: GOOD_SIGNATURE })).toMatchObject({ status: 200 });
    expect((await get(r, "/v1/agents/gasless-01")).agent).toMatchObject({ address: AGENT, named: true });
    // an address that is no account of ours is never asked anything
    const calls = r.chain.calls.length;
    expect((await post(r, "/v1/agents/profile", { ...body, address: wallet(0x77), signature: GOOD_SIGNATURE })).status).toBe(401);
    expect(r.chain.calls.slice(calls).filter((c) => c.what === "isValidSignature")).toHaveLength(0);
  });

  it("the title of a job it locked", async () => {
    const r = await two();
    const due = BigInt(r.chain.time + 86_400);
    await order(r, PERSON, [deskCall(A.desk, "lock", [AGENT, due, false], ETH / 25n)]);
    await r.engine.watchOnce();
    const at = r.chain.time;
    expect(await post(r, "/v1/jobs/title", { job: 1, title: "Summarise a lease", at, signature: BAD_SIGNATURE })).toMatchObject({ status: 401 });
    expect(await post(r, "/v1/jobs/title", { job: 1, title: "Summarise a lease", at, signature: GOOD_SIGNATURE })).toMatchObject({ status: 200 });
    expect((await get(r, "/v1/jobs/1")).job.title).toBe("Summarise a lease");
  });

  it("the request for a key to its compute credit", async () => {
    const r = await two({ COMPUTE_MODE: "on", ANTHROPIC_API_KEY: "sk-ant-test-a-key-to-nothing" });
    await r.engine.watchOnce();
    const at = r.chain.time;
    expect(keyMessage(AGENT, at)).toContain(AGENT);
    const gateway = r.engine.gateway!;
    expect(await gateway.mint({ address: AGENT, at, signature: BAD_SIGNATURE })).toMatchObject({ status: 401 });
    expect(await gateway.mint({ address: AGENT, at, signature: GOOD_SIGNATURE })).toMatchObject({ agent: AGENT });
  });
});

describe("reads for a browser with no node of its own", () => {
  it("are of the desk and of accounts, and of nothing else", async () => {
    const r = await two();
    expect(await post(r, "/v1/accounts/call", { to: A.desk, data: "0x", code: true })).toMatchObject({ status: 200, result: "0x6080" });
    expect((await post(r, "/v1/accounts/call", { from: PERSON, to: A.desk, data: deskCall(A.desk, "register").data })).status).toBe(200);
    expect((await post(r, "/v1/accounts/call", { to: PERSON, data: "0x" })).status).toBe(200);
    expect(await post(r, "/v1/accounts/call", { to: A.splitter, data: "0x" })).toMatchObject({ status: 400, error: "only the desk and accounts are read here" });
    expect((await post(r, "/v1/accounts/call", { to: A.token, data: "0x70a08231" })).status).toBe(400);
    expect((await post(r, "/v1/accounts/call", { to: "nowhere", data: "0x" })).status).toBe(400);
    const due = BigInt(r.chain.time + 86_400);
    const refused = await post(r, "/v1/accounts/call", { from: PERSON, to: A.desk, data: deskCall(A.desk, "lock", [wallet(0x404), due, false]).data, value: (ETH / 25n).toString() });
    expect(refused).toMatchObject({ status: 400, refused: { name: "NotRegistered" } });
    // more than the account holds: said as an answer, with what it holds and what was asked
    const short = await post(r, "/v1/accounts/call", { from: PERSON, to: A.desk, data: deskCall(A.desk, "lock", [AGENT, due, false]).data, value: ETH.toString() });
    expect(short).toMatchObject({ status: 400, refused: { name: "AccountShort", args: [(ETH / 20n).toString(), ETH.toString()] } });
  });

  it("and a caller is held to a number of requests a minute", async () => {
    const r = await two();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await post(r, "/v1/accounts", { kind: "seed phrase" }, "6.6.6.6")).status;
    expect(last).toBe(429);
    expect((await post(r, "/v1/accounts", { kind: "seed phrase" }, "5.5.5.5")).status).toBe(400);
  });
});
