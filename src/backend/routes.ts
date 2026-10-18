import express, { type Request, type Response, type Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  parseWebUiConfig,
  type WebEndpoint,
} from "../shared/web-endpoint-config.js";
import {
  createProxySessions,
  forward,
  normalizeMountPath,
  type ProxySessions,
} from "./proxy.js";

/** Matches the spec's ten minutes. */
const WEB_ENDPOINT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** The tunnels plugin, as ctx.services.get("tunnels.access") returns it. */
interface TunnelsAccess {
  forward(
    sourceHostId: number,
    target: {
      targetHost: string;
      targetPort: number;
      bindHost?: string;
      bindPort?: number;
    },
    options?: { name?: string; idleTimeoutMs?: number },
  ): Promise<{ bindHost: string; bindPort: number }>;
}

/**
 * Reserved by the tunnels plugin for on-demand forwards: never retried, and
 * the host id in it is what the tunnels plugin checks before letting anyone
 * stop one by name.
 */
function webEndpointTunnelName(hostId: number, endpointId: string): string {
  return `web:${hostId}:${endpointId}`;
}

async function loadEndpoint(
  ctx: PluginContext,
  hostId: number,
  endpointId: string,
): Promise<
  { error: { status: number; message: string } } | { endpoint: WebEndpoint }
> {
  const host = await ctx.hosts.get(hostId);
  if (!host) {
    return {
      error: { status: 403, message: "Host not found or access denied" },
    };
  }

  // A bulk update that only flips enableWebUi off can leave stale endpoints
  // in webUiConfig. The UI reads as off in that state, so a listed endpoint
  // is not on its own a licence to open a tunnel.
  const enabled = await ctx.settings.getHost<boolean>(hostId, "enableWebUi");
  if (!enabled) {
    return {
      error: {
        status: 400,
        message: "Web endpoints are not enabled for this host",
      },
    };
  }

  // Re-normalized rather than trusted: the stored value predates any later
  // tightening of the rules, and this is the value a forward or a window is
  // built from.
  const rawConfig = await ctx.settings.getHost(hostId, "webUiConfig");
  const endpoint = parseWebUiConfig(rawConfig).endpoints.find(
    (candidate) => candidate.id === endpointId,
  );
  if (!endpoint) {
    return { error: { status: 400, message: "Web endpoint not found" } };
  }

  return { endpoint };
}

async function openTunnel(
  ctx: PluginContext,
  hostId: number,
  endpointId: string,
  endpoint: WebEndpoint,
): Promise<{ bindHost: string; bindPort: number }> {
  const userId = ctx.currentActor();
  let tunnels: TunnelsAccess | undefined;
  try {
    tunnels = ctx.services.get<TunnelsAccess>("tunnels.access", { userId });
  } catch {
    tunnels = undefined;
  }
  // A missing provider hands back an empty handle rather than throwing.
  if (typeof tunnels?.forward !== "function") {
    throw Object.assign(new Error("The tunnels plugin is not available"), {
      status: 503,
    });
  }

  // A non-loopback bind publishes the target's web UI to anyone who can
  // reach the port, with no Termix login in front of it. Browsers reach a
  // tunnel through the authenticated proxy instead, so another address is
  // only honored when an admin turned that on.
  const allowExposed =
    (await ctx.settings.get<boolean>("allowExposedBind")) === true;
  const bindHost =
    allowExposed && endpoint.bindHost ? endpoint.bindHost : "127.0.0.1";

  try {
    return await tunnels.forward(
      hostId,
      {
        targetHost: "127.0.0.1",
        targetPort: endpoint.port,
        bindHost,
        // A fixed port when the endpoint names one, since a container can
        // only publish ports it knows in advance. Otherwise the kernel picks.
        bindPort: endpoint.localPort ?? undefined,
      },
      {
        name: webEndpointTunnelName(hostId, endpointId),
        idleTimeoutMs: WEB_ENDPOINT_IDLE_TIMEOUT_MS,
      },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.log.error(
      `Failed to open web endpoint tunnel for host ${hostId}: ${reason}`,
      error instanceof Error ? error : undefined,
    );
    throw Object.assign(new Error(reason), { status: 502 });
  }
}

/** A bare IPv6 literal has to be bracketed to be a legal URL authority. */
function bracketIfIpv6(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function endpointUrl(
  hostAddress: string,
  endpoint: WebEndpoint,
  localPort?: number,
): string {
  const path = endpoint.path && endpoint.path.length > 0 ? endpoint.path : "/";
  if (endpoint.access === "tunnel") {
    // Electron's isolated window always dials the backend's own loopback,
    // exactly like the renderer's own currentTunnelHost(true) does.
    return `${endpoint.scheme}://127.0.0.1:${localPort}${path}`;
  }
  return `${endpoint.scheme}://${bracketIfIpv6(hostAddress)}:${endpoint.port}${path}`;
}

export function createWebEndpointRoutes(
  ctx: PluginContext,
  sessions: ProxySessions = createProxySessions(),
): Router {
  const router = express.Router();
  // The router takes raw bodies so the proxy can stream them; these routes
  // parse their own small JSON bodies.
  const json = express.json({ limit: "64kb" });

  /**
   * @openapi
   * /plugin-api/web-endpoint/open:
   *   post:
   *     summary: Open a tunnel to a host's web endpoint
   *     description: For endpoints reached through SSH. Returns the local port the tunnel listens on.
   *     tags: [Web Endpoint]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [hostId, endpointId]
   *             properties:
   *               hostId: { type: integer }
   *               endpointId: { type: string }
   *     responses:
   *       200: { description: The local port. }
   *       400: { description: Invalid request, or the endpoint does not use a tunnel. }
   *       401: { description: Not signed in. }
   *       404: { description: Host or endpoint not found. }
   */
  router.post("/open", json, async (req, res) => {
    const userId = ctx.currentActor();
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { hostId, endpointId } = req.body ?? {};
    if (
      !Number.isInteger(hostId) ||
      hostId < 1 ||
      typeof endpointId !== "string"
    ) {
      return res.status(400).json({ error: "Invalid web endpoint request" });
    }

    // Deliberately NOT gated to the desktop. The forward binds wherever this
    // backend runs, and the endpoint's own bindHost decides whether that is
    // reachable from the browser.
    const resolved = await loadEndpoint(ctx, hostId, endpointId);
    if ("error" in resolved) {
      return res
        .status(resolved.error.status)
        .json({ error: resolved.error.message });
    }
    if (resolved.endpoint.access !== "tunnel") {
      return res
        .status(400)
        .json({ error: "This endpoint does not use a tunnel" });
    }

    try {
      const handle = await openTunnel(
        ctx,
        hostId,
        endpointId,
        resolved.endpoint,
      );
      return res.status(200).json({ port: handle.bindPort });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      const message = error instanceof Error ? error.message : String(error);
      return res.status(status).json({ error: message });
    }
  });

  /**
   * Opens the endpoint in an isolated Electron window instead of a tab.
   * Every part of the target URL is resolved server-side (the host's own
   * declared address for a direct endpoint, or the tunnel port this route
   * just opened for a tunnel one) so ctx.desktop.openIsolatedWindow's
   * capability check and audit line cover the whole decision, not just the
   * final "open a window" step.
   */
  /**
   * @openapi
   * /plugin-api/web-endpoint/open-window:
   *   post:
   *     summary: Open a host's web endpoint in a desktop window
   *     tags: [Web Endpoint]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [hostId, endpointId]
   *             properties:
   *               hostId: { type: integer }
   *               endpointId: { type: string }
   *     responses:
   *       200: { description: The window opened. }
   *       400: { description: Invalid request. }
   *       401: { description: Not signed in. }
   *       404: { description: Host not found or access denied. }
   */
  router.post("/open-window", json, async (req, res) => {
    const userId = ctx.currentActor();
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { hostId, endpointId } = req.body ?? {};
    if (
      !Number.isInteger(hostId) ||
      hostId < 1 ||
      typeof endpointId !== "string"
    ) {
      return res.status(400).json({ error: "Invalid web endpoint request" });
    }

    const resolved = await loadEndpoint(ctx, hostId, endpointId);
    if ("error" in resolved) {
      return res
        .status(resolved.error.status)
        .json({ error: resolved.error.message });
    }
    const { endpoint } = resolved;

    try {
      let localPort: number | undefined;
      if (endpoint.access === "tunnel") {
        const handle = await openTunnel(ctx, hostId, endpointId, endpoint);
        localPort = handle.bindPort;
      }

      const host = await ctx.hosts.get(hostId);
      if (!host) {
        return res
          .status(403)
          .json({ error: "Host not found or access denied" });
      }

      const url = endpointUrl(host.ip, endpoint, localPort);
      const result = await ctx.desktop.openIsolatedWindow({
        url,
        title: endpoint.label,
        // Only the saved endpoint can allow a bad certificate, never the request.
        ignoreCert:
          endpoint.access === "direct" && endpoint.ignoreCert === true,
      });
      return res.status(200).json(result);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 502;
      const message = error instanceof Error ? error.message : String(error);
      return res.status(status).json({ error: message });
    }
  });

  /**
   * @openapi
   * /plugin-api/web-endpoint/proxy:
   *   post:
   *     summary: Open a tunnel endpoint for a browser
   *     description: Opens the tunnel on 127.0.0.1 and returns a path under /plugin-api/web-endpoint/p/ that serves it to this browser. The path carries a short lived token and is the only credential for it.
   *     tags: [Web Endpoint]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [hostId, endpointId, mountPath]
   *             properties:
   *               hostId: { type: integer }
   *               endpointId: { type: string }
   *               mountPath: { type: string, description: "Where the browser reaches /plugin-api/web-endpoint" }
   *     responses:
   *       200: { description: The proxy path. }
   *       400: { description: Invalid request, or the endpoint does not use a tunnel. }
   *       401: { description: Not signed in. }
   */
  router.post("/proxy", json, async (req, res) => {
    const userId = ctx.currentActor();
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const { hostId, endpointId, mountPath } = req.body ?? {};
    const mount = normalizeMountPath(mountPath);
    if (
      !Number.isInteger(hostId) ||
      hostId < 1 ||
      typeof endpointId !== "string" ||
      !mount
    ) {
      return res.status(400).json({ error: "Invalid web endpoint request" });
    }
    const resolved = await loadEndpoint(ctx, hostId, endpointId);
    if ("error" in resolved) {
      return res
        .status(resolved.error.status)
        .json({ error: resolved.error.message });
    }
    const { endpoint } = resolved;
    if (endpoint.access !== "tunnel") {
      return res
        .status(400)
        .json({ error: "This endpoint does not use a tunnel" });
    }
    try {
      const handle = await openTunnel(ctx, hostId, endpointId, endpoint);
      const { session } = sessions.mint(
        {
          userId,
          hostId,
          endpointId,
          scheme: endpoint.scheme,
          targetPort: endpoint.port,
          localPort: handle.bindPort,
        },
        mount,
      );
      const path =
        endpoint.path && endpoint.path.length > 1 ? endpoint.path : "/";
      return res
        .status(200)
        .json({ path: session.publicPrefix + path.slice(1) });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      const message = error instanceof Error ? error.message : String(error);
      return res.status(status).json({ error: message });
    }
  });

  // Public: the token in the path is the credential, see proxy.ts.
  router.use("/p/:token", async (req: Request, res: Response) => {
    const token = req.baseUrl.split("/").pop() ?? "";
    const session = sessions.use(token);
    if (!session) {
      res.status(404).type("text/plain").send("This link has expired.");
      return;
    }
    if (req.url === "/" && !req.originalUrl.split("?")[0].endsWith("/")) {
      res.redirect(301, session.publicPrefix);
      return;
    }
    await forward(req, res, session, req.url);
  });

  return router;
}
