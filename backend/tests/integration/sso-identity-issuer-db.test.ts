/**
 * OIDC identity binding against a real Postgres: the takeover chains the unit
 * suite can only describe with mocks run here through the real services, the
 * real unique key on (provider, providerUserId) and the row lock on the
 * connection.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { groundingPostgres } from "../helpers/grounding-postgres.js";

const shared = vi.hoisted(() => ({ db: undefined as PrismaClient | undefined }));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, key) => {
        const v = Reflect.get(shared.db!, key);
        return typeof v === "function" ? v.bind(shared.db) : v;
      },
    },
  ),
}));
vi.mock("../../src/config/index.js", async (orig) => {
  const actual = await orig<typeof import("../../src/config/index.js")>();
  return { config: { ...actual.config, SSO_ENCRYPTION_KEY: "11".repeat(32) } };
});

import {
  getSsoConnectionByTeamId,
  upsertSsoConnection,
  upsertUserFromOidc,
} from "../../src/services/sso.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
let db: PrismaClient;
beforeAll(async () => {
  store = await groundingPostgres();
  db = store.db;
  shared.db = db;
}, 60000);
afterAll(async () => {
  if (store) await store.close();
});

const U = () => randomUUID().slice(0, 8);

async function connection(issuer: string, autoProvision = true) {
  const id = U();
  const team = await db.team.create({ data: { name: `t-${id}`, slug: `t-${id}` } });
  await upsertSsoConnection(team.id, {
    displayName: "x",
    issuer,
    clientId: "c",
    clientSecret: "s",
    emailDomains: [],
    autoProvision,
  });
  return (await getSsoConnectionByTeamId(team.id))!;
}

function claims(sub: string, iss: string, email?: string) {
  return { iss, sub, aud: "c", exp: 0, iat: 0, ...(email ? { email } : {}) };
}

function userId(result: unknown): string | null {
  return result && typeof result === "object" && "id" in result ? (result as { id: string }).id : null;
}

describe("OIDC identity bound to its issuer (real Postgres)", () => {
  it("same-issuer rebind followed by an issuer change does not reach the victim", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const evil = `https://evil-${U()}.example.net`;
    const a = await connection(shared);
    let b = await connection(shared);
    const sub = `victim-${U()}`;

    const victim = userId(await upsertUserFromOidc(a, claims(sub, shared)));
    expect(victim).not.toBeNull();
    // Same issuer through B: allowed, the identity is rebound to B.
    expect(userId(await upsertUserFromOidc(b, claims(sub, shared)))).toBe(victim);

    // B's admin moves B to their own IdP; the connection id stays the same.
    const bId = b.id;
    await upsertSsoConnection(b.teamId, {
      displayName: "x",
      issuer: evil,
      clientId: "c",
      clientSecret: "s",
      emailDomains: [],
    });
    b = (await getSsoConnectionByTeamId(b.teamId))!;
    expect(b.id).toBe(bId);

    const identity = await db.userIdentity.findUnique({
      where: { provider_providerUserId: { provider: "oidc", providerUserId: sub } },
    });
    expect(identity?.ssoConnectionId).toBeNull();

    const attacker = await upsertUserFromOidc(b, claims(sub, evil));
    expect(attacker).toEqual({ refused: "identity_conflict" });
    // The legitimate issuer is refused too until an operator rebinds the row.
    expect(await upsertUserFromOidc(a, claims(sub, shared))).toEqual({ refused: "identity_conflict" });
    const memberships = await db.teamMember.findMany({ where: { userId: victim! } });
    expect(memberships.map((m) => m.teamId).sort()).toEqual([a.teamId, b.teamId].sort());
  });

  it("a stale connection object from before an issuer change fails at the locked re-read", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const stale = await connection(shared);
    await upsertSsoConnection(stale.teamId, {
      displayName: "x",
      issuer: `https://evil-${U()}.example.net`,
      clientId: "c",
      clientSecret: "s",
      emailDomains: [],
    });
    const sub = `stale-${U()}`;

    await expect(upsertUserFromOidc(stale, claims(sub, shared))).rejects.toThrow(
      /connection changed during login/,
    );
    expect(
      await db.userIdentity.findUnique({
        where: { provider_providerUserId: { provider: "oidc", providerUserId: sub } },
      }),
    ).toBeNull();
  });

  it("auto-provisioning off: an outsider with a same-issuer identity is not added to the team", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const open = await connection(shared, true);
    const closed = await connection(shared, false);
    const sub = `outsider-${U()}`;

    const outsider = userId(await upsertUserFromOidc(open, claims(sub, shared)));
    expect(await upsertUserFromOidc(closed, claims(sub, shared))).toBeNull();
    expect(
      await db.teamMember.findUnique({
        where: { teamId_userId: { teamId: closed.teamId, userId: outsider! } },
      }),
    ).toBeNull();
    const identity = await db.userIdentity.findUnique({
      where: { provider_providerUserId: { provider: "oidc", providerUserId: sub } },
    });
    expect(identity?.ssoConnectionId).toBe(open.id);

    // Once a member, the same login passes.
    await db.teamMember.create({ data: { teamId: closed.teamId, userId: outsider!, role: "HUMAN_MEMBER" } });
    expect(userId(await upsertUserFromOidc(closed, claims(sub, shared)))).toBe(outsider);
  });

  it("concurrent first logins for one new sub from two issuers never share a user", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const evil = `https://evil-${U()}.example.net`;
    const a = await connection(shared);
    const c = await connection(evil);
    for (let i = 0; i < 10; i++) {
      const sub = `race-${U()}`;
      // Distinct emails give distinct logins, so only the identity insert races.
      const results = await Promise.allSettled([
        upsertUserFromOidc(a, claims(sub, shared, `victim-${sub}@a.example`)),
        upsertUserFromOidc(c, claims(sub, evil, `attacker-${sub}@c.example`)),
      ]);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected, JSON.stringify(rejected.map((r) => String((r as PromiseRejectedResult).reason)))).toEqual([]);
      const users = results
        .map((r) => (r.status === "fulfilled" ? userId(r.value) : null))
        .filter((v): v is string => v !== null);
      expect(users).toHaveLength(1);
      const refused = results.filter(
        (r) => r.status === "fulfilled" && JSON.stringify(r.value) === '{"refused":"identity_conflict"}',
      );
      expect(refused).toHaveLength(1);
      const identity = await db.userIdentity.findUnique({
        where: { provider_providerUserId: { provider: "oidc", providerUserId: sub } },
      });
      expect(identity?.userId).toBe(users[0]);
      // The loser's provisional user was rolled back with its transaction.
      expect(await db.userIdentity.count({ where: { providerUserId: sub } })).toBe(1);
      expect(await db.user.count({ where: { identities: { some: { providerUserId: sub } } } })).toBe(1);
    }
  });
});
