// The sample's vouches, in exactly the engine's shape (engine/src/vouching.ts), so the vouching pages can be built, looked
// at and tested with no chain behind them. Nothing here is real. Shown only when FACTOR_SAMPLE=1 (see data.ts).
//
// lumen-07 co-signs orbit-ops's credit line (standing); orbit-ops co-signed the cover on lumen-07's job 0412, which was
// delivered (kept); page-smith, one of Factor's own, co-signs orbit-ops's line too (shown, not counted); plain-reader,
// also Factor's own, has an offer to orbit-ops waiting.
import { sampleBits, sampleLine } from "./sample";
import type { AgentPage, AgentVouching, Vouch, Voucher, VouchingAbout, VouchList } from "./types";

const { TX, at, later, addressOf, find } = sampleBits;

const LUMEN = addressOf("lumen-07"), ORBIT = addressOf("orbit-ops"), PAGE = addressOf("page-smith"), PLAIN = addressOf("plain-reader");
const LINE = sampleLine("orbit-ops")!;
const scoreOf = (a: string): number => find(a)?.score ?? 0;

const base = (id: number, voucher: string, vName: string, kind: "line" | "cover", amountEth: number, offeredMin: number): Vouch => ({
  id, kind, state: "active", voucher, voucherName: vName, voucherNamed: true,
  agent: kind === "line" ? LINE.account : LUMEN, agentName: kind === "line" ? "orbit-ops" : "lumen-07", agentNamed: true, agentKey: kind === "line" ? ORBIT : null,
  amountEth, amountWei: String(BigInt(Math.round(amountEth * 1e6)) * 10n ** 12n), feeEth: +(amountEth * 0.02).toFixed(6), feeWei: String(BigInt(Math.round(amountEth * 2e4)) * 10n ** 12n),
  offeredAt: at(offeredMin), expiresAt: later(7 * 1440 - offeredMin), tx: TX(1200 + id), ties: [], factorOwn: false, counts: true,
});

const vouches: Vouch[] = [
  // offered: plain-reader to orbit-ops's line, waiting for its key
  { ...base(4, PLAIN, "plain-reader", "line", 0.005, 40), state: "offered", line: { account: LINE.account, owesEth: LINE.debtEth, dueAt: LINE.dueAt, late: false, defaulted: false, owedAtOfferEth: LINE.debtEth }, next: { what: "accept", at: later(7 * 1440 - 40) }, factorOwn: true, counts: false },
  // standing: page-smith, Factor's own, on orbit-ops's line
  { ...base(3, PAGE, "page-smith", "line", 0.01, 1500), startedAt: at(1480), acceptedTx: TX(1303), endsAt: later(30 * 1440 - 1480), line: { account: LINE.account, owesEth: LINE.debtEth, dueAt: LINE.dueAt, late: false, defaulted: false, owedAtOfferEth: 0.006 }, next: { what: "ends", at: later(30 * 1440 - 1480) }, factorOwn: true, counts: false },
  // standing: lumen-07 on orbit-ops's line
  { ...base(2, LUMEN, "lumen-07", "line", 0.02, 2900), startedAt: at(2880), acceptedTx: TX(1302), endsAt: later(30 * 1440 - 2880), line: { account: LINE.account, owesEth: LINE.debtEth, dueAt: LINE.dueAt, late: false, defaulted: false, owedAtOfferEth: 0.006 }, next: { what: "ends", at: later(30 * 1440 - 2880) } },
  // kept: orbit-ops co-signed the cover on lumen-07's job 0412, which was delivered
  { ...base(1, ORBIT, "orbit-ops", "cover", 0.01, 125), state: "kept", startedAt: at(120), acceptedTx: TX(1301), cover: { id: 2, job: "0412", customer: sampleBits.A(5), priceEth: 0.04, coverEth: 0.02, state: "released" }, endedTx: TX(1401), endedAt: at(29), toVoucherEth: 0.0001, burnedEth: 0.0001, paidEth: 0, paidTo: null, feeBackEth: 0 },
];

const voucher = (address: string, name: string, bondEth: number, mine: Vouch[], factorOwn: boolean): Voucher => {
  const open = mine.filter((v) => v.state === "offered" || v.state === "active");
  const held = +open.reduce((n, v) => n + v.amountEth, 0).toFixed(6);
  const earned = +mine.reduce((n, v) => n + (v.toVoucherEth ?? 0), 0).toFixed(6);
  return {
    voucher: address, name, named: true, factorOwn, bondEth, heldEth: held, freeEth: +(bondEth - held).toFixed(6), freeWei: String(BigInt(Math.round((bondEth - held) * 1e6)) * 10n ** 12n), perAgentEth: +(bondEth / 4).toFixed(6),
    score: scoreOf(address), strong: scoreOf(address) >= 300,
    vouches: mine.filter((v) => v.startedAt).length, kept: mine.filter((v) => v.state === "kept").length, failed: mine.filter((v) => v.state === "failed").length, returned: 0, standing: mine.filter((v) => v.state === "active").length,
    vouchedEth: +mine.filter((v) => v.startedAt).reduce((n, v) => n + v.amountEth, 0).toFixed(6), lostEth: 0, earnedEth: earned,
  };
};
const VOUCHERS: Voucher[] = [
  voucher(LUMEN, "lumen-07", 0.08, vouches.filter((v) => v.voucher === LUMEN), false),
  voucher(ORBIT, "orbit-ops", 0.04, vouches.filter((v) => v.voucher === ORBIT), false),
  voucher(PAGE, "page-smith", 0.04, vouches.filter((v) => v.voucher === PAGE), true),
  voucher(PLAIN, "plain-reader", 0.02, vouches.filter((v) => v.voucher === PLAIN), true),
];

export function sampleVouchingAbout(): VouchingAbout {
  const started = vouches.filter((v) => v.startedAt);
  return {
    enabled: true, contract: null, chainId: 4663,
    rules: { minScore: 300, maxSharePct: 25, feePct: 2, voucherPctOfFee: 50, minVouchEth: 0.0001, lineTermDays: 30, offerDays: 7 },
    totals: { bondsEth: 0.18, heldEth: 0.035, vouchedEth: +started.reduce((n, v) => n + v.amountEth, 0).toFixed(6), paidEth: 0, earnedEth: 0.0001, burnedEth: 0.0001, vouches: vouches.length, standing: vouches.filter((v) => v.state === "active").length },
  };
}

export function sampleVouchList(o: { state?: string } = {}): VouchList {
  return { ...sampleVouchingAbout(), vouchers: VOUCHERS.filter((x) => !x.factorOwn), factorOwn: VOUCHERS.filter((x) => x.factorOwn), items: vouches.filter((v) => !o.state || v.state === o.state) };
}

export const sampleVouch = (id: number): Vouch | null => vouches.find((v) => v.id === id) ?? null;

/** An agent's vouches, received and given, as its page has them. */
export function sampleAgentVouching(address: string): AgentVouching | null {
  const agent = address === ORBIT ? LINE.account : address;
  const received = vouches.filter((v) => v.agent === agent && v.state !== "withdrawn");
  const mine = VOUCHERS.find((x) => x.voucher === address);
  const asVoucher = mine ? { ...mine, items: vouches.filter((v) => v.voucher === address) } : null;
  if (!received.length && !asVoucher) return null;
  const counted = received.filter((v) => v.counts);
  return {
    agent, received,
    standing: counted.filter((v) => v.state === "active").length,
    backedEth: +counted.filter((v) => v.state === "active").reduce((n, v) => n + v.amountEth, 0).toFixed(6),
    kept: counted.filter((v) => v.state === "kept").length, failed: counted.filter((v) => v.state === "failed").length,
    notCounted: received.length - counted.length, voucher: asVoucher,
  };
}

export const sampleVoucher = (address: string): Voucher | null => ((m) => (m ? { ...m, items: vouches.filter((v) => v.voucher === m.voucher) } : null))(VOUCHERS.find((x) => x.voucher === address.toLowerCase() || x.name === address.toLowerCase()));

/** The vouches on one cover. */
export const sampleCoverVouches = (cover: number): Vouch[] => vouches.filter((v) => v.kind === "cover" && v.cover?.id === cover);

/** An agent's page with what vouching adds to it. */
export function withVouching(page: AgentPage | null): AgentPage | null {
  if (!page) return page;
  const v = sampleAgentVouching(page.agent.address);
  return v ? { ...page, vouching: v } : page;
}

/** The sample's whole state, with vouching on. */
export function withVouchingState<T extends { vouching?: VouchingAbout }>(s: T): T {
  return { ...s, vouching: sampleVouchingAbout() };
}

/** A job's page with the vouches on its cover. */
export function withCoverVouches<T extends { cover?: { id: number; vouches?: Vouch[] } } | null>(page: T): T {
  if (!page || !page.cover) return page;
  const v = sampleCoverVouches(page.cover.id);
  return v.length ? { ...page, cover: { ...page.cover, vouches: v } } : page;
}
