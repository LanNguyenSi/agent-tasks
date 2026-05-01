/**
 * Configuration loader.
 *
 * Priority: env vars > config file > defaults
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Config {
  endpoint: string;
  token: string;
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
