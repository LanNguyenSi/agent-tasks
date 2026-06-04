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

  getProjectEffectiveGates(projectId: string) {
    return this.request<unknown>(
      "GET",
      `/api/projects/${projectId}/effective-gates`,
    );
  }

  listClaimableTasks(params?: {
    limit?: number;
    projectId?: string;
    status?: string | string[];
    priority?: string | string[];
    labels?: string[];
    claimedByAgentId?: string;
    verbose?: boolean;
  }) {
    const sp = new URLSearchParams();
    if (params?.limit !== undefined) sp.set("limit", String(params.limit));
    if (params?.projectId) sp.set("projectId", params.projectId);
    if (params?.status !== undefined) {
      sp.set("status", Array.isArray(params.status) ? params.status.join(",") : params.status);
    }
    if (params?.priority !== undefined) {
      sp.set("priority", Array.isArray(params.priority) ? params.priority.join(",") : params.priority);
    }
    if (params?.labels && params.labels.length > 0) sp.set("labels", params.labels.join(","));
    if (params?.claimedByAgentId) sp.set("claimedByAgentId", params.claimedByAgentId);
    if (params?.verbose) sp.set("verbose", "true");
    const qs = sp.toString();
    return this.request<unknown>(
      "GET",
      qs.length > 0 ? `/api/tasks/claimable?${qs}` : `/api/tasks/claimable`,
    );
  }

  // Browse tasks scoped to a single project. Accepts slug or UUID for
  // `project`; if a slug is passed we resolve it to a UUID first via the
  // existing by-slug lookup so callers don't have to chain projects_get
  // themselves. Mirrors the filter surface of the CLI's `tasks list
  // --project` flow and forwards to GET /api/projects/:id/tasks.
  async listProjectTasks(
    project: string,
    params?: {
      status?: string | string[];
      priority?: string | string[];
      labels?: string[];
      unclaimed?: boolean;
      limit?: number;
    },
  ) {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        project,
      );
    let projectId: string;
    if (isUuid) {
      projectId = project;
    } else {
      const resolved = (await this.request<{ project: { id: string } }>(
        "GET",
        `/api/projects/by-slug/${encodeURIComponent(project)}`,
      )).project;
      projectId = resolved.id;
    }

    const sp = new URLSearchParams();
    if (params?.status !== undefined) {
      sp.set(
        "status",
        Array.isArray(params.status) ? params.status.join(",") : params.status,
      );
    }
    if (params?.priority !== undefined) {
      sp.set(
        "priority",
        Array.isArray(params.priority)
          ? params.priority.join(",")
          : params.priority,
      );
    }
    if (params?.labels && params.labels.length > 0) {
      sp.set("labels", params.labels.join(","));
    }
    if (params?.unclaimed) sp.set("unclaimed", "true");
    if (params?.limit !== undefined) sp.set("limit", String(params.limit));

    const qs = sp.toString();
    return this.request<unknown>(
      "GET",
      qs.length > 0
        ? `/api/projects/${projectId}/tasks?${qs}`
        : `/api/projects/${projectId}/tasks`,
    );
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
      dependsOn?: string[];
      debugFlavor?: boolean;
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

  startTask(taskId: string, input?: { branchName?: string }) {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/start`, input);
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

  mergeTask(taskId: string, mergeMethod?: "squash" | "merge" | "rebase") {
    return this.request<unknown>("POST", `/api/tasks/${taskId}/merge`, {
      mergeMethod: mergeMethod ?? "squash",
    });
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

  // ── Attachments (human-uploaded files, read-only for agents) ─────────────
  //
  // List returns metadata only; get-content returns a text excerpt (text/*) or
  // base64 (image/*). Agents cannot upload or delete attachments.

  listTaskAttachments(taskId: string) {
    return this.request<unknown>("GET", `/api/tasks/${taskId}/attachments`);
  }

  getTaskAttachmentContent(
    taskId: string,
    attachmentId: string,
    opts: { includeBase64?: boolean; textByteLimit?: number; base64ByteLimit?: number } = {},
  ) {
    const qs = new URLSearchParams();
    if (opts.includeBase64) qs.set("includeBase64", "true");
    if (opts.textByteLimit !== undefined) qs.set("textByteLimit", String(opts.textByteLimit));
    if (opts.base64ByteLimit !== undefined) qs.set("base64ByteLimit", String(opts.base64ByteLimit));
    const q = qs.toString();
    return this.request<unknown>(
      "GET",
      `/api/tasks/${taskId}/attachments/${attachmentId}/content${q ? `?${q}` : ""}`,
    );
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
    idempotencyKey?: string;
  }) {
    return this.request<unknown>("POST", "/api/github/pull-requests", input);
  }

  mergePullRequest(input: {
    taskId: string;
    owner: string;
    repo: string;
    prNumber: number;
    merge_method?: "merge" | "squash" | "rebase";
    idempotencyKey?: string;
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
    idempotencyKey?: string;
  }) {
    const { prNumber, ...rest } = input;
    return this.request<unknown>(
      "POST",
      `/api/github/pull-requests/${prNumber}/comments`,
      rest,
    );
  }
}
