import { describe, it, expect } from "vitest";
import { isProjectAdminRole } from "@/lib/api";

// Guards the admin-override gate derivation (page.tsx threads this into the
// status-override + claim-release controls). A regression here — admitting a
// non-admin role, or dropping the PROJECT_ADMIN clause — would silently ship.
describe("isProjectAdminRole", () => {
  it("is true for a team ADMIN and a per-project PROJECT_ADMIN", () => {
    expect(isProjectAdminRole("ADMIN")).toBe(true);
    expect(isProjectAdminRole("PROJECT_ADMIN")).toBe(true);
  });

  it("is false for every non-admin role and for null/undefined", () => {
    for (const role of [
      "HUMAN_MEMBER",
      "REVIEWER",
      "PROJECT_CONTRIBUTOR",
      "PROJECT_VIEWER",
      "",
      null,
      undefined,
    ]) {
      expect(isProjectAdminRole(role)).toBe(false);
    }
  });
});
