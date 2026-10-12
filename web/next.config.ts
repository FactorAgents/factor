import type { NextConfig } from "next";

// The page only ever talks to this site: its figures come from /api here and its fonts are served from here. So the
// policy can be strict: nothing loads from anywhere else, and no other site may frame the page.
const csp = [
  "default-src 'self'",
  // Next's own bootstrapping is inline
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const security = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // A page the visitor opened in the last half minute is drawn again from what the browser already holds, so going
  // back and forth is immediate. Every live figure on a page reads itself again on its own timer either way.
  experimental: { staleTimes: { dynamic: 30, static: 180 } },
  async headers() {
    // dev needs eval for fast refresh; the policy is for the real site
    const policy = process.env.NODE_ENV === "production" ? [{ key: "Content-Security-Policy", value: csp }] : [];
    return [{ source: "/:path*", headers: [...security, ...policy] }];
  },
};

export default nextConfig;
