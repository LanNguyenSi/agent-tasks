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

export interface Project {
  id: string;
  teamId: string;
  name: string;
  slug: string;
  description: string | null;
  githubRepo: string | null;
  githubSyncAt: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  claimedByUserId: string | null;
  claimedByAgentId: string | null;
  claimedAt: string | null;
  dueAt: string | null;
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

export async function claimTask(taskId: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${taskId}/claim`, { method: "POST" });
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

export async function getProjectAuditLogs(projectId: string, limit = 50): Promise<AuditLog[]> {
  const data = await request<{ logs: AuditLog[] }>(
    `/api/projects/${projectId}/audit?limit=${limit}`,
  );
  return data.logs;
}
