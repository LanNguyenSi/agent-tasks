# Task 009: Implement Konfigurierbare Workflow-Regeln (Statusübergänge, Review-Pflicht, Deployment-Verantwortung)

## Category

feature

## Priority

P1

## Wave

wave-3

## Delivery Phase

implementation

## Depends On

- 001
- 002

## Blocks

- 015

## Summary

Design and implement the capability for: Konfigurierbare Workflow-Regeln (Statusübergänge, Review-Pflicht, Deployment-Verantwortung).

## Problem

The product cannot satisfy its initial scope until Konfigurierbare Workflow-Regeln (Statusübergänge, Review-Pflicht, Deployment-Verantwortung) exists as a reviewable, testable capability.

## Solution

Add a focused module for Konfigurierbare Workflow-Regeln (Statusübergänge, Review-Pflicht, Deployment-Verantwortung) that matches the recommended modular monolith and keeps integration boundaries explicit.

## Files To Create Or Modify

- lib/github/client.ts — GitHub API client with octokit
- lib/github/types.ts — GitHub API types (Repository, PR, Check, Workflow)
- lib/github/repos.ts — Repository health functions (CI status, open PRs)
- lib/github/checks.ts — Check runs and check suites
- lib/github/prs.ts — Pull request operations
- lib/github/workflows.ts — GitHub Actions workflow runs
- app/api/github/repos/route.ts — GET repositories with health status
- app/api/github/repos/[owner]/[repo]/route.ts — GET single repo details
- app/api/github/prs/route.ts — GET open pull requests
- app/api/github/checks/route.ts — GET failing checks
- components/RepoCard.tsx — Repository card with CI status badge
- components/RepoList.tsx — Repository list component
- components/PRCard.tsx — Pull request card
- components/CheckStatus.tsx — Check run status indicator
- tests/github/client.test.ts — API client tests with mocked octokit
- tests/github/repos.test.ts — Repository health logic tests

## Acceptance Criteria

- [ ] The Konfigurierbare Workflow-Regeln (Statusübergänge, Review-Pflicht, Deployment-Verantwortung) capability is available through the intended application surface.
- [ ] Core validation, error handling, and persistence for Konfigurierbare Workflow-Regeln (Statusübergänge, Review-Pflicht, Deployment-Verantwortung) are covered by tests.

## Implementation Notes

- Start from domain rules and access constraints before UI or transport details.
- Keep module boundaries explicit so later extraction remains possible if the system grows.
- Update docs and tests in the same change instead of leaving them for cleanup.
