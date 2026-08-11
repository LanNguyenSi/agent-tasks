// Coupling test: nothing else in the suite pins the actual MCP-registered
// tool callback's emitted `content[0].text` to serializeResult(result). The
// receipt-budget tests in receipt.test.ts and tools.test.ts all measure
// `serializeResult(handlerReturnValue)` directly, never the real callback
// registered with McpServer.registerTool in server.ts. Decoupling
// serializeResult from that callback (e.g. swapping in a different
// stringify) would leave every other test green while silently changing
// the real wire payload. This test drives the actual registered callback
// end-to-end over an in-memory MCP client/server pair, the smallest
// faithful harness over createServer available from the SDK.

import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, serializeResult } from "../src/server.js";

describe("createServer tool callback wiring", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits content[0].text equal to serializeResult(result) through the real registered tool callback, for a nested-object result", async () => {
    const backendBody = { task: { id: "t1", status: "open" } };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(backendBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const server = createServer({ baseUrl: "https://example.test", token: "tok_abc" });
    const client = new Client({ name: "server-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "task_abandon",
        arguments: { taskId: "11111111-1111-1111-1111-111111111111" },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("text");
      // The receipt for task_abandon is `{ ok: true, task: { id, status } }`,
      // a nested object: serializeResult pretty-prints it (2-space indent,
      // real newlines). This is the exact transform under test, so assert
      // equality against serializeResult itself, not a hand-rolled compact
      // JSON.stringify that would pass even if the callback stopped
      // pretty-printing.
      const expectedText = serializeResult({ ok: true, task: { id: "t1", status: "open" } });
      expect(content[0].text).toBe(expectedText);
      expect(content[0].text).toContain("\n");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
