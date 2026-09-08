import type { Prisma } from "@prisma/client";
import type { Actor } from "../types/auth.js";
import { z } from "zod";
import { GroundingAccessError, unavailable, type GroundingTask, type GroundingTarget, type GroundingAuthority, type GroundingHeadProvider } from "./grounding-context.js";
import { findDelegationUser } from "./github-delegation.js";
import { evaluateTransitionRules, GITHUB_BACKED_RULES, type TransitionRule } from "./transition-rules.js";
import { fetchCheckRunStatus } from "./github-checks.js";
import { GroundingDecisionError } from "./grounding-transaction.js";

export async function completionGates(db: Prisma.TransactionClient, task: GroundingTask, actor: Actor, target: GroundingTarget, definition: unknown, authority: GroundingAuthority, remote: boolean, headProvider: GroundingHeadProvider) {
  return evaluateCompletionGates(db, task, actor, target, definition, authority, remote, headProvider, "allowAgentPrCreate");
}
export async function taskMergeCompletionGates(db: Prisma.TransactionClient, task: GroundingTask, actor: Actor, target: GroundingTarget, definition: unknown, authority: GroundingAuthority, remote: boolean, headProvider: GroundingHeadProvider) {
  return evaluateCompletionGates(db, task, actor, target, definition, authority, remote, headProvider, "allowAgentPrMerge");
}
async function evaluateCompletionGates(db: Prisma.TransactionClient, task: GroundingTask, actor: Actor, target: GroundingTarget, definition: unknown, authority: GroundingAuthority, remote: boolean, headProvider: GroundingHeadProvider, consent: "allowAgentPrCreate" | "allowAgentPrMerge") {
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
    const delegate = await findDelegationUser(task.project.teamId, consent, { preferUserId: actor.userId, db });
    githubToken = delegate?.githubAccessToken ?? null;
  }
  let ciHeadSha: string | null = null;
  if (rules.includes("ciGreen")) {
    try {
      const repo = task.project.githubRepo;
      if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isSafeInteger(task.prNumber) || (task.prNumber ?? 0) <= 0 ||
          task.prUrl !== `https://github.com/${repo}/pull/${task.prNumber}` || !githubToken) throw new GroundingDecisionError("precondition_failed");
      const [owner, name] = repo.split("/");
      // Retain the existing classification/cache policy, but never accept a
      // cached prior PR head as evidence for the fresh decision head.
      const ci = await fetchCheckRunStatus(owner!, name!, task.prNumber!, githubToken);
      const head = await headProvider({ actor, teamId: task.project.teamId, repo, prNumber: task.prNumber!, db });
      if (ci.state !== "success" || !/^[0-9a-f]{40}$/.test(head) || ci.sha !== head) throw new GroundingDecisionError("precondition_failed");
      ciHeadSha = head;
    } catch { throw new GroundingDecisionError("precondition_failed"); }
  }
  const result = await evaluateTransitionRules(rules.filter(rule => rule !== "ciGreen"), { branchName: task.branchName, prUrl: task.prUrl, prNumber: task.prNumber, projectGithubRepo: task.project.githubRepo, githubToken });
  if (result.failed.length || result.unknown.length) throw new GroundingDecisionError("precondition_failed");
  return { skippedRules: skipped, ciHeadSha };
}
