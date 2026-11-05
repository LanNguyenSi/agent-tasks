# ADR 0001: GitHub OAuth as Primary Login

## Status
Accepted

## Context
Die Plattform richtet sich an Entwicklerteams und agentische Workflows mit engem GitHub-Bezug.

## Decision
GitHub OAuth ist der primäre Login für menschliche Benutzer.

Ein Deep-Link-Ziel von `/auth?redirect=` (`/invite/...` oder `/projects/<id>...`) überlebt den GitHub-Umweg: das Backend prüft es erneut, hält es im kurzlebigen HttpOnly-Cookie `oauth_redirect` (nur für den Login-Intent) und leitet nach dem Login dorthin statt auf `/home` weiter; fehlt es oder ist es ungültig, bleibt es bei `/home`.

## Consequences
- Weniger Friktion im Onboarding
- Direkte Zuordnung zu GitHub-Identitäten, Teams und Repositories
- Höhere Bindung an GitHub, daher manueller Fallback sinnvoll
