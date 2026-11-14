import { describe, expect, it, vi } from "vitest";
import express from "express";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";

const manifest = manifestJson as unknown as PluginManifest;

describe("web UI down alerts", () => {
  it("alerts once when a web UI stops answering", async () => {
    const mock = createMockCtx({
      sandbox: true,
      pluginId: manifest.id,
      manifest,
      capabilities: manifest.capabilities,
      actor: "user-1",
      router: () => express.Router(),
      hosts: [
        {
          id: 3,
          userId: "user-1",
          name: "nas",
          ip: "10.0.0.3",
          port: 22,
          username: "root",
          tags: null,
          folder: null,
          authType: "password",
        },
      ],
    });
    await mock.ctx.settings.setHost(3, "enableWebUi", true);
    await mock.ctx.settings.setHost(3, "alertDown", true);
    await mock.ctx.settings.setHost(3, "webUiConfig", {
      endpoints: [
        {
          id: "ui",
          label: "Admin UI",
          scheme: "http",
          port: 8080,
          access: "direct",
          render: "embedded",
        },
      ],
    });
    await mock.ctx.kv.set("alerts:3", "user-1");
    const exec = vi
      .spyOn(mock.ctx.ssh, "exec")
      .mockResolvedValue({ stdout: "502", stderr: "", code: 0 } as never);

    await activate(mock.ctx);
    await mock.runScheduled();
    await mock.runScheduled();

    expect(exec).toHaveBeenCalled();
    expect(mock.notifications).toHaveLength(1);
    expect(mock.notifications[0].notification).toMatchObject({
      category: "web-endpoint.down",
      dedupeKey: "web-endpoint.down:3:ui",
    });
  });
});
