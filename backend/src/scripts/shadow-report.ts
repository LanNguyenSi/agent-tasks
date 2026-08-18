/**
 * scorer-v2 shadow report (T5). READ-ONLY.
 *
 * Computes the v2 confidence score for every OPEN task and reports, per project,
 * how many WOULD be blocked under the current threshold and the evals keystone,
 * plus which caps/findings fired. This is the calibration signal: review a
 * project's report before flipping its enforcementMode to BLOCK, and use the
 * cap histogram to tune the FIELD_WEIGHTS / EVALS_KEYSTONE_CAP numbers.
 *
 * Run:
 *   npm run shadow:report                      # all projects
 *   npm run shadow:report -- --project agent-tasks
 *   npm run shadow:report -- --json
 *
 * Writes nothing — safe to run against production.
 */
import { pathToFileURL } from "node:url";
import { prisma } from "../lib/prisma.js";
import {
  calculateConfidence,
  resolveEffectiveThreshold,
  type TemplateData,
  type TemplateFields,
} from "../lib/confidence.js";
import { resolveEnforcementMode } from "../lib/enforcement-mode.js";

interface ProjectReport {
  project: string;
  enforcementMode: string;
  /** Project-layer threshold ONLY (`Project.confidenceThreshold`). Per-task
   *  `wouldBlock` below is computed against the fully layered
   *  `resolveEffectiveThreshold` result (M2, task b8629b99), which can differ
   *  per task when the project also has `taskTypeThresholds` set; this
   *  field does not reflect that per-type override. */
  threshold: number;
  openTasks: number;
  wouldBlock: number;
  wouldBlockPct: number;
  keystoneBlock: number;
  scoreMin: number | null;
  scoreMean: number | null;
  topCaps: Array<{ code: string; count: number }>;
}

export async function computeShadowReport(projectFilter?: string): Promise<ProjectReport[]> {
  const projects = await prisma.project.findMany({
    where: projectFilter ? { OR: [{ slug: projectFilter }, { id: projectFilter }] } : undefined,
    select: {
      id: true,
      slug: true,
      confidenceThreshold: true,
      taskTemplate: true,
      enforcementMode: true,
      taskTypeThresholds: true,
    },
    orderBy: { slug: "asc" },
  });

  const report: ProjectReport[] = [];
  for (const project of projects) {
    // OPEN tasks are the population that hits the gate at the open→in_progress
    // claim edge. In-progress/claimed tasks are grandfathered (never re-gated).
    const tasks = await prisma.task.findMany({
      where: { projectId: project.id, status: "open" },
      select: { title: true, description: true, templateData: true },
    });
    const tpl = project.taskTemplate as { fields?: TemplateFields } | null;
    const threshold = project.confidenceThreshold;

    let wouldBlock = 0;
    let keystoneBlock = 0;
    const capCounts: Record<string, number> = {};
    const scores: number[] = [];

    for (const t of tasks) {
      const conf = calculateConfidence({
        title: t.title,
        description: t.description,
        templateData: t.templateData as TemplateData | null,
        templateFields: tpl?.fields ?? null,
      });
      scores.push(conf.score);
      // M2 (task b8629b99): the calibration signal must reflect the SAME
      // layered threshold the live claim gate applies: a per-task-type
      // override on this project changes wouldBlock for exactly the tasks
      // whose inferredTaskType matches it, not the whole population.
      //
      // M3 divergence, deliberate (batch 18 review, MED-5): this does NOT
      // additionally resolve Project.riskModifiers, so `wouldBlock` here is
      // the M2-only calibration signal, not the exact live gate outcome — a
      // task whose own description/labels trigger a configured modifier
      // blocks at the live gate but is NOT counted as `wouldBlock` here,
      // making this report a conservative UNDER-count relative to
      // production for such projects. Acceptable for this script's purpose
      // (tune FIELD_WEIGHTS/EVALS_KEYSTONE_CAP against the population, not
      // predict every individual task's fate) — the per-task query above
      // doesn't even select `labels`, and doing so plus the M3 resolution
      // per row is a follow-up if this script's precision ever needs to
      // match the live gate exactly.
      const { effectiveThreshold } = resolveEffectiveThreshold(
        conf.inferredTaskType,
        project.taskTypeThresholds,
        project.confidenceThreshold,
      );
      const below = conf.score < effectiveThreshold;
      const blocked = below || conf.blocking;
      if (blocked) wouldBlock++;
      if (conf.blocking) keystoneBlock++;
      if (blocked) {
        for (const f of conf.findings) {
          if (f.severity === "info") continue;
          capCounts[f.code] = (capCounts[f.code] ?? 0) + 1;
        }
      }
    }

    report.push({
      project: project.slug,
      enforcementMode: resolveEnforcementMode(project),
      threshold,
      openTasks: tasks.length,
      wouldBlock,
      wouldBlockPct: tasks.length ? Math.round((wouldBlock / tasks.length) * 100) : 0,
      keystoneBlock,
      scoreMin: scores.length ? Math.min(...scores) : null,
      scoreMean: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      topCaps: Object.entries(capCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([code, count]) => ({ code, count })),
    });
  }
  return report;
}

function printReport(report: ProjectReport[]): void {
  if (report.length === 0) {
    console.log("No matching projects.");
    return;
  }
  const totalTasks = report.reduce((a, r) => a + r.openTasks, 0);
  const totalBlock = report.reduce((a, r) => a + r.wouldBlock, 0);
  const totalKeystone = report.reduce((a, r) => a + r.keystoneBlock, 0);

  console.log("\nscorer-v2 shadow report — open tasks that WOULD block under the v2 scorer\n");
  for (const r of report) {
    console.log(`■ ${r.project}  [${r.enforcementMode}, threshold ${r.threshold}]`);
    console.log(
      `   open=${r.openTasks}  wouldBlock=${r.wouldBlock} (${r.wouldBlockPct}%)  keystone=${r.keystoneBlock}` +
        `  score min/mean=${r.scoreMin ?? "-"}/${r.scoreMean ?? "-"}`,
    );
    if (r.topCaps.length > 0) {
      console.log(`   caps: ${r.topCaps.map((c) => `${c.code}×${c.count}`).join("  ")}`);
    }
  }
  const pct = totalTasks ? Math.round((totalBlock / totalTasks) * 100) : 0;
  console.log(
    `\nTOTAL: ${totalBlock}/${totalTasks} open tasks would block (${pct}%), of which ${totalKeystone} on the evals keystone.\n` +
      "Review per-project distribution before flipping any project to BLOCK (PATCH enforcementMode=BLOCK + acknowledgeShadowReport=true).\n",
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const projIdx = args.indexOf("--project");
  const projectFilter = projIdx >= 0 ? args[projIdx + 1] : undefined;

  const report = await computeShadowReport(projectFilter);
  if (json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);

  await prisma.$disconnect();
}

// Run only when invoked directly (tsx/node), not when imported by a test.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
