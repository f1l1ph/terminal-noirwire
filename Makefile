.DEFAULT_GOAL := help

.PHONY: help install dev build start lint format format-check typecheck check test e2e e2e-install

help: ## List available commands
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*## "}; {printf "%-16s %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

dev: ## Run the dev server (needs sim-noirwire running, see .env.local)
	npm run dev

build: ## Production build
	npm run build

start: ## Start the production build (run `make build` first)
	npm run start

lint: ## ESLint
	npm run lint

format: ## Prettier, writes fixes
	npm run format

format-check: ## Prettier, check only
	npm run format:check

typecheck: ## next typegen && tsc --noEmit
	npm run typecheck

check: lint typecheck format-check ## lint + typecheck + format-check

test: ## Vitest unit tests
	npm test

e2e-install: ## Install Playwright's pinned Chromium (one-time, or after a Playwright upgrade)
	npx playwright install chromium

e2e: ## Playwright end-to-end tests, against a mock of sim-noirwire this repo starts itself
	npm run test:e2e
