import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStatus } from "../src/login.js";
import { resolveTokenStore, noTokenAvailableMessage } from "../src/token-store.js";

// Simulates keytar being present at import time but broken on every real
// call (the exact "keytar kaputt" dogfood symptom): the module loads
// cleanly, so a naive "does import throw?" check would still pick keytar,
// but every getPassword/setPassword/deletePassword call rejects.
const getPassword = vi.fn(async () => {
  throw new Error("keytar native module broken (simulated)");
});
const setPassword = vi.fn(async () => {
  throw new Error("keytar native module broken (simulated)");
});
const deletePassword = vi.fn(async () => {
  throw new Error("keytar native module broken (simulated)");
});

// Mirror both the named-export and default-export shapes: real keytar is a
// CJS module, and depending on the Node ESM interop path (cjs-module-lexer
// static analysis vs. plain default), src/token-store.ts's resolver may see
// either `mod.getPassword` directly or `mod.default.getPassword`.
vi.mock("keytar", () => ({
  getPassword,
  setPassword,
  deletePassword,
  default: { getPassword, setPassword, deletePassword },
}));

describe("token resolution degrades gracefully when keytar is broken", () => {
  let tmp: string;
  let filePath: string;
  const origEnv = process.env.AGENT_TASKS_TOKEN;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "atb-multi-"));
    filePath = join(tmp, "bridge-token");
    delete process.env.AGENT_TASKS_TOKEN;
    getPassword.mockClear();
    setPassword.mockClear();
    deletePassword.mockClear();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    if (origEnv !== undefined) process.env.AGENT_TASKS_TOKEN = origEnv;
  });

  it("AC1: keytar throws on read + a valid token file exists -> status resolves via file, not 'No token stored'", async () => {
    await writeFile(filePath, "valid-token-from-file-1234\n");
    const store = await resolveTokenStore({ filePath });

    const token = await store.get();
    expect(token).toBe("valid-token-from-file-1234");
    expect(store.kind).toBe("file");

    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    try {
      await runStatus("https://fake.local", store);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    const combined = writes.join("");
    expect(combined).not.toMatch(/No token stored/);
    expect(combined).toMatch(/ok \(store: file\)/);
  });

  it("AC2: login writes the file when keytar is dead, and a subsequent no-env status reads it back", async () => {
    const { runLogin } = await import("../src/login.js");
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const loginStore = await resolveTokenStore({ filePath });
    await runLogin({
      baseUrl: "https://fake.local",
      store: loginStore,
      tokenFromArg: "tok-written-via-file-fallback",
    });
    expect(loginStore.kind).toBe("file");

    // Fresh resolution, as a separate CLI invocation would do.
    const statusStore = await resolveTokenStore({ filePath });
    const token = await statusStore.get();
    expect(token).toBe("tok-written-via-file-fallback");
    expect(statusStore.kind).toBe("file");
  });

  it("AC3: no token from any source -> error names env, keychain, and file with remedies (not a keytar-only message)", async () => {
    // No env, keytar always throws, no file written.
    const store = await resolveTokenStore({ filePath });
    const token = await store.get();
    expect(token).toBeNull();

    const msg = noTokenAvailableMessage(filePath);
    expect(msg).toMatch(/AGENT_TASKS_TOKEN/);
    expect(msg).toMatch(/keychain/i);
    expect(msg).toMatch(/file/i);
    expect(msg).toMatch(/login/);
    expect(msg).not.toMatch(/^No token stored \(keytar\)/);
  });

  it("AC4: token values are never present in status output, on success or failure", async () => {
    const secret = "super-secret-token-value-zzz";
    await writeFile(filePath, `${secret}\n`);
    const store = await resolveTokenStore({ filePath });

    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

    // Failure path: backend rejects the token.
    globalThis.fetch = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    try {
      await runStatus("https://fake.local", store);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    const combined = writes.join("");
    expect(combined).not.toContain(secret);
  });

  it("clear() removes both the keytar entry attempt and the file, so a stale file token cannot resurface", async () => {
    await writeFile(filePath, "stale-file-token-abc\n");
    const store = await resolveTokenStore({ filePath });
    await store.clear();
    expect(deletePassword).toHaveBeenCalled();
    const token = await store.get();
    expect(token).toBeNull();
  });
});
