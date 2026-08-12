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
import { HANDSHAKE_PRIMER, WORKFLOW_PRIMER } from "../src/primer.js";

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

  // rc-v1-C004 (docs/response-contract-v1.md's "Onboarding channels by rate
  // of change" table): system/lifecycle/verb-order knowledge is sent once
  // per session via the MCP `initialize` handshake's `instructions` field,
  // instead of being replayed on every task_start response. This drives the
  // real handshake over the same in-memory client/server pair as the test
  // above, rather than asserting on the string passed into `new McpServer`
  // in isolation, so a regression in how the SDK surfaces `instructions`
  // through `initialize` would be caught here.
  it("carries HANDSHAKE_PRIMER as the initialize.instructions field over a real handshake", async () => {
    const server = createServer({ baseUrl: "https://example.test", token: "tok_abc" });
    const client = new Client({ name: "server-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(client.getInstructions()).toBe(HANDSHAKE_PRIMER);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // rc-v1-C004 review round 1, additional test A: workflow_primer's handler
  // returns a plain string (`async () => WORKFLOW_PRIMER`), so
  // serializeResult's string branch (return the string as-is, no
  // JSON.stringify) is the one on the wire for this tool specifically.
  // Nothing else in the suite drives that branch through the real
  // registered callback end-to-end; the other tools here all return
  // objects, exercising the JSON.stringify branch instead.
  it("emits WORKFLOW_PRIMER verbatim as content[0].text for the workflow_primer tool (guards serializeResult's string branch)", async () => {
    const server = createServer({ baseUrl: "https://example.test", token: "tok_abc" });
    const client = new Client({ name: "server-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "workflow_primer", arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("text");
      expect(content[0].text).toBe(WORKFLOW_PRIMER);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // rc-v1-C007: createServer's optional { legacy?: boolean } is a thin
  // passthrough to buildTools (tools.ts), whose own registration-filtering
  // logic has dedicated unit coverage (tests/tools.test.ts). This proves
  // the option actually reaches the real MCP-registered tool list over a
  // real handshake, not just at the buildTools call boundary: the DEFAULT
  // case here (tasks_claim absent from a real client.listTools()) is the
  // end-to-end counterpart to mcp-bridge's governance test, which drives
  // the LEGACY case (createServer(config, { legacy: true })) the same way.
  it("createServer's default mode omits a pruned v1 verb (tasks_claim) from the real, negotiated tools/list", async () => {
    const server = createServer({ baseUrl: "https://example.test", token: "tok_abc" });
    const client = new Client({ name: "server-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      expect(names).not.toContain("tasks_claim");
      expect(names).toContain("task_start");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
