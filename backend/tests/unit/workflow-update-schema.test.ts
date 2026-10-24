/**
 * Pins the zod 4 `.partial()` + `.default()` trap fix on the workflow UPDATE
 * body schema.
 *
 * In zod 3, `createWorkflowSchema.omit({ projectId }).partial()` left an absent
 * `isDefault` as `undefined` (the update route reads `undefined` as "do not
 * change the default flag"). zod 4 applies the inner `.default(false)` once the
 * field is optional, which would silently turn every bare PATCH body into
 * `isDefault: false` and make the update route wrongly invalidate grounding
 * context for the project's inherited tasks. The schema re-asserts isDefault as
 * a plain optional; these tests lock the base accept/output behaviour per input.
 */
import { describe, expect, it } from "vitest";
import { createWorkflowSchema, updateWorkflowSchema } from "../../src/routes/workflows.js";

const def = {
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "in_progress", label: "In progress", terminal: false },
    { name: "review", label: "In review", terminal: false },
    { name: "done", label: "Done", terminal: true },
  ],
  transitions: [],
  initialState: "open",
};

describe("updateWorkflowSchema keeps isDefault optional (no zod 4 default leak)", () => {
  it("name-only body leaves isDefault undefined", () => {
    const r = updateWorkflowSchema.safeParse({ name: "Renamed" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("Renamed");
      expect("isDefault" in r.data).toBe(false);
      expect(r.data.isDefault).toBeUndefined();
    }
  });

  it("empty body leaves every field undefined (no default injection)", () => {
    const r = updateWorkflowSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.isDefault).toBeUndefined();
  });

  it("explicit isDefault:false round-trips as false", () => {
    const r = updateWorkflowSchema.safeParse({ isDefault: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.isDefault).toBe(false);
  });

  it("create schema still defaults isDefault to false when absent", () => {
    const r = createWorkflowSchema.safeParse({ name: "W", projectId: "550e8400-e29b-41d4-a716-446655440000", definition: def });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.isDefault).toBe(false);
  });
});
