import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebEndpoint } from "../../src/shared/web-endpoint-config";

const isElectron = vi.hoisted(() => vi.fn(() => false));
vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isElectron,
}));

const pluginPost = vi.hoisted(() => vi.fn());

function endpoint(overrides: Partial<WebEndpoint> = {}): WebEndpoint {
  return {
    id: "e1",
    label: "Proxmox",
    scheme: "https",
    port: 8006,
    path: "/",
    access: "tunnel",
    render: "external",
    bindHost: "0.0.0.0",
    ...overrides,
  };
}

const host = { id: "7", ip: "192.168.1.10" };

beforeEach(async () => {
  const { setWebEndpointApi } =
    await import("../../src/frontend/web-endpoint-api");
  setWebEndpointApi({ post: pluginPost } as never);
  isElectron.mockReturnValue(false);
  pluginPost.mockReset();
  pluginPost.mockResolvedValue({ data: { port: 41234 } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requireNumericHostId", () => {
  it("accepts a saved host id and rejects a quick-connect one", async () => {
    const { requireNumericHostId } =
      await import("../../src/frontend/web-endpoint-api");
    expect(requireNumericHostId("7")).toBe(7);
    for (const bad of ["quick-connect-1", "", "0", "-3", "abc"]) {
      expect(() => requireNumericHostId(bad)).toThrow(
        /errors\.savedHostRequired/,
      );
    }
  });
});

/**
 * The backend now resolves and validates the target URL itself (host address,
 * tunnel port, loopback/session-cookie checks) before ever calling
 * ctx.desktop.openIsolatedWindow, so this call is a thin ask-and-report over
 * the plugin's own /open-window route rather than a client-side URL builder.
 */
describe("openWebEndpointExternally", () => {
  it("refuses outside the desktop app before calling the backend", async () => {
    const { openWebEndpointExternally } =
      await import("../../src/frontend/web-endpoint-api");
    await expect(openWebEndpointExternally(host, endpoint())).rejects.toThrow(
      /errors\.desktopOnly/,
    );
    expect(pluginPost).not.toHaveBeenCalled();
  });

  it("posts hostId, endpointId and ignoreCert to /open-window", async () => {
    isElectron.mockReturnValue(true);
    pluginPost.mockResolvedValue({ data: { success: true } });
    const { openWebEndpointExternally } =
      await import("../../src/frontend/web-endpoint-api");
    await openWebEndpointExternally(host, endpoint({ ignoreCert: true }));
    expect(pluginPost).toHaveBeenCalledWith("/open-window", {
      hostId: 7,
      endpointId: "e1",
      ignoreCert: true,
    });
  });

  it("preserves the backend's reason instead of the generic message", async () => {
    isElectron.mockReturnValue(true);
    const axiosError = Object.assign(new Error("Request failed"), {
      isAxiosError: true,
      response: { status: 502, data: { error: "No window to attach to" } },
    });
    pluginPost.mockRejectedValue(axiosError);
    const { openWebEndpointExternally, WebEndpointTunnelError } =
      await import("../../src/frontend/web-endpoint-api");
    await expect(
      openWebEndpointExternally(host, endpoint()),
    ).rejects.toBeInstanceOf(WebEndpointTunnelError);
  });
});

describe("openWebEndpointView", () => {
  it("posts the host and endpoint to /view and returns the grant", async () => {
    pluginPost.mockResolvedValue({
      data: { grant: "a".repeat(48), url: "https://10.0.0.5:8006/" },
    });
    const { openWebEndpointView } =
      await import("../../src/frontend/web-endpoint-api");
    await expect(openWebEndpointView(7, "e1")).resolves.toEqual({
      grant: "a".repeat(48),
      url: "https://10.0.0.5:8006/",
    });
    expect(pluginPost).toHaveBeenCalledWith("/view", {
      hostId: 7,
      endpointId: "e1",
    });
  });

  it("explains a refusal for Termix's own site in plain words", async () => {
    pluginPost.mockRejectedValue(
      Object.assign(new Error("409"), {
        isAxiosError: true,
        response: {
          status: 409,
          data: { code: "direct-shares-session-cookie", error: "x" },
        },
      }),
    );
    const { openWebEndpointView } =
      await import("../../src/frontend/web-endpoint-api");
    await expect(openWebEndpointView(7, "e1")).rejects.toThrow(
      /directSharesSessionCookie/,
    );
  });

  it("treats an answer with no grant as a failure", async () => {
    pluginPost.mockResolvedValue({ data: { url: "https://x/" } });
    const { openWebEndpointView } =
      await import("../../src/frontend/web-endpoint-api");
    await expect(openWebEndpointView(7, "e1")).rejects.toThrow();
  });
});

describe("onDesktop", () => {
  it("reads app.desktop, which works inside a frame", async () => {
    const { onDesktop, setWebEndpointDesktop } =
      await import("../../src/frontend/web-endpoint-api");
    setWebEndpointDesktop({ available: true });
    expect(onDesktop()).toBe(true);
    setWebEndpointDesktop({ available: false });
    isElectron.mockReturnValue(true);
    expect(onDesktop()).toBe(false);
    setWebEndpointDesktop(null);
    expect(onDesktop()).toBe(true);
  });
});
