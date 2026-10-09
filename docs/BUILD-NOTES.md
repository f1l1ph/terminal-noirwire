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

## Rollup trading client (third pass)

`RollupTradingClient` (`src/lib/trading/rollupClient.ts`) implements the same
`TradingClient` interface as `DevTradingClient`, signing and sending every
order straight to the real on-chain order book via `@noirwire/orderbook`
(currently 0.3.0, vendored under `vendor/` - `make sdk-update` copies a
fresh release tarball from a sibling checkout). Every call into that
package is isolated in `src/lib/rollup/sdk.ts`, the one file that imports
it; everything else in `src/lib/rollup/` and `src/lib/trading/` sees the
plain types and wrapper functions that file re-exports, so a future package
upgrade is an edit to that one file (mirrors sim-noirwire's own
`src/rollup/program.ts` for the same reason).

**Keys.** The browser wallet's keypair (already in hand, no wallet-adapter
flow) is the owner key. The 32-byte order-key seed is
`sha256(nacl.sign.detached(domain-message, owner.secretKey))` -
deterministic, so the same owner secret always rebuilds the same order
keys, exactly as `keys.ts` states. Order-key recovery after a reload
prefers a saved `OrderKeyManager.checkpoint()` (`checkpointStore.ts`,
localStorage, keyed by owner address) over the full `fromView` search, and
is saved again after every confirmed keyed call.

**Sessions and sign-in refresh.** `session.ts`'s `buildRealSession` derives
the owner/seed, connects to the rollup's public RPC, and signs in to the
private endpoint immediately (before any send is attempted, not lazily on
first trade - the hosted devnet needs a signed-in token to accept a send,
not only to read privately). `RollupTradingClient.withSession` proactively
rebuilds the session once it is older than four minutes (the package
exposes no token TTL to read, so this is a conservative guess, not a
measured value) and, on any thrown error from a call, rebuilds once and
retries - this is how an actually-expired token recovers without the
client trying to recognise the exact shape of an auth error itself.

**Market id resolution.** `/v1/markets` names a market by string id and has
no on-chain numeric id (the dev-mode engine has none to report), so
`marketIds.ts` resolves it by scanning the program's `Market` accounts
(public, DESIGN.md section 2) for a base/quote/kind match, once per program
id, cached. The same scan incidentally yields a token-index -> symbol map
for spot wallet balances, built only from spot markets' own
`baseToken`/`quoteToken` - a perp market's own indices both name the
collateral token (its "base" is cash-settled, not a real spot holding), so
including them would corrupt the map.

**Units.** `units.ts` converts between this terminal's existing decimal
strings and the program's lots/atoms using only `market.lotSize` (already
served by `/v1/markets`), re-deriving the same ratio sim-noirwire's own
`src/rollup/units.ts` computes from the raw `baseLot` + token decimals -
confirmed by reading that file, not guessed. Spot wallet balances (raw
atoms at the token's own decimals, not 6) are converted via
`mintDecimals.ts`, which reads the `Exchange` account for each token's
mint and then that mint's own decimals (`@solana/spl-token`'s `getMint`) -
the one place this dependency is used.

**Outcome mapping.** `outcome.ts` maps every `RESULT_STATUS` code onto this
terminal's existing `OrderStatus` wire enum (filled / open / partiallyFilled
/ cancelled / rejected), so the witness rail needed no new step types.
0.3.0 made `placeOrder` throw `OrderInvalid` (refused before signing) and
`TransactionFailed` (landed and refused) instead of returning them as
outcomes; `thrownToResult` catches both in `RollupTradingClient.placeOrder`
and maps them to the same ordinary rejected state with a plain sentence,
so a pre-sign refusal and a book-dependent one look the same to the trader.
An order that never got a result before its expiry (`outcome: "expired"`)
maps to rejected, "not placed," which is also the right read for a
malformed instruction that the rollup silently never executes.
**Assumption, not confirmed against a real refusal:** `OrderResult.cancelled`
is read as a lot-size SIZE on a place-order result (the remainder that
didn't rest) and as an order COUNT on a cancel/cancel-all result - the one
field is shared across instruction kinds and neither document I read states
the dual meaning explicitly; it is the only internally-consistent reading
given the field's name either way.

**Timing.** 0.3.0's `Timing` (`sentAt`/`resultAt`, both `performance.now()`)
is carried onto `PlaceOrderResult` as `sentAtMs`/`resultAtMs`;
`useTrading.ts`'s `placeOrder` prefers `resultAtMs - clickedAt` over timing
the whole call from outside, which would also count this function's own
promise-resolution overhead.

**Own-fill recognition.** There is no venue-assigned tag in rollup mode,
only the 16-byte secret chosen per order. **Assumption, isolated in
`ownFills.ts`:** sim-noirwire's rollup-mode `/v1/tape` is assumed to reuse
`PublicFill`'s existing `takerTag`/`makerTag` string fields to carry the
on-chain receipt reinterpreted as a big-endian u64 decimal string (read
directly from that repository's `src/rollup/rollup-venue.ts`: `const tagOf
= (receipt) => Buffer.from(receipt).readBigUInt64BE(0)`, then `tagString`
on the route) rather than inventing new field names. `deriveRollupOwnFills`
recomputes both role receipts per known secret per tape fill and compares
against those fields directly - no client tag is ever sent or expected on
the wire. Known secrets persist per owner address in `secretStore.ts`,
capped at the most recent 20 (a simplification of "drop them when the order
is gone": this is eviction by count, not by tracking each order's precise
open/closed lifecycle).

**Open orders, one market at a time.** The trader's view carries open
orders for only the market the last trading instruction targeted
(`snapshot.marketId`), not every market at once the way dev mode's
`/v1/dev/trader` does. `TraderState.openOrders` is empty for every market
except the one last traded in rollup mode - a real, not yet worked around,
product difference from dev mode.

**Two balances, the transfer control, and "move funds to spot."**
`TraderState.collateral` (new, optional) carries the separate perpetuals
collateral account; `balances` stays the spot wallet. `OrderEntry` reads
`collateral` (not spot) as the available quote for a perp order (RULES.md
section 6: perps draw on collateral, never the spot balance) - this was a
real bug caught while wiring it in, not merely a missing feature.
`needsSpotTransfer` (`trading/spotTransfer.ts`, pure and unit-tested) decides
when a spot buy should offer "Move funds to spot" instead of a pointless
repeat of the one-time faucet grant or a submit that would just fail.
`TransferControl` is the compact amount+direction control, shown in the
account dock's Balances tab and, pre-filled, from that primary button.

**Per-order cancel and "Good for."** The real program has `cancel_order`
(per order, by sequence number), unlike dev mode's cancel-all-only; the
witness rail's cancel button becomes "Cancel order N" whenever
`TradingClient.cancelOrder` exists. A rollup limit order may carry its own
expiry (RULES.md section 4); `OrderEntry` offers "Good for: until cancelled
/ 1 minute / 1 hour" only when `supportsGoodFor` (rollup mode) is true.

**The "Public view" second check.** `PublicView` gained a second,
independent check in rollup mode (`TradingClient.checkPrivacy`, optional):
an unsigned read of this trader's own view account and the current
market's book account, straight from the rollup's public RPC, no sign-in -
the same connection any visitor's browser could open - reporting whether
each came back empty. A private account read by a non-member returning
nothing is the actual mechanism behind "nobody but the program can read
the book," not a restated claim about it.

**Daily funding limit.** sim-noirwire's rollup-mode `/v1/fund/submit` can
now refuse with "daily limit reached" (503, the venue's own cap on new
accounts per day, distinct from the per-IP rate limit sim-noirwire has
always had). `FundOutcome`'s `rateLimited` variant gained an optional
`message`, shown verbatim when the server gave one, so this reads as
itself rather than the generic "too many requests" copy.

**Config added:** `NEXT_PUBLIC_ROLLUP_RPC_URL`, `NEXT_PUBLIC_ROLLUP_WS_URL`,
`NEXT_PUBLIC_ROLLUP_PRIVATE_URL` (all required only in rollup mode),
`NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID` (optional, defaults to the package's own
constant). **Deliberately not added:** `NEXT_PUBLIC_SOLANA_RPC_URL` -
nothing in the trading path talks to base-layer Solana directly (open,
fund and every trading instruction are rollup-only), so it would be
configuration with no reader.

### Rollup config the service doesn't expose yet

Nothing publishes the rollup's own RPC/WS/private URLs or the program id
over HTTP (no `/v1/deployment` route), so these are plain env vars instead
of being read from the service, per the brief's own fallback. If sim-noirwire
ever adds one, the shape to ask for is exactly its own internal `Deployment`
type (`src/rollup/settings.ts`): `{ network, programId, gate, oracle,
faucet, tokens: [{ index, symbol, decimals, mint }], markets: [{ id,
symbol, kind, fundingTaskId? }] }`. That would also let `marketIds.ts`'s
on-chain scan and `mintDecimals.ts`'s per-mint `getMint` calls be replaced
with a single read, both a latency and a code-size win.

### Bundle size: a real, unresolved cost

Measured total `.next/static/chunks` size after a clean build:
**dev mode 1,676,143 bytes, rollup mode 1,676,066 bytes** - functionally
identical. That is not a clean build: `createTradingClient()` reads
`env.tradingMode` (a property of a Zod-parsed object), not the literal
`process.env.NEXT_PUBLIC_TRADING_MODE` expression Next.js's dead-code
elimination for `NEXT_PUBLIC_*` vars needs to see directly, so it cannot
prove the `rollup` branch is unreachable in a dev-mode build and bundles
`@noirwire/orderbook` plus `@magicblock-labs/ephemeral-rollups-sdk` into
every build regardless of mode. The fix is to load whichever
`TradingClient` implementation is needed via a dynamic `import()` in
`trading/index.ts` instead of a static one, which would code-split the
rollup bundle out of a dev-only deployment; not done here, since
`createTradingClient()` is called synchronously today and making it async
touches `useTrading.ts`'s initialisation path too, which felt like the
wrong thing to rush at the end of this pass.

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
