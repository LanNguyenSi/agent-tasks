import { describe, it, expect } from "vitest";
import { isProjectWriteRole } from "@/lib/api";

// Guards the write-tier gate derivation (page.tsx threads this into the
// TaskMetaSidebar labels editor). Mirrors the backend's requireProjectWrite
// (backend/src/services/team-access.ts): every team role is write-capable,
// and on a per-project share only PROJECT_VIEWER is read-only. A regression
// here -- admitting PROJECT_VIEWER, or dropping a legitimate write role --
// would silently ship.
describe("isProjectWriteRole", () => {
  it("is true for every write-capable role: team roles and the two write-tier per-project roles", () => {
    for (const role of ["ADMIN", "HUMAN_MEMBER", "REVIEWER", "PROJECT_ADMIN", "PROJECT_CONTRIBUTOR"]) {
      expect(isProjectWriteRole(role)).toBe(true);
    }
  });

  it("is false for PROJECT_VIEWER and for null/undefined", () => {
    for (const role of ["PROJECT_VIEWER", "", null, undefined]) {
      expect(isProjectWriteRole(role)).toBe(false);
    }
  });

  it("fails closed for an unrecognized role, same as the backend's allow-list", () => {
    expect(isProjectWriteRole("SOME_FUTURE_ROLE")).toBe(false);
  });
});
