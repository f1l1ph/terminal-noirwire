import { Keypair } from "@solana/web3.js";
import { openSecret, parseSealedSecret, sealSecret } from "./sealedSecret";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Where earlier builds kept the secret as plain hex. Read only to encrypt it; never written. */
const LEGACY_SECRET_KEY = "noirwire-terminal-wallet-secret";
/** The owner secret, encrypted under the trader's passphrase (see sealedSecret.ts). */
const SEALED_SECRET_KEY = "noirwire-terminal-wallet-sealed";
/** The address of the wallet this device holds, encrypted or not. No secret. */
const ADDRESS_KEY = "noirwire-terminal-wallet-address";

/**
 * Everything else this terminal keeps under one owner address, named in one
 * place so that forgetting a wallet forgets all of it.
 */
export const ownerDataKeys = {
  orderSecrets: (address: string) => `noirwire-terminal-rollup-secrets-${address}`,
  keyCheckpoint: (address: string) => `noirwire-terminal-rollup-checkpoint-${address}`,
  grantUsed: (address: string) => `noirwire-terminal-grant-used:${address}`,
  unknownHolds: (address: string) => `noirwire-terminal-unknown-orders:${address}`,
  accountOpened: (address: string) => `noirwire-terminal-account-opened:${address}`,
};

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error("Not a valid hex secret");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export interface WalletAccount {
  publicKey: string;
  secretKeyHex: string;
}

function keypairToAccount(keypair: Keypair): WalletAccount {
  return { publicKey: keypair.publicKey.toBase58(), secretKeyHex: bytesToHex(keypair.secretKey) };
}

function accountFromHex(hex: string): WalletAccount {
  return keypairToAccount(Keypair.fromSecretKey(hexToBytes(hex.trim())));
}

/**
 * The shortest passphrase `protectWallet` accepts, the shared NoirWire
 * keystore's own minimum. Whoever copies localStorage can guess offline as
 * fast as their hardware allows; PBKDF2 slows each guess, the length has to
 * carry the rest.
 */
export const MIN_PASSPHRASE_LENGTH = 12;

/** Thrown by `importWallet` instead of replacing a different wallet the caller did not ask to replace. */
export class WalletExistsError extends Error {
  constructor(readonly existingAddress: string) {
    super(`a different wallet (${existingAddress}) is already kept on this device`);
    this.name = "WalletExistsError";
  }
}

/** A wallet from a build that stored the secret in plain text, still waiting to be encrypted. */
export function loadLegacyWallet(storage: KeyValueStore): WalletAccount | null {
  const hex = storage.getItem(LEGACY_SECRET_KEY);
  if (!hex) return null;
  try {
    return accountFromHex(hex);
  } catch {
    return null;
  }
}

/** The address of the encrypted wallet on this device, or null when there is none. */
export function lockedWalletAddress(storage: KeyValueStore): string | null {
  return parseSealedSecret(storage.getItem(SEALED_SECRET_KEY))?.publicKey ?? null;
}

/** The address of the wallet whose secret this device keeps, encrypted or in plain text from an earlier build. */
export function keptWalletAddress(storage: KeyValueStore): string | null {
  return lockedWalletAddress(storage) ?? loadLegacyWallet(storage)?.publicKey ?? null;
}

/** The address of the wallet this device holds or last held, whether or not its secret is still here. */
export function storedWalletAddress(storage: KeyValueStore): string | null {
  return keptWalletAddress(storage) ?? storage.getItem(ADDRESS_KEY);
}

/**
 * Test network only. The new secret is held by the caller, in memory: it is
 * written nowhere until `protectWallet` encrypts it. Only its address is
 * recorded, so that forgetting this wallet can find its other data. What a
 * wallet lost before it was ever saved left behind is forgotten first, so
 * it cannot keep linking that address to its fills.
 */
export function createWallet(storage: KeyValueStore): WalletAccount {
  const kept = keptWalletAddress(storage);
  if (kept) throw new WalletExistsError(kept);
  clearWallet(storage);
  const account = keypairToAccount(Keypair.generate());
  storage.setItem(ADDRESS_KEY, account.publicKey);
  return account;
}

/**
 * Encrypts `account`'s secret under `passphrase` and keeps it on this device,
 * removing any plain-text copy an earlier build left behind.
 */
export async function protectWallet(
  storage: KeyValueStore,
  account: WalletAccount,
  passphrase: string,
): Promise<void> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`A passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters is required`);
  }
  const sealed = await sealSecret(account.publicKey, hexToBytes(account.secretKeyHex), passphrase);
  storage.setItem(SEALED_SECRET_KEY, JSON.stringify(sealed));
  storage.setItem(ADDRESS_KEY, account.publicKey);
  storage.removeItem(LEGACY_SECRET_KEY);
}

/** Decrypts the wallet kept on this device. Null for a wrong passphrase or when there is no encrypted wallet. */
export async function unlockWallet(
  storage: KeyValueStore,
  passphrase: string,
): Promise<WalletAccount | null> {
  const sealed = parseSealedSecret(storage.getItem(SEALED_SECRET_KEY));
  if (!sealed) return null;
  const secret = await openSecret(sealed, passphrase);
  if (!secret) return null;
  try {
    const account = keypairToAccount(Keypair.fromSecretKey(secret));
    return account.publicKey === sealed.publicKey ? account : null;
  } catch {
    return null;
  } finally {
    secret.fill(0);
  }
}

/**
 * Throws if the secret is not a valid ed25519 keypair, and (unless
 * `replace` is set) when a different wallet is kept on this device or held
 * in memory (`heldAddress`, a wallet not saved yet, which storage alone
 * cannot tell from one already lost): importing over it would lose that
 * wallet for good if its secret was never saved elsewhere. Importing the
 * wallet already kept here changes nothing. A replaced wallet, or one whose
 * secret was lost before it was ever kept, is forgotten entirely
 * (`clearWallet`). Like a new one, the imported secret is held in memory
 * until `protectWallet` encrypts it.
 */
export function importWallet(
  storage: KeyValueStore,
  secretHex: string,
  options: { replace?: boolean; heldAddress?: string | null } = {},
): WalletAccount {
  const account = accountFromHex(secretHex);
  const kept = keptWalletAddress(storage);
  if (kept === account.publicKey) return account;
  const current = kept ?? options.heldAddress;
  if (current && current !== account.publicKey && !options.replace) {
    throw new WalletExistsError(current);
  }
  if (storedWalletAddress(storage) !== account.publicKey) clearWallet(storage);
  storage.setItem(ADDRESS_KEY, account.publicKey);
  return account;
}

/**
 * Forgets this device's wallet: its secret in every form, and the order
 * secrets, key checkpoint and grant flag kept under its address (and under
 * the address record, should that name another wallet), which would
 * otherwise still link that address to its fills on the public tape.
 */
export function clearWallet(storage: KeyValueStore): void {
  const addresses = new Set([keptWalletAddress(storage), storage.getItem(ADDRESS_KEY)]);
  for (const address of addresses) {
    if (!address) continue;
    for (const keyFor of Object.values(ownerDataKeys)) storage.removeItem(keyFor(address));
  }
  storage.removeItem(SEALED_SECRET_KEY);
  storage.removeItem(LEGACY_SECRET_KEY);
  storage.removeItem(ADDRESS_KEY);
}

/** A no-op store when localStorage isn't available (server render). */
export function browserLocalStorage(): KeyValueStore {
  if (typeof window === "undefined" || !window.localStorage) {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
  return window.localStorage;
}
