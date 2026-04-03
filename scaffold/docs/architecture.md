# Architecture: agent-tasks

## Overview

agent-tasks is a REST API built with **fastapi** and **postgresql**. It follows a layered architecture that separates HTTP concerns from business logic and data access, making each layer independently testable and replaceable.

## Architectural Layers

```
┌─────────────────────────────────────────────┐
│              HTTP Clients / Consumers        │
└──────────────────────┬──────────────────────┘
                       │ HTTP
┌──────────────────────▼──────────────────────┐
│               Routes / Controllers           │
│   Request parsing, validation, response      │
│             (src/routes/)                    │
├─────────────────────────────────────────────┤
│                  Services                    │
│      Business logic, orchestration           │
│  (no HTTP knowledge, no database queries)    │
├─────────────────────────────────────────────┤
│               Repositories                   │
│    Database queries, data access objects     │
│           (postgresql specific)          │
├─────────────────────────────────────────────┤
│                   Models                     │
│        Data shapes, schema definitions       │
│             (src/models/)                    │
└─────────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│               Postgresql         │
└─────────────────────────────────────────────┘
```

### Layer Responsibilities

**Routes / Controllers (`src/routes/`)**

- Parse and validate incoming HTTP requests
- Delegate to the appropriate service
- Format and return HTTP responses
- Handle HTTP-level concerns: status codes, headers, content negotiation
- Must NOT contain business logic or database queries

**Services**

- Implement all business logic
- Orchestrate calls across multiple repositories
- Validate business rules (as opposed to input format validation)
- Must NOT import HTTP framework types or query the database directly
- Are the primary unit of unit testing

**Repositories**

- Execute all database queries
- Map database rows/documents to model objects
- Handle pagination, filtering, and sorting at the query level
- Must NOT implement business logic
- Are the primary integration testing target

**Models (`src/models/`)**

- Define data shapes as types or classes
- Contain validation schemas for input/output
- Are framework-agnostic where possible

**Middleware (`src/middleware/`)**

- Cross-cutting concerns applied to all or selected routes
- Logging, request tracing, CORS, rate limiting
- Authentication and authorization checks
- Error normalization and response formatting

**Config (`src/config/`)**

- Load and validate environment variables at startup
- Expose typed configuration objects to the rest of the application
- Fail fast if required configuration is missing

## Framework: fastapi

FastAPI is a Python web framework built on Starlette and Pydantic.

Key conventions for this project:

- **Routers**: Each resource has its own `APIRouter` in `src/routes/`. Routers are registered in `src/main.py`.
- **Schemas**: Pydantic models in `src/models/` define request bodies, response shapes, and internal data structures. Separate `CreateSchema`, `UpdateSchema`, and `ResponseSchema` per resource.
- **Dependency injection**: FastAPI's `Depends()` is used to inject services and repositories into route handlers, and to enforce authentication on protected routes.
- **Async**: Route handlers and service methods are `async def`. Database calls must be awaited using an async ORM (e.g., SQLAlchemy async, Tortoise ORM, or Beanie for MongoDB).
- **Startup/shutdown**: Use `lifespan` context managers for database pool initialization and cleanup.

```python
# Example route structure
# src/routes/users.py
from fastapi import APIRouter, Depends, HTTPException, status
from src.models.user import UserCreate, UserResponse
from src.services.user_service import UserService
from src.middleware.auth import require_auth

router = APIRouter(prefix="/users", tags=["users"])

@router.get("/", response_model=list[UserResponse])
async def list_users(
    page: int = 1,
    page_size: int = 20,
    service: UserService = Depends(),
):
    return await service.list_users(page=page, page_size=page_size)

@router.post("/", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreate,
    service: UserService = Depends(),
):
    return await service.create_user(body)
```


## Database: postgresql

PostgreSQL is the primary data store.

**Connection**: Use a connection pool. Configure `DATABASE_URL` as a standard PostgreSQL connection string (`postgresql://user:pass@host:5432/dbname`).

**Migrations**: Track schema changes with a migration tool:
- Alembic is the standard choice for SQLAlchemy projects
- Each migration is a versioned Python file
- Run `alembic upgrade head` before starting the application

**Conventions**:
- Table names are plural snake_case: `users`, `api_keys`, `refresh_tokens`
- All tables have `id` (UUID or serial), `created_at`, and `updated_at` columns
- Foreign keys are explicit and indexed
- Soft deletes use a `deleted_at` nullable timestamp column


## Authentication: OAUTH2

Authentication delegates to an OAuth2 provider (e.g., Google, GitHub, Auth0).

**Flow** (Authorization Code with PKCE):
1. Client redirects user to `GET /api/v1/auth/authorize`
2. API redirects to the provider's authorization URL
3. Provider redirects back to `GET /api/v1/auth/callback` with an authorization code
4. API exchanges the code for provider tokens, looks up or creates the local user, and issues a session token
5. Client uses the session token for subsequent API requests

**Implementation rules**:
- Store `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` in environment variables
- Validate the `state` parameter to prevent CSRF attacks
- Store minimal user data locally (provider ID, email, display name)


### Authorization

Beyond authentication (who are you?), authorization (what can you do?) is enforced at the service layer using a role or permission model:

- Roles are assigned to users: `admin`, `member`, `viewer`
- Permissions are checked before any mutating operation
- Resource ownership is validated: users may only modify their own resources unless they hold an elevated role
- Authorization failures return `403 Forbidden`, not `404 Not Found`, unless hiding resource existence is a security requirement



## CI/CD

The CI pipeline runs on every push and pull request:

1. **Lint**: Check code style and format
2. **Type check**: Verify type correctness (if applicable)
3. **Unit tests**: Run fast, isolated tests
4. **Integration tests**: Run tests against a real postgresql instance (spun up by the CI environment)
5. **Build**: Verify the application builds successfully
6. **Security scan**: Check for known vulnerabilities in dependencies

On merge to `main`:
- Deploy to a staging environment
- Run smoke tests against staging
- Manual promotion gate to production (or automatic for low-risk changes)


## Error Handling

All errors return a consistent JSON envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request body is invalid.",
    "details": [
      { "field": "email", "message": "Must be a valid email address." }
    ]
  }
}
```

See [API Design](api-design.md) for the full error code list and HTTP status mapping.

## Testing Strategy

Approach: **unit-and-integration**

**Unit tests** (fast, no I/O):
- Every service method has unit tests
- Repositories are mocked in service tests
- Business rules and edge cases are exhaustively covered at this layer

**Integration tests** (real database, in `tests/integration/`):
- Every repository method is tested against a real postgresql instance
- Every route is tested via an HTTP client against a running application
- Authentication flows are tested end-to-end

## Decisions

See [ADR log](adrs/) for all architectural decisions and their rationale.
