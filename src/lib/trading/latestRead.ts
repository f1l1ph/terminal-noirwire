/**
 * Keeps only the newest of several reads for the same owner: a read that
 * started earlier but finished later must not overwrite a newer answer, and
 * an answer for an owner who is no longer the current one is dropped.
 */
export function createLatestReads() {
  const counters = new Map<string, number>();
  return {
    /** Starts a read for `owner`; keep the returned ticket and ask `isCurrent` before using the answer. */
    begin(owner: string): number {
      const next = (counters.get(owner) ?? 0) + 1;
      counters.set(owner, next);
      return next;
    },
    isCurrent(owner: string, ticket: number, currentOwner: string | null): boolean {
      return owner === currentOwner && counters.get(owner) === ticket;
    },
  };
}
