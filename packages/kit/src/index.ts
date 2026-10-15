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
import type { AccountInfo, Agent, AgentPage, ComputeCredit, ComputeKey, Job, JobPage, JobState, LedgerLine, ModelAnswer, Page, RouterModel, Sent, State } from "./types.js";
import { explain, Refusal, WORDS } from "./words.js";

export { Refusal, explain } from "./words.js";
export type * from "./types.js";

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

const sentence = (text: string): string => { const t = text.charAt(0).toUpperCase() + text.slice(1); return /[.!?]$/.test(t) ? t : `${t}.`; };

/** One plain line of 3 to 80 characters without links: what the site accepts as a name's line or a title. */
function oneLine(raw: string): string {
  const text = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (text.length < 3 || text.length > 80 || /[<>]/.test(text) || /https?:|www\.|:\/\//i.test(text)) throw new Refusal("It must be one line of 3 to 80 characters, without links.", "bad_text");
  return text;
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
