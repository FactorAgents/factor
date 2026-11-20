// The sample's balance sheets, in exactly the engine's shape (engine/src/sheets.ts), so the pages can be built, looked at
// and tested with no chain behind them. Nothing here is real. Shown only when FACTOR_SAMPLE=1 (see data.ts).
//
// orbit-ops holds locked pay on job 0414, its desk bond, its treasury (0.42, as the treasury sample), its guarantee and
// vouching bonds and the locked pay it bought, and owes the covers it sold and its vouches: solvent, sealed this hour.
import { sampleBits } from "./sample";
import type { AgentSheet, SealView, SheetLineView, SheetsState } from "./types";

const { A, TX, addressOf, at } = sampleBits;
const wei = (e: number) => String(BigInt(Math.round(e * 1e9)) * 10n ** 9n);
const CONTRACT = A(9300);
const KEEPER = A(9201);
const DESK = A(9001), TREASURY = A(9200), GUARANTEE = A(9101), VOUCH = A(9102), CLAIMS = A(9103);
const hex = (n: number) => `0x${n.toString(16).padStart(8, "0").repeat(8)}`;

const line = (key: string, label: string, e: number, contract: string, call: string, detail?: string): SheetLineView => ({ key, label, wei: wei(e), eth: e, source: { contract, call }, ...(detail ? { detail } : {}) });

const HOUR = Math.floor(Date.parse(at(20)) / 3_600_000);
const seal: SealView = { hour: HOUR, from: new Date(HOUR * 3_600_000).toISOString(), root: hex(0x5ea1ed01), sheets: 9, signature: `${hex(0xabcdef01)}${"1b"}`, signer: A(9202), tx: TX(2101), txUrl: `https://robinhoodchain.blockscout.com/tx/${TX(2101)}`, onChain: true, madeAt: at(20) };

export const sampleSheetsState = (): SheetsState => ({ enabled: true, contract: CONTRACT, keeper: KEEPER, latest: seal });

export function sampleSheet(address: string): AgentSheet | null {
  const orbit = addressOf("orbit-ops");
  if (address.toLowerCase() !== orbit.toLowerCase()) return null;
  const holds = [
    line("lockedPay", "Locked pay", 0.02, DESK, "job(id): price - early, for its jobs locked, advanced or delivered", "1 open job, before the desk's fee"),
    line("deskBond", "Desk bond", 0.006, DESK, `agent(${orbit}).bond`),
    line("treasury", "Treasury", 0.42, TREASURY, `balanceOf(${orbit})`),
    line("guaranteeBond", "Guarantee bond", 0.06, GUARANTEE, `bondOf(${orbit}).bond`),
    line("vouchBond", "Vouching bond", 0.08, VOUCH, `voucherOf(${orbit}).bond`),
    line("payBought", "Locked pay bought", 0.0188, CLAIMS, "claim(id).owing, for the claims it holds", "1 claim"),
  ];
  const owes = [
    line("coversSold", "Covers sold", 0.015, GUARANTEE, `bondOf(${orbit}).reserved`),
    line("vouchesGiven", "Vouches given", 0.02, VOUCH, `voucherOf(${orbit}).held`),
  ];
  const h = holds.reduce((n, l) => n + l.eth, 0), o = owes.reduce((n, l) => n + l.eth, 0);
  const text = `factor-sheet-v1|${orbit.toLowerCase()}|${HOUR}|holds:lockedPay=${wei(0.02)},deskBond=${wei(0.006)},treasury=${wei(0.42)},guaranteeBond=${wei(0.06)},vouchBond=${wei(0.08)},payBought=${wei(0.0188)},coinFees=0|owes:creditLine=0,coversSold=${wei(0.015)},vouchesGiven=${wei(0.02)},paySold=0`;
  return {
    sheet: { agent: orbit, name: "orbit-ops", parties: [orbit], holds, owes, holdsWei: wei(h), owesWei: wei(o), netWei: wei(h - o), holdsEth: +h.toFixed(6), owesEth: +o.toFixed(6), netEth: +(h - o).toFixed(6), solvent: true, at: at(5) },
    sealed: { hour: HOUR, text, leaf: hex(0x1eaf0001), proof: [hex(0x2001), hex(0x2002), hex(0x2003), hex(0x2004)], root: seal.root, signature: seal.signature, signer: seal.signer, tx: seal.tx, written: true },
    seal, contract: CONTRACT,
  };
}

export function withSheetsState<T extends { sheets?: SheetsState }>(s: T): T {
  return { ...s, sheets: sampleSheetsState() };
}
