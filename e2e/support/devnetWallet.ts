import fs from "node:fs";
import path from "node:path";

/**
 * Devnet seats are scarce (the exchange allows 100 new accounts a day; a
 * funding grant is once per address), so this suite creates a wallet once
 * and persists its secret here (git-ignored) for every later run to reuse,
 * rather than a fresh keypair per run.
 */
const WALLET_FILE = path.join(process.cwd(), "e2e", ".devnet-wallet.json");
/**
 * The localStorage key earlier builds kept the plain secret under.
 * `src/lib/wallet/index.ts` still loads a wallet from it (unlocked, not yet
 * encrypted), which is how a reused wallet is primed on every page load.
 */
export const WALLET_STORAGE_KEY = "noirwire-terminal-wallet-secret";

export interface PersistedWallet {
  secretHex: string;
}

export function loadPersistedWallet(): PersistedWallet | null {
  try {
    const raw = fs.readFileSync(WALLET_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedWallet>;
    return typeof parsed.secretHex === "string" ? { secretHex: parsed.secretHex } : null;
  } catch {
    return null;
  }
}

export function savePersistedWallet(secretHex: string): void {
  fs.writeFileSync(WALLET_FILE, JSON.stringify({ secretHex }, null, 2) + "\n", "utf8");
}
