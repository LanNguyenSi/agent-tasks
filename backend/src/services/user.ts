/**
 * User service — GitHub user upsert and retrieval
 */
import { prisma } from "../lib/prisma.js";
import type { GitHubUser } from "./github-oauth.js";

export async function upsertUserFromGitHub(githubUser: GitHubUser) {
  return prisma.user.upsert({
    where: { githubId: String(githubUser.id) },
    update: {
      login: githubUser.login,
      name: githubUser.name ?? undefined,
      avatarUrl: githubUser.avatar_url,
      email: githubUser.email ?? undefined,
      updatedAt: new Date(),
    },
    create: {
      githubId: String(githubUser.id),
      login: githubUser.login,
      name: githubUser.name ?? undefined,
      avatarUrl: githubUser.avatar_url,
      email: githubUser.email ?? undefined,
    },
  });
}

export async function getUserById(userId: string) {
  return prisma.user.findUnique({ where: { id: userId } });
}
