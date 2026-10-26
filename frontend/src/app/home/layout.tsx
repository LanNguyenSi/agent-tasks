import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ExactPathTitle } from "../../components/DocumentTitle";

export const metadata: Metadata = { title: "Home" };

export default function HomeLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ExactPathTitle path="/home" title="Home" />
      {children}
    </>
  );
}
