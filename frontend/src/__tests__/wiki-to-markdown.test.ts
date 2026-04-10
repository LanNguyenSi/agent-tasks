import { describe, it, expect } from "vitest";
import { isWikiMarkup, wikiToMarkdown } from "../lib/wiki-to-markdown";

describe("isWikiMarkup", () => {
  it("detects wiki markup with multiple patterns", () => {
    expect(isWikiMarkup("h1. Title\n||*Col*||*Col*||\n|a|b|")).toBe(true);
  });

  it("detects mentions + status icons", () => {
    expect(isWikiMarkup("[~accountid:abc] did (/) something")).toBe(true);
  });

  it("rejects plain text", () => {
    expect(isWikiMarkup("Just a normal description")).toBe(false);
  });

  it("rejects markdown", () => {
    expect(isWikiMarkup("# Heading\n\n- item\n- item")).toBe(false);
  });

  it("rejects empty/null", () => {
    expect(isWikiMarkup("")).toBe(false);
  });
});

describe("wikiToMarkdown", () => {
  it("converts headings", () => {
    expect(wikiToMarkdown("h1. Title\n(/) done\n[~accountid:x]")).toContain("# Title");
    expect(wikiToMarkdown("h2. Sub\n(/) ok\n[~accountid:x]")).toContain("## Sub");
    expect(wikiToMarkdown("h3. Deep\n(/) ok\n[~accountid:x]")).toContain("### Deep");
  });

  it("converts status icons", () => {
    const input = "h1. X\n(/) done (x) fail (?) unknown (-) skip\n[~accountid:x]";
    const result = wikiToMarkdown(input);
    expect(result).toContain("\u2705"); // ✅
    expect(result).toContain("\u274C"); // ❌
    expect(result).toContain("\u2753"); // ❓
  });

  it("strips color markup", () => {
    const input = "h1. X\n{color:#ffc400}warning text{color}\n[~accountid:x]";
    const result = wikiToMarkdown(input);
    expect(result).toContain("warning text");
    expect(result).not.toContain("{color");
  });

  it("converts mentions to @user", () => {
    const input = "h1. X\n[~accountid:712020:abc-def] assigned\n(/) done";
    const result = wikiToMarkdown(input);
    expect(result).toContain("@user");
    expect(result).not.toContain("accountid");
  });

  it("converts wiki links to markdown links", () => {
    const input = "h1. X\n[Click here|https://example.com]\n(/) done\n[~accountid:x]";
    const result = wikiToMarkdown(input);
    expect(result).toContain("[Click here](https://example.com)");
  });

  it("handles smart-link suffix", () => {
    const input = "h1. X\n[text|https://example.com|smart-link]\n(/) ok\n[~accountid:x]";
    const result = wikiToMarkdown(input);
    expect(result).toContain("[text](https://example.com)");
  });

  it("converts table headers", () => {
    const input = "||*ToDo*||*Status*||*Wer*||\n|task|(/)| me|\n[~accountid:x]";
    const result = wikiToMarkdown(input);
    expect(result).toContain("| **ToDo** | **Status** | **Wer** |");
    expect(result).toContain("---");
  });

  it("converts monospace", () => {
    const input = "h1. X\nuse {{pfaduml-pp}} group\n(/) ok\n[~accountid:x]";
    const result = wikiToMarkdown(input);
    expect(result).toContain("`pfaduml-pp`");
  });

  it("converts code blocks", () => {
    const input = "h1. X\n{code:java}int x = 1;{code}\n(/) ok\n[~accountid:x]";
    const result = wikiToMarkdown(input);
    expect(result).toContain("```\nint x = 1;\n```");
  });

  it("returns plain text unchanged", () => {
    const input = "Just a regular description without any wiki markup.";
    expect(wikiToMarkdown(input)).toBe(input);
  });

  it("handles real Jira onboarding description patterns", () => {
    const input = `h1. Allgemein

||*ToDo*||*Status*||*Wer kümmert sich*||*Kommentar*||
|dem Team hinzufügen|(/)|[~accountid:712020:abc]| |
|bei Jarvis registrieren|(/)|[~accountid:62b453bd]|In Jarvis muss sich einloggen. [https://jarvis.internal.example.com|https://jarvis.internal.example.com]|
|{color:#ffc400}Freigabe erfolgt bei Bedarf.{color}|(?)| | |`;

    const result = wikiToMarkdown(input);
    expect(result).toContain("# Allgemein");
    expect(result).toContain("| **ToDo** |");
    expect(result).toContain("\u2705"); // (/)
    expect(result).toContain("\u2753"); // (?)
    expect(result).toContain("@user");
    expect(result).toContain("Freigabe erfolgt bei Bedarf.");
    expect(result).not.toContain("{color");
    expect(result).toContain("[https://jarvis.internal.example.com](https://jarvis.internal.example.com)");
  });
});
