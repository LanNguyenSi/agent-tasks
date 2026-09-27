import { expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { assertGithubFenceInstalled } from "../../src/services/grounding-github-fence.js";

it("requires the hold, migration enrollment and immutable command triggers alongside repository fences", async () => {
  const query = vi.fn().mockResolvedValue([{ count: 9n }]);
  const db = { $queryRaw: query } as unknown as Prisma.TransactionClient;
  await assertGithubFenceInstalled(db);
  expect(query.mock.calls[0][0].join("")).toContain("grounding_hold_task_guard");
  for (const count of [0n, 6n, 7n, 8n]) {
    query.mockResolvedValueOnce([{ count }]);
    await expect(assertGithubFenceInstalled(db)).rejects.toThrow(/not installed/);
  }
});
