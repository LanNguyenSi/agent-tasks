/**
 * Webhook Automation Policy
 *
 * Pure-function evaluation of the review-automation-policy.md matrix.
 * Determines what side effects a webhook event should have on a task.
 */

export interface PolicyInput {
  event: "review_approved" | "review_changes_requested" | "review_commented" | "review_dismissed" | "pr_merged" | "pr_closed" | "pr_opened" | "pr_synchronized";
  taskStatus: string;
  reviewer?: string;
  prNumber?: number;
}

export interface PolicyResult {
  transition?: { from: string; to: string };
  timelineMessage: string;
  auditEvent: string;
}

/**
 * Evaluate the automation policy for a webhook event against a task.
 * Returns the allowed side effects according to review-automation-policy.md.
 */
export function evaluateWebhookPolicy(input: PolicyInput): PolicyResult {
  const { event, taskStatus, reviewer, prNumber } = input;

  switch (event) {
    case "review_approved":
      return {
        // No auto-transition on approval
        timelineMessage: `Review approved by ${reviewer}`,
        auditEvent: "webhook.review_approved",
      };

    case "review_changes_requested":
      return {
        // review → in_progress only
        transition: taskStatus === "review" ? { from: "review", to: "in_progress" } : undefined,
        timelineMessage: `Changes requested by ${reviewer}`,
        auditEvent: "webhook.changes_requested",
      };

    case "review_commented":
      return {
        timelineMessage: `Review comment by ${reviewer}`,
        auditEvent: "webhook.review_commented",
      };

    case "review_dismissed":
      return {
        timelineMessage: `Review dismissed for ${reviewer}`,
        auditEvent: "webhook.review_dismissed",
      };

    case "pr_merged":
      return {
        // Any non-done status → done
        transition: taskStatus !== "done" ? { from: taskStatus, to: "done" } : undefined,
        timelineMessage: `PR #${prNumber} merged`,
        auditEvent: "webhook.pr_merged",
      };

    case "pr_closed":
      return {
        // No auto-transition on close without merge
        timelineMessage: `PR #${prNumber} closed without merge`,
        auditEvent: "webhook.pr_closed",
      };

    case "pr_opened":
      return {
        timelineMessage: `PR #${prNumber} opened`,
        auditEvent: "webhook.pr_opened",
      };

    case "pr_synchronized":
      return {
        timelineMessage: `PR #${prNumber} updated (new commits)`,
        auditEvent: "webhook.pr_synchronized",
      };
  }
}
