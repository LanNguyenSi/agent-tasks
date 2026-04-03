# Task 008: Implement Task-Claiming durch Menschen und Agenten

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

Design and implement the capability for: Task-Claiming durch Menschen und Agenten.

## Problem

The product cannot satisfy its initial scope until Task-Claiming durch Menschen und Agenten exists as a reviewable, testable capability.

## Solution

Add a focused module for Task-Claiming durch Menschen und Agenten that matches the recommended modular monolith and keeps integration boundaries explicit.

## Files To Create Or Modify

- lib/ai/types.ts — ChatMessage, DashboardContext interfaces + Zod schemas
- lib/ai/context.ts — formatContextForAI() helper
- lib/ai/service.ts — OpenAI API integration
- app/api/chat/route.ts — POST chat endpoint
- app/api/chat/clear/route.ts — DELETE chat history endpoint
- components/Chat.tsx — Chat UI component
- tests/ai/types.test.ts — Zod schema tests
- tests/ai/context.test.ts — Context formatting tests

## Acceptance Criteria

- [ ] The Task-Claiming durch Menschen und Agenten capability is available through the intended application surface.
- [ ] Core validation, error handling, and persistence for Task-Claiming durch Menschen und Agenten are covered by tests.

## Implementation Notes

- Start from domain rules and access constraints before UI or transport details.
- Keep module boundaries explicit so later extraction remains possible if the system grows.
- Update docs and tests in the same change instead of leaving them for cleanup.
