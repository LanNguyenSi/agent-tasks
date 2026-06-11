import type { TemplateData, TaskType, QualityFinding } from "./confidence";

// TemplateData is owned by ./confidence (the scorer is its primary consumer);
// re-export it so existing `import { TemplateData } from "../lib/api"`
// call-sites keep working without a duplicated definition.
export type { TemplateData };

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
  githubConnected: boolean;
  allowAgentPrCreate: boolean;
  allowAgentPrMerge: boolean;
  allowAgentPrComment: boolean;
}

export interface TemplatePreset {
  name: string;
  description?: string;
  goal?: string;
  acceptanceCriteria?: string;
  context?: string;
  constraints?: string;
  // scorer-v2 executability fields (1:1 with the backend templatePresetSchema).
  scope?: string;
  outOfScope?: string;
  dependencies?: string;
  risk?: string;
  agentPrompt?: string;
  taskType?: TaskType;
}

export interface TaskTemplate {
  fields: {
    goal: boolean;
    acceptanceCriteria: boolean;
    context: boolean;
    constraints: boolean;
    // scorer-v2 executability fields. Optional: rows predating the schema
    // widening (T2) have no value for these keys, so a project that never
    // enabled them reads `undefined` (falsy → editor gated off).
    scope?: boolean;
    outOfScope?: boolean;
    dependencies?: boolean;
    risk?: boolean;
    agentPrompt?: boolean;
  };
  presets?: TemplatePreset[];
}

export interface Project {
  id: string;
  teamId: string;
  name: string;
  slug: string;
  description: string | null;
  githubRepo: string | null;
  githubSyncAt: string | null;
  taskTemplate: TaskTemplate | null;
  confidenceThreshold: number;
  /** @deprecated prefer governanceMode. Derived from governanceMode server-side through the deprecation window. */
  requireDistinctReviewer: boolean;
  /** @deprecated prefer governanceMode. Derived from governanceMode server-side through the deprecation window. */
  soloMode: boolean;
  /** Null only for rows predating the migration; the server derives from legacy flags at read time. Prefer reading this over the old flags. */
  governanceMode: "REQUIRES_DISTINCT_REVIEWER" | "AWAITS_CONFIRMATION" | "AUTONOMOUS" | null;
  /** Outbound webhook target for Signal push-delivery; see docs/notification-webhooks.md. Null when push delivery is off (poll-only). */
  notificationWebhookUrl: string | null;
  /** True iff a signing secret is configured. The raw secret is never returned by the API — PATCH with a new value to rotate. */
  hasNotificationWebhookSecret: boolean;
  createdAt: string;
  /** Source of the user's access to this project. `"team"` means the
   * project is in a team the user is a member of; `"project"` means
   * access is granted via a per-project share (ProjectMember row).
   * Optional because some legacy API responses may omit it; treat
   * `undefined` as `"team"` for backward-compatibility. */
  accessSource?: "team" | "project";
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  templateData: TemplateData | null;
  claimedByUserId: string | null;
  claimedByAgentId: string | null;
  claimedAt: string | null;
  dueAt: string | null;
  branchName: string | null;
  prUrl: string | null;
  prNumber: number | null;
  result: string | null;
  externalRef: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  attachments: TaskAttachment[];
  artifacts?: TaskArtifactMeta[];
  comments?: Comment[];
  claimedByUser?: {
    id: string;
    login: string;
    name: string | null;
    avatarUrl: string | null;
  } | null;
  claimedByAgent?: {
    id: string;
    name: string;
  } | null;
  blockedBy?: { id: string; title: string; status: string }[];
  blocks?: { id: string; title: string; status: string }[];
}

export interface Comment {
  id: string;
  taskId: string;
  content: string;
  createdAt: string;
  authorUser?: {
    id: string;
    login: string;
    name: string | null;
    avatarUrl: string | null;
  } | null;
  authorAgent?: {
    id: string;
    name: string;
  } | null;
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  name: string;
  // Uploaded files: /uploads/<uuid>.<ext>. URL pointers: an external http(s) URL.
  url: string;
  mimeType: string | null;
  sizeBytes: number;
  type: "IMAGE" | "DOCUMENT";
  createdByUserId: string | null;
  createdByUser?: { id: string; login: string; name: string | null; avatarUrl: string | null } | null;
  createdAt: string;
}

export type TaskArtifactType =
  | "build_log"
  | "test_report"
  | "generated_code"
  | "coverage"
  | "diff"
  | "other";

export interface TaskArtifactMeta {
  id: string;
  taskId: string;
  type: TaskArtifactType;
  name: string;
  description: string | null;
  url: string | null;
  mimeType: string | null;
  sizeBytes: number;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  createdByUser?: {
    id: string;
    login: string;
    name: string | null;
    avatarUrl: string | null;
  } | null;
  createdByAgent?: { id: string; name: string } | null;
}

export interface TaskArtifact extends TaskArtifactMeta {
  content: string | null;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  role?: string;
  memberCount?: number;
  projectCount?: number;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  action: string;
  actorId: string | null;
  taskId: string | null;
  projectId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ApiError {
  error: string;
  message: string;
}

// ── Core request ──────────────────────────────────────────────────────────────

/**
 * Error class that preserves the structured `error` code returned by
 * the backend. The previous shape (`new Error(err.message)`) dropped
 * the code on the floor, forcing callers to string-match on the
 * human-readable message — brittle and i18n-unfriendly. Callers can
 * now branch on `e instanceof ApiRequestError && e.code === "..."`.
 */
export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "include",
    ...init,
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({ message: "Request failed" }))) as ApiError;
    throw new ApiRequestError(
      err.error ?? "request_failed",
      err.message ?? "Request failed",
      res.status,
    );
  }

  return res.json() as Promise<T>;
}

// ── Teams ───────────────────────────────────────────────────────────────────

export async function getTeams(): Promise<Team[]> {
  const data = await request<{ teams: Team[] }>("/api/teams");
  return data.teams;
}

export async function createTeam(body: { name: string; slug: string }): Promise<Team> {
  const data = await request<{ team: Team }>("/api/teams", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.team;
}

export interface AgentToken {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreateAgentTokenResponse {
  token: AgentToken;
  rawToken: string;
}

export async function createAgentToken(
  body: {
    teamId: string;
    name: string;
    scopes: string[];
    expiresAt?: string;
  },
  options?: { signal?: AbortSignal },
): Promise<CreateAgentTokenResponse> {
  return request<CreateAgentTokenResponse>("/api/agent-tokens", {
    method: "POST",
    body: JSON.stringify(body),
    signal: options?.signal,
  });
}

export async function revokeAgentToken(tokenId: string): Promise<void> {
  await request(`/api/agent-tokens/${tokenId}/revoke`, { method: "POST" });
}

export async function getAgentTokens(teamId: string): Promise<AgentToken[]> {
  const data = await request<{ tokens: AgentToken[] }>(`/api/agent-tokens?teamId=${teamId}`);
  return data.tokens;
}

export interface ScopeDescriptor {
  id: string;
  label: string;
}

export async function getAvailableScopes(): Promise<ScopeDescriptor[]> {
  const data = await request<{ scopes: ScopeDescriptor[] }>(`/api/agent-tokens/scopes`);
  return data.scopes;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function getCurrentUser(): Promise<User | null> {
  try {
    const data = await request<{ user: User | null }>("/api/auth/me");
    return data.user;
  } catch {
    return null;
  }
}

export async function updateDelegationSettings(body: {
  allowAgentPrCreate: boolean;
  allowAgentPrMerge: boolean;
  allowAgentPrComment: boolean;
}): Promise<User> {
  const data = await request<{ user: User }>("/api/auth/delegation", {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return data.user;
}

export type GithubTokenHealthState = "healthy" | "invalid" | "unknown" | "not_connected";

export interface GithubTokenHealth {
  state: GithubTokenHealthState;
  lastCheckedAt: string | null;
}

export async function getGithubTokenHealth(): Promise<GithubTokenHealth> {
  return request<GithubTokenHealth>("/api/auth/github/health");
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", { method: "POST" });
}

export async function register(body: {
  email: string;
  password: string;
  name?: string;
}): Promise<User> {
  const data = await request<{ user: User }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.user;
}

export async function login(body: { email: string; password: string }): Promise<User> {
  const data = await request<{ user: User }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.user;
}

// ── SSO (OIDC) ────────────────────────────────────────────────────────────────

export interface SsoDiscoverResult {
  teamSlug: string;
  teamName: string;
  displayName: string;
  loginUrl: string;
}

export async function discoverSso(email: string): Promise<SsoDiscoverResult | null> {
  const data = await request<{ connection: SsoDiscoverResult | null }>(
    `/api/auth/sso/discover?email=${encodeURIComponent(email)}`,
  );
  return data.connection;
}

// SSO admin endpoints are token-gated (AgentToken with sso:admin scope) and
// called directly from /settings/sso with a user-supplied token — they are
// intentionally NOT exposed through this session-authed api.ts client.

// ── Projects ──────────────────────────────────────────────────────────────────

export async function getProjects(teamId: string): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>(`/api/projects?teamId=${teamId}`);
  return data.projects;
}

export async function createProject(body: {
  teamId: string;
  name: string;
  slug: string;
  description?: string;
  githubRepo?: string;
}): Promise<Project> {
  const data = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.project;
}

export async function getProject(id: string): Promise<Project> {
  const data = await request<{ project: Project }>(`/api/projects/${id}`);
  return data.project;
}

export async function updateProject(
  id: string,
  body: {
    name?: string;
    description?: string;
    githubRepo?: string;
    taskTemplate?: TaskTemplate | null;
    confidenceThreshold?: number;
    governanceMode?: "REQUIRES_DISTINCT_REVIEWER" | "AWAITS_CONFIRMATION" | "AUTONOMOUS";
    /** @deprecated prefer governanceMode. */
    requireDistinctReviewer?: boolean;
    /** @deprecated prefer governanceMode. */
    soloMode?: boolean;
    /** Set, replace, or clear the outbound Signal webhook target. Empty string is the wire convention for "clear". */
    notificationWebhookUrl?: string | null;
    /** Set, replace, or clear the HMAC signing secret. Never returned on read. Empty string is "clear". */
    notificationWebhookSecret?: string | null;
  },
): Promise<Project> {
  const data = await request<{ project: Project }>(`/api/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return data.project;
}

export async function deleteProject(id: string): Promise<void> {
  await request(`/api/projects/${id}`, { method: "DELETE" });
}

export async function syncProject(id: string): Promise<Project> {
  const data = await request<{ project: Project }>(`/api/projects/${id}/sync`, { method: "POST" });
  return data.project;
}

export async function syncTeamFromGitHub(teamId: string): Promise<{
  synced: number;
  created: number;
  updated: number;
  pruned: number;
  skippedPrune: boolean;
  message: string;
}> {
  return request(`/api/teams/${teamId}/sync`, { method: "POST" });
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export async function getTasks(projectId: string): Promise<Task[]> {
  const data = await request<{ tasks: Task[] }>(`/api/projects/${projectId}/tasks`);
  return data.tasks;
}

export interface TeamTasksProject {
  id: string;
  name: string;
  slug: string;
  accessSource: "team" | "project";
}

export interface TeamTasksCounts {
  open: number;
  review: number;
  done: number;
  // Team-wide done split at the 14-day window (added with the done recency
  // filter). Optional for forward-compat with a backend predating it.
  doneRecent?: number;
  doneOlder?: number;
  priority: number;
  mine: number;
  total: number;
}

export interface TeamTasksResponse {
  tasks: Task[];
  projects: TeamTasksProject[];
  // Optional for forward-compat: a backend predating the counts rollout
  // will simply omit this; callers should fall back to `tasks.length`.
  counts?: TeamTasksCounts;
  // Total rows matching the active filter, for server-side pagination.
  // Optional for forward-compat; callers fall back to `tasks.length`.
  filteredTotal?: number;
}

/**
 * Aggregation endpoint for the home dashboard: returns tasks across all
 * team-accessible projects in a single roundtrip plus a small projects
 * map so callers can decorate each task with its project name without a
 * second request. Replaces the per-project fan-out the home page used to
 * do.
 */
export async function getTeamTasks(
  teamId: string,
  opts: {
    status?: string;
    priority?: string;
    labels?: string;
    limit?: number;
    // Server-side filter/sort/pagination params for the /tasks browser.
    recency?: "recent" | "older" | "all";
    projectId?: string;
    mine?: boolean;
    q?: string;
    sort?: string;
    offset?: number;
  } = {},
): Promise<TeamTasksResponse> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.priority) params.set("priority", opts.priority);
  if (opts.labels) params.set("labels", opts.labels);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.recency && opts.recency !== "all") params.set("recency", opts.recency);
  if (opts.projectId) params.set("projectId", opts.projectId);
  if (opts.mine) params.set("mine", "1");
  if (opts.q) params.set("q", opts.q);
  if (opts.sort) params.set("sort", opts.sort);
  if (opts.offset) params.set("offset", String(opts.offset));
  const qs = params.toString();
  const path = `/api/teams/${teamId}/tasks${qs ? `?${qs}` : ""}`;
  return request<TeamTasksResponse>(path);
}

export async function getTask(taskId: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${taskId}`);
  return data.task;
}

/**
 * The authoritative create-time confidence the backend returns alongside a
 * newly-created task (POST /api/projects/:id/tasks responds `{ task, confidence }`).
 * It is the deterministic scorer-v2 output plus the project threshold and the
 * derived nextActions; the create form renders this rather than recomputing
 * client-side. `confidence` is optional only as a guard against an older backend.
 */
export interface CreateConfidence {
  score: number;
  threshold: number;
  blocking: boolean;
  missing: string[];
  findings: QualityFinding[];
  nextActions: string[];
}

export async function createTask(
  projectId: string,
  body: {
    title: string;
    description?: string;
    status?: "open" | "in_progress" | "review" | "done";
    priority?: string;
    dueAt?: string;
    templateData?: TemplateData;
  },
): Promise<{ task: Task; confidence?: CreateConfidence }> {
  return request<{ task: Task; confidence?: CreateConfidence }>(`/api/projects/${projectId}/tasks`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateTask(
  taskId: string,
  body: {
    title?: string;
    description?: string | null;
    priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    status?: "open" | "in_progress" | "review" | "done";
    dueAt?: string | null;
    branchName?: string | null;
    prUrl?: string | null;
    prNumber?: number | null;
    result?: string | null;
    templateData?: TemplateData | null;
  },
): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return data.task;
}

export async function deleteTask(taskId: string): Promise<void> {
  await request(`/api/tasks/${taskId}`, { method: "DELETE" });
}

export async function addTaskAttachment(
  taskId: string,
  body: { name: string; url: string },
): Promise<TaskAttachment> {
  const data = await request<{ attachment: TaskAttachment }>(`/api/tasks/${taskId}/attachments`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.attachment;
}

export async function deleteTaskAttachment(taskId: string, attachmentId: string): Promise<void> {
  await request(`/api/tasks/${taskId}/attachments/${attachmentId}`, { method: "DELETE" });
}

/**
 * Upload an image or text file to a task. Uses FormData and deliberately does
 * NOT set Content-Type so the browser adds the multipart boundary. Does not go
 * through `request()` (which forces application/json).
 */
export async function uploadTaskAttachmentFile(
  taskId: string,
  file: File,
  name?: string,
): Promise<TaskAttachment> {
  const form = new FormData();
  form.append("file", file);
  if (name) form.append("name", name);

  const res = await fetch(`${BASE}/api/tasks/${taskId}/attachments/upload`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ApiError;
    // The upload/raw endpoints return { error: "<reason>" } without a separate
    // `message`, so fall back to `error` for the human-readable string rather
    // than stranding the reason (e.g. a magic-byte rejection) in the code slot.
    const msg = err.message ?? err.error ?? "Upload failed";
    throw new ApiRequestError(err.error ?? "upload_failed", msg, res.status);
  }
  const data = (await res.json()) as { attachment: TaskAttachment };
  return data.attachment;
}

/**
 * Absolute URL of an uploaded attachment's bytes. The endpoint is auth-gated by
 * the session cookie, so a same-origin `<img src>` or download link works
 * without a query-string token. NOTE: in split-origin local dev (frontend on
 * :3000, API on :3001) the browser will not attach the SameSite=Lax session
 * cookie to these `<img>`/download requests, so thumbnails 401 locally; this
 * works in same-origin prod (or behind a same-origin dev proxy).
 */
export function rawAttachmentUrl(taskId: string, attachmentId: string): string {
  return `${BASE}/api/tasks/${taskId}/attachments/${attachmentId}/raw`;
}

// ── Artifacts (typed, agent-produced task outputs) ──────────────────────────

export async function listTaskArtifacts(
  taskId: string,
  type?: TaskArtifactType,
): Promise<TaskArtifactMeta[]> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : "";
  const data = await request<{ artifacts: TaskArtifactMeta[] }>(
    `/api/tasks/${taskId}/artifacts${qs}`,
  );
  return data.artifacts;
}

export async function getTaskArtifact(
  taskId: string,
  artifactId: string,
): Promise<TaskArtifact> {
  const data = await request<{ artifact: TaskArtifact }>(
    `/api/tasks/${taskId}/artifacts/${artifactId}`,
  );
  return data.artifact;
}

export async function createTaskArtifact(
  taskId: string,
  body: {
    type: TaskArtifactType;
    name: string;
    description?: string;
    content?: string;
    url?: string;
    mimeType?: string;
  },
): Promise<TaskArtifact> {
  const data = await request<{ artifact: TaskArtifact }>(
    `/api/tasks/${taskId}/artifacts`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return data.artifact;
}

export async function deleteTaskArtifact(
  taskId: string,
  artifactId: string,
): Promise<void> {
  await request(`/api/tasks/${taskId}/artifacts/${artifactId}`, { method: "DELETE" });
}

export async function createComment(taskId: string, content: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(`/api/tasks/${taskId}/comments`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  return data.comment;
}

export async function deleteComment(taskId: string, commentId: string): Promise<void> {
  await request(`/api/tasks/${taskId}/comments/${commentId}`, { method: "DELETE" });
}

export async function addDependency(taskId: string, blockedByTaskId: string): Promise<void> {
  await request(`/api/tasks/${taskId}/dependencies`, {
    method: "POST",
    body: JSON.stringify({ blockedByTaskId }),
  });
}

export async function removeDependency(taskId: string, blockerTaskId: string): Promise<void> {
  await request(`/api/tasks/${taskId}/dependencies/${blockerTaskId}`, { method: "DELETE" });
}

export async function claimTask(taskId: string, force = false): Promise<Task> {
  const qs = force ? "?force=true" : "";
  const data = await request<{ task: Task }>(`/api/tasks/${taskId}/claim${qs}`, { method: "POST" });
  return data.task;
}

export async function releaseTask(taskId: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${taskId}/release`, { method: "POST" });
  return data.task;
}

// Claim + advance an open task to in_progress in one call (the v2 `/start`
// endpoint). Workflow gates and the dependency gate are enforced server-side.
export async function startTask(taskId: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${taskId}/start`, { method: "POST" });
  return data.task;
}

export async function transitionTask(
  taskId: string,
  status: string,
  options: { force?: boolean; forceReason?: string } = {},
): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${taskId}/transition`, {
    method: "POST",
    body: JSON.stringify({ status, ...options }),
  });
  return data.task;
}

export async function reviewTask(taskId: string, action: "approve" | "request_changes", comment?: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${taskId}/review`, {
    method: "POST",
    body: JSON.stringify({ action, ...(comment?.trim() ? { comment: comment.trim() } : {}) }),
  });
  return data.task;
}

// ── Audit ─────────────────────────────────────────────────────────────────────

// ── Workflows ────────────────────────────────────────────────────────────────

export interface WorkflowState {
  name: string;
  label: string;
  terminal: boolean;
  agentInstructions?: string;
}

export interface WorkflowTransition {
  from: string;
  to: string;
  label?: string;
  requiredRole?: string;
  requires?: string[];
}

export interface WorkflowDefinition {
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  initialState: string;
}

// ── Workflow editor: effective-workflow + customize / reset / rules catalog ──

export interface WorkflowRule {
  id: string;
  label: string;
  description: string;
  failureMessage: string;
}

export interface EffectiveWorkflow {
  source: "custom" | "default";
  workflowId: string | null;
  definition: WorkflowDefinition;
}

export async function getWorkflowRules(): Promise<WorkflowRule[]> {
  const data = await request<{ rules: WorkflowRule[] }>(`/api/workflow-rules`);
  return data.rules;
}

export async function getEffectiveWorkflow(projectId: string): Promise<EffectiveWorkflow> {
  return request<EffectiveWorkflow>(
    `/api/projects/${projectId}/effective-workflow`,
  );
}

export async function customizeProjectWorkflow(projectId: string): Promise<EffectiveWorkflow> {
  return request<EffectiveWorkflow>(`/api/projects/${projectId}/workflow/customize`, {
    method: "POST",
  });
}

export async function resetProjectWorkflow(projectId: string): Promise<EffectiveWorkflow> {
  return request<EffectiveWorkflow>(`/api/projects/${projectId}/workflow`, {
    method: "DELETE",
  });
}

export interface WorkflowTemplateSummary {
  slug: string;
  name: string;
  description: string;
  stateCount: number;
  initialState: string;
}

export async function listWorkflowTemplates(): Promise<WorkflowTemplateSummary[]> {
  const data = await request<{ templates: WorkflowTemplateSummary[] }>("/api/workflow-templates");
  return data.templates;
}

export async function applyWorkflowTemplate(projectId: string, slug: string): Promise<EffectiveWorkflow> {
  return request<EffectiveWorkflow>(`/api/projects/${projectId}/workflow/apply-template/${slug}`, {
    method: "POST",
  });
}

export interface Workflow {
  id: string;
  projectId: string;
  name: string;
  isDefault: boolean;
  definition: WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
}

export async function getWorkflows(projectId: string): Promise<Workflow[]> {
  const data = await request<{ workflows: Workflow[] }>(`/api/projects/${projectId}/workflows`);
  return data.workflows;
}

export async function createWorkflow(
  projectId: string,
  body: { name: string; isDefault?: boolean; definition: WorkflowDefinition },
): Promise<Workflow> {
  const data = await request<{ workflow: Workflow }>(`/api/projects/${projectId}/workflows`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.workflow;
}

export async function updateWorkflow(
  workflowId: string,
  body: { name?: string; isDefault?: boolean; definition?: WorkflowDefinition },
): Promise<Workflow> {
  const data = await request<{ workflow: Workflow }>(`/api/workflows/${workflowId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return data.workflow;
}

export async function getProjectAuditLogs(projectId: string, limit = 50): Promise<AuditLog[]> {
  const data = await request<{ logs: AuditLog[] }>(
    `/api/projects/${projectId}/audit?limit=${limit}`,
  );
  return data.logs;
}

export async function getGitHubDelegationLogs(projectId: string, opts?: { action?: string; limit?: number }): Promise<AuditLog[]> {
  const params = new URLSearchParams();
  if (opts?.action) params.set("action", opts.action);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.toString() ? `?${params.toString()}` : "";
  const data = await request<{ logs: AuditLog[] }>(
    `/api/projects/${projectId}/audit/github-delegation${qs}`,
  );
  return data.logs;
}

// ── Per-project sharing ─────────────────────────────────────────────────────

export type ProjectMemberRole = "PROJECT_VIEWER" | "PROJECT_CONTRIBUTOR" | "PROJECT_ADMIN";

export interface ProjectMember {
  id: string;
  userId: string;
  role: ProjectMemberRole;
  joinedAt: string;
  user: {
    id: string;
    login: string;
    name: string | null;
    avatarUrl: string | null;
  };
}

export interface ProjectInvite {
  id: string;
  projectId: string;
  role: ProjectMemberRole;
  createdById: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedById: string | null;
  createdAt: string;
  status: "pending" | "expired" | "consumed";
}

export interface CreateInviteResponse {
  invite: ProjectInvite;
  plainToken: string;
}

export interface InvitePreview {
  projectId: string;
  projectName: string;
  projectSlug: string;
  ownerLogin: string;
  role: ProjectMemberRole;
  expiresAt: string;
}

export async function createProjectInvite(
  projectId: string,
  body: { role: ProjectMemberRole; expiresInDays?: number },
): Promise<CreateInviteResponse> {
  return request<CreateInviteResponse>(`/api/projects/${projectId}/invites`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listProjectInvites(projectId: string): Promise<ProjectInvite[]> {
  const data = await request<{ invites: ProjectInvite[] }>(
    `/api/projects/${projectId}/invites`,
  );
  return data.invites;
}

export async function revokeProjectInvite(projectId: string, inviteId: string): Promise<void> {
  await request<{ success: true }>(`/api/projects/${projectId}/invites/${inviteId}`, {
    method: "DELETE",
  });
}

export async function previewInvite(token: string): Promise<InvitePreview> {
  const data = await request<{ preview: InvitePreview }>(`/api/invites/preview`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  return data.preview;
}

export async function acceptInvite(token: string): Promise<{
  projectId: string;
  role: ProjectMemberRole;
  soloModeChanged: boolean;
}> {
  const data = await request<{
    success: true;
    projectId: string;
    role: ProjectMemberRole;
    soloModeChanged: boolean;
  }>(`/api/invites/accept`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  return {
    projectId: data.projectId,
    role: data.role,
    soloModeChanged: data.soloModeChanged,
  };
}

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const data = await request<{ members: ProjectMember[] }>(
    `/api/projects/${projectId}/members`,
  );
  return data.members;
}

export async function removeProjectMember(projectId: string, userId: string): Promise<{
  claimsReleased: number;
}> {
  const data = await request<{ success: true; claimsReleased: number }>(
    `/api/projects/${projectId}/members/${userId}`,
    { method: "DELETE" },
  );
  return { claimsReleased: data.claimsReleased };
}
