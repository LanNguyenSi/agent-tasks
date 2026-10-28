import { z } from "zod";

/**
 * The one team-name rule, shared by `POST /teams` and `PATCH /teams/:id`.
 *
 * After trimming (`String.prototype.trim`, which also strips NBSP and other
 * Unicode whitespace) the name must
 *   - hold no control character (`\p{Cc}`: C0 incl. NUL, newline and tab,
 *     DEL and C1). A NUL byte cannot be stored in a Postgres text column and
 *     used to surface as a 500;
 *   - be well-formed Unicode: no unpaired UTF-16 surrogate. A JSON string
 *     such as "\ud800" parses to one, and Prisma refuses to send it to
 *     Postgres, which used to surface as a 500. `\p{Cs}` in u-mode matches
 *     only an unpaired surrogate (a valid pair is one astral code point), so
 *     emoji pass; it needs no `String.prototype.isWellFormed` typings;
 *   - hold no line or paragraph separator (`\p{Zl}`, `\p{Zp}`: U+2028,
 *     U+2029) and no bidirectional control (U+202A-U+202E, U+2066-U+2069),
 *     which can break or reorder the text around the name;
 *   - hold no private-use character (`\p{Co}`) and no noncharacter (U+FDD0-U+FDEF
 *     and the last two code points of every plane), which render as nothing
 *     or as a box;
 *   - not be empty once the characters that render as nothing are removed:
 *     format characters (`\p{Cf}`, for example the zero-width space),
 *     whitespace, combining marks and variation selectors (`\p{M}`, so a
 *     base letter plus marks stays valid but marks alone do not), the Hangul
 *     fillers (U+115F, U+1160, U+3164, U+FFA0) and the braille blank U+2800;
 *   - be at most 100 code points (zod counts code points, not UTF-16 units).
 */
export const TEAM_NAME_MAX_LENGTH = 100;

export const TEAM_NAME_CONTROL_MESSAGE = "Team name must not contain control characters";
export const TEAM_NAME_ENCODING_MESSAGE = "Team name must be valid text (no unpaired surrogate characters)";
export const TEAM_NAME_EMPTY_MESSAGE = "Team name must not be empty";
export const TEAM_NAME_DIRECTION_MESSAGE =
  "Team name must not contain line or paragraph separators or text direction controls";
export const TEAM_NAME_UNASSIGNED_MESSAGE = "Team name must not contain private-use or noncharacter code points";
export const TEAM_NAME_LENGTH_MESSAGE = `Team name must be at most ${TEAM_NAME_MAX_LENGTH} characters`;

/** True for a noncharacter: U+FDD0-U+FDEF or a code point ending in FFFE/FFFF. */
function hasNoncharacter(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) return true;
  }
  return false;
}

export const teamNameSchema = z
  .string()
  .trim()
  .refine((value) => !/\p{Cc}/u.test(value), TEAM_NAME_CONTROL_MESSAGE)
  .refine((value) => !/\p{Cs}/u.test(value), TEAM_NAME_ENCODING_MESSAGE)
  .refine((value) => !/[\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(value), TEAM_NAME_DIRECTION_MESSAGE)
  .refine((value) => !/\p{Co}/u.test(value) && !hasNoncharacter(value), TEAM_NAME_UNASSIGNED_MESSAGE)
  .refine(
    (value) => value.replace(/[\p{Cf}\p{M}\s\u115f\u1160\u3164\uffa0\u2800]/gu, "").length > 0,
    TEAM_NAME_EMPTY_MESSAGE,
  )
  .max(TEAM_NAME_MAX_LENGTH, TEAM_NAME_LENGTH_MESSAGE);
