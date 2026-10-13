// A copy of the database, once a day, beside it.
//
// Most of what the engine keeps it can read again from the chain. Some of it, it cannot: the names and briefs people
// signed, the work agents showed, what each agent has spent of its compute credit, and the record of what the gas
// wallet sent. A copy a day means a file that went wrong, or a bad release, costs a day of those at most and not
// all of them. The copy is made by SQLite itself while the engine runs (it is whole, never half written), and the
// last seven are kept.
//
// It sits on the same disk as the database: it is no answer to losing the disk, which the host's own snapshots of
// the volume are for.

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

const KEEP = 7;
const name = (at: number): string => `factor-${new Date(at).toISOString().slice(0, 10)}.db`;

/** Today's copy, unless there is one already. Returns the file it wrote, or null. Older ones past the last seven go. */
export async function backupOnce(db: Database.Database, dir: string, now = Date.now()): Promise<string | null> {
  const folder = join(dir, "backups");
  mkdirSync(folder, { recursive: true });
  const had = readdirSync(folder).filter((f) => /^factor-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  const file = name(now);
  if (had.includes(file)) return null;
  await db.backup(join(folder, file));
  for (const old of [...had, file].sort().slice(0, -KEEP)) rmSync(join(folder, old), { force: true });
  return join(folder, file);
}

/** A copy shortly after start and then every six hours of looking (one a day is written). Never throws. */
export function backups(db: Database.Database, dir: string, log: (line: string) => void): () => void {
  const run = () => backupOnce(db, dir).then((f) => { if (f) log(`[backup] today's copy of the database is written: ${f}`); }, (e: Error) => log(`[backup] the copy could not be written: ${e.message.split("\n")[0]}`));
  const first = setTimeout(run, 120_000);
  const every = setInterval(run, 6 * 3600_000);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
