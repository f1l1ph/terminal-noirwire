"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createTabGuard, type TabGuard } from "@/lib/trading/tabGuard";

/** Whether another tab of this browser is trading on this account, and the way to take trading over from it. */
export function useTradingTabGuard(owner: string | null): {
  elsewhere: boolean;
  takeOver: () => void;
} {
  const [elsewhere, setElsewhere] = useState(false);
  const guard = useRef<TabGuard | null>(null);
  useEffect(() => {
    if (!owner) return;
    const created = createTabGuard(owner);
    guard.current = created;
    const stop = created.subscribe(() => setElsewhere(created.elsewhere()));
    return () => {
      stop();
      created.close();
      guard.current = null;
      setElsewhere(false);
    };
  }, [owner]);
  const takeOver = useCallback(() => guard.current?.takeOver(), []);
  return { elsewhere: owner ? elsewhere : false, takeOver };
}
