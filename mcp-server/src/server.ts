import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentTasksClient, type ClientConfig } from "./client.js";
import { buildTools } from "./tools.js";
import { HANDSHAKE_PRIMER } from "./primer.js";

export const DEFAULT_BASE_URL = "https://agent-tasks.opentriologue.ai";
export const SERVER_NAME = "agent-tasks-mcp";
export const SERVER_VERSION = "0.13.0";

// Wire-format serializer: the exact transform applied to every tool
// handler's return value before it goes out as the MCP text block. Exported
// so tests measuring a receipt's emitted size (the response-contract-v1.md
// token budgets) serialize through this same function instead of a
// hand-rolled compact JSON.stringify that would under-measure the real,
// pretty-printed payload and let a budget regression slip past the suite.
export function serializeResult(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

export function createServer(config: ClientConfig, options?: { legacy?: boolean }): McpServer {
  const client = new AgentTasksClient(config);
  const tools = buildTools(client, options);

  // docs/response-contract-v1.md's "Onboarding channels by rate of change":
  // system/lifecycle/verb-order knowledge is sent once per session via this
  // `instructions` field instead of being replayed on every write-verb
  // response. See primer.ts for the budgeted text and its `workflow_primer`
  // on-demand companion (registered below via buildTools).
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    { instructions: HANDSHAKE_PRIMER },
  );

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
                text: serializeResult(result),
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

  return server;
}

export async function runStdioServer(
  config: ClientConfig,
  options?: { legacy?: boolean },
): Promise<void> {
  const server = createServer(config, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { AgentTasksClient, type ClientConfig } from "./client.js";
export { buildTools } from "./tools.js";
