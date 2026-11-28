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
import { normalizeIssuer } from "./issuer.js";
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
    // Lock the team's connection row before anything is compared: a second
    // PUT and every login through this connection (FOR SHARE) wait here, so
    // `previous` is the row this transaction replaces.
    const lockedRows = await tx.$queryRaw<{ id: string; issuer: string }[]>`
      SELECT id, issuer FROM sso_connections WHERE "teamId" = ${teamId} FOR UPDATE`;
    const previous = lockedRows[0] ?? null;
    const saved = await tx.ssoConnection.upsert({
      where: { teamId },
      create: {
        teamId,
        displayName: input.displayName,
        issuer: normalizeIssuer(input.issuer),
        clientId: input.clientId,
        clientSecretEnc,
        emailDomains: domains,
        autoProvision: input.autoProvision ?? true,
        enabled: input.enabled ?? true,
      },
      update: {
        displayName: input.displayName,
        issuer: normalizeIssuer(input.issuer),
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
    // the new IdP assert their `sub`. Without a locked previous row there is
    // nothing to compare against: a new connection has no identities, and if
    // a concurrent PUT created the row first, its issuer is unknown here, so
    // the identities bound in between are unbound as well.
    if (!previous || !sameIssuer(previous.issuer, saved.issuer)) {
      const unbound = await tx.userIdentity.updateMany({
        where: { provider: "oidc", ssoConnectionId: saved.id },
        data: { ssoConnectionId: null },
      });
      if (previous || unbound.count > 0) {
        logger.warn(
          { component: "sso", phase: "issuer_change", connectionId: saved.id, unbound: unbound.count },
          "SSO issuer changed: identities of the connection unbound",
        );
      }
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

async function generateUniqueLogin(base: string, client: Prisma.TransactionClient): Promise<string> {
  const candidate = slugifyLogin(base);
  let index = 0;
  while (true) {
    const login = index === 0 ? candidate : `${candidate}-${index}`;
    const existing = await client.user.findUnique({ where: { login } });
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

/**
 * The one issuer comparison of this module: exact string equality after
 * removing trailing slashes. No case folding, no URL parsing, no prefix or
 * host matching. Used for the bound-versus-current check of a login, for the
 * locked re-read of the login's connection and for the unbind on an issuer
 * change.
 */
export function sameIssuer(a: string, b: string): boolean {
  return normalizeIssuer(a) === normalizeIssuer(b);
}

/**
 * Look up (or provision) a user from an OIDC ID token, attach/refresh the
 * UserIdentity row, and ensure they're a HUMAN_MEMBER of the connection's
 * team when auto-provisioning is enabled.
 *
 * `ssoConnection` carries the connection id and the issuer the ID token was
 * verified against. Everything else the decision depends on is read inside
 * one transaction, under row locks, in this order:
 *
 *  1. the login's connection (FOR SHARE): issuer, auto-provisioning, claimed
 *     email domains and team. A changed issuer or a deleted row fails the
 *     login.
 *  2. the connection an existing identity is bound to (FOR SHARE).
 *  3. the identity row (FOR UPDATE), which must still be bound to the
 *     connection locked in step 2; otherwise the attempt is rolled back and
 *     run once more.
 *
 * An issuer change or a delete of either connection (`upsertSsoConnection`
 * locks the row FOR UPDATE first) therefore commits entirely before these
 * reads or entirely after this transaction, and its unbind then sees what
 * this login wrote. Connections are always locked before identities, in the
 * login and in the issuer change, so the two cannot deadlock.
 *
 * Returns `null` when the SSO connection has auto-provisioning disabled
 * and no identity/email match exists, or when the matched user is not
 * already a member of the connection's team: with auto-provisioning off,
 * SSO never adds anyone to the team (no membership row is written at all).
 *
 * Returns an `OidcLoginRefusal` when an identity for this `sub` exists and
 * the connection it is bound to has a different issuer, or is missing (null
 * or deleted). A `sub` is only unique per issuer, so another IdP asserting the
 * same value must not reach that user. Nothing is written in that case.
 *
 * A new identity is inserted, never upserted: a first login that loses that
 * insert rolls back and runs once more against the winner's identity. A loser
 * that derived the same new login name fails on the user insert, not retried.
 */
export async function upsertUserFromOidc(
  ssoConnection: OidcLoginConnection,
  claims: OidcIdTokenClaims,
): Promise<OidcLoginResult> {
  try {
    return await upsertUserFromOidcOnce(ssoConnection, claims);
  } catch (err) {
    if (!(err instanceof IdentityChangedDuringLogin)) throw err;
  }
  return upsertUserFromOidcOnce(ssoConnection, claims);
}

interface OidcLoginConnection {
  id: string;
  /** The issuer the ID token of this login was verified against. */
  issuer: string;
}

type OidcLoginResult = { id: string; login: string; email: string | null } | OidcLoginRefusal | null;

/**
 * The identity row for this sub was created, rebound, unbound or removed by
 * another transaction after this login first read it.
 */
class IdentityChangedDuringLogin extends Error {}

/** The connection changed issuer or was deleted while this login ran. */
class ConnectionChangedDuringLogin extends Error {}

async function upsertUserFromOidcOnce(
  ssoConnection: OidcLoginConnection,
  claims: OidcIdTokenClaims,
): Promise<OidcLoginResult> {
  const providerUserId = claims.sub;
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  const emailVerified = claims.email_verified === true;
  const emailDomain = email?.split("@")[1] ?? null;
  const displayName =
    (typeof claims.name === "string" && claims.name) ||
    (typeof claims.preferred_username === "string" && claims.preferred_username) ||
    null;
  const picture = typeof claims.picture === "string" ? claims.picture : null;

  return prisma.$transaction(async (tx) => {
    // 0. Lock the login's connection and read its current settings.
    const currentRows = await tx.$queryRaw<
      { teamId: string; issuer: string; autoProvision: boolean; emailDomains: string[] }[]
    >`
      SELECT "teamId", issuer, "autoProvision", "emailDomains"
      FROM sso_connections WHERE id = ${ssoConnection.id} FOR SHARE`;
    const current = currentRows[0];
    if (!current || !sameIssuer(current.issuer, ssoConnection.issuer)) {
      throw new ConnectionChangedDuringLogin("SSO connection changed during login");
    }
    // Only trust email-based account linking when the IdP asserts the email is
    // verified AND the email's domain is one the team admin has claimed for this
    // SSO connection. Otherwise an attacker-controlled IdP could claim
    // alice@victim.com and get linked to Alice's existing account.
    const emailDomainClaimed = emailDomain !== null && current.emailDomains.includes(emailDomain);
    const emailIsTrustworthy = emailVerified && emailDomainClaimed;

    // 1. Existing identity for this (provider, sub)? This first read only
    //    tells which connection to lock; the decision uses the locked row.
    const seenIdentity = await tx.userIdentity.findUnique({
      where: { provider_providerUserId: { provider: "oidc", providerUserId } },
      select: { id: true, ssoConnectionId: true },
    });

    let user: {
      id: string;
      login: string;
      email: string | null;
      name: string | null;
      avatarUrl: string | null;
    } | null = null;
    let identityId: string | null = null;

    // 1a. An existing identity is only usable through a connection of the same
    //     issuer. Fail closed when the bound connection is unknown.
    if (seenIdentity) {
      const boundConnectionId = seenIdentity.ssoConnectionId;
      let boundIssuer: string | null = null;
      if (boundConnectionId === ssoConnection.id) {
        boundIssuer = current.issuer;
      } else if (boundConnectionId !== null) {
        const boundRows = await tx.$queryRaw<{ issuer: string }[]>`
          SELECT issuer FROM sso_connections WHERE id = ${boundConnectionId} FOR SHARE`;
        boundIssuer = boundRows[0]?.issuer ?? null;
      }
      const identityRows = await tx.$queryRaw<{ userId: string; ssoConnectionId: string | null }[]>`
        SELECT "userId", "ssoConnectionId" FROM user_identities WHERE id = ${seenIdentity.id} FOR UPDATE`;
      const identity = identityRows[0];
      if (!identity || identity.ssoConnectionId !== boundConnectionId) {
        throw new IdentityChangedDuringLogin("OIDC identity changed during login");
      }
      if (boundIssuer === null || !sameIssuer(boundIssuer, current.issuer)) {
        // The sub is never logged; the identity row id is enough to trace it.
        logger.warn(
          {
            component: "sso",
            phase: "identity_lookup",
            identityId: seenIdentity.id,
            connectionId: ssoConnection.id,
            boundConnectionId,
            cause:
              boundConnectionId === null
                ? "unbound"
                : boundIssuer === null
                  ? "connection_missing"
                  : "issuer_mismatch",
          },
          "SSO login refused: identity is bound to another issuer",
        );
        return { refused: "identity_conflict" };
      }
      user = await tx.user.findUnique({ where: { id: identity.userId } });
      if (!user) {
        throw new IdentityChangedDuringLogin("OIDC identity changed during login");
      }
      identityId = seenIdentity.id;
    }

    // 2. No identity row: try to link by email so manual/GitHub-bootstrapped
    //    users don't get duplicated. We only do this when the IdP asserts
    //    email_verified=true AND the email's domain is explicitly claimed by
    //    this SSO connection. Otherwise this path is an account-takeover
    //    vector.
    if (!user && email && emailIsTrustworthy) {
      user = await tx.user.findUnique({ where: { email } });
    }

    // 2a. Without auto-provisioning, SSO only signs in users who are already
    //     members of the connection's team; it never adds one.
    if (user && !current.autoProvision) {
      const membership = await tx.teamMember.findUnique({
        where: { teamId_userId: { teamId: current.teamId, userId: user.id } },
        select: { id: true },
      });
      if (!membership) {
        return null;
      }
    }

    // 3. Still nothing: provision, if policy allows.
    if (!user && !current.autoProvision) {
      return null;
    }

    let loginUser: { id: string; login: string; email: string | null };
    if (!user) {
      const loginBase = email ? (email.split("@")[0] ?? email) : providerUserId;
      // Only persist the email when it's trustworthy; otherwise we'd let an
      // unverified OIDC claim seed a unique-email row that blocks later sign-ups.
      loginUser = await tx.user.create({
        data: {
          login: await generateUniqueLogin(loginBase, tx),
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
        where: { id: user.id },
        data: {
          name: displayName ?? user.name ?? undefined,
          avatarUrl: picture ?? user.avatarUrl ?? undefined,
          email: emailIsTrustworthy ? (email ?? undefined) : undefined,
        },
      });
      loginUser = user;
    }

    // 4. Write the identity row so future logins hit the fast path. The
    //    existing row is locked since step 1a. A new identity is created,
    //    never upserted: if another login created it since step 1, the issuer
    //    check has to run against that row.
    if (identityId !== null) {
      await tx.userIdentity.update({
        where: { id: identityId },
        data: {
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
          throw new IdentityChangedDuringLogin("OIDC identity created concurrently");
        }
        throw err;
      }
    }

    // 5. With auto-provisioning on, ensure membership in the SSO-owning team.
    //    With it off, step 2a found the membership and nothing is written: a
    //    member removed while this login ran is not added back.
    if (current.autoProvision) {
      await tx.teamMember.upsert({
        where: { teamId_userId: { teamId: current.teamId, userId: loginUser.id } },
        create: { teamId: current.teamId, userId: loginUser.id, role: "HUMAN_MEMBER" },
        update: {},
      });
    }

    return { id: loginUser.id, login: loginUser.login, email: loginUser.email };
  });
}
