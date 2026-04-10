/**
 * Jira Excel/CSV column auto-detection and mapping.
 * Supports German and English Jira exports.
 */

export interface ColumnMapping {
  title: number | null;
  externalRef: number | null;
  description: number | null;
  priority: number | null;
  status: number | null;
  statusCategory: number | null;
  issueType: number | null;
  dueAt: number | null;
  labels: number | null;
}

export interface ImportableTask {
  title: string;
  description?: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status?: "open" | "in_progress" | "review" | "done";
  externalRef?: string;
  labels: string[];
  dueAt?: string;
}

// Column header patterns: German + English
const HEADER_PATTERNS: Record<keyof ColumnMapping, RegExp> = {
  title: /^(zusammenfassung|summary)$/i,
  externalRef: /^(vorgangsschlüssel|vorgangsschl.ssel|issue\s*key)$/i,
  description: /^(beschreibung|description)$/i,
  priority: /^(priorität|priorit.t|priority)$/i,
  status: /^(status)$/i,
  statusCategory: /^(statuskategorie|status\s*category)$/i,
  issueType: /^(vorgangstyp|issue\s*type)$/i,
  dueAt: /^(fälligkeitsdatum|f.lligkeitsdatum|due\s*date)$/i,
  labels: /^(bezeichnungen|labels)$/i,
};

export function autoDetectColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {
    title: null,
    externalRef: null,
    description: null,
    priority: null,
    status: null,
    statusCategory: null,
    issueType: null,
    dueAt: null,
    labels: null,
  };

  // Only match against top-level headers (skip "Benutzerdefiniertes Feld (...)")
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] || "").trim();
    if (h.startsWith("Benutzerdefiniertes Feld") || h.startsWith("Custom field")) continue;

    for (const [field, pattern] of Object.entries(HEADER_PATTERNS)) {
      if (mapping[field as keyof ColumnMapping] === null && pattern.test(h)) {
        mapping[field as keyof ColumnMapping] = i;
      }
    }
  }

  return mapping;
}

// Priority mapping: German + English
const PRIORITY_MAP: Record<string, ImportableTask["priority"]> = {
  // German
  höchste: "CRITICAL", hoch: "HIGH", normal: "MEDIUM", niedrig: "LOW", niedrigste: "LOW",
  // English
  highest: "CRITICAL", high: "HIGH", medium: "MEDIUM", low: "LOW", lowest: "LOW",
};

// Status category mapping: German + English
const STATUS_MAP: Record<string, ImportableTask["status"]> = {
  // German status categories
  "neu": "open", "ungelöst": "in_progress", "fertig": "done",
  // English status categories
  "to do": "open", "new": "open", "in progress": "in_progress", "done": "done",
  // Common status names
  "open": "open", "backlog": "open", "in review": "review", "review": "review",
  "closed": "done", "resolved": "done",
};

function parseDate(value: unknown): string | undefined {
  if (!value) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;

  // Try common Jira formats: "DD.MM.YYYY HH:mm" or "DD/MM/YYYY" or ISO
  const dotMatch = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (dotMatch) {
    return new Date(`${dotMatch[3]}-${dotMatch[2]}-${dotMatch[1]}`).toISOString();
  }

  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch { /* ignore */ }

  return undefined;
}

export function mapRows(
  rows: unknown[][],
  mapping: ColumnMapping,
): ImportableTask[] {
  const tasks: ImportableTask[] = [];

  for (const row of rows) {
    const get = (idx: number | null): string => {
      if (idx === null || idx >= row.length) return "";
      return String(row[idx] ?? "").trim();
    };

    const title = get(mapping.title);
    if (!title) continue; // Skip rows without title

    const priorityRaw = get(mapping.priority).toLowerCase();
    const statusRaw = get(mapping.statusCategory).toLowerCase() || get(mapping.status).toLowerCase();

    const labels: string[] = [];
    const issueType = get(mapping.issueType);
    if (issueType) labels.push(`type:${issueType.toLowerCase()}`);

    const labelsRaw = get(mapping.labels);
    if (labelsRaw) {
      labels.push(...labelsRaw.split(/[,;]/).map((l) => l.trim()).filter(Boolean));
    }

    tasks.push({
      title: title.slice(0, 255),
      description: get(mapping.description).slice(0, 49_990) || undefined,
      priority: PRIORITY_MAP[priorityRaw] || "MEDIUM",
      status: STATUS_MAP[statusRaw] || "open",
      externalRef: get(mapping.externalRef) || undefined,
      labels: labels.slice(0, 20).map((l) => l.slice(0, 100)),
      dueAt: parseDate(row[mapping.dueAt ?? -1]),
    });
  }

  return tasks;
}

export function getMappingCompleteness(mapping: ColumnMapping): {
  mapped: string[];
  unmapped: string[];
} {
  const mapped: string[] = [];
  const unmapped: string[] = [];
  const required: (keyof ColumnMapping)[] = ["title"];
  const optional: (keyof ColumnMapping)[] = ["externalRef", "description", "priority", "status", "statusCategory", "issueType", "dueAt", "labels"];

  for (const key of [...required, ...optional]) {
    if (mapping[key] !== null) {
      mapped.push(key);
    } else {
      unmapped.push(key);
    }
  }

  return { mapped, unmapped };
}
