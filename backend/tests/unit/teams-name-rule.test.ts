/**
 * The team-name rule on both write routes: POST /teams and PATCH /teams/:id
 * share one schema (`teamNameSchema`), so every case runs against both and
 * must give the same answer. Prisma is mocked, like teams-rename.test.ts: the
 * suite pins the route contract; the DB-backed NUL case lives in
 * tests/integration/teams-name-db.test.ts.
 *
 * Code-point semantics: 100 emoji (200 UTF-16 units) are accepted and 101 are
 * refused. A name that is only whitespace, NBSP or format characters (zero
 * width space) is empty; NUL, newline, tab and other C0/C1 control characters
 * inside the name are refused; a normal name keeps its inner spaces and
 * accents and is stored trimmed. An unpaired UTF-16 surrogate (JSON "\ud800")
 * is refused too: Prisma cannot send it to Postgres, so it used to be a 500.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  teamFindUnique: vi.fn(),
  teamUpdate: vi.fn(),
  teamCreate: vi.fn(),
  teamMemberFindUnique: vi.fn(),
  teamMemberCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    team: { findUnique: prismaMocks.teamFindUnique, update: prismaMocks.teamUpdate },
    teamMember: { findUnique: prismaMocks.teamMemberFindUnique },
    $transaction: prismaMocks.transaction,
  },
}));
vi.mock("../../src/services/audit.js", () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import { teamRouter } from "../../src/routes/teams.js";
import {
  TEAM_NAME_CONTROL_MESSAGE,
  TEAM_NAME_DIRECTION_MESSAGE,
  TEAM_NAME_EMPTY_MESSAGE,
  TEAM_NAME_ENCODING_MESSAGE,
  TEAM_NAME_LENGTH_MESSAGE,
  TEAM_NAME_UNASSIGNED_MESSAGE,
} from "../../src/lib/team-name.js";

const TEAM_ID = "team-1";
const ADMIN: Actor = { type: "human", userId: "admin-1" };

function makeApp() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", ADMIN);
    await next();
  });
  app.route("/", teamRouter);
  return app;
}

type Route = "POST /teams" | "PATCH /teams/:id";
const ROUTES: Route[] = ["POST /teams", "PATCH /teams/:id"];

function send(route: Route, name: unknown) {
  const init = (body: unknown, method: string) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return route === "POST /teams"
    ? makeApp().request("/teams", init({ name, slug: "new-team" }, "POST"))
    : makeApp().request(`/teams/${TEAM_ID}`, init({ name }, "PATCH"));
}

/** The name the route handed to Prisma, or undefined when it never got there. */
function storedName(route: Route): string | undefined {
  if (route === "POST /teams") {
    return prismaMocks.teamCreate.mock.calls[0]?.[0]?.data?.name as string | undefined;
  }
  return prismaMocks.teamUpdate.mock.calls[0]?.[0]?.data?.name as string | undefined;
}

function nothingWritten() {
  expect(prismaMocks.teamCreate).not.toHaveBeenCalled();
  expect(prismaMocks.teamUpdate).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.teamFindUnique.mockImplementation(({ where }: { where: { id?: string; slug?: string } }) =>
    Promise.resolve(
      where.id === TEAM_ID ? { id: TEAM_ID, name: "Old Name", slug: "old", createdAt: new Date(0) } : null,
    ),
  );
  prismaMocks.teamMemberFindUnique.mockResolvedValue({ teamId: TEAM_ID, userId: ADMIN.userId, role: "ADMIN" });
  prismaMocks.teamCreate.mockImplementation(({ data }: { data: { name: string; slug: string } }) =>
    Promise.resolve({ id: "new-1", name: data.name, slug: data.slug, createdAt: new Date(0) }),
  );
  prismaMocks.teamMemberCreate.mockResolvedValue({});
  prismaMocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({ team: { create: prismaMocks.teamCreate }, teamMember: { create: prismaMocks.teamMemberCreate } }),
  );
  prismaMocks.teamUpdate.mockImplementation(({ data }: { data: { name: string } }) =>
    Promise.resolve({ id: TEAM_ID, name: data.name, slug: "old", createdAt: new Date(0) }),
  );
});

interface Rejected {
  message: string;
  success: boolean;
  error: { issues: { message: string }[]; name: string };
}

describe.each(ROUTES)("%s: team name rule", (route) => {
  async function expectRejected(name: unknown, message: string) {
    const res = await send(route, name);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Rejected;
    // The shared wire shape is kept; `message` names the first failed rule.
    expect(body.success).toBe(false);
    expect(body.error.name).toBe("ZodError");
    expect(body.error.issues.length).toBeGreaterThan(0);
    expect(body.message).toBe(message);
    nothingWritten();
  }

  async function expectStored(name: unknown, stored: string) {
    const res = await send(route, name);
    expect(res.status).toBe(route === "POST /teams" ? 201 : 200);
    expect(storedName(route)).toBe(stored);
    const body = (await res.json()) as { team: { name: string } };
    expect(body.team.name).toBe(stored);
  }

  it("400s a NUL byte (not a 500)", async () => {
    await expectRejected("Team\u0000Name", TEAM_NAME_CONTROL_MESSAGE);
  });

  it("400s a name that is only a NUL byte", async () => {
    await expectRejected("\u0000", TEAM_NAME_CONTROL_MESSAGE);
  });

  it.each([
    ["newline", "Team\nName"],
    ["carriage return", "Team\rName"],
    ["tab", "Team\tName"],
    ["C0 control (BEL)", "Team\u0007Name"],
    ["C0 control (unit separator)", "Team\u001fName"],
    ["DEL", "Team\u007fName"],
    ["C1 control (NEL)", "Team\u0085Name"],
    ["C1 control (last)", "Team\u009fName"],
  ])("400s a %s inside the name", async (_label, name) => {
    await expectRejected(name, TEAM_NAME_CONTROL_MESSAGE);
  });

  it.each([
    ["a high surrogate inside the name", "A\ud800B"],
    ["a name that is only a high surrogate", "\ud800"],
    ["a low surrogate before text", "\udc00x"],
    ["a high surrogate at the end", "Team\ud83d"],
  ])("400s %s (unpaired surrogate, not a 500)", async (_label, name) => {
    await expectRejected(name, TEAM_NAME_ENCODING_MESSAGE);
  });

  it("accepts a valid surrogate pair next to text", async () => {
    await expectStored("Team \u{1F600}", "Team \u{1F600}");
  });

  it("400s a control character at the edge that trim does not remove", async () => {
    await expectRejected("\u0007Team", TEAM_NAME_CONTROL_MESSAGE);
  });

  it("400s an empty name", async () => {
    await expectRejected("", TEAM_NAME_EMPTY_MESSAGE);
  });

  it("400s a whitespace-only name", async () => {
    await expectRejected("   ", TEAM_NAME_EMPTY_MESSAGE);
  });

  it("400s a whitespace-only name made of newlines and tabs", async () => {
    await expectRejected(" \n\t ", TEAM_NAME_EMPTY_MESSAGE);
  });

  it("400s an NBSP-only name", async () => {
    await expectRejected("  ", TEAM_NAME_EMPTY_MESSAGE);
  });

  it("400s a zero-width-space-only name", async () => {
    await expectRejected("​", TEAM_NAME_EMPTY_MESSAGE);
  });

  it("400s a name of format characters and whitespace only", async () => {
    await expectRejected(" ​ ‍﻿­ ", TEAM_NAME_EMPTY_MESSAGE);
  });

  it.each([
    ["Hangul filler U+3164", "\u3164"],
    ["Hangul choseong filler U+115F", "\u115f"],
    ["Hangul jungseong filler U+1160", "\u1160"],
    ["halfwidth Hangul filler U+FFA0", "\uffa0"],
    ["braille blank U+2800", "\u2800"],
    ["combining acute accent only", "\u0301"],
    ["several combining marks only", "\u0301\u0302\u0303"],
    ["variation selector-16 only", "\ufe0f"],
    ["combining grapheme joiner only", "\u034f"],
    ["supplementary variation selector only", "\u{e0100}"],
    ["fillers mixed with spaces and marks", " \u3164 \u2800\u0301 "],
  ])("400s a name made only of %s", async (_label, name) => {
    await expectRejected(name, TEAM_NAME_EMPTY_MESSAGE);
  });

  it.each([
    ["bidi LRE U+202A", "abc\u202adef"],
    ["bidi RLE U+202B", "abc\u202bdef"],
    ["bidi PDF U+202C", "abc\u202cdef"],
    ["bidi LRO U+202D", "abc\u202ddef"],
    ["bidi RLO U+202E", "abc\u202edef"],
    ["bidi LRI U+2066", "abc\u2066def"],
    ["bidi RLI U+2067", "abc\u2067def"],
    ["bidi FSI U+2068", "abc\u2068def"],
    ["bidi PDI U+2069", "abc\u2069def"],
    ["bidi override at the start of a visible name", "\u202eabc"],
    ["bidi override at the end of a visible name", "abc\u202e"],
    ["line separator U+2028", "a\u2028b"],
    ["paragraph separator U+2029", "a\u2029b"],
  ])("400s %s inside a visible name", async (_label, name) => {
    await expectRejected(name, TEAM_NAME_DIRECTION_MESSAGE);
  });

  it.each([
    ["private use U+E000", "\ue000"],
    ["private use inside a visible name", "ab\ue000cd"],
    ["private use last of the BMP block U+F8FF", "x\uf8ff"],
    ["supplementary private use U+F0000", "x\u{f0000}"],
    ["noncharacter U+FFFE", "\ufffe"],
    ["noncharacter U+FFFF inside a visible name", "a\uffffb"],
    ["noncharacter U+FDD0", "a\ufdd0b"],
    ["noncharacter U+FDEF", "a\ufdefb"],
    ["noncharacter U+1FFFE", "a\u{1fffe}b"],
    ["noncharacter U+10FFFF", "a\u{10ffff}b"],
  ])("400s %s", async (_label, name) => {
    await expectRejected(name, TEAM_NAME_UNASSIGNED_MESSAGE);
  });

  it("accepts a base letter followed by combining marks (decomposed accent)", async () => {
    await expectStored("Cafe\u0301 Team", "Cafe\u0301 Team");
  });

  it("accepts a combining mark after a non-Latin base (Devanagari)", async () => {
    await expectStored("\u0915\u093f", "\u0915\u093f");
  });

  it("accepts emoji: variation selector, ZWJ sequence and a flag", async () => {
    const name = "\u2764\ufe0f \u{1f468}\u200d\u{1f469}\u200d\u{1f467} \u{1f1e9}\u{1f1ea} Team";
    await expectStored(name, name);
  });

  it("accepts code points next to the refused ranges (U+F900 after private use, U+FFFD, U+FDCF, U+FDF0)", async () => {
    await expectStored("a\uf900b\ufffdc\ufdcfd\ufdf0e", "a\uf900b\ufffdc\ufdcfd\ufdf0e");
  });

  it.each([
    ["Thai with vowel and tone marks", "\u0e17\u0e35\u0e21\u0e44\u0e17\u0e22"],
    ["Arabic with harakat", "\u0641\u064e\u0631\u0650\u064a\u0642"],
    ["a keycap emoji", "Team 1\ufe0f\u20e3"],
  ])("accepts %s", async (_label, name) => {
    await expectStored(name, name);
  });

  it("accepts inner spaces and a name with Hangul syllables", async () => {
    await expectStored("Team  \ud300 A", "Team  \ud300 A");
  });

  it("accepts a name that only contains a format character next to visible text", async () => {
    await expectStored("a​b", "a​b");
  });

  it("400s a missing name and a non-string name", async () => {
    expect((await send(route, undefined)).status).toBe(400);
    expect((await send(route, 42)).status).toBe(400);
    nothingWritten();
  });

  it("accepts 100 emoji (code points, not UTF-16 units)", async () => {
    const name = "\u{1F600}".repeat(100);
    expect(name.length).toBe(200);
    await expectStored(name, name);
  });

  it("400s 101 emoji", async () => {
    await expectRejected("\u{1F600}".repeat(101), TEAM_NAME_LENGTH_MESSAGE);
  });

  it("accepts exactly 100 ASCII characters and 400s 101", async () => {
    await expectStored("x".repeat(100), "x".repeat(100));
    vi.clearAllMocks();
    await expectRejected("x".repeat(101), TEAM_NAME_LENGTH_MESSAGE);
  });

  it("measures the length after trimming", async () => {
    await expectStored(` ${"x".repeat(100)} `, "x".repeat(100));
  });

  it("stores a normal name with inner spaces and accents trimmed", async () => {
    await expectStored("  Café  Müller Team \n", "Café  Müller Team");
  });
});
