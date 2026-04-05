export type InstructionTransition = {
  status: string;
  label: string;
  reason: string;
};

export type TaskInstructionsResult = {
  currentState: string | null;
  agentInstructions: string | null;
  allowedTransitions: InstructionTransition[];
  updatableFields: string[];
};

const AGENT_UPDATABLE_FIELDS = ["branchName", "prUrl", "prNumber", "result"];

function titleCase(status: string): string {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getDefaultTransitionsForStatus(status: string): InstructionTransition[] {
  switch (status) {
    case "open":
      return [
        {
          status: "in_progress",
          label: "Start work",
          reason: "Claim or begin executing the task.",
        },
      ];
    case "in_progress":
      return [
        {
          status: "review",
          label: "Request review",
          reason: "Implementation is ready for review.",
        },
        {
          status: "open",
          label: "Re-open",
          reason: "Release the task back to the queue.",
        },
      ];
    case "review":
      return [
        {
          status: "done",
          label: "Approve and complete",
          reason: "Review passed and the task is complete.",
        },
        {
          status: "in_progress",
          label: "Request changes",
          reason: "More work is needed before completion.",
        },
      ];
    case "done":
      return [];
    default:
      return [];
  }
}

export function buildWorkflowlessTaskInstructions(status: string): TaskInstructionsResult {
  const allowedTransitions = getDefaultTransitionsForStatus(status);
  const hasTransitions = allowedTransitions.length > 0;

  return {
    currentState: status,
    agentInstructions: hasTransitions
      ? `Task is currently '${titleCase(status)}'. Use one of the allowed transitions for the next workflow step.`
      : `Task is currently '${titleCase(status)}'. No further default transitions are available.`,
    allowedTransitions,
    updatableFields: [...AGENT_UPDATABLE_FIELDS],
  };
}
