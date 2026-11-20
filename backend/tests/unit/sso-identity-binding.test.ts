/**
 * upsertUserFromOidc binds an existing (oidc, sub) identity to the issuer of
 * the connection that minted it. A `sub` is only unique per issuer, so a login
 * through a connection with another issuer must not reach that user, and an
 * identity whose connection is unknown (null or deleted) fails closed.
 *
 * Prisma and the logger are mocked; every write the service can make is a
 * spy, so a refusal is checked to write nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  identityFindUnique: vi.fn(),
  identityUpsert: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  connectionFindUnique: vi.fn(),
  teamMemberUpsert: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    userIdentity: { findUnique: mocks.identityFindUnique, upsert: mocks.identityUpsert },
    user: {
      findUnique: mocks.userFindUnique,
      create: mocks.userCreate,
      update: mocks.userUpdate,
    },
    ssoConnection: { findUnique: mocks.connectionFindUnique },
    teamMember: { upsert: mocks.teamMemberUpsert },
  },
}));

vi.mock("../../src/config/index.js", () => ({
  config: { SSO_ENCRYPTION_KEY: "key" },
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: { warn: mocks.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { upsertUserFromOidc } from "../../src/services/sso.js";

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

function expectNothingWritten() {
  expect(mocks.userUpdate).not.toHaveBeenCalled();
  expect(mocks.userCreate).not.toHaveBeenCalled();
  expect(mocks.identityUpsert).not.toHaveBeenCalled();
  expect(mocks.teamMemberUpsert).not.toHaveBeenCalled();
}

function expectLoggedWithoutSub(cause: string) {
  expect(mocks.warn).toHaveBeenCalledTimes(1);
  const [fields, message] = mocks.warn.mock.calls[0]!;
  expect(fields).toMatchObject({ component: "sso", identityId: "identity-1", cause });
  expect(JSON.stringify([fields, message])).not.toContain(SUB);
}

function expectLoginCompleted(result: unknown) {
  expect(result).toEqual({ id: VICTIM.id, login: VICTIM.login, email: VICTIM.email });
  expect(mocks.identityUpsert).toHaveBeenCalledTimes(1);
  expect(mocks.identityUpsert.mock.calls[0]![0].update.ssoConnectionId).toBe(CONNECTION.id);
  expect(mocks.teamMemberUpsert).toHaveBeenCalledTimes(1);
  expect(mocks.teamMemberUpsert.mock.calls[0]![0].where.teamId_userId).toEqual({
    teamId: CONNECTION.teamId,
    userId: VICTIM.id,
  });
  expect(mocks.warn).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.identityUpsert.mockResolvedValue({});
  mocks.userUpdate.mockResolvedValue({});
  mocks.teamMemberUpsert.mockResolvedValue({});
  mocks.userFindUnique.mockResolvedValue(null);
  mocks.connectionFindUnique.mockResolvedValue(null);
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

  it("compares the issuer exactly: a different host case is a different issuer", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo("conn-other"));
    mocks.connectionFindUnique.mockResolvedValue({ issuer: "https://IDP.example.com" });

    const result = await upsertUserFromOidc(CONNECTION, CLAIMS);

    expect(result).toEqual({ refused: "identity_conflict" });
    expectNothingWritten();
  });

  it("allows the same issuer through another team's connection (rebinds and joins as today)", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo("conn-other"));
    mocks.connectionFindUnique.mockResolvedValue({ issuer: "https://idp.example.com" });

    const result = await upsertUserFromOidc(CONNECTION, CLAIMS);

    expectLoginCompleted(result);
    expect(mocks.userUpdate).toHaveBeenCalledTimes(1);
  });

  it("treats a trailing slash on either issuer as the same issuer", async () => {
    mocks.identityFindUnique.mockResolvedValue(identityBoundTo("conn-other"));
    mocks.connectionFindUnique.mockResolvedValue({ issuer: "https://idp.example.com/" });

    const result = await upsertUserFromOidc(
      { ...CONNECTION, issuer: "https://idp.example.com" },
      CLAIMS,
    );

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
    expect(mocks.identityUpsert.mock.calls[0]![0].create).toMatchObject({
      userId: "user-new",
      provider: "oidc",
      providerUserId: SUB,
      ssoConnectionId: CONNECTION.id,
    });
    expect(mocks.teamMemberUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("still links by verified, claimed email when no identity exists", async () => {
    mocks.identityFindUnique.mockResolvedValue(null);
    mocks.userFindUnique.mockResolvedValue(VICTIM);

    const result = await upsertUserFromOidc(CONNECTION, CLAIMS);

    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { email: "alice@example.com" } });
    expectLoginCompleted(result);
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it("returns null when auto-provisioning is off and nothing matches", async () => {
    mocks.identityFindUnique.mockResolvedValue(null);

    const result = await upsertUserFromOidc({ ...CONNECTION, autoProvision: false }, {
      ...CLAIMS,
      email_verified: false,
    });

    expect(result).toBeNull();
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.identityUpsert).not.toHaveBeenCalled();
  });
});
