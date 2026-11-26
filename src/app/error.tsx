"use client";

import { useEffect } from "react";
import { btnGhost } from "@/components/ui/styles";
import { trackAppError } from "@/lib/analytics";
import { isMainnetBuild } from "@/lib/network";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => trackAppError("route_boundary"), [error]);
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-ink-strong text-[16px] font-medium">Something went wrong.</p>
      <p className="text-dim max-w-sm text-[13px]">
        The terminal hit an unexpected error.{" "}
        {isMainnetBuild()
          ? "Your wallet and balances are unaffected."
          : "Your test wallet and balances are unaffected."}
      </p>
      <button type="button" className={`${btnGhost} px-5`} onClick={() => reset()}>
        Reload the terminal
      </button>
    </div>
  );
}
