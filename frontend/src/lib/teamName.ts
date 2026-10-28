/**
 * Client side of the team-name rule that `POST /api/teams` and
 * `PATCH /api/teams/:id` enforce (backend `teamNameSchema`): the name is
 * trimmed and must not be empty once the characters that render as nothing are
 * removed: format characters (`\p{Cf}`, for example the zero-width space),
 * whitespace, combining marks and variation selectors (`\p{M}`), the Hangul
 * fillers (U+115F, U+1160, U+3164, U+FFA0) and the braille blank U+2800. The
 * server stays the authority (control characters, separators and direction
 * controls, private use, the 100 code point limit): this only keeps
 * the submit controls honest for a name that renders as nothing, and the
 * server's 400 message is shown for everything else.
 */
export function isBlankTeamName(value: string): boolean {
  return value.replace(/[\p{Cf}\p{M}\s\u115f\u1160\u3164\uffa0\u2800]/gu, "").length === 0;
}
