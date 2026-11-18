import { describe, expect, it } from "vitest";
import { normalizeMountPath } from "../../src/backend/proxy.js";

describe("mount path", () => {
  it("accepts the plugin mount with or without trailing slashes", () => {
    expect(normalizeMountPath("/plugin-api/web-endpoint//")).toBe(
      "/plugin-api/web-endpoint",
    );
    expect(normalizeMountPath("/elsewhere")).toBeNull();
  });

  it("stays fast on a long run of slashes", () => {
    const start = performance.now();
    normalizeMountPath(`${"/".repeat(200_000)}x`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
