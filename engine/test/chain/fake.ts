// A chain made up for the engine's tests: blocks that are mined when a test says so, the three contracts as a small
// model that keeps the rules the engine leans on (the split, the burn's interval and minimum, the desk's jobs and
// their money, written again here from docs/RULEBOOK.md), the ETH price feed, logs
// in the real encoding (the watchers decode them with the real ABIs), and a wallet whose sends can be held back,
// dropped or made to fail. Nothing here touches a node or a key.

import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, type Abi, type AbiEvent, type Hex } from "viem";
import { factorAccountAbi, factorAccountsAbi, factorBurnPotAbi, factorDeskAbi, factorSplitterAbi, factorTokenAbi } from "../../src/abi/index.js";
import { Reverted, type CallSpec, type Chain, type ChainLog, type Fees, type Head, type LogFilter, type Pay, type RawCall, type Receipt, type RpcHealth, type SentTx, type Signer, type TxRequest } from "../../src/chain/chain.js";
import { ETH_USD_FEED } from "../../src/chain/watch.js";
import { FEEDS } from "../../src/house/feeds.js";

export const A = {
  splitter: "0x00000000000000000000000000000000000051f7",
  burnPot: "0x00000000000000000000000000000000000b0b07",
  desk: "0x000000000000000000000000000000000000de5c",
  gateway: "0x000000000000000000000000000000000000a7e0",
  token: "0x00000000000000000000000000000000000be157",
  factory: "0x00000000000000000000000000000000000fac70",
  escrow: "0x0000000000000000000000000000000000e5c209",
  admin: "0x00000000000000000000000000000000000ad313",
  bot: "0x0000000000000000000000000000000000000b07",
  // the maker of accounts for people without a wallet, and the account its copies are made from
  accounts: "0x00000000000000000000000000000000000acc07",
  original: "0x00000000000000000000000000000000000acc00",
};
// What the made-up accounts take as their owner's signature: a real one needs a passkey or a key, which the engine
// never has, so here the right signature is simply this one and every other is refused as the contract would.
export const GOOD_SIGNATURE = `0x${"5e".repeat(65)}` as Hex;
const ZERO = "0x0000000000000000000000000000000000000000";
export const ETH = 10n ** 18n;
export const MINTED = 1_000_000_000n * ETH;
const ABIS: Record<string, Abi> = { splitter: factorSplitterAbi as Abi, burnPot: factorBurnPotAbi as Abi, desk: factorDeskAbi as Abi, token: factorTokenAbi as Abi, accounts: factorAccountsAbi as Abi, account: factorAccountAbi as Abi };

// The desk's own numbers for a job's state, and for the kind of an advance.
export const S = { none: 0, locked: 1, advanced: 2, delivered: 3, settled: 4, half: 5, declined: 6, refunded: 7 } as const;
export const K = { early: 0, pool: 1, compute: 2 } as const;
const GRACE = 12 * 3600;
const REVIEW = 24 * 3600;

export interface FakeJob {
  customer: string;
  agent: string;
  price: bigint;
  dueAt: number;
  deliveredAt: number;
  state: number;
  allowEarly: boolean;
  late: boolean;
  early: bigint;
  fromPool: bigint;
  proof: string;
}

export interface FakeAgent {
  registered: boolean;
  barred: boolean;
  firstSettledAt: number;
  settled: number;
  settledAtHalf: number;
  notDelivered: number;
  unanswered: number;
  customers: number;
  onTime: number;
  late: number;
  advancesRepaid: number;
  advancesNotRepaid: number;
  earlyKept: number;
  bond: bigint;
  feesPaid: bigint;
  advancedNow: bigint;
  volume: bigint;
}

export class FakeChain implements Chain {
  id = 4663;
  number = 5000n;
  time: number;
  private stamps = new Map<bigint, number>();
  private salts = new Map<bigint, number>();
  allLogs: ChainLog[] = [];
  code_ = new Set<string>([A.splitter, A.burnPot, A.desk, A.token, A.factory, A.escrow, A.accounts, A.original]);
  // accounts for people without a wallet that exist, with the number their next order must carry
  made = new Map<string, { nonce: number; kind: number; a: string; b: string }>();

  // the token
  token: string | null = A.token;
  supply = MINTED;
  phase = 0;
  // the splitter and Pons' fee path
  curveFees = 0n; // fees still on the curve
  escrow = 0n; // what Pons' escrow holds for the splitter
  unsplit = 0n;
  factorCredit = 0n; // a credit in $FACTOR in the escrow
  totalSplit = 0n;
  totalToAdmin = 0n;
  totalToPool = 0n;
  wiring = { splitterBurn: A.burnPot, potSplitter: A.splitter, splitterDesk: A.desk, deskBurn: A.burnPot };
  // the desk
  pool = 0n;
  out = 0n;
  deskHeld = 0n;
  bonds = 0n;
  owedTotal = 0n;
  owed = new Map<string, bigint>();
  jobs = new Map<number, FakeJob>();
  agents = new Map<string, FakeAgent>();
  feesFrom = new Map<string, bigint>();
  jobCount = 0;
  totalAdvanced = 0n;
  totalAdvanceFees = 0n;
  totalJobFees = 0n;
  totalSettled = 0n;
  totalPoolIn = 0n;
  totalLost = 0n;
  gatewayAddr = A.gateway; // where the desk pays compute advances: a test may make it the gas wallet itself
  potRefuses = false; // the burn pot refuses an advance fee, which then waits in the desk
  paid = new Map<string, bigint>(); // what the desk has paid out, by wallet
  // the burn pot
  potEth = 0n;
  potFactor = 0n;
  startedAt: number;
  lastBurnAt = 0;
  burnCount = 0;
  totalEthBurned = 0n;
  totalTokensBurned = 0n;
  depthCap = 10n * ETH; // the most one burn may spend
  marketOpen = true;
  tokensPerEth = 500_000n; // the price a burn buys at
  fillBps = 10_000n; // under 10000: the pool's price limit stops the swap short
  // the ETH price feed: dollars with 8 decimals
  ethUsd = 2_500n * 10n ** 8n;
  // shares the splitter could not deliver when it split (somebody called it with too little gas): its retry() sends
  // them on, unless a test says the destination still refuses
  waiting = { admin: 0n, burn: 0n, pool: 0n };
  stillRefused = false;
  feedsDown = false;
  feedPrices = new Map<string, bigint>();
  feedAgeS = 120;

  // the bot's wallet and the node
  balances = new Map<string, bigint>([[A.bot, ETH / 100n]]);
  nonce = 0; // mined
  held: { hash: string; tx: TxRequest; from: string }[] = []; // sent, not mined
  receipts = new Map<string, Receipt>();
  hold = false; // sends stay in the mempool
  dropSends = false; // a send's request fails before it reaches the node (no connection)
  rejectSends = false; // the node answers a send with an error
  loseReply = false; // the node takes a send, and the reply is lost on the way back
  gasPrice = 22_000_000n;
  gasOf: Record<string, bigint> = { sweep: 280_000n, claimToken: 150_000n, burn: 400_000n, settle: 220_000n, refund: 100_000n, collect: 45_000n };
  busy = false; // every request is turned away (403)
  down = false; // every request fails
  tooManyAbove = 0n; // a log query over more blocks than this is refused as too big (0: never)
  calls: { kind: string; what: string; args?: readonly unknown[] }[] = [];
  private hashes = 0;

  constructor(start = Date.UTC(2026, 9, 8, 12) / 1000) {
    this.time = start;
    this.startedAt = start - 3600;
    this.stamps.set(this.number, this.time);
    this.mint();
  }

  // ---------- blocks ----------

  private hashOf(n: bigint): string {
    return `0x${(n * 1000n + BigInt(this.salts.get(n) ?? 0)).toString(16).padStart(64, "0")}`;
  }

  mine(blocks = 1, seconds = 0): void {
    this.time += seconds;
    for (let i = 0; i < blocks; i++) {
      this.number += 1n;
      this.stamps.set(this.number, this.time);
    }
    // whatever was held back stays held: only release() mines it
  }

  // Move the clock to a moment and mine a block there.
  warpTo(seconds: number): void {
    if (seconds < this.time) throw new Error("the fake chain's clock does not go back");
    this.time = seconds;
    this.mine();
  }

  // The last `depth` blocks are replaced: other hashes, and the logs that were in them are gone.
  reorg(depth: number): void {
    const from = this.number - BigInt(depth) + 1n;
    for (let n = from; n <= this.number; n++) this.salts.set(n, (this.salts.get(n) ?? 0) + 1);
    this.allLogs = this.allLogs.filter((l) => l.blockNumber < from);
  }

  // ---------- logs ----------

  emit(contract: keyof typeof ABIS, eventName: string, args: Record<string, unknown>, txHash?: string, from?: string): ChainLog {
    const abi = ABIS[contract];
    const event = abi.find((x) => x.type === "event" && x.name === eventName) as AbiEvent;
    const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
    const rest = event.inputs.filter((i) => !i.indexed);
    const data = encodeAbiParameters(rest, rest.map((i) => args[i.name!]) as never);
    const address = from ?? (contract === "token" ? this.token! : A[contract as "splitter"]);
    const hash = txHash ?? this.newHash();
    const log: ChainLog = { address, topics, data, blockNumber: this.number, transactionHash: hash, logIndex: this.allLogs.filter((l) => l.blockNumber === this.number).length };
    this.allLogs.push(log);
    return log;
  }

  private newHash(): string {
    return `0x${(++this.hashes).toString(16).padStart(64, "f")}`;
  }

  private mint(): void {
    this.emit("token", "Transfer", { from: ZERO, to: A.factory, value: MINTED });
  }

  // ---------- what tests do to the world ----------

  // A trade leaves fees on the curve (before graduation) or, once Pons' keeper has run, in the escrow.
  trade(fee: bigint, where: "curve" | "escrow" = "curve"): void {
    if (where === "curve") this.curveFees += fee;
    else this.escrow += fee;
    this.mine();
  }

  // ---------- the contracts ----------

  private preview(): [bigint, bigint, boolean] {
    if (!this.token) return [0n, 0n, false];
    const amount = this.potEth < this.depthCap ? this.potEth : this.depthCap;
    if (amount === 0n) return [0n, 0n, false];
    const since = this.lastBurnAt || this.startedAt;
    let at = Math.max(since + 1800, this.time);
    if (amount < ETH / 1000n) at = Math.max(at, since + 86400);
    return [amount, BigInt(at), this.marketOpen && at <= this.time];
  }

  // Run a call. `commit` false: the answer only, nothing changes. Throws Reverted as the contract would.
  private run(call: CallSpec, from: string, commit: boolean, txHash = ""): unknown {
    const to = call.to.toLowerCase();
    const args = call.args ?? [];
    const fn = call.functionName;
    if (to === A.splitter && fn === "sweep") {
      const amount = this.curveFees + this.escrow + this.unsplit;
      if (commit && amount > 0n) {
        const toAdmin = (amount * 7000n) / 10000n;
        const toPool = (amount * 1000n) / 10000n;
        const toBurn = amount - toAdmin - toPool;
        this.curveFees = this.escrow = this.unsplit = 0n;
        this.totalSplit += amount;
        this.totalToAdmin += toAdmin;
        this.totalToPool += toPool;
        this.potEth += toBurn;
        this.emit("splitter", "Split", { amount, toAdmin, toBurn, toPool, adminPushed: true, burnPushed: true, poolPushed: true }, txHash);
        if (toPool > 0n) this.poolIn(A.splitter, toPool, txHash);
      }
      return amount;
    }
    if (to === A.splitter && fn === "claimToken") {
      const amount = this.factorCredit;
      if (commit && amount > 0n) {
        this.factorCredit = 0n;
        this.potFactor += amount;
        this.emit("splitter", "TokensSentToBurn", { amount }, txHash);
      }
      return amount;
    }
    if (to === A.burnPot && fn === "burn") {
      const minOut = args[0] as bigint;
      if (!this.token) throw new Reverted("TokenNotSet");
      const since = this.lastBurnAt || this.startedAt;
      if (this.time < since + 1800) throw new Reverted("TooSoon", [BigInt(since + 1800)]);
      if (!this.marketOpen) throw new Reverted("MarketNotReady");
      const amount = this.potEth < this.depthCap ? this.potEth : this.depthCap;
      if (amount === 0n) throw new Reverted("NothingToBurn");
      if (amount < ETH / 1000n && this.time < since + 86400) throw new Reverted("TooSmall", [amount, ETH / 1000n]);
      const ethIn = (amount * this.fillBps) / 10000n;
      const bought = ethIn * this.tokensPerEth;
      if (ethIn === amount ? bought < minOut : (minOut * ethIn) / amount > bought) throw new Reverted("Slippage");
      const burned = bought + this.potFactor;
      if (commit) {
        this.potEth -= ethIn;
        this.potFactor = 0n;
        this.lastBurnAt = this.time;
        this.burnCount++;
        this.totalEthBurned += ethIn;
        this.totalTokensBurned += burned;
        this.supply -= burned;
        this.emit("burnPot", "Burned", { n: BigInt(this.burnCount), caller: from, ethIn, tokensBurned: burned, viaCurve: this.phase === 0 }, txHash);
      }
      return [ethIn, burned];
    }
    if (to === A.desk && fn === "settle") {
      const id = Number(args[0]);
      const j = this.jobs.get(id);
      if (!j || j.state !== S.delivered) throw new Reverted("WrongState", [j?.state ?? 0]);
      if (this.time < j.deliveredAt + REVIEW) throw new Reverted("TooSoon", [BigInt(j.deliveredAt + REVIEW)]);
      if (commit) this.settleJob(id, txHash);
      return undefined;
    }
    if (to === A.desk && fn === "refund") {
      const id = Number(args[0]);
      const j = this.jobs.get(id);
      if (!j || (j.state !== S.locked && j.state !== S.advanced)) throw new Reverted("WrongState", [j?.state ?? 0]);
      if (this.time <= j.dueAt + GRACE) throw new Reverted("TooSoon", [BigInt(j.dueAt + GRACE + 1)]);
      if (commit) this.refundJob(id, txHash);
      return undefined;
    }
    if (to === A.desk && fn === "collect") {
      const who = String(args[0]).toLowerCase();
      const amount = this.owed.get(who) ?? 0n;
      if (amount === 0n) throw new Reverted("NothingOwed");
      if (who === A.burnPot && this.potRefuses) throw new Reverted("PushFailed");
      if (commit) {
        this.owed.set(who, 0n);
        this.owedTotal -= amount;
        this.emit("desk", "Collected", { who, to: who, amount }, txHash);
        this.give(who, amount, txHash, true);
      }
      return undefined;
    }
    if (to === A.splitter && fn === "retry") {
      if (commit && !this.stillRefused) {
        const { admin, burn, pool } = this.waiting;
        this.waiting = { admin: 0n, burn: 0n, pool: 0n };
        if (admin > 0n) this.give(A.admin, admin, txHash);
        if (burn > 0n) this.give(A.burnPot, burn, txHash);
        if (pool > 0n) this.poolIn(A.splitter, pool, txHash);
      }
      return undefined;
    }
    if (to === A.accounts && fn === "create") {
      const key = args[0] as { kind: number; a: string; b: string };
      const account = FakeChain.accountOf(key);
      if (commit && !this.made.has(account)) {
        this.made.set(account, { nonce: 0, kind: Number(key.kind), a: key.a, b: key.b });
        this.code_.add(account);
        const id = keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }], [Number(key.kind), key.a as Hex, key.b as Hex]));
        this.emit("account", "KeyAdded", { id, kind: Number(key.kind), a: key.a, b: key.b, credential: args[1] }, txHash, account);
        this.emit("accounts", "Created", { account, keyId: id, kind: Number(key.kind), a: key.a, b: key.b, credential: args[1] }, txHash);
      }
      return account;
    }
    const account = this.made.get(to);
    if (account && fn === "execute") {
      const [calls, deadline, signature] = args as [{ to: string; value: bigint; data: Hex }[], bigint, string];
      if (BigInt(this.time) > deadline) throw new Reverted("Expired", [deadline]);
      if (signature !== GOOD_SIGNATURE) throw new Reverted("BadSignature");
      // every call is tried first, so that all of an order happens or none of it
      calls.forEach((c, i) => {
        try {
          this.asAccount(to, c, false, txHash);
        } catch (e) {
          // a call the account cannot pay for fails inside the order, which then fails as a whole
          if (e instanceof Reverted) throw e;
          throw new Reverted("CallFailed", [BigInt(i)]);
        }
      });
      if (commit) {
        account.nonce++;
        for (const c of calls) this.asAccount(to, c, true, txHash);
      }
      return [];
    }
    throw new Error(`the fake chain has no ${fn} at ${to}`);
  }

  // ---------- the desk, as tests move it ----------

  private agentOf(address: string): FakeAgent {
    const a = this.agents.get(address.toLowerCase());
    if (!a) throw new Reverted("NotRegistered");
    return a;
  }

  // The desk pays a wallet. The burn pot can be made to refuse, and then the money waits in the desk for it.
  private give(to: string, amount: bigint, txHash: string, collecting = false): void {
    if (amount === 0n) return;
    const who = to.toLowerCase();
    if (who === A.burnPot && this.potRefuses && !collecting) {
      this.owed.set(who, (this.owed.get(who) ?? 0n) + amount);
      this.owedTotal += amount;
      this.emit("desk", "Owed", { who, amount }, txHash);
      return;
    }
    if (who === A.burnPot) this.potEth += amount;
    // the gateway's wallet really holds what it is paid: it may have to send some of it back
    // and so does an account: it may spend what it was paid (an agent's account hires with its advance)
    if (who === this.gatewayAddr || this.made.has(who)) this.balances.set(who, (this.balances.get(who) ?? 0n) + amount);
    this.paid.set(who, (this.paid.get(who) ?? 0n) + amount);
  }

  private poolIn(from: string, amount: bigint, txHash?: string): void {
    this.pool += amount;
    this.totalPoolIn += amount;
    this.emit("desk", "PoolIn", { from, amount }, txHash);
  }

  /** ETH sent straight to the desk: it becomes pool. */
  fund(amount: bigint, from = "0x00000000000000000000000000000000000f00d5"): void {
    this.mine();
    this.poolIn(from, amount);
  }

  register(agent: string): void {
    this.mine();
    this.agents.set(agent.toLowerCase(), { registered: true, barred: false, firstSettledAt: 0, settled: 0, settledAtHalf: 0, notDelivered: 0, unanswered: 0, customers: 0, onTime: 0, late: 0, advancesRepaid: 0, advancesNotRepaid: 0, earlyKept: 0, bond: 0n, feesPaid: 0n, advancedNow: 0n, volume: 0n });
    this.emit("desk", "Registered", { agent });
  }

  bond(agent: string, amount: bigint): void {
    this.mine();
    const a = this.agentOf(agent);
    a.bond += amount;
    this.bonds += amount;
    this.emit("desk", "BondAdded", { agent, amount, bond: a.bond });
  }

  lock(customer: string, agent: string, price: bigint, dueInS = 86400, allowEarly = false): number {
    this.mine();
    this.agentOf(agent);
    const id = ++this.jobCount;
    this.jobs.set(id, { customer: customer.toLowerCase(), agent: agent.toLowerCase(), price, dueAt: this.time + dueInS, deliveredAt: 0, state: S.locked, allowEarly, late: false, early: 0n, fromPool: 0n, proof: `0x${"0".repeat(64)}` });
    this.deskHeld += price;
    this.emit("desk", "Locked", { id: BigInt(id), customer, agent, price, dueAt: BigInt(this.time + dueInS), allowEarly });
    return id;
  }

  draw(id: number, amount: bigint, kind: number): void {
    this.mine();
    const j = this.jobs.get(id)!;
    const a = this.agentOf(j.agent);
    if (j.early + j.fromPool + amount > j.price / 2n) throw new Reverted("OverHalf");
    if (kind === K.early) {
      if (!j.allowEarly) throw new Reverted("EarlyNotAllowed");
      j.early += amount;
      this.deskHeld -= amount;
    } else {
      if (a.barred || a.advancedNow + amount > a.bond + a.feesPaid) throw new Reverted("OverLimit");
      if ((this.out + amount) * 10000n > (this.pool + this.out) * 8000n) throw new Reverted("PoolShort");
      j.fromPool += amount;
      a.advancedNow += amount;
      this.pool -= amount;
      this.out += amount;
    }
    j.state = S.advanced;
    const fee = amount / 100n;
    this.totalAdvanced += amount;
    this.totalAdvanceFees += fee;
    const tx = this.emit("desk", "Advanced", { id: BigInt(id), agent: j.agent, kind, amount, fee }).transactionHash;
    this.give(A.burnPot, fee, tx);
    this.give(kind === K.compute ? this.gatewayAddr : j.agent, amount - fee, tx);
  }

  deliver(id: number, proof?: string): void {
    this.mine();
    const j = this.jobs.get(id)!;
    if (this.time > j.dueAt + GRACE) throw new Reverted("TooLate");
    j.state = S.delivered;
    j.deliveredAt = this.time;
    j.late = this.time > j.dueAt;
    j.proof = proof ?? `0x${id.toString(16).padStart(64, "a")}`;
    this.emit("desk", "Delivered", { id: BigInt(id), agent: j.agent, proof: j.proof, late: j.late });
  }

  /** The customer accepts. */
  accept(id: number): void {
    this.mine();
    this.settleJob(id);
  }

  private repay(a: FakeAgent, amount: bigint): void {
    if (amount === 0n) return;
    a.advancedNow -= amount;
    a.advancesRepaid++;
    this.out -= amount;
    this.pool += amount;
  }

  private settleJob(id: number, txHash?: string): void {
    const j = this.jobs.get(id)!;
    const a = this.agentOf(j.agent);
    j.state = S.settled;
    const fee = (j.price * 200n) / 10000n;
    const toAgent = j.price - j.early - j.fromPool - fee;
    this.deskHeld -= j.price - j.early;
    this.repay(a, j.fromPool);
    a.feesPaid += fee;
    this.pool += fee;
    this.totalJobFees += fee;
    a.settled++;
    a.volume += j.price;
    this.totalSettled += j.price;
    if (j.late) a.late++;
    else a.onTime++;
    if (!a.firstSettledAt) a.firstSettledAt = this.time;
    const key = `${j.agent}:${j.customer}`;
    const before = this.feesFrom.get(key) ?? 0n;
    this.feesFrom.set(key, before + fee);
    if (before < 10n ** 15n && before + fee >= 10n ** 15n) a.customers++;
    const tx = this.emit("desk", "Settled", { id: BigInt(id), agent: j.agent, toAgent, poolRepaid: j.fromPool, jobFee: fee }, txHash).transactionHash;
    this.give(j.agent, toAgent, tx);
  }

  /** The customer rejects: the job settles at half. */
  reject(id: number): void {
    this.mine();
    const j = this.jobs.get(id)!;
    const a = this.agentOf(j.agent);
    j.state = S.half;
    const toCustomer = j.price / 2n;
    const left = j.price - toCustomer - j.early - j.fromPool;
    let fee = ((j.price - toCustomer) * 200n) / 10000n;
    if (fee > left) fee = left;
    this.deskHeld -= j.price - j.early;
    this.repay(a, j.fromPool);
    a.feesPaid += fee;
    this.pool += fee;
    this.totalJobFees += fee;
    a.settledAtHalf++;
    const tx = this.emit("desk", "SettledAtHalf", { id: BigInt(id), agent: j.agent, toCustomer, toAgent: left - fee, poolRepaid: j.fromPool, jobFee: fee }).transactionHash;
    this.give(j.customer, toCustomer, tx);
    this.give(j.agent, left - fee, tx);
  }

  decline(id: number): void {
    this.mine();
    const j = this.jobs.get(id)!;
    j.state = S.declined;
    this.deskHeld -= j.price;
    const tx = this.emit("desk", "Declined", { id: BigInt(id), agent: j.agent, toCustomer: j.price }).transactionHash;
    this.give(j.customer, j.price, tx);
  }

  /** Anybody may refund a job whose time is up: here, somebody did. */
  refund(id: number): void {
    this.mine();
    this.refundJob(id);
  }

  private refundJob(id: number, txHash?: string): void {
    const j = this.jobs.get(id)!;
    const a = this.agentOf(j.agent);
    j.state = S.refunded;
    const toCustomer = j.price - j.early;
    this.deskHeld -= toCustomer;
    if (j.early + j.fromPool > 0n) a.notDelivered++;
    else a.unanswered++;
    const notRepaid = j.fromPool;
    let fromBond = 0n;
    let lost = 0n;
    if (notRepaid > 0n) {
      fromBond = a.bond < notRepaid ? a.bond : notRepaid;
      lost = notRepaid - fromBond;
      a.bond -= fromBond;
      this.bonds -= fromBond;
      a.advancedNow -= notRepaid;
      this.out -= notRepaid;
      this.pool += fromBond;
      this.totalLost += lost;
      a.advancesNotRepaid++;
      a.barred = true;
    }
    if (j.early > 0n) {
      a.earlyKept++;
      a.barred = true;
    }
    const tx = this.emit("desk", "Refunded", { id: BigInt(id), agent: j.agent, toCustomer, notRepaid, fromBond, lost }, txHash).transactionHash;
    this.give(j.customer, toCustomer, tx);
  }

  /** What the desk holds: its four parts. */
  get deskBalance(): bigint {
    return this.pool + this.deskHeld + this.bonds + this.owedTotal;
  }

  /** Where the made-up maker puts the account of a key: the same key, the same place. */
  static accountOf(key: { kind: number; a: string; b: string }): string {
    return `0x${keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }], [Number(key.kind), key.a as Hex, key.b as Hex])).slice(26)}`;
  }

  // One call of an order, made by the account: the desk's calls a customer or an agent makes, or ETH taken out.
  private asAccount(account: string, c: { to: string; value: bigint; data: Hex }, commit: boolean, txHash?: string): void {
    const to = c.to.toLowerCase();
    const has = this.balances.get(account) ?? 0n;
    if (c.value > has) throw Object.assign(new Error("insufficient funds for transfer"), { insufficient: true });
    if (to !== A.desk) {
      if (c.data !== "0x") throw new Reverted("CallFailed", [0n]);
      if (commit) {
        this.balances.set(account, has - c.value);
        this.balances.set(to, (this.balances.get(to) ?? 0n) + c.value);
      }
      return;
    }
    const d = decodeFunctionData({ abi: factorDeskAbi as Abi, data: c.data });
    const args = (d.args ?? []) as unknown[];
    if (d.functionName === "register") {
      if (this.agents.get(account)?.registered) throw new Reverted("AlreadyRegistered");
      if (commit) this.register(account);
    } else if (d.functionName === "lock") {
      const agent = String(args[0]).toLowerCase();
      if (!this.agents.get(agent)?.registered) throw new Reverted("NotRegistered");
      if (c.value < ETH / 1000n) throw new Reverted("TooSmall", [ETH / 1000n]);
      if (commit) {
        this.balances.set(account, has - c.value);
        this.lock(account, agent, c.value, Number(args[1] as bigint) - this.time, Boolean(args[2]));
      }
    } else if (d.functionName === "deliver") {
      const j = this.jobs.get(Number(args[0]));
      if (!j || j.agent !== account) throw new Reverted("NotAgent");
      if (j.state !== S.locked && j.state !== S.advanced) throw new Reverted("WrongState", [j.state]);
      if (this.time > j.dueAt + GRACE) throw new Reverted("TooLate");
      if (commit) this.deliver(Number(args[0]), String(args[1]));
    } else if (d.functionName === "decline") {
      const j = this.jobs.get(Number(args[0]));
      if (!j || j.agent !== account) throw new Reverted("NotAgent");
      if (j.state !== S.locked) throw new Reverted("WrongState", [j.state]);
      if (commit) this.decline(Number(args[0]));
    } else if (d.functionName === "accept") {
      const j = this.jobs.get(Number(args[0]));
      if (!j || j.customer !== account) throw new Reverted("NotCustomer");
      if (commit) this.accept(Number(args[0]));
    } else if (d.functionName === "draw") {
      const j = this.jobs.get(Number(args[0]));
      if (!j || j.agent !== account) throw new Reverted("NotAgent");
      if (j.state !== S.locked && j.state !== S.advanced) throw new Reverted("WrongState", [j.state]);
      if (Number(args[2]) === K.early && !j.allowEarly) throw new Reverted("EarlyNotAllowed");
      if (commit) this.draw(Number(args[0]), args[1] as bigint, Number(args[2]));
    } else throw new Error(`the fake chain's accounts do not do ${d.functionName}`);
    void txHash;
  }

  call(raw: RawCall): Promise<Hex> {
    return this.ask("call", raw.to, undefined, () => {
      const to = raw.to.toLowerCase();
      if (to === A.desk && raw.data.length >= 10) {
        const d = decodeFunctionData({ abi: factorDeskAbi as Abi, data: raw.data });
        if (["register", "lock", "deliver", "decline", "accept", "draw"].includes(d.functionName)) this.asAccount(raw.from.toLowerCase(), { to, value: raw.value ?? 0n, data: raw.data }, false);
        return "0x" as Hex;
      }
      if ((raw.value ?? 0n) > (this.balances.get(raw.from.toLowerCase()) ?? 0n)) throw new Error("insufficient funds for transfer");
      return "0x" as Hex;
    });
  }

  private answer(call: CallSpec): unknown {
    const to = call.to.toLowerCase();
    const a = call.args ?? [];
    const fn = call.functionName;
    if (to === A.accounts) {
      if (fn === "implementation") return A.original;
      if (fn === "addressOf") return FakeChain.accountOf(a[0] as { kind: number; a: string; b: string });
    }
    const made = this.made.get(to);
    if (made) {
      if (fn === "nonce") return BigInt(made.nonce);
      if (fn === "isValidSignature") return a[1] === GOOD_SIGNATURE ? "0x1626ba7e" : "0xffffffff";
    }
    if (to === A.splitter) {
      const s: Record<string, unknown> = {
        burnPot: this.wiring.splitterBurn, desk: this.wiring.splitterDesk, admin: A.admin, escrow: A.escrow, unsplit: this.unsplit,
        adminPending: this.waiting.admin, burnPending: this.waiting.burn, poolPending: this.waiting.pool, totalSplit: this.totalSplit, totalToAdmin: this.totalToAdmin, totalToPool: this.totalToPool,
        totalToBurn: this.totalSplit - this.totalToAdmin - this.totalToPool,
      };
      if (fn in s) return s[fn];
    }
    if (to === A.burnPot) {
      const s: Record<string, unknown> = {
        splitter: this.wiring.potSplitter, token: this.token ?? ZERO, factory: A.factory, startedAt: BigInt(this.token ? this.startedAt : 0), lastBurnAt: BigInt(this.lastBurnAt),
        burnCount: BigInt(this.burnCount), totalEthBurned: this.totalEthBurned, totalTokensBurned: this.totalTokensBurned,
        market: [this.marketOpen && !!this.token, this.phase === 0, this.depthCap], preview: this.preview(),
      };
      if (fn in s) return s[fn];
    }
    if (to === A.desk) {
      const d: Record<string, unknown> = {
        burnPot: this.wiring.deskBurn, gateway: this.gatewayAddr, pool: this.pool, out: this.out, held: this.deskHeld, bonds: this.bonds, owedTotal: this.owedTotal, jobCount: BigInt(this.jobCount),
        totalAdvanced: this.totalAdvanced, totalAdvanceFees: this.totalAdvanceFees, totalJobFees: this.totalJobFees, totalSettled: this.totalSettled, totalPoolIn: this.totalPoolIn, totalLost: this.totalLost,
      };
      if (fn in d) return d[fn];
      if (fn === "owed") return this.owed.get(String(a[0]).toLowerCase()) ?? 0n;
      // a number never given out reads as a job in state none, as on the real desk
      if (fn === "job") return this.jobs.get(Number(a[0])) ?? { customer: ZERO, agent: ZERO, price: 0n, dueAt: 0, deliveredAt: 0, state: S.none, allowEarly: false, late: false, early: 0n, fromPool: 0n, proof: `0x${"0".repeat(64)}` };
      if (fn === "agent") return this.agents.get(String(a[0]).toLowerCase()) ?? { registered: false };
    }
    // any other price feed: a price a test set for it, or one made from its address, updated a while before
    if (fn === "latestRoundData" && to !== ETH_USD_FEED && (this.feedPrices.has(to) || FEEDS.some((f) => f.address === to))) {
      if (this.feedsDown) throw new Error("fetch failed");
      const price = this.feedPrices.get(to) ?? BigInt(1 + FEEDS.findIndex((f) => f.address === to)) * 10n ** 9n;
      return [1n, price, BigInt(this.time - this.feedAgeS), BigInt(this.time - this.feedAgeS), 1n];
    }
    if (fn === "latestRoundData" && to === ETH_USD_FEED) {
      if (this.feedsDown) throw new Error("fetch failed");
      return [1n, this.ethUsd, BigInt(this.time), BigInt(this.time), 1n];
    }
    if (this.token && to === this.token) {
      if (fn === "totalSupply") return this.supply;
      if (fn === "balanceOf") return String(a[0]).toLowerCase() === A.burnPot ? this.potFactor : 0n;
    }
    if (to === A.factory && fn === "getLaunchedToken") return { phase: this.phase, exists: true };
    if (to === A.escrow && fn === "balanceOf") return this.escrow;
    if (to === A.escrow && fn === "balanceOfToken") return this.factorCredit;
    throw new Reverted("reverted");
  }

  // ---------- the Chain the engine sees ----------

  private async ask<T>(kind: string, what: string, args: readonly unknown[] | undefined, fn: () => T): Promise<T> {
    this.calls.push({ kind, what, args });
    if (this.busy) throw Object.assign(new Error("HTTP request failed.\n\nStatus: 403\nDetails: <title>Just a moment...</title>"), { status: 403 });
    if (this.down) throw new Error("fetch failed");
    return fn();
  }

  chainId(): Promise<number> {
    return this.ask("chainId", "", undefined, () => this.id);
  }

  head(): Promise<Head> {
    return this.ask("head", "", undefined, () => ({ number: this.number, timestamp: this.time, hash: this.hashOf(this.number) }));
  }

  block(number: bigint): Promise<{ hash: string; timestamp: number } | null> {
    return this.ask("block", String(number), undefined, () => (number > this.number ? null : { hash: this.hashOf(number), timestamp: this.stamps.get(number) ?? this.time }));
  }

  code(address: string): Promise<string> {
    return this.ask("code", address, undefined, () => (this.code_.has(address.toLowerCase()) ? "0x6080" : "0x"));
  }

  balance(address: string): Promise<bigint> {
    return this.ask("balance", address, undefined, () => {
      const a = address.toLowerCase();
      if (a === A.burnPot) return this.potEth;
      if (a === A.desk) return this.deskBalance;
      return this.balances.get(a) ?? 0n;
    });
  }

  logs(from: bigint, to: bigint, filter: LogFilter): Promise<ChainLog[]> {
    return this.ask("logs", `${from}-${to}`, undefined, () => {
      if (this.tooManyAbove > 0n && to - from + 1n > this.tooManyAbove) throw new Error("logs matched by query exceeds limit of 10000");
      const addresses = (Array.isArray(filter.address) ? filter.address : [filter.address]).map((x) => x.toLowerCase());
      return this.allLogs.filter((l) => {
        if (l.blockNumber < from || l.blockNumber > to || !addresses.includes(l.address)) return false;
        return (filter.topics ?? []).every((t, i) => t === null || (Array.isArray(t) ? t : [t]).some((x) => x.toLowerCase() === l.topics[i]?.toLowerCase()));
      });
    });
  }

  read<T>(call: CallSpec): Promise<T> {
    return this.ask("read", call.functionName, call.args, () => this.answer(call) as T);
  }

  simulate<T>(call: CallSpec, from: string): Promise<T> {
    return this.ask("simulate", call.functionName, call.args, () => this.run(call, from, false) as T);
  }

  estimateGas(call: CallSpec | null, from: string, pay?: Pay): Promise<bigint> {
    return this.ask("estimateGas", call?.functionName ?? (pay ? "pay" : "transfer"), call?.args, () => {
      if (!call) return pay ? 55_000n : 21_000n;
      this.run(call, from, false);
      return this.gasOf[call.functionName] ?? 100_000n;
    });
  }

  fees(): Promise<Fees> {
    return this.ask("fees", "", undefined, () => ({ maxFeePerGas: this.gasPrice, maxPriorityFeePerGas: 1n }));
  }

  nonces(_address: string): Promise<{ latest: number; pending: number }> {
    return this.ask("nonces", "", undefined, () => ({ latest: this.nonce, pending: this.nonce + this.held.length }));
  }

  receipt(hash: string): Promise<Receipt | null> {
    return this.ask("receipt", hash, undefined, () => this.receipts.get(hash) ?? null);
  }

  // ---------- transactions people send themselves (Pay with Factor reads them back) ----------

  txs = new Map<string, SentTx>();

  transaction(hash: string): Promise<SentTx | null> {
    return this.ask("transaction", hash, undefined, () => this.txs.get(hash) ?? null);
  }

  /** A lock sent from a wallet: the job, and the transaction it was in, with its receipt. */
  lockTx(customer: string, agent: string, price: bigint, dueInS = 86400, allowEarly = false): { id: number; hash: string } {
    const before = this.allLogs.length;
    const id = this.lock(customer, agent, price, dueInS, allowEarly);
    const logs = this.allLogs.slice(before);
    const hash = logs[logs.length - 1]!.transactionHash;
    this.receipts.set(hash, { ok: true, blockNumber: this.number, gasUsed: 120_000n, gasPrice: this.gasPrice, logs });
    this.txs.set(hash, { from: customer.toLowerCase(), to: A.desk, value: price, input: encodeFunctionData({ abi: factorDeskAbi as Abi, functionName: "lock", args: [agent, BigInt(this.time + dueInS), allowEarly] }) });
    return { id, hash };
  }

  /** Plain ETH from one address to another, in a transaction of its own. `ok: false`: the chain refused it. */
  transfer(from: string, to: string, value: bigint, ok = true, input: Hex = "0x"): string {
    this.mine();
    const hash = this.newHash();
    this.receipts.set(hash, { ok, blockNumber: this.number, gasUsed: 21_000n, gasPrice: this.gasPrice, logs: [] });
    this.txs.set(hash, { from: from.toLowerCase(), to: to.toLowerCase(), value, input });
    if (ok) this.balances.set(to.toLowerCase(), (this.balances.get(to.toLowerCase()) ?? 0n) + value);
    return hash;
  }

  health(): RpcHealth {
    return { nodes: [{ host: "fake", ok: this.calls.length, failed: 0, lastOkAt: null, lastErrorAt: null, lastError: null }], lastOkAt: null, lastErrorAt: null, lastError: null, failuresInARow: 0 };
  }

  // ---------- the bot's wallet ----------

  sent: { hash: string; tx: TxRequest }[] = [];

  signer(address = A.bot): Signer {
    return {
      address,
      send: async (tx, onSigned) => {
        const hash = this.newHash();
        onSigned(hash);
        this.calls.push({ kind: "send", what: tx.call?.functionName ?? (tx.pay ? "pay" : "transfer"), args: tx.call?.args });
        if (this.dropSends) throw new Error("fetch failed");
        if (this.rejectSends) throw Object.assign(new Error("insufficient funds for gas * price + value"), { code: -32000 });
        if (tx.nonce < this.nonce) throw new Error("nonce too low");
        // a transaction for a nonce that is already waiting takes the waiting one's place
        this.held = this.held.filter((h) => h.tx.nonce !== tx.nonce);
        this.sent.push({ hash, tx });
        if (this.hold) this.held.push({ hash, tx, from: address });
        else this.include(hash, tx, address);
        if (this.loseReply) throw new Error("The request took too long to respond.");
        return hash;
      },
    };
  }

  // Mine a transaction: a block, the call run for real, its receipt.
  private include(hash: string, tx: TxRequest, from: string): void {
    this.mine();
    const before = this.allLogs.length;
    let ok = true;
    try {
      if (tx.call) this.run(tx.call, from, true, hash);
      else if (tx.pay) {
        // ETH sent to the desk with no call is the pool
        if ((this.balances.get(from) ?? 0n) < tx.pay.value) throw new Error("not enough ETH");
        this.balances.set(from, (this.balances.get(from) ?? 0n) - tx.pay.value);
        // to the desk it is the pool; to anybody else, a plain payment
        const to = tx.pay.to.toLowerCase();
        if (to === A.desk) this.poolIn(from, tx.pay.value, hash);
        else this.balances.set(to, (this.balances.get(to) ?? 0n) + tx.pay.value);
      }
    } catch {
      ok = false;
    }
    this.nonce++;
    const gasUsed = tx.call ? (this.gasOf[tx.call.functionName] ?? 100_000n) : 21_000n;
    this.balances.set(from, (this.balances.get(from) ?? 0n) - gasUsed * this.gasPrice);
    this.receipts.set(hash, { ok, blockNumber: this.number, gasUsed, gasPrice: this.gasPrice, logs: this.allLogs.slice(before) });
  }

  // Whatever was held back is mined now.
  release(): void {
    const held = this.held;
    this.held = [];
    for (const h of held) this.include(h.hash, h.tx, h.from);
  }

  // What was really sent, by function name.
  sends(fn?: string): { hash: string; tx: TxRequest }[] {
    return fn ? this.sent.filter((s) => (s.tx.call?.functionName ?? (s.tx.pay ? "pay" : "transfer")) === fn) : this.sent;
  }
}
