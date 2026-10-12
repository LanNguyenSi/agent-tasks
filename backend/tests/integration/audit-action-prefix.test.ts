/**
 * GET /projects/:projectId/audit?actionPrefix= against a real database: only
 * rows of the project whose action starts with the prefix come back, and the
 * underscore in a prefix is matched literally.
 */
import { type PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { completionStore, completionFixture } from "../helpers/grounding-completion-fixtures.js";
import { ids } from "../helpers/grounding-fixtures.js";
import type { AppVariables } from "../../src/types/hono.js";

const harness = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, p) => {
        const v = Reflect.get(harness.db!, p);
        return typeof v === "function" ? v.bind(harness.db) : v;
      },
    },
  ),
}));
import { auditRouter } from "../../src/routes/audit.js";

let store: Awaited<ReturnType<typeof completionStore>>;
let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  store = await completionStore();
  harness.db = store.db;
  const f = await completionFixture(store);
  const g = await completionFixture(store);
  projectId = f.projectId;
  otherProjectId = g.projectId;
  const rows = [
    [projectId, "signal.webhook_delivered"],
    [projectId, "signal.webhook_failed"],
    [projectId, "task.created"],
    [projectId, "workflow.updated"],
    [projectId, "signalXwebhook_probe"],
    [otherProjectId, "signal.webhook_failed"],
  ] as const;
  for (const [pid, action] of rows) {
    await store.db.auditLog.create({ data: { project: { connect: { id: pid } }, action, actor: { connect: { id: ids.user } }, payload: {} } });
  }
}, 60000);
afterAll(async () => {
  await store?.close();
});

async function actions(query: string): Promise<string[]> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", { type: "human", userId: ids.user, teamId: ids.team } as AppVariables["actor"]);
    await next();
  });
  app.route("/api", auditRouter);
  const res = await app.request(`/api/projects/${projectId}/audit${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { logs: { action: string }[] };
  return body.logs.map((l) => l.action).sort();
}

describe("audit actionPrefix (real database)", () => {
  it("returns every row of the project without a prefix", async () => {
    expect(await actions("")).toHaveLength(5);
  });

  it("keeps only the project's rows that start with the prefix", async () => {
    expect(await actions("?actionPrefix=signal.webhook_")).toEqual([
      "signal.webhook_delivered",
      "signal.webhook_failed",
    ]);
    expect(await actions("?actionPrefix=workflow.")).toEqual(["workflow.updated"]);
  });

  it("treats the underscore as a literal character, not a one-character wildcard", async () => {
    expect(await actions("?actionPrefix=signal_webhook")).toEqual([]);
    expect(await actions("?actionPrefix=signalX")).toEqual(["signalXwebhook_probe"]);
  });

  it("returns an empty list for a prefix nothing matches", async () => {
    expect(await actions("?actionPrefix=nothing.")).toEqual([]);
  });
});
