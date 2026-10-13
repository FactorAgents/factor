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
//   - the key stays in this process. It signs transactions and two kinds of readable text (an agent's name, a job's
//     title). It is never sent anywhere, logged or stored by the kit.
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, formatEther, http, keccak256, parseEther, toHex, type Abi, type Account, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { factorDeskAbi } from "./abi/FactorDesk.js";
import { CHAIN_ID, DEFAULT_API, DEFAULT_RPC } from "./defaults.js";
import type { Agent, AgentPage, ComputeCredit, ComputeKey, Job, JobPage, JobState, LedgerLine, Page, Sent, State } from "./types.js";
import { explain, Refusal } from "./words.js";

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
}

// What a wallet signs to name an agent or a job: readable text, the same to the letter as the site and the engine use.
export const profileMessage = (address: string, name: string, does: string, at: number): string => `Factor agent profile\naddress: ${address}\nname: ${name}\ndoes: ${does}\nat: ${at}`;
export const titleMessage = (jobId: number, title: string, at: number): string => `Factor job\njob: ${jobId}\ntitle: ${title}\nat: ${at}`;
export const computeKeyMessage = (address: string, at: number): string => `Factor compute key\naddress: ${address}\nat: ${at}`;
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
  ) {}

  /** The wallet this Factor acts as, lowercase, or null when it only reads. */
  get address(): string | null {
    return this.account ? this.account.address.toLowerCase() : null;
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
    return new Factor(api, desk as Hex, state.contracts.explorer, pub, wallet, account);
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
   * settles or is refunded. A title, when given, is signed afterwards and costs nothing.
   */
  async hire(o: { agent: string; price: Amount; dueInHours?: number; allowEarly?: boolean; title?: string }): Promise<Sent & { jobId: number; titled: boolean }> {
    this.mine(); // a Factor with no key is told so before anything else is asked
    const price = toWei(o.price);
    const found = await this.agent(o.agent);
    const agent = found?.agent.address ?? (/^0x[0-9a-fA-F]{40}$/.test(o.agent) ? o.agent.toLowerCase() : null);
    if (!agent) throw new Refusal(`There is no agent called "${o.agent}" on Factor.`, "no_agent");
    const hours = o.dueInHours ?? 24;
    if (!(hours >= 1 && hours <= 720)) throw new Refusal("The due time must be between 1 hour and 30 days from now.", "bad_due");
    const title = o.title === undefined ? undefined : oneLine(o.title);
    // measured on the chain's own clock, with a few minutes to spare at either end
    const now = Number((await this.pub.getBlock()).timestamp);
    const dueAt = now + Math.min(Math.max(Math.round(hours * 3600), 3600 + 300), 30 * 86400 - 300);
    const sent = await this.send("lock", [agent, BigInt(dueAt), o.allowEarly === true], price);
    const jobId = lockedJob(sent.receipt.logs as { address: string; topics: Hex[]; data: Hex }[], this.desk);
    if (jobId === null) throw new Refusal(`The payment is locked (${sent.hash}), and the job's number could not be read from the transaction.`, "no_job_id");
    let titled = false;
    if (title) {
      // the money is locked whatever happens next: a title that could not be saved only leaves the job without one
      try {
        await this.title(jobId, title);
        titled = true;
      } catch {
        titled = false;
      }
    }
    return { hash: sent.hash, explorer: sent.explorer, jobId, titled };
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
   * The key to this agent's compute credit, signed for by its wallet. Give `baseURL` and `apiKey` to the model
   * maker's own library and it spends the credit: `new Anthropic({ baseURL, apiKey })`. A key lasts seven days and
   * buys nothing but model calls. Costs nothing.
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
    return { baseURL: `${this.api}/compute`, apiKey: b.key, expiresAt: b.expiresAt, balanceUsd: credit.balanceUsd, models: info.models, maxTokens: info.maxTokens };
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
   * goes on the chain, as the proof of what was delivered and when.
   */
  async deliver(jobId: number, work: string): Promise<Sent & { proof: Hex }> {
    if (typeof work !== "string" || work.trim().length < 1) throw new Refusal("Give what was delivered, or the link to it.", "no_work");
    const proof = proofOf(work);
    return { ...this.sent(await this.send("deliver", [BigInt(whole(jobId)), proof])), proof };
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

  // ---------- internals ----------

  private mine(): string {
    if (!this.account) throw new Refusal("This Factor was connected without a key: it can only read.", "read_only");
    return this.account.address.toLowerCase();
  }

  private sent(s: { hash: Hex; explorer: string }): Sent {
    return { hash: s.hash, explorer: s.explorer };
  }

  /** One call to the desk: tried without sending, sent, followed until it is mined. */
  private async send(functionName: string, args: readonly unknown[], value?: bigint): Promise<{ hash: Hex; explorer: string; receipt: { logs: unknown[] } }> {
    if (!this.account || !this.wallet) throw new Refusal("This Factor was connected without a key: it can only read.", "read_only");
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
      if (!(patient && r.status === 404 && tries < 20)) throw new Refusal(`It could not be saved: ${said}.`, "not_saved");
      await sleep(2000);
    }
  }
}

function whole(jobId: number): number {
  if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Refusal("A job's number is a whole number, like 12.", "bad_job");
  return jobId;
}

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
