import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "agent-tasks",
  description: "Collaborative task platform for humans and agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
