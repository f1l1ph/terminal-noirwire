"use client";

import { useEffect, useState } from "react";
import { env } from "@/lib/env";

interface Read {
  address: string;
  lamports: bigint | null;
}

async function readLamports(address: string, signal: AbortSignal): Promise<bigint | null> {
  if (!env.solanaRpcUrl) return null;
  try {
    const response = await fetch(env.solanaRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [address, { commitment: "confirmed" }],
      }),
      signal,
    });
    const body = (await response.json()) as { result?: { value?: unknown } } | null;
    const value = body?.result?.value;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? BigInt(value)
      : null;
  } catch {
    return null;
  }
}

/**
 * The SOL in `address`, in lamports, read once while `enabled`; null while
 * unknown or when the read fails, which is never to be treated as zero.
 */
export function useWalletLamports(address: string | null, enabled: boolean): bigint | null {
  const [read, setRead] = useState<Read | null>(null);
  useEffect(() => {
    if (!enabled || !address) return;
    const controller = new AbortController();
    void readLamports(address, controller.signal).then((lamports) => {
      if (!controller.signal.aborted) setRead({ address, lamports });
    });
    return () => controller.abort();
  }, [address, enabled]);
  return read !== null && read.address === address ? read.lamports : null;
}
