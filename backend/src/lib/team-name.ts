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
 *   - hold no tag character (U+E0020-U+E007F, which can carry an invisible
 *     ASCII payload) except the three exact subdivision flag sequences of
 *     England, Scotland and Wales (U+1F3F4, tag letters, U+E007F), no implicit
 *     direction mark (U+200E, U+200F, U+061C), no interlinear annotation mark
 *     (U+FFF9-U+FFFB), no invisible operator (U+2061-U+2064) and no unassigned
 *     code point (`\p{Cn}`, for example U+0378, U+2065). Most of these are
 *     `\p{Cf}`, but the rest of `\p{Cf}` stays allowed inside a visible name:
 *     the zero-width joiner U+200D in an emoji sequence and the variation
 *     selector U+FE0F are valid;
 *   - hold no more than 8 combining marks in one grapheme cluster, counted
 *     after removing invisible format characters (so zero-width joiners, zero-width
 *     spaces, word joiners, soft hyphens or a BOM cannot split a stack)
 *     (Zalgo text): the mark-cap check runs on a copy of the name with every
 *     `\p{Cf}` code point and U+00AD removed (`withoutInvisibleSeparators`),
 *     splits that copy into grapheme clusters with `Intl.Segmenter` and counts
 *     the `\p{M}` code points per cluster; the stored name is never changed
 *     and Burmese syllables (five marks over two clusters) stay valid;
 *     exactly 8 in one cluster is fine;
 *   - not be empty once the characters that render as nothing are removed:
 *     format characters (`\p{Cf}`, for example the zero-width space),
 *     whitespace, combining marks and variation selectors (`\p{M}`, so a
 *     base letter plus marks stays valid but marks alone do not), the Hangul
 *     fillers (U+115F, U+1160, U+3164, U+FFA0), the braille blank U+2800 and
 *     the object replacement character U+FFFC (a name of only U+FFFC is empty,
 *     U+FFFC inside a visible name stays allowed);
 *   - be at most 100 code points (zod counts code points, not UTF-16 units).
 */
export const TEAM_NAME_MAX_LENGTH = 100;

export const TEAM_NAME_CONTROL_MESSAGE = "Team name must not contain control characters";
export const TEAM_NAME_ENCODING_MESSAGE = "Team name must be valid text (no unpaired surrogate characters)";
export const TEAM_NAME_EMPTY_MESSAGE = "Team name must not be empty";
export const TEAM_NAME_DIRECTION_MESSAGE =
  "Team name must not contain line or paragraph separators or text direction controls";
export const TEAM_NAME_UNASSIGNED_MESSAGE = "Team name must not contain private-use or noncharacter code points";
export const TEAM_NAME_INVISIBLE_MESSAGE = "Team name must not contain invisible or unassigned characters";
export const TEAM_NAME_MARKS_MESSAGE = "Team name must not stack more than 8 combining marks on one character";
export const TEAM_NAME_LENGTH_MESSAGE = `Team name must be at most ${TEAM_NAME_MAX_LENGTH} characters`;

/**
 * The invisible or smuggling code points refused anywhere in the name: the tag
 * characters U+E0020-U+E007F (they can carry an invisible ASCII payload, save
 * for the subdivision flags below), the implicit direction marks U+200E, U+200F
 * and U+061C, the interlinear annotation marks U+FFF9-U+FFFB, the invisible
 * operators U+2061-U+2064 and every unassigned code point (`\p{Cn}`, e.g.
 * U+0378). Most of them are `\p{Cf}`, but the rest of `\p{Cf}` must stay valid
 * inside a visible name (the zero-width joiner U+200D, the variation selector
 * U+FE0F), so `\p{Cf}` is not used here.
 */
const INVISIBLE_CODE_POINTS = /[\u061c\u200e\u200f\u2061-\u2064\u{fff9}-\u{fffb}\u{e0020}-\u{e007f}]|\p{Cn}/u;

/**
 * The three RGI subdivision flag sequences that stay valid: England, Scotland
 * and Wales, each U+1F3F4 followed by five tag letters and the cancel tag
 * U+E007F. They are removed from the value before the invisible-character
 * check only (the stored name keeps them); any other tag character, a tag run
 * without the leading U+1F3F4, a partial sequence or one without U+E007F is
 * still refused.
 */
const RGI_SUBDIVISION_FLAGS = [
  "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}", // England
  "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}", // Scotland
  "\u{1f3f4}\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f}", // Wales
];

/** One `\p{M}` code point (`u`-mode counts code points, not UTF-16 units). */
const COMBINING_MARK = /\p{M}/gu;

/** A grapheme cluster with more combining marks than this is refused. */
const MARK_CLUSTER_CAP = 8;

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Invisible separators (zero-width spaces, word joiners, soft hyphens, a BOM:
 * `\p{Cf}` and U+00AD) each split a grapheme cluster, so they are removed from
 * the copy used for the mark-cap check only, never from the stored name.
 */
function withoutInvisibleSeparators(value: string): string {
  return value.replace(/[\p{Cf}\u00ad]/gu, "");
}

/** True when one grapheme cluster stacks more than `MARK_CLUSTER_CAP` marks. */
function exceedsMarkCap(value: string): boolean {
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    if ((segment.match(COMBINING_MARK) ?? []).length > MARK_CLUSTER_CAP) return true;
  }
  return false;
}

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
    (value) => !INVISIBLE_CODE_POINTS.test(RGI_SUBDIVISION_FLAGS.reduce((v, flag) => v.replaceAll(flag, ""), value)),
    TEAM_NAME_INVISIBLE_MESSAGE,
  )
  .refine((value) => !exceedsMarkCap(withoutInvisibleSeparators(value)), TEAM_NAME_MARKS_MESSAGE)
  .refine(
    (value) => value.replace(/[\p{Cf}\p{M}\s\u115f\u1160\u3164\uffa0\u2800\ufffc]/gu, "").length > 0,
    TEAM_NAME_EMPTY_MESSAGE,
  )
  .max(TEAM_NAME_MAX_LENGTH, TEAM_NAME_LENGTH_MESSAGE);
