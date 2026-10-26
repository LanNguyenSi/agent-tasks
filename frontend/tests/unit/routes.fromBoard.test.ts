import { describe, it, expect } from "vitest";
import { safeBackHref, taskFromBoardHref } from "../../src/lib/routes";

describe("taskFromBoardHref", () => {
  it("is /tasks/<id>?from=board", () => {
    expect(taskFromBoardHref("t-1")).toBe("/tasks/t-1?from=board");
  });

  it("is not a back URL: safeBackHref rejects it, so no Tasks crumb appears", () => {
    expect(safeBackHref("board")).toBeNull();
  });
});
