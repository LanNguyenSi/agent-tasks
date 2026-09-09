// T-010 round 2: shell-level test of the "Detect docs/okf-relevant changes"
// step in .github/workflows/okf-literal-guard.yml, replaying its actual
// committed run: script (never a hand-copied string) under
// `bash --noprofile --norc -eo pipefail`, the same invocation GitHub
// Actions' `run:` uses for a step with no `shell:` key on an
// ubuntu-latest/macos runner. Exercises a real scratch git repo so
// `git diff --name-only`/`git cat-file -e` behave exactly as they do in CI.
//
// Regression pin for the round-1 SIGPIPE bug: case 1's changed-file list
// is well over the 64KB a Linux pipe buffers in one write, with the
// relevant file first in the list. Under the pre-fix
// `git diff ... | grep -Eq "$PATTERN"` (and, empirically, the naive
// "capture first, still pipe into grep" form), `grep -q` exits at the
// first match and closes the pipe before the writer finishes, `pipefail`
// turns that SIGPIPE into a pipeline failure, and the step silently
// answers `relevant=false` even though a relevant file was in fact
// changed. Verified directly on a real `ubuntu-latest`-equivalent
// (`ubuntu:24.04`, bash 5.2.21) via Docker during this task, not assumed.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadWorkflow, stepRun } from "../helpers/workflow-yaml.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github/workflows/okf-literal-guard.yml",
);
const RUN_SCRIPT = stepRun(loadWorkflow(WORKFLOW_PATH), "literal-guard", "filter");
// Well past a Linux pipe's 64KB single-write buffer (each filler line is
// ~25 bytes; 3000 lines is ~75KB).
const FILLER_COUNT = 3000;

function git(args: string[], cwd: string): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${res.stderr}`);
  }
  return res.stdout;
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "okf-detect-step-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  return dir;
}

function fillerFiles(prefix: string, count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    files[`${prefix}/file${i}.txt`] = "x";
  }
  return files;
}

/** Writes `files`, commits them all, and returns the new commit's SHA. */
function commitFiles(dir: string, files: Record<string, string>, message: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir).trim();
}

interface DetectResult {
  relevant: string | undefined;
  status: number | null;
  stderr: string;
}

function runDetectStep(opts: {
  cwd: string;
  eventName: "pull_request" | "push";
  baseSha: string;
  headSha: string;
}): DetectResult {
  const scriptPath = path.join(opts.cwd, ".detect-step.sh");
  fs.writeFileSync(scriptPath, RUN_SCRIPT);
  const outputPath = path.join(opts.cwd, ".github-output");
  fs.writeFileSync(outputPath, "");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EVENT_NAME: opts.eventName,
    GITHUB_OUTPUT: outputPath,
    PR_BASE_SHA: "",
    PR_HEAD_SHA: "",
    PUSH_BEFORE_SHA: "",
    GITHUB_SHA: "",
  };
  if (opts.eventName === "pull_request") {
    env.PR_BASE_SHA = opts.baseSha;
    env.PR_HEAD_SHA = opts.headSha;
  } else {
    env.PUSH_BEFORE_SHA = opts.baseSha;
    env.GITHUB_SHA = opts.headSha;
  }

  const res = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", scriptPath],
    { cwd: opts.cwd, env, encoding: "utf8" },
  );
  const output = fs.readFileSync(outputPath, "utf8");
  const match = output.match(/^relevant=(true|false)$/m);
  return { relevant: match?.[1], status: res.status, stderr: res.stderr };
}

describe("okf-literal-guard.yml Detect step (T-010 round 2)", () => {
  it(
    "answers relevant=true for a pull_request diff with one relevant file among >64KB of names",
    () => {
      const dir = makeRepo();
      const base = commitFiles(dir, fillerFiles("irrelevant", FILLER_COUNT), "base");
      const head = commitFiles(
        dir,
        {
          ...fillerFiles("irrelevant2", FILLER_COUNT),
          "mcp-server/src/errors.ts": "export {};\n",
        },
        "head with relevant file amid a large diff",
      );
      const diffSize = git(["diff", "--name-only", base, head], dir).length;
      expect(diffSize).toBeGreaterThan(64 * 1024);
      const result = runDetectStep({
        cwd: dir,
        eventName: "pull_request",
        baseSha: base,
        headSha: head,
      });
      expect(result.status).toBe(0);
      expect(result.relevant).toBe("true");
      fs.rmSync(dir, { recursive: true, force: true });
    },
    20000,
  );

  it("answers relevant=false for an irrelevant-only diff", () => {
    const dir = makeRepo();
    const base = commitFiles(dir, { "irrelevant/a.txt": "x" }, "base");
    const head = commitFiles(dir, { "irrelevant/b.txt": "y" }, "head, irrelevant only");
    const result = runDetectStep({
      cwd: dir,
      eventName: "pull_request",
      baseSha: base,
      headSha: head,
    });
    expect(result.status).toBe(0);
    expect(result.relevant).toBe("false");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to relevant=true for an unresolvable head SHA", () => {
    const dir = makeRepo();
    const base = commitFiles(dir, { "irrelevant/a.txt": "x" }, "base");
    const result = runDetectStep({
      cwd: dir,
      eventName: "pull_request",
      baseSha: base,
      headSha: "f".repeat(40),
    });
    expect(result.status).toBe(0);
    expect(result.relevant).toBe("true");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to relevant=true for the all-zero before SHA on push", () => {
    const dir = makeRepo();
    const head = commitFiles(dir, { "irrelevant/a.txt": "x" }, "only commit");
    const result = runDetectStep({
      cwd: dir,
      eventName: "push",
      baseSha: "0".repeat(40),
      headSha: head,
    });
    expect(result.status).toBe(0);
    expect(result.relevant).toBe("true");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("answers relevant=true for a diff touching only a cited source file", () => {
    const dir = makeRepo();
    const base = commitFiles(dir, { "irrelevant/a.txt": "x" }, "base");
    const head = commitFiles(
      dir,
      { "mcp-server/src/errors.ts": "export class Foo {}\n" },
      "head, cited source file only",
    );
    const result = runDetectStep({
      cwd: dir,
      eventName: "pull_request",
      baseSha: base,
      headSha: head,
    });
    expect(result.status).toBe(0);
    expect(result.relevant).toBe("true");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
