"use client";

import { useEffect, useState } from "react";
import {
  fetchTradingPause,
  healthPollDelayMs,
  type TradingPause,
} from "@/lib/trading/tradingHealth";

/**
 * Whether the market maker has no quotes up, read from the service's public
 * health route every 15 seconds and less often while it fails to answer. Null
 * means trading is not known to be paused: an answer that says so, or no answer.
 */
export function useTradingPause(simUrl: string): TradingPause | null {
  const [pause, setPause] = useState<TradingPause | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const ask = () => {
      fetchTradingPause(simUrl).then(
        (answer) => {
          if (stopped) return;
          failures = 0;
          setPause(answer);
          timer = setTimeout(ask, healthPollDelayMs(failures));
        },
        () => {
          if (stopped) return;
          failures += 1;
          setPause(null);
          timer = setTimeout(ask, healthPollDelayMs(failures));
        },
      );
    };
    ask();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [simUrl]);
  return pause;
}
