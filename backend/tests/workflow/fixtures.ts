/**
 * Shared helpers for the workflow round-trip test suite.
 *
 * The suite exercises the canonical agent round-trip
 * (`task_create → task_start → task_submit_pr → task_finish → pull_requests_merge`)
 * against the real Hono route handlers with mocked Prisma + GitHub. Its job
 * is NOT to re-test per-route logic (each route already has its own unit
 * test); it is to catch:
 *
 *   1. Output-byte regressions, e.g. a response shape that doubles in size
 *      because someone nested a copy of the description in every payload.
 *   2. `tasks_list` overflow regressions, which is how today's friction was
 *      caught (the agent's tool call exceeds the harness's tool-result token
 *      cap and is truncated).
 *   3. Workflow ergonomics regressions: an agent doing the canonical flow
 *      should see usefully-shaped responses at every step.
 *
 * See agent-tasks task `47cc3e43-05ac-4975-9c86-60b5224ccda4` for the calibration
 * table that drove the budgets below.
 */

import type { Hono } from "hono";
import type { Actor } from "../../src/types/auth.js";
import type { AppVariables } from "../../src/types/hono.js";

/**
 * Byte budgets per verb, calibrated against the live backend on 2026-05-19.
 *
 * Calibration methodology: each verb was called from a session with a
 * representative fixture state, and the JSON payload byte size was recorded.
 * The budget is set at ~2x the observed size: a regression that genuinely
 * doubles a verb's response (e.g. embedding the description in a list
 * projection) must trip the assertion loud.
 *
 * Updating these numbers requires a corresponding calibration note in the
 * task's comment thread so the rationale stays paper-trail'd.
 */
export const BYTES_BUDGET = {
  // Fixed-shape responses
  projectsGet: 2_048,
  taskPickupIdle: 1_024,
  pullRequestsCreate: 2_048,
  ledgerAdd: 2_048,

  // Variable-shape responses (depend on task description size, metadata,
  // comments). Budgeted at ~2x of a typical task with a 1-2 paragraph
  // description and no comments.
  taskCreate: 8_192,
  taskGet: 12_288,
  taskStart: 12_288,
  taskSubmitPr: 12_288,
  taskFinish: 12_288,
  taskFinishAutoMerge: 12_288,
  taskPickupWithWork: 12_288,
  pullRequestsMerge: 12_288,

  // Round-trip aggregate budgets. Captures the "did the whole agent
  // workflow stay inside the harness tool-result cap" question.
  roundtripSolo: 50_000,
  roundtripDistinctReviewer: 60_000,
} as const;

/**
 * Minimal stateful task store. The round-trip test calls into the real
 * route handlers sequentially, so the Prisma mock has to track the same
 * task across calls (otherwise `task_start` sees no row for the id
 * `task_create` just returned).
 *
 * Not a full Prisma replacement — only the operations the round-trip flow
 * touches. The test fails loud if a route calls a Prisma method this
 * harness doesn't cover (vitest's default-mock returns undefined).
 */
export interface RoundtripState {
  // Single-task focus: the round-trip operates on one task at a time.
  // Each test owns its own RoundtripState instance via beforeEach, so
  // there is no cross-test bleed.
  task: TaskRow | null;
  tasks: TaskRow[];
  workflows: Map<string, unknown>;
}

export interface TaskRow {
  id: string;
  projectId: string;
  workflowId: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  labels: string[];
  claimedByUserId: string | null;
  claimedByAgentId: string | null;
  claimedAt: Date | null;
  reviewClaimedByUserId: string | null;
  reviewClaimedByAgentId: string | null;
  reviewClaimedAt: Date | null;
  branchName: string | null;
  prUrl: string | null;
  prNumber: number | null;
  metadata: unknown;
  externalRef: string | null;
  result: string | null;
  autoMergeSha: string | null;
  dueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  templateData: unknown;
  project: ProjectRow;
  workflow: null;
  attachments: never[];
  artifacts: never[];
  comments: never[];
  blockedBy: never[];
  blocks: never[];
  claimedByUser: null;
  claimedByAgent: { id: string; name: string } | null;
}

export interface ProjectRow {
  id: string;
  teamId: string;
  name: string;
  slug: string;
  description: string | null;
  githubRepo: string;
  taskTemplate: unknown;
  confidenceThreshold: number;
  requireDistinctReviewer: boolean;
  soloMode: boolean;
  governanceMode: string | null;
  requireGroundingForDebug: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function makeProject(overrides: Partial<ProjectRow> = {}): ProjectRow {
  const now = new Date("2026-05-19T00:00:00Z");
  return {
    id: "proj-roundtrip",
    teamId: "team-1",
    name: "fixture-project",
    slug: "fixture-project",
    description: "Round-trip test fixture project",
    githubRepo: "LanNguyenSi/fixture-project",
    taskTemplate: null,
    confidenceThreshold: 60,
    requireDistinctReviewer: false,
    soloMode: true,
    governanceMode: null,
    requireGroundingForDebug: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeTask(overrides: Partial<TaskRow> = {}, project?: ProjectRow): TaskRow {
  const now = new Date("2026-05-19T12:00:00Z");
  const proj = project ?? makeProject();
  return {
    id: "task-roundtrip",
    projectId: proj.id,
    workflowId: null,
    title: "Round-trip fixture task",
    description:
      "Fixture description for the round-trip suite. Long enough to exercise " +
      "the response-payload size assertions without being so long it dominates " +
      "the per-verb budget by itself.",
    status: "open",
    priority: "MEDIUM",
    labels: [],
    claimedByUserId: null,
    claimedByAgentId: null,
    claimedAt: null,
    reviewClaimedByUserId: null,
    reviewClaimedByAgentId: null,
    reviewClaimedAt: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    metadata: null,
    externalRef: null,
    result: null,
    autoMergeSha: null,
    dueAt: null,
    createdAt: now,
    updatedAt: now,
    createdByUserId: null,
    createdByAgentId: "agent-author",
    templateData: null,
    project: proj,
    workflow: null,
    attachments: [],
    artifacts: [],
    comments: [],
    blockedBy: [],
    blocks: [],
    claimedByUser: null,
    claimedByAgent: null,
    ...overrides,
  };
}

/**
 * Measure a Response. Returns the parsed body, the raw byte length of the
 * serialised body, and the status. Byte length is computed from the
 * UTF-8-encoded JSON serialisation — same shape the agent client receives.
 */
export async function measure<T = unknown>(
  responsePromise: Promise<Response> | Response,
): Promise<{ body: T; byteLength: number; status: number }> {
  const res = await responsePromise;
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as unknown as T;
  }
  return {
    body,
    byteLength: new TextEncoder().encode(text).length,
    status: res.status,
  };
}

/**
 * Helper to inject an actor into a Hono test app, mirroring the convention
 * used by the existing unit tests (see task-merge-route.test.ts:99-107).
 *
 * The caller is responsible for mounting the actual taskRouter / githubRouter
 * — the helper just wires the pre-middleware that sets `actor` on the
 * context.
 */
export function withActor<TVars extends Record<string, unknown> = AppVariables>(
  app: Hono<{ Variables: TVars }>,
  actor: Actor,
): Hono<{ Variables: TVars }> {
  app.use("*", async (c, next) => {
    // The `actor` variable is part of AppVariables in the real app; the
    // type assertion below trades a tiny bit of safety for not having
    // to thread the var-shape through every test helper.
    (c as { set: (k: string, v: unknown) => void }).set("actor", actor);
    await next();
  });
  return app;
}
