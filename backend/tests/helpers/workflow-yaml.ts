// T-010 round 2: tiny YAML-navigation helper shared by the new
// docs-okf-literal-guard-detect-step and -pattern-coverage tests, so both
// can read the actual committed `.github/workflows/okf-literal-guard.yml`
// (its Detect step's `run:` script, and the `PATTERN` it defines) instead
// of a hand-copied string that could silently drift from what CI runs.
import fs from "node:fs";
import { load } from "js-yaml";

export interface WorkflowStep {
  id?: string;
  name?: string;
  run?: string;
}

interface WorkflowJob {
  steps: WorkflowStep[];
}

interface WorkflowDoc {
  jobs: Record<string, WorkflowJob>;
}

export function loadWorkflow(workflowPath: string): WorkflowDoc {
  const text = fs.readFileSync(workflowPath, "utf8");
  return load(text) as WorkflowDoc;
}

function findStep(doc: WorkflowDoc, jobId: string, stepId: string): WorkflowStep {
  const job = doc.jobs[jobId];
  if (!job) throw new Error(`workflow job not found: ${jobId}`);
  const step = job.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`workflow step not found: id=${stepId} in job ${jobId}`);
  return step;
}

/** The step's `run:` block as literal shell text, exactly as it will execute in CI. */
export function stepRun(doc: WorkflowDoc, jobId: string, stepId: string): string {
  const step = findStep(doc, jobId, stepId);
  if (typeof step.run !== "string") {
    throw new Error(`workflow step ${stepId} in job ${jobId} has no run: block`);
  }
  return step.run;
}

/** Extracts the single-quoted `PATTERN='...'` value from a shell script's text. */
export function extractPattern(shellScript: string): string {
  const m = shellScript.match(/PATTERN='([^']*)'/);
  if (!m) throw new Error("PATTERN='...' not found in shell script");
  return m[1];
}
