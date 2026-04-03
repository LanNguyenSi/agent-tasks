# Task 010: Implement Teams und Projekte als zentrale Mandanten-/Struktureinheit

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

Design and implement the capability for: Teams und Projekte als zentrale Mandanten-/Struktureinheit.

## Problem

The product cannot satisfy its initial scope until Teams und Projekte als zentrale Mandanten-/Struktureinheit exists as a reviewable, testable capability.

## Solution

Add a focused module for Teams und Projekte als zentrale Mandanten-/Struktureinheit that matches the recommended modular monolith and keeps integration boundaries explicit.

## Files To Create Or Modify

- lib/users/types.ts — User, Role, Permission interfaces + Zod schemas
- lib/users/service.ts — User CRUD, role assignment, team management
- lib/users/permissions.ts — RBAC check functions (hasPermission, requireRole)
- app/api/users/route.ts — GET (list) + POST (invite) endpoints
- app/api/users/[id]/route.ts — GET/PUT/DELETE user
- app/api/users/[id]/role/route.ts — PUT change user role
- app/admin/users/page.tsx — User management admin page
- prisma/schema.prisma — User, Role, TeamMember models
- tests/users/service.test.ts — User CRUD tests
- tests/users/permissions.test.ts — RBAC logic tests

## Acceptance Criteria

- [ ] The Teams und Projekte als zentrale Mandanten-/Struktureinheit capability is available through the intended application surface.
- [ ] Core validation, error handling, and persistence for Teams und Projekte als zentrale Mandanten-/Struktureinheit are covered by tests.

## Implementation Notes

- Start from domain rules and access constraints before UI or transport details.
- Keep module boundaries explicit so later extraction remains possible if the system grows.
- Update docs and tests in the same change instead of leaving them for cleanup.
