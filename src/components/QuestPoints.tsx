"use client";

import { useQuestSwitch } from "@/components/hooks/useQuests";

const QUEST_SWITCH_LABEL = "Earn MagicBlock quest points";
const QUEST_SWITCH_COPY = "While on, NoirWire records which of your trades count toward quests.";
const RENEWAL_COPY = "Needs renewal. Turn it on again to sign once more.";

function QuestSwitch({ owner }: { owner: string | null }) {
  const { status, busy, error, toggle } = useQuestSwitch(owner);
  const on = status === "on";
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={busy}
        onClick={toggle}
        className="text-ink inline-flex min-h-8 items-center gap-2 text-left disabled:opacity-40"
      >
        <span
          aria-hidden="true"
          className={`inline-flex h-4 w-7 shrink-0 items-center rounded-full border px-0.5 ${on ? "bg-ink-strong border-ink-strong justify-end" : "border-line-strong justify-start"}`}
        >
          <span className={`h-2.5 w-2.5 rounded-full ${on ? "bg-surface" : "bg-line-strong"}`} />
        </span>
        {QUEST_SWITCH_LABEL}
      </button>
      <span className="text-faint">{QUEST_SWITCH_COPY}</span>
      {status === "renew" && !busy && <span className="text-warning">{RENEWAL_COPY}</span>}
      {error && (
        <span role="alert" className="text-warning">
          {error}
        </span>
      )}
    </div>
  );
}

export function QuestOffer({ owner, onDismiss }: { owner: string | null; onDismiss: () => void }) {
  return (
    <div className="border-line text-dim rounded-tile flex flex-wrap items-start justify-between gap-2 border px-3 py-1.5 text-[12px]">
      <QuestSwitch owner={owner} />
      <button type="button" onClick={onDismiss} className="text-ink underline">
        Dismiss
      </button>
    </div>
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
