/**
 * Test helper: assert the browser tab title.
 *
 * The title is written by a passive effect (`useDocumentTitle` in
 * components/DocumentTitle.tsx). When the render that brings the effect's
 * component in is a promise-driven update (a page whose title comes from a
 * loaded task or project), the DOM a test awaits can be on screen before that
 * effect has run, so reading `document.title` right after a `findBy*` is a
 * race that only shows under load. Use this helper instead of a bare
 * `expect(document.title)`: it retries until the title matches. The ESLint
 * rule scoped to `tests/**` (eslint.config.mjs) flags a bare read.
 * Not a test file (no `.test.` in the name): vitest does not collect it.
 */
import { expect } from "vitest";
import { waitFor } from "@testing-library/react";

export async function expectDocumentTitle(expected: string): Promise<void> {
  await waitFor(() => expect(document.title).toBe(expected));
}
