import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  config: { GROUNDING_RUNTIME_CONFIG: "", CORS_ORIGINS: "http://localhost", PORT: 3001 },
  db: { $queryRaw: vi.fn(), $disconnect: vi.fn(), project: { findMany: vi.fn() } },
  serve: vi.fn(), app: vi.fn(() => ({ fetch: vi.fn() })), sweep: vi.fn(), error: vi.fn(),
}));
vi.mock("../../src/config/index.js", () => ({ config: state.config }));
vi.mock("../../src/lib/prisma.js", () => ({ prisma: state.db }));
vi.mock("@hono/node-server", () => ({ serve: state.serve }));
vi.mock("../../src/app.js", () => ({ createApp: state.app }));
vi.mock("../../src/lib/logger.js", () => ({ logger: { error: state.error, info: vi.fn() } }));
vi.mock("../../src/services/idempotency-sweep.js", () => ({ scheduleIdempotencySweep: state.sweep }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  state.config.GROUNDING_RUNTIME_CONFIG = "";
  state.db.$queryRaw.mockReset().mockResolvedValue([{ present: false }]);
  state.db.project.findMany.mockReset().mockResolvedValue([]);
  state.db.$disconnect.mockResolvedValue(undefined);
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());

it("imports the actual entry point and waits for the disabled-state read before app, listen or sweep", async () => {
  let finish!: (value: unknown) => void;
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  state.db.$queryRaw.mockImplementation(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
  const startup = import("../../src/server.js");
  await reached;
  expect(state.app).not.toHaveBeenCalled(); expect(state.serve).not.toHaveBeenCalled(); expect(state.sweep).not.toHaveBeenCalled();
  finish([{ present: false }]); await startup;
  expect(state.app).toHaveBeenCalledWith("http://localhost", undefined, undefined, undefined);
  expect(state.serve).toHaveBeenCalledTimes(1); expect(state.sweep).toHaveBeenCalledTimes(1);
  expect(process.exit).not.toHaveBeenCalled();
});

it.each(["history", "query error", "missing result", "malformed", "private", "unknown"])("actual entry refuses %s with no listener, fallback or sweep", async condition => {
  if (condition === "history") state.db.$queryRaw.mockResolvedValue([{ present: true }]);
  if (condition === "query error") state.db.$queryRaw.mockRejectedValue(new Error("sensitive database detail"));
  if (condition === "missing result") state.db.$queryRaw.mockResolvedValue([]);
  if (condition === "malformed") state.config.GROUNDING_RUNTIME_CONFIG = " ";
  if (condition === "private") state.config.GROUNDING_RUNTIME_CONFIG = '{"enabled":false,"privateKey":"secret"}';
  if (condition === "unknown") state.config.GROUNDING_RUNTIME_CONFIG = '{"enabled":false,"typo":true}';
  await import("../../src/server.js");
  expect(state.app).not.toHaveBeenCalled(); expect(state.serve).not.toHaveBeenCalled(); expect(state.sweep).not.toHaveBeenCalled();
  expect(process.exit).toHaveBeenCalledWith(1); expect(state.db.$disconnect).toHaveBeenCalledOnce();
  expect(state.error).toHaveBeenCalledWith("Backend startup refused: grounding configuration or database prerequisites unavailable");
});

it("actual enabled entry wires grouped completion, creation and migration on the same database", async () => {
  state.config.GROUNDING_RUNTIME_CONFIG = '{"enabled":true,"audience":"consumer.test","trust":[],"creationPolicy":[]}';
  state.db.$queryRaw.mockResolvedValue([{ count: 9n }]);
  await import("../../src/server.js");
  const { GroundingAttemptsService } = await import("../../src/services/grounding-attempts.js");
  const { GroundingGithubMergeService } = await import("../../src/services/grounding-github-merge.js");
  const { GroundingGithubCreateService } = await import("../../src/services/grounding-github-create.js");
  const { GroundingMigrationService } = await import("../../src/services/grounding-migration.js");
  const args = state.app.mock.calls[0] as unknown as [string, unknown, { db: unknown; service: unknown; githubCreate: unknown; creationPolicy: unknown }, unknown];
  expect(args[1]).toBeInstanceOf(GroundingAttemptsService);
  expect(args[2].service).toBeInstanceOf(GroundingGithubMergeService);
  expect(args[2].githubCreate).toBeInstanceOf(GroundingGithubCreateService);
  expect(args[2].db).toBe(state.db); expect(args[2].creationPolicy).toEqual([]);
  expect(args[3]).toBeInstanceOf(GroundingMigrationService);
  expect(state.serve).toHaveBeenCalledOnce(); expect(state.sweep).toHaveBeenCalledOnce();
});

it("actual enabled entry refuses missing SQL installation before listening", async () => {
  state.config.GROUNDING_RUNTIME_CONFIG = '{"enabled":true,"audience":"consumer.test","trust":[],"creationPolicy":[]}';
  state.db.$queryRaw.mockResolvedValue([{ count: 8n }]);
  await import("../../src/server.js");
  expect(state.app).not.toHaveBeenCalled(); expect(state.serve).not.toHaveBeenCalled(); expect(state.sweep).not.toHaveBeenCalled();
  expect(process.exit).toHaveBeenCalledWith(1);
});

it("retains sanitized nonzero exit when disconnect also fails", async () => {
  state.db.$queryRaw.mockRejectedValue(new Error("private database error"));
  state.db.$disconnect.mockRejectedValue(new Error("private disconnect error"));
  await import("../../src/server.js");
  expect(process.exit).toHaveBeenCalledWith(1);
  expect(state.error).toHaveBeenCalledTimes(1); expect(state.serve).not.toHaveBeenCalled();
});

it("the executed disabled sentinel covers every mapped Grounding schema model in one statement", async () => {
  await import("../../src/server.js");
  const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
  const tables = [...schema.matchAll(/model Grounding\w+\s*\{([\s\S]*?)\n\}/g)].map(match => /@@map\("([^"]+)"\)/.exec(match[1]!)![1]);
  const query = state.db.$queryRaw.mock.calls[0]![0] as { sql: string };
  expect([...query.sql.matchAll(/FROM (grounding_[a-z_]+)/g)].map(match => match[1]).sort()).toEqual(tables.sort());
  expect(tables).toHaveLength(15); expect(state.db.$queryRaw).toHaveBeenCalledOnce();
});
