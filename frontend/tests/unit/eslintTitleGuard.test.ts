/**
 * The ESLint guard against a bare `document.title` read in a test
 * (eslint.config.mjs, `no-restricted-syntax` for tests/**): each spelling of
 * the read is flagged outside waitFor, and the sanctioned forms are not.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { ESLint } from "eslint";

const cwd = path.resolve(__dirname, "../..");
const eslint = new ESLint({ cwd, overrideConfigFile: path.join(cwd, "eslint.config.mjs") });
const FILE = path.join(cwd, "tests/unit/fixture.test.ts");

async function rules(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: FILE });
  return result.messages.map((m) => m.ruleId ?? "parse-error");
}

const FLAGGED: Array<[string, string]> = [
  ["document.title", "expect(document.title).toBe('x');"],
  ["window.document.title", "expect(window.document.title).toBe('x');"],
  ["globalThis.document.title", "expect(globalThis.document.title).toBe('x');"],
  ["destructured from document", "const { title } = document;\nexpect(title).toBe('x');"],
  ["destructured from window.document", "const { title } = window.document;\nexpect(title).toBe('x');"],
  ["destructured from globalThis.document", "const { title } = globalThis.document;\nexpect(title).toBe('x');"],
  ["destructured after another property", "const { body, title } = document;\nexpect(title).toBe('x');"],
  ["computed document['title']", "expect(document['title']).toBe('x');"],
  ["computed window.document['title']", "expect(window.document['title']).toBe('x');"],
  ["computed globalThis.document['title']", "expect(globalThis.document['title']).toBe('x');"],
  ["self.document.title", "expect(self.document.title).toBe('x');"],
  ["destructured from self.document", "const { title } = self.document;\nexpect(title).toBe('x');"],
  ["aliased from document.title", "const t = document.title;\nexpect(t).toBe('x');"],
  ["aliased from window.document['title']", "const t = window.document['title'];\nexpect(t).toBe('x');"],
  ["aliased from self.document.title", "const t = self.document.title;\nexpect(t).toBe('x');"],
  ["nested destructured from window", "const { document: { title } } = window;\nexpect(title).toBe('x');"],
  ["nested destructured from globalThis", "const { document: { title } } = globalThis;\nexpect(title).toBe('x');"],
  ["nested destructured from self", "const { document: { title } } = self;\nexpect(title).toBe('x');"],
];

const ALLOWED: Array<[string, string]> = [
  ["inside waitFor", "await waitFor(() => expect(document.title).toBe('x'));"],
  ["inside vi.waitFor", "await vi.waitFor(() => expect(window.document.title).toBe('x'));"],
  ["destructured inside waitFor", "await waitFor(() => { const { title } = document; expect(title).toBe('x'); });"],
  ["computed inside waitFor", "await waitFor(() => expect(document['title']).toBe('x'));"],
  ["self inside vi.waitFor", "await vi.waitFor(() => expect(self.document.title).toBe('x'));"],
  ["aliased inside waitFor", "await waitFor(() => { const t = self.document.title; expect(t).toBe('x'); });"],
  ["nested destructured inside waitFor", "await waitFor(() => { const { document: { title } } = window; expect(title).toBe('x'); });"],
  ["via the helper", "await expectDocumentTitle('x');"],
  ["unrelated title", "expect(task.title).toBe('x');\nconst { title } = task;\nconst t = task.title;"],
  ["unrelated nested destructure", "const { meta: { title } } = task;"],
  ["window title, not the document's", "const { title } = window;"],
];

describe("tests/** document.title guard", () => {
  it.each(FLAGGED)("flags %s outside waitFor", async (_name, code) => {
    expect(await rules(code)).toContain("no-restricted-syntax");
  });

  it.each(ALLOWED)("allows %s", async (_name, code) => {
    const found = await rules(code);
    expect(found).not.toContain("parse-error");
    expect(found).not.toContain("no-restricted-syntax");
  });
});
