// Factor everywhere on the site (engine/src/everywhere.ts): the shape of a signed answer, how the site checks one, and
// the sample's answers. On the sample there is no engine and no Factor key: its answers are signed by a key made for
// the sample alone, which the sample's own about names, so the embeds and the page can be built and looked at.
import "server-only";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SAMPLE_SIGNER, sampleAgent, sampleGuarantee, sampleLine, sampleState } from "./sample";
import type { AgentAnswer, EverywhereAbout } from "./types";

/** The sample's signer: a key made from a fixed phrase, worth nothing, used for nothing but the sample's answers. */
const SAMPLE_KEY = keccak256(toHex("factor sample answers: worth nothing anywhere"));
const sampleSigner = privateKeyToAccount(SAMPLE_KEY);
if (sampleSigner.address.toLowerCase() !== SAMPLE_SIGNER) throw new Error("the sample's signer is not the one lib/sample.ts names");

export const SAMPLE_EVERYWHERE: EverywhereAbout = sampleState().everywhere!;

/** One sample agent, as an answer carries it. */
export function sampleAnswer(id: string): AgentAnswer | null {
  const raw = decodeURIComponent(id);
  const page = sampleAgent(/^(8004|erc8004):\d+$/.test(raw) ? "lumen-07" : raw);
  if (!page) return null;
  const a = page.agent;
  const l = sampleLine(a.address);
  const g = sampleGuarantee(a.address);
  return {
    agent: { address: a.address, name: a.name, named: a.named, does: a.does, since: a.since, page: `https://factoragents.fun/agents/${a.named ? a.name : a.address}`, factorOwn: a.house, erc8004: page.erc8004 ? { agentId: page.erc8004.agentId, registry: page.erc8004.registry } : null },
    score: { value: a.score, of: 1000, barred: a.barred, check: `score(${a.address}) on the desk ${sampleState().contracts.desk}` },
    record: { settled: a.settled, settledAtHalf: a.settledAtHalf, delivered: a.settled + a.settledAtHalf, onTime: Math.round((a.settled * a.onTimePct) / 100), late: a.settled - Math.round((a.settled * a.onTimePct) / 100), refunded: a.notDelivered + a.unanswered, declined: 0, customers: a.customers, distinctCustomers: a.customers, volumeEth: String(a.volumeEth), advancesRepaid: a.advancesRepaid, advancesNotRepaid: a.advancesMissed },
    line: l ? { status: l.status, limitEth: l.limitEth, owedEth: l.debtEth, headroomEth: l.canDrawEth, dueAt: l.dueAt } : null,
    guarantee: g ? { selling: g.selling, upToEth: g.upToEth, sharePct: g.sharePct, bondEth: g.bondEth, freeEth: g.freeEth, covers: g.covers, delivered: g.released, paidOut: g.paid, paidOutEth: g.paidOutEth } : null,
    hire: `https://factoragents.fun/hire?agent=${a.named ? a.name : a.address}`,
  };
}

/** The sample's answers, sealed as the engine seals them: the JSON text and an EIP-191 signature of it. */
export async function sampleSealed(path: string): Promise<{ status: number; body: unknown }> {
  const now = Math.floor(Date.now() / 1000);
  const env = (kind: string) => ({ v: 1, kind, chainId: 4663, desk: sampleState().contracts.desk, block: 105_000_000, issuedAt: now, expiresAt: now + 600 });
  const seal = async (data: unknown) => { const answer = JSON.stringify(data); return { answer, signature: await sampleSigner.signMessage({ message: answer }), signer: SAMPLE_EVERYWHERE.signer, scheme: "eip191" }; };
  const one = /^agent\/([^/]{3,120})$/.exec(path);
  if (one) {
    const a = sampleAnswer(one[1]!);
    return a ? { status: 200, body: await seal({ ...env("factor.agent"), ...a }) } : { status: 404, body: { error: "no agent is called that" } };
  }
  return { status: 404, body: { error: "not found" } };
}

/** The one-line snippet for an agent's embeds, as the kit's embedSnippet writes it. */
export const embedSnippet = (agent: string, site = "https://factoragents.fun"): string =>
  `<div data-factor-agent="${agent}" data-factor-show="score guarantee hire"></div>\n<script src="${site}/embed.js" async></script>`;
