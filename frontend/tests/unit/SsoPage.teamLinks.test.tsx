/** @vitest-environment jsdom */
/**
 * The links from /settings/team/sso back to /settings/team.
 *
 * The SSO page is token-gated: it learns its team from the whoami call the
 * pasted token answers with. Before that it knows no team and its links stay
 * bare; once unlocked, both links (the "Team settings" breadcrumb and the
 * inline "Team settings -> API Tokens" one) carry that team as `?teamId=`,
 * so /settings/team opens it instead of resolving and rewriting its URL.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import SsoSettingsPage from "../../src/app/settings/team/sso/page";

const WHOAMI = {
  team: { id: "t9", name: "SSO Team", slug: "sso-team" },
  connection: null,
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/sso/whoami")) {
        return { ok: true, json: async () => WHOAMI } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function breadcrumb() {
  return screen.getByRole("link", { name: "Team settings" });
}
function apiTokensLink() {
  return screen.getByRole("link", { name: /API Tokens/ });
}

async function unlock() {
  fireEvent.change(screen.getByLabelText(/API token/), { target: { value: "agt_x" } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock SSO settings" }));
  await screen.findByText(/Unlocked for team: SSO Team/);
}

describe("/settings/team/sso links back to team settings", () => {
  it("bare before a token has resolved a team (no team known yet)", () => {
    render(<SsoSettingsPage />);
    expect(breadcrumb()).toHaveAttribute("href", "/settings/team");
    expect(apiTokensLink()).toHaveAttribute("href", "/settings/team#api-tokens");
  });

  it("carry the whoami team once unlocked (query before the hash)", async () => {
    render(<SsoSettingsPage />);
    await unlock();
    await waitFor(() =>
      expect(breadcrumb()).toHaveAttribute("href", "/settings/team?teamId=t9"),
    );
    expect(apiTokensLink()).toHaveAttribute("href", "/settings/team?teamId=t9#api-tokens");
  });
});
