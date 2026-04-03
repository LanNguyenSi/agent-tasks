# ADR-0001: Framework and Database Selection

## Status

Accepted

## Context

agent-tasks requires a foundational technology choice covering:

1. The web framework for handling HTTP, routing, validation, and serialization
2. The primary database for persistent storage
3. The authentication strategy for securing API endpoints

These decisions establish the project's core constraints and conventions. They are expensive to change after a codebase matures, so they deserve explicit documentation.

### Requirements

- A REST API that is straightforward to develop, test, and deploy
- Clear separation between HTTP handling, business logic, and data access
- Strong support for input validation and structured error responses
- Automatic or low-friction OpenAPI specification generation
- Secure, well-understood authentication mechanism
- Good ecosystem support and long-term maintainability

### Evaluated Options

**Frameworks considered:**
- FastAPI (Python) - async-native, Pydantic validation, built-in OpenAPI
- Express (Node.js) - minimal, flexible, vast ecosystem
- Django REST Framework (Python) - batteries-included, ORM integration
- Spring Boot (Java/Kotlin) - enterprise-grade, strong typing, mature ecosystem

**Databases considered:**
- PostgreSQL - relational, ACID, strong ecosystem
- MySQL - relational, widely hosted, good performance
- MongoDB - document store, flexible schema, horizontal scale
- SQLite - embedded, zero-infrastructure, limited concurrency

**Auth strategies considered:**
- JWT - stateless, scalable, no server-side session storage
- OAuth2 - delegated auth, reduces password management burden
- API Key - simple, suitable for service-to-service or developer APIs

## Decision

**Framework: fastapi**

**Database: postgresql**

**Auth strategy: OAUTH2**

### Rationale

**FastAPI** was selected because:

- Native async support aligns with non-blocking I/O patterns for database and external service calls
- Pydantic provides runtime validation and clear schema definitions that serve as living documentation
- OpenAPI schema is generated automatically from type annotations, reducing maintenance burden
- Performance benchmarks place it among the fastest Python frameworks
- The Python ecosystem is strong for data processing, if that need arises

Trade-offs accepted:
- Python's GIL limits CPU-bound parallelism (acceptable for an I/O-bound API)
- Async code requires discipline to avoid accidentally blocking the event loop


**PostgreSQL** was selected because:

- ACID compliance and strong consistency are critical for reliable data
- Rich feature set: JSONB for semi-structured data, full-text search, arrays, window functions
- Best-in-class ecosystem: pgvector, PostGIS, logical replication
- Strong cloud-hosted options (RDS, Cloud SQL, Supabase, Neon)
- Proven reliability at any scale from prototype to high-traffic production

Trade-offs accepted:
- Requires a running database service (more setup than SQLite)
- Schema changes require migrations, which add process overhead


### Auth Strategy Rationale

**OAuth2** was selected because:

- Delegates credential management to a trusted identity provider
- Users do not create a new password for this service, reducing password fatigue and breach surface
- Supports fine-grained scopes for delegated access
- Well-established standard with broad library support

Trade-offs accepted:
- Depends on an external identity provider; if the provider is down, login is unavailable
- The Authorization Code flow has more moving parts than simple username/password
- Implementation requires careful handling of state, PKCE, and token storage


## Consequences

### Positive

- Framework and database are well-matched to the use case and team experience
- The layered architecture (routes - services - repositories - models) is idiomatic for **fastapi**
- Established conventions from day one reduce decision fatigue for new contributors
- OpenAPI documentation is generated automatically, keeping the spec in sync with the code
- Infrastructure choices are documented here, making future revisits faster

### Negative / Trade-offs

- The framework and database are opinionated choices; contributors unfamiliar with them face a learning curve
- Changing either choice later would be a significant refactor

### Risks

- Over time, team preferences may shift; document any future reconsiderations in a superseding ADR
- Third-party library quality varies; vet new dependencies carefully before adding them

## References

- [Architecture documentation](../architecture.md)
- [API Design conventions](../api-design.md)
- [Ways of Working](../ways-of-working.md)
