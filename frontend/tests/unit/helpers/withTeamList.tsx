/**
 * Test helper: a team-scoped page the way the app mounts it, under the
 * shell's TeamListProvider (AppChrome owns it in the app). The provider loads
 * the list through `getTeams`, so a test's `getTeams` mock feeds the page
 * exactly as it fed the page's own lookup before the shell owned the list.
 * Not a test file (no `.test.` in the name): vitest does not collect it.
 */
import type { ComponentType } from "react";
import { TeamListProvider } from "../../../src/lib/teamList";

export function withTeamList<P extends object>(Page: ComponentType<P>): ComponentType<P> {
  function WithTeamList(props: P) {
    return (
      <TeamListProvider enabled>
        <Page {...props} />
      </TeamListProvider>
    );
  }
  WithTeamList.displayName = `WithTeamList(${Page.displayName ?? Page.name ?? "Page"})`;
  return WithTeamList;
}
