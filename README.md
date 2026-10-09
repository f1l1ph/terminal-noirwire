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

## Architecture

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Lightweight
Charts, `@solana/web3.js` (for the browser test wallet's ed25519 keypair),
Zod (runtime validation of every response from the simulation service). No
database and no backend of its own: the browser talks directly to
[sim-noirwire](../sim-noirwire), the always-on service that makes the test
order book feel alive and measurable.

| Path                   | What it is                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/env.ts`       | Zod-validated configuration; refuses to start with a missing simulation service URL                                                                                                                                                                          |
| `src/lib/market-data/` | Typed HTTP + one reconnecting websocket client for the service's public routes; a framework-free store, and the hooks that wire it into React                                                                                                                |
| `src/lib/trading/`     | The `TradingClient` interface, fixed-point order math (fees, margin, a liquidation estimate), order validation against market settings, the own-order tag used to recognise "yours" on the public tape, and `DevTradingClient` (today's only implementation) |
| `src/lib/wallet/`      | The browser test wallet: generate, store, export and import an ed25519 keypair, entirely client-side                                                                                                                                                         |
| `src/lib/format/`      | Number, price, duration and time formatting, matching the design concept                                                                                                                                                                                     |
| `src/components/`      | The terminal's screens: market switcher, chart, venue pulse, public tape, the witness rail (the own-order timeline that replaces a depth ladder), order entry, the account dock, the public view panel                                                       |
| `src/proxy.ts`         | Gives every page request its own Content-Security-Policy nonce, so inline bootstrap scripts can run under a strict `script-src`                                                                                                                              |

See `docs/BUILD-NOTES.md` for every place this terminal's build deviates from
`docs/CONCEPT.md`, and every assumption it makes about sim-noirwire's API
that needs reconciling once that service ships real code.

## Quick start

Node 24 or later (`.nvmrc`; `nvm use` picks it up).

```bash
npm install
cp .env.example .env.local
npm run dev            # http://localhost:3000
```

The terminal needs sim-noirwire running at the URL named in `.env.local`
(`NEXT_PUBLIC_SIM_URL`, `NEXT_PUBLIC_SIM_WS_URL`) to show anything past the
empty state. Until that service has its own `npm run dev`, point those
variables at any server implementing the routes in
`../sim-noirwire/docs/DESIGN.md` plus the dev trading routes `docs/BUILD-NOTES.md`
assumes, or run this repo's own end-to-end mock (`node e2e/fake-sim/server.mts`)
to see the terminal fully populated.

```bash
make check       # lint + typecheck + format check
make test        # vitest unit tests
make e2e          # Playwright, against this repo's own mock of sim-noirwire
make build        # production build
```

See the Makefile (`make help`) for every command.

## Environment variables

Both are required; the build and the dev server refuse to start without a
valid URL in each. See `.env.example` for the full comments.

| Variable                    | Required                    | What it is                                                                                                                                                                                                                                                       |
| --------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SIM_URL`       | yes                         | sim-noirwire's HTTP origin                                                                                                                                                                                                                                       |
| `NEXT_PUBLIC_SIM_WS_URL`    | yes                         | sim-noirwire's websocket URL (`/v1/stream`)                                                                                                                                                                                                                      |
| `NEXT_PUBLIC_TRADING_MODE`  | no (default `dev`)          | `dev` talks to sim-noirwire's local-development trading routes; `rollup` is reserved for the implementation that signs transactions and sends them to the rollup directly, which does not exist yet — the terminal shows a plain "not connected" notice under it |
| `NEXT_PUBLIC_NETWORK_LABEL` | no (default `TEST NETWORK`) | the words shown beside every balance, volume and speed figure                                                                                                                                                                                                    |

## How numbers are labelled

- Every balance, position and fee is in **nUSD** (test dollars), never a
  bare dollar sign, and every such figure sits beside the configured network
  label (`TEST NETWORK` by default).
- The venue-wide confirmation time (`VenuePulse`) states its own definition,
  sample size and window, and shows `Insufficient samples` or `Measurement
unavailable` rather than a confident number it cannot back up.
- A per-order "click to confirmation" time is measured on the device placing
  the order, with a monotonic clock, and is labelled as such — a different
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
  repo starts and steers itself (`e2e/fake-sim/server.mts` — serves the
  routes documented in `sim-noirwire/docs/DESIGN.md` plus a websocket with
  scripted prices and fills; no dependency on that repo being runnable).
  Covers the first-minute flow (wallet, funds, a filled market long), a
  resting limit order and its cancel, a rejected order, connection lost and
  recovered, the public view carrying no private rows, and the phone layout
  at 390 wide. There is no unit/Playwright split for landing-page polish
  here because this is a dense trading screen, not a marketing page — CI is
  lint, types, format and the suites above.

## Security

This terminal holds a test wallet's secret key in the browser (localStorage)
and trades only against a test network. See `SECURITY.md` for scope and how
to report an issue. This code has not been audited.

## License

Proprietary. See [LICENSE](./LICENSE).
