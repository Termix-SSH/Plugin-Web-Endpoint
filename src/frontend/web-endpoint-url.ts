import type { WebEndpoint } from "../shared/web-endpoint-config";
import { sharesCookieSiteWithPage } from "../shared/cookie-site";

export { sharesCookieSiteWithPage };

function defaultPageHost(): string {
  return typeof window === "undefined" ? "127.0.0.1" : window.location.hostname;
}

/**
 * Why a web endpoint must not be opened from this client.
 *
 * `direct-shares-session-cookie`, a direct
 * endpoint's target host shares Termix's cookie site, so the browser attaches
 * the `jwt` to it (and accepts one back). A different port is not a different
 * cookie key. See `sharesCookieSiteWithPage`.
 */
export type WebEndpointRefusalReason = "direct-shares-session-cookie";

/**
 * Why a web endpoint must not be opened from this client, or null when it may.
 *
 * Covers both access modes. A tunnel is refused when its forward would either
 * be unreachable (loopback bind on a remote backend) or resolve to the page's
 * own host string (`shares-session-cookie-with-termix`). A DIRECT endpoint is
 * refused when its target host shares Termix's cookie site
 * (`direct-shares-session-cookie`), the same leak, reached without a tunnel:
 * cookies ignore the port, so a UI on the very host serving Termix receives
 * the session. `hostAddress` is the direct endpoint's target host and is
 * ignored for tunnels.
 *
 * The desktop is exempt: its session is Bearer-only with no `jwt` in the jar,
 * and its API base ("localhost") is already separated from where tunnels
 * resolve ("127.0.0.1").
 */
export function webEndpointRefusalReason(
  endpoint: Pick<WebEndpoint, "access" | "bindHost">,
  runningInElectron: boolean,
  hostAddress: string | undefined,
  pageHost: string = defaultPageHost(),
): WebEndpointRefusalReason | null {
  if (runningInElectron) return null;

  if (endpoint.access === "direct") {
    if (hostAddress && sharesCookieSiteWithPage(hostAddress, pageHost)) {
      return "direct-shares-session-cookie";
    }
    return null;
  }

  // A browser reaches a tunnel through the backend's own proxy, in a
  // credentialless, sandboxed frame, so neither the bind address nor the
  // page host matters any more.
  return null;
}
