import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin, runStatus } from "../src/login.js";
import { resolveTokenStore, noTokenAvailableMessage } from "../src/token-store.js";

// Simulates keytar being present at import time but broken on every real
// call (the exact "keytar kaputt" dogfood symptom): the module loads
// cleanly, so a naive "does import throw?" check would still pick keytar,
// but every getPassword/setPassword/deletePassword call rejects.
//
// `keytarAlive` toggles that behavior mid-test so the write-through
// regression test can simulate keytar recovering and then dying again;
// `keychainValue` is a tiny in-memory stand-in for the OS keychain entry so
// a "healthy" set() is actually observable by a later get().
let keytarAlive = false;
let keychainValue: string | null = null;

const getPassword = vi.fn(async () => {
  if (!keytarAlive) throw new Error("keytar native module broken (simulated)");
  return keychainValue;
});
const setPassword = vi.fn(async (_service: string, _account: string, token: string) => {
  if (!keytarAlive) throw new Error("keytar native module broken (simulated)");
  keychainValue = token;
});
const deletePassword = vi.fn(async () => {
  if (!keytarAlive) throw new Error("keytar native module broken (simulated)");
  keychainValue = null;
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
  const origFetch = globalThis.fetch;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "atb-multi-"));
    filePath = join(tmp, "bridge-token");
    delete process.env.AGENT_TASKS_TOKEN;
    keytarAlive = false;
    keychainValue = null;
    getPassword.mockClear();
    setPassword.mockClear();
    deletePassword.mockClear();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    if (origEnv !== undefined) process.env.AGENT_TASKS_TOKEN = origEnv;
    globalThis.fetch = origFetch;
  });

  it("AC1: keytar throws on read + a valid token file exists -> status resolves via file, not 'No token stored'", async () => {
    await writeFile(filePath, "valid-token-from-file-1234\n");
    const store = await resolveTokenStore({ filePath });

    const token = await store.get();
    expect(token).toBe("valid-token-from-file-1234");
    expect(store.kind).toBe("file");
    // Pin the throw path: without this, the same assertions above would
    // also hold if resolveTokenStore had simply never constructed a
    // keytar-backed store at all (keytarStore === null) — this proves the
    // mocked keytar.getPassword was actually invoked and actually threw.
    expect(getPassword).toHaveBeenCalled();

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
    // Pin the throw path: proves the fallback to file happened because the
    // mocked keytar.setPassword was actually called and actually threw, not
    // because keytarStore was null from the start.
    expect(setPassword).toHaveBeenCalled();

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

    try {
      // Failure path: backend rejects the token.
      globalThis.fetch = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
      await runStatus("https://fake.local", store);

      // Success path: backend accepts the token.
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof fetch;
      await runStatus("https://fake.local", store);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    const combined = writes.join("");
    expect(combined).not.toContain(secret);
    // Confirm both paths actually ran (otherwise the assertion above would
    // pass vacuously).
    expect(combined).toMatch(/validation failed/);
    expect(combined).toMatch(/ok \(store: file\)/);
  });

  it("clear() removes both the keytar entry attempt and the file, so a stale file token cannot resurface", async () => {
    await writeFile(filePath, "stale-file-token-abc\n");
    const store = await resolveTokenStore({ filePath });
    await store.clear();
    expect(deletePassword).toHaveBeenCalled();
    const token = await store.get();
    expect(token).toBeNull();
  });

  it("LOW1 regression: a healthy keytar set() clears the file mirror, so a later keytar death cannot resurface the stale file token", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    // 1. keytar dead -> login writes file token A.
    keytarAlive = false;
    const store1 = await resolveTokenStore({ filePath });
    await runLogin({
      baseUrl: "https://fake.local",
      store: store1,
      tokenFromArg: "token-A-stale-file-value",
    });
    expect(store1.kind).toBe("file");
    expect(await readFile(filePath, "utf8")).toContain("token-A-stale-file-value");

    // 2. keytar recovers -> a fresh login writes keychain token B. The file
    // mirror from step 1 must be cleared so it cannot linger as a stale
    // credential.
    keytarAlive = true;
    const store2 = await resolveTokenStore({ filePath });
    await runLogin({
      baseUrl: "https://fake.local",
      store: store2,
      tokenFromArg: "token-B-fresh-keychain-value",
    });
    expect(store2.kind).toBe("keytar");
    expect(setPassword).toHaveBeenCalled();
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    // 3. keytar dies again -> get() must never return the stale A. With the
    // file mirror cleared in step 2, the only honest outcomes are B (if
    // some other component can still see the keychain) or null — never A.
    keytarAlive = false;
    const store3 = await resolveTokenStore({ filePath });
    const token = await store3.get();
    expect(token).not.toBe("token-A-stale-file-value");
    expect(token).toBeNull();
  });
});
