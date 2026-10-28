"use client";

// The one mechanism for the browser tab title: a page or layout renders
// <DocumentTitle title="Tasks" /> and the tab reads "Tasks - agent-tasks".
// The title is set in an effect (client-side), so it can use loaded data such
// as a project or task name; the segment `metadata` exports only supply the
// server-rendered fallback until then, where a route has one.

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

export const TITLE_SUFFIX = "agent-tasks";

/** "<title> - agent-tasks"; the bare suffix for an empty title. */
export function formatDocumentTitle(title: string | null | undefined): string {
  const t = title?.trim();
  return t ? `${t} - ${TITLE_SUFFIX}` : TITLE_SUFFIX;
}

// Set when the title or `enabled` changes, which includes the mount of the page
// or layout that owns it. A navigation to another page renders the new
// document head (with the segment's server-rendered title) in the same commit
// that changes or mounts the title of the page it lands on, so the effect runs
// after the head and wins. Two cases change no title prop: a query-only URL
// change, which therefore goes through history.replaceState (the board
// modal's `?taskId=`; it does not re-render the head), and a soft navigation
// to the same URL, which mounts the server-rendered <title> again; a route
// whose title only the client knows renders none
// (app/projects/[id]/layout.tsx).
// The title setter creates one when the document has no <title> element, so
// on a route whose segment metadata renders none the hook above would leave
// an unmanaged element behind: after a client navigation away, the next
// route's React/Next-managed <title> is inserted alongside it and head holds
// two. So when the effect finds no <title> at all it takes ownership of the
// element its assignment creates and removes exactly that element on unmount
// (only while it is still in head; a title that existed when the effect ran,
// Next/React-managed or not, is never removed). Removal happens only on
// unmount, never when the title changes while the owner stays mounted: a
// re-run updates the owned element in place, so the tab never flickers empty.
export function useDocumentTitle(title: string | null | undefined, enabled = true): void {
  const ownedRef = useRef<HTMLTitleElement | null>(null);
  useEffect(() => {
    return () => {
      const owned = ownedRef.current;
      ownedRef.current = null;
      if (owned && owned.parentNode === document.head) owned.remove();
    };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    // Head only: an inline SVG <title> in the body is not the document title.
    const hadTitle = document.head.querySelector("title") !== null;
    document.title = formatDocumentTitle(title);
    if (!hadTitle && ownedRef.current === null) {
      ownedRef.current = document.head.querySelector("title");
    }
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
