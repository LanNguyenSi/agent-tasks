# UI Audit

This audit reviews the current frontend state at `origin/master` (`dc38db2`) and focuses on structural UX issues that should inform the overhaul.

## Summary

The frontend already has useful primitives, but the app-level screens still behave like first-pass pages built before the design system existed.

The biggest issues are:

- heavy reliance on inline styles
- inconsistent hierarchy between pages
- weak task information density
- dark theme tokens that do not yet support layered layouts
- page-level patterns that are not reusable enough for future growth

## Findings

### 1. The home page undersells the product

Reference: [frontend/src/app/page.tsx](/tmp/agent-tasks-ui-overhaul-docs/frontend/src/app/page.tsx:1)

Issues:

- the product entry is a centered card with minimal narrative
- "Collaborative task platform for humans and agents" is accurate but generic
- the page does not establish why this product is different from issue trackers or kanban apps
- visual identity is basically a gradient heading plus a GitHub button

Impact:

- first impression feels like scaffolding, not a product
- human and agent entry paths are not framed as distinct workflows

### 2. The global visual system is still too thin

Reference: [frontend/src/app/globals.css](/tmp/agent-tasks-ui-overhaul-docs/frontend/src/app/globals.css:1)

Issues:

- only a small token set exists
- no elevation scale beyond `--bg` and `--surface`
- the accent color still leans toward Discord-like blue-purple
- typography uses a default system stack with minimal scale definition

Impact:

- different pages cannot express depth or section priority cleanly
- dialogs, cards, and page panels all compete at the same visual level

### 3. Teams page has serviceable structure, but weak product character

Reference: [frontend/src/app/teams/page.tsx](/tmp/agent-tasks-ui-overhaul-docs/frontend/src/app/teams/page.tsx:1)

What works:

- left rail + content split is the right broad pattern
- projects grid is a reasonable baseline
- modalized project creation is fine

Issues:

- layout reads as "admin panel defaults"
- project cards lack useful summary data and strong visual affordances
- the header is too quiet for the primary navigation surface
- the left rail looks like a temporary list, not a stable navigation model

Impact:

- low scan value
- low sense of place when switching teams/projects

### 4. Dashboard is the right screen, but still the wrong shape

Reference: [frontend/src/app/dashboard/page.tsx](/tmp/agent-tasks-ui-overhaul-docs/frontend/src/app/dashboard/page.tsx:1)

What works:

- persistent filters for done age and done column limits show good operational thinking
- `useDeferredValue` for search is appropriate
- the board already encodes useful workflow states

Issues:

- the kanban frame has weak page scaffolding around it
- status columns are visually similar, so priority of work is under-communicated
- task cards carry too little metadata for an execution surface
- the page is still mostly inline-style driven, which makes hierarchy harder to standardize
- the board counts, filter controls, and creation affordances do not yet form a clear command layer

Impact:

- the most important screen in the product does not feel like the center of operations
- users likely need more clicks than necessary to answer "what needs attention now?"

### 5. Onboarding is usable, but emotionally flat

Reference: [frontend/src/app/onboarding/page.tsx](/tmp/agent-tasks-ui-overhaul-docs/frontend/src/app/onboarding/page.tsx:1)

Issues:

- first-run experience is basically a single card form
- slug mechanics are visible before the product motivation is established
- the page lacks progression cues or "what happens next"

Impact:

- functional, but not confidence-building
- first-run setup feels more technical than collaborative

### 6. Primitives are improving faster than pages

References:

- [frontend/src/components/ui/Button.tsx](/tmp/agent-tasks-ui-overhaul-docs/frontend/src/components/ui/Button.tsx:1)
- [frontend/src/components/ui/Modal.tsx](/tmp/agent-tasks-ui-overhaul-docs/frontend/src/components/ui/Modal.tsx:1)
- [frontend/src/components/ui/Skeleton.tsx](/tmp/agent-tasks-ui-overhaul-docs/frontend/src/components/ui/Skeleton.tsx:1)

What works:

- primitives are becoming more disciplined
- modal accessibility and focus handling are moving in the right direction
- skeleton loading states are already separated into reusable components

Issues:

- app pages still bypass the design system frequently with inline styles
- primitives do not yet enforce a recognizable page language by themselves

Impact:

- implementation quality is ahead of product coherence
- new features risk drifting visually even when they reuse primitives

### 7. The data model is richer than the current UI expresses

Reference: [frontend/src/lib/api.ts](/tmp/agent-tasks-ui-overhaul-docs/frontend/src/lib/api.ts:1)

The UI already has access to richer entities:

- governance mode
- notification webhook state
- task attachments
- artifacts
- comments
- blocked-by / blocks relationships
- claimant metadata

Issue:

- the current screen architecture does not consistently surface this richness

Impact:

- product capability outpaces perceived capability
- users may underestimate what the system can manage

## Design Implications

The overhaul should not start with isolated component cosmetics. It should start with:

1. page shell and layout grammar
2. token/elevation/typography pass
3. dashboard and task surfaces as the product center
4. onboarding and teams as clearer narrative/supporting flows

## Priority Fix Order

1. Strengthen page shell, tokens, and typography
2. Redesign dashboard command layer and task card density
3. Redesign teams/projects scanability
4. Upgrade home/onboarding to reflect the product story
5. Consolidate page implementations onto shared layout primitives
