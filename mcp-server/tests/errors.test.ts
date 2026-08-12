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
  it("precondition_failed: a branch/PR gate failing names task_submit_pr and lists rules structured", () => {
    // Short synthetic per-rule messages here (under the per-entry clamp) so
    // this test demonstrates exact structured passthrough; the real,
    // longer RULE_MESSAGES strings and the clamp's truncation behavior are
    // covered by the dedicated worst-case fixture test below.
    const err = mapBackendError(
      422,
      {
        error: "precondition_failed",
        message: "Transition blocked — No branch recorded on this task.",
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
      { rule: "branchPresent", message: "No branch recorded." },
      { rule: "prPresent", message: "No pull request recorded." },
    ]);
    expect(err.error.detail?.totalFailed).toBe(2);
    assertAllowedNextRegistered(err, registered);
  });

  it("precondition_failed: the real (longer) RULE_MESSAGES text is clamped per-entry, visibly truncated, never silently", () => {
    const err = mapBackendError(
      422,
      {
        error: "precondition_failed",
        failed: [
          { rule: "branchPresent", message: "No branch recorded on this task. PATCH /api/tasks/:id with branchName first." },
          {
            rule: "prPresent",
            message:
              "No pull request recorded on this task. Create the PR (via /api/github/pull-requests or PATCH prUrl/prNumber) first.",
          },
        ],
      },
      "task_finish",
    );
    const detailFailed = err.error.detail?.failed as Array<{ rule: string; message: string }>;
    for (const entry of detailFailed) {
      expect(entry.message.endsWith("...")).toBe(true);
      expect(entry.message.length).toBeLessThanOrEqual(60);
    }
    expect(err.error.detail?.totalFailed).toBe(2);
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
  it("cross_repo_pr_rejected: the 400 maps to a task_submit_pr recipe", () => {
    const err = mapBackendError(400, {
      error: "cross_repo_pr_rejected",
      message: "PR points at other/repo, expected acme/agent-tasks.",
    });
    expect(err.error.code).toBe("cross_repo_pr_rejected");
    expect(err.error.allowedNext).toEqual(["task_submit_pr"]);
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

  // ── Generic degrade (acceptance criterion: unknown errors degrade
  // structurally) ─────────────────────────────────────────────────────────
  it("an uncataloged backend code/message still gets a structured shape (status-derived code, message passthrough, recipe -> workflow_primer)", () => {
    const err = mapBackendError(500, { error: "internal_error", message: "boom" });
    expect(err.error.code).toBe("http_500");
    expect(err.error.message).toBe("boom");
    expect(err.error.recipe).toContain("workflow_primer");
    expect(err.error.allowedNext).toEqual(["workflow_primer"]);
    assertAllowedNextRegistered(err, registered);
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
      resultMustBePlainStringError(),
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

  it("resultMustBePlainStringError names task_finish as the concrete corrective call", () => {
    const err = resultMustBePlainStringError();
    expect(err.error.code).toBe("result_not_plain_string");
    expect(err.error.allowedNext).toEqual(["task_finish"]);
    assertAllowedNextRegistered(err, registeredVerbNames());
    expect(serializeResult(err).length).toBeLessThanOrEqual(ERROR_BUDGET_CHARS);
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
