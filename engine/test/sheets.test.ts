// Live balance sheets: what is counted from each contract's rows, the parties of one agent (its line and pay accounts),
// solvency, the hashed text, the Merkle tree the seal contract's proves() walks, the hourly seal (signed, once an hour),
// the proof of a sealed sheet, the keeper writing the root once, and the owner's switch.

import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { EngineDb, open } from "../src/chain/db.js";
import { canonical, leafOf, merkle, readSheets, sealMessage, Sheets, walk } from "../src/sheets.js";
import { turn } from "../src/switches.js";

const ETH = 10n ** 18n;
const A = "0x00000000000000000000000000000000000a0001"; // an agent with a line and a pay account
const ACCT = "0x00000000000000000000000000000000000a00aa"; // its line account
const PAY = "0x00000000000000000000000000000000000a00bb"; // its pay account
const B = "0x00000000000000000000000000000000000b0001"; // an agent with only a treasury
const C = "0x00000000000000000000000000000000000c0001"; // an agent that owes more than it holds
const K = { desk: "0x000000000000000000000000000000000000d001", line: "0x000000000000000000000000000000000000d002", guarantee: "0x000000000000000000000000000000000000d003", vouch: "0x000000000000000000000000000000000000d004", claims: "0x000000000000000000000000000000000000d005", treasury: "0x000000000000000000000000000000000000d006" };
const SEAL = "0x000000000000000000000000000000000000d007";
const KEEPER = "0x000000000000000000000000000000000000beef";
const signer = privateKeyToAccount(keccak256(toBytes("sheets test key")));

/** A row with only the columns given; every other NOT NULL column gets 0 or an empty text. */
function put(db: EngineDb, table: string, values: Record<string, unknown>): void {
  const cols = db.q(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
  const row: Record<string, unknown> = {};
  for (const c of cols) if (c.notnull && c.dflt_value === null && !(c.name in values)) row[c.name] = /INT/i.test(c.type) ? 0 : "";
  Object.assign(row, values);
  const keys = Object.keys(row);
  db.q(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k] as never));
}

function setup(env: Record<string, string> = { SHEETS: "on", FACTOR_SHEETS: SEAL, FACTOR_SHEETS_BLOCK: "1" }) {
  const clock = { t: 1_790_000_000_000 };
  const db = new EngineDb(open(":memory:"), () => clock.t);
  const sheets = new Sheets({
    cfg: readSheets(env), db, chain: { read: async () => "0x" } as never, chainId: 46630, explorer: "https://robinhoodchain.blockscout.com", now: () => clock.t, log: () => {},
    names: () => new Map([[A, { name: "Ada" }]]), contracts: () => K,
    signer: () => ({ address: signer.address, sign: (text: string) => signer.signMessage({ message: text }) }),
    keeper: () => KEEPER, factorOwn: () => false,
  });
  // A: two open jobs (one paid 0.1 early), a settled one that does not count, a desk bond, a line, a guarantee bond with a
  // cover sold, a vouching bond with a vouch, a pay account that sold pay, a claim it bought, a coin with fees waiting
  put(db, "desk_jobs", { id: 1, agent: PAY, customer: B, price: (1n * ETH).toString(), early: "0", state: 1 });
  put(db, "desk_jobs", { id: 2, agent: PAY, customer: B, price: (5n * ETH / 10n).toString(), early: (ETH / 10n).toString(), state: 2 });
  put(db, "desk_jobs", { id: 3, agent: PAY, customer: B, price: (9n * ETH).toString(), early: "0", state: 4 });
  put(db, "desk_agents", { address: PAY, registered_block: 1, registered_at: 1, record: JSON.stringify({ bond: (ETH / 5n).toString() }) });
  put(db, "lines", { account: ACCT, key: A, block: 1, at: 1, state: JSON.stringify({ debt: (3n * ETH / 10n).toString() }) });
  put(db, "guarantee_bonds", { agent: A, block: 1, state: JSON.stringify({ bond: (2n * ETH).toString(), reserved: (ETH / 2n).toString() }) });
  put(db, "vouch_vouchers", { voucher: A, block: 1, state: JSON.stringify({ bond: (ETH).toString(), held: (ETH / 4n).toString() }) });
  put(db, "claims_accounts", { account: PAY, key: A, block: 1, at: 1, debt: (4n * ETH / 10n).toString() });
  put(db, "claims_claims", { id: 7, block: 1, at: 1, tx_hash: "0x", job: 99, account: "0x00000000000000000000000000000000000e0001", face: ETH.toString(), price: ETH.toString(), state: "sold", holder: A, owing: (6n * ETH / 10n).toString() });
  put(db, "coins", { agent: A, coin: "0x00000000000000000000000000000000000c01c0", splitter: "0x00000000000000000000000000000000000c0150", curve: "0x00000000000000000000000000000000000c0c00", maker: A, state: JSON.stringify({ unsplit: (ETH / 10n).toString(), escrow: (ETH / 10n).toString(), totalSplit: (10n * ETH).toString(), toCompute: (6n * ETH).toString() }) });
  // B: only a treasury
  put(db, "treasury_agents", { agent: B, block: 1, at: 1, tx_hash: "0x", balance: (7n * ETH / 10n).toString() });
  // C: a line it owes on and nothing else
  put(db, "lines", { account: "0x00000000000000000000000000000000000c00aa", key: C, block: 1, at: 1, state: JSON.stringify({ debt: (ETH / 10n).toString() }) });
  return { db, sheets, clock };
}

const wei = (s: { holds: { key: string; wei: string }[]; owes: { key: string; wei: string }[] }, side: "holds" | "owes", key: string) => BigInt(s[side].find((l) => l.key === key)?.wei ?? "0");

describe("live balance sheets", () => {
  it("reads the switch and the settings", () => {
    expect(readSheets({}).enabled).toBe(false);
    const problems: string[] = [];
    readSheets({ SHEETS: "on", FACTOR_SHEETS: "nope", SHEETS_MAX: "0" }, problems);
    expect(problems.join(" ")).toMatch(/FACTOR_SHEETS is not an address/);
    expect(problems.join(" ")).toMatch(/SHEETS_MAX/);
  });

  it("counts every line from its contract, across the agent's line and pay accounts", () => {
    const { sheets } = setup();
    expect(sheets.parties(A).sort()).toEqual([A, ACCT, PAY].sort());
    const s = sheets.sheet(A)!;
    expect(s.name).toBe("Ada");
    expect(wei(s, "holds", "lockedPay")).toBe(14n * ETH / 10n); // 1 + (0.5 - 0.1); the settled job is not pay waiting
    expect(wei(s, "holds", "deskBond")).toBe(ETH / 5n);
    expect(wei(s, "holds", "guaranteeBond")).toBe(2n * ETH);
    expect(wei(s, "holds", "vouchBond")).toBe(ETH);
    expect(wei(s, "holds", "payBought")).toBe(6n * ETH / 10n);
    expect(wei(s, "holds", "coinFees")).toBe(12n * ETH / 100n); // 0.2 waiting at 60% to compute
    expect(wei(s, "owes", "creditLine")).toBe(3n * ETH / 10n);
    expect(wei(s, "owes", "coversSold")).toBe(ETH / 2n);
    expect(wei(s, "owes", "vouchesGiven")).toBe(ETH / 4n);
    expect(wei(s, "owes", "paySold")).toBe(4n * ETH / 10n);
    expect(BigInt(s.holdsWei) - BigInt(s.owesWei)).toBe(BigInt(s.netWei));
    expect(s.solvent).toBe(true);
    // every line names where it is read
    for (const l of [...s.holds, ...s.owes]) expect(l.source.call.length).toBeGreaterThan(3);
    expect(s.owes.find((l) => l.key === "creditLine")!.source).toEqual({ contract: K.line, call: `line(${ACCT}).debt` });
  });

  it("one sheet per agent, the largest first, and insolvent when it owes more", () => {
    const { sheets } = setup();
    const all = sheets.all();
    expect(all.map((s) => s.agent)).toEqual([A, B, C]);
    const c = sheets.sheet(C)!;
    expect(c.solvent).toBe(false);
    expect(c.netEth).toBeCloseTo(-0.1);
    expect(sheets.sheet("0x00000000000000000000000000000000000f0001")).toBeNull();
  });

  it("a contract that is not on is not counted", () => {
    const { db } = setup();
    const s = new Sheets({ cfg: readSheets({ SHEETS: "on" }), db, chain: {} as never, chainId: 1, explorer: null, now: () => 0, log: () => {}, names: () => new Map(), contracts: () => ({ ...K, line: null, guarantee: null }), signer: () => null, keeper: () => null, factorOwn: () => false });
    const a = s.sheet(A)!;
    expect(wei(a, "owes", "creditLine")).toBe(0n);
    expect(wei(a, "holds", "guaranteeBond")).toBe(0n);
  });

  it("the hashed text holds every key in a fixed order", () => {
    const t = canonical(A, 5, [{ key: "treasury", wei: "7" }], [{ key: "creditLine", wei: "3" }]);
    expect(t).toBe(`factor-sheet-v1|${A}|5|holds:lockedPay=0,deskBond=0,treasury=7,guaranteeBond=0,vouchBond=0,payBought=0,coinFees=0|owes:creditLine=3,coversSold=0,vouchesGiven=0,paySold=0`);
    expect(leafOf(t)).toBe(keccak256(toBytes(t)));
  });

  it("the tree: every leaf's proof walks to the root, for any count", () => {
    for (const n of [1, 2, 3, 4, 5, 7, 8, 13]) {
      const leaves = Array.from({ length: n }, (_, i) => keccak256(toBytes(`leaf ${i}`)) as Hex);
      const { root, proofOf } = merkle(leaves);
      for (let i = 0; i < n; i++) expect(walk(leaves[i]!, proofOf(i))).toBe(root);
      expect(walk(keccak256(toBytes("not a leaf")), proofOf(0))).not.toBe(root);
    }
  });

  it("seals each hour once, signed, and proves each sheet", async () => {
    const { sheets, clock, db } = setup();
    const said = await sheets.sealNow();
    expect(said).toMatch(/sealed 3 balance sheets/);
    expect(await sheets.sealNow()).toBeNull(); // the same hour: once
    const hour = Math.floor(clock.t / 3_600_000);
    const seal = sheets.sealOf(hour)!;
    expect(seal.sheets).toBe(3);
    expect(await signer.address).toBe(seal.signer);
    const { verifyMessage } = await import("viem");
    expect(await verifyMessage({ address: signer.address, message: sealMessage(hour, seal.root, 3), signature: seal.signature as Hex })).toBe(true);
    const p = sheets.proofOf(A)!;
    expect(p.hour).toBe(hour);
    expect(walk(p.leaf, p.proof)).toBe(seal.root);
    expect(p.text).toContain(`|${hour}|`);
    // the next hour is a new seal
    clock.t += 3_600_000;
    expect(await sheets.sealNow()).toMatch(/sealed 3/);
    expect(sheets.latest()!.hour).toBe(hour + 1);
    // the owner's switch stops it
    turn(db, "sheets", false);
    expect(sheets.on()).toBe(false);
    clock.t += 3_600_000;
    expect(await sheets.sealNow()).toBeNull();
  });

  it("the keeper writes the latest root once", async () => {
    const { sheets, db } = setup();
    const sent: unknown[][] = [];
    const ctx = { params: { maxGasWei: 10n ** 15n } } as never;
    const attempt = async (_k: "sheets", _r: string, call: { functionName: string; args?: readonly unknown[] }) => { sent.push([call.functionName, ...(call.args ?? [])]); return { status: "done", why: "", hash: "0xabc" }; };
    const said = await sheets.step(ctx, {} as never, attempt);
    expect(said).toMatch(/write hour \d+'s root of 3 balance sheets/);
    expect(sent.length).toBe(1);
    expect(sent[0]![0]).toBe("seal");
    expect(sheets.latest()!.tx).toBe("0xabc");
    expect(await sheets.step(ctx, {} as never, attempt)).toMatch(/already written/);
    expect(sent.length).toBe(1);
    void db;
  });

  it("without a seal contract the sheets are signed and nothing is sent", async () => {
    const { db } = setup();
    const s = new Sheets({ cfg: readSheets({ SHEETS: "on" }), db, chain: {} as never, chainId: 1, explorer: null, now: () => 1_790_000_000_000, log: () => {}, names: () => new Map(), contracts: () => K, signer: () => null, keeper: () => null, factorOwn: () => false });
    const attempt = async () => { throw new Error("nothing may be sent"); };
    expect(await s.step({ params: { maxGasWei: 1n } } as never, {} as never, attempt as never)).toMatch(/sealed|no seal contract/);
  });
});
