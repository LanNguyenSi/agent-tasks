/**
 * OIDC identity binding against a real Postgres: the takeover chains the unit
 * suite can only describe with mocks run here through the real services, the
 * real unique key on (provider, providerUserId) and the real row locks.
 *
 * The services run on a prisma client wrapped in a proxy that reports every
 * call (inside transactions as `tx.<model>.<method>` or `tx.$queryRaw`). A
 * test can park one call on a `barrier()` to build a schedule; nothing in the
 * services is replaced. Lock states are read from a second client, with
 * NOWAIT probes and from pg_stat_activity, not inferred from timing.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { barrier, groundingPostgres } from "../helpers/grounding-postgres.js";

type Phase = "before" | "after";
interface Call {
  phase: Phase;
  /** `userIdentity.update`, `tx.$queryRaw`, ... */
  point: string;
  /** First argument of a model call. */
  args?: unknown;
  /** Raw queries: the statement with `?` for each parameter, and the parameters. */
  sql?: string;
  params?: unknown[];
}
type Hook = (call: Call) => Promise<void> | void;

const shared = vi.hoisted(() => ({
  db: undefined as PrismaClient | undefined,
  hook: undefined as Hook | undefined,
}));

vi.mock("../../src/lib/prisma.js", () => {
  const report = async (call: Call) => {
    if (shared.hook) await shared.hook(call);
  };
  const wrapDelegate = (delegate: object, point: string) =>
    new Proxy(delegate, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          const call = { point: `${point}.${String(key)}`, args: args[0] };
          await report({ phase: "before", ...call });
          const result = await value.apply(target, args);
          await report({ phase: "after", ...call });
          return result;
        };
      },
    });
  const wrapClient = (client: object, prefix: string): object =>
    new Proxy(client, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (key === "$transaction") {
          return (fn: (tx: unknown) => unknown, options?: unknown) =>
            (target as PrismaClient).$transaction(
              (tx) => fn(wrapClient(tx as object, "tx.")) as never,
              options as never,
            );
        }
        if (key === "$queryRaw") {
          return async (strings: TemplateStringsArray, ...params: unknown[]) => {
            const call = {
              point: `${prefix}$queryRaw`,
              sql: strings.join("?").replace(/\s+/g, " ").trim(),
              params,
            };
            await report({ phase: "before", ...call });
            const result = await (value as (...a: unknown[]) => Promise<unknown>).call(target, strings, ...params);
            await report({ phase: "after", ...call });
            return result;
          };
        }
        if (typeof key === "string" && !key.startsWith("$") && value && typeof value === "object") {
          return wrapDelegate(value as object, `${prefix}${key}`);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return { prisma: new Proxy({}, { get: (_t, key) => Reflect.get(wrapClient(shared.db!, ""), key) }) };
});
vi.mock("../../src/config/index.js", async (orig) => {
  const actual = await orig<typeof import("../../src/config/index.js")>();
  return { config: { ...actual.config, SSO_ENCRYPTION_KEY: "11".repeat(32) } };
});
vi.mock("../../src/lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  deleteSsoConnection,
  getSsoConnectionByTeamId,
  upsertSsoConnection,
  upsertUserFromOidc,
} from "../../src/services/sso.js";

let store: Awaited<ReturnType<typeof groundingPostgres>>;
/** The client the services use and the tests read state with. */
let db: PrismaClient;
/** A second client for lock probes, so a probe never queues behind a service call. */
let probe: PrismaClient;
beforeAll(async () => {
  store = await groundingPostgres();
  db = store.connect(10);
  probe = store.connect(2);
  shared.db = db;
}, 60000);
afterEach(() => {
  shared.hook = undefined;
  // A failed expectation must not leave a parked transaction behind.
  for (const gate of gates.splice(0)) gate.release();
});
afterAll(async () => {
  if (store) await store.close();
});

const U = () => randomUUID().slice(0, 8);
const REFUSED = { refused: "identity_conflict" };

interface Conn {
  id: string;
  teamId: string;
  issuer: string;
}

function input(issuer: string, extra: { autoProvision?: boolean; emailDomains?: string[] } = {}) {
  return { displayName: "x", issuer, clientId: "c", clientSecret: "s", emailDomains: [], ...extra };
}

async function team(): Promise<string> {
  const id = U();
  return (await db.team.create({ data: { name: `t-${id}`, slug: `t-${id}` } })).id;
}

/** The connection as a callback would read it now. */
async function read(teamId: string): Promise<Conn> {
  const row = (await getSsoConnectionByTeamId(teamId))!;
  return { id: row.id, teamId: row.teamId, issuer: row.issuer };
}

async function connection(issuer: string, extra: { autoProvision?: boolean; emailDomains?: string[] } = {}) {
  const teamId = await team();
  await upsertSsoConnection(teamId, input(issuer, extra));
  return read(teamId);
}

/** A login whose ID token was verified against `conn.issuer`. */
function login(conn: Conn, sub: string, extra: Record<string, unknown> = {}) {
  return upsertUserFromOidc(
    { id: conn.id, issuer: conn.issuer },
    { iss: conn.issuer, sub, aud: "c", exp: 0, iat: 0, ...extra },
  );
}

function userId(result: unknown): string | null {
  return result && typeof result === "object" && "id" in result ? (result as { id: string }).id : null;
}

function identity(sub: string) {
  return db.userIdentity.findUnique({
    where: { provider_providerUserId: { provider: "oidc", providerUserId: sub } },
  });
}

async function teamsOf(user: string): Promise<string[]> {
  return (await db.teamMember.findMany({ where: { userId: user } })).map((m) => m.teamId).sort();
}

const gates: { release: () => void }[] = [];

/** Park the first call the predicate matches until `release()`. */
function pauseAt(match: (call: Call) => boolean) {
  const gate = barrier();
  gates.push(gate);
  let armed = true;
  shared.hook = async (call) => {
    if (armed && match(call)) {
      armed = false;
      await gate.wait();
    }
  };
  return gate;
}

// The login's raw reads, matched without their lock clause: whether a lock is
// held is asserted with isLocked(), not implied by the statement text.
const readsConnection = (id: string) => (call: Call) =>
  call.point === "tx.$queryRaw" && /FROM sso_connections WHERE id = \?/.test(call.sql ?? "") && call.params?.[0] === id;
const readsIdentity = (call: Call) =>
  call.point === "tx.$queryRaw" && /FROM user_identities WHERE id = \?/.test(call.sql ?? "");

/**
 * Whether another transaction holds a row lock that conflicts with `strength`
 * on the row. FOR NO KEY UPDATE is what an issuer UPDATE takes (it conflicts
 * with FOR SHARE), FOR SHARE is what a login takes on a connection, and FOR KEY
 * SHARE only conflicts with FOR UPDATE.
 */
async function isLocked(
  table: "sso_connections" | "user_identities",
  id: string,
  strength: "FOR NO KEY UPDATE" | "FOR SHARE" | "FOR KEY SHARE",
): Promise<boolean> {
  try {
    await probe.$transaction((tx) =>
      tx.$queryRawUnsafe(`SELECT 1 FROM ${table} WHERE id = $1 ${strength} NOWAIT`, id),
    );
    return false;
  } catch (err) {
    if (/55P03/.test((err as Error).message)) return true;
    throw err;
  }
}

const PUT_LOCK = '%FROM sso_connections WHERE "teamId" = $1 FOR UPDATE%';
const LOGIN_LOCK = "%FROM sso_connections WHERE id = $1 FOR SHARE%";
const DELETE_CONNECTION = "%DELETE FROM %sso_connections%";

/**
 * Resolves once a statement matching the LIKE pattern is blocked on a lock in
 * this database, so "it waits" is observed and not assumed.
 */
async function blockedOnLock(pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const rows = await probe.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${pattern}`;
    if (rows[0]!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no statement like ${pattern} is blocked on a lock`);
}

/**
 * A victim who first signed in through connection A on the shared issuer and
 * then through B, a second connection on the same issuer: the identity is
 * bound to B, which is the precondition of the takeover chain.
 */
async function victimBoundToB() {
  const shared = `https://shared-${U()}.example.com`;
  const evil = `https://evil-${U()}.example.net`;
  const a = await connection(shared);
  const b = await connection(shared);
  const sub = `victim-${U()}`;
  const victim = userId(await login(a, sub, { name: "Victim" }))!;
  expect(userId(await login(b, sub, { name: "Victim" }))).toBe(victim);
  expect((await identity(sub))?.ssoConnectionId).toBe(b.id);
  return { shared, evil, a, b, sub, victim };
}

/** The victim's row and memberships are what they were, and no user was added. */
async function expectVictimUntouched(victim: string, teams: string[], usersBefore: number) {
  expect((await db.user.findUnique({ where: { id: victim } }))?.name).toBe("Victim");
  expect(await teamsOf(victim)).toEqual([...teams].sort());
  expect(await db.user.count()).toBe(usersBefore);
}

describe("OIDC identity bound to its issuer (real Postgres)", () => {
  it("same-issuer rebind followed by an issuer change does not reach the victim", async () => {
    const { shared, evil, a, b, sub, victim } = await victimBoundToB();
    expect((await db.teamMember.findMany({ where: { userId: victim } })).map((m) => m.role)).toEqual([
      "HUMAN_MEMBER",
      "HUMAN_MEMBER",
    ]);

    // B's admin moves B to their own IdP; the connection id stays the same.
    await upsertSsoConnection(b.teamId, input(evil));
    const bEvil = await read(b.teamId);
    expect(bEvil.id).toBe(b.id);
    expect((await identity(sub))?.ssoConnectionId).toBeNull();

    expect(await login(bEvil, sub)).toEqual(REFUSED);
    // The legitimate issuer is refused too until an operator rebinds the row.
    expect(await login(a, sub)).toEqual(REFUSED);
    expect(await teamsOf(victim)).toEqual([a.teamId, b.teamId].sort());
    expect(shared).not.toBe(evil);
  });

  it("an issuer change to a longer issuer on the same host unbinds too", async () => {
    const base = `https://idp-${U()}.example.com`;
    const a = await connection(base);
    const sub = `victim-${U()}`;
    await login(a, sub);

    await upsertSsoConnection(a.teamId, input(`${base}/realms/other`));

    expect((await identity(sub))?.ssoConnectionId).toBeNull();
    expect(await login(await read(a.teamId), sub)).toEqual(REFUSED);
  });

  it("a trailing slash on the issuer is not a change: identities stay bound", async () => {
    const base = `https://idp-${U()}.example.com`;
    const a = await connection(base);
    const sub = `user-${U()}`;
    const user = userId(await login(a, sub));

    await upsertSsoConnection(a.teamId, input(`${base}/`));

    expect((await read(a.teamId)).issuer).toBe(base);
    expect((await identity(sub))?.ssoConnectionId).toBe(a.id);
    expect(userId(await login(a, sub))).toBe(user);
  });

  it("a login verified against the issuer from before a change or a delete fails and writes nothing", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const stale = await connection(shared);
    await upsertSsoConnection(stale.teamId, input(`https://evil-${U()}.example.net`));
    const sub = `stale-${U()}`;
    const usersBefore = await db.user.count();

    await expect(login(stale, sub)).rejects.toThrow(/connection changed during login/);
    expect(await identity(sub)).toBeNull();

    const gone = await connection(shared);
    await deleteSsoConnection(gone.teamId);
    await expect(login(gone, sub)).rejects.toThrow(/connection changed during login/);
    expect(await identity(sub)).toBeNull();
    expect(await db.user.count()).toBe(usersBefore);
  });

  it("concurrent first logins for one new sub from two issuers never share a user", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const evil = `https://evil-${U()}.example.net`;
    const a = await connection(shared);
    const c = await connection(evil);
    for (let i = 0; i < 10; i++) {
      const sub = `race-${U()}`;
      const usersBefore = await db.user.count();
      // Distinct emails give distinct logins, so only the identity insert races.
      const results = await Promise.allSettled([
        login(a, sub, { email: `victim-${sub}@a.example` }),
        login(c, sub, { email: `attacker-${sub}@c.example` }),
      ]);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected, JSON.stringify(rejected.map((r) => String((r as PromiseRejectedResult).reason)))).toEqual([]);
      const users = results
        .map((r) => (r.status === "fulfilled" ? userId(r.value) : null))
        .filter((v): v is string => v !== null);
      expect(users).toHaveLength(1);
      const refused = results.filter(
        (r) => r.status === "fulfilled" && JSON.stringify(r.value) === JSON.stringify(REFUSED),
      );
      expect(refused).toHaveLength(1);
      expect((await identity(sub))?.userId).toBe(users[0]);
      // The loser's provisional user was rolled back with its transaction.
      expect(await db.userIdentity.count({ where: { providerUserId: sub } })).toBe(1);
      expect(await db.user.count()).toBe(usersBefore + 1);
    }
  });
});

describe("concurrent identical first logins (real Postgres)", () => {
  it("same sub, same connection, same login name: one user, the loser fails on the login name or signs in", async () => {
    const a = await connection(`https://shared-${U()}.example.com`);
    for (let i = 0; i < 5; i++) {
      const sub = `twice-${U()}`;
      const usersBefore = await db.user.count();

      const results = await Promise.allSettled([login(a, sub), login(a, sub)]);

      const users = results
        .map((r) => (r.status === "fulfilled" ? userId(r.value) : null))
        .filter((v): v is string => v !== null);
      expect(users.length).toBeGreaterThanOrEqual(1);
      expect(new Set(users).size).toBe(1);
      // Not retried: the loser fails on the unique login name, before the identity insert.
      for (const r of results) {
        if (r.status === "rejected") expect(String(r.reason)).toMatch(/Unique constraint failed.*login/s);
      }
      expect((await identity(sub))?.userId).toBe(users[0]);
      expect(await db.user.count()).toBe(usersBefore + 1);
      // The next attempt signs in.
      expect(userId(await login(a, sub))).toBe(users[0]);
    }
  });
});

describe("login through a second connection against an issuer change of the bound connection", () => {
  it("issuer change commits after the login first read the identity: refused, identity stays unbound", async () => {
    const { evil, a, b, sub, victim } = await victimBoundToB();
    const b2 = await connection(evil); // the attacker's second team, already on their IdP
    // Control: without the interleave the attacker is refused.
    expect(await login(b2, sub, { name: "Mallory" })).toEqual(REFUSED);
    const usersBefore = await db.user.count();

    // The login has read the identity (bound to B) and is about to lock B.
    const gate = pauseAt((call) => call.phase === "before" && readsConnection(b.id)(call));
    const attack = login(b2, sub, { name: "Mallory" });
    await gate.reached;
    await upsertSsoConnection(b.teamId, input(evil)); // commits: B on the attacker's IdP, identity unbound
    gate.release();

    expect(await attack).toEqual(REFUSED);
    expect((await identity(sub))?.ssoConnectionId).toBeNull();
    // No later login reaches the victim either, through B2 or through B.
    expect(await login(b2, sub, { name: "Mallory" })).toEqual(REFUSED);
    expect(await login(await read(b.teamId), sub, { name: "Mallory" })).toEqual(REFUSED);
    await expectVictimUntouched(victim, [a.teamId, b.teamId], usersBefore);
  });

  it("the login locks the bound connection first: the issuer change waits, the login is refused", async () => {
    const { evil, a, b, sub, victim } = await victimBoundToB();
    const b2 = await connection(evil);
    const usersBefore = await db.user.count();

    // The login holds its locks on B2, B and the identity and is about to decide.
    const gate = pauseAt((call) => call.phase === "after" && readsIdentity(call));
    const attack = login(b2, sub, { name: "Mallory" });
    await gate.reached;
    expect(await isLocked("sso_connections", b.id, "FOR NO KEY UPDATE")).toBe(true);
    expect(await isLocked("user_identities", (await identity(sub))!.id, "FOR KEY SHARE")).toBe(true);
    const change = upsertSsoConnection(b.teamId, input(evil));
    await blockedOnLock(PUT_LOCK);
    gate.release();

    expect(await attack).toEqual(REFUSED); // B still had the shared issuer under the lock
    await change;
    expect((await identity(sub))?.ssoConnectionId).toBeNull(); // unbound by the change
    expect(await login(b2, sub, { name: "Mallory" })).toEqual(REFUSED);
    expect(await login(await read(b.teamId), sub, { name: "Mallory" })).toEqual(REFUSED);
    await expectVictimUntouched(victim, [a.teamId, b.teamId], usersBefore);
  });

  it("a same-issuer login holds both connections and the identity until it commits", async () => {
    const { shared, evil, a, b, sub, victim } = await victimBoundToB();
    const b2 = await connection(shared);

    // The victim's own login through B2, parked before its first write.
    const gate = pauseAt((call) => call.phase === "before" && call.point === "tx.user.update");
    const own = login(b2, sub, { name: "Victim" });
    await gate.reached;
    expect(await isLocked("sso_connections", b2.id, "FOR NO KEY UPDATE")).toBe(true);
    expect(await isLocked("sso_connections", b.id, "FOR NO KEY UPDATE")).toBe(true);
    // FOR KEY SHARE only conflicts with FOR UPDATE: the identity row is held exclusively.
    expect(await isLocked("user_identities", (await identity(sub))!.id, "FOR KEY SHARE")).toBe(true);
    // Logins through the same connections are not blocked by each other.
    expect(await isLocked("sso_connections", b.id, "FOR SHARE")).toBe(false);
    const change = upsertSsoConnection(b.teamId, input(evil));
    await blockedOnLock(PUT_LOCK);
    gate.release();

    expect(userId(await own)).toBe(victim);
    await change;
    // The identity moved to B2 before B changed: it stays bound to the shared issuer.
    expect((await identity(sub))?.ssoConnectionId).toBe(b2.id);
    expect(await login(await read(b.teamId), sub, { name: "Mallory" })).toEqual(REFUSED);
    expect(userId(await login(b2, sub, { name: "Victim" }))).toBe(victim);
    expect(await teamsOf(victim)).toEqual([a.teamId, b.teamId, b2.teamId].sort());
  });

  it("the victim rebinds between the attacker login's first read and its lock, then B changes issuer: refused", async () => {
    const { shared, evil, a, b, sub, victim } = await victimBoundToB();
    const b2 = await connection(evil);
    const b3 = await connection(shared);
    const usersBefore = await db.user.count();

    // The attacker's login has read the identity (bound to B) and is about to lock B.
    const gate = pauseAt((call) => call.phase === "before" && readsConnection(b.id)(call));
    const attack = login(b2, sub, { name: "Mallory" });
    await gate.reached;
    // The victim signs in through B3: the identity moves from B to B3.
    expect(userId(await login(b3, sub, { name: "Victim" }))).toBe(victim);
    // B moves to the attacker's IdP and has nothing to unbind any more.
    await upsertSsoConnection(b.teamId, input(evil));
    gate.release();

    // B now has the attacker's issuer, but the identity is no longer bound to
    // it: the binding read first is not used, and the second pass sees B3.
    expect(await attack).toEqual(REFUSED);
    expect((await identity(sub))?.ssoConnectionId).toBe(b3.id);
    expect(await login(b2, sub, { name: "Mallory" })).toEqual(REFUSED);
    expect(await login(await read(b.teamId), sub, { name: "Mallory" })).toEqual(REFUSED);
    await expectVictimUntouched(victim, [a.teamId, b.teamId, b3.teamId], usersBefore);
  });

  it("a login waits for an uncommitted issuer change of the bound connection, then is refused", async () => {
    const { evil, a, b, sub, victim } = await victimBoundToB();
    const b2 = await connection(evil);
    const usersBefore = await db.user.count();

    // The change has written the attacker's issuer to B and has not unbound or committed yet.
    const gate = pauseAt((call) => call.phase === "before" && call.point === "tx.userIdentity.updateMany");
    const change = upsertSsoConnection(b.teamId, input(evil));
    await gate.reached;
    const attack = login(b2, sub, { name: "Mallory" });
    await blockedOnLock(LOGIN_LOCK);
    gate.release();
    await change;

    expect(await attack).toEqual(REFUSED);
    expect((await identity(sub))?.ssoConnectionId).toBeNull();
    await expectVictimUntouched(victim, [a.teamId, b.teamId], usersBefore);
  });

  // No hook and no delay: the unsynchronised race the deterministic cases pin.
  it("unsynchronised: concurrent logins through B2 against one issuer change never reach the victim", async () => {
    const trials = Number(process.env.SSO_RACE_TRIALS ?? 5);
    const perTrial = 12;
    const shared = `https://shared-${U()}.example.com`;
    const evil = `https://evil-${U()}.example.net`;
    const a = await connection(shared);
    const b2 = await connection(evil);
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    let takeovers = 0;
    let boundToAttacker = 0;
    let controlRefused = 0;
    for (let i = 0; i < trials; i++) {
      const b = await connection(shared);
      const sub = `victim-${U()}`;
      const victim = userId(await login(a, sub));
      await login(b, sub);
      if (JSON.stringify(await login(b2, sub)) === JSON.stringify(REFUSED)) controlRefused++;
      const change = (async () => {
        await tick();
        await upsertSsoConnection(b.teamId, input(evil));
      })();
      const logins: Promise<unknown>[] = [];
      for (let k = 0; k < perTrial; k++) {
        logins.push(login(b2, sub).catch((err: Error) => `error: ${err.message}`));
        await tick();
      }
      const results = await Promise.all(logins);
      await change;
      if (results.some((r) => userId(r) === victim)) takeovers++;
      if ((await identity(sub))?.ssoConnectionId === b2.id) boundToAttacker++;
    }
    if (process.env.SSO_RACE_TRIALS) {
      process.stdout.write(
        `sso race: trials=${trials} logins_per_trial=${perTrial} control_refused=${controlRefused} takeovers=${takeovers} identity_bound_to_attacker=${boundToAttacker}\n`,
      );
    }
    expect({ controlRefused, takeovers, boundToAttacker }).toEqual({
      controlRefused: trials,
      takeovers: 0,
      boundToAttacker: 0,
    });
  }, 900000);
});

describe("login against a change of its own connection", () => {
  it("login first: the change waits for the login, then unbinds the identity the login wrote", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const evil = `https://evil-${U()}.example.net`;
    const c = await connection(shared);
    const sub = `first-${U()}`;

    const gate = pauseAt((call) => call.phase === "before" && call.point === "tx.userIdentity.create");
    const first = login(c, sub);
    await gate.reached;
    expect(await isLocked("sso_connections", c.id, "FOR NO KEY UPDATE")).toBe(true);
    const change = upsertSsoConnection(c.teamId, input(evil));
    await blockedOnLock(PUT_LOCK);
    gate.release();

    const user = userId(await first);
    expect(user).not.toBeNull();
    await change;
    // Written by the login, then unbound by the change that waited for it.
    const row = await identity(sub);
    expect(row?.userId).toBe(user);
    expect(row?.ssoConnectionId).toBeNull();
    expect(await login(await read(c.teamId), sub)).toEqual(REFUSED);
  });

  it("change first: a login that waited for the uncommitted change fails and writes nothing", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const evil = `https://evil-${U()}.example.net`;
    const c = await connection(shared);
    const sub = `late-${U()}`;
    const usersBefore = await db.user.count();

    // The change has written the new issuer and has not committed.
    const gate = pauseAt((call) => call.phase === "before" && call.point === "tx.userIdentity.updateMany");
    const change = upsertSsoConnection(c.teamId, input(evil));
    await gate.reached;
    expect(await isLocked("sso_connections", c.id, "FOR SHARE")).toBe(true);
    const late = login(c, sub).catch((err: Error) => err);
    await blockedOnLock(LOGIN_LOCK);
    gate.release();
    await change;

    const outcome = await late;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/connection changed during login/);
    expect(await identity(sub)).toBeNull();
    expect(await db.user.count()).toBe(usersBefore);
  });

  it("login first: a delete of the connection waits, the identity is left on the deleted row", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const c = await connection(shared);
    const sub = `first-${U()}`;

    const gate = pauseAt((call) => call.phase === "before" && call.point === "tx.userIdentity.create");
    const first = login(c, sub);
    await gate.reached;
    const removal = deleteSsoConnection(c.teamId);
    await blockedOnLock(DELETE_CONNECTION);
    gate.release();

    const user = userId(await first);
    expect(user).not.toBeNull();
    await removal;
    expect(await getSsoConnectionByTeamId(c.teamId)).toBeNull();
    expect((await identity(sub))?.ssoConnectionId).toBe(c.id);
    // A recreated connection has a new id: the identity fails closed.
    await upsertSsoConnection(c.teamId, input(shared));
    expect(await login(await read(c.teamId), sub)).toEqual(REFUSED);
  });
});

describe("login against a delete of the bound connection", () => {
  it("login first: the delete waits, the identity ends on the surviving connection", async () => {
    const { shared, a, b, sub, victim } = await victimBoundToB();
    const b2 = await connection(shared);

    const gate = pauseAt((call) => call.phase === "before" && call.point === "tx.userIdentity.update");
    const own = login(b2, sub, { name: "Victim" });
    await gate.reached;
    expect(await isLocked("sso_connections", b.id, "FOR NO KEY UPDATE")).toBe(true);
    const removal = deleteSsoConnection(b.teamId);
    await blockedOnLock(DELETE_CONNECTION);
    gate.release();

    expect(userId(await own)).toBe(victim);
    await removal;
    expect(await getSsoConnectionByTeamId(b.teamId)).toBeNull();
    // Not left pointing at the deleted row.
    expect((await identity(sub))?.ssoConnectionId).toBe(b2.id);
    expect(userId(await login(b2, sub, { name: "Victim" }))).toBe(victim);
    expect(await teamsOf(victim)).toEqual([a.teamId, b.teamId, b2.teamId].sort());
  });

  it("delete commits after the login first read the identity: refused, nothing written", async () => {
    const { shared, a, b, sub, victim } = await victimBoundToB();
    const b2 = await connection(shared);
    const usersBefore = await db.user.count();

    const gate = pauseAt((call) => call.phase === "before" && readsConnection(b.id)(call));
    const attempt = login(b2, sub, { name: "Mallory" });
    await gate.reached;
    await deleteSsoConnection(b.teamId);
    gate.release();

    expect(await attempt).toEqual(REFUSED);
    // Still bound to the deleted row: fails closed until an operator rebinds it.
    expect((await identity(sub))?.ssoConnectionId).toBe(b.id);
    expect(await login(b2, sub, { name: "Mallory" })).toEqual(REFUSED);
    await expectVictimUntouched(victim, [a.teamId, b.teamId], usersBefore);
  });
});

describe("two PUTs on one team's connection", () => {
  it("existing connection: the second PUT waits and compares against what the first one saved", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const evil = `https://evil-${U()}.example.net`;
    const c = await connection(evil);
    const sub = `bound-${U()}`;
    await login(c, sub);

    // PUT 1 (same issuer, a no-op for identities) holds the row lock.
    const gate = pauseAt((call) => call.phase === "before" && call.point === "tx.ssoConnection.upsert");
    const first = upsertSsoConnection(c.teamId, input(evil));
    await gate.reached;
    expect(await isLocked("sso_connections", c.id, "FOR SHARE")).toBe(true);
    const second = upsertSsoConnection(c.teamId, input(shared));
    await blockedOnLock(PUT_LOCK);
    gate.release();
    await Promise.all([first, second]);

    // PUT 2 ran after PUT 1 and saw the issuer it replaced: identities unbound.
    expect((await read(c.teamId)).issuer).toBe(shared);
    expect((await identity(sub))?.ssoConnectionId).toBeNull();
  });

  it("no connection yet: a PUT that found no row still unbinds what was bound in between", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const evil = `https://evil-${U()}.example.net`;
    const a = await connection(shared);
    const sub = `victim-${U()}`;
    const victim = userId(await login(a, sub, { name: "Victim" }))!;
    const teamId = await team();

    // PUT 1 (the attacker's IdP) found no row to lock and is about to save.
    const gate = pauseAt((call) => call.phase === "before" && call.point === "tx.ssoConnection.upsert");
    const first = upsertSsoConnection(teamId, input(evil)).then(
      () => "saved",
      (err: Error) => `error: ${err.message}`,
    );
    await gate.reached;
    // PUT 2 creates the connection on the shared issuer; the victim signs in through it.
    await upsertSsoConnection(teamId, input(shared));
    const c = await read(teamId);
    expect(userId(await login(c, sub, { name: "Victim" }))).toBe(victim);
    expect((await identity(sub))?.ssoConnectionId).toBe(c.id);
    gate.release();

    // PUT 1 updates the row PUT 2 created. It never saw the shared issuer, so
    // it unbinds the identities of the row instead of comparing.
    expect(await first).toBe("saved");
    const now = await read(teamId);
    expect(now.id).toBe(c.id);
    expect(now.issuer).toBe(evil);
    expect((await identity(sub))?.ssoConnectionId).toBeNull();
    expect(await login(now, sub, { name: "Mallory" })).toEqual(REFUSED);
    expect((await db.user.findUnique({ where: { id: victim } }))?.name).toBe("Victim");
  });
});

describe("team join and auto-provisioning (real Postgres)", () => {
  it("a provisioned user and a same-issuer joiner are HUMAN_MEMBER", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const a = await connection(shared);
    const b = await connection(shared);
    const sub = `member-${U()}`;

    const user = userId(await login(a, sub))!;
    await login(b, sub);

    const members = await db.teamMember.findMany({ where: { userId: user } });
    expect(members.map((m) => [m.teamId, m.role]).sort()).toEqual(
      [
        [a.teamId, "HUMAN_MEMBER"],
        [b.teamId, "HUMAN_MEMBER"],
      ].sort(),
    );
  });

  it("an existing role is kept on a later login", async () => {
    const a = await connection(`https://shared-${U()}.example.com`);
    const sub = `admin-${U()}`;
    const user = userId(await login(a, sub))!;
    await db.teamMember.update({
      where: { teamId_userId: { teamId: a.teamId, userId: user } },
      data: { role: "ADMIN" },
    });

    await login(a, sub);

    expect(
      (await db.teamMember.findUnique({ where: { teamId_userId: { teamId: a.teamId, userId: user } } }))?.role,
    ).toBe("ADMIN");
  });

  it("auto-provisioning off: an outsider with a same-issuer identity is not added to the team", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const open = await connection(shared, { autoProvision: true });
    const closed = await connection(shared, { autoProvision: false });
    const sub = `outsider-${U()}`;

    const outsider = userId(await login(open, sub))!;
    expect(await login(closed, sub)).toBeNull();
    expect(await teamsOf(outsider)).toEqual([open.teamId]);
    expect((await identity(sub))?.ssoConnectionId).toBe(open.id);

    // Once a member, the same login passes and the identity moves.
    await db.teamMember.create({ data: { teamId: closed.teamId, userId: outsider, role: "REVIEWER" } });
    expect(userId(await login(closed, sub))).toBe(outsider);
    expect((await identity(sub))?.ssoConnectionId).toBe(closed.id);
    expect(
      (await db.teamMember.findUnique({ where: { teamId_userId: { teamId: closed.teamId, userId: outsider } } }))
        ?.role,
    ).toBe("REVIEWER");
  });

  it("auto-provisioning switched off after the callback read the connection: no user, no join", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const open = await connection(shared, { autoProvision: true });
    const c = await connection(shared, { autoProvision: true });
    const known = `known-${U()}`;
    const outsider = userId(await login(open, known))!;
    const usersBefore = await db.user.count();

    // `c` is the callback's view; the admin switches auto-provisioning off after it.
    await upsertSsoConnection(c.teamId, input(shared, { autoProvision: false }));

    expect(await login(c, `new-${U()}`)).toBeNull();
    expect(await login(c, known)).toBeNull();
    expect(await db.user.count()).toBe(usersBefore);
    expect(await teamsOf(outsider)).toEqual([open.teamId]);
  });

  it("auto-provisioning off: a member removed while the login runs is not added back", async () => {
    const shared = `https://shared-${U()}.example.com`;
    const open = await connection(shared, { autoProvision: true });
    const closed = await connection(shared, { autoProvision: false });
    const sub = `leaver-${U()}`;
    const user = userId(await login(open, sub))!;
    await db.teamMember.create({ data: { teamId: closed.teamId, userId: user, role: "HUMAN_MEMBER" } });

    // The login found the membership and is about to write.
    const gate = pauseAt((call) => call.phase === "before" && call.point === "tx.user.update");
    const attempt = login(closed, sub);
    await gate.reached;
    await db.teamMember.delete({ where: { teamId_userId: { teamId: closed.teamId, userId: user } } });
    gate.release();

    // Same result as the login finishing just before the removal.
    expect(userId(await attempt)).toBe(user);
    expect(await teamsOf(user)).toEqual([open.teamId]);
  });
});

describe("email link for a sub without an identity (real Postgres)", () => {
  async function localUser() {
    const id = U();
    const email = `alice-${id}@corp-${id}.example`;
    const user = await db.user.create({ data: { login: `alice-${id}`, email, name: "Alice" } });
    return { user, email, domain: email.split("@")[1]! };
  }

  it("links a verified email on a claimed domain", async () => {
    const { user, email, domain } = await localUser();
    const c = await connection(`https://idp-${U()}.example.com`, { emailDomains: [domain] });
    const sub = `link-${U()}`;

    expect(userId(await login(c, sub, { email, email_verified: true }))).toBe(user.id);
    expect((await identity(sub))?.userId).toBe(user.id);
  });

  it.each([
    ["an unverified email on a claimed domain", false, true],
    ["a verified email on an unclaimed domain", true, false],
    ["an unverified email on an unclaimed domain", false, false],
  ])("does not link %s to the existing user", async (_label, verified, claimed) => {
    const { user, email, domain } = await localUser();
    const c = await connection(`https://idp-${U()}.example.com`, { emailDomains: claimed ? [domain] : [] });
    const sub = `nolink-${U()}`;

    const result = userId(await login(c, sub, { email, email_verified: verified, name: "Mallory" }));

    expect(result).not.toBeNull();
    expect(result).not.toBe(user.id);
    expect((await identity(sub))?.userId).toBe(result);
    // The existing user keeps its row, gains no identity and no membership.
    expect(await db.user.findUnique({ where: { id: user.id } })).toMatchObject({ email, name: "Alice" });
    expect(await db.userIdentity.count({ where: { userId: user.id } })).toBe(0);
    expect(await teamsOf(user.id)).toEqual([]);
    expect((await db.user.findUnique({ where: { id: result! } }))?.email).toBeNull();
  });

  it.each([
    ["a domain that ends with the claimed one", (domain: string) => `evil${domain}`],
    ["a subdomain of the claimed one", (domain: string) => `sub.${domain}`],
  ])("does not link a verified email on %s", async (_label, other) => {
    const id = U();
    const claimed = `corp-${id}.example`;
    const email = `alice@${other(claimed)}`;
    const user = await db.user.create({ data: { login: `alice-${id}`, email, name: "Alice" } });
    const c = await connection(`https://idp-${U()}.example.com`, { emailDomains: [claimed] });
    const sub = `suffix-${U()}`;

    const result = userId(await login(c, sub, { email, email_verified: true, name: "Mallory" }));

    expect(result).not.toBeNull();
    expect(result).not.toBe(user.id);
    expect(await db.user.findUnique({ where: { id: user.id } })).toMatchObject({ email, name: "Alice" });
    expect(await db.userIdentity.count({ where: { userId: user.id } })).toBe(0);
    expect((await db.user.findUnique({ where: { id: result! } }))?.email).toBeNull();
  });

  it("an identity-matched login only writes a verified email on a claimed domain to the user", async () => {
    const id = U();
    const claimed = `corp-${id}.example`;
    const email = `alice@${claimed}`;
    const c = await connection(`https://idp-${U()}.example.com`, { emailDomains: [claimed] });
    const sub = `profile-${U()}`;
    const user = userId(await login(c, sub, { email, email_verified: true }))!;
    const stored = async () => (await db.user.findUnique({ where: { id: user } }))?.email;
    expect(await stored()).toBe(email);

    // Unverified, on the claimed domain.
    expect(userId(await login(c, sub, { email: `mallory@${claimed}`, email_verified: false }))).toBe(user);
    expect(await stored()).toBe(email);
    // Verified, on a domain the connection does not claim (also not by suffix).
    expect(userId(await login(c, sub, { email: `mallory@evil${claimed}`, email_verified: true }))).toBe(user);
    expect(await stored()).toBe(email);
    expect(userId(await login(c, sub, { email: `mallory@other-${id}.example`, email_verified: true }))).toBe(user);
    expect(await stored()).toBe(email);
    // Verified and claimed: written.
    expect(userId(await login(c, sub, { email: `alice.new@${claimed}`, email_verified: true }))).toBe(user);
    expect(await stored()).toBe(`alice.new@${claimed}`);
  });

  it("a domain claim removed after the callback read the connection no longer links", async () => {
    const { user, email, domain } = await localUser();
    const issuer = `https://idp-${U()}.example.com`;
    const c = await connection(issuer, { emailDomains: [domain] });
    await upsertSsoConnection(c.teamId, input(issuer, { emailDomains: [] }));

    const result = userId(await login(c, `unclaimed-${U()}`, { email, email_verified: true }));

    expect(result).not.toBe(user.id);
    expect(await db.userIdentity.count({ where: { userId: user.id } })).toBe(0);
  });
});
