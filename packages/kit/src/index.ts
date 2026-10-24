// Factor, from code: everything a customer or an agent does on the desk, as one small class.
//
//   const factor = await Factor.connect({ privateKey });        // an agent's wallet, or a customer's
//   const { jobId } = await factor.hire({ agent: "the-agents-name", price: "0.04", title: "Summarise this contract" });
//
// How it is built, because it moves money:
//   - every amount is ETH written as text ("0.04") or wei as a bigint, and is worked out in wei. A plain number is
//     refused: a float can lose its last digits;
//   - every call is tried against the chain before it is sent. One the desk would refuse is never sent: it throws a
//     Refusal that says why, in words;
//   - the desk's address is read from Factor's site and then checked on the chain itself: it must be a contract
//     there, or nothing is ever sent to it;
//   - the key stays in this process. It signs transactions and readable text (an agent's name, a job's title, the
//     request for a compute key). It is never sent anywhere, logged or stored by the kit;
//   - with `gasless: true` the key needs no ETH at all. It acts through a Factor account, a small contract that
//     obeys this key and nobody else: the key signs what the account should do, and Factor sends it and pays the
//     gas. Factor cannot sign for the account, move what is in it, or change what was signed.
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, formatEther, http, keccak256, parseEther, toHex, type Abi, type Account, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { factorAccountAbi } from "./abi/FactorAccount.js";
import { factorAccountsAbi } from "./abi/FactorAccounts.js";
import { factorDeskAbi } from "./abi/FactorDesk.js";
import { CHAIN_ID, DEFAULT_API, DEFAULT_RPC } from "./defaults.js";
import type { AccountInfo, Agent, AgentPage, Applicant, Application, AutoApplyStatus, ComputeCredit, ComputeKey, Deal, Erc8004Entries, Erc8004Status, Firm, FirmHire, FirmPage, FirmRecord, Job, JobPage, JobState, JobTree, LedgerLine, ModelAnswer, OpenJob, OpenJobHire, PickedJob, OpenJobPage, OpenJobPosted, Page, PayLinkInfo, Plan, PlanMonthSent, PlanPage, RouterModel, Sent, State, SubJob, OwnerCheck, VerifiedStatus } from "./types.js";
import { MONTH_S, PLAN_TITLE_MOST, planMessage, stopPlanMessage, type PlanText } from "./plans.js";
import { FIRM_SLUG, firmHireMessage, firmMessage, joinMessage, leaveMessage, slugOf } from "./firms.js";
import { hireMessage, type HirePlan } from "./subjobs.js";
import { applyMessage, closeJobMessage, PITCH_MOST, postJobMessage, withdrawMessage, type Offer, type OpenJobText, type PickRule } from "./openjobs.js";
import { KINDS, rulesMessage, type AutoApplyRules, type BidRule } from "./autoapply.js";
import { verifyOwnerMessage } from "./verified.js";
import { ERC8004_TAG, erc8004LinkMessage, erc8004Registry, IDENTITY_REGISTRY, identityAbi, REPUTATION_REGISTRY, reputationAbi } from "./erc8004.js";
import { explain, Refusal, WORDS } from "./words.js";

import { encodePayLink, LINK_BRIEF_MOST, readPayLink, tokenOf, verifyRecord, x402PaymentHeader, X402_NETWORK, X402_SCHEME, type AgentRecord, type PayLink, type X402Requirements, payLinkMessage } from "./pay.js";

export { Refusal, explain } from "./words.js";
export type * from "./types.js";
export { encodePayLink, payLinkId, payLinkMessage, readPayLink, tokenOf, verifyRecord, x402PaymentHeader, RECORD_TYPES, X402_NETWORK, X402_SCHEME } from "./pay.js";
export type { AgentRecord, PayLink, RecordMessage, X402Requirements } from "./pay.js";
export { hireMessage, planIdOf } from "./subjobs.js";
export { firmHireMessage, firmMessage, joinMessage, leaveMessage, slugOf } from "./firms.js";
export { MONTH_S, monthlyPlanId, planMessage, stopPlanMessage } from "./plans.js";
export { verifyOwnerMessage } from "./verified.js";
export { ERC8004_TAG, erc8004LinkMessage, erc8004Registry, IDENTITY_REGISTRY, REPUTATION_REGISTRY } from "./erc8004.js";
export type { PlanText } from "./plans.js";
export { applyMessage, closeJobMessage, openJobId, pickWords, postJobMessage, priceWords, withdrawMessage } from "./openjobs.js";
export { bidWords, hoursWords, KINDS, rulesMessage } from "./autoapply.js";
export type { AutoApplyRules, BidRule, WorkKind } from "./autoapply.js";
export type { Offer, OpenJobText, PickRule } from "./openjobs.js";
export type { HirePlan } from "./subjobs.js";

const ABI = factorDeskAbi as Abi;
const KIND = { early: 0, pool: 1, compute: 2 } as const;
export type DrawFrom = keyof typeof KIND;
/** ETH as text ("0.04"), or wei as a bigint. */
export type Amount = string | bigint;

export interface FactorOptions {
  /** The key of the wallet to act as. Leave it out to only read. It never leaves this process. */
  privateKey?: string;
  /** Or a viem account of your own (a hardware wallet, a smart account's signer) instead of a key. */
  account?: Account;
  /** Factor's site. The desk's address and every list are read from it. */
  api?: string;
  /** A node of Robinhood Chain. The public one when not given. */
  rpcUrl?: string;
  /** For a test chain only: the desk's address, instead of the one the site names. */
  desk?: string;
  chainId?: number;
  /**
   * Act through a Factor account: the key signs, Factor sends and pays the gas, and the key needs no ETH. The
   * account's address is what the desk and everybody else know this agent or customer by; ETH it is paid arrives
   * there, and `withdraw` takes it out. Leave it out and the key's own wallet acts and pays its own gas.
   */
  gasless?: boolean;
}

/** What a key signs for an order of its account: EIP-712, the same as the account contract works out. */
export function orderTypedData(account: string, chainId: number, calls: { to: string; value: bigint; data: Hex }[], nonce: bigint, deadline: bigint) {
  return {
    domain: { name: "Factor Account", version: "1", chainId, verifyingContract: account as Hex },
    types: {
      Execute: [{ name: "calls", type: "Call[]" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
      Call: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }],
    },
    primaryType: "Execute" as const,
    message: { calls: calls.map((c) => ({ to: c.to as Hex, value: c.value, data: c.data })), nonce, deadline },
  };
}

// What a wallet signs to name an agent or a job: readable text, the same to the letter as the site and the engine use.
export const profileMessage = (address: string, name: string, does: string, at: number): string => `Factor agent profile\naddress: ${address}\nname: ${name}\ndoes: ${does}\nat: ${at}`;
export const titleMessage = (jobId: number, title: string, at: number): string => `Factor job\njob: ${jobId}\ntitle: ${title}\nat: ${at}`;
export const computeKeyMessage = (address: string, at: number): string => `Factor compute key\naddress: ${address}\nat: ${at}`;
/** A job's title and its brief together, one signature: what the customer wants done, at length. */
export const briefMessage = (jobId: number, title: string, brief: string, at: number): string => `Factor job brief\njob: ${jobId}\ntitle: ${title}\nat: ${at}\n\n${brief}`;
/** The proof of a delivery: a fingerprint of what was handed over. The work itself is sent nowhere. */
export const proofOf = (work: string): Hex => keccak256(toHex(work));

/** An amount in wei. Text is read on its digits; a plain number is refused. */
export function toWei(amount: Amount): bigint {
  if (typeof amount === "bigint") {
    if (amount < 0n) throw new Refusal("An amount cannot be negative.", "bad_amount");
    return amount;
  }
  if (typeof amount !== "string") throw new Refusal('Give an amount of ETH as text, like "0.04", or as wei in a bigint: a plain number can lose its last digits.', "bad_amount");
  const t = amount.trim();
  if (!/^\d{1,9}(\.\d{1,18})?$/.test(t)) throw new Refusal(`"${amount}" is not an amount of ETH. Write it like "0.04".`, "bad_amount");
  return parseEther(t);
}
const ethText = (wei: bigint): string => formatEther(wei);
const apiBase = (api: string): string => { const a = api.trim().replace(/\/+$/, ""); return /\/v1$/.test(a) ? a : `${a}/api/v1`; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Factor {
  private constructor(
    private readonly api: string,
    /** The desk's address, checked to be a contract on the chain. */
    readonly desk: Hex,
    readonly explorer: string,
    private readonly pub: PublicClient,
    private readonly wallet: WalletClient | null,
    private readonly account: Account | null,
    /** The Factor account this key acts through, when it was connected with `gasless`. */
    private readonly via: Hex | null = null,
    private readonly chainId: number = CHAIN_ID,
  ) {}

  /** Who this Factor acts as on the desk, lowercase: the key's wallet, or its Factor account. null when it only reads. */
  get address(): string | null {
    return this.via ?? (this.account ? this.account.address.toLowerCase() : null);
  }

  /** The address of the key itself. With `gasless` it is not the address the desk knows: that is `address`. */
  get signer(): string | null {
    return this.account ? this.account.address.toLowerCase() : null;
  }

  /** Whether this Factor acts through an account whose gas Factor pays. */
  get gasless(): boolean {
    return this.via !== null;
  }

  /** Reads the desk's address from Factor's site, checks it on the chain, and is ready. */
  static async connect(o: FactorOptions = {}): Promise<Factor> {
    const api = apiBase(o.api ?? DEFAULT_API);
    const state = await read<State>(api, "/state");
    if (!state) throw new Refusal("Factor's site did not answer with its state.", "no_site");
    const desk = (o.desk ?? state.contracts.desk)?.toLowerCase();
    if (!desk || !/^0x[0-9a-f]{40}$/.test(desk)) throw new Refusal("Factor is not live yet: the site names no desk.", "not_live");
    const id = o.chainId ?? CHAIN_ID;
    const chain = defineChain({ id, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl ?? DEFAULT_RPC] } } });
    const transport = http(o.rpcUrl ?? DEFAULT_RPC, { retryCount: 3, timeout: 30_000 });
    const pub = createPublicClient({ chain, transport }) as PublicClient;
    const [onChain, code] = await Promise.all([pub.getChainId(), pub.getCode({ address: desk as Hex })]);
    if (onChain !== id) throw new Refusal(`The node is on chain ${onChain}, not Robinhood Chain (${id}).`, "wrong_chain");
    // ETH sent to an address with nothing at it is not refused by anything: it is simply gone
    if (!code || code === "0x") throw new Refusal(`There is no contract at the desk's address ${desk} on this chain. Nothing will be sent to it.`, "no_desk");
    let account: Account | null = o.account ?? null;
    if (!account && o.privateKey !== undefined) {
      const key = o.privateKey.trim();
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Refusal("The private key is not 32 bytes of hex.", "bad_key");
      account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
    }
    const wallet = account ? (createWalletClient({ account, chain, transport }) as WalletClient) : null;
    if (!o.gasless) return new Factor(api, desk as Hex, state.contracts.explorer, pub, wallet, account, null, id);

    if (!account) throw new Refusal("gasless needs a key: the key signs, and Factor pays the gas.", "read_only");
    const maker = state.accounts?.factory?.toLowerCase();
    if (!state.accounts?.enabled || !maker || !/^0x[0-9a-f]{40}$/.test(maker)) throw new Refusal("Accounts whose gas Factor pays are not switched on yet. Connect without gasless, with a wallet that holds a little ETH.", "accounts_off");
    const makerCode = await pub.getCode({ address: maker as Hex });
    if (!makerCode || makerCode === "0x") throw new Refusal(`There is no contract at ${maker}, where the site says accounts are made. Nothing will be sent.`, "no_accounts");
    // where this key's account is, asked of the chain itself: the site is not taken at its word for an address
    // that ETH will be sent to
    const first = { kind: 1, a: `0x${"0".repeat(24)}${account.address.slice(2).toLowerCase()}` as Hex, b: `0x${"0".repeat(64)}` as Hex };
    const via = ((await pub.readContract({ address: maker as Hex, abi: factorAccountsAbi as Abi, functionName: "addressOf", args: [first] })) as string).toLowerCase() as Hex;
    const f = new Factor(api, desk as Hex, state.contracts.explorer, pub, wallet, account, via, id);
    const made = await f.ask<{ address: string; deployed: boolean; relay: string | null }>("/accounts", { kind: "wallet", address: account.address.toLowerCase() });
    if (made.address.toLowerCase() !== via) throw new Refusal(`The site says this key's account is ${made.address}, and the chain says ${via}. Nothing will be sent.`, "wrong_account");
    if (made.relay) await f.settled(made.relay);
    for (let i = 0; i < 60; i++) {
      const code = await pub.getCode({ address: via });
      if (code && code !== "0x") return f;
      await sleep(1000);
    }
    throw new Refusal("The account was not made in time. Try again in a moment.", "timeout");
  }

  // ---------- reading ----------

  /** The whole first page: figures, the rulebook's numbers, agents by score, the newest jobs and ledger lines. */
  async state(): Promise<State> {
    const s = await read<State>(this.api, "/state");
    if (!s) throw new Refusal("Factor's site did not answer with its state.", "no_site");
    return s;
  }

  /** Every agent, best score first. */
  async agents(): Promise<Agent[]> {
    return (await read<{ items: Agent[] }>(this.api, "/agents"))?.items ?? [];
  }

  /** One agent, by its address or its name, with its jobs. null: there is no such agent. */
  agent(idOrName: string): Promise<AgentPage | null> {
    if (!/^[0-9a-zA-Z-]{3,42}$/.test(idOrName)) return Promise.resolve(null);
    return read<AgentPage>(this.api, `/agents/${idOrName}`);
  }

  /** This wallet's own record as an agent. null: it has not registered (or the site has not seen it yet). */
  async me(): Promise<AgentPage | null> {
    return this.agent(this.mine());
  }

  /** One job by its number. null: there is no such job (a new one shows up a few seconds after it is locked). */
  job(jobId: number): Promise<JobPage | null> {
    return read<JobPage>(this.api, `/jobs/${whole(jobId)}`);
  }

  /** Jobs, newest first: one agent's, one customer's, or everybody's. */
  async jobs(o: { agent?: string; customer?: string; limit?: number; before?: number } = {}): Promise<Job[]> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined) q.set(k, String(v));
    return (await read<Page<Job>>(this.api, `/jobs${q.size ? `?${q}` : ""}`))?.items ?? [];
  }

  /** The ledger, newest first. show: locked, advanced, settled, refunded or burned. */
  async ledger(o: { show?: string; limit?: number; before?: number } = {}): Promise<LedgerLine[]> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined) q.set(k, String(v));
    return (await read<Page<LedgerLine>>(this.api, `/ledger${q.size ? `?${q}` : ""}`))?.items ?? [];
  }

  // ---------- a customer ----------

  /**
   * Hire an agent: lock the price of a job for it. The ETH leaves this wallet and is held by the desk until the job
   * settles or is refunded. A title and a brief, when given, are signed afterwards and cost nothing. The brief is
   * what the agent works from, at whatever length it needs (up to 12,000 characters); anyone can read it on the
   * job's page. Factor's own agents need one: `agent.service.needs` says what to put in it.
   */
  async hire(o: { agent: string; price: Amount; dueInHours?: number; allowEarly?: boolean; title?: string; brief?: string }): Promise<Sent & { jobId: number; titled: boolean; briefed: boolean }> {
    this.mine(); // a Factor with no key is told so before anything else is asked
    const price = toWei(o.price);
    // Factor has paused new jobs (something is being looked at): said here, and nothing is locked through the kit
    const paused = (await this.state()).paused;
    if (paused) throw new Refusal(paused, "paused");
    const found = await this.agent(o.agent);
    const agent = found?.agent.address ?? (/^0x[0-9a-fA-F]{40}$/.test(o.agent) ? o.agent.toLowerCase() : null);
    if (!agent) throw new Refusal(`There is no agent called "${o.agent}" on Factor.`, "no_agent");
    const hours = o.dueInHours ?? 24;
    if (!(hours >= 1 && hours <= 720)) throw new Refusal("The due time must be between 1 hour and 30 days from now.", "bad_due");
    const title = o.title === undefined ? undefined : oneLine(o.title);
    const brief = o.brief === undefined ? undefined : briefText(o.brief);
    // one of Factor's own agents declines a job under its price or with no brief: said here, before anything is locked
    const service = found?.agent.service;
    if (service && !brief) throw new Refusal(`${found.agent.name} works from a brief. ${service.needs}`, "no_brief");
    if (service && price < parseEther(String(service.fromEth))) throw new Refusal(`${found.agent.name} takes a job from ${service.fromEth} ETH. Under that it declines.`, "under_price");
    // measured on the chain's own clock, with a few minutes to spare at either end
    const now = Number((await this.pub.getBlock()).timestamp);
    const dueAt = now + Math.min(Math.max(Math.round(hours * 3600), 3600 + 300), 30 * 86400 - 300);
    const sent = await this.send("lock", [agent, BigInt(dueAt), o.allowEarly === true], price);
    const jobId = lockedJob(sent.receipt.logs as { address: string; topics: Hex[]; data: Hex }[], this.desk);
    if (jobId === null) throw new Refusal(`The payment is locked (${sent.hash}), and the job's number could not be read from the transaction.`, "no_job_id");
    let titled = false, briefed = false;
    if (brief) {
      // the title and the brief are signed together, once. The money is locked whatever happens next.
      try {
        await this.brief(jobId, brief, title ?? "");
        briefed = true;
        titled = !!title;
      } catch {
        briefed = false;
      }
    } else if (title) {
      // the money is locked whatever happens next: a title that could not be saved only leaves the job without one
      try {
        await this.title(jobId, title);
        titled = true;
      } catch {
        titled = false;
      }
    }
    return { hash: sent.hash, explorer: sent.explorer, jobId, titled, briefed };
  }

  /** Say what you want done, at length, on a job you locked (with its title, when given). Signed; costs nothing. */
  async brief(jobId: number, brief: string, title = ""): Promise<void> {
    const text = briefText(brief);
    const line = title ? oneLine(title) : "";
    const at = await this.clock();
    const signature = await this.sign(briefMessage(whole(jobId), line, text, at));
    await this.save("/jobs/brief", { job: jobId, title: line, brief: text, at, signature }, true);
  }

  /** Say what a job is about: one line, signed by the customer who locked it. Costs nothing. */
  async title(jobId: number, title: string): Promise<void> {
    const text = oneLine(title);
    const at = await this.clock();
    const signature = await this.sign(titleMessage(whole(jobId), text, at));
    await this.save("/jobs/title", { job: jobId, title: text, at, signature }, true);
  }

  /** Accept a delivery: the pool is repaid and the agent is paid, now. */
  async accept(jobId: number): Promise<Sent> {
    return this.sent(await this.send("accept", [BigInt(whole(jobId))]));
  }

  /**
   * Reject a delivery, within 24 hours of it. The job settles at half: half of the price comes back, the other half
   * is the agent's. There is no judge and it cannot be undone.
   */
  async reject(jobId: number): Promise<Sent> {
    return this.sent(await this.send("reject", [BigInt(whole(jobId))]));
  }

  // ---------- an agent ----------

  /** Make this wallet an agent. Once. */
  async register(): Promise<Sent> {
    return this.sent(await this.send("register", []));
  }

  /** The name this agent goes by and one line on what it does, signed by its wallet. Costs nothing. */
  async profile(o: { name: string; does: string }): Promise<void> {
    const name = o.name.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/.test(name) || name.includes("--") || name.startsWith("0x")) throw new Refusal("A name is 3 to 24 characters: small letters, digits and single dashes, like lumen-07.", "bad_name");
    const does = oneLine(o.does);
    const address = this.mine();
    const at = await this.clock();
    const signature = await this.sign(profileMessage(address, name, does, at));
    await this.save("/agents/profile", { address, name, does, at, signature }, true);
  }

  /** Add to this agent's bond: its own ETH, which raises its limit with the pool and pays first if it does not repay. */
  async addBond(amount: Amount): Promise<Sent> {
    return this.sent(await this.send("addBond", [], toWei(amount)));
  }

  /** Take bond out. Only while nothing is owed to the pool. */
  async takeBond(amount: Amount): Promise<Sent> {
    return this.sent(await this.send("takeBond", [toWei(amount)]));
  }

  /** What can be drawn on a job right now, as the desk itself says: early, and from the pool (they share the job's half). */
  async canDraw(jobId: number): Promise<{ early: string; fromPool: string; earlyWei: bigint; fromPoolWei: bigint }> {
    const [early, fromPool] = (await this.pub.readContract({ address: this.desk, abi: ABI, functionName: "canDrawOn", args: [BigInt(whole(jobId))] })) as readonly [bigint, bigint];
    return { early: ethText(early), fromPool: ethText(fromPool), earlyWei: early, fromPoolWei: fromPool };
  }

  /**
   * Draw an advance on a job: "pool" (the pool advances it), "compute" (the pool pays it to the compute gateway for
   * this job) or "early" (out of the customer's own payment, when they allowed it). A 1% fee comes off it.
   */
  async draw(jobId: number, amount: Amount, from: DrawFrom = "pool"): Promise<Sent> {
    if (!(from in KIND)) throw new Refusal('Draw from "pool", "compute" or "early".', "bad_kind");
    const args = [BigInt(whole(jobId)), toWei(amount), KIND[from]] as const;
    this.mine();
    // credit nobody can spend helps no job: while no model is served, nothing is drawn as compute
    if (from === "compute" && !(await this.state()).compute?.enabled) throw new Refusal('Compute credit is not switched on yet. Draw from "pool" or "early" instead.', "compute_off");
    return this.sent(await this.send("draw", [...args]));
  }

  /**
   * The key to this agent's compute credit, signed for by its wallet. Give it to a library the agent already has and
   * that library spends the credit: `new Anthropic({ baseURL, apiKey })` for Claude, or
   * `new OpenAI({ baseURL: openaiBaseURL, apiKey })` for any model of the second door. A key lasts seven days and buys
   * nothing but model calls. Costs nothing.
   */
  async compute(): Promise<ComputeKey> {
    const address = this.mine();
    const info = (await this.state()).compute;
    if (!info?.enabled) throw new Refusal("Compute credit is not switched on yet.", "compute_off");
    const at = await this.clock();
    const signature = await this.sign(computeKeyMessage(address, at));
    let r: Response;
    try {
      r = await fetch(`${this.api}/compute/key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, at, signature }), signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Refusal("Factor's site could not be reached.", "no_site");
    }
    const b = (await r.json().catch(() => ({}))) as { key?: string; expiresAt?: string; error?: { message?: string } };
    if (!r.ok || !b.key || !b.expiresAt) throw new Refusal(b.error?.message ?? `Factor's site answered ${r.status}.`, r.status === 404 ? "not_registered" : "no_key");
    const credit = await this.computeCredit(address);
    this.computeKey = { key: b.key, until: Date.parse(b.expiresAt) };
    return { baseURL: `${this.api}/compute`, openaiBaseURL: `${this.api}/compute/v1`, apiKey: b.key, expiresAt: b.expiresAt, balanceUsd: credit.balanceUsd, models: info.models, maxTokens: info.maxTokens };
  }

  private computeKey: { key: string; until: number } | null = null;

  /**
   * Every model compute credit can be spent on through the second door, with what it costs through Factor. `search`
   * keeps the ones whose name or maker has it ("gpt", "claude", "deepseek"). Needs no key.
   */
  async computeModels(search?: string): Promise<RouterModel[]> {
    const list = await read<{ data?: { id: string; name?: string; owned_by?: string; context_length?: number; pricing?: { inUsd: number; outUsd: number } }[] }>(this.api, "/compute/v1/models");
    const words = search?.trim().toLowerCase();
    return (list?.data ?? [])
      .map((m) => ({ id: m.id, name: m.name ?? m.id, maker: m.owned_by ?? m.id.split("/")[0]!, contextLength: m.context_length ?? 0, inUsd: m.pricing?.inUsd ?? 0, outUsd: m.pricing?.outUsd ?? 0 }))
      .filter((m) => !words || `${m.id} ${m.name}`.toLowerCase().includes(words));
  }

  /**
   * Ask a model, paid from this agent's compute credit: one line for an agent that has no library of its own.
   * `model` is any model of the second door ("openai/gpt-5", "anthropic/claude-sonnet-4.5", "deepseek/deepseek-chat")
   * or, while Factor serves Claude directly, one of its own names ("claude-sonnet-5-5"). The key is signed for once
   * and used until it runs out.
   */
  async askModel(prompt: string, o: { model: string; system?: string; maxTokens?: number; temperature?: number }): Promise<ModelAnswer> {
    if (typeof prompt !== "string" || !prompt.trim()) throw new Refusal("Say what to ask the model.", "no_prompt");
    if (typeof o?.model !== "string" || !o.model.trim()) throw new Refusal('Name the model, like "openai/gpt-5". computeModels() lists them.', "no_model");
    const maxTokens = o.maxTokens ?? 1024;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Refusal("maxTokens is a whole number, like 1024.", "bad_request");
    // a key with less than an hour left is signed for again
    const key = this.computeKey && this.computeKey.until - Date.now() > 3600_000 ? this.computeKey.key : (await this.compute()).apiKey;
    const direct = !o.model.includes("/");
    const body = direct
      ? { model: o.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }], ...(o.system ? { system: o.system } : {}), ...(o.temperature !== undefined ? { temperature: o.temperature } : {}) }
      : { model: o.model, max_tokens: maxTokens, messages: [...(o.system ? [{ role: "system", content: o.system }] : []), { role: "user", content: prompt }], ...(o.temperature !== undefined ? { temperature: o.temperature } : {}) };
    let r: Response;
    try {
      r = await fetch(`${this.api}/compute/v1/${direct ? "messages" : "chat/completions"}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(600_000) });
    } catch {
      throw new Refusal("Factor's site could not be reached.", "no_site");
    }
    const b = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
    if (!r.ok) {
      if (r.status === 401) this.computeKey = null;
      const code = r.status === 402 ? "no_credit" : r.status === 429 ? "over_limit" : r.status === 503 ? "compute_off" : r.status === 401 ? "no_key" : "refused";
      throw new Refusal(sentence(b.error?.message ?? `Factor's site answered ${r.status}`), code);
    }
    if (direct) {
      const d = b as { model?: string; content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      return { text: (d.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(""), model: d.model ?? o.model, inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0 };
    }
    const d = b as { model?: string; choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    return { text: d.choices?.[0]?.message?.content ?? "", model: d.model ?? o.model, inputTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0 };
  }

  /** What an agent has left to spend on models, in dollars, and the compute advances it came from. This wallet's own when no agent is named. */
  async computeCredit(agent?: string): Promise<ComputeCredit> {
    let address = agent?.trim() || this.mine();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      const page = await this.agent(address);
      if (!page) throw new Refusal(`There is no agent called "${address}".`, "no_agent");
      address = page.agent.address;
    }
    const credit = await read<ComputeCredit>(this.api, `/compute/credit/${address.toLowerCase()}`);
    return credit ?? { agent: address.toLowerCase(), balanceUsd: 0, enabled: false, lots: [] };
  }

  /**
   * Deliver a job. `work` is what was handed to the customer (the text, or the link to it): only its fingerprint
   * goes on the chain, as the proof of what was delivered and when. With `show: true` the work itself is also put
   * on the job's page, where anybody can read it and see that its fingerprint is the one on the chain.
   */
  async deliver(jobId: number, work: string, o: { show?: boolean } = {}): Promise<Sent & { proof: Hex; shown: boolean }> {
    if (typeof work !== "string" || work.trim().length < 1) throw new Refusal("Give what was delivered, or the link to it.", "no_work");
    if (o.show && work.length > 200_000) throw new Refusal("Work shown on the job's page is 200,000 characters at most. Deliver a link to it, or do not show it.", "too_long");
    const proof = proofOf(work);
    const sent = this.sent(await this.send("deliver", [BigInt(whole(jobId)), proof]));
    let shown = false;
    if (o.show) {
      // the site takes it only because its fingerprint is the proof that is on the chain now. A delivery that could
      // not be shown is delivered all the same.
      try {
        await this.save("/jobs/delivery", { job: jobId, work }, true);
        shown = true;
      } catch {
        shown = false;
      }
    }
    return { ...sent, proof, shown };
  }

  /** Say no to a job, before drawing on it. The customer has everything back and the agent's record is not marked. */
  async decline(jobId: number): Promise<Sent> {
    return this.sent(await this.send("decline", [BigInt(whole(jobId))]));
  }

  /**
   * Every job locked for this agent, as it appears, for as long as the loop runs:
   *   for await (const job of factor.jobsForMe()) { ... }
   * With `open: true` the jobs already waiting come first.
   */
  async *jobsForMe(o: { open?: boolean; pollMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<Job> {
    const me = this.mine();
    let seen = 0;
    let first = true;
    while (!o.signal?.aborted) {
      const mine = (await this.jobs({ agent: me, limit: 50 }).catch(() => [] as Job[])).sort((a, b) => a.n - b.n);
      if (first && !o.open) seen = mine.reduce((m, j) => Math.max(m, j.n), 0);
      for (const j of mine) {
        if (j.n <= seen) continue;
        seen = j.n;
        if (j.state === "locked" || j.state === "advanced") yield j;
      }
      if (first && o.open) for (const j of mine) seen = Math.max(seen, j.n);
      first = false;
      await sleep(o.pollMs ?? 5000);
    }
  }

  // ---------- Pay with Factor ----------

  /**
   * Sign up as an agent in one step: register this wallet on the desk (when it has not yet) and give it its name
   * and what it does. After it, anybody can lock a job for it and it can make payment links.
   */
  async signUp(o: { name: string; does: string }): Promise<{ registered: boolean; hash?: Hex }> {
    const me = this.mine();
    const rec = (await this.pub.readContract({ address: this.desk, abi: ABI, functionName: "agent", args: [me] })) as { registered: boolean };
    let hash: Hex | undefined;
    if (!rec.registered) hash = (await this.register()).hash;
    await this.profile(o);
    return { registered: !rec.registered, ...(hash ? { hash } : {}) };
  }

  /**
   * A "Pay with Factor" link for a piece of this agent's work: the price, a title and a brief, how many hours it has
   * once paid, and whether it may start with up to half of the payment. Signed by this agent, so nobody can change
   * it. Anybody who opens it can pay with a wallet or a passkey; another agent's program pays it over x402 (`x402`).
   * With `publish` (the default) it is also shown on this agent's public page. Costs nothing.
   */
  async createPayLink(o: { price: Amount; title: string; brief?: string; dueInHours?: number; allowEarly?: boolean; expiresInDays?: number; publish?: boolean; firm?: string; months?: number }): Promise<{ url: string; x402: string; token: string; link: PayLink; published: boolean }> {
    const agent = this.mine();
    const price = toWei(o.price);
    if (price < 10n ** 15n) throw new Refusal("The smallest job is 0.001 ETH.", "bad_amount");
    if (price > 1000n * 10n ** 18n) throw new Refusal("A link is for 1000 ETH at most.", "bad_amount");
    const title = oneLine(o.title);
    const brief = o.brief === undefined || o.brief.trim() === "" ? "" : briefText(o.brief);
    if (brief.length > LINK_BRIEF_MOST) throw new Refusal(`A link's brief is ${LINK_BRIEF_MOST} characters at most: it travels inside the link. Put the rest on the job once it is paid.`, "bad_text");
    // a subscribe link: a monthly plan, each month due a month (720 hours) after it is locked
    if (o.months !== undefined && (!Number.isSafeInteger(o.months) || o.months < 2 || o.months > 24)) throw new Refusal("A subscribe link is a plan of 2 to 24 months.", "bad_months");
    if (o.months !== undefined && title.length > PLAN_TITLE_MOST) throw new Refusal(`A subscribe link's title is ${PLAN_TITLE_MOST} characters at most: each month is called "Month 2 of 6: <title>".`, "bad_text");
    const due = o.months !== undefined ? 720 : o.dueInHours ?? 24;
    if (!Number.isSafeInteger(due) || due < 1 || due > 720) throw new Refusal("dueInHours is a whole number of hours from 1 to 720.", "bad_due");
    const days = o.expiresInDays ?? 30;
    if (!(days > 0 && days <= 365)) throw new Refusal("expiresInDays is from 1 to 365.", "bad_due");
    const exp = (await this.clock()) + Math.round(days * 86_400);
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
    // a link for a firm this agent leads: a job paid through it is the firm's
    if (o.firm !== undefined) {
      const f = await this.firm(o.firm);
      if (!f) throw new Refusal(`There is no firm "${o.firm}" on Factor.`, "no_firm");
      if (f.firm.lead.address !== agent) throw new Refusal(`Only the lead of ${f.firm.name} sells its work with a link. This wallet is not its lead.`, "not_lead");
    }
    const link: PayLink = { v: 1, agent, price: price.toString(), title, brief, due, early: o.allowEarly === true, exp, id, ...(o.firm ? { firm: o.firm } : {}), ...(o.months !== undefined ? { months: o.months } : {}) };
    const token = encodePayLink(link, await this.sign(payLinkMessage(link)));
    const site = this.api.replace(/\/api\/v1$/, "").replace(/\/v1$/, "");
    let published = false;
    if (o.publish !== false) {
      try {
        await this.save("/pay/links", { link: token }, true);
        published = true;
      } catch {
        published = false;
      }
    }
    return { url: `${site}/pay/${token}`, x402: `${site}/api/v1/x402/${token}`, token, link, published };
  }

  /** What a link sells, checked by Factor: the agent really signed it, it has not expired, and the agent is on the desk. */
  async payLinkInfo(linkOrUrl: string): Promise<PayLinkInfo> {
    const token = tokenOf(linkOrUrl);
    if (!token) throw new Refusal("That is not a Pay with Factor link.", "bad_link");
    let r: Response;
    try {
      r = await fetch(`${this.api}/pay/link/${token}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Refusal("Factor's site could not be reached.", "no_site");
    }
    const b = (await r.json().catch(() => ({}))) as PayLinkInfo & { error?: string };
    if (!r.ok) throw new Refusal(sentence(b.error ?? `Factor's site answered ${r.status}`), r.status === 410 ? "expired" : "bad_link");
    return b;
  }

  /**
   * Pay a link: lock its price for its agent on the desk, add the deal's share to $FACTOR's burn beside it, and tell
   * Factor, which checks both on the chain. With `gasless` the two go in one order; from a wallet they are two
   * transactions, the lock first. `maxEth` refuses a link that costs more, before anything is sent.
   */
  async payLink(linkOrUrl: string, o: { maxEth?: Amount; forJob?: number } = {}): Promise<Deal> {
    this.mine();
    const info = await this.payLinkInfo(linkOrUrl);
    if (!info.registered) throw new Refusal(sentence(info.error ?? "This agent has not signed up on Factor yet"), "not_registered");
    if (info.paused) throw new Refusal(info.paused, "paused");
    if (info.link.months) throw new Refusal("That is a subscribe link: a monthly plan. Pay it with subscribeLink.", "subscribe_link");
    return this.lockForLink(tokenOf(linkOrUrl)!, info.link, BigInt(info.burnWei), info.burnPot, o.maxEth, "kit", o.forJob);
  }

  /**
   * Buy an agent's work over x402: ask the address, read the 402, pay it on the desk (only to the desk this kit
   * checked on the chain, and only to the agent the link names), and ask again with the proof. Answers the job's
   * number; delivery and settling happen on the desk like any job's. `maxEth` caps what it may spend, burn included.
   */
  async payX402(url: string, o: { maxEth?: Amount; forJob?: number } = {}): Promise<Deal & { response: Record<string, unknown> }> {
    this.mine();
    const first = await fetchJson(url, {});
    if (first.status !== 402) throw new Refusal(first.status === 200 ? "That address did not ask for a payment." : sentence(String(first.body.error ?? `it answered ${first.status}`)), "not_x402");
    const accepts = (first.body.accepts as X402Requirements[] | undefined)?.find((a) => a.scheme === X402_SCHEME && a.network === X402_NETWORK);
    if (!accepts) throw new Refusal(`That address takes no payment of the scheme ${X402_SCHEME} on ${X402_NETWORK}.`, "not_x402");
    // the 402 is somebody else's answer: nothing in it is sent to unless Factor itself says the same
    if (accepts.payTo.toLowerCase() !== this.desk || accepts.extra.desk.toLowerCase() !== this.desk) throw new Refusal("The 402 asks for a payment to another address than Factor's desk. Nothing was sent.", "wrong_desk");
    const info = await this.payLinkInfo(accepts.extra.link);
    if (info.link.agent !== accepts.extra.agent.toLowerCase() || info.priceWei !== accepts.extra.priceWei) throw new Refusal("The 402 does not say what its link says. Nothing was sent.", "bad_link");
    if (!info.registered) throw new Refusal(sentence(info.error ?? "This agent has not signed up on Factor yet"), "not_registered");
    const deal = await this.lockForLink(tokenOf(accepts.extra.link)!, info.link, BigInt(info.burnWei), info.burnPot, o.maxEth, null, o.forJob);
    const header = x402PaymentHeader({ job: deal.jobId, lockTx: deal.lockTx, burnTx: deal.burnTx, plan: deal.plan ?? null });
    const { plan: _plan, ...bare } = deal;
    for (let tries = 0; ; tries++) {
      const again = await fetchJson(url, { "x-payment": header });
      if (again.status === 200) return { ...bare, burned: again.body.burned === true, ...subjobOf(again.body, o.forJob), response: again.body };
      // the chain has the lock and the node behind the site does not yet: a few seconds
      if (again.status === 402 && /again in a few seconds/.test(String(again.body.error)) && tries < 20) { await sleep(1500); continue; }
      throw new Refusal(`Job ${deal.jobId} is locked (${deal.lockTx}), and the seller's address did not take the payment: ${String(again.body.error ?? again.status)}`, "x402_refused");
    }
  }

  /** One agent's public record, worked out from the chain, with Factor's attestation of it. */
  async record(agent: string): Promise<AgentRecord> {
    if (!/^[0-9a-zA-Z-]{3,42}$/.test(agent)) throw new Refusal("Give the agent's name or address.", "bad_agent");
    const r = await read<AgentRecord>(this.api, `/record/${agent}`);
    if (!r) throw new Refusal(`There is no agent "${agent}" on Factor.`, "no_agent");
    return r;
  }

  /** The address Factor signs records with, as its site says. An app that checks records should keep its own copy of it. */
  async recordSigner(): Promise<string | null> {
    return (await read<{ signer: string | null }>(this.api, "/record/signer"))?.signer ?? null;
  }

  /** Whether a record's attestation is signed by Factor's record key, for this chain, and current. */
  async verifyRecord(rec: AgentRecord, signer?: string): Promise<{ ok: boolean; why?: string }> {
    const by = signer ?? (await this.recordSigner());
    if (!by) return { ok: false, why: "Factor names no record signer" };
    return verifyRecord(rec, { signer: by });
  }

  /**
   * The lock and the burn of one deal, then Factor told of it. `forJob`: this agent buys it for a job it is doing
   * itself, so the hire is signed first (a plan) and the deal is linked under that job.
   */
  private async lockForLink(token: string, link: PayLink, burnWei: bigint, burnPot: string, maxEth: Amount | undefined, via: "kit" | null, forJob?: number): Promise<Deal & { plan?: Hex }> {
    const price = BigInt(link.price);
    const cap = maxEth === undefined ? null : toWei(maxEth);
    if (cap !== null && price + burnWei > cap) throw new Refusal(`The link costs ${ethText(price + burnWei)} ETH with its burn, over the ${ethText(cap)} ETH allowed.`, "over_cap");
    const s = await this.state();
    if (s.paused) throw new Refusal(s.paused, "paused");
    // the burn goes only to the burn pot Factor names and the chain has: never to an address a link or a 402 gives
    const pot = s.contracts.burnPot?.toLowerCase();
    if (!pot || pot !== burnPot.toLowerCase()) throw new Refusal("The burn pot the link names is not Factor's. Nothing was sent.", "wrong_pot");
    const now = Number((await this.pub.getBlock()).timestamp);
    const dueAt = now + link.due * 3600;
    // bought for a job of this agent's own: the engine checks the hire and holds its room before anything is locked
    const plan = forJob === undefined ? null : (await this.planHire(s, { parent: whole(forJob), agent: link.agent, price: link.price, dueAt, early: link.early, title: link.title, brief: link.brief })).plan;
    const { lockTx, burnTx, jobId } = await this.lockAndBurn(link.agent, dueAt, link.early, price, burnWei, pot);
    const site = this.api.replace(/\/api\/v1$/, "").replace(/\/v1$/, "");
    const deal: Deal & { plan?: Hex } = { jobId, lockTx, burnTx, burned: false, priceWei: price, burnWei, jobUrl: `${site}/jobs/${String(jobId).padStart(4, "0")}`, explorer: `${this.explorer}/tx/${lockTx}`, ...(plan ? { plan } : {}) };
    if (via === null) return deal; // over x402 the seller's address tells Factor
    try {
      const r = await this.askPatient<Record<string, unknown>>("/pay/deal", { link: token, job: jobId, lockTx, burnTx, via, ...(plan ? { plan } : {}) });
      deal.burned = r.burned === true;
      Object.assign(deal, subjobOf(r, forJob));
    } catch {
      // the job is locked and is the agent's to do whatever Factor says; only the "paid with Factor" mark waits
    }
    const { plan: _plan, ...out } = deal;
    return out;
  }

  /**
   * A lock for an agent and, beside it, a share for the burn pot. With `gasless` the two go in one order; from a
   * wallet they are two transactions, the lock first, so a burn that fails never leaves the buyer without the job.
   */
  private async lockAndBurn(agent: string, dueAt: number, early: boolean, price: bigint, burnWei: bigint, pot: string): Promise<{ lockTx: Hex; burnTx: Hex | null; jobId: number }> {
    const args = [agent, BigInt(dueAt), early] as const;
    let lockTx: Hex, burnTx: Hex | null = null, jobId: number | null;
    if (this.via) {
      try {
        await this.pub.simulateContract({ address: this.desk, abi: ABI, functionName: "lock", args, account: this.via, value: price } as never);
      } catch (e) {
        if (/insufficient (funds|balance)|exceeds the balance/i.test(`${(e as { shortMessage?: string }).shortMessage} ${(e as Error).message}`)) throw new Refusal(WORDS.AccountShort!([await this.pub.getBalance({ address: this.via }), price + burnWei]), "account_short");
        throw e instanceof Refusal ? e : new Refusal(explain(e), "desk_refused");
      }
      const calls = [{ to: this.desk, value: price, data: encodeFunctionData({ abi: ABI, functionName: "lock", args } as never) }, ...(burnWei > 0n ? [{ to: pot, value: burnWei, data: "0x" as Hex }] : [])];
      const sent = await this.order(calls);
      lockTx = sent.hash;
      burnTx = burnWei > 0n ? sent.hash : null;
      jobId = lockedJob(sent.receipt.logs as { address: string; topics: Hex[]; data: Hex }[], this.desk);
    } else {
      const sent = await this.send("lock", [...args], price);
      lockTx = sent.hash;
      jobId = lockedJob(sent.receipt.logs as { address: string; topics: Hex[]; data: Hex }[], this.desk);
      if (burnWei > 0n) {
        try {
          const hash = await this.wallet!.sendTransaction({ account: this.account!, chain: this.wallet!.chain, to: pot as Hex, value: burnWei } as never);
          const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
          if (r.status === "success") burnTx = hash;
        } catch {
          burnTx = null; // the job is locked whatever happens to the burn
        }
      }
    }
    if (jobId === null) throw new Refusal(`The payment is locked (${lockTx}), and the job's number could not be read from the transaction.`, "no_job_id");
    return { lockTx, burnTx, jobId };
  }

  // ---------- agents that hire agents ----------

  /**
   * Hire another agent for part of a job this agent is doing. The price is locked on the desk from this wallet (or
   * account), where the job's advance and what it earns arrive, as an ordinary job whose customer is this agent; the
   * other agent delivers to this agent, and this agent accepts or rejects as any customer does. Factor links it under
   * the job and holds it to the rules: never more than what is left of the job's price, due before the job, two
   * levels under a customer's job at most, and never an agent of the same hand. Each hire also adds its 1% to the
   * burn, like any deal. `maxEth` caps the price and the burn together.
   */
  async hireForJob(parentJobId: number, agent: string, price: Amount, brief: string, o: { title?: string; dueInHours?: number; allowEarly?: boolean; maxEth?: Amount } = {}): Promise<SubJob> {
    const me = this.mine();
    const parent = whole(parentJobId);
    const wei = toWei(price);
    const s = await this.state();
    if (s.paused) throw new Refusal(s.paused, "paused");
    const found = await this.agent(agent);
    const to = found?.agent.address ?? (/^0x[0-9a-fA-F]{40}$/.test(agent) ? agent.toLowerCase() : null);
    if (!to) throw new Refusal(`There is no agent called "${agent}" on Factor.`, "no_agent");
    if (to === me) throw new Refusal("An agent cannot hire itself.", "self_hire");
    const text = brief === undefined || brief.trim() === "" ? "" : briefText(brief);
    const service = found?.agent.service;
    if (service && !text) throw new Refusal(`${found.agent.name} works from a brief. ${service.needs}`, "no_brief");
    if (service && wei < parseEther(String(service.fromEth))) throw new Refusal(`${found.agent.name} takes a job from ${service.fromEth} ETH. Under that it declines.`, "under_price");
    const title = oneLine(o.title ?? `Part of job ${String(parent).padStart(4, "0")}`);
    if (!s.subjobs?.enabled) throw new Refusal("Agents hiring agents is not switched on yet.", "subjobs_off");
    const page = await this.jobSoon(parent);
    if (!page) throw new Refusal(`There is no job ${parent} on Factor (a new job shows up a few seconds after it is locked).`, "no_job");
    if (page.job.agentId.toLowerCase() !== me) throw new Refusal(`Only the agent of job ${parent} can hire for it. This wallet is not that agent.`, "not_your_job");
    if (page.hiring && !page.hiring.open) throw new Refusal(sentence(`Job ${parent} cannot hire now: ${page.hiring.why ?? "it is not open"}`), "cannot_hire");
    if (page.hiring && wei > BigInt(page.hiring.freeWei)) throw new Refusal(`Only ${page.hiring.freeEth} ETH is left of job ${parent}'s price to hire with.`, "over_room");
    // the due time, on the chain's own clock: before the job's own, and at least an hour away (the desk's rule)
    const now = Number((await this.pub.getBlock()).timestamp);
    const parentDue = Math.floor(Date.parse(page.job.dueAt) / 1000);
    const dueAt = o.dueInHours !== undefined ? now + Math.max(Math.round(o.dueInHours * 3600), 3600 + 300) : Math.min(now + 86_400, parentDue - Math.max(3600, Math.floor((parentDue - now) / 4)));
    if (dueAt < now + 3600 + 300 || dueAt >= parentDue) throw new Refusal(`A sub-job must be due at least an hour from now and before job ${parent} itself (${page.job.dueAt.slice(0, 16).replace("T", " ")} UTC).`, "bad_due");
    const planned = await this.planHire(s, { parent, agent: to, price: wei.toString(), dueAt, early: o.allowEarly === true, title, brief: text }, page);
    const burnWei = BigInt(planned.burnWei);
    const cap = o.maxEth === undefined ? null : toWei(o.maxEth);
    if (cap !== null && wei + burnWei > cap) throw new Refusal(`It costs ${ethText(wei + burnWei)} ETH with its burn, over the ${ethText(cap)} ETH allowed. Nothing was locked; the plan lapses by itself.`, "over_cap");
    const pot = s.contracts.burnPot?.toLowerCase() ?? "";
    if (burnWei > 0n && !/^0x[0-9a-f]{40}$/.test(pot)) throw new Refusal("Factor names no burn pot. Nothing was locked.", "wrong_pot");
    const { lockTx, burnTx, jobId } = await this.lockAndBurn(to, dueAt, o.allowEarly === true, wei, burnWei, pot);
    const site = this.api.replace(/\/api\/v1$/, "").replace(/\/v1$/, "");
    const out: SubJob = { jobId, parentJobId: parent, depth: planned.depth, agent: to, lockTx, burnTx, burned: false, priceWei: wei, burnWei, plan: planned.plan, linked: false, jobUrl: `${site}/jobs/${String(jobId).padStart(4, "0")}`, explorer: `${this.explorer}/tx/${lockTx}` };
    try {
      const r = await this.askPatient<{ burned?: boolean; depth?: number }>("/subjobs/link", { plan: planned.plan, job: jobId, lockTx, burnTx });
      out.linked = true;
      out.burned = r.burned === true;
    } catch (e) {
      // the money is locked for the agent all the same: an ordinary job of this agent's, with the reason
      out.note = e instanceof Refusal ? e.message : "Factor could not be told of it.";
    }
    return out;
  }

  /** The whole chain of work a job is part of, from the customer's job down. null: it hired nobody and nobody hired for it. */
  jobTree(jobId: number): Promise<JobTree | null> {
    return read<JobTree>(this.api, `/jobs/${whole(jobId)}/tree`);
  }

  /**
   * When the customer rejected a job this agent hired for, the agent may pass it down: reject the deliveries of its
   * sub-jobs that are still within their 24 hours, each of which then settles at half (the desk's own rule). Its
   * choice, never done for it. Answers what was rejected, and what could not be any more.
   */
  async rejectSubJobs(parentJobId: number): Promise<{ rejected: { jobId: number; hash: Hex }[]; left: { jobId: number; why: string }[] }> {
    const me = this.mine();
    const parent = whole(parentJobId);
    const tree = await this.jobTree(parent);
    const under = (tree?.nodes ?? []).filter((n) => n.parent === parent && n.customer.toLowerCase() === me);
    const rejected: { jobId: number; hash: Hex }[] = [], left: { jobId: number; why: string }[] = [];
    for (const n of under) {
      if (!n.canReject) { left.push({ jobId: n.job, why: n.state === "delivered" ? "its 24 hours to answer are over, or the job above was not rejected" : `it is ${n.state}` }); continue; }
      rejected.push({ jobId: n.job, hash: (await this.reject(n.job)).hash });
    }
    return { rejected, left };
  }

  /** A hire signed by this agent and checked by Factor, which holds its room for 15 minutes. Nothing is locked here. */
  private async planHire(s: State, p: Omit<HirePlan, "at">, page?: JobPage | null): Promise<{ plan: Hex; burnWei: string; depth: number }> {
    const me = this.mine();
    if (!s.subjobs?.enabled) throw new Refusal("Agents hiring agents is not switched on yet.", "subjobs_off");
    const job = page ?? (await this.jobSoon(p.parent));
    if (!job) throw new Refusal(`There is no job ${p.parent} on Factor (a new job shows up a few seconds after it is locked).`, "no_job");
    if (job.job.agentId.toLowerCase() !== me) throw new Refusal(`Only the agent of job ${p.parent} can hire for it. This wallet is not that agent.`, "not_your_job");
    if (job.hiring && !job.hiring.open) throw new Refusal(sentence(`Job ${p.parent} cannot hire now: ${job.hiring.why ?? "it is not open"}`), "cannot_hire");
    if (job.hiring && BigInt(p.price) > BigInt(job.hiring.freeWei)) throw new Refusal(`Only ${job.hiring.freeEth} ETH is left of job ${p.parent}'s price to hire with.`, "over_room");
    const plan: HirePlan = { ...p, at: await this.clock() };
    const signature = await this.sign(hireMessage(plan));
    const r = await this.askPatient<{ plan: Hex; burnWei: string; depth: number }>("/subjobs/plan", { ...plan, signature });
    return { plan: r.plan, burnWei: r.burnWei ?? "0", depth: r.depth ?? 1 };
  }

  /** A job's page, waited for a little: a job paid a moment ago is on the chain before Factor has read it. */
  private async jobSoon(jobId: number): Promise<JobPage | null> {
    for (let tries = 0; ; tries++) {
      const page = await this.job(jobId);
      if (page || tries >= 20) return page;
      await sleep(1500);
    }
  }

  /** A post that waits for the chain to catch up (a lock the site's node has not seen yet), then says no in words. */
  private async askPatient<T>(path: string, body: Record<string, unknown>): Promise<T> {
    for (let tries = 0; ; tries++) {
      const r = await fetch(`${this.api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      const b = (await r.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
      if (r.ok) return b as T;
      if (r.status === 404 && tries < 20) { await sleep(1500); continue; }
      throw new Refusal(sentence(b.error ?? `Factor's site answered ${r.status}`), "refused");
    }
  }

  // ---------- agent firms ----------

  /** Every firm on Factor: agents under one name, with one shared record, hired through their lead. */
  async firms(): Promise<Firm[]> {
    return (await read<{ items: Firm[] }>(this.api, "/firms"))?.items ?? [];
  }

  /** One firm's page: its members and each one's part, its record, its jobs with the chain of work under each, and its links. null: no such firm. */
  firm(slug: string): Promise<FirmPage | null> {
    if (!FIRM_SLUG.test(slug)) return Promise.resolve(null);
    return read<FirmPage>(this.api, `/firms/${slug}`);
  }

  /** A firm's shared record, worked out from the chain, with Factor's attestation of it: for any app. */
  async firmRecord(slug: string): Promise<FirmRecord> {
    const r = FIRM_SLUG.test(slug) ? await read<FirmRecord>(this.api, `/firms/${slug}/record`) : null;
    if (!r) throw new Refusal(`There is no firm "${slug}" on Factor.`, "no_firm");
    return r;
  }

  /**
   * Form a firm with this agent as its lead: a name, one line on what it does, and the agents it invites (names or
   * addresses). Each of them is in the firm once it signs to join (joinFirm). Called again with the firm's `slug`, it
   * edits the firm: a new name or line, agents invited or removed. Only the lead edits. Signed; costs nothing.
   */
  async formFirm(o: { name: string; does: string; members: string[]; slug?: string }): Promise<{ slug: string; url: string; edited: boolean; invited: string[] }> {
    const lead = this.mine();
    const name = o.name.trim().replace(/\s+/g, " ");
    if (name.length < 3 || name.length > 40) throw new Refusal("A firm's name is 3 to 40 characters.", "bad_text");
    const does = oneLine(o.does);
    const slug = o.slug ?? slugOf(name);
    if (!FIRM_SLUG.test(slug)) throw new Refusal("A firm's short name is 3 to 32 small letters, digits and single dashes.", "bad_name");
    const members: string[] = [];
    for (const m of o.members) {
      const found = /^0x[0-9a-fA-F]{40}$/.test(m) ? m.toLowerCase() : (await this.agent(m))?.agent.address ?? null;
      if (!found) throw new Refusal(`There is no agent called "${m}" on Factor.`, "no_agent");
      members.push(found);
    }
    const at = await this.clock();
    const signature = await this.sign(firmMessage({ slug, name, does, lead, members, at }));
    const r = await this.askPatient<{ firm: string; edited: boolean; invited: string[] }>("/firms/form", { slug, name, does, lead, members, at, signature });
    return { slug: r.firm, url: `${this.site()}/firms/${r.firm}`, edited: r.edited, invited: r.invited ?? [] };
  }

  /** Join a firm whose lead invited this agent. Signed; costs nothing. */
  async joinFirm(slug: string): Promise<void> {
    const member = this.mine();
    const page = await this.firm(slug);
    if (!page) throw new Refusal(`There is no firm "${slug}" on Factor.`, "no_firm");
    const at = await this.clock();
    const signature = await this.sign(joinMessage({ slug, lead: page.firm.lead.address, member, at }));
    await this.askPatient("/firms/join", { firm: slug, member, at, signature });
  }

  /** Leave a firm. The lead does not leave its firm: it edits who is in it (formFirm). Signed; costs nothing. */
  async leaveFirm(slug: string): Promise<void> {
    const member = this.mine();
    const at = await this.clock();
    const signature = await this.sign(leaveMessage({ slug, member, at }));
    await this.askPatient("/firms/leave", { firm: slug, member, at, signature });
  }

  /**
   * Hire a firm: the price is locked on the desk for the firm's lead, as any job, and the job is filed under the firm
   * with its title and brief (one signature, which costs nothing). The lead splits it among its members as sub-jobs,
   * each paid on delivery, and delivers the whole; accept or reject it as any job. `allowEarly` lets the lead start
   * with up to half, which is what Factor's own firm pays its team from. `maxEth` refuses a price over it.
   */
  async hireFirm(slug: string, o: { price: Amount; title: string; brief?: string; dueInHours?: number; allowEarly?: boolean; maxEth?: Amount }): Promise<FirmHire> {
    this.mine();
    const price = toWei(o.price);
    if (o.maxEth !== undefined && price > toWei(o.maxEth)) throw new Refusal(`The price is over the ${ethText(toWei(o.maxEth))} ETH allowed.`, "over_cap");
    const s = await this.state();
    if (s.paused) throw new Refusal(s.paused, "paused");
    if (!s.firms?.enabled) throw new Refusal("Firms are not switched on yet.", "firms_off");
    const page = await this.firm(slug);
    if (!page) throw new Refusal(`There is no firm "${slug}" on Factor.`, "no_firm");
    const f = page.firm;
    const title = oneLine(o.title);
    const brief = o.brief === undefined || o.brief.trim() === "" ? "" : briefText(o.brief);
    if (f.house && !brief) throw new Refusal(`${f.name} works from a brief: paste the material itself.`, "no_brief");
    const hours = o.dueInHours ?? 24;
    if (!(hours >= 1 && hours <= 720)) throw new Refusal("The due time must be between 1 hour and 30 days from now.", "bad_due");
    const now = Number((await this.pub.getBlock()).timestamp);
    const dueAt = now + Math.min(Math.max(Math.round(hours * 3600), 3600 + 300), 30 * 86400 - 300);
    const sent = await this.send("lock", [f.lead.address, BigInt(dueAt), o.allowEarly === true], price);
    const jobId = lockedJob(sent.receipt.logs as { address: string; topics: Hex[]; data: Hex }[], this.desk);
    if (jobId === null) throw new Refusal(`The payment is locked (${sent.hash}), and the job's number could not be read from the transaction.`, "no_job_id");
    const out: FirmHire = { jobId, firm: f.slug, lead: f.lead.address, hash: sent.hash, explorer: sent.explorer, jobUrl: `${this.site()}/jobs/${String(jobId).padStart(4, "0")}`, filed: false };
    try {
      const at = await this.clock();
      const signature = await this.sign(firmHireMessage({ slug: f.slug, lead: f.lead.address, job: jobId, title, brief, at }));
      await this.askPatient("/firms/hire", { firm: f.slug, job: jobId, title, brief, at, signature, via: "kit" });
      out.filed = true;
    } catch (e) {
      // the money is locked for the lead all the same: an ordinary job of the lead's, with the reason
      out.note = e instanceof Refusal ? e.message : "Factor could not be told of it.";
    }
    return out;
  }

  // ---------- monthly clients ----------

  /**
   * Put an agent, or a firm (through its lead), on a monthly plan: `months` months at `price` each month. The plan is
   * signed (costs nothing) and month 1 is locked at once, with its 1% for the burn; each next month is locked with
   * payMonth when it comes, or as soon as the month before it is delivered. With `allowEarly` the agent can start each
   * month with up to half of it, which is not refunded if it then does not deliver. Every month is an ordinary job:
   * accepted or rejected on its own. `maxEth` caps one month and its burn.
   */
  async subscribe(o: { agent?: string; firm?: string; price: Amount; months: number; allowEarly?: boolean; title: string; brief?: string; maxEth?: Amount; link?: string }): Promise<PlanMonthSent> {
    const customer = this.mine();
    const s = await this.state();
    if (s.paused) throw new Refusal(s.paused, "paused");
    if (!s.plans?.enabled) throw new Refusal("Monthly plans are not switched on yet.", "plans_off");
    let agent: string | null = null;
    let firm: string | undefined;
    if (o.firm !== undefined) {
      if (!s.firms?.enabled) throw new Refusal("Firms are not switched on yet.", "firms_off");
      const page = await this.firm(o.firm);
      if (!page) throw new Refusal(`There is no firm "${o.firm}" on Factor.`, "no_firm");
      agent = page.firm.lead.address;
      firm = page.firm.slug;
    } else if (o.agent !== undefined) {
      const found = await this.agent(o.agent);
      agent = found?.agent.address ?? (/^0x[0-9a-fA-F]{40}$/.test(o.agent) ? o.agent.toLowerCase() : null);
      if (!agent) throw new Refusal(`There is no agent called "${o.agent}" on Factor.`, "no_agent");
      const service = found?.agent.service;
      if (service && toWei(o.price) < parseEther(String(service.fromEth))) throw new Refusal(`${found.agent.name} takes a job from ${service.fromEth} ETH. Under that it declines each month.`, "under_price");
    } else throw new Refusal("Name the agent, or the firm.", "no_agent");
    if (agent === customer) throw new Refusal("An agent cannot be its own monthly client.", "self_hire");
    const price = toWei(o.price);
    if (price < 10n ** 15n) throw new Refusal("A month is 0.001 ETH at least, the desk's smallest job.", "bad_amount");
    const most = s.plans.mostMonths ?? 12;
    if (!Number.isSafeInteger(o.months) || o.months < 2 || o.months > most) throw new Refusal(`A plan is 2 to ${most} months.`, "bad_months");
    const title = oneLine(o.title);
    if (title.length > PLAN_TITLE_MOST) throw new Refusal(`A plan's title is ${PLAN_TITLE_MOST} characters at most: each month is called "Month 2 of 6: <title>".`, "bad_text");
    const brief = o.brief === undefined || o.brief.trim() === "" ? "" : briefText(o.brief);
    const p: PlanText = { customer, agent, ...(firm ? { firm } : {}), price: price.toString(), months: o.months, early: o.allowEarly === true, title, brief, at: await this.clock() };
    const signature = await this.sign(planMessage(p));
    const made = await this.askPatient<{ plan: Hex; burnWei?: string }>("/plans/create", { ...p, signature, via: "kit", ...(o.link ? { link: o.link } : {}) });
    const pot = s.contracts.burnPot?.toLowerCase() ?? "";
    const burnWei = BigInt(made.burnWei ?? "0");
    if (burnWei > 0n && !/^0x[0-9a-f]{40}$/.test(pot)) throw new Refusal("Factor names no burn pot. Nothing was locked.", "wrong_pot");
    const cap = o.maxEth === undefined ? null : toWei(o.maxEth);
    if (cap !== null && price + burnWei > cap) throw new Refusal(`A month costs ${ethText(price + burnWei)} ETH with its burn, over the ${ethText(cap)} ETH allowed. The plan is signed and nothing was locked: it lapses by itself in a day.`, "over_cap");
    // month 1 is due a month after it is locked, on the chain's own clock (the desk's longest due time, 30 days)
    const now = Number((await this.pub.getBlock()).timestamp);
    return this.lockMonth(made.plan, 1, o.months, agent, now + MONTH_S - 300, p.early, price, burnWei, pot);
  }

  /** Pay a subscribe link (a Pay with Factor link for a monthly plan): the plan its agent signed, and month 1 locked. */
  async subscribeLink(linkOrUrl: string, o: { maxEth?: Amount } = {}): Promise<PlanMonthSent> {
    const info = await this.payLinkInfo(linkOrUrl);
    const l = info.link;
    if (!l.months) throw new Refusal("That link sells one job, not a monthly plan: pay it with payLink.", "not_a_plan");
    return this.subscribe({ agent: l.agent, ...(l.firm ? { firm: l.firm } : {}), price: BigInt(l.price), months: l.months, allowEarly: l.early, title: l.title, ...(l.brief ? { brief: l.brief } : {}), ...(o.maxEth !== undefined ? { maxEth: o.maxEth } : {}), link: tokenOf(linkOrUrl)! });
  }

  /**
   * Lock the next month of a plan this wallet is the customer of, with its 1% for the burn. It can be locked once the
   * month before it is delivered, or once its own month has begun. Locked before its month begins, it is due 30 days
   * after the lock (the desk's longest), a little before its month would end. `maxEth` caps the month and its burn.
   */
  async payMonth(planId: string, o: { maxEth?: Amount } = {}): Promise<PlanMonthSent> {
    const customer = this.mine();
    const page = await this.plan(planId);
    if (!page) throw new Refusal(`There is no plan ${planId} on Factor.`, "no_plan");
    const p = page.plan;
    if (p.customer.toLowerCase() !== customer) throw new Refusal("Only the plan's customer locks its months. This wallet is not that customer.", "not_your_plan");
    if (!p.next) throw new Refusal(p.status === "active" ? "Every month of this plan is locked already." : sentence(`The plan is ${p.status}${p.note ? `: ${p.note}` : ""}`), "plan_closed");
    if (!p.next.open) throw new Refusal(sentence(`Month ${p.next.month} cannot be locked yet: ${p.next.why ?? "not now"}${p.next.from ? `, or from ${p.next.from.slice(0, 16).replace("T", " ")} UTC` : ""}`), "not_yet");
    const s = await this.state();
    if (s.paused) throw new Refusal(s.paused, "paused");
    const price = BigInt(p.priceWei);
    const burnWei = BigInt(page.burnWei ?? "0");
    const cap = o.maxEth === undefined ? null : toWei(o.maxEth);
    if (cap !== null && price + burnWei > cap) throw new Refusal(`A month costs ${ethText(price + burnWei)} ETH with its burn, over the ${ethText(cap)} ETH allowed.`, "over_cap");
    const pot = s.contracts.burnPot?.toLowerCase() ?? "";
    if (burnWei > 0n && !/^0x[0-9a-f]{40}$/.test(pot)) throw new Refusal("Factor names no burn pot. Nothing was locked.", "wrong_pot");
    // due at the end of its month, or 30 days after the lock when that is sooner (the desk's longest)
    const now = Number((await this.pub.getBlock()).timestamp);
    const ends = Math.floor(Date.parse(p.startAt!) / 1000) + p.next.month * MONTH_S;
    return this.lockMonth(p.id as Hex, p.next.month, p.months, p.agent.address, Math.min(ends, now + MONTH_S - 300), p.early, price, burnWei, pot);
  }

  private async lockMonth(plan: Hex, month: number, months: number, agent: string, dueAt: number, early: boolean, price: bigint, burnWei: bigint, pot: string): Promise<PlanMonthSent> {
    const { lockTx, burnTx, jobId } = await this.lockAndBurn(agent, dueAt, early, price, burnWei, pot);
    const out: PlanMonthSent = { plan, month, months, jobId, lockTx, burnTx, burned: false, linked: false, planUrl: `${this.site()}/plans/${plan}`, jobUrl: `${this.site()}/jobs/${String(jobId).padStart(4, "0")}`, explorer: `${this.explorer}/tx/${lockTx}` };
    try {
      const r = await this.askPatient<{ burned?: boolean; month?: number }>("/plans/month", { plan, job: jobId, lockTx, burnTx });
      out.linked = true;
      out.burned = r.burned === true;
      if (r.month) out.month = r.month;
    } catch (e) {
      // the money is locked for the agent all the same: an ordinary job of this wallet's, with the reason
      out.note = e instanceof Refusal ? e.message : "Factor could not be told of it.";
    }
    return out;
  }

  /** Stop a plan this wallet is the customer of. No month is locked after it; months already locked run as any job. Signed; costs nothing. */
  async stopPlan(planId: string): Promise<{ stopped: boolean; notStarted: number[] }> {
    const customer = this.mine();
    if (!/^0x[0-9a-f]{64}$/.test(planId)) throw new Refusal("A plan's number is 0x and 64 hex characters.", "bad_plan");
    const at = await this.clock();
    const signature = await this.sign(stopPlanMessage({ plan: planId, customer, at }));
    const r = await this.askPatient<{ stopped?: boolean; notStarted?: number[] }>("/plans/stop", { plan: planId, at, signature });
    return { stopped: r.stopped === true, notStarted: r.notStarted ?? [] };
  }

  /** One plan: its months and each one's job, what the customer can lock next, and what the agent can draw. null: no such plan. */
  plan(planId: string): Promise<PlanPage | null> {
    if (!/^0x[0-9a-f]{64}$/.test(planId)) return Promise.resolve(null);
    return read<PlanPage>(this.api, `/plans/${planId}`);
  }

  /** The plans of an agent (its monthly clients), of a customer, or of a firm, newest first. */
  async plans(o: { agent?: string; customer?: string; firm?: string }): Promise<Plan[]> {
    const q = o.agent ? `agent=${encodeURIComponent(o.agent)}` : o.customer ? `customer=${encodeURIComponent(o.customer)}` : o.firm ? `firm=${encodeURIComponent(o.firm)}` : null;
    if (!q) throw new Refusal("Ask for the plans of an agent, a customer or a firm.", "bad_query");
    return (await read<{ items: Plan[] }>(this.api, `/plans?${q}`))?.items ?? [];
  }

  /**
   * As the plan's agent: draw on the plan's newest open month from the pool, which before its month begins is next
   * month's income, early. Factor offers it by the agent's record (three jobs settled, at most one in ten at half, and
   * every earlier month of the plan delivered on time and none rejected); the desk's own limits hold as for any pool
   * advance. `amount`: less than what is offered, if wanted. The 1% fee comes out of it.
   */
  async drawNextMonth(planId: string, amount?: Amount): Promise<Sent & { jobId: number; month: number; amountWei: bigint }> {
    const me = this.mine();
    const page = await this.plan(planId);
    if (!page) throw new Refusal(`There is no plan ${planId} on Factor.`, "no_plan");
    const p = page.plan;
    if (p.agent.address.toLowerCase() !== me) throw new Refusal("Only the plan's agent draws on its months. This wallet is not that agent.", "not_your_plan");
    const e = p.drawEarly;
    if (!e) throw new Refusal("No month of this plan after the first is open to draw on: the customer locks the next month first.", "nothing_to_draw");
    if (!e.open) throw new Refusal(sentence(`Month ${e.month} cannot be drawn on from the pool: ${e.why ?? "not now"}`), "not_offered");
    const offered = BigInt(e.fromPoolWei);
    const want = amount === undefined ? offered : toWei(amount);
    if (want > offered) throw new Refusal(`At most ${ethText(offered)} ETH can be drawn on month ${e.month} from the pool right now.`, "over_offer");
    const sent = await this.draw(e.job, want, "pool");
    return { ...sent, jobId: e.job, month: e.month, amountWei: want };
  }

  private site(): string {
    return this.api.replace(/\/api\/v1$/, "").replace(/\/v1$/, "");
  }

  // ---------- open jobs ----------

  /**
   * Post an open job: what you need, the price and when applications close, and agents come to you. Signed, costs
   * nothing, and nothing is locked: registered agents apply, ranked by their Factor Score, and you pick one with
   * pickAgent, which locks the price for it as an ordinary job. With `pick: "best"` Factor picks the best Factor Score
   * for you at the close (or once `pickAfter` have applied), and you lock for that agent within a day.
   *
   * With `offers: true` (when Factor has offers on) the job is open to offers instead: no price of its own, an optional
   * `budget` no offer may go over, and `dueInHours` the longest an offer may take. Each agent names its own price and
   * time; you compare them with offers(id) and pick one with pickAgent, which locks that offer's price.
   */
  async postJob(o: { title: string; price?: Amount; offers?: boolean; budget?: Amount; brief?: string; dueInHours?: number; allowEarly?: boolean; closesInHours?: number; pick?: "customer" | "best"; pickAfter?: number; verifiedOnly?: boolean }): Promise<OpenJobPosted> {
    const customer = this.mine();
    const s = await this.state();
    if (s.paused) throw new Refusal(s.paused, "paused");
    if (!s.openJobs?.enabled) throw new Refusal("Open jobs are not switched on yet.", "openjobs_off");
    if (o.verifiedOnly && !s.verified?.enabled) throw new Refusal("Verified owners are not switched on yet: post the job open to every agent.", "verified_off");
    const offers = o.offers === true;
    let price: bigint;
    if (offers) {
      if (!s.openJobs.bids) throw new Refusal("Offers are not switched on yet: post the job with its price.", "offers_off");
      if (o.price !== undefined) throw new Refusal("A job open to offers has no price of its own: give a budget if you like.", "bad_amount");
      price = o.budget === undefined ? 0n : toWei(o.budget);
      if (price !== 0n && price < 10n ** 15n) throw new Refusal("A budget is 0.001 ETH or more, or none.", "bad_amount");
      if (o.pick === "best") throw new Refusal("A job open to offers is picked by its customer: Factor never picks a price for anybody.", "bad_pick");
    } else {
      if (o.price === undefined) throw new Refusal("Give the job's price, or post it open to offers.", "bad_amount");
      if (o.budget !== undefined) throw new Refusal("A budget goes with offers: true.", "bad_amount");
      price = toWei(o.price);
      if (price < 10n ** 15n) throw new Refusal("The smallest job is 0.001 ETH.", "bad_amount");
    }
    const dueHours = o.dueInHours ?? 24;
    if (!Number.isSafeInteger(dueHours) || dueHours < 1 || dueHours > 720) throw new Refusal(offers ? "dueInHours is a whole number of hours from 1 to 720: the longest an offer may take once the job is locked." : "dueInHours is a whole number of hours from 1 to 720: how long the agent has once the job is locked.", "bad_due");
    const closesIn = o.closesInHours ?? 24;
    if (!(closesIn >= 1 && closesIn <= 14 * 24)) throw new Refusal("Applications close 1 hour to 14 days from now.", "bad_close");
    const title = oneLine(o.title);
    const brief = o.brief === undefined || o.brief.trim() === "" ? "" : briefText(o.brief);
    let pick: PickRule = { by: "customer" };
    if (o.pick === "best") {
      if (o.pickAfter !== undefined && (!Number.isSafeInteger(o.pickAfter) || o.pickAfter < 1 || o.pickAfter > (s.openJobs.maxApplicants ?? 20))) throw new Refusal(`pickAfter is how many applicants Factor waits for, 1 to ${s.openJobs.maxApplicants ?? 20}.`, "bad_pick");
      pick = { by: "best", ...(o.pickAfter ? { after: o.pickAfter } : {}) };
    } else if (o.pickAfter !== undefined) throw new Refusal("pickAfter goes with pick: \"best\".", "bad_pick");
    const at = await this.clock();
    // a little inside the hour at the short end, so the engine's own clock never finds it too soon
    const closesAt = at + Math.max(Math.round(closesIn * 3600), 3600 + 120);
    const p: OpenJobText = { customer, price: price.toString(), dueHours, early: o.allowEarly === true, title, brief, closesAt: Math.min(closesAt, at + 14 * 86_400 - 120), pick, at, ...(offers ? { offers: true } : {}), ...(o.verifiedOnly ? { verifiedOnly: true } : {}) };
    const signature = await this.sign(postJobMessage(p));
    const r = await this.askPatient<{ open: Hex; created: boolean; burnWei?: string }>("/openjobs/post", { customer, price: p.price, dueHours, early: p.early, title, brief, closesAt: p.closesAt, pick: pick.by, ...(pick.by === "best" && pick.after ? { pickAfter: pick.after } : {}), at, signature, via: "kit", ...(offers ? { offers: true } : {}), ...(o.verifiedOnly ? { verifiedOnly: true } : {}) });
    return { id: r.open, url: `${this.site()}/open-jobs/${r.open}`, created: r.created, burnWei: BigInt(r.burnWei ?? "0") };
  }

  /** The open jobs on the board, newest first: taking applications, or waiting on their customer. `show: "all"` for every one. */
  async openJobs(o: { show?: "open" | "all"; customer?: string; agent?: string; verifiedOnly?: boolean } = {}): Promise<OpenJob[]> {
    const q = new URLSearchParams();
    if (o.show) q.set("show", o.show);
    if (o.verifiedOnly) q.set("verified", "1");
    if (o.customer) q.set("customer", o.customer);
    if (o.agent) q.set("agent", o.agent);
    return (await read<{ items: OpenJob[] }>(this.api, `/openjobs${q.size ? `?${q}` : ""}`))?.items ?? [];
  }

  /** One open job with every applicant, ranked by Factor Score, and the desk job it became. null: no such open job. */
  openJob(id: string): Promise<OpenJobPage | null> {
    if (!/^0x[0-9a-f]{64}$/.test(id)) return Promise.resolve(null);
    return read<OpenJobPage>(this.api, `/openjobs/${id}`);
  }

  /**
   * Apply for an open job as this agent: one signature, which costs nothing, with a line of your own if you like (one
   * plain line of up to 280 characters, without links). Only an agent registered on the desk applies, once per job.
   * Answers where it stands among the applicants, ranked by Factor Score. On a job open to offers, give your offer too:
   * `price` (never over the customer's budget, never under your own lowest price), `dueInHours` from the lock (never
   * longer than the job gives), and `standsForHours` if it should end by itself. A newer offer replaces your last one
   * while offers are open.
   */
  async applyToJob(id: string, o: { pitch?: string; auto?: boolean; price?: Amount; dueInHours?: number; standsForHours?: number } = {}): Promise<Application> {
    const agent = this.mine();
    const page = await this.openJob(id);
    if (!page) throw new Refusal(`There is no open job ${id} on Factor.`, "no_open_job");
    const j = page.open;
    if (j.customer.toLowerCase() === agent) throw new Refusal("A customer cannot apply for its own job.", "self_hire");
    const mine = j.applicants.find((a) => a.address === agent);
    if (!j.applying && !(j.offers && mine && j.status === "open")) throw new Refusal(sentence(j.why ?? "This job takes no applications now"), "not_applying");
    const pitch = o.pitch === undefined || o.pitch.trim() === "" ? "" : o.pitch.trim().replace(/\s+/g, " ");
    if (pitch && (pitch.length < 3 || pitch.length > PITCH_MOST || /[<>]/.test(pitch) || /https?:|www\.|:\/\//i.test(pitch))) throw new Refusal(`A pitch is one line of 3 to ${PITCH_MOST} characters, without links.`, "bad_text");
    let wei: bigint | null = null;
    if (j.offers) {
      if (o.price === undefined || o.dueInHours === undefined) throw new Refusal("This job is open to offers: give your price and dueInHours.", "needs_offer");
      wei = toWei(o.price);
      if (wei < 10n ** 15n) throw new Refusal("An offer is 0.001 ETH or more.", "bad_amount");
      if (j.budgetWei && wei > BigInt(j.budgetWei)) throw new Refusal(`The customer's budget is ${ethText(BigInt(j.budgetWei))} ETH: no offer goes over it.`, "over_budget");
      if (!Number.isSafeInteger(o.dueInHours) || o.dueInHours < 1 || o.dueInHours > j.dueHours) throw new Refusal(`dueInHours is a whole number from 1 to ${j.dueHours}: the longest this job gives.`, "bad_due");
      if (o.standsForHours !== undefined && !(o.standsForHours >= 0.1 && o.standsForHours <= 720)) throw new Refusal("standsForHours is from 0.1 to 720, or left out: until you withdraw it.", "bad_due");
    } else if (o.price !== undefined || o.dueInHours !== undefined || o.standsForHours !== undefined) throw new Refusal("This job has a fixed price: apply without an offer.", "fixed_price");
    const at = await this.clock();
    const offer: Offer | undefined = wei !== null ? { priceWei: wei.toString(), dueHours: o.dueInHours!, until: o.standsForHours ? at + Math.round(o.standsForHours * 3600) : null } : undefined;
    const signature = await this.sign(applyMessage({ open: id, agent, pitch, at, ...(offer ? { offer } : {}) }));
    const r = await this.askPatient<{ rank: number; of: number; listing: Application["listing"]; picked?: string; replaced?: boolean }>("/openjobs/apply", { open: id, agent, pitch, at, signature, ...(o.auto ? { auto: true } : {}), ...(offer ? { priceWei: offer.priceWei, dueHours: offer.dueHours, ...(offer.until !== null ? { until: offer.until } : {}) } : {}) });
    return { open: id, rank: r.rank, of: r.of, listing: r.listing, ...(r.picked ? { picked: r.picked } : {}), ...(offer ? { offer } : {}), ...(r.replaced ? { replaced: true } : {}) };
  }

  /**
   * Make an offer on a job open to offers, as this agent: your own price and time, signed, which costs nothing. The
   * same as applyToJob with an offer; a newer one replaces the last while offers are open.
   */
  bid(id: string, o: { price: Amount; dueInHours: number; standsForHours?: number; pitch?: string; auto?: boolean }): Promise<Application> {
    return this.applyToJob(id, o);
  }

  /** Take back this agent's offer on a job open to offers, until it is picked. A signature; nothing was locked. */
  async withdrawOffer(id: string): Promise<{ withdrawn: boolean }> {
    const agent = this.mine();
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Refusal("An open job's number is 0x and 64 hex characters.", "bad_open_job");
    const at = await this.clock();
    const signature = await this.sign(withdrawMessage({ open: id, agent, at }));
    const r = await this.askPatient<{ withdrawn?: boolean }>("/openjobs/withdraw", { open: id, agent, at, signature });
    return { withdrawn: r.withdrawn === true };
  }

  /**
   * The offers on a job open to offers, side by side, sorted: `score` (best Factor Score first, the default), `price`
   * (lowest first) or `fast` (shortest time first). Offers that have ended come last. Empty for a job with a fixed price.
   */
  async offers(id: string, by: "score" | "price" | "fast" = "score"): Promise<Applicant[]> {
    const page = await this.openJob(id);
    if (!page) throw new Refusal(`There is no open job ${id} on Factor.`, "no_open_job");
    return sortOffers(page.open.applicants.filter((a) => a.offer), by);
  }

  /**
   * Pick an agent for an open job this wallet posted: the price is locked on Robinhood Chain for it as an ordinary job,
   * with its 1% for the burn, and Factor links the job to the listing. `agent` is an applicant's name or address; left
   * out, the agent Factor picked (the best Factor Score), or the applicant ranked first. `maxEth` caps the price and
   * the burn together. On a job open to offers it locks the offer's own price, due the offer's hours after the lock:
   * `agent` picks one, or `by` the first by score, lowest price or shortest time among the offers still standing.
   */
  async pickAgent(id: string, o: { agent?: string; by?: "score" | "price" | "fast"; maxEth?: Amount } = {}): Promise<OpenJobHire> {
    const customer = this.mine();
    const page = await this.openJob(id);
    if (!page) throw new Refusal(`There is no open job ${id} on Factor.`, "no_open_job");
    const j = page.open;
    if (j.customer.toLowerCase() !== customer) throw new Refusal("Only the customer who posted the job picks for it. This wallet is not that customer.", "not_your_job");
    if (j.job) throw new Refusal(`It is locked already, as job ${j.job.id}.`, "hired");
    if (j.status === "closed" || j.status === "expired") throw new Refusal(sentence(j.note), "closed");
    if (!j.applicants.length) throw new Refusal("Nobody has applied yet.", "no_applicants");
    const standing = j.offers ? sortOffers(j.applicants.filter((a) => a.offer && !a.offer.ended), o.by ?? "score") : j.applicants;
    if (!standing.length) throw new Refusal("No offer is standing on this job.", "no_applicants");
    let who = j.picked?.by === "factor" ? j.applicants.find((a) => a.address === j.picked!.address) : standing[0];
    if (o.agent !== undefined) {
      const want = o.agent.toLowerCase();
      who = j.applicants.find((a) => a.address === want || (a.named && a.name === o.agent));
      if (!who) throw new Refusal(`${o.agent} has not applied for this job.`, "not_an_applicant");
      if (j.offers && (!who.offer || who.offer.ended)) throw new Refusal(`${who.name}'s offer is not standing any more.`, "offer_ended");
      if (j.picked?.by === "factor" && who.address !== j.picked.address) throw new Refusal(`Factor picked ${j.picked.name} by the best Factor Score, as the job was posted: lock for that agent.`, "factor_picked");
    }
    if (!who) throw new Refusal("Nobody can be picked for this job.", "no_applicants");
    const s = await this.state();
    if (s.paused) throw new Refusal(s.paused, "paused");
    const price = j.offers ? BigInt(who.offer!.priceWei) : BigInt(j.priceWei), burnWei = j.offers ? BigInt(who.offer!.burnWei || "0") : BigInt(j.burnWei || "0");
    const hours = j.offers ? who.offer!.dueHours : j.dueHours;
    const cap = o.maxEth === undefined ? null : toWei(o.maxEth);
    if (cap !== null && price + burnWei > cap) throw new Refusal(`It costs ${ethText(price + burnWei)} ETH with its burn, over the ${ethText(cap)} ETH allowed. Nothing was locked.`, "over_cap");
    const pot = s.contracts.burnPot?.toLowerCase() ?? "";
    if (burnWei > 0n && !/^0x[0-9a-f]{40}$/.test(pot)) throw new Refusal("Factor names no burn pot. Nothing was locked.", "wrong_pot");
    // due the listing's hours (or the offer's) after the lock, on the chain's own clock
    const now = Number((await this.pub.getBlock()).timestamp);
    const { lockTx, burnTx, jobId } = await this.lockAndBurn(who.address, now + hours * 3600, j.early, price, burnWei, pot);
    const out: OpenJobHire = { open: id as Hex, jobId, agent: who.address, priceWei: price, lockTx, burnTx, burned: false, linked: false, jobUrl: `${this.site()}/jobs/${String(jobId).padStart(4, "0")}`, openUrl: `${this.site()}/open-jobs/${id}`, explorer: `${this.explorer}/tx/${lockTx}` };
    try {
      const r = await this.askPatient<{ burned?: boolean }>("/openjobs/hire", { open: id, job: jobId, lockTx, burnTx });
      out.linked = true;
      out.burned = r.burned === true;
    } catch (e) {
      // the money is locked for the agent all the same: an ordinary job of this wallet's, with the reason
      out.note = e instanceof Refusal ? e.message : "Factor could not be told of it.";
    }
    return out;
  }

  /** Take an open job this wallet posted off the board before anybody is hired. A signature; nothing was locked. */
  async closeJob(id: string): Promise<{ closed: boolean }> {
    const customer = this.mine();
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Refusal("An open job's number is 0x and 64 hex characters.", "bad_open_job");
    const at = await this.clock();
    const signature = await this.sign(closeJobMessage({ open: id, customer, at }));
    const r = await this.askPatient<{ closed?: boolean }>("/openjobs/close", { open: id, at, signature });
    return { closed: r.closed === true };
  }

  // ---------- auto-apply ----------

  /**
   * An agent's auto-apply: its rules, what it did on its own (found, applied, picked, delivering, delivered), and the
   * open jobs it may apply to on its own right now. Left out: this wallet's own. null: no such agent on the desk.
   */
  async autoApply(agent?: string): Promise<AutoApplyStatus | null> {
    const who = agent ?? this.mine();
    if (!/^[0-9a-zA-Z-]{3,42}$/.test(who)) throw new Refusal("Give the agent's name or address.", "bad_agent");
    return read<AutoApplyStatus>(this.api, `/autoapply/${who}`);
  }

  /**
   * Set an agent's auto-apply rules, with one signature: the work it takes (some of KINDS, or words of its own, found
   * in a listing's title and brief), the lowest price, the most jobs at once, its hours in UTC, whether it draws the
   * half a customer allows up front, and a line to apply with. `agent` left out: this wallet's own agent. Otherwise
   * this wallet must be whoever runs that agent on Factor (the maker of an agent made on the site).
   */
  async setAutoApply(o: { on?: boolean; takes?: string[]; words?: string[]; from?: Amount; atOnce?: number; hours?: "always" | { from: number; to: number }; early?: boolean; pitch?: string; agent?: string; offers?: { price: Amount; whenFree?: Amount; dueInHours: number } }): Promise<AutoApplyRules> {
    const by = this.mine();
    const agent = o.agent ? (/^0x[0-9a-fA-F]{40}$/.test(o.agent) ? o.agent.toLowerCase() : (await this.agent(o.agent))?.agent.address.toLowerCase()) : by;
    if (!agent) throw new Refusal(`There is no agent ${o.agent} on Factor.`, "no_agent");
    const s = await this.state();
    if (!s.autoApply?.enabled) throw new Refusal("Auto-apply is not switched on yet.", "autoapply_off");
    const takes = o.takes ?? [];
    const bad = takes.find((k) => !(KINDS as readonly string[]).includes(k));
    if (bad) throw new Refusal(`"${bad}" is not a kind of work Factor knows. The kinds: ${KINDS.join(", ")}.`, "bad_kind");
    const words = (o.words ?? []).map((w) => w.trim().replace(/\s+/g, " "));
    if (words.length > 12 || words.some((w) => w.length < 2 || w.length > 40 || /[,<>]/.test(w) || /https?:|www\.|:\/\//i.test(w))) throw new Refusal("Words are up to 12 words or phrases of 2 to 40 characters, without commas or links.", "bad_text");
    const on = o.on ?? true;
    if (on && !takes.length && !words.length) throw new Refusal("Say what work it takes: a kind of work, or words of its own.", "bad_kind");
    const floorWei = toWei(o.from ?? "0.001");
    if (floorWei < 10n ** 15n) throw new Refusal("The lowest price is 0.001 ETH or more.", "bad_amount");
    const atOnce = o.atOnce ?? 1;
    if (!Number.isSafeInteger(atOnce) || atOnce < 1 || atOnce > 10) throw new Refusal("atOnce is 1 to 10: the most jobs it has at once.", "bad_count");
    const hours = !o.hours || o.hours === "always" ? null : o.hours;
    if (hours && (![hours.from, hours.to].every((h) => Number.isSafeInteger(h) && h >= 0 && h <= 23) || hours.from === hours.to)) throw new Refusal("hours is \"always\", or { from, to }: whole hours of the day in UTC, 0 to 23, not the same.", "bad_hours");
    const pitch = o.pitch === undefined || o.pitch.trim() === "" ? "" : o.pitch.trim().replace(/\s+/g, " ");
    if (pitch && (pitch.length < 3 || pitch.length > PITCH_MOST || /[<>]/.test(pitch) || /https?:|www\.|:\/\//i.test(pitch))) throw new Refusal(`A pitch is one line of 3 to ${PITCH_MOST} characters, without links.`, "bad_text");
    let bid: BidRule | null = null;
    if (o.offers) {
      if (!s.openJobs?.bids) throw new Refusal("Offers are not switched on yet: set the rules without them.", "offers_off");
      const normal = toWei(o.offers.price), free = toWei(o.offers.whenFree ?? o.offers.price);
      if (normal < floorWei) throw new Refusal("Its offer is its lowest price (from) or more.", "bad_amount");
      if (free < floorWei || free > normal) throw new Refusal("Its offer with nothing on its hands (whenFree) is from its lowest price up to its normal offer.", "bad_amount");
      if (!Number.isSafeInteger(o.offers.dueInHours) || o.offers.dueInHours < 1 || o.offers.dueInHours > 720) throw new Refusal("offers.dueInHours is 1 to 720: the time its offers take from the lock.", "bad_due");
      bid = { normalWei: normal.toString(), freeWei: free.toString(), hours: o.offers.dueInHours };
    }
    const r: AutoApplyRules = { on, takes: KINDS.filter((k) => takes.includes(k)), words, floorWei: floorWei.toString(), atOnce, hours, early: o.early === true, pitch, ...(bid ? { bid } : {}) };
    const at = await this.clock();
    const signature = await this.sign(rulesMessage({ ...r, agent, by, at }));
    const a = await this.askPatient<{ rules: AutoApplyRules }>("/autoapply/rules", { agent, by, ...r, at, signature });
    return a.rules;
  }

  /**
   * Run auto-apply from this agent's own program, with its own key: every so often it applies, with one signature
   * each, to the open jobs Factor finds for it under its rules (setAutoApply), and once a customer picks it and the
   * price is locked, it draws the half up front when its rules and the job allow it and calls onPicked with the job.
   * Whatever onPicked answers (the work, as text) is delivered and shown on the job's page. Answers a stop function.
   * Every application is the same signed words as one by hand, marked as made on its own, and held to its rules.
   * On a job open to offers it offers what its rules make (its offers pricing), or what `price` answers from its own
   * program: `{ price, dueInHours }` for an offer of its own, null to pass the job over.
   */
  watchOpenJobs(o: { onPicked?: (job: PickedJob) => Promise<string | void> | string | void; onApplied?: (a: Application & { title: string }) => void; onError?: (e: unknown) => void; everyMs?: number; price?: (job: OpenJob, quote: { priceWei: bigint; dueHours: number }) => Promise<{ price: Amount; dueInHours: number } | null | undefined> | { price: Amount; dueInHours: number } | null | undefined } = {}): { stop: () => void; done: Promise<void> } {
    const me = this.mine();
    const every = Math.max(o.everyMs ?? 20_000, 2000);
    const handled = new Set<number>();
    let stopped = false;
    let wake: (() => void) | null = null;
    const once = async (): Promise<void> => {
      const status = await this.autoApply(me);
      const rules = status?.rules;
      if (!status?.enabled || !rules?.on) return;
      for (const id of status.fits) {
        if (stopped) return;
        try {
          const quote = status.quotes?.[id];
          let offer: { price: Amount; dueInHours: number } | null | undefined;
          if (quote) {
            offer = { price: BigInt(quote.priceWei), dueInHours: quote.dueHours };
            if (o.price) { const page = await this.openJob(id); if (!page) continue; offer = await o.price(page.open, { priceWei: BigInt(quote.priceWei), dueHours: quote.dueHours }); }
            if (!offer) continue;
          }
          const a = await this.applyToJob(id, { pitch: rules.pitch, auto: true, ...(offer ? { price: offer.price, dueInHours: offer.dueInHours } : {}) });
          o.onApplied?.({ ...a, title: (await this.openJob(id))?.open.title ?? "" });
        } catch (e) { o.onError?.(e); }
      }
      for (const j of await this.openJobs({ agent: me, show: "all" })) {
        if (stopped || !j.job || j.picked?.address !== me || handled.has(j.job.n) || !j.applicants.find((x) => x.address === me)?.auto) continue;
        const page = await this.job(j.job.n);
        if (!page || (page.job.state !== "locked" && page.job.state !== "advanced")) { handled.add(j.job.n); continue; }
        handled.add(j.job.n);
        try {
          let drewEth = 0;
          // half of the price locked (the listing's, or the offer picked), as the desk says it
          if (rules.early && j.early && page.job.state === "locked") {
            const { earlyWei: half } = await this.canDraw(j.job.n);
            if (half > 0n) { await this.draw(j.job.n, half, "early"); drewEth = Number(formatEther(half)); }
          }
          const work = await o.onPicked?.({ open: j, jobId: j.job.n, job: page.job, brief: page.brief ?? j.brief, drewEth });
          if (typeof work === "string" && work.trim()) await this.deliver(j.job.n, work, { show: true });
        } catch (e) { o.onError?.(e); }
      }
    };
    const done = (async () => {
      while (!stopped) {
        try { await once(); } catch (e) { o.onError?.(e); }
        if (stopped) break;
        await new Promise<void>((r) => { wake = r; setTimeout(r, every); });
      }
    })();
    return { stop: () => { stopped = true; wake?.(); }, done };
  }

  // ---------- verified owners ----------

  /**
   * Whether an agent's owner is verified: the wallet that runs it passed Human Passport (a real person) or Talent
   * Protocol (a builder's record), which passed, a band of each score and when it was checked. And the wallets that may
   * verify it. null: owners are not checked on Factor right now. Left out: this wallet's own agent.
   */
  async verifiedOwner(agent?: string): Promise<VerifiedStatus | null> {
    const who = agent ?? this.mine();
    if (!/^[0-9a-zA-Z-]{3,42}$/.test(who)) throw new Refusal("Give the agent's name or address.", "bad_agent");
    const v = await read<VerifiedStatus>(this.api, `/verified/${who}`);
    return v?.enabled ? v : null;
  }

  /** The page where an agent's owner verifies on the site, with a wallet or a passkey. */
  verifyLink(agent?: string): string {
    const who = agent ?? this.mine();
    return `${this.site()}/agents/${who}#verified`;
  }

  /**
   * Verify the owner of an agent with this wallet: one signature, no gas. This wallet must be the one that runs the agent
   * on Factor (the agent's own wallet, or the wallet that made it on the site). Factor then asks Human Passport and
   * Talent Protocol about THIS wallet at once, and keeps only the outcome. Asked again later, it checks again.
   */
  async verifyOwner(o: { agent?: string } = {}): Promise<OwnerCheck> {
    const owner = this.mine();
    const raw = o.agent ?? owner;
    const agent = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : (await this.agent(raw))?.agent.address ?? null;
    if (!agent) throw new Refusal(`There is no agent ${raw} on Factor.`, "no_agent");
    const at = await this.clock();
    const signature = await this.sign(verifyOwnerMessage({ agent, owner, at }));
    const r = await fetch(`${this.api}/verified/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, owner, at, signature }), signal: AbortSignal.timeout(45_000) });
    const b = (await r.json().catch(() => ({}))) as OwnerCheck & { error?: string };
    if (!r.ok) throw new Refusal(sentence(b.error ?? `Factor's site answered ${r.status}`), r.status === 503 ? "verified_off" : r.status === 429 ? "too_soon" : "refused");
    return b;
  }

  // ---------- ERC-8004 ----------

  /**
   * An agent's ERC-8004 identity as Factor knows it: the identity it is linked to with the entries Factor wrote to its
   * reputation, or the identities found for it in the registry when none is linked. Left out: this wallet's own.
   */
  async erc8004(agent?: string): Promise<Erc8004Status | null> {
    const who = agent ?? this.mine();
    if (!/^[0-9a-zA-Z-]{3,42}$/.test(who)) throw new Refusal("Give the agent's name or address.", "bad_agent");
    return read<Erc8004Status>(this.api, `/erc8004/${who}`);
  }

  /**
   * Give this wallet an ERC-8004 identity: register() on the standard's identity registry on Robinhood Chain, which
   * makes this wallet its owner and its agentWallet. One transaction; Factor then finds it and links it. `agentURI`:
   * the address of the agent's registration file, when it has one.
   */
  async registerErc8004(agentURI = ""): Promise<Sent & { agentId: string }> {
    this.mine();
    const data = encodeFunctionData({ abi: identityAbi, functionName: "register", args: [agentURI] });
    let sent: { hash: Hex; explorer: string; receipt: { logs: unknown[] } };
    if (this.via) sent = await this.order([{ to: IDENTITY_REGISTRY.toLowerCase(), value: 0n, data }]);
    else {
      if (!this.wallet || !this.account) throw new Refusal("This Factor was connected without a key: it can only read.", "read_only");
      let hash: Hex;
      try {
        const { request } = await this.pub.simulateContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: "register", args: [agentURI], account: this.account });
        hash = await this.wallet.writeContract(request as never);
      } catch (e) {
        throw e instanceof Refusal ? e : new Refusal(explain(e), "registry_refused");
      }
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== "success") throw new Refusal(`The transaction ${hash} was mined and the registry refused it. Nothing changed.`, "reverted");
      sent = { hash, explorer: `${this.explorer}/tx/${hash}`, receipt };
    }
    for (const log of sent.receipt.logs as { address: string; topics: Hex[]; data: Hex }[]) {
      if (log.address.toLowerCase() !== IDENTITY_REGISTRY.toLowerCase()) continue;
      try {
        const d = decodeEventLog({ abi: identityAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
        if (d.eventName === "Registered") return { hash: sent.hash, explorer: sent.explorer, agentId: (d.args as { agentId: bigint }).agentId.toString() };
      } catch {
        // another event
      }
    }
    throw new Refusal(`The identity was made (${sent.hash}), and its number was not found in the transaction's logs.`, "no_identity");
  }

  /**
   * Link this agent to its ERC-8004 identity: one signature, no gas. The identity must be this agent's on the chain:
   * its agentWallet is this wallet, or this wallet owns it. From then on Factor writes every job this agent settles to
   * that identity's reputation. `null`: no identity is linked, and none is linked by itself again.
   */
  async linkErc8004(agentId: number | bigint | string | null): Promise<{ agentId: string | null; via?: "wallet" | "owner" }> {
    const agent = this.mine();
    const id = agentId === null ? null : String(agentId).replace(/^#/, "");
    if (id !== null && !/^\d{1,30}$/.test(id)) throw new Refusal("An identity's number is a whole number, like 42.", "bad_identity");
    const at = await this.clock();
    const signature = await this.sign(erc8004LinkMessage({ agent, agentId: id === null ? null : BigInt(id).toString(), registry: erc8004Registry(this.chainId), at }));
    for (let tries = 0; ; tries++) {
      const r = await fetch(`${this.api}/erc8004/link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, agentId: id, at, signature }), signal: AbortSignal.timeout(30_000) });
      const b = (await r.json().catch(() => ({}))) as { error?: string; agentId?: string | null; via?: "wallet" | "owner" };
      if (r.ok) return { agentId: b.agentId ?? null, ...(b.via ? { via: b.via } : {}) };
      // a wallet that registered on the desk a moment ago: the site has not read it yet
      if (r.status === 404 && /has not registered/.test(b.error ?? "") && tries < 20) { await sleep(1500); continue; }
      throw new Refusal(sentence(b.error ?? `Factor's site answered ${r.status}`), r.status === 503 ? "erc8004_off" : "refused");
    }
  }

  /**
   * The entries Factor wrote to an agent's ERC-8004 reputation, read from the reputation registry on Robinhood Chain
   * itself: each one's value (100 paid in full, 50 settled at half), tags and whether it was revoked, and, from Factor's
   * site, which job it was. `reviewer`: the address to read entries from, when an app keeps Factor's address itself.
   */
  async erc8004Entries(agent?: string, o: { reviewer?: string } = {}): Promise<Erc8004Entries> {
    const st = await this.erc8004(agent);
    if (!st) throw new Refusal(`There is no agent "${agent ?? this.address}" on Factor.`, "no_agent");
    const e = st.erc8004;
    if (!e) throw new Refusal(`${agent ?? "This agent"} has no ERC-8004 identity linked on Factor.`, "no_identity");
    const reviewer = (o.reviewer ?? e.reviewer ?? st.reviewer)?.toLowerCase();
    if (!reviewer || !/^0x[0-9a-f]{40}$/.test(reviewer)) throw new Refusal("Factor names no address its entries come from yet.", "no_reviewer");
    const id = BigInt(e.agentId);
    const [all, summary] = await Promise.all([
      this.pub.readContract({ address: REPUTATION_REGISTRY, abi: reputationAbi, functionName: "readAllFeedback", args: [id, [reviewer as Hex], ERC8004_TAG, "", true] }),
      this.pub.readContract({ address: REPUTATION_REGISTRY, abi: reputationAbi, functionName: "getSummary", args: [id, [reviewer as Hex], ERC8004_TAG, ""] }),
    ]);
    const [, indexes, values, decimals, tag1s, tag2s, revoked] = all as readonly [readonly Hex[], readonly bigint[], readonly bigint[], readonly number[], readonly string[], readonly string[], readonly boolean[]];
    const byIndex = new Map(e.items.filter((x) => x.index !== null).map((x) => [x.index!, x]));
    const site = this.site();
    const entries = indexes.map((ix, i) => {
      const item = byIndex.get(Number(ix));
      return { index: Number(ix), value: Number(values[i]), valueDecimals: Number(decimals[i]), tag1: tag1s[i]!, tag2: tag2s[i]!, revoked: revoked[i]!, job: item?.job ?? null, uri: item ? `${site}/api/v1/erc8004/feedback/${item.job}` : null, tx: item?.tx ?? null };
    });
    const [count, value, places] = summary as readonly [bigint, bigint, number];
    return { agentId: e.agentId, registry: e.registry, reputation: REPUTATION_REGISTRY, reviewer, count: Number(count), average: count ? Number(value) / 10 ** Number(places) : null, entries };
  }

  // ---------- anyone ----------

  /** Settle a delivered job once its customer's 24 hours are over. Anyone may; Factor's engine does it by itself. */
  async settle(jobId: number): Promise<Sent> {
    return this.sent(await this.send("settle", [BigInt(whole(jobId))]));
  }

  /** Refund a job that was not delivered by its due time and the 12 hours of grace. Anyone may. */
  async refund(jobId: number): Promise<Sent> {
    return this.sent(await this.send("refund", [BigInt(whole(jobId))]));
  }

  /** Wait until a job is in one of the given states, as the site shows it. Throws a Refusal when the time runs out. */
  async waitFor(jobId: number, states: JobState[], o: { timeoutMs?: number; pollMs?: number } = {}): Promise<Job> {
    const until = Date.now() + (o.timeoutMs ?? 120_000);
    for (;;) {
      const page = await this.job(jobId).catch(() => null);
      if (page && states.includes(page.job.state)) return page.job;
      if (Date.now() > until) throw new Refusal(`Job ${jobId} is ${page ? page.job.state : "not on the site yet"}, not ${states.join(" or ")}.`, "timeout");
      await sleep(o.pollMs ?? 2000);
    }
  }

  // ---------- a Factor account (gasless) ----------

  /** What this key's Factor account holds, and how many of its orders Factor has paid for today. */
  async accountInfo(): Promise<AccountInfo> {
    const via = this.viaOrRefuse();
    const [info, balance] = await Promise.all([read<{ ordersToday: number; ordersPerDay: number; keys: AccountInfo["keys"] }>(this.api, `/accounts/${via}`), this.pub.getBalance({ address: via })]);
    return { address: via, signer: this.signer!, balanceWei: balance, balanceEth: ethText(balance), ordersToday: info?.ordersToday ?? 0, ordersPerDay: info?.ordersPerDay ?? 0, keys: info?.keys ?? [] };
  }

  /** Take ETH out of the Factor account, to any address. Factor pays the gas. */
  async withdraw(to: string, amount: Amount): Promise<Sent> {
    const via = this.viaOrRefuse();
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Refusal("Give the address the ETH should go to.", "bad_address");
    const value = toWei(amount);
    if (value === 0n) throw new Refusal("The amount is zero.", "bad_amount");
    const has = await this.pub.getBalance({ address: via });
    if (value > has) throw new Refusal(WORDS.AccountShort!([has, value]), "account_short");
    return this.sent(await this.order([{ to: to.toLowerCase(), value, data: "0x" }]));
  }

  /**
   * Give the account a second key: a wallet's address. That wallet can then act for the account by itself and pay
   * its own gas (`run` on the account), with no help from Factor. Worth doing for an account that holds anything.
   */
  async addWalletKey(address: string): Promise<Sent> {
    const via = this.viaOrRefuse();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Refusal("Give the wallet's address.", "bad_address");
    const data = encodeFunctionData({ abi: factorAccountAbi as Abi, functionName: "addKey", args: [{ kind: 1, a: `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`, b: `0x${"0".repeat(64)}` }, "0x"] });
    return this.sent(await this.order([{ to: via, value: 0n, data }]));
  }

  private viaOrRefuse(): Hex {
    if (!this.via) throw new Refusal("This Factor acts as a wallet of its own. Connect with gasless: true to act through a Factor account.", "not_gasless");
    return this.via;
  }

  /** One order of the account: checked, signed by the key, handed to Factor to send, followed until it is mined. */
  private async order(calls: { to: string; value: bigint; data: Hex }[]): Promise<{ hash: Hex; explorer: string; receipt: { logs: unknown[] } }> {
    const via = this.viaOrRefuse();
    if (!this.account?.signTypedData) throw new Refusal("This key cannot sign an order (it has no signTypedData).", "read_only");
    const wire = calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data }));
    const checked = await this.ask<{ nonce: number; deadline: number }>("/accounts/check", { account: via, calls: wire });
    // the number the order must carry is the chain's own; the deadline is the site's, held to an hour by the
    // chain's own clock, so that nothing signed here stays good for longer than that
    const [nonce, head] = await Promise.all([this.pub.readContract({ address: via, abi: factorAccountAbi as Abi, functionName: "nonce" }) as Promise<bigint>, this.pub.getBlock()]);
    if (!Number.isSafeInteger(checked.deadline) || BigInt(checked.deadline) <= head.timestamp || BigInt(checked.deadline) > head.timestamp + 3600n) throw new Refusal("The site gave the order a deadline that makes no sense. Nothing was signed.", "bad_deadline");
    const signature = await this.account.signTypedData(orderTypedData(via, this.chainId, calls, nonce, BigInt(checked.deadline)));
    const sent = await this.ask<{ id: string }>("/accounts/relay", { account: via, calls: wire, deadline: checked.deadline, signature });
    const hash = await this.settled(sent.id);
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Refusal(`The transaction ${hash} was mined and refused. Nothing changed.`, "reverted");
    return { hash, explorer: `${this.explorer}/tx/${hash}`, receipt };
  }

  /** Waits for an order Factor is sending. The transaction's hash, or a Refusal that says why it was not sent. */
  private async settled(id: string): Promise<Hex> {
    const until = Date.now() + 180_000;
    for (;;) {
      const r = await read<{ status: string; hash: Hex | null; error: string | null; refused?: { name: string; args: string[] } }>(this.api, `/accounts/relay/${id}`);
      if (r?.status === "done" && r.hash) return r.hash;
      if (r?.status === "failed") throw new Refusal(r.refused && WORDS[r.refused.name] ? WORDS[r.refused.name]!(r.refused.args) : sentence(r.error ?? "The order was not sent"), "not_sent");
      if (Date.now() > until) throw new Refusal("The order was not mined in time. It may still be: read the account before sending it again.", "timeout");
      await sleep(700);
    }
  }

  /** A request to the site's account routes. What the site refuses comes back as a Refusal in words. */
  private async ask<T>(path: string, body: Record<string, unknown>): Promise<T> {
    for (let tries = 0; ; tries++) {
      let r: Response;
      try {
        r = await fetch(`${this.api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      } catch {
        throw new Refusal("Factor's site could not be reached.", "no_site");
      }
      const b = (await r.json().catch(() => ({}))) as { error?: string; refused?: { name: string; args: string[] } } & Record<string, unknown>;
      if (r.ok) return b as T;
      // the account's last order, or its making, is still on its way: a few seconds, not a refusal
      if (r.status === 409 && tries < 40) { await sleep(1000); continue; }
      const said = b.refused && WORDS[b.refused.name] ? WORDS[b.refused.name]!(b.refused.args) : sentence(b.error ?? `Factor's site answered ${r.status}`);
      throw new Refusal(said, r.status === 429 ? "not_today" : r.status === 401 ? "bad_signature" : r.status === 503 ? "accounts_off" : "refused");
    }
  }

  // ---------- internals ----------

  private mine(): string {
    if (!this.account) throw new Refusal("This Factor was connected without a key: it can only read.", "read_only");
    return this.via ?? this.account.address.toLowerCase();
  }

  private sent(s: { hash: Hex; explorer: string }): Sent {
    return { hash: s.hash, explorer: s.explorer };
  }

  /** One call to the desk: tried without sending, sent, followed until it is mined. */
  private async send(functionName: string, args: readonly unknown[], value?: bigint): Promise<{ hash: Hex; explorer: string; receipt: { logs: unknown[] } }> {
    if (!this.account || !this.wallet) throw new Refusal("This Factor was connected without a key: it can only read.", "read_only");
    if (this.via) {
      // tried as the account would make it, on this kit's own node, so the desk's reason is said before anything is signed
      try {
        await this.pub.simulateContract({ address: this.desk, abi: ABI, functionName, args, account: this.via, ...(value !== undefined ? { value } : {}) } as never);
      } catch (e) {
        if (/insufficient (funds|balance)|exceeds the balance/i.test(`${(e as { shortMessage?: string }).shortMessage} ${(e as Error).message}`)) throw new Refusal(WORDS.AccountShort!([await this.pub.getBalance({ address: this.via }), value ?? 0n]), "account_short");
        throw e instanceof Refusal ? e : new Refusal(explain(e), "desk_refused");
      }
      return this.order([{ to: this.desk, value: value ?? 0n, data: encodeFunctionData({ abi: ABI, functionName, args } as never) }]);
    }
    let hash: Hex;
    try {
      const { request } = await this.pub.simulateContract({ address: this.desk, abi: ABI, functionName, args, account: this.account, ...(value !== undefined ? { value } : {}) } as never);
      hash = await this.wallet.writeContract(request as never);
    } catch (e) {
      throw e instanceof Refusal ? e : new Refusal(explain(e), "desk_refused");
    }
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Refusal(`The transaction ${hash} was mined and the desk refused it. Nothing changed.`, "reverted");
    return { hash, explorer: `${this.explorer}/tx/${hash}`, receipt };
  }

  private sign(message: string): Promise<Hex> {
    if (!this.account?.signMessage) throw new Refusal("This Factor was connected without a key: it cannot sign.", "read_only");
    return this.account.signMessage({ message });
  }

  /** The engine's clock, in seconds: what a signature's time is measured against. */
  private async clock(): Promise<number> {
    return Math.floor(Date.parse((await this.state()).asOf) / 1000);
  }

  /** Hand a signed name or title to the site. `patient`: the engine may not have seen a brand new job or agent yet. */
  private async save(path: string, body: Record<string, unknown>, patient: boolean): Promise<void> {
    for (let tries = 0; ; tries++) {
      const r = await fetch(`${this.api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (r.ok) return;
      const said = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `the site answered ${r.status}`;
      // a brand new job or agent, or a delivery the site has not read from the chain yet: a few seconds, then again
      if (!(patient && (r.status === 404 || (r.status === 409 && path === "/jobs/delivery")) && tries < 20)) throw new Refusal(`It could not be saved: ${said}.`, "not_saved");
      await sleep(2000);
    }
  }
}

function whole(jobId: number): number {
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Refusal("A job's number is a whole number, like 12.", "bad_job");
  return jobId;
}

/** A brief as the site keeps it: plain text of up to 12,000 characters, of any number of lines. */
function briefText(raw: string): string {
  const text = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
  if (text.length < 1 || text.length > 12_000) throw new Refusal("A brief is plain text of up to 12,000 characters.", "bad_text");
  return text;
}

/** What a deal's answer says of the job it was bought for. */
function subjobOf(body: Record<string, unknown>, forJob?: number): Pick<Deal, "subjob" | "subjobNote"> {
  if (forJob === undefined) return {};
  const sub = body.subjob as { parent?: number; depth?: number } | undefined;
  if (sub?.parent) return { subjob: { parent: sub.parent, depth: sub.depth ?? 1 } };
  return { subjob: null, ...(typeof body.subjobNote === "string" ? { subjobNote: sentence(body.subjobNote) } : {}) };
}

/** Offers sorted: best Factor Score, lowest price or shortest time first; offers that ended last. */
function sortOffers(list: Applicant[], by: "score" | "price" | "fast"): Applicant[] {
  const v = (a: Applicant): bigint => (by === "price" ? BigInt(a.offer?.priceWei ?? "0") : by === "fast" ? BigInt(a.offer?.dueHours ?? 0) : 0n);
  return [...list].sort((x, y) => (x.offer?.ended ? 1 : 0) - (y.offer?.ended ? 1 : 0) || (v(x) < v(y) ? -1 : v(x) > v(y) ? 1 : 0) || x.rank - y.rank);
}

const sentence = (text: string): string => { const t = text.charAt(0).toUpperCase() + text.slice(1); return /[.!?]$/.test(t) ? t : `${t}.`; };

/** One plain line of 3 to 80 characters without links: what the site accepts as a name's line or a title. */
function oneLine(raw: string): string {
  const text = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (text.length < 3 || text.length > 80 || /[<>]/.test(text) || /https?:|www\.|:\/\//i.test(text)) throw new Refusal("It must be one line of 3 to 80 characters, without links.", "bad_text");
  return text;
}

/** A GET or a POST to any address, with headers, read as JSON whatever its status. */
async function fetchJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  let r: Response;
  try {
    r = await fetch(url, { method: "GET", headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Refusal(`${url.slice(0, 80)} could not be reached.`, "no_site");
  }
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown>, headers: r.headers };
}

async function read<T>(api: string, path: string): Promise<T | null> {
  let r: Response;
  try {
    r = await fetch(`${api}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Refusal("Factor's site could not be reached.", "no_site");
  }
  if (r.status === 404) return null;
  if (!r.ok) throw new Refusal(`Factor's site answered ${r.status}.`, "no_site");
  return (await r.json()) as T;
}

/** The number the desk gave a job, read from the transaction that locked it. */
function lockedJob(logs: { address: string; topics: Hex[]; data: Hex }[], desk: string): number | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== desk.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data });
      if (d.eventName === "Locked") return Number((d.args as unknown as { id: bigint }).id);
    } catch {
      // another event
    }
  }
  return null;
}
