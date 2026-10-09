import { toFixedPoint, fromFixedPoint } from "../trading/decimal";

/**
 * Converts between this terminal's numbers (a price per whole base unit and
 * a size in base units) and the on-chain program's (a price in quote atoms
 * per lot and a size in lots). Derived from `market.lotSize` alone, the same
 * human decimal string `/v1/markets` already serves in dev mode: no extra
 * on-chain read is needed for this. The quote token is always nUSD at 6
 * decimals, so quote amounts need no conversion of their own.
 *
 * This mirrors sim-noirwire's `src/rollup/units.ts` (`marketUnits` /
 * `toSimSize` / `toChainSize` / `toSimPrice` / `toChainPrice`), which works
 * in a 6-decimal "sim scale" the service's wire strings are already at;
 * re-derived here from the wire field rather than from the raw on-chain
 * `baseLot` + token decimals, which the browser has no other reason to read.
 * This terminal's own `toFixedPoint`/`fromFixedPoint` run at a 9-decimal
 * internal scale for precise arithmetic, so every sim-scale (1e6) integer
 * below is that internal value divided or multiplied by 1,000.
 */
export interface MarketUnits {
  /** How many on-chain lots make up one whole base unit. */
  lotsPerUnit: bigint;
  /** Sim-scale (1e6) size of one lot. */
  sizePerLot: bigint;
}

const SIM_SCALE = 1_000_000n;
const INTERNAL_PER_SIM = 1_000n; // this terminal's 1e9 internal scale / sim's 1e6 scale

function toSimScale(humanDecimal: string): bigint {
  const internal = toFixedPoint(humanDecimal);
  if (internal % INTERNAL_PER_SIM !== 0n) {
    throw new Error(`${humanDecimal} carries more precision than 6 decimals`);
  }
  return internal / INTERNAL_PER_SIM;
}

function fromSimScale(simValue: bigint, displayDecimals: number): string {
  return fromFixedPoint(simValue * INTERNAL_PER_SIM, displayDecimals);
}

export function marketUnitsFromLotSize(lotSize: string): MarketUnits {
  const sizePerLot = toSimScale(lotSize);
  if (sizePerLot <= 0n || SIM_SCALE % sizePerLot !== 0n) {
    throw new Error(`lot size ${lotSize} does not divide one base unit at 6 decimals`);
  }
  const lotsPerUnit = SIM_SCALE / sizePerLot;
  return { lotsPerUnit, sizePerLot };
}

/**
 * The authoritative version: built directly from `/v1/deployment`'s raw
 * on-chain `baseLot` (atoms per lot) and `baseDecimals` - exactly
 * sim-noirwire's own `marketUnits()` (`src/rollup/units.ts` there), no
 * longer re-derived from a human decimal string.
 */
export function marketUnitsFromChain(baseLot: bigint, baseDecimals: number): MarketUnits {
  const atomsPerUnit = 10n ** BigInt(baseDecimals);
  if (baseLot <= 0n || atomsPerUnit % baseLot !== 0n) {
    throw new Error(`a lot of ${baseLot} base atoms does not divide one base unit`);
  }
  const lotsPerUnit = atomsPerUnit / baseLot;
  if (SIM_SCALE % lotsPerUnit !== 0n) {
    throw new Error(`a lot of ${baseLot} base atoms is finer than 6 decimals`);
  }
  return { lotsPerUnit, sizePerLot: SIM_SCALE / lotsPerUnit };
}

/** Whole base units (a decimal string) to a whole number of lots. Throws if not a clean multiple. */
export function sizeToLots(units: MarketUnits, humanSize: string): bigint {
  const simSize = toSimScale(humanSize);
  if (simSize % units.sizePerLot !== 0n) {
    throw new Error(`${humanSize} is not a whole number of lots`);
  }
  return simSize / units.sizePerLot;
}

export function lotsToSize(units: MarketUnits, lots: bigint, displayDecimals = 6): string {
  return fromSimScale(lots * units.sizePerLot, displayDecimals);
}

/** Quote atoms per whole base unit (a decimal string) to quote atoms per lot. Throws if not exact. */
export function priceToChainAtoms(units: MarketUnits, humanPrice: string): bigint {
  const simPrice = toSimScale(humanPrice);
  if (simPrice % units.lotsPerUnit !== 0n) {
    throw new Error(`${humanPrice} is not a whole number of quote atoms per lot`);
  }
  return simPrice / units.lotsPerUnit;
}

export function chainAtomsToPrice(
  units: MarketUnits,
  chainPrice: bigint,
  displayDecimals = 6,
): string {
  return fromSimScale(chainPrice * units.lotsPerUnit, displayDecimals);
}

/** Raw quote atoms (nUSD, 6 decimals) to a display decimal string. For collateral and quote balances. */
export function quoteAtomsToAmount(atoms: bigint, displayDecimals = 6): string {
  return fromSimScale(atoms, displayDecimals);
}

export function amountToQuoteAtoms(humanAmount: string): bigint {
  return toSimScale(humanAmount);
}
