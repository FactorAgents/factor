// A read-only check of HEY builder records against HEY Research Lab's real API (free, no key, nothing written anywhere):
// Factor's own project by name, by $TICKER, by its HEY page and by its token, a project that is not on HEY, and a contract
// HEY does not know. Every request carries x-hey-integration: factor/<version>, and each one is listed with its header.
// Six to eight requests in all, well under HEY's 120 a minute.
//
//   npm run hey-live
import { HEY_INTEGRATION, HeyClient, HeyRecords, readHey, recordText, type BuilderRecord, type HeyFetch } from "../src/hey.js";

const seen: { url: string; header: string | undefined; status: number }[] = [];
const watched: HeyFetch = async (url, init) => {
  const r = await fetch(url, { headers: init.headers, signal: init.signal });
  seen.push({ url, header: init.headers["x-hey-integration"], status: r.status });
  return r;
};
const records = new HeyRecords(new HeyClient(readHey({ HEY: "on" }), { fetch: watched }));
const fails: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails.push(what); };

const byName = await records.lookup("Factor");
check(byName.found, "Factor by name is on HEY");
if (byName.found) {
  const r = byName as BuilderRecord;
  check(r.project.slug === "factor" && r.project.contract === "0x47c5ea4d85c4c1a81f26124580a80b0b7a581cc0", `its slug and token: ${r.project.slug}, ${r.project.contract}`);
  check(r.from === "builder card", `read from HEY's builder card (${r.from})`);
  check(typeof r.facts.verified_builder === "boolean", `verified_builder is HEY's yes or no: ${r.facts.verified_builder}`);
  check(typeof r.facts.hey_status === "string" && typeof r.facts.hey_status_label === "string", `HEY's status: ${r.facts.hey_status} (${r.facts.hey_status_label})`);
  check(r.facts.meaningful_ships_30d === null || Number.isInteger(r.facts.meaningful_ships_30d), `meaningful ships in 30 days: ${r.facts.meaningful_ships_30d}`);
  check(r.sourceUrl === "https://heyresearch.xyz/project/factor", `the source: ${r.sourceUrl}`);
  check(typeof r.disclaimer === "string" && r.disclaimer.length > 20, "HEY's own disclaimer came with it");
  console.log(`\n${recordText(r)}\n`);
}
for (const q of ["$FACTOR", "https://heyresearch.xyz/project/factor", "0x47C5eA4d85c4c1A81F26124580A80B0b7A581CC0"]) {
  const r = await records.lookup(q);
  check(r.found && r.project.slug === "factor", `${q} is the same project`);
}
const none = await records.lookup("no project is called this zq");
check(!none.found && !none.away, `a name HEY does not have: ${none.found ? "found" : none.why}`);
const dead = await records.lookup("0x000000000000000000000000000000000000dead");
check(!dead.found && !dead.away, `a contract HEY does not know: ${dead.found ? "found" : dead.why}`);

console.log("\nEvery request made to HEY:");
for (const x of seen) console.log(`  ${x.status} ${x.url}  x-hey-integration: ${x.header}`);
check(seen.length > 0 && seen.every((x) => x.header === HEY_INTEGRATION), `all ${seen.length} carried x-hey-integration: ${HEY_INTEGRATION}`);
check(seen.length <= 12, `${seen.length} requests in all: answers kept and shared`);
console.log(fails.length ? `\n${fails.length} FAILED` : "\nall held");
process.exit(fails.length ? 1 : 0);
