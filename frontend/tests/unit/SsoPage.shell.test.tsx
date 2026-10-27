/** @vitest-environment jsdom */
/**
 * /settings/team/sso page frame: the default (centred 1200px) page column
 * like the other settings pages, with the form capped at a reading width by
 * the sso-content slot class instead of a narrower shell variant, so the title
 * starts on the same x as /settings/team.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import SsoSettingsPage from "../../src/app/settings/team/sso/page";

afterEach(cleanup);

describe("/settings/team/sso page frame", () => {
  it("renders one <main> on the default column with the form slot class", () => {
    render(<SsoSettingsPage />);
    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    const main = mains[0]!;
    expect(main).toHaveClass("pshell--default");
    const slots = main.querySelectorAll(":scope > .pshell-content");
    expect(slots).toHaveLength(1);
    expect(slots[0]).toHaveClass("pshell-content--default", "sso-content");
    expect(slots[0]).not.toHaveClass("pshell-content--wide");
  });

  it("puts the title band straight into <main> (full width, column-aligned by CSS)", () => {
    render(<SsoSettingsPage />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Enterprise SSO (OIDC)" });
    expect(h1.closest(".page-header")?.parentElement).toBe(screen.getByRole("main"));
  });
});
