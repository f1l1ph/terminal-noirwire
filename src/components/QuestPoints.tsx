"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuestInvite, useQuestSwitch } from "@/components/hooks/useQuests";
import { onWalletMenuClosed, openWalletMenu } from "@/components/WalletWidget";
import { btnGhost, btnPrimary } from "@/components/ui/styles";
import { shouldOpenQuestDialog } from "@/lib/quests/invite";

const QUEST_SWITCH_COPY = "While on, NoirWire records which of your trades count toward quests.";
const RENEWAL_COPY = "Needs renewal. Turn it on again to sign once more.";

const QUEST_STEPS = [
  "Connect your wallet",
  "Turn on quest points (one signature)",
  "Make a trade of $50 or more",
] as const;

const QUESTS_HOW_IT_WORKS_URL = "https://quests.magicblock.app";

const BACKDROP_CLASS = "bg-base/80 fixed inset-0 z-30 flex items-center justify-center p-4";
const CARD_CLASS =
  "bg-surface border-line-strong rounded-panel max-h-full w-full max-w-sm overflow-y-auto border p-5";

function QuestStepList({ current }: { current: number }) {
  return (
    <ol className="mt-4 flex flex-col gap-1.5">
      {QUEST_STEPS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className={`rounded-tile flex items-center gap-3 border px-3 py-2 text-[13px] ${active ? "border-ink-strong text-ink-strong" : "border-line-subtle"} ${done ? "text-faint" : active ? "" : "text-dim"}`}
          >
            <span
              aria-hidden="true"
              className={`tnum inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${done ? "bg-ink-strong border-ink-strong text-(--color-base)" : active ? "border-ink-strong" : "border-line-strong"}`}
            >
              {done ? "✓" : index + 1}
            </span>
            <span>{label}</span>
            {done && <span className="sr-only">(done)</span>}
          </li>
        );
      })}
    </ol>
  );
}

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)"));
}

export function QuestInviteDialog({ owner }: { owner: string | null }) {
  const { dismissed, dismiss } = useQuestInvite();
  const { status, busy, error, toggle } = useQuestSwitch(owner);
  const [startedFor, setStartedFor] = useState<string | null>(null);
  const [pausedForWallet, setPausedForWallet] = useState(false);
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<Element | null>(null);

  if (pausedForWallet && owner) setPausedForWallet(false);
  if (startedFor !== null && owner !== startedFor) setStartedFor(null);

  const earning = owner !== null && startedFor === owner && status === "on" && !dismissed;
  const open =
    (earning || shouldOpenQuestDialog({ dismissed, status })) && !(pausedForWallet && !owner);

  useEffect(() => {
    if (!pausedForWallet) return;
    return onWalletMenuClosed(() => setPausedForWallet(false));
  }, [pausedForWallet]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement;
    const card = cardRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        return;
      }
      if (event.key !== "Tab" || !card) return;
      const items = focusableIn(card);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (!card.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const previous = returnFocusRef.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open, dismiss]);

  useEffect(() => {
    if (open) cardRef.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
  }, [open, earning]);

  if (!open) return null;

  const step = earning ? 2 : owner ? 1 : 0;

  return createPortal(
    <div
      className={BACKDROP_CLASS}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={CARD_CLASS}
      >
        {earning ? (
          <>
            <h2 id={titleId} className="text-ink-strong text-[16px] font-medium">
              You are earning quest points
            </h2>
            <p className="text-dim mt-2 text-[13px]">
              Make one trade of $50 or more to complete Get started on NoirWire. Points arrive with
              the Friday payout.
            </p>
            <QuestStepList current={step} />
            <button
              type="button"
              data-initial-focus
              className={`${btnPrimary} mt-5 h-11 w-full`}
              onClick={dismiss}
            >
              Start trading
            </button>
          </>
        ) : (
          <>
            <h2 id={titleId} className="text-ink-strong text-[16px] font-medium">
              Earn MagicBlock quest points
            </h2>
            <p className="text-dim mt-2 text-[13px]">
              Your trades on NoirWire can count toward your MagicBlock quests. Turn on quest points
              to start.
            </p>
            <QuestStepList current={step} />
            {status === "renew" && !busy && (
              <p className="text-warning mt-3 text-[12px]">{RENEWAL_COPY}</p>
            )}
            {error && (
              <p role="alert" className="text-warning mt-3 text-[12px]">
                {error}
              </p>
            )}
            <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
              {owner ? (
                <button
                  type="button"
                  data-initial-focus
                  disabled={busy}
                  className={`${btnPrimary} h-11 flex-1`}
                  onClick={() => {
                    setStartedFor(owner);
                    toggle();
                  }}
                >
                  {busy ? "Waiting for your wallet" : "Start earning points"}
                </button>
              ) : (
                <button
                  type="button"
                  data-initial-focus
                  className={`${btnPrimary} h-11 flex-1`}
                  onClick={() => {
                    setPausedForWallet(true);
                    openWalletMenu();
                  }}
                >
                  Connect wallet
                </button>
              )}
              <button type="button" className={`${btnGhost} h-11 flex-1`} onClick={dismiss}>
                Not now
              </button>
            </div>
            <a
              href={QUESTS_HOW_IT_WORKS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-dim hover:text-ink mt-4 block text-center text-[12px] underline"
            >
              New to MagicBlock? See how quest points work
            </a>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function QuestToggle({ owner }: { owner: string | null }) {
  const { status, busy, error, toggle } = useQuestSwitch(owner);
  if (!owner) return null;
  const on = status === "on";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={toggle}
      title={error ?? (status === "renew" ? RENEWAL_COPY : QUEST_SWITCH_COPY)}
      className="rounded-tile text-faint hover:text-ink inline-flex min-h-8 items-center gap-2 px-2 text-[12px] whitespace-nowrap transition-colors disabled:opacity-40"
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${on ? "bg-ink-strong" : status === "renew" ? "bg-warning" : "bg-line-strong"}`}
      />
      Quest points
    </button>
  );
}
