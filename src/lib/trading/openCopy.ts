import { ROUND_TRIP_LAMPORTS, SOLANA_EXIT_LAMPORTS } from "../transfer/computeBudget";
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
 * A reason as the tail of "Nothing was sent: ...": any closing "Nothing was
 * sent." and full stop dropped, and a lone capital lowered so the clause reads
 * on from the colon (an acronym such as "RPC" keeps its capitals).
 */
function notSentClause(reason: string): string {
  const bare = reason
    .trim()
    .replace(/\s*Nothing was sent\.?$/i, "")
    .replace(/[.\s]+$/, "");
  const startsLone = /^[A-Z][a-z]/.test(bare);
  return startsLone ? `${bare.charAt(0).toLowerCase()}${bare.slice(1)}` : bare;
}

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
      return notice(
        "error",
        `Nothing was sent: ${notSentClause(outcome.reason)}. You can try again.`,
        {
          nothingSent: true,
        },
      );
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
        "Nothing was sent. This address is not on the invite list yet. Ask NoirWire to add it, then try again.",
        { nothingSent: true },
      );
    case "inviteCodeNeeded":
      return notice(
        "error",
        "Nothing was sent. This address was invited with a code. Enter the invite code you were given, then try again.",
        { nothingSent: true },
      );
    case "inviteCodeWrong":
      return notice(
        "error",
        "Nothing was sent. That invite code does not match this address. Check it and try again.",
        { nothingSent: true },
      );
    case "inviteUsed":
      return notice("error", "Nothing was sent. This address's invite has already been used.", {
        nothingSent: true,
      });
    case "addressLimit":
      return notice(
        "error",
        "Nothing was sent. This network address already opened an account today. Try again tomorrow, or from another connection.",
        { nothingSent: true },
      );
    case "dailyCapReached":
      return notice(
        "error",
        "Nothing was sent. All of today's new accounts are taken. New accounts open again at 00:00 UTC, so come back then.",
        { nothingSent: true },
      );
    case "tryLater":
      return notice(
        "error",
        "Nothing was sent. The service is busy or just starting. Try again in a few seconds.",
        { nothingSent: true },
      );
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
      return notice(
        "error",
        "Something was wrong with the request. Reload the page and try again.",
      );
  }
}

/**
 * Whether the last attempt showed the gate admits people by invite, so the
 * invite code field is worth showing: only a refusal that comes from the
 * invite list says so.
 */
export function gateAsksForInvite(outcome: OpenAccountOutcome | null): boolean {
  if (outcome?.kind !== "refused") return false;
  const { kind } = outcome.refusal;
  return (
    kind === "notInvited" ||
    kind === "inviteCodeNeeded" ||
    kind === "inviteCodeWrong" ||
    kind === "inviteUsed"
  );
}

/** While an open request "may have gone through", the account is looked at again this often, up to this many times, so it shows as open without a press. */
export const OPEN_RECHECK_EVERY_MS = 5_000;
export const OPEN_RECHECK_ATTEMPTS = 12;

export type KeysNotice =
  | { kind: "settling"; secondsLeft: number }
  | { kind: "installing" }
  | { kind: "failed"; reason: string };

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
  if (keys.stage === "failed") return { kind: "failed", reason: keys.reason };
  return null;
}

/** What the single retry button is for, or null when there is nothing to retry: an unread account, or key setup that failed. */
export function recheckOffer(
  status: AccountStatus,
  keys: OrderKeyState | null,
): "check" | "retry" | null {
  if (keys?.stage === "failed") return "retry";
  return status === "unknown" || status === "declined" ? "check" : null;
}

/**
 * True when the browser did not promise to keep this device's trading keys.
 * Most browsers answer this way for a new site, so it is a quiet note, never
 * a warning: a browser that cannot store the keys at all fails the key setup
 * itself, which is reported as a failure.
 */
export const keysMayNotPersist = (keys: OrderKeyState | null): boolean =>
  keys?.seedPersisted === false;

export const KEYS_NOT_PERSISTED_NOTE =
  "If your browser clears site data, you will set up trading on this device again. Your funds are not affected.";

/** The flows with the owner's last open-account outcome forgotten, so a later visit starts clean. */
export function withoutOpenOutcome<T extends { outcome: OpenAccountOutcome | null }>(
  flows: Record<string, T>,
  owner: string,
): Record<string, T> {
  const flow = flows[owner];
  if (!flow || flow.outcome === null) return flows;
  return { ...flows, [owner]: { ...flow, outcome: null } };
}

export type SetupStepId = "connect" | "verify" | "open" | "keys" | "deposit";
export type SetupStepState = "done" | "current" | "upcoming";

export interface SetupStep {
  id: SetupStepId;
  label: string;
  state: SetupStepState;
}

export const SETUP_LABELS: Record<SetupStepId, string> = {
  connect: "Connect wallet",
  verify: "Verify wallet",
  open: "Open account",
  keys: "Trading keys",
  deposit: "Deposit USDC",
};

const SETUP_ORDER: SetupStepId[] = ["connect", "verify", "open", "keys", "deposit"];

/**
 * The steps from a new visitor to a funded account, each done, current or
 * upcoming, from the state the view already holds. `funded` is null while the
 * balance is not known; an unknown balance is never read as funded.
 */
export function setupSteps(input: {
  connected: boolean;
  status: AccountStatus;
  keys: OrderKeyState | null;
  funded: boolean | null;
}): { steps: SetupStep[]; ready: boolean } {
  const { connected, status, keys, funded } = input;
  const keysActive = keys !== null;
  const verified = connected && ((status !== "unknown" && status !== "declined") || keysActive);
  const opened = verified && (status === "open" || (status === "unknown" && keysActive));
  const keysReady = opened && keys?.stage === "ready";
  const done: Record<SetupStepId, boolean> = {
    connect: connected,
    verify: verified,
    open: opened,
    keys: keysReady,
    deposit: keysReady && funded === true,
  };
  const currentId = SETUP_ORDER.find((id) => !done[id]);
  const steps = SETUP_ORDER.map((id): SetupStep => {
    const state = done[id] ? "done" : id === currentId ? "current" : "upcoming";
    return { id, label: SETUP_LABELS[id], state };
  });
  return { steps, ready: currentId === undefined };
}

const LAMPORTS_PER_SOL = 1_000_000_000;
const LAMPORTS_PER_CENT_OF_SOL = LAMPORTS_PER_SOL / 100;

/** A fee need in SOL rounded up to the hundredth, such as "0.04 SOL", so it is never understated. */
export function feeSolText(lamports: number): string {
  return `${(Math.ceil(lamports / LAMPORTS_PER_CENT_OF_SOL) / 100).toFixed(2)} SOL`;
}

function heldSolText(lamports: bigint): string {
  const sol = Number(lamports) / LAMPORTS_PER_SOL;
  return `${sol.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")} SOL`;
}

/**
 * What the deposit step says to do; it never asks for an action the page
 * cannot offer. It names the SOL a deposit and a later withdrawal cost in
 * network fees, and when the wallet's SOL is known to be short of that, says
 * so here rather than letting the deposit fail. `walletLamports` is null while
 * the balance is unknown.
 */
export function depositHelp(depositsOpen: boolean, walletLamports: bigint | null = null): string {
  if (!depositsOpen) return "Deposits open soon. You can explore the market until then.";
  const addUsdc = "Add USDC from your wallet in the Funds section of your account panel.";
  const depositFee = feeSolText(ROUND_TRIP_LAMPORTS);
  if (walletLamports !== null && walletLamports < BigInt(ROUND_TRIP_LAMPORTS)) {
    return `${addUsdc} Your wallet holds ${heldSolText(walletLamports)}, and a deposit needs about ${depositFee} for network fees. Add some SOL first. Nothing is charged until you deposit.`;
  }
  return `${addUsdc} Your wallet also needs about ${depositFee} for network fees on the deposit, and about ${feeSolText(SOLANA_EXIT_LAMPORTS)} again to withdraw.`;
}

/** How far through the trading-key wait this device is, 0 to 1. */
export function keysSettleFraction(secondsLeft: number, totalMs: number): number {
  const total = totalMs / 1000;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - secondsLeft / total));
}
