// One answer from the engine, shared by everyone who asks for the same thing within SHARE_MS: a request that comes in
// meanwhile gets that answer, and one that comes while it is on its way waits for it rather than asking again. So the
// engine answers each public read about once every couple of seconds, however many people are looking.
//
// When the engine does not answer (it restarts with every deploy), the last good answer is given for up to STALE_MS,
// with its age in the x-factor-stale header, rather than an error. Every answer carries an ETag, and a caller that
// already has that answer gets a 304 with nothing in it.
import { createHash } from "node:crypto";

const SHARE_MS = Math.max(0, Number(process.env.FACTOR_STATE_SHARE_MS ?? 2_000) || 0);
const STALE_MS = 120_000;
// the reads differ by path and by page: a bound on how many are kept, so odd queries cannot grow it without end
const MOST = 500;

export interface Answer { status: number; body: string; etag: string; staleS: number | null }

const live = new Map<string, { at: number; read: Promise<Answer> }>();
const good = new Map<string, { at: number; body: string; etag: string }>();

const tagOf = (body: string): string => `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`;

/** The engine's answer to `key`, from `ask` at most once per SHARE_MS. `ask` throws when the engine cannot be reached. */
export function sharedRead(key: string, ask: () => Promise<{ status: number; body: string }>): Promise<Answer> {
  const now = Date.now();
  const hit = live.get(key);
  if (hit && now - hit.at < SHARE_MS) return hit.read;
  if (live.size >= MOST) live.clear();
  const read = (async (): Promise<Answer> => {
    try {
      const r = await ask();
      // a refusal (404, 400) is an answer too and is shared as it is; only a broken engine falls back
      if (r.status < 500) {
        const etag = tagOf(r.body);
        if (r.status === 200) {
          if (good.size >= MOST) good.clear();
          good.set(key, { at: Date.now(), body: r.body, etag });
        }
        return { status: r.status, body: r.body, etag, staleS: null };
      }
      throw new Error(`the engine answered ${r.status}`);
    } catch (e) {
      const last = good.get(key);
      if (last && Date.now() - last.at < STALE_MS) return { status: 200, body: last.body, etag: last.etag, staleS: Math.round((Date.now() - last.at) / 1000) };
      throw e;
    }
  })();
  live.set(key, { at: now, read });
  // a failed read is not kept: the next caller tries again
  read.catch(() => { if (live.get(key)?.read === read) live.delete(key); });
  return read;
}

/** The headers of a shared answer, and whether the caller already has it. */
export function answerHeaders(a: Answer, ifNoneMatch: string | null): { headers: Record<string, string>; notModified: boolean } {
  const headers: Record<string, string> = { "cache-control": "no-cache", etag: a.etag, "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" };
  if (a.staleS !== null) headers["x-factor-stale"] = String(a.staleS);
  const notModified = a.status === 200 && !!ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim() === a.etag);
  return { headers, notModified };
}
