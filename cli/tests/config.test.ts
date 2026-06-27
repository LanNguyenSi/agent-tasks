import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, statSync } from "node:fs";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => {
      throw new Error("config file disabled in tests");
    }),
    statSync: vi.fn(() => ({ mode: 0o600 })),
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

describe("config file permission warning (M7)", () => {
  const origEnv = { ...process.env };
  const origPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    // env present so loadConfig doesn't exit; the file existing triggers the
    // permission check regardless of where the values come from.
    process.env.AGENT_TASKS_ENDPOINT = "https://example.com";
    process.env.AGENT_TASKS_TOKEN = "test-token";
    vi.mocked(existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    process.env = { ...origEnv };
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(statSync).mockReturnValue({ mode: 0o600 } as ReturnType<typeof statSync>);
  });

  it("warns when the config file is group/other-readable (0644)", async () => {
    vi.mocked(statSync).mockReturnValue({ mode: 0o644 } as ReturnType<typeof statSync>);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { loadConfig } = await import("../src/config.js");
    loadConfig();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("chmod 600"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("644"));
    errSpy.mockRestore();
  });

  it("does not warn when the config file is 0600", async () => {
    vi.mocked(statSync).mockReturnValue({ mode: 0o600 } as ReturnType<typeof statSync>);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { loadConfig } = await import("../src/config.js");
    loadConfig();

    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("skips the permission check on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.mocked(statSync).mockReturnValue({ mode: 0o644 } as ReturnType<typeof statSync>);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { loadConfig } = await import("../src/config.js");
    loadConfig();

    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
