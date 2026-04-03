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
          priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
          workflowId: { type: "string", format: "uuid" },
          dueAt: { type: "string", format: "date-time" },
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
    "/api/projects": {
      get: {
        tags: ["Projects"],
        summary: "List projects",
        description:
          "For human sessions, provide teamId. For agent tokens, teamId is inferred from the token.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "teamId",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
            description: "Required for humans, optional/ignored for agent tokens.",
          },
        ],
        responses: {
          "200": {
            description: "Project list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    projects: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Project" },
                    },
                  },
                  required: ["projects"],
                },
              },
            },
          },
          "401": {
            description: "Authentication required",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
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
    "/api/tasks/{id}/claim": {
      post: {
        tags: ["Tasks"],
        summary: "Claim task",
        description: "Agent tokens require scope: tasks:claim. Claimed task is moved to in_progress.",
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
