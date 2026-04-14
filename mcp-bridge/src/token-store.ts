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

export async function resolveTokenStore(options?: {
  envToken?: string | undefined;
  filePath?: string;
}): Promise<TokenStore> {
  const envToken = options?.envToken ?? process.env.AGENT_TASKS_TOKEN;
  if (envToken && envToken.length > 0) {
    return new EnvStore(envToken);
  }

  try {
    const mod = (await import("keytar")) as unknown as {
      default?: unknown;
      getPassword?: unknown;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keytar: any = mod.getPassword ? mod : (mod as any).default;
    if (keytar?.getPassword) {
      // Runtime probe: on Linux without libsecret-1 at runtime, keytar
      // imports cleanly but throws on first call. Probe here so we can
      // fall through to FileStore before returning a broken store.
      await keytar.getPassword(SERVICE, ACCOUNT);
      return new KeytarStore(keytar);
    }
  } catch {
    // keytar native module failed to load or probe — fall through to file store
  }

  return new FileStore(options?.filePath ?? fileStorePath());
}

export const __testing = { FileStore, EnvStore, KeytarStore, fileStorePath };
