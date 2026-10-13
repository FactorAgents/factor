// A passkey made of software, for the end-to-end runs: what a phone's or a laptop's passkey does when it signs, done
// here with Node's own P-256, so that the real account contract is given a real passkey's answer to check. It is not
// used by anything that runs for a user: a real passkey never leaves the device that made it.

import { createHash, generateKeyPairSync, randomBytes, sign as p256Sign } from "node:crypto";
import { concat, encodeAbiParameters, type Hex } from "viem";
import { keyId, KIND } from "../src/accounts.js";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const hex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;
const sha256 = (b: Uint8Array): Buffer => createHash("sha256").update(b).digest();

export interface SoftPasskey {
  x: Hex;
  y: Hex;
  credential: Hex; // the passkey's own id
  id: Hex; // the id the account knows the key by
  /** The account's signature for `challenge`: the key's id, then the passkey's answer. */
  sign(challenge: Hex, o?: { flags?: number; type?: string }): Hex;
  /** The bare pieces of the last answer, for asking the chain's own P-256 check about them. */
  last: { hash: Hex; r: Hex; s: Hex } | null;
}

export function softPasskey(rpId = "factor.fun"): SoftPasskey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = hex(Buffer.from(jwk.x!, "base64url")), y = hex(Buffer.from(jwk.y!, "base64url"));
  const me: SoftPasskey = {
    x, y, credential: hex(randomBytes(20)), id: keyId({ kind: KIND.passkey, a: x, b: y }), last: null,
    sign(challenge, o = {}) {
      // 0x1d: its owner was present and verified, and it is kept in a synced keychain
      const authenticatorData = Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([o.flags ?? 0x1d]), Buffer.alloc(4)]);
      const json = JSON.stringify({ type: o.type ?? "webauthn.get", challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"), origin: `https://${rpId}`, crossOrigin: false });
      const message = Buffer.concat([authenticatorData, sha256(Buffer.from(json))]);
      const sig = p256Sign("sha256", message, { key: privateKey, dsaEncoding: "ieee-p1363" });
      const r = BigInt(hex(sig.subarray(0, 32)));
      let s = BigInt(hex(sig.subarray(32)));
      if (s > N / 2n) s = N - s; // the low half, as a browser hands it over: the account refuses the other
      const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
      me.last = { hash: hex(sha256(message)), r: word(r), s: word(s) };
      return concat([
        me.id,
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "string" }],
          [word(r), word(s), BigInt(json.indexOf('"challenge"')), BigInt(json.indexOf('"type"')), hex(authenticatorData), json],
        ),
      ]);
    },
  };
  return me;
}
