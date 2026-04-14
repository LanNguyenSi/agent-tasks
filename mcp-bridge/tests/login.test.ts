import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin, runLogout } from "../src/login.js";
import { __testing } from "../src/token-store.js";

describe("runLogin", () => {
  let tmp: string;
  const origFetch = globalThis.fetch;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "atb-login-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    globalThis.fetch = origFetch;
  });

  it("stores a valid token via the file store when backend accepts it", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "proj-1", name: "demo" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const store = new __testing.FileStore(join(tmp, "bridge-token"));
    await runLogin({
      baseUrl: "https://fake.local",
      store,
      tokenFromArg: "tok-abc",
    });
    expect(await store.get()).toBe("tok-abc");
    const raw = await readFile(join(tmp, "bridge-token"), "utf8");
    expect(raw).toBe("tok-abc");
  });

  it("refuses to store when backend returns 401", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;

    const store = new __testing.FileStore(join(tmp, "bridge-token"));
    await expect(
      runLogin({
        baseUrl: "https://fake.local",
        store,
        tokenFromArg: "bad-token",
      }),
    ).rejects.toThrow(/HTTP 401/);
    expect(await store.get()).toBeNull();
  });

  it("refuses to store when response shape is unexpected (defends against accidentally-public endpoint)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("hello world", { status: 200 }),
    ) as unknown as typeof fetch;

    const store = new __testing.FileStore(join(tmp, "bridge-token"));
    await expect(
      runLogin({
        baseUrl: "https://fake.local",
        store,
        tokenFromArg: "tok-xyz",
      }),
    ).rejects.toThrow(/shape/);
    expect(await store.get()).toBeNull();
  });

  it("runLogout on an env store prints guidance but does not throw", async () => {
    const envStore = new __testing.EnvStore("env-tok");
    await expect(runLogout(envStore)).resolves.toBeUndefined();
  });
});
