// Addresses, one way. Every address the engine stores, compares or shows
// goes through here: lowercase on store and on compare (an
// EVM address is the same wallet in any case, and a checksummed one from the
// wallet must find the row a lowercase one made), and nothing that is not
// twenty bytes of hex is an address at all.

const ADDRESS = /^0x[0-9a-f]{40}$/;

// The address as it is stored and compared, or null when it is not one.
export function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const a = raw.trim().toLowerCase();
  return ADDRESS.test(a) ? a : null;
}

// Already in stored form (lowercase, twenty bytes).
export function isAddress(a: unknown): a is string {
  return typeof a === "string" && ADDRESS.test(a);
}

export function sameAddress(a: unknown, b: unknown): boolean {
  const x = normalizeAddress(a);
  return x !== null && x === normalizeAddress(b);
}

// A short form for a log line: 0x1234...abcd.
export function shortAddress(raw: unknown): string {
  const a = normalizeAddress(raw);
  return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "";
}
