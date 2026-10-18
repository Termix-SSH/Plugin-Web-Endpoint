import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockCtx,
  type MockPluginContext,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { createWebEndpointRoutes } from "../../src/backend/routes.js";

const manifest = manifestJson as unknown as PluginManifest;

const forward = vi.fn();
const openIsolatedWindow = vi.fn();

function endpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: "e1",
    label: "Proxmox",
    scheme: "http",
    port: 8006,
    path: "/",
    access: "tunnel",
    render: "embedded",
    ...overrides,
  };
}

function host(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    userId: "u1",
    name: "nas",
    ip: "10.0.0.5",
    port: 22,
    username: "root",
    tags: null,
    folder: null,
    authType: "password",
    ...overrides,
  };
}

let mock: MockPluginContext;
let server: http.Server;
let baseUrl: string;

async function start(
  options: {
    hostOverrides?: Record<string, unknown>;
    noHost?: boolean;
    enableWebUi?: boolean;
    endpoints?: unknown[];
    capabilities?: string[];
    tunnelsAvailable?: boolean;
  } = {},
) {
  mock = createMockCtx({
    manifest,
    pluginId: "web-endpoint",
    actor: "u1",
    capabilities: options.capabilities ?? [
      "hosts:read",
      "network:serve",
      "ui:surface",
      "desktop:window",
    ],
    hosts: options.noHost ? [] : [host(options.hostOverrides)],
  });
  const hostId = (options.hostOverrides?.id as number) ?? 7;
  if (options.enableWebUi !== false) {
    await mock.ctx.settings.setHost(hostId, "enableWebUi", true);
    await mock.ctx.settings.setHost(hostId, "webUiConfig", {
      endpoints: options.endpoints ?? [endpoint()],
    });
  }
  if (options.tunnelsAvailable !== false) {
    mock.ctx.services.provide("tunnels.access", { forward });
  }

  const app = express();
  app.use(express.json());
  app.use(createWebEndpointRoutes(mock.ctx));

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
}

beforeEach(() => {
  forward.mockReset();
  forward.mockResolvedValue({ bindHost: "127.0.0.1", bindPort: 41234 });
  openIsolatedWindow.mockReset();
  openIsolatedWindow.mockResolvedValue({ success: true });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("POST /open", () => {
  it("refuses a host the user cannot resolve, without opening anything", async () => {
    await start({ noHost: true });
    const res = await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1" }),
    });
    expect(res.status).toBe(403);
    expect(forward).not.toHaveBeenCalled();
  });

  it("refuses when the feature is disabled even though the config still lists the endpoint", async () => {
    await start({ enableWebUi: false });
    await mock.ctx.settings.setHost(7, "webUiConfig", {
      endpoints: [endpoint()],
    });
    const res = await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1" }),
    });
    expect(res.status).toBe(400);
    expect(forward).not.toHaveBeenCalled();
  });

  it("refuses an endpoint id that matches nothing", async () => {
    await start();
    const res = await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns the port the tunnels service bound", async () => {
    await start();
    const res = await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).port).toBe(41234);
  });

  it("asks for a loopback forward under the reserved web name", async () => {
    await start();
    await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1" }),
    });
    expect(forward).toHaveBeenCalledWith(
      7,
      {
        targetHost: "127.0.0.1",
        targetPort: 8006,
        bindHost: "127.0.0.1",
        bindPort: undefined,
      },
      { name: "web:7:e1", idleTimeoutMs: 10 * 60 * 1000 },
    );
  });

  it("binds loopback even when the endpoint asks for another address", async () => {
    await start({
      endpoints: [endpoint({ bindHost: "0.0.0.0", localPort: 38080 })],
    });
    await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1" }),
    });
    const target = forward.mock.calls[0][1];
    expect(target.bindHost).toBe("127.0.0.1");
    expect(target.bindPort).toBe(38080);
  });

  it("passes another bind address through only when an admin allows it", async () => {
    await start({
      endpoints: [endpoint({ bindHost: "0.0.0.0", localPort: 38080 })],
    });
    await mock.ctx.settings.set("allowExposedBind", true);
    await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1" }),
    });
    expect(forward.mock.calls[0][1].bindHost).toBe("0.0.0.0");
  });

  it("reports the service's reason as a 502 instead of a dead 200", async () => {
    await start();
    forward.mockRejectedValue(
      new Error("Channel open failure: connect failed"),
    );
    const res = await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1" }),
    });
    expect(res.status).toBe(502);
    expect(String((await res.json()).error)).toMatch(/connect failed/);
  });

  it("answers 503 while the tunnels plugin is not available", async () => {
    await start({ tunnelsAvailable: false });
    const res = await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1" }),
    });
    expect(res.status).toBe(503);
  });

  it("rejects a malformed request before touching settings", async () => {
    await start();
    const getHostSpy = vi.spyOn(mock.ctx.settings, "getHost");
    for (const body of [
      {},
      { hostId: "7", endpointId: "e1" },
      { hostId: 0, endpointId: "e1" },
    ]) {
      const res = await fetch(`${baseUrl}/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(getHostSpy).not.toHaveBeenCalled();
  });

  it("refuses a direct-access endpoint", async () => {
    await start({ endpoints: [endpoint({ access: "direct" })] });
    const res = await fetch(`${baseUrl}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /open-window", () => {
  it("refuses without desktop:window", async () => {
    await start({
      capabilities: ["hosts:read", "network:serve", "ui:surface"],
    });
    const res = await fetch(`${baseUrl}/open-window`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1" }),
    });
    expect(res.status).toBe(502);
  });

  it("opens a tunnel first, then the window at the resolved port", async () => {
    await start();
    const res = await fetch(`${baseUrl}/open-window`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1" }),
    });
    expect(res.status).toBe(200);
    expect(forward).toHaveBeenCalledOnce();
    expect(mock.desktopWindows).toEqual([
      { url: "http://127.0.0.1:41234/", title: "Proxmox", ignoreCert: false },
    ]);
  });

  it("opens a direct endpoint at the host's own address without a tunnel", async () => {
    await start({
      endpoints: [
        endpoint({
          access: "direct",
          scheme: "https",
          port: 443,
          ignoreCert: true,
        }),
      ],
    });
    const res = await fetch(`${baseUrl}/open-window`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1", ignoreCert: true }),
    });
    expect(res.status).toBe(200);
    expect(forward).not.toHaveBeenCalled();
    expect(mock.desktopWindows).toEqual([
      { url: "https://10.0.0.5:443/", title: "Proxmox", ignoreCert: true },
    ]);
  });

  it("does not let the request allow a bad certificate the endpoint does not", async () => {
    await start({
      endpoints: [endpoint({ access: "direct", scheme: "https", port: 443 })],
    });
    await fetch(`${baseUrl}/open-window`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1", ignoreCert: true }),
    });
    expect(mock.desktopWindows[0].ignoreCert).toBe(false);
  });

  it("ignores ignoreCert for a tunnel endpoint, whose host component is already loopback", async () => {
    await start();
    await fetch(`${baseUrl}/open-window`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1", ignoreCert: true }),
    });
    expect(mock.desktopWindows[0].ignoreCert).toBe(false);
  });
});

describe("route registration", () => {
  it("registers /open and /open-window", async () => {
    await start();
    const routes = createWebEndpointRoutes(mock.ctx);
    const paths = (
      routes as unknown as {
        stack: Array<{ route?: { path: string; methods: { post?: boolean } } }>;
      }
    ).stack
      .filter((layer) => layer.route?.methods.post)
      .map((layer) => layer.route?.path);
    expect(paths).toEqual(expect.arrayContaining(["/open", "/open-window"]));
  });
});

describe("browser proxy", () => {
  let upstream: http.Server;
  let seen: http.IncomingMessage | null = null;

  async function startUpstream(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ) {
    upstream = http.createServer((req, res) => {
      seen = req;
      handler(req, res);
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    const { port } = upstream.address() as AddressInfo;
    forward.mockResolvedValue({ bindHost: "127.0.0.1", bindPort: port });
  }

  afterEach(async () => {
    seen = null;
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  async function mint(mountPath = "/plugin-api/web-endpoint") {
    const res = await fetch(`${baseUrl}/proxy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: 7, endpointId: "e1", mountPath }),
    });
    return { status: res.status, body: await res.json() };
  }

  /** The proxy path, as the test server mounts it at the root. */
  const local = (path: string) =>
    path.replace(/^\/plugin-api\/web-endpoint/, "");

  it("serves the endpoint behind a token, sandboxed and without Termix cookies", async () => {
    await startUpstream((_req, res) => {
      res.setHeader("set-cookie", "sid=1; Path=/; Domain=evil.example");
      res.setHeader("location", "/login");
      res.end("hello");
    });
    await start();
    const { body } = await mint();
    expect(body.path).toMatch(/^\/plugin-api\/web-endpoint\/p\/[\w-]{43}\/$/);
    expect(forward.mock.calls[0][1].bindHost).toBe("127.0.0.1");

    const res = await fetch(`${baseUrl}${local(body.path)}app?x=1`, {
      headers: { cookie: "jwt=secret; sid=1", authorization: "Bearer secret" },
      redirect: "manual",
    });
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(res.headers.get("set-cookie")).toBe(`sid=1; Path=${body.path}`);
    expect(res.headers.get("location")).toBe(`${body.path}login`);
    expect(seen?.url).toBe("/app?x=1");
    expect(seen?.headers.cookie).toBe("sid=1");
    expect(seen?.headers.authorization).toBeUndefined();
  });

  it("streams a request body through", async () => {
    let received = "";
    await startUpstream((req, res) => {
      req.on("data", (chunk) => (received += chunk));
      req.on("end", () => res.end("ok"));
    });
    await start();
    const { body } = await mint();
    await fetch(`${baseUrl}${local(body.path)}form`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "a=1",
    });
    expect(received).toBe("a=1");
  });

  it("refuses an unknown token", async () => {
    await startUpstream((_req, res) => res.end("hello"));
    await start();
    const res = await fetch(`${baseUrl}/p/${"x".repeat(43)}/`);
    expect(res.status).toBe(404);
    expect(seen).toBeNull();
  });

  it("refuses a mount path outside the plugin", async () => {
    await startUpstream((_req, res) => res.end("hello"));
    await start();
    expect((await mint("/evil")).status).toBe(400);
    expect(
      (await mint("https://evil.example/plugin-api/web-endpoint")).status,
    ).toBe(400);
  });
});
