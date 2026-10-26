import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ExactPathTitle } from "../../../components/DocumentTitle";

export const metadata: Metadata = { title: { absolute: "Team settings - agent-tasks" } };

export default function TeamSettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ExactPathTitle path="/settings/team" title="Team settings" />
      <ExactPathTitle path="/settings/team/sso" title="Single sign-on" />
      {children}
    </>
  );
}
