# DECISIONS

## ADR-001: Initial Architecture Shape

- Decision: Start with modular monolith as the default architecture.
- Full ADR: ../adrs/001-initial-architecture-shape.md

## ADR-002: Primary Data Store

- Decision: Use a relational primary data store unless the domain clearly requires a different model.
- Full ADR: ../adrs/002-primary-data-store.md

## ADR-003: Integration Strategy

- Decision: Encapsulate third-party integrations behind internal modules and keep failure handling explicit.
- Full ADR: ../adrs/003-integration-strategy.md
