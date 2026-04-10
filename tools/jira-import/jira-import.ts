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

// -- Types --

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: Record<string, unknown> | null; // ADF (Atlassian Document Format) in API v3
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

// -- ADF Extraction --

const BLOCK_TYPES = new Set(["doc", "paragraph", "heading", "blockquote", "codeBlock", "bulletList", "orderedList", "listItem", "table", "tableRow", "tableCell", "tableHeader", "mediaSingle", "mediaGroup", "rule"]);

function extractAdfText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as Record<string, unknown>;

  // Leaf nodes
  if (n.type === "text") return (n.text as string) || "";
  if (n.type === "hardBreak") return "\n";
  if (n.type === "mention") return `@${(n.attrs as Record<string, string>)?.text || "user"}`;
  if (n.type === "emoji") return (n.attrs as Record<string, string>)?.shortName || "";
  if (n.type === "inlineCard" || n.type === "blockCard") return (n.attrs as Record<string, string>)?.url || "";
  if (n.type === "rule") return "\n---\n";

  // Container nodes
  if (!Array.isArray(n.content)) return "";
  const children = (n.content as unknown[]).map(extractAdfText);

  // Block-level containers: join children with newlines
  if (BLOCK_TYPES.has(n.type as string)) {
    if (n.type === "codeBlock") return "```\n" + children.join("") + "\n```";
    if (n.type === "heading") return children.join("") + "\n";
    if (n.type === "listItem") return "- " + children.join("");
    if (n.type === "paragraph") return children.join("");
    return children.join("\n");
  }

  // Inline containers (marks, etc.): join without separator
  return children.join("");
}

function adfToText(doc: Record<string, unknown> | null): string {
  if (!doc) return "";
  if (!Array.isArray(doc.content)) return "";
  return (doc.content as unknown[])
    .map(extractAdfText)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

const MAX_LABELS = 20;
const MAX_LABEL_LENGTH = 100;

function mapIssue(issue: JiraIssue): ImportTask {
  const f = issue.fields;
  const priorityName = (f.priority?.name || "medium").toLowerCase();
  const statusCategory = f.status?.statusCategory?.key || "new";

  let labels = [...(f.labels || [])];
  if (f.issuetype?.name) {
    labels.push(`type:${f.issuetype.name.toLowerCase()}`);
  }
  // Truncate labels to fit API constraints
  labels = labels
    .map((l) => l.slice(0, MAX_LABEL_LENGTH))
    .slice(0, MAX_LABELS);

  const description = adfToText(f.description);

  let dueAt: string | undefined;
  if (f.duedate) {
    try {
      dueAt = new Date(f.duedate).toISOString();
    } catch {
      // Invalid date — skip
    }
  }

  return {
    title: f.summary.slice(0, 255),
    description: description.slice(0, 49_990) || undefined,
    priority: PRIORITY_MAP[priorityName] || "MEDIUM",
    status: STATUS_CATEGORY_MAP[statusCategory] || "open",
    externalRef: issue.key,
    labels,
    dueAt,
  };
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
