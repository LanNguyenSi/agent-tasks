import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: { absolute: "Single sign-on - agent-tasks" } };

export default function SsoSettingsLayout({ children }: { children: ReactNode }) {
  return children;
}
