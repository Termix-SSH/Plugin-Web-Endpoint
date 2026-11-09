import { describe, expect, it } from "vitest";
import { checkCommand } from "../../src/backend/operations.js";

describe("checkCommand", () => {
  it("quotes the path so it cannot break out", () => {
    const command = checkCommand({
      id: "a",
      label: "A",
      scheme: "http",
      port: 8080,
      path: "/x';rm -rf /;'",
    } as never);
    expect(command).toContain("'http://127.0.0.1:8080/x'\'';rm -rf /;'\'''");
  });
});
