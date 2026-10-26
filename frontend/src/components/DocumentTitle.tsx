"use client";

// The one mechanism for the browser tab title: a page or layout renders
// <DocumentTitle title="Tasks" /> and the tab reads "Tasks - agent-tasks".
// The title is set in an effect (client-side), so it can use loaded data such
// as a project or task name; the segment `metadata` exports only supply the
// server-rendered fallback until then.

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export const TITLE_SUFFIX = "agent-tasks";

/** "<title> - agent-tasks"; the bare suffix for an empty title. */
export function formatDocumentTitle(title: string | null | undefined): string {
  const t = title?.trim();
  return t ? `${t} - ${TITLE_SUFFIX}` : TITLE_SUFFIX;
}

// Next re-applies the server-rendered segment title in places a title
// component's props do not change: after a router.replace that only changes
// the query (the board modal adds and drops `?taskId=`), and on a reload that
// restores the router state of such an entry. So the title is set again
// after every navigation commit (pathname and query string are effect
// dependencies), and while the component is mounted on its own route a change
// to the <title> element is undone. The route guard keeps a leaving page from
// overwriting the title of the page that replaces it.
export function useDocumentTitle(title: string | null | undefined, enabled = true): void {
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? "";
  useEffect(() => {
    if (!enabled) return;
    const wanted = formatDocumentTitle(title);
    document.title = wanted;
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (window.location.pathname !== pathname) return;
      if (document.title !== wanted) document.title = wanted;
    });
    observer.observe(document.head, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [title, enabled, pathname, search]);
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
