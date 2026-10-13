// Who is asking, for the engine's limits on how much one place may ask. A visitor can write anything into the front
// of X-Forwarded-For, so that is never taken: the host's own word is (X-Real-IP, which the host sets itself), and
// without one the last address in the chain, which the nearest proxy wrote.
import type { NextRequest } from "next/server";

export function callerOf(req: NextRequest): string {
  const ip = /^[0-9a-fA-F:.]{3,45}$/;
  const real = req.headers.get("x-real-ip")?.trim() ?? "";
  if (ip.test(real)) return real;
  const last = req.headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean).at(-1) ?? "";
  return ip.test(last) ? last : "";
}
