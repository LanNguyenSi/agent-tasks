import { z } from "zod";
import type { Actor } from "../types/auth.js";
import type { Prisma } from "@prisma/client";
import { findDelegationUser } from "./github-delegation.js";
import { GroundingAccessError, unavailable } from "./grounding-context.js";

const repoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).refine(repo => repo.split("/").every(p => p !== "." && p !== ".."));
export const mergeIdentitySchema = z.object({ repo: repoSchema, prNumber: z.number().int().positive().max(2147483647), headSha: z.string().regex(/^[0-9a-f]{40}$/), method: z.enum(["merge", "squash", "rebase"]) });
export type MergeIdentity = z.infer<typeof mergeIdentitySchema>;
export interface MergeProof { repo: string; prNumber: number; headSha: string; merged: boolean; mergeCommitSha: string | null }
export interface GroundingMergeProvider {
  merge(input: MergeIdentity, token: string): Promise<void>;
  read(input: MergeIdentity, token: string): Promise<MergeProof>;
}
export async function groundingMergeConsent(db: Prisma.TransactionClient, actor: Actor, teamId: string): Promise<string> {
  if (actor.type === "agent" && !actor.scopes.includes("github:pr_merge")) throw new GroundingAccessError("forbidden", 403);
  const delegate = await findDelegationUser(teamId, "allowAgentPrMerge", { preferUserId: actor.userId, db });
  if (!delegate) throw new GroundingAccessError("forbidden", 403);
  return delegate.githubAccessToken;
}
async function request(input: MergeIdentity, token: string, write: boolean): Promise<unknown> {
  if (!mergeIdentitySchema.safeParse(input).success || !token) unavailable();
  const response = await fetch(`https://api.github.com/repos/${input.repo}/pulls/${input.prNumber}${write ? "/merge" : ""}`, {
    method: write ? "PUT" : "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "Cache-Control": "no-cache" },
    ...(write ? { body: JSON.stringify({ sha: input.headSha, merge_method: input.method }) } : {}),
  });
  if (!response.ok || !response.body) unavailable();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length;
      if (length > 262144) { await reader.cancel(); unavailable(); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
/** A successful PUT alone is not recovery proof: GET pins the source head separately. */
export const githubGroundingMergeProvider: GroundingMergeProvider = {
  async merge(input, token) {
    const body = await request(input, token, true);
    if (!z.object({ merged: z.literal(true), sha: z.string().regex(/^[0-9a-f]{40}$/) }).safeParse(body).success) unavailable();
  },
  async read(input, token) {
    const body = await request(input, token, false);
    const parsed = z.object({ number: z.literal(input.prNumber), html_url: z.literal(`https://github.com/${input.repo}/pull/${input.prNumber}`),
      base: z.object({ repo: z.object({ full_name: z.literal(input.repo) }) }), head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
      merged: z.boolean(), state: z.enum(["open", "closed"]), merge_commit_sha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    }).safeParse(body);
    if (!parsed.success || (parsed.data.merged && (parsed.data.state !== "closed" || !parsed.data.merge_commit_sha))) unavailable();
    return { repo: input.repo, prNumber: input.prNumber, headSha: parsed.data.head.sha, merged: parsed.data.merged, mergeCommitSha: parsed.data.merge_commit_sha };
  },
};
export function matchesGroundingMerge(input: MergeIdentity, proof: MergeProof): boolean {
  return proof.merged === true && proof.repo === input.repo && proof.prNumber === input.prNumber && proof.headSha === input.headSha && typeof proof.mergeCommitSha === "string" && /^[0-9a-f]{40}$/.test(proof.mergeCommitSha);
}
