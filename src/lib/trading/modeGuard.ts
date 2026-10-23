/**
 * Dev mode posts orders with only an address and no signature, so a
 * production build refuses it unless the build explicitly opts in (the
 * end-to-end suites build against a mock service this way).
 */
export function unsignedDevModeRefusal(
  tradingMode: string,
  nodeEnv: string | undefined,
  allowUnsignedDev: string | undefined,
): string | null {
  if (tradingMode !== "dev" || nodeEnv !== "production" || allowUnsignedDev === "1") return null;
  return "NEXT_PUBLIC_TRADING_MODE=dev posts unsigned orders and is refused in a production build. Use rollup mode.";
}
