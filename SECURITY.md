# Security

This terminal generates and holds a test wallet's secret key in the
browser, and places orders against a test network. If you find a way to
read another trader's private state, forge an own-fill match on the tape, or
make the terminal claim a speed or privacy guarantee it does not actually
provide, please tell us privately before telling anyone else.

## Reporting a vulnerability

Email **ph1l1ph@proton.me**.

Include what you found, how to reproduce it, and what an attacker gains. A
proof of concept helps. Please do not open a public issue, and do not test
against a wallet or funds that are not yours. Everything here is test
money on a test network, so there is no real-money impact, but the same
rule applies: report privately.

You will get an acknowledgement, and we will keep you informed while we work
on a fix. We will credit you when the fix ships unless you would rather we
did not.

## What matters most

- Anything that exposes another browser's test wallet secret, or moves it
  off the device it was created on.
- Anything that lets a fill on the public tape be falsely attributed to, or
  withheld from, this browser's own orders.
- Anything that submits an order the trader did not actually confirm, or
  that duplicates an order on a retry.
- Anything that bypasses the Content-Security-Policy to reach a host other
  than the configured simulation service from the browser.
- Anything that makes the venue-wide speed or privacy figures shown
  (`VenuePulse`, `PublicView`) misrepresent what the simulation service
  actually measured or returned.

## Scope

This repository is the NoirWire trading terminal: a Next.js client where the
test wallet's keypair is generated, held and used, and a thin proxy
(`src/proxy.ts`) that only sets the page's Content-Security-Policy nonce. It
holds no provider key and talks to nothing but the configured simulation
service. This code has not been audited.

The simulation service (sim-noirwire) and the shared NoirWire app have their
own `SECURITY.md`.
