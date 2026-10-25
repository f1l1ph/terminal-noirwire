import type { AccountStatus, OpenAccountOutcome, OrderKeyState } from "./types";

export interface OpenNotice {
  /** `ok`: the account is open. `wait`: not settled, look again before acting. `error`: it did not open. */
  tone: "ok" | "wait" | "error";
  /** True when nothing reached the network, so pressing Open account again is safe. */
  nothingSent: boolean;
  /** True when Open account may be pressed again. */
  canRetry: boolean;
  text: string;
}

const notice = (
  tone: OpenNotice["tone"],
  text: string,
  { nothingSent = false, canRetry = true }: { nothingSent?: boolean; canRetry?: boolean } = {},
): OpenNotice => ({ tone, nothingSent, canRetry, text });

/**
 * What to tell the trader about the last attempt to open an account, in one
 * line. `status` is the owner's account as the view reads it right now: an
 * answer that left it doubtful whether the account opened is settled by that
 * read, and the line says what the read showed.
 */
export function describeOpenOutcome(
  outcome: OpenAccountOutcome,
  status: AccountStatus,
): OpenNotice {
  switch (outcome.kind) {
    case "opened":
      return notice("ok", "Your account is open.", { canRetry: false });
    case "alreadyOpen":
      return notice("ok", "Your account is already open.", { canRetry: false });
    case "notAvailable":
      return notice("error", "Accounts cannot be opened from here.", { canRetry: false });
    case "notSent":
      return notice("error", `Nothing was sent. ${outcome.reason} You can try again.`, {
        nothingSent: true,
      });
    case "refused":
      break;
  }
  const { refusal } = outcome;
  switch (refusal.kind) {
    case "mayBeOpen":
      if (status === "open") return notice("ok", "Your account is open.", { canRetry: false });
      return notice(
        "wait",
        status === "absent"
          ? "Checking your account. The request may have gone through, but the account does not show as open yet. Press Open account to check again."
          : "Checking your account. The request may have gone through, and the account could not be read just now. Press Open account to check again.",
      );
    case "accountOpen":
      return notice("ok", "Your account is already open.", { canRetry: false });
    case "notInvited":
      return notice(
        "error",
        "Nothing was sent. This address has no invite, or the code is wrong. Check the code and try again.",
        { nothingSent: true },
      );
    case "inviteUsed":
      return notice("error", "Nothing was sent. This invite code has already been used.", {
        nothingSent: true,
      });
    case "tooManyToday":
      return notice(
        "error",
        "Nothing was sent. All of today's new accounts are taken. Try again tomorrow.",
        { nothingSent: true },
      );
    case "tryLater":
      return notice("error", "Nothing was sent. The service is busy. Try again shortly.", {
        nothingSent: true,
      });
    case "prepareExpired":
      return notice("error", "Nothing was sent. The request timed out. Try again.", {
        nothingSent: true,
      });
    case "unreachable":
      return notice("error", "Could not reach NoirWire. Nothing was sent. Try again shortly.", {
        nothingSent: true,
      });
    case "badAnswer":
      return notice("error", "NoirWire gave an answer that could not be used. Nothing was sent.", {
        nothingSent: true,
      });
    case "rejected":
      return notice("error", `The request was turned away (status ${refusal.status}).`);
  }
}

export type KeysNotice = { kind: "settling"; secondsLeft: number } | { kind: "installing" };

/** What to show while this device's order keys are set up, or null once they are ready (or not yet known). */
export function keysNotice(keys: OrderKeyState | null, nowMs: number): KeysNotice | null {
  if (!keys) return null;
  if (keys.stage === "settling") {
    return {
      kind: "settling",
      secondsLeft: Math.max(0, Math.ceil((keys.readyAtMs - nowMs) / 1000)),
    };
  }
  if (keys.stage === "installing") return { kind: "installing" };
  return null;
}

/** True when this browser said it may not keep the device's trading keys, so trading from it is not recommended. */
export const keysMayNotPersist = (keys: OrderKeyState | null): boolean =>
  keys?.seedPersisted === false;
