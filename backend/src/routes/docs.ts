import { Hono } from "hono";
import { MAX_RISK_MODIFIER_POINTS_SUM, RISK_MODIFIER_NAMES, SUGGESTED_TASK_TYPE_THRESHOLDS } from "../lib/confidence.js";
import { GateCode } from "../services/gates/index.js";

// Shared by the Project schema and the PATCH /api/projects/{id} body so the
// documented bounds cannot drift from riskModifiersSchema (lib/confidence.ts).
const RISK_MODIFIERS_SCHEMA = {
  type: "object",
  nullable: true,
  description: `Optional opt-in risk-modifier points (M3). Each triggered modifier adds its points to the resolved base threshold (clamped to 100). Any subset of the four names; each value is an integer 0-100 and the values must sum to at most ${MAX_RISK_MODIFIER_POINTS_SUM}. PATCH rejects unknown keys, negative or non-integer values, values above 100 and a sum above ${MAX_RISK_MODIFIER_POINTS_SUM} with 400; null clears the stored value.`,
  properties: Object.fromEntries(
    RISK_MODIFIER_NAMES.map((name) => [name, { type: "integer", minimum: 0, maximum: 100 }]),
  ),
  additionalProperties: false,
} as const;


export const docsRouter = new Hono();

export const openApiSpec = {
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
    { name: "Grounding", description: "External assessment attempt and signed-receipt transport" },
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
      MergeInProgressResponse: {
        type: "object",
        description: "409 merge_in_progress: a pull request merge holds the task, so this claim or status write was refused and nothing was changed. The merge takes a leased reservation on the task right before the GitHub call; every claim and status writer refuses while it is live, and the reservation lapses on its own after its lease (two minutes) if the merge never completes. Retry once the merge has settled (the Retry-After header and retryAfterSeconds, when present, say how many seconds the lease has left at most).",
        properties: {
          error: { type: "string", enum: ["merge_in_progress"] },
          message: { type: "string" },
          retryAfterSeconds: { type: "integer", minimum: 1, description: "Upper bound on the seconds until the reservation lapses on its own." },
        },
        required: ["error", "message"],
      },
      GroundingErrorResponse: {
        type: "object",
        description: "External-grounding transport errors always include a stable error code. Message and verification detail are returned only for the applicable failure.",
        properties: {
          error: { type: "string", example: "grounding_verification_unavailable" },
          message: { type: "string" },
          detail: { type: "string", example: "assessment_failed" },
        },
        required: ["error"],
      },
      TemplateData: {
        type: "object",
        description: "Structured task information for agents. Fields match the project's task template configuration.",
        properties: {
          goal: { type: "string", description: "What should be achieved" },
          acceptanceCriteria: { type: "string", description: "When is the task done (the task's evals)" },
          context: { type: "string", description: "Relevant files, links, dependencies" },
          constraints: { type: "string", description: "What must not happen" },
          scope: { type: "string", description: "What may be changed" },
          outOfScope: { type: "string", description: "What must not be changed" },
          dependencies: { type: "string", description: "Prerequisite tasks or work (also satisfiable via the dependsOn graph edges)" },
          risk: { type: "string", description: "Risk level / blast radius" },
          agentPrompt: { type: "string", description: "Literal instruction block for a weak agent to execute the task" },
          prefers: {
            type: "object",
            description: "Optional quality/safety preferences (bonus-only signals)",
            properties: {
              testBeforeImplementation: { type: "boolean" },
              verticalSlices: { type: "boolean" },
              smallDiffs: { type: "boolean" },
              explicitStopConditions: { type: "boolean" },
              noSpeculativeRefactoring: { type: "boolean" },
            },
          },
          taskType: { type: "string", enum: ["bugfix", "feature", "refactoring", "security", "migration", "docs"], description: "Semantic task kind (informational)" },
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
          scope: { type: "string" },
          outOfScope: { type: "string" },
          dependencies: { type: "string" },
          risk: { type: "string" },
          agentPrompt: { type: "string" },
          taskType: { type: "string", enum: ["bugfix", "feature", "refactoring", "security", "migration", "docs"] },
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
              scope: { type: "boolean" },
              outOfScope: { type: "boolean" },
              dependencies: { type: "boolean" },
              risk: { type: "boolean" },
              agentPrompt: { type: "boolean" },
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
        description: "Deterministic, template-independent confidence score (0-100, fixed denominator) measuring weak-agent executability. Score below threshold blocks agent claims. A violated keystone (see `blocking`) is a threshold-independent block.",
        properties: {
          score: { type: "integer", minimum: 0, maximum: 100, example: 75 },
          missing: {
            type: "array",
            items: { type: "string" },
            example: ["scope", "agentPrompt"],
            description: "Core fields that are empty or missing (title, description, goal, acceptanceCriteria, scope, outOfScope, dependencies, risk, agentPrompt)",
          },
          threshold: { type: "integer", minimum: 0, maximum: 100, example: 60, description: "The EFFECTIVE minimum score for agent claims (M2): taskTypeThresholds[taskType] -> project.confidenceThreshold -> global default (60). Identical to effectiveThreshold below; kept for backward compatibility." },
          effectiveThreshold: { type: "integer", minimum: 0, maximum: 100, example: 60, description: "M2: same value as `threshold`, named explicitly for callers that want to pair it with thresholdSource." },
          thresholdSource: { type: "string", enum: ["global", "project", "taskType"], example: "project", description: "M2: which layer of the threshold hierarchy produced `threshold`/`effectiveThreshold`." },
          triggeredRiskModifiers: {
            type: "array",
            items: {
              type: "string",
              enum: ["touchesAuth", "touchesDatabase", "touchesPersonalData", "productionImpact"],
            },
            example: ["productionImpact"],
            description: "M3: risk-modifier names that both fired their trigger (description keywords, or the 'production'/'prod' label for productionImpact) AND had a valid positive point entry in the project's opt-in Project.riskModifiers config. Their summed points are added to the M2 base threshold and clamped to 100 to produce `effectiveThreshold`/`threshold` above. Empty when the project has not opted into any modifier, or none fired.",
          },
          blocking: { type: "boolean", example: false, description: "True when a hard, threshold-INDEPENDENT keystone is violated (today: no acceptance criteria and no verification signal in the description). The score is already capped below the default threshold in this case." },
          nextActions: {
            type: "array",
            items: { type: "string" },
            description: "Prioritised, deduplicated suggestions (blocking first) for raising the score. Present on the create response and the low-confidence 422; omitted from the read-only task view.",
          },
          findings: {
            type: "array",
            description: "Per-dimension quality findings (info / warning / blocking). Keystone findings additionally carry `keystone: true`.",
            items: {
              type: "object",
              properties: {
                code: { type: "string", example: "missing_acceptance_criteria" },
                severity: { type: "string", enum: ["info", "warning", "blocking"] },
                dimension: { type: "string", example: "testability" },
                message: { type: "string" },
                suggestion: { type: "string" },
                keystone: { type: "boolean" },
              },
              required: ["code", "severity", "dimension", "message"],
            },
          },
        },
        required: ["score", "missing", "threshold", "blocking", "effectiveThreshold", "thresholdSource", "triggeredRiskModifiers"],
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
          riskModifiers: RISK_MODIFIERS_SCHEMA,
          taskTypeThresholds: {
            type: "object",
            nullable: true,
            description:
              "Optional per-task-type override of confidenceThreshold (M2). Resolution order: taskTypeThresholds[EXPLICIT templateData.taskType] -> confidenceThreshold -> global default (60). Any subset of the six taskType keys; PATCH rejects unknown keys.",
            properties: {
              bugfix: {
                type: "integer",
                minimum: 0,
                maximum: 100,
                description: `Suggested starting value: ${SUGGESTED_TASK_TYPE_THRESHOLDS.bugfix}. Never applied automatically.`,
              },
              feature: {
                type: "integer",
                minimum: 0,
                maximum: 100,
                description: `Suggested starting value: ${SUGGESTED_TASK_TYPE_THRESHOLDS.feature}. Never applied automatically.`,
              },
              refactoring: {
                type: "integer",
                minimum: 0,
                maximum: 100,
                description: `Suggested starting value: ${SUGGESTED_TASK_TYPE_THRESHOLDS.refactoring}. Never applied automatically.`,
              },
              security: {
                type: "integer",
                minimum: 0,
                maximum: 100,
                description: `Suggested starting value: ${SUGGESTED_TASK_TYPE_THRESHOLDS.security}. Never applied automatically.`,
              },
              migration: {
                type: "integer",
                minimum: 0,
                maximum: 100,
                description: `Suggested starting value: ${SUGGESTED_TASK_TYPE_THRESHOLDS.migration}. Never applied automatically.`,
              },
              docs: {
                type: "integer",
                minimum: 0,
                maximum: 100,
                description: `Suggested starting value: ${SUGGESTED_TASK_TYPE_THRESHOLDS.docs}. Never applied automatically.`,
              },
            },
            additionalProperties: false,
          },
          enforcementMode: {
            type: "string",
            enum: ["OFF", "WARN", "BLOCK"],
            nullable: true,
            description: "Confidence-gate enforcement (scorer-v2). OFF = advisory; WARN = compute + shadow-log but never block (the rollout default; null resolves to WARN); BLOCK = block claims below threshold OR on a violated keystone. Flipping to BLOCK requires acknowledgeShadowReport=true on the PATCH.",
          },
          notificationWebhookUrl: {
            type: "string",
            format: "uri",
            nullable: true,
            description:
              "Outbound webhook URL for Signal push delivery. When set, every Signal is POSTed here in addition to the polling channel. See docs/notification-webhooks.md. PATCH with empty string or null to clear.",
          },
          hasNotificationWebhookSecret: {
            type: "boolean",
            description:
              "True iff a signing secret is configured for the notification webhook. The raw secret is never returned in responses; PATCH the project with the new value to rotate.",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "teamId", "name", "slug", "createdAt", "updatedAt"],
      },
      EffectiveGate: {
        type: "object",
        description:
          "Per-project projection of one registered gate (services/gates/): whether it would evaluate on this project right now, and why. `active=false` does NOT mean the gate is gone — it means the gate is registered but currently short-circuits to allowed for this project (typical for governance gates that bypass on a permissive governanceMode).",
        properties: {
          code: {
            type: "string",
            enum: Object.values(GateCode),
            example: GateCode.DistinctReviewer,
            description: "Stable wire identifier — part of the public API (services/gates/types.ts); renaming requires a deprecation cycle.",
          },
          name: { type: "string", example: "Distinct reviewer required for review→done" },
          active: { type: "boolean", example: true },
          because: {
            type: "string",
            example:
              "governanceMode=REQUIRES_DISTINCT_REVIEWER; the work-claimant cannot approve their own task (a different actor must hold the review lock).",
            description: "Human-readable reason, safe to surface to an agent or the UI.",
          },
          appliesTo: {
            type: "array",
            items: { type: "string" },
            example: ["task_finish", "tasks_transition"],
            description: "Verb names (stdio MCP + HTTP bridge) that can trip this gate. Freetext — the source of truth is the verb that actually invokes the check.",
          },
        },
        required: ["code", "name", "active", "because", "appliesTo"],
      },
      EffectiveThreshold: {
        type: "object",
        description:
          "Resolved confidence-threshold value for one task type (M2): taskTypeThresholds[taskType] -> project.confidenceThreshold -> global default (60).",
        properties: {
          effectiveThreshold: { type: "integer", minimum: 0, maximum: 100, example: 60 },
          thresholdSource: {
            type: "string",
            enum: ["global", "project", "taskType"],
            example: "project",
            description: "Which layer of the threshold hierarchy produced effectiveThreshold.",
          },
        },
        required: ["effectiveThreshold", "thresholdSource"],
      },
      TaskCreationReadiness: {
        type: "object",
        description:
          "Per-project task-creation knobs an agent should read BEFORE composing a task, so it can supply the structured spec fields the confidence scorer (and, in BLOCK mode, the claim gate) expects. Read-only summary; it never blocks by itself — a low-readiness claim is still enforced separately at task_pickup/task_start.",
        properties: {
          enforcementMode: {
            type: "string",
            enum: ["OFF", "WARN", "BLOCK"],
            example: "WARN",
            description: "Effective confidence-gate enforcement mode; a null column resolves to WARN (the rollout default).",
          },
          confidenceThreshold: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            example: 60,
            description: "The flat project threshold, before any per-task-type override.",
          },
          templateModeEnabled: {
            type: "boolean",
            example: false,
            description: "True when the project marks at least one template field as required.",
          },
          requiredFields: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "goal",
                "acceptanceCriteria",
                "context",
                "constraints",
                "scope",
                "outOfScope",
                "dependencies",
                "risk",
                "agentPrompt",
              ],
            },
            example: ["goal", "acceptanceCriteria"],
            description: "The template fields the project marks required. Empty when template mode is off.",
          },
          taskTypeThresholds: {
            type: "object",
            description:
              "The resolved threshold hierarchy for EVERY task type (M2) — the same resolveEffectiveThreshold the claim gate uses, not a re-derivation. Lets an agent see a per-type override BEFORE creating a typed task, instead of only discovering it after a claim gets rejected. Project-level only: per-task M3 risk modifiers (Project.riskModifiers, evaluated per-task against that task's own description/labels) are NOT reflected here, so a SPECIFIC task's actual effective claim threshold can be higher than the value shown for its type — see the Confidence schema's triggeredRiskModifiers.",
            properties: {
              bugfix: { $ref: "#/components/schemas/EffectiveThreshold" },
              feature: { $ref: "#/components/schemas/EffectiveThreshold" },
              refactoring: { $ref: "#/components/schemas/EffectiveThreshold" },
              security: { $ref: "#/components/schemas/EffectiveThreshold" },
              migration: { $ref: "#/components/schemas/EffectiveThreshold" },
              docs: { $ref: "#/components/schemas/EffectiveThreshold" },
            },
            required: ["bugfix", "feature", "refactoring", "security", "migration", "docs"],
            additionalProperties: false,
          },
        },
        required: [
          "enforcementMode",
          "confidenceThreshold",
          "templateModeEnabled",
          "requiredFields",
          "taskTypeThresholds",
        ],
      },
      ConfidenceTelemetryWeekBucket: {
        type: "object",
        description: "One ISO week's worth of confidence-gate claim evaluations for the project.",
        properties: {
          weekStart: { type: "string", format: "date", example: "2026-08-17", description: "Monday (UTC) of the ISO week." },
          overrideCount: { type: "integer", minimum: 0, example: 1 },
          totalClaims: { type: "integer", minimum: 0, description: "Claim attempts the confidence gate evaluated that week, across all four claim_* audit actions — including attempts later rejected by the CAS/transition guard downstream of the gate (MED-6, batch 18 review). Not a count of claims that actually succeeded.", example: 5 },
          rate: { type: "number", minimum: 0, maximum: 1, description: "overrideCount / totalClaims; 0 when totalClaims is 0.", example: 0.2 },
        },
        required: ["weekStart", "overrideCount", "totalClaims", "rate"],
      },
      ConfidenceTelemetryScoreBandBounceBack: {
        type: "object",
        properties: {
          band: { type: "string", example: "60-70", description: "Half-open [lower,upper) score band, except the top band 90-100 which is closed on both ends." },
          taskCount: { type: "integer", minimum: 0, example: 4 },
          avgBounceBackCount: { type: "number", minimum: 0, example: 1.5 },
        },
        required: ["band", "taskCount", "avgBounceBackCount"],
      },
      ConfidenceTelemetryScoreBandClarification: {
        type: "object",
        properties: {
          band: { type: "string", example: "70-80" },
          taskCount: { type: "integer", minimum: 0, example: 6 },
          avgClarificationCount: { type: "number", minimum: 0, description: "Mean clarificationCount across this band's tasks: comments an agent claim-holder posted while the task was in a work state other than review (in_progress in the built-in and template workflows).", example: 1.5 },
        },
        required: ["band", "taskCount", "avgClarificationCount"],
      },
      ConfidenceTelemetryScoreBandDoneRate: {
        type: "object",
        properties: {
          band: { type: "string", example: "70-80" },
          taskCount: { type: "integer", minimum: 0, example: 6 },
          doneRate: { type: "number", minimum: 0, maximum: 1, description: "Share of this band's terminal tasks whose outcome is 'done'. The outcome is finalDisposition ?? finalStatus: 'done' is written when a task reaches a terminal review-approve, 'abandoned' after a successful creator-abandon of a task that had a scored claim. A band stays at 1.0 until such a task is creator-abandoned.", example: 1 },
        },
        required: ["band", "taskCount", "doneRate"],
      },
      ConfidenceTelemetryAggregates: {
        type: "object",
        description:
          "M5 (task 698eeb01) calibration telemetry, collected from task_finish's review-approve snapshot hook, the comment route and the confidence-gate audit trail. Aggregates all four calibration signals named by the milestone (review bounce-backs, agent clarification comments, override frequency, score-vs-outcome by band). A clarification is a comment posted via POST /tasks/{id}/comments by an agent that holds the task's active work claim while the task is in a work state other than review (in_progress in the built-in and template workflows); human claim-holders, reviewers and comments in review do not count. COLLECTION ONLY - no field here feeds an automatic weight/threshold adjustment; a future, deliberately separate milestone calibrates against this data. See services/confidence-telemetry.ts.",
        properties: {
          overrideRatePerWeek: { type: "array", items: { $ref: "#/components/schemas/ConfidenceTelemetryWeekBucket" } },
          bounceBackByScoreBand: { type: "array", items: { $ref: "#/components/schemas/ConfidenceTelemetryScoreBandBounceBack" } },
          clarificationByScoreBand: { type: "array", items: { $ref: "#/components/schemas/ConfidenceTelemetryScoreBandClarification" } },
          doneRateByScoreBand: { type: "array", items: { $ref: "#/components/schemas/ConfidenceTelemetryScoreBandDoneRate" } },
          lowScoreSuccesses: { type: "integer", minimum: 0, description: "Terminal tasks with scoreAtClaim < 60 whose outcome (finalDisposition ?? finalStatus) is 'done'.", example: 2 },
          highScoreFailures: { type: "integer", minimum: 0, description: "Terminal tasks with scoreAtClaim >= 90 whose outcome is not 'done'. The outcome is finalDisposition ?? finalStatus; the only non-done outcome today is 'abandoned', written after a successful creator-abandon of a task that had a scored claim (a claim-release via task_abandon or release is not terminal and writes nothing, and a creator-abandon of a task that was never claimed with a score writes no row). A 0 therefore means no such task has been creator-abandoned, not necessarily good calibration.", example: 0 },
        },
        required: [
          "overrideRatePerWeek",
          "bounceBackByScoreBand",
          "clarificationByScoreBand",
          "doneRateByScoreBand",
          "lowScoreSuccesses",
          "highScoreFailures",
        ],
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
          url: {
            type: "string",
            description: "Uploaded files use a relative /uploads/<uuid>.<ext> path; URL pointers use an absolute http(s) URL.",
          },
          mimeType: {
            type: "string",
            nullable: true,
            description: "Sniffed media type of an uploaded file; null for URL pointers.",
          },
          sizeBytes: { type: "integer", description: "Byte length of the stored file; 0 for URL pointers." },
          type: { type: "string", enum: ["IMAGE", "DOCUMENT"] },
          createdByUserId: { type: "string", format: "uuid", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "taskId", "name", "url", "sizeBytes", "type", "createdAt"],
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
          status: { type: "string", enum: ["backlog", "open", "in_progress", "review", "done"] },
          priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
          workflowId: { type: "string", format: "uuid" },
          dueAt: { type: "string", format: "date-time" },
          templateData: { $ref: "#/components/schemas/TemplateData" },
          externalRef: {
            type: "string",
            minLength: 1,
            maxLength: 255,
            description: "Idempotency key; the backend dedupes on (projectId, externalRef).",
          },
          labels: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 100 },
            maxItems: 20,
            description: "Free-form labels for filtering and classification.",
          },
          dependsOn: {
            type: "array",
            items: { type: "string", format: "uuid" },
            maxItems: 50,
            description: "Blocking task ids in the same project; task pickup skips this task until every blocker reaches a resolved status (done or abandoned). Create-time only.",
          },
          debugFlavor: {
            type: "boolean",
            description: "Explicit debug-flavor opt-in/out. When omitted the backend runs its title/label heuristic at task pickup; when set, the value is persisted verbatim to metadata.debugFlavor.",
          },
          deliverableRepo: {
            type: "string",
            minLength: 3,
            maxLength: 255,
            pattern: "^[^/\\s]+/[^/\\s]+$",
            description: "Cross-repo deliverable override ('owner/repo'). For tasks whose legitimate deliverable is a PR in a different GitHub repo than the project's linked githubRepo. Post-create changes are project-admin-only.",
          },
        },
        required: ["title"],
      },
      RespecTaskRequest: {
        type: "object",
        description:
          "Corrects description and/or templateData on an OPEN+UNCLAIMED task without delete+recreate. At least one of the two properties is required (enforced by the Zod schema; not expressible as a flat JSON Schema `required` array — see the `anyOf` below). Neither property accepts an empty value: description is trimmed and must be non-empty, templateData must carry at least one key.",
        properties: {
          description: { type: "string", minLength: 1, maxLength: 50000, description: "Trimmed server-side; a whitespace-only string is rejected, not silently stored." },
          templateData: {
            allOf: [{ $ref: "#/components/schemas/TemplateData" }],
            minProperties: 1,
            description: "An empty object ({}) is rejected — respec must carry at least one populated field.",
          },
        },
        anyOf: [{ required: ["description"] }, { required: ["templateData"] }],
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
      patch: {
        tags: ["Projects"],
        summary: "Update project settings",
        description:
          "Humans with project ADMIN only. Partial update: only the fields present are changed. The body is documented here only for riskModifiers. The other updatable fields are defined by updateProjectSchema in backend/src/routes/projects.ts and are not described here yet; the Project schema is the response shape, not the update body, and non-updatable fields such as slug or teamId are ignored.",
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
              schema: {
                type: "object",
                properties: { riskModifiers: RISK_MODIFIERS_SCHEMA },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Project updated",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { project: { $ref: "#/components/schemas/Project" } },
                  required: ["project"],
                },
              },
            },
          },
          "400": {
            description: "Validation error (for riskModifiers: unknown key, negative, non-integer or above 100 value, or a sum above 100)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
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
    "/api/projects/{id}/effective-gates": {
      get: {
        tags: ["Projects"],
        summary: "Get effective gates + task-creation readiness for a project",
        description:
          "Dedicated discovery endpoint — same effectiveGates/taskCreation data as GET /projects/:id, without the project payload. Backs the projects_get_effective_gates MCP verb. Lets a caller learn which invariants would trip BEFORE calling a gated verb (effectiveGates), and which structured fields / per-task-type confidence thresholds apply BEFORE composing a task (taskCreation), instead of only discovering either after tripping a 4xx.",
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
            description: "Effective gate map + task-creation readiness",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    effectiveGates: {
                      type: "object",
                      description:
                        "Keyed by GateCode — one entry per registered gate. Deterministic key ordering is NOT guaranteed; key by `code`, not object/array position.",
                      additionalProperties: { $ref: "#/components/schemas/EffectiveGate" },
                    },
                    taskCreation: { $ref: "#/components/schemas/TaskCreationReadiness" },
                  },
                  required: ["effectiveGates", "taskCreation"],
                  // Example mirrors the fixture in
                  // backend/tests/unit/effective-gates-endpoint.test.ts
                  // ("surfaces a per-task-type confidenceThreshold override
                  // (select fix)"): governanceMode=AUTONOMOUS,
                  // githubRepo="owner/repo", enforcementMode=BLOCK,
                  // confidenceThreshold=60, taskTypeThresholds={security:90}.
                  example: {
                    effectiveGates: {
                      distinct_reviewer: {
                        code: "distinct_reviewer",
                        name: "Distinct reviewer required for review→done",
                        active: false,
                        because:
                          "governanceMode=AUTONOMOUS (legacy soloMode=true) — single-actor project, no distinct reviewer needed.",
                        appliesTo: ["task_finish", "tasks_transition"],
                      },
                      self_merge: {
                        code: "self_merge",
                        name: "Work-claimant cannot merge their own PR",
                        active: false,
                        because: "governanceMode=AUTONOMOUS — single-actor project, self-merge permitted by design.",
                        appliesTo: ["pull_requests_merge", "task_merge", "task_finish"],
                      },
                      task_status_for_merge: {
                        code: "task_status_for_merge",
                        name: "Task status allows PR merge",
                        active: true,
                        because:
                          "Every project requires task.status ∈ {review, done} before merging the backing PR; open / in_progress tasks must transition first.",
                        appliesTo: ["pull_requests_merge", "task_merge"],
                      },
                      pr_repo_matches_project: {
                        code: "pr_repo_matches_project",
                        name: "PR URL repo matches project binding",
                        active: true,
                        because: "Project is bound to owner/repo; PR URLs pointing elsewhere are rejected (ADR-0010 §5b).",
                        appliesTo: ["task_finish", "submit_pr", "tasks_update", "pull_requests_create"],
                      },
                    },
                    taskCreation: {
                      enforcementMode: "BLOCK",
                      confidenceThreshold: 60,
                      templateModeEnabled: false,
                      requiredFields: [],
                      taskTypeThresholds: {
                        bugfix: { effectiveThreshold: 60, thresholdSource: "project" },
                        feature: { effectiveThreshold: 60, thresholdSource: "project" },
                        refactoring: { effectiveThreshold: 60, thresholdSource: "project" },
                        security: { effectiveThreshold: 90, thresholdSource: "taskType" },
                        migration: { effectiveThreshold: 60, thresholdSource: "project" },
                        docs: { effectiveThreshold: 60, thresholdSource: "project" },
                      },
                    },
                  },
                },
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
    "/api/projects/{id}/telemetry/confidence": {
      get: {
        tags: ["Projects"],
        summary: "Calibration telemetry aggregates (M5, collection-only)",
        description:
          "Read-only. Aggregates all four calibration signals collected by services/confidence-telemetry.ts: review bounce-backs (task_finish snapshot hook), agent clarification comments (a comment posted via POST /tasks/{id}/comments by an agent that holds the task's active work claim while the task is in a work state; human claim-holders, reviewers and comments in review do not count), override frequency, and score-vs-outcome cross-referencing by score band. COLLECTS ONLY - nothing here or in this milestone auto-adjusts a threshold, weight, or riskModifiers config; a future, deliberately separate milestone calibrates against this data once enough volume exists. `scoreAtClaim` is null (and so excluded from the score-banded aggregates) for tasks claimed by a human, or claimed under an enforcementMode=OFF project - the confidence gate never evaluates either case, so there is nothing to snapshot. The score-vs-outcome signal reads each row's outcome as finalDisposition ?? finalStatus: finalDisposition 'done' is written with the terminal review-approve snapshot, 'abandoned' after a successful creator-abandon (only for a task that had a scored claim; a restore from abandoned to the initial state clears it), and rows that predate the column fall back to finalStatus 'done'. task_abandon and release only release a claim and write no disposition. See the field-level descriptions below.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "period",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["7d", "30d", "90d"], default: "30d" },
            description: "Lookback window. Defaults to 30d when omitted.",
          },
        ],
        responses: {
          "200": {
            description: "Calibration telemetry aggregates for the requested period",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    period: { type: "string", enum: ["7d", "30d", "90d"], example: "30d" },
                    periodStart: { type: "string", format: "date-time" },
                    aggregates: { $ref: "#/components/schemas/ConfidenceTelemetryAggregates" },
                  },
                  required: ["period", "periodStart", "aggregates"],
                },
              },
            },
          },
          "400": {
            description: "Invalid period",
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
        description:
          "Defaults to `sort=createdAt:desc` (newest first) — unchanged, pre-existing behavior for this route. Pass `sort=createdAt:asc` to reverse it. `cursor` (a task id from a previous page's `nextCursor`) pages forward from that point; `nextCursor` in the response is the id to pass next, or `null`/absent once the last page has been reached. `limit`, when supplied, is clamped to 500; when omitted the route stays unbounded (see `/api/tasks/claimable` for the MCP `tasks_list`-facing sibling of this endpoint).",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "projectId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "externalRef",
            in: "query",
            required: false,
            schema: { type: "string", maxLength: 255 },
            description:
              "Exact-match filter on the task's externalRef, scoped to this project (no partial or case-insensitive matching). Rejected with 400 when longer than 255 characters — the same cap `CreateTaskRequest.externalRef` enforces at create time, so no stored value could ever exceed it and a longer filter could never match anything. (An earlier version of this endpoint silently dropped over-length values instead, which returned this project's *unfiltered* task list — indistinguishable from a filtered response to the caller.)",
          },
          {
            name: "sort",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["createdAt:asc", "createdAt:desc"], default: "createdAt:desc" },
            description: "Only `createdAt` is sortable here. Default `createdAt:desc` (newest first, unchanged pre-existing behavior).",
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
            description: "Task id to page forward from (typically the previous response's `nextCursor`). Combine with `limit` to page through results.",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 500 },
            description: "Clamped to 500. Omit for the pre-existing unbounded behavior (e.g. the frontend dashboard's full-project fetch).",
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
                    nextCursor: {
                      type: "string",
                      format: "uuid",
                      nullable: true,
                      description: "Pass as `cursor` to fetch the next page. `null` when no rows exist after this page (the route fetches limit+1 to decide) or when limit was omitted.",
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
            description: "Task created. The non-blocking `confidence` object surfaces the score and what's missing at create time; a low score does NOT block creation (the hard gate is at task_pickup/task_start).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    task: { $ref: "#/components/schemas/Task" },
                    confidence: { $ref: "#/components/schemas/Confidence" },
                  },
                  required: ["task", "confidence"],
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
        summary: "List tasks (defaults to claimable: open + unclaimed)",
        description:
          "For agents, team scope is inferred from token; optionally narrow by projectId. For humans, provide projectId or teamId. " +
          "Pass status/priority/labels/claimedByAgentId to broaden the search beyond claimable. " +
          "verbose=false (the default) returns a summary projection without the long-form description, comments, attachments, or artifacts. " +
          "Defaults to `sort=createdAt:asc` — unchanged, pre-existing API-level behavior kept for backward compatibility; the deprecated MCP `tasks_list` tool defaults/documents `createdAt:desc` at the tool layer so agents see the N newest tasks by default. Pass `cursor` (a task id from a previous page's `nextCursor`) to page forward; `nextCursor` in the response is the id to pass next, or `null` once the last page is reached. A page holds at most `limit` rows (default 25, so a caller that omits `limit` sees at most 25 tasks per call); the response always carries `truncated`, which is true exactly when more rows exist after this page, proven by a take-limit-plus-one probe. A caller that needs every match pages with `nextCursor` until `truncated` is false.",
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
            schema: { type: "integer", minimum: 1, maximum: 200, default: 25 },
            description:
              "Page size. Out-of-range values are clamped: above 200 becomes 200, below 1 becomes 1; an absent or non-numeric value uses the default 25. The project task route (`GET /api/projects/:id/tasks`) differs on purpose: it caps at 500 and rejects a value of 0 or below with 400.",
          },
          {
            name: "sort",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["createdAt:asc", "createdAt:desc"], default: "createdAt:asc" },
            description: "Only `createdAt` is sortable here. Default `createdAt:asc` (unchanged, pre-existing behavior — API-level backward compatibility). Pass `createdAt:desc` to see the newest tasks first.",
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
            description: "Task id to page forward from (typically the previous response's `nextCursor`).",
          },
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string" },
            description:
              "One value or CSV. Valid: open|in_progress|review|done|abandoned. When set, drops the implicit unclaimed constraint.",
          },
          {
            name: "priority",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "One value or CSV. Valid: LOW|MEDIUM|HIGH|CRITICAL.",
          },
          {
            name: "labels",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Comma-separated list. AND-match: only tasks carrying every listed label are returned.",
          },
          {
            name: "claimedByAgentId",
            in: "query",
            required: false,
            schema: { type: "string" },
            description:
              "UUID, or magic value 'me' (agent actors only) which resolves to the calling token's id. Drops the implicit unclaimed constraint.",
          },
          {
            name: "verbose",
            in: "query",
            required: false,
            schema: { type: "boolean", default: false },
            description: "When true, return the full task payload (description, comments, attachments, artifacts) instead of the summary projection.",
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
                    nextCursor: {
                      type: "string",
                      format: "uuid",
                      nullable: true,
                      description: "Pass as `cursor` to fetch the next page. `null` on the last page (no more results). Exact: a page that is exactly full with nothing after it also reports `null`.",
                    },
                    truncated: {
                      type: "boolean",
                      description: "True exactly when more rows exist after this page (equivalent to `nextCursor !== null`). A page capped at `limit` (default 25) with rows remaining reports `true`, so a capped page is never mistaken for the complete result.",
                    },
                  },
                  required: ["tasks", "nextCursor", "truncated"],
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
          "Agents can update: branchName, prUrl, prNumber, result. Requires scope: tasks:update. Humans can update all fields. Humans (project write access) can also move an open task back to backlog with `status: \"backlog\"` (demote): the task must be open with no work or review claim, otherwise this returns 409. Backlog is reachable only by this demote: a status of backlog from any source status other than open returns 400, also when the project stores an older workflow definition with an edge into backlog. The write is a compare-and-swap, so a concurrent task_start cannot leave a claimed backlog task, and the task's pending signals are acknowledged. Agents cannot send status at all (403).",
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
          "409": {
            description: "Demote (open to backlog) refused: the task holds a work or review claim, or lost the claim race. A status write is also refused with merge_in_progress while a pull request merge holds the task.",
            content: {
              "application/json": {
                schema: { oneOf: [{ $ref: "#/components/schemas/ErrorResponse" }, { $ref: "#/components/schemas/MergeInProgressResponse" }] },
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
    "/api/tasks/{id}/grounding-attempts": {
      post: {
        tags: ["Grounding"],
        summary: "Issue an external-grounding challenge",
        description: "Authorizes and issues an assessment attempt for a provisioned task. It does not complete the task. The strict JSON challenge envelope is limited to 1,024 streamed bytes.",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { intent: { type: "string", enum: ["finish", "approve", "merge"] } }, required: ["intent"] } } } },
        responses: {
          "201": { description: "Authoritative challenge for the configured producer" },
          "400": { description: "Invalid request", content: { "application/json": { schema: { $ref: "#/components/schemas/GroundingErrorResponse" } } } },
          "409": { description: "Stale or unavailable grounding context", content: { "application/json": { schema: { $ref: "#/components/schemas/GroundingErrorResponse" } } } },
          "401": { description: "Unauthenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/GroundingErrorResponse" } } } },
          "403": { description: "Forbidden", content: { "application/json": { schema: { $ref: "#/components/schemas/GroundingErrorResponse" } } } },
          "404": { description: "Task not found", content: { "application/json": { schema: { $ref: "#/components/schemas/GroundingErrorResponse" } } } },
          "503": { description: "grounding_verification_unavailable", content: { "application/json": { schema: { $ref: "#/components/schemas/GroundingErrorResponse" } } } },
        },
      },
    },
    "/api/tasks/{id}/grounding-attempts/{attemptId}/receipt": {
      post: {
        tags: ["Grounding"],
        summary: "Upload an external signed receipt",
        description: "Transports the producer's original receipt JSON bytes as a JSON string. The request envelope is limited to 200,000 streamed bytes; receipt content is limited to 32,768 UTF-8 bytes (`x-maxBytes`), and is verified server-side. Upload alone does not complete a task.",
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "attemptId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { session: { type: "object", additionalProperties: false, properties: { id: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" }, revision: { type: "integer", minimum: 1, maximum: 2147483647 } }, required: ["id", "revision"] }, receipt: { type: "string", "x-maxBytes": 32768 } }, required: ["session", "receipt"] } } } },
        responses: {
          "200": { description: "Verified receipt evidence or an exact replay" },
          "400": { description: "Invalid receipt transport", content: { "application/json": { schema: { $ref: "#/components/schemas/GroundingErrorResponse" } } } },
          "409": { description: "Stale, mismatched, or missing active attempt", content: { "application/json": { schema: { $ref: "#/components/schemas/GroundingErrorResponse" } } } },
          "422": { description: "Untrusted or unsupported receipt", content: { "application/json": { schema: { $ref: "#/components/schemas/GroundingErrorResponse" } } } },
          "401": { description: "Unauthenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/GroundingErrorResponse" } } } },
          "403": { description: "Forbidden", content: { "application/json": { schema: { $ref: "#/components/schemas/GroundingErrorResponse" } } } },
          "404": { description: "Task or attempt not found", content: { "application/json": { schema: { $ref: "#/components/schemas/GroundingErrorResponse" } } } },
          "503": { description: "grounding_verification_unavailable", content: { "application/json": { schema: { $ref: "#/components/schemas/GroundingErrorResponse" } } } },
        },
      },
    },
    "/api/tasks/{id}/finish": {
      post: {
        tags: ["Tasks", "Grounding"], summary: "Finish a task", security: [{ bearerAuth: [] }],
        description: "Provisioned external-grounding completion requires Idempotency-Key. Reuse it only for an identical retry; a pending result is not completion.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }, { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" }, description: "Required for a provisioned task." }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Completed task route result" }, "202": { description: "Pending remote completion; retry with the same key." }, "400": { description: "Missing or invalid operation key for a provisioned task" }, "409": { description: "merge_in_progress: a pull request merge holds the task, so this claim or status write was refused and nothing was changed; retry once the merge has settled. Another finish that merges the pull request (autoMerge) while the first holds the reservation gets the same answer. grounding_github_fence_conflict: the task is under an active GitHub repository fence, so the reservation write was refused, nothing was merged and GitHub was not called; retry once the fenced operation has finished. Other 409 causes use the ErrorResponse shape.", content: { "application/json": { schema: { oneOf: [{ $ref: "#/components/schemas/MergeInProgressResponse" }, { $ref: "#/components/schemas/ErrorResponse" }] } } } } },
      },
    },
    "/api/tasks/{id}/merge": {
      post: {
        tags: ["Tasks", "Grounding"], summary: "Merge a task pull request", security: [{ bearerAuth: [] }],
        description: "Provisioned external-grounding merge requires Idempotency-Key. Reuse it only for an identical retry.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }, { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" }, description: "Required for a provisioned task." }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { mergeMethod: { type: "string", enum: ["squash", "merge", "rebase"] } } } } } },
        responses: { "200": { description: "Merged task route result" }, "202": { description: "Pending remote merge; retry with the same key." }, "400": { description: "Missing or invalid operation key for a provisioned task" }, "409": { description: "merged_but_status_changed: the pull request was merged on GitHub, but the task was changed by another writer before this request could record it, so the task was not updated. mergeSha is the merge commit and currentStatus the status the task has now; the system's own PR-merge webhook having moved the task to done first is not an error (200). Other 409 causes use the ErrorResponse shape: bad_state (the task is not in a mergeable state) and foreign_deliverable_merge_refused. merge_in_progress: another merge of the task holds its reservation, so this merge was refused before the GitHub call. grounding_github_fence_conflict: the task is under an active GitHub repository fence, so the reservation write was refused, nothing was merged and GitHub was not called; retry once the fenced operation has finished.", content: { "application/json": { schema: { oneOf: [{ type: "object", properties: { error: { type: "string", enum: ["merged_but_status_changed"] }, message: { type: "string" }, mergeSha: { type: "string", nullable: true }, currentStatus: { type: "string", nullable: true } }, required: ["error", "message", "mergeSha", "currentStatus"] }, { $ref: "#/components/schemas/MergeInProgressResponse" }, { $ref: "#/components/schemas/ErrorResponse" }] } } } } },
      },
    },
    "/api/tasks/{id}/abandon": {
      post: {
        tags: ["Tasks", "Grounding"], summary: "Abandon an active task claim", security: [{ bearerAuth: [] }],
        description: "Provisioned external-grounding abandonment requires Idempotency-Key and an empty JSON object. Reuse the key only for an identical retry.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }, { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" }, description: "Required for a provisioned task." }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false } } } },
        responses: { "200": { description: "Abandoned task route result" }, "400": { description: "Missing or invalid operation key for a provisioned task" }, "409": { description: "merge_in_progress: a pull request merge holds the task, so the claim was not released; retry once the merge has settled. Other 409 causes use the ErrorResponse shape.", content: { "application/json": { schema: { oneOf: [{ $ref: "#/components/schemas/MergeInProgressResponse" }, { $ref: "#/components/schemas/ErrorResponse" }] } } } } },
      },
    },
    "/api/tasks/{id}/respec": {
      post: {
        tags: ["Tasks"],
        summary: "Correct description/templateData on an open or backlog, unclaimed task",
        description:
          "Updates ONLY description and/or templateData — no other field (title included) is respec-able. The task must be unclaimed (work and review), with status=open or status=backlog, or this returns 409. Agents: requires scope tasks:update and project access. In backlog, any such agent may respec, regardless of who created the task or the project's allowNonCreatorRespec flag. In open, only the task's creator may respec by default; allowNonCreatorRespec relaxes that to any agent with project access. Humans: project write access is sufficient in either status, with no creator restriction. Every actually-changed field is audited with its full before/after value (capped per field beyond 8KB serialized). The response's `confidence` is re-scored on the new values and is purely informational — it never blocks the respec.",
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
              schema: { $ref: "#/components/schemas/RespecTaskRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Task respec'd. `confidence` reflects the NEW description/templateData.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    task: { $ref: "#/components/schemas/Task" },
                    confidence: { $ref: "#/components/schemas/Confidence" },
                  },
                  required: ["task", "confidence"],
                },
              },
            },
          },
          "403": {
            description: "Missing scope, no project access, or not the task's creator (and allowNonCreatorRespec is not set)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
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
          "409": {
            description: "Task is not open, or is claimed (work or review)",
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
    "/api/tasks/{id}/suggest-rewrite": {
      post: {
        tags: ["Tasks"],
        summary: "Suggest an LLM-rewritten task description (advisory only)",
        description:
          "M4 (ADR-0011: LLMs are advisory only, never gating). Reads the task and its live confidence findings and asks an LLM to propose a rewritten description that addresses them; NEVER modifies the task itself, and never calls any mutating verb. Gated behind the project's `aiHelpersEnabled` flag (default false, set via PATCH /projects/:id) -- when off, this returns 404 identically to a missing task, so the feature is invisible unless explicitly opted in. Returns 503 if the server has no ANTHROPIC_API_KEY configured. To apply a suggestion, PATCH /tasks/:id with the returned `suggestion` as the new `description` -- this endpoint never writes it for you. Requires scope: tasks:read.",
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
            description: "Rewrite suggestion",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    suggestion: { type: "string", description: "Proposed rewritten task description." },
                    changedSignals: {
                      type: "array",
                      items: { type: "string" },
                      description: "Confidence-finding `code` values (see the Confidence schema's `findings`) the suggestion addresses.",
                    },
                  },
                  required: ["suggestion", "changedSignals"],
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
          "404": {
            description: "Task not found, or the project has aiHelpersEnabled=false",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "429": {
            description: "Rate limited (`error: \"rate_limited\"`): more than 10 requests/minute from this caller against this task. Per-(caller IP, taskId), not a ceiling on total Anthropic spend -- see docs/llm-rewrite-helper.md's Security posture section.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "502": {
            description: "The LLM request failed or returned an unparseable response (`error: \"llm_request_failed\"`), or the response was truncated at the model's output-token limit before it could finish (`error: \"llm_response_truncated\"`)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "503": {
            description: "The LLM rewrite helper is not configured on this server (missing ANTHROPIC_API_KEY)",
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
            description: "Set to 'true' to override the confidence gate (claim below threshold or past a keystone). Requires the operator-only 'confidence:override' scope plus a forceReason of at least 10 characters; without the scope the call returns 403. The override is audited with the operator identity.",
          },
          {
            name: "forceReason",
            in: "query",
            required: false,
            schema: { type: "string", minLength: 10 },
            description: "Required when force=true: a >=10-char justification, recorded in the override audit event.",
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
            description: "Task already claimed; (merge_in_progress) a pull request merge holds the task; (bad_state) the task is in backlog or not in the workflow's initial state, or the caller holds the review claim in a project that requires a distinct reviewer",
            content: {
              "application/json": {
                schema: { oneOf: [{ $ref: "#/components/schemas/ErrorResponse" }, { $ref: "#/components/schemas/MergeInProgressResponse" }] },
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
        description: "Only current claimant can release. Status is reset to open. Refused with 409 bad_state while the task is in a review state: the work claim stays with its holder until the reviewer approves or requests changes (admin-release is the override). A caller that also holds the review claim is pointed at /abandon, which drops both claims.",
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
          "409": {
            description: "The task is in a review state (bad_state), the claim is no longer held or the status changed before the request completed, or (merge_in_progress) a pull request merge holds the task",
            content: {
              "application/json": {
                schema: { oneOf: [{ $ref: "#/components/schemas/ErrorResponse" }, { $ref: "#/components/schemas/MergeInProgressResponse" }] },
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
          "409": {
            description: "The status changed before the request completed, or (merge_in_progress) a pull request merge holds the task",
            content: {
              "application/json": {
                schema: { oneOf: [{ $ref: "#/components/schemas/ErrorResponse" }, { $ref: "#/components/schemas/MergeInProgressResponse" }] },
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
          "409": {
            description: "merged_but_status_changed: the pull request was merged on GitHub, but the task was changed by another writer before this request could record it, so the task was not updated. mergeSha is the merge commit and currentStatus the status the task has now; the system's own PR-merge webhook having moved the task to done first is not an error (200). Other 409 causes use the ErrorResponse shape: foreign_deliverable_merge_refused, and conflict when an Idempotency-Key is reused with a different payload. merge_in_progress: another merge of the task holds its reservation, so this merge was refused before the GitHub call. grounding_github_fence_conflict: the task is under an active GitHub repository fence, so the reservation write was refused, nothing was merged and GitHub was not called; retry once the fenced operation has finished.",
            content: { "application/json": { schema: { oneOf: [{ type: "object", properties: { error: { type: "string", enum: ["merged_but_status_changed"] }, message: { type: "string" }, mergeSha: { type: "string", nullable: true }, currentStatus: { type: "string", nullable: true } }, required: ["error", "message", "mergeSha", "currentStatus"] }, { $ref: "#/components/schemas/MergeInProgressResponse" }, { $ref: "#/components/schemas/ErrorResponse" }] } } },
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
