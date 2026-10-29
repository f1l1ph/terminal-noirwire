"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QUOTE_DECIMALS } from "@/lib/rollup/markets";
import {
  actionsOf,
  attentionOf,
  awaitsFinality,
  shortSignature,
  type Attention,
  type SeatJudgement,
} from "@/lib/transfer/attention";
import { atomsText } from "@/lib/transfer/amount";
import { newTransferBlocked, openTransfers } from "@/lib/transfer/resume";
import type { DismissOutcome } from "@/lib/transfer/dismiss";
import { userMessageLine } from "@/lib/userMessage";
import {
  createJournal,
  indexedDbStorage,
  isKeySweep,
  type OperationRecord,
} from "@/lib/transfer/journal";
import { btnGhost, sectionLabel } from "@/components/ui/styles";

/** What judging and dismissing a record needs: present only in a build with transfers on. */
export interface RecordsEngine {
  judge(records: OperationRecord[]): Promise<Record<string, SeatJudgement>>;
  dismiss(): Promise<DismissOutcome>;
  /** Carries an open record on with its own flow and says in plain words how it ended. */
  resume(attention: Attention, report: (line: string) => void): Promise<string>;
  /** Takes a deposit's tokens, or a return already begun, back to the wallet and says in plain words how it ended. */
  giveBack(attention: Attention, report: (line: string) => void): Promise<string>;
  /** What the deposit key still holds in the rollup, read without the wallet; null when nothing is waiting. */
  leftover(): Promise<bigint | null>;
  /** Puts what the deposit key holds into the account and says in plain words how it ended. */
  recover(report: (line: string) => void): Promise<string>;
  /** Closes the records that are complete and only waiting for finality, sending nothing. */
  settle(): Promise<void>;
  /** Sends the deposit key's spare SOL back to the wallet when no transfer is open, with the key alone; best effort. */
  sweep(): Promise<void>;
}

const RELOAD_MS = 20_000;

const OPERATION_LABEL: Record<Attention["operation"], string> = {
  deposit: "Deposit",
  withdraw: "Withdrawal",
  return: "Return to wallet",
  sweep: "Return of spare network fee money to your wallet",
};

const KIND_COPY: Record<Exclude<Attention["kind"], "not-landed">, string> = {
  waiting:
    "Not finished. It is still settling on the network. Do not start another transfer until it has.",
  unknown:
    "We cannot tell what happened to it. Wait, or contact support with the transfer id and the signature. It cannot be dismissed.",
};

/** What a row says about its state; a deposit that did not go through already took the USDC out of the wallet, so it is not "nothing moved". */
function kindCopy(item: Attention): string {
  if (item.stranded && item.kind === "waiting") {
    return "The exchange did not accept the last step of this deposit. Your USDC left your wallet and is safe, held by this browser's deposit key. The move into the rollup is still settling; do not start another transfer until it has.";
  }
  if (item.kind !== "not-landed") return KIND_COPY[item.kind];
  return item.operation === "deposit"
    ? "The last step did not go through. Your USDC already left your wallet and is safe in the rollup. Dismiss this, then use the button that appears to finish the deposit."
    : "It did not go through, and nothing moved by it. You can dismiss this and start again.";
}

/**
 * The transfers on record in this browser that are not finished, each with
 * what happened to it and what may be done. It reads the journal alone, so
 * a build with transfers off still shows a record left by an earlier one;
 * only with an `engine` is a record judged against the network and a
 * dismissal or resuming possible. Resuming runs the record's own flow, which
 * judges every earlier send first; no row ever offers to send one again.
 */
export function TransferRecords({
  owner,
  engine,
  refreshKey = 0,
  onBlocked,
  running = false,
  accountKnown = true,
}: {
  owner: string | null;
  engine: RecordsEngine | null;
  refreshKey?: number;
  /** Told whether a new transfer must wait: a record is open, or the records cannot be read. */
  onBlocked?: (blocked: boolean) => void;
  /** Whether a transfer started from this tab is running now, so its own record offers nothing to press. */
  running?: boolean;
  /** Whether it is known if the wallet has an open account: leftover USDC is not put in the account before that. */
  accountKnown?: boolean;
}) {
  const [items, setItems] = useState<Attention[]>([]);
  const [unreadable, setUnreadable] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [waiting, setWaiting] = useState<bigint | null>(null);
  const autoTried = useRef<string | null>(null);
  const autoRecover = useRef<() => void>(() => {});
  const runningNow = useRef(running);
  useEffect(() => {
    runningNow.current = running;
  }, [running]);

  useEffect(() => {
    if (!owner) return;
    let active = true;
    const load = async (lookForLeftover: boolean) => {
      try {
        const journal = createJournal(indexedDbStorage());
        let records = await journal.unfinished(owner);
        if (engine && !runningNow.current && records.some(awaitsFinality)) {
          await engine.settle().catch(() => {});
          records = await journal.unfinished(owner);
        }
        if (engine && !runningNow.current && records.every(isKeySweep)) {
          await engine.sweep().catch(() => {});
          records = await journal.unfinished(owner);
        }
        const judged =
          engine && records.some((record) => record.seat?.state === "pending")
            ? await engine.judge(records).catch(() => ({}) as Record<string, SeatJudgement>)
            : {};
        const leftover =
          engine && records.length === 0 && lookForLeftover
            ? await engine.leftover().catch(() => null)
            : null;
        if (!active) return;
        setItems(
          openTransfers(records).map((record) =>
            attentionOf(record, judged[record.id] ?? null, records),
          ),
        );
        if (records.length > 0) setWaiting(null);
        else if (lookForLeftover) setWaiting(leftover);
        if (leftover !== null && accountKnown && autoTried.current !== owner) {
          autoTried.current = owner;
          autoRecover.current();
        }
        setUnreadable(false);
        onBlocked?.(newTransferBlocked(records, false));
      } catch {
        if (!active) return;
        setUnreadable(true);
        onBlocked?.(newTransferBlocked([], true));
      }
    };
    void load(true);
    const timer = setInterval(() => void load(false), RELOAD_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [owner, engine, refreshKey, reload, onBlocked, accountKnown]);

  const dismiss = useCallback(async () => {
    if (!engine) return;
    setBusy(true);
    try {
      const outcome = await engine.dismiss();
      setNote(
        outcome.status === "dismissed"
          ? "Dismissed. Nothing was sent. You can start again."
          : "That record could not be dismissed. Nothing was changed.",
      );
    } catch {
      setNote("That record could not be dismissed. Nothing was changed.");
    } finally {
      setBusy(false);
      setReload((count) => count + 1);
    }
  }, [engine]);

  const resume = useCallback(
    async (item: Attention, how: "resume" | "return") => {
      if (!engine) return;
      setBusy(true);
      setNote(null);
      try {
        setNote(
          await (how === "return" ? engine.giveBack(item, setNote) : engine.resume(item, setNote)),
        );
      } catch (error) {
        setNote(`The transfer stopped. ${userMessageLine(error)} Nothing is sent again.`);
      } finally {
        setBusy(false);
        setReload((count) => count + 1);
      }
    },
    [engine],
  );

  const recover = useCallback(async () => {
    if (!engine) return;
    setBusy(true);
    setNote(null);
    try {
      setNote(await engine.recover(setNote));
    } catch (error) {
      setNote(`The transfer stopped. ${userMessageLine(error)} Nothing is sent again.`);
    } finally {
      setBusy(false);
      setReload((count) => count + 1);
    }
  }, [engine]);

  useEffect(() => {
    autoRecover.current = () => void recover();
  }, [recover]);

  const copy = (signature: string) => {
    try {
      void navigator.clipboard.writeText(signature).catch(() => {});
    } catch {
      // No clipboard here: the shortened signature on screen is all there is.
    }
  };

  if (!owner) return null;
  if (unreadable) {
    return (
      <p role="alert" className="text-danger border-line-subtle border-b p-3 text-[12px]">
        This browser could not read its saved transfers, so a new transfer cannot start. Reload the
        page. If it keeps happening, allow site data for this page or use a regular browser window.
      </p>
    );
  }
  if (items.length === 0 && !note && waiting === null) return null;
  return (
    <section className="border-line-subtle border-b p-3" aria-label="Transfers that need attention">
      <p className={sectionLabel}>Transfers that need attention</p>
      {engine && waiting !== null && items.length === 0 && (
        <div className="border-line-subtle rounded-tile mt-2 border p-2">
          <p className="text-ink text-[13px]">
            {atomsText(waiting, QUOTE_DECIMALS)} USDC is waiting to be credited
          </p>
          <p className="text-dim mt-1 text-[12px]">
            It is in the rollup, held by this browser&apos;s deposit key, and not yet in your
            account. Putting it in your account asks nothing of your wallet.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={`${btnGhost} px-2 text-[11px]`}
              disabled={busy || !accountKnown}
              onClick={() => void recover()}
            >
              {busy ? "Working..." : "Put it in my account"}
            </button>
          </div>
        </div>
      )}
      {items.map((item) => (
        <div key={item.id} className="border-line-subtle rounded-tile mt-2 border p-2">
          <p className="text-ink text-[13px]">
            {OPERATION_LABEL[item.operation]} of {atomsText(BigInt(item.atoms), QUOTE_DECIMALS)}{" "}
            USDC
          </p>
          <p className="text-dim mt-1 text-[12px]">{kindCopy(item)}</p>
          {engine && item.returnable && item.staged && (
            <p className="text-dim mt-1 text-[12px]">
              Your USDC left your wallet and is held by this browser&apos;s deposit key. &quot;Try
              the deposit again&quot; finishes moving it into your account, and &quot;Return to
              wallet&quot; sends it back to your wallet. Either one sends nothing that was already
              sent.
            </p>
          )}
          {engine && item.returnable && !item.staged && (
            <p className="text-dim mt-1 text-[12px]">
              If your USDC already moved into the rollup, &quot;Try the deposit again&quot; puts it
              in your account, and &quot;Return to wallet&quot; sends it back to your wallet. Either
              one sends nothing that was already sent.
            </p>
          )}
          {engine && item.keyed && item.resumable && !(item.staged && item.returnable) && (
            <p className="text-dim mt-1 text-[12px]">
              If your USDC already moved into the rollup, it is held by this browser&apos;s deposit
              key. &quot;Try the deposit again&quot; puts it in your account and asks nothing of
              your wallet.
            </p>
          )}
          {!engine && (
            <p className="text-faint mt-1 text-[11px]">
              Transfers are switched off in this build, so nothing more can be done here.
            </p>
          )}
          <p className="tnum text-faint mt-1 text-[11px]">Transfer id {item.id}</p>
          {item.signature && (
            <p className="tnum text-faint mt-1 text-[11px]">
              Signature <span title={item.signature}>{shortSignature(item.signature)}</span>
            </p>
          )}
          {running && (
            <p role="status" className="text-dim mt-1 text-[12px]">
              This transfer is running in this tab now. Wait for it to finish.
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {actionsOf(item, running).map((action) =>
              action === "copy-signature" ? (
                <button
                  key={action}
                  type="button"
                  className={`${btnGhost} px-2 text-[11px]`}
                  onClick={() => copy(item.signature ?? "")}
                >
                  Copy signature
                </button>
              ) : !engine ? null : action === "resume" || action === "return" ? (
                <button
                  key={action}
                  type="button"
                  className={`${btnGhost} px-2 text-[11px]`}
                  disabled={busy}
                  onClick={() => void resume(item, action)}
                >
                  {busy
                    ? "Working..."
                    : action === "return"
                      ? "Return to wallet"
                      : item.operation === "deposit"
                        ? "Try the deposit again"
                        : "Resume"}
                </button>
              ) : (
                <button
                  key={action}
                  type="button"
                  className={`${btnGhost} px-2 text-[11px]`}
                  disabled={busy}
                  onClick={() => void dismiss()}
                >
                  {busy ? "Dismissing..." : "Dismiss"}
                </button>
              ),
            )}
          </div>
        </div>
      ))}
      {note && (
        <p role="status" className="text-dim mt-2 text-[12px]">
          {note}
        </p>
      )}
    </section>
  );
}
