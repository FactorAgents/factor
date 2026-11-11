// How the demo speaks in a terminal: who acts, what it did, and the transaction to look at.

import type { Sent } from "../lib/near.ts";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string): string => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const gilt = (s: string): string => c("38;2;205;178;127", s);
export const dim = (s: string): string => c("38;2;110;107;101", s);
export const ink = (s: string): string => c("38;2;236;231;222", s);

const WIDTH = 24;

export function step(who: string, what: string): void {
  if (who.length >= WIDTH) console.log(gilt(who)), console.log(`${" ".repeat(WIDTH)}${ink(what)}`);
  else console.log(`${gilt(who.padEnd(WIDTH))}${ink(what)}`);
}

export function say(what: string): void {
  console.log(`${" ".repeat(WIDTH)}${dim(what)}`);
}

export function link(s: Sent): void {
  console.log(`${" ".repeat(WIDTH)}${dim("tx " + s.hash)}`);
}

/** A short wait between steps, so a person watching can read each one. PAUSE_MS=0 runs straight through. */
export function pause(): Promise<void> {
  const ms = Number(process.env.PAUSE_MS ?? 1200);
  return new Promise((r) => setTimeout(r, ms));
}

export function receiptsTable(rows: { what: string; from: string; price: string; check: string; tx: string }[]): void {
  console.log("");
  console.log(gilt("receipts"));
  for (const r of rows) {
    console.log(`  ${ink(r.what.padEnd(26))}${r.from.padEnd(30)}${(r.price + " NEAR").padEnd(12)}${r.check}`);
    console.log(`  ${dim("tx " + r.tx)}`);
  }
  console.log("");
}
