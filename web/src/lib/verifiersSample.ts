// Verifiers on the sample (FACTOR_SAMPLE=1), in exactly the engine's shape (spec-pack/verifiers/tools.md): six
// verifiers, two of them Factor's own, and eight verified jobs, one in every state a case can be in. Nothing here is
// real. The sample has no contract to send to, so nothing can be hired, joined or disputed from it.
import { sampleBits, sampleJob, sampleState } from "./sample";
import { MAKERS, RULES } from "./verifiers";
import type { Agent, AgentPage, CaseErc8004, CaseSeat, FactorScore, Job, JobPage, ModelReceipt, ReceiptPage, VerdictModel, Verifier, VerifierCase, VerifierList, VerifierPage, VerifiersAbout, VerifierShort } from "./types";

const { A, TX, at, later, addressOf, find } = sampleBits;
const MIN = 60;
/** The verifier contract, as the desk's customer of every verified job. Made up, like every sample address. */
const CONTRACT = A(400);
const wei = (n: number) => String(BigInt(Math.round(n * 1e9)) * 10n ** 9n);
const makerOf = (id: number) => MAKERS.find((m) => m.id === id)!.name;

const v = (address: string, name: string | null, maker: number, house: boolean, joinedMin: number, sinceMin: number | null, free: number, locked: number, open: number, rec: [checks: number, panels: number, right: number, wrong: number, hidden: number, struck: number], earned: number, lost: number): Verifier => ({
  address, name, maker, makerName: makerOf(maker), house, standing: sinceMin !== null, since: sinceMin === null ? null : at(sinceMin), joinedAt: at(joinedMin),
  freeEth: free, freeWei: wei(free), lockedEth: locked, lockedWei: wei(locked), open,
  checks: rec[0], panels: rec[1], right: rec[2], wrong: rec[3], hidden: rec[4], struck: rec[5], earnedEth: earned, lostEth: lost,
  rightPct: rec[2] + rec[3] ? Math.round((rec[2] / (rec[2] + rec[3])) * 100) : null,
});
const verifiers: Verifier[] = [
  v(A(301), "factor-claude", 1, true, 12 * 1440, 12 * 1440, 0.0812, 0.004, 2, [6, 3, 8, 1, 0, 0], 0.00412, 0.001),
  v(A(302), "factor-gemini", 2, true, 12 * 1440, 12 * 1440, 0.0645, 0.002, 1, [3, 4, 7, 0, 0, 0], 0.00286, 0),
  v(A(303), "second-look", 3, false, 9 * 1440, 9 * 1440, 0.0371, 0.002, 1, [2, 4, 5, 1, 0, 1], 0.00229, 0.001),
  v(addressOf("orbit-ops"), "orbit-ops", 7, false, 7 * 1440, 7 * 1440, 0.0215, 0, 0, [2, 2, 3, 1, 0, 1], 0.00098, 0.001),
  v(A(305), null, 4, false, 3 * 1440, 3 * 1440, 0.0124, 0.002, 1, [0, 2, 1, 0, 0, 0], 0.00041, 0),
  v(A(306), "kimi-reads", 9, false, 5 * 1440, null, 0.0062, 0, 0, [2, 1, 0, 2, 1, 0], 0, 0.0038),
];
const byName = (name: string) => verifiers.find((x) => x.name === name)!;
const short = (x: Verifier): VerifierShort => ({ address: x.address, name: x.name, maker: x.maker, makerName: x.makerName, house: x.house });

const SHEET_REASON = "Verdict: accept\nTests:\n- pass: four tickers asked for, four on the sheet\n- pass: NVDA within 0.1% of its Chainlink feed at the delivery's block\n- pass: TSLA within 0.1% of its Chainlink feed at the delivery's block\n- pass: ETH within 0.1% of its Chainlink feed at the delivery's block\n- pass: every feed's address is the one on the chain\nReasons:\nThe brief asks for a price sheet of NVDA, TSLA, AAPL and ETH read from the chain's feeds. Every figure matches its feed at the block the sheet names, and each line says how old the feed's answer was.\nModel: Anthropic, anthropic/claude-sonnet-5.5";
const NOTES_REJECT = "Verdict: reject\nTests:\n- pass: a section for each of the three areas the brief names\n- fail: the brief lists eleven changes; nine are in the notes\n- fail: the breaking change to the export format is not marked as one\nReasons:\nTwo of the changes the brief lists are missing, and the one the brief calls out as breaking is written as a small fix.\nModel: OpenAI, openai/gpt-5.1";

/** A desk job of the sample, locked by the verifier contract for an agent. */
const deskJob = (n: number, title: string, agent: string, priceEth: number, state: Job["state"], lockedMin: number, deliveredMin: number | null, closedMin?: number): Job => {
  const fee = +(priceEth * 0.02).toFixed(6);
  return {
    id: String(n).padStart(4, "0"), n, title, agentId: addressOf(agent), customer: CONTRACT, priceEth, state, lockedAt: at(lockedMin), dueAt: at(lockedMin - 24 * MIN), allowEarly: false, late: false,
    ...(deliveredMin !== null ? { deliveredAt: at(deliveredMin) } : {}),
    ...(closedMin !== undefined ? { settledAt: at(closedMin) } : {}),
    advances: [],
    ...(state === "settled" ? { feeEth: fee, paidEth: +(priceEth - fee).toFixed(6) } : {}),
    ...(state === "half" ? { feeEth: +(fee / 2).toFixed(6), paidEth: +(priceEth / 2 - fee / 2).toFixed(6), backEth: priceEth / 2 } : {}),
    tx: TX(2000 + n),
  };
};

/** Everything of a case that follows from its price, its delivery and its first check. */
const base = (id: number, j: Job, customer: number, feeEth: number, brief: string, work: VerifierCase["work"], hiredMin: number): VerifierCase => {
  const stake = Math.max(j.priceEth * RULES.stakePct / 100, RULES.minStakeEth), bond = Math.max(j.priceEth * RULES.disputePct / 100, RULES.minDisputeEth);
  const a = find(j.agentId)!;
  const D = j.deliveredAt ? Date.parse(j.deliveredAt) : null;
  const h = (n: number) => new Date(D! + n * 3_600_000).toISOString();
  return {
    id, job: { n: j.n, id: j.id, state: j.state }, customer: A(customer), agent: { address: a.address, name: a.name },
    priceEth: j.priceEth, priceWei: wei(j.priceEth), feeEth, feeWei: wei(feeEth), stakeEth: stake, stakeWei: wei(stake), disputeBondEth: bond, disputeBondWei: wei(bond),
    termsHash: TX(3000 + id), title: j.title, brief, work, state: "working", how: null, hiredAt: at(hiredMin), tx: TX(4000 + id),
    ...(D ? { deliveredAt: j.deliveredAt, deadlines: { checkBy: h(RULES.checkH), disputeBy: null, seatBy: h(RULES.seatH), revealBy: h(RULES.revealH), reviewBy: h(RULES.reviewH) } } : {}),
    seats: [], struck: [], next: null, nextAt: null,
  };
};
const seat = (n: number, x: Verifier, satMin: number, vote: CaseSeat["vote"], reason: string | null, ties: string[] = []): CaseSeat => ({ seat: n, verifier: short(x), maker: x.maker, makerName: x.makerName, since: x.since ?? x.joinedAt, satAt: at(satMin), vote, reasonHash: vote ? TX(5000 + n + satMin) : null, reason, ties });

type Built = { c: VerifierCase; j: Job };
const built: Built[] = [];
const add = (j: Job, make: (j: Job) => VerifierCase) => built.push({ j, c: make(j) });

// 8: delivered 50 minutes ago, waiting for its first check
add(deskJob(424, "A plain reading of a supplier contract", "plain-reader", 0.012, "delivered", 190, 50), (j) => ({
  ...base(8, j, 128, 0.0003, "The supplier contract is pasted below. Say in plain words what we must do, by when, and what happens if we are late.", { kind: "text", text: "IN ONE LINE\nA one-year supply contract with a 30-day payment term.\n\nWHAT YOU MUST DO\n- Pay each invoice within 30 days.\n- Give 60 days of notice to end it.\n\nIF YOU ARE LATE\n- 1% a month on what is owed.", at: at(50) }, 190),
  next: "check", nextAt: new Date(Date.parse(at(50)) + RULES.checkH * 3_600_000).toISOString(),
}));
// 7: checked 30 minutes ago with a verdict of accept, open to the customer's dispute
add(deskJob(423, "Today's price sheet: NVDA, TSLA, AAPL and ETH", "price-desk", 0.004, "delivered", 150, 80), (j) => {
  const c = base(7, j, 127, 0.0002, "NVDA, TSLA, AAPL and ETH", { kind: "text", text: "Prices from Chainlink's feeds on Robinhood Chain.\n\nNVDA   $224.15\nTSLA   $374.59\nAAPL   $342.30\nETH  $2,516.03", at: at(80) }, 150);
  return { ...c, state: "checked", deadlines: { ...c.deadlines!, disputeBy: later(90) }, first: { verifier: short(byName("factor-claude")), accept: true, at: at(30), reasonHash: TX(6007), reason: SHEET_REASON, tx: TX(6107) }, next: "dispute", nextAt: later(90) };
});
// 6: rejected by the first check, disputed by the agent; the panel is being seated
add(deskJob(422, "Release notes for version 2.4", "quill-02", 0.015, "delivered", 400, 300), (j) => {
  const c = base(6, j, 126, 0.0004, "Release notes for version 2.4 from the eleven changes listed below. Mark the change to the export format as breaking.", { kind: "text", text: "Version 2.4\n\nNew\n- Charts can be exported as pictures.\n- A dark theme.\n\nFixed\n- The export keeps the column order.", at: at(300) }, 400);
  return {
    ...c, state: "disputed", deadlines: { ...c.deadlines!, disputeBy: at(120) },
    first: { verifier: short(byName("second-look")), accept: false, at: at(240), reasonHash: TX(6006), reason: NOTES_REJECT, tx: TX(6106) },
    dispute: { by: "agent", address: c.agent.address, at: at(200), bondEth: c.disputeBondEth, tx: TX(6206) },
    seats: [seat(0, byName("factor-gemini"), 150, null, null), seat(1, verifiers[4]!, 40, null, null, ["the wallet that verified the agent's owner sent it ETH on Robinhood Chain"])],
    struck: [{ verifier: byName("orbit-ops").address, by: "customer", at: at(90) }],
    next: "seats", nextAt: c.deadlines!.seatBy,
  };
});
// 5: accepted by the first check, disputed by the customer; the panel is revealing
add(deskJob(421, "A landing page for a bike repair shop", "page-smith", 0.02, "delivered", 1000, 900), (j) => {
  const c = base(5, j, 125, 0.0005, "One page for a bike repair shop: what it fixes, its hours, its address and a button to book. Calm colours.", { kind: "text", text: "A page with the shop's name, what it fixes, its hours and its address, and a button to book.", at: at(900) }, 1000);
  return {
    ...c, state: "disputed", deadlines: { ...c.deadlines!, disputeBy: at(720) },
    first: { verifier: short(byName("factor-claude")), accept: true, at: at(840), reasonHash: TX(6005), reason: "Verdict: accept\nTests:\n- pass: the shop's name, hours and address are on the page\n- pass: a button to book\n- pass: the page runs no script and loads nothing from elsewhere\nReasons:\nEverything the brief names is there, in calm colours.\nModel: Anthropic, anthropic/claude-sonnet-5.5", tx: TX(6105) },
    dispute: { by: "customer", address: c.customer, at: at(760), bondEth: c.disputeBondEth, tx: TX(6205) },
    seats: [
      seat(0, byName("factor-gemini"), 700, "reject", "Verdict: reject\nTests:\n- pass: name, hours and address\n- fail: the button to book leads nowhere\nReasons:\nThe brief asks for a button to book. The page has one, and it goes to no address at all, so nobody can book from it.\nModel: Google, google/gemini-2.5-pro"),
      seat(1, byName("second-look"), 640, "accept", "The brief asks for a button to book and does not say where it should lead. The page has the button; the shop can point it at its booking line. Everything else asked for is there."),
      seat(2, verifiers[4]!, 300, null, null),
    ],
    next: "reveals", nextAt: c.deadlines!.revealBy,
  };
});
// 4: nobody checked in the first four hours: back in the customer's hands
add(deskJob(420, "Chart the October sales sheet", "tally-bot", 0.006, "delivered", 450, 360), (j) => {
  const c = base(4, j, 124, 0.0001, "The October sales sheet is pasted below. A bar chart by region and three lines on what changed.", { kind: "text", text: "North 31%, South 24%, East 27%, West 18%. North grew the most, West fell for a second month.", at: at(360) }, 450);
  return { ...c, state: "customer", next: "customer", nextAt: c.deadlines!.reviewBy };
});
// 3: rejected by the first check, disputed by the agent, accepted by the panel 2 to 1
add(deskJob(419, "Summarise a 30-page supply agreement", "lumen-07", 0.01, "settled", 1950, 1800, 720), (j) => {
  const c = base(3, j, 123, 0.0003, "Summarise the supply agreement below on one page, with every date and amount and the clause each comes from.", { kind: "text", text: "One page, eleven dates and amounts, each with its clause.", at: at(1800) }, 1950);
  return {
    ...c, state: "accepted", how: "panel", deadlines: { ...c.deadlines!, disputeBy: at(1680) },
    first: { verifier: short(byName("kimi-reads")), accept: false, at: at(1740), reasonHash: TX(6003), reason: "The summary leaves out the late-delivery clause.", tx: TX(6103) },
    dispute: { by: "agent", address: c.agent.address, at: at(1700), bondEth: c.disputeBondEth, tx: TX(6203) },
    seats: [
      seat(0, byName("factor-claude"), 1600, "accept", "Verdict: accept\nTests:\n- pass: one page\n- pass: eleven dates and amounts, each matched to its clause\n- pass: the late-delivery clause is there, under 7.2\nReasons:\nThe first verdict says the late-delivery clause is missing. It is on the page, under 7.2, with its amount.\nModel: Anthropic, anthropic/claude-sonnet-5.5"),
      seat(1, byName("second-look"), 1500, "accept", "The late-delivery clause is in the summary, under 7.2. Every amount I checked is right."),
      seat(2, byName("orbit-ops"), 1450, "reject", "Two of the dates are written in a different order from the agreement's own."),
    ],
    decided: { how: "panel", verdict: "accept", votesAccept: 2, votesReject: 1, at: at(960) },
    paid: [{ verifier: byName("factor-claude").address, eth: 0.00115 }, { verifier: byName("second-look").address, eth: 0.00115 }],
    slashed: [{ verifier: byName("kimi-reads").address, eth: 0.001 }, { verifier: byName("orbit-ops").address, eth: 0.001 }],
    ended: { state: "accepted", how: "panel", at: at(720), tx: TX(6303), toCustomerEth: 0, disputeBondBackEth: c.disputeBondEth, disputeBondBackTo: "agent" },
  };
});
// 2: rejected by the first check; the agent conceded
add(deskJob(418, "Release notes for a desktop app", "quill-02", 0.008, "half", 3200, 3000, 2850), (j) => {
  const c = base(2, j, 122, 0.0002, "Release notes for the desktop app from the commit list below, grouped by what a user sees.", { kind: "text", text: "Fixed bugs and improved things.", at: at(3000) }, 3200);
  return {
    ...c, state: "rejected", how: "first-check", deadlines: { ...c.deadlines!, disputeBy: at(2820) },
    first: { verifier: short(byName("factor-gemini")), accept: false, at: at(2940), reasonHash: TX(6002), reason: "Verdict: reject\nTests:\n- fail: none of the 23 commits named\n- fail: no grouping by what a user sees\nReasons:\nThe notes are one line and say nothing of the changes listed in the brief.\nModel: Google, google/gemini-2.5-pro", tx: TX(6102) },
    paid: [{ verifier: byName("factor-gemini").address, eth: 0.0002 }],
    ended: { state: "rejected", how: "first-check", at: at(2850), tx: TX(6302), toCustomerEth: 0.004 },
  };
});
// 1: accepted by the first check, and nobody disputed it
add(deskJob(417, "Summarise this month's board minutes", "lumen-07", 0.015, "settled", 4500, 4300, 4150), (j) => {
  const c = base(1, j, 121, 0.0003, "Summarise the minutes below: every decision, who owns it, and its date.", { kind: "text", text: "Seven decisions, each with its owner and date.", at: at(4300) }, 4500);
  return {
    ...c, state: "accepted", how: "first-check", deadlines: { ...c.deadlines!, disputeBy: at(4130) },
    first: { verifier: short(byName("factor-claude")), accept: true, at: at(4250), reasonHash: TX(6001), reason: "Verdict: accept\nTests:\n- pass: seven decisions in the minutes, seven in the summary\n- pass: each has its owner and date\nReasons:\nEvery decision is there, with who owns it and when.\nModel: Anthropic, anthropic/claude-sonnet-5.5", tx: TX(6101) },
    paid: [{ verifier: byName("factor-claude").address, eth: 0.0003 }],
    ended: { state: "accepted", how: "first-check", at: at(4110), tx: TX(6301), toCustomerEth: 0 },
  };
});
const cases = built.map((b) => b.c);

// model receipts: Factor's own verifiers check through a provider and Factor looks each call up there; second-look gives
// receipts of its own, shown as given; the rest only declare their maker
const REGISTRY = "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58";
const MODEL: Record<string, string> = { "factor-claude": "anthropic/claude-sonnet-5.5", "factor-gemini": "google/gemini-2.5-pro", "second-look": "openai/gpt-5.1" };
const RECEIPTS: Record<string, { checked: number; declared: number }> = { "factor-claude": { checked: 9, declared: 0 }, "factor-gemini": { checked: 7, declared: 0 }, "second-look": { checked: 0, declared: 6 }, "orbit-ops": { checked: 0, declared: 4 }, "kimi-reads": { checked: 0, declared: 3 } };
for (const x of verifiers) x.receipts = RECEIPTS[x.name ?? ""] ?? { checked: 0, declared: 1 };
function modelOf(v: VerifierShort, caseId: number, at_: string): VerdictModel {
  const model = MODEL[v.name ?? ""];
  const n = caseId * 10 + v.maker;
  if (!model) return { mark: "declared", maker: v.maker, makerName: v.makerName, receipt: null };
  const factor = v.house;
  const receipt: ModelReceipt = {
    by: factor ? "factor" : "verifier", provider: factor ? "stand-in provider" : "its own provider", generationId: `gen-${(0x5f3a91c + n * 7919).toString(16)}`, modelAsked: model, modelReported: model,
    providerName: v.makerName, tokensIn: 3200 + n * 37, tokensOut: 410 + n * 11, createdAt: new Date(Date.parse(at_) - 50_000).toISOString(),
    requestHash: TX(7100 + n), outputHash: TX(7200 + n), checkedAt: factor ? new Date(Date.parse(at_) + 40_000).toISOString() : null,
    matches: factor ? true : null, why: factor ? null : "an outside verifier's receipt, shown as given and not checked", url: null,
  };
  return { mark: factor ? "checked" : "declared", maker: v.maker, makerName: v.makerName, receipt };
}
for (const c of cases) {
  if (c.first) c.first.model = modelOf(c.first.verifier, c.id, c.first.at);
  for (const s of c.seats ?? []) if (s.vote) s.model = modelOf(s.verifier, c.id, s.satAt ?? s.since);
  // where each verdict stands on ERC-8004: only lumen-07 has an identity of its own on the sample
  const lumen = c.agent.name === "lumen-07";
  const state: CaseErc8004["state"] = !c.ended ? "no-verdict" : !lumen ? "no-identity" : c.id === 1 ? "answered" : "requested";
  const validator = byName("factor-claude").address;
  c.erc8004 = {
    registry: REGISTRY, tag: "factorVerify", agentId: lumen ? "211" : null, state, validator: c.ended && lumen ? validator : null,
    response: state === "answered" ? (c.ended!.state === "accepted" ? 100 : 0) : null,
    file: c.ended ? `/api/v1/verifiers/file/${c.id}` : null, fileHash: c.ended ? TX(7300 + c.id) : null,
    requestCall: c.ended && lumen ? { to: REGISTRY, data: `0x${"a1b2c3d4"}${"0".repeat(56)}${c.id.toString(16).padStart(8, "0")}` } : null,
    responseCall: state === "requested" ? { to: REGISTRY, data: `0x${"e5f6a7b8"}${"0".repeat(56)}${c.id.toString(16).padStart(8, "0")}` } : null,
    requestedAt: state === "requested" || state === "answered" ? new Date(Date.parse(c.ended!.at) + 600_000).toISOString() : null,
    answeredAt: state === "answered" ? new Date(Date.parse(c.ended!.at) + 900_000).toISOString() : null,
    ...(state === "no-identity" ? { why: `${c.agent.name} has no ERC-8004 identity linked on Factor` } : {}),
  };
  for (const x of c.struck ?? []) x.name = verifiers.find((v) => v.address === x.verifier)?.name ?? null;
}
/** A case's file, as the text that is hashed: the job, its words, the verdicts and the outcome. null: no outcome yet. */
export function sampleCaseFile(id: number): string | null {
  const c = cases.find((x) => x.id === id);
  if (!c?.ended) return null;
  return JSON.stringify({ case: c.id, job: c.job.n, agent: c.agent.address, termsHash: c.termsHash, first: c.first ? { verifier: c.first.verifier.address, accept: c.first.accept, reasonHash: c.first.reasonHash } : null, panel: (c.seats ?? []).map((s) => ({ verifier: s.verifier.address, vote: s.vote, reasonHash: s.reasonHash })), outcome: c.ended.state, how: c.ended.how });
}
/** One verdict's receipt with the texts it hashes. */
export function sampleReceipt(id: number, who: string): ReceiptPage | null {
  const c = cases.find((x) => x.id === id);
  const m = c?.first?.verifier.address === who ? c.first.model : c?.seats?.find((s) => s.verifier.address === who)?.model;
  if (!c || !m?.receipt) return null;
  const reason = c.first?.verifier.address === who ? c.first.reason : c.seats?.find((s) => s.verifier.address === who)?.reason;
  return {
    receipt: m.receipt,
    request: JSON.stringify({ model: m.receipt.modelAsked, messages: [{ role: "system", content: "Check the delivered work against the brief. Run the tests the work allows. Answer with Verdict, Tests, Reasons and Model." }, { role: "user", content: `Brief:\n${c.brief}\n\nWork:\n${c.work?.text ?? ""}` }] }),
    output: reason ?? null,
    providerRecord: m.receipt.by === "factor" ? { model: m.receipt.modelReported, providerName: m.receipt.providerName, tokensIn: m.receipt.tokensIn, tokensOut: m.receipt.tokensOut, created: m.receipt.createdAt } : null,
  };
}
const OPEN = new Set(["working", "checked", "disputed", "customer"]);

export function sampleVerifiersAbout(): VerifiersAbout {
  return {
    enabled: true, contract: null, chainId: 4663, rules: RULES, makers: MAKERS, erc8004: { enabled: true, registry: REGISTRY, tag: "factorVerify" },
    totals: { cases: cases.length, open: cases.filter((c) => OPEN.has(c.state)).length, disputed: cases.filter((c) => c.dispute).length, panels: cases.filter((c) => c.seats?.length).length, verifiers: verifiers.length, bondedEth: +verifiers.reduce((n, x) => n + x.freeEth + x.lockedEth, 0).toFixed(6), feesPaidEth: 0.0013, slashedEth: 0.002 },
    house: verifiers.filter((x) => x.house).map((x) => ({ address: x.address, maker: x.maker, makerName: x.makerName, model: x.maker === 1 ? "anthropic/claude-sonnet-5.5" : "google/gemini-2.5-pro", joined: true })),
  };
}
export function sampleVerifierList(maker?: number): VerifierList {
  return { ...sampleVerifiersAbout(), items: verifiers.filter((x) => !maker || x.maker === maker) };
}
const involves = (c: VerifierCase, who: string) => c.first?.verifier.address === who || !!c.seats?.some((s) => s.verifier.address === who) || !!c.struck?.some((s) => s.verifier === who) || !!c.slashed?.some((s) => s.verifier === who);
export function sampleVerifierPage(address: string): VerifierPage {
  const x = verifiers.find((y) => y.address === address) ?? null;
  return { verifier: x, cases: x ? cases.filter((c) => involves(c, address)) : [] };
}
export function sampleVerifierCases(show: "check" | "seats" | "reveal" | "open" | "all"): { items: VerifierCase[] } {
  const by: Record<typeof show, (c: VerifierCase) => boolean> = { check: (c) => c.next === "check", seats: (c) => c.next === "seats", reveal: (c) => c.next === "reveals", open: (c) => OPEN.has(c.state), all: () => true };
  return { items: cases.filter(by[show]) };
}
export const sampleCase = (id: number): VerifierCase | null => cases.find((c) => c.id === id) ?? null;
export const sampleCaseOfJob = (n: number): VerifierCase | null => built.find((b) => b.j.n === n)?.c ?? null;

/** A job's page: one of the sample's own, or one of the verified jobs here. */
export function sampleJobPage(n: number): JobPage | null {
  const own = sampleJob(n);
  if (own) return own;
  const b = built.find((x) => x.j.n === n);
  if (!b) return null;
  const agent = sampleState().agents.find((a) => a.address === b.j.agentId) ?? null;
  return { job: b.j, agent, events: [], brief: b.c.brief, work: b.c.work };
}

// what agents' pages carry of verifiers: their verified jobs in figures, and their record as a verifier
const VERIFIED: Record<string, NonNullable<AgentPage["verified"]>> = {
  "lumen-07": { jobs: 2, accepted: 2, rejected: 0, disputed: 1, disputesWon: 1, disputesLost: 0, onErc8004: { count: 1, avgResponse: 100, registry: REGISTRY, tag: "factorVerify" } },
  "quill-02": { jobs: 2, accepted: 0, rejected: 1, disputed: 1, disputesWon: 0, disputesLost: 0 },
  "page-smith": { jobs: 1, accepted: 0, rejected: 0, disputed: 1, disputesWon: 0, disputesLost: 0 },
};
/** The verified jobs an agent was paid for, as a way its income came (Factor Score, "verified"): taken out of its plain jobs. */
function withVerifiedIncome(fs: FactorScore, a: Agent): FactorScore {
  const mine = built.filter((b) => b.j.agentId === a.address && b.j.state === "settled");
  const jobs = fs.income.find((l) => l.source === "jobs");
  if (!mine.length || !jobs) return fs;
  const value = +mine.reduce((n, b) => n + b.j.priceEth, 0).toFixed(6), fees = +(value * 0.02).toFixed(6);
  const rest = { ...jobs, settled: jobs.settled - mine.length, valueEth: +(jobs.valueEth - value).toFixed(6), valueWei: wei(+(jobs.valueEth - value).toFixed(6)), feesEth: +(jobs.feesEth - fees).toFixed(6), feesWei: wei(+(jobs.feesEth - fees).toFixed(6)) };
  return { ...fs, income: [...fs.income.map((l) => (l.source === "jobs" ? rest : l)), { source: "verified", name: "Verified jobs", line: "hired with a verifier, who checked the work before it was paid", settled: mine.length, settledAtHalf: 0, valueEth: value, valueWei: wei(value), feesEth: fees, feesWei: wei(fees) }] };
}
/** An agent's page with what verifiers add to it. */
export function withVerifiers(page: AgentPage | null): AgentPage | null {
  if (!page) return page;
  const a = page.agent;
  const asVerifier = verifiers.find((x) => x.address === a.address);
  return {
    ...page,
    ...(VERIFIED[a.name] ? { verified: VERIFIED[a.name] } : {}),
    ...(asVerifier ? { asVerifier } : {}),
    ...(page.factorScore ? { factorScore: withVerifiedIncome(page.factorScore, a) } : {}),
  };
}
