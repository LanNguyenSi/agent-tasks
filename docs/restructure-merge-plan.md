# Restructure Merge Plan (Root-First)

## Status

- `.planforge/` und `scaffold/` sind vollständig wiederhergestellt.
- Ziel ist jetzt ein kontrollierter Root-first-Merge statt früher Löschung.

## Warum Root-First nicht direkt per `mv * .`

Beim direkten Flatten in den Root entstehen sofort Dateikonflikte.

Ermittelter Konfliktstand:
- Legacy-Dateien gesamt: 67
- Direkte Namenskonflikte: 6

Konfliktdateien:
- `README.md`
- `Makefile`
- `.dockerignore`
- `.gitignore`
- `.github/workflows/ci.yml`
- `docs/architecture.md`

## Vorgehen

1. Root-first Sicht herstellen:
- Inhalte aus `.planforge/` und `scaffold/` bleiben sichtbar im Repo.
- Kein weiterer harter Delete-Schritt, bis alle Konflikte aufgelöst sind.

2. Konflikte einzeln mergen:
- Bei jeder Konfliktdatei explizit Source-of-Truth festlegen.
- Relevante Deltas in aktive Dateien übernehmen.

3. Planungswissen normalisieren:
- Backlog in `docs/backlog.md`
- Roadmap in `docs/roadmap.md`
- Entscheidungen in `adr/`

4. Final Cut erst nach Abnahme:
- Erst wenn keine relevanten Deltas offen sind, werden `.planforge/` und `scaffold/` entfernt.

## Bereits übernommen

- ADR-Deltas:
  - `adr/0005-modular-monolith-as-starting-architecture.md`
  - `adr/0006-relational-database-as-primary-store.md`
  - `adr/0007-integrations-behind-internal-boundaries.md`
- Vision/NFR-Deltas:
  - `docs/vision.md`
  - `docs/non-functional-requirements.md`
- Backlog/Roadmap:
  - `docs/backlog.md`
  - `docs/roadmap.md`

## Nächste konkrete Schritte

1. [x] `README.md` gegen `scaffold/README.md` und `.planforge/PROJECT.md` mergen.
2. [x] Root-`Makefile` gegen `.planforge/Makefile` mergen.
3. [x] Root-`docker-compose.yml` gegen `.planforge/docker-compose.dev.yml` mergen.
4. [x] `.github/workflows/ci.yml` und `docs/architecture.md` final zusammenführen.
5. [x] `.gitignore` und `.dockerignore` final zusammenführen.
