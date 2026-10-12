#!/usr/bin/env -S npx tsx
/**
 * Jira -> agent-tasks Import CLI
 *
 * Fetches issues from Jira via REST API v3 and imports them into agent-tasks
 * via the batch import endpoint.
 *
 * Usage:
 *   # Set credentials via environment variables (recommended):
 *   export JIRA_URL=https://your-org.atlassian.net
 *   export JIRA_EMAIL=you@example.com
 *   export JIRA_TOKEN=ATATT...
 *   export AGENT_TASKS_URL=https://agent-tasks.opentriologue.ai
 *   export AGENT_TASKS_TOKEN=at_...
 *   export PROJECT_ID=<uuid>
 *
 *   npx tsx tools/jira-import/jira-import.ts --jql "project = PROJ AND status != Done" [--dry-run]
 */

import { isAgentToken, mapIssue, type ImportTask, type JiraIssue } from "./mapping";

// -- Types --

interface JiraSearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

interface ImportResponse {
  created: number;
  skipped: number;
  failed: number;
  ids: Array<{ index: number; id: string }>;
  skippedRefs: string[];
  errors: Array<{ index: number; error: string }>;
}

// -- Config --

interface Config {
  jiraUrl: string;
  jiraEmail: string;
  jiraToken: string;
  jql: string;
  agentTasksUrl: string;
  agentTasksToken: string;
  projectId: string;
  dryRun: boolean;
}

function printHelp() {
  console.log(`
Jira -> agent-tasks Import CLI

Usage:
  npx tsx tools/jira-import/jira-import.ts [options]

Options:
  --jql <query>             JQL filter (default: "ORDER BY created DESC")
  --jira-url <url>          Jira base URL (or JIRA_URL env)
  --jira-email <email>      Jira email (or JIRA_EMAIL env)
  --jira-token <token>      Jira API token (or JIRA_TOKEN env, preferred)
  --agent-tasks-url <url>   agent-tasks base URL (or AGENT_TASKS_URL env)
  --agent-tasks-token <t>   agent-tasks API token (or AGENT_TASKS_TOKEN env, preferred)
  --project-id <uuid>       Target project ID (or PROJECT_ID env)
  --dry-run                 Preview mapped tasks without importing
  --help                    Show this help

Environment variables (recommended for tokens):
  JIRA_URL, JIRA_EMAIL, JIRA_TOKEN, JIRA_JQL,
  AGENT_TASKS_URL, AGENT_TASKS_TOKEN, PROJECT_ID
`.trim());
}

function parseArgs(): Config {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      flags["dry-run"] = "true";
    } else if (args[i].startsWith("--") && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[++i];
    }
  }

  // Warn if tokens are passed via CLI args (visible in process list)
  if (flags["jira-token"] || flags["agent-tasks-token"]) {
    console.warn("WARNING: Passing tokens via CLI args exposes them in the process list.");
    console.warn("         Prefer environment variables: JIRA_TOKEN, AGENT_TASKS_TOKEN\n");
  }

  const config: Config = {
    jiraUrl: flags["jira-url"] || process.env.JIRA_URL || "",
    jiraEmail: flags["jira-email"] || process.env.JIRA_EMAIL || "",
    jiraToken: flags["jira-token"] || process.env.JIRA_TOKEN || "",
    jql: flags["jql"] || process.env.JIRA_JQL || "ORDER BY created DESC",
    agentTasksUrl: flags["agent-tasks-url"] || process.env.AGENT_TASKS_URL || "",
    agentTasksToken: flags["agent-tasks-token"] || process.env.AGENT_TASKS_TOKEN || "",
    projectId: flags["project-id"] || process.env.PROJECT_ID || "",
    dryRun: flags["dry-run"] === "true",
  };

  const missing: string[] = [];
  if (!config.jiraUrl) missing.push("JIRA_URL");
  if (!config.jiraEmail) missing.push("JIRA_EMAIL");
  if (!config.jiraToken) missing.push("JIRA_TOKEN");
  if (!config.agentTasksUrl) missing.push("AGENT_TASKS_URL");
  if (!config.agentTasksToken) missing.push("AGENT_TASKS_TOKEN");
  if (!config.projectId) missing.push("PROJECT_ID");

  if (missing.length > 0) {
    console.error(`Missing required config: ${missing.join(", ")}`);
    console.error("Run with --help for usage.\n");
    process.exit(1);
  }

  config.jiraUrl = config.jiraUrl.replace(/\/+$/, "");
  config.agentTasksUrl = config.agentTasksUrl.replace(/\/+$/, "");

  // Warn if using default JQL (fetches everything)
  if (!flags["jql"] && !process.env.JIRA_JQL) {
    console.warn("WARNING: No --jql specified. Default fetches ALL issues. Consider adding a filter.\n");
  }

  return config;
}

// -- Jira API --

const FETCH_TIMEOUT = 30_000;
const MAX_RETRIES = 2;

async function fetchWithRetry(url: string, opts: RequestInit, retries = MAX_RETRIES): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (res.status === 429 || (res.status >= 500 && attempt < retries)) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.warn(`  Retrying after ${res.status} (attempt ${attempt + 1})...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < retries) {
        console.warn(`  Retrying after error (attempt ${attempt + 1}): ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
}

async function fetchJiraIssues(config: Config): Promise<JiraIssue[]> {
  const auth = Buffer.from(`${config.jiraEmail}:${config.jiraToken}`).toString("base64");
  const allIssues: JiraIssue[] = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const url = `${config.jiraUrl}/rest/api/3/search?jql=${encodeURIComponent(config.jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=summary,description,priority,status,labels,duedate,assignee,issuetype`;

    const res = await fetchWithRetry(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira API error ${res.status}: ${body.slice(0, 500)}`);
    }

    const data: JiraSearchResponse = await res.json();
    allIssues.push(...data.issues);

    console.log(`  Fetched ${allIssues.length}/${data.total} issues...`);

    if (allIssues.length >= data.total) break;
    startAt += maxResults;
  }

  return allIssues;
}

// -- Import --

async function importTasks(
  tasks: ImportTask[],
  config: Config,
): Promise<ImportResponse> {
  const url = `${config.agentTasksUrl}/api/projects/${config.projectId}/tasks/import`;

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.agentTasksToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tasks }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`agent-tasks API error ${res.status}: ${body.slice(0, 500)}`);
  }

  return res.json();
}

// -- Main --

async function main() {
  const config = parseArgs();

  console.log(`Jira Import CLI`);
  console.log(`  Jira: ${config.jiraUrl}`);
  console.log(`  JQL: ${config.jql}`);
  console.log(`  Target: ${config.agentTasksUrl} (project ${config.projectId})`);
  console.log(`  Dry run: ${config.dryRun}`);
  console.log();

  // 1. Fetch from Jira
  console.log("Fetching issues from Jira...");
  const issues = await fetchJiraIssues(config);
  console.log(`Found ${issues.length} issues.`);

  if (issues.length === 0) {
    console.log("Nothing to import.");
    return;
  }

  // 2. Map to agent-tasks format
  const agentToken = isAgentToken(config.agentTasksToken);
  if (agentToken) {
    console.log("Agent token detected: every task is imported with status backlog.");
  }
  const tasks: ImportTask[] = issues.map((issue) => mapIssue(issue, { agentToken }));

  // 3. Preview
  console.log(`\nMapped ${tasks.length} tasks:`);
  for (const t of tasks.slice(0, 5)) {
    console.log(`  ${t.externalRef} [${t.priority}] ${t.title.slice(0, 60)}`);
  }
  if (tasks.length > 5) {
    console.log(`  ... and ${tasks.length - 5} more`);
  }

  if (config.dryRun) {
    console.log("\n--dry-run: skipping import.");
    console.log(JSON.stringify(tasks.slice(0, 3), null, 2));
    return;
  }

  // 4. Import in batches of 200
  console.log("\nImporting...");
  let totalCreated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (let i = 0; i < tasks.length; i += 200) {
    const batch = tasks.slice(i, i + 200);
    const batchNum = Math.floor(i / 200) + 1;
    console.log(`  Batch ${batchNum}: ${batch.length} tasks...`);

    try {
      const result = await importTasks(batch, config);
      totalCreated += result.created;
      totalSkipped += result.skipped;
      totalFailed += result.failed;

      if (result.errors.length > 0) {
        console.error(`  Errors:`, result.errors);
      }
    } catch (err) {
      console.error(`  Batch ${batchNum} failed: ${(err as Error).message}`);
      totalFailed += batch.length;
      // Continue with remaining batches
    }
  }

  console.log(`\nDone.`);
  console.log(`  Created: ${totalCreated}`);
  console.log(`  Skipped (duplicates): ${totalSkipped}`);
  console.log(`  Failed: ${totalFailed}`);

  if (totalFailed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
