# agent-tasks

agent-tasks ist eine kollaborative Task-Plattform für Menschen und Agenten. Sie ermöglicht strukturierte Zusammenarbeit rund um Softwareprojekte, inklusive Aufgabenerstellung, Claiming, Review-Handoffs, konfigurierbaren Boards und klaren Verantwortlichkeiten. Agenten arbeiten mit dedizierten API-Tokens, Menschen mit GitHub OAuth. Alle Aktionen sind auditierbar und policy-gesteuert.

## Overview

| Property | Value |
|----------|-------|
| Framework | fastapi |
| Database | postgresql |
| Auth | OAUTH2 |
| API Docs | OpenAPI / Swagger |
| Test Strategy | unit-and-integration |

## Quick Start

```bash
# Create a virtual environment
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Copy environment config
cp .env.example .env

# Run database migrations
alembic upgrade head

# Start the development server
uvicorn src.main:app --reload --port 8000
```

API documentation is available at: http://localhost:8000/docs


## Project Structure

```
agent-tasks/
├── src/
│   ├── routes/           # Route handlers and request validation
│   ├── models/           # Data models and schemas
│   ├── middleware/        # Authentication, logging, error handling
│   └── config/           # App configuration and environment
├── tests/
│   ├── integration/       # Integration tests against a real database
│   └── *.test.*           # Unit tests co-located with source or in tests/
├── docs/
│   ├── architecture.md    # System design and layer responsibilities
│   ├── ways-of-working.md # Team conventions and definition of done
│   ├── api-design.md      # REST conventions, naming, error formats
│   └── adrs/              # Architecture Decision Records
├── AI_CONTEXT.md          # AI agent context - read before making changes
├── .editorconfig
├── .gitignore
└── README.md
```

## API Endpoints

Base path: `/api/v1`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/v1/auth/login` | Authenticate and receive token |
| POST | `/api/v1/auth/logout` | Invalidate token |
| GET | `/api/v1/auth/callback` | OAuth2 callback handler |
| GET | `/api/v1/resources` | List resources (paginated) |
| POST | `/api/v1/resources` | Create a resource |
| GET | `/api/v1/resources/{id}` | Get a single resource |
| PUT | `/api/v1/resources/{id}` | Replace a resource |
| PATCH | `/api/v1/resources/{id}` | Partially update a resource |
| DELETE | `/api/v1/resources/{id}` | Delete a resource |

See [API Design](docs/api-design.md) for full conventions and error formats.
See the interactive docs at `/docs` (or `/swagger-ui.html` for Spring Boot) when the server is running.

## Authentication

This API uses **OAUTH2** authentication.

Authentication follows the OAuth2 Authorization Code flow. Redirect users to `/api/v1/auth/authorize` to begin the flow. The API will exchange the code for tokens and return a session.

## Testing

Strategy: **unit-and-integration**

```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=src --cov-report=term-missing

# Run only unit tests
pytest tests/ -m "not integration"

# Run only integration tests
pytest tests/integration/
```

- Unit tests cover service logic and data transformations
- Integration tests run against a real postgresql instance
- Target: >80% coverage on business logic

## Configuration

Environment variables are loaded from `.env` (development) or the system environment (production).

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | Database connection string | - |
| `SECRET_KEY` | Application secret key | - |
| `DEBUG` | Enable debug mode | `false` |
| `ALLOWED_HOSTS` | Comma-separated allowed hosts | `*` |
| `OAUTH_CLIENT_ID` | OAuth2 client ID | - |
| `OAUTH_CLIENT_SECRET` | OAuth2 client secret | - |
| `OAUTH_REDIRECT_URI` | Callback URL after auth | - |

## Documentation

- [Architecture](docs/architecture.md) - System design and layer responsibilities
- [Ways of Working](docs/ways-of-working.md) - Team conventions and definition of done
- [API Design](docs/api-design.md) - REST conventions, naming, pagination, error formats
- [ADR-0001: Framework and Database](docs/adrs/0001-architecture.md) - Why these technology choices were made
- Interactive API docs available when the server is running

---

*Generated with [ScaffoldKit](https://github.com/LanNguyenSi/scaffoldkit)*
