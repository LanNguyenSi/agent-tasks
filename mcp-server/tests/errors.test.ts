import { describe, it, expect } from "vitest";
import {
  mapBackendError,
  serializeTeachingError,
  looksLikeStructuredWrapper,
  resultMustBePlainStringError,
  projectAddressingConflictError,
  unknownProjectSlugError,
  KNOWN_RULE_CORRECTIVES,
  type TeachingError,
} from "../src/errors.js";
import { serializeResult } from "../src/server.js";
import { buildTools } from "../src/tools.js";
import { AgentTasksClient } from "../src/client.js";
// Same cross-workspace test-only import idiom as
// tests/default-workflow.test.ts: the real source of truth for the
// TransitionRule set and its diagnostic prose is the backend, not a
// hand-typed copy in this package. Never reaches `npm run build`'s tsc
// output (mcp-server's tsconfig.json excludes `tests/`).
import { RULE_MESSAGES } from "../../backend/src/services/transition-rules.js";

// docs/response-contract-v1.md's "Error shape (block tier)" section: sized
// to teach, not a payload cap, but the task_start Named exception's own
// budget (1200 emitted chars) is reused here as the ceiling for a worst-case
// error fixture, same convention receipt.test.ts uses (character-count
// proxy for token count, measured through serializeResult exactly as the
// wire format).
const ERROR_BUDGET_CHARS = 1200;

function registeredVerbNames(): Set<string> {
  const client = new AgentTasksClient({ baseUrl: "https://example.test", token: "tok" });
  return new Set(buildTools(client).map((t) => t.name));
}

// rc-v1-C007: tasks_transition, tasks_update, and tasks_claim (the three
// verbContext values the it.each loop below drives) are legacy-only now,
// pruned from the DEFAULT buildTools() result (tools.ts's
// LEGACY_VERB_NAMES). mapBackendError's precondition_failed branch still
// legitimately names them in allowedNext/recipe when threaded through as
// verbContext, since that only happens when the corresponding legacy verb's
// own handler actually raised the error (only reachable with
// AGENT_TASKS_MCP_LEGACY=1). The consistency assert for those three cases
// therefore runs against the LEGACY-mode registered set, not the
// module-level default-mode `registered` set every other
// assertAllowedNextRegistered call in this file uses.
function legacyRegisteredVerbNames(): Set<string> {
  const client = new AgentTasksClient({ baseUrl: "https://example.test", token: "tok" });
  return new Set(buildTools(client, { legacy: true }).map((t) => t.name));
}

// Acceptance criterion: "allowedNext contains only actually-registered verb
// names (consistency assert against buildTools-derived list)".
function assertAllowedNextRegistered(err: TeachingError, registered: Set<string>): void {
  for (const verb of err.error.allowedNext) {
    expect(registered.has(verb), `allowedNext verb "${verb}" is not a registered tool`).toBe(true);
  }
}

// rc-v1-C005 round 2 review, finding #3 (drift guard): KNOWN_RULE_CORRECTIVES
// hand-authors a short corrective for each of the four real TransitionRule
// values. Nothing previously checked that its key set actually stayed in
// sync with the real backend's own rule set (RULE_MESSAGES, backend/src/
// services/transition-rules.ts) -- a future rule addition there could go
// unnoticed here indefinitely, silently falling back to the truncating
// clamp for the new rule instead of getting its own corrective. This
// compares the KEY SETS directly against the imported (not hand-copied)
// backend export.
describe("KNOWN_RULE_CORRECTIVES stays in sync with the backend's real TransitionRule set", () => {
  it("has exactly the same keys as RULE_MESSAGES (backend/src/services/transition-rules.ts)", () => {
    expect(Object.keys(KNOWN_RULE_CORRECTIVES).sort()).toEqual(Object.keys(RULE_MESSAGES).sort());
  });
});

describe("mapBackendError catalog", () => {
  const registered = registeredVerbNames();

  // ── 1. not_claimed ─────────────────────────────────────────────────────
  it("not_claimed: task_finish's own 403 wording maps to code/recipe/allowedNext", () => {
    const err = mapBackendError(403, {
      error: "forbidden",
      message:
        "You do not hold a claim on this task. Call task_start to claim it before task_finish, even if you just finished an unrelated task in the same session.",
    });
    expect(err.error.code).toBe("not_claimed");
    expect(err.error.recipe).toBe("call task_start to claim this task first");
    expect(err.error.allowedNext).toEqual(["task_start"]);
    assertAllowedNextRegistered(err, registered);
  });

  it("not_claimed: matches task_submit_pr's own 'work claim' wording", () => {
    const err = mapBackendError(403, {
      error: "forbidden",
      message: "You do not hold a work claim on this task. Call task_start to claim it before task_submit_pr.",
    });
    expect(err.error.code).toBe("not_claimed");
  });

  it("not_claimed: matches task_abandon's own wording", () => {
    const err = mapBackendError(403, {
      error: "forbidden",
      message:
        "You do not hold a claim on this task. There is nothing to abandon; call task_start first if you intended to pick this task up.",
    });
    expect(err.error.code).toBe("not_claimed");
  });

  // ── 2. already_claimed ──────────────────────────────────────────────────
  it("already_claimed: the 409 claim wall maps to a finish/abandon recipe", () => {
    const err = mapBackendError(409, {
      error: "already_claimed",
      message: "You already hold an active claim. Call task_finish or task_abandon on it before picking up new work.",
      activeClaim: { taskId: "t1", title: "x", role: "author" },
    });
    expect(err.error.code).toBe("already_claimed");
    expect(err.error.allowedNext).toEqual(["task_finish", "task_abandon"]);
    assertAllowedNextRegistered(err, registered);
  });

  // ── 3. precondition_failed ──────────────────────────────────────────────
  it("precondition_failed: a branch/PR gate failing names task_submit_pr and lists rules structured, with the known rule's own-authored corrective as detail.failed[].message (not the backend's raw text)", () => {
    // rc-v1-C005 review round 1, finding #4: DETAIL_ENTRY_CHAR_BUDGET (60
    // chars) truncated the real backend RULE_MESSAGES text exactly where
    // the instruction half of the sentence started, so a caller reading
    // detail.failed[].message got the diagnosis but never the fix. For
    // branchPresent/prPresent/ciGreen/prMerged specifically, the emitted
    // message is now a short, own-authored corrective instead of a
    // (possibly truncated) passthrough of whatever the backend sent -- see
    // errors.ts's KNOWN_RULE_CORRECTIVES. The dedicated real-4-gate budget
    // test below proves this holds for the actual RULE_MESSAGES text, not
    // just this short synthetic fixture.
    const err = mapBackendError(
      422,
      {
        error: "precondition_failed",
        message: "Transition blocked: No branch recorded on this task.",
        failed: [
          { rule: "branchPresent", message: "No branch recorded." },
          { rule: "prPresent", message: "No pull request recorded." },
        ],
        canForce: false,
      },
      "task_finish",
    );
    expect(err.error.code).toBe("precondition_failed");
    expect(err.error.recipe).toContain("task_submit_pr");
    expect(err.error.allowedNext).toEqual(["task_submit_pr", "task_finish"]);
    expect(err.error.detail?.failed).toEqual([
      { rule: "branchPresent", message: "record the branch via task_submit_pr" },
      { rule: "prPresent", message: "create the PR then task_submit_pr" },
    ]);
    expect(err.error.detail?.totalFailed).toBe(2);
    assertAllowedNextRegistered(err, registered);
  });

  it("precondition_failed: an unknown/future rule not in the known-corrective map falls back to a truncating clamp of the backend's own message, visibly truncated, never silently", () => {
    // Fallback path for KNOWN_RULE_CORRECTIVES's unconditional-clamp
    // property: the four REAL rules never hit this path any more (they get
    // a whole corrective instead), but a rule this module does not know
    // about -- a future backend addition, or a malformed/spoofed fixture --
    // must still be bounded.
    const err = mapBackendError(
      422,
      {
        error: "precondition_failed",
        failed: [
          {
            rule: "someFutureRule",
            message:
              "A very long backend-authored explanation of a brand-new workflow gate that easily exceeds the sixty character per-entry budget this module enforces.",
          },
        ],
      },
      "task_finish",
    );
    const detailFailed = err.error.detail?.failed as Array<{ rule: string; message: string }>;
    expect(detailFailed[0].rule).toBe("someFutureRule");
    expect(detailFailed[0].message.endsWith("...")).toBe(true);
    expect(detailFailed[0].message.length).toBeLessThanOrEqual(60);
    expect(err.error.detail?.totalFailed).toBe(1);
  });

  it("precondition_failed: an optional per-rule `error` field (present today on ciGreen/prMerged when the underlying GitHub call itself failed) is included, clamped, when the backend sends one", () => {
    // The only thing distinguishing "CI is red" from "GitHub was
    // unreachable" on ciGreen/prMerged -- silently dropped before this fix.
    const err = mapBackendError(
      422,
      {
        error: "precondition_failed",
        failed: [{ rule: "ciGreen", message: "CI is not green on the PR.", error: "GitHub API request timed out" }],
      },
      "task_finish",
    );
    const detailFailed = err.error.detail?.failed as Array<{ rule: string; message: string; error?: string }>;
    expect(detailFailed[0].error).toBe("GitHub API request timed out");
  });

  it("precondition_failed: a failed entry with no `error` field omits the key entirely (not error: undefined)", () => {
    const err = mapBackendError(
      422,
      { error: "precondition_failed", failed: [{ rule: "ciGreen", message: "CI is not green on the PR." }] },
      "task_finish",
    );
    const detailFailed = err.error.detail?.failed as Array<Record<string, unknown>>;
    expect("error" in detailFailed[0]).toBe(false);
  });

  it("precondition_failed: the real backend's 4-gate worst case (all TransitionRule values failing at once, actual RULE_MESSAGES text) keeps every corrective whole and stays within the error budget", () => {
    // Built directly from the imported RULE_MESSAGES (backend/src/services/
    // transition-rules.ts), not a hand-copied string -- rc-v1-C005 round 2
    // review, finding #3: a hand-copy can silently drift from the real
    // backend text without failing here. This is the actual worst case the
    // live backend can ever send on this route (the real TransitionRule set:
    // branchPresent/prPresent/ciGreen/prMerged), unlike the synthetic
    // fixtures the other tests in this file use.
    const failed = (Object.keys(RULE_MESSAGES) as Array<keyof typeof RULE_MESSAGES>).map((rule) => ({
      rule,
      message: RULE_MESSAGES[rule],
    }));
    const err = mapBackendError(422, { error: "precondition_failed", failed }, "task_finish");
    const detailFailed = err.error.detail?.failed as Array<{ rule: string; message: string }>;
    expect(detailFailed).toEqual([
      { rule: "branchPresent", message: "record the branch via task_submit_pr" },
      { rule: "prPresent", message: "create the PR then task_submit_pr" },
      { rule: "ciGreen", message: "wait for CI to pass on the PR" },
      { rule: "prMerged", message: "merge the PR first" },
    ]);
    expect(err.error.detail?.totalFailed).toBe(4);
    const serialized = serializeResult(err);
    expect(serialized.length).toBeLessThanOrEqual(1200);
  });

  it("precondition_failed: only ciGreen/prMerged failing does not name task_submit_pr", () => {
    const err = mapBackendError(
      422,
      { error: "precondition_failed", failed: [{ rule: "ciGreen", message: "CI is not green on the PR." }] },
      "task_finish",
    );
    expect(err.error.recipe).not.toContain("task_submit_pr");
    expect(err.error.allowedNext).toEqual(["task_finish"]);
  });

  it("precondition_failed: verbContext changes the retry verb named in allowedNext/recipe", () => {
    const err = mapBackendError(
      422,
      { error: "precondition_failed", failed: [{ rule: "ciGreen", message: "..." }] },
      "task_start",
    );
    expect(err.error.allowedNext).toEqual(["task_start"]);
    expect(err.error.recipe).toContain("task_start");
  });

  it("precondition_failed: defaults to task_finish as the retry verb when no verbContext is supplied", () => {
    const err = mapBackendError(422, { error: "precondition_failed", failed: [{ rule: "ciGreen" }] });
    expect(err.error.allowedNext).toEqual(["task_finish"]);
  });

  // Every wrap() call site that actually threads verbContext through for
  // this error (tools.ts: task_start and task_finish are pinned above by
  // name; the remaining three deprecated v1 routes are covered here as a
  // cheap loop rather than three near-duplicate `it` blocks).
  it.each(["tasks_transition", "tasks_update", "tasks_claim"] as const)(
    "precondition_failed: verbContext '%s' is named in both allowedNext and the recipe",
    (verb) => {
      const err = mapBackendError(
        422,
        { error: "precondition_failed", failed: [{ rule: "ciGreen", message: "..." }] },
        verb,
      );
      expect(err.error.allowedNext).toEqual([verb]);
      expect(err.error.recipe).toContain(verb);
      assertAllowedNextRegistered(err, legacyRegisteredVerbNames());
    },
  );

  it("precondition_failed: many failing gates clamp to 5 detail entries plus totalFailed (worst-case fixture), and the whole response stays under budget", () => {
    // TransitionRule only has 4 real values on the live backend
    // (branchPresent/prPresent/ciGreen/prMerged); this fixture is
    // deliberately synthetic (12 entries, each with an oversized message)
    // to prove the clamp holds unconditionally, same convention as
    // receipt.ts's WORKFLOW_GATE_SKIPPED clamp test.
    const failed = Array.from({ length: 12 }, (_, i) => ({
      rule: `syntheticRule${i}`,
      message: "x".repeat(200),
    }));
    const err = mapBackendError(422, { error: "precondition_failed", failed }, "task_finish");
    const detailFailed = err.error.detail?.failed as Array<{ rule: string; message: string }>;
    expect(detailFailed).toHaveLength(5);
    expect(err.error.detail?.totalFailed).toBe(12);
    for (const entry of detailFailed) {
      expect(entry.message.length).toBeLessThanOrEqual(60);
    }
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
  });

  // rc-v1-C005 round 2 review, finding #2+#3 (structural): the fixture above
  // clamps to 5 entries but never carries the optional per-rule `error`
  // field alongside rule/message -- the round 2 review measured the
  // combined shape (5 entries, each with rule+message+error all near their
  // own 60-char field clamp) at 1559 SERIALIZED chars, over budget, even
  // though every individual field stayed within DETAIL_ENTRY_CHAR_BUDGET.
  // This is the aggregate-bound regression pin: buildTeachingError's own
  // enforceErrorBudget step (errors.ts) must catch what the per-field clamp
  // alone cannot, by re-clamping `detail` harder -- visibly (fewer entries
  // than the normal DETAIL_CLAMP=5 survive, but totalFailed still reports
  // the true, un-shrunk count, so the degrade is never silent).
  it("precondition_failed: the worst case WITH per-rule error fields stays within budget via the aggregate bound (round 2 finding: per-field clamps alone measured 1559 chars)", () => {
    const failed = Array.from({ length: 12 }, (_, i) => ({
      rule: `syntheticRule${i}`,
      message:
        "A very long backend-authored explanation of a brand-new workflow gate that easily exceeds the sixty character budget, entry " +
        i,
      error: "GitHub API request timed out with a fairly long diagnostic explanation attached, entry " + i,
    }));
    const err = mapBackendError(422, { error: "precondition_failed", failed }, "task_finish");
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
    const detailFailed = err.error.detail?.failed as Array<{ rule: string; message: string; error?: string }>;
    // The aggregate bound degraded further than the normal per-field clamp
    // alone (fewer than DETAIL_CLAMP=5 entries survive), visibly: totalFailed
    // still reports the true original count (12), not the shrunk count.
    expect(detailFailed.length).toBeLessThan(5);
    expect(err.error.detail?.totalFailed).toBe(12);
  });

  // ── 4. cross_repo_pr_rejected ───────────────────────────────────────────
  it("cross_repo_pr_rejected: the 400 maps to a task_submit_pr recipe by default (no verbContext, or task_finish/tasks_update)", () => {
    const err = mapBackendError(400, {
      error: "cross_repo_pr_rejected",
      message: "PR points at other/repo, expected acme/agent-tasks.",
    });
    expect(err.error.code).toBe("cross_repo_pr_rejected");
    expect(err.error.allowedNext).toEqual(["task_submit_pr"]);
    assertAllowedNextRegistered(err, registered);
  });

  it("cross_repo_pr_rejected: verbContext 'pull_requests_create' names pull_requests_create instead of task_submit_pr, since that caller sent owner/repo, not a prUrl", () => {
    // rc-v1-C005 review round 1, finding #7: the default recipe/allowedNext
    // (task_submit_pr, talking about `prUrl`) misdirects a caller who hit
    // this from pull_requests_create's own emit site
    // (backend/src/routes/github.ts's POST /pull-requests), which never
    // sends a prUrl at all.
    const err = mapBackendError(
      400,
      {
        error: "cross_repo_pr_rejected",
        message: "PR points at other/repo, expected acme/agent-tasks.",
      },
      "pull_requests_create",
    );
    expect(err.error.code).toBe("cross_repo_pr_rejected");
    expect(err.error.recipe).toContain("pull_requests_create");
    expect(err.error.recipe).not.toContain("task_submit_pr");
    expect(err.error.allowedNext).toEqual(["pull_requests_create"]);
    assertAllowedNextRegistered(err, registered);
  });

  // ── 5. pr_author_mismatch ───────────────────────────────────────────────
  it("pr_author_mismatch: the 403 maps to a task_submit_pr recipe", () => {
    const err = mapBackendError(403, {
      error: "pr_author_mismatch",
      message: "PR #7 was created by 'someone-else', not by the delegation user 'bot'.",
    });
    expect(err.error.code).toBe("pr_author_mismatch");
    expect(err.error.allowedNext).toEqual(["task_submit_pr"]);
    assertAllowedNextRegistered(err, registered);
  });

  // ── 6. force_admin_only ─────────────────────────────────────────────────
  it("force_admin_only: non-admin force=true has no self-service allowedNext but a concrete recipe (never 'invalid request')", () => {
    const err = mapBackendError(403, {
      error: "forbidden",
      message: "Only team admins can force a transition",
    });
    expect(err.error.code).toBe("force_admin_only");
    expect(err.error.recipe.toLowerCase()).not.toBe("invalid request");
    expect(err.error.recipe.length).toBeGreaterThan(0);
    expect(err.error.allowedNext).toEqual([]);
    assertAllowedNextRegistered(err, registered);
  });

  // ── 7. respec_conflict ──────────────────────────────────────────────────
  it("respec_conflict: a claimed/non-open task on task_respec maps to task_abandon/task_respec", () => {
    const err = mapBackendError(409, {
      error: "conflict",
      message: "Task must be open and unclaimed to respec",
    });
    expect(err.error.code).toBe("respec_conflict");
    expect(err.error.allowedNext).toEqual(["task_abandon", "task_respec"]);
    assertAllowedNextRegistered(err, registered);
  });

  // ── 9. low_confidence ────────────────────────────────────────────────────
  //
  // rc-v1-C005 review round 1, finding #2: the 422 low_confidence body
  // (backend/src/middleware/error.ts's lowConfidence, via
  // confidence-gate.ts's evaluateConfidenceGate on task_start/tasks_claim)
  // used to fall to the generic degrade and silently drop score/threshold/
  // missing[] -- a net information loss on the highest-traffic verb. Not in
  // the contract's original catalog seed list; added on review.
  it("low_confidence: lifts score/threshold/missing[]/totalMissing from body.details and names task_respec", () => {
    const err = mapBackendError(422, {
      error: "low_confidence",
      message: "Task does not meet confidence threshold for agent claiming",
      details: {
        score: 35,
        threshold: 60,
        missing: ["acceptanceCriteria", "agentPrompt"],
        nextActions: ["add acceptance criteria", "add an agentPrompt"],
      },
    });
    expect(err.error.code).toBe("low_confidence");
    expect(err.error.recipe).toContain("task_respec");
    expect(err.error.allowedNext).toEqual(["task_respec"]);
    expect(err.error.detail).toEqual({
      score: 35,
      threshold: 60,
      missing: ["acceptanceCriteria", "agentPrompt"],
      totalMissing: 2,
    });
    assertAllowedNextRegistered(err, registered);
  });

  it("low_confidence: a details object missing score/threshold omits those keys rather than emitting null/undefined", () => {
    const err = mapBackendError(422, {
      error: "low_confidence",
      message: "Task does not meet confidence threshold for agent claiming",
      details: { missing: ["title"] },
    });
    expect(err.error.detail).toEqual({ missing: ["title"], totalMissing: 1 });
    expect("score" in (err.error.detail as object)).toBe(false);
    expect("threshold" in (err.error.detail as object)).toBe(false);
  });

  it("low_confidence: a missing/malformed body.details still degrades cleanly (no throw), with an empty missing[] and totalMissing 0", () => {
    const err = mapBackendError(422, {
      error: "low_confidence",
      message: "Task does not meet confidence threshold for agent claiming",
    });
    expect(err.error.code).toBe("low_confidence");
    expect(err.error.detail).toEqual({ missing: [], totalMissing: 0 });
  });

  it("low_confidence: many missing fields (worst-case fixture, 9 real scorer field names) clamp missing[] to 5 plus totalMissing, and the whole response stays under budget", () => {
    // backend/src/lib/confidence.ts's scorer can populate up to 9 field
    // names (title, description, goal, acceptanceCriteria, scope,
    // outOfScope, dependencies, risk, agentPrompt) -- same set
    // receipt.ts's confidenceDeviation documents for task_create/respec's
    // own CONFIDENCE_BELOW_THRESHOLD deviation.
    const missing = [
      "title",
      "description",
      "goal",
      "acceptanceCriteria",
      "scope",
      "outOfScope",
      "dependencies",
      "risk",
      "agentPrompt",
    ];
    const err = mapBackendError(422, {
      error: "low_confidence",
      message: "Task does not meet confidence threshold for agent claiming",
      details: { score: 5, threshold: 60, missing },
    });
    expect(err.error.detail?.missing).toHaveLength(5);
    expect(err.error.detail?.totalMissing).toBe(9);
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
  });

  // ── Generic degrade (acceptance criterion: unknown errors degrade
  // structurally) ─────────────────────────────────────────────────────────
  it("an uncataloged backend code/message still gets a structured shape (body code passthrough, message passthrough, recipe -> workflow_primer)", () => {
    const err = mapBackendError(500, { error: "internal_error", message: "boom" });
    expect(err.error.code).toBe("internal_error");
    expect(err.error.message).toBe("boom");
    expect(err.error.recipe).toContain("workflow_primer");
    expect(err.error.allowedNext).toEqual(["workflow_primer"]);
    expect(err.error.detail).toBeUndefined();
    assertAllowedNextRegistered(err, registered);
  });

  // ── Generic degrade: details preservation (rc-v1-C005 review round 1,
  // finding #2b) ────────────────────────────────────────────────────────────
  //
  // Before this fix, ANY uncataloged error with a structured `details`
  // payload silently dropped it -- not just low_confidence (now its own
  // catalog entry above), but every future backend error that carries one.
  it("an uncataloged error with a structured body.details survives into error.detail, clamped, with every key kept (never silently dropped)", () => {
    const err = mapBackendError(423, {
      error: "some_future_code",
      message: "a brand-new backend error this catalog does not know about",
      details: {
        reason: "x".repeat(200),
        candidates: ["a", "b", "c", "d", "e", "f", "g"],
        nested: { note: "y".repeat(100), count: 3 },
        retryable: true,
        attempts: 2,
      },
    });
    expect(err.error.code).toBe("some_future_code");
    const detail = err.error.detail as {
      reason: string;
      candidates: string[];
      nested: { note: string; count: number };
      retryable: boolean;
      attempts: number;
    };
    // Every top-level key survives (no silent drop).
    expect(Object.keys(detail).sort()).toEqual(["attempts", "candidates", "nested", "reason", "retryable"].sort());
    // String clamped (60 chars).
    expect(detail.reason.endsWith("...")).toBe(true);
    expect(detail.reason.length).toBeLessThanOrEqual(60);
    // Array clamped to 5 entries (count itself is not preserved for a
    // generic array the way low_confidence's own totalMissing is -- this
    // is the generic path, which only guarantees length + entry bounds).
    expect(detail.candidates).toHaveLength(5);
    // Nested object preserved (not dropped), its own string clamped.
    expect(detail.nested.note.endsWith("...")).toBe(true);
    expect(detail.nested.count).toBe(3);
    // Primitives pass through unchanged.
    expect(detail.retryable).toBe(true);
    expect(detail.attempts).toBe(2);
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
  });

  it("an uncataloged error whose body.details is an array, a primitive, or absent never sets error.detail at all", () => {
    expect(mapBackendError(500, { error: "x", message: "m", details: [1, 2, 3] }).error.detail).toBeUndefined();
    expect(mapBackendError(500, { error: "x", message: "m", details: "just a string" }).error.detail).toBeUndefined();
    expect(mapBackendError(500, { error: "x", message: "m", details: {} }).error.detail).toBeUndefined();
    expect(mapBackendError(500, { error: "x", message: "m" }).error.detail).toBeUndefined();
  });

  it("a known backend `error` code that is NOT in the catalog passes through as the emitted code (consumers key on it), with http_<status> only as the no-code fallback", () => {
    // bad_state / claim_blocked / self_merge_blocked etc. are real backend
    // codes (backend/src/routes/tasks.ts) outside this catalog's scope. The
    // backend's own code is the most specific signal available and
    // downstream consumers assert on it (mcp-bridge's governance suite
    // pins a 409 claim_blocked staying visible end to end), so the degrade
    // emits it verbatim (clamped) instead of masking it behind the status.
    const err = mapBackendError(409, { error: "bad_state", message: "Task must be in review status" });
    expect(err.error.code).toBe("bad_state");
    const governance = mapBackendError(409, { error: "claim_blocked", message: "Claim blocked by governance mode" });
    expect(governance.error.code).toBe("claim_blocked");
    const noCode = mapBackendError(409, { message: "no code in this body" });
    expect(noCode.error.code).toBe("http_409");
  });

  it("a body with no message field at all still produces a usable message", () => {
    const err = mapBackendError(502, {});
    expect(err.error.message).toBe("request failed with status 502");
  });

  it("a non-object body (e.g. plain text) does not throw and still degrades", () => {
    const err = mapBackendError(500, "internal server error, no json");
    expect(err.error.code).toBe("http_500");
    expect(err.error.message).toBe("request failed with status 500");
  });

  it("clamps a very long backend message so the response stays within budget", () => {
    const longMessage = "x".repeat(5000);
    const err = mapBackendError(400, { error: "bad_request", message: longMessage });
    expect(err.error.message.length).toBeLessThan(5000);
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
  });

  // rc-v1-C005 round 2 review, missing test: a realistic zod .flatten()
  // shaped payload through the generic degrade path. Mirrors the real
  // (non-exported) agentUpdateTaskSchema shape tasks_update's own backend
  // route validates against (backend/src/routes/tasks.ts's PATCH
  // /tasks/:id, agent path: branchName/prUrl/prNumber/result) -- every
  // field invalid at once is the actual worst case that route can send.
  // Structure only (zod's own `{formErrors, fieldErrors}` shape), not a
  // byte-exact import: the schema itself is not exported, so this is a
  // deliberate, documented mirror rather than a drift-guarded import (see
  // the KNOWN_RULE_CORRECTIVES/RULE_MESSAGES drift guard above for the
  // pattern used where the source IS exported).
  it("generic degrade: a realistic zod-flatten payload (tasks_update's own 4-field agentUpdateTaskSchema, every field invalid) stays within budget", () => {
    const flattened = {
      formErrors: [],
      fieldErrors: {
        branchName: ["Expected string, received number"],
        prUrl: ["Invalid url", "URL must use the http or https scheme"],
        prNumber: ["Expected integer, received float", "Number must be greater than 0"],
        result: ["Expected string, received object"],
      },
    };
    const err = mapBackendError(400, { error: "bad_request", message: "Validation failed", details: flattened });
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
    // Small, real-shaped payload: nothing needs to be dropped.
    expect(err.error.detail).toEqual(flattened);
  });

  it("generic degrade: a wide details object (50 keys x 200 chars) clamps key COUNT and key NAMES, with a visible (accurate, un-shrunk) totalKeys marker, and stays within budget", () => {
    const details: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      details[`field_${i}_with_a_fairly_long_descriptive_key_name`] = "v".repeat(200);
    }
    const err = mapBackendError(500, { error: "internal_error", message: "too many fields", details });
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
    // totalKeys reports the TRUE original count (50), not the count of
    // whatever intermediate, already-shrunk object a second clamp pass
    // might otherwise have measured (rc-v1-C005 round 2 fix-round bug,
    // caught and fixed during this same change: an earlier version of this
    // fix reported an inaccurate, much smaller totalKeys after a harder
    // reclamp pass).
    expect(err.error.detail?.totalKeys).toBe(50);
    expect(Object.keys(err.error.detail ?? {}).length).toBeLessThan(51);
  });

  // ── Generic degrade: OBJECT body.error (rc-v1 d9c0c45f) ─────────────────
  //
  // Observed live during rc-v1-C008 (2026-08-12): POST /tasks with an
  // invalid templateData shape (acceptanceCriteria sent as an array, the
  // schema wants a string) 400s with @hono/zod-validator's default (no
  // custom hook) failure body -- a raw zod SafeParseError spread verbatim:
  // `{ success: false, error: { issues: [...], name: "ZodError" } }`, no
  // top-level `details` field at all. Before this fix, an OBJECT body.error
  // matched neither the string-code passthrough nor the body.details clamp
  // path, so the caller got a bare `http_400` with no detail whatsoever.
  // Fixture shape reproduced from a real `createTaskSchema.safeParse` call
  // (zod 3.23), not hand-guessed.
  it("generic degrade: an OBJECT body.error with a zod issues[] array (the real rc-v1-C008 shape) keeps code http_<status> and surfaces path/code/message per issue in detail.issues", () => {
    const err = mapBackendError(400, {
      success: false,
      error: {
        issues: [
          {
            code: "invalid_type",
            expected: "string",
            received: "array",
            path: ["acceptanceCriteria"],
            message: "Expected string, received array",
          },
        ],
        name: "ZodError",
      },
    });
    // An object is not a code: code still falls back to http_<status>, same
    // as the existing "no code at all" fallback.
    expect(err.error.code).toBe("http_400");
    expect(err.error.detail).toEqual({
      issues: [{ path: "acceptanceCriteria", code: "invalid_type", message: "Expected string, received array" }],
      totalIssues: 1,
    });
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
  });

  it("generic degrade: a multi-segment (nested/array-index) zod path is joined into a single dot-separated string rather than a nested array (clampDetailValue's own depth budget would otherwise silently truncate a nested path array)", () => {
    const err = mapBackendError(400, {
      error: {
        issues: [{ code: "invalid_type", path: ["templateData", "tags", 2, "name"], message: "Expected string" }],
      },
    });
    const detail = err.error.detail as { issues: Array<{ path?: string }> } | undefined;
    expect(detail?.issues[0].path).toBe("templateData.tags.2.name");
  });

  it("generic degrade: a STRING body.error still passes through as the code unchanged (regression: the object-body.error handling above must not disturb the existing string-code path)", () => {
    const err = mapBackendError(409, { error: "claim_blocked", message: "Claim blocked by governance mode" });
    expect(err.error.code).toBe("claim_blocked");
    expect(err.error.detail).toBeUndefined();
  });

  it("generic degrade: many/long zod issues clamp to DETAIL_CLAMP entries with path+code+message each truncated, a visible (accurate, un-shrunk) totalIssues marker, and the whole response stays within budget", () => {
    const issues = Array.from({ length: 20 }, (_, i) => ({
      code: "too_small",
      minimum: 1,
      type: "string",
      inclusive: true,
      exact: false,
      path: [`field_${i}`, "nested", "deeply", i],
      message: "A very long backend-authored zod issue message that easily exceeds the sixty character budget, entry " + i,
    }));
    const err = mapBackendError(400, { error: { issues, name: "ZodError" } });
    expect(err.error.code).toBe("http_400");
    const detail = err.error.detail as { issues: Array<{ message?: string }>; totalIssues: number } | undefined;
    expect(detail?.totalIssues).toBe(20);
    for (const issue of detail?.issues ?? []) {
      if (issue.message) expect(issue.message.length).toBeLessThanOrEqual(60);
    }
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
  });

  it("generic degrade: an OBJECT body.error with no recognizable issues[] array still surfaces something (the object itself, clamped) rather than staying completely silent", () => {
    const err = mapBackendError(400, {
      error: { code: "SOME_UPSTREAM_CODE", detail: "an upstream service rejected the request" },
    });
    expect(err.error.code).toBe("http_400");
    expect(err.error.detail).toEqual({
      code: "SOME_UPSTREAM_CODE",
      detail: "an upstream service rejected the request",
    });
  });

  it("generic degrade: a top-level body.details still takes precedence over an object body.error (existing details-passthrough behavior is unaffected)", () => {
    const err = mapBackendError(400, {
      error: { issues: [{ code: "invalid_type", path: ["x"], message: "should not be used" }] },
      message: "Validation failed",
      details: { reason: "top-level details wins" },
    });
    expect(err.error.detail).toEqual({ reason: "top-level details wins" });
  });

  // Every catalog + degrade fixture above stays within budget on its own,
  // not just the deliberately worst-case one.
  it("every catalog entry constructed in this file stays within the error budget", () => {
    const fixtures = [
      mapBackendError(403, { error: "forbidden", message: "You do not hold a claim on this task. Call task_start to claim it before task_finish." }),
      mapBackendError(409, { error: "already_claimed", message: "You already hold an active claim." }),
      mapBackendError(400, { error: "cross_repo_pr_rejected", message: "PR points at other/repo." }),
      mapBackendError(403, { error: "pr_author_mismatch", message: "PR #7 was created by someone else." }),
      mapBackendError(403, { error: "forbidden", message: "Only team admins can force a transition" }),
      mapBackendError(409, { error: "conflict", message: "Task must be open and unclaimed to respec" }),
      mapBackendError(422, {
        error: "low_confidence",
        message: "Task does not meet confidence threshold for agent claiming",
        details: { score: 35, threshold: 60, missing: ["acceptanceCriteria", "agentPrompt"] },
      }),
      resultMustBePlainStringError(),
      resultMustBePlainStringError("tasks_update"),
      projectAddressingConflictError("task_create"),
      unknownProjectSlugError("does-not-exist", "task_create"),
    ];
    for (const fixture of fixtures) {
      expect(serializeResult(fixture).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
    }
  });
});

// ── 10. rc-v1-C006: project_addressing_conflict / unknown_project_slug ──────
//
// Both are client-side-only (raised directly by tools.ts's task_create /
// project_tasks handlers, never by mapBackendError), same pattern as
// resultMustBePlainStringError above.
describe("projectAddressingConflictError / unknownProjectSlugError", () => {
  it("projectAddressingConflictError names the calling verb as its own corrective and carries the aggregate budget invariant", () => {
    const err = projectAddressingConflictError("task_create");
    expect(err.error.code).toBe("project_addressing_conflict");
    expect(err.error.allowedNext).toEqual(["task_create"]);
    expect(err.error.recipe).toContain("task_create");
    assertAllowedNextRegistered(err, registeredVerbNames());
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
  });

  // NOTE: no real tools.ts call site ever invokes projectAddressingConflictError
  // with "project_tasks" as `verb` -- project_tasks (tools.ts) takes a single
  // polymorphic `project` param (slug-or-UUID), never a projectId/projectSlug
  // pair, so the "both provided" / "neither provided" conflict this builder
  // exists for can never actually arise on that verb. This test exercises
  // the builder's own `verb` PARAMETERIZATION in isolation (any string
  // flows through to recipe/allowedNext unchanged), not a real project_tasks
  // code path -- kept as a parameterization-only regression pin, not
  // evidence the error is reachable from project_tasks (rc-v1-C006 round-2
  // review, LOW).
  it("projectAddressingConflictError('project_tasks') names project_tasks instead (builder parameterization only, not a real project_tasks code path)", () => {
    const err = projectAddressingConflictError("project_tasks");
    expect(err.error.allowedNext).toEqual(["project_tasks"]);
    expect(err.error.recipe).toContain("project_tasks");
  });

  // rc-v1-C007: projects_list is legacy-gated now (pruned from the default
  // registration). This entry's real call sites (task_create, project_tasks)
  // both stay default-registered, so `allowedNext` no longer names
  // projects_list unconditionally (it would violate "allowedNext lists only
  // verb names the caller can call immediately" for a default-mode caller);
  // `recipe` still mentions it as the AGENT_TASKS_MCP_LEGACY=1 option,
  // alongside the always-available "ask the operator" fallback.
  it('projectAddressingConflictError(verb, "neither_provided") mentions projects_list in the recipe as the legacy-flag option, but does not put it in allowedNext, distinct from the default "both_provided" wording', () => {
    const err = projectAddressingConflictError("task_create", "neither_provided");
    expect(err.error.code).toBe("project_addressing_conflict");
    expect(err.error.message).toMatch(/neither projectId nor projectSlug/i);
    expect(err.error.recipe).toContain("projects_list");
    expect(err.error.recipe).toContain("AGENT_TASKS_MCP_LEGACY=1");
    expect(err.error.allowedNext).toEqual(["task_create"]);
    assertAllowedNextRegistered(err, registeredVerbNames());
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
  });

  it('projectAddressingConflictError defaults to "both_provided" wording when reason is omitted (backward-compatible call shape)', () => {
    const withDefault = projectAddressingConflictError("task_create");
    const explicit = projectAddressingConflictError("task_create", "both_provided");
    expect(withDefault).toEqual(explicit);
    expect(withDefault.error.message).toMatch(/both provided/i);
  });

  it("unknownProjectSlugError mentions projects_list in the recipe as the legacy-flag option, and includes only the calling verb in allowedNext", () => {
    const err = unknownProjectSlugError("no-such-slug", "task_create");
    expect(err.error.code).toBe("unknown_project_slug");
    expect(err.error.message).toContain("no-such-slug");
    expect(err.error.recipe).toContain("projects_list");
    expect(err.error.recipe).toContain("AGENT_TASKS_MCP_LEGACY=1");
    expect(err.error.allowedNext).toEqual(["task_create"]);
    assertAllowedNextRegistered(err, registeredVerbNames());
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
  });

  it("unknownProjectSlugError('project_tasks') names project_tasks in allowedNext instead of task_create", () => {
    const err = unknownProjectSlugError("no-such-slug", "project_tasks");
    expect(err.error.allowedNext).toEqual(["project_tasks"]);
  });

  it("unknownProjectSlugError stays within budget even for a pathologically long slug", () => {
    const err = unknownProjectSlugError("x".repeat(5000), "task_create");
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
  });
});

// ── 8. task_finish result plain-string guard ────────────────────────────────
describe("resultMustBePlainStringError / looksLikeStructuredWrapper", () => {
  it("detects an XML-tag-wrapped string", () => {
    expect(looksLikeStructuredWrapper("<result>done</result>")).toBe(true);
  });

  it("detects whole-string JSON (object or array)", () => {
    expect(looksLikeStructuredWrapper('{"result":"done"}')).toBe(true);
    expect(looksLikeStructuredWrapper('["done"]')).toBe(true);
  });

  it("does not flag plain prose that merely contains an angle bracket or a brace", () => {
    expect(looksLikeStructuredWrapper("fixed the <Foo> component")).toBe(false);
    expect(looksLikeStructuredWrapper("see {this} note for context")).toBe(false);
  });

  it("does not flag ordinary markdown/prose", () => {
    expect(looksLikeStructuredWrapper("Implemented the feature and added tests.")).toBe(false);
  });

  it("does not flag an empty string", () => {
    expect(looksLikeStructuredWrapper("")).toBe(false);
    expect(looksLikeStructuredWrapper("   ")).toBe(false);
  });

  // rc-v1-C005 round 2 review, finding #1 (MEDIUM): TAG_PAIR_PATTERN's lazy,
  // backtracking-capable inner match can blow up combinatorially on a long,
  // pathological string with many unmatched '<' characters -- measured at
  // ~18.4s scanning a single 400k-char adversarial string through the raw
  // regex before the TAG_SCAN_CHAR_LIMIT guard was added. tools.ts's
  // task_finish and tasks_update both cap `result` at 5000 chars today, but
  // this is a guard-cost test on looksLikeStructuredWrapper itself
  // (independent of any caller's own cap), so a future uncapped caller can
  // never reintroduce the stall unnoticed.
  it("stays fast on a 400k-char adversarial string with no closing tags (guard-cost regression pin for the TAG_PAIR_PATTERN backtracking blowup)", () => {
    const adversarial = "<a ".repeat(133_333).slice(0, 400_000);
    const start = performance.now();
    const result = looksLikeStructuredWrapper(adversarial);
    const elapsed = performance.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(250);
  });

  it("resultMustBePlainStringError names task_finish as the concrete corrective call by default", () => {
    const err = resultMustBePlainStringError();
    expect(err.error.code).toBe("result_not_plain_string");
    expect(err.error.allowedNext).toEqual(["task_finish"]);
    expect(err.error.recipe).toContain("task_finish");
    assertAllowedNextRegistered(err, registeredVerbNames());
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
  });

  it("resultMustBePlainStringError('tasks_update') names tasks_update instead (rc-v1-C005 review round 1, finding #6: tasks_update accepts result but used to skip this guard)", () => {
    const err = resultMustBePlainStringError("tasks_update");
    expect(err.error.code).toBe("result_not_plain_string");
    expect(err.error.allowedNext).toEqual(["tasks_update"]);
    expect(err.error.recipe).toContain("tasks_update");
    expect(err.error.recipe).not.toContain("task_finish");
    // rc-v1-C007: tasks_update is legacy-only now (pruned from the default
    // registration); this builder is only ever called with "tasks_update"
    // from tasks_update's own handler (only reachable under
    // AGENT_TASKS_MCP_LEGACY=1), so the consistency assert runs against the
    // legacy-mode registered set, same reasoning as the precondition_failed
    // it.each loop above.
    assertAllowedNextRegistered(err, legacyRegisteredVerbNames());
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
  });

  // ── rc-v1-C005 review round 1, finding #5: looksLikeStructuredWrapper's
  // boundary was too narrow (missed several common LLM mistakes) AND too
  // wide in one spot (flagged a purely inline formatting tag). These tests
  // pin the NEW detections, the fixed false positive, and the boundary this
  // widening deliberately still does NOT cover (negative space, documented
  // rather than silently absent). ─────────────────────────────────────────
  describe("boundary widening: new detections", () => {
    it("detects two sibling top-level tag pairs (not just a single whole-string wrap)", () => {
      expect(looksLikeStructuredWrapper("<a>x</a><b>y</b>")).toBe(true);
    });

    it("detects a leading tag pair followed by trailing prose", () => {
      expect(looksLikeStructuredWrapper("<result>done</result> plus some trailing notes.")).toBe(true);
    });

    it("detects leading prose followed by a trailing tag pair", () => {
      expect(looksLikeStructuredWrapper("Notes: <result>done</result>")).toBe(true);
    });

    it("detects a fenced code block even when prefaced by prose", () => {
      expect(looksLikeStructuredWrapper('Here is the result:\n```json\n{"ok":true}\n```')).toBe(true);
    });

    it("detects a fenced code block that opens the whole string", () => {
      expect(looksLikeStructuredWrapper("```\nsome code\n```")).toBe(true);
    });

    it("detects an <?xml preamble", () => {
      expect(looksLikeStructuredWrapper('<?xml version="1.0"?><result>done</result>')).toBe(true);
    });
  });

  describe("boundary widening: fixed false positive", () => {
    it("a purely inline formatting tag pair filling the whole string is legitimate prose, not a structured wrapper (was a false positive before this fix)", () => {
      expect(looksLikeStructuredWrapper("<b>Done</b>")).toBe(false);
    });

    it("a lone inline formatting tag pair with surrounding prose is legitimate prose regardless of position", () => {
      expect(looksLikeStructuredWrapper("<b>Warning:</b> this needs review before merging.")).toBe(false);
      expect(looksLikeStructuredWrapper("This change is <em>not</em> backwards compatible.")).toBe(false);
    });
  });

  describe("boundary widening: deliberately-uncovered shapes (negative space, documented not accidental)", () => {
    it("a non-inline tag pair embedded mid-sentence with prose on both sides is NOT flagged (indistinguishable from quoting a tag-like token in prose)", () => {
      expect(looksLikeStructuredWrapper("I noted that <status>done</status> in the report.")).toBe(false);
    });

    it("multiple inline-formatting tag pairs ARE flagged, even though each pair alone would be legitimate (the single-lone-pair allowance is deliberately narrow)", () => {
      expect(looksLikeStructuredWrapper("This is <b>bold</b> and this is <i>italic</i> text.")).toBe(true);
    });
  });
});

// ── Wire-format consistency ──────────────────────────────────────────────
//
// wrap() (tools.ts) throws `new Error(serializeTeachingError(...))`, and
// server.ts's tool-call catch block puts `err.message` straight into the
// isError text block, UNCHANGED — it never re-serializes. So the text a
// caller actually sees is exactly serializeTeachingError's output, and this
// must equal what serializeResult (server.ts's own success-path serializer)
// would have produced for the same object, or the two paths silently
// diverge in format. Asserted directly rather than by import (see
// errors.ts's own comment on serializeTeachingError for why it does not
// import serializeResult from server.ts).
describe("serializeTeachingError matches server.ts's serializeResult exactly", () => {
  it("for a representative sample of catalog and degrade fixtures", () => {
    const samples: TeachingError[] = [
      mapBackendError(403, {
        error: "forbidden",
        message: "You do not hold a claim on this task. Call task_start to claim it before task_finish.",
      }),
      mapBackendError(409, { error: "already_claimed", message: "..." }),
      mapBackendError(422, { error: "precondition_failed", failed: [{ rule: "ciGreen", message: "x" }] }),
      mapBackendError(500, { error: "internal_error", message: "boom" }),
      resultMustBePlainStringError(),
      // low_confidence, carrying its own score/threshold/missing[] detail
      // shape (distinct from precondition_failed's failed[] shape above).
      mapBackendError(422, {
        error: "low_confidence",
        message: "Task does not meet confidence threshold for agent claiming",
        details: { score: 35, threshold: 60, missing: ["acceptanceCriteria", "agentPrompt"] },
      }),
      // A degrade-with-detail sample big enough to trip the aggregate
      // budget's harder reclamp (see the "response budget invariant" tests
      // below): the two serializers must stay in lockstep on the DEGRADED
      // shape too, not just the common case.
      mapBackendError(400, {
        error: "x",
        message: "M".repeat(300),
        details: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, "v".repeat(500)])),
      }),
    ];
    for (const sample of samples) {
      expect(serializeTeachingError(sample)).toBe(serializeResult(sample));
    }
  });
});

// ── Response budget invariant (rc-v1-C005 round 2 review, structural
// finding): buildTeachingError's own per-field clamps bound a single field,
// never their sum. enforceErrorBudget (errors.ts) is the aggregate backstop:
// re-measure the whole serialized object, re-clamp `detail` harder if it is
// still over budget, and, only if that is still not enough, replace `detail`
// with a small visible summary rather than a silent or misleading drop.
// This fuzzes a handful of adversarial body shapes through the real
// mapBackendError entry point (not the internal helpers directly) and pins
// the one thing that must ALWAYS hold regardless of shape: the serialized
// size never exceeds the budget. ────────────────────────────────────────────
describe("response budget invariant: adversarial input", () => {
  const adversarialBodies: Array<{ label: string; status: number; body: unknown }> = [
    {
      label: "huge details object (2000 keys, 500-char values)",
      status: 500,
      body: {
        error: "x",
        message: "m",
        details: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, "v".repeat(500)])),
      },
    },
    {
      label: "single huge string detail value (200k chars)",
      status: 500,
      body: { error: "x", message: "m", details: { blob: "z".repeat(200_000) } },
    },
    {
      label: "huge array of huge strings (5000 x 500 chars)",
      status: 500,
      body: {
        error: "x",
        message: "m",
        details: { items: Array.from({ length: 5000 }, () => "y".repeat(500)) },
      },
    },
    {
      label: "huge key NAMES (20 keys, 2000-char names)",
      status: 500,
      body: {
        error: "x",
        message: "m",
        details: Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["k".repeat(2000) + i, "short"])),
      },
    },
    {
      label: "deeply nested chain (well beyond GENERIC_DETAIL_MAX_DEPTH)",
      status: 500,
      body: {
        error: "x",
        message: "m",
        details: Array.from({ length: 20 }, () => 0).reduce((acc: unknown) => ({ next: acc }), { leaf: "bottom" }),
      },
    },
    {
      label: "pathological message alone (1,000,000 chars, no details)",
      status: 400,
      body: { error: "bad", message: "x".repeat(1_000_000) },
    },
    {
      label: "max-length message combined with a huge-keys details object",
      status: 400,
      body: {
        error: "x",
        message: "M".repeat(1000),
        details: Object.fromEntries(
          Array.from({ length: 2000 }, (_, i) => [`some_fairly_long_field_name_${i}`, "v".repeat(500)]),
        ),
      },
    },
    {
      label: "precondition_failed, 12 max-length rule/message/error entries",
      status: 422,
      body: {
        error: "precondition_failed",
        message: "x".repeat(400),
        failed: Array.from({ length: 12 }, (_, i) => ({
          rule: `r${i}`.repeat(20),
          message: "m".repeat(400),
          error: "e".repeat(400),
        })),
      },
    },
  ];

  it.each(adversarialBodies)("$label: serialized response never exceeds ERROR_BUDGET_CHARS", ({ status, body }) => {
    const err = mapBackendError(status, body, "task_finish");
    const serialized = serializeResult(err);
    expect(serialized.length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
    // code/message/recipe/allowedNext are never sacrificed to hold the
    // invariant -- only `detail` is ever degraded.
    expect(typeof err.error.code).toBe("string");
    expect(err.error.code.length).toBeGreaterThan(0);
    expect(Array.isArray(err.error.allowedNext)).toBe(true);
  });

  it("a wide-and-deep nested object (10-way branching, 4 levels) forces the full omission fallback, with a visible marker, and still stays within budget", () => {
    function buildWide(depth: number): unknown {
      if (depth === 0) return "leafvalue".repeat(10);
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < 10; i++) {
        obj[`key_level${depth}_index${i}_${"pad".repeat(10)}`] = buildWide(depth - 1);
      }
      return obj;
    }
    const err = mapBackendError(400, { error: "x", message: "M".repeat(300), details: buildWide(4) as Record<string, unknown> });
    const serialized = serializeResult(err);
    expect(serialized.length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
    expect(err.error.detail?.omitted).toBe(true);
    expect(err.error.detail?.reason).toBe("detail exceeded the error budget");
  });
});
