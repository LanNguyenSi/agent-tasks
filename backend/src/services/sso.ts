/**
 * SSO (OIDC) team-scoped operations:
 *  - CRUD on SsoConnection
 *  - login flow: upsert user + identity, ensure team membership
 *  - domain-based discovery for the login page
 */

import { prisma } from "../lib/prisma.js";
import { config } from "../config/index.js";
import { decryptSecret, encryptSecret } from "./sso-crypto.js";
import type { OidcIdTokenClaims } from "./oidc.js";

export interface SsoConnectionInput {
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  emailDomains: string[];
  autoProvision?: boolean;
  enabled?: boolean;
}

function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^@/, "");
}

export async function upsertSsoConnection(teamId: string, input: SsoConnectionInput) {
  const clientSecretEnc = await encryptSecret(input.clientSecret, config.SSO_ENCRYPTION_KEY);
  const domains = input.emailDomains.map(normalizeDomain).filter(Boolean);

  return prisma.ssoConnection.upsert({
    where: { teamId },
    create: {
      teamId,
      displayName: input.displayName,
      issuer: input.issuer.replace(/\/+$/, ""),
      clientId: input.clientId,
      clientSecretEnc,
      emailDomains: domains,
      autoProvision: input.autoProvision ?? true,
      enabled: input.enabled ?? true,
    },
    update: {
      displayName: input.displayName,
      issuer: input.issuer.replace(/\/+$/, ""),
      clientId: input.clientId,
      clientSecretEnc,
      emailDomains: domains,
      autoProvision: input.autoProvision ?? true,
      enabled: input.enabled ?? true,
    },
  });
}

export async function getSsoConnectionByTeamId(teamId: string) {
  return prisma.ssoConnection.findUnique({ where: { teamId } });
}

export async function getSsoConnectionByTeamSlug(slug: string) {
  const team = await prisma.team.findUnique({ where: { slug } });
  if (!team) return null;
  const conn = await prisma.ssoConnection.findUnique({ where: { teamId: team.id } });
  if (!conn) return null;
  return Object.assign(conn, { team: { slug: team.slug, name: team.name, id: team.id } });
}

/** Public view of a connection — never includes the client secret. */
export function publicSsoConnection(
  c: NonNullable<Awaited<ReturnType<typeof getSsoConnectionByTeamId>>>,
) {
  return {
    id: c.id,
    teamId: c.teamId,
    displayName: c.displayName,
    issuer: c.issuer,
    clientId: c.clientId,
    emailDomains: c.emailDomains,
    autoProvision: c.autoProvision,
    enabled: c.enabled,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export async function decryptClientSecret(encoded: string): Promise<string> {
  return decryptSecret(encoded, config.SSO_ENCRYPTION_KEY);
}

export async function deleteSsoConnection(teamId: string) {
  await prisma.ssoConnection.deleteMany({ where: { teamId } });
}

/** Find the enabled SSO connection whose email domains contain the given email. */
export async function findSsoConnectionForEmail(email: string) {
  const at = email.indexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain) return null;

  // Array contains — use Prisma `has` filter.
  return prisma.ssoConnection.findFirst({
    where: {
      enabled: true,
      emailDomains: { has: domain },
    },
    include: { team: { select: { slug: true, name: true } } },
  });
}

// ── Login flow: identity → user ──────────────────────────────────────────────

function slugifyLogin(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base.slice(0, 40) : "user";
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

/**
 * Look up (or provision) a user from an OIDC ID token, attach/refresh the
 * UserIdentity row, and ensure they're a HUMAN_MEMBER of the connection's
 * team when auto-provisioning is enabled.
 *
 * Returns `null` when the SSO connection has auto-provisioning disabled
 * and no identity/email match exists — callers should render an error in
 * that case rather than silently creating an orphan user.
 */
export async function upsertUserFromOidc(
  ssoConnection: { id: string; teamId: string; issuer: string; autoProvision: boolean },
  claims: OidcIdTokenClaims,
): Promise<{ id: string; login: string; email: string | null } | null> {
  const providerUserId = claims.sub;
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  const displayName =
    (typeof claims.name === "string" && claims.name) ||
    (typeof claims.preferred_username === "string" && claims.preferred_username) ||
    null;
  const picture = typeof claims.picture === "string" ? claims.picture : null;

  // 1. Existing identity for this (provider, sub)?
  const existingIdentity = await prisma.userIdentity.findUnique({
    where: { provider_providerUserId: { provider: "oidc", providerUserId } },
    include: { user: true },
  });

  let user = existingIdentity?.user ?? null;

  // 2. No identity row — try to link by email so manual/GitHub-bootstrapped
  //    users don't get duplicated.
  if (!user && email) {
    user = await prisma.user.findUnique({ where: { email } });
  }

  // 3. Still nothing — provision, if policy allows.
  if (!user) {
    if (!ssoConnection.autoProvision) {
      return null;
    }
    const loginBase = email ? (email.split("@")[0] ?? email) : providerUserId;
    const login = await generateUniqueLogin(loginBase);
    user = await prisma.user.create({
      data: {
        login,
        email: email ?? undefined,
        name: displayName ?? undefined,
        avatarUrl: picture ?? undefined,
      },
    });
  } else {
    // Refresh profile fields opportunistically — but don't overwrite a name
    // the user has set locally with a blank from the IdP.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        name: displayName ?? user.name ?? undefined,
        avatarUrl: picture ?? user.avatarUrl ?? undefined,
        email: email ?? user.email ?? undefined,
      },
    });
  }

  // 4. Upsert the identity row so future logins hit the fast path.
  await prisma.userIdentity.upsert({
    where: { provider_providerUserId: { provider: "oidc", providerUserId } },
    create: {
      userId: user.id,
      provider: "oidc",
      providerUserId,
      ssoConnectionId: ssoConnection.id,
      email,
    },
    update: {
      userId: user.id,
      ssoConnectionId: ssoConnection.id,
      email: email ?? undefined,
    },
  });

  // 5. Ensure membership in the SSO-owning team.
  await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: ssoConnection.teamId, userId: user.id } },
    create: { teamId: ssoConnection.teamId, userId: user.id, role: "HUMAN_MEMBER" },
    update: {},
  });

  return { id: user.id, login: user.login, email: user.email };
}
