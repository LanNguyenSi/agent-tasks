import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTokenStore, __testing } from "../src/token-store.js";

describe("resolveTokenStore", () => {
  let tmp: string;
  const origEnv = process.env.AGENT_TASKS_TOKEN;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "atb-"));
    delete process.env.AGENT_TASKS_TOKEN;
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    if (origEnv !== undefined) process.env.AGENT_TASKS_TOKEN = origEnv;
  });

  it("returns EnvStore when AGENT_TASKS_TOKEN is set and refuses writes", async () => {
    const store = await resolveTokenStore({
      envToken: "env-token-123",
      filePath: join(tmp, "token"),
    });
    expect(store.kind).toBe("env");
    expect(await store.get()).toBe("env-token-123");
    await expect(store.set("other")).rejects.toThrow(/env var/);
    await expect(store.clear()).rejects.toThrow(/env var/);
  });

  it("FileStore round-trips tokens with 0600 perms and returns null when empty", async () => {
    const path = join(tmp, "nested", "bridge-token");
    const fs = new __testing.FileStore(path);
    expect(await fs.get()).toBeNull();
    await fs.set("secret-xyz");
    expect(await fs.get()).toBe("secret-xyz");
    const st = await stat(path);
    // octal 600 = owner read/write only
    expect(st.mode & 0o777).toBe(0o600);
    const raw = await readFile(path, "utf8");
    expect(raw).toBe("secret-xyz");
    await fs.clear();
    expect(await fs.get()).toBeNull();
  });

  it("FileStore.clear is idempotent when file does not exist", async () => {
    const fs = new __testing.FileStore(join(tmp, "missing"));
    await expect(fs.clear()).resolves.toBeUndefined();
  });
});
