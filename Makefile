.PHONY: help install setup hooks db-generate db-push dev dev-backend dev-frontend dev-docker docker-up docker-down docker-logs build test typecheck lint ci clean

.DEFAULT_GOAL := help

help: ## Show available targets
	@echo "Usage: make <target>"
	@echo ""
	@awk 'BEGIN {FS = ":.*?## "}; /^[a-zA-Z_-]+:.*?## / {printf "  %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install backend and frontend dependencies
	npm ci

setup: ## Prepare local development (.env + Prisma client)
	@if [ ! -f .env ]; then cp .env.example .env; fi
	npm run db:generate --workspace=backend

hooks: ## Set up Git pre-commit hooks (Husky + lint-staged)
	npx husky init
	cp .planforge/.husky-pre-commit .husky/pre-commit
	chmod +x .husky/pre-commit

db-generate: ## Generate Prisma client
	npm run db:generate --workspace=backend

db-push: ## Push schema to configured database
	npm run db:push --workspace=backend

dev: ## Run backend and frontend locally in one terminal
	@bash -lc 'set -e; trap "kill 0" EXIT; npm run dev:backend & npm run dev:frontend & wait'

dev-backend: ## Run backend locally
	npm run dev:backend

dev-frontend: ## Run frontend locally
	npm run dev:frontend

dev-docker: docker-up ## Start development stack in Docker

docker-up: ## Start Postgres + backend + frontend in Docker
	docker compose up --build

docker-down: ## Stop Docker services
	docker compose down

docker-logs: ## Tail Docker logs
	docker compose logs -f

build: ## Build backend and frontend
	npm run build

test: ## Run test suite
	npm test

typecheck: ## Run TypeScript checks
	npm run typecheck

lint: ## Run lint checks
	npm run lint

ci: ## Run core CI checks locally
	npm run typecheck
	npm test
	npm run build

clean: ## Remove local build artifacts
	rm -rf backend/dist frontend/.next coverage
