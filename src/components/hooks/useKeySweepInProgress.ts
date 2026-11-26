"use client";

import { useTransferRecordsPoll } from "@/components/hooks/useTransferRecordsPoll";
import { keySweepInProgress } from "@/lib/transfer/attention";

/** The deposit key's return of spare SOL to this owner while its record is open, read from this browser's transfer records; null otherwise. */
export function useKeySweepInProgress(owner: string | null): { signature?: string } | null {
  return useTransferRecordsPoll(owner, keySweepInProgress, null);
}
