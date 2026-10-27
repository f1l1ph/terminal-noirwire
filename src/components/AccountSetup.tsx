"use client";

import { useState, type ReactNode } from "react";
import { formatShortAddress } from "@/lib/format";
import {
  depositHelp,
  describeOpenOutcome,
  KEYS_NOT_PERSISTED_NOTE,
  keysMayNotPersist,
  keysNotice,
  keysSettleFraction,
  recheckOffer,
  setupSteps,
  type SetupStep,
} from "@/lib/trading/openCopy";
import { SETTLE_WAIT_MS } from "@/lib/rollup/orderKeySetup";
import type { AccountStatus, OpenAccountOutcome, OrderKeyState } from "@/lib/trading/types";
import { useWalletLamports } from "@/components/hooks/useWalletLamports";
import { btnGhost, btnPrimary } from "@/components/ui/styles";
import { openWalletMenu } from "@/components/WalletWidget";

const TONE_CLASS = { ok: "text-dim", wait: "text-warning", error: "text-danger" } as const;
const SEGMENT_CLASS = {
  done: "bg-safe",
  current: "bg-ink-strong",
  upcoming: "bg-line-subtle",
} as const;

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
  now,
  funded = null,
  depositsOpen,
}: {
  /** The connected address; null before a wallet is connected. */
  address: string | null;
  status: AccountStatus;
  needsInvite: boolean;
  opening: boolean;
  outcome: OpenAccountOutcome | null;
  onOpen: () => void;
  /** Runs the account check (and any key setup a failed attempt left undone) again. */
  onRecheck: () => Promise<void>;
  keys: OrderKeyState | null;
  now: number;
  /** Whether the trading account holds USDC; null while that is not known. */
  funded?: boolean | null;
  /** Whether this build offers deposits (whether the Funds section renders). */
  depositsOpen: boolean;
}) {
  const notice = outcome ? describeOpenOutcome(outcome, status) : null;
  const keyStep = keysNotice(keys, now);
  const offer = recheckOffer(status, keys);
  const [checking, setChecking] = useState(false);
  const { steps, ready } = setupSteps({ connected: address !== null, status, keys, funded });
  const current = steps.find((step) => step.state === "current")?.id ?? null;
  const walletLamports = useWalletLamports(address, current === "deposit" && depositsOpen);

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
        setChecking(true);
        void onRecheck().finally(() => setChecking(false));
      }}
    >
      {checking ? "Checking…" : offer === "retry" ? "Retry" : "Check again"}
    </button>
  );

  const settleFraction =
    keyStep?.kind === "settling" ? keysSettleFraction(keyStep.secondsLeft, SETTLE_WAIT_MS) : 0;

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
              onClick={openWalletMenu}
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
                Your account could not be read, so trading is off.
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
              Creates your private trading account. Your wallet asks you to approve one transaction;
              no funds move.
            </p>
            {(needsInvite || notice?.tone === "wait") && status !== "open" && (
              <button
                type="button"
                className={`${btnPrimary} mt-1 h-11 w-full`}
                disabled={opening}
                onClick={() => onOpen()}
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
            {keyStep?.kind === "settling" && (
              <div role="status">
                <p>Setting up trading on this device. Ready in about {keyStep.secondsLeft}s.</p>
                <div
                  className="bg-line-subtle mt-1 h-1.5 w-full overflow-hidden rounded-full"
                  role="progressbar"
                  aria-label="Trading key setup"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(settleFraction * 100)}
                >
                  <div
                    className="bg-ink-strong h-full rounded-full transition-[width] duration-700"
                    style={{ width: `${settleFraction * 100}%` }}
                  />
                </div>
              </div>
            )}
            {keyStep?.kind === "installing" && (
              <p role="status">
                Setting up trading on this device. Approve the request in your wallet.
              </p>
            )}
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
        return depositHelp(depositsOpen, walletLamports);
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
