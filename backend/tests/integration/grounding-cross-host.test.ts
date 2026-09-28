import { generateKeyPairSync, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GroundingReceiptVerificationError, type GroundingReceiptTrustEntry } from "../../src/services/grounding-receipt.js";
import { completionActor, completionFixture, completionStore } from "../helpers/grounding-completion-fixtures.js";

const sentinels = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("../../src/services/grounding-client.js", () => ({ getGroundingClient: sentinels.factory }));

const assessmentEntrypoint = process.env.GROUNDING_TEST_ASSESSMENT_ENTRYPOINT;
const qualified = assessmentEntrypoint ? it : it.skip;
const execFile = promisify(execFileCallback);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const deploymentCheck = fileURLToPath(new URL("../../../scripts/grounding-deployment-check.mjs", import.meta.url));
const sevenAssessmentTools = [
  "assessment_start", "assessment_status", "assessment_advance", "assessment_dossier_add",
  "assessment_dossier_read", "assessment_claim_set", "assessment_export",
];

let store: Awaited<ReturnType<typeof completionStore>>;
let fixture: Awaited<ReturnType<typeof completionFixture>>;

type AssessmentSession = { id: string; revision: number };

function text(result: unknown): string {
  const response = result as { content?: Array<{ type?: unknown; text?: unknown }>; isError?: unknown };
  expect(response.isError).not.toBe(true);
  const content = response.content?.[0];
  expect(content).toMatchObject({ type: "text" });
  if (!content || content.type !== "text" || typeof content.text !== "string") throw new Error("assessment producer returned no text");
  return content.text;
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse(text(await client.callTool({ name, arguments: args }))) as Record<string, unknown>;
}

async function assessment(challenge: Awaited<ReturnType<typeof fixture.attempts.issue>>, complete: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "grounding-assessment-test-"));
  const home = join(directory, "home");
  const state = join(directory, "state");
  const keyPath = join(directory, "issuer.pem");
  const configPath = join(directory, "assessment.json");
  const keys = generateKeyPairSync("ed25519");
  const trust: GroundingReceiptTrustEntry = {
    issuer: "local-test-issuer", kid: "local-test-key",
    publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    profileDigest: challenge.policy.sha256, projectIds: [challenge.projectId], audiences: [challenge.audience],
  };
  await writeFile(keyPath, keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({
    issuer: trust.issuer, kid: trust.kid, privateKeyPath: keyPath, stateDirectory: state, policy: challenge.policy,
  }), { mode: 0o600 });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [assessmentEntrypoint!],
    cwd: directory,
    // Keep the producer process independent of the consumer's database and state.
    env: { PATH: process.env.PATH ?? "", HOME: home, GROUNDING_ASSESSMENT_CONFIG: configPath },
    stderr: "pipe",
  });
  const client = new Client({ name: "grounding-consumer-qualification", version: "1" });
  try {
    await client.connect(transport);
    expect(transport.pid).not.toBe(process.pid);
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([...sevenAssessmentTools].sort());
    for (const forbidden of ["solution_evaluate", "exec", "read_file"]) {
      const denied = await client.callTool({ name: forbidden, arguments: {} });
      expect(denied).toMatchObject({ isError: true });
    }

    const started = await callJson(client, "assessment_start", { challenge, keyword: "service", problem: "The service is not running." });
    let session: AssessmentSession = { id: String(started.id), revision: Number(started.revision) };
    for (const phase of ["scope-resolution", "doc-reading", "playbook-loading", "runtime-inspection", "evidence-collection", "claim-evaluation"]) {
      const next = await callJson(client, "assessment_advance", { sessionId: session.id, expectedRevision: session.revision, expectedPhase: phase });
      session = { id: String(next.id), revision: Number(next.revision) };
    }
    if (complete) {
      const fact = await callJson(client, "assessment_dossier_add", { sessionId: session.id, expectedRevision: session.revision, kind: "fact", content: "The service process is absent.", source: "local qualification" });
      session = { id: String(fact.id), revision: Number(fact.revision) };
      const claim = await callJson(client, "assessment_claim_set", { sessionId: session.id, expectedRevision: session.revision, text: "The service is unavailable." });
      session = { id: String(claim.id), revision: Number(claim.revision) };
    }
    const wire = text(await client.callTool({ name: "assessment_export", arguments: { sessionId: session.id, expectedRevision: session.revision, challenge } }));
    return { wire, session, trust };
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertNoLegacyFallback() {
  expect(fixture.ledger.getLedgerSummary).not.toHaveBeenCalled();
  expect(sentinels.factory).not.toHaveBeenCalled();
}

async function deployment(args: string[], env: Record<string, string> = {}, cwd = tmpdir()) {
  return execFile(process.execPath, [deploymentCheck, ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
}

beforeAll(async () => {
  await execFile("npm", ["run", "build", "--workspace=backend"], { cwd: repositoryRoot, encoding: "utf8" });
  store = await completionStore();
}, 60000);
afterAll(async () => { await store?.close(); });
beforeEach(async () => {
  await store.db.groundingFinalization.deleteMany(); await store.db.groundingOperation.deleteMany();
  await store.db.groundingBinding.updateMany({ data: { activeAttemptId: null } });
  await store.db.groundingReceipt.deleteMany(); await store.db.groundingAttempt.deleteMany();
  await store.db.groundingBinding.deleteMany(); await store.db.groundingCohort.deleteMany();
  await store.db.task.deleteMany(); await store.db.project.deleteMany();
  fixture = await completionFixture(store);
  fixture.now = Math.floor(Date.now() / 1000);
  fixture.ledger.getLedgerSummary.mockReset().mockRejectedValue(new Error("legacy ledger must not run"));
  sentinels.factory.mockReset().mockRejectedValue(new Error("grounding client factory must not run"));
});
afterEach(() => { vi.restoreAllMocks(); });

describe("local separated-process producer qualification", () => {
  qualified("permits protected completion from a genuine producer receipt without legacy fallback", async () => {
    const challenge = await fixture.attempts.issue(fixture.taskId, completionActor, "finish");
    const result = await assessment(challenge, true);
    fixture.issuer.trust = [result.trust];

    await fixture.attempts.ingest(fixture.taskId, challenge.attemptId, completionActor, result.session, result.wire);
    await fixture.service.complete(fixture.taskId, completionActor, randomUUID(), { action: "finish" });

    expect((await fixture.task()).status).toBe("review");
    expect(await store.db.groundingReceipt.count({ where: { taskId: fixture.taskId } })).toBe(1);
    await assertNoLegacyFallback();
  }, 60000);

  qualified("blocks missing, failed, and untrusted producer receipts without legacy fallback", async () => {
    await expect(fixture.service.complete(fixture.taskId, completionActor, randomUUID(), { action: "finish" })).rejects.toMatchObject({ code: "grounding_required" });
    await assertNoLegacyFallback();

    const failedChallenge = await fixture.attempts.issue(fixture.taskId, completionActor, "finish");
    const failed = await assessment(failedChallenge, false);
    fixture.issuer.trust = [failed.trust];
    await expect(fixture.attempts.ingest(fixture.taskId, failedChallenge.attemptId, completionActor, failed.session, failed.wire)).rejects.toMatchObject({ code: "grounding_required" });
    await expect(fixture.service.complete(fixture.taskId, completionActor, randomUUID(), { action: "finish" })).rejects.toMatchObject({ code: "grounding_required" });
    await assertNoLegacyFallback();

    const untrustedChallenge = await fixture.attempts.issue(fixture.taskId, completionActor, "finish");
    const untrusted = await assessment(untrustedChallenge, true);
    const wrongKey = generateKeyPairSync("ed25519");
    fixture.issuer.trust = [{ ...untrusted.trust, publicKeyPem: wrongKey.publicKey.export({ format: "pem", type: "spki" }).toString() }];
    const taskBeforeWrongKey = await fixture.task();
    await expect(fixture.attempts.ingest(fixture.taskId, untrustedChallenge.attemptId, completionActor, untrusted.session, untrusted.wire)).rejects.toBeInstanceOf(GroundingReceiptVerificationError);
    await expect(fixture.service.complete(fixture.taskId, completionActor, randomUUID(), { action: "finish" })).rejects.toMatchObject({ code: "grounding_required" });
    expect(await fixture.task()).toEqual(taskBeforeWrongKey);
    await assertNoLegacyFallback();
  }, 60000);

  it("runs only the bounded inventory command and never authorizes activation", async () => {
    await expect(import(new URL("../../../scripts/grounding-deployment-check.mjs", import.meta.url).href)).resolves.toBeDefined();
    const success = await deployment(["--inventory-only"], { GROUNDING_MIGRATION_DATABASE_URL: store.datasourceUrl });
    expect(JSON.parse(success.stdout)).toMatchObject({ mode: "inventory-only", inventory: { inventoryOnly: true }, activation: { status: "blocked" } });
    await expect(deployment(["--activate"], { GROUNDING_MIGRATION_DATABASE_URL: store.datasourceUrl })).rejects.toMatchObject({ stderr: expect.stringContaining("Usage: grounding-deployment-check") });
    await expect(deployment(["--inventory-only"])).rejects.toMatchObject({ stderr: "Grounding deployment inventory failed\n" });
  }, 30000);
});
