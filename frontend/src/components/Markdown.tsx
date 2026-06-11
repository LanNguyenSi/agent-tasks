// Markdown: wraps ReactMarkdown with remark-gfm (tables, task lists,
// strikethrough) and rehype-sanitize (XSS guard). The sanitize schema is
// extended to render GFM task-list checkboxes as disabled <input> elements.
//
// Use this component everywhere a markdown string should render instead of
// calling ReactMarkdown directly.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options } from "rehype-sanitize";

// The default sanitize schema blocks all <input> elements. We extend it to
// allow read-only checkboxes produced by GFM task-list syntax (- [x] / - [ ]).
// The checked and disabled attributes are preserved so rendered checkboxes
// reflect the markdown state without becoming interactive.
const sanitizeSchema: Options = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "input"],
  attributes: {
    ...defaultSchema.attributes,
    input: ["type", "checked", "disabled"],
  },
};

interface MarkdownProps {
  children: string;
  className?: string;
}

export default function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={["prose-markdown", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
