/** @vitest-environment jsdom */
/**
 * usePopover: the portal mount flag and the position-ready flag that keeps a
 * panel hidden until its coordinates are computed.
 */
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { usePopover } from "../../src/components/ui/usePopover";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function setup(initialOpen: boolean) {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const anchorRef = { current: anchor };
  return renderHook(
    ({ open }: { open: boolean }) => usePopover({ anchorRef, open, onClose: () => {} }),
    { initialProps: { open: initialOpen } },
  );
}

describe("usePopover", () => {
  it("reports mounted on the client", () => {
    const { result } = setup(false);
    expect(result.current.mounted).toBe(true);
  });

  it("is not position-ready while closed, ready once opened, and not ready again after closing", () => {
    const { result, rerender } = setup(false);
    expect(result.current.positionReady).toBe(false);

    rerender({ open: true });
    expect(result.current.positionReady).toBe(true);

    rerender({ open: false });
    expect(result.current.positionReady).toBe(false);

    rerender({ open: true });
    expect(result.current.positionReady).toBe(true);
  });
});
