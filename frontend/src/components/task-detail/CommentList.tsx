// Renders the list of user comments on a task.
// The composer (textarea + Send button) stays in TaskDetail.
// Webhook activity comments are filtered out upstream before passing here.

import type { Comment, User } from "@/lib/api";
import Markdown from "@/components/Markdown";
import InlineConfirmDelete from "@/components/ui/InlineConfirmDelete";
import { formatAbsoluteDate, formatRelativeTime } from "@/lib/time";

interface CommentListProps {
  comments: Comment[];
  user: User | null;
  /** Called when the user confirms a delete for the given comment. */
  onConfirmDelete: (commentId: string) => void;
}

export default function CommentList({
  comments,
  user,
  onConfirmDelete,
}: CommentListProps) {
  if (comments.length === 0) return null;

  return (
    <div className="td-thread">
      {comments.map((comment: Comment) => {
        const authorName =
          comment.authorUser?.name ??
          comment.authorUser?.login ??
          (comment.authorAgent ? `Agent ${comment.authorAgent.name}` : "Unknown");
        const isOwn = comment.authorUser?.id === user?.id;
        const isAgent = Boolean(comment.authorAgent);

        return (
          <article key={comment.id} className="td-comment">
            <div className="td-comment-head">
              {/* Author initials avatar */}
              <span className="td-avatar" aria-hidden="true">
                {isAgent
                  ? "AI"
                  : authorName
                      .trim()
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((w) => w[0])
                      .join("")
                      .toUpperCase()
                      .slice(0, 2) || "?"}
              </span>
              <span
                className={[
                  "td-comment-author",
                  isAgent ? "td-comment-author--agent" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {authorName}
              </span>
              <span
                className="td-comment-time"
                title={formatAbsoluteDate(comment.createdAt)}
              >
                {formatRelativeTime(comment.createdAt)}
              </span>
              {isOwn && (
                <span className="td-comment-actions">
                  <InlineConfirmDelete
                    onConfirm={() => onConfirmDelete(comment.id)}
                  />
                </span>
              )}
            </div>
            <div className="td-comment-body prose-markdown">
              <Markdown>{comment.content}</Markdown>
            </div>
          </article>
        );
      })}
    </div>
  );
}
