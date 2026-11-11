// A small client for the NEAR Intents 1Click API (https://docs.near-intents.org). No key is needed; a JWT in
// ONECLICK_JWT is sent when present (without one, 1Click adds its unauthenticated fee to the quote).
// 1Click has no testnet: every call here goes to mainnet, and the scripts only make read-only ones (dry quotes,
// the token list, the status of an address).

export const ONECLICK = process.env.ONECLICK_URL || "https://1click.chaindefuser.com";

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type Status = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING" | "SUCCESS" | "INCOMPLETE_DEPOSIT" | "REFUNDED" | "FAILED";

export interface Token {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  contractAddress?: string | null;
}

export interface QuoteRequest {
  dry: boolean;
  swapType: SwapType;
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS";
  deadline: string;
  /** Passed to ft_transfer_call when the tokens are delivered on NEAR: here, the desk's lock message. */
  customRecipientMsg?: string;
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
}

export interface StatusResponse {
  correlationId: string;
  quoteResponse: QuoteResponse;
  status: Status;
  updatedAt: string;
  swapDetails?: {
    nearTxHashes?: string[];
    amountOut?: string;
    amountOutFormatted?: string;
    refundedAmount?: string;
    refundReason?: string;
    depositedAmount?: string;
    originChainTxHashes?: { hash: string; explorerUrl: string }[];
    destinationChainTxHashes?: { hash: string; explorerUrl: string }[];
  };
}

export class OneClickError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: any) {
    super(`1Click answered ${status}: ${body?.message ?? JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

type Fetch = typeof fetch;

export class OneClick {
  base: string;
  jwt?: string;
  fetchImpl: Fetch;

  constructor(opts: { base?: string; jwt?: string; fetchImpl?: Fetch } = {}) {
    this.base = opts.base ?? ONECLICK;
    this.jwt = opts.jwt ?? process.env.ONECLICK_JWT;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.jwt) headers.authorization = `Bearer ${this.jwt}`;
    const r = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text.slice(0, 200) };
    }
    if (!r.ok) throw new OneClickError(r.status, json);
    return json as T;
  }

  tokens(): Promise<Token[]> {
    return this.req("GET", "/v0/tokens");
  }

  quote(q: QuoteRequest): Promise<QuoteResponse> {
    return this.req("POST", "/v0/quote", q);
  }

  /** Null when 1Click does not know the address (404). */
  async status(depositAddress: string, depositMemo?: string): Promise<StatusResponse | null> {
    const qs = new URLSearchParams({ depositAddress });
    if (depositMemo) qs.set("depositMemo", depositMemo);
    try {
      return await this.req("GET", `/v0/status?${qs}`);
    } catch (e) {
      if (e instanceof OneClickError && e.status === 404) return null;
      throw e;
    }
  }

  /** Optional: tells 1Click a deposit was sent, so it is picked up sooner. */
  submitDeposit(depositAddress: string, txHash: string, nearSenderAccount?: string): Promise<unknown> {
    return this.req("POST", "/v0/deposit/submit", { depositAddress, txHash, ...(nearSenderAccount ? { nearSenderAccount } : {}) });
  }
}
