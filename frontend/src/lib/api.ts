const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: "Request failed" }));
    throw new Error(err.message ?? "Request failed");
  }
  return res.json() as Promise<T>;
}

export async function getTasks(projectId: string) {
  return request<{ tasks: unknown[] }>(`/api/projects/${projectId}/tasks`);
}

export async function createTask(projectId: string, body: { title: string; priority?: string }) {
  return request(`/api/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify(body) });
}

export async function claimTask(taskId: string) {
  return request(`/api/tasks/${taskId}/claim`, { method: "POST" });
}

export async function releaseTask(taskId: string) {
  return request(`/api/tasks/${taskId}/release`, { method: "POST" });
}

export async function transitionTask(taskId: string, status: string) {
  return request(`/api/tasks/${taskId}/transition`, { method: "POST", body: JSON.stringify({ status }) });
}
