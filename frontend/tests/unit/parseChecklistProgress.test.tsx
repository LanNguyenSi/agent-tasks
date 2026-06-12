/** @vitest-environment jsdom */
/**
 * parseChecklistProgress -- the GFM checklist counter behind the
 * "{checked} of {total} checked" indicator in the task-detail header.
 * jsdom env because the host module (TaskDetail) imports React components.
 */
import { describe, it, expect } from "vitest";

import { parseChecklistProgress } from "../../src/components/TaskDetail";

describe("parseChecklistProgress", () => {
  it("counts checked and unchecked dash items", () => {
    const md = "- [ ] one\n- [x] two\n- [X] three\n";
    expect(parseChecklistProgress(md)).toEqual({ checked: 2, total: 3 });
  });

  it("counts indented (nested) items and * / + bullets", () => {
    const md = [
      "- [ ] top",
      "  - [x] nested dash",
      "    * [ ] nested star",
      "+ [x] plus bullet",
    ].join("\n");
    expect(parseChecklistProgress(md)).toEqual({ checked: 2, total: 4 });
  });

  it("returns null when the description has no checklist", () => {
    expect(parseChecklistProgress("plain text, no boxes")).toBeNull();
    expect(parseChecklistProgress("")).toBeNull();
  });

  it("ignores checkbox-like text that is not at a line start", () => {
    const md = "see the - [ ] marker syntax described above";
    expect(parseChecklistProgress(md)).toBeNull();
  });

  it("requires the bracket to follow the bullet", () => {
    expect(parseChecklistProgress("- no box here\n* also none")).toBeNull();
  });
});
