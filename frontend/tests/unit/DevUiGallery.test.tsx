/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ToastProvider } from "../../src/components/ui/Toast";
import UIGalleryPage from "../../src/app/dev/ui/page";

afterEach(cleanup);

describe("/dev/ui gallery accessibility", () => {
  it("names the Select trigger and wraps the gallery in a main landmark", () => {
    render(
      <ToastProvider>
        <UIGalleryPage />
      </ToastProvider>,
    );
    expect(screen.getByRole("combobox", { name: "Gallery project filter" })).toBeInTheDocument();
    // By role, not tag: a <main> that loses its landmark role must fail here.
    expect(screen.getByRole("main")).toHaveClass("dev-gallery");
  });
});
