# Contributing

## Before you open a pull request

Run all four. CI runs the same checks and a pull request does not merge until they pass.

```bash
make lint
make typecheck
make format-check
make test
```

`make format` fixes formatting. A change to a screen or to the market-data
or trading clients runs `make e2e` (Playwright, against a production build
talking to this repo's own mock of sim-noirwire). It is part of CI and
needs no network access and no dependency on sim-noirwire actually running.

## Commits

- Keep the subject under 50 characters.
- Start it with a conventional prefix: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `ci:` or `build:`.
- Write it in the imperative: `fix: drop a stale mark price tick`, not `fixed` or `fixes`.
- One change per commit. Explain why in the body when the reason is not obvious from the change.

## Tests

Every change comes with its tests. A new rule has a test for each branch; a fixed bug has a test that failed before the fix.

A test is held to three rules:

- Give each test one failure it uniquely catches; repeat across layers only where the boundary changes.
- Assert money, an observable decision, or an accessible role/label; never exact prose or an input echoed back.
- Use controlled clocks and injected sockets/fetches, not sleeps or real timers, outside the Playwright suite.

## Code

- Small modules with one job each, named in the product's words: witness rail, venue pulse, public view, order entry.
- No dead code and no commented-out code. Comment only where the reason is not obvious.
- Build what the change needs and nothing more. A new dependency needs a reason in the pull request, and must be on the project's approved list.
- Amounts cross the `TradingClient` interface as decimal strings; order math runs on `bigint` fixed-point (`src/lib/trading/decimal.ts`), never floating point.
- A number that could be mistaken for real money or a real venue carries its network label at the point it is shown, not just once at the top of the screen.

## Text people read

- No em dashes. Use a hyphen.
- Say plainly what happened and what to do next. Never advertise a missing feature; say what the trader can do.
- Every volume, balance or speed figure is labelled test network.

## Security issues

Do not open an issue or a pull request for a vulnerability. See [SECURITY.md](SECURITY.md).
