# Vendored fonts

Self-hosted font files for `frontend/src/app/layout.tsx`, loaded with
`next/font/local`. The app never fetches fonts from the Google Fonts CDN: a
Google outage must not be able to fail a build or a deploy, and the CI guard
step in `.github/workflows/ci.yml` (Frontend job, "Vendored fonts only" step)
fails any change that imports the Google fonts loader again.

## Files

Variable-weight (wght axis), normal-style subsets only -- the app declares
`style: "normal"` and a weight range per family, exactly as the previous
Google Fonts setup did.

| File | npm package | Version | Subset |
| --- | --- | --- | --- |
| `inter-latin-wght-normal.woff2` | `@fontsource-variable/inter` | 5.3.0 | latin |
| `inter-latin-ext-wght-normal.woff2` | `@fontsource-variable/inter` | 5.3.0 | latin-ext |
| `inter-cyrillic-wght-normal.woff2` | `@fontsource-variable/inter` | 5.3.0 | cyrillic |
| `inter-cyrillic-ext-wght-normal.woff2` | `@fontsource-variable/inter` | 5.3.0 | cyrillic-ext |
| `inter-greek-wght-normal.woff2` | `@fontsource-variable/inter` | 5.3.0 | greek |
| `inter-greek-ext-wght-normal.woff2` | `@fontsource-variable/inter` | 5.3.0 | greek-ext |
| `inter-vietnamese-wght-normal.woff2` | `@fontsource-variable/inter` | 5.3.0 | vietnamese |
| `jetbrains-mono-latin-wght-normal.woff2` | `@fontsource-variable/jetbrains-mono` | 5.3.0 | latin |
| `jetbrains-mono-latin-ext-wght-normal.woff2` | `@fontsource-variable/jetbrains-mono` | 5.3.0 | latin-ext |
| `jetbrains-mono-cyrillic-wght-normal.woff2` | `@fontsource-variable/jetbrains-mono` | 5.3.0 | cyrillic |
| `jetbrains-mono-cyrillic-ext-wght-normal.woff2` | `@fontsource-variable/jetbrains-mono` | 5.3.0 | cyrillic-ext |
| `jetbrains-mono-greek-wght-normal.woff2` | `@fontsource-variable/jetbrains-mono` | 5.3.0 | greek |
| `jetbrains-mono-vietnamese-wght-normal.woff2` | `@fontsource-variable/jetbrains-mono` | 5.3.0 | vietnamese |
| `OFL-Inter.txt` | license of `@fontsource-variable/inter` (the font's OFL text) | 5.3.0 | -- |
| `OFL-JetBrains-Mono.txt` | license of `@fontsource-variable/jetbrains-mono` (the font's OFL text) | 5.3.0 | -- |

Both fonts are licensed under the SIL Open Font License 1.1; the license files
are the `LICENSE` files of the packages above and must be kept next to the
fonts they cover.

## Why every subset

Every subset the fontsource packages ship is vendored (Inter: latin,
latin-ext, cyrillic, cyrillic-ext, greek, greek-ext, vietnamese; JetBrains
Mono: latin, latin-ext, cyrillic, cyrillic-ext, greek, vietnamese), because
the Google fonts loader served the full per-subset `@font-face` set and the
rendered result must stay the same: the app shows task titles, descriptions
and comments written by users and agents, which are not limited to latin
characters, and each subset face only loads (by its `unicode-range`) when a
page actually needs it. Only the latin face is preloaded; the other subsets
are declared with `preload: false` in `layout.tsx`.

## How to update

1. From the repository root, fetch a package version without adding a
   dependency:
   `npm pack @fontsource-variable/inter --pack-destination .scratch`
   (same for `@fontsource-variable/jetbrains-mono`), then
   `tar -xzf .scratch/fontsource-variable-<name>-<version>.tgz -C .scratch/pkg`.
2. Copy `pkg/files/<family>-<subset>-wght-normal.woff2` for every subset in
   the table above over the files here, and `pkg/LICENSE` over the matching
   `OFL-*.txt`. Check each file with `file` (must report Web Open Font
   Format (Version 2)).
3. If the release adds or drops a subset, mirror that in `layout.tsx` (one
   `localFont` call per subset, latin preloaded) and take the subset
   `unicode-range` values from the package's `unicode.json`, and update the
   table above.
4. Delete `.scratch` afterwards.
