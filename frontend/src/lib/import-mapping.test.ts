/**
 * Unit tests for the Jira column auto-detection and row-mapping helpers.
 *
 * All three exports are pure data-transforms; no mocking is required.
 * wikiToMarkdown (imported transitively by mapRows) is also pure and
 * returns plain text unchanged when it contains no Wiki Markup signals.
 */
import { describe, it, expect } from "vitest";
import {
  autoDetectColumns,
  mapRows,
  getMappingCompleteness,
} from "./import-mapping";
import type { ColumnMapping } from "./import-mapping";

// ---------------------------------------------------------------------------
// autoDetectColumns
// ---------------------------------------------------------------------------

describe("autoDetectColumns", () => {
  it("detects all 9 columns from a German Jira export header row", () => {
    const headers = [
      "Zusammenfassung",
      "Vorgangsschlüssel",
      "Beschreibung",
      "Priorität",
      "Status",
      "Statuskategorie",
      "Vorgangstyp",
      "Fälligkeitsdatum",
      "Bezeichnungen",
    ];
    const mapping = autoDetectColumns(headers);
    expect(mapping).toEqual<ColumnMapping>({
      title: 0,
      externalRef: 1,
      description: 2,
      priority: 3,
      status: 4,
      statusCategory: 5,
      issueType: 6,
      dueAt: 7,
      labels: 8,
    });
  });

  it("detects all 9 columns from an English Jira export header row", () => {
    const headers = [
      "Summary",
      "Issue Key",
      "Description",
      "Priority",
      "Status",
      "Status Category",
      "Issue Type",
      "Due Date",
      "Labels",
    ];
    const mapping = autoDetectColumns(headers);
    expect(mapping).toEqual<ColumnMapping>({
      title: 0,
      externalRef: 1,
      description: 2,
      priority: 3,
      status: 4,
      statusCategory: 5,
      issueType: 6,
      dueAt: 7,
      labels: 8,
    });
  });

  it('skips "Benutzerdefiniertes Feld" columns and keeps recognised columns around them', () => {
    const headers = [
      "Summary",
      "Benutzerdefiniertes Feld (Sprint)",
      "Custom field (Story Points)",
      "Labels",
    ];
    const mapping = autoDetectColumns(headers);
    expect(mapping.title).toBe(0);
    expect(mapping.labels).toBe(3);
    expect(mapping.externalRef).toBeNull();
    expect(mapping.description).toBeNull();
    expect(mapping.priority).toBeNull();
  });

  it("is case-insensitive", () => {
    const mapping = autoDetectColumns(["SUMMARY", "STATUS"]);
    expect(mapping.title).toBe(0);
    expect(mapping.status).toBe(1);
  });

  it("returns null for every field that has no matching header", () => {
    const mapping = autoDetectColumns(["Summary", "UnknownColumn"]);
    expect(mapping.title).toBe(0);
    expect(mapping.description).toBeNull();
    expect(mapping.priority).toBeNull();
    expect(mapping.issueType).toBeNull();
  });

  it("does not assign the same index twice (first match wins)", () => {
    // Two 'Status' columns — only the first should be captured.
    const mapping = autoDetectColumns(["Summary", "Status", "Status"]);
    expect(mapping.title).toBe(0);
    expect(mapping.status).toBe(1);
  });

  it("handles null/undefined entries in the headers array without throwing (|| '' defensive fallback)", () => {
    // Exercises the `(headers[i] || "").trim()` null-safety branch on line 58.
    // Real-world xlsx parsers can produce sparse rows where some cells are null.
    const headers = ["Summary", null as unknown as string, "Labels"];
    const mapping = autoDetectColumns(headers);
    expect(mapping.title).toBe(0);
    expect(mapping.labels).toBe(2);
    expect(mapping.externalRef).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mapRows
// ---------------------------------------------------------------------------

describe("mapRows", () => {
  // Full English mapping used as the baseline.
  const fullMapping: ColumnMapping = {
    title: 0,
    externalRef: 1,
    description: 2,
    priority: 3,
    status: 4,
    statusCategory: 5,
    issueType: 6,
    dueAt: 7,
    labels: 8,
  };

  it("maps a standard row to a correctly typed ImportableTask", () => {
    const row = [
      "Fix login bug",      // title
      "PROJ-1",             // externalRef
      "The login is broken", // description (plain text — no wikiToMarkdown transform)
      "High",               // priority
      "open",               // status (column)
      "In Progress",        // statusCategory — takes precedence
      "Bug",                // issueType → type:bug label
      null,                 // dueAt (null → undefined)
      "backend,auth",       // labels
    ];
    const [task] = mapRows([row], fullMapping);

    expect(task.title).toBe("Fix login bug");
    expect(task.externalRef).toBe("PROJ-1");
    expect(task.description).toBe("The login is broken");
    expect(task.priority).toBe("HIGH");
    expect(task.status).toBe("in_progress"); // statusCategory wins
    expect(task.labels).toContain("type:bug");
    expect(task.labels).toContain("backend");
    expect(task.labels).toContain("auth");
    expect(task.dueAt).toBeUndefined();
  });

  it("defaults priority to MEDIUM for an unrecognised priority value", () => {
    const row = ["Task", null, null, "urgent", null, null, null, null, null];
    const [task] = mapRows([row], fullMapping);
    expect(task.priority).toBe("MEDIUM");
  });

  it("defaults priority to MEDIUM when the priority cell is empty", () => {
    const row = ["Task", null, null, "", null, null, null, null, null];
    const [task] = mapRows([row], fullMapping);
    expect(task.priority).toBe("MEDIUM");
  });

  it("maps German priority labels to the correct tier", () => {
    const cases: Array<[string, string]> = [
      ["Höchste", "CRITICAL"],
      ["Hoch", "HIGH"],
      ["Normal", "MEDIUM"],
      ["Niedrig", "LOW"],
      ["Niedrigste", "LOW"],
    ];
    for (const [raw, expected] of cases) {
      const row = ["Task", null, null, raw, null, null, null, null, null];
      const [task] = mapRows([row], fullMapping);
      expect(task.priority, `priority for "${raw}"`).toBe(expected);
    }
  });

  it("maps English priority labels to the correct tier", () => {
    const cases: Array<[string, string]> = [
      ["Highest", "CRITICAL"],
      ["High", "HIGH"],
      ["Medium", "MEDIUM"],
      ["Low", "LOW"],
      ["Lowest", "LOW"],
    ];
    for (const [raw, expected] of cases) {
      const row = ["Task", null, null, raw, null, null, null, null, null];
      const [task] = mapRows([row], fullMapping);
      expect(task.priority, `priority for "${raw}"`).toBe(expected);
    }
  });

  it("derives status from the statusCategory column when it is non-empty", () => {
    const row = ["Task", null, null, null, "Backlog", "In Progress", null, null, null];
    const [task] = mapRows([row], fullMapping);
    // statusCategory = 'In Progress' → 'in_progress'
    expect(task.status).toBe("in_progress");
  });

  it("falls back to the status column when statusCategory is null in the mapping", () => {
    const mapping: ColumnMapping = { ...fullMapping, statusCategory: null };
    const row = ["Task", null, null, null, "done", null, null, null, null];
    const [task] = mapRows([row], mapping);
    expect(task.status).toBe("done");
  });

  it("falls back to the status column when the statusCategory cell is empty", () => {
    const row = ["Task", null, null, null, "review", "", null, null, null];
    const [task] = mapRows([row], fullMapping);
    // statusCategory cell is empty → falls through to status column
    expect(task.status).toBe("review");
  });

  it("defaults status to open when both status columns are empty or unrecognised", () => {
    const row = ["Task", null, null, null, "unknown-status", "", null, null, null];
    const mapping: ColumnMapping = { ...fullMapping, statusCategory: null };
    const [task] = mapRows([row], mapping);
    // 'unknown-status' is not in STATUS_MAP → defaults to 'open'
    expect(task.status).toBe("open");
  });

  it("skips rows that have no title", () => {
    const rows = [
      ["", null, null, null, null, null, null, null, null],      // empty → skipped
      [null, null, null, null, null, null, null, null, null],    // null  → skipped
      ["Valid task", null, null, null, null, null, null, null, null],
    ];
    const result = mapRows(rows, fullMapping);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Valid task");
  });

  it("truncates titles longer than 255 characters", () => {
    const longTitle = "A".repeat(300);
    const row = [longTitle, null, null, null, null, null, null, null, null];
    const [task] = mapRows([row], fullMapping);
    expect(task.title).toHaveLength(255);
    expect(task.title).toBe("A".repeat(255));
  });

  it("parses DD.MM.YYYY date format", () => {
    const row = ["Task", null, null, null, null, null, null, "25.12.2024", null];
    const [task] = mapRows([row], fullMapping);
    expect(task.dueAt).toBe(new Date("2024-12-25").toISOString());
  });

  it("parses DD.MM.YYYY HH:mm date format (time portion is ignored)", () => {
    const row = ["Task", null, null, null, null, null, null, "25.12.2024 10:30", null];
    const [task] = mapRows([row], fullMapping);
    expect(task.dueAt).toBe(new Date("2024-12-25").toISOString());
  });

  it("parses ISO date strings", () => {
    const isoDate = "2024-06-15T00:00:00.000Z";
    const row = ["Task", null, null, null, null, null, null, isoDate, null];
    const [task] = mapRows([row], fullMapping);
    expect(task.dueAt).toBe(new Date(isoDate).toISOString());
  });

  it("returns undefined dueAt for an empty date cell", () => {
    const row = ["Task", null, null, null, null, null, null, "", null];
    const [task] = mapRows([row], fullMapping);
    expect(task.dueAt).toBeUndefined();
  });

  it("returns undefined dueAt for an unparseable date string", () => {
    // Triggers the !isNaN false branch (new Date('not-a-date') is Invalid Date)
    // and the final `return undefined` at the end of parseDate.
    const row = ["Task", null, null, null, null, null, null, "not-a-date", null];
    const [task] = mapRows([row], fullMapping);
    expect(task.dueAt).toBeUndefined();
  });

  it("returns undefined dueAt for a whitespace-only date string (defensive parseDate guard on line 93)", () => {
    // A truthy value ("   ") passes the !value check but String(v).trim() = ""
    // which hits the `if (!s) return undefined` guard (line 93) in parseDate.
    const row = ["Task", null, null, null, null, null, null, "   ", null];
    const [task] = mapRows([row], fullMapping);
    expect(task.dueAt).toBeUndefined();
  });

  it("returns undefined dueAt when the dueAt mapping is null", () => {
    const mapping: ColumnMapping = { ...fullMapping, dueAt: null };
    const row = ["Task", null, null, null, null, null, null, "25.12.2024", null];
    const [task] = mapRows([row], mapping);
    expect(task.dueAt).toBeUndefined();
  });

  it("splits labels on commas", () => {
    const row = ["Task", null, null, null, null, null, null, null, "alpha,beta,gamma"];
    const [task] = mapRows([row], fullMapping);
    expect(task.labels).toEqual(expect.arrayContaining(["alpha", "beta", "gamma"]));
  });

  it("splits labels on semicolons", () => {
    const row = ["Task", null, null, null, null, null, null, null, "alpha;beta;gamma"];
    const [task] = mapRows([row], fullMapping);
    expect(task.labels).toEqual(expect.arrayContaining(["alpha", "beta", "gamma"]));
  });

  it("mixes comma and semicolon delimiters in labels", () => {
    const row = ["Task", null, null, null, null, null, null, null, "alpha,beta;gamma"];
    const [task] = mapRows([row], fullMapping);
    expect(task.labels).toEqual(expect.arrayContaining(["alpha", "beta", "gamma"]));
  });

  it("prefixes the issueType as a type: label and lowercases it", () => {
    const row = ["Task", null, null, null, null, null, "Story", null, null];
    const [task] = mapRows([row], fullMapping);
    expect(task.labels).toContain("type:story");
  });

  it("omits the type: label when issueType is empty", () => {
    const row = ["Task", null, null, null, null, null, "", null, null];
    const [task] = mapRows([row], fullMapping);
    expect(task.labels.some((l) => l.startsWith("type:"))).toBe(false);
  });

  it("returns undefined externalRef when the externalRef cell is empty", () => {
    const row = ["Task", "", null, null, null, null, null, null, null];
    const [task] = mapRows([row], fullMapping);
    expect(task.externalRef).toBeUndefined();
  });

  it("returns undefined description when the description cell is empty", () => {
    const row = ["Task", null, "", null, null, null, null, null, null];
    const [task] = mapRows([row], fullMapping);
    expect(task.description).toBeUndefined();
  });

  it("handles an empty rows array without throwing", () => {
    const result = mapRows([], fullMapping);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getMappingCompleteness
// ---------------------------------------------------------------------------

describe("getMappingCompleteness", () => {
  it("reports all 9 fields as mapped when every index is set", () => {
    const mapping: ColumnMapping = {
      title: 0,
      externalRef: 1,
      description: 2,
      priority: 3,
      status: 4,
      statusCategory: 5,
      issueType: 6,
      dueAt: 7,
      labels: 8,
    };
    const { mapped, unmapped } = getMappingCompleteness(mapping);
    expect(mapped).toHaveLength(9);
    expect(unmapped).toHaveLength(0);
    expect(mapped).toContain("title");
  });

  it("reports only title as mapped when the rest are null", () => {
    const mapping: ColumnMapping = {
      title: 0,
      externalRef: null,
      description: null,
      priority: null,
      status: null,
      statusCategory: null,
      issueType: null,
      dueAt: null,
      labels: null,
    };
    const { mapped, unmapped } = getMappingCompleteness(mapping);
    expect(mapped).toEqual(["title"]);
    expect(unmapped).toHaveLength(8);
    expect(unmapped).not.toContain("title");
  });

  it("reports all 9 fields as unmapped when every index is null", () => {
    const mapping: ColumnMapping = {
      title: null,
      externalRef: null,
      description: null,
      priority: null,
      status: null,
      statusCategory: null,
      issueType: null,
      dueAt: null,
      labels: null,
    };
    const { mapped, unmapped } = getMappingCompleteness(mapping);
    expect(mapped).toHaveLength(0);
    expect(unmapped).toHaveLength(9);
    expect(unmapped).toContain("title");
  });

  it("title appears before optional fields in the mapped array (required-first ordering)", () => {
    const mapping: ColumnMapping = {
      title: 0,
      externalRef: 1,
      description: null,
      priority: null,
      status: null,
      statusCategory: null,
      issueType: null,
      dueAt: null,
      labels: null,
    };
    const { mapped } = getMappingCompleteness(mapping);
    expect(mapped[0]).toBe("title");
    expect(mapped[1]).toBe("externalRef");
  });
});
