// Guard: the production migrate path must never accept data loss. A
// destructive schema change has to fail the one-shot `migrate` service (see
// docs/ops-backups.md, "Applying a destructive schema change"), and the SQL
// steps must keep their order after the push.
//
// Run: npx vitest run tests/unit/migrate-no-accept-data-loss.test.ts from
// backend/ (also part of `npm run test --workspace=backend`).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function nonCommentLines(text: string): string[] {
  return text.split("\n").filter((l) => !l.trim().startsWith("#"));
}

describe("migrate does not accept data loss", () => {
  for (const file of [
    "Dockerfile.migrate",
    "docker-compose.prod.yml",
    ".relay.yml",
  ]) {
    it(`${file} has no --accept-data-loss outside comments`, () => {
      const hits = nonCommentLines(read(file)).filter((l) =>
        l.includes("--accept-data-loss"),
      );
      expect(hits).toEqual([]);
    });
  }

  it("Dockerfile.migrate CMD runs push, fence SQL, claim repair in order joined by &&", () => {
    const cmdLine = nonCommentLines(read("Dockerfile.migrate")).find((l) =>
      l.trimStart().startsWith("CMD "),
    );
    expect(cmdLine).toBeDefined();
    const cmd = cmdLine as string;
    const push = cmd.indexOf("prisma db push");
    const fence = cmd.indexOf("grounding-github-fence.sql");
    const claims = cmd.indexOf("clear-terminal-claims.sql");
    expect(push).toBeGreaterThan(-1);
    expect(fence).toBeGreaterThan(push);
    expect(claims).toBeGreaterThan(fence);
    const marker = '"-c", "';
    expect(cmd).toContain(marker);
    const sh = cmd.slice(cmd.indexOf(marker) + marker.length);
    const steps = sh.split(" && ");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain("prisma db push");
    expect(steps[1]).toContain("grounding-github-fence.sql");
    expect(steps[2]).toContain("clear-terminal-claims.sql");
    expect(sh).not.toMatch(/;/);
  });
});
