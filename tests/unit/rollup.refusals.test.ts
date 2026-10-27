import { describe, expect, it } from "vitest";
import {
  describeProgramError,
  describeTransactionError,
  NOT_RAISED_BY_TRADERS,
  PROGRAM_ERROR,
  WIRE_ERROR_OFFSET,
} from "@/lib/rollup/refusals";
import { ACCESS_ERROR } from "@/lib/rollup/sdk";

/**
 * Every code of `OrderbookError` in `programs/noirwire-orderbook/src/errors.rs`
 * of the order book repository (codes 1 to 99 are the engine's own, one to one
 * with `crates/engine/src/error.rs`), by number. When the program gains a code,
 * add it here and either give it a sentence in `refusals.ts` or list it there as
 * one a trader cannot raise.
 */
const PROGRAM_ERROR_CODES: Readonly<Record<number, string>> = {
  1: "MathOverflow",
  2: "InvariantBroken",
  3: "InvalidMarketParams",
  4: "MarketMismatch",
  5: "JournalFull",
  6: "StepLimitTooLarge",
  10: "SeatOutOfRange",
  11: "SeatNotOpen",
  12: "NotSeatOwner",
  13: "SeatTableFull",
  14: "SeatAlreadyOpen",
  15: "SeatNotEmpty",
  16: "ReservedSeat",
  17: "NotReservedSeat",
  20: "InvalidToken",
  21: "ZeroAmount",
  22: "InsufficientBalance",
  23: "InsufficientCollateral",
  24: "InsufficientMargin",
  25: "BalanceCapExceeded",
  30: "ExchangePaused",
  31: "MarketPaused",
  32: "MarketReduceOnly",
  33: "InvalidOrderFlags",
  34: "SizeTooSmall",
  35: "PriceOffTick",
  36: "NotionalTooSmall",
  37: "PriceOutsideBand",
  38: "StalePrice",
  39: "PriceUnavailable",
  40: "TooManyOpenOrders",
  43: "ReduceOnlyWouldIncrease",
  44: "MarketDataMissing",
  45: "FeeSeatNotOpen",
  46: "OrderExpired",
  47: "InsuranceSeatNotOpen",
  48: "PositionCapExceeded",
  50: "OrderNotFound",
  60: "NotPerpMarket",
  61: "NotLiquidatable",
  62: "SelfLiquidation",
  63: "NoPosition",
  64: "ShortfallOutstanding",
  70: "PriceTimeWentBackwards",
  71: "PriceMoveTooLarge",
  72: "ZeroPrice",
  73: "PricePublishedTooSoon",
  74: "PriceFromTheFuture",
  75: "PriceTooHigh",
  76: "FeedNotSeeded",
  77: "OracleDislocated",
  78: "OracleIncident",
  79: "PriceTooOld",
  80: "PriceConfidenceTooWide",
  81: "QuoteGuardTripped",
  90: "SeatBlocked",
  91: "MakerNotListed",
  92: "TakerNotListed",
  100: "NotUpgradeAuthority",
  101: "NotAdmin",
  102: "NotNominee",
  103: "GateMissing",
  104: "NotOracle",
  105: "InvalidSettings",
  106: "BelowRent",
  107: "UnknownToken",
  108: "WrongCustody",
  109: "WrongMint",
  110: "WrongTokenAccountOwner",
  111: "WrongTokenProgram",
  112: "TokenAccountUninitialised",
  113: "AccountExists",
  114: "AccountMissing",
  115: "WrongOwner",
  116: "WrongDerivation",
  117: "WrongKind",
  118: "WrongSize",
  119: "NotReady",
  120: "AlreadyReady",
  121: "WrongMarket",
  122: "InvalidGrowth",
  123: "NotOrderKey",
  124: "InvalidOrderKey",
  125: "NotViewOwner",
  126: "MarketExists",
  127: "InvalidCapacity",
  128: "MalformedRemainingAccounts",
  129: "DuplicateMarket",
  130: "CounterOverflow",
  131: "Unaligned",
  132: "InvalidSchedule",
  133: "Expired",
  134: "ExpiryTooFar",
  135: "ResumeOnly",
  136: "CustodyNotPrivate",
  137: "DailySeatLimitReached",
  138: "SeatUsed",
  139: "CustodyNotPublic",
  140: "PayoutIntoCustody",
  141: "WrongPriceAccount",
  142: "WrongPriceAccountOwner",
  143: "WrongPriceAccountSize",
  144: "WrongPriceAccountKind",
  145: "PriceNotFullyVerified",
  146: "WrongPriceFeed",
  147: "WrongPriceExponent",
  148: "PriceSourceBound",
  149: "PriceSourceInUse",
  150: "CustodyCapReached",
};

const NUMBERS = Object.keys(PROGRAM_ERROR_CODES).map(Number);

const DASHES = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)];

const FORBIDDEN_IN_COPY = [/\bprogram error\b/i, /\b6\d{3}\b/, /\bcode \d/i, /0x[0-9a-f]+/i];

describe("the sentence for every refusal a trader can meet", () => {
  it.each(NUMBERS.filter((number) => !NOT_RAISED_BY_TRADERS.has(number)))(
    "has a sentence for code %i",
    (number) => {
      expect(describeProgramError(number), PROGRAM_ERROR_CODES[number]).not.toBeNull();
    },
  );

  it.each(NUMBERS.filter((number) => NOT_RAISED_BY_TRADERS.has(number)))(
    "leaves code %i, which a trader cannot raise, without one",
    (number) => {
      expect(describeProgramError(number), PROGRAM_ERROR_CODES[number]).toBeNull();
    },
  );

  it("lists as not raised by traders only codes the program has", () => {
    for (const number of NOT_RAISED_BY_TRADERS) expect(PROGRAM_ERROR_CODES[number]).toBeDefined();
  });

  it("names only codes the program has", () => {
    for (const number of Object.values(PROGRAM_ERROR)) {
      expect(PROGRAM_ERROR_CODES[number]).toBeDefined();
    }
  });

  it("names each code by the program's own name for it", () => {
    for (const [name, number] of Object.entries(PROGRAM_ERROR)) {
      expect(PROGRAM_ERROR_CODES[number].toLowerCase()).toBe(name.toLowerCase());
    }
  });

  it("agrees with the package on the access-list codes", () => {
    expect(PROGRAM_ERROR.seatBlocked).toBe(ACCESS_ERROR.seatBlocked - WIRE_ERROR_OFFSET);
    expect(PROGRAM_ERROR.makerNotListed).toBe(ACCESS_ERROR.makerNotListed - WIRE_ERROR_OFFSET);
    expect(PROGRAM_ERROR.takerNotListed).toBe(ACCESS_ERROR.takerNotListed - WIRE_ERROR_OFFSET);
  });

  it("never shows a code, a program error label or a raw address in a sentence", () => {
    for (const number of NUMBERS) {
      const sentence = describeProgramError(number, { isPerp: true, maxPriceAgeSeconds: 90 });
      if (sentence === null) continue;
      for (const pattern of FORBIDDEN_IN_COPY) {
        expect(sentence, PROGRAM_ERROR_CODES[number]).not.toMatch(pattern);
      }
      for (const dash of DASHES) expect(sentence).not.toContain(dash);
    }
  });

  it("ends every sentence with a full stop", () => {
    for (const number of NUMBERS) {
      const sentence = describeProgramError(number);
      if (sentence !== null) expect(sentence).toMatch(/\.$/);
    }
  });
});

describe("the sentences the issue calls out", () => {
  it.each([
    [22, /available balance does not cover/],
    [23, /collateral does not cover/],
    [25, /past the most the exchange allows/],
    [39, /no price yet/],
    [40, /most open orders/],
    [46, /own time limit had already passed/],
    [50, /not open any more/],
    [80, /too uncertain/],
    [137, /all the new accounts it allows today/],
  ])("code %i", (number, sentence) => {
    expect(describeProgramError(number)).toMatch(sentence);
  });

  it("says withdrawals are blocked while a shortfall is recorded (64), and that funds are safe", () => {
    const sentence = describeProgramError(64) ?? "";
    expect(sentence).toMatch(/withdrawing collateral is paused/);
    expect(sentence).toMatch(/funds are safe/);
  });

  it("says withdrawals are blocked during a price incident (78), and that funds are safe", () => {
    const sentence = describeProgramError(78) ?? "";
    expect(sentence).toMatch(/price problem/);
    expect(sentence).toMatch(/withdrawing collateral is paused/);
    expect(sentence).toMatch(/funds are safe/);
  });

  it("says another device took the order keys (123) and what to do", () => {
    const sentence = describeProgramError(123) ?? "";
    expect(sentence).toMatch(/another device set up trading/);
    expect(sentence).toMatch(/Set up trading again on this device/);
  });

  it("tells a deposit past the custody cap (150) that trading and withdrawing still work", () => {
    expect(describeProgramError(150)).toMatch(/still trade and withdraw/);
  });
});

describe("describeTransactionError", () => {
  it("reads a failed transaction's code from 6000 up as the program's", () => {
    expect(describeTransactionError(6064, {})).toBe(describeProgramError(64));
  });

  it("does not read a code below 6000 as the program's", () => {
    expect(describeTransactionError(64, {})).toBeNull();
  });
});
