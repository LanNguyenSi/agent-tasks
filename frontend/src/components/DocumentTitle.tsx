"use client";

// The one mechanism for the browser tab title: a page or layout renders
// <DocumentTitle title="Tasks" /> and the tab reads "Tasks - agent-tasks".
// The title is set in an effect (client-side), so it can use loaded data such
// as a project or task name; the segment `metadata` exports only supply the
// server-rendered fallback until then.

import { useEffect } from "react";
import { usePathname } from "next/navigation";

export const TITLE_SUFFIX = "agent-tasks";

/** "<title> - agent-tasks"; the bare suffix for an empty title. */
export function formatDocumentTitle(title: string | null | undefined): string {
  const t = title?.trim();
  return t ? `${t} - ${TITLE_SUFFIX}` : TITLE_SUFFIX;
}

export function useDocumentTitle(title: string | null | undefined, enabled = true): void {
  useEffect(() => {
    if (enabled) document.title = formatDocumentTitle(title);
  }, [title, enabled]);
}

export default function DocumentTitle({ title }: { title: string | null | undefined }) {
  useDocumentTitle(title);
  return null;
}

/**
 * Title for a route that has nested routes below it. A layout's effect runs
 * after its children's, so a plain <DocumentTitle> in a layout would overwrite
 * the title of a deeper page that sets its own. This sets the title only while
 * the current pathname is exactly `path`.
 */
export function ExactPathTitle({ path, title }: { path: string; title: string }) {
  const pathname = usePathname();
  useDocumentTitle(pathname === path ? title : undefined, pathname === path);
  return null;
}
