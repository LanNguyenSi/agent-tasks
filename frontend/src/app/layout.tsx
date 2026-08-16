import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "../lib/theme";
import { ToastProvider } from "../components/ui/Toast";
import AppChrome from "../components/AppChrome";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "agent-tasks",
  description: "Collaborative task platform for humans and agents",
  icons: {
    icon: "/icon.svg",
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // DO NOT DELETE this line without reading scripts/assert-dynamic-rendering.mjs first.
  //
  // Reading headers() here is required, not just informational: it's what makes
  // Next's App Router apply the per-request CSP nonce (middleware.ts) to the
  // RSC-streaming inline scripts it injects for hydration. Without a headers()
  // read somewhere in the render tree, Next renders those scripts unnonced and
  // they fail the CSP (verified live). This also opts the whole app out of
  // static prerendering into per-request dynamic rendering -- an accepted
  // trade-off of a nonce-based CSP, documented in docs/development.md.
  //
  // Removing this line is silent everywhere except the CSP itself: tsc, the
  // frontend build, and every existing test stay green while routes revert to
  // static and start serving unnonced inline scripts (verified live). The
  // `postbuild` script (scripts/assert-dynamic-rendering.mjs) is the guard
  // that catches this: it fails the build if any app route beyond /icon.svg
  // shows up in .next/prerender-manifest.json, i.e. if it got prerendered
  // statically instead of rendered dynamically.
  await headers();
  return (
    <html
      lang="en"
      data-theme="dark"
      // eslint-disable-next-line no-restricted-syntax
      style={{ colorScheme: "dark" /* dynamic: SSR initial; theme.ts updates at runtime */ }}
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ToastProvider>
          <AppChrome>{children}</AppChrome>
        </ToastProvider>
      </body>
    </html>
  );
}
