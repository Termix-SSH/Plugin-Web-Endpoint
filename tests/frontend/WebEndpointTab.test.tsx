import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { WebEndpoint } from "../../src/shared/web-endpoint-config";
import type { PluginHostRecord as Host } from "@termix-ssh/plugin-sdk/frontend";

const openWebEndpointTunnel = vi.hoisted(() => vi.fn());
const openWebEndpointProxy = vi.hoisted(() => vi.fn());
const allowInvalidCertificateForOrigin = vi.hoisted(() => vi.fn());

vi.mock("../../src/frontend/web-endpoint-api", async (importOriginal) => {
  // requireNumericHostId is left as the real implementation -- the "no saved
  // host" case exercises the actual validation, not a re-implementation of it
  // that could drift.
  const actual =
    await importOriginal<
      typeof import("../../src/frontend/web-endpoint-api")
    >();
  return {
    ...actual,
    openWebEndpointTunnel: (...args: unknown[]) =>
      openWebEndpointTunnel(...args),
    openWebEndpointProxy: (...args: unknown[]) => openWebEndpointProxy(...args),
    allowInvalidCertificateForOrigin: (...args: unknown[]) =>
      allowInvalidCertificateForOrigin(...args),
  };
});

const electron = vi.hoisted(() => ({ isElectron: vi.fn(() => true) }));
vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...electron,
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function endpoint(overrides: Partial<WebEndpoint> = {}): WebEndpoint {
  return {
    id: "e1",
    label: "Proxmox",
    scheme: "https",
    port: 8006,
    path: "/",
    access: "direct",
    render: "embedded",
    ...overrides,
  };
}

function host(
  overrides: Partial<Host> = {},
  endpoints: WebEndpoint[] = [],
): Host {
  return {
    id: "7",
    ip: "192.168.1.10",
    pluginSettings: { "web-endpoint": { webUiConfig: { endpoints } } },
    ...overrides,
  } as unknown as Host;
}

let pageHostname = "localhost";
const realLocation = window.location;

beforeEach(() => {
  Object.defineProperty(HTMLIFrameElement.prototype, "credentialless", {
    configurable: true,
    writable: true,
    value: false,
  });
  pageHostname = "localhost";
  electron.isElectron.mockReturnValue(true);
  Object.defineProperty(window, "location", {
    configurable: true,
    get: () => ({ ...realLocation, hostname: pageHostname }),
  });
});

afterEach(() => {
  cleanup();
  delete (HTMLIFrameElement.prototype as { credentialless?: boolean })
    .credentialless;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: realLocation,
  });
  openWebEndpointTunnel.mockReset();
  openWebEndpointProxy.mockReset();
  allowInvalidCertificateForOrigin.mockReset();
});

describe("WebEndpointTab", () => {
  it("refuses unsupported environments before creating a tunnel or iframe", async () => {
    delete (HTMLIFrameElement.prototype as { credentialless?: boolean })
      .credentialless;
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(
      <WebEndpointTab
        host={host({}, [endpoint({ access: "tunnel" })])}
        endpointId="e1"
      />,
    );
    await screen.findByText("webEndpoint.isolationUnavailable");
    expect(openWebEndpointTunnel).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBeNull();
  });
  it("isolates cookie state and denies parent access, popups and top navigation", async () => {
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(<WebEndpointTab host={host({}, [endpoint()])} endpointId="e1" />);
    const frame = (await screen.findByTitle("Proxmox")) as HTMLIFrameElement;
    expect(
      (frame as HTMLIFrameElement & { credentialless: boolean }).credentialless,
    ).toBe(true);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.queryByText("webEndpoint.openExternally")).toBeNull();
  });

  describe("in the desktop app", () => {
    const open = vi.fn(async () => ({}));
    const embeddedView = {
      open,
      setBounds: vi.fn(async () => ({})),
      setVisible: vi.fn(async () => ({})),
      close: vi.fn(async () => ({})),
    };

    beforeEach(() => {
      open.mockClear();
      (window as unknown as { electronAPI: unknown }).electronAPI = {
        embeddedView,
      };
    });

    afterEach(() => {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    });

    it("opens a native view instead of an iframe", async () => {
      const { WebEndpointTab } =
        await import("../../src/frontend/WebEndpointTab");
      render(
        <WebEndpointTab
          host={host({}, [endpoint({ ignoreCert: true })])}
          endpointId="e1"
        />,
      );
      await waitFor(() => expect(open).toHaveBeenCalled());
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://192.168.1.10:8006/",
          ignoreCert: true,
        }),
      );
      expect(document.querySelector("iframe")).toBeNull();
      expect(allowInvalidCertificateForOrigin).not.toHaveBeenCalled();
    });

    it("does not need iframe isolation support", async () => {
      delete (HTMLIFrameElement.prototype as { credentialless?: boolean })
        .credentialless;
      const { WebEndpointTab } =
        await import("../../src/frontend/WebEndpointTab");
      render(<WebEndpointTab host={host({}, [endpoint()])} endpointId="e1" />);
      await waitFor(() => expect(open).toHaveBeenCalled());
      expect(screen.queryByText("webEndpoint.isolationUnavailable")).toBeNull();
    });
  });

  it("renders an iframe at the direct URL", async () => {
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(<WebEndpointTab host={host({}, [endpoint()])} endpointId="e1" />);
    await waitFor(() =>
      expect(screen.getByTitle("Proxmox")).toHaveAttribute(
        "src",
        "https://192.168.1.10:8006/",
      ),
    );
  });

  it("opens the tunnel through the numeric host id and frames the loopback URL", async () => {
    openWebEndpointTunnel.mockResolvedValue(41234);
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(
      <WebEndpointTab
        host={host({}, [endpoint({ access: "tunnel" })])}
        endpointId="e1"
      />,
    );
    await waitFor(() => {
      expect(openWebEndpointTunnel).toHaveBeenCalledWith(7, "e1");
      expect(screen.getByTitle("Proxmox")).toHaveAttribute(
        "src",
        "https://127.0.0.1:41234/",
      );
    });
  });

  it("registers the certificate allowance for a direct endpoint with ignoreCert", async () => {
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(
      <WebEndpointTab
        host={host({}, [endpoint({ ignoreCert: true })])}
        endpointId="e1"
      />,
    );
    await waitFor(() =>
      expect(allowInvalidCertificateForOrigin).toHaveBeenCalledWith(
        "https://192.168.1.10:8006",
      ),
    );
  });

  it("reframes at the new port when a reopened tunnel binds a different one", async () => {
    openWebEndpointTunnel
      .mockResolvedValueOnce(41234)
      .mockResolvedValueOnce(51234);
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(
      <WebEndpointTab
        host={host({}, [endpoint({ access: "tunnel" })])}
        endpointId="e1"
      />,
    );
    await waitFor(() =>
      expect(screen.getByTitle("Proxmox")).toHaveAttribute(
        "src",
        "https://127.0.0.1:41234/",
      ),
    );

    fireEvent.click(screen.getByTitle("webEndpoint.reload"));

    await waitFor(() =>
      expect(screen.getByTitle("Proxmox")).toHaveAttribute(
        "src",
        "https://127.0.0.1:51234/",
      ),
    );
    expect(openWebEndpointTunnel).toHaveBeenCalledTimes(2);
  });

  /**
   * The case the port-changed test above CANNOT exercise, and the one that
   * matters most: a live tunnel returns the SAME port on every open, and a
   * direct endpoint's URL never changes at all. If reload just did
   * setUrl(resolved), React would bail out of the same-value setState and the
   * frame would never remount -- so the button would do nothing in the two
   * most common cases. Capturing the DOM node before and after is what catches
   * that: a same-value setState never touches the DOM.
   */
  it("remounts the frame on reload even when the resolved URL is unchanged", async () => {
    openWebEndpointTunnel.mockResolvedValue(41234);
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(
      <WebEndpointTab
        host={host({}, [endpoint({ access: "tunnel" })])}
        endpointId="e1"
      />,
    );
    const firstFrame = await screen.findByTitle("Proxmox");
    expect(firstFrame).toHaveAttribute("src", "https://127.0.0.1:41234/");

    fireEvent.click(screen.getByTitle("webEndpoint.reload"));
    await waitFor(() => expect(openWebEndpointTunnel).toHaveBeenCalledTimes(2));

    // Polled rather than asserted once: against the defective implementation
    // this never becomes true and the test times out -- a real failure, not a
    // race.
    await waitFor(() => {
      expect(screen.getByTitle("Proxmox")).not.toBe(firstFrame);
    });
  });

  it("shows the failure reason when the tunnel cannot open", async () => {
    openWebEndpointTunnel.mockRejectedValue(
      new Error("Timed out reaching the endpoint port"),
    );
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(
      <WebEndpointTab
        host={host({}, [endpoint({ access: "tunnel" })])}
        endpointId="e1"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Timed out reaching the endpoint port/),
      ).toBeInTheDocument(),
    );
  });

  it("shows a plain message when the endpoint id matches nothing on the host", async () => {
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(<WebEndpointTab host={host({}, [])} endpointId="deleted" />);
    await waitFor(() =>
      expect(screen.getByText("webEndpoint.notFound")).toBeInTheDocument(),
    );
    expect(openWebEndpointTunnel).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("explains that a tunnel needs a saved host, instead of calling the route", async () => {
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(
      <WebEndpointTab
        host={host({ id: "quick-connect-1" }, [endpoint({ access: "tunnel" })])}
        endpointId="e1"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/errors\.savedHostRequired/)).toBeInTheDocument(),
    );
    expect(openWebEndpointTunnel).not.toHaveBeenCalled();
  });

  it("resolves a direct endpoint normally on the same quick-connect host", async () => {
    // The positive case: requireNumericHostId must be consulted only on the
    // tunnel branch, or direct endpoints would break on unsaved hosts too.
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(
      <WebEndpointTab
        host={host({ id: "quick-connect-1" }, [endpoint({ access: "direct" })])}
        endpointId="e1"
      />,
    );
    await waitFor(() =>
      expect(screen.getByTitle("Proxmox")).toHaveAttribute(
        "src",
        "https://192.168.1.10:8006/",
      ),
    );
    expect(openWebEndpointTunnel).not.toHaveBeenCalled();
  });

  it("refuses a direct endpoint on the same host that serves Termix", async () => {
    electron.isElectron.mockReturnValue(false);
    pageHostname = "termix.example";
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(
      <WebEndpointTab
        host={host({ ip: "termix.example" }, [
          endpoint({ access: "direct", port: 8443 }),
        ])}
        endpointId="e1"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText("webEndpoint.directSharesSessionCookie"),
      ).toBeInTheDocument(),
    );
    // Refusing after framing would have leaked on the very first request.
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("refuses a direct endpoint on a sub domain of the page host", async () => {
    electron.isElectron.mockReturnValue(false);
    pageHostname = "termix.example.com";
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(
      <WebEndpointTab
        host={host({ ip: "ui.termix.example.com" }, [
          endpoint({ access: "direct" }),
        ])}
        endpointId="e1"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText("webEndpoint.directSharesSessionCookie"),
      ).toBeInTheDocument(),
    );
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("still frames a direct same-host endpoint on the desktop, whose jar has no jwt", async () => {
    electron.isElectron.mockReturnValue(true);
    pageHostname = "termix.example";
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(
      <WebEndpointTab
        host={host({ ip: "termix.example" }, [
          endpoint({ access: "direct", port: 8443 }),
        ])}
        endpointId="e1"
      />,
    );
    await waitFor(() =>
      expect(screen.getByTitle("Proxmox")).toHaveAttribute(
        "src",
        "https://termix.example:8443/",
      ),
    );
  });

  it("still frames a DIRECT endpoint on a hostname that refuses tunnels", async () => {
    electron.isElectron.mockReturnValue(false);
    pageHostname = "termix.example.com";
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(<WebEndpointTab host={host({}, [endpoint()])} endpointId="e1" />);
    await waitFor(() =>
      expect(screen.getByTitle("Proxmox")).toHaveAttribute(
        "src",
        "https://192.168.1.10:8006/",
      ),
    );
  });

  it("frames a tunnel in a browser through the backend's proxy", async () => {
    electron.isElectron.mockReturnValue(false);
    pageHostname = "termix.example.com";
    openWebEndpointProxy.mockResolvedValue(
      "https://termix.example.com/plugin-api/web-endpoint/p/token/",
    );
    const { WebEndpointTab } =
      await import("../../src/frontend/WebEndpointTab");
    render(
      <WebEndpointTab
        host={host({}, [endpoint({ access: "tunnel" })])}
        endpointId="e1"
      />,
    );
    await waitFor(() =>
      expect(screen.getByTitle("Proxmox")).toHaveAttribute(
        "src",
        "https://termix.example.com/plugin-api/web-endpoint/p/token/",
      ),
    );
    expect(openWebEndpointProxy).toHaveBeenCalledWith(7, "e1");
    // Never a raw forward port from a browser.
    expect(openWebEndpointTunnel).not.toHaveBeenCalled();
  });
});
