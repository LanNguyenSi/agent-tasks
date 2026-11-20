/**
 * upsertUserFromOidc binds an existing (oidc, sub) identity to the issuer of
 * the connection that minted it. A `sub` is only unique per issuer, so a login
 * through a connection with another issuer must not reach that user, and an
 * identity whose connection is unknown (null or deleted) fails closed.
 * Without auto-provisioning, SSO only signs in existing team members.
 * upsertSsoConnection unbinds a connection's identities when its issuer
 * changes.
 *
 * Prisma and the logger are mocked. The mock is a small table store: every
 * read the service makes (the locked raw reads included) is answered from
 * `db`, and every write is a spy, so a refusal is checked to write nothing.
 * The locks themselves and the interleavings are covered against a real
 * Postgres in tests/integration/sso-identity-issuer-db.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

interface ConnectionRow {
  teamId: string;
  issuer: string;
  autoProvision: boolean;
  emailDomains: string[];
}
interface IdentityRow {
  id: string;
  userId: string;
  ssoConnectionId: string | null;
}
interface UserRow {
  id: string;
  login: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

const mocks = vi.hoisted(() => ({
  identityFindUnique: vi.fn(),
  identityCreate: vi.fn(),
  identityUpdate: vi.fn(),
  identityUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  connectionFindMany: vi.fn(),
  connectionUpsert: vi.fn(),
  teamMemberFindUnique: vi.fn(),
  teamMemberUpsert: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  warn: vi.fn(),
}));

/** What the mocked database holds; reset before each test. */
const db = {
  connections: {} as Record<string, ConnectionRow>,
  /** What the first, unlocked read of the identity returns. */
  identity: null as IdentityRow | null,
  /** What the locked re-read returns; `undefined` means the same row. */
  lockedIdentity: undefined as IdentityRow | null | undefined,
  users: [] as UserRow[],
  /** `${teamId}:${userId}` of existing memberships. */
  members: new Set<string>(),
};

vi.mock("../../src/lib/prisma.js", () => {
  const client = {
    userIdentity: {
      findUnique: mocks.identityFindUnique,
      create: mocks.identityCreate,
      update: mocks.identityUpdate,
      updateMany: mocks.identityUpdateMany,
    },
    user: {
      findUnique: mocks.userFindUnique,
      create: mocks.userCreate,
      update: mocks.userUpdate,
    },
    ssoConnection: {
      findMany: mocks.connectionFindMany,
      upsert: mocks.connectionUpsert,
    },
    teamMember: { findUnique: mocks.teamMemberFindUnique, upsert: mocks.teamMemberUpsert },
    $queryRaw: mocks.queryRaw,
    $transaction: mocks.transaction,
  };
  return { prisma: client };
});

vi.mock("../../src/config/index.js", () => ({
  config: { SSO_ENCRYPTION_KEY: "key" },
}));

vi.mock("../../src/services/sso-crypto.js", () => ({
  encryptSecret: vi.fn(async () => "enc"),
  decryptSecret: vi.fn(async () => "plain"),
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: { warn: mocks.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { prisma as mockedPrisma } from "../../src/lib/prisma.js";
import { sameIssuer, upsertSsoConnection, upsertUserFromOidc } from "../../src/services/sso.js";

const SUB = "sub-shared-4711";
const ISSUER = "https://idp.example.com";

/** What the callback passes: the connection id and the verified issuer. */
const LOGIN = { id: "conn-current", issuer: ISSUER };
const TEAM = "team-current";

const CLAIMS = {
  iss: ISSUER,
  sub: SUB,
  aud: "client",
  exp: 0,
  iat: 0,
  email: "alice@example.com",
  email_verified: true,
  name: "Alice",
};

const VICTIM: UserRow = {
  id: "user-victim",
  login: "alice",
  email: "alice@example.com",
  name: "Alice",
  avatarUrl: null,
};

function identityBoundTo(ssoConnectionId: string | null): IdentityRow {
  return { id: "identity-1", userId: VICTIM.id, ssoConnectionId };
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.22.0",
  });
}

/** The SQL of every raw read so far, parameters replaced by `?`. */
function rawQueries(): string[] {
  return mocks.queryRaw.mock.calls.map(([strings]) =>
    (strings as string[]).join("?").replace(/\s+/g, " ").trim(),
  );
}

function expectNothingWritten() {
  expect(mocks.userUpdate).not.toHaveBeenCalled();
  expect(mocks.userCreate).not.toHaveBeenCalled();
  expect(mocks.identityCreate).not.toHaveBeenCalled();
  expect(mocks.identityUpdate).not.toHaveBeenCalled();
  expect(mocks.identityUpdateMany).not.toHaveBeenCalled();
  expect(mocks.teamMemberUpsert).not.toHaveBeenCalled();
}

function expectLoggedWithoutSub(cause: string) {
  expect(mocks.warn).toHaveBeenCalledTimes(1);
  const [fields, message] = mocks.warn.mock.calls[0]!;
  expect(fields).toMatchObject({ component: "sso", identityId: "identity-1", cause });
  expect(JSON.stringify([fields, message])).not.toContain(SUB);
}

function expectRebound() {
  expect(mocks.identityUpdate).toHaveBeenCalledTimes(1);
  expect(mocks.identityUpdate.mock.calls[0]![0]).toMatchObject({
    where: { id: "identity-1" },
    data: { ssoConnectionId: LOGIN.id },
  });
  expect(mocks.identityCreate).not.toHaveBeenCalled();
}

function expectJoinedAsHumanMember(userId: string) {
  expect(mocks.teamMemberUpsert).toHaveBeenCalledTimes(1);
  expect(mocks.teamMemberUpsert.mock.calls[0]![0]).toEqual({
    where: { teamId_userId: { teamId: TEAM, userId } },
    create: { teamId: TEAM, userId, role: "HUMAN_MEMBER" },
    update: {},
  });
}

function expectLoginCompleted(result: unknown) {
  expect(result).toEqual({ id: VICTIM.id, login: VICTIM.login, email: VICTIM.email });
  expectRebound();
  expectJoinedAsHumanMember(VICTIM.id);
  expect(mocks.warn).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  db.connections = {
    [LOGIN.id]: { teamId: TEAM, issuer: ISSUER, autoProvision: true, emailDomains: ["example.com"] },
  };
  db.identity = null;
  db.lockedIdentity = undefined;
  db.users = [VICTIM];
  db.members = new Set();

  mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockedPrisma));
  mocks.queryRaw.mockImplementation(async (strings: string[], param: string) => {
    const sql = strings.join("?").replace(/\s+/g, " ");
    if (/FROM sso_connections WHERE id = \? FOR SHARE/.test(sql)) {
      const row = db.connections[param];
      return row ? [{ ...row }] : [];
    }
    if (/FROM user_identities WHERE id = \? FOR UPDATE/.test(sql)) {
      const row = db.lockedIdentity === undefined ? db.identity : db.lockedIdentity;
      return row && row.id === param ? [{ userId: row.userId, ssoConnectionId: row.ssoConnectionId }] : [];
    }
    if (/FROM sso_connections WHERE "teamId" = \? FOR UPDATE/.test(sql)) {
      return Object.entries(db.connections)
        .filter(([, row]) => row.teamId === param)
        .map(([id, row]) => ({ id, issuer: row.issuer }));
    }
    throw new Error(`unexpected raw query: ${sql}`);
  });
  mocks.identityFindUnique.mockImplementation(async () =>
    db.identity ? { id: db.identity.id, ssoConnectionId: db.identity.ssoConnectionId } : null,
  );
  mocks.userFindUnique.mockImplementation(
    async ({ where }: { where: { id?: string; email?: string; login?: string } }) =>
      db.users.find((u) =>
        where.id !== undefined
          ? u.id === where.id
          : where.email !== undefined
            ? u.email === where.email
            : u.login === where.login,
      ) ?? null,
  );
  mocks.teamMemberFindUnique.mockImplementation(
    async ({ where }: { where: { teamId_userId: { teamId: string; userId: string } } }) =>
      db.members.has(`${where.teamId_userId.teamId}:${where.teamId_userId.userId}`)
        ? { id: "membership-1" }
        : null,
  );
  mocks.userCreate.mockImplementation(async ({ data }: { data: { login: string; email?: string } }) => ({
    id: "user-new",
    login: data.login,
    email: data.email ?? null,
  }));
  mocks.identityCreate.mockResolvedValue({});
  mocks.identityUpdate.mockResolvedValue({});
  mocks.identityUpdateMany.mockResolvedValue({ count: 0 });
  mocks.userUpdate.mockResolvedValue({});
  mocks.teamMemberUpsert.mockResolvedValue({});
  mocks.connectionFindMany.mockResolvedValue([]);
});

// Each pair is a different issuer in both argument orders: a prefix, suffix
// or host relation is never the same issuer.
const DIFFERENT_ISSUERS: [string, string, string][] = [
  ["host case", "https://IDP.example.com", "https://idp.example.com"],
  ["host suffix", "https://idp.example.com.evil.net", "https://idp.example.com"],
  ["host prefix label", "https://evil-idp.example.com", "https://idp.example.com"],
  ["same host, other path", "https://idp.example.com/realms/a", "https://idp.example.com/realms/b"],
  ["path suffix", "https://idp.example.com/tenant", "https://idp.example.com"],
  ["path suffix on a path", "https://idp.example.com/t/abc", "https://idp.example.com/t/ab"],
  ["scheme", "http://idp.example.com", "https://idp.example.com"],
  ["explicit port", "https://idp.example.com:443", "https://idp.example.com"],
  ["other port", "https://idp.example.com:8443", "https://idp.example.com:9443"],
  ["double slash", "https://idp.example.com//x", "https://idp.example.com/x"],
  ["leading slash kept", "/https://idp.example.com", "https://idp.example.com"],
  ["same length", "https://idp.example.org", "https://idp.example.com"],
];

const SAME_ISSUERS: [string, string, string][] = [
  ["identical", "https://idp.example.com", "https://idp.example.com"],
  ["identical with a path", "https://idp.example.com/realms/a", "https://idp.example.com/realms/a"],
  ["slash on the first", "https://idp.example.com/", "https://idp.example.com"],
  ["slash on the second", "https://idp.example.com", "https://idp.example.com/"],
  ["several trailing slashes", "https://idp.example.com//", "https://idp.example.com"],
  ["slashes on both", "https://idp.example.com/a/", "https://idp.example.com/a//"],
];

describe("sameIssuer: the one issuer comparison", () => {
  it.each(DIFFERENT_ISSUERS)("different: %s", (_label, a, b) => {
    expect(sameIssuer(a, b)).toBe(false);
    expect(sameIssuer(b, a)).toBe(false);
  });

  it.each(SAME_ISSUERS)("same: %s", (_label, a, b) => {
    expect(sameIssuer(a, b)).toBe(true);
    expect(sameIssuer(b, a)).toBe(true);
  });
});

describe("upsertUserFromOidc: existing identity bound to its issuer", () => {
  it("refuses an identity bound to a connection with a different issuer and writes nothing", async () => {
    db.identity = identityBoundTo("conn-other");
    db.connections["conn-other"] = {
      teamId: "team-other",
      issuer: "https://other-idp.example.net",
      autoProvision: true,
      emailDomains: [],
    };

    const result = await upsertUserFromOidc(LOGIN, CLAIMS);

    expect(result).toEqual({ refused: "identity_conflict" });
    expectNothingWritten();
    // Neither the user of the identity nor the email-link user is looked up:
    // the refusal comes first.
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.teamMemberFindUnique).not.toHaveBeenCalled();
    expectLoggedWithoutSub("issuer_mismatch");
    expect(mocks.warn.mock.calls[0]![0]).toMatchObject({
      connectionId: LOGIN.id,
      boundConnectionId: "conn-other",
    });
  });

  // The bound-versus-current check runs the whole matrix through the service,
  // in both directions.
  it.each(DIFFERENT_ISSUERS)("refuses %s, bound and current swapped too", async (_label, a, b) => {
    for (const [bound, current] of [
      [a, b],
      [b, a],
    ] as const) {
      vi.clearAllMocks();
      db.identity = identityBoundTo("conn-other");
      db.connections["conn-other"] = { teamId: "team-other", issuer: bound, autoProvision: true, emailDomains: [] };
      db.connections[LOGIN.id]!.issuer = current;

      const result = await upsertUserFromOidc({ ...LOGIN, issuer: current }, CLAIMS);

      expect(result, `bound ${bound}, current ${current}`).toEqual({ refused: "identity_conflict" });
      expectNothingWritten();
    }
  });

  it("allows the same issuer through another team's connection (rebinds and joins as today)", async () => {
    db.identity = identityBoundTo("conn-other");
    db.connections["conn-other"] = { teamId: "team-other", issuer: ISSUER, autoProvision: true, emailDomains: [] };

    const result = await upsertUserFromOidc(LOGIN, CLAIMS);

    expectLoginCompleted(result);
    expect(mocks.userUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.userUpdate.mock.calls[0]![0].where).toEqual({ id: VICTIM.id });
  });

  it.each(SAME_ISSUERS)("treats a trailing slash as the same issuer: %s", async (_label, bound, current) => {
    db.identity = identityBoundTo("conn-other");
    db.connections["conn-other"] = { teamId: "team-other", issuer: bound, autoProvision: true, emailDomains: [] };
    db.connections[LOGIN.id]!.issuer = current;

    const result = await upsertUserFromOidc({ ...LOGIN, issuer: current }, CLAIMS);

    expectLoginCompleted(result);
  });

  it("allows the connection that minted the identity without locking a second connection", async () => {
    db.identity = identityBoundTo(LOGIN.id);

    const result = await upsertUserFromOidc(LOGIN, CLAIMS);

    expectLoginCompleted(result);
    expect(rawQueries().filter((q) => /FROM sso_connections/.test(q))).toHaveLength(1);
  });

  it("refuses an identity without a bound connection (fail closed)", async () => {
    db.identity = identityBoundTo(null);

    const result = await upsertUserFromOidc(LOGIN, CLAIMS);

    expect(result).toEqual({ refused: "identity_conflict" });
    expect(rawQueries().filter((q) => /FROM sso_connections/.test(q))).toHaveLength(1);
    expectNothingWritten();
    expectLoggedWithoutSub("unbound");
  });

  it("refuses an identity whose bound connection was deleted (fail closed)", async () => {
    db.identity = identityBoundTo("conn-deleted");

    const result = await upsertUserFromOidc(LOGIN, CLAIMS);

    expect(result).toEqual({ refused: "identity_conflict" });
    expectNothingWritten();
    expectLoggedWithoutSub("connection_missing");
  });

  it("a refusal is not the not-provisioned null, even with auto-provisioning off", async () => {
    db.identity = identityBoundTo("conn-other");
    db.connections["conn-other"] = {
      teamId: "team-other",
      issuer: "https://other-idp.example.net",
      autoProvision: true,
      emailDomains: [],
    };
    db.connections[LOGIN.id]!.autoProvision = false;

    const result = await upsertUserFromOidc(LOGIN, CLAIMS);

    expect(result).toEqual({ refused: "identity_conflict" });
    expectNothingWritten();
  });
});

describe("upsertUserFromOidc: every input is read under a lock inside the transaction", () => {
  it("locks the login's connection, then the bound connection, then the identity", async () => {
    db.identity = identityBoundTo("conn-other");
    db.connections["conn-other"] = { teamId: "team-other", issuer: ISSUER, autoProvision: true, emailDomains: [] };

    await upsertUserFromOidc(LOGIN, CLAIMS);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(rawQueries()).toEqual([
      'SELECT "teamId", issuer, "autoProvision", "emailDomains" FROM sso_connections WHERE id = ? FOR SHARE',
      "SELECT issuer FROM sso_connections WHERE id = ? FOR SHARE",
      'SELECT "userId", "ssoConnectionId" FROM user_identities WHERE id = ? FOR UPDATE',
    ]);
    expect(mocks.queryRaw.mock.calls.map((c) => c[1])).toEqual([LOGIN.id, "conn-other", "identity-1"]);
    // The connection locks come before the first write and before the
    // identity lock, the order an issuer change uses as well.
    const firstWrite = Math.min(
      mocks.userUpdate.mock.invocationCallOrder[0]!,
      mocks.identityUpdate.mock.invocationCallOrder[0]!,
    );
    expect(Math.max(...mocks.queryRaw.mock.invocationCallOrder)).toBeLessThan(firstWrite);
  });

  it("fails when the connection's issuer changed since the callback verified the token", async () => {
    db.identity = identityBoundTo(LOGIN.id);
    db.connections[LOGIN.id]!.issuer = "https://evil-idp.example.net";

    await expect(upsertUserFromOidc(LOGIN, CLAIMS)).rejects.toThrow(/connection changed during login/);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.identityFindUnique).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it.each(DIFFERENT_ISSUERS)("the locked re-read fails for %s, both directions", async (_label, a, b) => {
    for (const [stored, verified] of [
      [a, b],
      [b, a],
    ] as const) {
      vi.clearAllMocks();
      db.connections[LOGIN.id]!.issuer = stored;

      await expect(
        upsertUserFromOidc({ ...LOGIN, issuer: verified }, CLAIMS),
        `stored ${stored}, verified ${verified}`,
      ).rejects.toThrow(/connection changed during login/);
      expectNothingWritten();
    }
  });

  it.each(SAME_ISSUERS)("the locked re-read accepts %s", async (_label, stored, verified) => {
    db.identity = identityBoundTo(LOGIN.id);
    db.connections[LOGIN.id]!.issuer = stored;

    const result = await upsertUserFromOidc({ ...LOGIN, issuer: verified }, CLAIMS);

    expectLoginCompleted(result);
  });

  it("fails when the connection was deleted since the callback read it", async () => {
    db.identity = identityBoundTo(LOGIN.id);
    delete db.connections[LOGIN.id];

    await expect(upsertUserFromOidc(LOGIN, CLAIMS)).rejects.toThrow(/connection changed during login/);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expectNothingWritten();
  });

  it("an identity unbound between the first read and the lock: one more pass, then refused", async () => {
    // First pass: the row was bound to conn-other when first read, and that
    // connection now has the login's issuer (its issuer change unbound the row).
    db.identity = identityBoundTo("conn-other");
    db.lockedIdentity = identityBoundTo(null);
    db.connections["conn-other"] = { teamId: "team-other", issuer: ISSUER, autoProvision: true, emailDomains: [] };
    mocks.identityFindUnique
      .mockResolvedValueOnce({ id: "identity-1", ssoConnectionId: "conn-other" })
      .mockResolvedValueOnce({ id: "identity-1", ssoConnectionId: null });

    const result = await upsertUserFromOidc(LOGIN, CLAIMS);

    expect(result).toEqual({ refused: "identity_conflict" });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expectNothingWritten();
    expectLoggedWithoutSub("unbound");
  });

  it("an identity rebound to another connection between the first read and the lock is not used as read", async () => {
    db.identity = identityBoundTo("conn-other");
    db.lockedIdentity = identityBoundTo("conn-third");
    db.connections["conn-other"] = { teamId: "team-other", issuer: ISSUER, autoProvision: true, emailDomains: [] };

    await expect(upsertUserFromOidc(LOGIN, CLAIMS)).rejects.toThrow(/identity changed during login/);
    // Two passes, no third.
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expectNothingWritten();
  });

  it("an identity bound in the meantime (null when first read) is not treated as unbound", async () => {
    db.identity = identityBoundTo(null);
    db.lockedIdentity = identityBoundTo(LOGIN.id);

    await expect(upsertUserFromOidc(LOGIN, CLAIMS)).rejects.toThrow(/identity changed during login/);
    expectNothingWritten();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("an identity deleted between the first read and the lock: one more pass", async () => {
    db.identity = identityBoundTo(LOGIN.id);
    db.lockedIdentity = null;

    await expect(upsertUserFromOidc(LOGIN, CLAIMS)).rejects.toThrow(/identity changed during login/);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expectNothingWritten();
  });

  it("an identity whose user is gone is not signed in", async () => {
    db.identity = identityBoundTo(LOGIN.id);
    db.users = [];

    await expect(upsertUserFromOidc(LOGIN, CLAIMS)).rejects.toThrow(/identity changed during login/);
    expectNothingWritten();
  });

  it("another error is not retried", async () => {
    db.identity = identityBoundTo(LOGIN.id);
    mocks.userUpdate.mockRejectedValue(new Error("db down"));

    await expect(upsertUserFromOidc(LOGIN, CLAIMS)).rejects.toThrow(/db down/);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("signs in the user of the locked identity row", async () => {
    const other: UserRow = { id: "user-other", login: "bob", email: null, name: null, avatarUrl: null };
    db.users = [VICTIM, other];
    db.identity = identityBoundTo(LOGIN.id);
    db.lockedIdentity = { ...identityBoundTo(LOGIN.id), userId: other.id };

    const result = await upsertUserFromOidc(LOGIN, { ...CLAIMS, email: undefined });

    expect(result).toEqual({ id: other.id, login: "bob", email: null });
    expect(mocks.userUpdate.mock.calls[0]![0].where).toEqual({ id: other.id });
    expectJoinedAsHumanMember(other.id);
  });
});

describe("upsertUserFromOidc: auto-provisioning off never adds a team member", () => {
  beforeEach(() => {
    db.connections[LOGIN.id]!.autoProvision = false;
  });

  it("refuses an outsider whose identity has the same issuer: null, no membership, no rebind", async () => {
    db.identity = identityBoundTo("conn-other");
    db.connections["conn-other"] = { teamId: "team-other", issuer: ISSUER, autoProvision: true, emailDomains: [] };
    // A member of another team only.
    db.members.add(`team-other:${VICTIM.id}`);

    const result = await upsertUserFromOidc(LOGIN, CLAIMS);

    expect(result).toBeNull();
    expect(mocks.teamMemberFindUnique).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: TEAM, userId: VICTIM.id } },
      select: { id: true },
    });
    expectNothingWritten();
  });

  it("refuses an outsider matched by verified, claimed email", async () => {
    const result = await upsertUserFromOidc(LOGIN, CLAIMS);

    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { email: "alice@example.com" } });
    expect(result).toBeNull();
    expectNothingWritten();
  });

  it("signs in an existing member of the team and writes no membership", async () => {
    db.identity = identityBoundTo("conn-other");
    db.connections["conn-other"] = { teamId: "team-other", issuer: ISSUER, autoProvision: true, emailDomains: [] };
    db.members.add(`${TEAM}:${VICTIM.id}`);

    const result = await upsertUserFromOidc(LOGIN, CLAIMS);

    expect(result).toEqual({ id: VICTIM.id, login: VICTIM.login, email: VICTIM.email });
    expectRebound();
    expect(mocks.teamMemberUpsert).not.toHaveBeenCalled();
  });

  it("returns null when nothing matches, and creates no user", async () => {
    const result = await upsertUserFromOidc(LOGIN, { ...CLAIMS, email_verified: false });

    expect(result).toBeNull();
    expectNothingWritten();
  });
});

describe("upsertUserFromOidc: auto-provisioning comes from the locked connection row", () => {
  it("on: an outsider joins as HUMAN_MEMBER without a membership lookup", async () => {
    db.identity = identityBoundTo("conn-other");
    db.connections["conn-other"] = { teamId: "team-other", issuer: ISSUER, autoProvision: false, emailDomains: [] };

    const result = await upsertUserFromOidc(LOGIN, CLAIMS);

    expectLoginCompleted(result);
    expect(mocks.teamMemberFindUnique).not.toHaveBeenCalled();
  });

  it("the caller cannot switch it on: extra fields of the argument are ignored", async () => {
    db.connections[LOGIN.id]!.autoProvision = false;

    const result = await upsertUserFromOidc(
      { ...LOGIN, autoProvision: true, teamId: "team-forged", emailDomains: ["example.com"] } as typeof LOGIN,
      { ...CLAIMS, email: "nobody@example.com" },
    );

    expect(result).toBeNull();
    expectNothingWritten();
  });
});

describe("upsertUserFromOidc: first-login race for a new sub", () => {
  it("on a unique violation, runs again and applies the issuer check to the winner's identity", async () => {
    db.connections["conn-attacker"] = {
      teamId: "team-attacker",
      issuer: "https://evil-idp.example.net",
      autoProvision: true,
      emailDomains: [],
    };
    mocks.identityCreate.mockImplementationOnce(async () => {
      db.identity = identityBoundTo("conn-attacker");
      throw uniqueViolation();
    });

    const result = await upsertUserFromOidc(LOGIN, { ...CLAIMS, email: "bob@example.com" });

    expect(result).toEqual({ refused: "identity_conflict" });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.identityCreate).toHaveBeenCalledTimes(1);
    expect(mocks.identityUpdate).not.toHaveBeenCalled();
    // The join of the first pass is never reached: the insert comes first.
    expect(mocks.teamMemberUpsert).not.toHaveBeenCalled();
  });

  it("on a unique violation with the same issuer, signs in the winner's user", async () => {
    db.connections["conn-other"] = { teamId: "team-other", issuer: ISSUER, autoProvision: true, emailDomains: [] };
    mocks.identityCreate.mockImplementationOnce(async () => {
      db.identity = identityBoundTo("conn-other");
      throw uniqueViolation();
    });

    const result = await upsertUserFromOidc(LOGIN, { ...CLAIMS, email: "bob@example.com" });

    expect(result).toEqual({ id: VICTIM.id, login: VICTIM.login, email: VICTIM.email });
    expect(mocks.identityCreate).toHaveBeenCalledTimes(1);
    expect(mocks.identityUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.identityUpdate.mock.calls[0]![0]).toMatchObject({
      where: { id: "identity-1" },
      data: { ssoConnectionId: LOGIN.id },
    });
  });

  it("a second unique violation is not retried again", async () => {
    mocks.identityCreate.mockRejectedValue(uniqueViolation());

    await expect(upsertUserFromOidc(LOGIN, { ...CLAIMS, email: "bob@example.com" })).rejects.toThrow(
      /identity created concurrently/,
    );
    expect(mocks.identityCreate).toHaveBeenCalledTimes(2);
  });

  it("another database error is not treated as the race", async () => {
    mocks.identityCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "5.22.0" }),
    );

    await expect(upsertUserFromOidc(LOGIN, { ...CLAIMS, email: "bob@example.com" })).rejects.toThrow(/fk/);
    expect(mocks.identityCreate).toHaveBeenCalledTimes(1);
  });

  it("a unique violation that is not a Prisma error is not treated as the race", async () => {
    mocks.identityCreate.mockRejectedValue(Object.assign(new Error("plain"), { code: "P2002" }));

    await expect(upsertUserFromOidc(LOGIN, { ...CLAIMS, email: "bob@example.com" })).rejects.toThrow(/plain/);
    expect(mocks.identityCreate).toHaveBeenCalledTimes(1);
  });
});

describe("upsertUserFromOidc: no identity for the sub", () => {
  it("provisions a new user bound to the current connection, joined as HUMAN_MEMBER", async () => {
    const result = await upsertUserFromOidc(LOGIN, { ...CLAIMS, email: "bob@example.com" });

    expect(result).toEqual({ id: "user-new", login: "bob", email: "bob@example.com" });
    expect(rawQueries()).toHaveLength(1);
    expect(mocks.userCreate).toHaveBeenCalledTimes(1);
    expect(mocks.userCreate.mock.calls[0]![0].data).toMatchObject({ login: "bob", email: "bob@example.com" });
    expect(mocks.identityCreate.mock.calls[0]![0].data).toEqual({
      userId: "user-new",
      provider: "oidc",
      providerUserId: SUB,
      ssoConnectionId: LOGIN.id,
      email: "bob@example.com",
    });
    expect(mocks.identityUpdate).not.toHaveBeenCalled();
    expectJoinedAsHumanMember("user-new");
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("picks the next free login inside the transaction", async () => {
    // alice is taken by the victim, whose email differs from the claim.
    const result = await upsertUserFromOidc(LOGIN, { ...CLAIMS, email: "alice@other.example" });

    expect(result).toEqual({ id: "user-new", login: "alice-1", email: null });
  });

  it("still links by verified, claimed email when no identity exists", async () => {
    const result = await upsertUserFromOidc(LOGIN, CLAIMS);

    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { email: "alice@example.com" } });
    expect(result).toEqual({ id: VICTIM.id, login: VICTIM.login, email: VICTIM.email });
    expect(mocks.identityCreate.mock.calls[0]![0].data).toMatchObject({ userId: VICTIM.id });
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expectJoinedAsHumanMember(VICTIM.id);
  });

  // The email-link guard: each input alone must not link to the existing user.
  it.each([
    ["unverified email on a claimed domain", { email_verified: false }, ["example.com"]],
    ["email_verified missing", { email_verified: undefined }, ["example.com"]],
    ["email_verified as a string", { email_verified: "true" }, ["example.com"]],
    ["verified email on an unclaimed domain", { email_verified: true }, ["other.example"]],
    ["verified email, no domain claimed", { email_verified: true }, []],
    ["unverified email on an unclaimed domain", { email_verified: false }, []],
  ])("does not link to an existing user: %s", async (_label, claimPatch, domains) => {
    db.connections[LOGIN.id]!.emailDomains = domains;

    const result = await upsertUserFromOidc(LOGIN, { ...CLAIMS, ...claimPatch } as typeof CLAIMS);

    // No lookup by email, a separate user without the email, the victim untouched.
    expect(mocks.userFindUnique).not.toHaveBeenCalledWith({ where: { email: "alice@example.com" } });
    expect(result).toEqual({ id: "user-new", login: "alice-1", email: null });
    expect(mocks.userCreate.mock.calls[0]![0].data.email).toBeUndefined();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.identityCreate.mock.calls[0]![0].data).toMatchObject({ userId: "user-new" });
  });

  it("the claimed domains come from the locked connection row, not from the caller", async () => {
    db.connections[LOGIN.id]!.emailDomains = [];

    const result = await upsertUserFromOidc(
      { ...LOGIN, emailDomains: ["example.com"] } as typeof LOGIN,
      CLAIMS,
    );

    expect(result).toEqual({ id: "user-new", login: "alice-1", email: null });
  });
});

describe("upsertSsoConnection: an issuer change unbinds the connection's identities", () => {
  const INPUT = {
    displayName: "Acme",
    issuer: ISSUER,
    clientId: "c",
    clientSecret: "s",
    emailDomains: [],
  };

  function existing(issuer: string) {
    db.connections = { "conn-1": { teamId: "team-1", issuer, autoProvision: true, emailDomains: [] } };
  }

  beforeEach(() => {
    db.connections = {};
    mocks.connectionUpsert.mockImplementation(async (args: { update: { issuer: string } }) => ({
      id: "conn-1",
      issuer: args.update.issuer,
    }));
  });

  it("locks the team's row before the upsert", async () => {
    existing(ISSUER);

    await upsertSsoConnection("team-1", INPUT);

    expect(rawQueries()).toEqual(['SELECT id, issuer FROM sso_connections WHERE "teamId" = ? FOR UPDATE']);
    expect(mocks.queryRaw.mock.calls[0]![1]).toBe("team-1");
    expect(mocks.queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.connectionUpsert.mock.invocationCallOrder[0]!,
    );
  });

  it("unbinds every oidc identity of the connection in the same transaction", async () => {
    existing("https://old-idp.example.com");
    mocks.identityUpdateMany.mockResolvedValue({ count: 3 });

    await upsertSsoConnection("team-1", INPUT);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.identityUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.identityUpdateMany).toHaveBeenCalledWith({
      where: { provider: "oidc", ssoConnectionId: "conn-1" },
      data: { ssoConnectionId: null },
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "issuer_change", connectionId: "conn-1", unbound: 3 }),
      expect.any(String),
    );
  });

  it("logs an issuer change that unbound nothing", async () => {
    existing("https://old-idp.example.com");

    await upsertSsoConnection("team-1", INPUT);

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "issuer_change", unbound: 0 }),
      expect.any(String),
    );
  });

  it.each(DIFFERENT_ISSUERS)("unbinds for %s, both directions", async (_label, a, b) => {
    for (const [before, after] of [
      [a, b],
      [b, a],
    ] as const) {
      vi.clearAllMocks();
      existing(before);

      await upsertSsoConnection("team-1", { ...INPUT, issuer: after });

      expect(mocks.identityUpdateMany, `from ${before} to ${after}`).toHaveBeenCalledTimes(1);
    }
  });

  it.each(SAME_ISSUERS)("keeps identities bound: %s", async (_label, before, after) => {
    existing(before);

    await upsertSsoConnection("team-1", { ...INPUT, issuer: after });

    expect(mocks.identityUpdateMany).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("stores the issuer without trailing slashes", async () => {
    await upsertSsoConnection("team-1", { ...INPUT, issuer: "https://idp.example.com//" });

    const args = mocks.connectionUpsert.mock.calls[0]![0];
    expect(args.create.issuer).toBe("https://idp.example.com");
    expect(args.update.issuer).toBe("https://idp.example.com");
  });

  it("keeps identities bound when only client id or secret change", async () => {
    existing(ISSUER);

    await upsertSsoConnection("team-1", { ...INPUT, clientId: "c2", clientSecret: "s2" });

    expect(mocks.identityUpdateMany).not.toHaveBeenCalled();
  });

  it("a new connection has nothing to unbind and logs nothing", async () => {
    await upsertSsoConnection("team-1", INPUT);

    // No locked previous row: the unbind runs against the saved row's id and
    // finds no identity.
    expect(mocks.identityUpdateMany).toHaveBeenCalledWith({
      where: { provider: "oidc", ssoConnectionId: "conn-1" },
      data: { ssoConnectionId: null },
    });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("without a locked previous row, identities bound to the saved row are unbound and logged", async () => {
    // Another PUT created the row after this one found none: the same issuer
    // as the input, and still unbound, because the old issuer is unknown here.
    mocks.identityUpdateMany.mockResolvedValue({ count: 2 });

    await upsertSsoConnection("team-1", INPUT);

    expect(mocks.identityUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "issuer_change", connectionId: "conn-1", unbound: 2 }),
      expect.any(String),
    );
  });
});
