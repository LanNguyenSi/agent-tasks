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
 *   - not be empty once format characters (`\p{Cf}`, for example the
 *     zero-width space) and whitespace are removed, so a name that renders as
 *     nothing is refused;
 *   - be at most 100 code points (zod counts code points, not UTF-16 units).
 */
export const TEAM_NAME_MAX_LENGTH = 100;

export const TEAM_NAME_CONTROL_MESSAGE = "Team name must not contain control characters";
export const TEAM_NAME_ENCODING_MESSAGE = "Team name must be valid text (no unpaired surrogate characters)";
export const TEAM_NAME_EMPTY_MESSAGE = "Team name must not be empty";
export const TEAM_NAME_LENGTH_MESSAGE = `Team name must be at most ${TEAM_NAME_MAX_LENGTH} characters`;

export const teamNameSchema = z
  .string()
  .trim()
  .refine((value) => !/\p{Cc}/u.test(value), TEAM_NAME_CONTROL_MESSAGE)
  .refine((value) => !/\p{Cs}/u.test(value), TEAM_NAME_ENCODING_MESSAGE)
  .refine((value) => value.replace(/[\p{Cf}\s]/gu, "").length > 0, TEAM_NAME_EMPTY_MESSAGE)
  .max(TEAM_NAME_MAX_LENGTH, TEAM_NAME_LENGTH_MESSAGE);
