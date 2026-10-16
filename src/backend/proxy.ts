/**
 * Serves a tunnel endpoint to a browser through Termix itself, so the SSH
 * forward never has to listen anywhere but 127.0.0.1.
 *
 * A signed-in user mints a session for one endpoint. Its token is the only
 * credential for /p/<token>/..., because the endpoint's iframe is
 * credentialless and sends no Termix cookie. Every response is served with a
 * CSP sandbox, so the proxied app runs in an opaque origin even when the URL
 * is opened in its own tab, and can never read Termix's session.
 */

import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";

/** Matches the tunnel's own idle timeout. */
export const PROXY_IDLE_MS = 10 * 60 * 1000;
/** A token never outlives this, however busy. */
export const PROXY_MAX_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;

export interface ProxySession {
  userId: string;
  hostId: number;
  endpointId: string;
  scheme: "http" | "https";
  /** The endpoint's port on the host, for the Host header. */
  targetPort: number;
  /** Where the loopback forward listens on this server. */
  localPort: number;
  /** The path the browser reaches this session at, ending in "/". */
  publicPrefix: string;
  createdAt: number;
  lastUsed: number;
}

export function createProxySessions(now: () => number = Date.now) {
  const sessions = new Map<string, ProxySession>();

  function prune(): void {
    const time = now();
    for (const [token, session] of sessions) {
      if (
        time - session.lastUsed > PROXY_IDLE_MS ||
        time - session.createdAt > PROXY_MAX_MS
      ) {
        sessions.delete(token);
      }
    }
  }

  return {
    mint(
      session: Omit<ProxySession, "createdAt" | "lastUsed" | "publicPrefix">,
      mountPath: string,
    ): { token: string; session: ProxySession } {
      prune();
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.entries()].sort(
          (a, b) => a[1].lastUsed - b[1].lastUsed,
        )[0];
        if (oldest) sessions.delete(oldest[0]);
      }
      const token = randomBytes(32).toString("base64url");
      const time = now();
      const full: ProxySession = {
        ...session,
        publicPrefix: `${mountPath}/p/${token}/`,
        createdAt: time,
        lastUsed: time,
      };
      sessions.set(token, full);
      return { token, session: full };
    },
    /** The live session for a token, refreshing its idle timer. */
    use(token: string): ProxySession | null {
      prune();
      const session = sessions.get(token);
      if (!session) return null;
      session.lastUsed = now();
      return session;
    },
    clear(): void {
      sessions.clear();
    },
    get size(): number {
      return sessions.size;
    },
  };
}

export type ProxySessions = ReturnType<typeof createProxySessions>;

/**
 * The browser-side path of this plugin's mount, as the frontend reported it.
 * Only a plain absolute path ending in the plugin's own mount is accepted, so
 * a caller cannot point rewritten cookies or redirects somewhere else.
 */
export function normalizeMountPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.replace(/\/+$/, "");
  if (!/^(\/[A-Za-z0-9._~-]+)*\/plugin-api\/web-endpoint$/.test(value)) {
    return null;
  }
  return value;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Cookies Termix itself sets, which must never reach the proxied app. */
const TERMIX_COOKIE = /^(jwt|termix[^=]*)$/i;

function stripTermixCookies(cookie: string): string {
  return cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.split("=")[0]?.trim() ?? "";
      return part && !TERMIX_COOKIE.test(name);
    })
    .join("; ");
}

export function requestHeaders(
  incoming: IncomingHttpHeaders,
  session: ProxySession,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "host" || lower === "referer") continue;
    if (lower === "authorization") continue;
    if (lower.startsWith("x-forwarded-") || lower === "forwarded") continue;
    if (lower === "cookie") {
      const kept = stripTermixCookies(
        Array.isArray(value) ? value.join("; ") : value,
      );
      if (kept) out.cookie = kept;
      continue;
    }
    out[lower] = value;
  }
  const targetOrigin = `${session.scheme}://127.0.0.1:${session.targetPort}`;
  out.host = `127.0.0.1:${session.targetPort}`;
  // The app sees itself on its own origin, as it did before the proxy.
  if (out.origin) out.origin = targetOrigin;
  return out;
}

/**
 * A redirect the app sends, rewritten to stay inside the proxy: a path on the
 * app's own root, or an absolute URL on its own loopback origin.
 */
export function rewriteLocation(
  location: string,
  session: ProxySession,
): string {
  const prefix = session.publicPrefix;
  if (location.startsWith("/") && !location.startsWith("//")) {
    return prefix + location.slice(1);
  }
  try {
    const url = new URL(location);
    const local =
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      Number(url.port || (url.protocol === "https:" ? 443 : 80)) ===
        session.targetPort;
    if (local) return prefix + (url.pathname + url.search + url.hash).slice(1);
  } catch {
    // A relative location resolves against the proxied page already.
  }
  return location;
}

/** A cookie the app sets, kept to this session's path and host only. */
export function rewriteSetCookie(
  cookie: string,
  session: ProxySession,
): string {
  const parts = cookie.split(";").map((part) => part.trim());
  const [pair, ...attributes] = parts;
  let path = "/";
  const kept: string[] = [];
  for (const attribute of attributes) {
    const [rawName, ...rest] = attribute.split("=");
    const name = rawName.trim().toLowerCase();
    if (name === "domain") continue;
    if (name === "path") {
      path = rest.join("=").trim() || "/";
      continue;
    }
    kept.push(attribute);
  }
  const scoped =
    session.publicPrefix + (path.startsWith("/") ? path.slice(1) : path);
  return [pair, `Path=${scoped}`, ...kept].join("; ");
}

export function responseHeaders(
  incoming: IncomingHttpHeaders,
  session: ProxySession,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "location" && typeof value === "string") {
      out.location = rewriteLocation(value, session);
      continue;
    }
    if (lower === "set-cookie") {
      const cookies = Array.isArray(value) ? value : [value];
      out["set-cookie"] = cookies.map((c) => rewriteSetCookie(c, session));
      continue;
    }
    out[lower] = value;
  }
  // The app must never run on Termix's own origin, even opened in a tab of
  // its own. A second CSP header narrows whatever the app sends.
  const sandbox = "sandbox allow-scripts allow-forms allow-popups";
  const existing = out["content-security-policy"];
  out["content-security-policy"] = existing
    ? [...(Array.isArray(existing) ? existing : [existing]), sandbox]
    : sandbox;
  out["referrer-policy"] = "no-referrer";
  out["x-content-type-options"] = "nosniff";
  return out;
}

/** Streams one request to the forward and the answer back. */
export function forward(
  req: Request,
  res: Response,
  session: ProxySession,
  path: string,
): Promise<"ok" | "unreachable"> {
  return new Promise((resolve) => {
    const client = session.scheme === "https" ? https : http;
    const upstream = client.request(
      {
        host: "127.0.0.1",
        port: session.localPort,
        method: req.method,
        path,
        headers: requestHeaders(req.headers, session),
        // The hop to the app runs inside the SSH tunnel, and a self-signed
        // certificate is the norm for the UIs this serves.
        rejectUnauthorized: false,
      },
      (answer: IncomingMessage) => {
        res.status(answer.statusCode ?? 502);
        for (const [name, value] of Object.entries(
          responseHeaders(answer.headers, session),
        )) {
          res.setHeader(name, value);
        }
        answer.pipe(res);
        answer.on("end", () => resolve("ok"));
        answer.on("error", () => {
          res.end();
          resolve("ok");
        });
      },
    );
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      if (res.headersSent) {
        res.end();
        resolve("ok");
        return;
      }
      // An idle tunnel closes; reloading the tab opens a new one.
      res
        .status(502)
        .type("text/plain")
        .send("The web endpoint did not answer. Reload the tab to reconnect.");
      resolve(error.code === "ECONNREFUSED" ? "unreachable" : "ok");
    });
    req.pipe(upstream);
  });
}
