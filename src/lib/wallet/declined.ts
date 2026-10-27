const WALLET_REJECTED_CODE = 4001;
const MAX_CAUSE_DEPTH = 3;

/** The error classes a wallet adapter throws when the owner turns a signing request down or closes its window. */
const WALLET_DECLINE_NAMES: ReadonlySet<string> = new Set([
  "WalletSignTransactionError",
  "WalletSignMessageError",
  "WalletWindowClosedError",
]);

/** Errors this app throws itself. Their sentences may contain "refused" or "cancel" without the owner having declined anything. */
const APP_ERROR_NAMES: ReadonlySet<string> = new Set([
  "NetworkRefused",
  "StaleSigner",
  "SignedTransactionRefused",
  "OwnerActionRefused",
  "OwnerActionFailed",
]);

/** The wording wallets use for a turned-down request; none of this app's own sentences is phrased this way. */
const DECLINE_WORDS =
  /\buser (?:rejected|declined|denied|cancell?ed)\b|\b(?:request|transaction|signature|message) (?:was |has been )?(?:rejected|declined|denied|cancell?ed)\b|\brejected the request\b/i;

/**
 * Whether the owner turned a wallet request down. Only wallet signals count:
 * the wallet's rejection code (4001), a wallet adapter's error class, or the
 * wording wallets use. Free text from this app's own errors never does.
 */
export function isWalletDecline(error: unknown, depth = 0): boolean {
  if (typeof error === "string") return DECLINE_WORDS.test(error);
  if (typeof error !== "object" || error === null) return false;
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  if (code === WALLET_REJECTED_CODE) return true;
  const name = error instanceof Error ? error.name : "";
  if (APP_ERROR_NAMES.has(name)) return false;
  if (WALLET_DECLINE_NAMES.has(name)) return true;
  if (error instanceof Error && DECLINE_WORDS.test(error.message)) return true;
  return cause !== undefined && depth < MAX_CAUSE_DEPTH && isWalletDecline(cause, depth + 1);
}
