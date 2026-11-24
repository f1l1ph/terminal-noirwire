"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { syncUntilDone } from "@/lib/trading/fillSync";
import { userMessageLine } from "@/lib/userMessage";
import { browserLocalStorage } from "@/lib/wallet/index";
import {
  clearLocalTrigger,
  loadTriggerBook,
  setLocalTrigger,
  splitTriggerBook,
  type LocalTrigger,
  type LocalTriggerBook,
  type LocalTriggers,
} from "@/lib/trading/triggerStore";
import { describePartialFailure, TRIGGER_NAME } from "@/lib/trading/triggers";
import type {
  Position,
  TriggerKind,
  TriggerRequest,
  TriggerResult,
  TriggerStatuses,
} from "@/lib/trading/types";

/** One thing the editor asks for: set a trigger (with what this device will remember of it) or remove one. */
export type TriggerStep =
  | { op: "set"; request: TriggerRequest; remember: Omit<LocalTrigger, "setAtMs"> }
  | { op: "cancel"; kind: TriggerKind };

export interface TriggerApplyResult {
  /** What went through, one plain line each. */
  done: string[];
  /** Why it stopped, when it did; whatever follows it was not sent. */
  failure: string | null;
}

export interface TriggerNoticeState {
  market: string;
  lines: string[];
  failure: string | null;
}

/** Everything the positions list needs to show and change take profit and stop loss; null in the dock when they are not available. */
export interface PositionTriggerControls {
  statusesFor(market: string): TriggerStatuses | null;
  localFor(market: string): LocalTriggers;
  apply(market: string, steps: TriggerStep[]): Promise<TriggerApplyResult>;
  /**
   * Ask the exchange for the status of this market's triggers: once per
   * position size and side, and again when `force` is set (the editor opening).
   * A failed sync is tried again by the next call, never in a loop.
   */
  refresh(market: string, positionSize: string, force?: boolean): void;
  notice: TriggerNoticeState | null;
  dismissNotice(): void;
}

interface Source {
  owner: string | null;
  live: boolean;
  accountLoaded: boolean;
  positions: Record<string, Position>;
  statuses: Record<string, TriggerStatuses> | undefined;
  /** Why changes are off right now (trading is open in another tab), or null. */
  blocked: string | null;
  setTrigger: (market: string, request: TriggerRequest) => Promise<TriggerResult>;
  cancelTrigger: (market: string, kind: TriggerKind) => Promise<TriggerResult>;
  syncMarket: (market: string) => Promise<boolean>;
}

const NO_STATUSES: Record<string, TriggerStatuses> = {};
const NO_BOOK: LocalTriggerBook = {};
const NO_LOCAL: LocalTriggers = {};

async function settled(result: TriggerResult): Promise<TriggerResult> {
  return result.kind === "pending" ? settled(await result.pending.settled) : result;
}

function describeStep(step: TriggerStep, priceText: string | null): string {
  if (step.op === "cancel") return `${TRIGGER_NAME[step.kind]} removed.`;
  return `${TRIGGER_NAME[step.request.kind]} set at ${priceText ?? step.request.price}.`;
}

export function usePositionTriggers(source: Source): PositionTriggerControls | null {
  const { owner, live, accountLoaded, positions, statuses, blocked } = source;
  const { setTrigger, cancelTrigger, syncMarket } = source;
  const [book, setBook] = useState<{
    owner: string | null;
    live: boolean;
    entries: LocalTriggerBook;
  }>({ owner: null, live: false, entries: {} });
  const [notice, setNotice] = useState<TriggerNoticeState | null>(null);
  const synced = useRef(new Map<string, string>());
  const syncing = useRef(new Map<string, () => void>());

  if (book.owner !== owner || book.live !== live) {
    setBook({
      owner,
      live,
      entries: owner && live ? loadTriggerBook(browserLocalStorage(), owner) : {},
    });
  }

  const stateStatuses = statuses ?? NO_STATUSES;
  const entries = book.owner === owner && book.live === live ? book.entries : NO_BOOK;
  const { standing, forgotten } = useMemo(
    () =>
      accountLoaded
        ? splitTriggerBook(entries, positions, stateStatuses)
        : { standing: entries, forgotten: [] },
    [accountLoaded, entries, positions, stateStatuses],
  );
  useEffect(() => {
    if (!owner) return;
    const storage = browserLocalStorage();
    for (const { market, kinds } of forgotten) {
      for (const kind of kinds) clearLocalTrigger(storage, owner, market, kind);
    }
  }, [owner, forgotten]);

  useEffect(() => {
    const running = syncing.current;
    synced.current = new Map();
    return () => {
      for (const stop of running.values()) stop();
      running.clear();
    };
  }, [owner]);

  const refresh = useCallback(
    (market: string, positionSize: string, force = false) => {
      if (syncing.current.has(market)) return;
      if (!force && synced.current.get(market) === positionSize) return;
      synced.current.set(market, positionSize);
      syncing.current.set(
        market,
        syncUntilDone(
          () => syncMarket(market),
          () => syncing.current.delete(market),
        ),
      );
    },
    [syncMarket],
  );

  const apply = useCallback(
    async (market: string, steps: TriggerStep[]): Promise<TriggerApplyResult> => {
      if (!owner) return { done: [], failure: "No wallet is connected. Nothing was changed." };
      if (blocked) return { done: [], failure: blocked };
      const storage = browserLocalStorage();
      const done: string[] = [];
      let failure: string | null = null;
      let failedStep: TriggerStep | null = null;
      for (const step of steps) {
        let result: TriggerResult;
        const sentAtMs = Date.now();
        try {
          result = await settled(
            step.op === "set"
              ? await setTrigger(market, step.request)
              : await cancelTrigger(market, step.kind),
          );
        } catch (error) {
          failure = userMessageLine(error, { nothingSent: true });
          failedStep = step;
          break;
        }
        if (result.kind === "refused") {
          failure = result.reason;
          failedStep = step;
          break;
        }
        const next =
          step.op === "set"
            ? setLocalTrigger(storage, owner, market, step.request.kind, {
                ...step.remember,
                setAtMs: sentAtMs,
              })
            : clearLocalTrigger(storage, owner, market, step.kind);
        setBook({ owner, live, entries: next });
        done.push(describeStep(step, step.op === "set" ? step.remember.price : null));
      }
      if (failure !== null && failedStep !== null && done.length > 0) {
        failure = describePartialFailure(
          {
            op: failedStep.op,
            kind: failedStep.op === "set" ? failedStep.request.kind : failedStep.kind,
          },
          failure,
        );
        refresh(market, positions[market]?.size ?? "", true);
      }
      setNotice({ market, lines: done, failure });
      return { done, failure };
    },
    [owner, live, blocked, setTrigger, cancelTrigger, refresh, positions],
  );

  const statusesFor = useCallback(
    (market: string): TriggerStatuses | null => stateStatuses[market] ?? null,
    [stateStatuses],
  );
  const localFor = useCallback(
    (market: string): LocalTriggers => standing[market] ?? NO_LOCAL,
    [standing],
  );
  const dismissNotice = useCallback(() => setNotice(null), []);

  if (!live) return null;
  return { statusesFor, localFor, apply, refresh, notice, dismissNotice };
}
