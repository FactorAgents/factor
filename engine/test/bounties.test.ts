// Bounties on the made-up chain: the bounty contract is modelled here (FakeChain.extra), and its logs are written in the
// real encoding, so the engine reads them with the real ABI. What is checked: the switch and the settings; a bounty read
// and shown on the board; a task's words and an entry's work taken only when they hash to what the chain holds; work hidden
// from everybody until it is public, and the poster's signed read from the deadline; the keeper's every timed step; a win
// on the agent's record and its Factor Score income; Factor's own agents entering with real work, their cap, what they
// pass over, and delivering a win with no second call to a model; that no page view starts anything; the owner's switch.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { KIND } from "../src/accounts.js";
import { factorBountyAbi } from "../src/abi/index.js";
import { BOUNTY_RULES, entryHashOf, readBounties, readMessage, SERVICE_WORDS, splitTask, textHash } from "../src/bounties.js";
import type { CallSpec } from "../src/chain/chain.js";
import type { HouseSigner } from "../src/house/house.js";
import { SERVICES } from "../src/house/services.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain, GOOD_SIGNATURE, S } from "./chain/fake.js";
import { rig, wallet, type Rig } from "./chain/harness.js";

const B = "0x0000000000000000000000000000000000006b70";
const posterKey = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const strangerKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const POSTER = posterKey.address.toLowerCase();
const AGENT = "0x00000000000000000000000000000000000a6e71";
const OTHER = "0x00000000000000000000000000000000000a6e72";
const THIRD = "0x00000000000000000000000000000000000a6e73";
const DAY = 86_400;
const PRIZE = ETH / 200n; // 0.005
const BOND = PRIZE / 100n;
const ST = { open: 1, picked: 2, won: 3, unpicked: 4, undelivered: 5, empty: 6 } as const;

interface ModelBounty { id: number; poster: string; prize: bigint; fee: bigint; bond: bigint; deadline: number; minScore: number; task: string; state: number; winner: string; job: number; bondsBack: boolean; list: string[]; hashes: Map<string, string> }

/** The bounty contract, as the engine asks it things and as the keeper's calls change it. */
class Model {
  items: ModelBounty[] = [];
  won = 0n; split = 0n; burned = 0n; returned = 0n;
  closes: number[] = [];
  bondCalls: number[] = [];
  entersFromAccounts: { id: number; agent: string }[] = [];
  constructor(private chain: FakeChain) {
    chain.extra = { answer: (c) => this.answer(c), run: (c, f, commit, tx) => this.run(c, f, commit, tx) };
  }

  by(id: number): ModelBounty { return this.items.find((x) => x.id === id)!; }

  answer(call: CallSpec): unknown {
    if (call.to.toLowerCase() !== B) return undefined;
    const fn = call.functionName, a = call.args ?? [];
    if (fn === "bounty") { const x = this.items.find((y) => y.id === Number(a[0])); return x ? { state: x.state, task: x.task } : { state: 0, task: `0x${"0".repeat(64)}` }; }
    if (fn === "entryOf") { const h = this.by(Number(a[0]))?.hashes.get(String(a[1]).toLowerCase()); return h ? { hash: h, at: 1 } : { hash: `0x${"0".repeat(64)}`, at: 0 }; }
    const open = this.items.filter((x) => x.state === ST.open);
    const totals: Record<string, bigint> = {
      held: open.reduce((n, x) => n + x.prize + x.fee, 0n), bonds: 0n, owedTotal: 0n, atDesk: this.items.filter((x) => x.state === ST.picked).reduce((n, x) => n + x.prize, 0n), totalPrizes: this.items.reduce((n, x) => n + x.prize, 0n),
      totalBurned: this.burned, totalWon: this.won, totalSplit: this.split, totalReturned: this.returned, bountyCount: BigInt(this.items.length),
    };
    return fn in totals ? totals[fn] : undefined;
  }

  run(call: CallSpec, from: string, commit: boolean, tx: string): unknown {
    // an account's order to enter: the fake chain's accounts only know the desk, so it is modelled here
    if (call.functionName === "execute" && call.to.toLowerCase() !== B) {
      const [calls, , signature] = call.args as [{ to: string; value: bigint; data: Hex }[], bigint, string];
      if (calls.length !== 1 || calls[0]!.to.toLowerCase() !== B) return undefined;
      if (signature !== GOOD_SIGNATURE) throw new Error("BadSignature");
      const c = calls[0]!;
      const d = decodeFunctionData({ abi: factorBountyAbi as Abi, data: c.data });
      const account = call.to.toLowerCase();
      const has = this.chain.balances.get(account) ?? 0n;
      if (c.value > has) throw new Error("insufficient funds");
      if (d.functionName !== "enter") throw new Error("not modelled");
      const [id, agent, hash] = d.args as [bigint, string, string];
      if (commit) { this.chain.balances.set(account, has - c.value); this.entersFromAccounts.push({ id: Number(id), agent: agent.toLowerCase() }); this.enter(Number(id), agent.toLowerCase(), hash, tx); }
      return [];
    }
    if (call.to.toLowerCase() !== B) return undefined;
    const fn = call.functionName, a = call.args ?? [];
    if (fn === "returnBonds") {
      const x = this.by(Number(a[0]));
      if (x.state !== ST.picked || x.bondsBack) throw new Error("WrongState");
      if (commit) { x.bondsBack = true; this.bondCalls.push(x.id); for (const w of x.list) if (w !== x.winner) this.log("Paid", { id: BigInt(x.id), who: w, share: 0n, bond: x.bond }, tx); }
      return null;
    }
    if (fn === "close") {
      const x = this.by(Number(a[0]));
      if (!commit) return null;
      this.closes.push(x.id);
      if (x.state === ST.open) {
        if (this.chain.time < x.deadline) throw new Error("TooSoon");
        if (x.list.length === 0) { x.state = ST.empty; this.returned += x.prize; this.log("Closed", { id: BigInt(x.id), how: ST.empty, winner: "0x0000000000000000000000000000000000000000", job: 0n, share: 0n, paidTo: 0n, burned: 0n, toPoster: x.prize + x.fee }, tx); return null; }
        if (this.chain.time < x.deadline + 3 * DAY) throw new Error("TooSoon");
        x.state = ST.unpicked;
        const share = x.prize / BigInt(x.list.length);
        this.split += x.prize; this.burned += x.fee;
        this.log("Closed", { id: BigInt(x.id), how: ST.unpicked, winner: "0x0000000000000000000000000000000000000000", job: 0n, share, paidTo: BigInt(x.list.length), burned: x.fee, toPoster: 0n }, tx);
        for (const w of x.list) this.log("Paid", { id: BigInt(x.id), who: w, share, bond: x.bond }, tx);
        return null;
      }
      const j = this.chain.jobs.get(x.job)!;
      if (j.state === S.locked && this.chain.time > j.dueAt + 12 * 3600) (this.chain as unknown as { refundJob(id: number, tx: string): void }).refundJob(x.job, tx);
      if (j.state === S.delivered) {
        if (j.proof === x.hashes.get(x.winner) || this.chain.time >= j.deliveredAt + DAY) (this.chain as unknown as { settleJob(id: number, tx: string): void }).settleJob(x.job, tx);
        else throw new Error("TooSoon");
      }
      if (j.state === S.settled) {
        x.state = ST.won; this.won += x.prize;
        this.log("Closed", { id: BigInt(x.id), how: ST.won, winner: x.winner, job: BigInt(x.job), share: 0n, paidTo: 1n, burned: 0n, toPoster: 0n }, tx);
        this.log("Paid", { id: BigInt(x.id), who: x.winner, share: 0n, bond: x.bond }, tx);
      } else if (j.state === S.refunded || j.state === S.declined) {
        x.state = ST.undelivered;
        const others = x.list.filter((w) => w !== x.winner);
        const share = others.length ? (x.prize + x.bond) / BigInt(others.length) : 0n;
        this.log("Closed", { id: BigInt(x.id), how: ST.undelivered, winner: x.winner, job: BigInt(x.job), share, paidTo: BigInt(others.length), burned: 0n, toPoster: others.length ? 0n : x.prize }, tx);
        for (const w of others) this.log("Paid", { id: BigInt(x.id), who: w, share, bond: x.bondsBack ? 0n : x.bond }, tx);
      } else throw new Error("TooSoon");
      return null;
    }
    return undefined;
  }

  log(eventName: string, args: Record<string, unknown>, tx?: string) {
    const abi = factorBountyAbi as Abi;
    const ev = abi.find((x) => x.type === "event" && x.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
    const rest = ev.inputs.filter((i) => !i.indexed);
    return this.chain.push({ address: B, topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[], data: encodeAbiParameters(rest, rest.map((i) => args[i.name]) as never), ...(tx ? { transactionHash: tx as Hex } : {}) } as never);
  }

  post(task: string, o: { openS?: number; minScore?: number; prize?: bigint; poster?: string } = {}): ModelBounty {
    this.chain.mine();
    const prize = o.prize ?? PRIZE;
    const x: ModelBounty = { id: this.items.length + 1, poster: (o.poster ?? POSTER).toLowerCase(), prize, fee: prize / 100n, bond: prize / 100n, deadline: this.chain.time + (o.openS ?? DAY), minScore: o.minScore ?? 0, task: textHash(task), state: ST.open, winner: "", job: 0, bondsBack: false, list: [], hashes: new Map() };
    this.items.push(x);
    this.log("Posted", { id: BigInt(x.id), poster: x.poster, prize, fee: x.fee, bond: x.bond, deadline: BigInt(x.deadline), minScore: BigInt(x.minScore), task: x.task });
    return x;
  }

  enter(id: number, agent: string, hash: string, tx?: string): void {
    const x = this.by(id);
    x.list.push(agent);
    x.hashes.set(agent, hash);
    this.log("Entered", { id: BigInt(id), agent, from: agent, hash, count: BigInt(x.list.length) }, tx);
  }

  enterWork(id: number, agent: string, work: string): string {
    this.chain.mine();
    const hash = entryHashOf(B, id, agent, textHash(work));
    this.enter(id, agent, hash);
    return hash;
  }

  pick(id: number, winner: string): number {
    const x = this.by(id);
    x.state = ST.picked;
    x.winner = winner;
    this.burned += x.fee;
    x.job = this.chain.lock(B, winner, x.prize, 3 * DAY);
    this.log("Picked", { id: BigInt(id), winner, job: BigInt(x.job), burned: x.fee, dueAt: BigInt(this.chain.time + 3 * DAY) });
    return x.job;
  }
}

const rigs: Rig[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => { s.closeAllConnections(); s.close(() => done()); })));
});

const ON = { BOUNTIES: "on", FACTOR_BOUNTY: B, FACTOR_BOUNTY_BLOCK: "5000" };

async function world(o: { more?: Record<string, string>; mode?: "live" | "dry" } = {}): Promise<{ r: Rig; chain: FakeChain; model: Model }> {
  const chain = new FakeChain();
  chain.fund(ETH);
  chain.register(AGENT);
  chain.register(OTHER);
  chain.register(THIRD);
  const model = new Model(chain);
  const r = await rig(o.mode ?? "live", { chain, more: { ...ON, ...o.more } });
  rigs.push(r);
  r.db.q("INSERT INTO agent_profiles (address, name, name_key, does, signed_at) VALUES (?, ?, ?, ?, ?)").run(AGENT, "report-lead", "report-lead", "writes weekly reports", 1);
  await r.engine.watchOnce();
  return { r, chain, model };
}

type Body = Record<string, any>;
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? "")))!; return { status: a.status, ...(a.body as Body) }; };
const post = async (r: Rig, path: string, body: unknown, from = "1.1.1.1"): Promise<Body> => { const a = (await r.engine.post(path, body, from))!; return { status: a.status, ...(a.body as Body) }; };

const TASK = "Write the words for our front page\n\nThree short paragraphs on what the shop sells.";
const WORK = "Here are the three short paragraphs, finished.";

describe("the settings", () => {
  it("are off unless BOUNTIES=on, and say why they cannot run", () => {
    expect(readBounties({}).enabled).toBe(false);
    expect(readBounties({ BOUNTIES: "on" }).note).toMatch(/FACTOR_BOUNTY is not set/);
    expect(readBounties({ BOUNTIES: "on", FACTOR_BOUNTY: B }).note).toMatch(/FACTOR_BOUNTY_BLOCK/);
    expect(readBounties(ON).note).toBeNull();
    expect(readBounties(ON).house).toBe(false);
    expect(readBounties(ON).houseDailyMicro).toBe(2_000_000);
    expect(readBounties({ ...ON, BOUNTIES_HOUSE: "on", BOUNTIES_HOUSE_DAILY_USD: "0.5" })).toMatchObject({ house: true, houseDailyMicro: 500_000 });
    const problems: string[] = [];
    readBounties({ FACTOR_BOUNTY: "nope", FACTOR_BOUNTY_BLOCK: "x", BOUNTIES_PER_PASS: "0", BOUNTIES_HOUSE_DAILY_USD: "lots" }, problems);
    expect(problems).toHaveLength(4);
  });

  it("the contract's hash of an entry has the contract, the bounty, the agent and the work in it", () => {
    const w = textHash(WORK);
    expect(entryHashOf(B, 1, AGENT, w)).not.toBe(entryHashOf(B, 1, OTHER, w));
    expect(entryHashOf(B, 1, AGENT, w)).not.toBe(entryHashOf(B, 2, AGENT, w));
    expect(entryHashOf(B, 1, AGENT, w)).not.toBe(entryHashOf(B, 1, AGENT, textHash("other")));
  });

  it("off, nothing is read or shown, and the first page says bounties are off", async () => {
    const { r, model } = await world({ more: { BOUNTIES: "" } });
    model.post(TASK);
    await r.engine.watchOnce();
    expect(r.db.count("bounties")).toBe(0);
    expect(await get(r, "/v1/bounties")).toMatchObject({ enabled: false, items: [] });
    expect((await get(r, "/v1/state")).bounties.enabled).toBe(false);
    expect((await get(r, "/v1/bounties/1")).status).toBe(404);
    expect((await get(r, "/v1/agents/report-lead")).bounties).toBeUndefined();
    expect((await post(r, "/v1/bounties/task", { id: 1, task: TASK })).status).toBe(503);
  });
});

describe("a bounty, read from the chain", () => {
  it("is on the board with its count, and its words once they hash to what it holds", async () => {
    const { r, model } = await world();
    const x = model.post(TASK);
    await r.engine.watchOnce();
    let b = await get(r, "/v1/bounties/1");
    expect(b).toMatchObject({ id: 1, status: "open", poster: POSTER, prizeEth: 0.005, feeEth: 0.00005, bondEth: 0.00005, entries: 0, slots: 25, revealed: false, title: null, task: null });
    // other words are refused
    expect((await post(r, "/v1/bounties/task", { id: 1, task: "Something else" })).status).toBe(409);
    expect((await post(r, "/v1/bounties/task", { id: 2, task: TASK })).status).toBe(404);
    expect((await post(r, "/v1/bounties/task", { id: 1, task: "" })).status).toBe(400);
    expect((await post(r, "/v1/bounties/task", { id: 1, task: "x".repeat(BOUNTY_RULES.taskBytes + 1) })).status).toBe(400);
    expect((await post(r, "/v1/bounties/task", { id: 1, task: TASK })).status).toBe(200);
    b = await get(r, "/v1/bounties/1");
    expect(b.title).toBe("Write the words for our front page");
    expect(b.task).toBe(TASK);
    const list = await get(r, "/v1/bounties?show=open");
    expect(list.items.map((i: Body) => i.id)).toEqual([1]);
    expect(list).toMatchObject({ enabled: true, contract: B, rules: { burnPct: 1, bondPct: 1, maxEntries: 25, pickD: 3 } });
    expect((await get(r, `/v1/bounties?poster=${POSTER}`)).items).toHaveLength(1);
    expect((await get(r, "/v1/state")).bounties.totals).toMatchObject({ bounties: 1, open: 1, entries: 0, openEth: 0.00505 });
    expect(x.state).toBe(ST.open);
  });

  it("a task can arrive before the engine has read the post, from the chain's own word", async () => {
    const { r, model } = await world();
    model.post(TASK);
    expect((await post(r, "/v1/bounties/task", { id: 1, task: TASK })).status).toBe(200);
  });
});

describe("entries", () => {
  it("are taken only when they hash to what the agent committed, under its own address", async () => {
    const { r, model } = await world();
    model.post(TASK);
    await r.engine.watchOnce();
    expect((await post(r, "/v1/bounties/entry", { id: 1, agent: AGENT, work: WORK })).status).toBe(404);
    model.enterWork(1, AGENT, WORK);
    expect((await post(r, "/v1/bounties/entry", { id: 1, agent: AGENT, work: "Not that" })).status).toBe(409);
    // the agent's work, under another agent that has committed: refused, because the address is in the hash
    model.enter(1, OTHER, entryHashOf(B, 1, AGENT, textHash(WORK)));
    expect((await post(r, "/v1/bounties/entry", { id: 1, agent: OTHER, work: WORK })).status).toBe(409);
    expect((await post(r, "/v1/bounties/entry", { id: 1, agent: AGENT, work: WORK })).status).toBe(200);
    expect((await post(r, "/v1/bounties/entry", { id: 1, agent: AGENT, work: "x".repeat(BOUNTY_RULES.workBytes + 1) })).status).toBe(400);
    await r.engine.watchOnce();
    expect(await get(r, `/v1/bounties/1/mine/${AGENT}`)).toMatchObject({ entered: true, workShown: true });
    expect(await get(r, `/v1/bounties/1/mine/${OTHER}`)).toMatchObject({ entered: true, workShown: false });
    expect(await get(r, `/v1/bounties/1/mine/${THIRD}`)).toMatchObject({ entered: false, workShown: false });
  });

  it("are hidden from everybody until a winner is picked, whatever the door", async () => {
    const { r, chain, model } = await world();
    model.post(TASK);
    const secret = "THE-SECRET-WORK-OF-THE-AGENT";
    model.enterWork(1, AGENT, secret);
    await r.engine.watchOnce();
    expect((await post(r, "/v1/bounties/entry", { id: 1, agent: AGENT, work: secret })).status).toBe(200);
    for (const path of ["/v1/bounties/1", "/v1/bounties", "/v1/bounties?show=open", `/v1/bounties/agent/${AGENT}`, `/v1/bounties/poster/${POSTER}`, `/v1/bounties/1/mine/${AGENT}`, "/v1/state", "/v1/agents/report-lead", `/v1/record/${AGENT}`]) {
      expect(JSON.stringify(await get(r, path))).not.toContain(secret);
    }
    expect((await get(r, "/v1/bounties/1")).items).toBeUndefined();
    expect((await get(r, "/v1/bounties/1")).entries).toBe(1);
    expect((await get(r, `/v1/bounties/1/entries/${AGENT}`)).status).toBe(404);
    // still hidden from the public past the deadline, while the poster chooses
    chain.time += DAY + 1;
    expect(JSON.stringify(await get(r, "/v1/bounties/1"))).not.toContain(secret);
    expect((await get(r, `/v1/bounties/1/entries/${AGENT}`)).status).toBe(404);
    // public from the pick
    model.pick(1, AGENT);
    await r.engine.watchOnce();
    const open = await get(r, "/v1/bounties/1");
    expect(open.revealed).toBe(true);
    expect(open.items[0]).toMatchObject({ agent: AGENT, name: "report-lead", won: true, shown: true, work: secret });
    expect((await get(r, `/v1/bounties/1/entries/${AGENT}`)).entry.work).toBe(secret);
  });

  it("shows an entry whose work never came as no work shown", async () => {
    const { r, chain, model } = await world();
    model.post(TASK);
    model.enterWork(1, AGENT, WORK);
    model.enterWork(1, OTHER, "never sent");
    chain.time += DAY + 1;
    model.pick(1, AGENT);
    await r.engine.watchOnce();
    const items = (await get(r, "/v1/bounties/1")).items as Body[];
    expect(items.map((i) => i.shown)).toEqual([false, false]);
    expect((await post(r, "/v1/bounties/entry", { id: 1, agent: OTHER, work: "never sent" })).status).toBe(200);
    expect(((await get(r, "/v1/bounties/1")).items as Body[])[1]).toMatchObject({ shown: true, work: "never sent" });
  });
});

describe("the poster's read", () => {
  const sign = (id: number, at: number, poster = POSTER, key = posterKey) => key.signMessage({ message: readMessage({ id, poster, at }) });

  it("opens at the deadline, for the poster, by its signature, and tells nobody else", async () => {
    const { r, chain, model } = await world();
    model.post(TASK);
    model.enterWork(1, AGENT, WORK);
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/entry", { id: 1, agent: AGENT, work: WORK });
    const at = () => chain.time;
    // before the deadline: not even the poster, or its second wallet could copy
    let a = await post(r, "/v1/bounties/read", { id: 1, poster: POSTER, at: at(), signature: await sign(1, at()) });
    expect(a.status).toBe(409);
    expect(a.error).toMatch(/deadline/);
    chain.time += DAY;
    // a stranger, as itself and in the poster's name
    a = await post(r, "/v1/bounties/read", { id: 1, poster: strangerKey.address.toLowerCase(), at: at(), signature: await sign(1, at(), strangerKey.address.toLowerCase(), strangerKey) });
    expect(a.status).toBe(403);
    a = await post(r, "/v1/bounties/read", { id: 1, poster: POSTER, at: at(), signature: await sign(1, at(), POSTER, strangerKey) });
    expect(a.status).toBe(401);
    // an old signature
    a = await post(r, "/v1/bounties/read", { id: 1, poster: POSTER, at: at() - 700, signature: await sign(1, at() - 700) });
    expect(a.status).toBe(400);
    // a signature for another bounty
    a = await post(r, "/v1/bounties/read", { id: 1, poster: POSTER, at: at(), signature: await sign(2, at()) });
    expect(a.status).toBe(401);
    // the poster
    a = await post(r, "/v1/bounties/read", { id: 1, poster: POSTER, at: at(), signature: await sign(1, at()) });
    expect(a.status).toBe(200);
    expect(a.items[0]).toMatchObject({ agent: AGENT, shown: true, work: WORK, whole: true });
    // and it is still hidden from the public after that
    expect(JSON.stringify(await get(r, "/v1/bounties/1"))).not.toContain(WORK);
  });
});

describe("the keeper", () => {
  it("sends back an empty bounty from the deadline, and not before", async () => {
    const { r, chain, model } = await world();
    model.post(TASK);
    await r.turn();
    expect(model.closes).toEqual([]);
    chain.time += DAY;
    await r.turn();
    expect(model.closes).toEqual([1]);
    await r.engine.watchOnce();
    expect(await get(r, "/v1/bounties/1")).toMatchObject({ state: "empty", status: "empty", toPosterEth: 0.00505, revealed: true });
  });

  it("splits an unpicked bounty three days after the deadline, and not before", async () => {
    const { r, chain, model } = await world();
    model.post(TASK);
    model.enterWork(1, AGENT, WORK);
    model.enterWork(1, OTHER, "more work");
    await r.turn();
    chain.time += DAY;
    await r.turn();
    expect((await get(r, "/v1/bounties/1"))).toMatchObject({ status: "choosing" });
    expect(model.closes).toEqual([]);
    chain.time += 3 * DAY - 10;
    await r.turn();
    expect(model.closes).toEqual([]);
    chain.time += 10;
    await r.turn();
    expect(model.closes).toEqual([1]);
    await r.engine.watchOnce();
    const b = await get(r, "/v1/bounties/1");
    expect(b).toMatchObject({ state: "unpicked", shareEth: 0.0025, paidTo: 2, revealed: true });
    expect(b.items.map((i: Body) => i.shareEth)).toEqual([0.0025, 0.0025]);
    expect((await get(r, `/v1/bounties/agent/${AGENT}`)).bounties).toMatchObject({ entered: 1, won: 0, splitEth: 0.0025 });
  });

  it("sends bonds back after a pick, closes once the winner delivers its entry's hash, and the win is on the record", async () => {
    const { r, chain, model } = await world();
    model.post(TASK);
    const hash = model.enterWork(1, AGENT, WORK);
    model.enterWork(1, OTHER, "more work");
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/entry", { id: 1, agent: AGENT, work: WORK });
    chain.time += DAY;
    const job = model.pick(1, AGENT);
    await r.turn();
    expect(model.bondCalls).toEqual([1]);
    expect(model.closes).toEqual([]);
    chain.deliver(job, hash);
    await r.turn();
    await r.turn();
    expect(model.closes).toEqual([1]);
    await r.turn();
    const b = await get(r, "/v1/bounties/1");
    expect(b).toMatchObject({ state: "won", winner: { address: AGENT, name: "report-lead", named: true }, job: { n: job } });
    const page = await get(r, "/v1/agents/report-lead");
    expect(page.bounties).toMatchObject({ entered: 1, won: 1, wonEth: 0.005, splitEth: 0 });
    const income = page.factorScore.income as Body[];
    expect(income.map((l) => l.source)).toEqual(["jobs", "monthly", "subjobs", "firm", "bounties"]);
    expect(income.find((l) => l.source === "bounties")).toMatchObject({ settled: 1, valueEth: 0.005, feesEth: 0.0001 });
    expect(income.find((l) => l.source === "jobs")).toMatchObject({ settled: 0 });
    const rec = await get(r, `/v1/record/${AGENT}`);
    expect(rec.bounties).toEqual({ entered: 1, won: 1, wonEth: 0.005, splitEth: 0 });
    const jobPage = await get(r, `/v1/jobs/${job}`);
    expect(jobPage.job.bounty).toEqual({ id: 1, title: null, poster: POSTER, proof: hash });
    expect(jobPage.work.text).toBe(WORK);
    expect((await get(r, `/v1/bounties/poster/${POSTER}`))).toMatchObject({ posted: 1, won: 1, picks: [{ bounty: 1, winner: AGENT, name: "report-lead" }] });
  });

  it("waits for the desk's clock when the proof is not the entry's", async () => {
    const { r, chain, model } = await world();
    model.post(TASK);
    model.enterWork(1, AGENT, WORK);
    chain.time += DAY;
    const job = model.pick(1, AGENT);
    chain.deliver(job, `0x${"ab".repeat(32)}`);
    await r.turn();
    await r.turn();
    expect(model.closes).toEqual([]);
    chain.time += DAY;
    await r.turn();
    await r.turn();
    expect(model.closes).toEqual([1]);
  });

  it("closes when the winner did not deliver past the due time and the grace, or declined", async () => {
    const { r, chain, model } = await world();
    model.post(TASK);
    model.enterWork(1, AGENT, WORK);
    model.enterWork(1, OTHER, "more work");
    chain.time += DAY;
    model.pick(1, AGENT);
    await r.turn();
    chain.time += 3 * DAY + 12 * 3600;
    await r.turn();
    expect(model.closes).toEqual([]);
    chain.time += 700;
    await r.turn();
    expect(model.closes).toEqual([1]);
    await r.engine.watchOnce();
    expect(await get(r, "/v1/bounties/1")).toMatchObject({ state: "undelivered", paidTo: 1 });

    model.post(TASK);
    model.enterWork(2, AGENT, WORK);
    chain.time += DAY;
    const j2 = model.pick(2, AGENT);
    await r.turn();
    (chain as unknown as { decline(id: number): void }).decline(j2);
    await r.turn();
    await r.turn();
    expect(model.closes).toEqual([1, 2]);
    await r.engine.watchOnce();
    expect(await get(r, "/v1/bounties/2")).toMatchObject({ state: "undelivered", paidTo: 0, toPosterEth: 0.005 });
  });

  it("only says what it would do in dry mode", async () => {
    const { r, chain, model } = await world({ mode: "dry" });
    model.post(TASK);
    chain.time += DAY;
    await r.turn();
    expect(model.closes).toEqual([]);
    expect(r.lines.join("\n")).toMatch(/would send bounty close:1/);
  });

  it("stops with the owner's switch and starts again, and everything is hidden meanwhile", async () => {
    const { r, chain, model } = await world();
    model.post(TASK);
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/task", { id: 1, task: TASK });
    turn(r.db, "bounties", false, "a look at it");
    chain.time += DAY;
    await r.turn();
    expect(model.closes).toEqual([]);
    expect(await get(r, "/v1/bounties")).toMatchObject({ enabled: false, items: [] });
    expect((await get(r, "/v1/state")).bounties.enabled).toBe(false);
    turn(r.db, "bounties", true);
    await r.turn();
    expect(model.closes).toEqual([1]);
  });

  it("the owner hides what a task says, and the number stays", async () => {
    const { r, model } = await world({ more: { ENGINE_ADMIN_KEY: "an-admin-key-of-this-test-run-long-enough" } });
    model.post(TASK);
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/task", { id: 1, task: TASK });
    const a = await r.engine.post("/v1/admin/hide", { what: "bounty", key: "1" }, "1.1.1.1", "an-admin-key-of-this-test-run-long-enough");
    expect(a!.status).toBe(200);
    expect(await get(r, "/v1/bounties/1")).toMatchObject({ id: 1, title: null, task: null, hidden: true });
  });
});

// ---------- Factor's own agents ----------

const numberOf = (name: string) => { const i = SERVICES.findIndex((s) => s.name === name); return i >= 0 ? 0xa000 + i : 0xb000 + [...name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 0xfff, 7); };
const signerFor = (name: string): HouseSigner => ({ address: wallet(numberOf(name)), signTypedData: async () => GOOD_SIGNATURE });
const accountOf = (name: string) => FakeChain.accountOf({ kind: KIND.wallet, a: `0x${"0".repeat(24)}${signerFor(name).address.slice(2)}`, b: `0x${"0".repeat(64)}` });
const PAGE_SMITH = accountOf("page-smith"), RED_PEN = accountOf("red-pen");
const A_PAGE = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Tide Tea</title><style>body{font-family:system-ui}</style></head><body><h1>Tide Tea</h1><p>Loose leaf tea, posted weekly.</p></body></html>';

interface StubModel { url: string; asks: number; say: string }
async function stubModel(): Promise<StubModel> {
  const m: StubModel = { url: "", asks: 0, say: A_PAGE };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      m.asks++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: m.say }], usage: { input_tokens: 2000, output_tokens: 1000 } }));
    });
  });
  servers.push(server);
  m.url = await new Promise((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  return m;
}

const round = async (w: Rig, n = 1) => { for (let i = 0; i < n; i++) { await w.engine.houseOnce(); await w.turn(); await w.engine.watchOnce(); } };

async function houseWorld(more: Record<string, string> = {}): Promise<{ r: Rig; chain: FakeChain; model: Model; m: StubModel }> {
  const m = await stubModel();
  const chain = new FakeChain();
  chain.balances.set(A.bot, ETH);
  chain.register(AGENT);
  const model = new Model(chain);
  const r = await rig("live", { chain, houseSigners: signerFor, more: { ...ON, BOUNTIES_HOUSE: "on", HOUSE_MODE: "on", FACTOR_ACCOUNTS: A.accounts, HOUSE_UPSTREAM_URL: m.url, ANTHROPIC_API_KEY: "sk-ant-test-0000-the-owners-key-with-the-model-maker", ...more } });
  rigs.push(r);
  await r.engine.watchOnce();
  await round(r, 8);
  chain.balances.set(PAGE_SMITH, ETH / 10n);
  chain.balances.set(RED_PEN, ETH / 10n);
  return { r, chain, model, m };
}
const LANDING = "A landing page for our tea shop\n\nWe sell loose leaf tea, posted weekly. Say what it is, who it is for, and end with a link to the shop.";

describe("Factor's own agents", () => {
  it("each service has words, and no service is left without any", () => {
    for (const s of SERVICES) expect(SERVICE_WORDS[s.name], s.name).toBeTruthy();
    expect(splitTask("  \nThe title\n\nThe rest").title).toBe("The title");
  });

  it("enter a bounty that fits, with real work from the service that does it, and its work is hidden and readable like any", async () => {
    const { r, chain, model, m } = await houseWorld();
    model.post(LANDING);
    await r.engine.watchOnce();
    // nothing without the task's words
    await round(r, 2);
    expect(m.asks).toBe(0);
    expect((await post(r, "/v1/bounties/task", { id: 1, task: LANDING })).status).toBe(200);
    await round(r, 3);
    expect(m.asks).toBe(1);
    expect(model.entersFromAccounts).toEqual([{ id: 1, agent: PAGE_SMITH }]);
    expect(chain.balances.get(PAGE_SMITH)).toBe(ETH / 10n - BOND);
    expect((await get(r, "/v1/bounties/1")).entries).toBe(1);
    expect(JSON.stringify(await get(r, "/v1/bounties/1"))).not.toContain("Tide Tea");
    expect(await get(r, `/v1/bounties/1/mine/${PAGE_SMITH}`)).toMatchObject({ entered: true, workShown: true });
    // again and again: it does not ask twice or enter twice
    await round(r, 3);
    expect(m.asks).toBe(1);
    expect(model.by(1).list).toHaveLength(1);
    // the entry hash is the work's, under its own address
    expect(model.by(1).hashes.get(PAGE_SMITH)).toBe(entryHashOf(B, 1, PAGE_SMITH, textHash(A_PAGE)));
    expect(r.lines.join("\n")).toMatch(/page-smith did the work for bounty 1: \$0\.\d+ for the model/);
  });

  it("no page view and no API call starts a model", async () => {
    const { r, model, m } = await houseWorld();
    model.post(LANDING);
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/task", { id: 1, task: LANDING });
    for (let i = 0; i < 5; i++) {
      await get(r, "/v1/bounties");
      await get(r, "/v1/bounties/1");
      await get(r, "/v1/state");
      await post(r, "/v1/bounties/task", { id: 1, task: LANDING });
    }
    await r.engine.watchOnce();
    expect(m.asks).toBe(0);
    expect(model.entersFromAccounts).toEqual([]);
  });

  it("a service that reads the chain enters with real figures and asks no model", async () => {
    const { r, chain, model, m } = await houseWorld();
    const PRICES = accountOf("price-desk");
    chain.balances.set(PRICES, ETH / 10n);
    const sheet = "A price sheet for NVDA and ETH\n\nThe latest price of each.";
    model.post(sheet);
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/task", { id: 1, task: sheet });
    await round(r, 3);
    expect(m.asks).toBe(0);
    expect(model.by(1).list).toEqual([PRICES]);
    expect((r.engine as unknown as { bounties: { spentToday(): number } }).bounties.spentToday()).toBe(0);
  });

  it("pass over a task they cannot do", async () => {
    const { r, model, m } = await houseWorld();
    const words = "Plant a tree in my garden\n\nA real tree, by a real person, this week.";
    model.post(words);
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/task", { id: 1, task: words });
    await round(r, 3);
    expect(m.asks).toBe(0);
    expect(model.by(1).list).toEqual([]);
  });

  it("pass when the model says it cannot be done, keeping what it cost", async () => {
    const { r, model, m } = await houseWorld();
    m.say = "DECLINE: this is not something it can build";
    model.post(LANDING);
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/task", { id: 1, task: LANDING });
    await round(r, 3);
    expect(m.asks).toBe(1);
    expect(model.by(1).list).toEqual([]);
    expect((r.engine as unknown as { bounties: { spentToday(): number } }).bounties.spentToday()).toBeGreaterThan(0);
  });

  it("stop at the day's cap of their own, counted by the most a question could cost", async () => {
    const { r, chain, model, m } = await houseWorld({ BOUNTIES_HOUSE_DAILY_USD: "0.09" });
    for (const n of [1, 2]) {
      model.post(`${LANDING} Shop ${n}.`);
      await r.engine.watchOnce();
      await post(r, "/v1/bounties/task", { id: n, task: `${LANDING} Shop ${n}.` });
    }
    await round(r, 6);
    // one question fits: the next could take it over the cap, so it is not asked
    expect(m.asks).toBe(1);
    expect(model.by(1).list).toHaveLength(1);
    expect(model.by(2).list).toHaveLength(0);
    expect(r.lines.join("\n")).toMatch(/day's cap for models on bounties/);
    // the next day it goes on
    chain.time += DAY;
    model.by(2).deadline += 2 * DAY;
    r.db.q("UPDATE bounties SET deadline = deadline + ? WHERE id = 2").run(2 * DAY);
    await round(r, 3);
    expect(m.asks).toBe(2);
  });

  it("pass when the account holds less than the bond, and when they have not the score", async () => {
    const { r, chain, model, m } = await houseWorld();
    chain.balances.set(PAGE_SMITH, 0n);
    model.post(LANDING);
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/task", { id: 1, task: LANDING });
    await round(r, 2);
    expect(m.asks).toBe(0);
    chain.balances.set(PAGE_SMITH, ETH);
    const scored = `${LANDING} With a score.`;
    model.post(scored, { minScore: 100 });
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/task", { id: 2, task: scored });
    await round(r, 2);
    expect(model.by(2).list).toEqual([]);
  });

  it("at most two on one bounty, and never the last slots", async () => {
    const { r, chain, model, m } = await houseWorld();
    m.say = "CORRECTED\nThe page, with its spelling put right, and nothing else changed at all in any way.\n\nCHANGES\n- Nothing needed correcting.";
    const both = `A landing page and its spelling checked\n\nProofread the words for a landing page: ${"our tea shop sells loose leaf tea. ".repeat(3)}`;
    model.post(both);
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/task", { id: 1, task: both });
    chain.balances.set(accountOf("plain-reader"), ETH);
    await round(r, 8);
    const x = model.by(1);
    expect(x.list.length).toBeLessThanOrEqual(2);
    // a bounty nearly full is left to others
    model.post(LANDING);
    for (let i = 0; i < 20; i++) model.enter(2, wallet(0xc000 + i), `0x${(i + 1).toString(16).padStart(64, "0")}`);
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/task", { id: 2, task: LANDING });
    const asks = m.asks;
    await round(r, 3);
    expect(m.asks).toBe(asks);
  });

  it("a house agent that wins delivers its entry with no second call to a model, whatever the price", async () => {
    const { r, chain, model, m } = await houseWorld();
    model.post(LANDING);
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/task", { id: 1, task: LANDING });
    await round(r, 3);
    expect(m.asks).toBe(1);
    chain.time += DAY;
    const job = model.pick(1, PAGE_SMITH);
    await r.engine.watchOnce();
    await round(r, 4);
    expect(m.asks).toBe(1);
    expect(chain.jobs.get(job)!.proof).toBe(model.by(1).hashes.get(PAGE_SMITH));
    await round(r, 3);
    expect(model.by(1).state).toBe(ST.won);
    expect((await get(r, `/v1/jobs/${job}`)).work.kind).toBe("html");
  });

  it("do nothing with BOUNTIES_HOUSE off, or the owner's house or bounties switch", async () => {
    const off = await houseWorld({ BOUNTIES_HOUSE: "" });
    off.model.post(LANDING);
    await off.r.engine.watchOnce();
    await post(off.r, "/v1/bounties/task", { id: 1, task: LANDING });
    await round(off.r, 3);
    expect(off.m.asks).toBe(0);

    const { r, model, m } = await houseWorld();
    model.post(LANDING);
    await r.engine.watchOnce();
    await post(r, "/v1/bounties/task", { id: 1, task: LANDING });
    turn(r.db, "house", false);
    await round(r, 2);
    expect(m.asks).toBe(0);
    turn(r.db, "house", true);
    turn(r.db, "bounties", false);
    await round(r, 2);
    expect(m.asks).toBe(0);
    turn(r.db, "bounties", true);
    await round(r, 2);
    expect(m.asks).toBe(1);
  });
});
