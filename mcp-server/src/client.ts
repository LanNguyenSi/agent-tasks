export interface ClientConfig {
  baseUrl: string;
  token: string;
}

export class AgentTasksApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "AgentTasksApiError";
  }
}

export class AgentTasksClient {
  constructor(private readonly config: ClientConfig) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const msg =
        (parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : undefined) ?? `${method} ${path} failed: ${res.status}`;
      throw new AgentTasksApiError(res.status, parsed, msg);
    }

    return parsed as T;
  }

  listProjects() {
    return this.request<unknown>("GET", "/api/projects/available");
  }

  listClaimableTasks(params?: { limit?: number }) {
    const qs =
      params?.limit !== undefined ? `?limit=${params.limit}` : "";
    return this.request<unknown>("GET", `/api/tasks/claimable${qs}`);
  }

  getTask(taskId: string) {
    return this.request<unknown>("GET", `/api/tasks/${taskId}`);
  }

  getTaskInstructions(taskId: string) {
    return this.request<unknown>("GET", `/api/tasks/${taskId}/instructions`);
  }

  createTask(
    projectId: string,
    input: {
      title: string;
      description?: string;
      priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
      workflowId?: string;
      dueAt?: string;
      externalRef?: string;
      labels?: string[];
    },
  ) {
    return this.request<unknown>(
      "POST",
      `/api/projects/${projectId}/tasks`,
      input,
    );
  }

  claimTask(taskId: string) {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/claim`);
  }

  releaseTask(taskId: string) {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/release`);
  }

  transitionTask(
    taskId: string,
    input: { status: string; force?: boolean; forceReason?: string },
  ) {
    return this.request<unknown>(
      "POST",
      `/api/tasks/${taskId}/transition`,
      input,
    );
  }

  updateTask(
    taskId: string,
    input: {
      branchName?: string | null;
      prUrl?: string | null;
      prNumber?: number | null;
      result?: string | null;
    },
  ) {
    return this.request<unknown>("PATCH", `/api/tasks/${taskId}`, input);
  }

  addTaskComment(taskId: string, content: string) {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/comments`, {
      content,
    });
  }

  pollSignals() {
    return this.request<unknown>("GET", "/api/agent/signals");
  }

  ackSignal(signalId: string) {
    return this.request<unknown>("POST", `/api/agent/signals/${signalId}/ack`);
  }
}
