/** @vitest-environment jsdom */
/**
 * ConfirmDialog primitive — the dialog title is a heading at the dialog
 * level (h2 beside the page H1, matching Modal's default), named by the
 * title prop, and the dialog is named by it through aria-labelledby.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import ConfirmDialog from "../../src/components/ui/ConfirmDialog";

afterEach(cleanup);

describe("ConfirmDialog — title heading", () => {
  it("titles the dialog with an h2 by default", () => {
    render(
      <ConfirmDialog
        open
        title="Delete token"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const title = screen.getByRole("heading", { level: 2, name: "Delete token" });
    expect(title).toHaveClass("confirm-dialog-title");
    expect(screen.queryByRole("heading", { level: 3, name: "Delete token" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Delete token" })).toBeInTheDocument();
  });
});
