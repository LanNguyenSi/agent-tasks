# Task 003: Implement GitHub OAuth Login für Menschen

## Category

feature

## Priority

P0

## Wave

wave-2

## Delivery Phase

implementation

## Depends On

- 001
- 002

## Blocks

- 015

## Summary

Design and implement the capability for: GitHub OAuth Login für Menschen.

## Problem

The product cannot satisfy its initial scope until GitHub OAuth Login für Menschen exists as a reviewable, testable capability.

## Solution

Add a focused module for GitHub OAuth Login für Menschen that matches the recommended modular monolith and keeps integration boundaries explicit.

## Files To Create Or Modify

- lib/auth/jwt.ts — Token generation + verification (jsonwebtoken)
- lib/auth/password.ts — bcrypt hashing + verification
- lib/auth/middleware.ts — withAuth() HOF for protected routes
- lib/auth/validation.ts — Zod schemas (RegisterInput, LoginInput)
- lib/auth/service.ts — User registration + login business logic
- app/api/auth/register/route.ts — POST registration endpoint
- app/api/auth/login/route.ts — POST login endpoint
- app/api/auth/me/route.ts — GET current user (protected)
- prisma/schema.prisma — User model with email, password, name
- tests/auth/jwt.test.ts — Token generation + verification tests
- tests/auth/password.test.ts — Hash + verify tests
- tests/auth/validation.test.ts — Zod schema tests

## Acceptance Criteria

- [ ] The GitHub OAuth Login für Menschen capability is available through the intended application surface.
- [ ] Core validation, error handling, and persistence for GitHub OAuth Login für Menschen are covered by tests.

## Implementation Notes

- Start from domain rules and access constraints before UI or transport details.
- Keep module boundaries explicit so later extraction remains possible if the system grows.
- Update docs and tests in the same change instead of leaving them for cleanup.
