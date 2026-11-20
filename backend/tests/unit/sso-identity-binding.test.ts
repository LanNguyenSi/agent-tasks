/**
 * upsertUserFromOidc binds an existing (oidc, sub) identity to the issuer of
 * the connection that minted it. A `sub` is only unique per issuer, so a login
 * through a connection with another issuer must not reach that user, and an
 * identity whose connection is unknown (null or deleted) fails closed.
 * Without auto-provisioning, SSO only signs in existing team members.
 * upsertSsoConnection unbinds a connection's identities when its issuer
 * changes.
 *
 * Prisma and the logger are mocked; every write the service can make is a
 * spy, so a refusal is checked to write nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  identityFindUnique: vi.fn(),
  identityCreate: vi.fn(),
  identityUpdate: vi.fn(),
  identityUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  connectionFindUnique: vi.fn(),
  connectionFindMany: vi.fn(),
  connectionUpsert: vi.fn(),
  teamMemberFindUnique: vi.fn(),
  teamMemberUpsert: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  warn: vi.fn(),
}));

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
      findUnique: mocks.connectionFindUnique,
      findMany: mocks.connectionFindMany,
      upsert: mocks.connectionUpsert,
    },
    teamMember: { findUnique: mocks.teamMemberFindUnique, upsert: mocks.teamMemberUpsert },
    $queryRaw: mocks.queryRaw,
    $transaction: mocks.transaction,
  };
  mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(client));
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

import { upsertSsoConnection, upsertUserFromOidc } from "../../src/services/sso.js";

const SUB = "sub-shared-4711";

const CONNECTION = {
  id: "conn-current",
  teamId: "team-current",
  issuer: "https://idp.example.com",
  autoProvision: true,
  emailDomains: ["example.com"],
};

const CLAIMS = {
  iss: "https://idp.example.com",
  sub: SUB,
  aud: "client",
  exp: 0,
  iat: 0,
  email: "alice@example.com",
  email_verified: true,
  name: "Alice",
};

const VICTIM = {
  id: "user-victim",
  login: "alice",
  email: "alice@example.com",
  name: "Alice",
  avatarUrl: null,
};

function identityBoundTo(ssoConnectionId: string | null) {
  return {
    id: "identity-1",
    userId: VICTIM.id,
    provider: "oidc",
    providerUserId: SUB,
    ssoConnectionId,
    email: VICTIM.email,
    user: VICTIM,
  };
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.22.0",
  });
}

function expectNothingWritten() {
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.userUpdate).not.toHaveBeenCalled();
  expect(mocks.userCreate).not.toHaveBeenCalled();
  expect(mocks.identityCreate).not.toHaveBeenCalled();
  expect(mocks.identityUpdate).not.toHaveBeenCalled();
  expect(mocks.teamMemberUpsert).not.toHaveBeenCalled();
}

function expectLoggedWithoutSub(cause: string) {
  expect(mocks.warn).toHaveBeenCalledTimes(1);
  const [fields, message] = mocks.warn.mock.calls[0]!;
  expect(fields).toMatchObject({ component: "sso", identityId: "identity-1", cause });
  expect(JSON.stringify([fields, message])).not.toContain(SUB);
}

function expectLoginCompleted(result: unknown, connection = CONNECTION) {
  expect(result).toEqual({ id: VICTIM.id, login: VICTIM.login, email: VICTIM.email });
  expect(mocks.identityUpdate).toHaveBeenCalledTimes(1);
  expect(mocks.identityUpdate.mock.calls[0]![0]).toMatchObject({
    where: { id: "identity-1" },
    data: { ssoConnectionId: connection.id },
  });
  expect(mocks.identityCreate).not.toHaveBeenCalled();
  expect(mocks.teamMemberUpsert).toHaveBeenCalledTimes(1);
  expect(mocks.teamMemberUpsert.mock.calls[0]![0].where.teamId_userId).toEqual({
    teamId: connection.teamId,
    userId: VICTIM.id,
  });
  expect(mocks.warn).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.identityCreate.mockResolvedValue({});
  mocks.identityUpdate.mockResolvedValue({});
  mocks.identityUpdateMany.mockResolvedValue({ count: 0 });
  mocks.userUpdate.mockResolvedValue({});
  mocks.teamMemberUpsert.mockResolvedValue({});
  mocks.teamMemberFindUnique.mockResolvedValue(null);
  mocks.userFindUnique.mockResolvedValue(null);
  mocks.connectionFindUnique.mockResolvedValue(null);
  mocks.connectionFindMany.mockResolvedValue([]);
  // The locked re-read of the current connection returns its issuer unchanged.
  mocks.queryRaw.mockImplementation(async () => [{ issuer: CONNECTION.issuer }]);
});

describe("upsertUserFromOidc: existing identity bound to its issuer", () => {
  it("refuses an identity bound to a connection with a different issuer and writes nothing", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo("conn-other"));
    mocks.connectionFindUnique.mockResolvedValue({ issuer: "https://other-idp.example.net" });

    const result = await upsertUserFromOidc(CONNECTION, CLAIMS);

    expect(result).toEqual({ refused: "identity_conflict" });
    expect(mocks.connectionFindUnique).toHaveBeenCalledWith({
      where: { id: "conn-other" },
      select: { issuer: true },
    });
    expectNothingWritten();
    // The email-link lookup must not run either: the refusal comes first.
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expectLoggedWithoutSub("issuer_mismatch");
  });

  // Each pair is refused in both directions (bound issuer, current issuer and
  // the swap): a prefix or suffix relation is never the same issuer.
  it.each([
    ["host case", "https://IDP.example.com", "https://idp.example.com"],
    ["host suffix", "https://idp.example.com.evil.net", "https://idp.example.com"],
    ["host prefix label", "https://evil-idp.example.com", "https://idp.example.com"],
    ["path suffix", "https://idp.example.com/tenant", "https://idp.example.com"],
    ["path suffix on a path", "https://idp.example.com/t/abc", "https://idp.example.com/t/ab"],
    ["scheme", "http://idp.example.com", "https://idp.example.com"],
    ["explicit port", "https://idp.example.com:443", "https://idp.example.com"],
    ["double slash", "https://idp.example.com//x", "https://idp.example.com/x"],
  ])("refuses %s, bound longer and current longer", async (_label, a, b) => {
    for (const [bound, current] of [
      [a, b],
      [b, a],
    ] as const) {
      vi.clearAllMocks();
      mocks.identityFindUnique.mockResolvedValue(identityBoundTo("conn-other"));
      mocks.connectionFindUnique.mockResolvedValue({ issuer: bound });

      const result = await upsertUserFromOidc({ ...CONNECTION, issuer: current }, CLAIMS);

      expect(result, `bound ${bound}, current ${current}`).toEqual({ refused: "identity_conflict" });
      expectNothingWritten();
    }
  });

  it("allows the same issuer through another team's connection (rebinds and joins as today)", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo("conn-other"));
    mocks.connectionFindUnique.mockResolvedValue({ issuer: "https://idp.example.com" });

    const result = await upsertUserFromOidc(CONNECTION, CLAIMS);

    expectLoginCompleted(result);
    expect(mocks.userUpdate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["slash on the bound issuer", "https://idp.example.com/", "https://idp.example.com"],
    ["slash on the current issuer", "https://idp.example.com", "https://idp.example.com/"],
    ["several trailing slashes", "https://idp.example.com//", "https://idp.example.com"],
  ])("treats a trailing slash as the same issuer: %s", async (_label, bound, current) => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo("conn-other"));
    mocks.connectionFindUnique.mockResolvedValue({ issuer: bound });
    mocks.queryRaw.mockImplementation(async () => [{ issuer: current }]);

    const result = await upsertUserFromOidc({ ...CONNECTION, issuer: current }, CLAIMS);

    expectLoginCompleted(result);
  });

  it("allows the connection that minted the identity without a second lookup", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo(CONNECTION.id));

    const result = await upsertUserFromOidc(CONNECTION, CLAIMS);

    expectLoginCompleted(result);
    expect(mocks.connectionFindUnique).not.toHaveBeenCalled();
  });

  it("refuses an identity without a bound connection (fail closed)", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo(null));

    const result = await upsertUserFromOidc(CONNECTION, CLAIMS);

    expect(result).toEqual({ refused: "identity_conflict" });
    expect(mocks.connectionFindUnique).not.toHaveBeenCalled();
    expectNothingWritten();
    expectLoggedWithoutSub("unbound");
  });

  it("refuses an identity whose bound connection was deleted (fail closed)", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo("conn-deleted"));
    mocks.connectionFindUnique.mockResolvedValue(null);

    const result = await upsertUserFromOidc(CONNECTION, CLAIMS);

    expect(result).toEqual({ refused: "identity_conflict" });
    expectNothingWritten();
    expectLoggedWithoutSub("connection_missing");
  });

  it("a refusal is not the not-provisioned null, even with auto-provisioning off", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo("conn-other"));
    mocks.connectionFindUnique.mockResolvedValue({ issuer: "https://other-idp.example.net" });

    const result = await upsertUserFromOidc({ ...CONNECTION, autoProvision: false }, CLAIMS);

    expect(result).toEqual({ refused: "identity_conflict" });
    expectNothingWritten();
  });
});

describe("upsertUserFromOidc: auto-provisioning off never adds a team member", () => {
  const CLOSED = { ...CONNECTION, autoProvision: false };

  it("refuses an outsider whose identity has the same issuer: null, no membership, no rebind", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo("conn-other"));
    mocks.connectionFindUnique.mockResolvedValue({ issuer: CONNECTION.issuer });
    mocks.teamMemberFindUnique.mockResolvedValue(null);

    const result = await upsertUserFromOidc(CLOSED, CLAIMS);

    expect(result).toBeNull();
    expect(mocks.teamMemberFindUnique).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: CLOSED.teamId, userId: VICTIM.id } },
      select: { id: true },
    });
    expectNothingWritten();
  });

  it("refuses an outsider matched by verified, claimed email", async () => {
    mocks.identityFindUnique.mockResolvedValue(null);
    mocks.userFindUnique.mockResolvedValue(VICTIM);

    const result = await upsertUserFromOidc(CLOSED, CLAIMS);

    expect(result).toBeNull();
    expectNothingWritten();
  });

  it("signs in an existing member of the team", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo("conn-other"));
    mocks.connectionFindUnique.mockResolvedValue({ issuer: CONNECTION.issuer });
    mocks.teamMemberFindUnique.mockResolvedValue({ id: "membership-1" });

    const result = await upsertUserFromOidc(CLOSED, CLAIMS);

    expectLoginCompleted(result, CLOSED);
  });

  it("with auto-provisioning on, an outsider joins without a membership lookup", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo("conn-other"));
    mocks.connectionFindUnique.mockResolvedValue({ issuer: CONNECTION.issuer });

    const result = await upsertUserFromOidc(CONNECTION, CLAIMS);

    expectLoginCompleted(result);
    expect(mocks.teamMemberFindUnique).not.toHaveBeenCalled();
  });
});

describe("upsertUserFromOidc: the connection is re-read under a lock", () => {
  it("fails when the connection's issuer changed since the callback read it", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo(CONNECTION.id));
    mocks.queryRaw.mockImplementation(async () => [{ issuer: "https://evil-idp.example.net" }]);

    await expect(upsertUserFromOidc(CONNECTION, CLAIMS)).rejects.toThrow(
      /connection changed during login/,
    );
    expect(mocks.identityUpdate).not.toHaveBeenCalled();
    expect(mocks.teamMemberUpsert).not.toHaveBeenCalled();
  });

  it("fails when the connection was deleted since the callback read it", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo(CONNECTION.id));
    mocks.queryRaw.mockImplementation(async () => []);

    await expect(upsertUserFromOidc(CONNECTION, CLAIMS)).rejects.toThrow(
      /connection changed during login/,
    );
    expect(mocks.identityUpdate).not.toHaveBeenCalled();
  });

  it("locks the row with FOR SHARE", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo(CONNECTION.id));

    await upsertUserFromOidc(CONNECTION, CLAIMS);

    const [strings, id] = mocks.queryRaw.mock.calls[0]!;
    expect((strings as string[]).join("?")).toMatch(/FROM sso_connections WHERE id = \? FOR SHARE/);
    expect(id).toBe(CONNECTION.id);
  });
});

describe("upsertUserFromOidc: first-login race for a new sub", () => {
  it("on a unique violation, runs again and applies the issuer check to the winner's identity", async () => {
    mocks.identityFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(identityBoundTo("conn-attacker"));
    mocks.connectionFindUnique.mockResolvedValue({ issuer: "https://evil-idp.example.net" });
    mocks.userCreate.mockResolvedValue({ id: "user-new", login: "alice-1", email: null });
    mocks.identityCreate.mockRejectedValueOnce(uniqueViolation());

    const result = await upsertUserFromOidc(CONNECTION, CLAIMS);

    expect(result).toEqual({ refused: "identity_conflict" });
    expect(mocks.identityFindUnique).toHaveBeenCalledTimes(2);
    expect(mocks.identityCreate).toHaveBeenCalledTimes(1);
    expect(mocks.identityUpdate).not.toHaveBeenCalled();
    expect(mocks.teamMemberUpsert).not.toHaveBeenCalled();
  });

  it("on a unique violation with the same issuer, signs in the winner's user", async () => {
    mocks.identityFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(identityBoundTo("conn-other"));
    mocks.connectionFindUnique.mockResolvedValue({ issuer: CONNECTION.issuer });
    mocks.userCreate.mockResolvedValue({ id: "user-new", login: "alice-1", email: null });
    mocks.identityCreate.mockRejectedValueOnce(uniqueViolation());

    const result = await upsertUserFromOidc(CONNECTION, CLAIMS);

    expect(result).toEqual({ id: VICTIM.id, login: VICTIM.login, email: VICTIM.email });
    expect(mocks.identityUpdate).toHaveBeenCalledTimes(1);
  });

  it("a second unique violation is not retried again", async () => {
    mocks.identityFindUnique.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: "user-new", login: "alice-1", email: null });
    mocks.identityCreate.mockRejectedValue(uniqueViolation());

    await expect(upsertUserFromOidc(CONNECTION, CLAIMS)).rejects.toThrow(
      /identity created concurrently/,
    );
    expect(mocks.identityCreate).toHaveBeenCalledTimes(2);
  });

  it("another database error is not treated as the race", async () => {
    mocks.identityFindUnique.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: "user-new", login: "alice-1", email: null });
    mocks.identityCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "5.22.0" }),
    );

    await expect(upsertUserFromOidc(CONNECTION, CLAIMS)).rejects.toThrow(/fk/);
    expect(mocks.identityCreate).toHaveBeenCalledTimes(1);
  });
});

describe("upsertUserFromOidc: no identity for the sub (unchanged)", () => {
  it("provisions a new user bound to the current connection", async () => {
    mocks.identityFindUnique.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: "user-new", login: "bob", email: "bob@example.com" });

    const result = await upsertUserFromOidc(CONNECTION, {
      ...CLAIMS,
      email: "bob@example.com",
    });

    expect(result).toEqual({ id: "user-new", login: "bob", email: "bob@example.com" });
    expect(mocks.connectionFindUnique).not.toHaveBeenCalled();
    expect(mocks.userCreate).toHaveBeenCalledTimes(1);
    expect(mocks.identityCreate.mock.calls[0]![0].data).toMatchObject({
      userId: "user-new",
      provider: "oidc",
      providerUserId: SUB,
      ssoConnectionId: CONNECTION.id,
    });
    expect(mocks.identityUpdate).not.toHaveBeenCalled();
    expect(mocks.teamMemberUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("still links by verified, claimed email when no identity exists", async () => {
    mocks.identityFindUnique.mockResolvedValue(null);
    mocks.userFindUnique.mockResolvedValue(VICTIM);

    const result = await upsertUserFromOidc(CONNECTION, CLAIMS);

    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { email: "alice@example.com" } });
    expect(result).toEqual({ id: VICTIM.id, login: VICTIM.login, email: VICTIM.email });
    expect(mocks.identityCreate.mock.calls[0]![0].data).toMatchObject({ userId: VICTIM.id });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it("returns null when auto-provisioning is off and nothing matches", async () => {
    mocks.identityFindUnique.mockResolvedValue(null);

    const result = await upsertUserFromOidc(
      { ...CONNECTION, autoProvision: false },
      { ...CLAIMS, email_verified: false },
    );

    expect(result).toBeNull();
    expectNothingWritten();
  });
});

describe("upsertSsoConnection: an issuer change unbinds the connection's identities", () => {
  const INPUT = {
    displayName: "Acme",
    issuer: "https://idp.example.com",
    clientId: "c",
    clientSecret: "s",
    emailDomains: [],
  };

  beforeEach(() => {
    mocks.connectionUpsert.mockImplementation(async (args: { update: { issuer: string } }) => ({
      id: "conn-1",
      issuer: args.update.issuer,
    }));
  });

  it("unbinds every oidc identity of the connection in the same transaction", async () => {
    mocks.connectionFindUnique.mockResolvedValue({ id: "conn-1", issuer: "https://old-idp.example.com" });
    mocks.identityUpdateMany.mockResolvedValue({ count: 3 });

    await upsertSsoConnection("team-1", INPUT);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.identityUpdateMany).toHaveBeenCalledWith({
      where: { provider: "oidc", ssoConnectionId: "conn-1" },
      data: { ssoConnectionId: null },
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "issuer_change", connectionId: "conn-1", unbound: 3 }),
      expect.any(String),
    );
  });

  it("keeps identities bound when the issuer only gains a trailing slash", async () => {
    mocks.connectionFindUnique.mockResolvedValue({ id: "conn-1", issuer: "https://idp.example.com" });

    await upsertSsoConnection("team-1", { ...INPUT, issuer: "https://idp.example.com/" });

    expect(mocks.identityUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps identities bound when only client id or secret change", async () => {
    mocks.connectionFindUnique.mockResolvedValue({ id: "conn-1", issuer: "https://idp.example.com" });

    await upsertSsoConnection("team-1", { ...INPUT, clientId: "c2", clientSecret: "s2" });

    expect(mocks.identityUpdateMany).not.toHaveBeenCalled();
  });

  it("a new connection unbinds nothing", async () => {
    mocks.connectionFindUnique.mockResolvedValue(null);

    await upsertSsoConnection("team-1", INPUT);

    expect(mocks.identityUpdateMany).not.toHaveBeenCalled();
  });
});
