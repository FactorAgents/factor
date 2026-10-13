// The file a security researcher looks for first (RFC 9116). Served only once there is an address to write to.
import type { NextRequest } from "next/server";
import { getState } from "@/lib/data";
import { securityContact } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const s = await getState();
  const contact = securityContact(s.links.x);
  if (!contact?.href) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const origin = `${req.nextUrl.protocol}//${req.headers.get("host") ?? req.nextUrl.host}`;
  // good for a year from the day it is read: the page it points to is where anything newer is said
  const expires = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
  const body = [`Contact: ${contact.href}`, `Policy: ${origin}/security`, `Expires: ${expires}T00:00:00.000Z`, "Preferred-Languages: en", ""].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
