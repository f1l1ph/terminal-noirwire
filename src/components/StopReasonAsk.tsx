"use client";

import { useEffect, useState } from "react";
import { track, type StopAnswer } from "@/lib/analytics";
import { browserStorage } from "@/lib/layout/persistedStore";
import { markStopReasonAsked, mayAskStopReason, STOP_ASK_AFTER_MS } from "@/lib/setupFunnel";

export const STOP_CHOICES: readonly { answer: Exclude<StopAnswer, "dismissed">; label: string }[] =
  [
    { answer: "just_looking", label: "Just looking" },
    { answer: "no_usdc_now", label: "No USDC right now" },
    { answer: "not_sure_what_to_do", label: "Not sure what to do" },
    { answer: "fees_or_minimum", label: "Fees or the minimum" },
    { answer: "something_broke", label: "Something broke" },
  ];

const CHIP =
  "border-line text-ink hover:bg-surface-raised min-h-9 rounded-full border px-3 text-[12px]";

/**
 * After a visitor has sat on the deposit step for a while, one question with
 * fixed answers: what stopped them. Asked once per browser, and only where
 * the browser can remember that it asked.
 */
export function StopReasonAsk({ active }: { active: boolean }) {
  const [phase, setPhase] = useState<"waiting" | "asking" | "answered" | "closed">("waiting");

  useEffect(() => {
    if (!active || phase !== "waiting") return;
    const timer = setTimeout(() => {
      const store = browserStorage();
      if (!mayAskStopReason(store)) return;
      markStopReasonAsked(store);
      setPhase("asking");
    }, STOP_ASK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [active, phase]);

  if (!active || phase === "waiting" || phase === "closed") return null;
  if (phase === "answered") {
    return (
      <p role="status" className="text-dim mt-2 text-[12px]">
        Thanks, that helps.
      </p>
    );
  }

  function answer(choice: StopAnswer) {
    track("deposit_stop_reason", { answer: choice });
    setPhase("answered");
  }

  return (
    <div
      role="group"
      aria-labelledby="stop-reason-title"
      className="border-line-subtle rounded-tile mt-2 border p-2"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p id="stop-reason-title" className="text-ink-strong text-[12px] font-medium">
          What stopped you?
        </p>
        <button
          type="button"
          className="text-faint hover:text-ink min-h-9 px-1 text-[12px]"
          onClick={() => {
            track("deposit_stop_reason", { answer: "dismissed" });
            setPhase("closed");
          }}
        >
          Not now
        </button>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {STOP_CHOICES.map((choice) => (
          <button
            key={choice.answer}
            type="button"
            className={CHIP}
            onClick={() => answer(choice.answer)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}
