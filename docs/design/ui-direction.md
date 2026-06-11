# UI Overhaul 0/6: Design Direction

## Problem

The current frontend is functional but visually provisional. The app reads like an internal scaffold:

- pages are built mostly with inline styles
- hierarchy is weak, especially on dashboard and teams
- the product has no strong visual identity beyond a single accent color
- dense operational work is presented with consumer-app spacing and weak grouping
- the critical object in the product, the task, does not yet feel central enough

That mismatch matters because `agent-tasks` is not a generic CRUD app. It is an operations surface for mixed human/agent execution. The UI should communicate control, auditability, and flow.

## Product Positioning

The interface should feel like a lightweight mission control system:

- not enterprise-grey bureaucracy
- not playful consumer SaaS
- not Discord clone styling

The right tone is:

- operational
- high-signal
- calm under load
- compact, but not cramped

## Core Principles

### 1. Tasks are the hero object

Projects, teams, and settings exist to support task execution. On task-heavy screens:

- task status must be visible faster than metadata
- claim state, confidence, review state, and blockage must read at a glance
- done work should recede without disappearing

### 2. Dense information needs strong grouping

The product will continue to grow in operational complexity. That means the layout must do more work:

- use explicit panels/cards for meaning, not decoration
- reserve whitespace for section boundaries, not for empty breathing room everywhere
- prefer clear grid structure over stacked one-column forms when context allows

### 3. One visual system, fewer one-off styles

The app needs a real set of reusable primitives:

- page shell
- section header
- metric strip
- task card
- side panel
- inline form row
- status chip
- metadata rail

Inline per-page styling should shrink over time.

### 4. Dark mode should feel intentional

The current palette is "default dark". The overhaul should keep dark mode as the baseline, but make it more legible and product-specific:

- warmer neutrals instead of pure black slabs
- one strong accent family
- clearer elevation steps
- higher contrast for small metadata

### 5. Flow before polish

This overhaul should improve:

- wayfinding
- scanning
- editing flow
- claim/review/finish flow

Animations, illustrations, and extra flair come after the structure is right.

## Visual Direction

## Palette

Use a restrained operator palette:

- background: graphite / deep slate, not pure black
- surface: two elevation steps so panels are readable
- accent: electric blue with teal support, not Discord-purple
- status colors: keep semantic red/amber/green, but slightly muted

Suggested token direction:

- `--bg`: deep graphite
- `--surface-1`: main canvas panels
- `--surface-2`: raised cards / dialogs
- `--surface-3`: active states / selected rails
- `--text`: cool off-white
- `--muted`: medium-contrast grey that still passes on dark
- `--accent`: blue
- `--accent-2`: teal

## Typography

Avoid generic system-feel headers. The UI needs a clearer display/body split:

- display/headings: a sharper grotesk or semi-condensed UI face
- body/UI text: pragmatic sans for long operational reading

If introducing new fonts is too expensive in the short term, the interim step is:

- stronger scale
- tighter heading tracking
- clearer size steps

## Shapes and surfaces

- medium radius by default
- cleaner edge language on panels
- borders stay visible, but softer
- use subtle panel tint shifts instead of heavy drop shadows

## Information Architecture Direction

### Home / entry

Current home is a thin login card. It should become a proper product entry page:

- short value proposition
- clear split: humans sign in, agents use tokens
- concise product proof points
- immediate route into the primary workflow

### Onboarding

Onboarding should feel like a guided first-run, not a raw form:

- progress framing
- why the team exists before asking for slug details
- stronger empty-state context

### Teams

Teams should become the control hub for projects:

- left rail for team switching
- main area for projects
- project cards with clearer state and next actions
- settings/access actions discoverable without clutter

### Dashboard

Dashboard should evolve from plain kanban into an execution board:

- top summary strip
- sticky project context
- stronger filter bar
- clearer distinction between open/in-progress/review/done
- task cards that carry enough metadata to reduce click churn

### Task detail

Task detail should become the highest-fidelity operational screen:

- title and status rail at top
- primary action cluster near the object
- collapsible secondary sections
- artifacts, attachments, and comments grouped by workflow meaning

## Layout Direction

Adopt a consistent page shell:

- top app bar
- optional left rail
- centered content container with explicit max widths
- reusable section spacing tokens

Recommended defaults:

- app shell max width for primary pages: wide desktop container
- dashboard: full-width within shell, with horizontal overflow only where necessary
- forms: two-column where fields are paired, single-column where prose matters

## Rollout Plan

### Slice 0/6

- direction doc
- audit
- mockups

### Slice 1/6

- token pass in `globals.css`
- shell/page scaffolding
- typography and spacing normalization

### Slice 2/6

- home + onboarding redesign

### Slice 3/6

- teams/projects redesign

### Slice 4/6

- dashboard redesign

### Slice 5/6

- task detail + modal/detail surface redesign

### Slice 6/6

- polish, consistency sweep, responsive cleanup, empty/loading/error states

## Success Criteria

The overhaul is successful if:

- the product feels intentional within 5 seconds of landing
- dashboard scanning improves without sacrificing density
- task state and responsibility are easier to read than today
- teams/projects/task-detail share one coherent visual system
- new features can plug into established page and component patterns
