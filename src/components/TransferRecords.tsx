"use client";

import { useCallback, useEffect, useState } from "react";
import { QUOTE_DECIMALS } from "@/lib/rollup/markets";
import {
  actionsOf,
  attentionOf,
  shortSignature,
  type Attention,
  type SeatJudgement,
} from "@/lib/transfer/attention";
import { atomsText } from "@/lib/transfer/amount";
import type { DismissOutcome } from "@/lib/transfer/dismiss";
import { createJournal, indexedDbStorage, type OperationRecord } from "@/lib/transfer/journal";
import { btnGhost, sectionLabel } from "@/components/ui/styles";

/** What judging and dismissing a record needs: present only in a build with transfers on. */
export interface RecordsEngine {
  judge(records: OperationRecord[]): Promise<Record<string, SeatJudgement>>;
  dismiss(): Promise<DismissOutcome>;
}

const RELOAD_MS = 20_000;

const OPERATION_LABEL: Record<Attention["operation"], string> = {
  deposit: "Deposit",
  withdraw: "Withdrawal",
  return: "Return to wallet",
};

const KIND_COPY: Record<Attention["kind"], string> = {
  waiting:
    "Not finished. It is still settling on the network. Do not start another transfer until it has.",
  "not-landed":
    "It did not go through, and nothing moved by it. You can dismiss this and start again.",
  unknown:
    "We cannot tell what happened to it. Wait, or contact support with the signature. It cannot be dismissed.",
};

/**
 * The transfers on record in this browser that are not finished, each with
 * what happened to it and what may be done. It reads the journal alone, so
 * a build with transfers off still shows a record left by an earlier one;
 * only with an `engine` is a record judged against the network and a
 * dismissal possible. No row ever offers to send anything again.
 */
export function TransferRecords({
  owner,
  engine,
  refreshKey = 0,
}: {
  owner: string | null;
  engine: RecordsEngine | null;
  refreshKey?: number;
}) {
  const [items, setItems] = useState<Attention[]>([]);
  const [unreadable, setUnreadable] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!owner) return;
    let active = true;
    const load = async () => {
      try {
        const records = await createJournal(indexedDbStorage()).unfinished(owner);
        const judged =
          engine && records.some((record) => record.seat?.state === "pending")
            ? await engine.judge(records).catch(() => ({}) as Record<string, SeatJudgement>)
            : {};
        if (!active) return;
        setItems(records.map((record) => attentionOf(record, judged[record.id] ?? null)));
        setUnreadable(false);
      } catch {
        if (active) setUnreadable(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), RELOAD_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [owner, engine, refreshKey, reload]);

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
        Transfers on record in this browser could not be read. Do not start a transfer from here
        until they can.
      </p>
    );
  }
  if (items.length === 0 && !note) return null;
  return (
    <section className="border-line-subtle border-b p-3" aria-label="Transfers that need attention">
      <p className={sectionLabel}>Transfers that need attention</p>
      {items.map((item) => (
        <div key={item.id} className="border-line-subtle rounded-tile mt-2 border p-2">
          <p className="text-ink text-[13px]">
            {OPERATION_LABEL[item.operation]} of {atomsText(BigInt(item.atoms), QUOTE_DECIMALS)}{" "}
            USDC
          </p>
          <p className="text-dim mt-1 text-[12px]">{KIND_COPY[item.kind]}</p>
          {!engine && (
            <p className="text-faint mt-1 text-[11px]">
              Transfers are switched off in this build, so nothing more can be done here.
            </p>
          )}
          {item.signature && (
            <p className="tnum text-faint mt-1 text-[11px]">
              Signature <span title={item.signature}>{shortSignature(item.signature)}</span>
            </p>
          )}
          <div className="mt-2 flex gap-2">
            {actionsOf(item).map((action) =>
              action === "copy-signature" ? (
                <button
                  key={action}
                  type="button"
                  className={`${btnGhost} h-7 px-2 text-[11px]`}
                  onClick={() => copy(item.signature ?? "")}
                >
                  Copy signature
                </button>
              ) : engine ? (
                <button
                  key={action}
                  type="button"
                  className={`${btnGhost} h-7 px-2 text-[11px]`}
                  disabled={busy}
                  onClick={() => void dismiss()}
                >
                  {busy ? "Dismissing..." : "Dismiss"}
                </button>
              ) : null,
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
