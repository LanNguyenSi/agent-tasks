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

  getProject(slugOrId: string) {
    // Mirror the CLI: UUIDs route to the id endpoint, anything else is
    // treated as a slug. Keeps the MCP tool input permissive (one string)
    // without forcing callers to know which flavor of identifier they hold.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);
    const path = isUuid
      ? `/api/projects/${slugOrId}`
      : `/api/projects/by-slug/${encodeURIComponent(slugOrId)}`;
    return this.request<unknown>("GET", path);
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

  reviewTask(
    taskId: string,
    input: { action: "approve" | "request_changes"; comment?: string },
  ) {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/review`, input);
  }

  claimReview(taskId: string) {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/review/claim`);
  }

  releaseReview(taskId: string) {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/review/release`);
  }

  // ── v2 MCP workflow surface ──────────────────────────────────────────
  //
  // Verb-oriented endpoints backing the v2 MCP tools. See ADR 0008.

  pickupWork() {
    return this.request<unknown>("POST", "/api/tasks/pickup");
  }

  startTask(taskId: string) {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/start`);
  }

  finishTask(
    taskId: string,
    input: {
      result?: string;
      prUrl?: string;
      outcome?: "approve" | "request_changes";
      autoMerge?: boolean;
      mergeMethod?: "squash" | "merge" | "rebase";
    },
  ) {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/finish`, input);
  }

  abandonTask(taskId: string) {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/abandon`);
  }

  submitPr(
    taskId: string,
    input: { branchName: string; prUrl: string; prNumber: number },
  ) {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/submit-pr`, input);
  }

  pollSignals() {
    return this.request<unknown>("GET", "/api/agent/signals");
  }

  // ── Artifacts ────────────────────────────────────────────────────────────
  //
  // Typed, agent-produced task outputs (build logs, test reports, etc.).
  // List returns metadata only; get-by-id returns the payload.

  listTaskArtifacts(taskId: string, type?: string) {
    const qs = type ? `?type=${encodeURIComponent(type)}` : "";
    return this.request<unknown>("GET", `/api/tasks/${taskId}/artifacts${qs}`);
  }

  getTaskArtifact(taskId: string, artifactId: string) {
    return this.request<unknown>("GET", `/api/tasks/${taskId}/artifacts/${artifactId}`);
  }

  createTaskArtifact(
    taskId: string,
    input: {
      type: string;
      name: string;
      description?: string;
      content?: string;
      url?: string;
      mimeType?: string;
    },
  ) {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/artifacts`, input);
  }

  ackSignal(signalId: string) {
    return this.request<unknown>("POST", `/api/agent/signals/${signalId}/ack`);
  }

  // ── GitHub PR delegation ──────────────────────────────────────────────
  //
  // Thin wrappers around the three `/api/github/pull-requests*` endpoints.
  // All three are AGENT-ONLY at the backend (humans get 403) because they
  // depend on the GitHub delegation token of a user who has connected
  // GitHub and opted in to PR actions — see backend/src/routes/github.ts.

  createPullRequest(input: {
    taskId: string;
    owner: string;
    repo: string;
    head: string;
    base?: string;
    title: string;
    body?: string;
  }) {
    return this.request<unknown>("POST", "/api/github/pull-requests", input);
  }

  mergePullRequest(input: {
    taskId: string;
    owner: string;
    repo: string;
    prNumber: number;
    merge_method?: "merge" | "squash" | "rebase";
  }) {
    const { prNumber, ...body } = input;
    return this.request<unknown>(
      "POST",
      `/api/github/pull-requests/${prNumber}/merge`,
      body,
    );
  }

  commentOnPullRequest(input: {
    taskId: string;
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }) {
    const { prNumber, ...rest } = input;
    return this.request<unknown>(
      "POST",
      `/api/github/pull-requests/${prNumber}/comments`,
      rest,
    );
  }
}
