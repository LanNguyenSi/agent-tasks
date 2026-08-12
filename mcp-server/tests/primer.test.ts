import { describe, it, expect } from "vitest";
import { HANDSHAKE_PRIMER, WORKFLOW_PRIMER } from "../src/primer.js";
import { DEFAULT_WORKFLOW_STATES } from "../src/default-workflow.js";
import { buildTools } from "../src/tools.js";
import { AgentTasksClient } from "../src/client.js";

// docs/response-contract-v1.md's "Onboarding channels by rate of change" table:
// HANDSHAKE_PRIMER targets ~300-500 tokens with a HARD budget of 2000 chars
// (character-count proxy for token count, same convention as
// receipt.test.ts's TIER1_BUDGET_CHARS / TIER2_BUDGET_CHARS).
const HANDSHAKE_PRIMER_HARD_BUDGET_CHARS = 2000;

// Every verb name either primer mentions must be one this server actually
// registers, derived from buildTools (not hardcoded), so the primer text and
// the real tool surface can never silently diverge. Matches on the
// underscore-joined verb-name families this package uses
// (task_*, tasks_*, project_*, projects_*, workflow_*, signals_*, review_*,
// pull_requests_*); this deliberately does NOT match other underscore-joined
// words in the prose that are not verb names (e.g. the state name
// `in_progress`, or the error code `cross_repo_pr_rejected`), since none of
// those start with a registered verb-name prefix.
const VERB_NAME_PATTERN =
  /\b(?:task|tasks|project|projects|workflow|signals|review|pull_requests)_[a-z_]+\b/g;

function registeredVerbNames(): Set<string> {
  const client = new AgentTasksClient({ baseUrl: "https://example.test", token: "tok" });
  return new Set(buildTools(client).map((t) => t.name));
}

function mentionedVerbNames(text: string): string[] {
  return Array.from(new Set(text.match(VERB_NAME_PATTERN) ?? []));
}

describe("HANDSHAKE_PRIMER (initialize.instructions)", () => {
  it(`is <= ${HANDSHAKE_PRIMER_HARD_BUDGET_CHARS} chars (hard budget; measured ${HANDSHAKE_PRIMER.length})`, () => {
    expect(HANDSHAKE_PRIMER.length).toBeLessThanOrEqual(HANDSHAKE_PRIMER_HARD_BUDGET_CHARS);
  });

  it("carries no per-task data (no UUID-shaped taskId)", () => {
    expect(HANDSHAKE_PRIMER).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("has no em dashes", () => {
    expect(HANDSHAKE_PRIMER).not.toContain("—");
  });

  it("states the lifecycle in the actual default-workflow state order, derived not hardcoded", () => {
    const order = DEFAULT_WORKFLOW_STATES.map((s) => s.name).join(" -> ");
    expect(HANDSHAKE_PRIMER).toContain(order);
  });

  it("points to workflow_primer and projects_get_effective_gates", () => {
    expect(HANDSHAKE_PRIMER).toContain("workflow_primer");
    expect(HANDSHAKE_PRIMER).toContain("projects_get_effective_gates");
  });

  it("does not claim task_start returns the full task (contradicts receipt defaults)", () => {
    expect(HANDSHAKE_PRIMER).not.toMatch(/task_start returns the full task/i);
  });

  it("mentions only verb names that are actually registered", () => {
    const registered = registeredVerbNames();
    for (const name of mentionedVerbNames(HANDSHAKE_PRIMER)) {
      expect(registered.has(name)).toBe(true);
    }
  });
});

describe("WORKFLOW_PRIMER (workflow_primer verb)", () => {
  it("is deterministic across repeated reads", () => {
    expect(WORKFLOW_PRIMER).toBe(WORKFLOW_PRIMER);
    // Re-import identity: a plain module-level const, so two reads in the
    // same process are always the same string. Pinned as a regression guard
    // against the exported value drifting between builds.
    expect(WORKFLOW_PRIMER).toMatchSnapshot();
  });

  it("has no em dashes", () => {
    expect(WORKFLOW_PRIMER).not.toContain("—");
  });

  it("carries no per-task data (no UUID-shaped taskId)", () => {
    expect(WORKFLOW_PRIMER).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("reuses every DEFAULT_WORKFLOW_STATES agentInstructions string verbatim (single source, no third copy)", () => {
    for (const state of DEFAULT_WORKFLOW_STATES) {
      expect(WORKFLOW_PRIMER).toContain(state.agentInstructions);
    }
  });

  it("describes task_start's default as a receipt + per-task slice, not the full task (matches the Named exception in docs/response-contract-v1.md)", () => {
    expect(WORKFLOW_PRIMER).toMatch(/task_start:\s+a receipt plus a small per-task slice/);
    expect(WORKFLOW_PRIMER).not.toMatch(/task_start returns the full task/i);
  });

  it("describes task_pickup's default as the full spec without comments (matches the one write-verb exception in docs/response-contract-v1.md)", () => {
    expect(WORKFLOW_PRIMER).toMatch(/task_pickup:\s+the full task spec, without comments/);
  });

  it("does not present the future teaching-error catalog (code/recipe/allowedNext) as already implemented", () => {
    expect(WORKFLOW_PRIMER).toMatch(/planned for a future release/i);
    expect(WORKFLOW_PRIMER).not.toMatch(/"recipe":|"allowedNext":/);
  });

  it("mentions only verb names that are actually registered", () => {
    const registered = registeredVerbNames();
    for (const name of mentionedVerbNames(WORKFLOW_PRIMER)) {
      expect(registered.has(name)).toBe(true);
    }
  });
});
