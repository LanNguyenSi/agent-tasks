import type { Prisma } from "@prisma/client";
import type { Actor } from "../types/auth.js";
import { z } from "zod";
import { GroundingAccessError, unavailable, type GroundingTask, type GroundingTarget, type GroundingAuthority } from "./grounding-context.js";
import { findDelegationUser } from "./github-delegation.js";
import { evaluateTransitionRules, GITHUB_BACKED_RULES, type TransitionRule } from "./transition-rules.js";
import { GroundingDecisionError } from "./grounding-transaction.js";

export async function completionGates(db: Prisma.TransactionClient, task: GroundingTask, actor: Actor, target: GroundingTarget, definition: unknown, authority: GroundingAuthority, remote: boolean) {
  const parsed = z.object({ transitions: z.array(z.object({ from: z.string(), to: z.string(), requiredRole: z.enum(["ADMIN", "HUMAN_MEMBER", "REVIEWER", "any"]).optional(), requires: z.array(z.string()).optional() })) }).safeParse(definition);
  if (!parsed.success) unavailable();
  const edge = parsed.data.transitions.find(t => t.from === target.from && t.to === target.to);
  if (!edge) throw new GroundingAccessError("bad_state", 409);
  if (edge.requiredRole && !await authority.hasRole(actor, task.projectId, edge.requiredRole, db)) throw new GroundingAccessError("forbidden", 403);
  const foreign = task.deliverableRepo !== null && task.deliverableRepo !== task.project.githubRepo;
  if (remote && foreign) throw new GroundingAccessError("forbidden", 403);
  // Local foreign-deliverable behavior preserves the existing explicit skip.
  const skipped = foreign ? (edge.requires ?? []).filter(r => GITHUB_BACKED_RULES.has(r as TransitionRule)) : [];
  const rules = (edge.requires ?? []).filter(r => !skipped.includes(r) && !(remote && r === "prMerged"));
  let githubToken: string | null = null;
  if (rules.some(r => GITHUB_BACKED_RULES.has(r as TransitionRule))) {
    const delegate = await findDelegationUser(task.project.teamId, "allowAgentPrCreate", { preferUserId: actor.userId, db });
    githubToken = delegate?.githubAccessToken ?? null;
  }
  const result = await evaluateTransitionRules(rules, { branchName: task.branchName, prUrl: task.prUrl, prNumber: task.prNumber, projectGithubRepo: task.project.githubRepo, githubToken });
  if (result.failed.length || result.unknown.length) throw new GroundingDecisionError("precondition_failed");
  return skipped;
}
