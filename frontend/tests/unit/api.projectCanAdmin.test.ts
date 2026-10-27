import { describe, it, expect } from "vitest";
import { projectCanAdmin } from "@/lib/api";

// The UI admin gate. `canAdmin` from GET /projects/:id wins whenever it is a
// boolean (the server computes it with the check the write routes enforce);
// `accessRole` only decides when `canAdmin` is missing (older backend).
describe("projectCanAdmin", () => {
  const ADMIN_ROLES = ["ADMIN", "PROJECT_ADMIN"];
  const NON_ADMIN_ROLES = ["HUMAN_MEMBER", "REVIEWER", "PROJECT_CONTRIBUTOR", "PROJECT_VIEWER", null, undefined];

  describe("canAdmin true wins over every accessRole", () => {
    for (const accessRole of [...ADMIN_ROLES, ...NON_ADMIN_ROLES]) {
      it(`accessRole ${String(accessRole)}`, () => {
        expect(projectCanAdmin({ canAdmin: true, accessRole })).toBe(true);
      });
    }
  });

  describe("canAdmin false wins over every accessRole", () => {
    for (const accessRole of [...ADMIN_ROLES, ...NON_ADMIN_ROLES]) {
      it(`accessRole ${String(accessRole)}`, () => {
        expect(projectCanAdmin({ canAdmin: false, accessRole })).toBe(false);
      });
    }
  });

  describe("canAdmin absent falls back to the accessRole rule", () => {
    for (const accessRole of ADMIN_ROLES) {
      it(`admin accessRole ${accessRole} is admin`, () => {
        expect(projectCanAdmin({ accessRole })).toBe(true);
      });
    }
    for (const accessRole of NON_ADMIN_ROLES) {
      it(`non-admin accessRole ${String(accessRole)} is not admin`, () => {
        expect(projectCanAdmin({ accessRole })).toBe(false);
      });
    }
  });

  it("a non-boolean canAdmin (null from a malformed response) counts as absent", () => {
    expect(projectCanAdmin({ canAdmin: null as unknown as boolean, accessRole: "ADMIN" })).toBe(true);
    expect(projectCanAdmin({ canAdmin: null as unknown as boolean, accessRole: "HUMAN_MEMBER" })).toBe(false);
  });

  it("no project yet is not admin", () => {
    expect(projectCanAdmin(null)).toBe(false);
    expect(projectCanAdmin(undefined)).toBe(false);
  });
});
