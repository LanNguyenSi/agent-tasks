import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => {
      throw new Error("config file disabled in tests");
    }),
  };
});

describe("loadConfig", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("loads config from environment variables", async () => {
    process.env.AGENT_TASKS_ENDPOINT = "https://example.com";
    process.env.AGENT_TASKS_TOKEN = "test-token";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.endpoint).toBe("https://example.com");
    expect(config.token).toBe("test-token");
  });

  it("strips trailing slash from endpoint", async () => {
    process.env.AGENT_TASKS_ENDPOINT = "https://example.com/";
    process.env.AGENT_TASKS_TOKEN = "test-token";

    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.endpoint).toBe("https://example.com");
  });

  it("exits if no endpoint configured", async () => {
    delete process.env.AGENT_TASKS_ENDPOINT;
    delete process.env.AGENT_TASKS_TOKEN;

    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    const { loadConfig } = await import("../src/config.js");

    expect(() => loadConfig()).toThrow("exit");
    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });
});
