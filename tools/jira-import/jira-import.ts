#!/usr/bin/env npx tsx
/**
 * Jira → agent-tasks Import CLI
 *
 * Fetches issues from Jira via REST API and imports them into agent-tasks
 * via the batch import endpoint.
 *
 * Usage:
 *   npx tsx tools/jira-import/jira-import.ts \
 *     --jira-url https://your-org.atlassian.net \
 *     --jira-email you@example.com \
 *     --jira-token ATATT... \
 *     --jql "project = PROJ AND status != Done" \
 *     --agent-tasks-url https://agent-tasks.opentriologue.ai \
 *     --agent-tasks-token at_... \
 *     --project-id <uuid> \
 *     [--dry-run]
 *
 * Environment variables (alternative to flags):
 *   JIRA_URL, JIRA_EMAIL, JIRA_TOKEN, AGENT_TASKS_URL, AGENT_TASKS_TOKEN, PROJECT_ID
 */

// -- Types --

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: string | null;
    priority?: { name: string };
    status?: { name: string; statusCategory?: { key: string } };
    labels?: string[];
    duedate?: string | null;
    assignee?: { displayName: string } | null;
    issuetype?: { name: string };
    [key: string]: unknown;
  };
}

interface JiraSearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

interface ImportTask {
  title: string;
  description?: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status?: "open" | "in_progress" | "review" | "done";
  externalRef: string;
  labels: string[];
  dueAt?: string;
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

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      flags["dry-run"] = "true";
    } else if (args[i].startsWith("--") && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[++i];
    }
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
  if (!config.jiraUrl) missing.push("--jira-url / JIRA_URL");
  if (!config.jiraEmail) missing.push("--jira-email / JIRA_EMAIL");
  if (!config.jiraToken) missing.push("--jira-token / JIRA_TOKEN");
  if (!config.agentTasksUrl) missing.push("--agent-tasks-url / AGENT_TASKS_URL");
  if (!config.agentTasksToken) missing.push("--agent-tasks-token / AGENT_TASKS_TOKEN");
  if (!config.projectId) missing.push("--project-id / PROJECT_ID");

  if (missing.length > 0) {
    console.error(`Missing required config: ${missing.join(", ")}`);
    process.exit(1);
  }

  // Normalize URL (strip trailing slash)
  config.jiraUrl = config.jiraUrl.replace(/\/+$/, "");
  config.agentTasksUrl = config.agentTasksUrl.replace(/\/+$/, "");

  return config;
}

// -- Jira API --

async function fetchJiraIssues(config: Config): Promise<JiraIssue[]> {
  const auth = Buffer.from(`${config.jiraEmail}:${config.jiraToken}`).toString("base64");
  const allIssues: JiraIssue[] = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const url = `${config.jiraUrl}/rest/api/3/search?jql=${encodeURIComponent(config.jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=summary,description,priority,status,labels,duedate,assignee,issuetype`;

    const res = await fetch(url, {
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

// -- Mapping --

const PRIORITY_MAP: Record<string, ImportTask["priority"]> = {
  highest: "CRITICAL",
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  lowest: "LOW",
};

const STATUS_CATEGORY_MAP: Record<string, ImportTask["status"]> = {
  new: "open",
  indeterminate: "in_progress",
  done: "done",
};

function mapJiraDescription(desc: unknown): string {
  if (!desc) return "";
  if (typeof desc === "string") return desc;
  // Jira Cloud uses ADF (Atlassian Document Format) — extract text content
  if (typeof desc === "object" && desc !== null) {
    return extractAdfText(desc);
  }
  return String(desc);
}

function extractAdfText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as Record<string, unknown>;
  if (n.type === "text" && typeof n.text === "string") return n.text;
  if (Array.isArray(n.content)) {
    return n.content.map(extractAdfText).join("\n");
  }
  return "";
}

function mapIssue(issue: JiraIssue): ImportTask {
  const f = issue.fields;
  const priorityName = (f.priority?.name || "medium").toLowerCase();
  const statusCategory = f.status?.statusCategory?.key || "new";

  const labels = [...(f.labels || [])];
  if (f.issuetype?.name) {
    labels.push(`type:${f.issuetype.name.toLowerCase()}`);
  }

  const description = mapJiraDescription(f.description);

  return {
    title: f.summary.slice(0, 255),
    description: description.slice(0, 50_000) || undefined,
    priority: PRIORITY_MAP[priorityName] || "MEDIUM",
    status: STATUS_CATEGORY_MAP[statusCategory] || "open",
    externalRef: issue.key,
    labels,
    dueAt: f.duedate ? new Date(f.duedate).toISOString() : undefined,
  };
}

// -- Import --

async function importTasks(
  tasks: ImportTask[],
  config: Config,
): Promise<ImportResponse> {
  const url = `${config.agentTasksUrl}/api/projects/${config.projectId}/tasks/import`;

  const res = await fetch(url, {
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
  const tasks = issues.map(mapIssue);

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
    console.log(`  Batch ${Math.floor(i / 200) + 1}: ${batch.length} tasks...`);

    const result = await importTasks(batch, config);
    totalCreated += result.created;
    totalSkipped += result.skipped;
    totalFailed += result.failed;

    if (result.errors.length > 0) {
      console.error(`  Errors:`, result.errors);
    }
  }

  console.log(`\nDone.`);
  console.log(`  Created: ${totalCreated}`);
  console.log(`  Skipped (duplicates): ${totalSkipped}`);
  console.log(`  Failed: ${totalFailed}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
