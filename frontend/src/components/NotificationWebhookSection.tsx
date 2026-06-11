"use client";

import { useState } from "react";
import { Button } from "./ui/Button";

/**
 * Project settings form section for the outbound notification webhook.
 *
 * Controlled component -- parent owns the draft state so it can fold the
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
   *  - `null`  -- do not touch the secret on this save
   *  - `""`    -- clear the secret on the server
   *  - other   -- set/replace the secret with this value
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
      className="notification-webhook-section"
    >
      <p className="notification-webhook-title">Notification webhook</p>
      <p className="notification-webhook-desc">
        Opt-in push delivery: every Signal also POSTs here in addition to the polling
        channel. Leave blank to disable.
      </p>

      <label
        htmlFor="notification-webhook-url"
        className="notification-webhook-field-label"
      >
        Webhook URL
      </label>
      <input
        id="notification-webhook-url"
        type="url"
        value={urlDraft}
        onChange={(e) => onUrlDraftChange(e.target.value)}
        placeholder={initialWebhookUrl ?? "https://example.com/agent-tasks-inbox"}
        className="notification-webhook-input"
      />
      <p className="notification-webhook-hint">
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
        className="notification-webhook-field-label"
      >
        Signing secret (optional)
      </label>
      {showSecretInput ? (
        <div className="notification-webhook-secret-row">
          <input
            id="notification-webhook-secret"
            type={reveal ? "text" : "password"}
            value={secretDraft ?? ""}
            onChange={(e) => onSecretDraftChange(e.target.value)}
            placeholder={
              hasSecret
                ? "Enter a new value to replace the current secret"
                : "shared secret"
            }
            autoComplete="off"
            className="notification-webhook-input notification-webhook-input--flex"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? "Hide signing secret" : "Show signing secret"}
            aria-pressed={reveal}
          >
            {reveal ? "Hide" : "Show"}
          </Button>
          {hasSecret && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onSecretDraftChange(null);
                setReveal(false);
              }}
              aria-label="Cancel secret replacement"
            >
              Cancel
            </Button>
          )}
        </div>
      ) : (
        <div className="notification-webhook-secret-row">
          <span
            data-testid="notification-webhook-secret-redacted"
            className="notification-webhook-redacted"
          >
            •••• (set)
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onSecretDraftChange("")}
          >
            Replace
          </Button>
        </div>
      )}
      <p className="notification-webhook-hint">
        If set, requests include{" "}
        <code>X-AgentTasks-Signature: sha256=&lt;hmac&gt;</code> over the raw body.
        Recommended for production endpoints.
      </p>
    </div>
  );
}

/**
 * Translate the section's draft state into the body fields the
 * `updateProject` PATCH expects. Returns `undefined` for keys that should
 * not be touched on this save (so the existing PATCH semantics -- "omit =
 * leave unchanged" -- are preserved for unmodified fields).
 */
export function buildWebhookPatch(args: {
  initialWebhookUrl: string | null;
  urlDraft: string;
  secretDraft: string | null;
}): {
  notificationWebhookUrl?: string | null;
  notificationWebhookSecret?: string | null;
} {
  const out: {
    notificationWebhookUrl?: string | null;
    notificationWebhookSecret?: string | null;
  } = {};
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
