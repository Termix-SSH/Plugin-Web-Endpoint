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

const openWebEndpointView = vi.hoisted(() => vi.fn());
const desktop = vi.hoisted(() => ({ value: false }));

vi.mock("../../src/frontend/web-endpoint-api", async (importOriginal) => {
  // requireNumericHostId is the real one, so the "no saved host" case runs
  // the actual check.
  const actual =
    await importOriginal<
      typeof import("../../src/frontend/web-endpoint-api")
    >();
  return {
    ...actual,
    onDesktop: () => desktop.value,
    openWebEndpointView: (...args: unknown[]) => openWebEndpointView(...args),
  };
});

vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isElectron: () => desktop.value,
  NativeView: (props: { grant?: string; url?: string }) => (
    <div data-testid="granted" data-grant={props.grant} data-url={props.url} />
  ),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { WebEndpointTab } from "../../src/frontend/WebEndpointTab";

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
  endpoints: WebEndpoint[] = [endpoint()],
): Host {
  return {
    id: "7",
    ip: "192.168.1.10",
    pluginSettings: { "web-endpoint": { webUiConfig: { endpoints } } },
    ...overrides,
  } as unknown as Host;
}

const GRANT_A = "a".repeat(48);
const GRANT_B = "b".repeat(48);

beforeEach(() => {
  desktop.value = false;
  openWebEndpointView.mockResolvedValue({
    grant: GRANT_A,
    url: "https://192.168.1.10:8006/",
  });
});

afterEach(() => {
  cleanup();
  openWebEndpointView.mockReset();
});

describe("WebEndpointTab", () => {
  it("asks the backend for the page and shows only its grant", async () => {
    render(<WebEndpointTab host={host()} endpointId="e1" />);
    await waitFor(() =>
      expect(screen.getByTestId("granted")).toHaveAttribute(
        "data-grant",
        GRANT_A,
      ),
    );
    expect(openWebEndpointView).toHaveBeenCalledWith(7, "e1");
    // The tab never hands the view an address of its own.
    expect(screen.getByTestId("granted")).not.toHaveAttribute("data-url");
    expect(screen.getByText("https://192.168.1.10:8006/")).toBeInTheDocument();
  });

  it("gets a fresh grant on reload", async () => {
    render(<WebEndpointTab host={host()} endpointId="e1" />);
    await waitFor(() => screen.getByTestId("granted"));
    openWebEndpointView.mockResolvedValueOnce({
      grant: GRANT_B,
      url: "https://192.168.1.10:8006/",
    });
    fireEvent.click(screen.getByTitle("webEndpoint.reload"));
    await waitFor(() =>
      expect(screen.getByTestId("granted")).toHaveAttribute(
        "data-grant",
        GRANT_B,
      ),
    );
    expect(openWebEndpointView).toHaveBeenCalledTimes(2);
  });

  it("shows the backend's reason when it refuses", async () => {
    openWebEndpointView.mockReset();
    openWebEndpointView.mockRejectedValue(
      new Error("webEndpoint.directSharesSessionCookie"),
    );
    render(<WebEndpointTab host={host()} endpointId="e1" />);
    await waitFor(() =>
      expect(
        screen.getByText("webEndpoint.directSharesSessionCookie"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("granted")).toBeNull();
  });

  it("shows a plain message when the endpoint id matches nothing on the host", () => {
    render(<WebEndpointTab host={host()} endpointId="gone" />);
    expect(screen.getByText("webEndpoint.notFound")).toBeInTheDocument();
    expect(openWebEndpointView).not.toHaveBeenCalled();
  });

  it("explains that it needs a saved host, instead of calling the route", async () => {
    render(
      <WebEndpointTab host={host({ id: "quick-connect-1" })} endpointId="e1" />,
    );
    await waitFor(() => expect(screen.queryByTestId("granted")).toBeNull());
    expect(openWebEndpointView).not.toHaveBeenCalled();
  });

  it("opens an endpoint set to go through Termix in the browser, not in a tab", async () => {
    render(
      <WebEndpointTab
        host={host({}, [endpoint({ access: "termix" })])}
        endpointId="e1"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText("hosts.webUiAccessTermixDesc"),
      ).toBeInTheDocument(),
    );
    expect(openWebEndpointView).not.toHaveBeenCalled();
  });

  it("offers a desktop window only in the desktop app", async () => {
    const { unmount } = render(
      <WebEndpointTab host={host()} endpointId="e1" />,
    );
    await waitFor(() => screen.getByTestId("granted"));
    expect(screen.queryByText("webEndpoint.openIsolatedWindow")).toBeNull();
    expect(screen.getByText("webEndpoint.isolationNotice")).toBeInTheDocument();
    unmount();
    desktop.value = true;
    render(<WebEndpointTab host={host()} endpointId="e1" />);
    await waitFor(() => screen.getByTestId("granted"));
    expect(
      screen.getByText("webEndpoint.openIsolatedWindow"),
    ).toBeInTheDocument();
    expect(screen.queryByText("webEndpoint.isolationNotice")).toBeNull();
  });
});
