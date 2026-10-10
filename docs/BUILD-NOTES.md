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

**Superseded by the fourth pass** (see below): sim-noirwire's rollup mode
now serves `GET /v1/deployment`, and this terminal reads it instead of env
vars or an on-chain scan. Kept for history; do not add back the scan
modules this section used to call for.

### Bundle size: a real, unresolved cost

**Resolved in the fourth pass** (see below): `createTradingClient()` now
returns a `LazyRollupTradingClient` that imports the real client (and so
`@noirwire/orderbook`) only when a method is actually called, which in
practice means only after a wallet is created. Current measured numbers are
in the fourth-pass section and in the README's "Bundle size" section.

## Fourth pass: the real local stack

The first three passes built and tested the rollup trading client only
against fakes (a scripted mock of sim-noirwire's routes, or reasoning from
reading sim-noirwire's and the order book's source). This pass ran the
first-minute flow in a real browser, via Playwright, against the real local
three-part network (solana-test-validator, the ephemeral rollup, the query
filter) and a real sim-noirwire in `VENUE=rollup` mode - and fixed what
broke. Every fix below is in this repository; **no sim-noirwire source was
changed** (one local, non-committed runtime choice is noted at the end).

**Deployment-based config replaces env vars and on-chain scanning.**
`src/lib/rollup/deployment.ts` fetches sim-noirwire's `GET /v1/deployment`
once per `simUrl` (Zod-validated, cached): network, program id, the rollup's
RPC/WS URL, the exchange account, and every market's id/symbol/tokens
(mint, decimals)/lot/tick. This replaced two modules outright, both
deleted: `marketIds.ts` (used to resolve a market's numeric id by scanning
every on-chain `Market` account for a base/quote/kind match) and
`mintDecimals.ts` (used to read each spot token's decimals via
`@solana/spl-token`'s `getMint`, one on-chain read per mint). `@solana/spl-token`
is consequently no longer a dependency. `session.ts`'s `resolveTokenIndices`
now does the one read a trader's session still needs (the Exchange account,
to map each market's token mints onto `Seat.spot[]`'s index) by matching
against `/v1/deployment`'s own token descriptions, not a fresh scan.

**Sending a transaction needs the signed-in token too, not only private
reads.** Confirmed by hand: constructing `TraderClient` with a plain,
unsigned `Connection` as the sending connection fails every send with 401
"Missing token query param," even though the design doc frames sign-in as
being about private reads. `buildRealSession` (`session.ts`) now uses the
one signed-in `reader` connection for both the sending and the private-read
role; the separate unsigned `anonymous` connection exists only for the
Exchange account read, which is genuinely public.

**`deposit` does not update the trader's view; `fund()` now syncs it
explicitly.** Verified with a standalone script calling the SDK directly:
after a successful `open_trader` + `deposit` (sim-noirwire's fund flow),
`view().snapshot.seat.collateral` stayed zero. The `deposit` instruction's
account list never includes the `TraderView` account - only an order-key-signed
instruction (`place_order`, `cancel_order`, `cancel_all`, `sync_view`,
`transfer_between_balances`) re-copies the seat into the view as a side
effect. `RollupTradingClient.fund()` now calls `client.syncView(marketId)`
right after a grant and saves the resulting key checkpoint, so the balance
shows up without the trader placing an order first.

**The outer price band is real and narrower than dev mode's.** A resting
limit order priced far from the mark (e.g. "1.00" against a ~109 mark)
is refused by the real program - RULES.md section 3's 50% outer band,
which the dev-mode fake engine does not enforce. Not a terminal bug; the
rollup e2e spec prices its resting-order step close to the mark instead
(the exact price does not matter functionally, only that it is within the
band and unlikely to fill in a short test window).

**Witness-rail "filled" step and fill tracking, both masked by dev mode.**
Two separate bugs, both invisible against the dev-mode fake engine because
its behaviour happens to paper over them: (1) the rail's "filled" branch
required a truthy `trackedOrderId` as well as a non-empty fill list, but a
fully (not partially) filled market order legitimately returns an empty
order id - fixed by dropping that condition, keeping only the fill-list
check. (2) `RollupTradingClient.placeOrder()` returned `tag: ""` (there is
no venue tag in rollup mode), but the rail's fill-tracking treats an empty
tag as "nothing to track." Fixed by returning the order's own secret as
`tag` (hex-encoded, the same string `ownFills.ts` already produces for a
matched fill), reusing the existing tag-based plumbing instead of adding a
mode-specific path.

**Own-fill ("yours") marking needed a mode-agnostic signal.** `PublicTape`
and `MarketChart` matched fills by tag (`ownTags`/`isOwnFill`), which works
in dev mode (the venue echoes a client-chosen tag) but cannot work in
rollup mode once `placeOrder` returns the order's _secret_ as its tag (the
fix above) - a secret can never equal a fill's receipt-derived
`takerTag`/`makerTag`. Both components now take `ownSequences: ReadonlySet<number>`
instead; `Terminal.tsx` computes it from `ownFillsForMarket` (already
correct per mode - `deriveOwnFills` for dev, `deriveRollupOwnFills` for
rollup) via each fill's `sequence`, which means the same thing in both
modes. Verified before and after a reload.

**Transfer direction defaulted to the wrong account.** `TransferControl`'s
initial direction was `prefillAmount ? "toSpot" : "toCollateral"`; the
"Move funds to spot" shortcut (from the order entry panel) opens the
control via `initiallyOpen`, not `prefillAmount`, when no quantity is
typed yet - so it silently defaulted to debiting the (empty) spot balance
instead of collateral, and the real program refused it
(`InsufficientBalance`, on-chain error code 6022). Fixed by also checking
`initiallyOpen` in the default.

**A WebSocket reconnect storm, from an unstable `useMemo` dependency.**
`Terminal.tsx`'s inline `marketSettings` lookup was recreated every render;
combined with `useNow()`'s one-second tick, the `useMemo` that builds the
trading client (and, in rollup mode, signs in and opens a session
WebSocket) was rebuilding every second, faster than old connections could
close, until the browser refused new sockets ("Insufficient resources").
Fixed by wrapping `marketSettings` in `useCallback`.

**Order entry now fits at 1280x800 for a market order, without internal
scroll.** It did not, once a real perp order with the leverage slider and
full cost breakdown was on screen - the panel clipped below "Remaining
available" and the submit button was unreachable. Compacted without
dropping any information: `OrderSummary` is a single tight column with
shorter labels (`Notional`/`Fee`/`Margin`/`Liquidation (est.)`/`Remaining`,
previously longer and each on a bigger row); the leverage caption and the
quantity hint moved inline (the former into a `title` tooltip, the latter
next to the "Available" line); gaps and padding across the panel went from
`gap-1.5 p-2` to `gap-0.5 p-1.5`. No information was removed, only
re-packed.

**Measured click-to-result, 30 market orders, local stack:** median 33 ms,
p95 50 ms (min 26 ms, max 150 ms - the first order after funding, plausibly
a cold-start cost). This is local-network latency (loopback to
solana-test-validator / the ephemeral rollup / the query filter on the same
machine), not a production figure.

**Bundle size, measured against a production build** (`npx next build && npx next start`,
counting every script byte the browser actually requests, not just
`.next/static/chunks` on disk): dev mode loads ~1.53 MB on arrival and never
loads more. Rollup mode loads the same ~1.53 MB on arrival, then a separate
~16 KB (two small chunks) only once a wallet is created - the point at
which `LazyRollupTradingClient` resolves its dynamic `import("./rollupClient")`.
This finishes what the third pass's "unresolved cost" note flagged: no
`createTradingClient()` async-initialisation change was actually needed in
the end, because the laziness lives one level down, inside the
`TradingClient` implementation itself (`rollupClientLazy.ts`), so
`useTrading.ts`'s synchronous call to `createTradingClient()` did not need
to change at all.

**Local-only runtime choice, not a repository change:** sim-noirwire's
per-IP fund rate limit (`FUND_IP_RATE_LIMIT`, default low) was hit during
rapid automated testing and raised in a scratch env file used only to start
the local test instance - never in the repo's own `.env`/`.env.example`,
and not a code change in either repository.

**What would help from the order book repository, if anything:** nothing
required. Two n8n-adjacent asides, mentioned in case they are easy
elsewhere: there is no on-chain error-code-to-name endpoint or exported
map, so the real on-chain refusal above was decoded by hand from
`programs/noirwire-orderbook/src/errors.rs` (wire code `6000 + N`); and
`openOrders` in rollup mode is scoped to one market, the one last traded
(noted in the third pass, still true) - worth keeping in mind if a future
pass wants "open orders across every market" without a per-market refetch.

## Seventh pass: live on Solana devnet

Switched to `@noirwire/orderbook` 0.4.0 - a clean drop-in for everything this
terminal calls (`make check`/`make test` green with no source changes beyond
the vendored file and `package.json`); 0.4.0's only other differences (token
registration, `custodyVisibility` on a deployment token) are either not
called here or absent from this service's actual `/v1/deployment` response,
and the zod schema already ignores fields it does not declare, so nothing
needed adding speculatively.

**CORS found the hard way.** The devnet-pointed sim-noirwire's own
`ALLOWED_ORIGINS` did not include a freshly-chosen port (3103); every REST
fetch (`/v1/deployment`, `/v1/candles`) failed with no
`Access-Control-Allow-Origin` header, while the **websocket stream kept
delivering live data regardless** - which looked like a partial success
(the tape showed one row, the pulse showed real numbers) rather than the
CORS failure it was, until `curl -H "Origin: ..."` against a few candidate
ports confirmed 3100 was already allowed and 3103 was not. `make e2e-devnet`
defaults to 3100 for exactly this reason - see the README's "Running against
devnet" for the check to run before ever changing it.

**Devnet-specific UX, verified by hand against the real deployment:**

- **"Confirming on chain…"** replaces "Available: 0.00 nUSD" between a
  funding grant landing and this device's own first read of the resulting
  balance actually showing it (`OrderEntry.tsx`'s `confirmingFund`, cleared
  the moment a real balance appears or after 15s) - a brand-new account's
  own first read can lag its own grant transaction by several seconds on a
  real network. Scoped to rollup mode only (`collateral !== undefined`):
  dev mode has no such lag, and the wording would be false there.
- **A stale-price refusal is a plain sentence**, not a generic "refused by
  the venue" one: `RESULT_STATUS_CODE.refused` with program error code 38
  (`StalePrice`, `errors.rs`) now reads "The venue's mark price is too old
  to accept new orders right now." `STALE_MARK_MS` (10s) already matched
  the program's own threshold from an earlier pass; this pass only adds the
  human sentence for when the client's own check and the venue's disagree
  at the boundary.
- **No "local" qualifier on a real network's own number.** The per-order
  "This order · click to result Nms" line now omits the network word
  entirely outside `isLocalNetwork` (devnet reads "This order · click to
  result 1.27 s", never "devnet click to result"), since a real number
  needs no disclaimer the way a loopback one does.
- **"Sending" is instant**: `OrderEntry`'s `submitting` state was already
  set synchronously before the `await`, confirmed by hand this pass (the
  button read "Submitting…" within tens of milliseconds of the confirm
  dialog's own click, verified with a timestamped screenshot check) - no
  code change was needed here, only verification against real latency.
- No "unknown" outcome was observed across roughly 25 real orders this
  pass; the pending/unknown UI from the fifth and sixth passes was not
  re-exercised live, only by its existing unit tests.

**Measured, this device's connection, Europe to the public devnet
endpoint** (`https://devnet-tee.magicblock.app`), 20 market orders: median
**1.35 s**, p95 **2.85-2.9 s**, worst **2.88 s**, best **1.00 s** (the
terminal's own "click to result" figures, not a wall-clock proxy). Noisier
and almost an order of magnitude slower than the local stack's 30-50 ms
(fourth pass) - expected: a real network round trip plus confirmation, not
loopback.

**Wallet persistence** (`e2e/support/devnetWallet.ts`,
`e2e/.devnet-wallet.json`, git-ignored): one wallet created once this pass,
reused for the entire 20-order measurement, the formal `make e2e-devnet`
run (both desktop and phone), and every manual check - exactly one new
wallet for the whole pass, well under the three-wallet budget. The
persisted-secret pattern seeds `localStorage` via `page.addInitScript`
before the page's own script runs, using the exact key
`src/lib/wallet/index.ts` reads (`noirwire-terminal-wallet-secret`) - a
test-only mechanism, not a product code change.

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
