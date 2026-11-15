/** Lowercase, trim, drop surrounding IPv6 brackets and a single trailing dot. */
function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * Whether a browser would attach Termix's `jwt` cookie to a request for
 * `targetHost` while the page is served from `pageHost`, or accept a
 * `Set-Cookie` from `targetHost` into the jar Termix's own API reads.
 *
 * The web client sets `jwt` host-only (no `Domain`), so the port is irrelevant
 * and the disclosure direction is exactly an equal host. The reverse direction
 *, the target answering `Set-Cookie: jwt=...; Domain=<parent>`, reaches
 * Termix whenever the two share a domain, so a parent/sub relationship counts
 * too. The suffix check is anchored on a dot boundary so `eviltermix.example`
 * is not treated as same-site with `termix.example`.
 *
 * A precise registrable-domain (eTLD+1) test would also catch sibling
 * subdomains under a shared parent, but needs a public-suffix list this app
 * does not bundle; the exact/parent/sub check closes the reported same-host
 * case only. This is defense in depth, not cookie isolation: embedded frames
 * must use credentialless plus an opaque sandbox origin, including redirects.
 */
export function sharesCookieSiteWithPage(
  targetHost: string,
  pageHost: string,
): boolean {
  const t = normalizeHost(targetHost);
  const p = normalizeHost(pageHost);
  if (!t || !p) return false;
  if (t === p) return true;
  return t.endsWith("." + p) || p.endsWith("." + t);
}
