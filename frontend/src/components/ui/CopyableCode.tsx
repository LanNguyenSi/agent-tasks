"use client";

// Code block with an inline copy button. No inline styles: all geometry lives
// in .copyable-code-* classes in globals.css.
//
// Usage:
//   <CopyableCode value="npx @agent-tasks/mcp-server --token <TOKEN>" label="Quick start" />
//   <CopyableCode value={rawToken} masked={tokenMasked} onCopy={() => startMaskTimer()} />

import { useState } from "react";
import { Button } from "./Button";

interface CopyableCodeProps {
  /** The raw value placed on the clipboard and shown in the code block. */
  value: string;
  /** Optional accessible label rendered above the block. */
  label?: string;
  /**
   * When true, the displayed text is replaced with placeholder bullets
   * while the raw value is still used for clipboard writes.
   */
  masked?: boolean;
  /** Called immediately after the clipboard write succeeds. */
  onCopy?: () => void;
  className?: string;
}

const MASK_PLACEHOLDER = "••••••••";

export function CopyableCode({
  value,
  label,
  masked = false,
  onCopy,
  className,
}: CopyableCodeProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      onCopy?.();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access may be denied; silence the error here since the
      // user can still select-and-copy the visible text.
    }
  }

  return (
    <div className={["copyable-code", className].filter(Boolean).join(" ")}>
      {label && (
        <span className="copyable-code-label">{label}</span>
      )}
      <div className="copyable-code-row">
        <code className="copyable-code-value" aria-label={label}>
          {masked ? MASK_PLACEHOLDER : value}
        </code>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleCopy()}
          aria-label={copied ? "Copied" : `Copy ${label ?? "value"}`}
          className="copyable-code-btn"
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
