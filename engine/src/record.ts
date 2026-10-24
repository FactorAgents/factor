// An agent's public record: one answer another app can read and trust.
//
//   GET /v1/record/<address>   the record, worked out from the chain, and an attestation of it signed by Factor
//
// Everything in it comes from the desk: its own counters for the agent (FactorDesk.agent, read at the head whenever
// one of the agent's logs arrives) and the jobs locked for it (read from the desk's Locked logs). Nothing here is
// set by hand, and the same figures can be read from the chain by anyone: `agent(address)` on the desk holds them.
//
// The attestation is for an app that would rather not read the chain itself. It is EIP-712 typed data, signed by a
// key the engine derives for this alone (or RECORD_SIGNING_KEY), good for an hour. An app checks the signature with
// any EIP-712 library and compares the signer with the address Factor publishes (GET /v1/record/signer and the
// docs). The record field by field is described in docs/PAY-WITH-FACTOR.md.
//
// "hiring" (who hired the agent for part of a job of theirs, and whom it hired) is the engine's link between jobs
// (./subjobs.ts), not a figure of the desk's: it is outside the attestation. Each job behind it is on the desk, with
// the hirer as its customer. "plans" (its monthly clients, ./plans.ts) is the same kind of link, outside it too: each
// month behind it is a job on the desk, locked by the plan's customer.
//
// "factorScore" (./factorscore.ts) is the score with its parts, the income behind it by the way each job came, and what
// the desk lets the agent draw. Its number is the attested "score": the desk's own, FactorDesk.score(agent). The rest
// of it (the split by the way each job came, the words) is outside the attestation, like "hiring" and "plans".
//
// "erc8004" (./erc8004.ts) is the agent's ERC-8004 identity and the entries Factor wrote to its reputation, outside the
// attestation too: each entry is on Robinhood Chain in the standard's own registry, where any app reads it.
//
// "verifiedOwner" (./verified.ts) is the outcome of checking the agent's owner wallet with Human Passport and Talent
// Protocol: verified, by which, a band of each score and the date. Outside the attestation: it is not the desk's.

import { concat, formatEther, hashTypedData, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AgentRecord, AgentRow } from "./desk.js";
import { scoreOf } from "./score.js";
import type { FactorScoreJson } from "./factorscore.js";
import type { Erc8004Json } from "./erc8004.js";
import type { VerifiedJson } from "./verified.js";
import { takeHouseSeed } from "./house/house.js";
import type { EngineDb } from "./chain/db.js";

type Env = Record<string, string | undefined>;

export interface RecordSigner { address: string; signTypedData: (typed: ReturnType<typeof recordTypedData>) => Promise<Hex> }

/**
 * The key that signs attestations: RECORD_SIGNING_KEY when the owner set one, otherwise one derived from the house
 * agents' seed for this use alone, so no new secret has to be kept. null: no key at all, and no attestation.
 */
export function recordSigner(env: Env): RecordSigner | null {
  const own = env.RECORD_SIGNING_KEY?.trim();
  let key: Hex | null = null;
  if (own && /^(0x)?[0-9a-fA-F]{64}$/.test(own)) key = (own.startsWith("0x") ? own : `0x${own}`) as Hex;
  else {
    const seed = takeHouseSeed(env);
    if (seed) key = keccak256(concat([seed, toHex("factor record attestation")]));
  }
  if (!key) return null;
  const account = privateKeyToAccount(key);
  return { address: account.address.toLowerCase(), signTypedData: (typed) => account.signTypedData(typed as never) };
}

export const RECORD_TYPES = {
  Record: [
    { name: "agent", type: "address" },
    { name: "block", type: "uint64" },
    { name: "delivered", type: "uint32" },
    { name: "onTime", type: "uint32" },
    { name: "late", type: "uint32" },
    { name: "settled", type: "uint32" },
    { name: "settledAtHalf", type: "uint32" },
    { name: "refunded", type: "uint32" },
    { name: "advancesRepaid", type: "uint32" },
    { name: "advancesNotRepaid", type: "uint32" },
    { name: "customers", type: "uint32" },
    { name: "volume", type: "uint256" },
    { name: "score", type: "uint16" },
    { name: "barred", type: "bool" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export interface RecordMessage {
  agent: string; block: number; delivered: number; onTime: number; late: number; settled: number; settledAtHalf: number; refunded: number;
  advancesRepaid: number; advancesNotRepaid: number; customers: number; volume: string; score: number; barred: boolean; issuedAt: number; expiresAt: number;
}

/** What is signed: the record's figures, bound to Robinhood Chain and to the desk they were read from. */
export function recordTypedData(chainId: number, desk: string, m: RecordMessage) {
  return {
    domain: { name: "Factor Record", version: "1", chainId, verifyingContract: desk as Hex },
    types: RECORD_TYPES,
    primaryType: "Record" as const,
    message: { ...m, agent: m.agent as Hex, block: BigInt(m.block), volume: BigInt(m.volume), issuedAt: BigInt(m.issuedAt), expiresAt: BigInt(m.expiresAt) },
  };
}

/** The record, for the answer: counts as numbers, amounts as wei in text and as ETH to read. */
export interface RecordJson {
  version: 1;
  agent: string;
  name: string;
  named: boolean;
  does: string;
  chainId: number;
  desk: string;
  block: number;
  asOf: string;
  since: string;
  jobs: { locked: number; open: number; delivered: number; onTime: number; late: number; settled: number; settledAtHalf: number; declined: number; refunded: number; refundedAfterDrawing: number; unanswered: number };
  advances: { repaid: number; notRepaid: number; earlyKept: number };
  volumeWei: string;
  volumeEth: string;
  feesPaidWei: string;
  customers: number;
  distinctCustomers: number;
  score: number;
  barred: boolean;
  payWithFactor: { deals: number; burnedWei: string; burnedEth: string };
  /** agents that hire agents: who hired this agent for part of a job of theirs, and whom it hired, with how many jobs */
  hiring: { hiredBy: { address: string; name: string; jobs: number }[]; hires: { address: string; name: string; jobs: number }[] };
  /** monthly clients (./plans.ts): plans running now, their customers, the price a month of them added up, and the months delivered and settled */
  plans: { active: number; clients: number; monthlyWei: string; monthlyEth: string; monthsDelivered: number; monthsSettled: number };
  /** the Factor Score: the score above with its parts, the income behind it by the way each job came, and what the desk lets it draw */
  factorScore: FactorScoreJson | null;
  /** its ERC-8004 identity and the entries Factor wrote to its reputation; null when no identity is linked */
  erc8004: Erc8004Json | null;
  /** its owner is verified (./verified.ts): the outcome only, outside the attestation. Present while checking owners is on; null: not verified */
  verifiedOwner?: VerifiedJson | null;
  page: string;
  badge: string;
  attestation: { signer: string; signature: Hex; digest: Hex; message: RecordMessage; issuedAt: string; expiresAt: string } | null;
}

/** The jobs locked for one agent, counted by state from the engine's copy of the desk. */
function jobCounts(db: EngineDb, agent: string): { byState: Map<number, number>; distinct: number } {
  const rows = db.q("SELECT state, COUNT(*) AS n FROM desk_jobs WHERE agent = ? GROUP BY state").all(agent) as { state: number; n: number }[];
  const distinct = (db.q("SELECT COUNT(DISTINCT customer) AS n FROM desk_jobs WHERE agent = ? AND state IN (4, 5)").get(agent) as { n: number }).n;
  return { byState: new Map(rows.map((r) => [r.state, r.n])), distinct };
}

export async function recordOf(o: {
  db: EngineDb; row: AgentRow; name: string; named: boolean; does: string; chainId: number; desk: string; block: number; nowS: number; site: string;
  pay: { deals: number; burnedWei: bigint }; signer: RecordSigner | null;
  hiring?: { hiredBy: { address: string; name: string; jobs: number }[]; hires: { address: string; name: string; jobs: number }[] };
  plans?: { active: number; clients: number; monthlyWei: string; monthsDelivered: number; monthsSettled: number } | null;
  factorScore?: FactorScoreJson | null;
  erc8004?: Erc8004Json | null;
  verifiedOwner?: VerifiedJson | null;
}): Promise<RecordJson> {
  const r: AgentRecord = o.row.record;
  const { byState, distinct } = jobCounts(o.db, o.row.address);
  const n = (s: number) => byState.get(s) ?? 0;
  const locked = [...byState.values()].reduce((a, b) => a + b, 0);
  const delivered = r.settled + r.settledAtHalf + n(3);
  const refunded = r.notDelivered + r.unanswered;
  const score = scoreOf(r, o.nowS);
  const issuedAt = o.nowS, expiresAt = o.nowS + 3600;
  const message: RecordMessage = {
    agent: o.row.address, block: o.block, delivered, onTime: r.onTime, late: r.late, settled: r.settled, settledAtHalf: r.settledAtHalf, refunded,
    advancesRepaid: r.advancesRepaid, advancesNotRepaid: r.advancesNotRepaid, customers: r.customers, volume: r.volume, score, barred: r.barred, issuedAt, expiresAt,
  };
  let attestation: RecordJson["attestation"] = null;
  if (o.signer) {
    const typed = recordTypedData(o.chainId, o.desk, message);
    attestation = { signer: o.signer.address, signature: await o.signer.signTypedData(typed), digest: hashTypedData(typed as never), message, issuedAt: new Date(issuedAt * 1000).toISOString(), expiresAt: new Date(expiresAt * 1000).toISOString() };
  }
  const path = o.named ? o.name : o.row.address;
  return {
    version: 1, agent: o.row.address, name: o.name, named: o.named, does: o.does, chainId: o.chainId, desk: o.desk, block: o.block, asOf: new Date(o.nowS * 1000).toISOString(), since: new Date(o.row.registered_at * 1000).toISOString(),
    jobs: { locked, open: n(1) + n(2) + n(3), delivered, onTime: r.onTime, late: r.late, settled: r.settled, settledAtHalf: r.settledAtHalf, declined: n(6), refunded, refundedAfterDrawing: r.notDelivered, unanswered: r.unanswered },
    advances: { repaid: r.advancesRepaid, notRepaid: r.advancesNotRepaid, earlyKept: r.earlyKept },
    volumeWei: r.volume, volumeEth: formatEther(BigInt(r.volume)), feesPaidWei: r.feesPaid,
    customers: r.customers, distinctCustomers: distinct, score, barred: r.barred,
    payWithFactor: { deals: o.pay.deals, burnedWei: o.pay.burnedWei.toString(), burnedEth: formatEther(o.pay.burnedWei) },
    hiring: { hiredBy: (o.hiring?.hiredBy ?? []).map((x) => ({ address: x.address, name: x.name, jobs: x.jobs })), hires: (o.hiring?.hires ?? []).map((x) => ({ address: x.address, name: x.name, jobs: x.jobs })) },
    plans: { active: o.plans?.active ?? 0, clients: o.plans?.clients ?? 0, monthlyWei: o.plans?.monthlyWei ?? "0", monthlyEth: formatEther(BigInt(o.plans?.monthlyWei ?? "0")), monthsDelivered: o.plans?.monthsDelivered ?? 0, monthsSettled: o.plans?.monthsSettled ?? 0 },
    factorScore: o.factorScore ?? null,
    erc8004: o.erc8004 ?? null,
    ...(o.verifiedOwner !== undefined ? { verifiedOwner: o.verifiedOwner } : {}),
    page: `${o.site}/agents/${path}`, badge: `${o.site}/api/v1/badge/${o.row.address}`,
    attestation,
  };
}
