#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentTasksClient } from "./client.js";
import { buildTools } from "./tools.js";

const DEFAULT_BASE_URL = "https://agent-tasks.opentriologue.ai";

function resolveConfig() {
  const token = process.env.AGENT_TASKS_TOKEN;
  if (!token) {
    throw new Error(
      "AGENT_TASKS_TOKEN env var is required. Obtain a token from the agent-tasks UI under Settings → Agent Tokens.",
    );
  }
  const baseUrl = process.env.AGENT_TASKS_BASE_URL ?? DEFAULT_BASE_URL;
  return { token, baseUrl };
}

async function main() {
  const config = resolveConfig();
  const client = new AgentTasksClient(config);
  const tools = buildTools(client);

  const server = new McpServer({
    name: "agent-tasks-mcp",
    version: "0.1.0",
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputShape,
      },
      async (args) => {
        try {
          const result = await tool.handler(args as never);
          return {
            content: [
              {
                type: "text",
                text:
                  typeof result === "string"
                    ? result
                    : JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [{ type: "text", text: message }],
          };
        }
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[agent-tasks-mcp] fatal:", err);
  process.exit(1);
});
