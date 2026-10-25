import type { Connection, PublicKey } from "@solana/web3.js";
import { ownerDataKeys, type KeyValueStore } from "../wallet/index";
import type { OwnerSigner } from "../wallet/ownerSigner";
import { signInSigner } from "./keys";
import { forgetToken, rememberToken } from "./redact";

/**
 * A token with less than this left is signed for again, so a session never
 * starts on a token that lapses within the hour.
 */
export const TOKEN_REFRESH_MARGIN_MS = 60 * 60 * 1000;

interface StoredToken {
  token: string;
  expiresAtMs: number;
}

const readStored = (storage: KeyValueStore, owner: string): StoredToken | null => {
  try {
    const raw = storage.getItem(ownerDataKeys.signInToken(owner));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredToken> | null;
    if (
      typeof parsed?.token !== "string" ||
      parsed.token === "" ||
      typeof parsed.expiresAtMs !== "number" ||
      !Number.isFinite(parsed.expiresAtMs)
    ) {
      return null;
    }
    return { token: parsed.token, expiresAtMs: parsed.expiresAtMs };
  } catch {
    return null;
  }
};

/**
 * The owner's cached sign-in token, or null when there is none, it is
 * malformed, or it has less than `TOKEN_REFRESH_MARGIN_MS` left. A token that
 * is no longer usable is removed.
 */
export function loadSignInToken(
  storage: KeyValueStore,
  owner: string,
  nowMs: number,
): StoredToken | null {
  const stored = readStored(storage, owner);
  if (!stored) return null;
  if (stored.expiresAtMs - nowMs < TOKEN_REFRESH_MARGIN_MS) {
    clearSignInToken(storage, owner);
    return null;
  }
  rememberToken(stored.token);
  return stored;
}

/** Keeps `token` for this owner on this device; without storage the next page load signs in again. */
export function saveSignInToken(
  storage: KeyValueStore,
  owner: string,
  token: string,
  expiresAtMs: number,
): void {
  rememberToken(token);
  try {
    storage.setItem(ownerDataKeys.signInToken(owner), JSON.stringify({ token, expiresAtMs }));
  } catch {
    // Best effort: the token still serves this page.
  }
}

/** Forgets the owner's token: on disconnect, on an account change, and when the rollup stops accepting it. */
export function clearSignInToken(storage: KeyValueStore, owner: string): void {
  const stored = readStored(storage, owner);
  if (stored) forgetToken(stored.token);
  try {
    storage.removeItem(ownerDataKeys.signInToken(owner));
  } catch {
    // Nothing to remove from storage that cannot be reached.
  }
}

/**
 * Calls `forget` with an address once it stops being the connected owner
 * (disconnected, or switched to another account). A page that loads with an
 * owner already connected, or a reconnect to the same address, forgets
 * nothing.
 */
export function trackConnectedOwner(forget: (address: string) => void) {
  let current: string | null = null;
  return (next: string | null) => {
    if (current && current !== next) forget(current);
    current = next;
  };
}

export interface SignedIn {
  reader: Connection;
  expiresAtMs: number;
  /** Whether the token came from this device's cache, not from a signature just now. */
  cached: boolean;
}

export interface SignInDeps {
  rollupRpcUrl: string;
  owner: OwnerSigner;
  storage: KeyValueStore;
  now: () => number;
  signIn: (
    url: string,
    reader: PublicKey,
    signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  ) => Promise<{ token: string; expiresAtMs: number }>;
  connect: (url: string, token: string) => Connection;
}

/**
 * A connection to the private endpoint, signed in as `owner`. The cached
 * token is used while it has time left, so a reload asks the wallet for
 * nothing; otherwise (or when `fresh` is set, after the rollup refused the
 * cached one) the owner signs the rollup's challenge once and the new token
 * is kept for its lifetime.
 */
export async function signedInReader(
  deps: SignInDeps,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<SignedIn> {
  const address = deps.owner.publicKey.toBase58();
  if (!fresh) {
    const cached = loadSignInToken(deps.storage, address, deps.now());
    if (cached) {
      return {
        reader: deps.connect(deps.rollupRpcUrl, cached.token),
        expiresAtMs: cached.expiresAtMs,
        cached: true,
      };
    }
  }
  const { token, expiresAtMs } = await deps.signIn(
    deps.rollupRpcUrl,
    deps.owner.publicKey,
    signInSigner(deps.owner),
  );
  saveSignInToken(deps.storage, address, token, expiresAtMs);
  return { reader: deps.connect(deps.rollupRpcUrl, token), expiresAtMs, cached: false };
}
