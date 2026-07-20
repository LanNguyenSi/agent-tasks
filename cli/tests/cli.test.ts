import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Subprocess-based tests: the CLI's argument validation lives in commander
// `.action` callbacks that call `process.exit`, which is awkward to unit-test
// in-process. Spawning the built CLI is the cleanest way to verify the
// validation surface from the user's POV.
const CLI = resolve(__dirname, "../dist/index.js");

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  // Provide a dummy endpoint+token so loadConfig succeeds and execution
  // reaches the argument validation under test. Without this the CLI exits
  // early with "No endpoint configured" in any environment that lacks an
  // ambient ~/.agent-tasks.json or AGENT_TASKS_* env (e.g. CI), which made
  // these tests pass only on a developer machine that happened to be
  // configured. env takes priority over the config file, so this is
  // hermetic. The `.invalid` host is never reached: every case here exits
  // on a validation error before the first network call (RFC 6761 reserves
  // `.invalid` so it can never resolve even if one slipped through).
  const res = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_TASKS_ENDPOINT: "https://agent-tasks.invalid",
      AGENT_TASKS_TOKEN: "test-token",
    },
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status };
}

describe("tasks finish argument validation", () => {
  it("rejects --auto-merge combined with --outcome request_changes", () => {
    // Backend's finishReviewSchema rejects this; we surface it at the CLI
    // boundary so the user gets a clean message before any network call.
    const res = run([
      "tasks",
      "finish",
      "00000000-0000-0000-0000-000000000000",
      "--outcome",
      "request_changes",
      "--auto-merge",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--auto-merge is not allowed with --outcome request_changes");
    expect(res.stdout).toBe("");
  });

  it("rejects --pr-url combined with --outcome (work vs review claim mix)", () => {
    const res = run([
      "tasks",
      "finish",
      "00000000-0000-0000-0000-000000000000",
      "--outcome",
      "approve",
      "--pr-url",
      "https://github.com/o/r/pull/1",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Pick one");
  });

  it("rejects an invalid --outcome value", () => {
    const res = run([
      "tasks",
      "finish",
      "00000000-0000-0000-0000-000000000000",
      "--outcome",
      "bogus",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--outcome must be 'approve' or 'request_changes'");
  });

  it("rejects an invalid --merge-method value", () => {
    const res = run([
      "tasks",
      "finish",
      "00000000-0000-0000-0000-000000000000",
      "--outcome",
      "approve",
      "--merge-method",
      "fastforward",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--merge-method must be one of merge, squash, rebase");
  });
});

describe("tasks create option surface", () => {
  // This subprocess check verifies the create-time flags are registered on
  // the command; a regression that drops or renames one would fail here.
  // The api-layer body serialization (debugFlavor / dependsOn reaching the
  // request body) is covered separately by the `createTask` suite in
  // api.test.ts.
  it("registers --debug-flavor / --no-debug-flavor / --depends-on", () => {
    const res = run(["tasks", "create", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("--debug-flavor");
    expect(res.stdout).toContain("--no-debug-flavor");
    expect(res.stdout).toContain("--depends-on");
  });
});

describe("tasks submit-pr argument validation", () => {
  it("rejects a non-integer --pr-number", () => {
    const res = run([
      "tasks",
      "submit-pr",
      "00000000-0000-0000-0000-000000000000",
      "--branch",
      "feat/x",
      "--pr-url",
      "https://github.com/o/r/pull/1",
      "--pr-number",
      "not-a-number",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--pr-number must be a positive integer");
  });
});

describe("tasks list browse-mode argument validation", () => {
  // These checks all run before the first network call, so we don't need a
  // backend stub: a successful exit means we'd hit the network, a non-zero
  // exit with the expected stderr means the guard fired.

  it("rejects --status without --project", () => {
    const res = run(["tasks", "list", "--status", "open"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--status");
    expect(res.stderr).toContain("require --project");
  });

  it("rejects --priority without --project", () => {
    const res = run(["tasks", "list", "--priority", "HIGH"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--priority");
  });

  it("rejects --unclaimed without --project", () => {
    const res = run(["tasks", "list", "--unclaimed"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--unclaimed");
  });

  it("rejects an invalid --status value in browse mode", () => {
    const res = run(["tasks", "list", "--project", "agent-tasks", "--status", "banana"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("invalid status 'banana'");
  });

  it("rejects an invalid --priority value (uppercase enum)", () => {
    const res = run(["tasks", "list", "--project", "agent-tasks", "--priority", "high"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("invalid priority 'high'");
  });

  it("rejects a non-positive --limit", () => {
    const res = run(["tasks", "list", "--project", "agent-tasks", "--limit", "0"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--limit must be a positive integer");
  });
});

describe("tasks respec argument validation", () => {
  const TASK_ID = "00000000-0000-0000-0000-000000000000";
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("rejects when no source is provided (no --description/--template-data/--file)", () => {
    const res = run(["tasks", "respec", TASK_ID]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      "provide at least one of --description, --template-data, or --file",
    );
    expect(res.stdout).toBe("");
  });

  it("rejects --file combined with --description", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-tasks-respec-"));
    const filePath = join(tmpDir, "respec.json");
    writeFileSync(filePath, JSON.stringify({ description: "from file" }));
    const res = run([
      "tasks",
      "respec",
      TASK_ID,
      "--file",
      filePath,
      "--description",
      "inline",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      "--file cannot be combined with --description or --template-data",
    );
  });

  it("rejects --file combined with --template-data", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-tasks-respec-"));
    const filePath = join(tmpDir, "respec.json");
    writeFileSync(filePath, JSON.stringify({ description: "from file" }));
    const res = run([
      "tasks",
      "respec",
      TASK_ID,
      "--file",
      filePath,
      "--template-data",
      "{}",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      "--file cannot be combined with --description or --template-data",
    );
  });

  it("rejects invalid JSON in --template-data", () => {
    const res = run(["tasks", "respec", TASK_ID, "--template-data", "{not json"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--template-data must be a valid JSON object string");
  });

  it("rejects a non-object --template-data value", () => {
    const res = run(["tasks", "respec", TASK_ID, "--template-data", "[1,2,3]"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--template-data must be a valid JSON object string");
  });

  it("rejects a missing --file path", () => {
    const res = run(["tasks", "respec", TASK_ID, "--file", "/nonexistent/path/respec.json"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("could not read --file");
  });

  it("rejects a --file with invalid JSON content", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-tasks-respec-"));
    const filePath = join(tmpDir, "respec.json");
    writeFileSync(filePath, "{not json");
    const res = run(["tasks", "respec", TASK_ID, "--file", filePath]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("is not valid JSON");
  });

  it("rejects a --file with neither description nor templateData", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-tasks-respec-"));
    const filePath = join(tmpDir, "respec.json");
    writeFileSync(filePath, JSON.stringify({ foo: "bar" }));
    const res = run(["tasks", "respec", TASK_ID, "--file", filePath]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("must contain 'description' and/or 'templateData'");
  });

  it("documents the open+unclaimed state guard and the creator/flag rule in --help", () => {
    const res = run(["tasks", "respec", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("open and unclaimed");
    expect(res.stdout).toContain("allowNonCreatorRespec");
    expect(res.stdout).toContain("--description");
    expect(res.stdout).toContain("--template-data");
    expect(res.stdout).toContain("--file");
  });
});
