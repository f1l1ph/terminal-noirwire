import type { Connection, PublicKey } from "@solana/web3.js";
import { ownerDataKeys, type KeyValueStore } from "../wallet/index";
import { StaleSigner, type OwnerSigner } from "../wallet/ownerSigner";
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

/**
 * The tokens signed for in this page, per store: storage that cannot keep a
 * write must not make a rebuilt session ask the wallet to sign in again.
 */
const inMemory = new WeakMap<KeyValueStore, Map<string, StoredToken>>();

const memoryTokens = (storage: KeyValueStore): Map<string, StoredToken> => {
  const tokens = inMemory.get(storage) ?? new Map<string, StoredToken>();
  inMemory.set(storage, tokens);
  return tokens;
};

const readStored = (storage: KeyValueStore, owner: string): StoredToken | null => {
  try {
    const raw = storage.getItem(ownerDataKeys.signInToken(owner));
    if (!raw) return memoryTokens(storage).get(owner) ?? null;
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
    return memoryTokens(storage).get(owner) ?? null;
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
  memoryTokens(storage).set(owner, { token, expiresAtMs });
  try {
    storage.setItem(ownerDataKeys.signInToken(owner), JSON.stringify({ token, expiresAtMs }));
  } catch {
    // Best effort: the token still serves this page.
  }
}

/** How many times each owner's token was wiped in this page; a sign-in that began before a wipe must not save its token after it. */
const wipes = new Map<string, number>();

/** A store that can list its keys, as `localStorage` can. */
export type ListableStore = KeyValueStore & {
  readonly length: number;
  key(index: number): string | null;
};

/**
 * Wipes the stored token of every owner but `keep`: a token left by an owner
 * who disconnected on an earlier visit lives no longer than the next
 * connection of anyone else.
 */
export function clearOtherSignInTokens(storage: ListableStore, keep: string): void {
  try {
    const prefix = ownerDataKeys.signInToken("");
    const owners: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix) && key.length > prefix.length) {
        owners.push(key.slice(prefix.length));
      }
    }
    for (const owner of owners) if (owner !== keep) clearSignInToken(storage, owner);
  } catch {
    // Storage that cannot be listed has nothing this can wipe.
  }
}

/** Forgets the owner's token: on disconnect, on an account change, and when the rollup stops accepting it. */
export function clearSignInToken(storage: KeyValueStore, owner: string): void {
  wipes.set(owner, (wipes.get(owner) ?? 0) + 1);
  const stored = readStored(storage, owner);
  if (stored) forgetToken(stored.token);
  memoryTokens(storage).delete(owner);
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
export function trackConnectedOwner(
  forget: (address: string) => void,
  /** Called with each address that becomes the connected owner, so tokens left by any other owner can go. */
  onConnect: (address: string) => void = () => {},
) {
  let current: string | null = null;
  return (next: string | null) => {
    if (current && current !== next) forget(current);
    if (next && next !== current) onConnect(next);
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
  const startedAt = wipes.get(address) ?? 0;
  const { token, expiresAtMs } = await deps.signIn(
    deps.rollupRpcUrl,
    deps.owner.publicKey,
    signInSigner(deps.owner),
  );
  // The owner was disconnected or switched while the endpoint was logging in:
  // the token belongs to a connection that is gone, so it is dropped unsaved.
  if ((wipes.get(address) ?? 0) !== startedAt) throw new StaleSigner();
  saveSignInToken(deps.storage, address, token, expiresAtMs);
  return { reader: deps.connect(deps.rollupRpcUrl, token), expiresAtMs, cached: false };
}
