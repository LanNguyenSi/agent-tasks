/**
 * Output formatting helpers.
 */
import type { Project, Task, Signal } from "./api.js";

export type OutputMode = "table" | "json" | "quiet";

export function formatTasks(tasks: Task[], mode: OutputMode): string {
  if (mode === "json") return JSON.stringify(tasks, null, 2);
  if (mode === "quiet") return tasks.map((t) => t.id).join("\n");

  if (tasks.length === 0) return "No tasks found.";

  const lines = tasks.map((t) => {
    const project = t.project?.slug ?? "";
    const prio = t.priority.padEnd(8);
    const status = t.status.padEnd(12);
    return `${prio} ${status} ${project.padEnd(20)} ${t.title}`;
  });
  return `${"PRIORITY".padEnd(8)} ${"STATUS".padEnd(12)} ${"PROJECT".padEnd(20)} TITLE\n${lines.join("\n")}`;
}

export function formatTask(task: Task, mode: OutputMode): string {
  if (mode === "json") return JSON.stringify(task, null, 2);
  if (mode === "quiet") return task.id;

  const lines = [
    `ID:       ${task.id}`,
    `Title:    ${task.title}`,
    `Status:   ${task.status}`,
    `Priority: ${task.priority}`,
  ];
  if (task.branchName) lines.push(`Branch:   ${task.branchName}`);
  if (task.prUrl) lines.push(`PR:       ${task.prUrl}`);
  return lines.join("\n");
}

export function formatProjects(projects: Project[], mode: OutputMode): string {
  if (mode === "json") return JSON.stringify(projects, null, 2);
  if (mode === "quiet") return projects.map((p) => p.slug).join("\n");

  if (projects.length === 0) return "No projects found.";

  const lines = projects.map((p) => {
    const repo = p.githubRepo ?? "";
    return `${p.slug.padEnd(30)} ${repo.padEnd(40)} ${p.name}`;
  });
  return `${"SLUG".padEnd(30)} ${"GITHUB REPO".padEnd(40)} NAME\n${lines.join("\n")}`;
}

export function formatProject(project: Project, mode: OutputMode): string {
  if (mode === "json") return JSON.stringify(project, null, 2);
  if (mode === "quiet") return project.id;

  const lines = [
    `ID:          ${project.id}`,
    `Slug:        ${project.slug}`,
    `Name:        ${project.name}`,
  ];
  if (project.githubRepo) lines.push(`GitHub repo: ${project.githubRepo}`);
  if (project.description) lines.push(`Description: ${project.description}`);
  return lines.join("\n");
}

export function formatPickup(result: import("./api.js").PickupResult, mode: OutputMode): string {
  if (mode === "json") return JSON.stringify(result, null, 2);
  if (mode === "quiet") {
    if (result.kind === "signal") return result.signal.id;
    if (result.kind === "review" || result.kind === "work") return result.task.id;
    return "";
  }
  if (result.kind === "idle") return "Idle — nothing to pick up.";
  if (result.kind === "signal") {
    const ctx = result.signal.context as Record<string, unknown>;
    const title = (ctx.taskTitle as string) ?? result.signal.taskId;
    return `[signal] ${result.signal.type}\n  ${title}\n  signal-id: ${result.signal.id}`;
  }
  const tag = result.kind === "review" ? "review" : "work";
  return `[${tag}] ${result.task.title}\n  task-id: ${result.task.id}\n  project: ${result.project.slug}`;
}

export function formatStart(result: import("./api.js").StartResult, mode: OutputMode): string {
  if (mode === "json") return JSON.stringify(result, null, 2);
  if (mode === "quiet") return result.task.id;
  return [
    `Started ${result.kind} on ${result.task.id}`,
    `Title:               ${result.task.title}`,
    `Project:             ${result.project.slug}`,
    `Status:              ${result.task.status}`,
    `expectedFinishState: ${result.expectedFinishState}`,
  ].join("\n");
}

export function formatGates(
  gates: import("./api.js").EffectiveGate[],
  mode: OutputMode,
): string {
  if (mode === "json") return JSON.stringify(gates, null, 2);
  if (mode === "quiet") return gates.filter((g) => g.active).map((g) => g.code).join("\n");
  if (gates.length === 0) return "No gates configured.";
  const lines = gates.map((g) => {
    const flag = g.active ? "✓" : "·";
    return `${flag.padEnd(8)} ${g.code.padEnd(28)} ${g.because}`;
  });
  return `${"ACTIVE".padEnd(8)} ${"GATE".padEnd(28)} REASON\n${lines.join("\n")}`;
}

export function formatSignals(signals: Signal[], mode: OutputMode): string {
  if (mode === "json") return JSON.stringify(signals, null, 2);
  if (mode === "quiet") return signals.map((s) => s.id).join("\n");

  if (signals.length === 0) return "No signals.";

  const lines = signals.map((s) => {
    const ctx = s.context as Record<string, unknown>;
    const title = (ctx.taskTitle as string) ?? s.taskId;
    const time = new Date(s.createdAt).toLocaleString();
    return `${s.type.padEnd(22)} ${title.substring(0, 40).padEnd(42)} ${time}`;
  });
  return `${"TYPE".padEnd(22)} ${"TASK".padEnd(42)} CREATED\n${lines.join("\n")}`;
}
