// Factor Credit Reports in the kit, against a made-up Factor site: a report read through the site and said in the same
// words as the engine (engine/src/reports.ts), the leaderboard and the look-up, the signed answer checked against the signer
// (and refused when it is not Factor's or has run out), an owner's claim signed with the key in the same words the engine
// checks, and the four tools an assistant gets.
import { recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimMessage as engineClaimMessage, reportText as engineReportText, type ReportJson } from "../../../engine/src/reports.js";
import { askedText, claimMessage, creditLeaderboard, creditReport, Factor, findAgent, reportText, signedReport, type Asked, type CreditReport } from "../src/index.js";
import { runTool, TOOLS } from "../src/tools.js";
import { KEY, stub, type Stub } from "./stub.js";

let s: Stub;
beforeAll(async () => { s = await stub(); });
afterAll(async () => { await s.close(); });
const ME = privateKeyToAccount(KEY).address.toLowerCase();
const SIGNER = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");

const REPORT: CreditReport = {
  enabled: true, version: "factor-report/1.0.0", score: 412, of: 1000, blank: false, rank: 3, ranked: 418,
  agent: { subject: "8004:486", agentId: "486", name: "ledger-bot", nameFrom: "chain", about: "Reads ledgers.", owner: ME, agentWallet: "0x00000000000000000000000000000000000a6e01", maker: ME, desk: ["0x00000000000000000000000000000000000a6e01"], registeredAt: "2026-09-20T10:00:00.000Z", uri: null, factorOwn: false },
  parts: [
    { key: "work", name: "Paid work", points: 210, max: 400, why: "6 jobs paid in full on the Factor desk, 0.21 ETH in all, from 4 customers.", lines: [] },
    { key: "repayment", name: "Repayment", points: 102, max: 250, why: "2.00 repayment units: 2 loans repaid on Priors.", lines: [] },
    { key: "feedback", name: "Paying clients' feedback", points: 30, max: 150, why: "1 paying client said something: 1 good, 0 middling, 0 bad.", lines: [] },
    { key: "time", name: "Time active", points: 50, max: 100, why: "Counted activity in 5 weeks.", lines: [] },
    { key: "reliability", name: "Reliability", points: 20, max: 100, why: "4 of 5 on time.", lines: [] },
  ],
  pulls: [], sources: [{ source: "factor-desk", name: "Factor desk", points: 260 }, { source: "priors", name: "Loans on Priors", points: 122 }, { source: "erc8004-reputation", name: "ERC-8004 reputation", points: 30 }],
  flags: [{ key: "unpaid-feedback", title: "Feedback from wallets that never paid it", words: "3 entries on ERC-8004 came from wallets with no paid job with this agent on the chain.", effect: "Shown, not counted.", count: 3, tone: "info" }],
  raise: ["More customers: each new customer whose jobs pay about 0.05 ETH of work adds 30 points, up to 150."],
  counts: {}, firstAt: "2026-10-01T00:00:00.000Z", lastAt: "2026-11-09T00:00:00.000Z", asOf: "2026-11-10T08:00:00.000Z", block: 110700000, timeline: [], erc8004: [], claim: null,
  links: { page: "https://factoragents.fun/reports/486", card: "https://factoragents.fun/api/v1/reports/486/card.png", badge: "https://factoragents.fun/api/v1/reports/486/badge.svg", signed: "https://factoragents.fun/api/v1/reports/signed/486", erc8004: null, desk: null },
};
const ROW = { subject: "8004:486", agentId: "486", wallet: REPORT.agent.agentWallet, name: "ledger-bot", score: 412, parts: { work: 210 }, pulled: 0, flags: [], sources: ["factor-desk"], factorOwn: false, rank: 3, lastAt: null };

let claimed: Record<string, unknown> | null = null;
let sealedAt = Math.floor(Date.now() / 1000);
beforeEach(() => {
  claimed = null;
  sealedAt = Math.floor(Date.now() / 1000);
  s.site.reports = async (method, path, body) => {
    if (method === "POST" && path === "/reports/claim") { claimed = body; return { status: 200, body: { ok: true, subject: "8004:486", by: body?.by } }; }
    if (path === "/reports") return { status: 200, body: { enabled: true, signer: SIGNER.address.toLowerCase() } };
    if (path === "/reports/agent/486" || path === `/reports/agent/${REPORT.agent.agentWallet}`) return { status: 200, body: REPORT };
    if (path.startsWith("/reports/top")) return { status: 200, body: { enabled: true, total: 418, items: [ROW] } };
    if (path.startsWith("/reports/find?q=")) return { status: 200, body: { enabled: true, items: decodeURIComponent(path.slice(16)).includes("ledger") ? [ROW] : [] } };
    if (path === "/reports/signed/486") {
      const answer = JSON.stringify({ v: 1, kind: "factor.report", version: "factor-report/1.0.0", agent: { agentId: "486" }, score: 412, issuedAt: sealedAt, expiresAt: sealedAt + 600 });
      return { status: 200, body: { answer, signature: await SIGNER.signMessage({ message: answer }), signer: SIGNER.address.toLowerCase(), scheme: "eip191" } };
    }
    return { status: 404, body: { error: "no agent by that number, wallet or name" } };
  };
});

describe("reading", () => {
  it("a report through Factor's site, said in the engine's own words", async () => {
    const r = await creditReport("486", { api: s.api });
    expect(r).toMatchObject({ score: 412, rank: 3, agent: { agentId: "486" } });
    const t = reportText(r);
    expect(t).toBe(engineReportText(r as unknown as ReportJson));
    expect(t).toContain("ledger-bot (ERC-8004 #486): 412 of 1000 on its Factor credit report, 3rd of 418 agents scored on Robinhood Chain");
    expect(t).toContain("It moves no money.");
    expect(t).not.toContain(String.fromCharCode(0x2014));
  });

  it("the leaderboard and the look-up; a bad id is refused before anything is asked", async () => {
    expect((await creditLeaderboard({ api: s.api, limit: 5 })).items[0].name).toBe("ledger-bot");
    expect(await findAgent("ledg", { api: s.api })).toHaveLength(0);
    expect(await findAgent("ledger", { api: s.api })).toHaveLength(1);
    expect(() => creditReport("<script>", { api: s.api })).toThrow(/ERC-8004 number/);
    await expect(creditReport("999", { api: s.api })).rejects.toThrow(/no agent by that number/i);
  });

  it("the signed answer, checked against Factor's signer, and refused from anyone else or once it has run out", async () => {
    const got = await signedReport("486", { api: s.api });
    expect(got.data).toMatchObject({ kind: "factor.report", score: 412 });
    await expect(signedReport("486", { api: s.api, signer: ME })).rejects.toThrow(/not signed by Factor/);
    sealedAt = Math.floor(Date.now() / 1000) - 3600;
    await expect(signedReport("486", { api: s.api })).rejects.toThrow(/run out/);
  });
});

describe("Ask Factor", () => {
  it("says each agent's chain-wide credit score beside its reasons, with the link", () => {
    const asked = { v: 1, written: "plain", model: null, cached: false, job: { title: "A price sheet", brief: "", priceEth: "0.002", dueHours: 24, dueAt: "2026-11-11T09:00:00.000Z", cover: false, stages: null, missing: [] }, price: { basis: "desk", similar: 0, lowEth: null, highEth: null, medianEth: null, budgetEth: null, said: "" }, deadline: { from: "default", said: "" }, notes: [],
      agents: [{ kind: "agent", name: "ledger-bot", address: REPORT.agent.agentWallet, does: "", score: 40, settled: 6, house: false, priceEth: "0.002", coverEth: null, reasons: ["6 jobs paid."], hire: "https://factoragents.fun/pay?agent=ledger-bot", report: { score: 412, rank: 3, url: "https://factoragents.fun/reports/486" } }] } as unknown as Asked;
    expect(askedText(asked)).toContain("Credit report on the chain: 412 of 1000, 3 of every agent scored. https://factoragents.fun/reports/486");
  });
});

describe("claiming", () => {
  it("signs the same words the engine checks, and sends the profile", async () => {
    const f = await Factor.connect({ privateKey: KEY, api: s.api, rpcUrl: s.rpc });
    const c = await f.claimReport({ agent: "486", name: "Ledger Bot", about: "Reads  ledgers.", site: "https://ledger.example", x: "@ledgerbot" });
    expect(c).toMatchObject({ ok: true, subject: "8004:486", by: ME });
    const b = claimed!;
    expect(b).toMatchObject({ agent: "486", by: ME, name: "Ledger Bot", about: "Reads ledgers.", site: "https://ledger.example", x: "ledgerbot" });
    const words = claimMessage({ subject: "8004:486", by: ME, name: "Ledger Bot", about: "Reads ledgers.", site: "https://ledger.example", x: "ledgerbot", at: b.at as number });
    expect(words).toBe(engineClaimMessage({ subject: "8004:486", by: ME, name: "Ledger Bot", about: "Reads ledgers.", site: "https://ledger.example", x: "ledgerbot", at: b.at as number }));
    expect((await recoverMessageAddress({ message: words, signature: b.signature as Hex })).toLowerCase()).toBe(ME);
  });
});

describe("the tools", () => {
  it("four of them: three reads an assistant can use with no key, and the owner's claim", async () => {
    const names = ["factor_credit_report", "factor_credit_leaderboard", "factor_find_agent", "factor_claim_report"];
    const mine = TOOLS.filter((t) => names.includes(t.name));
    expect(mine.map((t) => [t.name, t.readOnly])).toEqual([["factor_credit_report", true], ["factor_credit_leaderboard", true], ["factor_find_agent", true], ["factor_claim_report", false]]);
    for (const t of mine) expect(t.description, t.name).not.toContain(String.fromCharCode(0x2014));
    const f = await Factor.connect({ api: s.api, rpcUrl: s.rpc });
    const report = await runTool(f, "factor_credit_report", { agent: "486" }, null);
    expect(report.isError).toBe(false);
    expect(report.text).toContain("412 of 1000");
    expect((await runTool(f, "factor_credit_leaderboard", {}, null)).text).toContain("418 agents on Robinhood Chain have a credit score above 0");
    expect((await runTool(f, "factor_find_agent", { q: "ledger" }, null)).text).toContain(`${s.api}/reports/486`);
    expect((await runTool(f, "factor_find_agent", { q: "nobody" }, null)).text).toMatch(/No agent on Robinhood Chain matches/);
    const noKey = await runTool(f, "factor_claim_report", { agent: "486", name: "Mine" }, null);
    expect(noKey.isError).toBe(true);
  });
});
