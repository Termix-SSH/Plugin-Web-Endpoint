import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { PortInput } from "../../src/frontend/HostEditorWebUiSection";

afterEach(cleanup);

function Harness({ onCommit }: { onCommit: (port: number) => void }) {
  const [port, setPort] = useState(443);
  return (
    <PortInput
      aria-label="port"
      port={port}
      onCommit={(next) => {
        onCommit(next);
        setPort(next);
      }}
    />
  );
}

describe("PortInput", () => {
  it("lets the whole field be cleared and retyped", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const input = screen.getByLabelText("port") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "8006" } });
    expect(input.value).toBe("8006");
    expect(onCommit).toHaveBeenLastCalledWith(8006);
  });

  it("goes back to the saved port on blur when left empty", () => {
    render(<Harness onCommit={vi.fn()} />);
    const input = screen.getByLabelText("port") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("443");
  });
});
