/**
 * Client side of the team-name rule that `POST /api/teams` and
 * `PATCH /api/teams/:id` enforce (backend `teamNameSchema`): the name is
 * trimmed and must not be empty once format characters (`\p{Cf}`, for example
 * the zero-width space) and whitespace are removed. The server stays the
 * authority (control characters, the 100 code point limit): this only keeps
 * the submit controls honest for a name that renders as nothing, and the
 * server's 400 message is shown for everything else.
 */
export function isBlankTeamName(value: string): boolean {
  return value.replace(/[\p{Cf}\s]/gu, "").length === 0;
}
