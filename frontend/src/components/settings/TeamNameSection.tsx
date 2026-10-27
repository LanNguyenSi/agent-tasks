"use client";

// Team name card on /settings/team. Team admins get an edit form; everyone
// else sees the name only. The slug is not editable: it never changes.

import { useState } from "react";
import { renameTeam, type Team } from "../../lib/api";
import AlertBanner from "../ui/AlertBanner";
import { Button } from "../ui/Button";
import Card from "../ui/Card";
import FormField from "../ui/FormField";

// Mirrors the server's 100 limit (PATCH /api/teams/:id). The server counts
// code points, the input's maxLength counts UTF-16 units, so for astral
// characters (emoji) the input is stricter than the server, never looser.
const MAX_NAME_LENGTH = 100;

interface TeamNameSectionProps {
  team: Team;
  /**
   * Called once the server accepted the new name (also when this section is
   * gone by then, e.g. after a team switch), so the caller can reload the
   * shared team list.
   */
  onRenamed: (team: Team) => void;
}

export default function TeamNameSection({ team, onRenamed }: TeamNameSectionProps) {
  const isAdmin = team.role === "ADMIN";
  const [value, setValue] = useState(team.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const trimmed = value.trim();
  const unchanged = trimmed === team.name;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !trimmed || unchanged) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await renameTeam(team.id, trimmed);
      setValue(updated.name);
      setSaved(true);
      onRenamed(updated);
    } catch (err) {
      // The old name stays: the input keeps what was typed so it can be fixed.
      setError(err instanceof Error ? err.message : "Failed to rename the team.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <section id="team-name">
        <h2 className="settings-section-heading">Team name</h2>
        {isAdmin ? (
          <form onSubmit={(e) => void handleSubmit(e)} className="settings-team-name-form">
            <FormField
              label="Name"
              hint="Shown in the header and the team switcher. The team slug does not change."
            >
              <input
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setSaved(false);
                }}
                maxLength={MAX_NAME_LENGTH}
                required
                className="settings-input"
                autoComplete="off"
              />
            </FormField>
            {(error || saved) && (
              <div className="settings-team-name-feedback">
                {error && (
                  <AlertBanner tone="danger" title="Failed to rename team">
                    {error}
                  </AlertBanner>
                )}
                {saved && !error && <AlertBanner tone="success">Team name saved.</AlertBanner>}
              </div>
            )}
            <div className="settings-team-name-actions">
              <Button
                type="submit"
                size="sm"
                disabled={saving || !trimmed || unchanged}
                loading={saving}
              >
                Save name
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p className="settings-team-name-value">{team.name}</p>
            <p className="settings-section-desc">Only team admins can rename the team.</p>
          </>
        )}
      </section>
    </Card>
  );
}
