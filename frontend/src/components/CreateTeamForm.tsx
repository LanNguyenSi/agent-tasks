"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createTeam } from "../lib/api";
import { rememberTeam } from "../lib/currentTeam";
import { sectionHref } from "../lib/teamSwitch";
import AlertBanner from "./ui/AlertBanner";
import { Button } from "./ui/Button";
import FormField from "./ui/FormField";

interface CreateTeamFormProps {
  /**
   * Given: the form sits in a dialog and ends in a "Create team" + Cancel
   * row. Absent: the first-team page, a full-width "Create team" button.
   */
  onCancel?: () => void;
  /** Called after the team was created and its Home was opened. */
  onCreated?: () => void;
}

/** Slug suggestion from a team name: lowercase, hyphens, at most 50 chars. */
function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 50);
}

/**
 * The create-team form shared by the first-team onboarding page and the
 * "New team" dialog. Creating remembers the new team and opens its Home.
 */
export default function CreateTeamForm({ onCancel, onCreated }: CreateTeamFormProps) {
  const router = useRouter();
  const [teamName, setTeamName] = useState("");
  const [teamSlug, setTeamSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleNameChange(name: string) {
    setTeamName(name);
    // Don't clobber a slug the user has hand-edited.
    if (!slugTouched) setTeamSlug(slugFromName(name));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!teamName.trim() || !teamSlug.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const team = await createTeam({ name: teamName.trim(), slug: teamSlug.trim() });
      // Switch to the new team: remember it and open its Home.
      rememberTeam(team.id);
      router.replace(sectionHref("home", team.id));
      onCreated?.();
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleCreate(e)} className="auth-form-grid">
      <FormField label="Team name">
        <input
          type="text"
          autoComplete="organization"
          value={teamName}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="My Team"
          required
        />
      </FormField>

      <FormField
        label="Slug"
        hint={
          "Used in URLs. Lowercase, hyphens only." +
          (!slugTouched ? " Auto-generated from the name." : "")
        }
      >
        <input
          type="text"
          autoComplete="off"
          value={teamSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setTeamSlug(e.target.value);
          }}
          placeholder="my-team"
          pattern="[a-z0-9-]+"
          required
          className="auth-slug-input"
        />
      </FormField>

      {error && (
        <AlertBanner tone="danger" title="Failed to create team">
          {error}
        </AlertBanner>
      )}

      {onCancel ? (
        <div className="settings-modal-actions">
          <Button
            type="submit"
            size="sm"
            disabled={creating || !teamName || !teamSlug}
            loading={creating}
          >
            Create team
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          type="submit"
          disabled={creating || !teamName || !teamSlug}
          loading={creating}
          className="auth-btn-full"
        >
          Create team
        </Button>
      )}
    </form>
  );
}
