import { describe, expect, it } from "vitest";
import {
  sharesCookieSiteWithPage,
  webEndpointRefusalReason,
} from "../../src/frontend/web-endpoint-url";
import type { WebEndpoint } from "../../src/shared/web-endpoint-config";

function endpoint(overrides: Partial<WebEndpoint> = {}): WebEndpoint {
  return {
    id: "e1",
    label: "Proxmox",
    scheme: "https",
    port: 8006,
    access: "direct",
    render: "external",
    ...overrides,
  };
}

describe("sharesCookieSiteWithPage", () => {
  it("is true for the exact same host, because cookies ignore the port", () => {
    expect(sharesCookieSiteWithPage("termix.example", "termix.example")).toBe(
      true,
    );
  });

  it("is true for a parent or sub domain, which a Domain-scoped cookie crosses", () => {
    expect(
      sharesCookieSiteWithPage("app.termix.example", "termix.example"),
    ).toBe(true);
    expect(
      sharesCookieSiteWithPage("termix.example", "app.termix.example"),
    ).toBe(true);
  });

  it("is false for a genuinely different host", () => {
    expect(sharesCookieSiteWithPage("192.168.1.10", "termix.example")).toBe(
      false,
    );
    expect(sharesCookieSiteWithPage("nas.local", "termix.example")).toBe(false);
  });

  it("is case- and whitespace-insensitive and ignores a trailing dot", () => {
    expect(
      sharesCookieSiteWithPage(" TERMIX.example. ", "termix.example"),
    ).toBe(true);
  });

  it("does not treat a shared suffix off a label boundary as same-site", () => {
    // "eviltermix.example" ends with "termix.example" as a string but not on a
    // dot boundary -- treating it as same-site would let an attacker pick such
    // a name to dodge the guard, so it must be false.
    expect(
      sharesCookieSiteWithPage("eviltermix.example", "termix.example"),
    ).toBe(false);
  });

  it("is false for blank input rather than guessing", () => {
    expect(sharesCookieSiteWithPage("", "termix.example")).toBe(false);
    expect(sharesCookieSiteWithPage("termix.example", "")).toBe(false);
  });
});

describe("webEndpointRefusalReason", () => {
  const tunnel = (bindHost?: string) =>
    endpoint({ access: "tunnel", bindHost }) as Pick<
      WebEndpoint,
      "access" | "bindHost"
    >;
  const direct = () =>
    endpoint({ access: "direct" }) as Pick<WebEndpoint, "access" | "bindHost">;

  it("refuses a direct endpoint on the same host that serves Termix", () => {
    // https://termix.example:8443 receives Termix's jwt: same host, and the
    // port is not part of the cookie key.
    expect(
      webEndpointRefusalReason(
        direct(),
        false,
        "termix.example",
        "termix.example",
      ),
    ).toBe("direct-shares-session-cookie");
  });

  it("refuses a direct endpoint on a parent or sub domain of the page host", () => {
    expect(
      webEndpointRefusalReason(
        direct(),
        false,
        "termix.example.com",
        "app.termix.example.com",
      ),
    ).toBe("direct-shares-session-cookie");
    expect(
      webEndpointRefusalReason(
        direct(),
        false,
        "app.termix.example.com",
        "termix.example.com",
      ),
    ).toBe("direct-shares-session-cookie");
  });

  it("allows a direct endpoint on a genuinely different host", () => {
    expect(
      webEndpointRefusalReason(
        direct(),
        false,
        "192.168.1.10",
        "termix.example",
      ),
    ).toBeNull();
    expect(
      webEndpointRefusalReason(direct(), false, "nas.local", "termix.example"),
    ).toBeNull();
  });

  it("allows a direct same-host endpoint on the desktop, whose jar has no jwt", () => {
    expect(
      webEndpointRefusalReason(
        direct(),
        true,
        "termix.example",
        "termix.example",
      ),
    ).toBeNull();
  });

  it("never refuses a tunnel, which a browser reaches through the proxy", () => {
    for (const pageHost of [
      "localhost",
      "termix.example.com",
      "192.168.1.50",
    ]) {
      expect(
        webEndpointRefusalReason(tunnel(), false, undefined, pageHost),
      ).toBeNull();
      expect(
        webEndpointRefusalReason(tunnel("0.0.0.0"), false, undefined, pageHost),
      ).toBeNull();
    }
  });

  it("passes anything on the desktop", () => {
    expect(
      webEndpointRefusalReason(tunnel(), true, undefined, "localhost"),
    ).toBeNull();
    expect(
      webEndpointRefusalReason(tunnel("0.0.0.0"), true, undefined, "localhost"),
    ).toBeNull();
  });
});
