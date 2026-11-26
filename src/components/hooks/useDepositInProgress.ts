"use client";

import { useTransferRecordsPoll } from "@/components/hooks/useTransferRecordsPoll";
import { depositInProgress } from "@/lib/transfer/attention";

/** Whether a deposit of this owner is between its first step and its last, read from this browser's transfer records. */
export function useDepositInProgress(owner: string | null): boolean {
  return useTransferRecordsPoll(owner, depositInProgress, false);
}
