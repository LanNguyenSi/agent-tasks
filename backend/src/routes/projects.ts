import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { Actor } from "../types/auth.js";
import type { AppVariables } from "../types/hono.js";
import { forbidden, notFound } from "../middleware/error.js";
import { ensureDefaultBoardForProject } from "../services/board-default.js";
import { taskTemplateSchema } from "../lib/confidence.js";
import {
  hasProjectAccess,
  isProjectAdmin,
  resolveTeamId,
  resolveTeamIdErrorBody,
  getProjectMembership,
} from "../services/team-access.js";
import { logAuditEvent } from "../services/audit.js";
import { unlink } from "node:fs/promises";
import { storedFilePath } from "../services/attachment-files.js";
import {
  GovernanceMode,
  deriveGovernanceModeFromFlags,
  legacyFlagsFromGovernanceMode,
} from "../lib/governance-mode.js";
import { resolveEnforcementMode, EnforcementMode } from "../lib/enforcement-mode.js";
import { describeTaskCreation } from "../lib/task-creation-readiness.js";
import { computeEffectiveGates } from "../services/gates/index.js";
import { httpUrl } from "../lib/url-guard.js";

export const projectRouter = new Hono<{ Variables: AppVariables }>();

const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes"),
  description: z.string().optional(),
  teamId: z.string().uuid(),
  githubRepo: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, "GitHub repo format: owner/repo")
    .optional(),
});

const updateProjectSchema = createProjectSchema.partial().omit({ teamId: true, slug: true }).extend({
  taskTemplate: taskTemplateSchema.nullable().optional(),
  confidenceThreshold: z.number().int().min(0).max(100).optional(),
  // scorer-v2 (T5): per-project confidence-gate enforcement level.
  enforcementMode: z.enum(["OFF", "WARN", "BLOCK"]).optional(),
  // Required to flip a project TO `BLOCK` (the gate enforces it; this is not a
  // stored column). Operationalizes "review the shadow report before blocking"
  // — see docs/scorer-v2-enforcement.md.
  acknowledgeShadowReport: z.boolean().optional(),
  governanceMode: z
    .enum(["REQUIRES_DISTINCT_REVIEWER", "AWAITS_CONFIRMATION", "AUTONOMOUS"])
    .optional(),
  /** @deprecated prefer `governanceMode`. Kept for backward compatibility. */
  requireDistinctReviewer: z.boolean().optional(),
  /** @deprecated prefer `governanceMode`. Kept for backward compatibility. */
  soloMode: z.boolean().optional(),
  // Phase 3 of the grounding-hint integration. Default false because the
  // evidence ledger lives on a single host's filesystem; in multi-host
  // deployments the backend cannot read what the agent wrote. Power users
  // in single-host setups can flip it on per-project.
  // See docs/adr/0002-grounding-finish-gate.md.
  requireGroundingForDebug: z.boolean().optional(),
  // Outbound Signal-webhook target. See docs/notification-webhooks.md.
  // Pass an empty string OR null to clear. URL is validated for shape only —
  // we do not probe reachability here; failed deliveries surface in audit.
  notificationWebhookUrl: z
    .union([httpUrl(), z.literal(""), z.null()])
    .optional(),
  // Signing secret. Empty string / null clears. Never echoed in responses.
  notificationWebhookSecret: z
    .union([z.string().min(1).max(255), z.literal(""), z.null()])
    .optional(),
});

/**
 * Strip the webhook secret from API responses and expose a boolean
 * indicating whether one is set. Operators can tell the secret exists
 * (so the UI can show "•••• (set)" with a Replace affordance) without
 * us round-tripping the value.
 */
function redactProject<T extends { notificationWebhookSecret?: string | null }>(
  project: T,
): Omit<T, "notificationWebhookSecret"> & { hasNotificationWebhookSecret: boolean } {
  const { notificationWebhookSecret, ...rest } = project;
  return {
    ...rest,
    hasNotificationWebhookSecret: !!notificationWebhookSecret,
  };
}

/**
 * Team-only membership check. Used for routes that genuinely need team
 * scope (project creation, since per-project shares can't bootstrap a
 * project in a team the user is not in). All other reads/writes use
 * `hasProjectAccess` / `isProjectAdmin` from services/team-access.ts so
 * ProjectMember grants are honored.
 */
async function assertTeamMembership(actor: Actor, teamId: string): Promise<boolean> {
  if (actor.type === "agent") {
    return actor.teamId === teamId;
  }
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId: actor.userId } },
  });
  return !!membership;
}

// ── List projects ─────────────────────────────────────────────────────────────

projectRouter.get("/projects", async (c) => {
  const actor = c.get("actor");
  const resolved = await resolveTeamId(actor, c.req.query("teamId"));
  if (!resolved.ok) {
    return c.json(
      resolveTeamIdErrorBody(resolved),
      resolved.status,
    );
  }

  // Humans see team projects PLUS any project they have a per-project
  // grant on (shared via invite from another team). Agents see team-only;
  // their per-project access is exercised through specific project IDs,
  // not through this listing.
  const projects = await prisma.project.findMany({
    where:
      actor.type === "human"
        ? {
            OR: [
              { teamId: resolved.teamId },
              { projectMembers: { some: { userId: actor.userId } } },
            ],
          }
        : { teamId: resolved.teamId },
    orderBy: { createdAt: "desc" },
  });

  // Annotate each project with `accessSource` so the UI can mark shared
  // projects. For agents this is always "team" by construction.
  // `redactProject` strips notificationWebhookSecret and replaces it with
  // a boolean — secrets never round-trip on read paths.
  const projectsAnnotated =
    actor.type === "human"
      ? projects.map((p) =>
          redactProject({
            ...p,
            accessSource: p.teamId === resolved.teamId ? "team" : "project",
          }),
        )
      : projects.map((p) => redactProject({ ...p, accessSource: "team" as const }));

  return c.json({ projects: projectsAnnotated });
});

// ── List token-available projects (agent-friendly) ──────────────────────────

projectRouter.get("/projects/available", async (c) => {
  const actor = c.get("actor");
  const resolved = await resolveTeamId(actor, c.req.query("teamId"));
  if (!resolved.ok) {
    return c.json(
      resolveTeamIdErrorBody(resolved),
      resolved.status,
    );
  }

  // Same access expansion as `/projects`: humans see team projects plus
  // shared projects.
  const projects = await prisma.project.findMany({
    where:
      actor.type === "human"
        ? {
            OR: [
              { teamId: resolved.teamId },
              { projectMembers: { some: { userId: actor.userId } } },
            ],
          }
        : { teamId: resolved.teamId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      teamId: true,
      name: true,
      slug: true,
      description: true,
      githubRepo: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return c.json({
    projects: projects.map((project) => ({
      ...project,
      displayName: `${project.name} (${project.slug})`,
      accessSource:
        actor.type === "human" && project.teamId !== resolved.teamId
          ? ("project" as const)
          : ("team" as const),
    })),
  });
});

// ── Get project by slug ──────────────────────────────────────────────────────

projectRouter.get("/projects/by-slug/:slug", async (c) => {
  const actor = c.get("actor");
  const slug = c.req.param("slug");

  const resolved = await resolveTeamId(actor, c.req.query("teamId"));
  if (!resolved.ok) {
    return c.json(
      resolveTeamIdErrorBody(resolved),
      resolved.status,
    );
  }
  const teamId = resolved.teamId;

  const project = await prisma.project.findUnique({
    where: { teamId_slug: { teamId, slug } },
  });

  if (!project) return notFound(c);

  // Mirror GET /projects/:id so the `projects_get` verb returns the same shape
  // for slug lookups: the gate map plus the task-creation readiness block.
  return c.json({
    project: redactProject(project),
    effectiveGates: computeEffectiveGates(project),
    taskCreation: describeTaskCreation(project),
  });
});

// ── Create project ────────────────────────────────────────────────────────────

projectRouter.post("/projects", zValidator("json", createProjectSchema), async (c) => {
  const actor = c.get("actor");
  const body = c.req.valid("json");

  // Only humans can create projects
  if (actor.type === "agent") {
    return forbidden(c, "Agents cannot create projects");
  }

  if (!(await assertTeamMembership(actor, body.teamId))) {
    return forbidden(c, "Access denied to this team");
  }

  // Check slug uniqueness within team
  const existing = await prisma.project.findUnique({
    where: { teamId_slug: { teamId: body.teamId, slug: body.slug } },
  });
  if (existing) {
    return c.json({ error: "conflict", message: "Project slug already exists in this team" }, 409);
  }

  const project = await prisma.project.create({
    data: {
      teamId: body.teamId,
      name: body.name,
      slug: body.slug,
      description: body.description,
      githubRepo: body.githubRepo,
    },
  });

  await ensureDefaultBoardForProject(project.id);

  return c.json({ project: redactProject(project) }, 201);
});

// ── Get project ───────────────────────────────────────────────────────────────

projectRouter.get("/projects/:id", async (c) => {
  const actor = c.get("actor");
  const project = await prisma.project.findUnique({
    where: { id: c.req.param("id") },
  });

  if (!project) return notFound(c);

  const membership = await getProjectMembership(actor, project.id);
  if (!membership) {
    return forbidden(c, "Access denied");
  }

  // `effectiveGates` is a per-project projection of the gate registry:
  // for each registered gate, whether it would evaluate on this project
  // and why. Lets clients (agents, UI, external integrations) learn the
  // invariant surface BEFORE tripping a 4xx. See services/gates/.
  return c.json({
    project: redactProject({ ...project, accessSource: membership.source }),
    effectiveGates: computeEffectiveGates(project),
    taskCreation: describeTaskCreation(project),
  });
});

// Dedicated discovery endpoint — same data as `GET /projects/:id` but
// without the project payload, for clients that only need the gate map.
projectRouter.get("/projects/:id/effective-gates", async (c) => {
  const actor = c.get("actor");
  const project = await prisma.project.findUnique({
    where: { id: c.req.param("id") },
    select: {
      teamId: true,
      githubRepo: true,
      governanceMode: true,
      soloMode: true,
      requireDistinctReviewer: true,
      // Task-creation readiness — lets an agent learn, before composing a task,
      // whether template mode is on and which structured fields are required.
      taskTemplate: true,
      enforcementMode: true,
      confidenceThreshold: true,
    },
  });

  if (!project) return notFound(c);

  if (!(await hasProjectAccess(actor, c.req.param("id")))) {
    return forbidden(c, "Access denied");
  }

  return c.json({
    effectiveGates: computeEffectiveGates(project),
    taskCreation: describeTaskCreation(project),
  });
});

// ── Update project ────────────────────────────────────────────────────────────

projectRouter.patch("/projects/:id", zValidator("json", updateProjectSchema), async (c) => {
  const actor = c.get("actor");

  if (actor.type === "agent") {
    return forbidden(c, "Agents cannot update projects");
  }

  const project = await prisma.project.findUnique({ where: { id: c.req.param("id") } });
  if (!project) return notFound(c);

  // Project settings carry governance semantics (confidence threshold,
  // distinct-reviewer gate, task template). Any team member used to be
  // able to flip these — which means a careless or malicious member could
  // silently disable the distinct-reviewer gate before self-approving
  // a task. Require admin on the whole PATCH path, matching the existing
  // `DELETE /projects/:id` check above.
  if (!(await isProjectAdmin(actor, project.id))) {
    return forbidden(c, "Only team admins can update project settings");
  }

  const body = c.req.valid("json");

  // scorer-v2 (T5): flipping a project TO `BLOCK` is gated on an explicit
  // acknowledgement that its shadow report was reviewed. `acknowledgeShadowReport`
  // is a request-only flag, never persisted. Idempotent re-sets of an
  // already-BLOCK project don't require it.
  if (body.enforcementMode === "BLOCK" && resolveEnforcementMode(project) !== EnforcementMode.BLOCK && body.acknowledgeShadowReport !== true) {
    return c.json(
      {
        error: "shadow_report_unacknowledged",
        message:
          "Flipping enforcementMode to BLOCK requires acknowledgeShadowReport=true. Review the project's shadow report first (npm run shadow:report), then re-send with the acknowledgement. See docs/scorer-v2-enforcement.md.",
      },
      400,
    );
  }

  // `acknowledgeShadowReport` is a control flag, not a column — keep it out of the write.
  const { taskTemplate, notificationWebhookUrl, notificationWebhookSecret, acknowledgeShadowReport: _ack, ...rest } = body;
  const data: Prisma.ProjectUpdateInput = { ...rest };
  if (taskTemplate !== undefined) {
    data.taskTemplate = taskTemplate === null ? Prisma.JsonNull : taskTemplate;
  }
  // Empty string is the UI's way to clear an optional field — normalize to
  // null so Prisma writes `NULL` and reads stop returning the old value.
  if (notificationWebhookUrl !== undefined) {
    data.notificationWebhookUrl = notificationWebhookUrl === "" ? null : notificationWebhookUrl;
  }
  if (notificationWebhookSecret !== undefined) {
    data.notificationWebhookSecret = notificationWebhookSecret === "" ? null : notificationWebhookSecret;
  }

  // Governance-mode writes always keep the legacy columns in sync so
  // dashboards still reading them stay accurate through the deprecation
  // window. If the client sends both, `governanceMode` wins and the legacy
  // fields in the payload are overwritten by the derivation.
  if (body.governanceMode !== undefined) {
    const mode = body.governanceMode as GovernanceMode;
    const legacy = legacyFlagsFromGovernanceMode(mode);
    data.governanceMode = mode;
    data.soloMode = legacy.soloMode;
    data.requireDistinctReviewer = legacy.requireDistinctReviewer;
  } else if (
    body.soloMode !== undefined ||
    body.requireDistinctReviewer !== undefined
  ) {
    // Legacy-only write: derive governanceMode so new readers see a
    // consistent value. Missing legacy flags fall back to the existing
    // row values.
    const soloMode = body.soloMode ?? project.soloMode;
    const requireDistinctReviewer =
      body.requireDistinctReviewer ?? project.requireDistinctReviewer;
    data.governanceMode = deriveGovernanceModeFromFlags({
      soloMode,
      requireDistinctReviewer,
    });
  }

  const updated = await prisma.project.update({
    where: { id: project.id },
    data,
  });

  // Audit the toggle so flipping the governance flag is traceable.
  // Scoped to the fields that carry real authorization meaning —
  // cosmetic renames are covered by updatedAt.
  const governanceChange: Record<string, unknown> = {};
  if (body.requireDistinctReviewer !== undefined && body.requireDistinctReviewer !== project.requireDistinctReviewer) {
    governanceChange.requireDistinctReviewer = {
      from: project.requireDistinctReviewer,
      to: body.requireDistinctReviewer,
    };
  }
  if (body.confidenceThreshold !== undefined && body.confidenceThreshold !== project.confidenceThreshold) {
    governanceChange.confidenceThreshold = {
      from: project.confidenceThreshold,
      to: body.confidenceThreshold,
    };
  }
  if (body.enforcementMode !== undefined && body.enforcementMode !== project.enforcementMode) {
    governanceChange.enforcementMode = {
      from: project.enforcementMode,
      to: body.enforcementMode,
    };
  }
  if (body.soloMode !== undefined && body.soloMode !== project.soloMode) {
    governanceChange.soloMode = {
      from: project.soloMode,
      to: body.soloMode,
    };
  }
  if (body.governanceMode !== undefined && body.governanceMode !== project.governanceMode) {
    governanceChange.governanceMode = {
      from: project.governanceMode,
      to: body.governanceMode,
    };
  }
  if (
    body.requireGroundingForDebug !== undefined &&
    body.requireGroundingForDebug !== project.requireGroundingForDebug
  ) {
    governanceChange.requireGroundingForDebug = {
      from: project.requireGroundingForDebug,
      to: body.requireGroundingForDebug,
    };
  }
  // Notification-webhook config is ops-sensitive: a flipped URL changes
  // where Signals are pushed, and a rotated secret invalidates receivers.
  // Audit URL transitions in plaintext (operators need to see destinations)
  // and secret changes as set/cleared/rotated booleans — never log the
  // raw secret value.
  if (notificationWebhookUrl !== undefined) {
    const nextUrl = notificationWebhookUrl === "" ? null : notificationWebhookUrl;
    if (nextUrl !== project.notificationWebhookUrl) {
      governanceChange.notificationWebhookUrl = {
        from: project.notificationWebhookUrl,
        to: nextUrl,
      };
    }
  }
  if (notificationWebhookSecret !== undefined) {
    const had = !!project.notificationWebhookSecret;
    const has = notificationWebhookSecret !== "" && notificationWebhookSecret !== null;
    // The plaintext compare below works because we read the raw secret
    // from the DB above. If notificationWebhookSecret ever moves to a
    // hashed-at-rest model, this comparison silently breaks (raw input
    // vs hash will never equal) — switch to a hash compare at that point.
    if (had !== has || (had && has && notificationWebhookSecret !== project.notificationWebhookSecret)) {
      governanceChange.notificationWebhookSecret = {
        from: had ? "set" : "unset",
        to: has ? "set" : "unset",
      };
    }
  }
  if (Object.keys(governanceChange).length > 0) {
    void logAuditEvent({
      action: "project.updated",
      actorId: actor.userId,
      projectId: project.id,
      payload: { changes: governanceChange },
    });
  }

  return c.json({ project: redactProject(updated) });
});

// ── Delete project ────────────────────────────────────────────────────────────

projectRouter.delete("/projects/:id", async (c) => {
  const actor = c.get("actor");

  if (actor.type === "agent") {
    return forbidden(c, "Agents cannot delete projects");
  }

  const project = await prisma.project.findUnique({ where: { id: c.req.param("id") } });
  if (!project) return notFound(c);

  // Project deletion is destructive; require admin authority. Matches the
  // PATCH guard that was tightened for governance fields. Prior code only
  // checked team membership — any HUMAN_MEMBER could delete the project.
  if (!(await isProjectAdmin(actor, project.id))) {
    return forbidden(c, "Only project admins can delete projects");
  }

  // Reclaim disk for uploaded attachments before the Project->Task->Attachment
  // cascade drops their rows; the cascade never touches the backing files.
  const attachments = await prisma.taskAttachment.findMany({
    where: { task: { projectId: project.id } },
    select: { url: true },
  });
  await prisma.project.delete({ where: { id: project.id } });
  for (const a of attachments) {
    const abs = storedFilePath(a.url);
    if (abs) await unlink(abs).catch(() => {});
  }

  return c.json({ success: true });
});

// ── GitHub sync trigger (placeholder for Wave 3) ─────────────────────────────

projectRouter.post("/projects/:id/sync", async (c) => {
  const actor = c.get("actor");

  if (actor.type === "agent") {
    return forbidden(c, "Agents cannot trigger project sync");
  }

  const project = await prisma.project.findUnique({ where: { id: c.req.param("id") } });
  if (!project) return notFound(c);

  if (!(await hasProjectAccess(actor, project.id))) {
    return forbidden(c, "Access denied");
  }

  if (!project.githubRepo) {
    return c.json({ error: "bad_request", message: "Project has no GitHub repository configured" }, 400);
  }

  const user = await prisma.user.findUnique({ where: { id: actor.userId } });
  if (!user?.githubAccessToken) {
    return c.json(
      { error: "forbidden", message: "Connect your GitHub account in settings before syncing" },
      403,
    );
  }

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { githubSyncAt: new Date() },
  });

  await ensureDefaultBoardForProject(updated.id);

  return c.json({ project: redactProject(updated), message: "Sync initiated (Wave 3: full implementation)" });
});
