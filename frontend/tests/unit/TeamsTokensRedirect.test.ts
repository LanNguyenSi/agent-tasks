import { describe, it, expect, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect }));

import TeamsTokensRedirectPage from "../../src/app/teams/tokens/page";

describe("/teams/tokens", () => {
  it("redirects to team settings", () => {
    TeamsTokensRedirectPage();
    expect(redirect).toHaveBeenCalledWith("/settings/team");
  });
});
