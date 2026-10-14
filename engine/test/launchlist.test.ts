import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import { LaunchList } from "../src/launchlist.js";
import { hostedMessage } from "../src/house/hosted.js";
import { profileMessage } from "../src/profiles.js";
import { HouseActivity } from "../src/activity.js";

const maker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // anvil's public test key 1
const own = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // anvil's public test key 2
const NOW = Date.UTC(2026, 9, 14, 10);
const at = Math.floor(NOW / 1000);
const INSTR = "Write a haiku about whatever the customer names. Three lines of five, seven and five syllables. Nothing else.";

async function made(list: LaunchList, name = "haiku-maker", o: { priceEth?: string; who?: typeof maker; signWith?: typeof maker } = {}) {
  const who = (o.who ?? maker).address.toLowerCase();
  const priceEth = o.priceEth ?? "0.002";
  const does = "Writes a haiku about anything you name";
  const signature = await (o.signWith ?? o.who ?? maker).signMessage({ message: hostedMessage(who, name, does, priceEth, who, keccak256(toHex(INSTR)), at) });
  return list.make({ owner: who, name, does, instructions: INSTR, priceEth, at, signature });
}

describe("signing up before the launch: an agent made here", () => {
  it("takes an agent its maker signed for, keeps the name, and shows it to its maker as waiting for the launch", async () => {
    const list = new LaunchList(new Database(":memory:"), { now: () => NOW });
    expect((await made(list)).status).toBe(200);
    expect(list.madeBy(maker.address.toLowerCase())).toEqual([expect.objectContaining({ name: "haiku-maker", priceEth: 0.002, waiting: true, ready: false })]);
    expect(list.list()).toEqual([expect.objectContaining({ kind: "made", name: "haiku-maker", does: "Writes a haiku about anything you name", priceEth: 0.002 })]);
    expect(JSON.stringify(list.list())).not.toContain("Three lines"); // instructions are never shown
    expect((await made(list)).body.error).toBe("another agent has that name");
  });

  it("refuses a signature that is not the maker's, a house agent's name, a price under the least, and too many from one address", async () => {
    const list = new LaunchList(new Database(":memory:"), { now: () => NOW, perOwner: 2 });
    expect((await made(list, "copycat", { signWith: own })).status).toBe(401);
    expect((await made(list, "page-smith")).body.error).toBe("that name is not available");
    expect((await made(list, "cheap-one", { priceEth: "0.0001" })).status).toBe(400);
    expect((await made(list, "one-agent")).status).toBe(200);
    expect((await made(list, "two-agent")).status).toBe(200);
    expect((await made(list, "three-agent")).status).toBe(429);
  });
});

describe("signing up before the launch: an agent with a wallet of its own", () => {
  it("keeps the name its own wallet signed, and lets it change it", async () => {
    const list = new LaunchList(new Database(":memory:"), { now: () => NOW });
    const address = own.address.toLowerCase();
    const sign = async (name: string, does: string) => list.own({ address, name, does, at, signature: await own.signMessage({ message: profileMessage(address, name, does, at) }) });
    expect((await sign("tide-reader", "Reads tide tables")).status).toBe(200);
    expect((await sign("tide-reader-2", "Reads tide tables, better")).status).toBe(200);
    expect(list.list()).toEqual([expect.objectContaining({ kind: "own", name: "tide-reader-2", address })]);
    expect(list.total()).toBe(1);
    const forged = await list.own({ address, name: "stolen", does: "Not mine", at, signature: await maker.signMessage({ message: profileMessage(address, "stolen", "Not mine", at) }) });
    expect(forged.status).toBe(401);
  });
});

describe("Factor's own agents at work before the launch", () => {
  /** A node with Chainlink's ETH feed at 3412.55 and every stock at 231.40, and a gas price of 0.02 gwei. */
  const node = (async (_u: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: [{ to?: string }] };
    if (method === "eth_gasPrice") return new Response(JSON.stringify({ result: "0x1312d00" }));
    const price = params[0]?.to === "0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9" ? 341_255_000_000n : 23_140_000_000n;
    const word = (v: bigint) => v.toString(16).padStart(64, "0");
    return new Response(JSON.stringify({ result: `0x${word(1n)}${word(price)}${word(0n)}${word(0n)}${word(1n)}` }));
  }) as unknown as typeof fetch;

  it("price-desk reads ETH and a stock, gas-desk prices a transfer, and each is written down", async () => {
    let flip = 0;
    const a = new HouseActivity(new Database(":memory:"), { urls: ["https://node.example"], fetchFn: node, now: () => NOW, random: () => (flip++ % 2 ? 0.75 : 0.25) });
    const first = await a.turn();
    expect(first).toMatchObject({ agent: "price-desk", kind: "read" });
    expect(first?.text).toMatch(/^read ETH at \$3,412\.55 and [A-Z]+ at \$231\.40 from Chainlink's feeds$/);
    expect((await a.turn())?.text).toBe("worked out that a plain transfer costs about $0.0014 right now");
    expect(a.latest().map((x) => x.agent)).toEqual(["gas-desk", "price-desk"]);
  });

  it("which agent goes is chance, but never the same one three times running", async () => {
    const a = new HouseActivity(new Database(":memory:"), { urls: ["https://node.example"], fetchFn: node, now: () => NOW, random: () => 0.1 });
    for (let i = 0; i < 6; i++) await a.turn();
    expect(a.latest(6).map((x) => x.agent).reverse()).toEqual(["price-desk", "price-desk", "gas-desk", "price-desk", "price-desk", "gas-desk"]);
  });

  it("now and then an agent that uses a model does a practice job, and it all stops at the launch", async () => {
    let asked = 0;
    let launched = false;
    const a = new HouseActivity(new Database(":memory:"), { urls: ["https://node.example"], fetchFn: node, now: () => NOW, practiceEvery: 3, launched: () => launched,
      ask: async () => { asked++; return { text: "the work, handed back", input: 400, output: 300 }; } });
    await a.turn(); await a.turn();
    const third = await a.turn();
    expect(asked).toBe(1);
    expect(third).toMatchObject({ kind: "practice" });
    expect(third?.text).toMatch(/^did a practice job on its own, ".+": 21 characters handed back$/);
    launched = true;
    expect(await a.turn()).toBeNull();
  });
});
