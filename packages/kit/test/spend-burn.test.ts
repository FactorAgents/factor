import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Factor } from "../src/index.js";
import { limitsFrom, runTool, Spending } from "../src/tools.js";
import { KEY, state, stub, type Stub } from "./stub.js";

let s: Stub;
beforeAll(async () => { s = await stub(); });
afterAll(async () => { await s.close(); });

it("factor_pay_month counts the month's 1% burn against the per-job cap", async () => {
  const f = await Factor.connect({ api: s.api, rpcUrl: s.rpc, privateKey: KEY });
  s.site.state = state({ contracts: { ...state().contracts, burnPot: "0x00000000000000000000000000000000000000b0" } } as never);
  const ID = `0x${"cd".repeat(32)}`;
  s.site.plan = { enabled: true, burnWei: "100000000000000", jobs: [], plan: {
    id: ID, status: "active", customer: f.address, agent: { address: "0x00000000000000000000000000000000000000a1", name: "lumen-07", named: true },
    title: "A weekly market note", brief: "", priceEth: 0.01, priceWei: "10000000000000000", months: 2, early: false, via: "kit",
    startAt: "2026-10-19T08:00:00.000Z", locked: 1, delivered: 1, settled: 0, paidEth: 0, lockedEth: 0.01, items: [],
    next: { month: 2, open: true, dueAt: "2026-11-18T09:00:00.000Z", lapsesAt: "2026-12-18T07:00:00.000Z" } } };
  const dir = mkdtempSync(join(tmpdir(), "factor-kit-"));
  // a cap of exactly one month's price: the month costs 0.01 ETH plus 0.0001 ETH of burn, 0.0101 ETH in all
  const spending = new Spending(limitsFrom({ FACTOR_MAX_JOB_ETH: "0.01", FACTOR_KIT_DIR: dir }), f.address!);
  const before = s.node.calls.length;
  const r = await runTool(f, "factor_pay_month", { plan: ID }, spending);
  rmSync(dir, { recursive: true, force: true });
  expect(r.text).toContain("over this assistant's cap");
  expect(s.node.calls.slice(before)).toEqual([]);
});
