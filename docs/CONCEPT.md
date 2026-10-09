# NoirWire Terminal: the witness rail

## 1. One idea

**Trade in two views at once.** The center of the terminal is a shared market chart and anonymous tape. Beside it, the **witness rail** tracks only _your_ instruction, confirmation, resting time, and fills. A small switch on that rail opens the same market as an unsigned observer sees it. The seam between public evidence and private account state is the product's visual identity. It makes a private order book feel deliberate, rather than like a familiar terminal with its ladder removed.

The rail answers the questions a depth ladder normally prompts: What is the market doing? What did I ask it to do? Did the venue accept it? How much filled? At what price, and when? It never draws a plausible looking depth curve from fills, predicts queue position, or suggests that public tape prints reveal another person's resting order. Public fill prices and sizes can still reveal activity. Privacy here means another trader cannot inspect resting orders, balances, or positions through the public venue view; it does not mean fills are invisible or that all identity links are impossible.

## 2. Screen architecture

At 1440 CSS pixels, allow 16 px outer gutters and 8 px internal gutters. The working grid is 220 / 604 / 260 / 300 px. Keep the chart and order entry visible without scrolling at a typical 900 px tall desktop viewport. The positions table may scroll internally. Resizing can first shrink the chart; do not shrink order entry below 280 px. No decorative hero or oversized KPI cards.

```text
1440 px desktop
+--------------------------------------------------------------------------------------------------------------+
| NoirWire mark | Markets | Activity                    TEST NETWORK | feed state | wallet / Create test wallet |
+--------------------------------------------------------------------------------------------------------------+
| MARKET SWITCHER 220 | MARKET HEADER 604: symbol, mark, age | VENUE PULSE 260 | ORDER ENTRY 300            |
| 2 or 3 rows         | chart period, settings          | p50/p95, sample | wallet and test funds      |
| search only if > 3  +---------------------------------+--------------+----------------------------+
| markets             | PRICE CHART 604                  | WITNESS RAIL 260             | SPOT / PERPS               |
| symbol              | Lightweight Charts             | Your order timeline          | buy/sell or long/short     |
| mark and age        | mark line, public fills as      | submit, confirm, rest,       | order type and all fields  |
| 24h context if      | unlinked event ticks           | partial, fill               | estimated cost / risk      |
| available           | stale overlay when needed      | Public view toggle           | primary submit button      |
|                     +---------------------------------+------------------------------+----------------------------+
|                     | PUBLIC TAPE: time, side if public, price, size | PUBLIC VIEW: unsigned snapshot / source |
|                     | no identity, no inferred order linkage        | what is visible, what is private        |
+---------------------+-------------------------------------------------+----------------------------------------+
| ACCOUNT DOCK: Positions | Open orders | Fills | Balances | Margin; selected tab shows private rows             |
+--------------------------------------------------------------------------------------------------------------+
| STATUS BAR: selected market settings | TEST NETWORK | last data time | connection | measured confirmation window |
+--------------------------------------------------------------------------------------------------------------+
```

The public view panel can collapse into a labelled tab below the witness rail after the first visit. Never collapse the order state itself. The tape is below the chart because its numbers are evidence, not a synthetic execution surface. The side column gives venue health and personal execution history the visual weight normally granted to depth.

Phone, 360 to 430 CSS pixels: one column, no horizontal page scroll. A persistent 52 px market bar carries symbol, mark, age, and `TEST NETWORK`. A two item segmented control selects `Trade` or `Market`. `Trade` shows the order entry first, then the current witness rail, then account tabs. `Market` shows chart, public tape, venue pulse, and `Public view`. A fixed bottom `Review buy` or `Review sell` action appears only while the order entry is valid; the actual submit action remains inside the review sheet. There is no squeezed four column grid. Market and account state stay available with one tap, and a resting order stays visible in a compact rail above the phone tabs.

## 3. The order book replacement

**Use the witness rail, backed by the public tape and a public view.** Its top row shows the latest mark and timestamp, with `Indicative mark, not a quote`. Beneath it, a vertical sequence shows `Submitted`, `Confirmed`, `Resting`, `Partially filled`, `Filled` or a precise failure. Each step has a timestamp and source. A fill row shows own execution price, quantity, fee if available, and order ID. The public tape alongside it shows _all_ fills without highlighting a purported match to the user's order unless a venue receipt explicitly establishes that relation. Before the first order, the rail teaches the distinction: `Your orders appear here. Public fills appear in the tape.`

Rejected alternative A: a heatmap or liquidity cloud inferred from prints. Trades are not resting liquidity. It would suggest knowledge the venue does not expose and could encourage bad size decisions.

Rejected alternative B: a private depth ladder containing only the trader's orders. A single sided ladder looks empty, implies price priority and queue position, and uses a lot of space to repeat the open orders table. The rail makes state and elapsed time legible instead.

There is no displayed spread, best bid or ask, impact estimate, fill probability, queue rank, or executable quote unless a separately specified, verifiable venue endpoint supplies it. The market order review says the mark is indicative and the execution price may differ. A protective price limit is mandatory if the venue supports protected market orders; otherwise offer limit orders only until the execution bound exists.

## 4. Speed as a measured fact

`TEST NETWORK · Confirmation p50 0.42 s · p95 0.91 s · 184 orders · last 15 min` is the format, not a target value or prewritten claim. Define **confirmation** as the first authoritative venue response that an order is accepted or rejected, not a fill and not a UI animation. Capture receipt time at server ingress and authoritative confirmation with a monotonic clock or one trace clock. Aggregate accepted and rejected orders together for placement to confirmation; disclose the definition in `How measured`. Show sample size, rolling window, last updated time, and p50/p95. If sample size is below the displayed threshold of 20, show `Insufficient samples` with the actual count. If measurement is stale, show `Measurement unavailable` and the last valid time. Never retain a green fast label over stale data.

For an individual order, the rail can show `Click to confirmation: 0.56 s · this device · TEST NETWORK`, measured with a monotonic client clock from submit click to authoritative acknowledgement. This is a different metric from venue p50. Show both labels explicitly. `Submit to fill` is a separate measurement and only appears when a fill occurs. Record timestamps and trace IDs in the receipt detail so a user can inspect the number. If the connection drops before the outcome is known, show `Checking order status`, never a fabricated rejection or retry that could duplicate the trade.

## 5. Privacy as inspectable evidence

The `Public view` button fetches the selected market through the same unauthenticated endpoint available to any visitor, in a request without the wallet credential or account ID. Present a side by side schema: `Public: mark, anonymous fills, aggregate counters, market settings` and `Only you: balances, positions, open orders, margin, own fills`. Show the public request URL, response time, snapshot time or slot, and `View raw response`. Link to the relevant public chain record only when there is an actual record and a stable explorer URL. The raw payload must be fetched independently, not composed from the signed-in private state and then masked. Repeat the check after placing a resting limit order: the private rail gains that order while a fresh unsigned snapshot does not gain an order row. Label this `Checked at [time]`, with a `Check again` button.

This is a test of what the public endpoint and linked records reveal at that time, not a proof against every chain, network, or operator correlation path. If an unsigned fetch, source link, or data provenance is unavailable, say `Public evidence unavailable` and remove any proof badge. Never use an eye icon alone as proof or claim anonymity, encryption, or invisible fills.

## 6. First minute, screen by screen

All balances, prices, notional, P&L, and counters in this flow carry a visible `TEST NETWORK` context at their point of use. The account starts with no funds. An inline first run strip belongs inside the terminal, not on a separate marketing page.

1. **Arrival, 0 to 5 seconds.** Market chart, pulse, public tape, and public view load without a wallet. Order entry is visible but disabled. Top strip: `Trade with test funds on a test network.` Primary button: `Create test wallet`. Secondary button: `View public market`. The landing link should read `Open test terminal`.
2. **Local wallet, 5 to 15 seconds.** On `Create test wallet`, create a browser wallet and show its short address plus `Stored on this device`. If creation fails, show `Wallet not created` and `Try again`. Explain recovery in one sentence and offer `Save recovery details` before the faucet; do not imply a disposable browser wallet is recoverable. The primary path remains one screen.
3. **Test funding, 15 to 25 seconds.** Order entry displays `Available: 0.00 test USD` and one button: `Get 5,000 test USD`. It submits once, disables during the request, and shows `Funding requested` until balance confirms. If funding is rate limited or fails, show the exact reason and `Try funding again` only when safe. Do not prefill a fake balance.
4. **Choose and review, 25 to 45 seconds.** Default to the first liquid configured market, spot `Buy`, `Market` only if a protected market order is supported, and a small editable quantity. The trader sees indicative mark age, estimated maximum spend at the protection price, fees from market settings, and `Execution price may differ`. The primary button reads `Review buy`; the review sheet repeats market, side, quantity, order type, protection price, maximum spend, fee, and `TEST NETWORK`. Final button: `Place test buy`.
5. **Submit and first fill, 45 to 60 seconds if the venue fills.** The sheet closes into the witness rail: `Submitting`, then `Confirmed`, then `Filled` with own price, quantity, fee, elapsed times, and `View receipt`. If it rests or only partly fills, show that truth and keep `Cancel order` available. Never promise a fill under a minute; the one minute goal is an interaction target, contingent on market conditions and network health.

## 7. Order entry specification

Shared fields in the persistent panel: market selector (symbol and test network), mode `Spot` / `Perps` if supported for that market, side, order type `Market` / `Limit` as enabled by settings, available test balance, live mark with age, quantity unit, fee schedule, estimate timestamp, and review action. Input precision, minimum, maximum, tick, and step come from market settings. A blank or stale market setting disables review. The final review sheet is mandatory for both modes. Never use a price fetched about once a second as a guaranteed execution quote.

**Spot fields:** `Buy` / `Sell`; `Market` / `Limit`; quantity in base units with a `Use test USD` or `Use asset` denomination toggle where conversion is supported; quantity input; `Max` shortcut bounded by balance and fee; limit price for limit orders; price protection bound for market orders if offered by the venue; time in force for limit orders, limited to server supported values; `Post only` for eligible limit orders; estimated maximum test USD spend for buys or estimated minimum test USD proceeds when enforceable for sells; estimated fee; available balance; remaining balance estimate. Show `Estimate unavailable` where a bound cannot be calculated. Do not submit market orders without the protective execution bound described above. Spot sell requires an owned balance.

**Perps fields:** `Long` / `Short`; `Market` / `Limit`; contract quantity and unit; limit price when applicable; protective price bound for market orders; leverage control with the exact allowed range from market settings; margin mode selector only for modes actually supported, with the chosen mode named; collateral amount and available test collateral; estimated notional, initial margin, maintenance margin, fee, funding rate with timestamp if supplied, mark and age, estimated liquidation price from the risk engine, and position impact; time in force for supported limit orders; `Post only` for eligible limit orders; `Reduce only` for an existing position with a valid reducible size. `Take profit` and `Stop loss` are omitted until supported as real conditional orders. If risk inputs or the engine's liquidation estimate are unavailable, disable review for an opening order and state which input is missing. The review sheet repeats leverage, mode, collateral, risk values, and maximum loss warning in plain text. Closing a position never defaults to adding exposure.

Every input has a visible unit, validation below the field, keyboard access, and a stable label. Buttons name the action: `Review buy`, `Review sell`, `Review long`, `Review short`, then `Place test buy`, `Place test sell`, `Place test long`, or `Place test short`. Disable only for a named reason. Cancelling a resting order is a separate action with its own pending and confirmed state.

## 8. States and exact surface behaviour

| State            | What the user sees                                                                                                                                                                                                                         | Allowed action                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Empty            | Public chart and tape use honest `No fills yet` and timestamped mark or `Mark unavailable`. Witness rail says `Your orders appear here.` Account dock says `Create a test wallet to see your account.`                                     | `Create test wallet`, `View public market`                        |
| Loading          | Skeleton dimensions hold the layout; text says `Loading market` or `Checking order status`. Existing known values show their old timestamp, never a fresh live dot.                                                                        | `Retry` only after a failed read; block duplicate submit          |
| No funds         | `Available: 0.00 test USD`; order review is disabled with `Get test funds to trade.`                                                                                                                                                       | `Get 5,000 test USD`                                              |
| Order resting    | Rail shows accepted limit price, remaining quantity, placed time, order ID, and elapsed rest time. Own open orders row agrees.                                                                                                             | `Cancel order`; acknowledge cancellation separately               |
| Partial fill     | Rail shows filled / original / remaining quantity, each own fill price and fee, and weighted average execution price. Open order remains active.                                                                                           | `Cancel remaining` when permitted                                 |
| Filled           | Rail closes the timeline with confirmed quantity, execution price or weighted average, fee, and receipt link. Balance and position refresh have distinct pending labels.                                                                   | `View receipt`, place another order                               |
| Rejected         | Rail shows `Rejected`, venue reason code translated to plain language, original input, and whether funds were reserved or released. Never imply a fill.                                                                                    | `Edit order`; `Try again` only after definitive rejection         |
| Liquidation risk | Persistent warning beside position and perps order entry: current margin ratio, maintenance threshold, timestamp, and `TEST NETWORK`. At or beyond engine threshold, block exposure increasing orders and show the allowed reduction path. | `Reduce position` if venue permits; otherwise `View risk details` |
| Network down     | Global status changes to `Connection lost`; chart and tape freeze with last updated time. Order outcome stays `Unknown, checking` if submit was in flight.                                                                                 | `Reconnect`; no fresh order submission until state reconciles     |

If an order has an unknown outcome, reconcile by client order ID against the authoritative venue before enabling another submit of that intent. A timeout is not a rejection. A recovered connection must refresh balances, open orders, fills, positions, market settings, and mark before showing live status.

## 9. Visual language and data formatting

Use the app's terminal facing tokens as the source: base `#0b0b0c`, surface `#131315`, raised `#18181b`, elevated `#1c1c1f`, ink `#e8e6e1`, strong ink `#f5f3ee`, dim `#b4b1aa`, faint `#8d8b86`, lines `#272a2d` / `#36393c` / `#515458`, safe `#75bc97`, warning `#d1ad70`, danger `#f18d80`. The landing source is a slightly warmer charcoal and ivory variant; its raven and wordmark rules still apply. Use the supplied one colour mark on a plain background. Safe is for a confirmed success, warning for stale or risk, danger for rejection and critical risk. Buy and sell controls use ivory as the action colour and words for direction; green and red must not carry direction alone. Do not add a trading neon palette.

Use Figtree throughout, 13 to 14 px for dense rows, 11 to 12 px for labels, 16 to 20 px for panel titles, and a restrained 28 px market price. Use tabular numerals and right aligned numeric columns. Keep 44 px touch targets on phone. Dividers provide structure, with 8 px tiles and 12 px panels from the tokens. No stacked cards inside cards. The chart has a thin ivory line and quiet event ticks, with no decorative gradient or invented depth.

Mark updates can crossfade in 120 ms; do not slide digits enough to obscure a changed value. Rail state transitions can highlight once for 180 ms. No blinking trade tape, particle fills, autoplay sound, chart wipe on every price update, or continuous pulsing latency badge. Respect reduced motion by removing transitions. Live freshness is conveyed in text even without motion. Focus states use a clear ink outline; live updates announce only order state changes to assistive technology, not every tick.

Use a consistent market supplied decimal precision. Group thousands with commas, align decimal places within a numeric column, and preserve trailing zeros where they express the market tick. Show `<0.01` only for a nonzero amount below display precision, never as `0.00`. Quantity uses the contract or asset unit. Test money uses `test USD` or the configured test collateral symbol, never a bare dollar sign. Display `TEST NETWORK` locally beside every volume and speed figure, including tooltips and receipts. Times use local `HH:mm:ss.SSS` for order events, date on older rows, and relative age only as a secondary label. Durations use `ms` below 1 s and `s` above; never show more precision than the measurement supports. Stale and unavailable values use an em dash free `Unavailable` label rather than zero.

## 10. Buildable component inventory

Types below describe display contracts. Data services supply authoritative market, account, measurement, and provenance values. Components do not infer hidden depth or risk data.

| Component          | Essential props                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `TerminalShell`    | `networkLabel`, `connectionState`, `walletState`, `selectedMarketId`, `onSelectMarket`                                                      |
| `MarketSwitcher`   | `markets: MarketSummary[]`, `selectedId`, `onSelect`, `markAges`                                                                            |
| `MarketHeader`     | `symbol`, `mark`, `markUpdatedAt`, `settingsStatus`, `onOpenSettings`                                                                       |
| `MarketChart`      | `markSeries`, `publicFillTicks`, `interval`, `stale`, `onIntervalChange`; implement with Lightweight Charts                                 |
| `VenuePulse`       | `p50Ms`, `p95Ms`, `sampleCount`, `windowStart`, `windowEnd`, `updatedAt`, `measurementDefinition`, `status`                                 |
| `PublicTape`       | `fills: PublicFill[]`, `updatedAt`, `connectionState`, `onLoadMore`; rows carry no account identity                                         |
| `WitnessRail`      | `order: OwnOrder                                                                                                                            | null`, `events: OwnOrderEvent[]`, `clientDurationMs`, `status`, `onCancel`, `onOpenReceipt` |
| `PublicView`       | `snapshot: UnsignedSnapshot                                                                                                                 | null`, `requestUrl`, `fetchedAt`, `sourceLink`, `status`, `onRefresh`, `onOpenRaw`          |
| `OrderEntry`       | `marketSettings`, `mode`, `side`, `orderType`, `balances`, `position`, `mark`, `riskEstimate`, `form`, `validation`, `onChange`, `onReview` |
| `OrderReview`      | `normalizedOrder`, `estimate`, `markAge`, `riskEstimate`, `pending`, `onSubmit`, `onBack`                                                   |
| `AccountDock`      | `activeTab`, `balances`, `positions`, `openOrders`, `fills`, `margin`, `loadingByTab`, `onTabChange`                                        |
| `OrderReceipt`     | `orderId`, `clientOrderId`, `eventTimes`, `ownFills`, `fees`, `measurementTraceId`, `sourceLinks`                                           |
| `ConnectionStatus` | `state`, `lastHealthyAt`, `pendingOrderIds`, `onReconnect`                                                                                  |
| `FirstRunStrip`    | `walletState`, `fundingState`, `onCreateWallet`, `onSaveRecovery`, `onRequestFunds`                                                         |

`MarketSummary` includes market ID, symbol, mark, mark timestamp, and test network label. `OwnOrderEvent` includes type, authoritative timestamp, source, and any fill ID. `UnsignedSnapshot` includes the raw public response or a URL to it, fetch metadata, and a schema summary. `riskEstimate` is a server derived value with its calculation timestamp and status, never a UI constant. Order submission uses a persisted client order ID for reconciliation. Market settings are the source of enabled order types, precision, fees, limits, margin modes, and risk parameters. Unknown and stale are first class values in every data prop.

## 11. Three day build boundary

**Cut:** cross market search for only two or three markets; custom chart indicators; resizable panels; advanced hotkeys; saved layouts; P&L charts; chart drawing tools; TP/SL until supported; animated onboarding; a full historical latency explorer; explorer deep links when no trustworthy record exists. On phone, one chart interval and the two `Trade` / `Market` views are enough. If perps engine and risk data are not ready, show a disabled `Perps` tab with a factual availability reason rather than a plausible form.

**Must keep:** accurate test network labels at every financial and speed number; wallet creation and one request for 5,000 test USD; market settings driven validation; an order review with price protection or limit only; idempotent submission and unknown outcome reconciliation; real own order states and cancel path; clear public tape versus private rail; independently fetched unsigned public view with provenance or explicit evidence unavailable; authoritative p50/p95 with sample/window or explicit measurement unavailable; stale mark, risk, and connection states; accessible phone order entry. These are the mechanics that let the interface make its speed and privacy claims honestly.
