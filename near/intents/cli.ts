// NEAR Intents for the Factor desk, from the command line.
//
//   node intents/cli.ts tokens                         the assets used here, live from 1Click (read-only)
//   node intents/cli.ts quote [--price 25] [--from base-usdc]
//                                                      a live DRY quote: what the customer sends on its own chain
//                                                      so exactly the job's price lands on the desk (read-only)
//   node intents/cli.ts status <depositAddress>        the live status of a deposit address (read-only)
//   node intents/cli.ts demo                           the whole path: live dry quote, the lock message checked,
//                                                      and on testnet the delivery 1Click makes on SUCCESS, made
//                                                      by a stand-in account with the same message, which locks
//                                                      the job; then the agent does it and is paid in the token
//
// 1Click runs on mainnet only and has no testnet. Nothing here makes a deposit or a non-dry quote.

import { mkdirSync, writeFileSync } from "node:fs";
import { OneClick } from "./oneclick.ts";
import { ASSETS, checkLock, creditedJob, fundingQuote, lockMsg, newRef, noteOf, phaseOf } from "./fund.ts";
import { DESK, TEST_DOLLAR, call, fmtUnits, sha256, signer, view, txLink, NETWORK } from "../lib/near.ts";
import { step, say, link, pause } from "../agent/say.ts";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const CUSTOMER = process.env.CUSTOMER || "factor-client.testnet";
const AGENT = process.env.AGENT || "factor-scout.testnet";
const STANDIN = process.env.INTENTS_STANDIN || "intents-standin.factor-desk.testnet";
// 1Click checks the recipient exists on mainnet. The desk runs on testnet only, so a dry quote names this existing
// mainnet account in its place. A dry quote has no deposit address: nothing can ever be sent to it.
const DRY_RECIPIENT = process.env.DRY_QUOTE_RECIPIENT || "wrap.near";
// any valid address on the origin chain; a dry quote never refunds anything
const REFUND_TO = process.env.REFUND_TO || "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const DEPOSIT_MINUTES = 30;

const oneclick = new OneClick();
const usdc = (v: bigint | string): string => fmtUnits(BigInt(v), 6, 6);

async function tokens() {
  const all = await oneclick.tokens();
  const wanted = new Set(Object.values(ASSETS));
  for (const t of all.filter((t) => wanted.has(t.assetId))) {
    console.log(`${t.symbol.padEnd(7)}${t.blockchain.padEnd(7)}${String(t.price).padEnd(12)}${t.assetId}`);
  }
}

function brief(): string {
  return "Factor brief, paid from Base: summarize this week's NEAR Intents volume by chain, under 200 words.";
}

async function quote(price: bigint, from: string, dueMs: number, ref: string) {
  const msg = lockMsg({ customer: CUSTOMER, agent: AGENT, dueMs, allowAdvance: true, brief: sha256(brief()), ref });
  const req = fundingQuote({ from, refundTo: REFUND_TO, desk: DRY_RECIPIENT, destinationAsset: ASSETS["near-usdc"], amount: price, msg, dry: true, nowMs: Date.now(), minutes: DEPOSIT_MINUTES });
  const res = await oneclick.quote(req);
  return { msg, req, res };
}

async function status(addr: string) {
  const s = await oneclick.status(addr);
  const p = phaseOf(s);
  console.log(`${s?.status ?? "not found"}: ${p.words}`);
}

async function demo() {
  const run: any = { network: NETWORK, desk: DESK, started: new Date().toISOString() };
  const price = BigInt(Math.round(Number(flag("price", "25")) * 1e6));
  const from = flag("from", "base-usdc");
  const ref = newRef();
  const dueMs = Date.now() + 60 * 60_000;

  step(CUSTOMER, `wants to hire ${AGENT} for ${usdc(price)} USDC, paying from ${from.replace("-", " ").toUpperCase()}`);
  const rules = await view(DESK, "get_config");
  const msg = lockMsg({ customer: CUSTOMER, agent: AGENT, dueMs, allowAdvance: true, brief: sha256(brief()), ref });
  const wrong = checkLock(msg, price, TEST_DOLLAR, rules, Date.now(), DEPOSIT_MINUTES);
  say(`the lock message is checked against the desk's rules first: ${wrong.length ? wrong.join("; ") : "it would be accepted"}`);
  if (wrong.length) throw new Error(wrong.join("; "));
  await pause();

  step("1Click (mainnet, live)", `asked for a dry quote: exactly ${usdc(price)} USDC on NEAR, delivered with the lock message`);
  const { req, res } = await quote(price, from, dueMs, ref);
  run.quote = { request: req, response: res };
  say(`send ${res.quote.amountInFormatted} USDC on ${from.split("-")[0]} (${res.quote.amountInUsd.slice(0, 6)} USD); lands ${res.quote.amountOutFormatted} USDC in about ${res.quote.timeEstimate} s`);
  say(`quote ${res.correlationId}, signed by 1Click; dry: no deposit address is made and nothing is sent`);
  await pause();

  step("1Click", "on a real deposit: PENDING_DEPOSIT, then PROCESSING, then SUCCESS (1Click has no testnet: this step is not run)");
  say("on SUCCESS NEAR Intents calls ft_transfer_call(desk, amount, msg) on the token, with the message above");
  await pause();

  step("intents stand-in", `${STANDIN} makes that same delivery on testnet: ${usdc(price)} tUSD to the desk with the same message`);
  const standin = signer(STANDIN);
  const minted = await call(standin, TEST_DOLLAR, "mint", { amount: price.toString() }, { tgas: 30 });
  run.mint = minted.hash;
  const delivered = await call(standin, TEST_DOLLAR, "ft_transfer_call", { receiver_id: DESK, amount: price.toString(), memo: "1Click delivery stand-in", msg }, { deposit: 1n, tgas: 120 });
  link(delivered);
  run.delivery = { hash: delivered.hash, link: txLink(delivered.hash) };
  const locked = delivered.events.find((e) => e.event === "job_locked")?.data;
  if (!locked) throw new Error(`the desk did not lock a job: ${delivered.logs.join(" | ")}`);
  const jobs = await view(DESK, "get_jobs", { from: String(Math.max(0, Number(locked.id) - 5)), limit: 10 });
  const job = creditedJob(jobs, ref, price, TEST_DOLLAR);
  if (!job) throw new Error("no job carries this quote's reference");
  say(`job #${(job as any).id} locked in the same transfer: ${usdc((job as any).price)} tUSD for ${(job as any).agent}, customer ${(job as any).customer}, note ${noteOf(ref)}`);
  run.job = job;
  await pause();

  step(AGENT, `takes job #${(job as any).id}, draws an advance in tUSD, delivers, and is paid in tUSD`);
  const agent = signer(AGENT);
  const customer = signer(CUSTOMER);
  const id = String((job as any).id);
  const t1 = await call(agent, DESK, "accept_job", { id });
  const t2 = await call(agent, DESK, "draw", { id, amount: (price / 5n).toString() });
  const work = "NEAR Intents weekly volume note (stub model output for the demo).";
  const t3 = await call(agent, DESK, "deliver", { id, proof: sha256(work) });
  const t4 = await call(customer, DESK, "accept", { id });
  const paid = t4.events.find((e) => e.event === "job_paid")?.data;
  for (const t of [t1, t2, t3, t4]) link(t);
  say(`paid: advance ${usdc(paid.advance_settled)} settled out of ${usdc(paid.gross)} tUSD, desk fee ${usdc(paid.fee)}, ${AGENT} is paid ${usdc(paid.to_agent)} tUSD`);
  run.job_txs = [t1, t2, t3, t4].map((t) => ({ hash: t.hash, link: t.link }));
  run.settlement = paid;

  run.finished = new Date().toISOString();
  mkdirSync(new URL("../demo/runs/", import.meta.url), { recursive: true });
  const file = new URL(`../demo/runs/intents-${run.started.replace(/[:.]/g, "-")}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
  say(`saved the run: ${file.pathname.split("/near/")[1]}`);
}

const cmd = args[0];
const main = async () => {
  if (cmd === "tokens") return tokens();
  if (cmd === "quote") {
    const { req, res } = await quote(BigInt(Math.round(Number(flag("price", "25")) * 1e6)), flag("from", "base-usdc"), Date.now() + 60 * 60_000, newRef());
    console.log(JSON.stringify({ request: req, quote: res.quote, correlationId: res.correlationId }, null, 2));
    return;
  }
  if (cmd === "status") return status(args[1] ?? "");
  if (cmd === "demo") return demo();
  console.log("usage: node intents/cli.ts tokens | quote [--price 25] [--from base-usdc] | status <depositAddress> | demo");
};
main().catch((e) => {
  console.error(`stopped: ${e?.message ?? e}`);
  process.exit(1);
});
