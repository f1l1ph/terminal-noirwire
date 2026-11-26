# Analytics events

Every event this terminal sends, and the values it may carry. The source of
truth is `EVENT_SCHEMA` in `src/lib/analytics.ts`; this file is the reading
guide.

## Privacy rule

Event data only ever carries keys from a fixed schema, and each key takes a
value from a closed list. An unknown key is dropped and an unknown value is
sent as `other`. Every event also carries `v`: the first 7 characters of the
deployed commit, or `dev` when there is none. Never sent: an address, amount,
size, price, URL, invite code or error text. Failure reasons are mapped from
error class names, wallet rejection codes and HTTP status
(`src/lib/failureReason.ts`). The one exception is wallet decline wording,
read through `isWalletDecline`, because several wallets reject without code 4001.

## Events

"Once per page load" means a reload counts again, and a visitor who returns
with steps already done counts those steps again on each load.

| Event                   | When it fires                                                                                                                                                                                      | Data and allowed values                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallet_connected`      | Setup step `connect` is done. Once per page load.                                                                                                                                                  | none                                                                                                                                                                                                                                                                         |
| `wallet_verified`       | Setup step `verify` is done. Once per page load.                                                                                                                                                   | none                                                                                                                                                                                                                                                                         |
| `account_opened`        | Setup step `open` is done. Once per page load.                                                                                                                                                     | none                                                                                                                                                                                                                                                                         |
| `keys_ready`            | Setup step `keys` is done. Once per page load.                                                                                                                                                     | none                                                                                                                                                                                                                                                                         |
| `account_funded`        | Setup step `deposit` is done. Once per page load.                                                                                                                                                  | none                                                                                                                                                                                                                                                                         |
| `invite_asked`          | The open step asks for an invite code. Once per page load.                                                                                                                                         | none                                                                                                                                                                                                                                                                         |
| `account_open_result`   | Each new answer to an open-account request, counted once per answer.                                                                                                                               | `result`: `opened`, `alreadyOpen`, `refused`, `notSent`, `notAvailable`                                                                                                                                                                                                      |
| `deposit_submitted`     | A deposit is submitted, before the storage check.                                                                                                                                                  | none                                                                                                                                                                                                                                                                         |
| `deposit_result`        | A deposit ends, by outcome or by a thrown error.                                                                                                                                                   | `result`: `done`, `refused`, `busy`, `waiting`, `not-landed`, `unknown`, `stranded`, `storage_refused`, `error`. `reason` (only with `error`): a failure reason, see below                                                                                                   |
| `deposit_needs_sol`     | The deposit step shows that the wallet holds too little SOL for fees. Once per page load, shared by two call sites.                                                                                | none                                                                                                                                                                                                                                                                         |
| `deposit_below_minimum` | The typed first deposit is under the seat minimum. Once per page load.                                                                                                                             | none                                                                                                                                                                                                                                                                         |
| `deposit_stop_reason`   | The visitor answers, or dismisses, the "What stopped you?" question.                                                                                                                               | `answer`: `just_looking`, `no_usdc_now`, `not_sure_what_to_do`, `something_broke`, `fees_or_minimum`, `dismissed`                                                                                                                                                            |
| `order_submitted`       | An order is sent after the review dialog.                                                                                                                                                          | `type`: `market`, `limit`                                                                                                                                                                                                                                                    |
| `order_result`          | An order ends, by outcome or by a thrown error.                                                                                                                                                    | `result`: `open`, `filled`, `partiallyFilled`, `cancelled`, `rejected`, `error`. `reason` (only with `error`): a failure reason, see below                                                                                                                                   |
| `ticket_seen`           | The order ticket is shown with a market. Once per page load.                                                                                                                                       | none                                                                                                                                                                                                                                                                         |
| `order_blocked`         | The ticket cannot submit and the block has held for a short settle time, or a reviewed order changed before sending. Once per page load per reason, except `changed_since_review`, sent each time. | `reason`: `limits_loading`, `limits_failed`, `paused`, `exposure_unreadable`, `no_funds`, `stale_price`, `closing_only`, `waiting_for_price`, `invalid_quantity`, `invalid_amount`, `over_available`, `too_small`, `invalid_price`, `short_of_funds`, `changed_since_review` |
| `quests_enabled`        | The visitor turns quests on successfully.                                                                                                                                                          | none                                                                                                                                                                                                                                                                         |
| `setup_step_seen`       | A setup step is the current step. Once per step per page load.                                                                                                                                     | `step`: `connect`, `verify`, `open`, `keys`, `deposit`                                                                                                                                                                                                                       |
| `setup_step_done`       | A setup step is done. Once per step per page load.                                                                                                                                                 | `step`: as above. `how`: `now`, `already`                                                                                                                                                                                                                                    |
| `setup_action`          | The visitor presses the action for a step. Every press.                                                                                                                                            | `step`: as above                                                                                                                                                                                                                                                             |
| `setup_failed`          | A setup step fails.                                                                                                                                                                                | `step`: as above. `reason`: a failure reason. `took`: `under_5s`, `5_30s`, `30_120s`, `over_120s`                                                                                                                                                                            |
| `app_error`             | The app throws. At most 3 per page load, then silent.                                                                                                                                              | `kind`: `route_boundary`, `uncaught`, `rejection`                                                                                                                                                                                                                            |

Failure reasons: `wallet_declined`, `wallet_unavailable`,
`network_unreachable`, `request_timeout`, `server_refused`, `invite_required`,
`rate_limited`, `daily_cap`, `key_storage_unavailable`, `other`.

## Reading the funnel

**Returning or new.** `setup_step_done.how` is `now` only when this page load
saw the step as the current one and this browser had never finished it.
Anything else is `already`. Filter to `now` to count fresh progress, and read
`already` as returning visitors passing through steps they finished earlier.
The same split explains why the five step events (`wallet_connected` to
`account_funded`) are inflated by returning visitors: they fire on every page
load where the step is done.

**Lost interest or hit a bug.**

- `setup_failed` with a `reason` of `wallet_declined`, `invite_required`,
  `daily_cap` or `rate_limited` is the visitor or the desk saying no, not a
  bug. `network_unreachable`, `server_refused`, `request_timeout`,
  `key_storage_unavailable` and `other` point at something broken or at an
  environment the terminal does not handle.
- `took` says how long the visitor waited: `under_5s` is an immediate refusal,
  `over_120s` is a visitor who waited and then saw a failure. A quick
  `wallet_declined` is a choice; a slow `request_timeout` is a bug or an
  outage.
- `order_blocked` reasons that are the visitor's input (`invalid_quantity`,
  `invalid_amount`, `too_small`, `invalid_price`, `over_available`,
  `short_of_funds`, `no_funds`) are friction or missing funds. `limits_failed`,
  `exposure_unreadable`, `stale_price` and `limits_loading` are data the
  terminal could not get. `changed_since_review` means the market moved
  between the dialog and the send.
- `deposit_result` and `order_result` with `result` `error` and a `reason`
  are bugs or outages. `refused`, `rejected` and `busy` are the venue saying
  no. `deposit_below_minimum` or `deposit_needs_sol` with no
  `deposit_submitted` after it means the visitor stopped at a requirement.
- `deposit_stop_reason` is the visitor's own words: `just_looking`,
  `no_usdc_now` and `fees_or_minimum` are lost interest; `something_broke` is
  to be matched against `setup_failed` and `app_error` in the same period.
  It is asked once per browser, after 45 seconds on the deposit step.
- `app_error` is never a visitor's choice. A rise after a deploy is read
  against `v`.

## setup_failed reasons

Where each reason comes from. The step in brackets is where it can appear.

| Reason                    | Comes from                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallet_declined`         | Wallet rejection code 4001 or the fixed rejection wording (`isWalletDecline`); `WalletWindowClosedError`; the verify step ending as declined [verify].                            |
| `wallet_unavailable`      | `WalletNotReadyError`, `WalletNotConnectedError`, `WalletConnectionError`, `WalletDisconnectedError`, `NetworkRefused`, `StaleSigner`.                                            |
| `network_unreachable`     | Open refusal `unreachable`; HTTP 502 or 503; `SessionAuthError`, `RollupIdentityError`.                                                                                           |
| `request_timeout`         | Open refusals `prepareExpired` and `mayBeOpen`; HTTP 408 or 504; `AbortError`, `TimeoutError`, `OrderOutcomeUnknownError`.                                                        |
| `server_refused`          | Open refusal `badAnswer`; any other HTTP 4xx or 5xx status; `SessionRefused`.                                                                                                     |
| `invite_required`         | Open refusals `notInvited`, `inviteCodeNeeded`, `inviteCodeWrong`, `inviteUsed` [open].                                                                                           |
| `rate_limited`            | Open refusal `tryLater`; HTTP 429.                                                                                                                                                |
| `daily_cap`               | Open refusals `dailyCapReached` and `addressLimit` [open].                                                                                                                        |
| `key_storage_unavailable` | `SeedStorageError` [keys].                                                                                                                                                        |
| `other`                   | Anything not listed above: no recognised name or status after following up to 3 levels of `cause`, a thrown value that is not an object, or a failure the key setup did not name. |

Open refusal `rejected` takes its reason from its HTTP status, and the
refusal `accountOpen` is not a failure, so it sends no `setup_failed`.

Mapping order for a thrown error: wallet decline first, then the error class
name, then an HTTP `status` on the error, then the same on its `cause`.

`took` is the time from the visitor's last press of that step's action (or,
failing that, from the step first being shown, or from page load) to the
failure:

| Bucket      | Elapsed             |
| ----------- | ------------------- |
| `under_5s`  | under 5 seconds     |
| `5_30s`     | 5 to under 30 s     |
| `30_120s`   | 30 s to under 2 min |
| `over_120s` | 2 minutes or more   |
