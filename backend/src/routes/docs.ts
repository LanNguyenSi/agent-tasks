import { Hono } from "hono";

export const docsRouter = new Hono();

const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "agent-tasks API",
    version: "1.0.0",
    description:
      "API documentation for humans and agents. Agent automation uses Bearer agent tokens with scopes.",
  },
  servers: [
    { url: "http://localhost:3001", description: "Local development" },
  ],
  tags: [
    { name: "Projects", description: "Project discovery and management" },
    { name: "Tasks", description: "Task read/write/claim/transition operations" },
    { name: "GitHub", description: "GitHub PR operations via delegation (agent-only)" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API Token",
        description: "Agent token from Settings > API Tokens, e.g. at_xxx",
      },
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        properties: {
          error: { type: "string", example: "forbidden" },
          message: { type: "string", example: "Missing scope: tasks:create" },
        },
        required: ["error", "message"],
      },
      TemplateData: {
        type: "object",
        description: "Structured task information for agents. Fields match the project's task template configuration.",
        properties: {
          goal: { type: "string", description: "What should be achieved" },
          acceptanceCriteria: { type: "string", description: "When is the task done" },
          context: { type: "string", description: "Relevant files, links, dependencies" },
          constraints: { type: "string", description: "What must not happen" },
        },
      },
      TemplatePreset: {
        type: "object",
        description: "A reusable preset that pre-fills description and template fields when creating a task.",
        properties: {
          name: { type: "string", example: "Bug Fix" },
          description: { type: "string", description: "Pre-filled task description" },
          goal: { type: "string" },
          acceptanceCriteria: { type: "string" },
          context: { type: "string" },
          constraints: { type: "string" },
        },
        required: ["name"],
      },
      TaskTemplate: {
        type: "object",
        description: "Project-level template configuration for structured task data.",
        properties: {
          fields: {
            type: "object",
            properties: {
              goal: { type: "boolean" },
              acceptanceCriteria: { type: "boolean" },
              context: { type: "boolean" },
              constraints: { type: "boolean" },
            },
          },
          presets: {
            type: "array",
            items: { $ref: "#/components/schemas/TemplatePreset" },
            description: "Reusable presets that pre-fill template fields",
          },
        },
        required: ["fields"],
      },
      Confidence: {
        type: "object",
        description: "Deterministic confidence score based on task completeness. Score below threshold blocks agent claims.",
        properties: {
          score: { type: "integer", minimum: 0, maximum: 100, example: 75 },
          missing: {
            type: "array",
            items: { type: "string" },
            example: ["constraints"],
            description: "Template fields that are empty or missing",
          },
          threshold: { type: "integer", minimum: 0, maximum: 100, example: 60, description: "Project-configured minimum score for agent claims" },
        },
        required: ["score", "missing", "threshold"],
      },
      LowConfidenceError: {
        type: "object",
        properties: {
          error: { type: "string", example: "low_confidence" },
          message: { type: "string", example: "Task does not meet confidence threshold for agent claiming" },
          details: { $ref: "#/components/schemas/Confidence" },
        },
        required: ["error", "message", "details"],
      },
      PreconditionFailedError: {
        type: "object",
        description: "Returned when one or more workflow transition rules (branchPresent, prPresent, ciGreen, prMerged) block the state change requested by the caller.",
        properties: {
          error: { type: "string", example: "precondition_failed" },
          message: { type: "string", example: "Transition blocked — No branch recorded on this task. PATCH /api/tasks/:id with branchName first." },
          failed: {
            type: "array",
            items: {
              type: "object",
              properties: {
                rule: { type: "string", example: "branchPresent" },
                message: { type: "string", example: "No branch recorded on this task. PATCH /api/tasks/:id with branchName first." },
                error: { type: "string", nullable: true, description: "Populated when the rule evaluator itself errored (e.g. GitHub API unreachable for ciGreen)." },
              },
              required: ["rule", "message"],
            },
          },
          canForce: {
            type: "boolean",
            example: false,
            description: "Whether this route accepts a force=true query parameter to bypass the gate. /tasks/:id/claim does NOT; use /tasks/:id/start with force=true + forceReason when an admin-level bypass is needed.",
          },
        },
        required: ["error", "message", "failed", "canForce"],
      },
      Project: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          teamId: { type: "string", format: "uuid" },
          name: { type: "string" },
          slug: { type: "string" },
          description: { type: "string", nullable: true },
          githubRepo: { type: "string", nullable: true, example: "owner/repo" },
          githubSyncAt: { type: "string", format: "date-time", nullable: true },
          taskTemplate: {
            nullable: true,
            allOf: [{ $ref: "#/components/schemas/TaskTemplate" }],
            description: "Template configuration with field toggles and reusable presets",
          },
          confidenceThreshold: { type: "integer", minimum: 0, maximum: 100, default: 60, description: "Minimum confidence score for agent claims" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "teamId", "name", "slug", "createdAt", "updatedAt"],
      },
      AvailableProject: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          slug: { type: "string" },
          displayName: { type: "string", example: "Foobar API (foobar-api)" },
          description: { type: "string", nullable: true },
          githubRepo: { type: "string", nullable: true, example: "owner/repo" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "slug", "displayName", "createdAt", "updatedAt"],
      },
      TaskAttachment: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          taskId: { type: "string", format: "uuid" },
          name: { type: "string" },
          url: { type: "string", format: "uri" },
          createdByUserId: { type: "string", format: "uuid", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "taskId", "name", "url", "createdAt"],
      },
      Task: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          projectId: { type: "string", format: "uuid" },
          workflowId: { type: "string", format: "uuid", nullable: true },
          title: { type: "string" },
          description: { type: "string", nullable: true },
          status: { type: "string", example: "open" },
          priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
          createdByUserId: { type: "string", format: "uuid", nullable: true },
          createdByAgentId: { type: "string", format: "uuid", nullable: true },
          claimedByUserId: { type: "string", format: "uuid", nullable: true },
          claimedByAgentId: { type: "string", format: "uuid", nullable: true },
          claimedAt: { type: "string", format: "date-time", nullable: true },
          dueAt: { type: "string", format: "date-time", nullable: true },
          branchName: { type: "string", nullable: true, example: "fix/issue-42" },
          prUrl: { type: "string", format: "uri", nullable: true, example: "https://github.com/owner/repo/pull/123" },
          prNumber: { type: "integer", nullable: true, example: 123 },
          templateData: {
            nullable: true,
            allOf: [{ $ref: "#/components/schemas/TemplateData" }],
            description: "Structured task data filled from template fields or presets",
          },
          result: { type: "string", nullable: true, description: "Agent output/summary after task completion" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          attachments: {
            type: "array",
            items: { $ref: "#/components/schemas/TaskAttachment" },
          },
        },
        required: [
          "id",
          "projectId",
          "title",
          "status",
          "priority",
          "createdAt",
          "updatedAt",
        ],
      },
      AgentUpdateTaskRequest: {
        type: "object",
        properties: {
          branchName: { type: "string", nullable: true, example: "fix/issue-42" },
          prUrl: { type: "string", format: "uri", nullable: true },
          prNumber: { type: "integer", nullable: true },
          result: { type: "string", nullable: true },
        },
      },
      TaskInstructions: {
        type: "object",
        properties: {
          task: { $ref: "#/components/schemas/Task" },
          currentState: {
            type: "object",
            nullable: true,
            properties: {
              name: { type: "string" },
              label: { type: "string" },
              terminal: { type: "boolean" },
              agentInstructions: { type: "string", nullable: true },
            },
          },
          agentInstructions: { type: "string", nullable: true, description: "What the agent should do right now" },
          allowedTransitions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                to: { type: "string" },
                label: { type: "string" },
              },
              required: ["to"],
            },
          },
          reviewActions: {
            type: "array",
            items: { type: "string", enum: ["approve", "request_changes"] },
            description: "Available review actions for the current actor (empty if not in review or actor is the claimant)",
          },
          recommendedAction: {
            type: "string",
            nullable: true,
            description: "Human-readable hint for the recommended next step",
          },
          workflowModel: {
            type: "object",
            description: "Explains how the default task workflow relates to operational steps like merge, deploy, and verification.",
            properties: {
              reviewScope: {
                type: "string",
                enum: ["code_review_only"],
              },
              externalFollowUps: {
                type: "array",
                items: { type: "string", enum: ["merge", "deploy", "verify"] },
              },
              notes: {
                type: "string",
              },
            },
            required: ["reviewScope", "externalFollowUps", "notes"],
          },
          updatableFields: {
            type: "array",
            items: { type: "string" },
            example: ["branchName", "prUrl", "prNumber", "result"],
          },
          actorPermissions: {
            type: "object",
            description: "What the current actor is allowed to do",
            properties: {
              canTransition: { type: "boolean" },
              canUpdate: { type: "boolean" },
              canComment: { type: "boolean" },
              canClaim: { type: "boolean" },
            },
            required: ["canTransition", "canUpdate", "canComment", "canClaim"],
          },
          confidence: { $ref: "#/components/schemas/Confidence" },
        },
        required: ["task", "agentInstructions", "allowedTransitions", "reviewActions", "recommendedAction", "workflowModel", "updatableFields", "actorPermissions", "confidence"],
      },
      ProjectRef: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          slug: { type: "string" },
        },
        required: ["id", "name", "slug"],
      },
      ClaimableTask: {
        allOf: [
          { $ref: "#/components/schemas/Task" },
          {
            type: "object",
            properties: {
              project: { $ref: "#/components/schemas/ProjectRef" },
            },
            required: ["project"],
          },
        ],
      },
      CreateTaskRequest: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 255 },
          description: { type: "string" },
          status: { type: "string", enum: ["open", "in_progress", "review", "done"] },
          priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
          workflowId: { type: "string", format: "uuid" },
          dueAt: { type: "string", format: "date-time" },
          templateData: { $ref: "#/components/schemas/TemplateData" },
        },
        required: ["title"],
      },
      TransitionTaskRequest: {
        type: "object",
        properties: {
          status: { type: "string", example: "review" },
        },
        required: ["status"],
      },
    },
  },
  paths: {
    "/api/projects/available": {
      get: {
        tags: ["Projects"],
        summary: "List token-available projects (ID + cleartext)",
        description:
          "Recommended discovery endpoint for agents. Returns project id plus human-readable name and slug.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "teamId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
            description: "Optional for agents, required for humans.",
          },
        ],
        responses: {
          "200": {
            description: "Available projects for current auth context",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    projects: {
                      type: "array",
                      items: { $ref: "#/components/schemas/AvailableProject" },
                    },
                  },
                  required: ["projects"],
                },
              },
            },
          },
          "403": {
            description: "No team access",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/projects/by-slug/{slug}": {
      get: {
        tags: ["Projects"],
        summary: "Get project by slug",
        description: "Lookup a project by its human-readable slug instead of UUID. For agents, teamId is inferred from the token. Humans must pass teamId as query parameter.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Project slug (e.g. agent-tasks)",
          },
          {
            name: "teamId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
            description: "Required for human users, inferred for agents",
          },
        ],
        responses: {
          "200": {
            description: "Project",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    project: { $ref: "#/components/schemas/Project" },
                  },
                  required: ["project"],
                },
              },
            },
          },
          "404": {
            description: "Project not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/projects/{id}": {
      get: {
        tags: ["Projects"],
        summary: "Get project by ID",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Project",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    project: { $ref: "#/components/schemas/Project" },
                  },
                  required: ["project"],
                },
              },
            },
          },
          "404": {
            description: "Project not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/projects/{projectId}/tasks": {
      get: {
        tags: ["Tasks"],
        summary: "List tasks for a project",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "projectId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Task list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tasks: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Task" },
                    },
                  },
                  required: ["tasks"],
                },
              },
            },
          },
          "403": {
            description: "No project access",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
      post: {
        tags: ["Tasks"],
        summary: "Create task in project",
        description: "Agent tokens require scope: tasks:create.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "projectId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateTaskRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Task created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { task: { $ref: "#/components/schemas/Task" } },
                  required: ["task"],
                },
              },
            },
          },
          "403": {
            description: "Missing scope or no access",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/tasks/claimable": {
      get: {
        tags: ["Tasks"],
        summary: "List claimable (open + unclaimed) tasks",
        description:
          "For agents, team scope is inferred from token; optionally narrow by projectId. For humans, provide projectId or teamId.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "projectId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "teamId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
            description: "Needed for humans when projectId is omitted.",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
        ],
        responses: {
          "200": {
            description: "Claimable tasks with project cleartext",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tasks: {
                      type: "array",
                      items: { $ref: "#/components/schemas/ClaimableTask" },
                    },
                  },
                  required: ["tasks"],
                },
              },
            },
          },
          "400": {
            description: "Missing required query parameters",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "403": {
            description: "Access denied",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/tasks/{id}": {
      patch: {
        tags: ["Tasks"],
        summary: "Update task (agent-safe fields)",
        description:
          "Agents can update: branchName, prUrl, prNumber, result. Requires scope: tasks:update. Humans can update all fields.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AgentUpdateTaskRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Task updated",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { task: { $ref: "#/components/schemas/Task" } },
                  required: ["task"],
                },
              },
            },
          },
          "403": {
            description: "Missing scope or forbidden fields",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
      get: {
        tags: ["Tasks"],
        summary: "Get task by ID",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Task details",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { task: { $ref: "#/components/schemas/Task" } },
                  required: ["task"],
                },
              },
            },
          },
          "404": {
            description: "Task not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/tasks/{id}/instructions": {
      get: {
        tags: ["Tasks"],
        summary: "Get task instructions for agent",
        description:
          "Returns the task with workflow context: current state, agent instructions, allowed transitions, review actions, permissions, and the default workflow model. In the default model, review is code-review only; merge, deploy, and verification are operational follow-ups unless a custom workflow models them explicitly. Requires scope: tasks:read.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Task instructions",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TaskInstructions" },
              },
            },
          },
          "404": {
            description: "Task not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/tasks/{id}/claim": {
      post: {
        tags: ["Tasks"],
        summary: "Claim task",
        description: "Agent tokens require scope: tasks:claim. Claimed task is moved to in_progress. Two gates can return 422: (1) confidence — task description incomplete for agent claiming (use ?force=true to bypass); (2) workflow preconditions — branchPresent/prPresent/ciGreen/prMerged rules on the open→in_progress transition of the project's workflow (no force bypass here; use /tasks/:id/start with force=true + forceReason when a bypass is required).",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "force",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["true"] },
            description: "Set to 'true' to bypass the confidence threshold check (for agents that can self-research missing context).",
          },
        ],
        responses: {
          "200": {
            description: "Task claimed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { task: { $ref: "#/components/schemas/Task" } },
                  required: ["task"],
                },
              },
            },
          },
          "403": {
            description: "Missing scope or access denied",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "409": {
            description: "Task already claimed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "422": {
            description: "Either (a) the task's confidence score is below the project threshold (agents only; ?force=true bypasses), or (b) a workflow transition-rule precondition failed on the open→in_progress edge (branchPresent, prPresent, ciGreen, prMerged). Mirrors the gate stack enforced by /tasks/:id/start (v2). Distinguish via the `error` field: `low_confidence` vs `precondition_failed`.",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/LowConfidenceError" },
                    { $ref: "#/components/schemas/PreconditionFailedError" },
                  ],
                  discriminator: { propertyName: "error" },
                },
              },
            },
          },
        },
      },
    },
    "/api/tasks/{id}/release": {
      post: {
        tags: ["Tasks"],
        summary: "Release claimed task",
        description: "Only current claimant can release. Status is reset to open.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Task released",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { task: { $ref: "#/components/schemas/Task" } },
                  required: ["task"],
                },
              },
            },
          },
          "403": {
            description: "Not claimant or no access",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/tasks/{id}/transition": {
      post: {
        tags: ["Tasks"],
        summary: "Transition task status",
        description: "Agent tokens require scope: tasks:transition.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TransitionTaskRequest" },
              examples: {
                inReview: {
                  value: { status: "review" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Task transitioned",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { task: { $ref: "#/components/schemas/Task" } },
                  required: ["task"],
                },
              },
            },
          },
          "403": {
            description: "Missing scope or no access",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/github/pull-requests": {
      post: {
        tags: ["GitHub"],
        summary: "Create a pull request",
        description: "Creates a GitHub PR via delegation. Requires agent token with scope: tasks:update. A team member must have GitHub connected and 'Allow agents to create PRs' enabled.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  taskId: { type: "string", format: "uuid", description: "Task to associate with the PR" },
                  owner: { type: "string", description: "GitHub repo owner", example: "LanNguyenSi" },
                  repo: { type: "string", description: "GitHub repo name", example: "agent-relay" },
                  head: { type: "string", description: "Source branch name", example: "feat/my-feature" },
                  base: { type: "string", description: "Target branch (default: main)", example: "main" },
                  title: { type: "string", description: "PR title" },
                  body: { type: "string", description: "PR description (optional)" },
                },
                required: ["taskId", "owner", "repo", "head", "title"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "PR created and task updated",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    pullRequest: {
                      type: "object",
                      properties: {
                        number: { type: "integer", example: 42 },
                        url: { type: "string", format: "uri", example: "https://github.com/owner/repo/pull/42" },
                        title: { type: "string" },
                      },
                      required: ["number", "url", "title"],
                    },
                    task: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        branchName: { type: "string" },
                        prUrl: { type: "string", format: "uri" },
                        prNumber: { type: "integer" },
                      },
                      required: ["id", "branchName", "prUrl", "prNumber"],
                    },
                  },
                  required: ["pullRequest", "task"],
                },
              },
            },
          },
          "403": {
            description: "No authorized user for GitHub delegation",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
          "404": {
            description: "Task not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
        },
      },
    },
    "/api/github/pull-requests/{prNumber}/merge": {
      post: {
        tags: ["GitHub"],
        summary: "Merge a pull request",
        description: "Merges a GitHub PR and transitions the task to done. Requires agent token with scope: tasks:transition. A team member must have 'Allow agents to merge PRs' enabled.",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "prNumber", in: "path", required: true, schema: { type: "integer" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  taskId: { type: "string", format: "uuid" },
                  owner: { type: "string", example: "LanNguyenSi" },
                  repo: { type: "string", example: "agent-relay" },
                  merge_method: { type: "string", enum: ["merge", "squash", "rebase"], default: "squash" },
                },
                required: ["taskId", "owner", "repo"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "PR merged and task set to done",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    merged: { type: "boolean" },
                    sha: { type: "string", nullable: true },
                    message: { type: "string" },
                    task: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        status: { type: "string", example: "done" },
                      },
                      required: ["id", "status"],
                    },
                  },
                  required: ["merged", "message", "task"],
                },
              },
            },
          },
          "403": {
            description: "No authorized user for GitHub delegation",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
          "404": {
            description: "Task not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
        },
      },
    },
    "/api/github/pull-requests/{prNumber}/comments": {
      post: {
        tags: ["GitHub"],
        summary: "Comment on a pull request",
        description: "Posts a comment on a GitHub PR. Requires agent token with scope: tasks:comment. A team member must have 'Allow agents to comment on PRs' enabled.",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "prNumber", in: "path", required: true, schema: { type: "integer" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  taskId: { type: "string", format: "uuid" },
                  owner: { type: "string", example: "LanNguyenSi" },
                  repo: { type: "string", example: "agent-relay" },
                  body: { type: "string", minLength: 1, description: "Comment text" },
                },
                required: ["taskId", "owner", "repo", "body"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Comment posted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    comment: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        url: { type: "string", format: "uri" },
                        body: { type: "string" },
                      },
                      required: ["id", "url", "body"],
                    },
                  },
                  required: ["comment"],
                },
              },
            },
          },
          "403": {
            description: "No authorized user for GitHub delegation",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
          "404": {
            description: "Task not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
        },
      },
    },
  },
} as const;

docsRouter.get("/api/openapi.json", (c) => c.json(openApiSpec));

docsRouter.get("/api/docs", (c) => c.redirect("/docs"));

docsRouter.get("/docs", (c) => {
  return c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>agent-tasks API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body { margin: 0; background: #0f0f0f; color: #f0f0f0; font-family: Inter, system-ui, sans-serif; }
      .intro { padding: 16px 20px; border-bottom: 1px solid #2a2a2a; background: #171717; }
      .intro h1 { margin: 0 0 6px 0; font-size: 18px; }
      .intro p { margin: 0; color: #b0b0b0; font-size: 14px; }
      .intro code { color: #7dd3fc; }
      #swagger-ui { max-width: 1200px; margin: 0 auto; }

      /* ── Swagger UI dark overrides ─────────────────────────── */
      .swagger-ui { color: #e0e0e0; }
      .swagger-ui .topbar { display: none; }
      .swagger-ui .info .title,
      .swagger-ui .info h1,
      .swagger-ui .info h2,
      .swagger-ui .info h3,
      .swagger-ui .opblock-tag { color: #f0f0f0; }
      .swagger-ui .info .base-url,
      .swagger-ui .info p,
      .swagger-ui .info li,
      .swagger-ui .opblock-description-wrapper p,
      .swagger-ui .opblock-external-docs-wrapper p,
      .swagger-ui table thead tr td,
      .swagger-ui table thead tr th,
      .swagger-ui .parameter__name,
      .swagger-ui .parameter__type,
      .swagger-ui .parameter__in,
      .swagger-ui .response-col_status,
      .swagger-ui .response-col_description,
      .swagger-ui .response-col_links,
      .swagger-ui label,
      .swagger-ui .model-title,
      .swagger-ui .model { color: #c8c8c8; }
      .swagger-ui .scheme-container,
      .swagger-ui .opblock .opblock-section-header { background: #1a1a1a; }
      .swagger-ui section.models,
      .swagger-ui section.models .model-container { background: #141414; }
      .swagger-ui .opblock .opblock-summary { border-color: #2a2a2a; }
      .swagger-ui .opblock { background: #141414; border-color: #2a2a2a; }
      .swagger-ui .opblock .opblock-section-header h4 { color: #e0e0e0; }
      .swagger-ui .opblock-body pre.microlight,
      .swagger-ui .highlight-code { background: #0d0d0d !important; color: #e0e0e0; }
      .swagger-ui .opblock-body pre span { color: #7dd3fc !important; }
      .swagger-ui input[type=text],
      .swagger-ui textarea,
      .swagger-ui select { background: #1a1a1a; color: #e0e0e0; border-color: #333; }
      .swagger-ui .btn { border-color: #444; color: #e0e0e0; }
      .swagger-ui .btn.execute { background: #2563eb; border-color: #2563eb; }
      .swagger-ui .model-box { background: #141414; }
      .swagger-ui .prop-type { color: #7dd3fc; }
      .swagger-ui .prop-format { color: #888; }
      .swagger-ui section.models h4 { color: #e0e0e0; border-color: #2a2a2a; }
      .swagger-ui .response-control-media-type__accept-message { color: #7dd3fc; }
      .swagger-ui .markdown p,
      .swagger-ui .markdown li,
      .swagger-ui .renderedMarkdown p { color: #c8c8c8; }
      .swagger-ui .opblock-tag:hover { background: rgba(255,255,255,0.03); }
      .swagger-ui .expand-operation svg { fill: #999; }
      .swagger-ui table tbody tr td { border-color: #2a2a2a; color: #c8c8c8; }
      .swagger-ui .copy-to-clipboard { bottom: 5px; right: 5px; }
      .swagger-ui .copy-to-clipboard button { background: #1a1a1a; border-color: #333; }
      .swagger-ui .auth-wrapper .authorize { border-color: #22c55e; color: #22c55e; }
      .swagger-ui .dialog-ux .modal-ux { background: #1a1a1a; border-color: #333; color: #e0e0e0; }
      .swagger-ui .dialog-ux .modal-ux-header h3 { color: #f0f0f0; }
      .swagger-ui .loading-container .loading::after { color: #999; }
    </style>
  </head>
  <body>
    <div class="intro">
      <h1>agent-tasks API (Agent Guide)</h1>
      <p>
        Use a Bearer token from <code>Settings → API Tokens</code>. For task automation you typically need
        <code>projects:read</code>, <code>tasks:read</code>, <code>tasks:create</code>, <code>tasks:claim</code>,
        <code>tasks:transition</code>.
      </p>
    </div>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.onload = () => {
        SwaggerUIBundle({
          url: "/api/openapi.json",
          dom_id: "#swagger-ui",
          deepLinking: true,
          persistAuthorization: true,
          defaultModelsExpandDepth: 1
        });
      };
    </script>
  </body>
</html>`);
});
