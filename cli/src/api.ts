/**
 * Thin API client for agent-tasks.
 */
import type { Config } from "./config.js";

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API error ${status}: ${typeof body === "object" ? JSON.stringify(body) : body}`);
  }
}

async function request<T>(config: Config, path: string, init?: RequestInit): Promise<T> {
  const url = `${config.endpoint}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ── Signals ─────────────────────────────────────────────────────────────────

export interface Signal {
  id: string;
  type: string;
  taskId: string;
  projectId: string;
  context: Record<string, unknown>;
  acknowledgedAt: string | null;
  createdAt: string;
}

export async function getSignals(config: Config, status = "unread", limit = 50): Promise<Signal[]> {
  const { signals } = await request<{ signals: Signal[] }>(
    config, `/api/agent/signals?status=${status}&limit=${limit}`,
  );
  return signals;
}

export async function ackSignal(config: Config, signalId: string): Promise<Signal> {
  const { signal } = await request<{ signal: Signal }>(
    config, `/api/agent/signals/${signalId}/ack`, { method: "POST" },
  );
  return signal;
}

// ── Projects ────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  githubRepo?: string | null;
}

export async function listProjects(config: Config): Promise<Project[]> {
  const { projects } = await request<{ projects: Project[] }>(
    config,
    "/api/projects/available",
  );
  return projects;
}

/**
 * Slugs are lowercase alphanumeric + dashes; IDs are UUIDs. Shared
 * detection helper so callers in `index.ts` don't re-implement the
 * regex and drift from the server's id shape.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export async function getProject(
  config: Config,
  slugOrId: string,
): Promise<Project> {
  const path = isUuid(slugOrId)
    ? `/api/projects/${slugOrId}`
    : `/api/projects/by-slug/${encodeURIComponent(slugOrId)}`;
  const { project } = await request<{ project: Project }>(config, path);
  return project;
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  branchName?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  claimedByAgentId?: string | null;
  project?: { name: string; slug: string };
}

export async function getClaimableTasks(config: Config): Promise<Task[]> {
  const { tasks } = await request<{ tasks: Task[] }>(config, "/api/tasks/claimable");
  return tasks;
}

export async function getTask(config: Config, taskId: string): Promise<Task> {
  const { task } = await request<{ task: Task }>(
    config,
    `/api/tasks/${taskId}`,
  );
  return task;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  workflowId?: string;
  dueAt?: string;
  externalRef?: string;
  labels?: string[];
}

export async function createTask(
  config: Config,
  projectId: string,
  input: CreateTaskInput,
): Promise<Task> {
  const { task } = await request<{ task: Task }>(
    config,
    `/api/projects/${projectId}/tasks`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return task;
}

export async function claimTask(config: Config, taskId: string, force = false): Promise<Task> {
  const { task } = await request<{ task: Task }>(
    config, `/api/tasks/${taskId}/claim${force ? "?force=true" : ""}`, { method: "POST" },
  );
  return task;
}

export async function releaseTask(config: Config, taskId: string): Promise<Task> {
  const { task } = await request<{ task: Task }>(
    config,
    `/api/tasks/${taskId}/release`,
    { method: "POST" },
  );
  return task;
}

export async function transitionTask(config: Config, taskId: string, status: string): Promise<Task> {
  const { task } = await request<{ task: Task }>(
    config, `/api/tasks/${taskId}/transition`,
    { method: "POST", body: JSON.stringify({ status }) },
  );
  return task;
}

export async function updateTask(config: Config, taskId: string, data: Record<string, unknown>): Promise<Task> {
  const { task } = await request<{ task: Task }>(
    config, `/api/tasks/${taskId}`,
    { method: "PATCH", body: JSON.stringify(data) },
  );
  return task;
}

export async function addComment(config: Config, taskId: string, content: string): Promise<unknown> {
  return request(config, `/api/tasks/${taskId}/comments`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

export async function getTaskInstructions(config: Config, taskId: string): Promise<unknown> {
  return request(config, `/api/tasks/${taskId}/instructions`);
}

// ── v2 verb API ─────────────────────────────────────────────────────────────
//
// Mirrors the agent-tasks v2 verb endpoints: pickup, start, finish, abandon,
// submit-pr. These supersede the v1 claim/release/transition/review surface
// (still callable via the helpers above for backwards compatibility). See
// agent-tasks `backend/src/routes/tasks.ts` for the canonical schema.

export interface PickupSignal {
  kind: "signal";
  signal: Signal;
}

export interface PickupReview {
  kind: "review";
  task: Task;
  project: Project;
}

export interface PickupWork {
  kind: "work";
  task: Task;
  project: Project;
}

export interface PickupIdle {
  kind: "idle";
}

export type PickupResult = PickupSignal | PickupReview | PickupWork | PickupIdle;

export async function taskPickup(config: Config): Promise<PickupResult> {
  return request<PickupResult>(config, "/api/tasks/pickup", { method: "POST" });
}

export interface StartResult {
  kind: "work" | "review";
  task: Task;
  project: Project;
  expectedFinishState: string;
}

export async function taskStart(config: Config, taskId: string): Promise<StartResult> {
  return request<StartResult>(config, `/api/tasks/${taskId}/start`, { method: "POST" });
}

export type MergeMethod = "merge" | "squash" | "rebase";

export interface FinishWorkInput {
  result?: string;
  prUrl?: string;
  autoMerge?: boolean;
  mergeMethod?: MergeMethod;
}

export interface FinishReviewInput {
  result?: string;
  outcome: "approve" | "request_changes";
  autoMerge?: boolean;
  mergeMethod?: MergeMethod;
}

export type FinishInput = FinishWorkInput | FinishReviewInput;

export interface FinishResult {
  task: Task;
}

export async function taskFinish(
  config: Config,
  taskId: string,
  body: FinishInput,
): Promise<FinishResult> {
  return request<FinishResult>(
    config,
    `/api/tasks/${taskId}/finish`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function taskAbandon(config: Config, taskId: string): Promise<{ task: Task }> {
  return request<{ task: Task }>(
    config,
    `/api/tasks/${taskId}/abandon`,
    { method: "POST" },
  );
}

export interface SubmitPrInput {
  branchName: string;
  prUrl: string;
  prNumber: number;
}

export async function submitPr(
  config: Config,
  taskId: string,
  body: SubmitPrInput,
): Promise<{ task: Task }> {
  return request<{ task: Task }>(
    config,
    `/api/tasks/${taskId}/submit-pr`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export interface EffectiveGate {
  code: string;
  name: string;
  active: boolean;
  because: string;
  appliesTo: string[];
}

export async function getEffectiveGates(
  config: Config,
  projectId: string,
): Promise<EffectiveGate[]> {
  // Backend returns a Record<gateCode, EffectiveGate> under `effectiveGates`.
  // We flatten to an array so output formatting can iterate it directly.
  const { effectiveGates } = await request<{
    effectiveGates: Record<string, EffectiveGate>;
  }>(config, `/api/projects/${projectId}/effective-gates`);
  return Object.values(effectiveGates);
}

// ── Reviews ─────────────────────────────────────────────────────────────────

export async function reviewTask(config: Config, taskId: string, action: "approve" | "request_changes", comment?: string): Promise<Task> {
  const { task } = await request<{ task: Task }>(
    config, `/api/tasks/${taskId}/review`,
    { method: "POST", body: JSON.stringify({ action, comment }) },
  );
  return task;
}

export async function claimReview(config: Config, taskId: string): Promise<Task> {
  const { task } = await request<{ task: Task }>(
    config, `/api/tasks/${taskId}/review/claim`, { method: "POST" },
  );
  return task;
}

export async function releaseReview(config: Config, taskId: string): Promise<Task> {
  const { task } = await request<{ task: Task }>(
    config, `/api/tasks/${taskId}/review/release`, { method: "POST" },
  );
  return task;
}

// ── GitHub delegation ───────────────────────────────────────────────────────
//
// These three endpoints delegate GitHub operations (PR create/merge/comment)
// to a team member with `allowAgentPr*` consent. The server resolves the
// delegation user at call time — CLI just forwards the request.

export interface PullRequestRef {
  number: number;
  url: string;
  title?: string;
}

export interface CreatePullRequestInput {
  taskId: string;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body?: string;
}

export async function createPullRequest(
  config: Config,
  input: CreatePullRequestInput,
): Promise<PullRequestRef> {
  const { pullRequest } = await request<{ pullRequest: PullRequestRef }>(
    config,
    "/api/github/pull-requests",
    { method: "POST", body: JSON.stringify(input) },
  );
  return pullRequest;
}

export interface MergePullRequestInput {
  taskId: string;
  owner: string;
  repo: string;
  // snake_case matches the backend schema (GitHub's own merge API uses
  // the same casing). Don't "fix" this in a refactor — it would break
  // the wire format.
  merge_method?: "merge" | "squash" | "rebase";
}

export async function mergePullRequest(
  config: Config,
  prNumber: number,
  input: MergePullRequestInput,
): Promise<{ merged: boolean; sha?: string; message?: string }> {
  return request<{ merged: boolean; sha?: string; message?: string }>(
    config,
    `/api/github/pull-requests/${prNumber}/merge`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export interface CommentPullRequestInput {
  taskId: string;
  owner: string;
  repo: string;
  body: string;
}

export async function commentPullRequest(
  config: Config,
  prNumber: number,
  input: CommentPullRequestInput,
): Promise<unknown> {
  return request(
    config,
    `/api/github/pull-requests/${prNumber}/comments`,
    { method: "POST", body: JSON.stringify(input) },
  );
}
