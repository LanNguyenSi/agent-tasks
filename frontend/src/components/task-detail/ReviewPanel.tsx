// Review panel: rendered when task.status === "review".
//
// Two cases:
//   (a) The current user is the claimant — they can only Mark Done (routed
//       through /transition so the backend enforces workflow gates). When the
//       project requires a distinct reviewer they see a gating message instead.
//   (b) Any other signed-in user — they can Approve or Request Changes with
//       an optional review comment.

import type { RefObject } from "react";
import type { Task, User } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { KeyHint } from "@/components/ui/KeyHint";

interface ReviewPanelProps {
  task: Task;
  user: User | null;
  requireDistinctReviewer: boolean;
  reviewComment: string;
  onReviewCommentChange: (v: string) => void;
  reviewBusy: boolean;
  onSubmitReview: (outcome: "approve" | "request_changes") => void;
  onMarkDone: () => void;
  reviewSectionRef: RefObject<HTMLElement | null>;
}

export default function ReviewPanel({
  task,
  user,
  requireDistinctReviewer,
  reviewComment,
  onReviewCommentChange,
  reviewBusy,
  onSubmitReview,
  onMarkDone,
  reviewSectionRef,
}: ReviewPanelProps) {
  if (task.status !== "review") return null;

  const isClaimant = task.claimedByUserId === user?.id;

  return (
    <section
      ref={reviewSectionRef}
      className="td-review-panel"
      aria-label="Review"
    >
      <p className="td-review-title">Review</p>

      {isClaimant ? (
        /* Case (a): the user who worked on this task */
        requireDistinctReviewer ? (
          <p className="td-review-note">
            This project requires a <strong>distinct reviewer</strong>. You
            claimed this task, so you cannot approve it yourself — a different
            user or agent must take the review lock and approve. Once approved
            the task moves to done automatically.
          </p>
        ) : (
          <>
            <p className="td-review-note">
              This is your task. Once review is complete, mark it done.
            </p>
            <Button
              size="sm"
              disabled={reviewBusy}
              loading={reviewBusy}
              onClick={onMarkDone}
            >
              Mark Done
            </Button>
          </>
        )
      ) : (
        /* Case (b): reviewer (different user) */
        <>
          <textarea
            className="td-review-textarea"
            value={reviewComment}
            onChange={(e) => onReviewCommentChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !reviewBusy) {
                e.preventDefault();
                onSubmitReview("approve");
              }
            }}
            aria-label="Review feedback"
            placeholder="Review feedback (optional)"
            rows={2}
          />
          <p className="td-review-kbd-hint">
            <KeyHint>⌘</KeyHint> <KeyHint>↵</KeyHint> to approve
          </p>
          <div className="td-review-actions">
            <Button
              size="sm"
              disabled={reviewBusy}
              loading={reviewBusy}
              onClick={() => onSubmitReview("approve")}
            >
              Approve
            </Button>
            <Button
              variant="outline-danger"
              size="sm"
              disabled={reviewBusy}
              loading={reviewBusy}
              onClick={() => onSubmitReview("request_changes")}
            >
              Request Changes
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
