/**
 * Coverage for the id-aware task search predicate: `looksLikeIdFragment`
 * gates the id-prefix branch onto hex/UUID-shaped queries only, and
 * `matchesTaskSearch` OR's that branch onto the existing title/description/
 * externalRef/labels text search used by the dashboard's client-side filter
 * (frontend/src/app/dashboard/page.tsx).
 */
import { describe, it, expect } from "vitest";

import type { Task } from "./api";
import {
  looksLikeIdFragment,
  matchesTaskSearch,
  normalizeIdQuery,
  ID_FRAGMENT_GATE,
} from "./taskDisplay";

// Minimal Task factory: only the fields the predicate reads are
// meaningful; the rest are filled so the object satisfies the type.
function task(over: Partial<Task> & { id: string; title: string }): Task {
  return {
    projectId: "p-1",
    description: null,
    status: "open",
    priority: "MEDIUM",
    templateData: null,
    claimedByUserId: null,
    claimedByAgentId: null,
    claimedAt: null,
    dueAt: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    result: null,
    externalRef: null,
    labels: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attachments: [],
    ...over,
  } as Task;
}

describe("looksLikeIdFragment", () => {
  it("accepts a full lowercase UUID", () => {
    expect(looksLikeIdFragment("8f30a6f3-1234-4abc-9def-000000000000")).toBe(true);
  });

  it("accepts an 8-char hex prefix (the short id shown in the UI)", () => {
    expect(looksLikeIdFragment("8f30a6f3")).toBe(true);
  });

  it("accepts a hex fragment at the 4-char minimum, case-insensitively", () => {
    expect(looksLikeIdFragment("DEAD")).toBe(true);
    expect(looksLikeIdFragment("cafe")).toBe(true);
  });

  it("rejects a fragment below the 4-char minimum", () => {
    expect(looksLikeIdFragment("dea")).toBe(false);
    expect(looksLikeIdFragment("")).toBe(false);
  });

  it("rejects text that is not hex/dash-only, even if 4+ chars", () => {
    expect(looksLikeIdFragment("onboarding")).toBe(false);
    expect(looksLikeIdFragment("face plant")).toBe(false); // contains a space
    expect(looksLikeIdFragment("zzzz")).toBe(false); // z is not a hex digit
  });
});

describe("matchesTaskSearch", () => {
  const t = task({
    id: "8f30a6f3-1234-4abc-9def-000000000000",
    title: "Fix the login flow",
    description: "Users report the deadbolt lock icon never disappears.",
  });

  it("matches on an empty query (no filter applied)", () => {
    expect(matchesTaskSearch(t, "")).toBe(true);
    expect(matchesTaskSearch(t, "   ")).toBe(true);
  });

  it("matches an ordinary title substring, case-insensitively", () => {
    expect(matchesTaskSearch(t, "login")).toBe(true);
    expect(matchesTaskSearch(t, "LOGIN")).toBe(true);
  });

  it("still matches title text that happens to be hex-shaped (e.g. 'dead' in 'deadbolt')", () => {
    // "dead" is inside the description ("deadbolt"): the text branch alone
    // finds it; the id branch never needs to run to explain this match.
    expect(matchesTaskSearch(t, "dead")).toBe(true);
  });

  it("matches the full task UUID", () => {
    expect(matchesTaskSearch(t, t.id)).toBe(true);
  });

  it("matches an 8-char id prefix even though it appears nowhere in the title/description", () => {
    expect(matchesTaskSearch(t, "8f30a6f3")).toBe(true);
  });

  it("id-prefix matching is case-insensitive", () => {
    expect(matchesTaskSearch(t, "8F30A6F3")).toBe(true);
  });

  it("does not match an id prefix belonging to a different task", () => {
    expect(matchesTaskSearch(t, "ffffffff")).toBe(false);
  });

  it("does not match a hex-shaped query below the 4-char minimum unless it's also a text hit", () => {
    expect(matchesTaskSearch(t, "8f3")).toBe(false);
  });

  it("does not match unrelated text", () => {
    expect(matchesTaskSearch(t, "billing export")).toBe(false);
  });

  // Copy-paste round-trip: the short-id chip (tasks/page.tsx,
  // dashboard/TaskListView.tsx) renders a trailing ellipsis. Depending on
  // the browser, selecting/copying the chip can carry that ellipsis into
  // the clipboard even though it's meant to be presentational-only (CSS
  // ::after, globals.css); matchesTaskSearch normalizes it away via
  // normalizeIdQuery so a pasted "8f30a6f3…" (or "8f30a6f3...") still
  // finds the task.
  it("matches an id prefix pasted with a trailing unicode ellipsis", () => {
    expect(matchesTaskSearch(t, "8f30a6f3…")).toBe(true);
  });

  it("matches an id prefix pasted with a trailing ASCII ellipsis ('...')", () => {
    expect(matchesTaskSearch(t, "8f30a6f3...")).toBe(true);
  });
});

describe("normalizeIdQuery", () => {
  it("strips a trailing unicode ellipsis", () => {
    expect(normalizeIdQuery("8f30a6f3…")).toBe("8f30a6f3");
  });

  it("strips a trailing ASCII ellipsis ('...')", () => {
    expect(normalizeIdQuery("8f30a6f3...")).toBe("8f30a6f3");
  });

  it("strips other trailing non-hex/dash characters", () => {
    expect(normalizeIdQuery("8f30a6f3!!")).toBe("8f30a6f3");
  });

  it("leaves an already-clean hex/dash query untouched", () => {
    expect(normalizeIdQuery("8f30a6f3-1234-4abc-9def-000000000000")).toBe(
      "8f30a6f3-1234-4abc-9def-000000000000",
    );
  });

  it("does not touch interior characters, only a trailing run", () => {
    expect(normalizeIdQuery("onboarding flow")).toBe("onboarding f");
  });
});

describe("ID_FRAGMENT_GATE regex source (guard test)", () => {
  // Pins the exact regex source so an accidental edit here is caught by a
  // failing assertion rather than a silent drift. Cross-reference: this
  // regex is mirrored in backend/src/routes/tasks.ts's ID_FRAGMENT_GATE —
  // if you change one, change the other and update both pinned strings.
  it("matches the mirrored backend/src/routes/tasks.ts ID_FRAGMENT_GATE source", () => {
    expect(String(ID_FRAGMENT_GATE)).toBe("/^[0-9a-f][0-9a-f-]{3,35}$/i");
  });

  it("requires a leading hex digit — a leading dash is rejected", () => {
    expect(looksLikeIdFragment("-8f30a6f3")).toBe(false);
  });

  it("caps the length at 36 (a full UUID fits; longer does not)", () => {
    expect(looksLikeIdFragment("8f30a6f3-1234-4abc-9def-000000000000")).toBe(true); // 36 chars
    expect(looksLikeIdFragment("8f30a6f3-1234-4abc-9def-0000000000000")).toBe(false); // 37 chars
  });
});
