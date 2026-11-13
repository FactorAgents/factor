// The one door between a visitor's browser and the engine. The page's own scripts ask here, never the engine and
// never a node, which is what lets the site's content policy say "this site only".
//
// Only what a page needs passes: the public reads, and the two writes a wallet signs. The owner's health answer,
// the hiding of names and anything else the engine has do not: they are not reachable through the site at all.
import { NextResponse, type NextRequest } from "next/server";
import { callerOf } from "@/lib/caller";
import { engineUrl, sampleMode } from "@/lib/data";
import { sampleCase, sampleCaseFile, sampleReceipt, sampleCaseOfJob, sampleJobPage, sampleVerifierCases, sampleVerifierList, sampleVerifierPage, sampleVerifiersAbout, withVerifiers } from "@/lib/verifiersSample";
import { sampleAgent, sampleReviews, sampleAutoApply, sampleBounties, sampleBounty, sampleMilestoneOfJob, sampleCoin, sampleCoins, sampleGuarantee, sampleGuarantees, sampleLine, sampleLines, sampleFirm, sampleJobs, sampleLedger, sampleOpenJob, sampleOpenJobs, samplePlan, sampleState } from "@/lib/sample";
import { answerBody, answerHeaders, sharedRead } from "@/lib/shared";
import { sampleAsk } from "@/lib/askSample";
import { sampleReport, sampleReportsAbout, sampleReportsFind, sampleReportsTop } from "@/lib/reportsSample";
import { sampleCopilot } from "@/lib/copilotSample";
import { sampleAgentClaims, sampleClaim, sampleClaims, sampleClaimsAbout, sampleClaimsOfJob, withClaimsState } from "@/lib/claimsSample";
import { sampleAgentVouching, sampleCoverVouches, sampleVouch, sampleVouchingAbout, sampleVouchList, sampleVoucher, withCoverVouches, withVouching, withVouchingState } from "@/lib/vouchingSample";

const READS = /^(state|ask|copilot|copilot\/c\/[0-9a-f]{32}|pulse|desk|agents|agents\/made\/0x[0-9a-fA-F]{40}|agents\/[0-9a-zA-Z-]{3,42}|jobs|jobs\/\d{1,9}|jobs\/\d{1,9}\/tree|ledger|burns|accounts\/0x[0-9a-fA-F]{40}|accounts\/relay\/0x[0-9a-f]{64}|accounts\/by-credential\/0x[0-9a-f]{2,2046}|pay\/link\/[A-Za-z0-9_-]{20,6000}\.[A-Za-z0-9_-]{80,3000}|pay\/links\/0x[0-9a-fA-F]{40}|firms|firms\/[a-z0-9-]{3,32}|plans|plans\/0x[0-9a-f]{64}|erc8004|erc8004\/[0-9a-zA-Z-]{3,42}|openjobs|openjobs\/0x[0-9a-f]{64}|autoapply\/[0-9a-zA-Z-]{3,42}|verified|verified\/[0-9a-zA-Z-]{3,42}|coins|coins\/about|coins\/[0-9a-zA-Z-]{3,42}|lines|lines\/about|lines\/[0-9a-zA-Z-]{3,42}|guarantees|guarantees\/about|guarantees\/agent\/[0-9a-zA-Z-]{3,42}|guarantees\/(job|cover)\/\d{1,9}|guarantees\/customer\/0x[0-9a-fA-F]{40}|bounties|bounties\/about|bounties\/\d{1,9}|bounties\/\d{1,9}\/entries\/0x[0-9a-fA-F]{40}|bounties\/\d{1,9}\/mine\/0x[0-9a-fA-F]{40}|bounties\/agent\/[0-9a-zA-Z-]{3,42}|bounties\/poster\/0x[0-9a-fA-F]{40}|milestones|milestones\/about|milestones\/\d{1,9}|milestones\/job\/\d{1,9}|milestones\/agent\/[0-9a-zA-Z-]{3,42}|milestones\/customer\/0x[0-9a-fA-F]{40}|reviews|reviews\/agent\/[0-9a-zA-Z-]{3,42}|reviews\/job\/\d{1,9}|reviews\/job\/\d{1,9}\/erc8004|reviews\/file\/\d{1,9}\/\d{1,2}|hey|hey\/record|hey\/agent\/[0-9a-zA-Z-]{3,42}|verifiers|verifiers\/about|verifiers\/cases|verifiers\/case\/\d{1,9}|verifiers\/job\/\d{1,9}|verifiers\/0x[0-9a-fA-F]{40}|verifiers\/erc8004\/\d{1,9}|verifiers\/file\/\d{1,9}|verifiers\/receipt\/\d{1,9}\/0x[0-9a-fA-F]{40}|reports|reports\/formula|reports\/top|reports\/find|reports\/(agent|signed|erc8004)\/(\d{1,12}|0x[0-9a-fA-F]{40}|[\w.-]{2,48})|vouches|vouches\/about|vouches\/\d{1,9}|vouches\/(agent|voucher)\/[0-9a-zA-Z-]{3,42}|vouches\/line\/0x[0-9a-fA-F]{40}|vouches\/cover\/\d{1,9}|claims|claims\/about|claims\/\d{1,9}|claims\/job\/\d{1,9}|claims\/agent\/0x[0-9a-fA-F]{40})$/;
// two things a wallet signs, what an account without a wallet asks of the engine (lib/passkey.ts), a job paid
// through a Pay with Factor link (lib/pay.ts), an agent hiring another for part of its job (lib/subjobs.ts), and a
// firm formed, joined, left or hired (lib/firms.ts), and a monthly plan signed, a month of it linked, or a plan stopped
// (lib/plans.ts), and an agent linking its ERC-8004 identity (lib/erc8004.ts), and an open job posted, applied to,
// linked to the lock that hired its agent, or taken down (lib/openjobs.ts), and an agent's auto-apply rules (lib/autoapply.ts),
// and an owner verifying the wallet that runs its agent (lib/verified.ts), and the maker of an agent Factor runs asking
// for the agent's permission to launch its coin (lib/coins.ts), and a bounty's words, an entry's work and a poster's read
// (lib/bounties.ts), and the words of a job in stages (lib/milestones.ts), and a sentence for Ask Factor (lib/ask.ts),
// and a message for Factor Copilot (lib/copilot.ts), which prepares and never signs, and a paid review, its agent's
// reply, and the customer's own ERC-8004 entry of it read back (lib/reviews.ts), and an agent's owner linking it to its
// maker's project on HEY (lib/hey.ts), and the words of a job hired with a verifier and a verifier's reasons, each taken
// only when it hashes to what the verifier contract holds (lib/verifiers.ts), and an owner's claim of its agent's credit
// report (lib/reports.ts)
const WRITES = /^(match|ask|copilot|reviews|reviews\/reply|reviews\/erc8004|agents\/profile|agents\/make|agents\/pause|jobs\/title|jobs\/brief|jobs\/delivery|accounts|accounts\/check|accounts\/call|accounts\/relay|pay\/deal|pay\/links|subjobs\/plan|subjobs\/link|firms\/form|firms\/join|firms\/leave|firms\/hire|plans\/create|plans\/month|plans\/stop|erc8004\/link|openjobs\/post|openjobs\/apply|openjobs\/hire|openjobs\/close|openjobs\/withdraw|autoapply\/rules|verified\/check|coins\/permission|bounties\/task|bounties\/entry|bounties\/read|milestones\/terms|hey\/link|verifiers\/terms|verifiers\/reason|reports\/claim)$/;
const QUERY = ["limit", "before", "show", "agent", "customer", "firm", "verified", "sort", "poster", "q", "maker", "verifier", "offset", "own", "state", "voucher"];
const BODY_MOST = 4096;
// an order of an account carries its calls and a passkey's answer
const ORDER_MOST = 32_768;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

// With the sample on there is no engine: the same reads are answered from the sample, so every page works alone.
function fromSample(path: string, q: URLSearchParams): unknown {
  if (path === "state") return withClaimsState(withVouchingState(sampleState()));
  if (path === "claims/about") return sampleClaimsAbout();
  if (path === "claims") return sampleClaims({ state: q.get("state") ?? undefined });
  if (/^claims\/\d+$/.test(path)) return ((c) => (c ? { claim: c } : null))(sampleClaim(Number(path.slice(7))));
  if (path.startsWith("claims/job/")) return { claims: sampleClaimsOfJob(Number(path.slice(11))) };
  if (path.startsWith("claims/agent/")) return sampleAgentClaims(path.slice(13));
  if (path === "vouches/about") return sampleVouchingAbout();
  if (path === "vouches") return sampleVouchList({ state: q.get("state") ?? undefined });
  if (/^vouches\/\d+$/.test(path)) return ((v) => (v ? { vouch: v } : null))(sampleVouch(Number(path.slice(8))));
  if (path.startsWith("vouches/agent/")) return ((a) => { const x = a ? sampleAgentVouching(a.agent.address) : null; return x ? { agent: x } : null; })(sampleAgent(path.slice(14)));
  if (path.startsWith("vouches/voucher/")) return ((v) => (v ? { voucher: v } : null))(sampleVoucher(sampleAgent(path.slice(16))?.agent.address ?? path.slice(16)));
  if (path.startsWith("vouches/line/")) return { items: sampleVouchList().items.filter((v) => v.kind === "line" && v.line?.account === path.slice(13).toLowerCase()) };
  if (path.startsWith("vouches/cover/")) return { items: sampleCoverVouches(Number(path.slice(14))) };
  if (path === "ask") return { enabled: true, mostChars: 500, perMinute: 4, perDay: 40, reads: "plain" };
  if (path === "copilot") return { enabled: true, mostChars: 500, mostEth: "0.1", perMinute: 8, perDay: 150, reads: "plain" };
  if (path === "pulse") return { items: [] };
  if (path === "reviews" || path.startsWith("reviews/")) return sampleReviews(path);
  if (path === "desk") return { on: false, writing: false, letter: null, latest: [], items: [] };
  if (path === "agents") return { items: sampleState().agents };
  if (path === "jobs") return sampleJobs({ agent: q.get("agent") ?? undefined, customer: q.get("customer") ?? undefined });
  if (path === "ledger") return sampleLedger(Number(q.get("limit")) || 50, Number(q.get("before")) || undefined);
  if (path === "burns") return { total: sampleState().burns.length, more: false, items: sampleState().burns };
  if (path.startsWith("agents/")) return withVouching(withVerifiers(sampleAgent(path.slice(7))));
  if (path.startsWith("jobs/")) return withCoverVouches(sampleJobPage(Number(path.slice(5))));
  if (path === "verifiers/about") return sampleVerifiersAbout();
  if (path === "verifiers") return sampleVerifierList(Number(q.get("maker")) || undefined);
  if (path === "verifiers/cases") return sampleVerifierCases((["check", "seats", "reveal", "open", "all"] as const).find((x) => x === q.get("show")) ?? "check");
  if (/^verifiers\/case\/\d+$/.test(path)) return ((c) => (c ? { case: c } : null))(sampleCase(Number(path.slice(15))));
  if (/^verifiers\/job\/\d+$/.test(path)) return ((c) => (c ? { case: c } : null))(sampleCaseOfJob(Number(path.slice(14))));
  if (path.startsWith("verifiers/0x")) return sampleVerifierPage(path.slice(10).toLowerCase());
  if (/^verifiers\/erc8004\/\d+$/.test(path)) return sampleCase(Number(path.slice(18)))?.erc8004 ?? null;
  if (/^verifiers\/receipt\/\d+\/0x[0-9a-fA-F]{40}$/.test(path)) { const [, id, who] = path.split("/").slice(1); return sampleReceipt(Number(id), who!.toLowerCase()); }
  if (path === "firms") return { enabled: true, items: sampleState().firms?.items ?? [] };
  if (path.startsWith("firms/")) return sampleFirm(path.slice(6));
  if (path === "plans") return { enabled: false, items: [] };
  if (path.startsWith("plans/")) return samplePlan(path.slice(6));
  if (path === "erc8004") return { enabled: false };
  if (path === "reports") return sampleReportsAbout();
  if (path === "reports/top") return sampleReportsTop(Number(q.get("offset")) || 0, q.get("own") === "1");
  if (path === "reports/find") return sampleReportsFind(q.get("q") ?? "");
  if (path.startsWith("reports/agent/")) return sampleReport(decodeURIComponent(path.slice(14)));
  if (path === "openjobs") return sampleOpenJobs();
  if (path.startsWith("openjobs/")) return sampleOpenJob(path.slice(9));
  if (path.startsWith("autoapply/")) return sampleAutoApply(path.slice(10));
  if (path === "verified" || path.startsWith("verified/")) return { enabled: false };
  if (path === "hey" || path.startsWith("hey/")) return { enabled: false };
  if (path === "coins") return sampleCoins(q.get("sort") === "new" ? "new" : "fees");
  if (path.startsWith("coins/") && path !== "coins/about") return sampleCoin(path.slice(6));
  if (path === "coins/about") return { enabled: false, launcher: null };
  if (path === "lines" || path === "lines/about") return { ...sampleState().lines, items: path === "lines" ? sampleLines() : undefined };
  if (path.startsWith("lines/")) return ((l) => (l ? { line: l } : null))(sampleLine(path.slice(6)));
  if (path === "guarantees" || path === "guarantees/about") return { ...sampleState().guarantees, ...(path === "guarantees" ? sampleGuarantees() : {}) };
  if (path.startsWith("guarantees/agent/")) return ((g) => (g ? { guarantee: g } : null))(sampleGuarantee(path.slice(17)));
  if (path.startsWith("guarantees/customer/")) return { items: [] };
  if (path === "bounties" || path === "bounties/about") return { ...sampleBounties((q.get("show") as "open" | "all") ?? "all"), ...(path === "bounties/about" ? { items: undefined } : {}) };
  if (/^bounties\/\d+$/.test(path)) return sampleBounty(Number(path.slice(9)));
  if (path === "milestones" || path === "milestones/about") return { ...sampleState().milestones, ...(path === "milestones" ? { items: [sampleMilestoneOfJob(416)] } : {}) };
  if (/^milestones\/job\/\d+$/.test(path)) return sampleMilestoneOfJob(Number(path.slice(15)));
  return null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  if (!READS.test(path)) return json({ error: "not found" }, 404);
  const q = new URLSearchParams();
  for (const k of QUERY) {
    const v = req.nextUrl.searchParams.get(k);
    if (v !== null && v.length <= 64) q.set(k, v);
  }
  if (sampleMode()) {
    // the sample's case file, as its text: what would be hashed
    if (path.startsWith("verifiers/file/")) { const f = sampleCaseFile(Number(path.slice(15))); return f ? new NextResponse(f, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }) : json({ error: "no such case" }, 404); }
    const body = fromSample(path, q);
    return body ? json(body) : json({ error: "not found" }, 404);
  }
  const engine = engineUrl();
  if (!engine) return json({ error: "nothing is live yet" }, 503);
  const url = `${engine}/v1/${path}${q.size ? `?${q}` : ""}`;
  // a verified job's case file: its keccak256 is on the chain, so its bytes pass through untouched, with the engine's own type
  if (path.startsWith("verifiers/file/")) {
    try {
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      return new NextResponse(new Uint8Array(await r.arrayBuffer()), { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    } catch {
      return json({ error: "the engine is not answering" }, 502);
    }
  }
  // an account's reads are its own, and cost the engine a question to the chain: asked for each caller, with who it is
  if (path.startsWith("accounts/")) {
    try {
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000), headers: { "x-forwarded-for": callerOf(req) } });
      return json(await r.json(), r.status);
    } catch {
      return json({ error: "the engine is not answering" }, 502);
    }
  }
  // every other read is the same for everybody: one answer from the engine, shared (lib/shared.ts)
  try {
    const a = await sharedRead(`${path}?${q}`, async () => {
      const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      return { status: r.status, body: await r.text() };
    });
    const { headers, notModified } = answerHeaders(a, req.headers.get("if-none-match"));
    return new NextResponse(notModified ? null : new Uint8Array(Buffer.from(answerBody(a, req.headers.get("accept-encoding"), headers))), { status: notModified ? 304 : a.status, headers });
  } catch {
    return json({ error: "the engine is not answering" }, 502);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  if (!WRITES.test(path)) return json({ error: "not found" }, 404);
  // the sample has no engine: a sentence for Ask Factor is read by plain rules against the sample's agents
  if (sampleMode() && path === "ask") {
    const b = (await req.json().catch(() => ({}))) as { text?: unknown };
    return typeof b.text === "string" && b.text.trim().length >= 8 ? json(sampleAsk(b.text.trim().slice(0, 500))) : json({ error: "say a little more: what you want done, and anything it must have" }, 400);
  }
  // the sample has no engine and no desk: Copilot answers from the sample's agents and prepares nothing
  if (sampleMode() && path === "copilot") {
    const b = (await req.json().catch(() => ({}))) as { text?: unknown };
    return typeof b.text === "string" && b.text.trim() ? json(sampleCopilot(b.text.trim().slice(0, 500))) : json({ error: "say what you want done" }, 400);
  }
  const engine = engineUrl();
  if (!engine) return json({ error: "nothing is live yet" }, 503);
  const text = await req.text();
  // a brief is up to 12,000 characters and a piece of work up to 200,000
  const most = path === "bounties/entry" ? 2 * 200_000 + 1024 : path === "bounties/task" ? 2 * 8000 + 1024 : path === "milestones/terms" ? 2 * 40_000 + 1024 : path === "verifiers/terms" ? 4 * 12_200 + 1024 : path === "verifiers/reason" ? 4 * 4000 + 1024 : path.startsWith("accounts") || path.startsWith("pay/") ? ORDER_MOST : path === "jobs/brief" || path === "agents/make" || path === "match" || path === "subjobs/plan" || path === "firms/hire" || path === "plans/create" || path === "openjobs/post" ? 64_000 : path === "jobs/delivery" ? 900_000 : BODY_MOST;
  if (text.length > most) return json({ error: "the body is too large" }, 413);
  // who is asking is passed on, so the engine's limit on signed writes counts visitors and not this site
  const from = callerOf(req);
  try {
    // matching and Ask Factor ask a model, which takes a few seconds more than a signed write
    const r = await fetch(`${engine}/v1/${path}`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(path === "match" || path === "ask" || path === "copilot" ? 45_000 : 12_000), headers: { "content-type": "application/json", ...(from ? { "x-forwarded-for": from } : {}) }, body: text });
    return json(await r.json(), r.status);
  } catch {
    return json({ error: "the engine is not answering" }, 502);
  }
}
