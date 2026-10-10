.DEFAULT_GOAL := help

.PHONY: help install dev build start lint format format-check typecheck check test e2e e2e-install e2e-live e2e-rollup e2e-devnet sdk-update

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

e2e-live: ## Opt-in: the first-minute flow against a REAL sim-noirwire you already started (SIM_LIVE_URL, default http://localhost:4100). Not part of CI.
	npx playwright test --config=playwright.live.config.ts

e2e-rollup: ## Opt-in: the first-minute flow signed in the browser against a REAL local rollup plus sim-noirwire in rollup mode. Needs ports 8899/7799/6699 and the service already running (see README). Not part of CI.
	npx playwright test --config=playwright.rollup.config.ts

e2e-devnet: ## Opt-in: the first-minute flow signed in the browser against the real Solana devnet, through a sim-noirwire already running in rollup mode pointed at devnet (DEVNET_SIM_URL, default http://localhost:4100). Reuses the wallet persisted in e2e/.devnet-wallet.json across runs. Not part of CI.
	npx playwright test --config=playwright.devnet.config.ts

sdk-update: ## Copy a fresh @noirwire/orderbook release tarball from a sibling checkout: make sdk-update SDK_SRC=/path/to/noirwire-orderbook-X.Y.Z.tgz
	@test -n "$(SDK_SRC)" || (echo "set SDK_SRC to the sibling sdk tgz path" && exit 1)
	cp "$(SDK_SRC)" vendor/
	npm install
