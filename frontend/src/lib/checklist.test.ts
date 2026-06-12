/**
 * parseChecklistProgress -- the GFM checklist counter behind the
 * "{checked} of {total} checked" indicator in the task-detail header.
 * Pure function, node-env test per the lib/ pattern.
 */
import { describe, it, expect } from "vitest";

import { parseChecklistProgress } from "./checklist";

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

  // Pins the documented divergence from remark-gfm rendering: the line-regex
  // approximation also counts checkbox-looking lines inside code blocks.
  // If this test starts failing, the parser got smarter; update the docstring.
  it("counts checkbox-looking lines inside code fences (known divergence)", () => {
    const md = "```\n- [ ] inside a fence\n```\n";
    expect(parseChecklistProgress(md)).toEqual({ checked: 0, total: 1 });
  });

  it("counts checkbox-looking lines in indented code blocks (known divergence)", () => {
    const md = "intro paragraph\n\n    - [x] looks like code\n";
    expect(parseChecklistProgress(md)).toEqual({ checked: 1, total: 1 });
  });
});
