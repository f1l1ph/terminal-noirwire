"use client";

import { useEffect, useState } from "react";
import { createJournal, indexedDbStorage, type OperationRecord } from "@/lib/transfer/journal";

const POLL_MS = 4_000;

/**
 * What `read` makes of this owner's unfinished transfer records, polled from this browser's journal;
 * `empty` while there is no owner or nothing was read. Unreadable records are reported by the
 * transfers panel, so a failed read leaves the last value in place.
 */
export function useTransferRecordsPoll<T>(
  owner: string | null,
  read: (records: OperationRecord[]) => T,
  empty: T,
): T {
  const [value, setValue] = useState<T>(empty);
  useEffect(() => {
    if (!owner) return;
    let active = true;
    const poll = async () => {
      try {
        const records = await createJournal(indexedDbStorage()).unfinished(owner);
        if (active) setValue(read(records));
      } catch {
        // Unreadable records are reported by the transfers panel; the caller only speaks for what it can see.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
      setValue(empty);
    };
  }, [owner, read, empty]);
  return owner ? value : empty;
}
