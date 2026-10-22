import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import { webPanelEnabled } from "../../src/frontend/WebEndpointCompanion";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const endpoint = {
  id: "ui",
  label: "Admin UI",
  scheme: "http",
  port: 8080,
  access: "direct",
  render: "embedded",
};

function hostWith(settings: Record<string, unknown>) {
  return {
    id: "3",
    name: "nas",
    ip: "10.0.0.3",
    port: 22,
    pluginSettings: { "web-endpoint": settings },
  };
}

const host = hostWith({
  enableWebUi: true,
  webUiConfig: { endpoints: [endpoint] },
});

describe("web UI panel and card", () => {
  it("offers the panel only for hosts with an embedded web UI", () => {
    expect(webPanelEnabled(host as never)).toBe(true);
    expect(
      webPanelEnabled(
        hostWith({
          enableWebUi: true,
          showPanel: false,
          webUiConfig: { endpoints: [endpoint] },
        }) as never,
      ),
    ).toBe(false);
    expect(
      webPanelEnabled(
        hostWith({
          enableWebUi: true,
          webUiConfig: { endpoints: [{ ...endpoint, render: "external" }] },
        }) as never,
      ),
    ).toBe(false);
  });

  it("registers the card and panel toggle", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.dashboardCards()).toEqual(["web-endpoints"]);
    expect(rendered.registered.slot("tab.menu")).toEqual([
      "web-endpoint.togglePanel",
    ]);
  });

  it("opens a web UI from the dashboard card", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      hosts: [host],
    });
    rendered.renderDashboardCard("web-endpoints");
    fireEvent.click(await screen.findByText("Admin UI"));
    expect(rendered.shellCalls).toContainEqual(
      expect.objectContaining({ method: "openTab" }),
    );
  });
});
