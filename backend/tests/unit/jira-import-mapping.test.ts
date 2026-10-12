/**
 * Status mapping of the Jira import tool: an agent token (`at_...`) must send
 * `backlog` (the import endpoint rejects any other status from an agent),
 * while a human token keeps the Jira status category map.
 */
import { describe, it, expect } from "vitest";
import {
  isAgentToken,
  mapIssue,
  type JiraIssue,
} from "../../../tools/jira-import/mapping.js";
import { batchImportSchema } from "../../src/routes/tasks.js";

function issue(categoryKey: string | undefined, key = "PROJ-1"): JiraIssue {
  return {
    key,
    fields: {
      summary: "Fix the thing",
      description: null,
      priority: { name: "High" },
      status: categoryKey ? { name: "Whatever", statusCategory: { key: categoryKey } } : undefined,
      labels: ["a"],
      issuetype: { name: "Bug" },
    },
  };
}

describe("jira-import status mapping", () => {
  it.each([
    ["new", "open"],
    ["indeterminate", "in_progress"],
    ["done", "done"],
    [undefined, "open"],
    ["unknown-category", "open"],
  ])("human token: status category %s maps to %s", (category, expected) => {
    expect(mapIssue(issue(category), { agentToken: false }).status).toBe(expected);
    expect(mapIssue(issue(category)).status).toBe(expected);
  });

  it.each(["new", "indeterminate", "done", undefined])(
    "agent token: status category %s maps to backlog",
    (category) => {
      expect(mapIssue(issue(category), { agentToken: true }).status).toBe("backlog");
    },
  );

  it("keeps the other mapped fields unchanged for an agent token", () => {
    const human = mapIssue(issue("done"), { agentToken: false });
    const agent = mapIssue(issue("done"), { agentToken: true });
    expect({ ...agent, status: undefined }).toEqual({ ...human, status: undefined });
    expect(agent.externalRef).toBe("PROJ-1");
    expect(agent.priority).toBe("HIGH");
    expect(agent.labels).toEqual(["a", "type:bug"]);
  });

  it("detects an agent token by its at_ prefix", () => {
    expect(isAgentToken("at_abc123")).toBe(true);
    expect(isAgentToken("eyJhbGciOi.session")).toBe(false);
    expect(isAgentToken("")).toBe(false);
  });

  it("produces a payload the batch import schema accepts for an agent token", () => {
    const tasks = [issue("new", "PROJ-1"), issue("done", "PROJ-2")].map((i) =>
      mapIssue(i, { agentToken: true }),
    );
    const parsed = batchImportSchema.safeParse({ tasks });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tasks.every((t) => t.status === "backlog")).toBe(true);
    }
  });
});
