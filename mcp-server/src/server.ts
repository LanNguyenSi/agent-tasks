import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentTasksClient, type ClientConfig } from "./client.js";
import { buildTools } from "./tools.js";

export const DEFAULT_BASE_URL = "https://agent-tasks.opentriologue.ai";
export const SERVER_NAME = "agent-tasks-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(config: ClientConfig): McpServer {
  const client = new AgentTasksClient(config);
  const tools = buildTools(client);

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
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

  return server;
}

export async function runStdioServer(config: ClientConfig): Promise<void> {
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { AgentTasksClient, type ClientConfig } from "./client.js";
export { buildTools } from "./tools.js";
