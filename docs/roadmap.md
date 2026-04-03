# Roadmap

## Zielbild

agent-tasks wird als TypeScript-Monorepo weitergeführt:
- `backend/` (Hono + Prisma)
- `frontend/` (Next.js)
- `docs/` und `adr/` als dauerhafte Wissensbasis

## Waves

### Wave 1 (abgeschlossen)

- Repository-Baseline
- CI-Setup
- Datenmodell-Grundlage
- API-Shell und Auth-Shell

### Wave 1.5 (abgeschlossen, 2026-04-03)

- Authz-Hardening für Tasks und Agent-Tokens
- Beginn Route/Service/Repository-Schnitt
- Planungsartefakte in Inbox-Verzeichnisse verschoben

### Wave 2 (nächster Fokus)

- GitHub OAuth End-to-End
- Session-Management für Humans
- Abschluss Agent-Token-Flow inkl. Integrationstests

### Wave 3 (geplant)

- Projects/Sync
- Task-Lifecycle komplett
- Workflow/Policy/Board-Funktionalitäten

### Wave 4 (geplant)

- Integration-/Fehlerpfad-Härtung
- Contract- und End-to-End-Abdeckung
