/**
 * Confluence/Jira Wiki Markup → Markdown converter.
 *
 * Detects whether a string contains Wiki Markup and converts it to Markdown.
 * Handles the most common patterns found in Jira Excel exports.
 */

// Patterns that indicate Wiki Markup (vs plain text or Markdown)
const WIKI_DETECTION_PATTERNS = [
  /\|\|.*\|\|/,                    // ||table header||
  /^\s*h[1-6]\.\s/m,              // h1. Heading
  /\(\/\)/,                         // (/) checkmark
  /\[~accountid:/,                 // [~accountid:...] mentions
  /\{color[:#]/,                   // {color:...}...{color}
  /\[([^|[\]]+)\|([^\]]+)\]/,     // [text|url] links
];

/**
 * Check if text looks like Confluence Wiki Markup
 */
export function isWikiMarkup(text: string): boolean {
  if (!text) return false;
  let hits = 0;
  for (const pattern of WIKI_DETECTION_PATTERNS) {
    if (pattern.test(text)) hits++;
  }
  // Need at least 2 pattern matches to be confident
  return hits >= 2;
}

/**
 * Convert Confluence Wiki Markup to Markdown.
 * If the text doesn't look like Wiki Markup, returns it unchanged.
 */
export function wikiToMarkdown(text: string): string {
  if (!text || !isWikiMarkup(text)) return text;

  let result = text;

  // -- Numbered lists FIRST (before headings, since Wiki # = list, not heading)
  result = result.replace(/^##\s+/gm, "   1. ");
  result = result.replace(/^#\s+/gm, "1. ");

  // -- Headings: h1. → #, h2. → ##, etc.
  result = result.replace(/^h1\.\s*(.+)$/gm, "# $1");
  result = result.replace(/^h2\.\s*(.+)$/gm, "## $1");
  result = result.replace(/^h3\.\s*(.+)$/gm, "### $1");
  result = result.replace(/^h4\.\s*(.+)$/gm, "#### $1");
  result = result.replace(/^h5\.\s*(.+)$/gm, "##### $1");
  result = result.replace(/^h6\.\s*(.+)$/gm, "###### $1");

  // -- Status icons
  result = result.replace(/\(\/\)/g, "\u2705"); // ✅
  result = result.replace(/\(x\)/g, "\u274C"); // ❌
  result = result.replace(/\(\?\)/g, "\u2753"); // ❓
  result = result.replace(/\(-\)/g, "\u2796"); // ➖
  result = result.replace(/\(!\)/g, "\u26A0\uFE0F"); // ⚠️
  result = result.replace(/\(\+\)/g, "\u2795"); // ➕
  result = result.replace(/\(i\)/g, "\u2139\uFE0F"); // ℹ️
  result = result.replace(/\(\*\)/g, "\u2B50"); // ⭐
  result = result.replace(/\u23F3/g, "\u23F3"); // preserve ⌚ already in text

  // -- Color markup: {color:#hex}text{color} → just the text
  result = result.replace(/\{color[:#][^}]*\}([\s\S]*?)\{color\}/g, "$1");

  // -- Mentions: [~accountid:...] → @user
  result = result.replace(/\[~accountid:[^\]]+\]/g, "@user");

  // -- Links: [text|url] → [text](url)
  // Also handle [url|url] and [text|url|smart-link]
  result = result.replace(/\[([^|[\]]+)\|([^|\]]+?)(?:\|[^\]]*?)?\]/g, "[$1]($2)");

  // -- Bare links: [url] (no pipe) → [url](url)
  result = result.replace(/\[(https?:\/\/[^\]]+)\]/g, "[$1]($1)");

  // -- Tables: ||*Header*||*Header*|| → | **Header** | **Header** |
  // First handle header rows
  result = result.replace(/^\|\|(.*)\|\|\s*$/gm, (_, content: string) => {
    const cells = content.split("||").map((c: string) => c.trim());
    const headerRow = "| " + cells.join(" | ") + " |";
    const separatorRow = "| " + cells.map(() => "---").join(" | ") + " |";
    return headerRow + "\n" + separatorRow;
  });

  // Then handle data rows: |cell|cell| → | cell | cell |
  result = result.replace(/^\|(?!\|)(.*)\|\s*$/gm, (_, content: string) => {
    const cells = content.split("|").map((c: string) => c.trim());
    return "| " + cells.join(" | ") + " |";
  });

  // -- Bold: *text* → **text** (but not inside URLs or already-Markdown)
  // Only match *word(s)* not preceded/followed by * or inside []()
  result = result.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, "**$1**");

  // -- Italic: _text_ → *text* (Markdown italic)
  result = result.replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, "*$1*");

  // -- Strikethrough: -text- → ~~text~~
  result = result.replace(/(?<![-\w])-([^-\n]+?)-(?![-\w])/g, "~~$1~~");

  // -- Monospace: {{text}} → `text`
  result = result.replace(/\{\{([^}]+)\}\}/g, "`$1`");

  // -- Code blocks: {code}...{code} → ```...```
  result = result.replace(/\{code(?::[^}]*)?\}([\s\S]*?)\{code\}/g, "```\n$1\n```");

  // -- Noformat: {noformat}...{noformat} → ```...```
  result = result.replace(/\{noformat\}([\s\S]*?)\{noformat\}/g, "```\n$1\n```");

  // -- Quote: {quote}...{quote} → > ...
  result = result.replace(/\{quote\}([\s\S]*?)\{quote\}/g, (_, content: string) => {
    return content.split("\n").map((line: string) => `> ${line}`).join("\n");
  });

  // -- Bullet lists: * item → - item (but only at line start)
  result = result.replace(/^\*\s+/gm, "- ");
  result = result.replace(/^\*\*\s+/gm, "  - ");

  // -- Horizontal rule: ---- → ---
  result = result.replace(/^-{4,}\s*$/gm, "---");

  // -- Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}
