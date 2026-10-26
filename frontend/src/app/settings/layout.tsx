import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ExactPathTitle } from "../../components/DocumentTitle";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ExactPathTitle path="/settings" title="Settings" />
      {children}
    </>
  );
}
