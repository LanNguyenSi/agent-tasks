# Design Direction: Quiet Precision

Status: approved by owner, 2026-06-11. This document is the single source of truth for the agent-tasks UI overhaul (6 PRs: 1 foundation, 4 surfaces, 1 polish). Implementing agents read this plus the mockups under docs/design/mockups/ before touching any surface.

## Why

The 7-surface UI/UX audit (93 findings) returned one verdict twice over. First, the styling system is inverted, the audit's only CRITICAL finding: design tokens and classes exist in globals.css, but the actual geometry of nearly every screen lives in 736 inline `style={{}}` blocks, even inside the `components/ui/` primitives. The responsive layer fights those inline styles with an `!important` arms race, theming can only reach colors (never spacing or shape), and any redesign becomes a touch-every-file operation. Worst offenders: `components/TaskDetail.tsx` (136 inline blocks), `app/dashboard/page.tsx` (88), `app/settings/page.tsx`. Second, the app looks like a functional wireframe: every element is the same 1px grey-bordered box, status and priority collapse into indistinguishable 7-9px color dots, Unicode glyphs (▲▼ ← ✕) stand in for icons, the type scale tops out at 1.25rem so nothing anchors the eye, pages stack 200-300px of control chrome before content, and the palette is the most default blue possible. Functionally the app is solid (URL-driven filters, focus traps, skeletons); visually it is anonymous, which is exactly the owner's complaint.

Quiet Precision is the chosen direction: Linear-school, layered monochrome dark surfaces (page, panel, card: three elevation steps, no shadows), Inter at a 13px base, exactly one desaturated indigo accent (#5e6ad2), status expressed only as small tinted dot+label chips, priority only as micro uppercase text, JetBrains Mono for machine references (branches, PR numbers, scopes, code), tight 4/6/8px radii, an 8px rhythm, and keyboard-first affordances with visible key chips. It was chosen because it matches the product's technical agent-coordination identity, it earns distinctiveness through precision rather than decoration (so it ages well and stays cheap to maintain), and it maps cleanly onto the existing token architecture: fixing the CRITICAL inversion (geometry into CSS classes) and applying the new look are the same motion, which is why the foundation PR must land first.

## Design tokens v2

Token names keep the existing `--bg`/`--surface`/`--text` naming style from globals.css so the migration is a value swap plus a handful of additions, not a rename of every call site. Values come from the approved mockups (the `:root` block in the mockup HTML is the canonical reference until globals.css lands).

### Surfaces (3 elevation steps + page)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#08090c` | Page background |
| `--surface` | `#0e1014` | Panels: board columns, toolbars, inputs, sidebars |
| `--surface-raised` | `#14171c` | Cards, modals, popovers |
| `--surface-hover` | `#191d24` | Hover state of raised surfaces |

`--surface-secondary` is retired (it was darker than `--surface`, the inverse of an elevation ladder); call sites move to `--surface` or `--bg` during de-inlining.

### Hairlines

| Token | Value | Use |
|---|---|---|
| `--border` | `#ffffff0f` | Default hairline between/around surfaces |
| `--border-strong` | `#ffffff1a` | Controls: inputs, buttons, chips |
| `--border-hover` | `#ffffff26` | Hovered controls |

### Text

| Token | Value | Use |
|---|---|---|
| `--text` | `#e8eaee` | Primary text |
| `--text-secondary` | `#a6acb8` | Secondary text, card meta |
| `--muted` | `#6d7480` | Muted: hints, kickers, placeholders, icons at rest |

### Accent (one)

| Token | Value | Use |
|---|---|---|
| `--primary` | `#5e6ad2` | Primary buttons, active indicators, focus rings |
| `--primary-hover` | `#6974dc` | Primary button hover |
| `--primary-text` | `#9aa3ec` | Accent-colored text on dark surfaces |
| `--primary-muted` | `rgba(94, 106, 210, 0.14)` | Soft accent fill (selected rows, in-progress chip fill) |
| `--primary-border` | `rgba(94, 106, 210, 0.38)` | Accent-tinted borders |
| `--link` | `var(--primary-text)` | Links, derived |

### Status (chips: 8px dot + 12-14% tinted fill, see StatusChip)

| Token | Value | Paired text token | Value |
|---|---|---|---|
| `--status-open` | `#8a8f98` | `--status-open-text` | `#a8aeb8` |
| `--status-in-progress` | `#5e6ad2` | `--status-in-progress-text` | `#99a2ee` |
| `--status-review` | `#c08b3a` | `--status-review-text` | `#d9aa5e` |
| `--status-done` | `#4c9a68` | `--status-done-text` | `#74bd8f` |

Chip recipe: fill `color-mix(in srgb, var(--status-X) 13%, transparent)`, dot in `--status-X`, label in `--status-X-text`. Custom workflow states fall back to the open (grey) treatment.

### Priority (10px/600 uppercase text, never a chip)

| Token | Value |
|---|---|
| `--priority-critical` | `#e07a76` |
| `--priority-high` | `#d99657` |
| `--priority-medium` | `#c2ab60` |
| `--priority-low` | `#8a8f98` |

### Semantic (re-derived from the status/priority hues so the app keeps one palette)

| Token | Value | Note |
|---|---|---|
| `--success` | `#4c9a68` | Same hue as done |
| `--warning` | `#c08b3a` | Same hue as review |
| `--danger` | `#e07a76` | Same hue as critical |
| `--danger-strong` | `#c4524d` | Destructive button fill |

### Type

| Token | Value | Use |
|---|---|---|
| `--font` | Inter (via next/font) + system fallbacks | All UI text |
| `--font-mono` | JetBrains Mono (via next/font), ui-monospace fallback | Branches, PR refs, scopes, code, token values |
| `--text-2xs` | 10px (0.625rem) | Priority text, keyboard-hint chips, uppercase micro labels (tracking 0.06em) |
| `--text-xs` | 11px (0.6875rem) | Micro: label pills, counts in chips |
| `--text-sm` | 12px (0.75rem) | Meta: timestamps, prop labels, breadcrumbs |
| `--text-base` | 13px (0.8125rem) | Body, card titles, nav |
| `--text-md` | 14px (0.875rem) | Section headings, weight 600 |
| `--text-lg` | 16px (1rem) | Modal titles, stat-strip numbers |
| `--text-xl` | 20px (1.25rem) | Page H1, weight 600, letter-spacing -0.012em |
| `--text-2xl` | 24px (1.5rem) | Auth/landing hero headings only |

All counts and numerals in lists render with `font-variant-numeric: tabular-nums` (utility class `.num`).

### Spacing (8px rhythm on a 4px base)

| Token | Value |
|---|---|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 24px |
| `--space-6` | 32px |
| `--space-8` | 48px (rare, page-level gaps) |

Note: `--space-5`/`--space-6`/`--space-8` change value (20/24/32px to 24/32/48px). Every surface PR re-snaps the spacing of the files it touches, so the shift lands surface by surface, never as a silent global jump.

### Radii

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 4px | Key chips, small icon buttons, mono ref chips |
| `--radius-base` | 6px | Buttons, inputs, selects, nav links, chips |
| `--radius-lg` | 8px | Cards, modals, panels, board columns |
| `--radius-full` | 999px | Pills: label badges, count badges, avatars |

`--radius-xl` (12px) and the old 10px `--radius-lg` are retired.

### Motion and elevation

| Token | Value | Use |
|---|---|---|
| `--transition-fast` | 120ms ease | background-color, border-color, color on hover/active |
| `--shadow-overlay` | `0 8px 24px rgba(0, 0, 0, 0.45)` | Overlays ONLY: modals, dropdowns, toasts |

No shadows on cards or panels: elevation is expressed by the surface ladder. `prefers-reduced-motion` disables non-essential transitions.

### Light-theme derivation

Light theme is a token re-declaration under `html[data-theme="light"]`, nothing else: the surface ladder flips to descending-lightness greys (page approx `#f7f8fa`, panel `#ffffff`, card `#ffffff`, hover `#f1f3f6`, tuned in the foundation PR), hairlines become black alphas (`#0000000f` / `#0000001a` / `#00000026`), the three text greys invert, and accent/status/priority hues stay identical while their `-text` variants darken roughly 25% to hold AA contrast on light fills. Components must consume role tokens only (color-mix recipes mix against tokens, never raw hexes), which collapses the current 180-line per-selector light override block (globals.css:1517-1696) into one token block.

## The five principles

1. Personality through precision: hierarchy comes from size, weight, and hairlines, never from decoration, so when an element needs emphasis you change its type weight or its surface step, not its color count.
2. One accent: `#5e6ad2` is the only promotional color in the app; status lives exclusively in small dot+label chips and priority exclusively in micro uppercase text, so the two encodings can never be confused because they differ in shape, not just hue.
3. One compact sticky control band per screen: each surface gets exactly one 52px toolbar carrying the title, search, filters, and the primary action, and real content starts within roughly 100px of the viewport top.
4. Keyboard-first affordances: every primary action advertises its shortcut with a visible key chip (`/` for search, `C` for create, `⌘↵` to submit), and `:focus-visible` rings are present everywhere and never suppressed.
5. Three elevation steps, 8px rhythm, aligned baselines: page, panel, and card are the only surfaces, spacing sits on the 4/8/12/16/24/32 scale, columns share baselines, and every count renders tabular.

## Component inventory

New primitives in `frontend/src/components/ui/`:

- StatusChip: dot + label pill with 13% tinted fill, driven by `lib/status.ts`; states: open, in_progress, review, done, custom-state fallback (grey); static and interactive (button) variants; replaces every bare status dot and grey status chip.
- PriorityLabel: 10px/600 uppercase text in the priority color, never a chip; states: critical, high, medium, low; carries `aria-label="Priority: X"` so the encoding is not color-only.
- Badge: neutral pill for labels, `+N` overflow, and counts; tones: neutral, accent, status-tinted; tabular numerals.
- Table: semantic table primitive (real roles, sortable column headers with `aria-sort`, row-as-link support, configurable columns via `data-col`, two-line stacked row mode under 900px); replaces both hand-rolled list-table copies.
- Tabs: one segmented-control pattern (roving tabindex, `aria-controls`, panels associated) replacing `.auth-tab`, `.view-toggle`, and the ConnectAgentModal underline tabs.
- Toast: `role="status"` portal for transient confirmations and non-fatal action errors; auto-dismiss, stacking; replaces persistent AlertBanners for ephemeral feedback.
- Tooltip: hover AND focus triggered, Escape dismisses, touch long-press; replaces native `title=` affordances (50 sites, migrated progressively).
- Icon: inline-SVG icon set on a 16px grid, stroke 1.5, `currentColor` (search, filter, board, list, plus, calendar, branch, pr, chevron, dots, check, edit, clip, box, x, arrow-right); replaces ▲▼ ← ✕ text glyphs; states: none, it inherits color.
- PageHeader (Toolbar): the one 52px sticky control band, slots for breadcrumb, H1/picker, count summary, search, filters, view toggle, primary action; sticky under the 48px nav with backdrop blur.
- KeyHint: the small bordered key chip (`/`, `C`, `⌘`, `↵`) used inside search fields, buttons, and composer hints.

Upgraded primitives:

- EmptyState: icon + title + description + action slot in a centered stack; every empty state must offer the next action, no dead ends.
- Card: surface-step prop (panel vs raised), all geometry in `.card` classes; kills the `!important` patches.
- Button: variants primary/secondary/ghost/danger/link, sizes sm/md, visible loading spinner (currentColor, label kept), optional KeyHint slot, `href` support so links stop hand-rolling button geometry.
- Select: token-aligned trigger (28px control height, `--radius-base`), portal + flip positioning shared with DropdownMenu so it survives scrollable modal bodies.
- Modal: token radius/spacing, header/body/footer slots with a pinned footer for long forms, existing focus trap kept.

Shared non-primitive extractions consumed across the surface PRs: `lib/status.ts` (STATUS_LABELS/STATUS_COLORS, mirrors `lib/priorityColors.ts`), `components/Markdown.tsx` (ReactMarkdown + remark-gfm + sanitize), `InlineConfirmDelete` (arm-then-confirm destructive control), `CopyableCode` (code block + copy button, optional masking), `AuthShell` (centered auth frame), `ProjectSubnav` (project hub tabs).

## CSS conventions

- Geometry (layout, spacing, sizing, borders, radius, typography) lives in CSS classes, never in `style={{}}`.
- Inline styles are allowed ONLY for truly dynamic runtime values (progress-bar width, confidence percentage, computed popover position); each exception carries a `/* dynamic: <reason> */` comment on the line.
- No new `!important`. The foundation PR removes the existing responsive `!important` patches by moving base styles out of inline and into classes.
- Component-scoped class prefixes, block-element style: `.task-card`, `.task-card-title`, `.tb-` (toolbar), `.props-` (detail sidebar), `.chip-`, `.btn-`. New classes group under a section comment in globals.css.
- Tokens only: no raw hex or rgba literals in components; `color-mix()` against tokens is the approved way to derive tints in CSS; no `var()` fallback values (tokens are defined on `:root`, fallbacks encode drift).
- Spacing values must be `--space-*` tokens; no off-scale literals (0.45rem, 0.72rem, etc.).
- An ESLint guard (warn on `style` props) prevents regression; documented dynamic exceptions are suppressed per line.

## Per-surface implementation notes

### Dashboard + home (PR 2/6)

- One 52px PageHeader replaces the three stacked control bands (audit: no page heading, ~300px of chrome before tasks): project picker rendered as the H1 with a chevron, task-count summary, search with `/` KeyHint, filter button, board/list view toggle, New task primary button with `C` KeyHint. The status-summary chip band is deleted in board view.
- Split error states (audit HIGH: any transient action failure unmounts the entire loaded board, no Retry): bootError gets a full-surface banner + Retry, actionError goes to a Toast or inline banner while the board stays mounted.
- Board cards decluttered (audit HIGH: up to 12 data points per 220px card, priority encoded three times): priority micro-label + mono PR/branch chip on top, title, footer with first label + `+N` Badge, due date, assignee avatar; description clamp, second dot, and per-card ConfidenceBadge are dropped.
- Column identity (audit HIGH wireframe look): status dot + column title + tinted count Badge, columns sit on `--surface` panels.
- Empty states with real actions (audit HIGH dead ends): no-team offers team selection, zero-project team offers Create project.
- Extraction before restyling (audit HIGH: 1360-line monolith, 88 inline blocks): NewTaskModal, ProjectPicker, BoardView, TaskListView, FilterToolbar become components.
- `lib/status.ts` + StatusChip consumed by home widgets too (audit MEDIUM: STATUS_COLORS duplicated verbatim, already drifting).
- Home leads with a stat strip built from the already-fetched counts (audit MEDIUM: counts hidden in xs link labels); My Tasks becomes the first widget; widget empty states get a one-line CTA.

### Tasks list (PR 3/6)

- The three overlapping chip mechanisms collapse into the FilterToolbar pattern (audit HIGH: scope presets, status/priority toggles, and Mine all share `.filter-chip`, up to four highlighted chips express one filter): scopes become a segmented control, chips remain only for true multi-toggles, Mine moves next to search.
- Real error and in-flight states (audit HIGH: a failed API call renders as a convincing "No tasks found"; an uncaught bootstrap error spins forever): error banner + Retry, `isFetching` dims the list with `aria-busy`, EmptyState only when the result is genuinely empty.
- Status color encoding fixed (audit HIGH: open is muted grey while done glows green, the inverse of a work queue): StatusChip makes open/in-progress prominent and done muted; priority becomes PriorityLabel, not a second identical chip.
- The table comes from the new Table primitive, shared with the dashboard list view (audit HIGH: copy-pasted JSX with confirmed drift in aria-labels, date formatting, columns).
- A New task primary action lands in the toolbar (audit MEDIUM: no primary action on the whole page); empty states offer Clear filters / Create your first task.
- Row click opens /tasks/[id] preserving the query string (audit MEDIUM: rows currently teleport to the board surface).

### Task detail (PR 3/6)

- The task title is the H1 (20px) under a Team / Project breadcrumb; the generic "Task Details" heading dies (audit HIGH: richest screen, flattest hierarchy, title at body size).
- Header row: StatusChip + the single gated transition button with an "only allowed transition" hint + Edit + overflow menu; the edit-mode status Select must route through the same gated transition logic as the buttons (audit HIGH: edit mode bypasses workflow gates via raw PATCH).
- Two-column layout per the mockup: main column (Description, Attachments, Artifacts, Agent Output, Comments) and a Properties sidebar (status, priority, assignee, labels, branch as mono chip, due, created, confidence bar), resurrecting the dead `.task-detail-grid`.
- GFM via the shared Markdown wrapper (audit HIGH: `- [ ]` checklists render as literal text): acceptance checklists render as real checkboxes with an N-of-M progress readout; tables, strikethrough, autolinks work; comments render markdown too (audit MEDIUM: comments are the only plain-text long-form field).
- InlineConfirmDelete guards artifact deletion (audit HIGH: one-click permanent delete) and unifies the three hand-rolled confirm idioms.
- TEMPLATE_FIELD_DEFS config drives the 18 copy-pasted template blocks; TaskHeader, TaskMetaSidebar, ReviewPanel, CommentList are extracted (audit HIGH: 1167-line monolith, 136 inline styles).
- Designed empty states for Attachments (dropzone + Attach action) and Artifacts (names the real `task_artifact_create` path); TaskDetailSkeleton replaces the bare "Loading…".

### Projects (PR 4/6)

- A project hub with ProjectSubnav tabs (Overview, Settings, Members, Workflow) under the app nav on every project page, via a shared `projects/[id]/layout.tsx` that fetches the project once (audit HIGH: three disconnected islands, no lateral navigation).
- The workflow editor moves to `/projects/[id]/workflow` with a redirect from the old query-param URL (audit MEDIUM: two routing conventions on one surface).
- The members page lists actual members (avatar, login, role, joined) above invites (audit HIGH: a /members route that never shows members).
- Project settings is renamed and split into sectioned cards: Governance as selectable option cards, Notifications, Task template (audit HIGH: misleading title, three unrelated concerns in one undifferentiated card).
- The workflow editor gets a read-only state-diagram strip (state chips connected by arrows carrying gate-count badges) above restyled tables; gates render as toggle chips with the rule id in a Tooltip (audit HIGH: a workflow editor with zero workflow visualization).
- Tokens replace the parallel hardcoded palette (#dc2626, #3b82f6, undefined --input-bg); ConfirmDialog replaces `window.confirm` and lists the actual validation warnings (audit MEDIUM consistency).

### Settings + teams (PR 5/6)

- A real page title and grouped sections (Account & Appearance, Integrations, API Tokens) with a sticky section nav (audit HIGH: no h1, six identical flat cards, body-sized headings).
- The token list moves above the fold: the two permanent documentation banners collapse into CollapsibleSection, AlertBanner is reserved for transient feedback (audit MEDIUM).
- The agent-connect modal stops minting a 90-day token as a side effect of opening: scope/TTL summary first, explicit Generate token button performs the POST (audit HIGH: orphan tokens accumulate per open).
- The create-token modal renders the human-readable scope labels it already fetches, with sensitive scopes tinted (audit HIGH: bare `sso:admin` IDs, the sensitivity warning invisible exactly where it is granted).
- CopyableCode replaces the six drifting hand-rolled code+copy blocks (audit MEDIUM).
- /settings/sso gets the app chrome back (AppHeader + page shell) (audit MEDIUM: bare page, lone back arrow).

### Auth + onboarding (PR 5/6)

- One AuthShell replaces four hand-rolled centered shells at four different widths (audit HIGH: 400/460/480/520px drift); auth/error gets the same card treatment (audit HIGH: looks like an unstyled 404).
- Field rhythm: forms get a real grid gap (audit HIGH: literally 0px between login fields, negative-margin hacks).
- Auth methods ranked in one card: Continue with GitHub primary on top, a hairline "or continue with email" divider, the email form below; an SSO match demotes the password submit so only one primary CTA shows (audit HIGH: competing CTAs, OAuth exiled to an apologetic second card).
- Branded first impression consistent with the landing card: brand mark, `--text-2xl` heading, gradient-washed frame (audit HIGH: most generic screens at the moment of first impression).
- autocomplete attributes and a visible password-length hint (audit MEDIUM a11y); the GitHub redirect state revives on back-navigation via `pageshow` (audit MEDIUM: permanently bricked link).
- Invite accept keeps the preview mounted with a loading Button; dead-invite errors route to /home with an actionable line (audit MEDIUM flow).

## Mockup-to-token mapping

The mockup `:root` blocks use shorthand names; the doc names above are canonical. Mapping:

| Mockup | Canonical |
|---|---|
| `--bg-0` / `--bg-1` / `--bg-2` / `--bg-3` | `--bg` / `--surface` / `--surface-raised` / `--surface-hover` |
| `--accent`, `--accent-soft`, `--accent-text` | `--primary`, `--primary-muted`, `--primary-text` |
| `--st-open`, `--st-progress`, `--st-review`, `--st-done` | `--status-open`, `--status-in-progress`, `--status-review`, `--status-done` |
| `--pri-*` | `--priority-*` |
| `--r-1` / `--r-2` / `--r-3` | `--radius-sm` / `--radius-base` / `--radius-lg` |
| `--s-1` .. `--s-6` | `--space-1` .. `--space-8` (mockup scale is positional) |
| `--fs-*` | `--text-*` (10px sizes map to `--text-2xs`, off-scale 12.5/11.5/10.5px snap to the canonical scale) |

Raw hex values in the mockups that have no token (white-alpha overlays like `#ffffff12`, avatar tints, view-toggle active fill, prose code text) are NOT canon: the foundation PR replaces them with tokens or `color-mix()` recipes derived from the tokens above. Where mockup pixels and this document disagree, this document wins (the known cases: board column radius 10px snaps to `--radius-lg` 8px, off-scale font sizes snap to the type scale).

## Mockup references

- docs/design/mockups/quiet-precision-dashboard.html (app shell, toolbar, board, cards, chips, icons)
- docs/design/mockups/quiet-precision-task-detail.html (breadcrumb + H1 header, two-column layout, properties sidebar, checklist rendering, comments, composer)

Open them directly in a browser. Their `:root` blocks are the canonical token values; where a mockup pixel value and this document disagree, this document wins (e.g. board columns snap to `--radius-lg` 8px).

## Deferred ideas (explicitly out of scope for all six PRs)

- Visible short task IDs (AT-152 style) on cards and chips: requires a backend numbering feature; the mono PR-number chip stands in for a machine ref until then.
- Light-theme full redesign QA: the token derivation lands in the foundation PR, but the across-all-surfaces light QA pass belongs to the polish PR (6/6), not to each surface PR.
- Mobile-first navigation rework (bottom nav or hamburger): deferred; this overhaul is desktop-first with a 390px correctness pass in the polish PR.
- Email-based password reset flow: a real backend feature; the auth PR only makes the current recovery hint actionable.
- Command palette (Cmd+K): a natural follow-up to the keyboard-first language, not part of these six PRs.
