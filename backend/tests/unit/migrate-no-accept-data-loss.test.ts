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
    it(`${file} has no --accept-data-loss or --force-reset outside comments`, () => {
      const hits = nonCommentLines(read(file)).filter(
        (l) => l.includes("--accept-data-loss") || l.includes("--force-reset"),
      );
      expect(hits).toEqual([]);
    });
  }

  // The whole CMD is pinned: any extra operator (`||`, `;`, `|`), flag or
  // reordering changes fail-closed behaviour, so a change here has to be a
  // deliberate edit of this expectation.
  it("Dockerfile.migrate CMD is exactly push, fence SQL, claim repair joined by &&", () => {
    const cmdLines = nonCommentLines(read("Dockerfile.migrate")).filter((l) =>
      l.trimStart().startsWith("CMD "),
    );
    expect(cmdLines).toHaveLength(1);
    const schema = "--schema=/app/backend/prisma/schema.prisma";
    const sh = [
      `npx prisma db push ${schema} --skip-generate`,
      `npx prisma db execute ${schema} --file=/app/backend/prisma/grounding-github-fence.sql`,
      `npx prisma db execute ${schema} --file=/app/backend/prisma/clear-terminal-claims.sql`,
    ].join(" && ");
    expect(cmdLines[0].trim()).toBe(`CMD ["sh", "-c", "${sh}"]`);
  });
});
