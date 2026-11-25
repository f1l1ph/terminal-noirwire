import type { FailureReason, TookBucket } from "./analytics";
import type { OpenRefusal } from "./rollup/openClient";
import { isWalletDecline } from "./wallet/declined";

const MAX_CAUSE_DEPTH = 3;

const BY_NAME: Readonly<Record<string, FailureReason>> = {
  WalletWindowClosedError: "wallet_declined",
  WalletNotReadyError: "wallet_unavailable",
  WalletNotConnectedError: "wallet_unavailable",
  WalletConnectionError: "wallet_unavailable",
  WalletDisconnectedError: "wallet_unavailable",
  NetworkRefused: "wallet_unavailable",
  StaleSigner: "wallet_unavailable",
  AbortError: "request_timeout",
  TimeoutError: "request_timeout",
  SessionAuthError: "network_unreachable",
  RollupIdentityError: "network_unreachable",
  SessionRefused: "server_refused",
  SeedStorageError: "key_storage_unavailable",
};

/** The failure an HTTP status stands for. */
export function reasonForStatus(status: number): FailureReason {
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "request_timeout";
  if (status === 502 || status === 503) return "network_unreachable";
  if (status >= 400 && status < 600) return "server_refused";
  return "other";
}

function statusOf(error: object): number | null {
  const { status } = error as { status?: unknown };
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

/**
 * The failure a thrown value stands for, read from its class name and any
 * HTTP status it carries, on the error or its cause. The one exception is a
 * decline, which goes through `isWalletDecline` (code 4001 first, then the
 * fixed rejection wording wallets use) because several wallets reject without
 * the code. Nothing else about the message is read.
 */
export function failureReasonOf(error: unknown, depth = 0): FailureReason {
  if (isWalletDecline(error)) return "wallet_declined";
  if (typeof error !== "object" || error === null) return "other";
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  const named = BY_NAME[name];
  if (named) return named;
  const status = statusOf(error);
  if (status !== null) return reasonForStatus(status);
  const { cause } = error as { cause?: unknown };
  return cause !== undefined && depth < MAX_CAUSE_DEPTH
    ? failureReasonOf(cause, depth + 1)
    : "other";
}

/** The failure an open-account refusal stands for, or null when the refusal is not a failure (the account is already open). */
export function openRefusalReason(refusal: OpenRefusal): FailureReason | null {
  switch (refusal.kind) {
    case "notInvited":
    case "inviteCodeNeeded":
    case "inviteCodeWrong":
    case "inviteUsed":
      return "invite_required";
    case "tryLater":
      return "rate_limited";
    case "dailyCapReached":
    case "addressLimit":
      return "daily_cap";
    case "prepareExpired":
    case "mayBeOpen":
      return "request_timeout";
    case "unreachable":
      return "network_unreachable";
    case "badAnswer":
      return "server_refused";
    case "rejected":
      return reasonForStatus(refusal.status);
    case "accountOpen":
      return null;
  }
}

/** How long a step took before it failed, in coarse buckets so no exact timing is sent. */
export function tookBucket(elapsedMs: number): TookBucket {
  if (!(elapsedMs >= 0) || elapsedMs < 5_000) return "under_5s";
  if (elapsedMs < 30_000) return "5_30s";
  if (elapsedMs < 120_000) return "30_120s";
  return "over_120s";
}
