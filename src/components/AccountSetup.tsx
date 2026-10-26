"use client";

import { useState, type ReactNode } from "react";
import { formatShortAddress } from "@/lib/format";
import {
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
import { btnGhost, btnPrimary } from "@/components/ui/styles";

const TONE_CLASS = { ok: "text-dim", wait: "text-warning", error: "text-danger" } as const;
const DEPOSITS_ON = process.env.NEXT_PUBLIC_DEPOSITS === "on";

function StepMark({ step, index }: { step: SetupStep; index: number }) {
  if (step.state === "done") {
    return (
      <span
        aria-hidden="true"
        className="bg-safe flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-(--color-base)"
      >
        ✓
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${
        step.state === "current"
          ? "border-ink-strong text-ink-strong"
          : "border-line-subtle text-faint"
      }`}
    >
      {index + 1}
    </span>
  );
}

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
}) {
  const notice = outcome ? describeOpenOutcome(outcome, status) : null;
  const keyStep = keysNotice(keys, now);
  const offer = recheckOffer(status, keys);
  const [checking, setChecking] = useState(false);
  const { steps, ready } = setupSteps({ connected: address !== null, status, keys, funded });
  const current = steps.find((step) => step.state === "current")?.id ?? null;

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
          "Choose Phantom or Solflare with the Connect wallet button at the top."
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
            <p>One button, no code. Your address must be on the invite list.</p>
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
        return DEPOSITS_ON
          ? "Add USDC from your wallet in the Funds section below the chart."
          : "Add USDC to your trading account to place your first order.";
    }
  }

  return (
    <section aria-label="Get ready to trade" className="border-line-subtle border-b pb-2">
      <h2 className="text-ink-strong text-[13px] font-medium">Get ready to trade</h2>
      <ol className="mt-1.5 flex flex-col gap-1.5">
        {steps.map((step, index) => (
          <li
            key={step.id}
            aria-current={step.id === current ? "step" : undefined}
            className={`flex items-start gap-2 ${step.state === "upcoming" ? "opacity-50" : ""}`}
          >
            <StepMark step={step} index={index} />
            <div className="min-w-0 flex-1">
              <p
                className={`text-[13px] leading-5 ${
                  step.state === "current" ? "text-ink-strong font-medium" : "text-ink"
                }`}
              >
                {step.label}
              </p>
              <div className="text-dim text-[12px]">{detail(step)}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
