// An account without a wallet, in the browser.
//
// The account is a small contract on the chain (contracts/src/FactorAccount.sol) that obeys one thing: a passkey,
// the key this device keeps behind a fingerprint, a face or a PIN. The passkey is made here, by the browser, and
// never leaves the device's own keychain: this page never sees it, and neither does Factor. What the page does:
//
//   - works out what the account is asked to do, and the one number that stands for exactly that (its EIP-712 hash);
//   - asks the passkey to sign that number, which is when the device asks for the fingerprint;
//   - hands the signature to the site, whose engine sends it to the chain and pays the gas.
//
// It is given to the rest of the site as a wallet is (the same few requests every wallet answers), so every form
// that works with a wallet works with an account, unchanged.
import { concat, encodeAbiParameters, encodeFunctionData, hashMessage, hashTypedData, keccak256, type Abi, type Hex } from "viem";
import { factorAccountAbi } from "./abi/FactorAccount";
import { CHAIN } from "./chain";
import { Refusal, wordsFor } from "./desk";
import type { Provider } from "./wallet";

/** What the browser remembers of an account: where it is and which passkey it obeys. Nothing here is secret. */
export interface Session { address: string; credential: Hex; x: Hex; y: Hex }

const KEY = "factor-account";
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const hex = (b: ArrayBuffer | Uint8Array): Hex => `0x${Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("")}`;
const bytes = (h: string): Uint8Array<ArrayBuffer> => { const out = new Uint8Array(new ArrayBuffer((h.length - 2) / 2)); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 + i * 2, 4 + i * 2), 16); return out; };
const random = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const sentence = (t: string): string => { const s = t.charAt(0).toUpperCase() + t.slice(1); return /[.!?]$/.test(s) ? s : `${s}.`; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Whether this browser can make and use a passkey at all. */
export const passkeysHere = (): boolean => typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;

export function remembered(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Session | null;
    return s && /^0x[0-9a-f]{40}$/.test(s.address) && /^0x[0-9a-f]{64}$/.test(s.x) && /^0x[0-9a-f]{64}$/.test(s.y) && /^0x([0-9a-f]{2})+$/.test(s.credential) ? s : null;
  } catch {
    return null;
  }
}
export function remember(s: Session | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // a browser that keeps nothing: the account is there for this visit, and found again by its passkey
  }
}

// ---- the site's account routes ----

interface Said { error?: string; refused?: { name: string; args: string[] } }
const refusalOf = (b: Said, status: number): Refusal => new Refusal((b.refused && wordsFor(b.refused.name, b.refused.args)) || sentence(b.error ?? `the site answered ${status}`));

async function ask<T>(path: string, body?: unknown): Promise<T> {
  for (let tries = 0; ; tries++) {
    let r: Response;
    try {
      r = await fetch(`/api/v1/${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      throw new Refusal("The site could not be reached. Try again in a moment.");
    }
    const b = (await r.json().catch(() => ({}))) as Said & T;
    if (r.ok) return b;
    // the account's last action is still on its way: a few seconds, not a refusal
    if (r.status === 409 && tries < 30) { await sleep(1000); continue; }
    throw refusalOf(b, r.status);
  }
}

interface Order { status: "queued" | "sent" | "done" | "failed"; hash: string | null; error: string | null; refused?: { name: string; args: string[] }; logs?: { address: string; topics: string[]; data: string }[] }
const orderOf = (id: string) => ask<Order>(`accounts/relay/${id}`);

async function settled(id: string, ms = 120_000): Promise<Order> {
  const until = Date.now() + ms;
  for (;;) {
    const o = await orderOf(id);
    if (o.status === "done") return o;
    if (o.status === "failed") throw refusalOf(o as Said, 400);
    if (Date.now() > until) throw new Refusal("It is taking longer than it should. Look again in a minute before trying it a second time.");
    await sleep(900);
  }
}

// ---- the passkey ----

const cancelled = (e: unknown): boolean => ["NotAllowedError", "AbortError"].includes((e as Error)?.name ?? "");

/** Make a passkey on this device and the account that obeys it. The device asks for a fingerprint, a face or a PIN. */
export async function createAccount(on: (step: "passkey" | "making") => void): Promise<Session> {
  if (!passkeysHere()) throw new Refusal("This browser has no passkeys. Use a wallet instead.");
  on("passkey");
  let made: PublicKeyCredential | null;
  try {
    made = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "Factor", id: window.location.hostname },
        // what the device's own list of passkeys shows this one as
        user: { id: random(16), name: `Factor account, ${new Date().toISOString().slice(0, 10)}`, displayName: "Factor account" },
        challenge: random(32),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        attestation: "none",
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw new Refusal(cancelled(e) ? "No passkey was made, and no account." : "This device could not make a passkey. Use a wallet instead.");
  }
  const answer = made?.response as AuthenticatorAttestationResponse | undefined;
  const key = answer?.getPublicKey?.();
  if (!made || !answer || !key || answer.getPublicKeyAlgorithm?.() !== -7) throw new Refusal("This device made a passkey of a kind Factor cannot use. Use a wallet instead.");
  // the public key as browsers hand it over ends in its two halves, 32 bytes each
  const spki = new Uint8Array(key);
  const session = { credential: hex(made.rawId), x: hex(spki.slice(-64, -32)), y: hex(spki.slice(-32)) };
  on("making");
  const account = await ask<{ address: string; relay: string | null }>("accounts", { kind: "passkey", ...session });
  if (account.relay) await settled(account.relay);
  const out = { address: account.address.toLowerCase(), ...session };
  remember(out);
  return out;
}

/** Find the account of a passkey this device (or its keychain) already has. The device lets its owner pick one. */
export async function signIn(): Promise<Session> {
  if (!passkeysHere()) throw new Refusal("This browser has no passkeys. Use a wallet instead.");
  let got: PublicKeyCredential | null;
  try {
    got = (await navigator.credentials.get({ publicKey: { challenge: random(32), rpId: window.location.hostname, userVerification: "required", timeout: 120_000 } })) as PublicKeyCredential | null;
  } catch (e) {
    throw new Refusal(cancelled(e) ? "No passkey was chosen." : "This device could not use a passkey.");
  }
  if (!got) throw new Refusal("No passkey was chosen.");
  const credential = hex(got.rawId);
  const found = await ask<{ address: string }>(`accounts/by-credential/${credential}`).catch(() => null);
  if (!found) throw new Refusal("No account is known for that passkey. Create an account instead.");
  const info = await ask<{ keys: { kind: string; x?: Hex; y?: Hex; credential?: Hex }[] }>(`accounts/${found.address}`);
  const mine = info.keys.find((k) => k.kind === "passkey" && k.credential === credential);
  if (!mine?.x || !mine.y) throw new Refusal("That passkey is no longer a key of its account.");
  const out = { address: found.address.toLowerCase(), credential, x: mine.x, y: mine.y };
  remember(out);
  return out;
}

/** r and s out of the signature as a passkey gives it (ASN.1 DER). */
function rs(sig: Uint8Array): [bigint, bigint] {
  let i = sig[1]! & 0x80 ? 2 + (sig[1]! & 0x7f) : 2;
  const next = (): bigint => {
    if (sig[i] !== 0x02) throw new Refusal("The passkey's answer could not be read.");
    const length = sig[i + 1]!;
    const part = sig.slice(i + 2, i + 2 + length);
    i += 2 + length;
    return BigInt(hex(part));
  };
  if (sig[0] !== 0x30) throw new Refusal("The passkey's answer could not be read.");
  return [next(), next()];
}

/** The account's signature over `challenge`: the key's id, then the passkey's answer, as the contract reads it. */
async function sign(session: Session, challenge: Hex): Promise<Hex> {
  let got: PublicKeyCredential | null;
  try {
    got = (await navigator.credentials.get({
      publicKey: { challenge: bytes(challenge), rpId: window.location.hostname, allowCredentials: [{ type: "public-key", id: bytes(session.credential) }], userVerification: "required", timeout: 120_000 },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw new Refusal(cancelled(e) ? "You cancelled it. Nothing was sent." : "This device could not use the account's passkey. It may live on another device.");
  }
  const a = got?.response as AuthenticatorAssertionResponse | undefined;
  if (!a) throw new Refusal("You cancelled it. Nothing was sent.");
  const json = new TextDecoder().decode(a.clientDataJSON);
  const typeIndex = json.indexOf('"type":"webauthn.get"'), challengeIndex = json.indexOf('"challenge":"');
  if (typeIndex < 0 || challengeIndex < 0) throw new Refusal("The passkey's answer could not be read.");
  const [r, high] = rs(new Uint8Array(a.signature));
  // the lower of the two forms a signature can take: the account refuses the other, so nobody can make a second
  // signature out of a first
  const s = high > N / 2n ? N - high : high;
  const id = keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }], [2, session.x, session.y]));
  return concat([
    id,
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "string" }],
      [word(r), word(s), BigInt(challengeIndex), BigInt(typeIndex), hex(a.authenticatorData), json],
    ),
  ]);
}

/** What a key signs for an order of its account: the same as the contract works out (FactorAccount.digest). */
export function orderHash(account: string, calls: { to: string; value: bigint; data: Hex }[], nonce: number, deadline: number): Hex {
  return hashTypedData({
    domain: { name: "Factor Account", version: "1", chainId: CHAIN.id, verifyingContract: account as Hex },
    types: {
      Execute: [{ name: "calls", type: "Call[]" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
      Call: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }],
    },
    primaryType: "Execute",
    message: { calls: calls.map((c) => ({ to: c.to as Hex, value: c.value, data: c.data })), nonce: BigInt(nonce), deadline: BigInt(deadline) },
  });
}

/**
 * The account, answering what a wallet answers. A read goes to the site (this page talks to nobody else); a send is
 * checked, signed by the passkey and handed to the site; a transaction's receipt is the order's, once it is mined.
 */
export function passkeyProvider(session: Session): Provider {
  const me = session.address;
  const refusedCall = async (to: string, data: string, from?: string, value?: string): Promise<string> => (await ask<{ result: string }>("accounts/call", { to, data, ...(from ? { from } : {}), ...(value ? { value } : {}) })).result;
  return {
    async request({ method, params = [] }) {
      const first = (params[0] ?? {}) as { from?: string; to?: string; data?: string; value?: string };
      switch (method) {
        case "eth_chainId": return CHAIN.hex;
        case "eth_accounts":
        case "eth_requestAccounts": return [me];
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain": return null;
        case "eth_getCode": return (await ask<{ result: string }>("accounts/call", { to: params[0], data: "0x", code: true })).result;
        case "eth_call": return refusedCall(String(first.to), first.data ?? "0x", first.from, first.value ? BigInt(first.value).toString() : undefined);
        case "eth_sendTransaction": {
          if ((first.from ?? "").toLowerCase() !== me) throw new Refusal("That is not this account.");
          const call = { to: String(first.to).toLowerCase(), value: first.value ? BigInt(first.value) : 0n, data: (first.data ?? "0x") as Hex };
          const wire = [{ to: call.to, value: call.value.toString(), data: call.data }];
          // would it go through? Asked before the device asks for a fingerprint
          const checked = await ask<{ nonce: number; deadline: number }>("accounts/check", { account: me, calls: wire });
          const signature = await sign(session, orderHash(me, [call], checked.nonce, checked.deadline));
          return (await ask<{ id: string }>("accounts/relay", { account: me, calls: wire, deadline: checked.deadline, signature })).id;
        }
        case "eth_getTransactionReceipt": {
          const o = await orderOf(String(params[0]));
          if (o.status === "done") return { status: "0x1", transactionHash: o.hash, logs: o.logs ?? [] };
          if (o.status === "failed") return { status: "0x0", transactionHash: o.hash ?? "", logs: [], reason: (o.refused && wordsFor(o.refused.name, o.refused.args)) || sentence(o.error ?? "it was not sent") };
          return null;
        }
        case "personal_sign": {
          if (String(params[1]).toLowerCase() !== me) throw new Refusal("That is not this account.");
          // the text is signed as a wallet signs it (EIP-191), so whoever checks it reads the same text
          return sign(session, hashMessage({ raw: params[0] as Hex }));
        }
        default: throw new Refusal(`An account without a wallet does not do ${method}.`);
      }
    },
  };
}

/** What the account holds and how many of its actions Factor has paid for today. */
export interface AccountView { address: string; deployed: boolean; balanceWei: string; ordersToday: number; ordersPerDay: number; keys: { kind: "wallet" | "passkey"; address?: string }[] }
export const accountView = (address: string): Promise<AccountView> => ask<AccountView>(`accounts/${address}`);

/** The account's call that adds a wallet as a second key. */
export const addWalletKeyData = (wallet: string): Hex =>
  encodeFunctionData({ abi: factorAccountAbi as Abi, functionName: "addKey", args: [{ kind: 1, a: `0x${"0".repeat(24)}${wallet.slice(2).toLowerCase()}`, b: `0x${"0".repeat(64)}` }, "0x"] });
