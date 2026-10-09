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
  in to the rollup's private endpoint to read its own account.

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

| Path                   | What it is                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/env.ts`       | Zod-validated configuration; refuses to start with a missing simulation service URL                                                                                                                                                                                                                                                       |
| `src/lib/sim-api/`     | The one shared schema file (`schema.ts`) for every wire shape sim-noirwire returns - REST and websocket alike. Both the browser client and the in-repo mock service import from it, so the two can never drift apart                                                                                                                      |
| `src/lib/market-data/` | Typed HTTP + one reconnecting websocket client for the service's public routes; a framework-free store, and the hooks that wire it into React                                                                                                                                                                                             |
| `src/lib/trading/`     | The `TradingClient` interface, fixed-point order math, order validation, and the two implementations: `DevTradingClient` (sim-noirwire's dev routes) and `RollupTradingClient` (signs and sends directly to the real on-chain order book)                                                                                                 |
| `src/lib/rollup/`      | Everything `RollupTradingClient` needs: key derivation, the signed-in session (with sign-in refresh), unit conversion between this terminal's decimal strings and the program's lots/atoms, the open-and-fund flow, outcome mapping, and receipt-based own-fill recognition. `sdk.ts` is the only file that imports `@noirwire/orderbook` |
| `src/lib/wallet/`      | The browser test wallet: generate, store, export and import an ed25519 keypair, entirely client-side. This keypair IS the owner key in rollup mode                                                                                                                                                                                        |
| `src/lib/format/`      | Number, price, duration and time formatting, matching the design concept                                                                                                                                                                                                                                                                  |
| `src/components/`      | The terminal's screens: market switcher, chart (real candles plus volume), venue pulse, public tape, the witness rail (the own-order timeline that replaces a depth ladder), order entry, the account dock, the public view panel                                                                                                         |
| `src/proxy.ts`         | Gives every page request its own Content-Security-Policy nonce, so inline bootstrap scripts can run under a strict `script-src`                                                                                                                                                                                                           |

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
dev`, `http://localhost:3101` for `make e2e-live`'s build) or every request
fails CORS silently in the browser console.

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

`NEXT_PUBLIC_SIM_URL` and `NEXT_PUBLIC_SIM_WS_URL` are always required. The
four `NEXT_PUBLIC_ROLLUP_*` variables are required only when
`NEXT_PUBLIC_TRADING_MODE=rollup`. See `.env.example` for the full comments.

| Variable                           | Required                       | What it is                                                                                                                                                       |
| ---------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SIM_URL`              | yes                            | sim-noirwire's HTTP origin                                                                                                                                       |
| `NEXT_PUBLIC_SIM_WS_URL`           | yes                            | sim-noirwire's websocket URL (`/v1/stream`)                                                                                                                      |
| `NEXT_PUBLIC_TRADING_MODE`         | no (default `dev`)             | `dev` talks to sim-noirwire's local-development trading routes; `rollup` signs and sends every trade straight to the real on-chain order book from this browser  |
| `NEXT_PUBLIC_NETWORK_LABEL`        | no (default `TEST NETWORK`)    | the words shown beside every balance, volume and speed figure                                                                                                    |
| `NEXT_PUBLIC_ROLLUP_RPC_URL`       | rollup mode only               | the rollup's public RPC (reads market/tape/price-feed/stats accounts and sends every trading instruction)                                                        |
| `NEXT_PUBLIC_ROLLUP_WS_URL`        | rollup mode only               | that connection's websocket companion                                                                                                                            |
| `NEXT_PUBLIC_ROLLUP_PRIVATE_URL`   | rollup mode only               | the rollup's private endpoint this browser signs in to, to read its own `TraderView` (DESIGN.md section 4); its websocket is derived from this URL automatically |
| `NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID` | no (defaults to the SDK's own) | overrides `@noirwire/orderbook`'s built-in program id, for a redeployment under a different one                                                                  |

No `NEXT_PUBLIC_SOLANA_RPC_URL`: nothing in the trading path talks to
base-layer Solana directly (opening, funding and every trading instruction
are rollup-only), so it would be a variable with no reader. See
docs/BUILD-NOTES.md, "Rollup config the service doesn't expose yet."

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
  CI): the first-minute flow signed in the browser against a real local
  MagicBlock rollup plus sim-noirwire in `VENUE=rollup` mode. See "Running
  against the real rollup" below.

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
SIM_ROLLUP_URL=http://localhost:4100 \
ROLLUP_RPC_URL=http://127.0.0.1:7799 \
ROLLUP_WS_URL=ws://127.0.0.1:7800 \
ROLLUP_PRIVATE_URL=http://127.0.0.1:6699 \
  make e2e-rollup
```

Point `.env.local` at the same four rollup variables (see the table above)
to run `npm run dev` against it by hand instead.

## Security

This terminal holds a test wallet's secret key in the browser (localStorage)
and trades only against a test network. See `SECURITY.md` for scope and how
to report an issue. This code has not been audited.

## License

Proprietary. See [LICENSE](./LICENSE).
