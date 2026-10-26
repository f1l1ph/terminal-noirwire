/** The subset of `navigator.locks` used here. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<void> | undefined,
  ): Promise<unknown>;
}

export interface OwnerLock {
  release(): void;
}

/**
 * Takes the one-operation-at-a-time lock for an owner across every tab of this
 * browser. Returns null when another tab holds it; the caller must then not
 * start. Without a lock manager nothing can be promised, so it throws.
 */
export function tryLockOwner(
  owner: string,
  locks: LockManagerLike | null = typeof navigator === "undefined"
    ? null
    : ((navigator.locks as unknown as LockManagerLike | undefined) ?? null),
): Promise<OwnerLock | null> {
  if (!locks) return Promise.reject(new Error("Web Locks are not available in this browser"));
  return new Promise((resolve, reject) => {
    locks
      .request(`transfer:${owner}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        return new Promise<void>((release) => resolve({ release: () => release() }));
      })
      .catch(reject);
  });
}
