"use client";

import { useEffect, useState } from "react";
import { keySweepInProgress } from "@/lib/transfer/attention";
import { createJournal, indexedDbStorage } from "@/lib/transfer/journal";

const POLL_MS = 4_000;

/** The deposit key's return of spare SOL to this owner while its record is open, read from this browser's transfer records; null otherwise. */
export function useKeySweepInProgress(owner: string | null): { signature?: string } | null {
  const [sweep, setSweep] = useState<{ signature?: string } | null>(null);
  useEffect(() => {
    if (!owner) return;
    let active = true;
    const read = async () => {
      try {
        const records = await createJournal(indexedDbStorage()).unfinished(owner);
        if (active) setSweep(keySweepInProgress(records));
      } catch {
        // Unreadable records are reported by the transfers panel; this line only speaks for a return it can see.
      }
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
      setSweep(null);
    };
  }, [owner]);
  return owner ? sweep : null;
}
