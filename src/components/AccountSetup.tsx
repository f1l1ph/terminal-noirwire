"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { track, trackOnce, type AnalyticsEvent, type SetupStepId } from "@/lib/analytics";
import { openRefusalReason } from "@/lib/failureReason";
import { formatShortAddress } from "@/lib/format";
import {
  depositHelp,
  depositNeedsSol,
  describeOpenOutcome,
  gateAsksForInvite,
  KEYS_NOT_PERSISTED_NOTE,
  keysMayNotPersist,
  CANCELS_STOPS_NOTE,
  KEYS_ELSEWHERE_TITLE,
  KEYS_MOVED_TITLE,
  keysNotice,
  MOVE_TRADING_HERE,
  OPEN_RECHECK_ATTEMPTS,
  OPEN_RECHECK_EVERY_MS,
  recheckOffer,
  setupSteps,
  type SetupStep,
} from "@/lib/trading/openCopy";
import { SetupFunnel } from "@/lib/setupFunnel";
import type {
  AccountStatus,
  OpenAccountOutcome,
  OrderKeyState,
  OwnerAuth,
} from "@/lib/trading/types";
import { useWalletLamports } from "@/components/hooks/useWalletLamports";
import { btnGhost, btnPrimary, input } from "@/components/ui/styles";
import { openWalletMenu } from "@/components/WalletWidget";
import { StopReasonAsk } from "@/components/StopReasonAsk";

const TONE_CLASS = { ok: "text-dim", wait: "text-warning", error: "text-danger" } as const;
const SEGMENT_CLASS = {
  done: "bg-safe",
  current: "bg-ink-strong",
  upcoming: "bg-line-subtle",
} as const;

const SETUP_EVENTS: Record<string, AnalyticsEvent | undefined> = {
  connect: "wallet_connected",
  verify: "wallet_verified",
  open: "account_opened",
  keys: "keys_ready",
  deposit: "account_funded",
};

const sentThisPageLoad = new Set<string>();
const countedOutcomes = new WeakSet<OpenAccountOutcome>();
const funnel = new SetupFunnel();

const STATE_WORD = { done: "done", current: "current", upcoming: "not started" } as const;

/**
 * Mainnet only: the steps from a new visitor to a funded account, with the
 * live state of each. The connected address opens its account through the
 * invite list, and the device's trading keys are set up here.
 */
export function AccountSetup({
  address,
  status,
  needsInvite,
  opening,
  outcome,
  onOpen,
  onRecheck,
  keys,
  onMoveHere,
  ownerAuth = "transaction",
  funded = null,
  depositsOpen,
}: {
  /** The connected address; null before a wallet is connected. */
  address: string | null;
  status: AccountStatus;
  needsInvite: boolean;
  opening: boolean;
  outcome: OpenAccountOutcome | null;
  /** Opens the account; `invite` is the code typed, when the gate asked for one. */
  onOpen: (invite?: string) => void;
  /** Runs the account check (and any key setup a failed attempt left undone) again; `fresh` reads it through a new session. */
  onRecheck: (options?: { fresh?: boolean }) => Promise<void>;
  keys: OrderKeyState | null;
  /** Takes over trading from the device that holds the keys: one wallet signature, no fee. */
  onMoveHere: () => void;
  /** How the deployment has the owner consent to opening: by a message, or by a transaction in the wallet. */
  ownerAuth?: OwnerAuth;
  /** Whether the trading account holds USDC; null while that is not known. */
  funded?: boolean | null;
  /** Whether this build offers deposits (whether the Funds section renders). */
  depositsOpen: boolean;
}) {
  const notice = outcome ? describeOpenOutcome(outcome, status) : null;
  const keyStep = keysNotice(keys);
  const offer = recheckOffer(status, keys);
  const [checking, setChecking] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const asksForInvite = gateAsksForInvite(outcome);
  const waiting = notice?.tone === "wait" && status !== "open";
  const recheckRef = useRef(onRecheck);
  useEffect(() => {
    recheckRef.current = onRecheck;
  }, [onRecheck]);
  // An open that may have gone through is looked at again on its own for a
  // minute, so an account that lands late shows as open without a press.
  useEffect(() => {
    if (!waiting) return;
    let attempts = 0;
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      attempts += 1;
      running = true;
      void recheckRef
        .current({ fresh: true })
        .catch(() => {})
        .finally(() => {
          running = false;
        });
      if (attempts >= OPEN_RECHECK_ATTEMPTS) clearInterval(timer);
    }, OPEN_RECHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [waiting]);
  const { steps, ready } = setupSteps({ connected: address !== null, status, keys, funded });
  const current = steps.find((step) => step.state === "current")?.id ?? null;
  const walletLamports = useWalletLamports(address, current === "deposit" && depositsOpen);
  const showsNeedsSol = current === "deposit" && depositsOpen && depositNeedsSol(walletLamports);
  useEffect(() => {
    if (showsNeedsSol) trackOnce("deposit_needs_sol", "deposit_needs_sol");
  }, [showsNeedsSol]);
  const doneIds = steps
    .filter((step) => step.state === "done")
    .map((step) => step.id)
    .join(",");
  useEffect(() => {
    if (current) funnel.seen(current);
  }, [current]);
  useEffect(() => {
    for (const id of doneIds ? doneIds.split(",") : []) {
      funnel.done(id as SetupStepId);
      const event = SETUP_EVENTS[id];
      if (!event || sentThisPageLoad.has(id)) continue;
      sentThisPageLoad.add(id);
      track(event);
    }
  }, [doneIds]);
  useEffect(() => {
    if (status === "declined") funnel.failed("verify", "wallet_declined");
  }, [status]);
  const keyFailure = keys?.stage === "failed" ? (keys.failure ?? "other") : null;
  useEffect(() => {
    if (keyFailure) funnel.failed("keys", keyFailure);
  }, [keyFailure]);
  useEffect(() => {
    if (!outcome || countedOutcomes.has(outcome)) return;
    countedOutcomes.add(outcome);
    track("account_open_result", { result: outcome.kind });
    const reason =
      outcome.kind === "refused"
        ? openRefusalReason(outcome.refusal)
        : outcome.kind === "notSent"
          ? (outcome.failure ?? "other")
          : null;
    if (reason) funnel.failed("open", reason);
  }, [outcome]);
  useEffect(() => {
    if (!asksForInvite || sentThisPageLoad.has("invite")) return;
    sentThisPageLoad.add("invite");
    track("invite_asked");
  }, [asksForInvite]);

  if (ready) {
    return (
      <div className="border-line-subtle flex flex-col gap-0.5 border-b pb-1.5">
        <p className="text-safe text-[12px]" role="status">
          ✓ Ready to trade{address ? ` · ${formatShortAddress(address)}` : ""}
        </p>
        {keysMayNotPersist(keys) && (
          <p className="text-faint text-[11px]">{KEYS_NOT_PERSISTED_NOTE}</p>
        )}
      </div>
    );
  }

  const recheckButton = offer && (
    <button
      type="button"
      className={`${btnGhost} mt-1 h-11 w-full`}
      disabled={checking}
      onClick={() => {
        funnel.acted(offer === "retry" ? "keys" : "verify");
        setChecking(true);
        void onRecheck().finally(() => setChecking(false));
      }}
    >
      {checking
        ? "Checking…"
        : offer === "retry"
          ? "Retry"
          : status === "declined"
            ? "Try again"
            : "Check again"}
    </button>
  );

  if (
    current === "keys" &&
    (keyStep?.kind === "elsewhere" || keyStep?.kind === "moved" || keyStep?.kind === "installing")
  ) {
    return (
      <section aria-label="Trading device" className="border-line-subtle border-b pb-2">
        {keyStep.kind === "installing" ? (
          <div role="status">
            <h2 className="text-ink-strong text-[13px] font-medium">Moving trading here</h2>
            <p className="text-dim mt-0.5 text-[12px]">Approve in your wallet.</p>
          </div>
        ) : (
          <>
            <h2 className="text-ink-strong text-[13px] font-medium">
              {keyStep.kind === "moved" ? KEYS_MOVED_TITLE : KEYS_ELSEWHERE_TITLE}
            </h2>
            {keyStep.cancelsStops && (
              <p className="text-warning mt-1 text-[11px]">{CANCELS_STOPS_NOTE}</p>
            )}
            <button
              type="button"
              className={`${keyStep.kind === "moved" ? btnGhost : btnPrimary} mt-1.5 min-h-11 w-full`}
              onClick={() => {
                funnel.acted("keys");
                onMoveHere();
              }}
            >
              {MOVE_TRADING_HERE}
            </button>
          </>
        )}
        {keysMayNotPersist(keys) && (
          <p className="text-faint mt-1 text-[11px]">{KEYS_NOT_PERSISTED_NOTE}</p>
        )}
      </section>
    );
  }

  function detail(step: SetupStep): ReactNode {
    if (step.state === "upcoming") return null;
    switch (step.id) {
      case "connect":
        return step.state === "done" && address ? (
          <span className="tnum">{formatShortAddress(address)}</span>
        ) : (
          <>
            <p>Use Phantom or Solflare.</p>
            <button
              type="button"
              className={`${btnPrimary} mt-1 h-11 w-full`}
              onClick={() => {
                funnel.acted("connect");
                openWalletMenu();
              }}
            >
              Connect wallet
            </button>
          </>
        );
      case "verify":
        if (step.state === "done") return null;
        return (
          <>
            <p>
              Approve the sign-in message in your wallet. It proves you own this address and moves
              no funds.
            </p>
            {offer === "check" && (
              <p role="status" className="text-warning mt-0.5">
                {status === "declined"
                  ? "You declined the sign-in message, so trading is off. Try again and approve it in your wallet."
                  : "Your account could not be read, so trading is off."}
              </p>
            )}
            {offer === "check" && recheckButton}
          </>
        );
      case "open":
        if (step.state === "done") return null;
        return (
          <>
            <p>
              {ownerAuth === "message"
                ? "Sign a message to open your account. No transaction is sent from your wallet."
                : "Creates your private trading account. Your wallet asks you to approve one transaction; no funds move."}
            </p>
            {asksForInvite && status !== "open" && (
              <>
                <label className="text-faint mt-1 block text-[12px]" htmlFor="invite-code">
                  Invite code (optional)
                </label>
                <input
                  id="invite-code"
                  className={`${input} mt-1`}
                  autoComplete="off"
                  spellCheck={false}
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                />
              </>
            )}
            {(needsInvite || notice?.tone === "wait") && status !== "open" && (
              <button
                type="button"
                className={`${btnPrimary} mt-1 h-11 w-full`}
                disabled={opening}
                onClick={() => {
                  funnel.acted("open");
                  onOpen(inviteCode.trim() === "" ? undefined : inviteCode.trim());
                }}
              >
                {opening ? "Opening…" : "Open account"}
              </button>
            )}
            {notice && notice.tone !== "ok" && (
              <p
                role={notice.tone === "error" ? "alert" : "status"}
                className={`${TONE_CLASS[notice.tone]} mt-1`}
              >
                {notice.text}
              </p>
            )}
          </>
        );
      case "keys":
        if (step.state === "done") return null;
        return (
          <>
            {keyStep?.kind === "failed" && (
              <>
                <p role="alert" className="text-danger">
                  {keyStep.reason} Trading stays off until the keys are set up.
                </p>
                {recheckButton}
              </>
            )}
            {keyStep === null && <p>Trading keys are set up once your account is open.</p>}
            {keysMayNotPersist(keys) && (
              <p className="text-faint mt-1 text-[11px]">{KEYS_NOT_PERSISTED_NOTE}</p>
            )}
          </>
        );
      case "deposit":
        return (
          <>
            <p>{depositHelp(depositsOpen, walletLamports)}</p>
            <StopReasonAsk active={depositsOpen} />
          </>
        );
    }
  }

  const currentIndex = steps.findIndex((step) => step.id === current);
  const currentStep = steps[currentIndex];

  return (
    <section aria-label="Get ready to trade" className="border-line-subtle border-b pb-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-ink-strong text-[13px] font-medium">Get ready to trade</h2>
        <p className="text-faint tnum text-[11px]">
          Step {currentIndex + 1} of {steps.length}
        </p>
      </div>
      <ol className="mt-1.5 flex gap-1">
        {steps.map((step) => (
          <li
            key={step.id}
            title={step.label}
            aria-label={`${step.label}, ${STATE_WORD[step.state]}`}
            aria-current={step.id === current ? "step" : undefined}
            className={`h-1 flex-1 rounded-full ${SEGMENT_CLASS[step.state]}`}
          />
        ))}
      </ol>
      {currentStep && (
        <div className="mt-1.5">
          <p className="text-ink-strong text-[13px] leading-5 font-medium">{currentStep.label}</p>
          <div className="text-dim text-[12px]">{detail(currentStep)}</div>
        </div>
      )}
    </section>
  );
}
