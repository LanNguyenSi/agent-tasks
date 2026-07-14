import { mkdir, readFile, writeFile, rm, chmod, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const SERVICE = "agent-tasks-mcp-bridge";
const ACCOUNT = "default";

export interface TokenStore {
  kind: "keytar" | "file" | "env";
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

class EnvStore implements TokenStore {
  readonly kind = "env" as const;
  constructor(private readonly value: string) {}
  async get() {
    return this.value;
  }
  async set() {
    throw new Error(
      "Token was provided via AGENT_TASKS_TOKEN env var; refusing to overwrite. Unset the env var to use the keychain store.",
    );
  }
  async clear() {
    throw new Error(
      "Token was provided via AGENT_TASKS_TOKEN env var; nothing to clear in the keychain.",
    );
  }
}

class KeytarStore implements TokenStore {
  readonly kind = "keytar" as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly keytar: any) {}
  async get() {
    return (await this.keytar.getPassword(SERVICE, ACCOUNT)) ?? null;
  }
  async set(token: string) {
    await this.keytar.setPassword(SERVICE, ACCOUNT, token);
  }
  async clear() {
    await this.keytar.deletePassword(SERVICE, ACCOUNT);
  }
}

function fileStorePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "agent-tasks", "bridge-token");
}

class FileStore implements TokenStore {
  readonly kind = "file" as const;
  constructor(private readonly path: string) {}
  async get() {
    try {
      const content = await readFile(this.path, "utf8");
      const trimmed = content.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
  async set(token: string) {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {
      // best-effort on filesystems without POSIX perms (e.g., some Windows)
    });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, token, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => {
      // best-effort
    });
    await rename(tmp, this.path);
  }
  async clear() {
    try {
      await rm(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/**
 * Wraps a keychain store (keytar) with a file-store fallback so token
 * resolution degrades gracefully instead of hard-failing.
 *
 * Unlike the previous design (a one-time startup probe that permanently
 * committed to either KeytarStore or FileStore), this store re-checks on
 * every call: keytar may load fine at startup and still throw later (a
 * flaky native binding, a revoked keychain entitlement, a missing D-Bus
 * session that only manifests on first real use). Every operation tries
 * keytar first and transparently falls back to the file store on any
 * failure or empty result, updating `kind` to reflect where the value
 * actually came from so `status`/`login` report the true source.
 */
class MultiSourceStore implements TokenStore {
  kind: "keytar" | "file";
  constructor(
    private readonly keytarStore: KeytarStore | null,
    private readonly fileStore: FileStore,
  ) {
    this.kind = keytarStore ? "keytar" : "file";
  }

  async get(): Promise<string | null> {
    if (this.keytarStore) {
      try {
        const value = await this.keytarStore.get();
        if (value) {
          this.kind = "keytar";
          return value;
        }
        // keytar reachable but has no entry — still check the file, since a
        // prior login may have written there while keytar was unusable.
      } catch {
        // keytar dead on this call — fall through to file store
      }
    }
    const value = await this.fileStore.get();
    this.kind = "file";
    return value;
  }

  async set(token: string): Promise<void> {
    if (this.keytarStore) {
      try {
        await this.keytarStore.set(token);
        this.kind = "keytar";
        return;
      } catch {
        // keytar dead — fall back to the file store
      }
    }
    await this.fileStore.set(token);
    this.kind = "file";
  }

  async clear(): Promise<void> {
    let clearedKeytar = false;
    if (this.keytarStore) {
      try {
        await this.keytarStore.clear();
        clearedKeytar = true;
      } catch {
        // ignore — keytar dead or nothing stored there
      }
    }
    // Always clear the file too, even when keytar succeeded: a stale file
    // token left over from a period when keytar was unusable must not
    // resurface as a valid credential on a later get().
    await this.fileStore.clear();
    this.kind = clearedKeytar ? "keytar" : "file";
  }
}

/**
 * Human-readable guidance for when no source (env, keychain, file) resolves
 * to a token. Always names all three sources plus the concrete remedy for
 * each — never blames a single source (e.g. "keytar") for what may be a
 * multi-source miss.
 */
export function noTokenAvailableMessage(filePath?: string): string {
  const path = filePath ?? fileStorePath();
  return (
    "No token available from any source: " +
    "env (AGENT_TASKS_TOKEN is not set), " +
    "OS keychain (no entry stored, or the keychain is unavailable), " +
    `file (${path} does not exist or is empty). ` +
    "Fix one of: set AGENT_TASKS_TOKEN, run 'agent-tasks-mcp-bridge login', " +
    `or write the token directly to ${path}.`
  );
}

export async function resolveTokenStore(options?: {
  envToken?: string | undefined;
  filePath?: string;
}): Promise<TokenStore> {
  const envToken = options?.envToken ?? process.env.AGENT_TASKS_TOKEN;
  if (envToken && envToken.length > 0) {
    return new EnvStore(envToken);
  }

  const fileStore = new FileStore(options?.filePath ?? fileStorePath());

  let keytarStore: KeytarStore | null = null;
  try {
    const mod = (await import("keytar")) as unknown as {
      default?: unknown;
      getPassword?: unknown;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keytar: any = mod.getPassword ? mod : (mod as any).default;
    if (keytar?.getPassword) {
      keytarStore = new KeytarStore(keytar);
    }
  } catch {
    // keytar native module failed to load — treat as unavailable, use file store.
    // Any failure that instead surfaces on a real call (not just import) is
    // handled per-call by MultiSourceStore, so no eager probe call is needed
    // here.
    keytarStore = null;
  }

  return new MultiSourceStore(keytarStore, fileStore);
}

export const __testing = {
  FileStore,
  EnvStore,
  KeytarStore,
  MultiSourceStore,
  fileStorePath,
};
