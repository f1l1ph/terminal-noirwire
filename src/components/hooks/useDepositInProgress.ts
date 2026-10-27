"use client";

import { useEffect, useState } from "react";
import { depositInProgress } from "@/lib/transfer/attention";
import { createJournal, indexedDbStorage } from "@/lib/transfer/journal";

const POLL_MS = 4_000;

/** Whether a deposit of this owner is between its first step and its last, read from this browser's transfer records. */
export function useDepositInProgress(owner: string | null): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!owner) return;
    let active = true;
    const read = async () => {
      try {
        const records = await createJournal(indexedDbStorage()).unfinished(owner);
        if (active) setOpen(depositInProgress(records));
      } catch {
        // Unreadable records are reported by the transfers panel; this banner only speaks for a deposit it can see.
      }
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
      setOpen(false);
    };
  }, [owner]);
  return owner ? open : false;
}
