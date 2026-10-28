import type { Side } from "../trading/types";

/** What this session knows about the order's own market, used to word a refusal. */
export interface RefusalContext {
  /** The market's own price age limit (`maxPriceAge`), when this session read it. */
  maxPriceAgeSeconds?: number;
  /** Whether the market is a perpetual; reduce-only orders exist only there. */
  isPerp?: boolean;
  /** The order's own side, which names who was missing when nothing matched. */
  side?: Side;
  /** Whether the order only closes or reduces a position, so nothing filling means the price moved, not that the book was empty. */
  reduceOnly?: boolean;
}

/**
 * The program's error list (`programs/noirwire-orderbook/src/errors.rs` in
 * the order book repository). A failed transaction reports 6000 plus the
 * number; a refusal written to the view's result ring carries the number
 * alone. A failed transaction's code below 6000 is not one of these: it is
 * any instruction's own custom error, possibly another program's. Only the
 * refusals a trader's order, cancel, deposit or withdrawal can raise are named.
 */
export const WIRE_ERROR_OFFSET = 6000;

export const PROGRAM_ERROR = {
  mathOverflow: 1,
  invariantBroken: 2,
  seatNotOpen: 11,
  seatTableFull: 13,
  seatAlreadyOpen: 14,
  zeroAmount: 21,
  insufficientBalance: 22,
  insufficientCollateral: 23,
  insufficientMargin: 24,
  balanceCapExceeded: 25,
  exchangePaused: 30,
  marketPaused: 31,
  marketReduceOnly: 32,
  invalidOrderFlags: 33,
  sizeTooSmall: 34,
  priceOffTick: 35,
  notionalTooSmall: 36,
  priceOutsideBand: 37,
  stalePrice: 38,
  priceUnavailable: 39,
  tooManyOpenOrders: 40,
  reduceOnlyWouldIncrease: 43,
  marketDataMissing: 44,
  feeSeatNotOpen: 45,
  orderExpired: 46,
  insuranceSeatNotOpen: 47,
  positionCapExceeded: 48,
  orderNotFound: 50,
  shortfallOutstanding: 64,
  oracleDislocated: 77,
  oracleIncident: 78,
  priceTooOld: 79,
  priceConfidenceTooWide: 80,
  quoteGuardTripped: 81,
  seatBlocked: 90,
  makerNotListed: 91,
  takerNotListed: 92,
  accountExists: 113,
  accountMissing: 114,
  notOrderKey: 123,
  invalidOrderKey: 124,
  notViewOwner: 125,
  counterOverflow: 130,
  expired: 133,
  expiryTooFar: 134,
  dailySeatLimitReached: 137,
  wrongPriceAccount: 141,
  wrongPriceAccountOwner: 142,
  wrongPriceAccountSize: 143,
  wrongPriceAccountKind: 144,
  priceNotFullyVerified: 145,
  wrongPriceFeed: 146,
  wrongPriceExponent: 147,
  custodyCapReached: 150,
} as const;

type Sentence = string | ((market: RefusalContext) => string);

function knownPriceAgeLimit({ maxPriceAgeSeconds }: RefusalContext): number | null {
  return maxPriceAgeSeconds !== undefined && maxPriceAgeSeconds > 0 ? maxPriceAgeSeconds : null;
}

/**
 * The stale-feed refusal is raised for the order's own market and for any
 * other market where the account holds a position, so it never pins the
 * blame on this market's limit alone.
 */
function stalePriceReason(market: RefusalContext): string {
  const limit = knownPriceAgeLimit(market);
  const ownLimit = limit === null ? "" : ` (this market accepts prices up to ${limit} seconds old)`;
  return `A price this order is checked against is too old: this market's${ownLimit}, or that of another market where this account holds a position. Wait for a fresh price and try again. No fill occurred.`;
}

function priceTooOldReason(market: RefusalContext): string {
  const limit = knownPriceAgeLimit(market);
  const age =
    limit === null
      ? "too old for this market to accept new orders"
      : `older than the ${limit} seconds this market accepts`;
  return `The market's price is ${age}. Wait for a fresh price and try again. No fill occurred.`;
}

function marketReduceOnlyReason(market: RefusalContext): string {
  return market.isPerp
    ? "This market only takes orders that shrink a position right now. Use Reduce only to close or reduce one. No fill occurred."
    : "This market only takes orders that shrink a position right now, which a spot order cannot be, so it takes no orders. No fill occurred.";
}

const INTERNAL_CHECK =
  "The exchange hit an internal check and stopped safely. Nothing was changed. Try again in a moment, and contact support if it repeats.";
const PRICE_SOURCE_NOT_READY =
  "The exchange's price source is not set up as expected, so it cannot check prices right now. This is on our side. Try again later. No fill occurred.";
const FEE_ACCOUNT_NOT_READY =
  "The exchange's fee account is not set up, so it takes no orders right now. This is on our side. Try again later. No fill occurred.";
const INSURANCE_ACCOUNT_NOT_READY =
  "The exchange's insurance account is not set up, so it takes no orders right now. This is on our side. Try again later. No fill occurred.";

/**
 * One plain sentence for each of those refusals. Each says what happened,
 * whether anything was charged or moved, and what to do next.
 */
const SENTENCES: Readonly<Record<number, Sentence>> = {
  [PROGRAM_ERROR.mathOverflow]: INTERNAL_CHECK,
  [PROGRAM_ERROR.invariantBroken]: INTERNAL_CHECK,
  [PROGRAM_ERROR.seatNotOpen]:
    "Your account is not open on the exchange yet, so there is nothing to trade with. Open your account first. No fill occurred.",
  [PROGRAM_ERROR.seatTableFull]:
    "The exchange has no room for more accounts right now. Try again later. Nothing was charged.",
  [PROGRAM_ERROR.seatAlreadyOpen]: "Your account is already open.",
  [PROGRAM_ERROR.zeroAmount]: "The amount is zero. Enter an amount above zero. Nothing moved.",
  [PROGRAM_ERROR.insufficientBalance]:
    "Your available balance does not cover this. Lower the amount, free up funds by cancelling open orders, or add funds. Nothing was charged and nothing moved.",
  [PROGRAM_ERROR.insufficientCollateral]:
    "Your collateral does not cover this. Lower the amount or add collateral. Nothing moved.",
  [PROGRAM_ERROR.insufficientMargin]:
    "Your collateral would fall below the margin this order needs. Lower the size or leverage, or add collateral. No fill occurred.",
  [PROGRAM_ERROR.balanceCapExceeded]:
    "This would take a balance past the most the exchange allows for one account. Use a smaller amount. Nothing moved.",
  [PROGRAM_ERROR.exchangePaused]:
    "The venue is paused, so it takes no orders right now. No fill occurred.",
  [PROGRAM_ERROR.marketPaused]:
    "This market is paused, so it takes no orders right now. No fill occurred.",
  [PROGRAM_ERROR.marketReduceOnly]: marketReduceOnlyReason,
  [PROGRAM_ERROR.invalidOrderFlags]:
    "These order options cannot be combined: reduce only needs a perpetual market and cannot be post-only. Change the options and try again. No fill occurred.",
  [PROGRAM_ERROR.sizeTooSmall]:
    "This order is smaller than the market's minimum size. Raise the size. No fill occurred.",
  [PROGRAM_ERROR.priceOffTick]:
    "This price is not a multiple of the market's tick. Round it to a valid price. No fill occurred.",
  [PROGRAM_ERROR.notionalTooSmall]:
    "This order is worth less than the market's minimum. Raise the size or the price. No fill occurred.",
  [PROGRAM_ERROR.priceOutsideBand]:
    "This price was too far from the mark price when it reached the exchange. Set a price nearer the market and try again. No fill occurred.",
  [PROGRAM_ERROR.stalePrice]: stalePriceReason,
  [PROGRAM_ERROR.priceUnavailable]:
    "This market has no price yet, so it takes no orders. Try again in a minute. No fill occurred.",
  [PROGRAM_ERROR.tooManyOpenOrders]:
    "You have the most open orders this market allows. Cancel one, then try again. No fill occurred.",
  [PROGRAM_ERROR.reduceOnlyWouldIncrease]:
    "A reduce-only order can only shrink your position, and this one would not. Check the side and that you still hold the position. No fill occurred.",
  [PROGRAM_ERROR.marketDataMissing]:
    "The exchange is missing price data for a market where you hold a position, so it cannot check your margin. Try again in a minute. No fill occurred.",
  [PROGRAM_ERROR.feeSeatNotOpen]: FEE_ACCOUNT_NOT_READY,
  [PROGRAM_ERROR.orderExpired]:
    "This order's own time limit had already passed when it reached the exchange, so it was not run. Try again. No fill occurred.",
  [PROGRAM_ERROR.insuranceSeatNotOpen]: INSURANCE_ACCOUNT_NOT_READY,
  [PROGRAM_ERROR.positionCapExceeded]:
    "This order could take your position past this market's position limit. Lower the size. No fill occurred.",
  [PROGRAM_ERROR.orderNotFound]:
    "That order is not open any more: it has probably filled, expired or been cancelled. Check your open orders and positions.",
  [PROGRAM_ERROR.shortfallOutstanding]:
    "A market has an unpaid loss on record, so withdrawing collateral is paused for everyone until it is covered. Your funds are safe and nothing moved. You can still trade and cancel orders. Try again later.",
  [PROGRAM_ERROR.oracleDislocated]:
    "The on-chain price is too far from the market, so trading is paused for safety until it catches up. Try again shortly. No fill occurred.",
  [PROGRAM_ERROR.oracleIncident]:
    "A price problem is open on a perpetual market, so withdrawing collateral is paused until it clears. Your funds are safe and nothing moved. You can still cancel orders. Try again later.",
  [PROGRAM_ERROR.priceTooOld]: priceTooOldReason,
  [PROGRAM_ERROR.priceConfidenceTooWide]:
    "The exchange's price source is too uncertain right now, so new orders are paused. Try again in a minute. No fill occurred.",
  [PROGRAM_ERROR.quoteGuardTripped]:
    "The venue's USDC price guard has tripped, so perpetuals only take orders that shrink a position right now. No fill occurred.",
  [PROGRAM_ERROR.seatBlocked]:
    "This account is blocked on this venue: it can cancel, reduce and move funds, but not open new orders. No fill occurred.",
  [PROGRAM_ERROR.makerNotListed]:
    "This market only lets listed makers rest orders, and this account is not one. No fill occurred.",
  [PROGRAM_ERROR.takerNotListed]:
    "This market only lets listed takers place orders that match, and this account is not one. No fill occurred.",
  [PROGRAM_ERROR.accountExists]: "Your account already exists.",
  [PROGRAM_ERROR.accountMissing]:
    "Your account could not be found on the exchange. If you just opened it, wait a moment and try again.",
  [PROGRAM_ERROR.notOrderKey]:
    "This device's trading keys are no longer the ones on your account, probably because another device set up trading. Set up trading again on this device. Nothing was charged.",
  [PROGRAM_ERROR.invalidOrderKey]:
    "The new trading key could not be used. Set up trading again on this device. Nothing was charged.",
  [PROGRAM_ERROR.notViewOwner]:
    "This account belongs to a different wallet. Connect the wallet that opened it.",
  [PROGRAM_ERROR.counterOverflow]: INTERNAL_CHECK,
  [PROGRAM_ERROR.expired]:
    "The order reached the venue after its time limit and was not run. Try again. No fill occurred.",
  [PROGRAM_ERROR.expiryTooFar]:
    "The clock on this device looks ahead of the network's, so the request was not run. Check the clock on your device and try again. Nothing was charged.",
  [PROGRAM_ERROR.dailySeatLimitReached]:
    "The exchange has opened all the new accounts it allows today. Try again after 00:00 UTC. Nothing was charged.",
  [PROGRAM_ERROR.wrongPriceAccount]: PRICE_SOURCE_NOT_READY,
  [PROGRAM_ERROR.wrongPriceAccountOwner]: PRICE_SOURCE_NOT_READY,
  [PROGRAM_ERROR.wrongPriceAccountSize]: PRICE_SOURCE_NOT_READY,
  [PROGRAM_ERROR.wrongPriceAccountKind]: PRICE_SOURCE_NOT_READY,
  [PROGRAM_ERROR.priceNotFullyVerified]: PRICE_SOURCE_NOT_READY,
  [PROGRAM_ERROR.wrongPriceFeed]: PRICE_SOURCE_NOT_READY,
  [PROGRAM_ERROR.wrongPriceExponent]: PRICE_SOURCE_NOT_READY,
  [PROGRAM_ERROR.custodyCapReached]:
    "Deposits are paused at the current limit. You can still trade and withdraw. Nothing moved.",
};

/**
 * Codes with no sentence on purpose: a trader's order, cancel, deposit or
 * withdrawal cannot raise them. They belong to the admin and oracle
 * instructions (setup, settings, price publishing, resuming a market,
 * collecting fees), to liquidation and funding cranks, to closing a seat, and
 * to account checks on accounts this terminal derives itself.
 */
export const NOT_RAISED_BY_TRADERS: ReadonlySet<number> = new Set([
  3, 4, 5, 6, 10, 12, 15, 16, 17, 20, 60, 61, 62, 63, 70, 71, 72, 73, 74, 75, 76, 100, 101, 102,
  103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 115, 116, 117, 118, 119, 120, 121, 122, 126,
  127, 128, 129, 131, 132, 135, 136, 138, 139, 140, 148, 149,
]);

/** A plain sentence for a program refusal by its number in the program's error list, or null for one this terminal has no sentence for. */
export function describeProgramError(number: number, market: RefusalContext = {}): string | null {
  const sentence = SENTENCES[number];
  if (sentence === undefined) return null;
  return typeof sentence === "string" ? sentence : sentence(market);
}

/** `describeProgramError` for a failed transaction's code, which names this program's error only from 6000 up. */
export function describeTransactionError(code: number, market: RefusalContext): string | null {
  return code >= WIRE_ERROR_OFFSET ? describeProgramError(code - WIRE_ERROR_OFFSET, market) : null;
}
