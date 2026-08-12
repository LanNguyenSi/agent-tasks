import { describe, it, expect } from "vitest";
import {
  mapBackendError,
  serializeTeachingError,
  looksLikeStructuredWrapper,
  resultMustBePlainStringError,
  type TeachingError,
} from "../src/errors.js";
import { serializeResult } from "../src/server.js";
import { buildTools } from "../src/tools.js";
import { AgentTasksClient } from "../src/client.js";

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

// Acceptance criterion: "allowedNext contains only actually-registered verb
// names (consistency assert against buildTools-derived list)".
function assertAllowedNextRegistered(err: TeachingError, registered: Set<string>): void {
  for (const verb of err.error.allowedNext) {
    expect(registered.has(verb), `allowedNext verb "${verb}" is not a registered tool`).toBe(true);
  }
}

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
    // Real text from backend/src/services/transition-rules.ts's
    // RULE_MESSAGES, for the real TransitionRule set (branchPresent/
    // prPresent/ciGreen/prMerged) -- not the synthetic fixtures the other
    // tests in this file use. This is the actual worst case the live
    // backend can ever send on this route.
    const failed = [
      { rule: "branchPresent", message: "No branch recorded on this task. PATCH /api/tasks/:id with branchName first." },
      {
        rule: "prPresent",
        message: "No pull request recorded on this task. Create the PR (via /api/github/pull-requests or PATCH prUrl/prNumber) first.",
      },
      {
        rule: "ciGreen",
        message:
          "CI is not green on the PR. Every check run must end in success (or neutral/skipped). If GitHub is unreachable or no delegation user is available, this rule fails closed -- retry or use admin force.",
      },
      {
        rule: "prMerged",
        message:
          "PR is not merged yet. The pull request on this task must be in the closed-merged state. Open PRs, rejected PRs, and API errors all block -- merge the PR or use admin force.",
      },
    ];
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
  it("an uncataloged backend code/message still gets a structured shape (status-derived code, message passthrough, recipe -> workflow_primer)", () => {
    const err = mapBackendError(500, { error: "internal_error", message: "boom" });
    expect(err.error.code).toBe("http_500");
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
    expect(err.error.code).toBe("http_423");
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

  it("a known backend `error` code that is NOT in the catalog still degrades by HTTP status, not by echoing that code", () => {
    // bad_state / self_merge_blocked / grounding_required / etc. are real
    // backend codes (backend/src/routes/tasks.ts) that are deliberately out
    // of this task's catalog scope; the code must come from the STATUS, not
    // be silently promoted to the emitted `code` field.
    const err = mapBackendError(409, { error: "bad_state", message: "Task must be in review status" });
    expect(err.error.code).toBe("http_409");
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
    ];
    for (const fixture of fixtures) {
      expect(serializeResult(fixture).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
    }
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
    assertAllowedNextRegistered(err, registeredVerbNames());
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
    ];
    for (const sample of samples) {
      expect(serializeTeachingError(sample)).toBe(serializeResult(sample));
    }
  });
});
