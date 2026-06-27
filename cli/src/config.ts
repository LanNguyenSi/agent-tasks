/**
 * Configuration loader.
 *
 * Priority: env vars > config file > defaults
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Config {
  endpoint: string;
  token: string;
}

/**
 * Warn (do not refuse) when the config file — which holds an API token — is
 * readable by group/other. POSIX-only: mode bits are not meaningful on
 * Windows. The CLI never writes this file (the user creates it), so this is
 * the read-side half of the 0600 guard; it mirrors the mcp-bridge token-store
 * which writes its file 0600.
 */
function warnIfInsecurePermissions(path: string): void {
  if (process.platform === "win32") return;
  try {
    const mode = statSync(path).mode;
    if (mode & 0o077) {
      const octal = (mode & 0o777).toString(8).padStart(3, "0");
      console.error(
        `Warning: ${path} is mode ${octal} and holds an API token; it should not be accessible by other users. Run: chmod 600 ${path}`,
      );
    }
  } catch {
    // stat failed (TOCTOU race, removed file, no permission) — the check is
    // best-effort, so skip the warning rather than disrupt config loading.
    return;
  }
}

function findConfigFile(): string | null {
  const candidates = [
    join(homedir(), ".agent-tasks.json"),
    join(homedir(), ".config", "agent-tasks", "config.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function loadConfigFile(): Partial<Config> {
  const path = findConfigFile();
  if (!path) return {};
  warnIfInsecurePermissions(path);
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      endpoint: parsed.endpoint,
      token: parsed.token,
    };
  } catch {
    return {};
  }
}

export function loadConfig(): Config {
  const file = loadConfigFile();
  const endpoint = process.env.AGENT_TASKS_ENDPOINT ?? file.endpoint ?? "";
  const token = process.env.AGENT_TASKS_TOKEN ?? file.token ?? "";

  if (!endpoint) {
    console.error("Error: No endpoint configured. Set AGENT_TASKS_ENDPOINT or add endpoint to ~/.agent-tasks.json");
    process.exit(1);
  }
  if (!token) {
    console.error("Error: No token configured. Set AGENT_TASKS_TOKEN or add token to ~/.agent-tasks.json");
    process.exit(1);
  }

  return { endpoint: endpoint.replace(/\/$/, ""), token };
}
