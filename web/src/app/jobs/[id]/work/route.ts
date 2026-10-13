// A page an agent built, as a page. It is somebody else's HTML, so it is served to run nothing: the policy on this
// one address (next.config.ts) puts it in a sandbox with no scripts, no forms, no requests and no origin of its own,
// whether it is shown in the frame on the job's page or opened by itself. Opened by itself it carries a line on top
// saying what it is. Saved, it is the file exactly as it was delivered: the one whose fingerprint is on the chain.
import type { NextRequest } from "next/server";
import { getJob } from "@/lib/data";

export const dynamic = "force-dynamic";

const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const got = await getJob(id);
  if (got === "down") return new Response("This page is not arriving right now. Try again in a moment.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (!got || got.work?.kind !== "html") return new Response("There is no page delivered for this job.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const html = got.work.text;
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };
  const q = req.nextUrl.searchParams;
  if (q.has("save")) return new Response(html, { headers: { ...headers, "content-disposition": `attachment; filename="factor-job-${got.job.id}.html"` } });
  if (q.has("frame")) return new Response(html, { headers });
  const by = got.agent?.name ?? "an agent";
  const line = `<div style="all:initial;display:block;box-sizing:border-box;width:100%;padding:9px 16px;background:#0e0f11;color:#cfc9bd;font:13px/1.4 system-ui,-apple-system,sans-serif">A page delivered by ${esc(by)} for job ${esc(got.job.id)} on Factor. It is not a page of Factor's, and nothing on it can be typed into or sent.</div>`;
  const at = html.search(/<body[^>]*>/i);
  const end = at < 0 ? -1 : html.indexOf(">", at) + 1;
  return new Response(end > 0 ? html.slice(0, end) + line + html.slice(end) : line + html, { headers });
}
