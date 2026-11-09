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
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, formatEther, http, keccak256, parseEther, toHex, type Abi, type Account, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { factorAccountAbi } from "./abi/FactorAccount.js";
import { factorAccountsAbi } from "./abi/FactorAccounts.js";
import { factorDeskAbi } from "./abi/FactorDesk.js";
import { agentCoinLauncherAbi } from "./abi/AgentCoinLauncher.js";
import { factorLineAbi } from "./abi/FactorLine.js";
import { factorLineAccountAbi } from "./abi/FactorLineAccount.js";
import { drawParts, lineWordsOf } from "./lines.js";
import { factorGuaranteeAbi } from "./abi/FactorGuarantee.js";
import { coverFee, guaranteeWordsOf } from "./guarantees.js";
import { factorBountyAbi } from "./abi/FactorBounty.js";
import { BOUNTY_STATES, bountyEntryHash, bountyParts, bountyReadMessage, bountyWordsOf, bytesOf, MIN_PRIZE_WEI, TASK_BYTES, textHash, WORK_BYTES } from "./bounties.js";
import { factorMilestonesAbi } from "./abi/FactorMilestones.js";
import { checkTerms, MAX_STAGE_S, MILESTONE_STATES, milestoneWordsOf, MIN_STAGE_S, MIN_STAGE_WEI, termsHash } from "./milestones.js";
import { caseNumber, CASE_WORDS, checkReason, checkVerifierTerms, commitOf, keepVerdict, makerName, MIN_BOND_WEI, MIN_FEE_WEI, MIN_JOB_WEI, readVerdict, reasonHashOf, saltOf, sealMessage, sendVerifierText, VERIFIER_STATES, VERIFIERS_ABI, VERIFIERS_GASLESS, verifiersOff, verifierTermsHash } from "./verifiers.js";
import { CHAIN_ID, DEFAULT_API, DEFAULT_RPC } from "./defaults.js";
import type { AccountInfo, Agent, AgentPage, Applicant, Application, AutoApplyStatus, ComputeCredit, ComputeKey, Deal, Erc8004Entries, Erc8004Status, Firm, FirmHire, FirmPage, FirmRecord, Job, JobPage, JobState, JobTree, LedgerLine, ModelAnswer, OpenJob, OpenJobHire, PickedJob, OpenJobPage, OpenJobPosted, Page, PayLinkInfo, Plan, PlanMonthSent, PlanPage, RouterModel, Sent, State, SubJob, OwnerCheck, VerifiedStatus, Coin, CoinsAbout, CoinLaunched, CoinLaunchTx, CreditLine, LinesAbout, LineSent, AgentGuarantee, Cover, CoverState, CoveredHire, GuaranteesAbout, GuaranteeSent, BountiesAbout, Bounty, BountyPage, BountyEntry, BountyPoster, AgentBounties, BountyPosted, BountyEntered, BountyPicked, BountyState, Burn, PublishedLink, MilestonesAbout, MilestonePlan, MilestonesHired, MilestoneSent, MilestoneState, AgentMilestones, VerifiersAbout, Verifier, VerifierCase, VerifierCaseState, VerifierPage, VerifierSent, VerifiedHire, VerdictGiven, VerdictSealed } from "./types.js";
import { coinAskMessage, coinDescription, coinLogo, coinNameProblem, coinPermissionTypedData, suggestCoin, type CoinPermission } from "./coins.js";
import { MONTH_S, PLAN_TITLE_MOST, planMessage, stopPlanMessage, type PlanText } from "./plans.js";
import { FIRM_SLUG, firmHireMessage, firmMessage, joinMessage, leaveMessage, slugOf } from "./firms.js";
import { hireMessage, type HirePlan } from "./subjobs.js";
import { applyMessage, closeJobMessage, PITCH_MOST, postJobMessage, withdrawMessage, type Offer, type OpenJobText, type PickRule } from "./openjobs.js";
import { KINDS, rulesMessage, type AutoApplyRules, type BidRule } from "./autoapply.js";
import { verifyOwnerMessage } from "./verified.js";
import { ERC8004_TAG, erc8004LinkMessage, erc8004Registry, IDENTITY_REGISTRY, identityAbi, REPUTATION_REGISTRY, reputationAbi } from "./erc8004.js";
import { explain, Refusal, verifierWordsOf, WORDS } from "./words.js";
import { checkAgent, checkAgents, hireLink, type CheckedAgent, type CheckedAgents, type HireLinkOptions } from "./everywhere.js";
import { ask, type Asked } from "./ask.js";
import { copilot, copilotText, type Copiloted } from "./copilot.js";
import { reviewOf, reviews, reviewsText, reviewText, reviewTyped, replyTyped, sendReview, type AgentReviews, type JobReview, type Review } from "./reviews.js";
import { agentBuilder, builderRecord, builderRecordText, heyLinkMessage, sendHeyLink, type AgentBuilder, type HeyLookup } from "./hey.js";

import { encodePayLink, LINK_BRIEF_MOST, readPayLink, tokenOf, verifyRecord, x402PaymentHeader, X402_NETWORK, X402_SCHEME, type AgentRecord, type PayLink, type X402Requirements, payLinkMessage } from "./pay.js";

export { Refusal, explain } from "./words.js";
export type * from "./types.js";
export { encodePayLink, payLinkId, payLinkMessage, readPayLink, tokenOf, verifyRecord, x402PaymentHeader, RECORD_TYPES, X402_NETWORK, X402_SCHEME } from "./pay.js";
export type { AgentRecord, PayLink, RecordMessage, X402Requirements } from "./pay.js";
export { hireMessage, planIdOf } from "./subjobs.js";
export { firmHireMessage, firmMessage, joinMessage, leaveMessage, slugOf } from "./firms.js";
export { MONTH_S, monthlyPlanId, planMessage, stopPlanMessage } from "./plans.js";
export { verifyOwnerMessage } from "./verified.js";
export { coinAskMessage, coinDescription, coinLogo, coinNameProblem, coinPermissionTypedData, suggestCoin } from "./coins.js";
export type { CoinPermission } from "./coins.js";
export { drawParts, LINE_WORDS } from "./lines.js";
export { coverFee, GUARANTEE_WORDS } from "./guarantees.js";
export { BOUNTY_WORDS, bountyEntryHash, bountyParts, bountyReadMessage, MIN_PRIZE_WEI, TASK_BYTES, WORK_BYTES } from "./bounties.js";
export { checkTerms, MAX_STAGES, MILESTONE_WORDS, MIN_STAGE_WEI, MIN_STAGES, termsHash, termsText } from "./milestones.js";
export type { Terms } from "./milestones.js";
export { VERIFIER_WORDS, verifierWordsOf } from "./words.js";
export { CASE_WORDS, checkReason, checkVerifierTerms, commitOf, disputeBondOf, keepVerdict, makerName, MAKERS, readVerdict, reasonHashOf, saltOf, sealMessage, sendVerifierText, stakeOf, VERIFIER_STATES, VERIFIERS_ABI, VERIFIERS_GASLESS, verifierTermsHash, verifierTermsText } from "./verifiers.js";
export type { KeptVerdict } from "./verifiers.js";
export { ERC8004_TAG, erc8004LinkMessage, erc8004Registry, IDENTITY_REGISTRY, REPUTATION_REGISTRY, SCORE_TAG } from "./erc8004.js";
export { checkAgent, checkAgents, embedSnippet, everywhereAbout, everywhereSigner, FactorConnect, hireLink, verifyAnswer, verifyWebhook } from "./everywhere.js";
export { ask, askedText } from "./ask.js";
export { copilot, copilotText } from "./copilot.js";
export type { Copiloted, CopilotAction, CopilotCall, CopilotReply } from "./copilot.js";
export { REVIEW_MOST_CHARS, REVIEW_TAG, REVIEW_TYPES, replyTyped, reviewOf, reviews, reviewsText, reviewText, reviewTyped } from "./reviews.js";
export type { AgentReviews, JobReview, Review, ReviewStanding } from "./reviews.js";
export { agentBuilder, builderRecord, builderRecordText, heyLinkMessage } from "./hey.js";
export type { AgentBuilder, BuilderRecord, HeyFacts, HeyLookup, NotOnHey } from "./hey.js";
export type { Asked, AskAgent, AskStage } from "./ask.js";
export type { AgentAnswer, AnswerEnvelope, CheckedAgent, CheckedAgents, ConnectHire, ConnectTicket, EmbedPart, HireLinkOptions, SealedAnswer } from "./everywhere.js";
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
    const made = await f.askSite<{ address: string; deployed: boolean; relay: string | null }>("/accounts", { kind: "wallet", address: account.address.toLowerCase() });
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

  /** Every buy back and burn of $FACTOR, newest first: the ETH each spent and the tokens it burned. */
  async burns(o: { limit?: number; before?: number } = {}): Promise<Burn[]> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined) q.set(k, String(v));
    return (await read<Page<Burn>>(this.api, `/burns${q.size ? `?${q}` : ""}`))?.items ?? [];
  }

  // ---------- a customer ----------

  /**
   * Hire an agent: lock the price of a job for it. The ETH leaves this wallet and is held by the desk until the job
   * settles or is refunded. A title and a brief, when given, are signed afterwards and cost nothing. The brief is
   * what the agent works from, at whatever length it needs (up to 12,000 characters); anyone can read it on the
   * job's page. Factor's own agents need one: `agent.service.needs` says what to put in it.
   */
  async hire(o: { agent: string; price: Amount; dueInHours?: number; allowEarly?: boolean; title?: string; brief?: string; /** hire with cover (hireWithCover): how much, or "max" for all the agent covers on this job */ cover?: Amount | "max" }): Promise<Sent & { jobId: number; titled: boolean; briefed: boolean }> {
    if (o.cover !== undefined) return this.hireWithCover(o.agent, o.price, { ...o, cover: o.cover });
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
    // a job locked for this agent's line account is drawn on through it, held to what the line leaves
    const acct = await this.lineAccountForJob(jobId);
    if (acct) return this.sent(await this.callLine(acct, LINE_ACCOUNT, "drawAdvance", [...args], 0n));
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
   * keeps the ones whose name or maker has it ("gpt", "claude", "deepseek"). Needs no key. While Factor serves it,
   * raeto/auto and its variants come first, marked `auto`: Raeto picks the model for each request, and a call costs
   * what Raeto charged for it, with the margin, so they have no price of their own here.
   */
  async computeModels(search?: string): Promise<RouterModel[]> {
    const list = await read<{ data?: { id: string; name?: string; owned_by?: string; context_length?: number; pricing?: { inUsd: number; outUsd: number } }[] }>(this.api, "/compute/v1/models");
    const words = search?.trim().toLowerCase();
    return (list?.data ?? [])
      .map((m) => ({ id: m.id, name: m.name ?? m.id, maker: m.owned_by ?? m.id.split("/")[0]!, contextLength: m.context_length ?? 0, inUsd: m.pricing?.inUsd ?? 0, outUsd: m.pricing?.outUsd ?? 0, ...(isAuto(m.id) ? { auto: true } : {}) }))
      .filter((m) => !words || `${m.id} ${m.name}`.toLowerCase().includes(words));
  }

  /**
   * Ask a model, paid from this agent's compute credit: one line for an agent that has no library of its own.
   * `model` is any model of the second door ("openai/gpt-5", "anthropic/claude-sonnet-4.5", "deepseek/deepseek-chat"),
   * "raeto/auto" (or a variant, like "raeto/auto:cheap") while Factor serves it, which has Raeto pick the model for this
   * request, or, while Factor serves Claude directly, one of its own names ("claude-sonnet-5-5"). The key is signed for
   * once and used until it runs out. The answer says which model answered, and, through raeto/auto, what it cost.
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
    const d = b as { model?: string; choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; raeto?: { model?: string } };
    // through raeto/auto the gateway says which model Raeto picked and what the call took from the credit
    const picked = r.headers.get("x-raeto-model") ?? d.raeto?.model;
    const cost = r.headers.get("x-factor-cost-usd");
    return { text: d.choices?.[0]?.message?.content ?? "", model: picked || d.model || o.model, inputTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0, ...(cost && /^\d+(\.\d+)?$/.test(cost) ? { costUsd: Number(cost) } : {}) };
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
    this.mine();
    // a job locked for this agent's line account is delivered through it
    const acct = await this.lineAccountForJob(jobId);
    const sent = this.sent(acct ? await this.callLine(acct, LINE_ACCOUNT, "deliver", [BigInt(whole(jobId)), proof], 0n) : await this.send("deliver", [BigInt(whole(jobId)), proof]));
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
    this.mine();
    const acct = await this.lineAccountForJob(jobId);
    if (acct) return this.sent(await this.callLine(acct, LINE_ACCOUNT, "decline", [BigInt(whole(jobId))], 0n));
    return this.sent(await this.send("decline", [BigInt(whole(jobId))]));
  }

  /**
   * Every job locked for this agent, as it appears, for as long as the loop runs:
   *   for await (const job of factor.jobsForMe()) { ... }
   * With `open: true` the jobs already waiting come first.
   */
  async *jobsForMe(o: { open?: boolean; pollMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<Job> {
    const me = this.mine();
    // with a credit line, new jobs are locked for its line account: those are this agent's too
    const account = await this.line(me).then((l) => (l && l.key === me ? l.account : null)).catch(() => null);
    let seen = 0;
    let first = true;
    while (!o.signal?.aborted) {
      const both = await Promise.all([me, ...(account ? [account] : [])].map((agent) => this.jobs({ agent, limit: 50 }).catch(() => [] as Job[])));
      const mine = both.flat().sort((a, b) => a.n - b.n);
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

  /** The links an agent published on its page that have not expired. Left out: this wallet's own. */
  async payLinks(agent?: string): Promise<PublishedLink[]> {
    const address = await this.agentAddress(agent ?? this.mine());
    return (await read<{ items: PublishedLink[] }>(this.api, `/pay/links/${address}`))?.items ?? [];
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

  /**
   * Factor everywhere: one agent's Factor Score, record, credit line headroom and Guarantee, by its address, its name or
   * its ERC-8004 identity ("8004:42"), in an answer Factor signs; the signature is checked against `signer` (keep your own
   * copy of Factor's address), or the one Factor's site names.
   */
  checkAgent(id: string, signer?: string): Promise<CheckedAgent> {
    return checkAgent(id, { api: this.api, signer });
  }

  /** Up to 25 agents in one signed answer, checked. */
  checkAgents(ids: string[], signer?: string): Promise<CheckedAgents> {
    return checkAgents(ids, { api: this.api, signer });
  }

  /** The address of Factor's pay flow filled in for one agent: a person opens it, locks the payment and signs there. */
  hireLink(o: Omit<HireLinkOptions, "site">): string {
    return hireLink({ ...o, site: this.api });
  }

  /**
   * Ask Factor: one sentence ("a landing page for my coin by Friday, under 0.02 ETH") made into a job, with the agents
   * that fit it, the reasons from each one's record, and the pay flow filled in for each. Nothing is paid or signed:
   * the person opens a link, checks every field and locks the payment there. `tz`: their offset from UTC in minutes.
   */
  ask(sentence: string, o: { tz?: number } = {}): Promise<Asked> {
    return ask(sentence, { api: this.api, ...o });
  }

  /**
   * Factor Copilot: one message in a chat that runs the desk. It asks for what is missing, answers from the desk, and
   * prepares an unsigned action when there is one; nothing is signed or paid by it. `conversation`: from the last answer.
   */
  copilot(message: string, o: { conversation?: string; address?: string; tz?: number } = {}): Promise<Copiloted> {
    return copilot(message, { api: this.api, ...o });
  }

  /** A Copilot answer in words, with the link where the person signs its action: the site this Factor talks to. */
  copilotText(c: Copiloted): string {
    return copilotText(c, { api: this.api });
  }

  /** An agent's paid reviews (docs/REVIEWS.md): the average weighted by what each job paid, the count, every review. Reads only. */
  reviews(agent: string, o: { limit?: number } = {}): Promise<AgentReviews> {
    return reviews(agent, { api: this.api, ...o });
  }

  /** A job's review, its history and the agent's reply, and who may review it until when. Reads only. */
  reviewOf(job: number): Promise<JobReview> {
    return reviewOf(job, { api: this.api });
  }

  /** An agent's reviews in words, the customers' words quoted as theirs. */
  reviewsText(r: AgentReviews): string {
    return reviewsText(r, { api: this.api });
  }

  /**
   * A project's builder record on HEY Research Lab, the public record of building on Robinhood Chain (docs/HEY.md): by its
   * name, its $TICKER, its HEY page or a 0x contract. HEY's facts as HEY gives them, with the page they are from. Not a
   * rating, and never in the Factor Score. Reads only.
   */
  builderRecord(project: string): Promise<HeyLookup> {
    return builderRecord(project, { api: this.api });
  }

  /** The project on HEY an agent's owner linked it to, and that project's builder record. Reads only. */
  agentBuilder(agent: string): Promise<AgentBuilder> {
    return agentBuilder(agent, { api: this.api });
  }

  /** A builder record in words, with the source. */
  builderRecordText(r: HeyLookup, o: { agent?: string } = {}): string {
    return builderRecordText(r, o);
  }

  /**
   * Link an agent to its maker's project on HEY, as its owner: one signature, no gas. `project` is the project's slug on
   * HEY (like "factor") or a 0x contract HEY ties to it; "none" unlinks. This wallet must be the one that runs the agent on
   * Factor (the agent's own, or the wallet that made it on the site). The project must be one HEY has published.
   */
  async linkHey(project: string, o: { agent?: string } = {}): Promise<AgentBuilder["link"]> {
    const by = this.mine();
    const raw = o.agent ?? by;
    const agent = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : (await this.agent(raw))?.agent.address ?? null;
    if (!agent) throw new Refusal(`There is no agent ${raw} on Factor.`, "no_agent");
    const p = String(project ?? "").trim();
    const given = /^0x[0-9a-fA-F]{40}$/.test(p) ? p.toLowerCase() : p;
    if (given !== "none" && !/^0x[0-9a-f]{40}$/.test(given) && !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(given)) throw new Refusal('Name the project by its slug on HEY (like "factor"), a 0x contract, or "none" to unlink.', "bad_project");
    const at = await this.clock();
    const signature = await this.sign(heyLinkMessage({ agent, project: given, at }));
    return sendHeyLink({ agent, by, project: given, at, signature }, { api: this.api });
  }

  /** The key that signs a review or a reply: the wallet's own. Through a Factor account, the site's job page signs instead. */
  private typedSigner(): NonNullable<Account["signTypedData"]> {
    if (!this.account?.signTypedData) throw new Refusal("This Factor was connected without a key: it cannot sign.", "read_only");
    if (this.via) throw new Refusal("A review is signed by the wallet itself; this Factor acts through a Factor account. Sign it on the job's page instead.", "gasless");
    return this.account.signTypedData.bind(this.account) as NonNullable<Account["signTypedData"]>;
  }

  /**
   * Review a job this wallet paid for, once it is paid: 1 to 5 stars and up to 500 characters of words (none is fine).
   * Signed as EIP-712 typed data with this key; nothing is sent to the chain and no ETH moves. Signing again within
   * seven days changes it, and the version before stays under it.
   */
  async review(job: number, stars: number, words = ""): Promise<Review> {
    const sign = this.typedSigner();
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Refusal("Stars are a whole number from 1 to 5.", "bad_stars");
    const text = reviewText(words);
    if (text === null) throw new Refusal("A review's words are 500 characters at most.", "bad_text");
    const j = await reviewOf(job, { api: this.api });
    const me = this.address!;
    if (!j.standing.reviewer) throw new Refusal(`Job ${job} has no review: ${j.standing.why ?? "nobody reviews it"}.`, "no_review");
    if (j.standing.reviewer !== me) throw new Refusal(`Only the wallet that paid for job ${job} can review it, and this one is ${me}.`, "not_yours");
    if (!j.standing.open) throw new Refusal(`Job ${job} cannot be reviewed now: ${j.standing.why}.`, "closed");
    const at = await this.clock();
    const signature = await sign(reviewTyped({ chainId: this.chainId, desk: this.desk, job, agent: j.agent, reviewer: me, stars, text, at }) as never);
    return (await sendReview("/reviews", { job, stars, text, at, reviewer: me, signature }, { api: this.api }))!;
  }

  /**
   * The agent's one public answer to a review of its job, signed by this key: the agent's own wallet, or the wallet that
   * runs it on Factor. It answers the review's latest version and can never be changed.
   */
  async reply(job: number, words: string): Promise<Review> {
    const sign = this.typedSigner();
    const text = reviewText(words);
    if (!text) throw new Refusal("A reply is 1 to 500 characters of plain words.", "bad_text");
    const j = await reviewOf(job, { api: this.api });
    const me = this.address!;
    if (!j.review) throw new Refusal(`Job ${job} has no review to answer.`, "no_review");
    if (j.review.reply) throw new Refusal("This review has its answer already: a reply is never changed.", "replied");
    if (!j.standing.repliers.includes(me)) throw new Refusal(`Only the agent's own wallet, or the wallet that runs it on Factor, can answer; this one is ${me}.`, "not_yours");
    const at = await this.clock();
    const signature = await sign(replyTyped({ chainId: this.chainId, desk: this.desk, job, agent: j.agent, by: me, review: j.review.digest as Hex, text, at }) as never);
    return (await sendReview("/reviews/reply", { job, text, at, by: me, review: j.review.digest, signature }, { api: this.api }))!;
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
  async hireFirm(slug: string, o: { price: Amount; title: string; brief?: string; dueInHours?: number; allowEarly?: boolean; maxEth?: Amount; /** with cover from the lead's guarantee bond: how much, or "max" */ cover?: Amount | "max" }): Promise<FirmHire> {
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
    let sent: { hash: Hex; explorer: string }, jobId: number | null, covered: Awaited<ReturnType<Factor["lockWithCover"]>> | null = null;
    if (o.cover !== undefined) {
      // the cover is the lead's: it is the desk agent of the firm's jobs
      covered = await this.lockWithCover(f.lead.address, dueAt, o.allowEarly === true, price, await this.coverAmount(f.lead.address, price, o.cover));
      sent = { hash: covered.lockTx, explorer: `${this.explorer}/tx/${covered.lockTx}` };
      jobId = covered.jobId;
    } else {
      const s = await this.send("lock", [f.lead.address, BigInt(dueAt), o.allowEarly === true], price);
      sent = s;
      jobId = lockedJob(s.receipt.logs as { address: string; topics: Hex[]; data: Hex }[], this.desk);
    }
    if (jobId === null) throw new Refusal(`The payment is locked (${sent.hash}), and the job's number could not be read from the transaction.`, "no_job_id");
    const out: FirmHire = { jobId, firm: f.slug, lead: f.lead.address, hash: sent.hash, explorer: sent.explorer, jobUrl: `${this.site()}/jobs/${String(jobId).padStart(4, "0")}`, filed: false, ...(covered ? { cover: covered.coverId, coverEth: ethText(covered.amount), tied: covered.tied } : {}) };
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
  async subscribe(o: { agent?: string; firm?: string; price: Amount; months: number; allowEarly?: boolean; title: string; brief?: string; maxEth?: Amount; link?: string; /** month 1 with cover from the agent's guarantee bond: how much, or "max" */ cover?: Amount | "max" }): Promise<PlanMonthSent> {
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
    return this.lockMonth(made.plan, 1, o.months, agent, now + MONTH_S - 300, p.early, price, burnWei, pot, o.cover);
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
  async payMonth(planId: string, o: { maxEth?: Amount; /** this month with cover from the agent's guarantee bond: how much, or "max" */ cover?: Amount | "max" } = {}): Promise<PlanMonthSent> {
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
    return this.lockMonth(p.id as Hex, p.next.month, p.months, p.agent.address, Math.min(ends, now + MONTH_S - 300), p.early, price, burnWei, pot, o.cover);
  }

  private async lockMonth(plan: Hex, month: number, months: number, agent: string, dueAt: number, early: boolean, price: bigint, burnWei: bigint, pot: string, cover?: Amount | "max"): Promise<PlanMonthSent> {
    let lockTx: Hex, burnTx: Hex | null, jobId: number, coverEth: string | undefined;
    if (cover !== undefined) {
      // the month with cover: reserved first, locked on exactly its terms, tied, and the burn beside it
      const c = await this.lockWithCover(agent, dueAt, early, price, await this.coverAmount(agent, price, cover), burnWei > 0n ? [{ to: pot as Hex, value: burnWei }] : []);
      ({ lockTx, jobId } = c);
      burnTx = c.extraTx;
      coverEth = ethText(c.amount);
    } else ({ lockTx, burnTx, jobId } = await this.lockAndBurn(agent, dueAt, early, price, burnWei, pot));
    const out: PlanMonthSent = { plan, month, months, jobId, lockTx, burnTx, burned: false, linked: false, planUrl: `${this.site()}/plans/${plan}`, jobUrl: `${this.site()}/jobs/${String(jobId).padStart(4, "0")}`, explorer: `${this.explorer}/tx/${lockTx}`, ...(coverEth ? { coverEth } : {}) };
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

  // ---------- agent coins ----------

  /** Every listed agent coin: by what its fees have paid to its agent's compute (the default), or newest first. */
  async coins(o: { sort?: "fees" | "new" } = {}): Promise<Coin[]> {
    return (await read<{ items: Coin[] }>(this.api, `/coins${o.sort === "new" ? "?sort=new" : ""}`))?.items ?? [];
  }

  /**
   * One agent's coin, by the agent's name or address or the coin's own address: what its fees have paid for (its
   * agent's compute, the $FACTOR burn), its trading and its holders. null: none is listed. Left out: this wallet's agent.
   */
  async coin(id?: string): Promise<Coin | null> {
    const who = id ?? this.mine();
    if (!/^[0-9a-zA-Z-]{3,42}$/.test(who)) throw new Refusal("Give the agent's name or address, or the coin's address.", "bad_agent");
    return read<Coin>(this.api, `/coins/${who}`);
  }

  /** Where an agent's maker launches its coin on the site, with a wallet. */
  coinLaunchLink(agent: string): string {
    return `${this.site()}/agents/${agent}#coin`;
  }

  /**
   * As an agent: sign the permission for `maker` to launch this agent's coin with these words. A signature, not a
   * transaction, and no money. The maker sends it with launchCoin({ agent, permission }) within `validMinutes` (60).
   * The name and the ticker are the agent's own by default. cancelCoinPermissions() takes back every one given.
   */
  async signCoinPermission(o: { maker: string; name?: string; symbol?: string; validMinutes?: number }): Promise<CoinPermission> {
    const agent = this.mine();
    if (!this.account?.signTypedData) throw new Refusal("This key cannot sign typed data.", "read_only");
    if (!/^0x[0-9a-fA-F]{40}$/.test(o.maker)) throw new Refusal("Give the maker's wallet address.", "bad_address");
    const maker = o.maker.toLowerCase();
    const { launcher, site } = await this.launcher();
    const words = await this.coinWords(agent, o.name, o.symbol, site);
    const [nonce, block] = await Promise.all([this.pub.readContract({ address: launcher, abi: LAUNCHER, functionName: "nonces", args: [agent] }) as Promise<bigint>, this.pub.getBlock()]);
    const minutes = Math.min(Math.max(o.validMinutes ?? 60, 5), 7 * 24 * 60);
    const deadline = block.timestamp + BigInt(Math.round(minutes * 60));
    const signature = await this.account.signTypedData(coinPermissionTypedData({ chainId: this.chainId, launcher, agent, maker, ...words, nonce, deadline }));
    return { agent, maker, ...words, nonce: nonce.toString(), deadline: deadline.toString(), signature, launcher };
  }

  /** As an agent: take back every permission this agent has signed for a launch of its coin. One transaction. */
  async cancelCoinPermissions(): Promise<Sent> {
    this.mine();
    const { launcher } = await this.launcher();
    return this.sent(await this.callLauncher(launcher, "bumpNonce", [], 0n));
  }

  /**
   * Launch an agent's coin on Pons. As the agent itself (leave `agent` out): it launches its own, and `maker` (this
   * wallet when left out) is the wallet its maker's share goes to. As its maker: give `agent`, and either the
   * `permission` the agent signed, or nothing for an agent Factor runs (made on the site, or Factor's own), whose
   * permission Factor signs once this wallet has signed the ask. One coin per agent, ever.
   *
   * It costs Pons' launch fee and the gas, and `firstBuy` (ETH, optional) buys the coin for the maker in the launch
   * itself, before anybody else can trade. The name and the ticker are the agent's own by default, and are checked
   * against the rule before anything is signed or sent.
   */
  async launchCoin(o: { agent?: string; name?: string; symbol?: string; firstBuy?: Amount; maker?: string; permission?: CoinPermission } = {}): Promise<CoinLaunched> {
    const me = this.mine();
    const agent = o.agent ? await this.agentAddress(o.agent) : me;
    const { launcher, fee, site } = await this.launcher();
    let maker: string, deadline = 0n, sig: Hex = "0x", words: { name: string; symbol: string; logo: string; description: string };
    if (agent === me) {
      if (o.maker !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(o.maker)) throw new Refusal("Give the maker's wallet address.", "bad_address");
      maker = (o.maker ?? me).toLowerCase();
      words = await this.coinWords(agent, o.name, o.symbol, site);
    } else {
      maker = me;
      let p = o.permission;
      if (p) {
        if (p.agent.toLowerCase() !== agent || p.maker.toLowerCase() !== me) throw new Refusal("That permission is for another agent or another maker.", "bad_permission");
        if (p.launcher.toLowerCase() !== launcher) throw new Refusal("That permission is for another launcher.", "bad_permission");
      } else {
        // an agent Factor runs: this wallet signs the ask, and Factor signs the agent's permission for it
        const w = await this.coinWords(agent, o.name, o.symbol, site);
        const at = await this.clock();
        const signature = await this.sign(coinAskMessage({ agent, maker: me, name: w.name, symbol: w.symbol, at }));
        // a 409 here is an answer (the agent has its coin already), not an order still on its way: not asked again
        p = await this.askSite<CoinPermission>("/coins/permission", { agent, maker: me, name: w.name, symbol: w.symbol, at, signature }, false);
      }
      words = { name: p.name, symbol: p.symbol, logo: p.logo, description: p.description };
      deadline = BigInt(p.deadline);
      sig = p.signature;
    }
    const value = fee + (o.firstBuy === undefined ? 0n : toWei(o.firstBuy));
    const params = { ...words, socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" }, creatorFeeRecipient: "0x0000000000000000000000000000000000000000" as Hex, creatorTaxBps: 0, buybackEnabled: false, expectedEconomics: `0x${"0".repeat(64)}` as Hex, salt: keccak256(toHex(`${agent}:${Date.now()}`)) };
    const sent = await this.callLauncher(launcher, "launch", [agent, maker, params, 0n, deadline, sig], value);
    let coin: string | null = null;
    for (const log of sent.receipt.logs as { address: string; topics: Hex[]; data: Hex }[]) {
      if (log.address.toLowerCase() !== launcher) continue;
      try {
        const d = decodeEventLog({ abi: LAUNCHER, topics: log.topics as [Hex, ...Hex[]], data: log.data });
        if (d.eventName === "CoinLaunched") coin = String((d.args as unknown as { coin: string }).coin).toLowerCase();
      } catch {
        // another event
      }
    }
    const page = await this.agent(agent).catch(() => null);
    return { hash: sent.hash, explorer: sent.explorer, coin, url: `${site}/coins/${page?.agent.named ? page.agent.name : agent}` };
  }

  /**
   * A launch made ready for a maker who signs it with a wallet of its own (a phone, a hardware wallet): the exact
   * transaction, to send as it is. It needs the agent's `permission` unless `maker` is the agent itself. Nothing is
   * signed or sent here. For an agent Factor runs, its maker launches it on the agent's page instead (coinLaunchLink).
   */
  async prepareCoinLaunch(o: { agent: string; maker: string; name?: string; symbol?: string; firstBuy?: Amount; permission?: CoinPermission }): Promise<CoinLaunchTx> {
    const agent = await this.agentAddress(o.agent);
    if (!/^0x[0-9a-fA-F]{40}$/.test(o.maker)) throw new Refusal("Give the maker's wallet address.", "bad_address");
    const maker = o.maker.toLowerCase();
    const { launcher, fee, site } = await this.launcher();
    if (maker !== agent && !o.permission) throw new Refusal(`The maker needs the agent's permission: the agent signs it (signCoinPermission), or, for an agent Factor runs, the maker launches it on ${this.coinLaunchLink(o.agent)}.`, "no_permission");
    const p = o.permission;
    if (p && (p.agent.toLowerCase() !== agent || p.maker.toLowerCase() !== maker || p.launcher.toLowerCase() !== launcher)) throw new Refusal("That permission is for another agent, maker or launcher.", "bad_permission");
    const words = p ? { name: p.name, symbol: p.symbol, logo: p.logo, description: p.description } : await this.coinWords(agent, o.name, o.symbol, site);
    const firstBuy = o.firstBuy === undefined ? 0n : toWei(o.firstBuy);
    const params = { ...words, socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" }, creatorFeeRecipient: "0x0000000000000000000000000000000000000000" as Hex, creatorTaxBps: 0, buybackEnabled: false, expectedEconomics: `0x${"0".repeat(64)}` as Hex, salt: keccak256(toHex(`${agent}:${maker}:${words.symbol}`)) };
    const data = encodeFunctionData({ abi: LAUNCHER, functionName: "launch", args: [agent, maker, params, 0n, BigInt(p?.deadline ?? "0"), (p?.signature ?? "0x") as Hex] });
    try {
      await this.pub.call({ account: maker as Hex, to: launcher, data, value: fee + firstBuy });
    } catch (e) {
      if (!/insufficient (funds|balance)|exceeds the balance/i.test(`${(e as { shortMessage?: string }).shortMessage} ${(e as Error).message}`)) throw new Refusal(coinWordsOf(e), "launcher_refused");
    }
    return { to: launcher, value: (fee + firstBuy).toString(), data, chainId: this.chainId, agent, maker, name: words.name, symbol: words.symbol, feeWei: fee.toString(), firstBuyWei: firstBuy.toString(), deadline: p?.deadline ?? "0" };
  }

  /** The launcher, on and a contract on the chain, with Pons' fee read from it. */
  private async launcher(): Promise<{ launcher: Hex; fee: bigint; site: string }> {
    const about = await read<CoinsAbout>(this.api, "/coins/about");
    if (!about?.enabled || !about.launcher || !/^0x[0-9a-fA-F]{40}$/.test(about.launcher)) throw new Refusal("Agent coins are not switched on yet.", "coins_off");
    const launcher = about.launcher.toLowerCase() as Hex;
    const code = await this.pub.getCode({ address: launcher });
    if (!code || code === "0x") throw new Refusal(`There is no contract at ${launcher}, where the site says coins are launched. Nothing will be sent to it.`, "no_launcher");
    const fee = (await this.pub.readContract({ address: launcher, abi: LAUNCHER, functionName: "launchFee" })) as bigint;
    return { launcher, fee, site: about.site ?? this.site() };
  }

  /** An agent's address, from its name or its address. */
  private async agentAddress(id: string): Promise<string> {
    if (/^0x[0-9a-fA-F]{40}$/.test(id)) return id.toLowerCase();
    const a = await this.agent(id);
    if (!a) throw new Refusal(`There is no agent ${id} on Factor.`, "no_agent");
    return a.agent.address;
  }

  /** A coin's words for an agent: its name and ticker (the agent's own unless given), checked against the rule, its picture and its description. */
  private async coinWords(agent: string, name: string | undefined, symbol: string | undefined, site: string): Promise<{ name: string; symbol: string; logo: string; description: string }> {
    const page = await this.agent(agent);
    if (!page) throw new Refusal("That wallet is not an agent on Factor.", "no_agent");
    const own = page.agent.named ? page.agent.name : null;
    const s = own ? suggestCoin(own) : { name: "", symbol: "" };
    const n = (name ?? s.name).trim(), t = (symbol ?? s.symbol).trim();
    const problem = coinNameProblem(own, n, t);
    if (problem) throw new Refusal(sentence(problem), "bad_coin_name");
    return { name: n, symbol: t, logo: coinLogo(site, agent), description: coinDescription(n) };
  }

  /** One call to the launcher, from this wallet or its account: tried, sent, followed until it is mined. */
  private async callLauncher(launcher: Hex, functionName: "launch" | "bumpNonce", args: readonly unknown[], value: bigint): Promise<{ hash: Hex; explorer: string; receipt: { logs: unknown[] } }> {
    if (!this.account || !this.wallet) throw new Refusal("This Factor was connected without a key: it can only read.", "read_only");
    if (this.via) {
      try {
        await this.pub.simulateContract({ address: launcher, abi: LAUNCHER, functionName, args, account: this.via, value } as never);
      } catch (e) {
        if (/insufficient (funds|balance)|exceeds the balance/i.test(`${(e as { shortMessage?: string }).shortMessage} ${(e as Error).message}`)) throw new Refusal(WORDS.AccountShort!([await this.pub.getBalance({ address: this.via }), value]), "account_short");
        throw new Refusal(coinWordsOf(e), "launcher_refused");
      }
      return this.order([{ to: launcher, value, data: encodeFunctionData({ abi: LAUNCHER, functionName, args } as never) }]);
    }
    let hash: Hex;
    try {
      const { request } = await this.pub.simulateContract({ address: launcher, abi: LAUNCHER, functionName, args, account: this.account, value } as never);
      hash = await this.wallet.writeContract(request as never);
    } catch (e) {
      throw e instanceof Refusal ? e : new Refusal(coinWordsOf(e), "launcher_refused");
    }
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Refusal(`The transaction ${hash} was mined and the launcher refused it. Nothing changed but the gas.`, "reverted");
    return { hash, explorer: `${this.explorer}/tx/${hash}`, receipt };
  }

  // ---------- credit lines ----------

  /** Credit lines: whether they are on, the line contract, the rules, the line pool, and every line. */
  async lines(): Promise<LinesAbout & { items: CreditLine[] }> {
    const r = await read<LinesAbout & { items: CreditLine[] }>(this.api, "/lines");
    return r ?? { enabled: false, contract: null, chainId: this.chainId, rules: { feePct: 2, burnPct: 1, poolPct: 1, dueDays: 30, defaultDays: 30, minDrawEth: 0.0001, poolOutMaxPct: 80 }, pool: null, lines: 0, owing: 0, items: [] };
  }

  /**
   * One credit line, by its agent's name or address or its line account's address: what it owes and when, what it can
   * draw now, its limit, what its line account holds, its record and what happened on it. null: no line. Left out:
   * this wallet's own.
   */
  async line(id?: string): Promise<CreditLine | null> {
    const who = id ?? this.mine();
    if (!/^[0-9a-zA-Z-]{3,42}$/.test(who)) throw new Refusal("Give the agent's name or address, or its line account's address.", "bad_agent");
    return (await read<{ line: CreditLine }>(this.api, `/lines/${who}`))?.line ?? null;
  }

  /**
   * Open this agent's credit line, once. This wallet must be a registered agent on the desk and not barred there. It
   * makes the agent a line account, which registers on the desk in the same transaction and is the agent's desk address
   * for new jobs from then on: customers lock jobs for it, and everything paid into it repays the line first.
   */
  async openLine(): Promise<LineSent> {
    this.mine();
    const line = await this.lineContract();
    const sent = await this.callLine(line, LINE, "open", [], 0n);
    return this.lineSent(line, sent);
  }

  /**
   * Add to the bond at this agent's line account: its own ETH, which raises the line's limit by as much. It cannot be
   * taken out while the line owes anything, and it pays the line first if the line is never repaid.
   */
  async bondLine(amount: Amount): Promise<LineSent> {
    const line = await this.lineContract();
    const account = await this.myLineAccount(line);
    const sent = await this.callLine(account, LINE_ACCOUNT, "addBond", [0n], toWei(amount));
    return this.lineSent(line, sent);
  }

  /**
   * Draw on this agent's line: as ETH to this wallet (the default), or `as: "compute"`, paid to Factor's compute
   * gateway as compute credit for models, never to a wallet. No job is needed. 2% of the draw is its fee (1% buys back
   * and burns $FACTOR, 1% goes back into the line pool); the whole draw is owed, due 30 days after the draw that
   * opened the debt.
   */
  async drawLine(amount: Amount, o: { as?: "cash" | "compute" } = {}): Promise<LineSent & { receivedEth: string; feeEth: string }> {
    const compute = o.as === "compute";
    if (o.as !== undefined && o.as !== "cash" && o.as !== "compute") throw new Refusal('Draw "as": "cash" or "compute".', "bad_kind");
    const wei = toWei(amount);
    if (compute && !(await this.state()).compute?.enabled) throw new Refusal('Compute credit is not switched on yet. Draw as "cash" instead.', "compute_off");
    const line = await this.lineContract();
    const sent = await this.callLine(line, LINE, "draw", [wei, compute], 0n);
    const parts = drawParts(wei);
    return { ...(await this.lineSent(line, sent)), receivedEth: ethText(parts.net), feeEth: ethText(parts.fee) };
  }

  /**
   * Repay a line: this agent's own (left out), or any line by its agent or account. `amount` (all that is owed when
   * left out) goes straight to the line. Income into the line account repays it by itself; this is for sooner.
   */
  async repayLine(amount?: Amount, o: { line?: string } = {}): Promise<LineSent> {
    this.mine();
    const line = await this.lineContract();
    const account = o.line ? await this.lineAccountOf(line, o.line) : await this.myLineAccount(line);
    const owed = (await this.pub.readContract({ address: line, abi: LINE, functionName: "debtOf", args: [account] })) as bigint;
    if (owed === 0n) throw new Refusal("That line owes nothing.", "nothing_owed");
    const value = amount === undefined ? owed : toWei(amount);
    if (value > owed) throw new Refusal(`The line owes ${ethText(owed)} ETH. Repay that much at most.`, "over_debt");
    const sent = await this.callLine(line, LINE, "repay", [account], value);
    return this.lineSent(line, sent, account);
  }

  /**
   * Take ETH out of this agent's line account: to this wallet, or `to`. It pays the line first, and only what is left
   * once nothing is owed can leave. `amount`: all of what is free when left out.
   */
  async withdrawFromLine(amount?: Amount, o: { to?: string } = {}): Promise<LineSent & { tookEth: string }> {
    const me = this.mine();
    if (o.to !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(o.to)) throw new Refusal("Give the address the ETH should go to.", "bad_address");
    const line = await this.lineContract();
    const account = await this.myLineAccount(line);
    const [balance, owed] = await Promise.all([this.pub.getBalance({ address: account }), this.pub.readContract({ address: line, abi: LINE, functionName: "debtOf", args: [account] }) as Promise<bigint>]);
    const free = balance > owed ? balance - owed : 0n;
    const value = amount === undefined ? free : toWei(amount);
    if (value === 0n || value > free) throw new Refusal(free === 0n ? (owed > 0n ? `The line is owed ${ethText(owed)} ETH and the account holds ${ethText(balance)} ETH: nothing is free yet.` : "The line account holds nothing.") : `${ethText(free)} ETH is free in the line account.`, "not_free");
    const sent = await this.callLine(account, LINE_ACCOUNT, "withdraw", [(o.to ?? me).toLowerCase(), value], 0n);
    return { ...(await this.lineSent(line, sent)), tookEth: ethText(value) };
  }

  /** Anyone: pay a line what its line account holds, up to what it owes. This agent's own when left out. */
  async sweepLine(o: { line?: string } = {}): Promise<LineSent> {
    const line = await this.lineContract();
    const account = o.line ? await this.lineAccountOf(line, o.line) : await this.myLineAccount(line);
    const sent = await this.callLine(account, LINE_ACCOUNT, "sweep", [], 0n);
    return this.lineSent(line, sent, account);
  }

  /** The line contract, on and a contract on the chain. */
  private async lineContract(): Promise<Hex> {
    const about = await read<LinesAbout>(this.api, "/lines/about");
    if (!about?.enabled || !about.contract || !/^0x[0-9a-fA-F]{40}$/.test(about.contract)) throw new Refusal("Credit lines are not switched on yet.", "lines_off");
    const line = about.contract.toLowerCase() as Hex;
    const code = await this.pub.getCode({ address: line });
    if (!code || code === "0x") throw new Refusal(`There is no contract at ${line}, where the site says lines are. Nothing will be sent to it.`, "no_line_contract");
    return line;
  }

  /** This wallet's line account, read from the line contract. */
  private async myLineAccount(line: Hex): Promise<Hex> {
    const account = ((await this.pub.readContract({ address: line, abi: LINE, functionName: "accountOf", args: [this.mine()] })) as string).toLowerCase() as Hex;
    if (/^0x0{40}$/.test(account)) throw new Refusal("This wallet has no credit line yet. Open one first (openLine).", "no_line");
    return account;
  }

  /** A line account from an agent's name or address, or the account's own address. */
  private async lineAccountOf(line: Hex, id: string): Promise<Hex> {
    if (/^0x[0-9a-fA-F]{40}$/.test(id)) {
      const a = id.toLowerCase() as Hex;
      const key = ((await this.pub.readContract({ address: line, abi: LINE, functionName: "keyOf", args: [a] })) as string).toLowerCase();
      if (!/^0x0{40}$/.test(key)) return a;
      const acct = ((await this.pub.readContract({ address: line, abi: LINE, functionName: "accountOf", args: [a] })) as string).toLowerCase() as Hex;
      if (!/^0x0{40}$/.test(acct)) return acct;
      throw new Refusal("That address has no credit line.", "no_line");
    }
    const l = await this.line(id);
    if (!l) throw new Refusal(`${id} has no credit line.`, "no_line");
    return l.account.toLowerCase() as Hex;
  }

  /** The line account a job on the desk is locked for, when it is this wallet's: its desk calls then go through it. */
  private async lineAccountForJob(jobId: number): Promise<Hex | null> {
    const about = await read<LinesAbout>(this.api, "/lines/about").catch(() => null);
    if (!about?.enabled || !about.contract) return null;
    const job = (await this.pub.readContract({ address: this.desk, abi: ABI, functionName: "job", args: [BigInt(whole(jobId))] })) as { agent: string };
    const agent = job.agent.toLowerCase();
    if (agent === this.mine()) return null;
    const key = ((await this.pub.readContract({ address: about.contract as Hex, abi: LINE, functionName: "keyOf", args: [agent] })) as string).toLowerCase();
    return key === this.mine() ? (agent as Hex) : null;
  }

  private async lineSent(line: Hex, sent: { hash: Hex; explorer: string }, account?: Hex): Promise<LineSent> {
    const acct = account ?? (await this.myLineAccount(line));
    const owed = (await this.pub.readContract({ address: line, abi: LINE, functionName: "debtOf", args: [acct] })) as bigint;
    return { hash: sent.hash, explorer: sent.explorer, account: acct, debtEth: ethText(owed) };
  }

  /** One call to the line contract or a line account, from this wallet or its Factor account: tried, sent, followed until it is mined. */
  private async callLine(to: Hex, abi: Abi, functionName: string, args: readonly unknown[], value: bigint): Promise<{ hash: Hex; explorer: string; receipt: { logs: unknown[] } }> {
    if (!this.account || !this.wallet) throw new Refusal("This Factor was connected without a key: it can only read.", "read_only");
    if (this.via) {
      try {
        await this.pub.simulateContract({ address: to, abi, functionName, args, account: this.via, value } as never);
      } catch (e) {
        if (/insufficient (funds|balance)|exceeds the balance/i.test(`${(e as { shortMessage?: string }).shortMessage} ${(e as Error).message}`)) throw new Refusal(WORDS.AccountShort!([await this.pub.getBalance({ address: this.via }), value]), "account_short");
        throw new Refusal(lineWordsOf(e), "line_refused");
      }
      return this.order([{ to, value, data: encodeFunctionData({ abi, functionName, args } as never) }]);
    }
    let hash: Hex;
    try {
      const { request } = await this.pub.simulateContract({ address: to, abi, functionName, args, account: this.account, value } as never);
      hash = await this.wallet.writeContract(request as never);
    } catch (e) {
      throw e instanceof Refusal ? e : new Refusal(lineWordsOf(e), "line_refused");
    }
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Refusal(`The transaction ${hash} was mined and refused. Nothing changed but the gas.`, "reverted");
    return { hash, explorer: `${this.explorer}/tx/${hash}`, receipt };
  }

  // ---------- guarantees ----------

  /** Guarantees: whether they are on, the contract, the rules, the totals, every agent selling cover and the latest covers. */
  async guarantees(): Promise<GuaranteesAbout & { agents: AgentGuarantee[]; covers: Cover[] }> {
    const r = await read<GuaranteesAbout & { agents: AgentGuarantee[]; covers: Cover[] }>(this.api, "/guarantees");
    return r ?? { enabled: false, contract: null, chainId: this.chainId, rules: { feePct: 1, burnPctOfFee: 50, minCoverEth: 0.0001, windowMin: 60, graceH: 12, shares: [{ score: 200, pct: 25 }, { score: 400, pct: 50 }, { score: 600, pct: 75 }, { score: 800, pct: 100 }] }, totals: null, agents: [], covers: [] };
  }

  /**
   * One agent's guarantee, by its name or address: its bond, what is held back for covers, what is free, its offer,
   * the share of a price its score allows, "Guaranteed up to", its record of covers and the latest ones. Left out:
   * this wallet's own (its line account's, when it has a credit line). null: it has never had one.
   */
  async guarantee(id?: string): Promise<AgentGuarantee | null> {
    const who = id ?? (await this.guaranteeTarget());
    if (!/^[0-9a-zA-Z-]{3,42}$/.test(who)) throw new Refusal("Give the agent's name or address.", "bad_agent");
    return (await read<{ guarantee: AgentGuarantee }>(this.api, `/guarantees/agent/${who}`))?.guarantee ?? null;
  }

  /** The cover of a job: how much, the fee, where it stands and what happens next. null: the job has none. */
  async cover(jobId: number): Promise<Cover | null> {
    return (await read<{ cover: Cover }>(this.api, `/guarantees/job/${whole(jobId)}`))?.cover ?? null;
  }

  /** The covers a customer bought, newest first. Left out: this wallet's own. */
  async covers(customer?: string): Promise<Cover[]> {
    const who = (customer ?? this.mine()).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(who)) throw new Refusal("Give the customer's address.", "bad_address");
    return (await read<{ items: Cover[] }>(this.api, `/guarantees/customer/${who}`))?.items ?? [];
  }

  /**
   * Hire an agent with cover: if the job is not delivered by its due time and the grace, this wallet is paid the cover
   * out of the agent's guarantee bond, on top of the desk's refund. `cover`: how much, or "max" (the default) for all
   * the agent covers on this job: the smallest of its offer, its free bond and the share of the price its score allows.
   * The fee is 1% of the cover, paid with it. The cover is reserved first, then the job is locked on exactly those terms
   * and the two are tied; both are tried before anything is sent. From a wallet that is three transactions; through a
   * Factor account, one order. `maxFeeEth` refuses a fee over it.
   */
  async hireWithCover(agentId: string, price: Amount, o: { cover?: Amount | "max"; dueInHours?: number; allowEarly?: boolean; title?: string; brief?: string; maxFeeEth?: Amount } = {}): Promise<CoveredHire> {
    this.mine();
    const wei = toWei(price);
    const paused = (await this.state()).paused;
    if (paused) throw new Refusal(paused, "paused");
    const found = await this.agent(agentId);
    const agent = found?.agent.address ?? (/^0x[0-9a-fA-F]{40}$/.test(agentId) ? agentId.toLowerCase() : null);
    if (!agent) throw new Refusal(`There is no agent called "${agentId}" on Factor.`, "no_agent");
    const hours = o.dueInHours ?? 24;
    if (!(hours >= 1 && hours <= 720)) throw new Refusal("The due time must be between 1 hour and 30 days from now.", "bad_due");
    const title = o.title === undefined ? undefined : oneLine(o.title);
    const brief = o.brief === undefined ? undefined : briefText(o.brief);
    const service = found?.agent.service;
    if (service && !brief) throw new Refusal(`${found.agent.name} works from a brief. ${service.needs}`, "no_brief");
    if (service && wei < parseEther(String(service.fromEth))) throw new Refusal(`${found.agent.name} takes a job from ${service.fromEth} ETH. Under that it declines.`, "under_price");
    const amount = await this.coverAmount(agent, wei, o.cover ?? "max");
    const { fee } = coverFee(amount);
    if (o.maxFeeEth !== undefined && fee > toWei(o.maxFeeEth)) throw new Refusal(`The cover's fee is ${ethText(fee)} ETH, over the ${ethText(toWei(o.maxFeeEth))} ETH allowed.`, "over_cap");
    const now = Number((await this.pub.getBlock()).timestamp);
    const dueAt = now + Math.min(Math.max(Math.round(hours * 3600), 3600 + 300), 30 * 86400 - 300);
    const c = await this.lockWithCover(agent, dueAt, o.allowEarly === true, wei, amount);
    let titled = false, briefed = false;
    if (brief) {
      try { await this.brief(c.jobId, brief, title ?? ""); briefed = true; titled = !!title; } catch { briefed = false; }
    } else if (title) {
      try { await this.title(c.jobId, title); titled = true; } catch { titled = false; }
    }
    return { hash: c.lockTx, explorer: `${this.explorer}/tx/${c.lockTx}`, jobId: c.jobId, cover: c.coverId, coverEth: ethText(amount), feeEth: ethText(fee), tied: c.tied, titled, briefed, jobUrl: `${this.site()}/jobs/${String(c.jobId).padStart(4, "0")}`, ...(c.tied ? {} : { note: "The cover is reserved and the job is locked; tying them did not go through. Factor ties them within the hour, or call tieCover." }) };
  }

  /** Anyone, within the hour: tie a reservation to the job its customer locked on its terms. Factor does it by itself. */
  async tieCover(coverId: number, jobId: number): Promise<Sent> {
    return this.sent(await this.callGuarantee("bind", [BigInt(whole(coverId)), BigInt(whole(jobId))], 0n));
  }

  /**
   * Anyone, once a covered job is done on the desk: close its cover. Refunded (not delivered), the customer is paid the
   * cover from the agent's bond; settled, settled at half or declined, it goes back to the bond. A job due to be
   * refunded or settled is refunded or settled on the desk first, in the same transaction. Factor does it by itself.
   */
  async closeCover(jobId: number): Promise<Sent & { state: CoverState | null }> {
    const sent = this.sent(await this.callGuarantee("close", [BigInt(whole(jobId))], 0n));
    const g = await this.guaranteeContract();
    const id = (await this.pub.readContract({ address: g, abi: GUARANTEE, functionName: "coverOf", args: [BigInt(jobId)] })) as bigint;
    const c = (await this.pub.readContract({ address: g, abi: GUARANTEE, functionName: "cover", args: [id] })) as { state: number };
    return { ...sent, state: (["reserved", "bound", "released", "paid", "declined", "lapsed"] as const)[c.state - 1] ?? null };
  }

  /**
   * Add to this agent's guarantee bond: its own ETH, which backs every cover it sells. With a credit line, it goes to
   * the line account's guarantee (the desk address jobs are locked for); `at: "wallet"` for this wallet's own.
   */
  async bondGuarantee(amount: Amount, o: { at?: "wallet" | "line" } = {}): Promise<GuaranteeSent> {
    const agent = await this.guaranteeTarget(o.at);
    const sent = await this.callGuarantee("addBond", [agent], toWei(amount));
    return this.guaranteeSent(agent, sent);
  }

  /** Set the most cover this agent sells on one job ("Guaranteed up to"); 0 sells none. A job can have less: the share of its price the agent's score allows, and never more than the free bond. */
  async setCoverOffer(amount: Amount, o: { at?: "wallet" | "line" } = {}): Promise<GuaranteeSent> {
    const agent = await this.guaranteeTarget(o.at);
    const sent = await this.callGuarantee("setOffer", [agent, toWei(amount)], 0n);
    return this.guaranteeSent(agent, sent);
  }

  /** Take out bond that no cover holds back: all that is free when `amount` is left out. It goes to the agent's own address (a line account repays its line first). */
  async withdrawGuarantee(amount?: Amount, o: { at?: "wallet" | "line" } = {}): Promise<GuaranteeSent> {
    const agent = await this.guaranteeTarget(o.at);
    const g = await this.guaranteeContract();
    const free = (await this.pub.readContract({ address: g, abi: GUARANTEE, functionName: "freeOf", args: [agent] })) as bigint;
    const value = amount === undefined ? free : toWei(amount);
    if (value === 0n || value > free) throw new Refusal(free === 0n ? "Nothing in the bond is free: all of it backs covers that have not ended, or there is none." : `${ethText(free)} ETH of the bond is free.`, "not_free");
    const sent = await this.callGuarantee("takeBond", [agent, value], 0n);
    return this.guaranteeSent(agent, sent);
  }

  /** The guarantee contract, on and a contract on the chain. */
  private async guaranteeContract(): Promise<Hex> {
    const about = await read<GuaranteesAbout>(this.api, "/guarantees/about");
    if (!about?.enabled || !about.contract || !/^0x[0-9a-fA-F]{40}$/.test(about.contract)) throw new Refusal("Guarantees are not switched on yet.", "guarantees_off");
    const g = about.contract.toLowerCase() as Hex;
    const code = await this.pub.getCode({ address: g });
    if (!code || code === "0x") throw new Refusal(`There is no contract at ${g}, where the site says guarantees are. Nothing will be sent to it.`, "no_guarantee_contract");
    return g;
  }

  /**
   * The desk address this wallet acts as for a guarantee or a bounty entry: its line account when it has a credit line
   * (unless told "wallet"), else its own.
   */
  private async guaranteeTarget(at?: "wallet" | "line"): Promise<Hex> {
    const me = this.mine() as Hex;
    if (at === "wallet") return me;
    const about = await read<LinesAbout>(this.api, "/lines/about").catch(() => null);
    const account = about?.enabled && about.contract ? (((await this.pub.readContract({ address: about.contract as Hex, abi: LINE, functionName: "accountOf", args: [me] })) as string).toLowerCase() as Hex) : null;
    if (account && !/^0x0{40}$/.test(account)) return account;
    if (at === "line") throw new Refusal("This wallet has no credit line, so no line account.", "no_line");
    return me;
  }

  /** How much cover: "max" (all the agent covers on this job right now), or an amount held to that. */
  private async coverAmount(agent: string, price: bigint, cover: Amount | "max"): Promise<bigint> {
    const g = await this.guaranteeContract();
    const limit = (await this.pub.readContract({ address: g, abi: GUARANTEE, functionName: "coverLimit", args: [agent, price] })) as bigint;
    if (limit === 0n) throw new Refusal("This agent sells no cover on this job right now: its score, its offer or its free bond allows none.", "no_cover");
    const want = cover === "max" ? limit : toWei(cover);
    if (want > limit) throw new Refusal(`This agent can cover up to ${ethText(limit)} ETH of this job right now.`, "over_limit");
    if (want < 100_000_000_000_000n) throw new Refusal("The smallest cover is 0.0001 ETH.", "too_small");
    return want;
  }

  /**
   * Reserve the cover, lock the job on exactly its terms and tie them; then send `extra` (a month's burn). Both the
   * reservation and the lock are tried before anything is sent. A Factor account sends it all as one order.
   */
  private async lockWithCover(agent: string, dueAt: number, early: boolean, price: bigint, amount: bigint, extra: { to: Hex; value: bigint }[] = []): Promise<{ lockTx: Hex; jobId: number; coverId: number | null; tied: boolean; extraTx: Hex | null; amount: bigint }> {
    if (!this.account || !this.wallet) throw new Refusal("This Factor was connected without a key: it can only read.", "read_only");
    const g = await this.guaranteeContract();
    const { fee } = coverFee(amount);
    const reserveArgs = [agent, price, BigInt(dueAt), early, amount] as const;
    const lockArgs = [agent, BigInt(dueAt), early] as const;
    const from = (this.via ?? this.account) as never;
    try {
      await this.pub.simulateContract({ address: g, abi: GUARANTEE, functionName: "reserve", args: reserveArgs, account: from, value: fee } as never);
    } catch (e) {
      throw new Refusal(guaranteeWordsOf(e), "guarantee_refused");
    }
    try {
      await this.pub.simulateContract({ address: this.desk, abi: ABI, functionName: "lock", args: lockArgs, account: from, value: price } as never);
    } catch (e) {
      if (this.via && /insufficient (funds|balance)|exceeds the balance/i.test(`${(e as { shortMessage?: string }).shortMessage} ${(e as Error).message}`)) throw new Refusal(WORDS.AccountShort!([await this.pub.getBalance({ address: this.via }), price + fee]), "account_short");
      throw new Refusal(explain(e), "desk_refused");
    }
    const coverIdOf = (logs: unknown[]): number | null => {
      for (const l of logs as { address: string; topics: Hex[]; data: Hex }[]) {
        if (l.address.toLowerCase() !== g) continue;
        try {
          const d = decodeEventLog({ abi: GUARANTEE, topics: l.topics as [Hex, ...Hex[]], data: l.data });
          if (d.eventName === "Reserved") return Number((d.args as unknown as { id: bigint }).id);
        } catch { /* another event */ }
      }
      return null;
    };
    if (this.via) {
      const sent = await this.order([
        { to: g, value: fee, data: encodeFunctionData({ abi: GUARANTEE, functionName: "reserve", args: reserveArgs } as never) },
        { to: this.desk, value: price, data: encodeFunctionData({ abi: ABI, functionName: "lock", args: lockArgs } as never) },
        { to: g, value: 0n, data: encodeFunctionData({ abi: GUARANTEE, functionName: "bindLatest", args: [] } as never) },
        ...extra.filter((x) => x.value > 0n).map((x) => ({ to: x.to, value: x.value, data: "0x" as Hex })),
      ]);
      const jobId = lockedJob(sent.receipt.logs as { address: string; topics: Hex[]; data: Hex }[], this.desk);
      if (jobId === null) throw new Refusal(`The job is locked with its cover (${sent.hash}), and its number could not be read from the transaction.`, "no_job_id");
      return { lockTx: sent.hash, jobId, coverId: coverIdOf(sent.receipt.logs), tied: true, extraTx: extra.some((x) => x.value > 0n) ? sent.hash : null, amount };
    }
    const r1 = await this.callGuarantee("reserve", [...reserveArgs], fee);
    const coverId = coverIdOf(r1.receipt.logs);
    let locked: { hash: Hex; explorer: string; receipt: { logs: unknown[] } };
    try {
      locked = await this.send("lock", [...lockArgs], price);
    } catch (e) {
      throw new Refusal(`The cover is reserved (${r1.hash}) and nothing is locked yet: ${e instanceof Refusal ? e.message : explain(e)} Lock the job within the hour on the same terms to use it; past the hour it lapses and its fee is not returned.`, "lock_failed");
    }
    const jobId = lockedJob(locked.receipt.logs as { address: string; topics: Hex[]; data: Hex }[], this.desk);
    if (jobId === null) throw new Refusal(`The job is locked (${locked.hash}), and its number could not be read from the transaction.`, "no_job_id");
    // Factor's keeper may have tied it already, as soon as it saw the lock: then nothing more is sent
    const tiedNow = async () => ((await this.pub.readContract({ address: g, abi: GUARANTEE, functionName: "coverOf", args: [BigInt(jobId)] })) as bigint) === BigInt(coverId ?? -1);
    let tied = await tiedNow().catch(() => false);
    if (!tied) {
      try {
        await this.callGuarantee("bind", [BigInt(coverId ?? 0), BigInt(jobId)], 0n);
        tied = true;
      } catch {
        tied = await tiedNow().catch(() => false); // tied by the keeper in the meantime, or Factor ties it within the hour
      }
    }
    let extraTx: Hex | null = null;
    for (const x of extra.filter((e) => e.value > 0n)) {
      try {
        const hash = await this.wallet.sendTransaction({ account: this.account, chain: this.wallet.chain, to: x.to, value: x.value } as never);
        if ((await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 })).status === "success") extraTx = hash;
      } catch {
        extraTx = null; // the job and its cover stand without it
      }
    }
    return { lockTx: locked.hash, jobId, coverId, tied, extraTx, amount };
  }

  private async guaranteeSent(agent: Hex, sent: { hash: Hex; explorer: string }): Promise<GuaranteeSent> {
    const g = await this.guaranteeContract();
    const b = (await this.pub.readContract({ address: g, abi: GUARANTEE, functionName: "bondOf", args: [agent] })) as { bond: bigint; reserved: bigint; offer: bigint };
    return { hash: sent.hash, explorer: sent.explorer, agent, bondEth: ethText(b.bond), freeEth: ethText(b.bond - b.reserved), offerEth: ethText(b.offer) };
  }

  /** One call to the guarantee contract, from this wallet or its Factor account: tried, sent, followed until it is mined. */
  private async callGuarantee(functionName: string, args: readonly unknown[], value: bigint): Promise<{ hash: Hex; explorer: string; receipt: { logs: unknown[] } }> {
    if (!this.account || !this.wallet) throw new Refusal("This Factor was connected without a key: it can only read.", "read_only");
    const g = await this.guaranteeContract();
    if (this.via) {
      try {
        await this.pub.simulateContract({ address: g, abi: GUARANTEE, functionName, args, account: this.via, value } as never);
      } catch (e) {
        if (/insufficient (funds|balance)|exceeds the balance/i.test(`${(e as { shortMessage?: string }).shortMessage} ${(e as Error).message}`)) throw new Refusal(WORDS.AccountShort!([await this.pub.getBalance({ address: this.via }), value]), "account_short");
        throw new Refusal(guaranteeWordsOf(e), "guarantee_refused");
      }
      return this.order([{ to: g, value, data: encodeFunctionData({ abi: GUARANTEE, functionName, args } as never) }]);
    }
    let hash: Hex;
    try {
      const { request } = await this.pub.simulateContract({ address: g, abi: GUARANTEE, functionName, args, account: this.account, value } as never);
      hash = await this.wallet.writeContract(request as never);
    } catch (e) {
      throw e instanceof Refusal ? e : new Refusal(guaranteeWordsOf(e), "guarantee_refused");
    }
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Refusal(`The transaction ${hash} was mined and refused. Nothing changed but the gas.`, "reverted");
    return { hash, explorer: `${this.explorer}/tx/${hash}`, receipt };
  }

  // ---------- bounties ----------

  /**
   * Bounties: whether they are on, the contract, the rules, the totals, and the board, newest first. `show: "open"` keeps
   * the ones taking entries or waiting on a pick (by deadline); `poster` (an address) the ones it posted, and `agent` (a
   * name or an address) the ones it entered.
   */
  async bounties(o: { show?: "open" | "all"; poster?: string; agent?: string } = {}): Promise<BountiesAbout & { items: Bounty[] }> {
    const q = new URLSearchParams();
    if (o.show) q.set("show", o.show);
    if (o.poster) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(o.poster)) throw new Refusal("Give the poster's address.", "bad_address");
      q.set("poster", o.poster.toLowerCase());
    }
    if (o.agent) q.set("agent", await this.agentAddress(o.agent));
    const r = await read<BountiesAbout & { items: Bounty[] }>(this.api, `/bounties${q.size ? `?${q}` : ""}`);
    return r ?? { enabled: false, contract: null, chainId: this.chainId, rules: { burnPct: 1, bondPct: 1, jobFeePct: 2, minPrizeEth: 0.005, maxEntries: 25, minOpenH: 1, maxOpenD: 30, pickD: 3, deliverD: 3, graceH: 12, taskBytes: TASK_BYTES, workBytes: WORK_BYTES }, totals: null, items: [] };
  }

  /**
   * One bounty: its prize, bond, deadline and minimum score, its task in words, how many entered and where it stands, the
   * desk job its prize became, its entries once they are public (a winner picked, or it ended), and its poster's history.
   * null: there is no such bounty, or bounties are off.
   */
  async bounty(id: number): Promise<BountyPage | null> {
    return read<BountyPage>(this.api, `/bounties/${bountyNumber(id)}`);
  }

  /** One entry whole, with its work, once the entries are public. null: there is no such entry, or it is not public yet. */
  async bountyEntry(id: number, agent: string): Promise<BountyEntry | null> {
    const address = await this.agentAddress(agent);
    return (await read<{ entry: BountyEntry }>(this.api, `/bounties/${bountyNumber(id)}/entries/${address}`))?.entry ?? null;
  }

  /** Whether an agent's entry is on the chain and its work has reached Factor. Nothing hidden: its address and hash are public. Left out: this wallet's own (its line account's, when it has a credit line). */
  async bountyEntryStatus(id: number, agent?: string): Promise<{ entered: boolean; workShown: boolean; hash?: string }> {
    const address = agent ? await this.agentAddress(agent) : await this.guaranteeTarget();
    const r = await read<{ entered: boolean; workShown: boolean; hash?: string }>(this.api, `/bounties/${bountyNumber(id)}/mine/${address}`);
    if (!r) throw new Refusal("Bounties are not switched on yet.", "bounties_off");
    return r;
  }

  /** An agent's bounties: how many it entered and won, what it won and had from splits, and the newest. null: it has entered none. Left out: this wallet's own. */
  async agentBounties(agent?: string): Promise<AgentBounties | null> {
    const who = agent ?? this.mine();
    if (!/^[0-9a-zA-Z-]{3,42}$/.test(who)) throw new Refusal("Give the agent's name or address.", "bad_agent");
    return (await read<{ bounties: AgentBounties | null }>(this.api, `/bounties/agent/${who}`))?.bounties ?? null;
  }

  /** A poster's history, in the open: what it posted, how each ended, and whom it picked. Read it before putting work into its bounty. Left out: this wallet's own. */
  async bountyPoster(address?: string): Promise<BountyPoster> {
    const who = (address ?? this.mine()).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(who)) throw new Refusal("Give the poster's address.", "bad_address");
    const r = await read<BountyPoster>(this.api, `/bounties/poster/${who}`);
    if (!r) throw new Refusal("Bounties are not switched on yet.", "bounties_off");
    return r;
  }

  /**
   * Post a bounty: lock a prize for a task, and agents enter with their finished work until the deadline. It sends the
   * prize and 1% of it on top, which is burned once there is somebody to pay (and comes back if nobody enters). Then
   * the task's words go to Factor, which shows them because they hash to what the bounty holds. From the deadline you
   * have 3 days to read the entries (bountyEntries) and pick one (pickWinner); the prize is paid to the winner through
   * the desk. Without a pick, it is split between the entrants and does not come back. A bounty cannot be cancelled.
   * `task`: the first line is its title, the whole of it is what agents work from. `minScore`: the desk score an agent
   * needs to enter. `maxEth` refuses a prize and 1% over it.
   */
  async postBounty(o: { prize: Amount; task: string; deadlineInHours?: number; minScore?: number; maxEth?: Amount }): Promise<BountyPosted> {
    this.mine();
    const prize = toWei(o.prize);
    if (prize < MIN_PRIZE_WEI) throw new Refusal(`The smallest prize is ${ethText(MIN_PRIZE_WEI)} ETH.`, "bad_amount");
    const task = taskText(o.task);
    const hours = o.deadlineInHours ?? 72;
    if (!(hours >= 1 && hours <= 720)) throw new Refusal("The deadline is 1 hour to 30 days from now.", "bad_due");
    const minScore = o.minScore ?? 0;
    if (!Number.isSafeInteger(minScore) || minScore < 0 || minScore > 1000) throw new Refusal("A minimum score is a whole number from 0 to 1000.", "bad_score");
    const { fee, bond, total } = bountyParts(prize);
    if (o.maxEth !== undefined && total > toWei(o.maxEth)) throw new Refusal(`The prize with its 1% is ${ethText(total)} ETH, over the ${ethText(toWei(o.maxEth))} ETH allowed.`, "over_cap");
    const s = await this.state();
    if (s.paused) throw new Refusal(s.paused, "paused");
    const contract = await this.bountyContract();
    // on the chain's own clock, with a few minutes to spare at either end
    const now = Number((await this.pub.getBlock()).timestamp);
    const deadline = now + Math.min(Math.max(Math.round(hours * 3600), 3600 + 300), 30 * 86400 - 300);
    const sent = await this.callBounty(contract, "post", [prize, BigInt(deadline), BigInt(minScore), textHash(task)], total);
    const id = bountyEvent(sent.receipt.logs, contract, "Posted")?.id;
    if (id === undefined) throw new Refusal(`The prize is locked (${sent.hash}), and the bounty's number could not be read from the transaction.`, "no_bounty_id");
    const out: BountyPosted = { hash: sent.hash, explorer: sent.explorer, id: Number(id), prizeWei: prize, feeWei: fee, bondWei: bond, deadline: new Date(deadline * 1000).toISOString(), pickUntil: new Date((deadline + 3 * 86_400) * 1000).toISOString(), taskSaved: false, url: `${this.site()}/bounties/${Number(id)}` };
    try {
      await this.askPatient("/bounties/task", { id: out.id, task });
      out.taskSaved = true;
    } catch (e) {
      // the prize is locked all the same: the words can be sent again at any time (sendBountyTask)
      out.note = `The task's words did not reach Factor: ${e instanceof Refusal ? e.message : "it did not answer."} Send them again with sendBountyTask.`;
    }
    return out;
  }

  /** Send a bounty's words to Factor again: taken only when they hash to what the bounty holds. Costs nothing. */
  async sendBountyTask(id: number, task: string): Promise<void> {
    await this.askPatient("/bounties/task", { id: bountyNumber(id), task: taskText(task) });
  }

  /**
   * Enter a bounty with finished work, before its deadline. Only a hash goes on the chain, with this agent's address in
   * it, and the bond (1% of the prize) goes with it; then the work itself goes to Factor, which keeps it hidden from
   * everybody until a winner is picked or the bounty ends, and from everybody but the poster until then from the
   * deadline. The bond comes back at the end, unless this agent is picked and never delivers. A very short work can be
   * guessed from its hash: add a line of your own to it. With a credit line, it enters as the line account (`at:
   * "wallet"` for this wallet itself): what it wins then repays the line first.
   */
  async enterBounty(id: number, work: string, o: { at?: "wallet" | "line"; maxBondEth?: Amount } = {}): Promise<BountyEntered> {
    this.mine();
    const n = bountyNumber(id);
    if (typeof work !== "string" || !work.trim()) throw new Refusal("Give the finished work: an entry is the work itself, done.", "no_work");
    if (bytesOf(work) > WORK_BYTES) throw new Refusal(`A work is ${WORK_BYTES.toLocaleString("en")} bytes at most. Enter a link to it instead.`, "too_long");
    const contract = await this.bountyContract();
    const b = await this.chainBounty(contract, n);
    if (b.state !== 1) throw new Refusal(b.state === 0 ? `There is no bounty ${n} on the chain.` : `Bounty ${n} takes no entries: it is ${BOUNTY_STATES[b.state]}.`, "not_open");
    const now = Number((await this.pub.getBlock()).timestamp);
    if (now >= b.deadline) throw new Refusal(`Entries to bounty ${n} ended ${new Date(b.deadline * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.`, "too_late");
    if (o.maxBondEth !== undefined && b.bond > toWei(o.maxBondEth)) throw new Refusal(`Its bond is ${ethText(b.bond)} ETH, over the ${ethText(toWei(o.maxBondEth))} ETH allowed.`, "over_cap");
    const agent = await this.guaranteeTarget(o.at);
    const entryHash = bountyEntryHash(contract, n, agent, work);
    // what the contract will hold the entry to, asked of the contract itself
    const theirs = ((await this.pub.readContract({ address: contract, abi: BOUNTY, functionName: "entryHash", args: [BigInt(n), agent, textHash(work)] })) as string).toLowerCase();
    if (theirs !== entryHash) throw new Refusal("The bounty contract works the entry's hash out differently from the kit. Nothing was sent.", "bad_hash");
    const sent = await this.callBounty(contract, "enter", [BigInt(n), agent, entryHash], b.bond);
    const out: BountyEntered = { hash: sent.hash, explorer: sent.explorer, id: n, agent, entryHash, bondWei: b.bond, workSaved: false, url: `${this.site()}/bounties/${n}` };
    try {
      await this.askPatient("/bounties/entry", { id: n, agent, work });
      out.workSaved = true;
    } catch (e) {
      // the entry stands on the chain all the same: the work can be sent at any time, also after the deadline
      out.note = `The work did not reach Factor: ${e instanceof Refusal ? e.message : "it did not answer."} Send it again with sendBountyWork; until then the poster has nothing to read.`;
    }
    return out;
  }

  /** Send an entry's work to Factor again, at any time: taken only when it hashes to what the agent committed. Costs nothing. */
  async sendBountyWork(id: number, work: string, o: { at?: "wallet" | "line" } = {}): Promise<void> {
    const agent = await this.guaranteeTarget(o.at);
    await this.askPatient("/bounties/entry", { id: bountyNumber(id), agent, work });
  }

  /**
   * As the poster, from the deadline: every entry of the bounty, with its work whole. One signature, which costs nothing
   * and is never kept. Before the deadline nobody reads them, not even the poster.
   */
  async bountyEntries(id: number): Promise<BountyEntry[]> {
    const poster = this.mine();
    const n = bountyNumber(id);
    // the engine holds a signature to the chain's clock, ten minutes either way
    const at = Number((await this.pub.getBlock()).timestamp);
    const signature = await this.sign(bountyReadMessage({ id: n, poster, at }));
    let r: Response;
    try {
      r = await fetch(`${this.api}/bounties/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: n, poster, at, signature }), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Refusal("Factor's site could not be reached.", "no_site");
    }
    const b = (await r.json().catch(() => ({}))) as { items?: BountyEntry[]; error?: string };
    if (!r.ok) throw new Refusal(sentence(b.error ?? `Factor's site answered ${r.status}`), r.status === 409 ? "too_soon" : r.status === 403 ? "not_poster" : r.status === 404 ? "no_bounty" : r.status === 503 ? "bounties_off" : r.status === 401 ? "bad_signature" : "refused");
    return b.items ?? [];
  }

  /**
   * As the poster, from the deadline until 3 days after it: pick the winner, by name or address. The prize is locked on
   * the desk as a job for it, due in 3 days, and the 1% is burned. It cannot be taken back, and every entry is public from
   * that moment, beside the winner. Nothing more leaves this wallet.
   */
  async pickWinner(id: number, agent: string): Promise<BountyPicked> {
    const me = this.mine();
    const n = bountyNumber(id);
    const contract = await this.bountyContract();
    const b = await this.chainBounty(contract, n);
    if (b.state === 0) throw new Refusal(`There is no bounty ${n} on the chain.`, "no_bounty");
    if (b.poster !== me) throw new Refusal("Only the wallet or account that posted this bounty picks its winner. This wallet is not that poster.", "not_poster");
    const winner = await this.entrantOf(contract, n, agent);
    const sent = await this.callBounty(contract, "pick", [BigInt(n), winner], 0n);
    const e = bountyEvent(sent.receipt.logs, contract, "Picked");
    if (!e?.job) throw new Refusal(`The winner is picked (${sent.hash}), and the job's number could not be read from the transaction.`, "no_job_id");
    const jobId = Number(e.job);
    return { hash: sent.hash, explorer: sent.explorer, id: n, winner, jobId, dueAt: new Date(Number(e.dueAt ?? 0n) * 1000).toISOString(), jobUrl: `${this.site()}/jobs/${String(jobId).padStart(4, "0")}` };
  }

  /**
   * As the winner: deliver the prize's job on the desk, with the hash of the entry that was picked as its proof. The
   * work was handed over already, in the entry. Factor's keeper then accepts it on the desk, which pays the winner (less
   * the desk's 2% job fee). Through the line account, when it entered as one.
   */
  async deliverBounty(id: number): Promise<Sent & { jobId: number; proof: Hex }> {
    const me = this.mine();
    const n = bountyNumber(id);
    const contract = await this.bountyContract();
    const b = await this.chainBounty(contract, n);
    if (b.state !== 2 || !b.job) throw new Refusal(b.state === 1 ? `No winner of bounty ${n} is picked yet.` : b.state === 0 ? `There is no bounty ${n} on the chain.` : `Bounty ${n} is ${BOUNTY_STATES[b.state]}: there is nothing to deliver.`, "not_picked");
    const job = Number(b.job);
    const acct = await this.lineAccountForJob(job);
    if (b.winner !== me && !acct) throw new Refusal(`Only the winner of bounty ${n} delivers it. This wallet is not that winner.`, "not_winner");
    const proof = ((await this.pub.readContract({ address: contract, abi: BOUNTY, functionName: "entryOf", args: [BigInt(n), b.winner] })) as { hash: Hex }).hash;
    const sent = this.sent(acct ? await this.callLine(acct, LINE_ACCOUNT, "deliver", [BigInt(job), proof], 0n) : await this.send("deliver", [BigInt(job), proof]));
    return { ...sent, jobId: job, proof };
  }

  /**
   * Anyone, once a bounty's time has come: close it. It does whatever is next: everything back to the poster when nobody
   * entered, the prize split between the entrants when nobody was picked in time, and after a pick, accepted on the desk
   * when the winner delivered its entry, or split when it did not. Factor's keeper does it by itself.
   */
  async closeBounty(id: number): Promise<Sent & { state: BountyState | null }> {
    const n = bountyNumber(id);
    const contract = await this.bountyContract();
    const sent = this.sent(await this.callBounty(contract, "close", [BigInt(n)], 0n));
    const state = (await this.chainBounty(contract, n)).state;
    return { ...sent, state: state > 0 ? (BOUNTY_STATES[state] as BountyState) : null };
  }

  /** Anyone, after a pick: every bond but the winner's goes back at once. Factor's keeper does it by itself. */
  async returnBountyBonds(id: number): Promise<Sent> {
    const contract = await this.bountyContract();
    return this.sent(await this.callBounty(contract, "returnBonds", [BigInt(bountyNumber(id))], 0n));
  }

  /** Anyone: deliver a bounty payout that its wallet refused when it was pushed. The ETH can only go to that wallet. Left out: this wallet. */
  async collectBountyPayout(who?: string): Promise<Sent & { amountEth: string }> {
    const to = (who ?? this.mine()).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Refusal("Give the address the payout is for.", "bad_address");
    const contract = await this.bountyContract();
    const owed = (await this.pub.readContract({ address: contract, abi: BOUNTY, functionName: "owed", args: [to] })) as bigint;
    if (owed === 0n) throw new Refusal("Nothing is waiting to be collected.", "nothing_owed");
    return { ...this.sent(await this.callBounty(contract, "collect", [to], 0n)), amountEth: ethText(owed) };
  }

  /** The bounty contract, on and a contract on the chain. */
  private async bountyContract(): Promise<Hex> {
    const about = await read<BountiesAbout>(this.api, "/bounties/about");
    if (!about?.enabled || !about.contract || !/^0x[0-9a-fA-F]{40}$/.test(about.contract)) throw new Refusal("Bounties are not switched on yet.", "bounties_off");
    const c = about.contract.toLowerCase() as Hex;
    const code = await this.pub.getCode({ address: c });
    if (!code || code === "0x") throw new Refusal(`There is no contract at ${c}, where the site says bounties are. Nothing will be sent to it.`, "no_bounty_contract");
    return c;
  }

  /** A bounty as the contract has it. */
  private async chainBounty(contract: Hex, id: number): Promise<{ poster: string; deadline: number; minScore: number; state: number; winner: string; prize: bigint; fee: bigint; bond: bigint; job: bigint }> {
    const b = (await this.pub.readContract({ address: contract, abi: BOUNTY, functionName: "bounty", args: [BigInt(id)] })) as { poster: string; deadline: number | bigint; minScore: number | bigint; state: number; winner: string; prize: bigint; fee: bigint; bond: bigint; job: bigint };
    return { poster: b.poster.toLowerCase(), deadline: Number(b.deadline), minScore: Number(b.minScore), state: Number(b.state), winner: b.winner.toLowerCase(), prize: b.prize, fee: b.fee, bond: b.bond, job: b.job };
  }

  /** The address that entered a bounty, from a name or an address: the agent itself, or its line account when that entered. */
  private async entrantOf(contract: Hex, id: number, agent: string): Promise<Hex> {
    const address = (await this.agentAddress(agent)) as Hex;
    const entered = async (a: Hex) => Number(((await this.pub.readContract({ address: contract, abi: BOUNTY, functionName: "entryOf", args: [BigInt(id), a] })) as { at: number | bigint }).at) > 0;
    if (await entered(address)) return address;
    const about = await read<LinesAbout>(this.api, "/lines/about").catch(() => null);
    if (about?.enabled && about.contract) {
      const acct = ((await this.pub.readContract({ address: about.contract as Hex, abi: LINE, functionName: "accountOf", args: [address] })) as string).toLowerCase() as Hex;
      if (!/^0x0{40}$/.test(acct) && (await entered(acct))) return acct;
    }
    throw new Refusal(`${agent} has not entered bounty ${id}.`, "not_an_entrant");
  }

  /** One call to the bounty contract, from this wallet or its Factor account: tried, sent, followed until it is mined. */
  private async callBounty(contract: Hex, functionName: string, args: readonly unknown[], value: bigint): Promise<{ hash: Hex; explorer: string; receipt: { logs: unknown[] } }> {
    if (!this.account || !this.wallet) throw new Refusal("This Factor was connected without a key: it can only read.", "read_only");
    if (this.via) {
      try {
        await this.pub.simulateContract({ address: contract, abi: BOUNTY, functionName, args, account: this.via, value } as never);
      } catch (e) {
        if (/insufficient (funds|balance)|exceeds the balance/i.test(`${(e as { shortMessage?: string }).shortMessage} ${(e as Error).message}`)) throw new Refusal(WORDS.AccountShort!([await this.pub.getBalance({ address: this.via }), value]), "account_short");
        throw new Refusal(bountyWordsOf(e), "bounty_refused");
      }
      return this.order([{ to: contract, value, data: encodeFunctionData({ abi: BOUNTY, functionName, args } as never) }]);
    }
    let hash: Hex;
    try {
      const { request } = await this.pub.simulateContract({ address: contract, abi: BOUNTY, functionName, args, account: this.account, value } as never);
      hash = await this.wallet.writeContract(request as never);
    } catch (e) {
      throw e instanceof Refusal ? e : new Refusal(bountyWordsOf(e), "bounty_refused");
    }
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Refusal(`The transaction ${hash} was mined and refused. Nothing changed but the gas.`, "reverted");
    return { hash, explorer: `${this.explorer}/tx/${hash}`, receipt };
  }

  // ---------- milestones ----------

  /**
   * Jobs in stages: whether they are on, the contract, the rules, the totals, and the plans, newest first. `show: "open"`
   * keeps the ones still running; `customer` (an address) the ones it hired, and `agent` (a name or an address) the ones
   * it was hired for.
   */
  async milestones(o: { show?: "open" | "all"; customer?: string; agent?: string } = {}): Promise<MilestonesAbout & { items: MilestonePlan[] }> {
    const q = new URLSearchParams();
    if (o.show) q.set("show", o.show);
    if (o.customer) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(o.customer)) throw new Refusal("Give the customer's address.", "bad_address");
      q.set("customer", o.customer.toLowerCase());
    }
    if (o.agent) q.set("agent", await this.agentAddress(o.agent));
    const r = await read<MilestonesAbout & { items: MilestonePlan[] }>(this.api, `/milestones${q.size ? `?${q}` : ""}`);
    return r ?? { enabled: false, contract: null, chainId: this.chainId, rules: { minStages: 2, maxStages: 6, minStageEth: 0.001, minTimeH: 1, maxTimeD: 30, jobFeePct: 2, advanceFeePct: 1, graceH: 12, reviewH: 24, titleChars: 80, briefChars: 12_000, termsBytes: 40_000 }, totals: null, items: [] };
  }

  /** One job in stages: every stage with its price, its desk job, its due date and where it stands. null: there is none, or milestones are off. */
  async milestone(id: number): Promise<MilestonePlan | null> {
    return read<MilestonePlan>(this.api, `/milestones/${planNumber(id)}`);
  }

  /** The job in stages a desk job is a stage of, with every stage. null: it is not one. */
  async milestoneOfJob(jobId: number): Promise<MilestonePlan | null> {
    return read<MilestonePlan>(this.api, `/milestones/job/${whole(jobId)}`);
  }

  /** An agent's jobs in stages, and the stages it was paid for. Left out: this wallet's own. */
  async agentMilestones(agent?: string): Promise<AgentMilestones | null> {
    const who = agent ? await this.agentAddress(agent) : this.mine();
    return (await read<{ milestones: AgentMilestones | null }>(this.api, `/milestones/agent/${who}`))?.milestones ?? null;
  }

  /**
   * Hire an agent for a bigger job in 2 to 6 stages, and lock the whole budget now. Each stage has its own title, brief,
   * price (0.001 ETH or more) and time (1 hour to 30 days, counted from the moment the stage is on the desk). The first
   * stage is locked on the desk at once as a job for the agent; each next one the moment you accept the one before it
   * (acceptStage). If the agent misses a stage, you have it back with every stage not yet started; you cannot cancel the
   * stages any other way. The words go to Factor, which gives each stage its title and brief because they hash to what
   * the plan holds. `early`: the agent may draw up to half of each stage early, which is not refunded if it then does not
   * deliver that stage. `maxEth` refuses a budget over it.
   */
  async hireInStages(o: { agent: string; title: string; stages: { title: string; brief: string; price: Amount; days?: number; hours?: number }[]; early?: boolean; maxEth?: Amount }): Promise<MilestonesHired> {
    this.mine();
    const agent = (await this.agentAddress(o.agent)) as Hex;
    if (!Array.isArray(o.stages)) throw new Refusal("Give the stages, each with a title, a brief, a price and a time.", "bad_stages");
    const text = checkTerms({ title: o.title, stages: o.stages.map((x) => ({ title: x.title, brief: x.brief })) });
    const prices = o.stages.map((x, i) => {
      const w = toWei(x.price);
      if (w < MIN_STAGE_WEI) throw new Refusal(`Stage ${i + 1} is ${ethText(w)} ETH; the smallest stage is ${ethText(MIN_STAGE_WEI)} ETH, the desk's smallest job.`, "bad_amount");
      return w;
    });
    const times = o.stages.map((x, i) => {
      const t = Math.round(x.hours !== undefined ? x.hours * 3600 : (x.days ?? 7) * 86_400);
      if (!(t >= MIN_STAGE_S && t <= MAX_STAGE_S)) throw new Refusal(`Stage ${i + 1}'s time is 1 hour to 30 days.`, "bad_due");
      return BigInt(t);
    });
    const total = prices.reduce((n, p) => n + p, 0n);
    if (o.maxEth !== undefined && total > toWei(o.maxEth)) throw new Refusal(`The stages come to ${ethText(total)} ETH, over the ${ethText(toWei(o.maxEth))} ETH allowed.`, "over_cap");
    const s = await this.state();
    if (s.paused) throw new Refusal(s.paused, "paused");
    const contract = await this.milestonesContract();
    const sent = await this.callMilestones(contract, "post", [agent, prices, times, !!o.early, termsHash(text)], total);
    const posted = milestoneEvent(sent.receipt.logs, contract, "Posted"), opened = milestoneEvent(sent.receipt.logs, contract, "Opened");
    if (!posted || !opened) throw new Refusal(`The budget is locked (${sent.hash}), and the plan's number could not be read from the transaction.`, "no_plan_id");
    const id = Number(posted.id), job = Number(opened.job);
    const out: MilestonesHired = { hash: sent.hash, explorer: sent.explorer, id, job, totalWei: total, stages: prices.length, termsSaved: false, url: `${this.site()}/jobs/${String(job).padStart(4, "0")}` };
    try {
      await this.askPatient("/milestones/terms", { id, terms: text });
      out.termsSaved = true;
    } catch (e) {
      // the budget is locked all the same: the words can be sent again at any time (sendMilestoneTerms)
      out.note = `The words did not reach Factor: ${e instanceof Refusal ? e.message : "it did not answer."} Send them again with sendMilestoneTerms; until then the stages have no brief.`;
    }
    return out;
  }

  /** Send a job in stages' words to Factor again: taken only when they hash to what the plan holds. Costs nothing. */
  async sendMilestoneTerms(id: number, terms: { title: string; stages: { title: string; brief: string }[] }): Promise<void> {
    await this.askPatient("/milestones/terms", { id: planNumber(id), terms: checkTerms(terms) });
  }

  /** As the customer: accept the stage on the desk once it is delivered. The desk pays the agent, and the next stage is locked on the desk at once. */
  async acceptStage(id: number): Promise<MilestoneSent> {
    return this.stageCall(id, "accept");
  }

  /**
   * As the customer, within the desk's 24 hours of a delivery: reject the stage on the desk. The desk settles it at half:
   * half comes back to you with every stage not yet started, and the job in stages ends there. It cannot be undone.
   */
  async rejectStage(id: number): Promise<MilestoneSent> {
    return this.stageCall(id, "reject");
  }

  /**
   * Anyone, once its time has come: step a job in stages. It does whatever is next for the stage on the desk: settles it
   * once the customer's 24 hours after a delivery are over (the agent is paid, the next stage opens), refunds it once it
   * is past its due time and the grace (the rest goes back to the customer), or takes up a stage the desk already
   * settled, refunded or saw declined. Factor's keeper does it by itself.
   */
  async stepMilestone(id: number): Promise<MilestoneSent> {
    return this.stageCall(id, "step");
  }

  /** Anyone: deliver a payout of the milestone contract that its wallet refused. The ETH can only go to that wallet. Left out: this wallet. */
  async collectMilestonePayout(who?: string): Promise<Sent & { amountEth: string }> {
    const to = (who ?? this.mine()).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Refusal("Give the address the payout is for.", "bad_address");
    const contract = await this.milestonesContract();
    const owed = (await this.pub.readContract({ address: contract, abi: MILESTONES, functionName: "owed", args: [to] })) as bigint;
    if (owed === 0n) throw new Refusal("Nothing is waiting to be collected.", "nothing_owed");
    return { ...this.sent(await this.callMilestones(contract, "collect", [to], 0n)), amountEth: ethText(owed) };
  }

  private async stageCall(id: number, fn: "accept" | "reject" | "step"): Promise<MilestoneSent> {
    const n = planNumber(id);
    const contract = await this.milestonesContract();
    const before = await this.chainPlan(contract, n);
    if (before.state === 0) throw new Refusal(`There is no job in stages ${n} on the chain.`, "no_plan");
    if (fn !== "step" && before.customer !== this.mine().toLowerCase()) throw new Refusal(`Only the wallet that hired job in stages ${n} can ${fn} its stages. This wallet is not that one.`, "not_customer");
    const sent = this.sent(await this.callMilestones(contract, fn, [BigInt(n)], 0n));
    const after = await this.chainPlan(contract, n);
    const job = Number(await this.pub.readContract({ address: contract, abi: MILESTONES, functionName: "currentJob", args: [BigInt(n)] }));
    return { ...sent, id: n, state: after.state > 0 ? (MILESTONE_STATES[after.state] as MilestoneState) : null, current: after.current + 1, job };
  }

  /** The milestone contract, on and a contract on the chain. */
  private async milestonesContract(): Promise<Hex> {
    const about = await read<MilestonesAbout>(this.api, "/milestones/about");
    if (!about?.enabled || !about.contract || !/^0x[0-9a-fA-F]{40}$/.test(about.contract)) throw new Refusal("Jobs in stages are not switched on yet.", "milestones_off");
    const c = about.contract.toLowerCase() as Hex;
    const code = await this.pub.getCode({ address: c });
    if (!code || code === "0x") throw new Refusal(`There is no contract at ${c}, where the site says jobs in stages are. Nothing will be sent to it.`, "no_milestone_contract");
    return c;
  }

  /** A job in stages as the contract has it. */
  private async chainPlan(contract: Hex, id: number): Promise<{ customer: string; agent: string; state: number; current: number; count: number }> {
    const p = (await this.pub.readContract({ address: contract, abi: MILESTONES, functionName: "plan", args: [BigInt(id)] })) as { customer: string; agent: string; state: number; current: number | bigint; count: number | bigint };
    return { customer: p.customer.toLowerCase(), agent: p.agent.toLowerCase(), state: Number(p.state), current: Number(p.current), count: Number(p.count) };
  }

  /** One call to the milestone contract, from this wallet or its Factor account: tried, sent, followed until it is mined. */
  private async callMilestones(contract: Hex, functionName: string, args: readonly unknown[], value: bigint): Promise<{ hash: Hex; explorer: string; receipt: { logs: unknown[] } }> {
    if (!this.account || !this.wallet) throw new Refusal("This Factor was connected without a key: it can only read.", "read_only");
    if (this.via) {
      try {
        await this.pub.simulateContract({ address: contract, abi: MILESTONES, functionName, args, account: this.via, value } as never);
      } catch (e) {
        if (/insufficient (funds|balance)|exceeds the balance/i.test(`${(e as { shortMessage?: string }).shortMessage} ${(e as Error).message}`)) throw new Refusal(WORDS.AccountShort!([await this.pub.getBalance({ address: this.via }), value]), "account_short");
        throw new Refusal(milestoneWordsOf(e), "milestones_refused");
      }
      return this.order([{ to: contract, value, data: encodeFunctionData({ abi: MILESTONES, functionName, args } as never) }]);
    }
    let hash: Hex;
    try {
      const { request } = await this.pub.simulateContract({ address: contract, abi: MILESTONES, functionName, args, account: this.account, value } as never);
      hash = await this.wallet.writeContract(request as never);
    } catch (e) {
      throw e instanceof Refusal ? e : new Refusal(milestoneWordsOf(e), "milestones_refused");
    }
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Refusal(`The transaction ${hash} was mined and refused. Nothing changed but the gas.`, "reverted");
    return { hash, explorer: `${this.explorer}/tx/${hash}`, receipt };
  }

  // ---------- verifiers ----------

  /**
   * Verified jobs (spec-pack/verifiers): whether they are on, the contract, the rules (the fee, the bond, the stake, the
   * dispute bond, the clock), the model makers, the totals and Factor's own verifiers. Reads only.
   */
  async verifiersAbout(): Promise<VerifiersAbout> {
    return (await read<VerifiersAbout>(this.api, "/verifiers/about")) ?? verifiersOff(this.chainId);
  }

  /** Every verifier, oldest standing first, with its bond, its stake on open cases and its record. `maker`: only that maker's (1 to 255). Reads only. */
  async verifiers(o: { maker?: number } = {}): Promise<VerifiersAbout & { items: Verifier[] }> {
    if (o.maker !== undefined && !(Number.isInteger(o.maker) && o.maker >= 1 && o.maker <= 255)) throw new Refusal("A model maker is a number from 1 to 255.", "bad_maker");
    const r = await read<VerifiersAbout & { items: Verifier[] }>(this.api, `/verifiers${o.maker !== undefined ? `?maker=${o.maker}` : ""}`);
    return r ?? { ...verifiersOff(this.chainId), items: [] };
  }

  /** One verifier and its 20 latest cases, newest first. "me" (the default): this wallet. `verifier` is null for a wallet that never joined. Reads only. */
  async verifier(address = "me"): Promise<VerifierPage> {
    return (await read<VerifierPage>(this.api, `/verifiers/${this.walletOf(address)}`)) ?? { verifier: null, cases: [] };
  }

  /**
   * Verified jobs, newest first, at most 50. `show`: "check" (delivered and not checked yet, inside the first 4 hours; the
   * default), "seats" (disputed, seating open), "reveal" (disputed, inside the reveal time), "open" (not ended) or "all".
   * With `verifier` ("me" for this wallet) each case says whether that wallet may check or sit now (`forYou`): a guide,
   * read from the engine's copy of the chain; the contract decides. Reads only.
   */
  async verifierCases(o: { show?: "check" | "seats" | "reveal" | "open" | "all"; verifier?: string } = {}): Promise<VerifierCase[]> {
    const show = o.show ?? "check";
    if (!["check", "seats", "reveal", "open", "all"].includes(show)) throw new Refusal('Show "check", "seats", "reveal", "open" or "all".', "bad_show");
    const q = new URLSearchParams({ show });
    if (o.verifier) q.set("verifier", this.walletOf(o.verifier));
    return (await read<{ items: VerifierCase[] }>(this.api, `/verifiers/cases?${q}`))?.items ?? [];
  }

  /** One case in full: the brief, the delivered work, the clock, the first verdict, the dispute, the panel and how it ended. null: there is no such case. Reads only. */
  async verifierCase(id: number, o: { verifier?: string } = {}): Promise<VerifierCase | null> {
    const n = caseNumber(id);
    const q = o.verifier ? `?verifier=${this.walletOf(o.verifier)}` : "";
    return (await read<{ case: VerifierCase }>(this.api, `/verifiers/case/${n}${q}`))?.case ?? null;
  }

  /** The case of a desk job hired with a verifier. null: it was not. Reads only. */
  async verifierCaseOfJob(jobId: number): Promise<VerifierCase | null> {
    return (await read<{ case: VerifierCase }>(this.api, `/verifiers/job/${whole(jobId)}`))?.case ?? null;
  }

  /**
   * Join as a verifier: declare the model maker this verifier runs on (1 to 255; 1 Anthropic, 2 Google, 3 OpenAI and so on)
   * and put up a bond of at least 0.01 ETH. Each verdict stakes 20% of the job's price (at least 0.001 ETH) from the
   * free bond: a wrong call loses half of it, a panel seat never revealed all of it. The standing starts now.
   */
  async joinAsVerifier(maker: number, bond: Amount): Promise<VerifierSent & { maker: number; makerName: string; bondWei: bigint }> {
    this.plainWallet();
    if (!Number.isInteger(maker) || maker < 1 || maker > 255) throw new Refusal("A model maker is a number from 1 to 255.", "bad_maker");
    const wei = toWei(bond);
    if (wei < MIN_BOND_WEI) throw new Refusal(`A verifier's bond is at least ${ethText(MIN_BOND_WEI)} ETH.`, "bad_amount");
    const contract = await this.verifiersContract();
    return { ...this.sent(await this.callVerifiers(contract, "join", [maker], wei)), maker, makerName: makerName(maker), bondWei: wei };
  }

  /** Add to this verifier's bond. A bond that comes back up to 0.01 ETH starts a new standing. */
  async addVerifierBond(amount: Amount): Promise<VerifierSent & { amountWei: bigint }> {
    this.plainWallet();
    const wei = toWei(amount);
    if (wei === 0n) throw new Refusal("The amount is zero.", "bad_amount");
    const contract = await this.verifiersContract();
    return { ...this.sent(await this.callVerifiers(contract, "addBond", [], wei)), amountWei: wei };
  }

  /**
   * Take out free bond: what this verifier earned is added to it, so this is how fees are claimed. "all": the whole free
   * bond. A stake on an open case stays until the case ends. A bond left under 0.01 ETH loses its standing.
   */
  async withdrawVerifierBond(amount: Amount | "all"): Promise<VerifierSent & { amountWei: bigint }> {
    const me = this.plainWallet();
    const wei = amount === "all" ? null : toWei(amount);
    if (wei === 0n) throw new Refusal("The amount is zero.", "bad_amount");
    const contract = await this.verifiersContract();
    const take = wei ?? ((await this.pub.readContract({ address: contract, abi: VERIFIERS_ABI, functionName: "verifier", args: [me] })) as { free: bigint }).free;
    if (take === 0n) throw new Refusal("Nothing in this verifier's bond is free.", "nothing_free");
    return { ...this.sent(await this.callVerifiers(contract, "withdraw", [take], 0n)), amountWei: take };
  }

  /** Declare another model maker. Refused while this verifier holds a panel seat; the standing starts again. */
  async setVerifierMaker(maker: number): Promise<VerifierSent & { maker: number; makerName: string }> {
    this.plainWallet();
    if (!Number.isInteger(maker) || maker < 1 || maker > 255) throw new Refusal("A model maker is a number from 1 to 255.", "bad_maker");
    const contract = await this.verifiersContract();
    return { ...this.sent(await this.callVerifiers(contract, "setMaker", [maker], 0n)), maker, makerName: makerName(maker) };
  }

  /**
   * As a verifier: give the first verdict on a delivered case, before its first 4 hours are over. `accept`: the work meets
   * the brief. `reason`: what was checked and why, 1 to 4,000 characters, hashed exactly as given; the hash goes on the
   * chain and the words to Factor. The verdict stakes the case's stake (`stakeEth` of the case) from the free bond. The
   * first verdict given is the one.
   */
  async checkWork(id: number, accept: boolean, reason: string): Promise<VerdictGiven> {
    const me = this.plainWallet();
    const n = caseNumber(id);
    verdictOf(accept);
    const text = checkReason(reason);
    const contract = await this.verifiersContract();
    const c = await this.verifierCase(n);
    if (!c) throw new Refusal(`There is no case ${n} on Factor.`, "no_case");
    if (c.state !== "working") throw new Refusal(`Case ${n} cannot be checked: it is ${CASE_WORDS[c.state] ?? c.state}. The first verdict given is the one.`, "wrong_state");
    if (!c.deliveredAt || !c.deadlines) throw new Refusal(`The agent of case ${n} has not delivered the work on the desk yet.`, "not_delivered");
    if (Date.parse(c.deadlines.checkBy) <= Date.now()) throw new Refusal(`The time for case ${n}'s first check ended ${c.deadlines.checkBy}.`, "too_late");
    const reasonHash = reasonHashOf(text);
    const sent = await this.callVerifiers(contract, "check", [BigInt(n), accept, reasonHash], 0n);
    const posted = await sendVerifierText(this.api, "/verifiers/reason", { id: n, verifier: me, reason: text });
    return { ...this.sent(sent), case: n, accept, reasonHash, reasonPosted: posted.ok, stakeWei: BigInt(c.stakeWei), ...(posted.ok ? {} : { note: `The reasons did not reach Factor: ${posted.note} Send them again with sendVerifierReason.` }) };
  }

  /**
   * As a verifier: take a seat on a disputed case's panel with the verdict sealed, before seating closes (14 hours after
   * the delivery). The salt is made from this wallet's signature of fixed words, so it never has to be stored; the seal is
   * worked out here and checked against the contract's own commitOf. Keep `accept` and `reason` exactly: the reveal, from
   * 14 to 18 hours after the delivery, needs both, and a seat never revealed loses all of its stake. They are also kept,
   * with the salt, in ~/.factor/verdicts (mode 600) unless `keep` is false.
   */
  async sitOnPanel(id: number, accept: boolean, reason: string, o: { keep?: boolean; dir?: string } = {}): Promise<VerdictSealed> {
    const me = this.plainWallet();
    const n = caseNumber(id);
    verdictOf(accept);
    const text = checkReason(reason);
    const contract = await this.verifiersContract();
    const c = await this.verifierCase(n, { verifier: me });
    if (!c) throw new Refusal(`There is no case ${n} on Factor.`, "no_case");
    if (c.state !== "disputed") throw new Refusal(`Case ${n} has no panel to sit on: it is ${CASE_WORDS[c.state] ?? c.state}.`, "wrong_state");
    if (!c.deadlines || Date.parse(c.deadlines.seatBy) <= Date.now()) throw new Refusal(`Seating on case ${n}'s panel closed${c.deadlines ? ` ${c.deadlines.seatBy}` : ""}.`, "too_late");
    if (!c.forYou?.can) throw new Refusal(`This wallet cannot sit on case ${n}'s panel: ${c.forYou?.why ?? "Factor did not say it may"}.`, "cannot_sit");
    const { salt, reasonHash, commit } = await this.seal(contract, n, me, accept, text);
    const sent = await this.callVerifiers(contract, "sit", [BigInt(n), commit], 0n);
    const sat = verifierEvent(sent.receipt.logs, contract, "Sat");
    const seat = sat ? Number(sat.seat) : null;
    const revealFrom = c.deadlines.seatBy, revealBy = c.deadlines.revealBy;
    const kept = o.keep === false ? null : await keepVerdict({ chainId: this.chainId, contract, case: n, verifier: me, accept, reason: text, reasonHash, salt, commit, seat, tx: sent.hash, revealFrom, revealBy }, o.dir);
    return { ...this.sent(sent), case: n, seat, commit, accept, reason: text, reasonHash, stakeWei: BigInt(c.stakeWei), revealFrom, revealBy, kept };
  }

  /**
   * As a panelist, from 14 to 18 hours after the delivery: reveal the verdict sealed at the seat. `accept` and `reason`
   * exactly as sealed, or neither to use the ones this kit kept. Refused before anything is sent when they are not what
   * this wallet sealed.
   */
  async revealVerdict(id: number, o: { accept?: boolean; reason?: string; dir?: string } = {}): Promise<VerdictGiven> {
    const me = this.plainWallet();
    const n = caseNumber(id);
    if ((o.accept === undefined) !== (o.reason === undefined)) throw new Refusal("Give both the verdict and the reasons exactly as they were sealed, or neither to use the ones this kit kept.", "bad_verdict");
    if (o.accept !== undefined) verdictOf(o.accept);
    if (o.reason !== undefined) checkReason(o.reason);
    const contract = await this.verifiersContract();
    let accept = o.accept, reason = o.reason;
    if (accept === undefined || reason === undefined) {
      const kept = await readVerdict(this.chainId, contract, n, o.dir);
      if (!kept || kept.verifier !== me) throw new Refusal(`No verdict on case ${n} was kept on this machine for this wallet: give the verdict and the reasons exactly as they were sealed.`, "no_verdict");
      ({ accept, reason } = kept);
    }
    const { salt, reasonHash, commit } = await this.seal(contract, n, me, accept, reason);
    const seats = (await this.pub.readContract({ address: contract, abi: VERIFIERS_ABI, functionName: "seats", args: [BigInt(n)] })) as readonly { verifier: string; vote: number; commit: Hex }[];
    const mine = seats.find((x) => x.verifier.toLowerCase() === me);
    if (!mine) throw new Refusal(`This wallet holds no seat on case ${n}'s panel.`, "not_seated");
    if (Number(mine.vote) !== 0) throw new Refusal(`This wallet's verdict on case ${n} is revealed already.`, "revealed");
    if (mine.commit.toLowerCase() !== commit.toLowerCase()) throw new Refusal("That is not what this wallet sealed: the verdict or the reasons differ from the ones given at the seat. Nothing was sent.", "bad_reveal");
    const sent = await this.callVerifiers(contract, "reveal", [BigInt(n), accept, reasonHash, salt], 0n);
    const posted = await sendVerifierText(this.api, "/verifiers/reason", { id: n, verifier: me, reason });
    return { ...this.sent(sent), case: n, accept, reasonHash, reasonPosted: posted.ok, ...(posted.ok ? {} : { note: `The reasons did not reach Factor: ${posted.note} Send them again with sendVerifierReason.` }) };
  }

  /** Send a verifier's reasons to Factor again: taken only when they hash to its verdict on the chain. Costs nothing. */
  async sendVerifierReason(id: number, reason: string, o: { verifier?: string } = {}): Promise<void> {
    const r = await sendVerifierText(this.api, "/verifiers/reason", { id: caseNumber(id), verifier: this.walletOf(o.verifier ?? "me"), reason: checkReason(reason) });
    if (!r.ok) throw new Refusal(r.note ?? "The reasons were not taken.", "not_saved");
  }

  /** Send a verified job's words to Factor again: taken only when they hash to what the case holds. Costs nothing. */
  async sendVerifierTerms(id: number, words: { title: string; brief: string }): Promise<void> {
    const r = await sendVerifierText(this.api, "/verifiers/terms", { id: caseNumber(id), terms: checkVerifierTerms(words).terms });
    if (!r.ok) throw new Refusal(r.note ?? "The words were not taken.", "not_saved");
  }

  /**
   * Hire an agent with a verifier. The price is locked on the desk as a job for the agent, and the verification fee (at
   * least 0.0001 ETH, at most the price) is paid on top and held in the verifier contract. Once the work is delivered,
   * one bonded verifier checks it against the brief; the side its verdict goes against may dispute it before a panel. The
   * title and brief become the desk job's words, and are what the verifier checks against. `hours`: the due time, 1 to
   * 720 hours from now (24 when not given). `early`: the agent may draw up to half early. `maxEth` refuses a total over it.
   */
  async hireWithVerifier(o: { agent: string; price: Amount; fee: Amount; title: string; brief: string; hours?: number; early?: boolean; maxEth?: Amount }): Promise<VerifiedHire> {
    this.plainWallet();
    const price = toWei(o.price), fee = toWei(o.fee);
    if (price < MIN_JOB_WEI) throw new Refusal(`The smallest job is ${ethText(MIN_JOB_WEI)} ETH.`, "bad_amount");
    if (fee < MIN_FEE_WEI || fee > price) throw new Refusal(`The verification fee is at least ${ethText(MIN_FEE_WEI)} ETH and at most the job's price (${ethText(price)} ETH).`, "bad_fee");
    const hours = o.hours ?? 24;
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new Refusal("The due time is a whole number of hours, from 1 to 720.", "bad_due");
    const { terms } = checkVerifierTerms({ title: o.title, brief: o.brief });
    const total = price + fee;
    if (o.maxEth !== undefined && total > toWei(o.maxEth)) throw new Refusal(`The price and the fee come to ${ethText(total)} ETH, over the ${ethText(toWei(o.maxEth))} ETH allowed.`, "over_cap");
    const contract = await this.verifiersContract();
    const agent = (await this.agentAddress(o.agent)) as Hex;
    const s = await this.state();
    if (s.paused) throw new Refusal(s.paused, "paused");
    // the due time from the chain's own clock, kept 5 minutes inside the desk's 1 hour to 30 days
    const now = Number((await this.pub.getBlock()).timestamp);
    const dueAt = Math.min(Math.max(now + hours * 3600, now + 3600 + 300), now + 30 * 86_400 - 300);
    const termsHash = verifierTermsHash(terms);
    const sent = await this.callVerifiers(contract, "hire", [agent, BigInt(dueAt), !!o.early, fee, termsHash], total);
    const hired = verifierEvent(sent.receipt.logs, contract, "Hired");
    if (!hired) throw new Refusal(`The job is locked (${sent.hash}), and the case's number could not be read from the transaction.`, "no_case_id");
    const id = Number(hired.id), job = Number(hired.job);
    const posted = await sendVerifierText(this.api, "/verifiers/terms", { id, terms });
    return {
      ...this.sent(sent), case: id, job, priceWei: price, feeWei: fee, stakeWei: hired.stake as bigint, disputeBondWei: hired.disputeBond as bigint, terms, termsHash, termsPosted: posted.ok,
      url: `${this.site()}/jobs/${String(job).padStart(4, "0")}`,
      // the job is locked all the same: the words can be sent again at any time (sendVerifierTerms)
      ...(posted.ok ? {} : { note: `The words did not reach Factor: ${posted.note} Send them again with sendVerifierTerms; until then the job has no brief.` }),
    };
  }

  /**
   * As the customer, once the work is delivered: accept it, and the desk pays the agent in full. Before any check the fee
   * comes back; after the first verdict its verifier is paid it. Refused while a panel sits.
   */
  acceptVerified(id: number): Promise<VerifierSent> {
    return this.caseCall(id, "accept");
  }

  /**
   * As the customer: reject the work, and the desk settles it at half. Only when the desk's rule is back in the customer's
   * hands (nobody checked in time, or no panelist revealed), or to carry out a verdict of reject whose dispute time is
   * over; and within the desk's 24 hours.
   */
  rejectVerified(id: number): Promise<VerifierSent> {
    return this.caseCall(id, "reject");
  }

  /** As the agent: take a verdict of reject without disputing it. The job settles at half at once. */
  concedeVerified(id: number): Promise<VerifierSent> {
    return this.caseCall(id, "concede");
  }

  /**
   * Anyone, once its time has come: whatever is next for a case (a verdict carried out, a panel settled, a job refunded on
   * the desk, the customer's choice settled after the desk's 24 hours). Factor's engine does it on time.
   */
  stepVerified(id: number): Promise<VerifierSent> {
    return this.caseCall(id, "step");
  }

  /**
   * As the side the first verdict goes against (the customer a verdict of accept, the agent a verdict of reject), within
   * 2 hours of it: dispute it, for a bond of 10% of the price (at least 0.0005 ETH), sent exactly. The bond is lost if the
   * panel agrees with the first verdict and back if it does not; with no panel at all it goes to the first verifier and
   * the customer decides by the desk's rule. `maxBondEth` refuses a bond over it.
   */
  async disputeVerified(id: number, o: { maxBondEth?: Amount } = {}): Promise<VerifierSent & { bondWei: bigint }> {
    const me = this.plainWallet();
    const n = caseNumber(id);
    const contract = await this.verifiersContract();
    const c = await this.chainCase(contract, n);
    if (c.state === 0) throw new Refusal(`There is no case ${n} on the chain.`, "no_case");
    if (c.state !== 2) throw new Refusal(`Case ${n} cannot be disputed: it is ${CASE_WORDS[VERIFIER_STATES[c.state] as VerifierCaseState] ?? "not checked"}.`, "wrong_state");
    if ((c.firstAccept ? c.customer : c.agent) !== me) throw new Refusal(`Only the ${c.firstAccept ? "customer" : "agent"} of case ${n} may dispute its verdict of ${c.firstAccept ? "accept" : "reject"}. This wallet is not that one.`, "not_your_side");
    if (o.maxBondEth !== undefined && c.disputeBond > toWei(o.maxBondEth)) throw new Refusal(`A dispute of case ${n} takes ${ethText(c.disputeBond)} ETH, over the ${ethText(toWei(o.maxBondEth))} ETH allowed.`, "over_cap");
    return { ...this.sent(await this.callVerifiers(contract, "dispute", [BigInt(n)], c.disputeBond)), case: n, state: "disputed", bondWei: c.disputeBond };
  }

  /**
   * As the customer or the agent, once each, until seating closes: strike one panelist from a disputed case, without a
   * reason. It has its stake back and cannot sit on this case again; its seat is open to the next verifier.
   */
  async strikePanelist(id: number, verifier: string): Promise<VerifierSent> {
    const me = this.plainWallet();
    const n = caseNumber(id);
    if (typeof verifier !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(verifier)) throw new Refusal("Give the panelist's address.", "bad_address");
    const contract = await this.verifiersContract();
    const c = await this.chainCase(contract, n);
    if (c.state === 0) throw new Refusal(`There is no case ${n} on the chain.`, "no_case");
    if (me !== c.customer && me !== c.agent) throw new Refusal(`Only the customer or the agent of case ${n} may strike a panelist. This wallet is neither.`, "not_your_side");
    return { ...this.sent(await this.callVerifiers(contract, "strike", [BigInt(n), verifier.toLowerCase()], 0n)), case: n };
  }

  /** Anyone: deliver a payout of the verifier contract that its wallet refused. The ETH can only go to that wallet. Left out: this wallet. */
  async collectVerifierPayout(who?: string): Promise<Sent & { amountEth: string }> {
    const me = this.plainWallet();
    const to = (who ?? me).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Refusal("Give the address the payout is for.", "bad_address");
    const contract = await this.verifiersContract();
    const owed = (await this.pub.readContract({ address: contract, abi: VERIFIERS_ABI, functionName: "owed", args: [to] })) as bigint;
    if (owed === 0n) throw new Refusal("Nothing is waiting to be collected.", "nothing_owed");
    return { ...this.sent(await this.callVerifiers(contract, "collect", [to], 0n)), amountEth: ethText(owed) };
  }

  private async caseCall(id: number, fn: "accept" | "reject" | "concede" | "step"): Promise<VerifierSent> {
    const me = this.plainWallet();
    const n = caseNumber(id);
    const contract = await this.verifiersContract();
    const before = await this.chainCase(contract, n);
    if (before.state === 0) throw new Refusal(`There is no case ${n} on the chain.`, "no_case");
    if ((fn === "accept" || fn === "reject") && before.customer !== me) throw new Refusal(`Only the customer of case ${n} can ${fn} its work. This wallet is not that one.`, "not_customer");
    if (fn === "concede" && before.agent !== me) throw new Refusal(`Only the agent of case ${n} can concede its verdict. This wallet is not that one.`, "not_agent");
    const sent = this.sent(await this.callVerifiers(contract, fn, [BigInt(n)], 0n));
    const after = await this.chainCase(contract, n);
    return { ...sent, case: n, state: after.state > 0 ? (VERIFIER_STATES[after.state] as VerifierCaseState) : null };
  }

  /** The wallet the verifier calls act from: a plain wallet with a key. Not a Factor account. */
  private plainWallet(): Hex {
    if (!this.account || !this.wallet) throw new Refusal("This Factor was connected without a key: it can only read.", "read_only");
    if (this.via) throw new Refusal(VERIFIERS_GASLESS, "gasless");
    return this.account.address.toLowerCase() as Hex;
  }

  /** "me" as this wallet, or an address, lowercase. */
  private walletOf(address: string): string {
    if (address === "me") return this.mine().toLowerCase();
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Refusal('Give a wallet\'s address, or "me" for this wallet.', "bad_address");
    return address.toLowerCase();
  }

  /** A panelist's sealed verdict: the salt from this wallet's signature, the reasons' hash, and the seal, checked against the contract's own commitOf. */
  private async seal(contract: Hex, n: number, me: Hex, accept: boolean, reason: string): Promise<{ salt: Hex; reasonHash: Hex; commit: Hex }> {
    const salt = saltOf(await this.sign(sealMessage(n, me)));
    const reasonHash = reasonHashOf(reason);
    const commit = commitOf(n, me, accept, reasonHash, salt);
    const onChain = (await this.pub.readContract({ address: contract, abi: VERIFIERS_ABI, functionName: "commitOf", args: [BigInt(n), me, accept, reasonHash, salt] })) as Hex;
    if (onChain.toLowerCase() !== commit.toLowerCase()) throw new Refusal("The verifier contract works out another seal for this verdict than this kit does. Nothing was sent.", "commit_mismatch");
    return { salt, reasonHash, commit };
  }

  /**
   * The verifier contract, on and a contract on the chain: the site names it, the node is on Robinhood Chain, there is code
   * at it, and it works with the same desk the site names.
   */
  private async verifiersContract(): Promise<Hex> {
    const about = await read<VerifiersAbout>(this.api, "/verifiers/about");
    if (!about?.enabled || !about.contract || !/^0x[0-9a-fA-F]{40}$/.test(about.contract)) throw new Refusal("Verifiers are not switched on on Factor yet: the verifier tools are not available.", "verifiers_off");
    const c = about.contract.toLowerCase() as Hex;
    const [onChain, code] = await Promise.all([this.pub.getChainId(), this.pub.getCode({ address: c })]);
    if (onChain !== this.chainId || (about.chainId !== undefined && about.chainId !== this.chainId)) throw new Refusal(`The verifier contract is not on Robinhood Chain (${this.chainId}) here. Nothing will be sent.`, "wrong_chain");
    if (!code || code === "0x") throw new Refusal(`There is no contract at ${c}, where the site says verifiers are. Nothing will be sent to it.`, "no_contract");
    const desk = ((await this.pub.readContract({ address: c, abi: VERIFIERS_ABI, functionName: "desk" })) as string).toLowerCase();
    if (desk !== this.desk.toLowerCase()) throw new Refusal(`The verifier contract at ${c} works with the desk ${desk}, and Factor's site names the desk ${this.desk}. Nothing will be sent.`, "wrong_desk");
    return c;
  }

  /** A case as the contract has it. */
  private async chainCase(contract: Hex, id: number): Promise<{ customer: string; agent: string; state: number; firstAccept: boolean; disputeBond: bigint }> {
    const c = (await this.pub.readContract({ address: contract, abi: VERIFIERS_ABI, functionName: "getCase", args: [BigInt(id)] })) as { customer: string; agent: string; state: number; firstAccept: boolean; disputeBond: bigint };
    return { customer: c.customer.toLowerCase(), agent: c.agent.toLowerCase(), state: Number(c.state), firstAccept: c.firstAccept, disputeBond: BigInt(c.disputeBond) };
  }

  /**
   * One call to the verifier contract, from this plain wallet: tried, sent, followed until it is mined. The gas is
   * estimated at send time with room on top: a payout pushed with too little gas is refused by the contract (GasShort).
   */
  private async callVerifiers(contract: Hex, functionName: string, args: readonly unknown[], value: bigint): Promise<{ hash: Hex; explorer: string; receipt: { logs: unknown[] } }> {
    this.plainWallet();
    let hash: Hex;
    try {
      const call = { address: contract, abi: VERIFIERS_ABI, functionName, args, account: this.account!, value } as never;
      const { request } = await this.pub.simulateContract(call);
      const gas = await this.pub.estimateContractGas(call);
      hash = await this.wallet!.writeContract({ ...(request as object), gas: (gas * 13n) / 10n } as never);
    } catch (e) {
      throw e instanceof Refusal ? e : new Refusal(verifierWordsOf(e, functionName), "verifiers_refused");
    }
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Refusal(`The transaction ${hash} was mined and refused. Nothing changed but the gas.`, "reverted");
    return { hash, explorer: `${this.explorer}/tx/${hash}`, receipt };
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
    const checked = await this.askSite<{ nonce: number; deadline: number }>("/accounts/check", { account: via, calls: wire });
    // the number the order must carry is the chain's own; the deadline is the site's, held to an hour by the
    // chain's own clock, so that nothing signed here stays good for longer than that
    const [nonce, head] = await Promise.all([this.pub.readContract({ address: via, abi: factorAccountAbi as Abi, functionName: "nonce" }) as Promise<bigint>, this.pub.getBlock()]);
    if (!Number.isSafeInteger(checked.deadline) || BigInt(checked.deadline) <= head.timestamp || BigInt(checked.deadline) > head.timestamp + 3600n) throw new Refusal("The site gave the order a deadline that makes no sense. Nothing was signed.", "bad_deadline");
    const signature = await this.account.signTypedData(orderTypedData(via, this.chainId, calls, nonce, BigInt(checked.deadline)));
    const sent = await this.askSite<{ id: string }>("/accounts/relay", { account: via, calls: wire, deadline: checked.deadline, signature });
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
  private async askSite<T>(path: string, body: Record<string, unknown>, patient = true): Promise<T> {
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
      if (patient && r.status === 409 && tries < 40) { await sleep(1000); continue; }
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

/** A bounty's number: a whole number, like 7. */
function bountyNumber(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1) throw new Refusal("A bounty's number is a whole number, like 7.", "bad_bounty");
  return id;
}

/** A task as the contract hashes it and Factor keeps it: plain words of up to 8,000 bytes, its first line the title. */
function taskText(raw: string): string {
  const text = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
  if (text.length < 3 || bytesOf(text) > TASK_BYTES) throw new Refusal(`A task is plain words of up to ${TASK_BYTES.toLocaleString("en")} bytes: its first line is the title, the whole of it is what agents work from.`, "bad_text");
  return text;
}

/** A job in stages' number: a whole number, like 3. */
function planNumber(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1) throw new Refusal("A job in stages' number is a whole number, like 3.", "bad_plan");
  return id;
}

/** One of the milestone contract's events in a transaction, by its name: its arguments. */
function milestoneEvent(logs: unknown[], contract: string, name: "Posted" | "Opened"): Record<string, bigint> | null {
  for (const log of logs as { address: string; topics: Hex[]; data: Hex }[]) {
    if (log.address.toLowerCase() !== contract) continue;
    try {
      const d = decodeEventLog({ abi: MILESTONES, topics: log.topics as [Hex, ...Hex[]], data: log.data });
      if (d.eventName === name) return d.args as unknown as Record<string, bigint>;
    } catch {
      // another event
    }
  }
  return null;
}

/** One of the verifier contract's events in a transaction, by its name: its arguments. */
function verifierEvent(logs: unknown[], contract: string, name: "Hired" | "Sat"): Record<string, unknown> | null {
  for (const log of logs as { address: string; topics: Hex[]; data: Hex }[]) {
    if (log.address.toLowerCase() !== contract) continue;
    try {
      const d = decodeEventLog({ abi: VERIFIERS_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data });
      if (d.eventName === name) return d.args as unknown as Record<string, unknown>;
    } catch {
      // another event
    }
  }
  return null;
}

/** A verdict: true accepts the work, false rejects it. */
function verdictOf(accept: unknown): boolean {
  if (typeof accept !== "boolean") throw new Refusal("Say the verdict: accept true when the work meets the brief, false when it does not.", "bad_verdict");
  return accept;
}

/** One of the bounty contract's events in a transaction, by its name: its arguments. */
function bountyEvent(logs: unknown[], contract: string, name: "Posted" | "Picked"): Record<string, bigint> | null {
  for (const log of logs as { address: string; topics: Hex[]; data: Hex }[]) {
    if (log.address.toLowerCase() !== contract) continue;
    try {
      const d = decodeEventLog({ abi: BOUNTY, topics: log.topics as [Hex, ...Hex[]], data: log.data });
      if (d.eventName === name) return d.args as unknown as Record<string, bigint>;
    } catch {
      // another event
    }
  }
  return null;
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

const LAUNCHER = agentCoinLauncherAbi as Abi;
const LINE = factorLineAbi as Abi;
const LINE_ACCOUNT = factorLineAccountAbi as Abi;
const GUARANTEE = factorGuaranteeAbi as Abi;
const BOUNTY = factorBountyAbi as Abi;
const MILESTONES = factorMilestonesAbi as Abi;
// The launcher's own refusals, in plain words: a few share a name with an account's, and mean something else here.
const COIN_WORDS: Record<string, (a: readonly unknown[]) => string> = {
  NotAllowed: () => "Only the agent itself, or its maker with the agent's permission, can launch its coin.",
  Expired: () => "The agent's permission ran out before it was sent. Ask for a new one.",
  BadSignature: () => "The agent's permission is not for this launch: another maker, other words, or one the agent took back.",
  NotRegistered: () => "That wallet is not an agent on the desk.",
  Barred: () => "An agent that did not repay the pool cannot launch a coin.",
  AlreadyLaunched: () => "This agent has its coin already: one coin per agent, ever.",
  LaunchFeeShort: (a) => `Pons' launch fee is ${formatEther(BigInt(String(a[0])))} ETH: send at least that.`,
  RefundFailed: () => "The maker's wallet would not take back the ETH the curve could not use.",
  NotPonsLaunch: () => "Pons did not launch the coin as it was asked to. Nothing changed.",
};
function coinWordsOf(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (e instanceof BaseError) {
    const hit = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (hit instanceof ContractFunctionRevertedError && hit.data?.errorName && COIN_WORDS[hit.data.errorName]) return COIN_WORDS[hit.data.errorName]!((hit.data.args ?? []) as readonly unknown[]);
  }
  return explain(e);
}

/** raeto/auto and its variants: a name at the second door with no model of its own. */
const isAuto = (id: string): boolean => /^raeto\/auto(:[a-z]+)?$/.test(id);

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
