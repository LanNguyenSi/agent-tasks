const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
  githubConnected: boolean;
}

export interface TemplatePreset {
  name: string;
  description?: string;
  goal?: string;
  acceptanceCriteria?: string;
  context?: string;
  constraints?: string;
}

export interface TaskTemplate {
  fields: {
    goal: boolean;
    acceptanceCriteria: boolean;
    context: boolean;
    constraints: boolean;
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
  createdAt: string;
}

export interface TemplateData {
  goal?: string;
  acceptanceCriteria?: string;
  context?: string;
  constraints?: string;
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
  createdAt: string;
  updatedAt: string;
  attachments: TaskAttachment[];
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
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  name: string;
  url: string;
  createdAt: string;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "include",
    ...init,
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({ message: "Request failed" }))) as ApiError;
    throw new Error(err.message ?? "Request failed");
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

export async function createAgentToken(body: {
  teamId: string;
  name: string;
  scopes: string[];
}): Promise<CreateAgentTokenResponse> {
  return request<CreateAgentTokenResponse>("/api/agent-tokens", { method: "POST", body: JSON.stringify(body) });
}

export async function revokeAgentToken(tokenId: string): Promise<void> {
  await request(`/api/agent-tokens/${tokenId}/revoke`, { method: "POST" });
}

export async function getAgentTokens(teamId: string): Promise<AgentToken[]> {
  const data = await request<{ tokens: AgentToken[] }>(`/api/agent-tokens?teamId=${teamId}`);
  return data.tokens;
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
): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/projects/${projectId}/tasks`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.task;
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

export async function claimTask(taskId: string, force = false): Promise<Task> {
  const qs = force ? "?force=true" : "";
  const data = await request<{ task: Task }>(`/api/tasks/${taskId}/claim${qs}`, { method: "POST" });
  return data.task;
}

export async function releaseTask(taskId: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${taskId}/release`, { method: "POST" });
  return data.task;
}

export async function transitionTask(taskId: string, status: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${taskId}/transition`, {
    method: "POST",
    body: JSON.stringify({ status }),
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
}

export interface WorkflowDefinition {
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  initialState: string;
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
