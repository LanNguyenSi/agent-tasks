import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "../lib/theme";
import { ToastProvider } from "../components/ui/Toast";
import AppChrome from "../components/AppChrome";

// Vendored fonts (frontend/src/fonts, see its README): the fonts are served
// from the repo instead of the Google Fonts CDN, so no build or deploy ever
// depends on Google being reachable. next/font/local cannot attach a
// unicode-range to a src entry, so each family is declared with one call per
// subset: the latin face is preloaded and the other subsets share its
// font-family through `declarations` (with `declarations` font-family set,
// next/font keeps that exact family name), so every face of a family lives
// under one name and the browser still selects the face by unicode-range,
// exactly like the Google Fonts CSS did. The unicode-range values below are
// the ones the fontsource packages publish for each subset.

const inter = localFont({
  src: [{ path: "../fonts/inter-latin-wght-normal.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-inter",
  display: "swap",
  declarations: [
    { prop: "font-family", value: "Inter" },
    { prop: "unicode-range", value: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" },
  ],
});

const interLatinExt = localFont({
  src: [{ path: "../fonts/inter-latin-ext-wght-normal.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-inter-latin-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    { prop: "unicode-range", value: "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF" },
  ],
});

const interCyrillic = localFont({
  src: [{ path: "../fonts/inter-cyrillic-wght-normal.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-inter-cyrillic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    { prop: "unicode-range", value: "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116" },
  ],
});

const interCyrillicExt = localFont({
  src: [{ path: "../fonts/inter-cyrillic-ext-wght-normal.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-inter-cyrillic-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    { prop: "unicode-range", value: "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F" },
  ],
});

const interGreek = localFont({
  src: [{ path: "../fonts/inter-greek-wght-normal.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-inter-greek",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    { prop: "unicode-range", value: "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF" },
  ],
});

const interGreekExt = localFont({
  src: [{ path: "../fonts/inter-greek-ext-wght-normal.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-inter-greek-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    { prop: "unicode-range", value: "U+1F00-1FFF" },
  ],
});

const interVietnamese = localFont({
  src: [{ path: "../fonts/inter-vietnamese-wght-normal.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-inter-vietnamese",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "Inter" },
    { prop: "unicode-range", value: "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB" },
  ],
});

const jetbrainsMono = localFont({
  src: [{ path: "../fonts/jetbrains-mono-latin-wght-normal.woff2", weight: "100 800", style: "normal" }],
  variable: "--font-jetbrains-mono",
  display: "swap",
  declarations: [
    { prop: "font-family", value: "JetBrains Mono" },
    { prop: "unicode-range", value: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" },
  ],
});

const jetbrainsMonoLatinExt = localFont({
  src: [{ path: "../fonts/jetbrains-mono-latin-ext-wght-normal.woff2", weight: "100 800", style: "normal" }],
  variable: "--font-jetbrains-mono-latin-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "JetBrains Mono" },
    { prop: "unicode-range", value: "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF" },
  ],
});

const jetbrainsMonoCyrillic = localFont({
  src: [{ path: "../fonts/jetbrains-mono-cyrillic-wght-normal.woff2", weight: "100 800", style: "normal" }],
  variable: "--font-jetbrains-mono-cyrillic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "JetBrains Mono" },
    { prop: "unicode-range", value: "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116" },
  ],
});

const jetbrainsMonoCyrillicExt = localFont({
  src: [{ path: "../fonts/jetbrains-mono-cyrillic-ext-wght-normal.woff2", weight: "100 800", style: "normal" }],
  variable: "--font-jetbrains-mono-cyrillic-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "JetBrains Mono" },
    { prop: "unicode-range", value: "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F" },
  ],
});

const jetbrainsMonoGreek = localFont({
  src: [{ path: "../fonts/jetbrains-mono-greek-wght-normal.woff2", weight: "100 800", style: "normal" }],
  variable: "--font-jetbrains-mono-greek",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "JetBrains Mono" },
    { prop: "unicode-range", value: "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF" },
  ],
});

const jetbrainsMonoVietnamese = localFont({
  src: [{ path: "../fonts/jetbrains-mono-vietnamese-wght-normal.woff2", weight: "100 800", style: "normal" }],
  variable: "--font-jetbrains-mono-vietnamese",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "font-family", value: "JetBrains Mono" },
    { prop: "unicode-range", value: "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB" },
  ],
});

// The non-latin subset calls above only contribute their @font-face rules to
// the generated CSS: their variables are deliberately not applied anywhere
// (the latin face's --font-inter / --font-jetbrains-mono carry the shared
// family name, which is what makes the unicode-range selection work), and
// their classNames are not used either. This keeps the calls -- and their CSS
// -- referenced so the font loader emits every subset face.
void [
  interLatinExt,
  interCyrillic,
  interCyrillicExt,
  interGreek,
  interGreekExt,
  interVietnamese,
  jetbrainsMonoLatinExt,
  jetbrainsMonoCyrillic,
  jetbrainsMonoCyrillicExt,
  jetbrainsMonoGreek,
  jetbrainsMonoVietnamese,
];

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
