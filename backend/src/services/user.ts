/**
 * User service
 */
import { prisma } from "../lib/prisma.js";
import type { GitHubUser } from "./github-oauth.js";
import { hashPassword } from "./password.js";

function slugifyLogin(input: string): string {
  const normalized = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 40) : "user";
}

async function generateUniqueLogin(base: string): Promise<string> {
  const candidate = slugifyLogin(base);
  let index = 0;

  while (true) {
    const login = index === 0 ? candidate : `${candidate}-${index}`;
    const existing = await prisma.user.findUnique({ where: { login } });
    if (!existing) return login;
    index += 1;
  }
}

export async function getUserById(userId: string) {
  return prisma.user.findUnique({ where: { id: userId } });
}

export async function getUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

export async function createLocalUser(input: {
  email: string;
  password: string;
  name?: string;
}) {
  const email = input.email.toLowerCase().trim();
  const passwordHash = await hashPassword(input.password);
  const login = await generateUniqueLogin(email.split("@")[0] ?? email);

  return prisma.user.create({
    data: {
      email,
      passwordHash,
      login,
      name: input.name?.trim() || null,
    },
  });
}

export async function upsertUserFromGitHub(
  githubUser: GitHubUser,
  accessToken: string,
) {
  const githubId = String(githubUser.id);
  const email = githubUser.email?.toLowerCase() ?? null;

  const byGithubId = await prisma.user.findUnique({
    where: { githubId },
  });

  if (byGithubId) {
    return prisma.user.update({
      where: { id: byGithubId.id },
      data: {
        name: githubUser.name ?? byGithubId.name,
        avatarUrl: githubUser.avatar_url,
        email: email ?? byGithubId.email,
        githubAccessToken: accessToken,
        githubConnectedAt: new Date(),
      },
    });
  }

  if (email) {
    const byEmail = await prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      return prisma.user.update({
        where: { id: byEmail.id },
        data: {
          githubId,
          avatarUrl: githubUser.avatar_url,
          name: githubUser.name ?? byEmail.name,
          githubAccessToken: accessToken,
          githubConnectedAt: new Date(),
        },
      });
    }
  }

  const githubLogin = await generateUniqueLogin(githubUser.login);
  return prisma.user.create({
    data: {
      githubId,
      login: githubLogin,
      name: githubUser.name ?? undefined,
      avatarUrl: githubUser.avatar_url,
      email: email ?? undefined,
      githubAccessToken: accessToken,
      githubConnectedAt: new Date(),
    },
  });
}

export async function updateUserDelegation(
  userId: string,
  settings: {
    allowAgentPrCreate: boolean;
    allowAgentPrMerge: boolean;
    allowAgentPrComment: boolean;
  },
) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      allowAgentPrCreate: settings.allowAgentPrCreate,
      allowAgentPrMerge: settings.allowAgentPrMerge,
      allowAgentPrComment: settings.allowAgentPrComment,
    },
  });
}

export async function connectGitHubToExistingUser(
  userId: string,
  githubUser: GitHubUser,
  accessToken: string,
) {
  const githubId = String(githubUser.id);
  const existing = await prisma.user.findUnique({ where: { githubId } });

  if (existing && existing.id !== userId) {
    throw new Error("This GitHub account is already connected to another user");
  }

  return prisma.user.update({
    where: { id: userId },
    data: {
      githubId,
      avatarUrl: githubUser.avatar_url,
      name: githubUser.name ?? undefined,
      githubAccessToken: accessToken,
      githubConnectedAt: new Date(),
    },
  });
}
