const ROLE_LABELS: Record<string, string> = {
  PROJECT_VIEWER: "Viewer",
  PROJECT_CONTRIBUTOR: "Contributor",
  PROJECT_ADMIN: "Admin",
};

/**
 * Friendly label for a ProjectMemberRole enum value. Falls back to the raw
 * value for anything unmapped so a new role never renders as blank.
 */
export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}
