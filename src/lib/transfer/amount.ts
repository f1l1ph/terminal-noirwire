import { tokenAtoms } from "./verdicts";

export type AmountCheck =
  | { ok: true; atoms: bigint }
  | {
      ok: false;
      reason: "empty" | "invalid" | "too-many-decimals" | "zero" | "above-limit" | "limit-unknown";
    };

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * What the owner typed, as integer atoms. Refused unless it is plainly a
 * number above zero with no more decimal places than the token has, and no
 * more than `limit` (the balance it comes from; null while that is unknown).
 * No floating point anywhere: the text is split and read as integers.
 */
export function checkAmount(text: string, decimals: number, limit: bigint | null): AmountCheck {
  const typed = text.trim();
  if (typed === "") return { ok: false, reason: "empty" };
  const parts = PLAIN_DECIMAL.exec(typed);
  if (!parts) return { ok: false, reason: "invalid" };
  if ((parts[2] ?? "").length > decimals) return { ok: false, reason: "too-many-decimals" };
  let atoms: bigint;
  try {
    atoms = tokenAtoms(typed, decimals);
  } catch {
    return { ok: false, reason: /^0*(\.0*)?$/.test(typed) ? "zero" : "invalid" };
  }
  if (limit === null) return { ok: false, reason: "limit-unknown" };
  if (atoms > limit) return { ok: false, reason: "above-limit" };
  return { ok: true, atoms };
}

/**
 * A balance a figure was read as (a decimal string) in atoms, rounded down so
 * a limit is never overstated; null for text that is not a plain non-negative
 * decimal.
 */
export function balanceAtoms(text: string, decimals: number): bigint | null {
  const parts = PLAIN_DECIMAL.exec(text.trim());
  if (!parts) return null;
  const fraction = (parts[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(parts[1]) * 10n ** BigInt(decimals) + BigInt(fraction || "0");
}

/** Atoms as a plain decimal string with every decimal place kept, such as 2.500000. */
export function atomsText(atoms: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = atoms / scale;
  return decimals === 0
    ? whole.toString()
    : `${whole}.${(atoms % scale).toString().padStart(decimals, "0")}`;
}
