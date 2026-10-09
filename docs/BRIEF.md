# Trading terminal: design brief

## The product

A web trading terminal for the NoirWire order book: spot and perpetual markets on a
Solana test network, with exchange-like speed. It will live at terminal.noirwire.com.

The order book is **private**. Resting orders, depth, balances and positions are hidden
from everyone but their owner. That is the product's reason to exist, and it is the
design problem: every trading terminal is built around a visible order book, and this
one has none to show.

## What exists to show

Public, live:

- Mark price per market (copied from real prices, updated about once a second).
- The tape: every fill's price, size and time. No names.
- Counters: orders placed, fills, volume, open interest, and measured speed (time from
  placing an order to its confirmation).
- Market settings.

Private, to the signed-in trader only:

- Their balances, positions, open orders, fills, profit and loss, margin.

Not available to anyone: depth, other people's orders.

## The user

Someone who has used Hyperliquid, Binance or a similar terminal. They arrive from a
link, on desktop first. They hold nothing. In under a minute they should: get a wallet
in the browser without installing anything, press one button to receive 5,000 test
dollars, and place a trade on one of two or three markets. Everything is test money on a
test network, and the screen says so wherever a number could be mistaken for real.

## What it must make someone feel

1. This is as fast as a centralised exchange. The measured number is on screen.
2. Nobody can see my orders. Shown, not claimed: for example a view of what a stranger
   sees when looking at this market on chain.
3. This is a serious venue, not a hackathon demo.

## Constraints

- Brand: the existing NoirWire look. Tokens and components to read:
  `../app-noirwire/src/app/globals.css`, `../app-noirwire/src/components`,
  `../landinpage-noirwire/src`. Its tokens win over any other palette.
- Stack: Next.js 16, React 19, Tailwind 4, TypeScript, as in `../app-noirwire`.
- Charts: TradingView Lightweight Charts (open source).
- Dense product UI. It is a tool, not a landing page.
- Desktop first; it must still work on a phone.
- No em dashes in any copy. Say what the user can do; never advertise what is missing.
- Every volume or speed figure is labelled as test network.

## Reference terminals

Hyperliquid, Binance, Bybit, Lighter, Pacifica, dYdX, Robinhood Legend, Bloomberg-style
density.
