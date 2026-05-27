"use client";

import { useState } from "react";

/**
 * Project settings form section for the outbound notification webhook.
 *
 * Controlled component — parent owns the draft state so it can fold the
 * values into the existing project-settings save handler. The "Replace
 * secret" affordance is local UI state (whether the password field is
 * shown vs the redacted "•••• (set)" label) and is reset every time the
 * settings modal is reopened.
 *
 * See docs/notification-webhooks.md for the wire contract.
 */

export interface NotificationWebhookSectionProps {
  /** Current URL on the server. Used purely for placeholder hint when the draft is empty. */
  initialWebhookUrl: string | null;
  /** True iff a signing secret is configured. Drives the redacted-vs-input view. */
  hasSecret: boolean;
  /** Current draft URL value. Empty string is allowed and means "clear on save". */
  urlDraft: string;
  onUrlDraftChange: (value: string) => void;
  /**
   * Current draft secret value. The value is only ever sent on save, never
   * displayed back from the server (the API redacts it).
   *
   * Semantics for the parent's save handler:
   *  - `null`  → do not touch the secret on this save
   *  - `""`    → clear the secret on the server
   *  - other   → set/replace the secret with this value
   */
  secretDraft: string | null;
  onSecretDraftChange: (value: string | null) => void;
}

export function NotificationWebhookSection({
  initialWebhookUrl,
  hasSecret,
  urlDraft,
  onUrlDraftChange,
  secretDraft,
  onSecretDraftChange,
}: NotificationWebhookSectionProps) {
  const [reveal, setReveal] = useState(false);

  // Show the password input when (a) no secret exists yet, or (b) the
  // operator has explicitly clicked "Replace". Otherwise show the
  // redacted state.
  const showSecretInput = !hasSecret || secretDraft !== null;

  return (
    <div
      data-testid="notification-webhook-section"
      style={{ marginBottom: "0.75rem", paddingBottom: "0.75rem", borderBottom: "1px solid var(--border)" }}
    >
      <p style={{ fontSize: "var(--text-sm)", fontWeight: 600, marginBottom: "0.4rem" }}>
        Notification webhook
      </p>
      <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "0.5rem" }}>
        Opt-in push delivery: every Signal also POSTs here in addition to the polling channel. Leave blank to disable.
      </p>

      <label
        htmlFor="notification-webhook-url"
        style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "0.2rem" }}
      >
        Webhook URL
      </label>
      <input
        id="notification-webhook-url"
        type="url"
        value={urlDraft}
        onChange={(e) => onUrlDraftChange(e.target.value)}
        placeholder={initialWebhookUrl ?? "https://example.com/agent-tasks-inbox"}
        style={{ width: "100%", fontSize: "var(--text-sm)" }}
      />
      <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginTop: "0.2rem", marginBottom: "0.5rem" }}>
        We POST every Signal to this URL. See the{" "}
        <a
          href="https://github.com/LanNguyenSi/agent-tasks/blob/master/docs/notification-webhooks.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          Notification webhooks docs
        </a>
        .
      </p>

      <label
        htmlFor="notification-webhook-secret"
        style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "0.2rem" }}
      >
        Signing secret (optional)
      </label>
      {showSecretInput ? (
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
          <input
            id="notification-webhook-secret"
            type={reveal ? "text" : "password"}
            value={secretDraft ?? ""}
            onChange={(e) => onSecretDraftChange(e.target.value)}
            placeholder={hasSecret ? "Enter a new value to replace the current secret" : "shared secret"}
            autoComplete="off"
            style={{ flex: 1, fontSize: "var(--text-sm)" }}
          />
          <button
            type="button"
            className="filter-chip"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? "Hide signing secret" : "Show signing secret"}
            aria-pressed={reveal}
          >
            {reveal ? "Hide" : "Show"}
          </button>
          {hasSecret && (
            <button
              type="button"
              className="filter-chip"
              onClick={() => {
                onSecretDraftChange(null);
                setReveal(false);
              }}
              aria-label="Cancel secret replacement"
            >
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
          <span
            data-testid="notification-webhook-secret-redacted"
            style={{ flex: 1, fontSize: "var(--text-sm)", color: "var(--muted)" }}
          >
            •••• (set)
          </span>
          <button
            type="button"
            className="filter-chip"
            onClick={() => onSecretDraftChange("")}
          >
            Replace
          </button>
        </div>
      )}
      <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginTop: "0.2rem" }}>
        If set, requests include <code>X-AgentTasks-Signature: sha256=&lt;hmac&gt;</code> over the raw body. Recommended for production endpoints.
      </p>
    </div>
  );
}

/**
 * Translate the section's draft state into the body fields the
 * `updateProject` PATCH expects. Returns `undefined` for keys that should
 * not be touched on this save (so the existing PATCH semantics — "omit =
 * leave unchanged" — are preserved for unmodified fields).
 *
 * Conventions:
 *  - URL: if the draft equals the server's current value, omit. Otherwise
 *    send the trimmed value (empty string clears, server normalizes to
 *    null).
 *  - Secret: if the draft is `null`, the operator left the redacted state
 *    untouched → omit. If the draft is `""`, clear. Otherwise send the
 *    new value.
 */
export function buildWebhookPatch(args: {
  initialWebhookUrl: string | null;
  urlDraft: string;
  secretDraft: string | null;
}): { notificationWebhookUrl?: string | null; notificationWebhookSecret?: string | null } {
  const out: { notificationWebhookUrl?: string | null; notificationWebhookSecret?: string | null } = {};
  const trimmed = args.urlDraft.trim();
  const currentUrl = args.initialWebhookUrl ?? "";
  if (trimmed !== currentUrl) {
    out.notificationWebhookUrl = trimmed === "" ? null : trimmed;
  }
  if (args.secretDraft !== null) {
    out.notificationWebhookSecret = args.secretDraft === "" ? null : args.secretDraft;
  }
  return out;
}
