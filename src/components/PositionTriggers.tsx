"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatClockTime, formatDecimal, formatMoney } from "@/lib/format";
import { marketDisplayName } from "@/lib/market-data/displayName";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";
import type { MarketInfo } from "@/lib/market-data/types";
import { fromFixedPoint, withoutSign } from "@/lib/trading/decimal";
import {
  bpsFromMark,
  DEFAULT_TRIGGER_SLIPPAGE_BPS,
  describeSaveScope,
  describeTriggerError,
  describeTriggerLine,
  describeUnfillable,
  estimatedPnl,
  formatBpsFromMark,
  percentFromBps,
  planTriggerChanges,
  positionIsLong,
  priceFromBps,
  slippageBpsFromPercent,
  TRIGGER_KINDS,
  TRIGGER_NAME,
  TRIGGER_SHORT,
  triggerExists,
  validateTriggerDraft,
  worstPriceFor,
  type TriggerDraft,
  type TriggerTone,
} from "@/lib/trading/triggers";
import type { LocalTriggers } from "@/lib/trading/triggerStore";
import type { MarketLimits, Position, TriggerKind } from "@/lib/trading/types";
import type {
  PositionTriggerControls,
  TriggerApplyResult,
  TriggerStep,
} from "@/components/hooks/usePositionTriggers";
import { btnGhost, btnPrimary, input } from "@/components/ui/styles";

const TONE_CLASS: Record<TriggerTone, string> = {
  ok: "text-safe",
  warn: "text-warning",
  muted: "text-faint",
};

/** How far from the mark the quick picks sit, in basis points: a take profit reaches further than a stop loss. */
const PRESET_BPS: Record<TriggerKind, number[]> = {
  takeProfit: [200, 500, 1000],
  stopLoss: [100, 200, 500],
};

const TRIGGER_RECHECK_MS = 60_000;

const clockSeconds = (ms: number): string => formatClockTime(new Date(ms)).slice(0, 8);
const clockMinutes = (ms: number): string => formatClockTime(new Date(ms)).slice(0, 5);

function rememberedTitle(setAtMs: number | null): string {
  return setAtMs === null
    ? "Remembered on this device. The exchange keeps the price sealed."
    : `Remembered on this device, set ${clockMinutes(setAtMs)}. The exchange keeps the price sealed.`;
}

/** The take profit and stop loss of one position, in the words the exchange's report allows, with the way to change them. */
export function TriggerRow({
  position,
  settings,
  controls,
  onEdit,
}: {
  position: Position;
  settings: MarketInfo | undefined;
  controls: PositionTriggerControls;
  onEdit: () => void;
}) {
  const { refresh } = controls;
  useEffect(() => {
    refresh(position.market, position.size);
  }, [refresh, position.market, position.size]);

  const statuses = controls.statusesFor(position.market);
  const local = controls.localFor(position.market);
  const priceDecimals = settings ? priceDecimalsOf(settings) : 2;
  const lines = TRIGGER_KINDS.flatMap((kind) => {
    const line = describeTriggerLine({
      kind,
      chain: statuses ? statuses[kind] : null,
      readAtMs: statuses ? statuses.readAtMs : null,
      local: local[kind],
      formatTime: clockSeconds,
      stale: statuses?.stale === true,
      formatCheckTime: clockMinutes,
    });
    return line ? [line] : [];
  });
  const hasTrigger = lines.length > 0;
  useEffect(() => {
    if (!hasTrigger) return;
    const timer = setInterval(
      () => refresh(position.market, position.size, true),
      TRIGGER_RECHECK_MS,
    );
    return () => clearInterval(timer);
  }, [hasTrigger, refresh, position.market, position.size]);
  return (
    <div className="border-line-subtle mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t pt-3">
      {lines.length === 0 ? (
        <p className="text-faint min-w-0 flex-1 basis-40 text-[12px]">
          {statuses ? "No take profit or stop loss" : "Checking take profit and stop loss"}
        </p>
      ) : (
        <ul className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
          {lines.map((line) => (
            <li key={line.kind} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
              <span className="text-faint" aria-hidden="true">
                {TRIGGER_SHORT[line.kind]}
              </span>
              <span className="sr-only">{TRIGGER_NAME[line.kind]}</span>
              {line.price !== null ? (
                <span className="tnum text-ink" title={rememberedTitle(line.setAtMs)}>
                  {formatDecimal(line.price, priceDecimals)}
                  <span className="text-faint ml-1 text-[11px] font-normal">
                    set on this device
                  </span>
                </span>
              ) : (
                <span
                  className="text-dim"
                  title="Set on another device. The exchange keeps the price sealed."
                >
                  Set elsewhere
                </span>
              )}
              <span className={TONE_CLASS[line.tone]}>{line.status}</span>
              {line.detail && <span className="tnum text-faint">{line.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className={`${btnGhost} shrink-0 text-[12px]`}
        aria-haspopup="dialog"
        onClick={onEdit}
      >
        {lines.length === 0 ? "Add TP/SL" : "Edit TP/SL"}
      </button>
    </div>
  );
}

/** What the last change came to, in the same quiet style as the last order. */
export function TriggerNotice({ controls }: { controls: PositionTriggerControls }) {
  const { notice } = controls;
  if (!notice) return null;
  const problem = notice.failure !== null;
  return (
    <div
      className="bg-surface-raised rounded-tile mb-2 flex items-start justify-between gap-2 px-3 py-2 text-[12px]"
      role={problem ? "alert" : "status"}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-dim">TP/SL · {marketDisplayName(notice.market)}</p>
        {notice.lines.map((line) => (
          <p key={line} className="text-ink font-medium">
            {line}
          </p>
        ))}
        {notice.failure && <p className="text-danger font-medium">{notice.failure}</p>}
      </div>
      <button
        type="button"
        className="text-dim hover:text-ink min-h-11 shrink-0 px-2"
        onClick={controls.dismissNotice}
      >
        Dismiss
      </button>
    </div>
  );
}

const NOTHING_REMOVED: Record<TriggerKind, boolean> = { takeProfit: false, stopLoss: false };

function startingDraft(local: LocalTriggers): TriggerDraft {
  const sized = TRIGGER_KINDS.map((kind) => local[kind]).find((entry) => entry?.size != null);
  const known = local.takeProfit ?? local.stopLoss;
  return {
    takeProfit: local.takeProfit?.price ?? "",
    stopLoss: local.stopLoss?.price ?? "",
    whole: !sized,
    size: sized?.size ?? "",
    slippagePercent: percentFromBps(known?.slippageBps ?? DEFAULT_TRIGGER_SLIPPAGE_BPS),
  };
}

function focusable(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    ),
  ];
}

/**
 * The take profit and stop loss of one position. A centred dialog from the
 * small-tablet width up, a sheet from the bottom edge below it. A portal to
 * `document.body`, for the same reason as the order dialogs: a dock panel has
 * a transform, which would otherwise pin a fixed box to the panel.
 */
export function TriggerEditor({
  position,
  settings,
  mark,
  limits,
  quoteSymbol,
  controls,
  onClose,
}: {
  position: Position;
  settings: MarketInfo;
  /** The fresh mark, or null when there is none. */
  mark: string | null;
  limits: MarketLimits | undefined;
  quoteSymbol: string;
  controls: PositionTriggerControls;
  onClose: () => void;
}) {
  const long = positionIsLong(position.size);
  const priceDecimals = priceDecimalsOf(settings);
  const sizeDecimals = sizeDecimalsOf(settings);
  const heldSize = withoutSign(position.size);
  const statuses = controls.statusesFor(position.market);
  const local = controls.localFor(position.market);

  const [initial] = useState(() => startingDraft(local));
  const [draft, setDraft] = useState<TriggerDraft>(initial);
  const [remove, setRemove] = useState(NOTHING_REMOVED);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [completed, setCompleted] = useState<string[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const titleId = useId();
  const fieldId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const { refresh } = controls;
  const positionSize = position.size;
  const positionMarket = position.market;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstFieldRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    refresh(positionMarket, positionSize, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const context = {
    long,
    mark,
    tick: settings.tickSize,
    lot: settings.lotSize,
    positionSize: heldSize,
    minSize: limits?.minSize,
    bandBps: limits?.bandBps,
  };
  const errors = validateTriggerDraft(draft, context);
  const exists = {
    takeProfit: triggerExists(statuses ? statuses.takeProfit : null, local.takeProfit),
    stopLoss: triggerExists(statuses ? statuses.stopLoss : null, local.stopLoss),
  };
  const changes = planTriggerChanges({ draft, initial, exists, remove });
  const saveScope = describeSaveScope({ changes, exists, local });
  const hasErrors = Object.keys(errors).length > 0;
  const slippageBps = slippageBpsFromPercent(draft.slippagePercent);
  const pnlSize = draft.whole ? heldSize : errors.size ? null : draft.size.trim();
  const errorContext = { ...context, base: settings.base, quote: settings.quote };

  function setPrice(kind: TriggerKind, value: string) {
    setDraft((prev) => ({ ...prev, [kind]: value }));
    setRemove((prev) => ({ ...prev, [kind]: false }));
    setFailure(null);
  }

  function removeTrigger(kind: TriggerKind) {
    setDraft((prev) => ({ ...prev, [kind]: "" }));
    setRemove((prev) => ({ ...prev, [kind]: true }));
    setFailure(null);
  }

  function worstPrice(kind: TriggerKind): string | null {
    if (!draft[kind].trim() || errors[kind] || slippageBps === null || errors.slippage) return null;
    return worstPriceFor({
      triggerPrice: draft[kind].trim(),
      long,
      slippageBps,
      tick: settings.tickSize,
      priceDecimals,
    });
  }

  async function save() {
    if (busy || hasErrors || changes.length === 0 || slippageBps === null) return;
    const steps: TriggerStep[] = [];
    for (const change of changes) {
      if (change.op === "cancel") {
        steps.push({ op: "cancel", kind: change.kind });
        continue;
      }
      const price = draft[change.kind].trim();
      const worst = worstPrice(change.kind);
      if (worst === null) return;
      const size = draft.whole ? null : draft.size.trim();
      steps.push({
        op: "set",
        request: { kind: change.kind, price, worstPrice: worst, size },
        remember: { price, size, slippageBps, long },
      });
    }
    setBusy(true);
    setFailure(null);
    setCompleted([]);
    let result: TriggerApplyResult;
    try {
      result = await controls.apply(position.market, steps);
    } finally {
      setBusy(false);
    }
    if (result.failure) {
      setCompleted(result.done);
      setFailure(result.failure);
    } else onClose();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !busy) {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const items = focusable(dialogRef.current);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className="bg-base/80 fixed inset-0 z-20 flex items-end justify-center sm:items-center sm:p-4"
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-surface border-line-strong max-sm:rounded-t-panel sm:rounded-panel flex max-h-[92dvh] w-full flex-col overflow-hidden border max-sm:border-b-0 sm:max-w-md"
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          noValidate
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-5">
            <div>
              <h2 id={titleId} className="text-ink-strong text-[14px] font-medium">
                Take profit and stop loss
              </h2>
              <p className="tnum text-faint mt-1 text-[12px]">
                {long ? "Long" : "Short"} {formatDecimal(heldSize, sizeDecimals)} {settings.base} ·
                Mark {mark !== null ? formatDecimal(mark, priceDecimals) : "unavailable"} ·
                Break-even {formatDecimal(position.entryPrice, priceDecimals)}
              </p>
            </div>

            {TRIGGER_KINDS.map((kind, index) => {
              const text = draft[kind].trim();
              const error = errors[kind];
              const fromMark = text && !error && mark !== null ? bpsFromMark(text, mark) : null;
              const pnl =
                text && !error && pnlSize !== null
                  ? estimatedPnl({ long, entry: position.entryPrice, price: text, size: pnlSize })
                  : null;
              const above = kind === "takeProfit" ? long : !long;
              const chain = statuses && !statuses.stale ? statuses[kind] : null;
              return (
                <div key={kind} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor={`${fieldId}-${kind}`} className="text-ink text-[13px]">
                      {TRIGGER_NAME[kind]} price
                    </label>
                    {exists[kind] && !remove[kind] && (
                      <button
                        type="button"
                        className="text-dim hover:text-ink min-h-11 px-2 text-[12px] underline"
                        onClick={() => removeTrigger(kind)}
                      >
                        Remove
                      </button>
                    )}
                    {remove[kind] && (
                      <button
                        type="button"
                        className="text-dim hover:text-ink min-h-11 px-2 text-[12px] underline"
                        onClick={() => setPrice(kind, initial[kind])}
                      >
                        Undo remove
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      ref={index === 0 ? firstFieldRef : undefined}
                      id={`${fieldId}-${kind}`}
                      className={`${input} tnum min-h-11 pr-16 ${error ? "border-danger" : ""}`}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder={
                        remove[kind]
                          ? "Removed when you save"
                          : exists[kind] && !text
                            ? "Set on another device"
                            : "Not set"
                      }
                      value={draft[kind]}
                      disabled={remove[kind]}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={`${fieldId}-${kind}-note`}
                      onChange={(event) => setPrice(kind, event.target.value)}
                    />
                    <span className="text-faint pointer-events-none absolute inset-y-0 right-3 flex items-center text-[12px]">
                      {quoteSymbol}
                    </span>
                  </div>
                  <div id={`${fieldId}-${kind}-note`} className="flex flex-col gap-1 text-[12px]">
                    {error ? (
                      <p role="alert" className="text-danger">
                        {describeTriggerError(error, kind, errorContext)}
                      </p>
                    ) : fromMark !== null ? (
                      <p className="tnum text-dim">
                        {formatBpsFromMark(fromMark)} from mark
                        {pnl !== null && (
                          <>
                            {" · est. "}
                            <span className={pnl >= 0n ? "text-safe" : "text-danger"}>
                              {pnl > 0n ? "+" : ""}
                              {formatMoney(fromFixedPoint(pnl, 2), quoteSymbol)}
                            </span>
                          </>
                        )}
                      </p>
                    ) : (
                      <p className="text-faint">
                        {above ? "Above" : "Below"} the mark price
                        {mark !== null
                          ? `, ${kind === "takeProfit" ? "to take a profit" : "to limit the loss"}.`
                          : "."}
                      </p>
                    )}
                    {kind === "takeProfit" && pnl !== null && pnl < 0n && (
                      <p className="text-warning">
                        {long ? "Below" : "Above"} your entry price, so it would close at a loss.
                      </p>
                    )}
                    {chain?.state === "unfillable" && (
                      <p className="text-warning">
                        {describeUnfillable(kind, chain, clockMinutes)}
                      </p>
                    )}
                    {chain?.state === "blockedByRestingOrders" && (
                      <p className="text-warning">
                        Your open orders in this market hold the margin it needs. Cancelling one of
                        them may let the next attempt go through.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Quick picks">
                    {PRESET_BPS[kind].map((bps) => {
                      const signed = above ? bps : -bps;
                      const preset =
                        mark !== null
                          ? priceFromBps(signed, mark, settings.tickSize, priceDecimals)
                          : null;
                      return (
                        <button
                          key={bps}
                          type="button"
                          disabled={preset === null || remove[kind]}
                          className="border-line text-dim hover:bg-surface-raised tnum rounded-tile min-h-11 flex-1 border px-2 text-[12px] disabled:cursor-not-allowed disabled:opacity-40"
                          aria-label={`${TRIGGER_NAME[kind]} ${formatBpsFromMark(signed)} from mark`}
                          onClick={() => preset !== null && setPrice(kind, preset)}
                        >
                          {formatBpsFromMark(signed)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            <fieldset className="flex flex-col gap-2">
              <legend className="text-ink mb-2 text-[13px]">Size</legend>
              <div className="flex gap-2" role="group" aria-label="Size to close">
                {[
                  { whole: true, label: "Whole position" },
                  { whole: false, label: "Amount" },
                ].map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={draft.whole === option.whole}
                    className={`rounded-tile min-h-11 flex-1 border text-[13px] ${
                      draft.whole === option.whole
                        ? "bg-elevated text-ink-strong border-line-strong"
                        : "border-line text-dim hover:bg-surface-raised"
                    }`}
                    onClick={() => {
                      setDraft((prev) => ({ ...prev, whole: option.whole }));
                      setFailure(null);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {!draft.whole && (
                <>
                  <div className="relative">
                    <input
                      id={`${fieldId}-size`}
                      aria-label="Amount to close"
                      className={`${input} tnum min-h-11 pr-16 ${errors.size ? "border-danger" : ""}`}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder={`Up to ${formatDecimal(heldSize, sizeDecimals)}`}
                      value={draft.size}
                      aria-invalid={errors.size ? true : undefined}
                      aria-describedby={errors.size ? `${fieldId}-size-note` : undefined}
                      onChange={(event) => {
                        setDraft((prev) => ({ ...prev, size: event.target.value }));
                        setFailure(null);
                      }}
                    />
                    <span className="text-faint pointer-events-none absolute inset-y-0 right-3 flex items-center text-[12px]">
                      {settings.base}
                    </span>
                  </div>
                  {errors.size && (
                    <p id={`${fieldId}-size-note`} role="alert" className="text-danger text-[12px]">
                      {describeTriggerError(errors.size, null, errorContext)}
                    </p>
                  )}
                </>
              )}
            </fieldset>

            <details
              className="group flex flex-col gap-2"
              open={advancedOpen || Boolean(errors.slippage)}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            >
              <summary
                className="text-dim hover:text-ink min-h-11 cursor-pointer content-center text-[13px]"
                onClick={(event) => errors.slippage && event.preventDefault()}
              >
                Advanced
              </summary>
              <label htmlFor={`${fieldId}-slippage`} className="text-ink block text-[13px]">
                Slippage
              </label>
              <div className="relative mt-2">
                <input
                  id={`${fieldId}-slippage`}
                  className={`${input} tnum min-h-11 pr-10 ${errors.slippage ? "border-danger" : ""}`}
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft.slippagePercent}
                  aria-invalid={errors.slippage ? true : undefined}
                  aria-describedby={`${fieldId}-slippage-note`}
                  onChange={(event) => {
                    setDraft((prev) => ({ ...prev, slippagePercent: event.target.value }));
                    setFailure(null);
                  }}
                />
                <span className="text-faint pointer-events-none absolute inset-y-0 right-3 flex items-center text-[12px]">
                  %
                </span>
              </div>
              <div
                id={`${fieldId}-slippage-note`}
                className="tnum mt-2 flex flex-col gap-1 text-[12px]"
              >
                {errors.slippage ? (
                  <p role="alert" className="text-danger">
                    {describeTriggerError(errors.slippage, null, errorContext)}
                  </p>
                ) : (
                  <p className="text-faint">
                    {TRIGGER_KINDS.map((kind) => ({ kind, worst: worstPrice(kind) }))
                      .filter((entry) => entry.worst !== null)
                      .map(
                        (entry) =>
                          `${TRIGGER_SHORT[entry.kind]} worst price ${formatDecimal(entry.worst!, priceDecimals)}`,
                      )
                      .join(" · ") ||
                      "The worst price a trigger may fill at, set from its trigger price."}
                  </p>
                )}
                <p className="text-faint">Fires on the mark price as a reduce-only market order.</p>
              </div>
            </details>
          </div>

          <div className="border-line-subtle flex shrink-0 flex-col gap-3 border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-5">
            <p className="text-faint text-[12px]">
              Not a guaranteed exit: it may fill only part, or not at all.
            </p>
            {failure && (
              <div role="alert" className="flex flex-col gap-1 text-[12px]">
                {completed.map((line) => (
                  <p key={line} className="text-ink">
                    {line}
                  </p>
                ))}
                <p className="text-danger">{failure}</p>
              </div>
            )}
            {saveScope.length > 0 && (
              <div className="text-faint flex flex-col gap-0.5 text-[12px]">
                {saveScope.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                className={`${btnGhost} h-11 flex-1`}
                disabled={busy}
                onClick={onClose}
              >
                Back
              </button>
              <button
                type="submit"
                className={`${btnPrimary} h-11 flex-1`}
                disabled={busy || hasErrors || changes.length === 0}
              >
                {busy ? "Saving" : "Save"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
