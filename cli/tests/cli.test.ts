import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Subprocess-based tests: the CLI's argument validation lives in commander
// `.action` callbacks that call `process.exit`, which is awkward to unit-test
// in-process. Spawning the built CLI is the cleanest way to verify the
// validation surface from the user's POV.
const CLI = resolve(__dirname, "../dist/index.js");

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
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
