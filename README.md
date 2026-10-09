# NoirWire terminal

A web trading terminal for the NoirWire order book: spot and perpetual markets
on a test network, with exchange-like speed. The order book is private:
resting orders, depth, balances and positions are visible only to their
owner. What is public is the mark price, the tape of fills, aggregate
counters, and market settings.

- Get a browser wallet in under a minute, no install, no extension.
- Press one button for 5,000 test nUSD, then place a spot or perpetual order.
- Every figure that could be mistaken for real money or a real venue is
  labelled test network, in the UI and in this README.
- A measured confirmation time is shown per order (click to acknowledgement,
  on this device) alongside the venue-wide p50 / p99 from `/v1/stats`.
- In rollup mode (`NEXT_PUBLIC_TRADING_MODE=rollup`), every order is signed in
  this browser and sent straight to the real on-chain order book. Nothing but
  public market data (markets, mark, tape, candles, stats) goes through
  sim-noirwire; the browser wallet's keypair is the owner key, and it signs
  in to the rollup's query filter to read its own account. On the local
  stack this is one RPC/WS endpoint, not a separate public/private pair:
  sign-in is a token appended to the same URL, and sending a transaction
  needs that signed-in token too, not only reading privately.
- The on-chain client (`@noirwire/orderbook` and everything under it) is
  loaded lazily, only once a wallet is created: a dev-mode build never
  fetches it. See "Bundle size" below.

## Architecture

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Lightweight
Charts, `@solana/web3.js` (the browser test wallet's ed25519 keypair, and the
owner key in rollup mode), `@noirwire/orderbook` (the real order book's
client, rollup mode only - a vendored release under `vendor/`, see "Updating
the order book client" below), Zod (runtime validation of every response
from the simulation service). No database and no backend of its own: the
browser talks directly to [sim-noirwire](../sim-noirwire) for public market
data in both modes, and directly to the rollup for everything else in
rollup mode.

| Path                   | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/env.ts`       | Zod-validated configuration; refuses to start with a missing simulation service URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/lib/sim-api/`     | The one shared schema file (`schema.ts`) for every wire shape sim-noirwire returns - REST and websocket alike. Both the browser client and the in-repo mock service import from it, so the two can never drift apart                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/lib/market-data/` | Typed HTTP + one reconnecting websocket client for the service's public routes; a framework-free store, and the hooks that wire it into React                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/lib/trading/`     | The `TradingClient` interface, fixed-point order math, order validation, and the two implementations: `DevTradingClient` (sim-noirwire's dev routes) and `RollupTradingClient` (signs and sends directly to the real on-chain order book). `rollupClientLazy.ts` wraps the latter behind a dynamic `import()` so a dev-mode build never pulls it in                                                                                                                                                                                                                                                  |
| `src/lib/rollup/`      | Everything `RollupTradingClient` needs: `deployment.ts` fetches sim-noirwire's `GET /v1/deployment` (network, program id, the rollup's RPC/WS URL, the exchange account, and every market's id/symbol/tokens/decimals/lot/tick) instead of reading it from env vars or scanning on-chain accounts; key derivation, the signed-in session (with sign-in refresh), unit conversion between this terminal's decimal strings and the program's lots/atoms, the open-and-fund flow, outcome mapping, and receipt-based own-fill recognition. `sdk.ts` is the only file that imports `@noirwire/orderbook` |
| `src/lib/wallet/`      | The browser test wallet: generate, store, export and import an ed25519 keypair, entirely client-side. This keypair IS the owner key in rollup mode                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/lib/format/`      | Number, price, duration and time formatting, matching the design concept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/components/`      | The terminal's screens: market switcher, chart (real candles plus volume), venue pulse, public tape, the witness rail (the own-order timeline that replaces a depth ladder), order entry, the account dock, the public view panel                                                                                                                                                                                                                                                                                                                                                                    |
| `src/proxy.ts`         | Gives every page request its own Content-Security-Policy nonce, so inline bootstrap scripts can run under a strict `script-src`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

See `docs/BUILD-NOTES.md` for every place this terminal's build deviates from
`docs/CONCEPT.md`, every decision this second pass made reconciling against
sim-noirwire's real code, and every remaining gap between what the UI wants
and what the service currently returns.

## Quick start

Node 24 or later (`.nvmrc`; `nvm use` picks it up).

```bash
npm install
cp .env.example .env.local
npm run dev            # http://localhost:3000
```

The terminal needs sim-noirwire running at the URL named in `.env.local`
(`NEXT_PUBLIC_SIM_URL`, `NEXT_PUBLIC_SIM_WS_URL`) to show anything past the
empty state. Run the real service from `../sim-noirwire` (`make install` if
needed, then `VENUE=memory DEV_TRADING=1` and its own `.env` - see that
repo's README for every variable), or run this repo's own deterministic mock
(`node e2e/fake-sim/server.mts`) to see the terminal fully populated without
a second service. **The real service's `ALLOWED_ORIGINS` must include
whatever origin the browser runs from** (`http://localhost:3000` for `npm run
dev`, `http://localhost:3101` for `make e2e-live`'s build, `http://localhost:3102`
for `make e2e-rollup`'s build) or every request fails CORS silently in the
browser console - including the `/v1/deployment` fetch rollup mode needs
before it will render anything but "Loading market settings."

```bash
make check       # lint + typecheck + format check
make test        # vitest unit tests
make e2e         # Playwright, against this repo's own mock of sim-noirwire
make e2e-live    # opt-in: the first-minute flow against a REAL sim-noirwire (dev mode) you already started
make e2e-rollup  # opt-in: the first-minute flow signed in the browser against a REAL local rollup
make build       # production build
```

See the Makefile (`make help`) for every command.

## Environment variables

`NEXT_PUBLIC_SIM_URL` and `NEXT_PUBLIC_SIM_WS_URL` are always required. In
rollup mode, everything else about the rollup - its RPC/WS URL, the program
id, the exchange account, every market's tokens and decimals - is read at
runtime from sim-noirwire's `GET /v1/deployment`, not from an env variable:
the three `NEXT_PUBLIC_ROLLUP_*`/`NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID` variables
below are **optional overrides** for a non-default deployment, never
required. See `.env.example` for the full comments.

| Variable                           | Required                    | What it is                                                                                                                                                      |
| ---------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SIM_URL`              | yes                         | sim-noirwire's HTTP origin                                                                                                                                      |
| `NEXT_PUBLIC_SIM_WS_URL`           | yes                         | sim-noirwire's websocket URL (`/v1/stream`)                                                                                                                     |
| `NEXT_PUBLIC_TRADING_MODE`         | no (default `dev`)          | `dev` talks to sim-noirwire's local-development trading routes; `rollup` signs and sends every trade straight to the real on-chain order book from this browser |
| `NEXT_PUBLIC_NETWORK_LABEL`        | no (default `TEST NETWORK`) | the words shown beside every balance, volume and speed figure                                                                                                   |
| `NEXT_PUBLIC_ROLLUP_RPC_URL`       | no - override only          | replaces the RPC URL `/v1/deployment` reports (the query filter on a local stack); also widens the Content-Security-Policy to allow it                          |
| `NEXT_PUBLIC_ROLLUP_WS_URL`        | no - override only          | replaces the websocket URL `/v1/deployment` reports; also widens the CSP                                                                                        |
| `NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID` | no - override only          | replaces the program id `/v1/deployment` reports, for a redeployment under a different one                                                                      |

No `NEXT_PUBLIC_SOLANA_RPC_URL` and no "private URL" variable: nothing in the
trading path talks to base-layer Solana directly, and the rollup's query
filter is one endpoint for both an unsigned read and a signed-in one - sign-in
is a token appended to the same URL, not a separate address. See
docs/BUILD-NOTES.md, "Deployment-based rollup config."

## How numbers are labelled

- Every balance, position and fee is in **nUSD** (test dollars), never a
  bare dollar sign, and every such figure sits beside the configured network
  label (`TEST NETWORK` by default).
- The venue-wide confirmation time (`VenuePulse`) states its own definition,
  sample size and window, and shows `Insufficient samples` or `Measurement
unavailable` rather than a confident number it cannot back up.
- A per-order "click to confirmation" time is measured on the device placing
  the order, with a monotonic clock, and is labelled as such - a different
  number from the venue-wide p50/p99.
- The liquidation price shown in order entry and in the Margin tab is a
  client-computed **estimate**, labelled `(est.)`, because sim-noirwire does
  not document a risk-engine read endpoint (see `docs/BUILD-NOTES.md`).

## Bundle size

The on-chain client (`@noirwire/orderbook`, `@magicblock-labs/ephemeral-rollups-sdk`
and everything under them) is loaded through a dynamic `import()`
(`src/lib/trading/rollupClientLazy.ts`), not a static one, so it is a
separate chunk the browser fetches only once a wallet is actually created -
never on page load, and never at all in a dev-mode build. Measured against a
production build (`npx next build && npx next start`), counting every script
byte the browser actually requests:

| Build                             | On arrival | After creating a wallet |
| --------------------------------- | ---------- | ----------------------- |
| `NEXT_PUBLIC_TRADING_MODE=dev`    | ~1.53 MB   | ~1.53 MB (unchanged)    |
| `NEXT_PUBLIC_TRADING_MODE=rollup` | ~1.53 MB   | ~1.55 MB (+~16 KB)      |

A dev-mode build's initial load is identical to rollup mode's; the entire
on-chain SDK costs about 16 KB, paid only by a browser that actually opens a
wallet in rollup mode.

## Deployment

Deployable to Vercel as is: set `NEXT_PUBLIC_SIM_URL`, `NEXT_PUBLIC_SIM_WS_URL`
and (if needed) `NEXT_PUBLIC_TRADING_MODE` / `NEXT_PUBLIC_NETWORK_LABEL` as
environment variables, and let the host build it with `npm run build`.
`next.config.ts` sets security headers (`X-Frame-Options`, `nosniff`,
`Referrer-Policy`, a Permissions-Policy, HSTS) on every response; `src/proxy.ts`
sets a nonced Content-Security-Policy on every page, with `connect-src`
limited to `'self'` plus the two configured simulation-service origins, so
the page reaches no other host.

## Testing

- **Unit** (`make test` / `npm test`): formatting, order validation against
  market settings, the fixed-point margin and liquidation-estimate math,
  own-fill tag matching, the websocket reconnect/backoff schedule under a
  controlled clock, and `DevTradingClient` against a mocked `fetch`. No
  network, no browser.
- **End-to-end** (`make e2e` / `npm run test:e2e`): Playwright against this
  repo's own production build, talking to a small mock of sim-noirwire this
  repo starts and steers itself (`e2e/fake-sim/server.mts` - built on the
  same `src/lib/sim-api/schema.ts` the browser client uses, so its shapes
  cannot drift from the real service's; no dependency on that repo being
  runnable). Covers the first-minute flow (wallet, funds, a filled market
  long), a resting limit order and its cancel, a rejected order (reduce-only
  in the wrong direction), a spot buy, connection lost and recovered, the
  public view carrying no private rows, and the phone layout at 390 wide.
  There is no unit/Playwright split for landing-page polish here because
  this is a dense trading screen, not a marketing page - CI is lint, types,
  format and the suite above.
- **End-to-end against the real service** (`make e2e-live`, opt-in, never
  CI): the same first-minute flow run against a real local sim-noirwire
  instance in dev mode (`SIM_LIVE_URL`, default `http://localhost:4100`).
  Start that service yourself first; see the CORS note under Quick start.
- **End-to-end against the real rollup** (`make e2e-rollup`, opt-in, never
  CI): signed in the browser against a real local MagicBlock rollup plus
  sim-noirwire in `VENUE=rollup` mode - creates a wallet, opens and funds the
  real on-chain account (one transaction, 5,000 nUSD collateral), places a
  market long that fills against the house maker, checks the position, rests
  a limit order and cancels it, moves funds to spot and buys on the spot
  market, runs the public-view check twice (an unsigned read of this
  trader's own account and of the market's book both come back empty), and
  reloads the page to confirm the account, position, open orders and
  own-fill marks all come back from the chain. A second, phone-viewport test
  covers the funded and filled states at 390 wide. See "Running against the
  real rollup" below.

## Running against the real rollup

Needs the order book repository's local network (solana-test-validator, the
ephemeral rollup, the query filter - ports 8899/7799/6699) and sim-noirwire
running with `VENUE=rollup`, both already up (that repository's own
`make network-up` / `make docker-up`; see its README and
`docs/DESIGN.md`, "Local run in Docker"). This repository never starts or
stops that network: those ports are shared with whoever is testing the
program itself, and bringing the network up or down from here could pull
state out from under them.

```bash
make e2e-rollup
```

No rollup URLs to pass: the build reads them from sim-noirwire's
`GET /v1/deployment` at runtime. The only env vars `make e2e-rollup` reads
are `SIM_ROLLUP_URL` (default `http://localhost:4100`) and, only if the
local stack's query filter is not at the default `6699`/`6700`,
`ROLLUP_RPC_URL`/`ROLLUP_WS_URL` (used solely to widen the
Content-Security-Policy to match - see playwright.rollup.config.ts).

Point `.env.local` at `NEXT_PUBLIC_TRADING_MODE=rollup` and the same
`NEXT_PUBLIC_SIM_URL`/`NEXT_PUBLIC_SIM_WS_URL` to run `npm run dev` against
it by hand instead; no rollup-specific variable is required there either.

## Security

This terminal holds a test wallet's secret key in the browser (localStorage)
and trades only against a test network. See `SECURITY.md` for scope and how
to report an issue. This code has not been audited.

## License

Proprietary. See [LICENSE](./LICENSE).
