/** A market id as a trader reads it: the venue's test-token N prefix is dropped (NSOL-PERP shows as SOL-PERP). */
export function marketDisplayName(id: string): string {
  return id.replace(/^N(?=SOL-|NVDA-)/, "");
}
