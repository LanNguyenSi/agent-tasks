/**
 * Pure Jira -> agent-tasks mapping used by jira-import.ts: ADF text
 * extraction, priority and status mapping, and the per-token status rule.
 * Kept free of I/O so it can be unit tested.
 */

// -- Types --

export interface JiraIssue {
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

export interface ImportTask {
  title: string;
  description?: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status?: "backlog" | "open" | "in_progress" | "review" | "done";
  externalRef: string;
  labels: string[];
  dueAt?: string;
}

// -- ADF Extraction --

const BLOCK_TYPES = new Set(["doc", "paragraph", "heading", "blockquote", "codeBlock", "bulletList", "orderedList", "listItem", "table", "tableRow", "tableCell", "tableHeader", "mediaSingle", "mediaGroup", "rule"]);

export function extractAdfText(node: unknown): string {
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

export function adfToText(doc: Record<string, unknown> | null): string {
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

/**
 * An agent token (`at_...`) can only create backlog tasks: the import endpoint
 * rejects the whole batch with 400 backlog_routing_enforced when any item
 * carries another status. Human tokens keep the Jira status category mapping.
 */
export function isAgentToken(token: string): boolean {
  return token.startsWith("at_");
}

export function mapIssue(issue: JiraIssue, opts: { agentToken?: boolean } = {}): ImportTask {
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
    status: opts.agentToken ? "backlog" : STATUS_CATEGORY_MAP[statusCategory] || "open",
    externalRef: issue.key,
    labels,
    dueAt,
  };
}

