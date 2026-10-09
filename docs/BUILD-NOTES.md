# Build notes

sim-noirwire had no code when this was built, only
`sim-noirwire/docs/DESIGN.md`. Everything below either deviates from
`docs/CONCEPT.md` (with the reason) or assumes a shape for sim-noirwire's
API that was not documented there. Read this before wiring the terminal to
the real service.

## Assumptions about sim-noirwire's API (need reconciling against real code)

1. **Dev trading route shapes are invented.** The design doc names
   `POST /v1/dev/orders`, `POST /v1/dev/cancel-all`, `GET /v1/dev/trader`
   and `POST /v1/fund` but does not give request/response bodies. This
   terminal's assumption lives in `src/lib/trading/schemas.ts` (Zod
   schemas) and `src/lib/trading/devClient.ts`. The single biggest
   assumption: **every order carries a `clientTag`** (this browser's random
   64-bit tag, `src/lib/trading/tags.ts`), and the venue is assumed to echo
   it back on the trader's own open orders, own fills, and on the
   corresponding row of the **public** tape (`PublicFill.tag`). Without that
   echo, the "yours" highlight on the tape (an explicit product requirement)
   cannot work from the public feed alone.
2. **No per-order cancel route is documented**, only cancel-all.
   `DevTradingClient.cancelOrder(wallet, market, orderId)` calls
   `POST /v1/dev/cancel-all` and ignores `orderId`. This is only correct
   when the trader has one resting order in that market. A real per-order
   cancel route should replace this the moment it exists.
3. **No account-state push channel is documented** (the public websocket
   covers `price` / `fill` / `candle` / `stats` only). `DevTradingClient`
   polls `GET /v1/dev/trader` once immediately on `subscribe()` and then
   every `pollIntervalMs` (default 1000 ms - lowered from an initial 2000 ms
   so a fill shows up within about a second, closer to the "fast as a
   centralised exchange" goal). A position, fill or cancellation can
   therefore lag up to one poll interval behind the witness rail's
   `Confirmed` step, which comes straight from the order's own HTTP
   response.
4. **No explicit open-account route exists.** `openAccount()` calls
   `GET /v1/dev/trader` and swallows a failure; `fund()` is what actually
   creates server-side state for a new address (matching the design doc's
   `Venue.deposit`, which implies the trader springs into existence on
   first deposit).
5. **No websocket subscribe handshake is documented** ("a client subscribes
   per market" is the only line). `MarketSocket` listens to the unfiltered
   stream after connecting; the client-side store
   (`src/lib/market-data/store.ts`) already keys every message by the
   `market` field the design doc's message shapes all carry, so no
   bandwidth is wasted on _rendering_ unwanted markets, only on receiving
   them. Reconcile once sim-noirwire documents a real subscribe protocol.
6. **No risk-engine read endpoint is documented.** The concept
   (section 7) calls for "an estimated liquidation price from the risk
   engine." There is nothing to read it from, so `src/lib/trading/risk.ts`
   computes a liquidation **estimate** client-side (fixed-point, a flat
   0.50% maintenance-margin assumption against notional) and every place it
   is shown is labelled `(est.)`. At minimum leverage this estimate is
   correctly very close to zero (it would take price falling by roughly the
   inverse of leverage to erase the margin) - a near-zero number at 1x is
   expected output, not a bug.
7. **No time-in-force enumeration is documented** on `MarketInfo`. Limit
   orders are always sent with `timeInForce: "gtc"`. The concept's
   time-in-force selector and `Post only` control are cut for this reason
   (see "Cuts from the concept" below).
8. **The protective execution bound for a market order** (concept sections 3
   and 7: "A protective price limit is mandatory... otherwise offer limit
   orders only") is sent as `protectionPrice` on every market order, a field
   name this terminal invented. It defaults to mark price ± 1% (buy/sell)
   and is editable. If sim-noirwire's `NewOrder` shape does not have this
   field, or names it differently, `DevTradingClient.placeOrder` needs
   updating; nothing else does.
9. `e2e/fake-sim/server.mts`'s `/v1/fund` grants another 5,000 nUSD on every
   call, not once per address as the design doc's "one grant per address"
   says - a deliberate simplification for repeatable local test runs, not a
   claim about the real service.

## Deviations from docs/CONCEPT.md

These are required by the brief's explicit overrides, or cut for scope
(YAGNI) given the gaps above; none are silent.

- **No separate routed screens for "Markets" / "Activity".** The top bar's
  nav items from the concept's ASCII layout are folded into the one
  terminal screen (`MarketSwitcher` + `AccountDock` tabs already cover that
  ground) rather than built as their own pages - in the spirit of "one idea
  per screen" and the brief's own 3-day-build cuts (no saved layouts, no
  cross-market search).
- **No review sheet.** Per the task's explicit override: the order summary
  (quantity, protection/limit price, fee, initial margin, estimated
  liquidation) is always visible above the submit button
  (`OrderSummary`/`OrderEntry`), and only the **first** order each browser
  session asks for one confirmation (with a "Do not ask again" tick,
  persisted in `localStorage`); every order after that is one click. Session
  boundary is `sessionStorage` (a new tab or a reload after the browser
  fully closes asks again, unless "Do not ask again" was ticked).
- **"always with the word too"** (the brief's phrasing for the safe/danger
  side-button and tape-row override) is read as: color never carries
  direction alone, it is always paired with the literal word - "Buy"/"Sell"
  on buttons, "buy"/"sell" on tape rows - not as literally appending the
  word "too" to any label. `Place test long` / `Place test short` are the
  submit-button labels; no "too" suffix is added anywhere.
- **No time-in-force selector, no Post only control.** See assumption 7
  above. Orders are effectively GTC.
- **No persistent "Liquidation risk" banner** as its own global warning
  state (concept section 8). There is no account-level equity/margin-ratio
  feed to drive one honestly (assumption 6). Instead, every open perp
  position's estimated liquidation price is shown in the Positions and
  Margin tabs of the account dock, each labelled an estimate.
- **The chart is real OHLC candles plus a volume histogram** (second pass,
  superseding the original one-line-series build): `/v1/candles` rows map
  directly onto `lightweight-charts`' candlestick + histogram series, with
  the live mark drawn as a price line and fill markers split into "yours"
  (above the bar) and public (inside the bar, dimmer) - no client tag is
  sent or expected; "yours" is read off the trader's own reported fill
  sequence numbers against the public tape's sequence field, so an
  observer watching the tape alone can never link a fill to a trader.
- **`ConnectionStatus` shows "Connection lost" for both `reconnecting` and
  `closed`** (only the dot color differs): an unexpected drop always
  retries on its own, so there is no action for the trader to take either
  way, and showing two different sentences for the same "nothing works
  right now" fact would be noise.

## A real bug this build found and fixed

Three places defaulted a raw browser global (`fetch`, `setInterval`,
`clearInterval`, `setTimeout`) directly onto a class field and later called
it as `this.field(...)`. Chrome throws `TypeError: Illegal invocation` for
exactly this, because these are receiver-checked native functions and the
method-call form rebinds `this` to the class instance instead of `window`.
Unit tests never caught it because they always inject a plain mock function
for these; only the Playwright suite, against a real browser, did
(`DevTradingClient` and `MarketSocket` now wrap every such default in an
arrow function that performs the call bare). `lightweight-charts`' own
`setMarkers` also required its input sorted ascending by time - the public
tape is stored newest-first for display, so markers are now re-sorted
before being handed to the chart.

## Known non-blocking issue

A `lightweight-charts` internal error ("Value is null") was observed
sporadically in the tested Chromium build when its own `autoSize` /
internal `ResizeObserver` path was used; it did not reproduce after
replacing `autoSize: true` with a plain `ResizeObserver` that calls
`chart.resize()` directly, which `MarketChart.tsx` now does. If it
resurfaces, it does not affect any functional state observed in testing
(every e2e scenario passed repeatedly with it fixed), but is noted here in
case it turns out to be a `lightweight-charts`/Chromium version interaction
worth a pinned-version bump later.
