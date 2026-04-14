import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer } from "@agent-tasks/mcp-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * Governance acceptance: when the backend rejects a claim (4xx), the rejection
 * must reach the MCP client as an `isError` tool result — not a silent success.
 *
 * This test wires a real MCP Client ↔ Server over InMemoryTransport, so the
 * tool registration, JSON-RPC framing, and error-wrapping path all execute
 * just as they would over stdio. Only the HTTP boundary (fetch to the
 * agent-tasks backend) is stubbed.
 */
describe("governance: blocked claim surfaces as MCP tool error end-to-end", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/api/tasks/11111111-2222-3333-4444-555555555555/claim")) {
        return new Response(
          JSON.stringify({
            error: "claim_blocked",
            message: "Task blocked by unresolved preconditions",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("propagates the backend 409 body through the MCP tool result", async () => {
    const server = createServer({
      baseUrl: "https://fake.local",
      token: "fake-token",
    });
    const client = new Client(
      { name: "governance-test", version: "0.0.0" },
      { capabilities: {} },
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      expect(names, "claim tool must be discoverable").toContain("tasks_claim");

      const result = await client.callTool({
        name: "tasks_claim",
        arguments: { taskId: "11111111-2222-3333-4444-555555555555" },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const text = content[0]?.text ?? "";
      expect(text).toContain("claim_blocked");
      expect(text).toContain("preconditions");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
