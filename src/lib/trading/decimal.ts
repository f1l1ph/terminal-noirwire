/**
 * All order math (margin, fees, liquidation estimate, tick/lot checks) runs
 * on bigint, never on floating point. Every decimal string the venue or the
 * trader types is converted to a fixed-point bigint at this one internal
 * scale before any arithmetic, and converted back only for display.
 */
export const FIXED_POINT_SCALE = 1_000_000_000n;

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export function toFixedPoint(decimalString: string): bigint {
  const trimmed = decimalString.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new Error(`Not a decimal number: "${decimalString}"`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ""] = unsigned.split(".");
  const fractionDigits = 9;
  const paddedFraction = (fraction + "0".repeat(fractionDigits)).slice(0, fractionDigits);
  const combined = BigInt(whole) * FIXED_POINT_SCALE + BigInt(paddedFraction || "0");
  return negative ? -combined : combined;
}

export function fromFixedPoint(value: bigint, displayDecimals: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / FIXED_POINT_SCALE;
  const fraction = magnitude % FIXED_POINT_SCALE;
  const fractionStr = fraction.toString().padStart(9, "0").slice(0, Math.max(displayDecimals, 0));
  const roundedFraction = displayDecimals >= 9 ? fraction.toString().padStart(9, "0") : fractionStr;
  const sign = negative && (whole !== 0n || magnitude !== 0n) ? "-" : "";
  if (displayDecimals <= 0) return `${sign}${whole}`;
  return `${sign}${whole}.${roundedFraction.padEnd(displayDecimals, "0")}`;
}

export function mulFixedPoint(a: bigint, b: bigint): bigint {
  return (a * b) / FIXED_POINT_SCALE;
}

export function divFixedPoint(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("Division by zero");
  return (a * FIXED_POINT_SCALE) / b;
}

export function bpsOfFixedPoint(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.round(bps))) / 10_000n;
}
