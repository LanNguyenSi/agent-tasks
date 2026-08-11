import { describe, it, expect } from "vitest";
import {
  buildReceipt,
  receiptForCreate,
  receiptForRespec,
  receiptForFinish,
  receiptForSubmitPr,
  receiptForMerge,
  receiptForAbandon,
  receiptForNote,
  type Receipt,
  type Deviation,
} from "../src/receipt.js";
import { serializeResult } from "../src/server.js";

// Token budgets are approximated as character counts (the convention the
// task brief and docs/response-contract-v1.md both specify: "character-count
// proxy for token count").
const TIER1_BUDGET_CHARS = 240; // ~60 tokens
const TIER2_BUDGET_CHARS = 1600; // ~400 tokens

// Measure through serializeResult (server.ts), the exact transform the MCP
// server applies before a result goes out as the tool's text block
// (JSON.stringify(x, null, 2) for a non-string result). A compact
// JSON.stringify(x) here would under-measure the real wire payload by
// 27-49% and let a budget regression pass the suite unnoticed.
function size(x: unknown): number {
  return serializeResult(x).length;
}

describe("buildReceipt", () => {
  it("always includes ok:true and task.id", () => {
    const r = buildReceipt({ taskId: "t1" });
    expect(r).toEqual({ ok: true, task: { id: "t1" } });
  });

  it("includes task.status only when provided", () => {
    const withStatus = buildReceipt({ taskId: "t1", status: "open" });
    expect(withStatus.task).toEqual({ id: "t1", status: "open" });
    const withoutStatus = buildReceipt({ taskId: "t1" });
    expect(withoutStatus.task).toEqual({ id: "t1" });
    expect("status" in withoutStatus.task).toBe(false);
  });

  it("omits transition, deviations, and next when not supplied (report by exception)", () => {
    const r = buildReceipt({ taskId: "t1", status: "open" });
    expect(r).not.toHaveProperty("transition");
    expect(r).not.toHaveProperty("deviations");
    expect(r).not.toHaveProperty("next");
  });

  it("omits deviations when the array is empty, not just when absent", () => {
    const r = buildReceipt({ taskId: "t1", deviations: [] });
    expect(r).not.toHaveProperty("deviations");
  });

  it("omits next when the array is empty", () => {
    const r = buildReceipt({ taskId: "t1", next: [] });
    expect(r).not.toHaveProperty("next");
  });

  it("includes transition when supplied", () => {
    const r = buildReceipt({ taskId: "t1", status: "done", transition: { from: "review", to: "done" } });
    expect(r.transition).toEqual({ from: "review", to: "done" });
  });

  it("includes confidence as a bare scalar when supplied", () => {
    const r = buildReceipt({ taskId: "t1", confidence: 87 });
    expect(r.confidence).toBe(87);
    expect(typeof r.confidence).toBe("number");
  });
});

describe("receiptForCreate", () => {
  const freshTask = {
    id: "t1",
    status: "open",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    labels: ["backend"],
  };
  const highConfidence = {
    score: 90,
    threshold: 60,
    enforcementMode: "BLOCK",
    blocking: false,
    missing: [],
    findings: [],
    nextActions: [],
  };

  it("happy path: no deviations, bare confidence scalar, a task_start hint, within the tier-1 budget", () => {
    const receipt = receiptForCreate(
      { task: freshTask, confidence: highConfidence },
      { labels: ["backend"] },
    );
    expect(receipt).toEqual({
      ok: true,
      task: { id: "t1", status: "open" },
      confidence: 90,
      next: ["task_start to begin work on this task"],
    });
    expect(receipt).not.toHaveProperty("deviations");
    expect(size(receipt)).toBeLessThanOrEqual(TIER1_BUDGET_CHARS);
  });

  it("no-echo: the caller's description/templateData never appear in the receipt, even though the raw backend object carries them", () => {
    const backendResponse = {
      task: {
        ...freshTask,
        description: "SECRET SPEC TEXT THAT MUST NOT BE ECHOED",
        templateData: { goal: "another long field that must not round-trip" },
      },
      confidence: highConfidence,
    };
    const receipt = receiptForCreate(backendResponse, {});
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("SECRET SPEC TEXT");
    expect(serialized).not.toContain("must not round-trip");
  });

  it("CONFIDENCE_BELOW_THRESHOLD fires when score < threshold, with detail + next, and stays within the tier-2 budget", () => {
    const lowConfidence = {
      score: 42,
      threshold: 60,
      enforcementMode: "BLOCK",
      blocking: true,
      missing: ["acceptanceCriteria", "goal"],
      findings: [],
      nextActions: [],
    };
    const receipt = receiptForCreate({ task: freshTask, confidence: lowConfidence }, {}) as Receipt;
    expect(receipt.confidence).toBe(42);
    expect(receipt.deviations).toHaveLength(1);
    const dev = receipt.deviations![0];
    expect(dev.code).toBe("CONFIDENCE_BELOW_THRESHOLD");
    expect(dev.detail).toEqual({
      score: 42,
      threshold: 60,
      enforcementMode: "BLOCK",
      missing: ["acceptanceCriteria", "goal"],
      totalMissing: 2,
    });
    expect(dev.actNow).toMatch(/immutable|not editable/i);
    expect(dev.actNow).toMatch(/BLOCK/);
    expect(dev.next).toEqual(["task_respec to raise the score above the threshold"]);
    expect(size(receipt)).toBeLessThanOrEqual(TIER2_BUDGET_CHARS);
  });

  it("CONFIDENCE_BELOW_THRESHOLD actNow reflects a non-BLOCK enforcementMode as advisory", () => {
    const warnConfidence = {
      score: 30,
      threshold: 60,
      enforcementMode: "WARN",
      blocking: false,
      missing: ["goal"],
      findings: [],
      nextActions: [],
    };
    const receipt = receiptForCreate({ task: freshTask, confidence: warnConfidence }, {}) as Receipt;
    const dev = receipt.deviations![0];
    expect(dev.detail).toMatchObject({ enforcementMode: "WARN" });
    expect(dev.actNow).toMatch(/advisory/i);
    expect(dev.actNow).not.toMatch(/will reject/i);
  });

  it("does not fire CONFIDENCE_BELOW_THRESHOLD when score meets the threshold exactly", () => {
    const atThreshold = { ...highConfidence, score: 60, threshold: 60 };
    const receipt = receiptForCreate({ task: freshTask, confidence: atThreshold }, {});
    expect(receipt).not.toHaveProperty("deviations");
  });

  it("DEDUPED_EXTERNAL_REF fires when the caller sent externalRef and createdAt !== updatedAt (best-effort heuristic; see receipt.ts doc comment for why)", () => {
    const dedupedTask = {
      ...freshTask,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      status: "in_progress",
    };
    const receipt = receiptForCreate(
      { task: dedupedTask, confidence: highConfidence },
      { externalRef: "jira-PROJ-42" },
    ) as Receipt;
    expect(receipt.deviations).toContainEqual({
      code: "DEDUPED_EXTERNAL_REF",
      detail: { existingTaskId: "t1", existingStatus: "in_progress" },
      next: ["tasks_get"],
    });
  });

  it("does NOT fire DEDUPED_EXTERNAL_REF on a genuinely fresh task (createdAt === updatedAt) even with externalRef sent: distinguishes fresh creation from dedupe return", () => {
    const receipt = receiptForCreate(
      { task: freshTask, confidence: highConfidence },
      { externalRef: "jira-PROJ-42" },
    );
    expect(JSON.stringify(receipt)).not.toContain("DEDUPED_EXTERNAL_REF");
  });

  it("does NOT fire DEDUPED_EXTERNAL_REF when the caller sent no externalRef, even if createdAt !== updatedAt (the contract trigger is (projectId, externalRef) already exists)", () => {
    const dedupedTask = {
      ...freshTask,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      status: "in_progress",
    };
    const receipt = receiptForCreate({ task: dedupedTask, confidence: highConfidence }, {});
    expect(JSON.stringify(receipt)).not.toContain("DEDUPED_EXTERNAL_REF");
  });

  it("DEPENDS_ON_REJECTED fires for dependsOn ids missing from the response's blockedBy", () => {
    const taskWithBlockers = {
      ...freshTask,
      blockedBy: [{ id: "blocker-a" }],
    };
    const receipt = receiptForCreate(
      { task: taskWithBlockers, confidence: highConfidence },
      { dependsOn: ["blocker-a", "blocker-b"] },
    ) as Receipt;
    expect(receipt.deviations).toContainEqual({
      code: "DEPENDS_ON_REJECTED",
      detail: { rejected: ["blocker-b"], reason: "not found or cross-project", totalRejected: 1 },
      next: ["task_create again with corrected dependsOn"],
    });
  });

  it("does not fire DEPENDS_ON_REJECTED when every sent id is present in blockedBy", () => {
    const taskWithBlockers = { ...freshTask, blockedBy: [{ id: "blocker-a" }, { id: "blocker-b" }] };
    const receipt = receiptForCreate(
      { task: taskWithBlockers, confidence: highConfidence },
      { dependsOn: ["blocker-a", "blocker-b"] },
    );
    expect(receipt).not.toHaveProperty("deviations");
  });

  it("LABELS_DROPPED fires for sent labels missing from the response's labels", () => {
    const taskWithFewerLabels = { ...freshTask, labels: ["backend"] };
    const receipt = receiptForCreate(
      { task: taskWithFewerLabels, confidence: highConfidence },
      { labels: ["backend", "urgent"] },
    ) as Receipt;
    expect(receipt.deviations).toContainEqual({
      code: "LABELS_DROPPED",
      detail: { dropped: ["urgent"], totalDropped: 1 },
      next: ["task_create again (agents cannot set labels post-create)"],
    });
  });

  it("does not fire LABELS_DROPPED when every sent label round-trips", () => {
    const receipt = receiptForCreate(
      { task: freshTask, confidence: highConfidence },
      { labels: ["backend"] },
    );
    expect(receipt).not.toHaveProperty("deviations");
  });

  it("stays within the tier-2 budget even with all four deviations present at once", () => {
    const worstCase = {
      ...freshTask,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      labels: ["backend"],
      blockedBy: [{ id: "blocker-a" }],
    };
    const lowConfidence = {
      score: 42,
      threshold: 60,
      enforcementMode: "BLOCK",
      blocking: true,
      missing: ["acceptanceCriteria", "goal", "context"],
      findings: [],
      nextActions: [],
    };
    const receipt = receiptForCreate(
      { task: worstCase, confidence: lowConfidence },
      {
        externalRef: "jira-PROJ-42",
        labels: ["backend", "urgent", "p0"],
        dependsOn: ["blocker-a", "blocker-b", "blocker-c"],
      },
    ) as Receipt;
    expect(receipt.deviations).toHaveLength(4);
    expect(size(receipt)).toBeLessThanOrEqual(TIER2_BUDGET_CHARS);
  });

  it("clamps DEPENDS_ON_REJECTED/LABELS_DROPPED/CONFIDENCE_BELOW_THRESHOLD detail at the schemas' and backend's declared maxima (dependsOn 50, labels 20 from tools.ts task_create inputShape; missing[] 9 from backend/src/lib/confidence.ts's fixed field list) and stays within the tier-2 budget", () => {
    const dependsOnIds = Array.from(
      { length: 50 },
      (_, i) => `11111111-1111-1111-1111-${String(100000000000 + i).padStart(12, "0")}`,
    );
    const labels = Array.from({ length: 20 }, (_, i) => `label-${String(i).padStart(2, "0")}`);
    const maxedTask = { ...freshTask, blockedBy: [], labels: [] };
    // The backend scorer (backend/src/lib/confidence.ts ~lines 812-821) can
    // populate at most these 9 fields, in this surfacing-priority order.
    const missingAtMax = [
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
    const lowConfidence = {
      score: 42,
      threshold: 60,
      enforcementMode: "BLOCK",
      blocking: true,
      missing: missingAtMax,
      findings: [],
      nextActions: [],
    };
    const receipt = receiptForCreate(
      { task: maxedTask, confidence: lowConfidence },
      { dependsOn: dependsOnIds, labels },
    ) as Receipt;
    expect(receipt.deviations).toHaveLength(3);
    const confDev = receipt.deviations!.find((d: Deviation) => d.code === "CONFIDENCE_BELOW_THRESHOLD")!;
    expect((confDev.detail!.missing as string[]).length).toBeLessThanOrEqual(5);
    expect(confDev.detail!.totalMissing).toBe(9);
    const dependsOnDev = receipt.deviations!.find((d: Deviation) => d.code === "DEPENDS_ON_REJECTED")!;
    expect((dependsOnDev.detail!.rejected as string[]).length).toBeLessThanOrEqual(5);
    expect(dependsOnDev.detail!.totalRejected).toBe(50);
    const labelsDev = receipt.deviations!.find((d: Deviation) => d.code === "LABELS_DROPPED")!;
    expect((labelsDev.detail!.dropped as string[]).length).toBeLessThanOrEqual(5);
    expect(labelsDev.detail!.totalDropped).toBe(20);
    expect(size(receipt)).toBeLessThanOrEqual(TIER2_BUDGET_CHARS);
  });
});

describe("receiptForRespec", () => {
  it("happy path: bare confidence scalar, no deviations", () => {
    const receipt = receiptForRespec({
      task: { id: "t1", status: "open" },
      confidence: { score: 85, threshold: 60, enforcementMode: "BLOCK", blocking: false, missing: [], findings: [], nextActions: [] },
    });
    expect(receipt).toEqual({ ok: true, task: { id: "t1", status: "open" }, confidence: 85 });
    expect(size(receipt)).toBeLessThanOrEqual(TIER1_BUDGET_CHARS);
  });

  it("no-echo: replacement description/templateData never appear in the receipt", () => {
    const receipt = receiptForRespec({
      task: { id: "t1", status: "open", description: "REPLACEMENT SPEC TEXT" } as never,
      confidence: { score: 85, threshold: 60, enforcementMode: "BLOCK", blocking: false, missing: [], findings: [], nextActions: [] },
    });
    expect(JSON.stringify(receipt)).not.toContain("REPLACEMENT SPEC TEXT");
  });

  it("CONFIDENCE_BELOW_THRESHOLD fires on a still-thin re-score", () => {
    const receipt = receiptForRespec({
      task: { id: "t1", status: "open" },
      confidence: { score: 40, threshold: 60, enforcementMode: "BLOCK", blocking: true, missing: ["goal"], findings: [], nextActions: [] },
    }) as Receipt;
    expect(receipt.deviations).toHaveLength(1);
    expect(receipt.deviations![0].code).toBe("CONFIDENCE_BELOW_THRESHOLD");
  });
});

describe("receiptForFinish", () => {
  it("happy path (work branch): no deviations, within the tier-1 budget", () => {
    const receipt = receiptForFinish({ kind: "work", task: { id: "t1", status: "review" }, targetStatus: "review" }) as Receipt;
    expect(receipt).toEqual({ ok: true, task: { id: "t1", status: "review" } });
    expect(receipt.confidence).toBeUndefined();
    expect(size(receipt)).toBeLessThanOrEqual(TIER1_BUDGET_CHARS);
  });

  it("no-echo: a caller-sent `result` string never appears (receiptForFinish doesn't read it at all)", () => {
    const receipt = receiptForFinish({ kind: "work", task: { id: "t1", status: "done" }, targetStatus: "done" });
    expect(JSON.stringify(receipt)).not.toContain("result");
  });

  it("WORKFLOW_GATE_SKIPPED fires when autoMerge skipped a normally-required gate", () => {
    const receipt = receiptForFinish({
      kind: "work",
      task: { id: "t1", status: "done" },
      targetStatus: "done",
      autoMergeSha: "abc123",
      skippedGates: ["prMerged"],
    }) as Receipt;
    expect(receipt.deviations).toEqual([
      {
        code: "WORKFLOW_GATE_SKIPPED",
        detail: { skipped: ["prMerged"], totalSkipped: 1 },
        actNow: "autoMerge bypassed the normally-required workflow gate(s) before this transition: prMerged.",
      },
    ]);
    expect(size(receipt)).toBeLessThanOrEqual(TIER2_BUDGET_CHARS);
  });

  it("does not carry a confidence field (actionable-counter-rule: confidence detail belongs only on create/respec)", () => {
    const receipt = receiptForFinish({ kind: "review", task: { id: "t1", status: "done" }, outcome: "approve" });
    expect(receipt).not.toHaveProperty("confidence");
  });
});

describe("receiptForSubmitPr", () => {
  it("happy path: a task_finish hint, no transition field, within the tier-1 budget", () => {
    const receipt = receiptForSubmitPr({ kind: "submit_pr", task: { id: "t1", status: "in_progress" } });
    expect(receipt).toEqual({
      ok: true,
      task: { id: "t1", status: "in_progress" },
      next: ["task_finish once CI is green"],
    });
    expect(receipt).not.toHaveProperty("transition");
    expect(receipt).not.toHaveProperty("confidence");
    expect(size(receipt)).toBeLessThanOrEqual(TIER1_BUDGET_CHARS);
  });

  it("no-echo: a caller-sent branchName/prUrl never appears (receiptForSubmitPr doesn't read the request at all)", () => {
    const receipt = receiptForSubmitPr({ kind: "submit_pr", task: { id: "t1", status: "in_progress" } });
    expect(JSON.stringify(receipt)).not.toContain("branchName");
    expect(JSON.stringify(receipt)).not.toContain("prUrl");
  });
});

describe("receiptForMerge", () => {
  // Regression coverage for the fabricated-transition bug: `transition` must
  // never appear, in either alreadyMerged direction. The route admits both
  // `review` and an idempotent `done` retry as valid starting states, and
  // `alreadyMerged` describes the GitHub PR's own merge state, not whether a
  // DB transition happened on this call: task.status alone reports the
  // outcome (see receipt.ts's receiptForMerge doc comment for the full
  // out-of-band-merge scenario that made keying off alreadyMerged wrong).

  it("a fresh merge (alreadyMerged: false) carries task status but no transition field, within the tier-1 budget", () => {
    const receipt = receiptForMerge({ task: { id: "t1", status: "done" }, merged: true, sha: "abc", alreadyMerged: false });
    expect(receipt).toEqual({
      ok: true,
      task: { id: "t1", status: "done" },
    });
    expect(receipt).not.toHaveProperty("transition");
    expect(size(receipt)).toBeLessThanOrEqual(TIER1_BUDGET_CHARS);
  });

  it("an idempotent already-merged retry (alreadyMerged: true) also carries no transition field", () => {
    const receipt = receiptForMerge({ task: { id: "t1", status: "done" }, merged: true, sha: "abc", alreadyMerged: true });
    expect(receipt).toEqual({
      ok: true,
      task: { id: "t1", status: "done" },
    });
    expect(receipt).not.toHaveProperty("transition");
  });
});

describe("receiptForAbandon", () => {
  it("happy path: task id + resulting status, within the tier-1 budget", () => {
    const receipt = receiptForAbandon({ task: { id: "t1", status: "open" } });
    expect(receipt).toEqual({ ok: true, task: { id: "t1", status: "open" } });
    expect(size(receipt)).toBeLessThanOrEqual(TIER1_BUDGET_CHARS);
  });
});

describe("receiptForNote", () => {
  it("uses comment.taskId from the response when present", () => {
    const receipt = receiptForNote("fallback-id", { comment: { taskId: "t1" } });
    expect(receipt).toEqual({ ok: true, task: { id: "t1" } });
  });

  it("falls back to the caller's own taskId when the backend response carries none (POST /comments returns no task/status field)", () => {
    const receipt = receiptForNote("t1", {});
    expect(receipt).toEqual({ ok: true, task: { id: "t1" } });
    expect(receipt.task).not.toHaveProperty("status");
  });

  it("no-echo: a caller-sent comment body never appears (receiptForNote doesn't read it)", () => {
    const receipt = receiptForNote("t1", { comment: { taskId: "t1" } });
    expect(JSON.stringify(receipt)).not.toContain("content");
  });

  it("is the smallest receipt shape and comfortably clears the tier-1 budget", () => {
    const receipt = receiptForNote("11111111-1111-1111-1111-111111111111", {
      comment: { taskId: "11111111-1111-1111-1111-111111111111" },
    });
    expect(size(receipt)).toBeLessThanOrEqual(TIER1_BUDGET_CHARS);
  });
});

describe("malformed backend success bodies (no task.id)", () => {
  // A success body without a `task` object would otherwise throw a raw
  // TypeError from `response.task.id` inside the builder. Every builder that
  // reads task.id falls back to returning the raw, unprojected response
  // instead of crashing.
  it("every builder that reads task.id falls back to the raw response instead of throwing", () => {
    const malformed = { ok: true, weird: "shape" };
    expect(() => receiptForCreate(malformed as never, {})).not.toThrow();
    expect(receiptForCreate(malformed as never, {})).toBe(malformed);

    expect(() => receiptForRespec(malformed as never)).not.toThrow();
    expect(receiptForRespec(malformed as never)).toBe(malformed);

    expect(() => receiptForFinish(malformed as never)).not.toThrow();
    expect(receiptForFinish(malformed as never)).toBe(malformed);

    expect(() => receiptForSubmitPr(malformed as never)).not.toThrow();
    expect(receiptForSubmitPr(malformed as never)).toBe(malformed);

    expect(() => receiptForMerge(malformed as never)).not.toThrow();
    expect(receiptForMerge(malformed as never)).toBe(malformed);

    expect(() => receiptForAbandon(malformed as never)).not.toThrow();
    expect(receiptForAbandon(malformed as never)).toBe(malformed);
  });

  it("also falls back when `task` is present but `task.id` itself is missing", () => {
    const malformed = { ok: true, task: { status: "open" } };
    expect(() => receiptForAbandon(malformed as never)).not.toThrow();
    expect(receiptForAbandon(malformed as never)).toBe(malformed);
  });
});
