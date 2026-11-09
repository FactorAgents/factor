// What backs a verdict beyond the verdict itself (docs/VERIFIERS.md, sections 16 and 17): a model receipt in the verifier's
// reasons, and the verdict on the ERC-8004 validation registry. Pure functions only; ./verifiers.ts keeps and sends.
//
// A RECEIPT is a block at the end of a verdict's reasons, whose keccak256 is on the chain with the verdict:
//
//   Receipt:
//   - provider: openrouter
//   - generation: gen-...                 the provider's own id of the call
//   - model: google/gemini-2.5-flash      the model asked for
//   - request-hash: 0x...                 keccak256 of the exact request body sent to the provider, UTF-8
//   - output-hash: 0x...                  keccak256 of the model's answer text, UTF-8
//
// Factor's own verifiers add what the provider's record of the call said when Factor looked it up with the key that made
// it: reported-model, provider-name, tokens, created. What this binds, and what it does not, is said in VERIFIERS.md.
//
// The CASE FILE is what a verdict on ERC-8004 points to: one JSON text, its keys in a fixed order, frozen once the case has
// ended, served at <site>/api/v1/verifiers/file/<case> exactly as hashed. Its keccak256 is the request's hash and the
// response's hash on the registry.

import { keccak256, toHex, type Hex } from "viem";

export interface ReceiptLines {
  provider: string;
  generation: string;
  model: string | null;
  requestHash: Hex;
  outputHash: Hex;
  reportedModel?: string | null;
  providerName?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  created?: string | null;
}

export const hashOf = (text: string): Hex => keccak256(toHex(text));

/** The receipt block, as it ends a verdict's reasons. */
export function receiptBlock(r: ReceiptLines): string {
  const lines = ["Receipt:", `- provider: ${r.provider}`, `- generation: ${r.generation}`, `- model: ${r.model ?? "unknown"}`, `- request-hash: ${r.requestHash}`, `- output-hash: ${r.outputHash}`];
  if (r.reportedModel) lines.push(`- reported-model: ${r.reportedModel}`);
  if (r.providerName) lines.push(`- provider-name: ${r.providerName}`);
  if (typeof r.tokensIn === "number" && typeof r.tokensOut === "number") lines.push(`- tokens: ${r.tokensIn} in, ${r.tokensOut} out`);
  if (r.created) lines.push(`- created: ${r.created}`);
  return lines.join("\n");
}

const LINE = /^- ([a-z-]+): (.{1,200})$/;

/** The receipt block at the end of a verdict's reasons, read back; null when there is none or it is not whole. */
export function readReceipt(reasons: string | null): ReceiptLines | null {
  if (!reasons) return null;
  const at = reasons.lastIndexOf("\nReceipt:\n");
  const start = at >= 0 ? at + 1 : reasons.startsWith("Receipt:\n") ? 0 : -1;
  if (start < 0) return null;
  const fields = new Map<string, string>();
  for (const l of reasons.slice(start).split("\n").slice(1)) {
    const m = LINE.exec(l.trim());
    if (m) fields.set(m[1]!, m[2]!.trim());
  }
  const req = fields.get("request-hash"), out = fields.get("output-hash");
  const hex = (x: string | undefined): x is Hex => !!x && /^0x[0-9a-f]{64}$/i.test(x);
  if (!fields.get("provider") || !fields.get("generation") || !hex(req) || !hex(out)) return null;
  const tokens = /^(\d+) in, (\d+) out$/.exec(fields.get("tokens") ?? "");
  return {
    provider: fields.get("provider")!, generation: fields.get("generation")!, model: fields.get("model") ?? null,
    requestHash: req.toLowerCase() as Hex, outputHash: out.toLowerCase() as Hex,
    reportedModel: fields.get("reported-model") ?? null, providerName: fields.get("provider-name") ?? null,
    tokensIn: tokens ? Number(tokens[1]) : null, tokensOut: tokens ? Number(tokens[2]) : null, created: fields.get("created") ?? null,
  };
}

/** How a model's id at OpenRouter starts for each maker number: what a provider's record is held to against a declared maker. */
export const MAKER_PREFIXES: Record<number, string[]> = {
  1: ["anthropic/"], 2: ["google/"], 3: ["openai/"], 4: ["x-ai/"], 5: ["meta-llama/"], 6: ["mistralai/"], 7: ["deepseek/"],
  8: ["qwen/"], 9: ["moonshotai/"], 10: ["z-ai/", "thudm/"], 11: ["amazon/"], 12: ["cohere/"], 13: ["microsoft/"], 14: ["nvidia/"], 15: ["minimax/"],
};

/** Whether a model id is the declared maker's. */
export function modelOfMaker(model: string | null | undefined, maker: number): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return (MAKER_PREFIXES[maker] ?? []).some((p) => m.startsWith(p));
}

/** What a provider's record of a call is held to: the model of the declared maker, and the tokens it counted. */
export interface ProviderRecord { model: string | null; providerName: string | null; tokensIn: number | null; tokensOut: number | null; created: string | null }

/** OpenRouter's answer to GET /generation?id=..., read: the fields a receipt keeps. Null when it is not one. */
export function readOpenRouterRecord(body: unknown): ProviderRecord | null {
  const d = (body && typeof body === "object" && "data" in body ? (body as { data: unknown }).data : null) as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || typeof d.id !== "string") return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    model: typeof d.model === "string" ? d.model : null,
    providerName: typeof d.provider_name === "string" ? d.provider_name : null,
    tokensIn: n(d.tokens_prompt) ?? n(d.native_tokens_prompt), tokensOut: n(d.tokens_completion) ?? n(d.native_tokens_completion),
    created: typeof d.created_at === "string" ? d.created_at : null,
  };
}

/**
 * Whether a receipt of Factor's own holds: the provider's record names a model of the declared maker, the published
 * request and output hash to what the receipt says, and the reasons on the chain carry that receipt. Returns why not.
 */
export function receiptHolds(o: { lines: ReceiptLines; record: ProviderRecord | null; request: string | null; output: string | null; maker: number; reasons: string | null; reasonHashOnChain: string | null }): { ok: boolean; why: string | null } {
  if (!o.reasons || !o.reasonHashOnChain || hashOf(o.reasons) !== o.reasonHashOnChain.toLowerCase()) return { ok: false, why: "the reasons that carry it are not the ones whose hash is on the chain" };
  const onChain = readReceipt(o.reasons);
  if (!onChain || onChain.generation !== o.lines.generation || onChain.requestHash !== o.lines.requestHash || onChain.outputHash !== o.lines.outputHash) return { ok: false, why: "the receipt in the reasons on the chain is not this one" };
  if (o.request === null || hashOf(o.request) !== o.lines.requestHash) return { ok: false, why: "the published request does not hash to the receipt's request hash" };
  if (o.output === null || hashOf(o.output) !== o.lines.outputHash) return { ok: false, why: "the published answer does not hash to the receipt's output hash" };
  if (!o.record) return { ok: false, why: "the provider's record of the call has not been read" };
  if (!modelOfMaker(o.record.model, o.maker)) return { ok: false, why: `the provider's record names ${o.record.model ?? "no model"}, not a model of the declared maker` };
  return { ok: true, why: null };
}

/** The case file of a verdict on ERC-8004: every key in a fixed order, so the same case always makes the same text. */
export interface CaseFile {
  kind: "factor.verify"; version: 1; chainId: number; verifiers: string; desk: string; case: number; job: number;
  agent: string; agentId: string; customer: string; priceWei: string; termsHash: string; proof: string | null;
  verdict: "accept" | "reject"; response: 0 | 100; decidedBy: "first-check" | "panel"; validator: string;
  firstCheck: { verifier: string; accept: boolean; reasonHash: string } | null;
  panel: { verifier: string; maker: number; vote: "accept" | "reject" | null; reasonHash: string | null }[];
  votes: { accept: number; reject: number };
  ended: { state: string; how: string | null; at: number; tx: string };
  page: string;
}

export function caseFileText(f: CaseFile): string {
  return JSON.stringify({
    kind: f.kind, version: f.version, chainId: f.chainId, verifiers: f.verifiers, desk: f.desk, case: f.case, job: f.job,
    agent: f.agent, agentId: f.agentId, customer: f.customer, priceWei: f.priceWei, termsHash: f.termsHash, proof: f.proof,
    verdict: f.verdict, response: f.response, decidedBy: f.decidedBy, validator: f.validator,
    firstCheck: f.firstCheck ? { verifier: f.firstCheck.verifier, accept: f.firstCheck.accept, reasonHash: f.firstCheck.reasonHash } : null,
    panel: f.panel.map((s) => ({ verifier: s.verifier, maker: s.maker, vote: s.vote, reasonHash: s.reasonHash })),
    votes: { accept: f.votes.accept, reject: f.votes.reject },
    ended: { state: f.ended.state, how: f.ended.how, at: f.ended.at, tx: f.ended.tx },
    page: f.page,
  });
}
