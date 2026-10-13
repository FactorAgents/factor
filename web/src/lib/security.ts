// Where a security report goes and what the most a report is paid is: the owner's to set on the host, and said on
// the Security page only once they are.
//   FACTOR_SECURITY_CONTACT   an email address, or an https link (a form, a profile to write to)
//   FACTOR_BOUNTY_MAX_ETH     the most paid for one report, like 2

export function securityContact(x: string | null): { text: string; href: string | null } | null {
  const raw = (process.env.FACTOR_SECURITY_CONTACT ?? "").trim();
  if (/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(raw)) return { text: raw, href: `mailto:${raw}` };
  if (/^https:\/\/[^\s<>"]+$/.test(raw)) return { text: raw.replace(/^https:\/\//, ""), href: raw };
  // with nothing set, the project's own account on X, when it has one
  return x ? { text: "By direct message on X", href: x } : null;
}

export function bounty(): string | null {
  const raw = (process.env.FACTOR_BOUNTY_MAX_ETH ?? "").trim();
  return /^\d{1,4}(\.\d{1,4})?$/.test(raw) && Number(raw) > 0 ? raw : null;
}
