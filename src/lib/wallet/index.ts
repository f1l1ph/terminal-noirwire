import { Keypair } from "@solana/web3.js";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = "noirwire-terminal-wallet-secret";

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

/** Test network only. The secret never leaves this device. */
export function createWallet(storage: KeyValueStore): WalletAccount {
  const account = keypairToAccount(Keypair.generate());
  storage.setItem(STORAGE_KEY, account.secretKeyHex);
  return account;
}

export function loadWallet(storage: KeyValueStore): WalletAccount | null {
  const hex = storage.getItem(STORAGE_KEY);
  if (!hex) return null;
  try {
    return keypairToAccount(Keypair.fromSecretKey(hexToBytes(hex)));
  } catch {
    return null;
  }
}

/** Throws if the secret is not a valid ed25519 keypair. */
export function importWallet(storage: KeyValueStore, secretHex: string): WalletAccount {
  const account = keypairToAccount(Keypair.fromSecretKey(hexToBytes(secretHex.trim())));
  storage.setItem(STORAGE_KEY, account.secretKeyHex);
  return account;
}

export function exportSecret(storage: KeyValueStore): string | null {
  return storage.getItem(STORAGE_KEY);
}

export function clearWallet(storage: KeyValueStore): void {
  storage.removeItem(STORAGE_KEY);
}

/** A no-op store when localStorage isn't available (server render). */
export function browserLocalStorage(): KeyValueStore {
  if (typeof window === "undefined" || !window.localStorage) {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
  return window.localStorage;
}
