"use client";

import { btnGhost } from "@/components/ui/styles";

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-ink-strong text-[16px] font-medium">Something went wrong.</p>
      <p className="text-dim max-w-sm text-[13px]">
        The terminal hit an unexpected error. Your test wallet and balances are unaffected.
      </p>
      <button type="button" className={`${btnGhost} px-5`} onClick={() => reset()}>
        Reload the terminal
      </button>
    </div>
  );
}
