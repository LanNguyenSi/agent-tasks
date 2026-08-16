import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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

// A handful of tests below need a real response body (a confidence envelope,
// a task-search pool, a project record) rather than the `.invalid` host's
// guaranteed network failure. A tiny local HTTP stub gives them that while
// still exercising the exact same compiled CLI binary as every other test in
// this file -- unlike an in-process fetch mock, it needs no access to
// index.ts's module-scope Commander program (which self-executes
// `parseAsync()` against `process.argv` on import) and so needs no import
// gymnastics to reset between cases.
function startStubServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ endpoint: string; close: () => Promise<void> }> {
  return new Promise((resolvePromise) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolvePromise({
        endpoint: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

// Async on purpose: these callers also run a `node:http` stub server in
// this SAME test process. `spawnSync` blocks the whole event loop of the
// calling process until the child exits -- including the stub server's own
// loop -- so a spawnSync'd child waiting on a response from a same-process
// server deadlocks (confirmed by hand: a direct child process round-trips
// in milliseconds; wrapped in spawnSync from inside another Node process it
// hangs until the spawnSync timeout with zero output). `spawn` doesn't
// block, so the stub server stays free to answer while we await the child.
function runAgainst(
  endpoint: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn("node", [CLI, ...args], {
      env: { ...process.env, AGENT_TASKS_ENDPOINT: endpoint, AGENT_TASKS_TOKEN: "test-token" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (status) => {
      resolvePromise({ stdout, stderr, status });
    });
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
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

describe("--json/--quiet mutual exclusion (e7911cdd)", () => {
  // Decided as a hard error rather than "quiet wins": see the comment on
  // `getMode` in index.ts. The check fires before any network call, so a
  // *mutating* command can't run its side effect and then fail to render.
  // `tasks list` needs no endpoint reachability either way, since the
  // conflict is caught before `getClaimableTasks` -- the `.invalid` host is
  // never contacted.

  it("rejects --json combined with --quiet on a read command (tasks list)", () => {
    const res = run(["tasks", "list", "--json", "--quiet"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--json and --quiet are mutually exclusive");
    expect(res.stdout).toBe("");
  });

  it("rejects --json combined with --quiet on a mutating command (tasks finish) before any network call", () => {
    const res = run([
      "tasks",
      "finish",
      "00000000-0000-0000-0000-000000000000",
      "--json",
      "--quiet",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--json and --quiet are mutually exclusive");
    expect(res.stdout).toBe("");
  });

  it("accepts --json alone", () => {
    // Genuinely reaches the network (the `.invalid` host never resolves),
    // so assert the actual network-failure stderr rather than only the
    // absence of "mutually exclusive" -- that weaker assertion would also
    // pass if the command failed for an unrelated reason before ever
    // reaching the mutual-exclusion check or the network call.
    const res = run(["tasks", "list", "--json"]);
    expect(res.stderr).not.toContain("mutually exclusive");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("fetch failed");
  });

  it("accepts --quiet alone", () => {
    const res = run(["tasks", "list", "--quiet"]);
    expect(res.stderr).not.toContain("mutually exclusive");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("fetch failed");
  });
});

describe("tasks create -- confidence exit code", () => {
  it("exits 0 even when the returned confidence.blocking is true (informational score, not a gate)", async () => {
    const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
    const { endpoint, close } = await startStubServer((req, res) => {
      if (req.method === "POST" && req.url === `/api/projects/${PROJECT_ID}/tasks`) {
        respondJson(res, 200, {
          task: { id: "11111111-1111-1111-1111-111111111111", title: "x", status: "open", priority: "MEDIUM" },
          confidence: {
            score: 10,
            threshold: 60,
            enforcementMode: "WARN",
            blocking: true,
            missing: ["description"],
            findings: [],
            nextActions: ["add a description"],
          },
        });
        return;
      }
      respondJson(res, 404, { error: "not_found" });
    });
    try {
      // A UUID project ref -- `tasks create` skips resolving it via
      // getProject and posts directly, so the stub only needs the one route.
      const res = await runAgainst(endpoint, ["tasks", "create", PROJECT_ID, "--title", "x"]);
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("(blocking)");
    } finally {
      await close();
    }
  });
});

describe("wiring: tasks get <prefix> resolves through resolveTaskId (task e7911cdd)", () => {
  it("resolves a short id prefix to the full task before fetching it", async () => {
    const FULL_ID = "abcdef12-0000-0000-0000-000000000000";
    const { endpoint, close } = await startStubServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "GET" && url.startsWith("/api/tasks/claimable")) {
        // resolveTaskId's search pool -- only reached because the prefix
        // isn't a full UUID.
        respondJson(res, 200, {
          tasks: [{ id: FULL_ID, title: "Only match", status: "open", priority: "LOW" }],
          nextCursor: null,
        });
        return;
      }
      if (req.method === "GET" && url === `/api/tasks/${FULL_ID}`) {
        respondJson(res, 200, { task: { id: FULL_ID, title: "Only match", status: "open", priority: "LOW" } });
        return;
      }
      // If the `resolveTaskId` call were ever dropped from `tasks get`, the
      // raw 8-char prefix would be sent straight to GET /api/tasks/:id
      // instead -- a route this stub does not serve, so the CLI would 404
      // and this test would go red.
      respondJson(res, 404, { error: "not_found" });
    });
    try {
      const res = await runAgainst(endpoint, ["tasks", "get", "abcdef12", "--quiet"]);
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe(FULL_ID);
    } finally {
      await close();
    }
  });
});

describe("wiring: tasks list --project backfills the PROJECT column via withProject (task e7911cdd)", () => {
  it("fills PROJECT even when the browse-mode endpoint doesn't attach it to each row", async () => {
    const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
    const { endpoint, close } = await startStubServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/api/projects/by-slug/my-project") {
        respondJson(res, 200, { project: { id: PROJECT_ID, name: "My Project", slug: "my-project" } });
        return;
      }
      if (req.method === "GET" && url.startsWith(`/api/projects/${PROJECT_ID}/tasks`)) {
        // Deliberately no `project` on the row, mirroring the backend's
        // project-scoped list endpoint (see api.ts withProject's comment).
        respondJson(res, 200, {
          tasks: [{ id: "44444444-4444-4444-4444-444444444444", title: "Task X", status: "open", priority: "LOW" }],
        });
        return;
      }
      respondJson(res, 404, { error: "not_found" });
    });
    try {
      const res = await runAgainst(endpoint, ["tasks", "list", "--project", "my-project"]);
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      // If the `api.withProject(...)` wrapper were ever dropped in favor of
      // the raw taskList, the PROJECT column would render blank instead of
      // the slug and this assertion would go red.
      expect(res.stdout).toContain("my-project");
    } finally {
      await close();
    }
  });
});
