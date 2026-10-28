/**
 * isBlankTeamName (lib/teamName.ts): the client mirror of the server's blank
 * class. A name that renders as nothing is blank, so the submit controls stay
 * disabled; a name with anything visible left is not blank and the server's 400
 * message is shown for everything the client does not judge.
 */
import { describe, it, expect } from "vitest";
import { isBlankTeamName } from "../../src/lib/teamName";

describe("isBlankTeamName", () => {
  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["NBSP", "\u00a0"],
    ["a zero-width space", "\u200b"],
    ["the Hangul filler U+3164", "\u3164"],
    ["the braille blank U+2800", "\u2800"],
    ["a combining mark", "\u0301"],
    ["a variation selector", "\ufe0f"],
    ["the object replacement character U+FFFC", "\ufffc"],
    ["U+FFFC and whitespace", " \ufffc "],
    ["U+FFFC and other blanks", "\ufffc\u200b\u3164\u0301"],
  ] as const)("treats %s as blank", (_label, value) => {
    expect(isBlankTeamName(value)).toBe(true);
  });

  it.each([
    ["a normal name", "Team Nord"],
    ["U+FFFC inside a visible name", "Team \ufffc A"],
    ["U+FFFC at the edge of a visible name", "\ufffcTeam"],
    ["a base letter with combining marks", "Cafe\u0301"],
    ["an emoji ZWJ sequence", "\u{1f468}\u200d\u{1f469}"],
    ["the invisible characters the server refuses outright", "a\u{e0020}\u200e\u0378b"],
  ] as const)("does not treat %s as blank", (_label, value) => {
    expect(isBlankTeamName(value)).toBe(false);
  });
});
