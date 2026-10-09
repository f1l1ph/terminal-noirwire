/**
 * Whether order entry should offer "Move funds to spot" instead of letting
 * a spot buy fail for an empty spot balance, or pointlessly offering the
 * one-time faucet grant again. True only when there is somewhere to move
 * funds FROM: rollup mode's separate collateral account (RULES.md section
 * 6); dev mode has one balance, nothing to move between.
 */
export function needsSpotTransfer(params: {
  isPerp: boolean;
  side: "buy" | "sell";
  hasWallet: boolean;
  canTransfer: boolean;
  spotAvailable: number;
  collateralAvailable: number | null;
}): boolean {
  if (params.isPerp || params.side !== "buy" || !params.hasWallet || !params.canTransfer) {
    return false;
  }
  if (params.collateralAvailable === null) return false;
  return params.spotAvailable <= 0 && params.collateralAvailable > 0;
}
