/**
 * SSO (OIDC) team-scoped operations:
 *  - CRUD on SsoConnection
 *  - login flow: upsert user + identity, ensure team membership
 *  - domain-based discovery for the login page
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";
import { decryptSecret, encryptSecret } from "./sso-crypto.js";
import type { OidcIdTokenClaims } from "./oidc.js";
import { ConflictError, ValidationError } from "../lib/errors.js";

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

// A tiny deny-list for well-known free-mail / public-suffix domains. This is
// not exhaustive — the goal is to block the obvious "claim gmail.com and hijack
// everyone" scenario, not to be a full public-suffix implementation.
const BLOCKED_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "mail.ru",
  "yandex.com",
]);

function validateDomain(domain: string): void {
  if (BLOCKED_DOMAINS.has(domain)) {
    throw new ValidationError(
      `Domain "${domain}" is a public mail provider and cannot be claimed`,
    );
  }
  // Must look like a registrable domain — at least one dot, valid label chars.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new ValidationError(`"${domain}" is not a valid domain`);
  }
}

/** Fail if any of the given domains is already claimed by another team. */
async function ensureDomainsUnclaimed(teamId: string, domains: string[]): Promise<void> {
  if (domains.length === 0) return;
  const conflicts = await prisma.ssoConnection.findMany({
    where: {
      teamId: { not: teamId },
      emailDomains: { hasSome: domains },
    },
    select: { teamId: true, emailDomains: true },
  });
  if (conflicts.length > 0) {
    const claimed = new Set<string>();
    for (const c of conflicts) {
      for (const d of c.emailDomains) {
        if (domains.includes(d)) claimed.add(d);
      }
    }
    throw new ConflictError(
      `Domain(s) already claimed by another team: ${Array.from(claimed).join(", ")}`,
    );
  }
}

export async function upsertSsoConnection(teamId: string, input: SsoConnectionInput) {
  const clientSecretEnc = await encryptSecret(input.clientSecret, config.SSO_ENCRYPTION_KEY);
  const domains = input.emailDomains.map(normalizeDomain).filter(Boolean);
  for (const d of domains) validateDomain(d);
  await ensureDomainsUnclaimed(teamId, domains);

  return prisma.$transaction(async (tx) => {
    const previous = await tx.ssoConnection.findUnique({
      where: { teamId },
      select: { id: true, issuer: true },
    });
    const saved = await tx.ssoConnection.upsert({
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
    // An OIDC `sub` is only unique per issuer. When the connection moves to
    // another issuer, the identities it minted (or that were rebound to it)
    // are unbound, so the next login for them fails closed instead of letting
    // the new IdP assert their `sub`.
    if (previous && normalizeIssuer(previous.issuer) !== normalizeIssuer(saved.issuer)) {
      const unbound = await tx.userIdentity.updateMany({
        where: { provider: "oidc", ssoConnectionId: previous.id },
        data: { ssoConnectionId: null },
      });
      logger.warn(
        { component: "sso", phase: "issuer_change", connectionId: previous.id, unbound: unbound.count },
        "SSO issuer changed: identities of the connection unbound",
      );
    }
    return saved;
  });
}

export async function getSsoConnectionByTeamId(teamId: string) {
  return prisma.ssoConnection.findUnique({ where: { teamId } });
}

export interface SsoConnectionWithTeam {
  connection: NonNullable<Awaited<ReturnType<typeof getSsoConnectionByTeamId>>>;
  team: { id: string; slug: string; name: string };
}

export async function getSsoConnectionByTeamSlug(
  slug: string,
): Promise<SsoConnectionWithTeam | null> {
  const team = await prisma.team.findUnique({ where: { slug } });
  if (!team) return null;
  const connection = await prisma.ssoConnection.findUnique({ where: { teamId: team.id } });
  if (!connection) return null;
  return { connection, team: { id: team.id, slug: team.slug, name: team.name } };
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
 * Refusal returned by `upsertUserFromOidc` when the (oidc, sub) identity
 * already exists but was minted by an issuer other than the one of the
 * connection the login came through (or its connection is unknown).
 */
export interface OidcLoginRefusal {
  refused: "identity_conflict";
}

// Issuers are compared as exact strings after removing trailing slashes, the
// same normalisation the connection upsert and the OIDC client apply.
function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

/**
 * Look up (or provision) a user from an OIDC ID token, attach/refresh the
 * UserIdentity row, and ensure they're a HUMAN_MEMBER of the connection's
 * team when auto-provisioning is enabled.
 *
 * Returns `null` when the SSO connection has auto-provisioning disabled
 * and no identity/email match exists — callers should render an error in
 * that case rather than silently creating an orphan user.
 *
 * It also returns `null` when auto-provisioning is disabled and the matched
 * user is not already a member of the connection's team: with
 * auto-provisioning off, SSO never adds anyone to the team.
 *
 * Returns an `OidcLoginRefusal` when an identity for this `sub` exists and
 * the connection it is bound to has a different issuer, or is missing (null
 * or deleted). A `sub` is only unique per issuer, so another IdP asserting the
 * same value must not reach that user. Nothing is written in that case.
 *
 * All writes run in one transaction that re-reads the current connection's
 * issuer under a row lock, so a concurrent issuer change either sees this
 * login's identity (and unbinds it) or makes this login fail. When two first
 * logins race for the same new `sub`, the loser's writes roll back and it runs
 * once more against the identity the winner created.
 */
export async function upsertUserFromOidc(
  ssoConnection: OidcLoginConnection,
  claims: OidcIdTokenClaims,
): Promise<OidcLoginResult> {
  try {
    return await upsertUserFromOidcOnce(ssoConnection, claims);
  } catch (err) {
    if (!(err instanceof IdentityCreateConflict)) throw err;
  }
  return upsertUserFromOidcOnce(ssoConnection, claims);
}

interface OidcLoginConnection {
  id: string;
  teamId: string;
  issuer: string;
  autoProvision: boolean;
  emailDomains: string[];
}

type OidcLoginResult = { id: string; login: string; email: string | null } | OidcLoginRefusal | null;

/** Another login inserted the identity for this sub after our lookup. */
class IdentityCreateConflict extends Error {}

/** The connection changed issuer or was deleted while this login ran. */
class ConnectionChangedDuringLogin extends Error {}

async function upsertUserFromOidcOnce(
  ssoConnection: OidcLoginConnection,
  claims: OidcIdTokenClaims,
): Promise<OidcLoginResult> {
  const providerUserId = claims.sub;
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  const emailVerified = claims.email_verified === true;
  // Only trust email-based account linking when the IdP asserts the email is
  // verified AND the email's domain is one the team admin has claimed for this
  // SSO connection. Otherwise an attacker-controlled IdP could claim
  // alice@victim.com and get linked to Alice's existing account.
  const emailDomain = email?.split("@")[1] ?? null;
  const emailDomainClaimed =
    emailDomain !== null && ssoConnection.emailDomains.includes(emailDomain);
  const emailIsTrustworthy = emailVerified && emailDomainClaimed;
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

  // 1a. An existing identity is only usable through a connection of the same
  //     issuer. Fail closed when the bound connection is unknown.
  if (existingIdentity) {
    const boundConnectionId = existingIdentity.ssoConnectionId;
    const boundConnection =
      boundConnectionId === null
        ? null
        : boundConnectionId === ssoConnection.id
          ? ssoConnection
          : await prisma.ssoConnection.findUnique({
              where: { id: boundConnectionId },
              select: { issuer: true },
            });
    if (
      !boundConnection ||
      normalizeIssuer(boundConnection.issuer) !== normalizeIssuer(ssoConnection.issuer)
    ) {
      // The sub is never logged; the identity row id is enough to trace it.
      logger.warn(
        {
          component: "sso",
          phase: "identity_lookup",
          identityId: existingIdentity.id,
          connectionId: ssoConnection.id,
          boundConnectionId,
          cause:
            boundConnectionId === null
              ? "unbound"
              : boundConnection
                ? "issuer_mismatch"
                : "connection_missing",
        },
        "SSO login refused: identity is bound to another issuer",
      );
      return { refused: "identity_conflict" };
    }
  }

  let user = existingIdentity?.user ?? null;

  // 2. No identity row — try to link by email so manual/GitHub-bootstrapped
  //    users don't get duplicated. We only do this when the IdP asserts
  //    email_verified=true AND the email's domain is explicitly claimed by
  //    this SSO connection. Otherwise this path is an account-takeover
  //    vector.
  if (!user && email && emailIsTrustworthy) {
    user = await prisma.user.findUnique({ where: { email } });
  }

  // 2a. Without auto-provisioning, SSO only signs in users who are already
  //     members of the connection's team; it never adds one.
  if (user && !ssoConnection.autoProvision) {
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: ssoConnection.teamId, userId: user.id } },
      select: { id: true },
    });
    if (!membership) {
      return null;
    }
  }

  // 3. Still nothing: provision, if policy allows.
  if (!user && !ssoConnection.autoProvision) {
    return null;
  }
  const loginBase = email ? (email.split("@")[0] ?? email) : providerUserId;
  const newLogin = user ? null : await generateUniqueLogin(loginBase);
  const matchedUser = user;

  return prisma.$transaction(async (tx) => {
    // Lock the connection row and re-check its issuer: an issuer change
    // commits either before this read (the login fails) or after this
    // transaction (its unbind then covers the identity written here).
    const current = await tx.$queryRaw<{ issuer: string }[]>`
      SELECT issuer FROM sso_connections WHERE id = ${ssoConnection.id} FOR SHARE`;
    if (
      current.length === 0 ||
      normalizeIssuer(current[0]!.issuer) !== normalizeIssuer(ssoConnection.issuer)
    ) {
      throw new ConnectionChangedDuringLogin("SSO connection changed during login");
    }

    let loginUser: { id: string; login: string; email: string | null };
    if (!matchedUser) {
      // Only persist the email when it's trustworthy; otherwise we'd let an
      // unverified OIDC claim seed a unique-email row that blocks later sign-ups.
      loginUser = await tx.user.create({
        data: {
          login: newLogin!,
          email: emailIsTrustworthy ? email : undefined,
          name: displayName ?? undefined,
          avatarUrl: picture ?? undefined,
        },
      });
    } else {
      // Refresh profile fields opportunistically, but don't overwrite a name
      // the user has set locally with a blank from the IdP, and never overwrite
      // an email with an unverified claim.
      await tx.user.update({
        where: { id: matchedUser.id },
        data: {
          name: displayName ?? matchedUser.name ?? undefined,
          avatarUrl: picture ?? matchedUser.avatarUrl ?? undefined,
          email: emailIsTrustworthy ? (email ?? undefined) : undefined,
        },
      });
      loginUser = matchedUser;
    }

    // 4. Write the identity row so future logins hit the fast path. A new
    //    identity is created, never upserted: if another login created it
    //    since step 1, the issuer check has to run against that row.
    if (existingIdentity) {
      await tx.userIdentity.update({
        where: { id: existingIdentity.id },
        data: {
          userId: loginUser.id,
          ssoConnectionId: ssoConnection.id,
          email: email ?? undefined,
        },
      });
    } else {
      try {
        await tx.userIdentity.create({
          data: {
            userId: loginUser.id,
            provider: "oidc",
            providerUserId,
            ssoConnectionId: ssoConnection.id,
            email,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new IdentityCreateConflict("OIDC identity created concurrently");
        }
        throw err;
      }
    }

    // 5. Ensure membership in the SSO-owning team (step 2a already refused a
    //    non-member when auto-provisioning is off).
    await tx.teamMember.upsert({
      where: { teamId_userId: { teamId: ssoConnection.teamId, userId: loginUser.id } },
      create: { teamId: ssoConnection.teamId, userId: loginUser.id, role: "HUMAN_MEMBER" },
      update: {},
    });

    return { id: loginUser.id, login: loginUser.login, email: loginUser.email };
  });
}
